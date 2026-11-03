/**
 * video/gen/ingest.ts —— 成片入库（T-2026-0921-0002）
 *
 * 为什么必须做：供应商产物只保证保留 7 天（Higgsfield 官方口径），只存 URL = 资产会丢。
 * 流程：下载 → sha256 → 落自有媒体库（WORKLOOM_MEDIA_DIR，默认 <repo>/var/media）→
 *      asset-cms.register(kind=final_cut)（sha256 幂等去重）→ 返回 assetId 用于 render_jobs 回链。
 * 播放：签名 URL（HMAC + 过期时间），`/media/*` 路由校验后才吐文件——不做无鉴权裸目录。
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, existsSync, fstatSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, resolve, sep } from "node:path";
import type { getAppPool, getGatewayPool } from "@workloom/db";
import { register } from "@workloom/base/asset-cms";
import { newId } from "@workloom/shared";
import type { Scope } from "./db.js";
import { probeMedia } from "../media/ffmpeg.js";
import { safeSegment } from "../media/paths.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../../../../..");

export function mediaRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.WORKLOOM_MEDIA_DIR?.trim() || join(REPO_ROOT, "var/media");
}

export interface DownloadedMedia {
  relPath: string;
  absPath: string;
  sha256: string;
  bytes: number;
  contentType: string | null;
}

const DEFAULT_MAX_BYTES = 300 * 1024 * 1024; // 300MB：短视频上限；超限拒收，避免磁盘被写爆

/**
 * 取供应商/本地产物到媒体库（sha256 幂等；超限拒收）。
 *
 * 支持两种来源：
 *   · `http(s)://` —— 远端供应商产物（原行为：整段取回后落盘并算 sha256）；
 *   · `file://`    —— **本地渲染产物**（T-2026-0926-0020 新增）。
 *     为什么必须支持：手绘白板引擎是本地确定性渲染器，产物天然在磁盘上，
 *     没有远端 URL。若这里只认 http(s)，白板片就永远进不了媒资库，
 *     只能被迫写一条平行入库路径——违反"零平行实现"的口径。
 */
export async function downloadToMediaStore(
  uri: string,
  opts: { workspaceId: string; maxBytes?: number; fetchImpl?: typeof fetch } = { workspaceId: "unknown" },
): Promise<DownloadedMedia> {
  if (/^file:\/\//i.test(uri)) return storeLocalFile(uri, opts);
  if (uri.startsWith("/")) return storeLocalFile(uri, opts);   // 本仓产物的裸绝对路径写法
  if (!/^https?:\/\//i.test(uri)) throw new Error(`只支持 http(s) 产物地址：${uri.slice(0, 80)}`);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("成片大小上限必须是非负安全整数");
  // C-06 修复：大文件下载 5 分钟超时（此前无超时，慢源/断流会永久拖住整个 poll 批次）
  const res = await fetchImpl(uri, { signal: AbortSignal.timeout(Number(process.env.MEDIA_DOWNLOAD_TIMEOUT_MS ?? 300_000)) });
  const rejectResponse = async (error: Error): Promise<never> => {
    try { await res.body?.cancel(error); }
    catch (cancelError) { throw new AggregateError([error, cancelError], `${error.message}；响应取消失败`); }
    throw error;
  };
  if (!res.ok) return rejectResponse(new Error(`成片下载失败：HTTP ${res.status}`));
  const declaredLength = res.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    return rejectResponse(new Error(`成片超过大小上限（${declaredLength} > ${maxBytes} 字节），已拒收`));
  }
  const contentType = res.headers.get("content-type");
  const ext = contentType?.includes("webm") ? "webm" : contentType?.includes("png") ? "png"
    : contentType?.includes("jpeg") || contentType?.includes("jpg") ? "jpg" : "mp4";
  const reader = res.body?.getReader();
  if (!reader) throw new Error("成片下载为空，拒绝入库");
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      received += part.value.byteLength;
      if (received > maxBytes) throw new Error(`成片超过大小上限（${received} > ${maxBytes} 字节），已拒收`);
      chunks.push(part.value);
    }
  } catch (error) {
    try { await reader.cancel(error); }
    catch (cancelError) {
      // An already errored stream rejects cancel with the same original read error.
      if (cancelError !== error) throw new AggregateError([error, cancelError], `成片下载失败：${error instanceof Error ? error.message : String(error)}；响应取消失败`);
    }
    throw error;
  } finally { reader.releaseLock(); }
  if (received === 0) throw new Error("成片下载为空，拒绝入库");
  return storeMediaBytes(Buffer.concat(chunks, received), opts.workspaceId, ext, contentType);
}

/** Atomically publish the bytes that were hashed; cache existence alone is not integrity. */
function storeMediaBytes(bytes: Buffer, workspaceId: string, ext: string, contentType: string | null): DownloadedMedia {
  safeSegment(workspaceId, "workspaceId");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const relPath = join("video", workspaceId, `${sha256}.${ext}`);
  const absPath = join(mediaRoot(), relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  const cached = existsSync(absPath) ? lstatSync(absPath) : null;
  const valid = cached?.isFile() && cached.size === bytes.length
    && createHash("sha256").update(readFileSync(absPath)).digest("hex") === sha256;
  if (!valid) {
    const temp = `${absPath}.write-${randomUUID()}`;
    try {
      writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
      renameSync(temp, absPath);
    } finally { rmSync(temp, { force: true }); }
  }
  return { relPath: relPath.split(sep).join("/"), absPath, sha256, bytes: bytes.length, contentType };
}

/** 本地文件 → 媒体仓：同一描述符读取、检查，再原子落已哈希字节。 */
export function storeLocalFile(
  uri: string,
  opts: { workspaceId: string; maxBytes?: number },
): DownloadedMedia {
  const srcPath = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
  const fd = openSync(srcPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size === 0) throw new Error(`本地产物必须为非空文件：${srcPath}`);
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    if (before.size > maxBytes) throw new Error(`成片超过大小上限（${before.size} > ${maxBytes} 字节），已拒收`);
    bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size) {
      throw new Error("本地产物在读取期间变化，拒绝入库");
    }
    if (bytes.length > maxBytes) throw new Error(`成片超过大小上限（${bytes.length} > ${maxBytes} 字节），已拒收`);
  } finally { closeSync(fd); }
  const ext = srcPath.toLowerCase().endsWith(".webm") ? "webm"
    : srcPath.toLowerCase().endsWith(".png") ? "png"
      : /\.jpe?g$/i.test(srcPath) ? "jpg" : "mp4";
  return storeMediaBytes(bytes, opts.workspaceId, ext, null);
}

/* ================= 成片注册（asset-cms） ================= */

export interface RegisterFinalCutInput {
  assetId: string;
  projectId?: string | null;
  sha256: string;
  /** 供应商原始 URL（保留为归因与回查线索；本地副本为准） */
  sourceUrl: string;
  localRelPath: string;
  provider: string;
  providerModel: string;
  jobId: string;
  scriptId: string;
  seconds?: number | null;
  by: string;
}

/**
 * 渲染产物登记的泛化入参（T-2026-0926-0007 规格书 §3.2）。
 *
 * 粒度修正：单镜 job 的产物是 **clip**（镜头片段），不是 final_cut（成片）。
 * 原实现把每个单镜产物都登记成 final_cut，导致"成片历史"里塞满 5 秒片段。
 * final_cut 语义从此只属于**合成成片**（交付包母版/变体、重剪产物）。
 */
export interface RegisterRenderedClipInput {
  assetId?: string;
  kind: "clip" | "final_cut";
  projectId?: string | null;
  sha256: string;
  sourceUrl: string;
  localRelPath: string;
  provider: string;
  providerModel: string;
  jobId: string;
  scriptId: string;
  seconds?: number | null;
  /** 素材名（缺省 kind + 时间由调用方补） */
  title?: string | null;
  /** 提示词冗余（检索依赖；来自 render_scripts.md） */
  prompt?: string | null;
  /** 片型（0042 扩展 explainer：口播解说片） */
  pipelineKind?: "narrative" | "marketing" | "explainer" | null;
  aspectRatio?: string | null;
  by: string;
}

export async function registerFinalCut(
  app: ReturnType<typeof getAppPool>,
  gateway: ReturnType<typeof getGatewayPool>,
  scope: Scope,
  input: RegisterFinalCutInput,
): Promise<{ assetId: string; deduped: boolean }> {
  const r = await registerRenderedClip(app, gateway, scope, {
    ...input,
    kind: "final_cut",
  });
  return { assetId: r.assetId, deduped: r.deduped };
}

/**
 * 渲染产物登记（泛化版）：register() 之后补写 0039 媒资列（title/prompt/pipeline_kind/宽高/画幅）。
 * 补写用动态 import 引 `media/register-local` 的列助手（该模块反向依赖本文件的 mediaRoot，
 * 静态相互 import 会形成环；动态 import 在调用期解析，环被打破）。
 */
export async function registerRenderedClip(
  app: ReturnType<typeof getAppPool>,
  gateway: ReturnType<typeof getGatewayPool>,
  scope: Scope,
  input: RegisterRenderedClipInput,
): Promise<{ assetId: string; deduped: boolean }> {
  const assetId = input.assetId ?? newId("VA");
  const r = await register(app, gateway, scope, {
    id: assetId,
    projectId: input.projectId ?? undefined,
    kind: input.kind,
    sourceUrl: input.sourceUrl,
    provenance: {
      source: "generated",
      provider: input.provider,
      providerModel: input.providerModel,
      jobId: input.jobId,
      scriptId: input.scriptId,
      localPath: input.localRelPath,
      ingestedAt: new Date().toISOString(),
    },
    licenseRisk: "none",
    sha256: input.sha256,
    meta: {
      durationSeconds: input.seconds ?? null,
      localPath: input.localRelPath,
      jobId: input.jobId,
      scriptId: input.scriptId,
      ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
    },
    /** 单镜片段是"可复用的素材"而非"待发布的成片"：clip 直接 registered，成片沿用 draft 口径 */
    status: input.kind === "clip" ? "registered" : "draft",
    by: input.by,
  });
  const { applyMediaColumns } = await import("../media/columns.js");
  const localAbs = join(mediaRoot(), input.localRelPath);
  const probed = existsSync(localAbs) ? await probeMedia(localAbs) : null;
  await applyMediaColumns(app, scope, r.asset.id, {
    title: input.title ?? null,
    prompt: input.prompt ?? null,
    pipelineKind: input.pipelineKind ?? null,
    durationSeconds: input.seconds ?? probed?.durationSeconds ?? null,
    width: probed?.width ?? null,
    height: probed?.height ?? null,
    sourceType: "generated",
    aspectRatio: input.aspectRatio ?? null,
  }, { fillOnlyEmpty: r.deduped });
  return { assetId: r.asset.id, deduped: r.deduped };
}

/* ================= 签名媒体 URL（HMAC + 过期；播放/下载均走校验） ================= */

function secret(): string {
  const s = process.env.MEDIA_SIGNING_SECRET?.trim() || process.env.JWT_SECRET?.trim();
  if (!s) throw new Error("缺少 MEDIA_SIGNING_SECRET / JWT_SECRET：拒绝签发无签名媒体 URL（fail-closed）");
  return s;
}

/** 媒体签名密钥（上传凭证与播放签名共用一个秘密源；导出供 media/upload.ts 复用） */
export function mediaSigningSecret(): string {
  return secret();
}

/**
 * 路径 → workspaceId（媒体仓口径 `<大类>/<workspaceId>/<sha256><ext>`）。
 * 第二段即签发时的租户；推导失败返回空串（该路径不可能被本仓正常资源命中）。
 */
export function workspaceIdFromMediaPath(relPath: string): string {
  const segments = relPath.split("/").filter(Boolean);
  return segments.length >= 3 ? (segments[1] ?? "") : "";
}

/**
 * 签名媒体路径（HMAC + 过期时间）。
 *
 * T-2026-0926-0007 修复：签名载荷加入 workspaceId 绑定（规格书 §3.6）。
 * 原实现只签 relPath，令牌一旦被复制到同 workspace 内的另一条路径上仍可用；
 * 绑定 workspace 后，令牌的效力被收紧到「签发时那个租户的路径空间」——
 * 跨租户重放（即使猜中路径）签发与校验两侧的 ws 不同，签名必然不匹配。
 */
export function signMediaPath(relPath: string, ttlSec = 3600, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + Math.max(30, Math.floor(ttlSec));
  const ws = workspaceIdFromMediaPath(relPath);
  const sig = createHmac("sha256", secret()).update(`${ws}|${relPath}|${exp}`).digest("base64url");
  return `${exp}.${sig}`;
}

export function verifyMediaToken(relPath: string, token: string, now = Date.now()): { ok: boolean; reason?: string } {
  const m = /^(\d+)\.([A-Za-z0-9_-]+)$/.exec(token ?? "");
  if (!m) return { ok: false, reason: "token 格式非法" };
  const exp = Number(m[1]);
  if (!Number.isFinite(exp) || exp * 1000 < now) return { ok: false, reason: "token 已过期" };
  const ws = workspaceIdFromMediaPath(relPath);
  const expect = createHmac("sha256", secret()).update(`${ws}|${relPath}|${exp}`).digest("base64url");
  const a = Buffer.from(expect);
  const b = Buffer.from(m[2]!);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "token 签名不匹配" };
  return { ok: true };
}

/** 解析并防目录穿越：只允许媒体根内的相对路径 */
export function resolveMediaPath(relPath: string): string {
  const root = resolve(mediaRoot());
  const abs = resolve(root, normalize(relPath).replace(/^([/\\])+/, ""));
  if (!abs.startsWith(root + sep)) throw new Error(`媒体路径越界：${relPath}`);
  return abs;
}

export function mediaUrl(relPath: string, ttlSec = 3600): string {
  const token = signMediaPath(relPath, ttlSec);
  return `/media/${relPath.split("/").map(encodeURIComponent).join("/")}?token=${token}`;
}
