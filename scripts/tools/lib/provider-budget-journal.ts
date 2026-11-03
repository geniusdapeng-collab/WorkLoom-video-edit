import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import {
  BudgetError, check, llmMicroCny, record, safeHash, safeInteger, safeTaskId, TASK_CAPS, WORKFLOW_TASK_CAPS,
  type BudgetProfile, type BudgetScope, type Claim, type ImageProof, type Settlement,
} from "./provider-budget-policy.js";

const JOURNAL_SCHEMA = "workloom.provider-budget-wal/v1";
const MAX_JOURNAL_BYTES = 512 * 1024;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,95}$/;

type BudgetLimits = { profile?: never; caps: typeof TASK_CAPS }
  | { profile: "workflow"; caps: typeof WORKFLOW_TASK_CAPS };
type Header = { schema: typeof JOURNAL_SCHEMA; type: "open"; task: string; port: number; at: number;
  scope: BudgetScope } & BudgetLimits;
type Reserve = { type: "reserve"; hash: string; wireSha256: string; at: number; claim: Claim };
type Ack = { type: "ack"; hash: string; at: number; taskId: string };
type Settle = { type: "settle"; hash: string; at: number; usage: Settlement };
type Freeze = { type: "freeze"; hash: string; at: number; reason: string };
type Event = Reserve | Ack | Settle | Freeze;

export interface Reservation {
  readonly hash: string;
  readonly wireSha256: string;
  readonly claim: Claim;
  taskId?: string;
  usage?: Settlement;
}

function validateClaim(claim: unknown): claim is Claim {
  if (!record(claim) || !safeInteger(claim.microCny, 1)) return false;
  if (claim.kind === "llm") return safeInteger(claim.inputTokens, 1) && safeInteger(claim.maxOutputTokens, 1)
    && claim.microCny === llmMicroCny(claim.inputTokens, claim.maxOutputTokens);
  if (claim.kind === "image") return safeInteger(claim.inputImages) && claim.inputImages <= 4;
  return claim.kind === "video" && safeInteger(claim.seconds, TASK_CAPS.minVideoSeconds) && claim.seconds <= TASK_CAPS.maxVideoSeconds
    && (claim.resolution === "720p" || claim.resolution === "1080p") && typeof claim.ratio === "string";
}

function validateSettlement(usage: unknown): usage is Settlement {
  if (!record(usage) || !safeInteger(usage.microCny)) return false;
  if (usage.kind === "llm") return safeInteger(usage.inputTokens, 1) && safeInteger(usage.outputTokens)
    && usage.microCny === llmMicroCny(usage.inputTokens, usage.outputTokens);
  if (usage.kind === "image") return record(usage.image) && safeHash(usage.image.urlHash)
    && safeInteger(usage.image.width, 1) && safeInteger(usage.image.height, 1);
  return usage.kind === "video" && typeof usage.status === "string" && ["succeeded", "failed", "cancelled", "expired"].includes(usage.status);
}

function parseEvent(raw: string): Event {
  const row: unknown = JSON.parse(raw);
  check(record(row) && safeHash(row.hash) && safeInteger(row.at, 1), "BUDGET_JOURNAL_INVALID", 503);
  if (row.type === "reserve" && safeHash(row.wireSha256) && validateClaim(row.claim)) {
    return { type: row.type, hash: row.hash, wireSha256: row.wireSha256, at: row.at, claim: row.claim };
  }
  if (row.type === "ack" && safeTaskId(row.taskId)) return { type: row.type, hash: row.hash, at: row.at, taskId: row.taskId };
  if (row.type === "settle" && validateSettlement(row.usage)) return { type: row.type, hash: row.hash, at: row.at, usage: row.usage };
  if (row.type === "freeze" && typeof row.reason === "string" && ERROR_CODE.test(row.reason)) return { type: row.type, hash: row.hash, at: row.at, reason: row.reason };
  throw new BudgetError("BUDGET_JOURNAL_INVALID", 503);
}

/**
 * Only the owner of the bound TCP listener may open a journal. Its header
 * permanently binds it to that port. Independent starts on different ports
 * cannot open the same journal, including simultaneous first creation.
 */
export class BudgetJournal {
  private readonly byHash = new Map<string, Reservation>();
  private readonly byTask = new Map<string, Reservation>();
  private readonly byImage = new Map<string, ImageProof>();
  private frozenReason: string | null = null;
  private writeFailed = false;

  private constructor(private readonly fd: number, private readonly header: Header, private readonly now: () => number) {}

  static open(path: string, port: number, task: string, scope: BudgetScope, now: () => number, profile: BudgetProfile = "case"): BudgetJournal {
    // Keep existing case headers readable by earlier releases. The distinct
    // workflow header pins both the explicit profile and its expanded limits.
    const limits: BudgetLimits = profile === "workflow" ? { profile, caps: WORKFLOW_TASK_CAPS } : { caps: TASK_CAPS };
    const flags = constants.O_NOFOLLOW | constants.O_APPEND | constants.O_RDWR;
    let fd: number;
    let created = false;
    try {
      fd = openSync(path, flags | constants.O_CREAT | constants.O_EXCL, 0o600);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new BudgetError("BUDGET_JOURNAL_UNAVAILABLE", 503);
      fd = openSync(path, flags);
    }
    try {
      const stat = fstatSync(fd);
      check(stat.isFile() && stat.nlink === 1 && !(stat.mode & 0o077) && stat.uid === process.getuid?.()
        && stat.size <= MAX_JOURNAL_BYTES, "BUDGET_JOURNAL_UNSAFE", 503);
      if (created) {
        const header: Header = { schema: JOURNAL_SCHEMA, type: "open", task, port, at: now(), scope, ...limits };
        check(safeInteger(header.at, 1), "BUDGET_CLOCK_INVALID", 503);
        const journal = new BudgetJournal(fd, header, now);
        journal.append(header);
        const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
        try { fsyncSync(parent); } finally { closeSync(parent); }
        return journal;
      }
      const contents = readFileSync(fd, "utf8");
      check(contents.endsWith("\n"), "BUDGET_JOURNAL_INVALID", 503);
      const [first, ...rest] = contents.slice(0, -1).split("\n");
      const header: unknown = JSON.parse(first ?? "");
      check(record(header) && header.schema === JOURNAL_SCHEMA && header.type === "open"
        && header.task === task && header.port === port && safeInteger(header.at, 1)
        && header.profile === limits.profile && JSON.stringify(header.scope) === JSON.stringify(scope)
        && JSON.stringify(header.caps) === JSON.stringify(limits.caps), "BUDGET_JOURNAL_SCOPE_MISMATCH", 503);
      const journal = new BudgetJournal(fd, { schema: JOURNAL_SCHEMA, type: "open", task, port, at: header.at, scope, ...limits }, now);
      for (const line of rest) journal.apply(parseEvent(line));
      const uncertain = [...journal.byHash.values()].find((entry) => !entry.taskId && !entry.usage);
      if (uncertain) journal.freeze(uncertain.hash, "BUDGET_INTERRUPTED_WITHOUT_RECEIPT");
      return journal;
    } catch (error) {
      closeSync(fd);
      throw error instanceof BudgetError ? error : new BudgetError("BUDGET_JOURNAL_INVALID", 503);
    }
  }

  private append(event: Header | Event): void {
    try {
      const stat = fstatSync(this.fd);
      const bytes = Buffer.from(JSON.stringify(event) + "\n");
      if (stat.nlink !== 1 || stat.size + bytes.length > MAX_JOURNAL_BYTES) throw new Error("budget journal unavailable");
      for (let offset = 0; offset < bytes.length;) {
        const written = writeSync(this.fd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new Error("budget journal short write");
        offset += written;
      }
      fsyncSync(this.fd);
    } catch {
      this.writeFailed = true;
      throw new BudgetError("BUDGET_JOURNAL_WRITE_FAILED", 503);
    }
  }

  private apply(event: Event): void {
    const previous = this.byHash.get(event.hash);
    const valid = (condition: unknown) => check(condition, "BUDGET_JOURNAL_INVALID", 503);
    if (event.type === "reserve") {
      valid(!previous);
      this.byHash.set(event.hash, { hash: event.hash, wireSha256: event.wireSha256, claim: event.claim });
      return;
    }
    check(previous, "BUDGET_JOURNAL_INVALID", 503);
    if (event.type === "ack") {
      valid(previous.claim.kind === "video" && !previous.taskId && !previous.usage && !this.byTask.has(event.taskId));
      previous.taskId = event.taskId;
      this.byTask.set(event.taskId, previous);
    } else if (event.type === "settle") {
      valid(!previous.usage && previous.claim.kind === event.usage.kind && (previous.claim.kind !== "video" || previous.taskId));
      previous.usage = event.usage;
      if (event.usage.kind === "image") this.byImage.set(event.usage.image.urlHash, event.usage.image);
    } else {
      this.frozenReason ??= event.reason;
    }
  }

  private write(event: Event): void {
    check(!this.writeFailed, "BUDGET_JOURNAL_WRITE_FAILED", 503);
    this.append(event);
    this.apply(event);
  }

  get deadline(): number { return this.header.at + this.header.caps.windowMs; }
  get expired(): boolean { return this.now() < this.header.at || this.now() >= this.deadline; }
  get frozen(): string | null { return this.writeFailed ? "BUDGET_JOURNAL_WRITE_FAILED" : this.frozenReason; }
  find(hash: string): Reservation | undefined { return this.byHash.get(hash); }
  task(taskId: string): Reservation | undefined { return this.byTask.get(taskId); }
  image(urlHash: string): ImageProof | undefined { return this.byImage.get(urlHash); }

  reserve(hash: string, wireSha256: string, claim: Claim): void {
    check(!this.frozen, "BUDGET_FROZEN", 423);
    check(!this.expired, "BUDGET_DEADLINE_EXCEEDED", 423);
    check(!this.byHash.has(hash), "BUDGET_DUPLICATE_REQUEST", 409);
    const { usage, estimatedCost } = this.counters();
    const { caps } = this.header;
    if (claim.kind === "llm") {
      check(usage.llmCalls + 1 <= caps.llmCalls, "BUDGET_LLM_CALLS_EXCEEDED", 429);
      // In workflow mode each exact native request already proves its own
      // window. The call limit bounds the cumulative usage without clipping.
      if (this.header.profile !== "workflow") {
        check(usage.llmGrossTokens + claim.inputTokens + claim.maxOutputTokens <= caps.llmGrossTokens, "BUDGET_LLM_TOKENS_EXCEEDED", 429);
      }
    } else if (claim.kind === "image") {
      check(usage.imageCalls + 1 <= caps.imageCalls, "BUDGET_IMAGE_COUNT_EXCEEDED", 429);
    } else {
      check(usage.videoCalls + 1 <= caps.videoCalls && usage.videoSeconds + claim.seconds <= caps.totalVideoSeconds, "BUDGET_VIDEO_LIMIT_EXCEEDED", 429);
    }
    if (this.header.profile === "workflow") {
      const { media } = estimatedCost;
      if (claim.kind !== "llm") check(media.settledMicroCny + media.reservedMicroCny + claim.microCny <= this.header.caps.mediaMicroCny,
        "BUDGET_MEDIA_CNY_EXCEEDED", 429);
    } else {
      check(usage.microCny + claim.microCny <= this.header.caps.microCny, "BUDGET_CNY_EXCEEDED", 429);
    }
    this.write({ type: "reserve", hash, wireSha256, at: this.now(), claim });
  }

  accept(hash: string, taskId: string): void {
    check(!this.byTask.has(taskId), "BUDGET_UPSTREAM_TASK_CONFLICT", 502);
    this.write({ type: "ack", hash, taskId, at: this.now() });
  }

  settle(hash: string, usage: Settlement): void {
    this.write({ type: "settle", hash, usage, at: this.now() });
  }

  freeze(hash: string, reason: string): void {
    if (this.frozen) return;
    this.write({ type: "freeze", hash, reason, at: this.now() });
  }

  private counters() {
    let llmCalls = 0, llmGrossTokens = 0, imageCalls = 0, videoCalls = 0, videoSeconds = 0;
    let settledMicroCny = 0, reservedMicroCny = 0;
    let settledLlmInputTokens = 0, settledLlmOutputTokens = 0;
    const estimatedCost = { llm: { settledMicroCny: 0, reservedMicroCny: 0 }, media: { settledMicroCny: 0, reservedMicroCny: 0 } };
    for (const { claim, usage } of this.byHash.values()) {
      const cost = claim.kind === "llm" ? estimatedCost.llm : estimatedCost.media;
      if (usage) {
        settledMicroCny += usage.microCny;
        cost.settledMicroCny += usage.microCny;
      } else {
        reservedMicroCny += claim.microCny;
        cost.reservedMicroCny += claim.microCny;
      }
      if (claim.kind === "llm") {
        llmCalls++;
        if (usage?.kind === "llm") {
          settledLlmInputTokens += usage.inputTokens;
          settledLlmOutputTokens += usage.outputTokens;
          llmGrossTokens += usage.inputTokens + usage.outputTokens;
        } else {
          llmGrossTokens += claim.inputTokens + claim.maxOutputTokens;
        }
      } else if (claim.kind === "image") {
        imageCalls++;
      } else {
        videoCalls++;
        videoSeconds += claim.seconds;
      }
    }
    return { usage: { llmCalls, llmGrossTokens, settledLlmGrossTokens: settledLlmInputTokens + settledLlmOutputTokens,
      imageCalls, videoCalls, videoSeconds, microCny: settledMicroCny + reservedMicroCny, settledMicroCny, reservedMicroCny },
      estimatedCost, settledLlmInputTokens, settledLlmOutputTokens };
  }

  status() {
    const { usage, estimatedCost, settledLlmInputTokens, settledLlmOutputTokens } = this.counters();
    const frozen = this.frozen;
    const expired = this.expired;
    const requests = [...this.byHash.values()];
    const holds = requests.filter((entry) => !entry.usage);
    return { schema: JOURNAL_SCHEMA, task: this.header.task, openedAt: this.header.at, deadlineAt: this.deadline,
      state: frozen ? "frozen" : expired ? "expired" : holds.length ? "held" : "live",
      live: !expired && !frozen, expired, frozen, held: holds.length > 0,
      scope: this.header.scope, caps: this.header.caps, usage,
      ...(this.header.profile === "workflow" ? { profile: this.header.profile, estimatedCost,
        settledLlmTokens: { input: settledLlmInputTokens, output: settledLlmOutputTokens } } : {}),
      consumed: { llmGrossTokens: usage.settledLlmGrossTokens, microCny: usage.settledMicroCny },
      reserved: { llmGrossTokens: usage.llmGrossTokens - usage.settledLlmGrossTokens, microCny: usage.reservedMicroCny, calls: holds.length },
      receipts: requests.map((entry) => ({ wireSha256: entry.wireSha256, kind: entry.claim.kind,
        state: entry.usage ? "settled" : entry.taskId ? "accepted" : "held", taskId: entry.taskId ?? null })),
      tasks: [...this.byTask].map(([taskId, entry]) => ({ taskId, state: entry.usage?.kind === "video" ? entry.usage.status : "accepted" })) };
  }

  close(): void { closeSync(this.fd); }
}
