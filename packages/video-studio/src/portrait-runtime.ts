/**
 * portrait-runtime.ts —— 定妆照真实出图运行时（vendor PortraitStudio 的 api 后端实现）
 *
 * 背景（2026-09-21 真机）：vendor 的定妆照阶段默认跑 `mode=interactive` + `executor=spec`：
 * 只产出"生成规格包"，17 张定妆照全部 pending → 角色绑定清单为空 → 渲染门
 * `BINDING_MANIFEST_INVALID` 直接拒片。产品口径是「全自动预生产」，定妆照必须真出图。
 *
 * 本模块把 PortraitStudio 的 `runtime` 三件事补齐（vendor 只读，运行期注入）：
 *   - apiRender(task, baseImage?)  逐张真实出图（火山方舟 Seedream，同步返回 URL），
 *                                  落盘到 `<workDir>/characters/<projectId>/<key>/portraits/<key>-<requestHash>-<angle>.png`
 *   - searchReferences(stage)      情报档案预填参考图（prefilled：免外部检索）
 *   - processImage(stage, images)  参考图标准化（本机为直通锚点：复制真实参考图作基准图，不做抠图）
 *
 * 命名口径与 vendor 渲染核心对齐（scripts/render-submitter-core.js 的 REQUIRED_ANGLES
 * `front / threeQuarter / closeup / side`）：角度 id 走 ANGLE_FILE_ALIASES 归一，
 * 绑定清单按索引中的精确路径消费当前版本，不通过扫描目录猜测版本。
 *
 * 幂等：完整请求与参考图字节相同、输出收据仍可核验才复用；不同请求写独立文件。
 */
import { existsSync, mkdirSync, readFileSync, statSync, lstatSync, realpathSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { shotIntentHash } from "./shot-intent.js";
import { isAbsolute, join, resolve, relative, dirname, sep } from "node:path";

/** vendor → 渲染核心要求的四个角度文件名（REQUIRED_ANGLES 口径） */
const ANGLE_FILE_ALIASES: Record<string, string> = {
  front_full: "front",
  side_full: "side",
  three_quarter: "threeQuarter",
  face_closeup: "closeup",
  back_full: "back",
  action_pose: "actionPose",
  emotion_closeup: "emotionCloseup",
  hand_detail: "handDetail"
};

/** 渲染核心要求的四角度（缺一即 BINDING_MANIFEST_INVALID） */
export const REQUIRED_ANGLES = ["front", "threeQuarter", "closeup", "side"] as const;

/** vendor 传给 apiRender 的任务形状（角色与商品两个分支的并集） */
export interface PortraitTask {
  portraitId?: string;
  characterId?: string;
  characterName?: string;
  productId?: string;
  productName?: string;
  angle?: string;
  view?: string;
  prompt?: string;
  /** 角色档案描述（供应商侧叫法不一，这里显式声明便于桥接） */
  characterDescription?: string;
  description?: string;
  [key: string]: unknown;
}

export interface PortraitInputReceipt { path: string; realPath: string; sha256: string; bytes: number }
export interface PortraitCacheReceipt {
  schemaVersion: "workloom.portrait-cache/v2";
  requestHash: string; sourceHash: string; kind: "character" | "product"; id: string; angle: string;
  model: string; size: string | null; endpoint: string; promptHash: string;
  references: PortraitInputReceipt[];
  output: PortraitInputReceipt;
}
export interface PortraitBaseReceipt {
  schemaVersion: "workloom.portrait-base/v1"; source: PortraitInputReceipt; output: PortraitInputReceipt;
}
/** Existing user-selected files are reuse evidence, never a newly generated model receipt. */
export interface PortraitReuseSelection {
  schemaVersion: "workloom.portrait-reuse-selection/v1";
  rawIntent: string;
  selectedVersion: number;
  expectedPortraits: number;
  selectedAt: string;
}
export interface ArchivedPortraitCharacter {
  id: string; name: string; aliases?: string[]; version: number;
  authorization: { status: "synthetic-no-real-person" };
  profile: PortraitInputReceipt;
  files: Record<string, PortraitInputReceipt>;
  wardrobe?: Record<string, unknown>;
}
export interface ArchivedPortraitCharacters {
  manifestPath: string; manifestSha256: string;
  approvedSelection: PortraitReuseSelection;
  characters: ArchivedPortraitCharacter[];
}
export interface PortraitReuseReceipt {
  schemaVersion: "workloom.portrait-reuse/v1";
  projectId: string; kind: "character"; id: string; angle: string;
  archiveId: string; archiveName: string; version: number;
  manifest: { path: string; sha256: string };
  selectionReceipt: PortraitReuseSelection;
  profile: PortraitInputReceipt; source: PortraitInputReceipt; output: PortraitInputReceipt;
  copiedAt: string; generationCount: 0;
}
export interface PortraitRuntimePlan {
  characterTasks: Array<Record<string, unknown>>;
  productTasks?: unknown[];
  summary?: string;
  [key: string]: unknown;
}
export interface PortraitIndexEntry {
  kind: "character" | "product";
  id: string;
  name: string;
  dir: string;
  /** 角度/视角 → 落盘绝对路径 */
  files: Record<string, string>;
  receipts?: Record<string, PortraitCacheReceipt>;
  reuseReceipts?: Record<string, PortraitReuseReceipt>;
  artifacts?: Record<string, PortraitInputReceipt>;
  portraitVersion?: number;
  pinnedVersion?: number;
  wardrobe?: Record<string, unknown>;
  wardrobeHash?: string;
}

export interface PortraitIndex {
  schemaVersion: "workloom.portrait-index/v1";
  projectId: string;
  generatedAt: string;
  characters: Record<string, PortraitIndexEntry>;
  products: Record<string, PortraitIndexEntry>;
  baseImages?: Record<string, PortraitBaseReceipt>;
}

export interface PortraitRuntimeOptions {
  /** 运行产物根（与 vendor 的 charactersDir 同一口径），默认 .vm-work */
  workDir: string;
  projectId: string;
  /** 火山方舟密钥（ARK_API_KEY / VOLCENGINE_ARK_API_KEY） */
  apiKey: string;
  /** 默认 https://ark.cn-beijing.volces.com/api/v3 */
  baseUrl?: string;
  /** 图像模型 id，默认 doubao-seedream-5-0-pro-260628（媒体目录同款） */
  model: string;
  /** 出图尺寸口径（媒体目录登记 2K/4K；vendor 直传亦可） */
  size?: string;
  timeoutMs?: number;
  /** 商品（服务）参考图：真实实拍图绝对/相对路径，顺序即优先级 */
  referenceImages?: string[];
  /** 角色锚定参考图（例如实拍人物），缺省不锚定 */
  characterAnchorImages?: string[];
  /**
   * 角色定妆照是否必须有可用的"角色档案"描述（默认 false，保持 vendor 既有行为；
   * WorkLoom 生产链路在 `studio-worker` 里显式打开）。
   * 真机事故 2026-09-23：描述为空时走兜底写法（只有"名字 + 角度 + 规范"），
   * 生成结果与角色设定无关（要求"三十岁上下女性"却出了个男性模特），
   * 进而污染整条真人出镜链路。打开后没有描述即拒绝出图（fail-closed）。
   */
  requireCharacterDescription?: boolean;
  /** 单次生成随附参考图上限（Seedance/Seedream 一致性口径 4 张） */
  maxReferenceImages?: number;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** 失败重试次数（仅网络/限流/5xx 类，默认 2） */
  retries?: number;
  /** Server-controlled, explicitly selected existing synthetic-character version. No generation fallback. */
  archivedCharacters?: ArchivedPortraitCharacters;
  /** Strict reuse run: every portrait task must belong to the selected archive; no new image request. */
  archivedCharactersOnly?: boolean;
}

export interface ReferenceSearchStageLike {
  productId?: string;
  prefilledFrom?: string;
  referenceImages?: Array<{ url?: string; localPath?: string | null }>;
  [key: string]: unknown;
}

export interface ProcessingStageLike {
  outputBaseImage?: string | null;
  [key: string]: unknown;
}

export interface PortraitRuntime {
  apiRender(task: PortraitTask, baseImage?: string | null): Promise<string>;
  searchReferences(stage: ReferenceSearchStageLike): Promise<string[]>;
  processImage(stage: ProcessingStageLike, images?: string[]): Promise<string>;
  /** 当前索引快照（角色/商品已出图清单，供渲染侧挑选参考图） */
  snapshot(): PortraitIndex;
  /** 索引落盘位置 */
  indexPath(): string;
  /** Bind only available archived views before the vendor begins portrait execution. */
  preparePlan?(plan: PortraitRuntimePlan): PortraitRuntimePlan;
}

const IMAGE_DOWNLOAD_TIMEOUT_MS = 120_000;
const CACHE_VERSION = "workloom.portrait-cache/v2" as const;
const inFlight = new Map<string, Promise<string>>();
const hashBytes = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function snapshotFile(path: string, minBytes = 1024): { receipt: PortraitInputReceipt; bytes: Buffer } {
  const realPath = realpathSync(path);
  const stat = statSync(realPath);
  if (!stat.isFile() || stat.size < minBytes || stat.size > 100_000_000) throw new Error(`PORTRAIT_INPUT_INVALID: 来源不是有效大小的普通文件：${path}`);
  const bytes = readFileSync(realPath);
  if (bytes.length !== stat.size || realpathSync(path) !== realPath) throw new Error(`PORTRAIT_INPUT_CHANGED: 读取期间来源变化：${path}`);
  return { receipt: { path: resolve(path), realPath, sha256: hashBytes(bytes), bytes: bytes.length }, bytes };
}
function verifySource(source: PortraitInputReceipt, minBytes = 1024): void {
  const current = snapshotFile(source.path, minBytes).receipt;
  if (shotIntentHash(current) !== shotIntentHash(source)) throw new Error(`PORTRAIT_INPUT_CHANGED: 请求期间参考图发生变化：${source.path}`);
}
function safeComponent(value: string, label: string): string {
  if (!value || value === "." || value === ".." || /[\\/\u0000-\u001f]/.test(value)) throw new Error(`PORTRAIT_PATH_INVALID: ${label}`);
  return value;
}
function identityKey(id: string): string {
  const key = portraitKey(id);
  return key === id && !["_products", "__proto__"].includes(key) && [...key].length <= 24 ? key : `${[...key].slice(0, 24).join("")}-${shotIntentHash(id).slice(0, 16)}`;
}

/**
 * 目录/文件名的安全化：**保留中文等非 ASCII 字符**。
 *
 * 真机教训（2026-09-21）：早先版本把所有非 ASCII 字符替换成 "-"，于是
 * `住客-three_quarter` 被压成 `three_quarter` → 三个角色的定妆照互相覆盖、还被归到商品桶。
 * 中文名在文件系统与绑定清单里都是合法标识，只清洗路径分隔符/保留字符即可。
 */
export function portraitKey(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "");
  return cleaned || "subject";
}

/** 从 vendor 的 portraitId（`<characterId>-<angleId>`）剥掉角度后缀，还原主体标识 */
function stripAngleSuffix(portraitId: string, angleRaw: string): string {
  if (!portraitId || !angleRaw) return portraitId;
  const escaped = angleRaw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return portraitId.replace(new RegExp(`[-_/\\s]+${escaped}$`), "");
}

/** 从 vendor 的定妆照提示词模板里取角色名：`【定妆照】<name> — <angleName>` */
function characterNameFromPrompt(prompt: unknown): string {
  if (typeof prompt !== "string") return "";
  const match = prompt.match(/【定妆照】\s*([^—\n]+?)\s*—/);
  return match?.[1]?.trim() ?? "";
}

function nonEmptyFile(file: string): boolean {
  try {
    return existsSync(file) && statSync(file).size > 1024;
  } catch {
    return false;
  }
}

function resolveLocal(image: string, workDir: string): string {
  return isAbsolute(image) ? image : resolve(workDir, image);
}

function portraitImageExtension(bytes: Buffer, source: string): "png" | "jpg" | "webp" {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  return /\.png$/i.test(source) ? "png" : /\.webp$/i.test(source) ? "webp" : "jpg";
}

/**
 * 创建定妆照真实出图运行时。
 *
 * 失败策略：出图失败直接抛错（vendor 会把该张记为 failed 并继续下一张，不静默降级成假成功）。
 */
export function createPortraitRuntime(options: PortraitRuntimeOptions): PortraitRuntime {
  const {
    workDir,
    projectId,
    apiKey,
    model,
    baseUrl = "https://ark.cn-beijing.volces.com/api/v3",
    size,
    timeoutMs = 240_000,
    referenceImages = [],
    characterAnchorImages = [],
    requireCharacterDescription = false,
    maxReferenceImages = 4,
    retries = 2
  } = options;
  safeComponent(projectId, "projectId");
  if (!model?.trim() || !apiKey?.trim()) throw new Error("PORTRAIT_CONFIG_INVALID: 缺model/apiKey");
  if (!Number.isInteger(maxReferenceImages) || maxReferenceImages < 1 || maxReferenceImages > 4) throw new Error("PORTRAIT_CONFIG_INVALID: maxReferenceImages必须为1..4");
  if (!Number.isInteger(retries) || retries < 0 || retries > 5 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 900_000) throw new Error("PORTRAIT_CONFIG_INVALID: 重试次数或超时非法");
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => undefined);
  const base = baseUrl.replace(/\/$/, "");
  const workRoot = resolve(workDir);
  mkdirSync(workRoot, { recursive: true });
  const workRealPath = realpathSync(workRoot);
  const inside = (basePath: string, candidate: string): boolean => { const rel = relative(basePath, candidate); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
  let scopePath = workRoot;
  for (const component of ["characters", projectId]) {
    if (!inside(workRealPath, realpathSync(scopePath))) throw new Error("PORTRAIT_PATH_INVALID: 项目目录逃离workDir");
    scopePath = join(scopePath, component);
    if (!existsSync(scopePath)) { try { mkdirSync(scopePath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
    if (!inside(workRealPath, realpathSync(scopePath))) throw new Error("PORTRAIT_PATH_INVALID: 项目目录逃离workDir");
  }
  const charactersRoot = scopePath;
  const rootRealPath = realpathSync(charactersRoot);
  const indexFile = join(charactersRoot, "portrait-index.json");
  const archived = options.archivedCharacters;
  let manifestReceipt: PortraitInputReceipt | undefined;
  if (options.archivedCharactersOnly && !archived) throw new Error("PORTRAIT_ARCHIVE_REQUIRED: archivedCharactersOnly 缺少归档清单");
  if (archived) {
    if (!record(archived) || !Array.isArray(archived.characters) || archived.characters.length === 0
      || !record(archived.approvedSelection) || archived.approvedSelection.schemaVersion !== "workloom.portrait-reuse-selection/v1"
      || typeof archived.approvedSelection.rawIntent !== "string" || !archived.approvedSelection.rawIntent.trim()
      || !Number.isInteger(archived.approvedSelection.selectedVersion) || archived.approvedSelection.selectedVersion < 1
      || !Number.isInteger(archived.approvedSelection.expectedPortraits)
      || archived.approvedSelection.expectedPortraits !== archived.characters.length * REQUIRED_ANGLES.length
      || !Number.isFinite(Date.parse(archived.approvedSelection.selectedAt))) {
      throw new Error("PORTRAIT_ARCHIVE_INVALID: 缺少本次用户选择或完整四角度数量");
    }
    manifestReceipt = snapshotFile(archived.manifestPath, 1).receipt;
    if (manifestReceipt.sha256 !== archived.manifestSha256) throw new Error("PORTRAIT_ARCHIVE_CHANGED: 归档清单摘要不一致");
    const manifest = JSON.parse(readFileSync(manifestReceipt.realPath, "utf8"));
    if (manifest.schemaVersion !== "workloom.portrait-reuse-manifest/v1"
      || shotIntentHash(manifest.characters) !== shotIntentHash(archived.characters)
      || shotIntentHash(manifest.approvedSelection) !== shotIntentHash(archived.approvedSelection)) {
      throw new Error("PORTRAIT_ARCHIVE_INVALID: 运行参数与实际归档清单不一致");
    }
    const aliases = new Set<string>();
    for (const item of archived.characters) {
      if (!record(item) || typeof item.id !== "string" || !item.id.trim() || typeof item.name !== "string" || !item.name.trim()
        || item.version !== archived.approvedSelection.selectedVersion || item.authorization?.status !== "synthetic-no-real-person"
        || !record(item.files) || REQUIRED_ANGLES.some(angle => !record(item.files[angle]))) {
        throw new Error("PORTRAIT_ARCHIVE_INVALID: 只能复用本次选定、四角度齐备的纯AI角色");
      }
      for (const alias of new Set([item.id, item.name, ...(item.aliases ?? [])])) {
        if (typeof alias !== "string" || !alias.trim() || aliases.has(alias)) throw new Error("PORTRAIT_ARCHIVE_INVALID: 角色别名为空或有歧义");
        aliases.add(alias);
      }
      verifySource(item.profile, 1);
      const profile = JSON.parse(readFileSync(item.profile.realPath, "utf8"));
      if (!["synthetic-digital-human", "generated"].includes(profile.kind) || profile.authorization?.status !== "synthetic-no-real-person") {
        throw new Error("PORTRAIT_ARCHIVE_INVALID: 源角色档案不支持纯AI归档复用");
      }
      for (const angle of REQUIRED_ANGLES) verifySource(item.files[angle]!);
    }
  }

  function archivedCharacter(id: string, name: string): ArchivedPortraitCharacter {
    const matches = archived?.characters.filter(item => [item.id, item.name, ...(item.aliases ?? [])].some(alias => alias === id || alias === name)) ?? [];
    if (matches.length !== 1) throw new Error(`PORTRAIT_ARCHIVE_IDENTITY_MISMATCH: ${name || id} 没有唯一的本次选定归档，禁止重新生成`);
    return matches[0]!;
  }

  const index: PortraitIndex = {
    schemaVersion: "workloom.portrait-index/v1",
    projectId,
    generatedAt: new Date().toISOString(),
    characters: {},
    products: {}
  };

  function refreshIndex(): void {
    if (!existsSync(indexFile)) return;
    if (lstatSync(indexFile).isSymbolicLink() || realpathSync(indexFile) !== join(rootRealPath, "portrait-index.json")) throw new Error("PORTRAIT_INDEX_INVALID: 索引不能是符号链接或逃离项目");
    const loaded: unknown = JSON.parse(readFileSync(indexFile, "utf8"));
    if (!record(loaded) || loaded.schemaVersion !== "workloom.portrait-index/v1" || loaded.projectId !== projectId
      || !record(loaded.characters) || !record(loaded.products) || (loaded.baseImages !== undefined && !record(loaded.baseImages))) {
      throw new Error("PORTRAIT_INDEX_INVALID: 索引结构或项目不匹配，不能以空索引覆盖");
    }
    index.characters = loaded.characters as Record<string, PortraitIndexEntry>;
    index.products = loaded.products as Record<string, PortraitIndexEntry>;
    index.baseImages = (loaded.baseImages ?? {}) as Record<string, PortraitBaseReceipt>;
  }
  refreshIndex();

  function assertOutputDirectory(dir: string): void {
    const rel = relative(rootRealPath, realpathSync(dir));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`PORTRAIT_PATH_INVALID: 输出目录逃离项目：${dir}`);
    if (realpathSync(charactersRoot) !== rootRealPath) throw new Error("PORTRAIT_PATH_CHANGED: 项目根目录发生变化");
  }
  function ensureOutputDirectory(dir: string): void {
    let current = charactersRoot;
    const rel = relative(charactersRoot, dir);
    if (!inside(charactersRoot, dir)) throw new Error("PORTRAIT_PATH_INVALID: 输出目录越界");
    for (const part of rel.split(sep).filter(Boolean)) {
      assertOutputDirectory(current);
      current = join(current, part);
      if (!existsSync(current)) { try { mkdirSync(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
      assertOutputDirectory(current);
    }
    assertOutputDirectory(dir);
  }
  function atomicWrite(path: string, bytes: string | Buffer): void {
    ensureOutputDirectory(dirname(path));
    const temp = join(dirname(path), `.portrait-${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
      assertOutputDirectory(dirname(path));
      renameSync(temp, path);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  function persistIndex(): void {
    index.generatedAt = new Date().toISOString();
    atomicWrite(indexFile, `${JSON.stringify(index, null, 2)}\n`);
  }
  /** Serialize filesystem publication across runtime instances and processes. Never steal an unknown paid request's lock. */
  async function locked<T>(fn: () => Promise<T>): Promise<T> {
    const path = join(charactersRoot, ".portrait-cache.lock");
    const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
    const started = Date.now();
    for (;;) {
      assertOutputDirectory(charactersRoot);
      try {
        const fd = openSync(path, "wx", 0o600);
        try { writeFileSync(fd, owner); } finally { closeSync(fd); }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let existing: string;
        try {
          if (lstatSync(path).isSymbolicLink()) throw new Error("PORTRAIT_CACHE_LOCK_INVALID: 锁不能是符号链接");
          existing = readFileSync(path, "utf8");
        } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        if (existing) {
          let holder: unknown;
          try { holder = JSON.parse(existing); } catch { throw new Error("PORTRAIT_CACHE_LOCK_INVALID: 锁内容不可核实"); }
          if (!record(holder) || !Number.isInteger(holder.pid) || Number(holder.pid) <= 0 || typeof holder.token !== "string") throw new Error("PORTRAIT_CACHE_LOCK_INVALID: 锁所有者不可核实");
          try { process.kill(Number(holder.pid), 0); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") throw new Error("PORTRAIT_CACHE_LOCK_STALE: 上次进程已结束，需核对是否已收费/有产物后恢复，禁止盲目重发");
            if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
          }
        }
        if (Date.now() - started > timeoutMs) throw new Error("PORTRAIT_CACHE_BUSY: 等待项目缓存锁超时，未发出重复请求");
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    try { refreshIndex(); return await fn(); }
    finally {
      if (readFileSync(path, "utf8") !== owner) throw new Error("PORTRAIT_CACHE_LOCK_CHANGED: 不删除其他请求的锁");
      unlinkSync(path);
    }
  }
  function upsert(bucket: "characters" | "products", key: string, name: string, dir: string, receipt: PortraitCacheReceipt): void {
    const existing = index[bucket][key];
    index[bucket][key] = {
      kind: receipt.kind, id: receipt.id, name, dir,
      files: { ...(existing?.id === receipt.id && existing.kind === receipt.kind ? existing.files : {}), [receipt.angle]: receipt.output.path },
      receipts: { ...(existing?.id === receipt.id && existing.kind === receipt.kind ? existing.receipts : {}), [receipt.angle]: receipt },
    };
    persistIndex();
  }
  function validOutput(output: PortraitInputReceipt, expected: string): boolean {
    try {
      if (!record(output) || output.path !== expected || lstatSync(expected).isSymbolicLink()) return false;
      assertOutputDirectory(dirname(expected));
      return shotIntentHash(snapshotFile(expected).receipt) === shotIntentHash(output);
    } catch (error) {
      log(`[portrait] 缓存输出不可核验：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
  function existingPortrait(bucket: "characters" | "products", key: string, receipt: Omit<PortraitCacheReceipt, "output">, expected: string): string | null {
    const entry = index[bucket][key];
    const stored = entry?.receipts?.[receipt.angle];
    if (!stored || entry.kind !== receipt.kind || entry.id !== receipt.id || entry.files?.[receipt.angle] !== expected) return null;
    const { output, ...storedRequest } = stored;
    return shotIntentHash(storedRequest) === shotIntentHash(receipt) && validOutput(output, expected) ? expected : null;
  }
  function anchorsFor(kind: "character" | "product", baseImage?: string | null): Array<ReturnType<typeof snapshotFile>> {
    const configured = kind === "character" ? characterAnchorImages : referenceImages;
    const paths = [...(baseImage ? [resolveLocal(baseImage, workDir)] : []), ...configured.map((file) => resolveLocal(file, workDir))];
    return [...new Set(paths)].slice(0, maxReferenceImages).map(snapshotFile);
  }

  async function reusePortrait(task: PortraitTask, id: string, name: string, angle: string): Promise<string> {
    const item = archivedCharacter(id, name);
    const source = item.files[angle];
    if (!source || !REQUIRED_ANGLES.includes(angle as typeof REQUIRED_ANGLES[number])) throw new Error(`PORTRAIT_ARCHIVE_ANGLE_MISSING: ${item.name}/${angle} 未选定且禁止补图`);
    const taskHash = shotIntentHash(task);
    const key = identityKey(id);
    const dir = join(charactersRoot, key);
    const extension = portraitImageExtension(snapshotFile(source.path).bytes, source.path);
    const file = join(dir, "portraits", `${key}-archive-v${item.version}-${source.sha256}-${angle}.${extension}`);
    return locked(async () => {
      if (shotIntentHash(task) !== taskHash) throw new Error("PORTRAIT_INPUT_CHANGED: 复用等待期间任务变化");
      verifySource(manifestReceipt!, 1); verifySource(item.profile, 1); verifySource(source);
      const bytes = snapshotFile(source.path).bytes;
      const previous = index.characters[key];
      const own = previous?.id === id && previous.kind === "character" ? previous : undefined;
      const mainViews = <T>(values: Record<string, T> | undefined): Record<string, T> => Object.fromEntries(Object.entries(values ?? {}).filter(([key]) => REQUIRED_ANGLES.includes(key as typeof REQUIRED_ANGLES[number])));
      // An explicit four-view selection replaces the active index, while old files remain immutable.
      if (own) {
        own.files = mainViews(own.files); own.artifacts = mainViews(own.artifacts); own.reuseReceipts = mainViews(own.reuseReceipts);
      }
      atomicWrite(file, bytes);
      const output = snapshotFile(file).receipt;
      verifySource(source);
      if (output.sha256 !== source.sha256) throw new Error("PORTRAIT_REUSE_CHANGED: 复制后摘要不一致");
      const receipt: PortraitReuseReceipt = {
        schemaVersion: "workloom.portrait-reuse/v1", projectId, kind: "character", id, angle,
        archiveId: item.id, archiveName: item.name, version: item.version,
        manifest: { path: manifestReceipt!.path, sha256: archived!.manifestSha256 },
        selectionReceipt: structuredClone(archived!.approvedSelection), profile: item.profile, source, output,
        copiedAt: new Date().toISOString(), generationCount: 0,
      };
      index.characters[key] = {
        kind: "character", id, name, dir, portraitVersion: item.version, pinnedVersion: item.version,
        ...(item.wardrobe ? { wardrobe: structuredClone(item.wardrobe), wardrobeHash: shotIntentHash(item.wardrobe) } : {}),
        files: { ...(own?.files ?? {}), [angle]: file },
        artifacts: { ...(own?.artifacts ?? {}), [angle]: output },
        reuseReceipts: { ...(own?.reuseReceipts ?? {}), [angle]: receipt },
      };
      persistIndex();
      log(`[portrait] 复用已选归档：${item.name} v${item.version}/${angle}，当前字节 ${source.sha256.slice(0, 12)}，本次生成0张`);
      return file;
    });
  }

  function preparePlan(plan: PortraitRuntimePlan): PortraitRuntimePlan {
    if (!archived) return plan;
    verifySource(manifestReceipt!, 1);
    if (!record(plan) || !Array.isArray(plan.characterTasks)) throw new Error("PORTRAIT_ARCHIVE_PLAN_INVALID: 缺少角色计划");
    const used = new Set<string>();
    const characterTasks = plan.characterTasks.map(task => {
      const id = String(task.characterId ?? task.characterName ?? "");
      const name = String(task.characterName ?? task.characterId ?? "");
      const item = archivedCharacter(id, name);
      if (used.has(item.id)) throw new Error("PORTRAIT_ARCHIVE_PLAN_INVALID: 同一选定角色被重复规划");
      used.add(item.id);
      return { ...task, angleCount: REQUIRED_ANGLES.length, reuseSource: "existing-selected-archive", portraits: REQUIRED_ANGLES.map(angle => ({
        portraitId: `${id}-${angle}`, characterId: id, characterName: name, angle,
        angleName: angle, status: "pending", outputFile: null,
        reuse: { archiveId: item.id, version: item.version, sourceSha256: item.files[angle]!.sha256 },
      })) };
    });
    if (used.size !== archived.characters.length) throw new Error("PORTRAIT_ARCHIVE_PLAN_INVALID: 正式角色计划遗漏本次指定人物");
    return { ...plan, characterTasks, summary: `${plan.summary ?? ""}\n本次角色复用：${archived.characters.map(item => `${item.name} v${item.version} 四角度`).join("、")}；角色生成0张；未选定的额外角度不再生成。` };
  }

  function buildPrompt(task: PortraitTask, kind: "character" | "product", angleRaw: string): string {
    const parts: string[] = [];
    if (typeof task.prompt === "string" && task.prompt.trim()) parts.push(task.prompt.trim());
    else {
      const name = String(task.characterName || task.characterId || task.productName || task.productId || "主体");
      parts.push(`【定妆照】${name} — ${angleRaw}`);
    }
    if (kind === "character") {
      const profile = characterProfileOf(task);
      if (profile) {
        if (!parts.some((part) => part.includes("角色档案"))) parts.push(`角色档案：${profile}`);
      } else if (requireCharacterDescription) {
        const name = String(task.characterName || task.characterId || "该角色");
        throw new Error(
          `角色定妆照缺少「角色档案」描述（${name}）：拒绝无描述出图——历史事故里这会生成与设定无关的人物`
          + "（如要求女性却出男性）。请在剧本/蓝图里补齐角色描述，或显式设 requireCharacterDescription=false。"
        );
      } else {
        /** 不阻断，但绝不静默：无描述=人物由模型自由发挥，真机事故根因之一 */
        log(
          `[portrait] ⚠️ 角色「${String(task.characterName || task.characterId || "未命名")}」缺少角色档案描述：`
          + "本次出图人物由模型自由发挥（与设定/真人可能无关）；生产链路应开启 requireCharacterDescription。"
        );
      }
    }
    parts.push("规范：写实摄影质感，主体完整入画，无文字无水印无边框，无多余肢体");
    if (kind === "product") parts.push("以参考图中的真实场景/空间为准，保持建筑、家具与材质细节不漂移");
    return parts.join("\n");
  }

  /**
   * 从任务里取"角色档案"描述：优先任务自带字段，其次 prompt 里的 `角色档案：…` 行，
   * 最后兜底检查 prompt 本身是否已是足够具体的人物描写。
   * 返回 null 表示"描述不可用"（调用方按 fail-closed 处理）。
   */
  function characterProfileOf(task: PortraitTask): string | null {
    const explicit = [task.characterDescription, task.description]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .find((value) => usableProfile(value) !== null);
    if (explicit) return usableProfile(explicit);
    const prompt = typeof task.prompt === "string" ? task.prompt : "";
    const line = /角色档案[:：]\s*([^\n]+)/.exec(prompt)?.[1]?.trim() ?? "";
    const fromLine = usableProfile(line, task.characterName ?? task.characterId);
    if (fromLine) return fromLine;
    /** 兜底只认"整段就是人物描写"的提示词：先剥掉定妆照模板行，避免把模板当成角色档案 */
    const stripped = prompt
      .replace(/【定妆照】[^\n]*/g, "")
      .replace(/^\s*(构图|规范|一致性|视觉系统|角度|背景)[:：][^\n]*$/gm, "")
      .trim();
    return usableProfile(stripped, task.characterName ?? task.characterId);
  }

  /** 去掉角色名与"human/真人/角色"这类占位词后，仍需足够具体才算可用描述 */
  function usableProfile(raw: string, name?: string): string | null {
    let text = raw.trim();
    if (!text) return null;
    if (name) text = text.split(name).join(" ");
    text = text.replace(/^(角色档案|角色|人物)[:：]\s*/, "")
      .replace(/\b(human|person|character)\b/gi, " ")
      .replace(/定妆照|全身|半身|正面|侧面|背面|近景|远景|特写/g, " ")
      .replace(/[，。、；;：:（）()【】\s]/g, "");
    const descriptive = /[女男]|[0-9一二三四五六七八九十]{1,2}\s*十?岁|发|裙|衣|装|妆|身高|体型|气质|脸|眼/;
    return text.length >= 8 && descriptive.test(text) ? raw.trim() : null;
  }

  async function generateImage(payload: Record<string, unknown>): Promise<string> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const res = await fetchImpl(`${base}/images/generations`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs)
        });
        const text = await res.text();
        if (!res.ok) {
          const err = new Error(`定妆照出图失败：HTTP ${res.status} ${text.slice(0, 200)}`);
          if (res.status === 429 || res.status >= 500) {
            lastError = err;
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
            continue;
          }
          Object.assign(err, { noRetry: true });
          throw err;
        }
        let data: { data?: Array<{ url?: string; size?: string }> };
        try { data = JSON.parse(text) as typeof data; }
        catch { throw Object.assign(new Error("定妆照出图成功响应不是有效JSON，禁止自动重复收费"), { noRetry: true }); }
        const url = data?.data?.[0]?.url;
        if (!url) throw Object.assign(new Error(`定妆照出图响应缺少 url：${text.slice(0, 200)}`), { noRetry: true });
        log(`[portrait] 出图成功（${data.data?.[0]?.size ?? "?"}）`);
        return url;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if ((err as { noRetry?: boolean })?.noRetry || attempt >= retries) break;
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    throw lastError ?? new Error("定妆照出图失败：未知错误");
  }

  async function download(url: string): Promise<Buffer> {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`定妆照下载失败：HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < 1024) throw new Error(`定妆照下载内容过小（${buf.byteLength} 字节）`);
    return buf;
  }

  async function apiRender(task: PortraitTask, baseImage?: string | null): Promise<string> {
    if (!record(task)) throw new Error("PORTRAIT_TASK_INVALID: 任务必须为对象");
    const sourceHash = shotIntentHash(task);
    const angleRaw = String(task.angle || task.view || "view");
    const hasCharacter = Boolean(task.characterId || task.characterName);
    const hasProduct = Boolean(task.productId || task.productName);
    if (hasCharacter && hasProduct) throw new Error("PORTRAIT_TASK_AMBIGUOUS: 角色和商品身份不能混在同一任务");
    const kind = hasCharacter ? "character" : hasProduct || task.view ? "product" : "character";
    if (kind === "product" && options.archivedCharactersOnly) throw new Error("PORTRAIT_ARCHIVE_ONLY: 本次仅复用已选人物，禁止额外商品或未知主体出图");
    const explicitId = kind === "product" ? task.productId || task.productName : task.characterId || task.characterName;
    const id = String(explicitId || stripAngleSuffix(String(task.portraitId ?? ""), angleRaw) || "subject");
    const name = String((kind === "product" ? task.productName || task.productId : task.characterName || characterNameFromPrompt(task.prompt)) || explicitId || id);
    const angle = ANGLE_FILE_ALIASES[angleRaw] ?? angleRaw;
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(angle)) throw new Error("PORTRAIT_ANGLE_INVALID: 角度不能用作路径或无效标识");
    const key = identityKey(id);
    const bucket = kind === "character" ? "characters" : "products";
    if (kind === "character" && archived) return reusePortrait(task, id, name, angle);
    // Build and validate all actual request inputs before considering the cache.
    const prompt = buildPrompt(task, kind, angleRaw);
    const anchors = anchorsFor(kind, baseImage);
    const images = anchors.map(({ receipt, bytes }) => `data:image/${receipt.path.toLowerCase().endsWith(".png") ? "png" : "jpeg"};base64,${bytes.toString("base64")}`);
    const payload: Record<string, unknown> = { model, prompt, response_format: "url", watermark: false, ...(size ? { size } : {}), ...(images.length ? { image: images.length === 1 ? images[0] : images } : {}) };
    const endpoint = `${base}/images/generations`;
    const requestHash = shotIntentHash({ schemaVersion: CACHE_VERSION, projectId, kind, id, angle, sourceHash, endpoint, payload, references: anchors.map((anchor) => anchor.receipt) });
    const planned: Omit<PortraitCacheReceipt, "output"> = { schemaVersion: CACHE_VERSION, requestHash, sourceHash, kind, id, angle, model, size: size ?? null, endpoint, promptHash: shotIntentHash(prompt), references: anchors.map((anchor) => anchor.receipt) };
    const dir = kind === "character" ? join(charactersRoot, key) : join(charactersRoot, "_products", key);
    const file = join(dir, "portraits", `${key}-${requestHash}-${angle}.png`);
    const flightKey = `${indexFile}:${requestHash}`;
    const pending = inFlight.get(flightKey);
    if (pending) {
      const output = await pending;
      if (shotIntentHash(task) !== sourceHash) throw new Error("PORTRAIT_INPUT_CHANGED: 并发等待期间角色任务变化");
      for (const anchor of anchors) verifySource(anchor.receipt);
      refreshIndex(); return output;
    }
    const operation = locked(async () => {
      if (shotIntentHash(task) !== sourceHash) throw new Error("PORTRAIT_INPUT_CHANGED: 等待期间角色任务变化");
      for (const anchor of anchors) verifySource(anchor.receipt);
      const cached = existingPortrait(bucket, key, planned, file);
      if (cached) { log(`[portrait] 完整请求及产物哈希一致，复用：${kind}/${key}/${angle}`); return cached; }
      ensureOutputDirectory(dirname(file));
      log(`[portrait] 出图：${name} / ${angle}，来源 ${requestHash.slice(0, 12)}，锚点 ${anchors.length}`);
      const url = await generateImage(payload);
      const bytes = await download(url);
      if (shotIntentHash(task) !== sourceHash) throw new Error("PORTRAIT_INPUT_CHANGED: 出图期间角色任务变化，产物未纳入索引");
      for (const anchor of anchors) verifySource(anchor.receipt);
      atomicWrite(file, bytes);
      const output = snapshotFile(file).receipt;
      if (output.sha256 !== hashBytes(bytes)) throw new Error("PORTRAIT_OUTPUT_CHANGED: 落盘期间产物变化");
      upsert(bucket, key, name, dir, { ...planned, output });
      return file;
    });
    inFlight.set(flightKey, operation);
    try { return await operation; }
    finally { if (inFlight.get(flightKey) === operation) inFlight.delete(flightKey); }
  }

  /** 情报档案预填：直接返回真实实拍参考图（prefilled 分支，免外部检索） */
  async function searchReferences(_stage: ReferenceSearchStageLike): Promise<string[]> {
    const images = referenceImages
      .map((image) => resolveLocal(image, workDir))
      .filter((file) => nonEmptyFile(file));
    if (images.length === 0) {
      log("[portrait] 未配置参考图：商品/服务定妆照将无真实锚点（仅按文字规格生成）");
    } else {
      log(`[portrait] 参考图预填 ${images.length} 张（prefilled，免外部检索）`);
    }
    return images.slice(0, maxReferenceImages);
  }

  /**
   * 参考图标准化（本机直通口径）：
   * 不做抠图/白底（服务类分支本身也不要求白底），把首选参考图复制为基准图，
   * 作为后续 5 视角风格化的唯一真实锚点。
   */
  async function processImage(stage: ProcessingStageLike, images?: string[]): Promise<string> {
    const candidates = [...(images ?? []), ...referenceImages].map((image) => resolveLocal(String(image), workDir));
    const sourcePath = candidates[0] ?? (stage.outputBaseImage ? resolveLocal(stage.outputBaseImage, workDir) : undefined);
    if (!sourcePath) throw new Error("参考图标准化失败：没有可用的真实参考图（禁止无参考生成）");
    const source = snapshotFile(sourcePath);
    const sourceHash = shotIntentHash(source.receipt);
    const ext = sourcePath.toLowerCase().endsWith(".png") ? "png" : "jpg";
    const out = join(charactersRoot, "_product-base", `base-${sourceHash}.${ext}`);
    return locked(async () => {
      verifySource(source.receipt);
      const prior = index.baseImages?.[sourceHash];
      if (prior?.schemaVersion === "workloom.portrait-base/v1" && shotIntentHash(prior.source) === sourceHash && validOutput(prior.output, out)) return out;
      atomicWrite(out, source.bytes);
      verifySource(source.receipt);
      index.baseImages = { ...index.baseImages, [sourceHash]: { schemaVersion: "workloom.portrait-base/v1", source: source.receipt, output: snapshotFile(out).receipt } };
      persistIndex(); log(`[portrait] 基准图按当前来源字节就位：${out}`); return out;
    });
  }

  return {
    apiRender,
    searchReferences,
    processImage,
    snapshot: () => structuredClone(index),
    indexPath: () => indexFile,
    ...(archived ? { preparePlan } : {})
  };
}
