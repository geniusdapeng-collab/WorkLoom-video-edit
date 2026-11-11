import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { BudgetJournal, type Reservation } from "./provider-budget-journal.js";
import {
  ARK_IMAGE_PATH, ARK_VIDEO_PATH, BudgetError, check, compileClaim, DEEPSEEK_CHAT_PATH, DEEPSEEK_MODEL, DEEPSEEK_RESPONSES_PATH, digest,
  exceededClaim, normalizeBudgetProfile, normalizeBudgetScope, record, responsesSettlement, safeTaskId, SEEDANCE_MODEL, SEEDREAM_MODEL, settlementFor,
  type JsonObject, type Settlement,
} from "./provider-budget-policy.js";

const ARK_ORIGIN = "https://ark.cn-beijing.volces.com";
const DEEPSEEK_ORIGIN = "https://api.deepseek.com";
const MAX_LLM_BODY_BYTES = 48 * 1024 * 1024;
const MAX_ARK_BODY_BYTES = 64 * 1024 * 1024;
const MAX_UPSTREAM_BODY_BYTES = 32 * 1024 * 1024;
const SYNCHRONOUS_TIMEOUT_MS = 5 * 60_000;
const VIDEO_ACK_TIMEOUT_MS = 2 * 60_000;
const READBACK_TIMEOUT_MS = 45_000;
const TEXT_POST_PATHS = new Set([DEEPSEEK_CHAT_PATH, DEEPSEEK_RESPONSES_PATH]);
const POST_PATHS = new Set([...TEXT_POST_PATHS, ARK_IMAGE_PATH, ARK_VIDEO_PATH]);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

interface GatewayOptions {
  port: number;
  task: string;
  journalPath: string;
  clientToken: string;
  deepSeekApiKey: string;
  arkApiKey: string;
  scope?: unknown;
  profile?: unknown;
  now?: () => number;
  /** Tests can inject a provider transport. The CLI never exposes it. */
  fetchImpl?: typeof fetch;
}

interface Upstream {
  status: number;
  body: Buffer;
  value: JsonObject;
  receiptHeaders: Record<string, string>;
}

function decode(body: Buffer, canonical: boolean): JsonObject {
  try {
    const text = utf8.decode(body);
    const value: unknown = JSON.parse(text);
    // The native serializers produce compact JSON.stringify bytes. Exact
    // re-encoding also rejects duplicate keys without changing forwarded bytes.
    if (record(value) && (!canonical || JSON.stringify(value) === text)) return value;
  } catch { /* Map parse and UTF-8 errors to the same safe protocol code. */ }
  throw new BudgetError(canonical ? "BUDGET_NONCANONICAL_JSON" : "BUDGET_UPSTREAM_RESPONSE_UNVERIFIED", canonical ? 400 : 502);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value));
  if (response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": bytes.length,
    "cache-control": "no-store", connection: "close" });
  response.end(bytes);
}

function sendUpstream(response: ServerResponse, upstream: Upstream): void {
  if (response.destroyed) return;
  response.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8", "content-length": upstream.body.length,
    "cache-control": "no-store", connection: "close", ...upstream.receiptHeaders });
  response.end(upstream.body);
}

async function incomingBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  check(request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
    && !request.headers["content-encoding"] && !request.headers["transfer-encoding"], "BUDGET_BODY_PROTOCOL_INVALID", 415);
  const rawLength = request.headers["content-length"];
  const length = Number(rawLength);
  check(rawLength && /^[1-9]\d{0,8}$/.test(rawLength) && length <= maxBytes, "BUDGET_BODY_SIZE_INVALID", 413);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.length;
    check(bytes <= length, "BUDGET_BODY_SIZE_INVALID", 413);
    chunks.push(chunk);
  }
  check(bytes === length && request.complete, "BUDGET_BODY_INCOMPLETE");
  return Buffer.concat(chunks, bytes);
}

async function upstreamBody(response: Response): Promise<Buffer> {
  const length = Number(response.headers.get("content-length") ?? 0);
  check(!(length > MAX_UPSTREAM_BODY_BYTES) && response.body, "BUDGET_UPSTREAM_RESPONSE_UNVERIFIED", 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      check(bytes <= MAX_UPSTREAM_BODY_BYTES, "BUDGET_UPSTREAM_RESPONSE_UNVERIFIED", 502);
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

function ensureLocalToken(input: string | undefined, expected: Buffer): void {
  const actual = Buffer.from(input ?? "");
  check(actual.length === expected.length && timingSafeEqual(actual, expected), "BUDGET_UNAUTHORIZED", 401);
}

function safeCredential(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);
}

const directProviderFetch: typeof fetch = (url, init) => new Promise((resolve, reject) => {
  // A new direct TLS connection per request. There is no redirect follower,
  // reused connection, environment HTTP proxy, or retry middleware here.
  const headers = new Headers(init?.headers);
  headers.set("accept-encoding", "identity");
  const body = init?.body as Buffer | undefined;
  if (body) headers.set("content-length", String(body.length));
  const outgoing = httpsRequest(new URL(String(url)), {
    method: init?.method, headers: Object.fromEntries(headers.entries()), signal: init?.signal ?? undefined,
    agent: false, rejectUnauthorized: true,
  }, (message) => {
    try {
      const status = message.statusCode ?? 502;
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(message.headers)) {
        if (typeof value === "string") responseHeaders.set(name, value);
      }
      const empty = [204, 205, 304].includes(status);
      if (empty) message.resume();
      resolve(new Response(empty ? null : Readable.toWeb(message) as ReadableStream<Uint8Array>, { status, headers: responseHeaders }));
    } catch (error) {
      message.destroy();
      reject(error);
    }
  });
  outgoing.once("error", reject);
  outgoing.end(body);
});

export async function startProviderBudgetGateway(options: GatewayOptions) {
  check(Number.isInteger(options.port) && options.port >= 0 && options.port <= 65535 && safeTaskId(options.task),
    "BUDGET_GATEWAY_OPTIONS_INVALID", 503);
  check(/^[A-Za-z0-9_-]{32,256}$/.test(options.clientToken) && safeCredential(options.deepSeekApiKey) && safeCredential(options.arkApiKey)
    && options.clientToken !== options.deepSeekApiKey && options.clientToken !== options.arkApiKey, "BUDGET_GATEWAY_CREDENTIALS_INVALID", 503);
  const localAuthorization = Buffer.from(`Bearer ${options.clientToken}`);
  const scope = normalizeBudgetScope(options.scope);
  const profile = normalizeBudgetProfile(options.profile);
  if (profile !== "case") {
    check(scope.video.seconds !== null && scope.video.ratio !== null && scope.video.resolution !== null,
      "BUDGET_WORKFLOW_SCOPE_REQUIRED", 503);
  }
  const now = options.now ?? Date.now;
  const fetcher = options.fetchImpl ?? directProviderFetch;
  const inFlightPolls = new Map<string, Promise<Upstream>>();
  let journal: BudgetJournal | undefined;

  async function forward(method: "GET" | "POST", path: string, timeoutMs: number, payload?: Buffer): Promise<Upstream> {
    check(timeoutMs > 0, "BUDGET_DEADLINE_EXCEEDED", 423);
    const deepSeek = TEXT_POST_PATHS.has(path) || path === "/models";
    const response = await fetcher(`${deepSeek ? DEEPSEEK_ORIGIN : ARK_ORIGIN}${path}`, {
      method,
      headers: { authorization: `Bearer ${deepSeek ? options.deepSeekApiKey : options.arkApiKey}`,
        accept: "application/json", ...(payload ? { "content-type": "application/json" } : {}) },
      body: payload as BodyInit | undefined,
      signal: AbortSignal.timeout(Math.ceil(timeoutMs)),
      redirect: "error",
    });
    const encoding = response.headers.get("content-encoding") ?? "identity";
    if (!response.ok || encoding !== "identity"
      || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      await response.body?.cancel().catch(() => undefined);
      throw new BudgetError("BUDGET_UPSTREAM_HTTP_UNVERIFIED", 502);
    }
    const body = await upstreamBody(response);
    const receiptHeaders: Record<string, string> = {};
    for (const name of ["x-request-id", "x-tt-logid"]) {
      const value = response.headers.get(name);
      if (value && /^[A-Za-z0-9._:-]{1,256}$/.test(value)) receiptHeaders[name] = value;
    }
    return { status: response.status, body, value: decode(body, false), receiptHeaders };
  }

  function freezeOutcome(store: BudgetJournal, hash: string, error: unknown): never {
    const reason = error instanceof BudgetError ? error.code : "BUDGET_UPSTREAM_TRANSPORT_UNKNOWN";
    store.freeze(hash, reason);
    throw new BudgetError("BUDGET_OUTCOME_UNKNOWN", 502);
  }

  function settle(store: BudgetJournal, entry: Reservation, usage: Settlement): void {
    if (entry.usage) {
      check(JSON.stringify(entry.usage) === JSON.stringify(usage), "BUDGET_UPSTREAM_USAGE_CHANGED", 502);
      return;
    }
    // Persist any observed overrun before releasing the reservation.
    if (exceededClaim(entry.claim, usage)) store.freeze(entry.hash, "BUDGET_UPSTREAM_EXCEEDED_RESERVATION");
    store.settle(entry.hash, usage);
  }

  async function poll(store: BudgetJournal, entry: Reservation, path: string): Promise<Upstream> {
    try {
      const upstream = await forward("GET", path, READBACK_TIMEOUT_MS);
      const usage = settlementFor(entry.claim, upstream.value, entry.taskId);
      if (usage) settle(store, entry, usage);
      else check(!entry.usage, "BUDGET_UPSTREAM_USAGE_CHANGED", 502);
      return upstream;
    } catch (error) {
      return freezeOutcome(store, entry.hash, error);
    }
  }

  async function submit(store: BudgetJournal, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    const bytes = await incomingBody(request, TEXT_POST_PATHS.has(path) ? MAX_LLM_BODY_BYTES : MAX_ARK_BODY_BYTES);
    const wireSha256 = digest(bytes);
    const hash = digest(`${path}\n${wireSha256}`);
    const body = decode(bytes, true);
    const claim = await compileClaim(path, body, scope, (urlHash) => store.image(urlHash));
    if (claim.kind === "video" && scope.video.totalSeconds !== undefined) {
      check(store.status().usage.videoSeconds + claim.seconds <= scope.video.totalSeconds,
        "BUDGET_VIDEO_SCOPE_MISMATCH", 429);
    }
    const existing = store.find(hash);
    if (existing?.taskId) {
      sendJson(response, 200, { id: existing.taskId });
      return;
    }
    check(!existing, "BUDGET_DUPLICATE_REQUEST", 409);

    // Synchronous validation + append + fsync. No dispatch can enter the
    // event loop between this admission decision and the durable reservation.
    store.reserve(hash, wireSha256, claim);
    try {
      const maxDuration = claim.kind === "video" ? VIDEO_ACK_TIMEOUT_MS : SYNCHRONOUS_TIMEOUT_MS;
      const remaining = store.deadline === null ? maxDuration : Math.min(maxDuration, store.deadline - now());
      const upstream = await forward("POST", path, remaining, bytes);
      if (claim.kind === "video") {
        check(safeTaskId(upstream.value.id), "BUDGET_UPSTREAM_TASK_UNVERIFIED", 502);
        store.accept(hash, upstream.value.id);
      } else {
        const usage = path === DEEPSEEK_RESPONSES_PATH ? responsesSettlement(upstream.value) : settlementFor(claim, upstream.value);
        const entry = store.find(hash);
        check(entry && usage, "BUDGET_UPSTREAM_USAGE_UNVERIFIED", 502);
        settle(store, entry, usage);
      }
      sendUpstream(response, upstream);
    } catch (error) {
      freezeOutcome(store, hash, error);
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    ensureLocalToken(request.headers.authorization, localAuthorization);
    const store = journal;
    check(store, "BUDGET_GATEWAY_STARTING", 503);
    const path = request.url ?? "";
    if (request.method === "GET") {
      if (path === "/budget/status") {
        const status = store.status();
        sendJson(response, 200, { ...status, phaseRelays: {
          llm: { model: DEEPSEEK_MODEL, path: DEEPSEEK_CHAT_PATH, configured: true, admitted: status.usage.llmCalls,
            ...(profile === "workflow-v2" ? { structuredScenePath: DEEPSEEK_RESPONSES_PATH } : {}) },
          image: { model: SEEDREAM_MODEL, path: ARK_IMAGE_PATH, configured: true, admitted: status.usage.imageCalls },
          video: { model: SEEDANCE_MODEL, path: ARK_VIDEO_PATH, configured: true, admitted: status.usage.videoCalls },
        } });
        return;
      }
      if (path === "/models") {
        sendUpstream(response, await forward("GET", path, READBACK_TIMEOUT_MS));
        return;
      }
      if (path.startsWith(`${ARK_VIDEO_PATH}/`)) {
        const taskId = path.slice(ARK_VIDEO_PATH.length + 1);
        const entry = safeTaskId(taskId) ? store.task(taskId) : undefined;
        check(entry, "BUDGET_TASK_NOT_OWNED", 404);
        let readback = inFlightPolls.get(taskId);
        if (!readback) {
          readback = poll(store, entry, path).finally(() => inFlightPolls.delete(taskId));
          inFlightPolls.set(taskId, readback);
        }
        sendUpstream(response, await readback);
        return;
      }
    }
    check(request.method === "POST" && POST_PATHS.has(path)
      && (path !== DEEPSEEK_RESPONSES_PATH || profile === "workflow-v2"), "BUDGET_ROUTE_DENIED", 404);
    await submit(store, request, response, path);
  }

  const server = createServer({ headersTimeout: 10_000, requestTimeout: 30_000, maxHeaderSize: 8192 }, (request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.destroyed || response.headersSent) return;
      const failure = error instanceof BudgetError ? error : new BudgetError("BUDGET_GATEWAY_FAILED", 503);
      sendJson(response, failure.httpStatus, {
        error: { code: failure.code, message: failure.code, ...(failure.limit ? { limit: failure.limit } : {}) },
      });
    });
  });
  // No upgrade, CONNECT, or Expect admission paths.
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("checkContinue", (_request, response) => sendJson(response, 417, { error: { code: "BUDGET_EXPECT_DENIED" } }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  try {
    journal = BudgetJournal.open(options.journalPath, port, options.task, scope, now, profile);
  } catch (error) {
    server.close();
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close() {
      closePromise ??= new Promise<void>((resolve, reject) => {
        server.close((error) => {
          journal?.close();
          if (error) reject(error);
          else resolve();
        });
      });
      return closePromise;
    },
  };
}
