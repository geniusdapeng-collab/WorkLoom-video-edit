/**
 * archive/store.ts —— 制片档案存储（T-2026-0926-0001）
 *
 * 一部片子 = 一个自包含档案夹：`<workDir>/archive/<workspaceId>/<projectId>/`。
 *
 * 纪律（规格书 §3/§5.1）：
 *   - **append-only**：重试开新 attempt 文件，历史永不覆盖；
 *   - **原子写**：tmp + rename（沿用 vendor checkpoint 模式）；
 *   - **旁路不阻断**：写盘失败只 console.error，绝不阻断主流程（档案是证据，不是闸门）；
 *   - **路径监狱**：所有相对路径收在档案根内，绝对路径与 `..` 越界一律拒绝。
 *
 * 事实源：文件是档案本体（大产物在此），PG 只是索引面（production_stage_runs）。
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const ARCHIVE_SCHEMA_VERSION = "production-archive/v1";

class ArchiveBoundaryError extends Error {
  constructor(code: "ARCHIVE_IDENTITY_INVALID" | "ARCHIVE_PATH_INVALID" | "ARCHIVE_SCOPE_INVALID", detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ArchiveBoundaryError";
  }
}

function assertIdentityComponent(value: string, label: string): void {
  if (typeof value !== "string" || !value || value === "." || value === ".."
    || /[/\\\0]/u.test(value) || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new ArchiveBoundaryError("ARCHIVE_IDENTITY_INVALID", `${label} 必须是单一档案身份组件`);
  }
}

export type PipelineKind = "marketing" | "narrative";

export interface ArchiveLedgerEntry {
  attempt: number;
  status: string;
  finishedAt: string | null;
}

export interface ArchiveManifest {
  schemaVersion: string;
  projectId: string;
  workspaceId: string;
  /** 管线类型（两条制片管线：marketing 含前置情报层 / narrative 通用；见规格书 §5.4） */
  pipelineKind: PipelineKind;
  /** 管线类型历史（同一档案夹被不同 kind 的 run 复用时留痕，不静默改写） */
  pipelineKindHistory?: Array<{ kind: PipelineKind; at: string }>;
  /** 项目身份指纹（来自 PG 的 video_projects：kind/title/created_at），用于识别"档案夹被另一代 DB 的同名 ID 复用" */
  projectIdentity?: ArchiveProjectIdentity | null;
  /** 身份漂移记录（只增不减，供监控器开工程发现） */
  identityDrifts?: Array<Record<string, unknown>>;
  /** 路由决策元数据（aspectRatio 9:16 等，供跨会话承接重建上下文） */
  routeMeta?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /** 环节账本：stageId → 最新一次 attempt 摘要 */
  ledger: Record<string, ArchiveLedgerEntry>;
}

/** 项目身份（PG 事实源快照；compareOn 用于跨代检测） */
export interface ArchiveProjectIdentity {
  kind: string;
  title: string | null;
  createdAt: string | null;
}

/** 档案相对路径监狱：拒绝绝对路径与越出档案根的 `..`（回归：`../../etc/passwd`） */
export function assertInsideRoot(root: string, relPath: string): string {
  if (!relPath || path.isAbsolute(relPath)) {
    throw new Error(`档案路径必须是档案根内的相对路径：${relPath}`);
  }
  const abs = path.resolve(root, relPath);
  const rootResolved = path.resolve(root);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    throw new Error(`档案路径越出档案根：${relPath}`);
  }
  return abs;
}

type ManifestSerializer = <T>(operation: () => Promise<T>) => Promise<T>;
const localManifestWrites = new Map<string, Promise<void>>();

export class ArchiveStore {
  readonly root: string;
  private readonly workRoot: string;

  constructor(
    workDir: string,
    readonly workspaceId: string,
    readonly projectId: string,
    readonly pipelineKind: PipelineKind = "narrative",
    readonly routeMeta?: Record<string, unknown>,
    private readonly serializeManifest?: ManifestSerializer,
  ) {
    assertIdentityComponent(workspaceId, "workspaceId");
    assertIdentityComponent(projectId, "projectId");
    this.workRoot = path.resolve(workDir);
    // 路径监狱：与 dossiers 同口径收在 workDir 下，不接受外部传入的绝对路径
    this.root = path.join(workDir, "archive", workspaceId, projectId);
  }

  private withManifestWrite<T>(operation: () => Promise<T>): Promise<T> {
    if (this.serializeManifest) return this.serializeManifest(operation);
    const key = path.resolve(this.root);
    const current = (localManifestWrites.get(key) ?? Promise.resolve()).then(operation);
    const settled = current.then(() => undefined, () => undefined);
    localManifestWrites.set(key, settled);
    return current.finally(() => {
      if (localManifestWrites.get(key) === settled) localManifestWrites.delete(key);
    });
  }

  /** The configured work directory is trusted; none of its archive descendants may redirect a scope. */
  private async assertPhysicalBoundary(absPath: string): Promise<void> {
    const relative = path.relative(this.workRoot, absPath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new ArchiveBoundaryError("ARCHIVE_PATH_INVALID", "档案真实路径不能越过工作目录");
    }
    let current = this.workRoot;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) {
          throw new ArchiveBoundaryError("ARCHIVE_PATH_INVALID", "档案目录或文件不能通过符号链接重定向");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
  }

  /**
   * 建档案夹 + 写 manifest。
   *
   * 已存在时不覆盖历史账本，但**必须做身份一致性校验**（真机审计发现）：
   * 档案夹以 `workspaceId/projectId` 为单位，而 projectId 只在一代数据库内唯一——
   * 换库/重置种子后同一个 `VID-nnn` 会指向另一个片子，旧档案会被静默继承
   * （实测：营销片的 manifest 写着 narrative）。这里把差异写成事件与漂移记录，
   * 并把 `pipelineKind` 校正为**本次 run 的真实值**（历史值进 pipelineKindHistory）。
   */
  async ensure(identity?: ArchiveProjectIdentity | null): Promise<void> {
    await this.withManifestWrite(() => this.ensureManifest(identity));
  }

  private async ensureManifest(identity?: ArchiveProjectIdentity | null): Promise<void> {
    await this.assertPhysicalBoundary(path.resolve(this.root, "manifest.json"));
    await fs.mkdir(this.root, { recursive: true });
    const manifestPath = path.join(this.root, "manifest.json");
    let existing: ArchiveManifest | null = null;
    try {
      await fs.access(manifestPath);
      existing = await this.readManifest();
    } catch (error) {
      if (error instanceof ArchiveBoundaryError) throw error;
      existing = null;
    }
    if (!existing) {
      const now = new Date().toISOString();
      const manifest: ArchiveManifest = {
        schemaVersion: ARCHIVE_SCHEMA_VERSION,
        projectId: this.projectId,
        workspaceId: this.workspaceId,
        pipelineKind: this.pipelineKind,
        pipelineKindHistory: [{ kind: this.pipelineKind, at: now }],
        ...(identity ? { projectIdentity: identity } : {}),
        ...(this.routeMeta ? { routeMeta: this.routeMeta } : {}),
        createdAt: now,
        updatedAt: now,
        ledger: {},
      };
      await this.writeJsonAtomic("manifest.json", manifest);
      return;
    }

    const kindChanged = existing.pipelineKind !== this.pipelineKind;
    const identityChanged = Boolean(
      identity
      && existing.projectIdentity
      && (existing.projectIdentity.createdAt !== identity.createdAt || existing.projectIdentity.kind !== identity.kind),
    );
    if (kindChanged || identityChanged) {
      const newProjectGeneration = Boolean(identity?.createdAt && existing.projectIdentity?.createdAt
        && identity.createdAt !== existing.projectIdentity.createdAt);
      const drift = {
        at: new Date().toISOString(),
        previousKind: existing.pipelineKind,
        currentKind: this.pipelineKind,
        previousIdentity: existing.projectIdentity ?? null,
        currentIdentity: identity ?? null,
        ...(newProjectGeneration ? { previousLedger: existing.ledger } : {}),
      };
      console.error(
        `[archive] 档案身份漂移 ${this.workspaceId}/${this.projectId}：`
        + `pipelineKind ${existing.pipelineKind}→${this.pipelineKind}`
        + `${identityChanged ? "（项目身份指纹不一致：档案夹可能被另一代数据库的同名 ID 复用）" : ""}`,
      );
      try {
        await this.appendJsonl("events.jsonl", { kind: "manifest.identity_drift", ...drift });
      } catch (err) {
        console.error(`[archive] 漂移事件写入失败: ${(err as Error).message}`);
      }
      const nextHistory = [...(existing.pipelineKindHistory ?? [])];
      if (kindChanged) nextHistory.push({ kind: this.pipelineKind, at: drift.at });
      await this.writeJsonAtomic("manifest.json", {
        ...existing,
        pipelineKind: this.pipelineKind,
        pipelineKindHistory: nextHistory,
        projectIdentity: identity ?? existing.projectIdentity ?? null,
        identityDrifts: [...(existing.identityDrifts ?? []), drift].slice(-20),
        ...(newProjectGeneration ? { ledger: {} } : {}),
        updatedAt: drift.at,
      });
      return;
    }
    if (identity && !existing.projectIdentity) {
      await this.writeJsonAtomic("manifest.json", {
        ...existing,
        projectIdentity: identity,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  /** 原子写 JSON（tmp + rename）；返回产物 sha256（对账用） */
  async writeJsonAtomic(relPath: string, data: unknown): Promise<{ sha256: string }> {
    const abs = assertInsideRoot(this.root, relPath);
    await this.assertPhysicalBoundary(abs);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await this.assertPhysicalBoundary(abs);
    const tmp = `${abs}.${randomUUID()}.tmp`;
    const body = JSON.stringify(data, null, 2);
    try {
      await fs.writeFile(tmp, body, { encoding: "utf8", flag: "wx" });
      await this.assertPhysicalBoundary(abs);
      await fs.rename(tmp, abs);
    } catch (error) {
      try { await fs.unlink(tmp); }
      catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new AggregateError([error, cleanupError], "archive-atomic-write-cleanup-failed");
        }
      }
      throw error;
    }
    return { sha256: createHash("sha256").update(body).digest("hex") };
  }

  /** 追加一行到 JSONL（events.jsonl / logs/<stage>.jsonl），自动带 ts */
  async appendJsonl(relPath: string, record: unknown): Promise<void> {
    const abs = assertInsideRoot(this.root, relPath);
    await this.assertPhysicalBoundary(abs);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await this.assertPhysicalBoundary(abs);
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...(record as object) })}\n`;
    await fs.appendFile(abs, line, "utf8");
  }

  async readJson<T>(relPath: string): Promise<T | null> {
    let abs: string;
    try { abs = assertInsideRoot(this.root, relPath); }
    catch (error) {
      if (error instanceof Error && /档案路径/.test(error.message)) return null;
      throw error;
    }
    await this.assertPhysicalBoundary(abs);
    try {
      return JSON.parse(await fs.readFile(abs, "utf8")) as T;
    } catch {
      return null;
    }
  }

  async readText(relPath: string): Promise<string | null> {
    return (await this.readBytes(relPath))?.toString("utf8") ?? null;
  }

  async readBytes(relPath: string): Promise<Buffer | null> {
    let abs: string;
    try { abs = assertInsideRoot(this.root, relPath); }
    catch (error) {
      if (error instanceof Error && /档案路径/.test(error.message)) return null;
      throw error;
    }
    await this.assertPhysicalBoundary(abs);
    try {
      return await fs.readFile(abs);
    } catch {
      return null;
    }
  }

  /** 读档案事件流（append-only JSONL，坏行跳过；监控/对账用） */
  async readEvents(limit = 200): Promise<Record<string, unknown>[]> {
    const text = await this.readText("events.jsonl");
    if (!text) return [];
    const lines = text.split("\n").filter((line) => line.trim());
    return lines.slice(-limit).flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  }

  /** 该 stage 已发生的 attempt 文件名清单（审计"历史不丢"用） */
  async listAttempts(stageId: string): Promise<{ attempt: number; files: string[] }[]> {
    const dir = assertInsideRoot(this.root, `stages/${stageId}`);
    await this.assertPhysicalBoundary(dir);
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const byAttempt = new Map<number, string[]>();
    for (const name of names) {
      const matched = /^attempt-(\d+)\.(.+)$/.exec(name);
      if (!matched) continue;
      const attempt = Number(matched[1]);
      byAttempt.set(attempt, [...(byAttempt.get(attempt) ?? []), name]);
    }
    return [...byAttempt.entries()]
      .map(([attempt, files]) => ({ attempt, files: files.sort() }))
      .sort((a, b) => a.attempt - b.attempt);
  }

  /** Serialize the entire read/merge/rename, including writes from one-shot stages. */
  async updateManifest(update: (current: ArchiveManifest | null) => ArchiveManifest | null): Promise<void> {
    await this.withManifestWrite(async () => {
      const next = update(await this.readManifest());
      if (next) await this.writeJsonAtomic("manifest.json", { ...next, updatedAt: new Date().toISOString() });
    });
  }

  async updateLedger(stageId: string, entry: ArchiveLedgerEntry): Promise<void> {
    await this.updateManifest((manifest) => {
      if (!manifest) return null;
      const previous = manifest.ledger[stageId];
      if (previous && (previous.attempt > entry.attempt
        || (previous.attempt === entry.attempt && previous.status !== "running" && entry.status === "running"))) {
        return null;
      }
      return { ...manifest, ledger: { ...manifest.ledger, [stageId]: entry } };
    });
  }

  /** 幂等补齐 manifest（档案夹存在但 manifest 缺失/损坏时重建；不丢已有账本） */
  async readManifest(): Promise<ArchiveManifest | null> {
    const manifest = await this.readJson<ArchiveManifest>("manifest.json");
    if (manifest && (manifest.workspaceId !== this.workspaceId || manifest.projectId !== this.projectId)) {
      throw new ArchiveBoundaryError("ARCHIVE_SCOPE_INVALID", "档案身份与当前工作区/项目不一致");
    }
    return manifest;
  }

  /**
   * 把档案夹**外部**的运行态目录快照进档案（只读源目录，不删不改）。
   *
   * 为什么需要（真机发现的方案缺陷修复）：vendor 的 Phase checkpoint 在做指纹校验失败时
   * 会**删除**自己的 checkpoint 文件（`production-engine.js#_loadLatestCheckpoint`），
   * 于是"曾经有过断点、但恢复没生效"这段过程证据在重跑后被就地销毁。
   * 档案是过程证据的本体：每轮 attempt 开跑前留一份只读快照，恢复是否命中都能事后对账。
   *
   * @param sourceAbsDir 源目录绝对路径（例如 `<WORK_DIR>/checkpoints/<projectId>`）
   * @param destRelDir   档案内相对目录（例如 `checkpoints/attempt-2-before`）
   */
  async snapshotExternalDir(
    sourceAbsDir: string,
    destRelDir: string,
    opts: { maxFiles?: number; maxBytes?: number; filter?: (name: string) => boolean } = {},
  ): Promise<{ files: number; bytes: number; skipped: string[] }> {
    const maxFiles = opts.maxFiles ?? 200;
    const maxBytes = opts.maxBytes ?? 32 * 1024 * 1024;
    const destAbs = assertInsideRoot(this.root, destRelDir);
    await this.assertPhysicalBoundary(destAbs);
    let names: string[] = [];
    try {
      names = await fs.readdir(sourceAbsDir);
    } catch {
      return { files: 0, bytes: 0, skipped: [] };
    }
    const skipped: string[] = [];
    let files = 0;
    let bytes = 0;
    for (const name of names.sort()) {
      if (files >= maxFiles) {
        skipped.push(`${name}(超文件数上限)`);
        continue;
      }
      if (opts.filter && !opts.filter(name)) continue;
      const from = path.join(sourceAbsDir, name);
      let stat;
      try {
        stat = await fs.stat(from);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (bytes + stat.size > maxBytes) {
        skipped.push(`${name}(超体积上限)`);
        continue;
      }
      await fs.mkdir(path.dirname(destAbs), { recursive: true });
      await fs.mkdir(destAbs, { recursive: true });
      const destination = assertInsideRoot(this.root, path.join(destRelDir, name));
      await this.assertPhysicalBoundary(destination);
      await fs.copyFile(from, destination);
      files += 1;
      bytes += stat.size;
    }
    return { files, bytes, skipped };
  }
}
