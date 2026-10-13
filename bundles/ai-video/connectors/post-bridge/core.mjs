/**
 * ai-video × 后期交付与返修工位 bridge 内核（core.mjs）
 *
 * 定位（2026-09-24 产品所有者口径）：**镜头生成是贵的，后期是便宜的**——所以
 *   ① 生成期：母版一律**不烧字幕**，字幕以旁挂文件（srt/ass/vtt + 清单）随片交付；
 *   ② 交付期：同一批镜头一次出**多个风格明显不同的变体**（封面 / BGM / 文案 / 调色 / 转场），
 *      让用户在后期**选**而不是让系统替他猜；
 *   ③ 返修期：用户反馈先做**变更影响分析**——能在本地重合成的绝不重新生成镜头；
 *      只有点名到"画面内容"时才走镜头重生成（花钱 → 走人审闸），重生成后照样回到本地合成。
 *
 * 纪律（与 subtitle/color/bgm 三个工位同构）：
 * - 原片只读：任何写入都落到新文件，覆盖原片直接拒绝；版本只增不覆盖（v1 → v2 → v3）；
 * - 无回执=未核实：每个产物带 sha256；"复用"必须给出"未被重算"的证据（哈希 + mtime 未变）；
 * - 不猜：未知的 patch 键、缺失的字体、找不到的曲目一律抛稳定 code 的错误，不静默兜底；
 * - 风格配方必须如实执行；不默认测源片品质或变体差异，未测字段保持明确；
 * - 花钱的动作不自动跑：需要重生成镜头时只产出计划 + 审批闸（G8），不擅自烧额度。
 *
 * 依赖关系：本工位是**总装工位**，复用三个专业工位的内核（同仓同 bundle，进程内 import）：
 *   subtitle-bridge/core.mjs  → 旁挂字幕（sidecar）、软字幕轨（softmux）、标题版式
 *   color-bridge/core.mjs     → 单次声明配方调色（grade）
 *   bgm-bridge/core.mjs       → 选曲与单次混音（findTracks / mix）
 */

import { createHash, randomUUID } from "node:crypto";
import {
  buildSampleAccurateConcatPlan,
} from "./av-sync.mjs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractFrame, probeMedia, round, runBin, sha256File, tempDir,
} from "../subtitle-bridge/measure.mjs";
import {
  buildAssDocument, exportSidecars, loadFontCatalog, plan as planSubtitle,
  softMux, srtSecondsToAss, SubtitleError,
} from "../subtitle-bridge/core.mjs";
import { grade as colorGrade } from "../color-bridge/core.mjs";
import { findTracks, filmEnergyArc as bgmFilmEnergyArc, loadAllLocalTracks, mix as bgmMix } from "../bgm-bridge/core.mjs";
import { AUDIO_STEM_ROLES, audioStemDigest, renderAudioStems, verifyAudioStemBundle,
  muxAudioProgram, snapshotAudioStemArtifact } from "../bgm-bridge/audio-stems.mjs";
import { createAudioStemReceiptVerifier } from "../bgm-bridge/audio-stems-trust.mjs";

/* ============================ 工具面与错误 ============================ */

/** 本工位工具面（白名单纪律与其它 bridge 同款：不在表内的工具直接拒绝）。 */
export const POST_TOOLS = [
  "postread.health",
  "postread.plan",
  "postread.impact",
  "postwrite.package",
  "postwrite.reedit",
  "postwrite.triage",
];

const TOOL_SET = new Set(POST_TOOLS);

export function isPostTool(name) {
  return TOOL_SET.has(name);
}

export class PostError extends Error {
  constructor(message, code = "engine_failed", retryable = false) {
    super(message);
    this.name = "PostError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function resolveBinaries(env = process.env) {
  const localKit = path.join(os.homedir(), ".workloom-color", "bin");
  const localBin = (name) => {
    const candidate = path.join(localKit, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; }
    catch { return name; }
  };
  return {
    ffmpeg: env.WORKLOOM_POST_FFMPEG_PATH || env.WORKLOOM_SUBTITLE_FFMPEG_PATH || localBin("ffmpeg"),
    ffprobe: env.WORKLOOM_POST_FFPROBE_PATH || env.WORKLOOM_SUBTITLE_FFPROBE_PATH || localBin("ffprobe"),
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
/** `bundles/ai-video`（连接器目录的上两级）：变体包与 LUT 库都挂在这个 bundle 下。 */
export const BUNDLE_ROOT = path.resolve(here, "../..");
/**
 * 变体配方目录：默认随包；`WORKLOOM_POST_VARIANT_DIR` 可指向一份**覆盖副本**
 * （例如"本片全部硬切"的临时配方：复制三份变体包并把 transitions.mode 改成 hard）。
 * 覆盖只影响本次进程，不改随包资产。
 */
export const VARIANT_DIR = (process.env.WORKLOOM_POST_VARIANT_DIR ?? "").trim()
  || path.join(BUNDLE_ROOT, "library", "style-variants");
export const LUT_DIR = path.join(BUNDLE_ROOT, "library", "luts");
export const FILM_PROJECT_SCHEMA = "workloom.film-project/v1";
export const DELIVERY_SCHEMA = "workloom.delivery-package/v1";

/* ============================ 路径监狱 ============================ */

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realpathDeepest(target) {
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const real = fs.realpathSync(probe);
  return path.join(real, path.relative(probe, target));
}

/** 允许根目录：环境变量优先，缺省只放行进程工作目录与系统临时目录。 */
export function allowedRoots(env = process.env) {
  const raw = (env.WORKLOOM_POST_ALLOWED_ROOTS ?? "").trim();
  const list = raw ? raw.split(":").map((entry) => entry.trim()).filter(Boolean) : [process.cwd(), os.tmpdir()];
  return list.map((entry) => {
    try {
      return fs.realpathSync(entry);
    } catch {
      return path.resolve(entry);
    }
  });
}

export function assertPathAllowed(target, roots = allowedRoots(), label = "path") {
  if (typeof target !== "string" || !target.trim()) throw new PostError(`${label} 缺失`, "bad_request");
  const resolved = path.resolve(target);
  const real = realpathDeepest(resolved);
  if (!roots.some((root) => isInside(real, root))) {
    throw new PostError(`${label} 不在允许根目录内：${resolved}（可用 WORKLOOM_POST_ALLOWED_ROOTS 追加）`, "path_not_allowed");
  }
  return real;
}

/** 供 CLI 使用的默认工作根（交付包与缓存都在这里，避免污染素材目录）。 */
export function workRoot(env = process.env) {
  const raw = (env.WORKLOOM_POST_WORK_DIR ?? "").trim();
  return raw ? path.resolve(raw) : path.join(os.homedir(), ".workloom-post");
}

/* ============================ 风格变体包（library/style-variants） ============================ */

export function loadVariantIndex(file = path.join(VARIANT_DIR, "index.json")) {
  if (!fs.existsSync(file)) {
    throw new PostError(`风格变体索引不存在：${file}`, "not_configured");
  }
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(doc?.variants) || doc.variants.length === 0) {
    throw new PostError(`风格变体索引为空：${file}`, "not_configured");
  }
  return doc;
}

/** 变体包：一个变体 = 一套「调色 + 转场 + BGM + 封面 + 文案」的完整风格配方。 */
export function findVariantPack(id, { file = path.join(VARIANT_DIR, "index.json") } = {}) {
  const index = loadVariantIndex(file);
  const entry = index.variants.find((item) => item.id === id);
  if (!entry) {
    throw new PostError(`未知风格变体：${id}（可用：${index.variants.map((item) => item.id).join(", ")}）`, "bad_recipe");
  }
  const packFile = path.resolve(path.dirname(file), entry.file);
  if (!isInside(packFile, path.dirname(file)) || !fs.existsSync(packFile)) {
    throw new PostError(`变体包文件缺失或越界：${entry.file}`, "not_configured");
  }
  const pack = JSON.parse(fs.readFileSync(packFile, "utf8"));
  if (pack.id !== id) throw new PostError(`变体包 id 与索引不一致：${pack.id} ≠ ${id}`, "bad_recipe");
  return { ...pack, _file: packFile, _index: entry };
}

export function listVariantPacks() {
  const index = loadVariantIndex();
  return index.variants.map((entry) => {
    const pack = findVariantPack(entry.id);
    return {
      id: pack.id,
      name: pack.name,
      positioning: pack.positioning,
      platforms: pack.platforms ?? [],
      color: pack.color ?? null,
      bgm: pack.bgm ?? null,
      transitions: pack.transitions ?? null,
      copy: pack.copy ?? null,
      cover: pack.cover ?? null,
      file: path.relative(BUNDLE_ROOT, pack._file),
    };
  });
}

/** LUT 只允许取仓内 library/luts 下的 .cube（不允许外部路径，避免"偷偷换 look"）。 */
export function resolveLut(fileName) {
  if (!fileName) return null;
  const target = path.resolve(LUT_DIR, String(fileName));
  if (!isInside(target, LUT_DIR)) throw new PostError(`LUT 越界：${fileName}`, "bad_lut");
  if (!fs.existsSync(target)) throw new PostError(`LUT 不存在：${target}`, "bad_lut");
  if (path.extname(target).toLowerCase() !== ".cube") throw new PostError(`LUT 必须是 .cube：${target}`, "bad_lut");
  return target;
}

/* ============================ 素材与工程 ============================ */

function text(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new PostError(`${label} 缺失`, "bad_request");
  }
  return value.trim();
}

function optionalNumber(value, fallback = null) {
  if (value === undefined || value === null || value === true || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function audioSourceObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/** Presence is an instruction: an explicit invalid source may never become original-audio fallback. */
function assertAudioStemDescriptors(value, label) {
  const reject = () => { throw new PostError(`${label} 必须提供完整独立音轨角色、来源和回执；省略该字段才采用原节目`, "audio_stems_source_unverified"); };
  if (!audioSourceObject(value) || Object.keys(value).length !== AUDIO_STEM_ROLES.length
    || Object.keys(value).some((role) => !AUDIO_STEM_ROLES.includes(role))) reject();
  for (const role of AUDIO_STEM_ROLES) {
    const descriptor = value[role];
    if (!audioSourceObject(descriptor) || !audioSourceObject(descriptor.receipt)
      || Object.keys(descriptor.receipt).length === 0) reject();
    if (descriptor.status === "not_applicable") {
      if (typeof descriptor.reason !== "string" || !descriptor.reason.trim()
        || descriptor.path != null || descriptor.sha256 != null || descriptor.sourceKind != null) reject();
    } else if (descriptor.status === "ready") {
      if (typeof descriptor.path !== "string" || !descriptor.path.trim()
        || !/^[a-f0-9]{64}$/.test(descriptor.sha256 ?? "")
        || typeof descriptor.sourceKind !== "string" || !descriptor.sourceKind.trim()) reject();
    } else reject();
  }
}

function explicitShotAudio(shots) {
  if (!Array.isArray(shots) || shots.length === 0
    || shots.some((shot) => !audioSourceObject(shot))) throw new PostError("shots 必须是非空镜头对象数组", "bad_request");
  const explicit = shots.some((shot) => Object.hasOwn(shot, "audioStems"));
  if (explicit) {
    for (const shot of shots) assertAudioStemDescriptors(shot.audioStems, `镜头 ${shot.shotId ?? shot.shot_id ?? "?"}.audioStems`);
  }
  return explicit;
}

export const ASPECT_PRESETS = {
  "9:16": [1080, 1920],
  "16:9": [1920, 1080],
  "1:1": [1080, 1080],
  "4:5": [1080, 1350],
};

export const UHD_ASPECT_PRESETS = {
  "9:16": [2160, 3840],
  "16:9": [3840, 2160],
  "1:1": [2160, 2160],
  "4:5": [2160, 2700],
};

export function resolveQuality(project = {}) {
  const quality = project.quality ?? "hd";
  if (quality !== "hd" && quality !== "uhd") {
    throw new PostError(`未知清晰度档位：${quality}（可用：hd / uhd）`, "bad_request");
  }
  return quality;
}

export function resolveResolution(project = {}) {
  const quality = resolveQuality(project);
  const presets = quality === "uhd" ? UHD_ASPECT_PRESETS : ASPECT_PRESETS;
  if (Array.isArray(project.resolution) && project.resolution.length === 2) {
    const [width, height] = project.resolution.map(Number);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new PostError(`分辨率非法：${JSON.stringify(project.resolution)}`, "bad_request");
    }
    if (quality === "uhd" && !Object.values(UHD_ASPECT_PRESETS).some(([w, h]) => w === width && h === height)) {
      throw new PostError(`uhd 仅支持 ${Object.values(UHD_ASPECT_PRESETS).map((size) => size.join("×")).join("、")}`, "bad_request");
    }
    return [width, height];
  }
  const aspect = String(project.aspect ?? "9:16");
  const preset = presets[aspect];
  if (!preset) {
    throw new PostError(`未知画幅：${aspect}（可用：${Object.keys(presets).join(", ")}）`, "bad_request");
  }
  return preset;
}

/** 交付计划：只读素材与配方，产出"要出哪些变体、差异在哪、预计几步"的计划（不动文件）。 */
export async function planDelivery({
  project = {}, shots = [], variants = null, bins = resolveBinaries(),
} = {}) {
  const projectId = text(project.projectId ?? project.project_id, "project.projectId");
  explicitShotAudio(shots);
  const index = loadVariantIndex();
  const wanted = Array.isArray(variants) && variants.length ? variants : index.defaults ?? index.variants.map((item) => item.id);
  const packs = wanted.map((id) => findVariantPack(id));
  if (packs.length < 2) {
    throw new PostError("多风格交付至少需要 2 个变体（否则用户没得选）", "bad_request");
  }
  const ids = new Set(packs.map((pack) => pack.id));
  if (ids.size !== packs.length) throw new PostError("变体 id 重复", "bad_request");
  const [width, height] = resolveResolution(project);
  const probed = [];
  for (const shot of shots) {
    const file = text(shot.path ?? shot.localPath, "shots[].path");
    if (!fs.existsSync(file)) throw new PostError(`镜头产物不存在：${file}`, "not_found");
    const probe = await probeMedia(file, { bins });
    probed.push({
      shotId: String(shot.shotId ?? shot.shot_id ?? path.basename(file)),
      path: file,
      duration: probe.duration,
      resolution: [probe.width, probe.height],
      hasAudio: probe.hasAudio,
      sha256: await sha256File(file),
    });
  }
  const totalSeconds = round(probed.reduce((acc, shot) => acc + (shot.duration ?? 0), 0), 2);
  return {
    schemaVersion: "workloom.delivery-plan/v1",
    projectId,
    quality: resolveQuality(project),
    resolution: [width, height],
    fps: optionalNumber(project.fps, 30),
    shots: probed,
    totalSeconds,
    variants: packs.map((pack) => ({
      id: pack.id,
      name: pack.name,
      positioning: pack.positioning,
      axes: {
        color: pack.color ? `${pack.color.profile ?? pack.color.lut} @${pack.color.intensity}` : "不调色",
        bgm: pack.bgm?.enabled === false ? "不配乐（保留原声）" : `${pack.bgm?.style ?? pack.bgm?.mood ?? "默认"} · ${pack.bgm?.policy ?? "keep-dialogue"}`,
        transitions: `${pack.transitions?.mode ?? "hard"}${pack.transitions?.fadeSec ? ` ${pack.transitions.fadeSec}s` : ""}`,
        cover: `${pack.cover?.template ?? "默认"} @${pack.cover?.at ?? 0.35}`,
        copy: pack.copy?.tone ?? "默认口吻",
      },
    })),
    steps: [
      ...(resolveQuality(project) === "uhd" ? ["⓪ 按请求输出 UHD 画布；普通本地缩放，不自动启动增强模型"] : []),
      "① 归一化镜头（一次，全部变体共用）",
      "② 按变体拼接（转场风格差异）",
      "③ 按变体执行声明的调色配方（不对源片评分）",
      "④ 按变体选曲混音（真实加工回执，不测源片品质）",
      "⑤ 旁挂字幕包（srt/ass/vtt + 清单，母版不烧字）",
      "⑥ 封面 + 文案包（按变体差异）",
      "⑦ 软字幕轨版（原编码画面/声音 copy，附当前字节回执）",
      "⑧ 交付清单 + 工程文件（film-project.json，供后续本地返修）",
    ],
    cost: {
      shotGeneration: "复用已有镜头产物（本计划不含镜头生成）",
      tokenCostDelta: 0,
      note: "变体只在后期派生：镜头生成费一次，风格差异不吃 token",
    },
  };
}

/* ============================ 归一化 / 拼接（层 1） ============================ */

/* ==================== 二次构图（取景轨道，T-2026-1011-0008） ====================
 *
 * 与 `packages/video-studio/src/edit/reframe.ts` 同一口径（计划层算决策、引擎只忠实渲染）：
 *   · crop-first：先在源像素上取窗口，再缩放到画布——不允许"先降到画布再放大裁回来"；
 *   · fill：pad（整幅+黑边，兼容）/ cover（裁切填满）/ blur（模糊底+前景）/ brand（重模糊压暗底+前景）；
 *   · 动画：`zoompan`（恒定输出尺寸；`scale=eval=frame` 在 -vf 链里会触发重初始化失败，已实测排除）；
 *   · 回执：逐镜 `<输出>.reframe.json`（描述子/窗口/预算/机检），交付面另有 reframe-receipt.json。
 */
export const REFRAME_MODES = ["static", "push", "pull", "follow", "locked-cut"];
export const REFRAME_FILLS = ["pad", "cover", "blur", "brand"];
export const REFRAME_EASINGS = ["linear", "smooth", "ease-in-out"];
export const REFRAME_MAX_ZOOM_CEILING = 3;
const REFRAME_KEYS = ["mode", "intent", "shotSize", "scale", "center", "anchor", "easing", "fill", "maxZoomPolicy", "safeArea", "note", "legacyPunchIn", "budget"];

function reframeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 取景描述子校验（未知键拒绝，不静默忽略——与 normalizePatchKeys 同纪律）。 */
export function normalizeShotReframe(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new PostError("shot.reframe 必须是对象或省略", "bad_request");
  const unknown = Object.keys(value).filter((key) => !REFRAME_KEYS.includes(key));
  if (unknown.length) throw new PostError(`shot.reframe 含未知键：${unknown.join(", ")}（允许：${REFRAME_KEYS.join(", ")}）`, "bad_request");
  const mode = value.mode === undefined || value.mode === null ? "static" : String(value.mode);
  if (!REFRAME_MODES.includes(mode)) throw new PostError(`未知取景模式：${mode}`, "bad_request");
  const fill = value.fill === undefined || value.fill === null ? "pad" : String(value.fill);
  if (!REFRAME_FILLS.includes(fill)) throw new PostError(`未知填充策略：${fill}（可用：${REFRAME_FILLS.join(" / ")}）`, "bad_request");
  const easing = value.easing === undefined || value.easing === null ? "smooth" : String(value.easing);
  if (!REFRAME_EASINGS.includes(easing)) throw new PostError(`未知取景缓动：${easing}`, "bad_request");
  const scaleFrom = reframeNumber(value.scale?.from, 1);
  const scaleTo = reframeNumber(value.scale?.to, scaleFrom);
  for (const [label, scale] of [["from", scaleFrom], ["to", scaleTo]]) {
    if (!(scale >= 1) || scale > REFRAME_MAX_ZOOM_CEILING) {
      throw new PostError(`取景倍率 ${label}=${scale} 越界（1–${REFRAME_MAX_ZOOM_CEILING}）`, "bad_request");
    }
  }
  const centerOf = (raw, fallbackX = 0.5, fallbackY = 0.5) => ({
    x: Math.min(1, Math.max(0, reframeNumber(raw?.x, fallbackX))),
    y: Math.min(1, Math.max(0, reframeNumber(raw?.y, fallbackY))),
  });
  return {
    mode,
    intent: value.intent ?? null,
    shotSize: value.shotSize ?? null,
    scale: { from: scaleFrom, to: scaleTo },
    center: { from: centerOf(value.center?.from), to: centerOf(value.center?.to ?? value.center?.from) },
    anchor: value.anchor ?? "center",
    easing,
    fill,
    maxZoomPolicy: value.maxZoomPolicy === "allow-upscale" ? "allow-upscale" : "lossless",
    safeArea: value.safeArea === "ignore" ? "ignore" : "respect",
    note: typeof value.note === "string" ? value.note : null,
    legacyPunchIn: value.legacyPunchIn === true,
    budget: value.budget ?? null,
  };
}

/** 与计划层同式：画布同比例、能放进源画面的最大基窗 + 无损预算。 */
export function computeReframeBudget(source, [canvasW, canvasH]) {
  if (!source || !(source.width > 0) || !(source.height > 0)) return { baseWindow: null, sMaxLossless: null, fillUpscale: null, effectiveUpscale: null };
  const aspect = canvasW / canvasH;
  const base = source.width / source.height >= aspect
    ? { w: source.height * aspect, h: source.height }
    : { w: source.width, h: source.width / aspect };
  return {
    baseWindow: { w: Math.round(base.w * 100) / 100, h: Math.round(base.h * 100) / 100 },
    sMaxLossless: Math.round(Math.min(base.w / canvasW, base.h / canvasH) * 10000) / 10000,
    fillUpscale: Math.round((canvasW / base.w) * 10000) / 10000,
    effectiveUpscale: null,
  };
}

function easeOf(easing, t) {
  if (easing === "smooth") return `(${t})*(${t})*(3-2*(${t}))`;
  if (easing === "ease-in-out") return `if(lt(${t},0.5),2*(${t})*(${t}),1-2*(1-(${t}))*(1-(${t})))`;
  return t;
}

const evenExpr = (expr) => `floor((${expr})/2)*2`;
const round4 = (value) => Math.round(value * 10000) / 10000;

/**
 * 取景滤镜链（crop-first）。返回 { filters, mode, window }；filters 由调用方 join(",") 使用。
 * 与 TS 计划层保持同构；`source` 为 null 时用相对表达式（iw/ih），不猜像素。
 */
export function buildReframeChain({ descriptor, source, canvas, durationSeconds, fps }) {
  const [outW, outH] = canvas;
  const aspect = outW / outH;
  const t = (value) => round4(value);
  const tail = ["setsar=1", `fps=${fps}`];
  const duration = Math.max(0.1, Number(durationSeconds) || 1);
  const { from: sFrom, to: sTo } = descriptor.scale;
  const { from: cFrom, to: cTo } = descriptor.center;
  const animated = Math.abs(sTo - sFrom) > 1e-6 || Math.abs(cTo.x - cFrom.x) > 1e-6 || Math.abs(cTo.y - cFrom.y) > 1e-6;
  const filters = [];

  if (descriptor.fill === "pad") {
    filters.push(`scale=${outW}:${outH}:force_original_aspect_ratio=decrease`);
    filters.push(`pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2`);
    if (animated) {
      /** 用 `on`（输出帧号）而不是 `time`：后者是 FFmpeg 6.0 才有的变量（CI 为 5.1，见 docs/video-edit-reframe.md）。 */
      const totalFrames = Math.max(1, Math.round(duration * fps));
      /**
       * 本机生产补丁（2026-10-11）：原表达式少了收尾的 `)`——FFmpeg 报
       * `[Eval] Missing ')' in '(1+(1.12-1)*(clip(on/223,0,1))…'` 并中止归一化。
       * 这条"pad + 逐帧推近"路径此前没有测试覆盖（cover 路径正常），修好后与 cover 分支同构。
       */
      const sExpr = `(${t(sFrom)}+(${t(sTo)}-${t(sFrom)})*${easeOf(descriptor.easing, `clip(on/${totalFrames},0,1)`)})`;
      filters.push(`zoompan=z='${sExpr}':x='(iw-iw/zoom)*0.5':y='(ih-ih/zoom)*0.5':d=1:s=${outW}x${outH}:fps=${fps}`);
    }
    filters.push(...tail);
    return { filters, mode: animated ? "animated" : "static", window: "fit-zoom" };
  }

  const cropBw = source
    ? (source.width / source.height >= aspect ? `floor(${source.height}*${t(aspect)}/2)*2` : `floor(${source.width}/2)*2`)
    : `floor(min(iw,ih*${t(aspect)})/2)*2`;
  const cropBh = source
    ? (source.width / source.height >= aspect ? `floor(${source.height}/2)*2` : `floor(${source.width}/${t(aspect)}/2)*2`)
    : `floor(min(ih,iw/${t(aspect)})/2)*2`;
  const windowArg = `w=${cropBw}:h=${cropBh}:x='(iw-ow)*${t(cFrom.x)}':y='(ih-oh)*${t(cFrom.y)}'`;

  if (descriptor.fill === "blur" || descriptor.fill === "brand") {
    const background = descriptor.fill === "blur"
      ? `[bgsrc]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},gblur=sigma=20[bg]`
      : `[bgsrc]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},gblur=sigma=40,eq=brightness=-0.15:saturation=0.4[bg]`;
    filters.push(`split=2[bgsrc][fgsrc];${background};[fgsrc]crop=${windowArg},scale=${outW}:${outH}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,${tail.join(",")}`);
    return { filters, mode: "static", window: "base+foreground" };
  }

  if (!animated) {
    filters.push(`crop=w='${evenExpr(`${cropBw}/${t(sTo)}`)}':h='${evenExpr(`${cropBh}/${t(sTo)}`)}':x='(iw-ow)*${t(cFrom.x)}':y='(ih-oh)*${t(cFrom.y)}'`);
    filters.push(`scale=${outW}:${outH}:flags=lanczos`);
    filters.push(...tail);
    return { filters, mode: "static", window: "cover" };
  }
  const totalFrames = Math.max(1, Math.round(duration * fps));
  const e = easeOf(descriptor.easing, `clip(on/${totalFrames},0,1)`);
  const sExpr = `(${t(sFrom)}+(${t(sTo)}-${t(sFrom)})*${e})`;
  const cxExpr = `(${t(cFrom.x)}+(${t(cTo.x)}-${t(cFrom.x)})*${e})`;
  const cyExpr = `(${t(cFrom.y)}+(${t(cTo.y)}-${t(cFrom.y)})*${e})`;
  filters.push(`crop=${windowArg}`);
  filters.push(`zoompan=z='${sExpr}':x='(iw-iw/zoom)*${cxExpr}':y='(ih-ih/zoom)*${cyExpr}':d=1:s=${outW}x${outH}:fps=${fps}`);
  filters.push(...tail);
  return { filters, mode: "animated", window: "cover+zoom" };
}

/** 边缘亮度机检：取 cover/blur/brand 输出左右各 8px 条带的平均亮度，证明没有黑边缺陷。 */
async function measureEdgeBands({ file, height, bins }) {
  const { stdout } = await runBin(bins.ffmpeg, [
    "-hide_banner", "-v", "info", "-i", file,
    "-vf", `crop=8:${Math.max(2, height)}:0:0,signalstats,metadata=print:file=-`,
    "-frames:v", "4", "-an", "-f", "null", "-",
  ], { label: "ffmpeg(reframe-edge)" });
  const values = [...String(stdout).matchAll(/YAVG=([0-9.]+)/g)].map((match) => Number(match[1]));
  if (values.length === 0) return { ok: false, samples: 0, meanLuma: null, detail: "边缘亮度采样为空" };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { ok: mean > 6, samples: values.length, meanLuma: Math.round(mean * 10) / 10, detail: `左边缘 ${values.length} 帧平均亮度 ${Math.round(mean * 10) / 10}` };
}

/** 取景机检与回执（硬项：预算/时长/黑边；咨询项留给交付面）。 */
async function verifyReframeOutcome({ descriptor, key, source, canvas, outProbe, sourceDuration, target, bins }) {
  const budget = computeReframeBudget(source, canvas);
  const maxRequested = Math.max(descriptor.scale.from, descriptor.scale.to);
  /** 无损预算只限制"额外推近"（详见 reframe.ts#losslessScaleCap）：上限 = max(1, sMaxLossless)。 */
  const losslessCap = budget.sMaxLossless === null ? REFRAME_MAX_ZOOM_CEILING : Math.max(1, budget.sMaxLossless);
  const effectiveUpscale = budget.sMaxLossless === null || budget.fillUpscale === null
    ? null
    : round4(budget.fillUpscale * maxRequested);
  const checks = [
    {
      kind: "reframe_zoom_with_budget",
      hard: true,
      ok: descriptor.maxZoomPolicy === "allow-upscale" || budget.sMaxLossless === null || maxRequested <= losslessCap + 1e-6,
      detail: {
        requested: maxRequested,
        sMaxLossless: budget.sMaxLossless,
        losslessScaleCap: losslessCap,
        fillUpscale: budget.fillUpscale,
        effectiveUpscale,
        policy: descriptor.maxZoomPolicy,
        basis: budget.sMaxLossless === null
          ? "源规格未知：无法判定（如实标注）"
          : `额外推近上限=max(1, min(基窗/画布))=${losslessCap}；画幅转换本身 ${budget.fillUpscale}×`,
      },
    },
    {
      kind: "reframe_duration_preserved",
      hard: true,
      ok: Math.abs((outProbe.videoDuration ?? 0) - sourceDuration) <= 0.2,
      detail: { source: round3(sourceDuration), output: round3(outProbe.videoDuration ?? 0), toleranceSec: 0.2 },
    },
  ];
  if (descriptor.fill !== "pad") {
    const edge = await measureEdgeBands({ file: target, height: canvas[1], bins });
    checks.push({ kind: "reframe_no_letterbox_defect", hard: true, ok: edge.ok, detail: edge });
  }
  const passed = checks.every((check) => check.ok !== false);
  return {
    schemaVersion: "workloom.reframe-receipt/v1",
    generatedAt: new Date().toISOString(),
    key,
    mode: descriptor.mode,
    intent: descriptor.intent,
    fill: descriptor.fill,
    legacyPunchIn: descriptor.legacyPunchIn === true,
    source: source ? { width: source.width, height: source.height } : null,
    canvas: { width: canvas[0], height: canvas[1] },
    scale: descriptor.scale,
    center: descriptor.center,
    budget: { ...budget, effectiveUpscale },
    checks,
    passed,
  };
}

async function contentKey(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/**
 * 逐镜归一化：统一 WxH / fps / yuv420p / AAC 48k 立体声，**并按内容哈希缓存**。
 * 缓存命中即复用（不重编码）——这正是"返修不重新生成镜头"的地基：镜头没换，归一化产物就不该重算。
 */
export async function normaliseShots({
  shots = [], project = {}, workDir, bins = resolveBinaries(), reuse = true, force = false, env = process.env,
}) {
  explicitShotAudio(shots);
  const [width, height] = resolveResolution(project);
  const quality = resolveQuality(project);
  const fps = optionalNumber(project.fps, 30);
  const canonicalWorkDir = assertPathAllowed(workDir, allowedRoots(env), "workDir");
  const dir = path.join(canonicalWorkDir, "norm");
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) {
    throw new PostError("归一化工作目录不能是符号链接", "path_not_allowed");
  }
  assertPathAllowed(dir, allowedRoots(env), "normDir");
  await fsp.mkdir(dir, { recursive: true });
  const out = [];
  for (const shot of shots) {
    const source = text(shot.path ?? shot.localPath, "shots[].path");
    if (!fs.existsSync(source)) throw new PostError(`镜头产物不存在：${source}`, "not_found");
    const shotId = String(shot.shotId ?? shot.shot_id ?? path.basename(source));
    const sourceHash = await sha256File(source);
    let frozenSource = source;
    {
      const snapshotDir = await fsp.mkdtemp(path.join(dir, ".source-"));
      frozenSource = (await snapshotAudioStemArtifact({ file: source, sha256: sourceHash,
        output: path.join(snapshotDir, "original"), allowedRoots: allowedRoots(env) })).path;
    }
    const probe = await probeMedia(frozenSource, { bins });
    const sourceDuration = probe.videoDuration;
    if (!(sourceDuration > 0)) throw new PostError(`镜头 ${shotId} 缺视频轨时长`, "bad_media");
    const sourceKind = String(shot.kind ?? project.sourceKind ?? project.mediaKind ?? "live-action");
    if (!["live-action", "animation", "text"].includes(sourceKind)) {
      throw new PostError(`镜头 ${shotId} 的素材类型未知：${sourceKind}`, "bad_request");
    }
    /**
     * 二次构图（取景轨道）：`shot.reframe` 由编辑层计划（reframe.ts）物化后传入；
     * 缺省 null = 完全沿用既有归一化路径（零行为变化）。
     */
    const reframe = normalizeShotReframe(shot.reframe ?? null);
    const reframeKey = reframe ? `rf-${hashKey(STABLE_JSON(reframe))}` : "none";
    const reframeSource = { width: probe.width, height: probe.height };
    let input = frozenSource;
    const enhancement = quality === "uhd" ? {
      status: "not-requested", kind: sourceKind, sourceResolution: [probe.width, probe.height],
      sourceSha256: sourceHash, method: "local-canvas-resize", model: null, qualityReviewed: false,
    } : null;
    const inputHash = input === frozenSource ? sourceHash : enhancement.sha256;
    const key = await contentKey({
      sourceHash, inputHash, width, height, fps, quality, v: 3,
      ...(reframe ? { reframe: reframeKey } : {}),
    });
    const target = path.join(dir, `${shotId}-${key}.mp4`);
    const receiptPath = `${target}.json`;
    if (reuse && !force && fs.existsSync(target)) {
      const stat = await fsp.stat(target);
      const cachedProbe = await probeMedia(target, { bins });
      let receipt;
      try { receipt = JSON.parse(await fsp.readFile(receiptPath, "utf8")); }
      catch (error) {
        throw new PostError(`归一化缓存回执缺失或不可读：${target}：${error instanceof Error ? error.message : String(error)}`, "verify_failed");
      }
      const cachedHash = await sha256File(target);
      if (receipt.key !== key || receipt.sourceSha256 !== sourceHash || receipt.inputSha256 !== inputHash
          || receipt.outputSha256 !== cachedHash || receipt.bytes !== stat.size
          || cachedProbe.width !== width || cachedProbe.height !== height || !cachedProbe.hasAudio
          || cachedProbe.videoCodec !== "h264" || cachedProbe.audioCodec !== "aac"
          || !(cachedProbe.videoDuration > 0)
          || Math.abs((cachedProbe.fps ?? 0) - fps) > 0.01) {
        throw new PostError(`归一化缓存内容或规格与回执不一致：${target}`, "verify_failed");
      }
      if (await sha256File(source) !== sourceHash
          || (input !== source && await sha256File(input) !== inputHash)) {
        throw new PostError(`镜头 ${shotId} 归一化缓存读取期间原素材发生变化`, "verify_failed");
      }
      if ((receipt.reframe?.key ?? "none") !== reframeKey) {
        throw new PostError(`镜头 ${shotId} 归一化缓存的取景口径与本次请求不一致：${target}`, "verify_failed");
      }
      if (receipt.reframe && receipt.reframe.passed === false) {
        throw new PostError(`镜头 ${shotId} 归一化缓存的取景机检未通过（上次运行）：请清理工作目录后重跑`, "verify_failed");
      }
      out.push({
        shotId, source, sourceHash, sourceDuration, sourceHasAudio: probe.hasAudio,
        audioStems: shot.audioStems ?? null, sourceKind, enhancement, quality, path: target, reused: true,
        sha256: cachedHash, bytes: stat.size, mtimeMs: Math.round(stat.mtimeMs),
        duration: cachedProbe.videoDuration, reframe: receipt.reframe ?? null,
      });
      continue;
    }
    /**
     * 取景链（crop-first）与旧归一化链二选一：
     *   · 未声明 reframe：字节级沿用旧链（scale→pad），零行为变化；
     *   · 声明 reframe：源原生裁切 → 填充/画布 → 动画（zoompan），并补 `-t` 锁定输出时长。
     */
    const reframeChain = reframe
      ? buildReframeChain({ descriptor: reframe, source: reframeSource, canvas: [width, height], durationSeconds: probe.videoDuration, fps })
      : null;
    const scale = reframeChain
      ? `${reframeChain.filters.join(",")},format=yuv420p`
      : `scale=${width}:${height}:force_original_aspect_ratio=decrease`
        + `,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p`;
    /**
     * 2026-10-11：uhd（4K）交付不再人为限 2 线程——旧值让 4K 成片交付耗时数小时；
     * 只放开线程数，preset/crf 等画质参数一律不变。
     */
    const args = ["-hide_banner", "-v", "error", "-y", "-filter_threads", quality === "uhd" ? "0" : "1", "-i", input];
    if (!probe.hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
    args.push("-vf", scale);
    if (reframeChain) args.push("-t", String(round3(probe.videoDuration)));
    if (probe.hasAudio) args.push("-map", "0:v:0", "-map", "0:a:0");
    else args.push("-map", "0:v:0", "-map", "1:a:0", "-shortest");
    const tempTarget = path.join(dir, `${shotId}-${key}.${process.pid}.${Date.now()}.tmp.mp4`);
    args.push(
      "-c:v", "libx264", "-preset", quality === "uhd" ? "medium" : "veryfast",
      "-crf", quality === "uhd" ? "16" : "18", "-threads", "0", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-movflags", "+faststart", tempTarget,
    );
    let stat;
    let outputProbe;
    let outputHash;
    /** 取景回执（在 try 内计算、在 finally 后随 clip 返回，故需外层作用域） */
    let reframeReceipt = null;
    try {
      await runBin(bins.ffmpeg, args, { label: "ffmpeg(normalise)", timeoutMs: 900_000 });
      if (!fs.existsSync(tempTarget)) throw new PostError(`归一化未产出文件：${tempTarget}`, "ffmpeg_failed", true);
      stat = await fsp.stat(tempTarget);
      outputProbe = await probeMedia(tempTarget, { bins });
      if (outputProbe.width !== width || outputProbe.height !== height || !outputProbe.hasAudio
          || outputProbe.videoCodec !== "h264" || outputProbe.audioCodec !== "aac"
          || !(outputProbe.videoDuration > 0)
          || Math.abs((outputProbe.fps ?? 0) - fps) > 0.01) {
        throw new PostError(`镜头 ${shotId} 归一化规格不符：实测 ${outputProbe.width}×${outputProbe.height}/${outputProbe.fps}fps`, "verify_failed");
      }
      outputHash = await sha256File(tempTarget);
      if (await sha256File(source) !== sourceHash
          || (input !== source && await sha256File(input) !== inputHash)) {
        throw new PostError(`镜头 ${shotId} 归一化期间原素材或增强输入发生变化`, "verify_failed");
      }
      await fsp.rename(tempTarget, target);
      /**
       * 取景机检（预算/时长/黑边）与回执：先落回执（含失败证据），硬项不过即抛错，
       * 不让"带黑边 / 超预算 / 吞时长"的产物静默进入交付。
       */
      reframeReceipt = reframe
        ? await verifyReframeOutcome({
          descriptor: reframe, key: reframeKey, source: reframeSource, canvas: [width, height],
          outProbe: outputProbe, sourceDuration: probe.videoDuration, target, bins,
        })
        : null;
      await writeJson(receiptPath, {
        key, sourceSha256: sourceHash, inputSha256: inputHash, outputSha256: outputHash,
        bytes: stat.size, width, height, fps, hasAudio: true,
        ...(reframeReceipt ? { reframe: reframeReceipt } : {}),
      });
      if (reframeReceipt && reframeReceipt.passed === false) {
        const failures = reframeReceipt.checks.filter((check) => check.hard !== false && check.ok === false);
        throw new PostError(
          `镜头 ${shotId} 取景机检未通过（${failures.length} 项硬失败）：${failures.map((check) => `${check.kind} ${JSON.stringify(check.detail)}`).join("；")}`,
          "verify_failed",
        );
      }
    } finally {
      await fsp.rm(tempTarget, { force: true });
    }
    out.push({
      shotId, source, sourceHash, sourceDuration, sourceHasAudio: probe.hasAudio,
      audioStems: shot.audioStems ?? null, sourceKind, enhancement, quality, path: target, reused: false,
      sha256: outputHash, bytes: stat.size, mtimeMs: Math.round((await fsp.stat(target)).mtimeMs),
      duration: outputProbe.videoDuration,
      reframe: reframe
        ? {
          key: reframeKey, mode: reframe.mode, intent: reframe.intent, fill: reframe.fill,
          legacyPunchIn: reframe.legacyPunchIn === true,
          source: reframeSource, canvas: { width, height },
          scale: reframe.scale, center: reframe.center,
          chainMode: reframeChain?.mode ?? null,
          receiptPath, passed: reframeReceipt ? reframeReceipt.passed !== false : true,
        }
        : null,
    });
  }
  return out;
}

async function verifyUhdEvidence(clips, [width, height], bins) {
  for (const clip of clips) {
    if (!clip.path || !fs.existsSync(clip.path) || await sha256File(clip.path) !== clip.sha256) {
      throw new PostError(`镜头 ${clip.shotId} 归一化产物缺失或哈希变化`, "verify_failed");
    }
    const normalisedProbe = await probeMedia(clip.path, { bins });
    if (normalisedProbe.width !== width || normalisedProbe.height !== height || !normalisedProbe.hasAudio) {
      throw new PostError(`镜头 ${clip.shotId} 归一化产物规格不符`, "verify_failed");
    }
    const item = clip.enhancement;
    if (!item || item.sourceSha256 !== clip.sourceHash || !Array.isArray(item.sourceResolution)) {
      throw new PostError(`镜头 ${clip.shotId} 缺 UHD 来源与源哈希`, "verify_failed");
    }
    if (item.status === "not-requested" && item.method === "local-canvas-resize") {
      if (!clip.source || !fs.existsSync(clip.source) || await sha256File(clip.source) !== clip.sourceHash
        || item.sourceResolution.some((dimension) => !Number.isInteger(dimension) || dimension <= 0)) {
        throw new PostError(`镜头 ${clip.shotId} 本地画布加工的原片来源发生变化`, "verify_failed");
      }
      continue;
    }
    if (item.status === "source-sufficient") {
      const [sourceWidth, sourceHeight] = item.sourceResolution;
      if (!Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight)
          || sourceWidth <= 0 || sourceHeight <= 0
          || Math.min(width / sourceWidth, height / sourceHeight) > 1.001) {
        throw new PostError(`镜头 ${clip.shotId} 的原片像素不足以直接交付 UHD`, "verify_failed");
      }
      continue;
    }
    if (item.status !== "enhanced" || item.processingMode !== "ai-upscale"
        || item.receipt?.localVerified !== true || !item.model || !item.engineSha256
        || !item.output || !item.provenancePath || !/^[a-f0-9]{64}$/.test(item.sha256 ?? "")) {
      throw new PostError(`镜头 ${clip.shotId} 缺真实本机 AI 增强回执`, "verify_failed");
    }
    let provenance;
    try { provenance = JSON.parse(await fsp.readFile(item.provenancePath, "utf8")); }
    catch (error) {
      throw new PostError(`镜头 ${clip.shotId} 来源文件不可读：${error instanceof Error ? error.message : String(error)}`, "verify_failed");
    }
    if (provenance.key !== item.key || provenance.processingMode !== "ai-upscale"
        || provenance.model !== item.model || provenance.engine?.binarySha256 !== item.engineSha256
        || provenance.source?.sha256 !== item.sourceSha256 || provenance.output?.sha256 !== item.sha256
        || provenance.receipt?.localVerified !== true || provenance.output?.probe?.width !== width
        || provenance.output?.probe?.height !== height) {
      throw new PostError(`镜头 ${clip.shotId} 来源文件与交付记录不一致`, "verify_failed");
    }
    if (!fs.existsSync(item.output) || await sha256File(item.output) !== item.sha256) {
      throw new PostError(`镜头 ${clip.shotId} 增强产物缺失或哈希变化`, "verify_failed");
    }
  }
}

/**
 * 拼接（层 2）：三种转场口径，全部走"先归一化后拼接"，避免异构编码直接 concat 花屏。
 * - hard：concat demuxer 无损直拼（最快，适合快节奏信息流）；
 * - fade：逐镜淡入淡出后直拼（情绪连贯，适合叙事/文旅）；
 * - xfade：真交叉溶解（镜头之间重叠过渡，最"精致"但需重编码）。
 */
/** Assemble the requested timeline; no source-audio correlation or speech-quality review. */
async function assembleSampleAccurate({ bins, list, clips, output, workDir, fps = 30 }) {
  const measuredClips = clips.map((clip) => ({ ...clip, durationSec: Number(clip.durationSec ?? clip.duration ?? 0) }));
  if (measuredClips.some((clip) => !Number.isFinite(clip.durationSec) || clip.durationSec <= 0)) {
    throw new PostError("样点级拼接需要每个镜头的有效时长", "bad_media");
  }
  const plan = buildSampleAccurateConcatPlan({ listFile: list, clips: measuredClips, output, workDir, fps });
  await fsp.writeFile(list, plan.concatList, "utf8");
  await runBin(bins.ffmpeg, plan.videoArgs, { label: "ffmpeg(concat-video)", timeoutMs: 900_000 });
  await runBin(bins.ffmpeg, plan.audioArgs, { label: "ffmpeg(concat-audio)", timeoutMs: 900_000 });
  await runBin(bins.ffmpeg, plan.muxArgs, { label: "ffmpeg(concat-mux)", timeoutMs: 900_000 });
  const report = { policy: "rendered-source-default-acceptance", qualityReviewed: false,
    correlation: null, method: "sample-accurate-timeline", sourceClips: measuredClips.length };
  await writeAvSyncReport(output, { processed: true, report });
  return report;
}

/** 音画对齐报告落地（与基座 CLI 同口径：`<输出>.av-sync.json`，便于发布方/审计复核）。 */
async function writeAvSyncReport(output, payload) {
  const target = `${output.replace(/\.mp4$/i, "")}.av-sync.json`;
  try {
    await fsp.writeFile(target, `${JSON.stringify({ generatedAt: new Date().toISOString(), output, ...payload }, null, 2)}\n`, "utf8");
  } catch (error) {
    throw new PostError(`音画同步报告写入失败：${target}：${error instanceof Error ? error.message : String(error)}`, "io_failed");
  }
}

/* ============================ 转场引擎（逐切 xfade 计划） ============================ */
/**
 * 转场引擎口径（2026-10-11，T-2026-1011-0003）：
 *
 * - 目录与默认映射的唯一事实源是 `bundles/ai-video/library/transitions/catalog.json`
 *   （FFmpeg 6.0 的 46 种命名转场 + 7.0 新增 12 种 + custom 表达式变量表）；
 * - 逐切计划由剪辑层（`packages/video-studio/src/edit/transitions.ts`）产出，本引擎只忠实渲染，
 *   变体配方的 `intentMap` 可按风格覆盖具体转场（同一剪辑脚本 → 三种风格转场）；
 * - **硬切是真硬切**：按转场切点把时间轴拆成若干 run，run 内做 xfade，run 之间用样点级 concat，
 *   不把硬切降级成"1 帧 xfade"（幽灵帧在快剪里看得见）；
 * - 每刀转场都有回执：重叠窗口帧数、中点亮度、帧间差集中度、黑帧比例。
 *   其中"窗口不存在"与"非黑场类转场出现黑帧"是**事实类硬失败**（产物缺陷），
 *   缓动/集中度这类观感指标只作咨询项（硬闸只允许事实类，见 scripts/ci/hard-gate-policy.mjs）。
 */
export const TRANSITION_CATALOG_FILE = path.join(BUNDLE_ROOT, "library", "transitions", "catalog.json");
export const TRANSITION_RECEIPT_SCHEMA = "workloom.transition-receipt/v1";

/** 缓动叠化表达式：custom 逐像素求值（P=X 轴进度），smoothstep 让线性叠化不再"廉价"。 */
export const EASED_DISSOLVE_EXPR = "A*(1-(P*P*(3-2*P)))+B*(P*P*(3-2*P))";

const transitionCatalogCache = new Map();

/** 读取并校验转场目录；结构或引用不合法直接 fail-closed（不猜、不兜底）。 */
export function loadTransitionCatalog(file = TRANSITION_CATALOG_FILE) {
  if (transitionCatalogCache.has(file)) return transitionCatalogCache.get(file);
  if (!fs.existsSync(file)) throw new PostError(`转场目录不存在：${file}`, "not_configured");
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  if (doc?.schemaVersion !== "workloom.transition-catalog/v1" || !Array.isArray(doc.transitions) || !doc.intents || !doc.durationPolicy) {
    throw new PostError(`转场目录结构不合法：${file}`, "not_configured");
  }
  const names = new Set(doc.transitions.map((item) => item.name));
  for (const [intent, spec] of Object.entries(doc.intents)) {
    if (spec.type && !names.has(spec.type)) throw new PostError(`转场目录意图 ${intent} 指向未定义转场 ${spec.type}`, "not_configured");
    for (const [direction, mapped] of Object.entries(spec.directions ?? {})) {
      if (!names.has(mapped)) throw new PostError(`转场目录意图 ${intent} 的 ${direction} 方向指向未定义转场 ${mapped}`, "not_configured");
    }
  }
  transitionCatalogCache.set(file, doc);
  return doc;
}

/** 探测 ffmpeg 版本：7.0+ 新增的转场（wind/cover/reveal）按版本闸放行或明确拒绝。 */
export async function probeFfmpegVersion(bins = resolveBinaries()) {
  const { stdout } = await runBin(bins.ffmpeg, ["-version"], { label: "ffmpeg -version" });
  const banner = String(stdout).split("\n")[0] ?? "";
  const raw = /ffmpeg version\s+([^\s]+)/i.exec(banner)?.[1] ?? null;
  const numeric = raw ? /^n?(\d+)\.(\d+)/.exec(raw) : null;
  return { raw, major: numeric ? Number(numeric[1]) : null, minor: numeric ? Number(numeric[2]) : null, banner };
}

function versionSupportsTransition(entry, version) {
  if (!entry || entry.since === "6.0") return true;
  if (!version || version.major === null) return false;
  const required = String(entry.since).split(".").map((value) => Number(value));
  return version.major > required[0] || (version.major === required[0] && version.minor >= (required[1] ?? 0));
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * 逐切计划解析：把 `transitions.perCut`（以进入镜头 shotId 为键）解析成可渲染的切点。
 * 解析优先级：计划显式指定（params.xfade）→ 变体 intentMap → 计划默认类型 → 调用方默认。
 * 任何未知转场名、版本不支持的转场、时长越界都明确报错或按事实降级（绝不静默换类型）。
 */
export function planXfadeCuts({
  clips = [], transitions = {}, fps = 30, catalog = loadTransitionCatalog(),
  version = null, style = null,
} = {}) {
  const cuts = [];
  const notes = [];
  const perCutMap = transitions.perCut && typeof transitions.perCut === "object" && !Array.isArray(transitions.perCut)
    ? transitions.perCut
    : null;
  const perCutList = Array.isArray(transitions.perCut) ? transitions.perCut
    : (Array.isArray(transitions.plan?.cuts) ? transitions.plan.cuts : (Array.isArray(transitions.plan) ? transitions.plan : null));
  const legacyChain = !perCutMap && !perCutList;
  const fallbackType = typeof transitions.type === "string" && transitions.type.trim() ? transitions.type.trim() : (legacyChain ? "fade" : null);
  const fallbackDuration = optionalNumber(transitions.fadeSec ?? transitions.durationSec, 0.5);
  const intentMap = style?.intentMap ?? transitions.intentMap ?? null;
  const styleScale = optionalNumber(style?.scale ?? transitions.scale, 1);
  const limits = catalog.durationPolicy;
  const names = new Map(catalog.transitions.map((item) => [item.name, item]));
  const minSeconds = Math.max(limits.minSec, limits.minFrames / fps);

  const durationOf = (clip) => optionalNumber(clip.durationSec ?? clip.duration, 0);

  for (let index = 1; index < clips.length; index += 1) {
    const before = clips[index - 1];
    const after = clips[index];
    const shotKey = String(after.shotId);
    let raw = null;
    if (perCutMap) raw = perCutMap[shotKey] ?? null;
    if (!raw && perCutList) {
      raw = perCutList.find((entry) => entry && (String(entry.incomingSegmentId ?? entry.shotId ?? "") === shotKey || Number(entry.cutIndex) === index)) ?? null;
    }

    const intent = typeof raw?.intent === "string" ? raw.intent : null;
    const catalogIntent = intent ? catalog.intents[intent] ?? null : null;
    const styleSpec = intent && intentMap?.[intent] && typeof intentMap[intent] === "object" ? intentMap[intent] : null;
    const explicitType = raw?.explicit === true || (raw && intent === null && typeof raw.type === "string");
    let type = null;
    let resolvedBy = null;
    if (raw) {
      if (explicitType && typeof raw.type === "string") { type = raw.type; resolvedBy = "plan-explicit"; }
      else if (typeof styleSpec?.type === "string") { type = styleSpec.type; resolvedBy = "variant-intentMap"; }
      else if (typeof raw.type === "string" && raw.type !== "") { type = raw.type; resolvedBy = "plan-default"; }
      else if (typeof catalogIntent?.type === "string") { type = catalogIntent.type; resolvedBy = "catalog-intent"; }
      else if (raw.type === null || catalogIntent?.type === null) { type = null; resolvedBy = "plan-hard-cut"; }
    } else if (fallbackType) {
      type = fallbackType;
      resolvedBy = "caller-default";
    }
    if (!type) {
      if (raw && resolvedBy !== "plan-hard-cut" && !fallbackType) {
        notes.push(`切点 ${index}（${before.shotId}→${after.shotId}）没有可解析的转场类型，已按硬切处理。`);
      }
      continue;
    }

    const entry = names.get(type);
    if (!entry) {
      throw new PostError(
        `未知转场：${type}（切点 ${index} ${before.shotId}→${after.shotId}；可用转场见 transitions/catalog.json，共 ${names.size} 种）`,
        "bad_recipe",
      );
    }
    if (!versionSupportsTransition(entry, version)) {
      throw new PostError(
        `转场 ${type} 需要 FFmpeg ${entry.since}+（当前 ${version?.raw ?? "未知版本"}）：请改用 6.0 基线的转场，或升级 FFmpeg 后重跑`,
        "bad_recipe",
      );
    }

    let requestedDuration = optionalNumber(
      styleSpec?.durationSec ?? raw?.durationSeconds ?? (catalogIntent ? catalogIntent.durationSec : undefined),
      fallbackDuration,
    );
    const scale = raw ? optionalNumber(styleSpec?.scale ?? styleScale, 1) : 1;
    requestedDuration *= Number.isFinite(scale) && scale > 0 ? scale : 1;

    const share = limits.maxShareOfClip;
    const headroom = Math.min(limits.maxSec, durationOf(before) * share, durationOf(after) * share);
    let durationSeconds;
    if (legacyChain) {
      /** 旧口径（`{mode:"xfade", fadeSec}`）：保持历史行为——下限 0.05s、上限相邻镜头 1/2。 */
      durationSeconds = Math.min(Math.max(0.05, fallbackDuration), Math.max(0.05, Math.min(durationOf(before), durationOf(after)) / 2));
    } else {
      if (headroom < minSeconds) {
        notes.push(`切点 ${index}（${before.shotId}→${after.shotId}）相邻镜头过短（可用 ${round3(headroom)}s < 下限 ${round3(minSeconds)}s），已降级为硬切。`);
        continue;
      }
      durationSeconds = Math.min(Math.max(requestedDuration, minSeconds), headroom);
    }
    durationSeconds = round3(Math.max(0.02, durationSeconds));

    const requestedEasing = raw?.easing ?? styleSpec?.easing ?? "native";
    let easing = requestedEasing === "smooth" ? "smooth" : "native";
    if (easing === "smooth" && type !== "fade") {
      notes.push(`切点 ${index} 的转场 ${type} 不支持 custom 缓动，已回退 native 曲线。`);
      easing = "native";
    }

    cuts.push({
      cutIndex: index,
      fromShotId: String(before.shotId),
      toShotId: shotKey,
      intent,
      type,
      durationSeconds,
      easing,
      maxDurationSeconds: round3(headroom),
      resolvedBy,
      blackDip: entry.blackDip === true || catalog.blackDipAllowed?.includes(type) === true,
      reason: typeof raw?.reason === "string" ? raw.reason : (legacyChain ? "调用方整段转场设置" : null),
    });
  }
  return { cuts, notes };
}

/** 依据切点把时间轴拆分为 run：run 内相邻镜头有转场，run 之间是真硬切。 */
function splitTransitionRuns(clipCount, cuts) {
  const byCut = new Map(cuts.map((cut) => [cut.cutIndex, cut]));
  const runs = [];
  let current = [0];
  for (let index = 1; index < clipCount; index += 1) {
    if (byCut.has(index)) current.push(index);
    else { runs.push(current); current = [index]; }
  }
  runs.push(current);
  return runs;
}

/** 构建单个 run 的 xfade 过滤链（run 内全部切点都有转场）。 */
function buildXfadeRunPlan({ clips, cuts, runIndexes }) {
  const filters = [];
  let lastVideo = "[0:v]";
  let lastAudio = "[0:a]";
  const runCuts = [];
  let offset = optionalNumber(clips[runIndexes[0]]?.durationSec ?? clips[runIndexes[0]]?.duration, 0);
  if (!(offset > 0)) throw new PostError(`镜头 ${clips[runIndexes[0]]?.shotId} 缺时长，无法计算转场重叠点`, "bad_media");
  for (let local = 1; local < runIndexes.length; local += 1) {
    const globalIndex = runIndexes[local];
    const cut = cuts.find((entry) => entry.cutIndex === globalIndex);
    if (!cut) throw new PostError(`内部错误：切点 ${globalIndex} 缺少转场计划`, "verify_failed");
    const fade = cut.durationSeconds;
    offset = Math.max(0, round3(offset - fade));
    const videoOut = local === runIndexes.length - 1 ? "[vout]" : `[v${local}]`;
    const audioOut = local === runIndexes.length - 1 ? "[aout]" : `[a${local}]`;
    const expr = cut.easing === "smooth" ? `:expr=${EASED_DISSOLVE_EXPR}` : "";
    filters.push(`${lastVideo}[${local}:v]xfade=transition=${cut.type}:duration=${fade}:offset=${offset}${expr}${videoOut}`);
    filters.push(`${lastAudio}[${local}:a]acrossfade=d=${fade}:c1=tri:c2=tri${audioOut}`);
    runCuts.push({ ...cut, runOffsetSeconds: offset });
    lastVideo = videoOut;
    lastAudio = audioOut;
    offset = round3(offset + optionalNumber(clips[globalIndex]?.durationSec ?? clips[globalIndex]?.duration, 0));
  }
  return { filters, runCuts, expectedDurationSeconds: round3(offset) };
}

/**
 * 转场窗口机检：读回执要能证明"这一刀真的做了转场，而且黑帧不是转场引入的"。
 *
 * 口径（避免误杀真实内容）：窗口内黑帧与窗口外邻域黑帧分别计数——
 * 只有"窗口内有黑帧、邻域却没有"才判定为**转场引入的黑屏**（事实缺陷，硬失败）；
 * 素材本身就是黑场（片头黑场、夜景）时邻域同样有黑帧，只记录不否决。
 */
async function measureTransitionWindow({ output, cut, bins, fps }) {
  const pad = 0.6;
  const windowStart = Math.max(0, cut.startSeconds - pad);
  const windowEnd = cut.endSeconds + pad;
  const { stdout, stderr } = await runBin(bins.ffmpeg, [
    "-hide_banner", "-v", "info",
    "-ss", String(round3(windowStart)), "-to", String(round3(windowEnd)), "-i", output,
    /** blackframe 必须在 tblend 之前：它要判的是**原始帧**的黑场，不是帧间差图（差图本来就接近全黑）。 */
    "-vf", "blackframe=amount=98:threshold=32,tblend=difference,signalstats,metadata=print:file=-",
    "-an", "-f", "null", "-",
  ], { label: "ffmpeg(transition-window)" });
  const diffs = [];
  for (const line of String(stdout).split("\n")) {
    const match = /lavfi\.signalstats\.YAVG=([0-9.]+)/.exec(line);
    if (!match) continue;
    const value = Number(match[1]);
    /** 链上是 `tblend=difference,signalstats`，因此 YAVG 是"与上一帧的差"；原始亮度由 blackframe 段提供。 */
    if (Number.isFinite(value)) diffs.push(value);
  }
  const blackFrames = [];
  for (const line of String(stderr).split("\n")) {
    const match = /frame:(\d+)\s+pblack:([0-9.]+)/.exec(line);
    if (match && Number(match[2]) >= 98) blackFrames.push(Number(match[1]));
  }
  const insideStart = cut.startSeconds - windowStart - 0.02;
  const insideEnd = cut.endSeconds - windowStart + 0.02;
  const isInside = (frame) => {
    const seconds = (frame + 0.5) / fps;
    return seconds >= insideStart && seconds <= insideEnd;
  };
  const blackFramesInside = blackFrames.filter(isInside).length;
  const blackFramesOutside = blackFrames.length - blackFramesInside;
  const samples = diffs.slice(1);
  const total = samples.reduce((sum, value) => sum + value, 0);
  const maxDiff = samples.length ? Math.max(...samples) : 0;
  return {
    windowStartSeconds: round3(windowStart),
    windowEndSeconds: round3(windowEnd),
    transitionStartSeconds: round3(cut.startSeconds),
    transitionEndSeconds: round3(cut.endSeconds),
    frameSamples: samples.length,
    diffSamples: samples.map((value) => round3(value)),
    meanFrameDiff: samples.length ? round3(total / samples.length) : 0,
    maxFrameDiff: round3(maxDiff),
    /** 集中度：单帧跳变（≈1）说明像硬切，多帧分摊（≈1/N）说明是渐变转场。 */
    changeConcentration: total > 0 ? round3(maxDiff / total) : 1,
    changedFrames: samples.filter((value) => value >= 1).length,
    blackFrames: blackFrames.length,
    blackFramesInside,
    blackFramesOutside,
    expectedMinFrames: Math.max(2, Math.floor(cut.durationSeconds * fps) - 1),
  };
}

/**
 * 黑场判定（纯函数，可单测）：只有"窗口内有黑帧、邻域没有"才算**转场引入的黑屏**。
 * 黑场类转场（fadeblack/fadewhite/fadegrays）是有意为之，直接豁免。
 */
export function evaluateTransitionBlackCheck(measurement, { blackDip = false } = {}) {
  const inside = Number(measurement?.blackFramesInside ?? 0);
  const outside = Number(measurement?.blackFramesOutside ?? 0);
  if (blackDip) {
    return { ok: true, introduced: false, detail: `黑场类转场（有意为之，豁免黑帧检查；窗口内黑帧 ${inside}）` };
  }
  const introduced = inside > 0 && outside === 0;
  return {
    ok: !introduced,
    introduced,
    detail: introduced
      ? `转场引入黑帧：窗口内 ${inside} 个黑帧、窗口外邻域 ${outside} 个（判定为黑屏过渡缺陷）`
      : `窗口内黑帧 ${inside} / 邻域黑帧 ${outside}（未发现转场引入的黑屏）`,
  };
}

/**
 * 渲染带逐切转场的时间轴（run 内 xfade、run 间样点级 concat），并产出转场回执。
 * 返回 { output, receiptPath, receipt, plan, runs }。
 */
async function assembleTransitionTimeline({
  bins, clips, cuts, notes, output, resolution, fps, workDir, version, catalog, styleId, videoEncode,
}) {
  const dir = path.join(workDir, "assemble-transitions");
  await fsp.mkdir(dir, { recursive: true });
  const runs = splitTransitionRuns(clips.length, cuts);
  const runOutputs = [];
  for (const [runIndex, runIndexes] of runs.entries()) {
    if (runIndexes.length === 1) {
      const clip = clips[runIndexes[0]];
      const probe = await probeMedia(clip.path, { bins });
      if (!(probe.videoDuration > 0)) throw new PostError(`镜头 ${clip.shotId} 缺视频轨时长`, "bad_media");
      runOutputs.push({ path: clip.path, durationSeconds: probe.videoDuration, runIndex, clips: runIndexes, single: true, cuts: [] });
      continue;
    }
    const target = runs.length === 1
      ? output
      : path.join(dir, `run-${String(runIndex).padStart(2, "0")}.mp4`);
    const plan = buildXfadeRunPlan({ clips, cuts, runIndexes });
    const args = ["-hide_banner", "-v", "error", "-y"];
    for (const index of runIndexes) args.push("-i", clips[index].path);
    args.push("-filter_complex", plan.filters.join(";"), "-map", "[vout]", "-map", "[aout]",
      ...videoEncode,
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-s", `${resolution[0]}x${resolution[1]}`, "-r", String(fps), "-movflags", "+faststart", target);
    await runBin(bins.ffmpeg, args, { label: "ffmpeg(xfade-runs)", timeoutMs: 1_800_000 });
    const probe = await probeMedia(target, { bins });
    if (!(probe.videoDuration > 0)) throw new PostError(`run ${runIndex} 拼装后无有效时长`, "verify_failed");
    runOutputs.push({ path: target, durationSeconds: probe.videoDuration, runIndex, clips: runIndexes, single: false, cuts: plan.runCuts });
  }

  if (runs.length > 1) {
    const list = path.join(dir, "runs-concat.txt");
    await assembleSampleAccurate({
      bins, list,
      clips: runOutputs.map((run) => ({
        shotId: `run-${run.runIndex}`,
        path: run.path,
        duration: run.durationSeconds,
        durationSec: run.durationSeconds,
        sourceHasAudio: true,
      })),
      output, workDir: dir, fps,
    });
  }

  const actualProbe = await probeMedia(output, { bins });
  const actualDurationSeconds = actualProbe.videoDuration ?? actualProbe.duration ?? 0;
  /** 把 run 内偏移换算成成片时间轴：运行间无重叠，直接累加。 */
  const cumulative = [];
  let acc = 0;
  for (const run of runOutputs) { cumulative.push(acc); acc = round3(acc + run.durationSeconds); }
  const timelineCuts = [];
  for (const run of runOutputs) {
    for (const cut of run.cuts ?? []) {
      timelineCuts.push({
        ...cut,
        startSeconds: round3(cumulative[run.runIndex] + cut.runOffsetSeconds),
        endSeconds: round3(cumulative[run.runIndex] + cut.runOffsetSeconds + cut.durationSeconds),
      });
    }
  }

  const tolerances = catalog.receiptPolicy ?? {};
  const evidence = [];
  const checks = [];
  for (const cut of timelineCuts) {
    const measurement = await measureTransitionWindow({ output, cut, bins, fps });
    const blackVerdict = evaluateTransitionBlackCheck(measurement, { blackDip: cut.blackDip === true });
    /** 事实类判定：转场窗口里必须真的有多帧可采样（证明存在重叠窗口，而不是一帧幽灵过渡）。 */
    const windowOk = measurement.frameSamples >= 2;
    const spreadAdvisory = measurement.frameSamples >= 3
      ? measurement.changeConcentration <= 0.85
      : null;
    evidence.push({ cutIndex: cut.cutIndex, from: cut.fromShotId, to: cut.toShotId, type: cut.type, intent: cut.intent, resolvedBy: cut.resolvedBy, measurement });
    checks.push({
      kind: "transition_window_present",
      ok: windowOk,
      hard: true,
      detail: `切点 ${cut.cutIndex}（${cut.fromShotId}→${cut.toShotId}）重叠窗口采样 ${measurement.frameSamples} 帧（预期 ≥2）`,
    });
    checks.push({
      kind: "transition_no_black_screen",
      ok: blackVerdict.ok,
      hard: true,
      detail: `切点 ${cut.cutIndex} 转场 ${cut.type}：${blackVerdict.detail}`,
    });
    if (spreadAdvisory !== null) {
      checks.push({
        kind: "transition_change_spread",
        ok: spreadAdvisory,
        hard: false,
        detail: `切点 ${cut.cutIndex} 帧间差集中度 ${measurement.changeConcentration}（≤0.85 表示变化分摊在多帧；仅咨询项）`,
      });
    }
  }
  const expectedDurationSeconds = round3(
    clips.reduce((sum, clip) => sum + optionalNumber(clip.durationSec ?? clip.duration, 0), 0)
      - timelineCuts.reduce((sum, cut) => sum + cut.durationSeconds, 0),
  );
  const durationOk = Math.abs(actualDurationSeconds - expectedDurationSeconds) <= optionalNumber(tolerances.durationToleranceSec, 0.4);
  checks.push({
    kind: "transition_duration_matches_plan",
    ok: durationOk,
    hard: true,
    detail: `实测 ${round3(actualDurationSeconds)}s / 计划 ${expectedDurationSeconds}s（容差 ±${optionalNumber(tolerances.durationToleranceSec, 0.4)}s）`,
  });

  const receipt = {
    schemaVersion: TRANSITION_RECEIPT_SCHEMA,
    generatedAt: new Date().toISOString(),
    output,
    mode: "xfade",
    styleId: styleId ?? null,
    engine: {
      name: catalog.engine?.name ?? "ffmpeg-xfade",
      filter: catalog.engine?.filter ?? "xfade",
      audioFilter: catalog.engine?.audioFilter ?? "acrossfade",
      ffmpegVersion: version?.raw ?? null,
      ffmpegBanner: version?.banner ?? null,
      catalogVersion: catalog.schemaVersion,
      catalogUpdatedAt: catalog.updatedAt ?? null,
    },
    cuts: timelineCuts.map((cut) => ({
      cutIndex: cut.cutIndex,
      fromShotId: cut.fromShotId,
      toShotId: cut.toShotId,
      intent: cut.intent,
      type: cut.type,
      durationSeconds: cut.durationSeconds,
      easing: cut.easing,
      resolvedBy: cut.resolvedBy,
      reason: cut.reason ?? null,
      startSeconds: cut.startSeconds,
      endSeconds: cut.endSeconds,
    })),
    hardCutCount: runs.filter((run) => run.length === 1).length,
    transitionCount: timelineCuts.length,
    totalTransitionSeconds: round3(timelineCuts.reduce((sum, cut) => sum + cut.durationSeconds, 0)),
    expectedDurationSeconds,
    actualDurationSeconds: round3(actualDurationSeconds),
    checks,
    evidence,
    notes: [...notes],
  };
  const receiptPath = `${output}.transition-receipt.json`;
  await writeJson(receiptPath, receipt);
  const failures = checks.filter((check) => check.hard && check.ok !== true);
  if (failures.length > 0) {
    throw new PostError(
      `转场机检未通过（${failures.length} 项硬失败）：${failures.map((check) => check.detail).join("；")}（回执：${receiptPath}）`,
      "verify_failed",
    );
  }
  return { output, receiptPath, receipt, cutCount: timelineCuts.length };
}

export async function assembleTimeline({
  clips = [], transitions = {}, output, resolution, fps = 30, quality = "hd", bins = resolveBinaries(),
}) {
  if (!Array.isArray(clips) || clips.length === 0) throw new PostError("拼接需要至少一个镜头", "bad_request");
  const mode = String(transitions.mode ?? "hard");
  const fadeSec = Math.max(0.05, optionalNumber(transitions.fadeSec, 0.5));
  const [width, height] = resolution ?? [1080, 1920];
  if (!["hd", "uhd"].includes(quality)) throw new PostError(`未知清晰度档位：${quality}`, "bad_request");
  const videoEncode = quality === "uhd"
    ? ["-c:v", "libx264", "-preset", "medium", "-crf", "16", "-threads", "0", "-pix_fmt", "yuv420p"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"];
  for (const clip of clips) {
    if (!fs.existsSync(clip.path)) throw new PostError(`归一化产物缺失：${clip.path}`, "not_found");
    if (path.resolve(clip.path) === path.resolve(output)) throw new PostError("拼接禁止覆盖输入镜头", "overwrite_source_forbidden");
  }
  await fsp.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  const dir = path.join(path.dirname(path.resolve(output)), "assemble");
  await fsp.mkdir(dir, { recursive: true });

  if (mode === "hard" || clips.length === 1) {
    const list = path.join(dir, "concat.txt");
    /**
     * 硬切拼接的**音画对齐纪律**（2026-09-26 真机事故修复，与基座 compose-film 同口径）：
     * 逐段 aac 音轨按 1024 样点成帧、末帧向上取整 → 每段音轨比画面长 0–21ms；
     * `-f concat -c copy` 让 demuxer 按各自流的时长累计偏移 → 声音逐镜漂移（真机尾镜 +125ms）。
     * 现在：画面仍 `-c:v copy`（帧级无损），声音改走 **concat 滤镜**并按画面时长 atrim+apad 到精确长度，再合流。
     */
    const avSync = await assembleSampleAccurate({
      bins, list, clips, output, workDir: dir, fps,
    });
    return { output, mode, fadeSec: 0, shots: clips.length, avSync,
      transitions: { receiptPath: null, cutCount: 0, note: "全部硬切（样点级拼接，无转场窗口）" } };
  }

  if (mode === "fade") {
    const parts = [];
    for (const [index, clip] of clips.entries()) {
      const duration = Number(clip.duration ?? 0);
      const fade = Math.min(fadeSec, Math.max(0.05, duration / 3));
      const target = path.join(dir, `fade-${index}.mp4`);
      await runBin(bins.ffmpeg, [
        "-hide_banner", "-v", "error", "-y", "-i", clip.path,
        "-vf", `fade=t=in:st=0:d=${fade},fade=t=out:st=${round(Math.max(0, duration - fade), 3)}:d=${fade}`,
        "-af", `afade=t=in:st=0:d=${fade},afade=t=out:st=${round(Math.max(0, duration - fade), 3)}:d=${fade}`,
        ...videoEncode,
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        target,
      ], { label: "ffmpeg(fade)", timeoutMs: 900_000 });
      parts.push(target);
    }
    const list = path.join(dir, "fade-concat.txt");
    /** 淡入淡出路径同样按样点级对齐拼接（各段已重编码，长度口径以各自的 durationSec 为准） */
    const avSync = await assembleSampleAccurate({
      bins, list,
      clips: await Promise.all(clips.map(async (clip, index) => {
        const file = parts[index] ?? clip.path;
        const fadedProbe = await probeMedia(file, { bins });
        if (!(fadedProbe.videoDuration > 0)) {
          throw new PostError(`淡化镜头 ${clip.shotId} 缺视频轨时长`, "bad_media");
        }
        return { ...clip, path: file, duration: fadedProbe.videoDuration };
      })),
      output, workDir: dir, fps,
    });
    /**
     * 旧 fade 模式是"逐段淡入淡出经黑场"——镜头之间必然出现黑帧，观感廉价（2026-10-11 客户反馈）。
     * 保留兼容，但写入回执明确标注该口径；新剪辑请改用 xfade 逐切计划（declared / auto）。
     */
    let blackGapEvidence = null;
    try {
      const firstProbe = await probeMedia(clips[0].path, { bins });
      if (firstProbe.videoDuration > 0) {
        blackGapEvidence = await measureTransitionWindow({
          output,
          cut: {
            cutIndex: 1,
            type: "legacy-per-clip-fade",
            durationSeconds: round(fadeSec * 2, 3),
            startSeconds: Math.max(0, round(firstProbe.videoDuration - fadeSec, 3)),
            endSeconds: round(firstProbe.videoDuration + fadeSec, 3),
            blackDip: true,
          },
          bins,
          fps,
        });
      }
    } catch (error) {
      blackGapEvidence = { error: error instanceof Error ? error.message : String(error), scope: "first-cut-sample" };
    }
    const receipt = {
      schemaVersion: TRANSITION_RECEIPT_SCHEMA,
      generatedAt: new Date().toISOString(),
      output,
      mode: "fade",
      styleId: null,
      engine: { name: "legacy-per-clip-fade", filter: "fade", ffmpegVersion: null, catalogVersion: null },
      cuts: [],
      hardCutCount: Math.max(0, clips.length - 1),
      transitionCount: 0,
      totalTransitionSeconds: 0,
      expectedDurationSeconds: round3(clips.reduce((sum, clip) => sum + Number(clip.duration ?? 0), 0)),
      actualDurationSeconds: null,
      checks: [],
      evidence: blackGapEvidence ? [{ scope: "first-cut-sample", measurement: blackGapEvidence }] : [],
      notes: [
        `legacy fade 模式：逐段淡入淡出 ${round(fadeSec, 3)}s，镜头之间经黑场（fade-to-black / fade-from-black），不是交叉溶解。`,
        blackGapEvidence && !blackGapEvidence.error
          ? `第 1 刀抽样：窗口内黑帧 ${blackGapEvidence.blackFramesInside}、邻域黑帧 ${blackGapEvidence.blackFramesOutside}（黑场过渡的量化证据；仅咨询项，不阻断兼容路径）。`
          : `黑场抽样未能完成：${blackGapEvidence?.error ?? "未执行"}`,
        "如出现黑屏停顿感，请改用 mode=xfade 的逐切计划（编辑层 declared / auto），黑场只保留给章节跳变。",
      ],
    };
    const receiptPath = `${output}.transition-receipt.json`;
    await writeJson(receiptPath, receipt);
    return { output, mode, fadeSec: round(fadeSec, 3), shots: clips.length, avSync,
      transitions: { receiptPath, receipt, cutCount: 0 } };
  }

  if (mode !== "xfade") throw new PostError(`未知转场模式：${mode}（可用：hard / fade / xfade）`, "bad_request");

  const durations = clips.map((clip) => Number(clip.duration ?? 0));
  if (durations.some((value) => !(value > 0))) {
    throw new PostError("xfade 需要每个镜头的时长（时长缺失无法算重叠点）", "bad_media");
  }
  /**
   * 逐切转场引擎（2026-10-11 起）：计划 → run 拆分 → run 内 xfade → run 间真硬切 concat → 转场回执。
   * 兼容旧调用：只给 `{mode:"xfade", fadeSec}` 时退化为"整条链一种转场"，但同样产出回执与机检。
   */
  const catalog = loadTransitionCatalog();
  const version = await probeFfmpegVersion(bins);
  const planned = planXfadeCuts({
    clips, transitions, fps, catalog, version,
    style: transitions.styleId || transitions.intentMap || transitions.scale
      ? { intentMap: transitions.intentMap ?? null, scale: transitions.scale ?? 1 }
      : null,
  });
  const legacyStyleId = typeof transitions.styleId === "string" ? transitions.styleId : null;

  if (planned.cuts.length === 0) {
    /** 计划里没有任何转场（全硬切）：走样点级 concat，不重编码、不引入幽灵帧。 */
    const list = path.join(dir, "planned-hard-concat.txt");
    const avSync = await assembleSampleAccurate({
      bins, list,
      clips: clips.map((clip) => ({ ...clip, duration: clip.duration ?? clip.durationSec, durationSec: clip.duration ?? clip.durationSec })),
      output, workDir: dir, fps,
    });
    const receipt = {
      schemaVersion: TRANSITION_RECEIPT_SCHEMA,
      generatedAt: new Date().toISOString(),
      output,
      mode: "xfade",
      styleId: legacyStyleId,
      engine: { name: catalog.engine?.name ?? "ffmpeg-xfade", filter: catalog.engine?.filter ?? "xfade",
        ffmpegVersion: version.raw, catalogVersion: catalog.schemaVersion },
      cuts: [],
      hardCutCount: Math.max(0, clips.length - 1),
      transitionCount: 0,
      totalTransitionSeconds: 0,
      expectedDurationSeconds: round3(durations.reduce((sum, value) => sum + value, 0)),
      actualDurationSeconds: null,
      checks: [],
      evidence: [],
      notes: [...planned.notes, "本片没有任何转场（全部硬切）：走样点级无损拼接。"],
    };
    const receiptPath = `${output}.transition-receipt.json`;
    await writeJson(receiptPath, receipt);
    return { output, mode, fadeSec: 0, shots: clips.length, avSync, transitions: { receiptPath, receipt, cutCount: 0 } };
  }

  const result = await assembleTransitionTimeline({
    bins, clips, cuts: planned.cuts, notes: planned.notes, output,
    resolution: [width, height], fps, workDir: dir, version, catalog, styleId: legacyStyleId, videoEncode,
  });
  const avSync = { policy: "rendered-source-default-acceptance", qualityReviewed: false,
    correlation: null, method: "planned-xfade-timeline", sourceClips: clips.length };
  await writeAvSyncReport(output, { processed: true, report: avSync });
  return {
    output, mode, fadeSec: round(fadeSec, 3), shots: clips.length, avSync,
    transitions: { receiptPath: result.receiptPath, receipt: result.receipt, cutCount: result.cutCount },
  };
}

/* ============================ 音频层（选曲 + 混音） ============================ */

/** 确定性选曲：按变体包的曲风/情绪过滤本地曲库，排序后取第一首可商用且文件在位者。 */
export function pickTrackForVariant(variant, { env = process.env } = {}) {
  return selectTrackForVariant(variant, { env }).picked;
}

/** BPM 折算到 [60,240) 家族（60/120/240 同族，消除倍频/半频误差）。 */
function foldBpm(value) {
  let bpm = Number(value);
  if (!Number.isFinite(bpm) || bpm <= 0) return null;
  while (bpm < 60) bpm *= 2;
  while (bpm > 240) bpm /= 2;
  return bpm;
}

/** 变体人设 → 目标能量区间（energyScore 0–1）；从 style/positioning 推断，未知按中档。 */
function energyBandForVariant(variant) {
  const style = String(variant.bgm?.style ?? "").toLowerCase();
  const text = `${style} ${variant.positioning ?? ""} ${variant.name ?? ""}`;
  if (/sports|hype|bold|燃|卡点|promo/.test(text)) return [0.6, 0.95];
  if (/warm|story|acoustic|温暖|叙事|情感/.test(text)) return [0.28, 0.6];
  if (/clean|corporate|技术|干净/.test(text)) return [0.45, 0.72];
  return [0.4, 0.75];
}

/**
 * 配乐 agent 打分（2026-10-11 升级，产品所有者反馈"BGM 跨版本一样且不好听"后的根因修复）：
 * 旧实现=「风格命中的第一条（本地优先→id 字典序）」——可复现但**不是最佳**，且同 style 的
 * warm/segmented 必然拿到同一首。现按 6 维打分（满分 93）：
 *   BPM 网格 30（围绕成片剪辑 targetBpm 的 60/120/240 家族）+ 能量档 20 + 情绪/题材 15
 *   + 时长富余 10 + 响度卫生 10 + 本地大库优先 8（产品所有者口径保留）。
 */
export function scoreTrackForVariant(track, variant, hints = {}) {
  const reasons = [];
  let score = 0;
  const targetBpm = Number(hints.targetBpm) > 0 ? Number(hints.targetBpm) : 120;
  const folded = foldBpm(track.bpmMeasured ?? track.bpm);
  if (folded) {
    const targets = [targetBpm / 2, targetBpm, targetBpm * 2].filter((value) => value >= 50 && value <= 260);
    const deltaRatio = Math.min(...targets.map((value) => Math.abs(folded - value) / value));
    const bpmScore = Math.max(0, 30 * (1 - deltaRatio / 0.25));
    score += bpmScore;
    if (bpmScore >= 18) reasons.push(`BPM ${Math.round(folded)} 贴合剪辑网格 ${targetBpm}`);
  }
  const [energyMin, energyMax] = energyBandForVariant(variant);
  const energy = Number.isFinite(Number(track.energyScore))
    ? Number(track.energyScore)
    : ({ low: 0.35, mid: 0.55, high: 0.8 })[String(track.energyBucket ?? "")] ?? 0.55;
  const energyDist = energy < energyMin ? energyMin - energy : energy > energyMax ? energy - energyMax : 0;
  const energyScore = Math.max(0, 20 * (1 - energyDist / 0.45));
  score += energyScore;
  if (energyDist === 0) reasons.push(`能量 ${energy.toFixed(2)} 落在变体目标区间 [${energyMin}, ${energyMax}]`);
  const tokens = [...new Set([
    ...String(variant.bgm?.mood ?? "").split(/[\/、,，\s]+/),
    ...(Array.isArray(hints.themeTokens) ? hints.themeTokens : []),
  ].map((token) => token.trim()).filter((token) => token.length >= 2))];
  const haystack = [track.style, track.styleLabel, track.genre, track.mood, ...(Array.isArray(track.tags) ? track.tags : []), ...(Array.isArray(track.useCases) ? track.useCases : [])]
    .filter(Boolean).join(" ").toLowerCase();
  let moodHits = 0;
  for (const token of tokens) if (haystack.includes(token.toLowerCase())) moodHits += 1;
  score += Math.min(15, moodHits * 6);
  if (moodHits > 0) reasons.push(`情绪/题材命中 ${moodHits} 项`);
  const filmSeconds = Number(hints.filmSeconds);
  if (Number.isFinite(filmSeconds) && filmSeconds > 0 && Number.isFinite(Number(track.durationSec))) {
    const margin = Number(track.durationSec) - filmSeconds;
    score += Math.max(0, Math.min(10, margin / 3));
    if (margin >= 30) reasons.push(`时长富余 ${Math.round(margin)}s`);
  } else {
    score += 6;
  }
  const lufs = Number(track.loudness?.integratedLufs);
  if (Number.isFinite(lufs)) {
    const dist = lufs < -16 ? -16 - lufs : lufs > -10 ? lufs + 10 : 0;
    score += Math.max(0, 10 * (1 - Math.min(1, dist / 6)));
    if (dist === 0) reasons.push(`响度 ${lufs.toFixed(1)} LUFS 在卫生区间`);
  } else {
    score += 5;
  }
  if (track.libraryKind !== "local-curated") {
    score += 8;
    reasons.push("来自本地打标大库");
  }
  return { score: Math.round(score * 10) / 10, reasons };
}

/**
 * 打分式选曲 + 候选清单（配乐 agent 主入口）。返回 picked / candidates（前 N 名，供回执与人工试听）/ notes。
 */
export function selectTrackForVariant(variant, { env = process.env, hints = {} } = {}) {
  const requestedStyle = String(variant.bgm?.style ?? "").trim().toLowerCase();
  const query = {};
  if (variant.bgm?.mood) query.mood = variant.bgm.mood;
  if (variant.bgm?.genre) query.genre = variant.bgm.genre;
  if (variant.bgm?.trackId) query.trackId = variant.bgm.trackId;
  /**
   * 指定曲目：走 `findTracks({ trackId })`——它会做许可可商用校验，找不到/不合规都如实报错。
   */
  if (variant.bgm?.trackId) {
    const byId = findTracks(query, env);
    const hit = byId.track ?? byId.items[0];
    if (!hit) throw new PostError(`曲库中未找到可用曲目：${variant.bgm.trackId}`, "not_found");
    return { picked: hit, candidates: [{ id: hit.id ?? variant.bgm.trackId, score: 100, reasons: ["配方指定曲目（trackId 钉住）"] }], notes: [] };
  }
  /**
   * 曲风（style）检索：`findTracks` 只按 mood/genre/id 过滤，而用户与配方说的是
   * "corporate-clean / sports-hype 那种风格"。这里直接在**全量曲库**上按风格关键词匹配
   * （id / style / genre / mood / tags / styleLabel 任一命中），再逐首过许可校验——
   * 不能只在前 20 条搜索结果里找风格（1034 首的库会漏）。找不到就如实报错，不静默换风格不符的曲目。
   */
  if (requestedStyle) {
    const library = loadAllLocalTracks(env);
    const matches = library.tracks
      .map((track) => ({
        track,
        haystack: [track.id, track.style, track.styleLabel, track.genre, track.mood,
          ...(Array.isArray(track.tags) ? track.tags : [])]
          .filter(Boolean).join(" ").toLowerCase(),
      }))
      .filter((entry) => entry.haystack.includes(requestedStyle));
    if (matches.length === 0) {
      throw new PostError(
        `曲库里没有「${variant.bgm.style}」风格的曲目：请换一个风格关键词（可用风格见 library/bgm-library-curated/tracks.json 的 style 字段）`,
        "not_found",
      );
    }
    /** 硬约束按"本地池优先 → 跨变体去重 → 时长富余"逐层放宽，任何放宽都写进 notes 留痕。 */
    const notes = [];
    const filmSeconds = Number(hints.filmSeconds);
    const excludeIds = new Set((hints.excludeIds ?? []).map((value) => String(value)));
    /**
     * 本地大库优先、随仓 50 首兜底（产品所有者口径 2026-10-11）是**硬层**而非加权项：
     * 同风格下只要有本地/客户池候选，就只在其中打分挑最佳；一条都没有才退随仓兜底池。
     * （评测环境把随仓曲库放在引擎路径监狱之外，选中它会直接 mix 失败——硬层同时保证可执行性。）
     */
    const localMatches = matches.filter((entry) => entry.track.libraryKind !== "local-curated");
    const basePool = localMatches.length > 0 ? localMatches : matches;
    if (localMatches.length === 0) notes.push("无本地大库候选：退随仓 50 首兜底池");
    const deduped = basePool.filter((entry) => !excludeIds.has(String(entry.track.id)));
    let pool = deduped.length > 0 ? deduped : basePool;
    if (deduped.length === 0) notes.push("同风格候选不足以覆盖全部变体：本变体放宽跨变体去重");
    const durationTiers = Number.isFinite(filmSeconds) && filmSeconds > 0 ? [filmSeconds + 15, filmSeconds + 5, 0] : [0];
    let durationPool = [];
    for (const [index, minSeconds] of durationTiers.entries()) {
      const filtered = pool.filter((entry) => Number(entry.track.durationSec ?? 0) >= minSeconds);
      if (filtered.length > 0) {
        durationPool = filtered;
        if (index > 0) notes.push(`时长≥成片+15s 的候选不足：本变体放宽到 ≥成片+${index === 1 ? 5 : 0}s`);
        break;
      }
    }
    const ranked = (durationPool.length > 0 ? durationPool : pool)
      .map((entry) => {
        const scored = scoreTrackForVariant(entry.track, variant, hints);
        return { track: entry.track, score: scored.score, reasons: scored.reasons };
      })
      .sort((a, b) => (b.score - a.score) || String(a.track.id).localeCompare(String(b.track.id)));
    const topN = Math.max(1, Math.min(10, Number(hints.topN) || 5));
    const candidates = ranked.slice(0, topN).map((entry) => ({
      id: entry.track.id,
      title: entry.track.title,
      bpm: entry.track.bpmMeasured ?? entry.track.bpm,
      energyBucket: entry.track.energyBucket ?? null,
      energyScore: entry.track.energyScore ?? null,
      durationSec: entry.track.durationSec ?? null,
      libraryKind: entry.track.libraryKind ?? null,
      file: entry.track.file ?? entry.track.localPath ?? null,
      score: entry.score,
      reasons: entry.reasons,
    }));
    for (const entry of ranked) {
      try {
        const verified = findTracks({ trackId: entry.track.id }, env);
        const hit = verified.track ?? verified.items[0];
        if (hit) return { picked: { ...hit, selectionScore: entry.score, selectionReasons: entry.reasons }, candidates, notes };
      } catch {
        /* 该曲目许可不合规/文件缺失：继续找同风格的下一首（不静默降级，最终全不过就报错） */
      }
    }
    throw new PostError(
      `风格「${variant.bgm.style}」下 ${matches.length} 首曲目都不满足许可/文件要求：请补曲库或换风格`,
      "license_blocked",
    );
  }
  const result = findTracks(query, env);
  if (!result.items?.length) {
    throw new PostError(
      `曲库中没有匹配变体「${variant.id}」的可用曲目（mood=${variant.bgm?.mood ?? "—"} / style=${variant.bgm?.style ?? "—"}）：`
      + `${result.note ?? "请先接入曲库"}`,
      "not_found",
    );
  }
  const styleHit = (item) => {
    if (!requestedStyle) return 1;
    const haystack = [item.id, item.genre, item.mood, ...(Array.isArray(item.tags) ? item.tags : [])]
      .filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(requestedStyle) ? 2 : 0;
  };
  const ranked = [...result.items]
    .map((item) => ({
      item,
      styleHit: styleHit(item),
    }))
    .sort((a, b) => (b.styleHit - a.styleHit) || String(a.item.id).localeCompare(String(b.item.id)));
  const usable = ranked.filter((entry) => entry.item.fileExists !== false && entry.item.path);
  if (requestedStyle && usable.every((entry) => entry.styleHit === 0)) {
    throw new PostError(
      `曲库里没有「${variant.bgm.style}」风格的可用曲目：请换一个风格关键词，或改用 mood/genre 检索`,
      "not_found",
    );
  }
  const chosen = usable[0]?.item;
  if (!chosen) {
    throw new PostError(`匹配到的曲目在工位上都不可用（文件缺失）：${result.items.map((item) => item.id).join(", ")}`, "not_found");
  }
  return {
    picked: chosen,
    candidates: usable.slice(0, 5).map((entry) => ({ id: entry.item.id, score: null, reasons: ["mood/genre 检索路径（无 style）"] })),
    notes: ["未提供 style：走 mood/genre 检索，不做打分排序"],
  };
}

/* ============================ 封面与文案 ============================ */

export function buildCopyPack({ project = {}, variant = {} }) {
  const base = project.copy ?? {};
  const tone = variant.copy ?? {};
  const titleTemplate = tone.titleTemplate ?? "{title}";
  const title = String(titleTemplate)
    .replaceAll("{title}", String(base.title ?? project.title ?? ""))
    .replaceAll("{hook}", String(base.hook ?? ""));
  const hook = String(base.hook ?? "");
  const body = [tone.opening, String(base.body ?? ""), tone.closing].filter(Boolean).join("\n\n");
  const hashtags = Array.isArray(tone.hashtags) && tone.hashtags.length ? tone.hashtags : (Array.isArray(base.hashtags) ? base.hashtags : []);
  const cta = tone.cta ?? base.cta ?? "";
  const checks = [
    { kind: "title_length", ok: title.length > 0 && title.length <= 55, detail: { length: title.length, limit: 55, basis: "抖音标题上限 55 字（含标点）" } },
    { kind: "hook_present", ok: hook.length > 0, detail: { length: hook.length } },
    { kind: "hashtags", ok: hashtags.length >= 3 && hashtags.length <= 8, detail: { count: hashtags.length, basis: "3–8 个，避免标签堆砌" } },
    { kind: "cta_present", ok: cta.length > 0, detail: { length: cta.length } },
  ];
  const markdown = [
    `# ${title}`,
    "",
    `- 风格变体：${variant.name ?? variant.id ?? "—"}`,
    `- 口吻：${tone.tone ?? "默认"}`,
    "",
    "## 开头钩子",
    hook || "—",
    "",
    "## 正文",
    body || "—",
    "",
    "## 话题标签",
    hashtags.join(" ") || "—",
    "",
    "## 行动号召",
    cta || "—",
    "",
    "## 交付校验",
    ...checks.map((check) => `- ${check.kind}: ${check.ok ? "ok" : "fail"} ${JSON.stringify(check.detail)}`),
    "",
  ].join("\n");
  return { title, hook, body, hashtags, cta, tone: tone.tone ?? null, checks, markdown };
}

/**
 * 封面：从已调色母版抽一帧 → 按平台版式渲标题（与字幕同源字体/字号体系）→ PNG。
 * 校验实际 PNG、请求尺寸、标题文本和已解析字体；版式建议保留在报告中。
 */
export async function buildCover({
  input, output, project = {}, variant = {}, resolution, platform = null,
  bins = resolveBinaries(), workDir, catalog = loadFontCatalog(),
}) {
  const probe = await probeMedia(input, { bins });
  const duration = probe.videoDuration ?? probe.duration;
  if (!(duration > 0)) throw new PostError("封面来源缺视频轨时长", "bad_media");
  const maxAt = Math.max(0, duration - 0.1);
  const requestedAt = round(Math.min(maxAt, Math.max(0, duration * optionalNumber(variant.cover?.at, 0.35))), 3);
  const dir = path.join(workDir, "cover");
  await fsp.mkdir(dir, { recursive: true });
  const at = requestedAt;
  const frame = await extractFrame({ input, at, output: path.join(dir, `${variant.id}-frame-0.png`), bins });
  const background = null;
  const titleLine = String(project.copy?.title ?? project.title ?? project.projectId ?? "");
  const hookLine = String(variant.cover?.subtitle ?? project.copy?.hook ?? "");
  const titleText = [titleLine, hookLine].filter(Boolean).join("\\N");
  const planOutcome = await planSubtitle({
    input: null,
    resolution,
    brief: { 平台: platform ?? project.platform ?? "默认", 内容调性: variant.copy?.tone ?? null },
    platform: platform ?? project.platform ?? null,
    titleText: titleLine,
    cues: [],
    scenes: ["标题"],
    catalog,
    bins,
    outputDir: dir,
    analyze: false,
  });
  const styles = planOutcome.styles.map((entry) => {
    if (entry.name !== "Title") return entry;
    const alignment = Number(variant.cover?.alignment ?? entry.style.alignment ?? 8);
    return {
      name: entry.name,
      style: {
        ...entry.style,
        alignment,
        marginV: Math.round((resolution?.[1] ?? 1920) * Number(variant.cover?.marginRatio ?? 0.08)),
      },
    };
  });
  const assText = buildAssDocument({
    resolution: resolution ?? [probe.width, probe.height],
    styles,
    events: [{
      layer: 0,
      start: srtSecondsToAss(0),
      end: srtSecondsToAss(3),
      style: "Title",
      name: variant.id,
      text: titleText || titleLine,
    }],
  });
  const assPath = path.join(dir, `${variant.id}-cover.ass`);
  await fsp.writeFile(assPath, assText, "utf8");
  const fontsDir = path.join(dir, "fonts-flat");
  await fsp.mkdir(fontsDir, { recursive: true });
  const fontFiles = [];
  const bundled = path.resolve(BUNDLE_ROOT, "library", "fonts");
  for (const sub of ["cn", "en"]) {
    const folder = path.join(bundled, sub);
    if (!fs.existsSync(folder)) continue;
    for (const file of await fsp.readdir(folder)) {
      if (!/\.(ttf|otf|ttc)$/i.test(file)) continue;
      const source = path.join(folder, file);
      const target = path.join(fontsDir, file);
      if (!fs.existsSync(target)) await fsp.copyFile(source, target);
      fontFiles.push(target);
    }
  }
  if (fontFiles.length === 0) throw new PostError(`封面渲染缺少字体（${bundled}）`, "font_not_found");
  const overlay = `ass=${assPath.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'")}:fontsdir=${fontsDir.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'")}`;
  await runBin(bins.ffmpeg, [
    "-hide_banner", "-v", "info", "-y", "-loop", "1", "-i", frame,
    "-vf", overlay, "-frames:v", "1", "-update", "1", output,
  ], { label: "ffmpeg(cover)", timeoutMs: 300_000 });
  if (!fs.existsSync(output)) throw new PostError(`封面未产出：${output}`, "ffmpeg_failed", true);
  const coverProbe = await probeMedia(output, { bins });
  const coverPlanChecks = planOutcome.checks.filter((check) => check.ok === false);
  const fontChecks = planOutcome.checks.filter((check) => check.kind === "font_resolution");
  const checks = [
    { kind: "cover_size", hard: true, ok: coverProbe.width === (resolution?.[0] ?? coverProbe.width) && coverProbe.height === (resolution?.[1] ?? coverProbe.height), detail: { width: coverProbe.width, height: coverProbe.height } },
    { kind: "cover_title_present", hard: true, ok: Boolean(titleText), detail: { text: titleText.replace("\\N", " / ") } },
    { kind: "cover_font_resolved", hard: true, ok: fontChecks.length > 0 && fontChecks.every((check) => check.ok === true), detail: fontChecks },
    { kind: "cover_layout", hard: false, ok: coverPlanChecks.length === 0, detail: coverPlanChecks.map((check) => check.kind) },
  ];
  return {
    output,
    at,
    requestedAt,
    background,
    frame,
    assPath,
    text: titleText.replace("\\N", " / "),
    fontsDir,
    width: coverProbe.width,
    height: coverProbe.height,
    sha256: await sha256File(output),
    bytes: (await fsp.stat(output)).size,
    checks,
  };
}

/* ============================ 交付包（主流程） ============================ */

/**
 * 封面两两差异（2026-10-11 客户反馈"几个版本的封面都还是用的同一个封面"）：
 * 缩到 64×36 灰度求平均绝对差（MAD）。identical（sha 相同）/ near-duplicate（<2）判硬失败，
 * similar（<6）在回执里提示——旧实现的 coverDivergence 是空数组，没有任何检查能拦住"两张一样的封面"。
 */
async function imageDivergence(a, b, bins) {
  const [hashA, hashB] = [await sha256File(a), await sha256File(b)];
  if (hashA === hashB) return { meanAbsDiff: 0, verdict: "identical" };
  const dir = await tempDir("workloom-cover-divergence-");
  const rawFile = path.join(dir, "diff.raw");
  await runBin(bins.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", a, "-i", b,
    "-lavfi", "[0:v]scale=64:36,format=gray[x];[1:v]scale=64:36,format=gray[y];[x][y]blend=all_mode=difference",
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", rawFile,
  ], { label: "ffmpeg(cover-divergence)" });
  const bytes = await fsp.readFile(rawFile);
  if (!bytes.length) return { meanAbsDiff: Number.NaN, verdict: "similar" };
  let total = 0;
  for (const value of bytes) total += value;
  const meanAbsDiff = round(total / bytes.length, 2);
  if (meanAbsDiff < 2) return { meanAbsDiff, verdict: "near-duplicate" };
  if (meanAbsDiff < 6) return { meanAbsDiff, verdict: "similar" };
  return { meanAbsDiff, verdict: "distinct" };
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return file;
}

async function assertStoredArtifact(file, expectedSha256, label) {
  if (!file || !/^[a-f0-9]{64}$/.test(expectedSha256 ?? "") || !fs.existsSync(file)) {
    throw new PostError(`${label} 缺文件或 SHA-256 回执，不能声明复用`, "verify_failed");
  }
  if (await sha256File(file) !== expectedSha256) {
    throw new PostError(`${label} 哈希与工程文件不一致，不能声明复用`, "verify_failed");
  }
}

/** BGM output authority is the actual processed file, never an audio-quality score. */
function assertBgmReportPassed(report) {
  const output = report?.output;
  if (!output?.path || !/^[a-f0-9]{64}$/.test(output.hash ?? "") || !output.audio || !(output.durationSeconds > 0)) {
    throw new PostError("配乐缺实际可读音轨、输出文件或 SHA-256 回执", "verify_failed");
  }
  try {
    const stat = fs.statSync(output.path);
    if (!stat.isFile() || !stat.size || createHash("sha256").update(fs.readFileSync(output.path)).digest("hex") !== output.hash) {
      throw new PostError("配乐产物字节与执行回执不一致", "verify_failed");
    }
  } catch (error) {
    if (error instanceof PostError) throw error;
    throw new PostError(`配乐产物无法读取：${error.message}`, "verify_failed");
  }
}

/** Source scope is the generation/script revision, not the local post-edit counter. */
function audioScope(project) {
  const scope = project.audioScope;
  if (!scope || scope.projectId !== (project.projectId ?? project.project_id)
    || (project.tenantId != null && project.tenantId !== scope.tenantId)
    || (project.workspaceId != null && project.workspaceId !== scope.workspaceId)) {
    throw new PostError("缺少与工程归属一致的 project.audioScope", "audio_stems_source_unverified");
  }
  return scope;
}
function stemReference(bundle, base = null) {
  if (!bundle) return null;
  return { dir: base ? path.relative(base, bundle.dir) : bundle.dir,
    manifestSha256: bundle.manifestSha256, recipeSha256: bundle.recipeSha256, scope: bundle.recipe.scope };
}
function restoreStemReference(reference, base) {
  return reference ? { ...reference, dir: resolveStored(base, reference.dir) } : null;
}
function descriptorsFromBundle(bundle) {
  const byShot = {};
  for (const source of bundle.sources) {
    const b = source.binding;
    (byShot[b.shotId] ??= {})[b.role] = b.status === "ready" ? {
      status: "ready", sourceKind: b.sourceKind, sha256: b.sourceSha256,
      path: path.join(bundle.dir, source.snapshot.path), receipt: source.receipt,
      offsetSec: b.offsetSamples / b.sampleRate, inSec: b.inSamples / b.sampleRate,
      ...(b.takeSamples === null ? {} : { durationSec: b.takeSamples / b.sampleRate }),
    } : { status: "not_applicable", reason: b.reason, receipt: source.receipt };
  }
  return byShot;
}
async function verifyStoredStems(reference, project, base, env, bins) {
  const restored = restoreStemReference(reference, base);
  if (!restored || audioStemDigest(restored.scope) !== audioStemDigest(audioScope(project))) {
    throw new PostError("独立音轨与当前工程作用域不一致", "audio_stems_source_unverified");
  }
  return verifyAudioStemBundle({ dir: restored.dir, expectedManifestSha256: restored.manifestSha256,
    expectedRecipeSha256: restored.recipeSha256, scope: audioScope(project),
    verifySource: createAudioStemReceiptVerifier({ env, expectedTenant: env.WORKLOOM_POST_BRIDGE_TENANT }), allowedRoots: allowedRoots(env), bins });
}
async function timelineStems({ project, clips, transitions, cuts = null, padToSeconds = null, workDir, env, bins }) {
  const shots = clips.map((clip) => ({ shotId: clip.shotId, videoSha256: clip.sourceHash,
    normalisedVideoSha256: clip.sha256, sourceDurationSec: clip.sourceDuration,
    durationSec: clip.duration, stems: clip.audioStems }));
  // Normalization is run from an owned original snapshot; hashes/durations here are measured, never caller assertions.
  for (const clip of clips) await assertStoredArtifact(clip.path, clip.sha256, `独立音轨画面 ${clip.shotId}`);
  return renderAudioStems({ scope: audioScope(project), shots, transitions, cuts, padToSeconds,
    outDir: path.join(workDir, "audio-stems", randomUUID()), allowedRoots: allowedRoots(env),
    verifySource: createAudioStemReceiptVerifier({ env, expectedTenant: env.WORKLOOM_POST_BRIDGE_TENANT }), bins });
}

/**
 * 转场回执 → 节目声逐刀口径（2026-10-13）。
 * 独立音轨时间线必须跟**画面实际渲染出来的每一刀**对齐：逐切计划里每刀时长不同、还可能有硬切，
 * 只按整段 fadeSec 折叠会让节目声与画面错位，`muxAudioProgram` 直接 fail-closed。
 */
function transitionCutsForStems(receipt = null) {
  const cuts = receipt?.cuts;
  if (!Array.isArray(cuts)) return [];
  return cuts.map((cut) => ({ toShotId: String(cut.toShotId ?? cut.incomingSegmentId ?? ""), durationSeconds: Number(cut.durationSeconds ?? 0) }));
}

function readTransitionCuts(receiptPath) {
  try {
    if (!receiptPath || !fs.existsSync(receiptPath)) return [];
    return transitionCutsForStems(JSON.parse(fs.readFileSync(receiptPath, "utf8")));
  } catch { return []; }
}
async function cleanProgramOutput({ gradedInput, stems, output, env, bins }) {
  if (!stems) {
    await fsp.mkdir(path.dirname(output), { recursive: true });
    const sourceHash = await sha256File(gradedInput);
    const result = await snapshotAudioStemArtifact({ file: gradedInput, sha256: sourceHash, output, allowedRoots: allowedRoots(env) });
    await probeMedia(result.path, { bins });
    return { ...result, embeddedAudioUsed: true, sourceAuthority: "original-media-bytes" };
  }
  const reauthorize = async () => {
    const verify = createAudioStemReceiptVerifier({ env, expectedTenant: env.WORKLOOM_POST_BRIDGE_TENANT });
    for (const { binding, bindingSha256, receipt, receiptSha256 } of stems.sources) {
      await verify({ binding, bindingSha256, receipt, receiptSha256 });
    }
  };
  await reauthorize();
  const result = await muxAudioProgram({ videoPath: gradedInput, videoSha256: await sha256File(gradedInput),
    programPath: stems.program.path, programSha256: stems.program.sha256, output,
    allowedRoots: allowedRoots(env), bins });
  try { await reauthorize(); }
  catch (error) { await fsp.unlink(output); throw error; }
  return result;
}

/** Mix the requested new music once, retaining original audio unless independent sources are explicitly supplied. */
/**
 * 配乐落位（2026-10-11 升级）：`cutTimes` 让节拍网格对齐真实切点（鼓点跟剪辑走），
 * `section` / `filmArc` 让选段对齐影片能量弧（情绪跟片子走）。
 * filmArc 按"画面内容哈希"缓存，避免每个变体重复分析同一条母版。
 */
const FILM_ARC_CACHE = new Map();
async function mixVariantAudio({ pack, gradedInput, workDir, output, bins, env, stems, cutTimes = null }) {
  if (pack.bgm?.enabled === false) {
    await cleanProgramOutput({ gradedInput, stems, output, env, bins });
    return { output, track: null, report: null, reused: false, failure: null, cacheKey: null };
  }
  const requestedLevel = optionalNumber(pack.bgm?.musicLevelDb, null);
  const sectionMode = String(pack.bgm?.section ?? "full");
  const pictureSha = await sha256File(gradedInput);
  let filmArc = null;
  if (sectionMode !== "full") {
    const cacheKey = `${pictureSha}:${sectionMode}`;
    if (FILM_ARC_CACHE.has(cacheKey)) {
      filmArc = FILM_ARC_CACHE.get(cacheKey);
    } else {
      try {
        filmArc = await bgmFilmEnergyArc({ input: gradedInput, bins });
        FILM_ARC_CACHE.set(cacheKey, filmArc);
      } catch {
        /** 弧线分析失败只降级为"按曲子结构选段"，不阻断交付；报告里如实不带 filmArc。 */
        filmArc = null;
      }
    }
  }
  const explicitSectionStart = optionalNumber(pack.bgm?.sectionStartSec, null);
  const explicitSectionEnd = optionalNumber(pack.bgm?.sectionEndSec, null);
  const track = pickTrackForVariant(pack, { env });
  const trackHash = await sha256File(track.path);
  const cacheKey = await contentKey({ picture: pictureSha,
    sourceManifest: stems?.manifestSha256 ?? null, sourceRecipe: stems?.recipeSha256 ?? null,
    trackSha256: trackHash, bgm: pack.bgm ?? null, v: 5 });
  const audioDir = path.join(workDir, "audio");
  await fsp.mkdir(audioDir, { recursive: true });
  const candidate = path.join(audioDir, `${pack.id}-${cacheKey}-${randomUUID()}.mp4`);
  const report = await bgmMix({ input: gradedInput, output: candidate, bgmPath: track.path,
    ...(stems ? { audioStems: stemReference(stems) } : {}), env, policy: pack.bgm?.policy ?? "keep-all", musicLevelDb: requestedLevel,
    targetLufs: optionalNumber(pack.bgm?.targetLufs, -14), fadeInSec: optionalNumber(pack.bgm?.fadeInSec, 1.2),
    fadeOutSec: optionalNumber(pack.bgm?.fadeOutSec, 1.6), section: sectionMode,
    ...(explicitSectionStart !== null && explicitSectionEnd !== null ? { sectionStartSec: explicitSectionStart, sectionEndSec: explicitSectionEnd } : {}),
    ...(Array.isArray(cutTimes) && cutTimes.length > 0 ? { cutTimes } : {}),
    ...(pack.bgm?.bpmStrategy ? { bpmStrategy: String(pack.bgm.bpmStrategy) } : {}),
    ...(filmArc ? { filmArc } : {}),
    bins });
  assertBgmReportPassed(report);
  const slimTrack = { id: track.id, title: track.title, artist: track.artist, mood: track.mood, genre: track.genre,
    license: track.license, licenseLabel: track.licenseLabel, bpm: track.bpm, attribution: track.attribution, sourceSha256: trackHash };
  const slimReport = { loudness: report.loudness, checks: report.checks, levels: report.levels,
    applicability: report.applicability, retainedTracks: report.retainedTracks, independentAudio: report.independentAudio,
    /** 配乐落位证据：选了哪一段（含理由）+ 节拍网格对齐到切点的误差（对齐失败也如实带 verdict）。 */
    section: report.section ?? null,
    alignment: report.alignment ?? null,
    output: { path: report.output.path, sha256: report.output.hash, duration: report.output.durationSeconds },
    mixing: { requestedMusicLevelDb: requestedLevel, appliedMusicLevelDb: report.mix.musicLevelDb, autoTrimDb: 0,
      note: "按请求执行混音；不评审源片音频品质，不自动重混" } };
  await snapshotAudioStemArtifact({ file: report.output.path, sha256: report.output.hash, output, allowedRoots: allowedRoots(env) });
  return { output, track: slimTrack, report: slimReport, reused: false, failure: null, cacheKey, mixing: slimReport.mixing };
}

function normalizePatchKeys(patch, allowed, label = "patch") {
  const unknown = Object.keys(patch ?? {}).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new PostError(
      `${label} 含未知键：${unknown.join(", ")}（允许：${allowed.join(", ")}）——未知指令不允许被静默忽略`,
      "bad_request",
    );
  }
}

/**
 * 第六风格轴（取景）：变体只能**调制**时间轴已声明的取景，不能凭空开启。
 * 允许的覆盖键（未知键在 findVariantPack 阶段无从校验，这里显式白名单）：
 *   · fill：填充策略（cover/blur/brand/pad）
 *   · scaleMultiplier：推近强度系数（0–2；1 = 与母版一致，0 = 取消推近，1.5 = 更猛）
 *   · easing：缓动曲线
 * 没有声明 reframe 的镜头一律保持 null —— 保证"未开启取景＝零行为变化"。
 */
export function mergeVariantReframe(clips = [], override = null) {
  if (!override || typeof override !== "object") return { applied: false, byShot: new Map() };
  const unknown = Object.keys(override).filter((key) => !["fill", "scaleMultiplier", "easing", "note"].includes(key));
  if (unknown.length) throw new PostError(`变体 reframe 含未知键：${unknown.join(", ")}（允许：fill, scaleMultiplier, easing, note）`, "bad_recipe");
  const multiplier = Number.isFinite(Number(override.scaleMultiplier)) ? Math.max(0, Math.min(2, Number(override.scaleMultiplier))) : 1;
  const byShot = new Map();
  let applied = false;
  for (const clip of clips) {
    const receipt = clip.reframe ?? null;
    if (!receipt) continue;
    const scale = {
      from: round4(1 + (Number(receipt.scale?.from ?? 1) - 1) * multiplier),
      to: round4(1 + (Number(receipt.scale?.to ?? 1) - 1) * multiplier),
    };
    byShot.set(String(clip.shotId), {
      mode: receipt.mode ?? "static",
      intent: receipt.intent ?? null,
      shotSize: null,
      scale,
      center: receipt.center ?? { from: { x: 0.5, y: 0.5 }, to: { x: 0.5, y: 0.5 } },
      anchor: receipt.anchor ?? "center",
      easing: REFRAME_EASINGS.includes(override.easing) ? override.easing : "smooth",
      fill: REFRAME_FILLS.includes(override.fill) ? override.fill : (receipt.fill ?? "pad"),
      maxZoomPolicy: "lossless",
      safeArea: "respect",
      note: typeof override.note === "string" ? override.note : "变体取景调制",
      legacyPunchIn: receipt.legacyPunchIn === true,
    });
    applied = true;
  }
  return { applied, byShot };
}

/**
 * 出交付包：一次跑完「母版 → 旁挂字幕 → N 个风格变体（封面/文案/BGM/调色/转场）→ 软字幕轨 → 清单」。
 *
 * 产物结构（示例）：
 *   <outDir>/
 *     master/master-clean.mp4            干净母版（无字幕、无变体调色；后续返修的地基）
 *     subtitles/<name>.zh.srt|.zh.ass|.en.srt|.vtt + subtitle-manifest.json
 *     variants/<id>/<id>.mp4            变体成片（无字幕轨）
 *     variants/<id>/<id>.softsub.mp4    同画面 + 可开关字幕轨（逐帧零改动复检）
 *     variants/<id>/cover.png           封面
 *     variants/<id>/copy.md|copy.json   文案包（标题/钩子/正文/话题/CTA + 校验）
 *     variants/<id>/audio.json          BGM 曲目、许可、电平与 LUFS 复检
 *     film-project.json                 工程文件（层结构 + 产物血缘；返修的输入）
 *     delivery-manifest.json            交付清单（全部产物 sha256 + 复检结论）
 *     delivery-report.md                人看的交付说明（含变体差异）
 */
export async function buildDeliveryPackage({
  project = {},
  shots = [],
  subtitles = null,
  variants = null,
  outDir,
  burnSubtitles = false,
  softSubtitles = true,
  /** 主轨切点（成片秒数，与时间轴一致）：传给配乐工位做节拍网格对齐（鼓点跟剪辑走） */
  cutTimes = null,
  bins = resolveBinaries(),
  reuse = true,
  env = process.env,
} = {}) {
  const projectId = text(project.projectId ?? project.project_id, "project.projectId");
  const hasIndependentAudio = explicitShotAudio(shots);
  if (hasIndependentAudio) audioScope(project);
  const target = assertPathAllowed(text(outDir, "outDir"), allowedRoots(env), "outDir");
  await fsp.mkdir(target, { recursive: true });
  const plan = await planDelivery({ project, shots, variants, bins });
  const packs = plan.variants.map((entry) => findVariantPack(entry.id));
  const [width, height] = plan.resolution;
  const quality = plan.quality;
  const existingManifestPath = path.join(target, "delivery-manifest.json");
  if (fs.existsSync(existingManifestPath)) {
    throw new PostError("交付目录已有完成工程，请走 reedit 创建新版本", "idempotency_conflict");
  }
  const fps = optionalNumber(project.fps, 30);
  const platform = project.platform ?? null;
  const workDir = path.join(target, "work");
  await fsp.mkdir(workDir, { recursive: true });

  /* ① 归一化（全部变体共用；按内容哈希缓存，返修时可复用） */
  const normalised = await normaliseShots({ shots, project, workDir, bins, reuse, env });
  const totalSeconds = normalised.reduce((sum, clip) => sum + Number(clip.duration), 0);
  if (quality === "uhd") await verifyUhdEvidence(normalised, [width, height], bins);
  /**
   * 转场口径基线（2026-10-11 起支持逐切计划）：
   *   · hard（默认）：全部硬切，样点级拼接；
   *   · fade（legacy）：逐段淡入淡出经黑场，仅为兼容保留；
   *   · xfade + perCut / plan：逐切专业转场（编辑层产出计划，引擎忠实渲染并机检）。
   * 旧实现只取 mode/fadeSec，会把逐切计划静默丢掉——这里整表透传，且由 `plannedTransitions` 标记。
   */
  const baseTransitions = {
    fadeSec: 0.5,
    ...(project.transitions ?? {}),
    mode: project.transitions?.mode ?? "hard",
  };
  const plannedTransitions = Boolean(baseTransitions.perCut || baseTransitions.plan);
  const masterAssembly = await assembleTimeline({
    clips: normalised,
    transitions: baseTransitions,
    output: path.join(workDir, "master-picture.mp4"),
    resolution: [width, height],
    fps,
    quality,
    bins,
  });
  /**
   * 母版节目声在**拼接之后**生成（2026-10-13 修复）：拿引擎回执里的逐刀实际时长对齐，
   * 而不是拿计划里的 fadeSec 猜——逐切计划/硬切混合时，后者必然错位并触发 fail-closed。
   */
  const masterTransitionCuts = transitionCutsForStems(masterAssembly.transitions?.receipt);
  /** 画面是逐帧量化的：用**母版实测时长**给节目轨补齐尾部静音，40ms 同步闸就不会被量化噪声打红。 */
  const masterPictureProbe = hasIndependentAudio ? await probeMedia(masterAssembly.output, { bins }) : null;
  const masterStems = hasIndependentAudio
    ? await timelineStems({ project, clips: normalised, transitions: baseTransitions, cuts: masterTransitionCuts,
      padToSeconds: masterPictureProbe?.videoDuration ?? masterPictureProbe?.duration ?? null, workDir, env, bins })
    : null;
  const cleanMaster = path.join(target, "master", "master-clean.mp4");
  await cleanProgramOutput({ gradedInput: masterAssembly.output, stems: masterStems, output: cleanMaster, env, bins });
  masterAssembly.output = cleanMaster;
  const masterProbe = await probeMedia(masterAssembly.output, { bins });
  if (masterProbe.width !== width || masterProbe.height !== height
      || Math.abs((masterProbe.fps ?? 0) - fps) > 0.01) {
    throw new PostError(`干净母版规格不符：实测 ${masterProbe.width}×${masterProbe.height}/${masterProbe.fps}fps，目标 ${width}×${height}/${fps}fps`, "verify_failed");
  }

  /* ② 旁挂字幕（一次生成，全部变体共用同一份文字层；母版不烧字） */
  let sidecar = null;
  if (subtitles?.zhPath || subtitles?.zhCues || subtitles?.zhText) {
    const { parseSrt } = await import("../subtitle-bridge/core.mjs");
    const zhText = subtitles.zhText ?? (subtitles.zhPath ? await fsp.readFile(subtitles.zhPath, "utf8") : null);
    if (!zhText) throw new PostError("subtitles.zhText / zhPath 缺失（旁挂字幕需要内容）", "bad_request");
    const enText = subtitles.enText ?? (subtitles.enPath ? await fsp.readFile(subtitles.enPath, "utf8") : null);
    sidecar = await exportSidecars({
      input: masterAssembly.output,
      outputDir: path.join(target, "subtitles"),
      name: projectId,
      cues: parseSrt(zhText),
      cuesEn: enText ? parseSrt(enText) : [],
      platform,
      brief: { 平台: platform ?? "默认", 内容调性: project.copy?.tone ?? null },
      fontsDir: null,
      bins,
    });
  }

  /* ③ 逐变体：拼接 → 调色 → 音频 → 封面 → 文案 →（可选）软字幕轨 / 硬字幕 */
  const variantsOut = [];
  const audioFailures = [];
  for (const pack of packs) {
    const variantDir = path.join(target, "variants", pack.id);
    await fsp.mkdir(variantDir, { recursive: true });
    /**
     * 变体转场口径：有逐切计划时，变体只允许用 `intentMap` / `scale` 覆盖**观感**，
     * 不能用旧 `mode/fadeSec` 把计划降级回"整条链一种转场"（那是静默丢弃编辑声明）。
     */
    const packTransitions = pack.transitions ?? {};
    const transitions = plannedTransitions
      ? { ...baseTransitions, intentMap: packTransitions.intentMap ?? null, scale: packTransitions.scale ?? 1, styleId: pack.id }
      : { ...baseTransitions, ...packTransitions, styleId: pack.id };
    /**
     * 第六风格轴（取景）：变体只调制已声明的取景；没有声明则一律沿用母版镜头（零行为变化）。
     * 调制后的镜头走**独立的归一化目录**（按 reframe 内容哈希缓存），不会污染母版缓存。
     */
    const variantReframe = mergeVariantReframe(normalised, pack.reframe ?? null);
    const variantClips = variantReframe.applied
      ? await normaliseShots({
        shots: shots.map((shot) => ({
          ...shot,
          reframe: variantReframe.byShot.get(String(shot.shotId ?? shot.shot_id ?? path.basename(String(shot.path)))) ?? null,
        })),
        project,
        workDir: path.join(workDir, `norm-${pack.id}`),
        bins,
        reuse,
        env,
      })
      : normalised;
    const assemblyKey = await contentKey({
      shots: variantClips.map((clip) => clip.sha256), transitions, v: 3,
    });
    const assemblyPath = path.join(workDir, "assemble", `${pack.id}-${assemblyKey}.mp4`);
    const assemblyHash = await contentKey({ key: assemblyKey, type: "assembly" });
    const assemblyMetaPath = path.join(workDir, "assemble", `${pack.id}-${assemblyKey}.json`);
    let assembly = null;
    if (reuse && fs.existsSync(assemblyPath) && fs.existsSync(assemblyMetaPath)) {
      let meta;
      try { meta = JSON.parse(await fsp.readFile(assemblyMetaPath, "utf8")); }
      catch (error) {
        throw new PostError(`拼接缓存回执不可读：${error instanceof Error ? error.message : String(error)}`, "verify_failed");
      }
      await assertStoredArtifact(assemblyPath, meta.sha256, `变体 ${pack.id} 拼接缓存`);
      const cachedProbe = await probeMedia(assemblyPath, { bins });
      if (meta.key !== assemblyHash || cachedProbe.width !== width || cachedProbe.height !== height || !cachedProbe.hasAudio) {
        throw new PostError(`变体 ${pack.id} 拼接缓存规格或回执不一致`, "verify_failed");
      }
      assembly = { ...meta, output: assemblyPath, durationSeconds: cachedProbe.videoDuration ?? cachedProbe.duration, reused: true };
    } else {
      const assembled = await assembleTimeline({
        clips: variantClips, transitions, output: assemblyPath, resolution: [width, height], fps, quality, bins,
      });
      const assembledProbe = await probeMedia(assemblyPath, { bins });
      if (assembledProbe.width !== width || assembledProbe.height !== height || !assembledProbe.hasAudio) {
        throw new PostError(`变体 ${pack.id} 拼接产物规格不符`, "verify_failed");
      }
      assembly = {
        output: assemblyPath,
        durationSeconds: assembledProbe.videoDuration ?? assembledProbe.duration,
        mode: transitions.mode,
        fadeSec: transitions.fadeSec ?? 0,
        shots: normalised.length,
        reused: false,
        key: assemblyHash,
        sha256: await sha256File(assemblyPath),
        transitions: assembled.transitions ?? null,
      };
      await writeJson(assemblyMetaPath, assembly);
    }

    // 调色（color-bridge，按请求加工，不做源片质量比较）
    const lutPath = pack.color?.lut ? resolveLut(pack.color.lut) : null;
    const colorKey = await contentKey({
      assemblySha256: assembly.sha256,
      profile: pack.color?.profile ?? null,
      lutSha256: lutPath ? await sha256File(lutPath) : null,
      intensity: pack.color?.intensity ?? 0.8,
      quality,
      v: 2,
    });
    const gradedPath = path.join(workDir, "graded", `${pack.id}-${colorKey}.mp4`);
    const gradedMetaPath = `${gradedPath}.json`;
    let gradeReport = null;
    if (pack.color) {
      if (reuse && fs.existsSync(gradedPath) && fs.existsSync(gradedMetaPath)) {
        let meta;
        try { meta = JSON.parse(await fsp.readFile(gradedMetaPath, "utf8")); }
        catch (error) {
          throw new PostError(`调色缓存回执不可读：${error instanceof Error ? error.message : String(error)}`, "verify_failed");
        }
        await assertStoredArtifact(gradedPath, meta.sha256, `变体 ${pack.id} 调色缓存`);
        const cachedProbe = await probeMedia(gradedPath, { bins });
        if (meta.key !== colorKey || meta.inputSha256 !== assembly.sha256
            || cachedProbe.width !== width || cachedProbe.height !== height || !cachedProbe.hasAudio) {
          throw new PostError(`变体 ${pack.id} 调色缓存规格或回执不一致`, "verify_failed");
        }
        gradeReport = { output: gradedPath, sha256: meta.sha256, reused: true, profile: pack.color.profile ?? null, lut: pack.color.lut ?? null, intensity: pack.color.intensity ?? 0.8 };
      } else {
        gradeReport = await colorGrade({
          input: assemblyPath,
          output: gradedPath,
          profile: pack.color.profile ?? null,
          lutPath,
          intensity: optionalNumber(pack.color.intensity, 0.8),
          quality,
          bins,
        });
        const gradedProbe = await probeMedia(gradedPath, { bins });
        if (gradedProbe.width !== width || gradedProbe.height !== height || !gradedProbe.hasAudio) {
          throw new PostError(`变体 ${pack.id} 调色产物规格不符`, "verify_failed");
        }
        gradeReport = { ...gradeReport, sha256: await sha256File(gradedPath), reused: false };
        await writeJson(gradedMetaPath, { key: colorKey, inputSha256: assembly.sha256, sha256: gradeReport.sha256 });
      }
    }
    const gradedInput = gradeReport?.output ?? assemblyPath;

    // 音频层（BGM 选曲 + 混音；按内容哈希缓存，返修时可直接复用）
    const scoredPath = path.join(variantDir, `${pack.id}.mp4`);
    const variantTransitionCuts = transitionCutsForStems(assembly.transitions?.receipt);
    /** 变体画面（已调色/待配音）的实测时长 = 节目声要补齐到的总长。 */
    const variantPictureProbe = hasIndependentAudio ? await probeMedia(gradedInput, { bins }) : null;
    const stems = !hasIndependentAudio ? null
      : audioStemDigest({ transitions, cuts: variantTransitionCuts }) === audioStemDigest({ transitions: baseTransitions, cuts: masterTransitionCuts }) ? masterStems
      // 合并口径（T-2026-1011-0007 × T-2026-1011-0008）：独立音轨按「本变体实际时间轴」（含
      // reframe 后的 variantClips）生成，同时保留本分支的 cutTimes —— 配乐节拍网格对齐真实切点。
      : await timelineStems({ project, clips: variantClips, transitions, cuts: variantTransitionCuts,
        padToSeconds: variantPictureProbe?.videoDuration ?? variantPictureProbe?.duration ?? null, workDir, env, bins });
    const audioOutcome = await mixVariantAudio({ pack, gradedInput, workDir, output: scoredPath, bins, env, stems, cutTimes });
    const audioReport = audioOutcome.report;
    const track = audioOutcome.track;
    const audioFailure = audioOutcome.failure;
    if (audioFailure) audioFailures.push(audioFailure);
    await writeJson(path.join(variantDir, "audio.json"), audioFailure
      ? {
        track: null,
        failed: true,
        code: audioFailure.code,
        message: audioFailure.message,
        note: "配乐工位复检未通过：本变体按原声降级交付（不冒充带配乐成片）",
      }
      : audioReport
        ? {
          track,
          policy: pack.bgm?.policy ?? "keep-dialogue",
          musicLevelDb: pack.bgm?.musicLevelDb ?? null,
          mixing: audioReport.mixing ?? null,
          loudness: audioReport.loudness,
          checks: audioReport.checks,
          levels: audioReport.levels,
          applicability: audioReport.applicability,
          retainedTracks: audioReport.retainedTracks,
          independentAudio: audioReport.independentAudio,
          /** 配乐落位证据（选段理由 + 节拍对齐误差）：让"配乐跟情绪/鼓点走"可复核。 */
          section: audioReport.section ?? null,
          alignment: audioReport.alignment ?? null,
          output: { path: scoredPath, sha256: await sha256File(scoredPath), duration: (await probeMedia(scoredPath, { bins })).duration },
          ...(audioOutcome.reused ? { reused: true, cacheKey: audioOutcome.cacheKey } : {}),
        }
        : { track: null, policy: "原声（变体刻意不配乐）", note: pack.bgm?.note ?? null });
    const scoredProbe = await probeMedia(scoredPath, { bins });
    if (scoredProbe.width !== width || scoredProbe.height !== height
        || Math.abs((scoredProbe.fps ?? 0) - fps) > 0.01) {
      throw new PostError(`变体 ${pack.id} 规格不符：实测 ${scoredProbe.width}×${scoredProbe.height}/${scoredProbe.fps}fps，目标 ${width}×${height}/${fps}fps`, "verify_failed");
    }

    // 封面 + 文案
    const cover = await buildCover({
      input: gradedInput,
      output: path.join(variantDir, "cover.png"),
      project, variant: pack, resolution: [width, height], platform, bins, workDir,
    });
    const copy = buildCopyPack({ project, variant: pack });
    await fsp.writeFile(path.join(variantDir, "copy.md"), copy.markdown, "utf8");
    await writeJson(path.join(variantDir, "copy.json"), {
      title: copy.title, hook: copy.hook, body: copy.body, hashtags: copy.hashtags, cta: copy.cta,
      tone: copy.tone, checks: copy.checks,
    });

    // 软字幕轨（画面逐帧零改动）与可选硬字幕
    let softsub = null;
    let burned = null;
    if (softSubtitles && sidecar) {
      const softTarget = path.join(variantDir, `${pack.id}.softsub.mp4`);
      /**
       * 每种语言只挂一条字幕轨：mp4/mov 用 mov_text 承载，ASS 样式本来就会被压掉，
       * 因此优先取该语言的 SRT（同一份文字层的纯文本形态）；mkv 才优先 ASS（保样式）。
       * 早先"过滤出全部 srt/ass"会让纯中文片挂出两条 chi 轨（一条 srt + 一条 ass），
       * 播放器里出现两个同语言菜单项——这是用户能直接看见的交付缺陷。
       */
      const byLang = new Map();
      for (const file of sidecar.files) {
        if (file.role !== "subtitle") continue;
        if (!["srt", "ass"].includes(file.format)) continue;
        const lang = file.lang === "eng" ? "eng" : "chi";
        const preferAss = path.extname(softTarget).toLowerCase() === ".mkv";
        const current = byLang.get(lang);
        const better = !current
          || (file.format === (preferAss ? "ass" : "srt") && current.format !== (preferAss ? "ass" : "srt"));
        if (better) byLang.set(lang, file);
      }
      const tracks = [...byLang.entries()].map(([lang, file], index) => ({
        path: file.path,
        lang,
        title: lang === "eng" ? "English" : "中文",
        default: index === 0,
      }));
      softsub = await softMux({ input: scoredPath, output: softTarget, subtitles: tracks, bins });
    }
    if (burnSubtitles && sidecar) {
      const { renderWithSubtitles, parseSrt } = await import("../subtitle-bridge/core.mjs");
      const zh = sidecar.files.find((file) => file.format === "srt" && file.lang === "chi");
      const cues = parseSrt(await fsp.readFile(zh.path, "utf8"));
      burned = await renderWithSubtitles({
        mode: "subtitle",
        input: scoredPath,
        output: path.join(variantDir, `${pack.id}.burned.mp4`),
        cues,
        platform,
        brief: { 平台: platform ?? "默认" },
        bins,
      });
    }

    variantsOut.push({
      id: pack.id,
      name: pack.name,
      positioning: pack.positioning,
      dir: variantDir,
      transitions: assembly.transitions ?? null,
      reframe: variantReframe.applied ? { applied: true, override: pack.reframe ?? null } : null,
      artifacts: {
        video: { path: scoredPath, sha256: await sha256File(scoredPath), duration: scoredProbe.duration, resolution: [scoredProbe.width, scoredProbe.height] },
        softsub: softsub ? { path: softsub.output, sha256: softsub.sha256, tracks: softsub.tracks, checks: softsub.checks } : null,
        burned: burned ? { path: burned.output.path, sha256: burned.output.hash, checks: burned.checks } : null,
        cover: { path: cover.output, sha256: cover.sha256, at: cover.at, requestedAt: cover.requestedAt, background: cover.background, text: cover.text, checks: cover.checks },
        copy: { path: path.join(variantDir, "copy.md"), checks: copy.checks, title: copy.title, hashtags: copy.hashtags },
        audioReceipt: { path: path.join(variantDir, "audio.json"), sha256: await sha256File(path.join(variantDir, "audio.json")) },
        audio: audioReport
          ? {
            path: path.join(variantDir, "audio.json"),
            trackId: track.id,
            trackTitle: track.title,
            attribution: track.attribution,
            policy: pack.bgm?.policy ?? "keep-dialogue",
            mixing: audioReport.mixing ?? null,
            loudness: audioReport.loudness,
            checks: audioReport.checks,
          }
          : (audioFailure
            ? { path: path.join(variantDir, "audio.json"), failed: true, code: audioFailure.code, message: audioFailure.message, trackId: null, trackTitle: null }
            : null),
      },
      style: {
        color: pack.color ?? null,
        bgm: pack.bgm ?? null,
        transitions,
        cover: pack.cover ?? null,
        copyTone: pack.copy?.tone ?? null,
      },
      layers: {
        audioStems: stemReference(stems),
        assembly: {
          path: assemblyPath,
          key: assemblyKey,
          sha256: assembly.sha256,
          durationSeconds: assembly.durationSeconds,
          reused: assembly.reused === true,
          mode: transitions.mode,
          transitionReceipt: assembly.transitions?.receiptPath ?? null,
          transitionCount: assembly.transitions?.cutCount ?? 0,
        },
        color: gradeReport ? { path: gradeReport.output, sha256: gradeReport.sha256, reused: gradeReport.reused === true, profile: gradeReport.profile ?? null, lut: gradeReport.lut ?? null, intensity: gradeReport.intensity ?? null, visibility: gradeReport.visibility ?? null } : null,
      },
    });
  }

  // Requested variant settings are recorded; source pictures/audio are not rescored against one another.
  const divergence = [];
  const coverDivergence = [];
  /** 变体封面两两差异化（硬门）：identical / near-duplicate 直接判失败，防止"几个版本同一个封面"回归。 */
  for (let i = 0; i < variantsOut.length; i += 1) {
    for (let j = i + 1; j < variantsOut.length; j += 1) {
      const a = variantsOut[i];
      const b = variantsOut[j];
      const diff = await imageDivergence(a.artifacts.cover.path, b.artifacts.cover.path, bins);
      coverDivergence.push({ a: a.id, b: b.id, diff });
    }
  }
  const duplicateCoverPairs = coverDivergence.filter((row) => row.diff.verdict === "identical" || row.diff.verdict === "near-duplicate");
  /**
   * 转场回执汇总（母版 + 每个变体）：同一批镜头、不同风格转场，各留各的回执。
   * 硬失败（黑屏 / 缺转场窗口 / 时长不符）在 assembleTimeline 内已抛出；这里只做交付面归档与状态汇总。
   */
  const transitionScopes = [
    { scope: "master", receipt: masterAssembly.transitions?.receipt ?? null, receiptPath: masterAssembly.transitions?.receiptPath ?? null },
    ...variantsOut.map((variant) => ({
      scope: variant.id,
      receipt: variant.transitions?.receipt ?? null,
      receiptPath: variant.transitions?.receiptPath ?? null,
    })),
  ];
  const transitionSummaryPath = path.join(target, "transitions", "transition-receipt.json");
  await fsp.mkdir(path.dirname(transitionSummaryPath), { recursive: true });
  await writeJson(transitionSummaryPath, {
    schemaVersion: "workloom.transition-summary/v1",
    generatedAt: new Date().toISOString(),
    mode: baseTransitions.mode,
    planned: plannedTransitions,
    catalog: "bundles/ai-video/library/transitions/catalog.json",
    scopes: transitionScopes.map((entry) => ({
      scope: entry.scope,
      receiptPath: entry.receiptPath ? path.relative(target, entry.receiptPath) : null,
      mode: entry.receipt?.mode ?? null,
      transitionCount: entry.receipt?.transitionCount ?? 0,
      hardCutCount: entry.receipt?.hardCutCount ?? null,
      types: [...new Set((entry.receipt?.cuts ?? []).map((cut) => cut.type))],
      totalTransitionSeconds: entry.receipt?.totalTransitionSeconds ?? 0,
      checks: (entry.receipt?.checks ?? []).map((check) => ({ kind: check.kind, ok: check.ok, hard: check.hard !== false })),
    })),
  });

  /**
   * 取景回执汇总（母版 + 每个变体；逐镜回执在各归一化产物旁 `<clip>.json#reframe`）。
   * 与转场回执同口径：事实类硬项（预算/时长/黑边）在 normaliseShots 内已 fail-closed，
   * 这里只做交付面归档与状态汇总。
   */
  const reframeClips = normalised.filter((clip) => clip.reframe);
  const reframeSummaryPath = path.join(target, "reframe", "reframe-receipt.json");
  await fsp.mkdir(path.dirname(reframeSummaryPath), { recursive: true });
  await writeJson(reframeSummaryPath, {
    schemaVersion: "workloom.reframe-summary/v1",
    generatedAt: new Date().toISOString(),
    planned: reframeClips.length > 0,
    shots: normalised.map((clip) => (clip.reframe
      ? {
        shotId: clip.shotId,
        mode: clip.reframe.mode ?? null,
        intent: clip.reframe.intent ?? null,
        fill: clip.reframe.fill ?? null,
        legacyPunchIn: clip.reframe.legacyPunchIn === true,
        scale: clip.reframe.scale ?? null,
        center: clip.reframe.center ?? null,
        source: clip.reframe.source ?? null,
        canvas: clip.reframe.canvas ?? null,
        budget: clip.reframe.budget ?? null,
        chainMode: clip.reframe.chainMode ?? null,
        passed: clip.reframe.passed !== false,
        receiptPath: clip.reframe.receiptPath ? path.relative(target, clip.reframe.receiptPath) : null,
      }
      : null)).filter(Boolean),
    variants: variantsOut.map((variant) => ({ id: variant.id, reframe: variant.reframe ?? null })),
  });

  const packageChecks = [
    { kind: "audio_sources", ok: true, detail: { sourceScope: hasIndependentAudio ? audioScope(project) : null,
      embeddedAudioUsed: !hasIndependentAudio && normalised.some((clip) => clip.sourceHasAudio),
      silenceInsertedForSources: !hasIndependentAudio ? normalised.filter((clip) => !clip.sourceHasAudio).map((clip) => clip.shotId) : [],
      storedMusicExcluded: hasIndependentAudio, qualityReviewed: false } },
    {
      kind: "resolution_exact",
      ok: masterProbe.width === width && masterProbe.height === height
        && variantsOut.every((variant) => variant.artifacts.video.resolution[0] === width && variant.artifacts.video.resolution[1] === height),
      detail: { requested: [width, height], master: [masterProbe.width, masterProbe.height], variants: variantsOut.map((variant) => ({ id: variant.id, resolution: variant.artifacts.video.resolution })) },
    },
    {
      kind: "enhancement_provenance",
      ok: quality !== "uhd" || normalised.every((clip) => clip.enhancement?.status === "not-requested"
        || clip.enhancement?.status === "source-sufficient"
        || (clip.enhancement?.status === "enhanced" && clip.enhancement.processingMode === "ai-upscale"
          && clip.enhancement.receipt?.localVerified === true && clip.enhancement.sha256
          && clip.enhancement.engineSha256 && clip.enhancement.provenancePath)),
      detail: { quality, shots: normalised.map((clip) => ({ shotId: clip.shotId, status: clip.enhancement?.status ?? "not-requested", sha256: clip.enhancement?.sha256 ?? null, provenancePath: clip.enhancement?.provenancePath ?? null })) },
    },
    { kind: "master_no_burn_in", ok: Boolean(masterAssembly.output), detail: { note: "干净母版不含任何烧录字幕；字幕只以旁挂文件 + 可开关字幕轨交付", subtitles: sidecar ? sidecar.files.length : 0 } },
    { kind: "sidecar_files", ok: sidecar ? sidecar.passed : true, detail: sidecar ? { files: sidecar.files.map((file) => path.basename(file.path)), timeline: sidecar.manifest.timeline } : { note: "本次未提供字幕，跳过旁挂交付" } },
    { kind: "variant_count", ok: variantsOut.length >= 2, detail: { variants: variantsOut.map((variant) => variant.id) } },
    {
      kind: "reframe_receipts",
      // 事实类硬项：逐镜取景回执的硬检查（预算/时长/黑边）必须全过；未声明取景时本项恒真。
      ok: normalised.every((clip) => !clip.reframe || clip.reframe.passed !== false),
      detail: {
        planned: normalised.filter((clip) => clip.reframe).length,
        shots: normalised.map((clip) => (clip.reframe
          ? {
            shotId: clip.shotId,
            fill: clip.reframe.fill ?? null,
            mode: clip.reframe.mode ?? null,
            legacyPunchIn: clip.reframe.legacyPunchIn === true,
            scale: clip.reframe.scale ?? null,
            effectiveUpscale: clip.reframe.budget?.effectiveUpscale ?? null,
            receiptPath: clip.reframe.receiptPath ? path.relative(target, clip.reframe.receiptPath) : null,
          }
          : null)).filter(Boolean),
      },
    },
    {
      kind: "covers_valid",
      ok: variantsOut.every((variant) => variant.artifacts.cover.checks.filter((check) => check.hard !== false).every((check) => check.ok === true)),
      detail: variantsOut.map((variant) => ({ id: variant.id, checks: variant.artifacts.cover.checks })),
    },
    {
      kind: "covers_distinct",
      ok: duplicateCoverPairs.length === 0,
      detail: {
        basis: "变体封面两两 64×36 灰度平均绝对差（MAD）；identical/near-duplicate(<2) 判失败，similar(<6) 提示",
        pairs: coverDivergence.map((row) => ({ a: row.a, b: row.b, meanAbsDiff: row.diff.meanAbsDiff, verdict: row.diff.verdict })),
        duplicates: duplicateCoverPairs.map((row) => ({ a: row.a, b: row.b, meanAbsDiff: row.diff.meanAbsDiff, verdict: row.diff.verdict })),
      },
    },
    { kind: "bgm_layer", ok: audioFailures.length === 0, detail: { failed: audioFailures, note: "失败的变体已按原声降级交付，不冒充带配乐成片" } },
    { kind: "softsub_video_unchanged", ok: variantsOut.every((variant) => !variant.artifacts.softsub || variant.artifacts.softsub.checks.every((check) => check.ok === true)), detail: variantsOut.filter((variant) => variant.artifacts.softsub).map((variant) => ({ id: variant.id, checks: variant.artifacts.softsub.checks.map((check) => check.kind) })) },
    {
      kind: "transition_receipts",
      // 事实类硬项：每个 scope 的转场回执里，硬检查（转场窗口存在 / 非黑场类不得出现黑帧 / 时长符合计划）必须全过。
      ok: transitionScopes.every((entry) => (entry.receipt?.checks ?? []).every((check) => check.hard !== true || check.ok === true)),
      detail: transitionScopes.map((entry) => ({
        scope: entry.scope,
        mode: entry.receipt?.mode ?? null,
        transitionCount: entry.receipt?.transitionCount ?? 0,
        hardCutCount: entry.receipt?.hardCutCount ?? null,
        types: [...new Set((entry.receipt?.cuts ?? []).map((cut) => cut.type))],
        receipt: entry.receiptPath ? path.relative(target, entry.receiptPath) : null,
        notes: entry.receipt?.notes ?? [],
      })),
    },
{
kind: "duration_consistent",
      // 每个变体都由完整归一化源时间轴独立装配；母版可能已做 xfade，不能再从它扣重叠。
      // 后续调色/配乐以该变体实际装配的视频轨时长为基准，保留真实加工时长检查。
      ok: variantsOut.every((variant) => {
        const expected = variant.layers.assembly.durationSeconds;
        return Number.isFinite(expected) && expected > 0
          && Math.abs((variant.artifacts.video.duration ?? 0) - expected) <= 0.4;
      }),
      detail: {
        master: masterProbe.duration,
        sourceTimelineSeconds: totalSeconds,
        variants: variantsOut.map((variant) => {
          const transitions = variant.style.transitions ?? {};
          return {
            id: variant.id,
            duration: variant.artifacts.video.duration,
            expected: round(variant.layers.assembly.durationSeconds, 3),
            transitions: `${transitions.mode}${transitions.fadeSec ? ` ${transitions.fadeSec}s` : ""}`,
          };
        }),
},
},
{ kind: "planned_duration_reference", ok: true,
  detail: { plannedSeconds: project.targetDurationSec ?? project.target_duration_sec ?? project.briefDurationSec ?? null,
    actualSourceSeconds: totalSeconds, basis: "planning-reference-only", qualityReviewed: false } },
  ];
  if (quality === "uhd") {
    const failedUhdChecks = packageChecks.filter((check) =>
      ["resolution_exact", "enhancement_provenance"].includes(check.kind) && check.ok !== true);
    if (failedUhdChecks.length > 0) {
      throw new PostError(`UHD 交付硬闸未通过：${failedUhdChecks.map((check) => check.kind).join("、")}`, "verify_failed");
    }
  }

  /* ⑤ 工程文件 + 交付清单（返修的输入；也是"哪些层可复用"的事实源） */
  const packageKey = await contentKey({
    projectId,
    shots: normalised.map((clip) => clip.sha256),
    variants: variantsOut.map((variant) => ({ id: variant.id, video: variant.artifacts.video.sha256 })),
  });
  const filmProject = {
    schemaVersion: FILM_PROJECT_SCHEMA,
    projectId,
    audioScope: hasIndependentAudio ? audioScope(project) : null,
    version: 1,
    deliveryRoot: ".",
    createdAt: new Date().toISOString(),
    title: project.title ?? projectId,
    platform,
    quality,
    resolution: [width, height],
    fps,
    layers: {
      audioStems: stemReference(masterStems, target),
      shots: normalised.map((clip) => ({
        shotId: clip.shotId, source: clip.source, normalised: path.relative(target, clip.path),
        sha256: clip.sha256, sourceSha256: clip.sourceHash, duration: clip.duration, sourceDuration: clip.sourceDuration,
        sourceHasAudio: clip.sourceHasAudio,
        kind: clip.sourceKind,
        enhancement: clip.enhancement ? {
          ...clip.enhancement,
          output: clip.enhancement.output ? path.relative(target, clip.enhancement.output) : null,
          provenancePath: clip.enhancement.provenancePath ? path.relative(target, clip.enhancement.provenancePath) : null,
        } : null,
      })),
      transitions: baseTransitions,
      text: sidecar ? {
        sidecarDir: path.relative(target, path.dirname(sidecar.files[0].path)),
        files: sidecar.files.map((file) => ({ role: file.role, lang: file.lang, format: file.format, path: path.relative(target, file.path), sha256: file.sha256 })),
        burnedInMaster: false,
      } : null,
      variants: variantsOut.map((variant) => ({
        id: variant.id,
        style: variant.style,
        audioStems: variant.layers.audioStems ? { ...variant.layers.audioStems, dir: path.relative(target, variant.layers.audioStems.dir) } : null,
        // 工程文件里的路径一律**相对交付根**（交付包可整体搬走；返修时再按根解析回来）
        color: variant.layers.color
          ? { ...variant.layers.color, path: path.relative(target, variant.layers.color.path) }
          : null,
        assembly: {
          ...variant.layers.assembly,
          path: path.relative(target, variant.layers.assembly.path),
          // 工程文件里的路径一律相对交付根；转场回执同样如此（返修时按根解析回来）
          transitionReceipt: variant.layers.assembly.transitionReceipt
            ? path.relative(target, variant.layers.assembly.transitionReceipt)
            : null,
        },
        bgm: variant.artifacts.audio ? { trackId: variant.artifacts.audio.trackId, policy: variant.artifacts.audio.policy } : null,
        artifacts: {
          audio: { ...variant.artifacts.audioReceipt, path: path.relative(target, variant.artifacts.audioReceipt.path) },
          video: { path: path.relative(target, variant.artifacts.video.path), sha256: variant.artifacts.video.sha256 },
          softsub: variant.artifacts.softsub ? { path: path.relative(target, variant.artifacts.softsub.path), sha256: variant.artifacts.softsub.sha256 } : null,
          cover: {
            path: path.relative(target, variant.artifacts.cover.path),
            sha256: variant.artifacts.cover.sha256,
            at: variant.artifacts.cover.at,
            requestedAt: variant.artifacts.cover.requestedAt,
          },
          copy: { path: path.relative(target, variant.artifacts.copy.path) },
        },
      })),
      copy: project.copy ?? null,
    },
    cache: { workDir: path.relative(target, workDir), packageKey },
    history: [{ at: new Date().toISOString(), kind: "initial-delivery", version: 1, variants: variantsOut.map((variant) => variant.id), patch: null }],
  };
  const projectPath = await writeJson(path.join(target, "film-project.json"), filmProject);

  const manifest = {
    schemaVersion: DELIVERY_SCHEMA,
    projectId,
    packageKey,
    createdAt: filmProject.createdAt,
    title: filmProject.title,
    platform,
    quality,
    resolution: [width, height],
    fps,
    audioScope: hasIndependentAudio ? audioScope(project) : null,
    independentAudio: stemReference(masterStems, target),
    master: {
      path: path.relative(target, masterAssembly.output),
      sha256: await sha256File(masterAssembly.output),
      duration: masterProbe.duration,
      resolution: [masterProbe.width, masterProbe.height],
      subtitles: "none（母版不烧字；字幕走旁挂文件或软字幕轨）",
    },
    subtitles: sidecar ? {
      dir: path.relative(target, path.dirname(sidecar.files[0].path)),
      files: sidecar.files.map((file) => ({ path: path.relative(target, file.path), role: file.role, lang: file.lang, format: file.format, sha256: file.sha256, bytes: file.bytes })),
      manifest: path.relative(target, sidecar.manifestPath),
      checks: sidecar.checks,
    } : null,
    variants: variantsOut.map((variant) => ({
      id: variant.id,
      name: variant.name,
      positioning: variant.positioning,
      dir: path.relative(target, variant.dir),
      reframe: variant.reframe ?? null,
      video: { path: path.relative(target, variant.artifacts.video.path), sha256: variant.artifacts.video.sha256, duration: variant.artifacts.video.duration, resolution: variant.artifacts.video.resolution },
      softsub: variant.artifacts.softsub ? { path: path.relative(target, variant.artifacts.softsub.path), sha256: variant.artifacts.softsub.sha256, tracks: variant.artifacts.softsub.tracks.map((track) => ({ lang: track.lang, title: track.title })) } : null,
      burned: variant.artifacts.burned ? { path: path.relative(target, variant.artifacts.burned.path), sha256: variant.artifacts.burned.sha256 } : null,
      cover: {
        path: path.relative(target, variant.artifacts.cover.path),
        sha256: variant.artifacts.cover.sha256,
        text: variant.artifacts.cover.text,
        at: variant.artifacts.cover.at,
        requestedAt: variant.artifacts.cover.requestedAt,
        background: variant.artifacts.cover.background,
        checks: variant.artifacts.cover.checks,
      },
      copy: { path: path.relative(target, variant.artifacts.copy.path), title: variant.artifacts.copy.title, hashtags: variant.artifacts.copy.hashtags, checks: variant.artifacts.copy.checks },
        audio: variant.artifacts.audio
        ? {
          path: path.relative(target, variant.artifacts.audio.path),
          trackId: variant.artifacts.audio.trackId,
          trackTitle: variant.artifacts.audio.trackTitle,
          attribution: variant.artifacts.audio.attribution,
          loudness: variant.artifacts.audio.loudness,
          // 请求电平 → 实际电平（自动降档时用户要能看见这个差异，而不是只看到"已交付"）
          mixing: variant.artifacts.audio.mixing ?? null,
          ...(variant.artifacts.audio.failed ? { failed: true, code: variant.artifacts.audio.code, message: variant.artifacts.audio.message } : {}),
        }
        : null,
      style: variant.style,
      independentAudio: variant.layers.audioStems ? { ...variant.layers.audioStems, dir: path.relative(target, variant.layers.audioStems.dir) } : null,
    })),
    transitions: {
      mode: baseTransitions.mode,
      planned: plannedTransitions,
      summaryPath: path.relative(target, transitionSummaryPath),
      catalog: "bundles/ai-video/library/transitions/catalog.json",
      scopes: transitionScopes.map((entry) => ({
        scope: entry.scope,
        mode: entry.receipt?.mode ?? null,
        transitionCount: entry.receipt?.transitionCount ?? 0,
        hardCutCount: entry.receipt?.hardCutCount ?? null,
        types: [...new Set((entry.receipt?.cuts ?? []).map((cut) => cut.type))],
        receiptPath: entry.receiptPath ? path.relative(target, entry.receiptPath) : null,
      })),
    },
    reframe: {
      planned: reframeClips.length > 0,
      summaryPath: path.relative(target, reframeSummaryPath),
      shots: normalised.filter((clip) => clip.reframe).map((clip) => ({
        shotId: clip.shotId,
        mode: clip.reframe.mode ?? null,
        intent: clip.reframe.intent ?? null,
        fill: clip.reframe.fill ?? null,
        legacyPunchIn: clip.reframe.legacyPunchIn === true,
        scale: clip.reframe.scale ?? null,
        effectiveUpscale: clip.reframe.budget?.effectiveUpscale ?? null,
        passed: clip.reframe.passed !== false,
      })),
    },
    divergence,
    coverDivergence: coverDivergence.map((row) => ({ a: row.a, b: row.b, meanAbsDiff: row.diff.meanAbsDiff, verdict: row.diff.verdict })),
    checks: packageChecks,
    enhancements: normalised.map((clip) => ({
      shotId: clip.shotId,
      kind: clip.sourceKind,
      sourceSha256: clip.sourceHash,
      sourceResolution: clip.enhancement?.sourceResolution ?? null,
      status: clip.enhancement?.status ?? "not-requested",
      outputSha256: clip.enhancement?.sha256 ?? null,
      outputResolution: clip.enhancement?.outputResolution ?? null,
      provenancePath: clip.enhancement?.provenancePath ? path.relative(target, clip.enhancement.provenancePath) : null,
      model: clip.enhancement?.model ?? null,
    })),
    filmProject: path.relative(target, projectPath),
    cost: {
      shotGeneration: "reused（本包未生成任何新镜头）",
      tokenCostDelta: 0,
      note: "多风格变体只吃本地算力：镜头生成费只付一次，风格差异零 token",
    },
  };
  const manifestPath = await writeJson(path.join(target, "delivery-manifest.json"), manifest);

  const report = [
    `# 交付包 · ${manifest.title}`,
    "",
    `- 项目：${projectId} · 平台：${platform ?? "默认"} · 画幅：${width}×${height} @${fps}fps · 时长：${masterProbe.duration}s`,
    `- 清晰度档位：${quality === "uhd" ? "UHD（本地目标画布加工，未请求模型增强）" : "HD"}；逐镜来源见 \`delivery-manifest.json\` 的 \`enhancements\``,
    `- 干净母版：\`${manifest.master.path}\`（**不含字幕**；字幕只以旁挂文件/可开关字幕轨交付）`,
    sidecar ? `- 字幕文件：${manifest.subtitles.files.map((file) => file.path.split("/").pop()).join("、")}（时间轴回读 ${sidecar.manifest.timeline.readback.ass ? "ok" : "fail"}）` : "- 字幕文件：本次未提供字幕",
    "",
    "## 风格变体（选一个，或提返修意见）",
    "",
    "| 变体 | 定位 | 调色 | BGM | 转场 | 封面 |",
    "|---|---|---|---|---|---|",
    ...manifest.variants.map((variant) => [
      `| ${variant.name}（\`${variant.id}\`）`,
      variant.positioning ?? "—",
      variant.style.color ? `${variant.style.color.profile ?? variant.style.color.lut} @${variant.style.color.intensity}` : "不调色",
      variant.audio
        ? `${variant.audio.trackTitle ?? variant.audio.trackId}${variant.audio.mixing?.autoTrimDb < 0 ? `（自动降档 ${variant.audio.mixing.autoTrimDb}dB → ${variant.audio.mixing.appliedMusicLevelDb}dB）` : ""}${variant.audio.failed ? "（配乐未过检，按原声交付）" : ""}`
        : "原声",
      (() => {
        const receipt = variant.transitions?.receipt ?? null;
        if (!receipt) return `${variant.style.transitions.mode}${variant.style.transitions.fadeSec ? ` ${variant.style.transitions.fadeSec}s` : ""}`;
        if (!receipt.transitionCount) return `${receipt.mode} · 全硬切${receipt.notes?.length ? "（见回执说明）" : ""}`;
        const types = [...new Set(receipt.cuts.map((cut) => cut.type))];
        return `${receipt.mode} · ${receipt.transitionCount} 刀（${types.join("/")}）+ 硬切 ${receipt.hardCutCount} 处`;
      })(),
      `\`${variant.cover.path}\``,
    ].join(" | ")),
    "",
    "## 变体配方与加工证据",
    "",
    "本包按上表声明的配方分别加工；未测画面差值或音频品质，也不据此拒收成功源片。各当前文件 SHA 和输出规格见清单。",
    "",
    "## 返修怎么走（不用重新生成镜头）",
    "",
    "- 换字幕/改文案/换封面：`postwrite.reedit` 只重算文字层与封面层，画面直接复用；",
    "- 换 BGM/调音量：只重算音频层（视频轨 copy，画面零改动）；",
    "- 换调色/转场：只重算调色与拼接层，镜头产物不动；",
    "- 只有点名到「画面内容」（人物/穿帮/镜头不好）才需要重生成镜头，且走人审闸（G8）后只重跑被点名的镜头。",
    "",
    ...(audioFailures.length
      ? [
        "## 需要人看一眼（本次未达标的部分）",
        "",
        ...audioFailures.map((failure) => `- 变体 \`${failure.variant}\` 配乐未通过复检（${failure.code}）：${failure.message}——该变体已按**原声**降级交付，未冒充带配乐成片。`),
        "",
      ]
      : []),
    `工程文件：\`${manifest.filmProject}\`（返修入口）· 清单：\`delivery-manifest.json\``,
    "",
  ].join("\n");
  const reportPath = path.join(target, "delivery-report.md");
  await fsp.writeFile(reportPath, report, "utf8");

  return {
    outDir: target,
    projectId,
    packageKey,
    filmProject,
    projectPath,
    manifest,
    manifestPath,
    reportPath,
    sidecar,
    variants: variantsOut,
    normalised,
    master: masterAssembly,
    checks: packageChecks,
    passed: packageChecks.every((check) => check.ok !== false),
  };
}

/* ============================ 变更影响分析（返修的第一步） ============================ */

const PATCH_KEYS = ["subtitles", "bgm", "color", "transitions", "cover", "copy", "variants", "shots"];
const LAYER_ORDER = ["shots", "assemble", "color", "audio", "text", "cover", "copy"];

/**
 * 变更影响分析：把"用户想改什么"翻译成"要重算哪些层、要不要重新生成镜头"。
 *
 * 这是整个返修机制的分水岭：
 * - 文字/音频/调色/封面/文案/转场 → **本地重合成**（既有镜头产物直接复用，token 增量 0）；
 * - 点名到画面内容 → **镜头重生成**（花钱 → 必须过 G8 人审，且只重跑被点名的镜头）；
 * - 未知键 → 直接报错（不允许"看不懂就忽略"）。
 */
export function analyzeImpact({ project = null, patch = {} } = {}) {
  normalizePatchKeys(patch, PATCH_KEYS, "patch");
  const layers = new Set();
  const reasons = [];
  let shotRegeneration = { required: false, shotIds: [], reason: null, gate: null };

  if (patch.subtitles) {
    normalizePatchKeys(patch.subtitles, ["zhText", "zhPath", "enText", "enPath", "style", "burn", "variantId"], "patch.subtitles");
    layers.add("text");
    reasons.push("字幕文字/样式变化：重出旁挂字幕文件 + 重建软字幕轨（画面不动）");
    if (patch.subtitles.burn === true) reasons.push("显式要求硬字幕：额外产出一支烧字副本（母版仍不烧）");
  }
  if (patch.bgm) {
    normalizePatchKeys(patch.bgm, ["variantId", "trackId", "mood", "genre", "style", "policy", "musicLevelDb", "targetLufs", "enabled"], "patch.bgm");
    layers.add("audio");
    reasons.push("配乐变化：只重跑选曲+混音（视频轨 copy，画面零改动）");
  }
  if (patch.color) {
    normalizePatchKeys(patch.color, ["variantId", "profile", "lut", "intensity"], "patch.color");
    layers.add("color");
    reasons.push("调色变化：从既有拼接母版重跑调色（镜头与拼接不动）");
  }
  if (patch.transitions) {
    normalizePatchKeys(
      patch.transitions,
      ["variantId", "mode", "fadeSec", "type", "easing", "perCut", "plan", "intentMap", "scale"],
      "patch.transitions",
    );
    layers.add("assemble");
    reasons.push("转场/拼接变化：从既有镜头产物重拼接（镜头不动）");
  }
  if (patch.cover) {
    normalizePatchKeys(patch.cover, ["variantId", "at", "alignment", "marginRatio", "subtitle"], "patch.cover");
    layers.add("cover");
    reasons.push("封面变化：重出封面（不动成片）");
  }
  if (patch.copy) {
    normalizePatchKeys(patch.copy, ["variantId", "titleTemplate", "opening", "closing", "cta", "hashtags", "tone", "title", "hook", "body"], "patch.copy");
    layers.add("copy");
    reasons.push("文案变化：重出文案包（不动成片）");
  }
  if (patch.variants) {
    normalizePatchKeys(patch.variants, ["add", "remove"], "patch.variants");
    reasons.push("变体集合变化：只派生新增/移除的变体，既有变体产物复用");
  }
  if (patch.shots) {
    normalizePatchKeys(patch.shots, ["replace", "regenerate"], "patch.shots");
    const requested = [
      ...(Array.isArray(patch.shots.replace) ? patch.shots.replace.map((item) => item.shotId ?? item.shot_id) : []),
      ...(Array.isArray(patch.shots.regenerate) ? patch.shots.regenerate : []),
    ].filter(Boolean).map(String);
    const known = new Set((project?.layers?.shots ?? []).map((shot) => String(shot.shotId)));
    const unknown = requested.filter((shotId) => known.size && !known.has(shotId));
    if (unknown.length) {
      throw new PostError(`patch.shots 点名了不存在的镜头：${unknown.join(", ")}（本片镜头：${[...known].join(", ")}）`, "bad_request");
    }
    layers.add("shots");
    layers.add("assemble");
    shotRegeneration = {
      required: true,
      shotIds: requested,
      reason: "反馈点名到画面内容：需要重新生成这些镜头，再回到本地合成",
      gate: "G8",
      budgetNote: "镜头生成消耗额度，必须人审（G8）后由渲染链路只重跑被点名的镜头",
    };
    reasons.push(`镜头重生成：${requested.join("、") || "全部"}（走 G8 人审，只重跑点名镜头）`);
  }
  if (patch.transitions || patch.shots) layers.add("color");
  /**
   * 调色会重编码音频轨（color-bridge 的 grade 输出 `-c:a aac`），因此"只改调色"必然连带重算音频层：
   * 不是多余步骤，而是**母版必须由同一支已调色母版派生**——否则会出现"画面是 v2 调色、声音是 v1 母版"的
   * 隐性错配（听不出来、也查不出来）。同理，音频变了就要重出软字幕轨（字幕挂在成片容器上）。
   */
  if (patch.transitions || patch.color || patch.shots) layers.add("audio");
  if (patch.transitions || patch.shots) layers.add("text");
  if (patch.transitions || patch.color || patch.shots) layers.add("cover");

  const ordered = LAYER_ORDER.filter((layer) => layers.has(layer));
  const localOnly = !shotRegeneration.required;
  return {
    schemaVersion: "workloom.delivery-impact/v1",
    layers: ordered,
    rebuild: {
      normalise: ordered.includes("shots"),
      assemble: ordered.includes("assemble"),
      color: ordered.includes("color"),
      audio: ordered.includes("audio"),
      text: ordered.includes("text"),
      cover: ordered.includes("cover"),
      copy: ordered.includes("copy"),
    },
    reuse: {
      shots: !ordered.includes("shots"),
      text: !ordered.includes("text"),
      color: !ordered.includes("color"),
      audio: !ordered.includes("audio"),
      cover: !ordered.includes("cover"),
      copy: !ordered.includes("copy"),
    },
    shotRegeneration,
    localOnly,
    costHint: localOnly
      ? { tokenCostDelta: 0, note: "本地重合成：既有镜头产物全部复用，不花 token" }
      : { tokenCostDelta: ">0", note: "需要重生成镜头（仅点名的镜头），先过 G8 人审" },
    reasons,
  };
}

/* ============================ 本地二次编辑（层增量重合成） ============================ */

/** 工程文件里的路径是相对交付根的；同时容忍历史文件里的绝对路径（两者都能解析）。 */
function resolveStored(base, storedPath) {
  const value = String(storedPath ?? "");
  return path.isAbsolute(value) ? value : path.resolve(base, value);
}

/** A revision request compares both the chosen version and its exact bytes. */
export function readRevisionBase(projectPath) {
  const file = path.resolve(text(projectPath, "projectPath"));
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) {
    const code = error.code === "ENOENT" ? "not_found" : error.code === "ELOOP" ? "path_not_allowed" : "revision_io_failed";
    throw new PostError(`无法读取返修工程：${error.message}`, code);
  }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size <= 0 || before.size > 4 * 1024 * 1024) {
      throw new PostError("返修工程必须是 4 MiB 以内的非空文件", "bad_request");
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(file);
    if (before.size !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev) {
      throw new PostError("返修工程在读取期间变化", "revision_conflict");
    }
    let project;
    try { project = JSON.parse(bytes.toString("utf8")); }
    catch (error) { throw new PostError(`返修工程 JSON 非法：${error.message}`, "bad_request"); }
    if (project?.schemaVersion !== FILM_PROJECT_SCHEMA || !Number.isSafeInteger(project.version) || project.version < 1
      || typeof project.projectId !== "string" || !project.projectId.trim()) {
      throw new PostError("返修工程缺少有效 schemaVersion、projectId 或 version", "bad_request");
    }
    return { file, project, version: project.version, sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally { fs.closeSync(fd); }
}

/** No symlinked version/root may redirect a local revision claim. */
function revisionPath(base, target, allowMissing = false) {
  const root = path.resolve(base);
  const rel = path.relative(root, path.resolve(target));
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new PostError("返修路径不在交付包内", "path_not_allowed");
  }
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new PostError("交付包根不能是符号链接", "path_not_allowed");
  let current = root;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (allowMissing && error.code === "ENOENT") continue; throw error; }
    if (stat.isSymbolicLink()) throw new PostError("返修路径不允许符号链接", "path_not_allowed");
  }
  return path.resolve(target);
}

/** A published film-project is the commit point; reserved/failed versions are never reused. */
function revisionHead(base) {
  const initial = readRevisionBase(revisionPath(base, path.join(base, "film-project.json")));
  let latest = initial;
  let highestReserved = initial.version;
  const versions = revisionPath(base, path.join(base, "versions"), true);
  if (!fs.existsSync(versions)) return { latest, highestReserved };
  if (!fs.lstatSync(versions).isDirectory()) throw new PostError("versions 不是目录", "bad_request");
  for (const name of fs.readdirSync(versions)) {
    if (!/^v[1-9]\d*$/.test(name)) continue;
    const version = Number(name.slice(1));
    if (!Number.isSafeInteger(version)) throw new PostError("返修版本号越界", "bad_request");
    const dir = revisionPath(base, path.join(versions, name));
    if (!fs.lstatSync(dir).isDirectory()) throw new PostError(`返修版本不是目录：${name}`, "bad_request");
    highestReserved = Math.max(highestReserved, version);
    const file = revisionPath(base, path.join(dir, "film-project.json"), true);
    if (!fs.existsSync(file)) continue;
    const candidate = readRevisionBase(file);
    if (candidate.version !== version || candidate.project.projectId !== initial.project.projectId) {
      throw new PostError(`返修版本归属不一致：${name}`, "revision_conflict");
    }
    const receiptFile = revisionPath(base, path.join(dir, "revision.json"), true);
    const claimFile = revisionPath(base, path.join(dir, "revision-claim.json"), true);
    if (fs.existsSync(claimFile) && !fs.existsSync(receiptFile)) {
      throw new PostError(`返修提交记录缺失：${name}`, "revision_conflict");
    }
    if (fs.existsSync(receiptFile)) {
      const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
      if (receipt.commit && (receipt.commit.projectSha256 !== candidate.sha256 || receipt.commit.version !== version)) {
        throw new PostError(`已提交返修工程指纹变化：${name}`, "revision_conflict");
      }
      if (fs.existsSync(claimFile)) {
        const claim = JSON.parse(fs.readFileSync(claimFile, "utf8"));
        if (!receipt.commit || receipt.commit.runId !== claim.runId || receipt.commit.baseProjectSha256 !== claim.baseProjectSha256
          || receipt.commit.baseVersion !== claim.baseVersion || claim.version !== version) {
          throw new PostError(`返修提交与认领记录不一致：${name}`, "revision_conflict");
        }
      }
    }
    if (candidate.version > latest.version) latest = candidate;
  }
  return { latest, highestReserved };
}

async function withRevisionClaim({ base, snapshot, expectedVersion, expectedProjectSha256, outDir }, execute) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !/^[a-f0-9]{64}$/.test(expectedProjectSha256 ?? "")) {
    throw new PostError("执行返修需要 expectedVersion 和 expectedProjectSha256（先读取所选工程或 dryRun）", "bad_request");
  }
  if (snapshot.version !== expectedVersion || snapshot.sha256 !== expectedProjectSha256) {
    throw new PostError("返修基础版本或工程指纹已变化，请重新读取后再提交", "revision_conflict");
  }
  revisionPath(base, snapshot.file);
  const lockPath = revisionPath(base, path.join(base, ".revision.lock"), true);
  let fd;
  try { fd = fs.openSync(lockPath, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new PostError("该交付包已有返修持有排他锁；不得覆盖或自动抢占未对账的锁", "revision_busy");
    throw new PostError(`无法认领返修锁：${error.message}`, "revision_io_failed");
  }
  const lockIdentity = fs.fstatSync(fd);
  const runId = randomUUID();
  let targetDir = null;
  let published = false;
  const claim = { runId, pid: process.pid, host: os.hostname(), at: new Date().toISOString(), projectId: snapshot.project.projectId,
    baseVersion: expectedVersion, baseProjectSha256: expectedProjectSha256 };
  const assertCurrent = () => {
    const lock = fs.lstatSync(lockPath);
    if (lock.isSymbolicLink() || lock.ino !== lockIdentity.ino || lock.dev !== lockIdentity.dev
      || JSON.parse(fs.readFileSync(lockPath, "utf8")).runId !== runId) {
      throw new PostError("返修锁归属已变化，禁止提交产物", "revision_conflict");
    }
    const { latest } = revisionHead(base);
    if (latest.version !== expectedVersion || latest.sha256 !== expectedProjectSha256
      || fs.realpathSync(latest.file) !== fs.realpathSync(snapshot.file)) {
      throw new PostError("返修基础已不是当前版本，禁止覆盖新版本", "revision_conflict");
    }
  };
  try {
    fs.writeFileSync(fd, `${JSON.stringify(claim, null, 2)}\n`);
    fs.fsyncSync(fd);
    assertCurrent();
    const version = revisionHead(base).highestReserved + 1;
    if (!Number.isSafeInteger(version)) throw new PostError("返修版本号越界", "bad_request");
    const expectedTarget = path.join(base, "versions", `v${version}`);
    if (outDir && path.resolve(outDir) !== path.resolve(expectedTarget)) {
      throw new PostError(`返修 outDir 必须是当前可认领的新版本目录：${expectedTarget}`, "revision_conflict");
    }
    const versionsDir = revisionPath(base, path.join(base, "versions"), true);
    fs.mkdirSync(versionsDir, { recursive: true });
    revisionPath(base, expectedTarget, true);
    fs.mkdirSync(expectedTarget); // atomic, recursive=false: an existing version is never overwritten
    targetDir = expectedTarget;
    fs.writeFileSync(path.join(targetDir, "revision-claim.json"), `${JSON.stringify({ ...claim, version }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const publish = async (nextProject, revision) => {
      assertCurrent();
      const bytes = `${JSON.stringify(nextProject, null, 2)}\n`;
      const projectSha256 = createHash("sha256").update(bytes).digest("hex");
      revision.commit = { ...claim, version, projectSha256 };
      await writeJson(path.join(targetDir, "revision.json"), revision);
      const pending = path.join(targetDir, `.film-project-${runId}.pending`);
      try {
        const pendingFd = fs.openSync(pending, "wx", 0o600);
        try { fs.writeFileSync(pendingFd, bytes); fs.fsyncSync(pendingFd); }
        finally { fs.closeSync(pendingFd); }
        assertCurrent();
        const projectFile = path.join(targetDir, "film-project.json");
        fs.linkSync(pending, projectFile); // atomic publish; unlike rename, an existing name is never replaced
        published = true;
        return projectFile;
      } finally { await fsp.rm(pending, { force: true }); }
    };
    return await execute({ version, targetDir, publish });
  } catch (error) {
    if (targetDir && !published) {
      try {
        await writeJson(path.join(targetDir, "revision-failed.json"), {
          schemaVersion: "workloom.delivery-revision-failure/v1", ...claim, failedAt: new Date().toISOString(),
          code: error.code ?? "engine_failed", message: error instanceof Error ? error.message : String(error),
        });
      } catch (recordError) {
        throw new PostError(`返修失败且失败记录无法写入：${recordError.message}；原错误：${error.message}`, "revision_io_failed");
      }
    }
    throw error;
  } finally {
    fs.closeSync(fd);
    let lock;
    try { lock = fs.lstatSync(lockPath); }
    catch (error) { throw new PostError(`返修锁无法复核，未删除：${error.message}`, "revision_conflict"); }
    if (lock.ino !== lockIdentity.ino || lock.dev !== lockIdentity.dev || lock.isSymbolicLink()
      || JSON.parse(fs.readFileSync(lockPath, "utf8")).runId !== runId) {
      throw new PostError("返修锁已被替换，不删除其他持有者的锁", "revision_conflict");
    }
    fs.unlinkSync(lockPath);
  }
}

/**
 * 本地二次编辑：读工程文件 → 只重算受影响层 → 落到**新版本目录**（v2/v3…）。
 * 不重新生成镜头；点名到镜头的 patch 会被拒绝执行，只返回计划（fail-closed，钱不能自动烧）。
 * @param {{projectPath?: string, deliveryDir?: string|null, expectedVersion?: number|null,
 * expectedProjectSha256?: string|null, patch?: Record<string, any>, outDir?: string|null,
 * shotPaths?: Record<string, string>|null, bins?: {ffmpeg: string, ffprobe: string},
 * dryRun?: boolean, env?: NodeJS.ProcessEnv}} options
 */
export async function reedit(options = {}) {
  const {
  projectPath,
  deliveryDir = null,
  expectedVersion = null,
  expectedProjectSha256 = null,
  patch = {},
  outDir = null,
  shotPaths = null,
  audioStemsByShot,
  bins = resolveBinaries(),
  dryRun = false,
  env = process.env,
  } = options;
  const explicitAudioSources = Object.hasOwn(options, "audioStemsByShot");
  if (explicitAudioSources) {
    if (!audioSourceObject(audioStemsByShot) || Object.keys(audioStemsByShot).length === 0) {
      throw new PostError("audioStemsByShot 必须是非空镜头来源映射；省略该字段才采用已有节目音轨", "audio_stems_source_unverified");
    }
    for (const [shotId, descriptors] of Object.entries(audioStemsByShot)) {
      assertAudioStemDescriptors(descriptors, `audioStemsByShot.${shotId}`);
    }
  }
  const snapshot = readRevisionBase(projectPath);
  const projectFile = snapshot.file;
  const project = snapshot.project;
  const impact = analyzeImpact({ project, patch });
  const knownShots = new Set((project.layers?.shots ?? []).map((shot) => shot.shotId));
  if (shotPaths && (!audioSourceObject(shotPaths) || Object.entries(shotPaths).some(([shotId, file]) =>
    !knownShots.has(shotId) || typeof file !== "string" || !file.trim()))) {
    throw new PostError("shotPaths 含未知镜头或无效文件路径", "bad_request");
  }
  if (explicitAudioSources) {
    if (!project.layers?.audioStems || !shotPaths || Object.keys(audioStemsByShot).some((shotId) => !Object.hasOwn(shotPaths, shotId))) {
      throw new PostError("显式音轨替换必须绑定已有独立音轨工程及本次替换镜头，不能被忽略或回退原声", "audio_stems_source_unverified");
    }
    audioScope(project);
  }
  if (project.layers?.audioStems && shotPaths) {
    for (const shotId of Object.keys(shotPaths)) {
      if (!explicitAudioSources || !Object.hasOwn(audioStemsByShot, shotId)) {
        throw new PostError(`替换镜头 ${shotId} 缺新的独立音轨来源回执`, "audio_stems_source_unverified");
      }
    }
  }
  /**
   * 两个基准必须分开（2026-09-24 真机修复）：
   *   · `projectDir`：工程文件所在目录——**产物路径按它解析**（约定：路径相对工程文件自己所在目录）；
   *   · `base`：交付包根——**新版本目录与缓存按它落盘**（`versions/vN`、`work/`）。
   * 早先把两者都当成 projectDir，于是连续返修（基线 = versions/v2/film-project.json）会把新版本写成
   * `versions/v2/versions/v3`（嵌套两层）——版本链看着像有、其实结构已经错了。
   */
  const projectDir = path.dirname(projectFile);
  const inferredRoot = path.basename(path.dirname(projectDir)) === "versions"
    && path.basename(projectDir) === `v${project.version}`
    ? path.dirname(path.dirname(projectDir))
    : projectDir;
  const base = deliveryDir ? path.resolve(deliveryDir)
    : project.deliveryRoot ? path.resolve(projectDir, project.deliveryRoot) : inferredRoot;
  const version = project.version + 1;
  const targetDir = path.resolve(outDir ?? path.join(base, "versions", `v${version}`));

  if (impact.shotRegeneration.required && !shotPaths) {
    return {
      executed: false,
      impact,
      blocked: {
        code: "shot_regeneration_required",
        message: "该返修点名到画面内容：需要先重新生成镜头（G8 人审 + 只重跑点名镜头），再回到本地合成",
        nextActions: [
          "① 走渲染链路重跑被点名镜头（render-project.mts --only <shotIds>），产物落回素材库",
          "② 带上 `shotPaths`（shotId → 新镜头文件）重新调用 postwrite.reedit：那时就只做本地合成",
        ],
      },
      version,
      targetDir,
    };
  }

  const plan = impact;
  if (dryRun) {
    return { executed: false, dryRun: true, impact: plan, version, targetDir,
      expectedVersion: snapshot.version, expectedProjectSha256: snapshot.sha256 };
  }

  return withRevisionClaim({ base, snapshot, expectedVersion, expectedProjectSha256, outDir }, async ({ version, targetDir, publish }) => {
    const projectShots = (project.layers?.shots ?? []).map((shot) => ({
      shotId: shot.shotId,
      stored: shot,
    }));
    const [width, height] = project.resolution ?? [1080, 1920];
    const quality = resolveQuality(project);
    const fps = Number(project.fps ?? 30);
    const workDir = path.join(base, "work");
    await fsp.mkdir(path.join(targetDir, "variants"));

    const rebuilt = [];
    const reused = [];
    const hasIndependentAudio = Boolean(project.layers?.audioStems);
    const priorMasterStems = hasIndependentAudio
      ? await verifyStoredStems(project.layers.audioStems, project, projectDir, env, bins) : null;
    const priorSources = priorMasterStems ? descriptorsFromBundle(priorMasterStems) : {};


    /**
     * 层 1：镜头产物（**返修的地基**）。
     * 没被点名的镜头一律直接复用上一次归一化的产物，并复核哈希与工程文件一致——
     * 这样"不重新生成镜头"不是一句承诺，而是可以在 `revision.json` 里逐镜对账的哈希。
     * 只有被点名的镜头（shotPaths 传入的新产物）才重新归一化。
     */
    const normalised = [];
    for (const entry of projectShots) {
      const replacement = shotPaths?.[entry.shotId];
      if (replacement) {
        const [clip] = await normaliseShots({
          shots: [{ shotId: entry.shotId, path: replacement, kind: entry.stored.kind ?? "live-action",
            ...(hasIndependentAudio ? { audioStems: audioStemsByShot[entry.shotId] } : {}) }],
          project: { projectId: project.projectId, resolution: [width, height], quality, fps },
          workDir,
          bins,
          reuse: true, env,
        });
        normalised.push(clip);
        rebuilt.push({ layer: "shots", shotId: clip.shotId, path: clip.path, sha256: clip.sha256, note: "点名镜头：用重生成后的新产物归一化" });
        continue;
      }
      const file = resolveStored(projectDir, entry.stored.normalised);
      if (!fs.existsSync(file)) throw new PostError(`返修需要的镜头产物缺失：${entry.shotId} → ${file}`, "not_found");
      const sha256 = await sha256File(file);
      if (!entry.stored.sha256 || sha256 !== entry.stored.sha256) {
        throw new PostError(`返修镜头 ${entry.shotId} 的归一化产物与工程文件哈希不一致：请通过 shotPaths 显式替换或从原素材重新归一化`, "verify_failed");
      }
      const reusedProbe = await probeMedia(file, { bins });
      if (!(reusedProbe.videoDuration > 0)) {
        throw new PostError(`返修镜头 ${entry.shotId} 缺视频轨时长`, "bad_media");
      }
      const clip = {
        shotId: entry.shotId,
        source: resolveStored(projectDir, entry.stored.source ?? entry.stored.normalised),
        sourceHash: entry.stored.sourceSha256 ?? null,
        sourceDuration: entry.stored.sourceDuration ?? entry.stored.duration,
        sourceHasAudio: entry.stored.sourceHasAudio ?? null,
        audioStems: priorSources[entry.shotId] ?? null,
        sourceKind: entry.stored.kind ?? "live-action",
        quality,
        enhancement: entry.stored.enhancement ? {
          ...entry.stored.enhancement,
          output: entry.stored.enhancement.output ? resolveStored(projectDir, entry.stored.enhancement.output) : null,
          provenancePath: entry.stored.enhancement.provenancePath ? resolveStored(projectDir, entry.stored.enhancement.provenancePath) : null,
        } : null,
        path: file,
        sha256,
        duration: reusedProbe.videoDuration,
        reused: true,
      };
      await assertStoredArtifact(clip.source, clip.sourceHash, `返修镜头 ${entry.shotId} 原素材`);
      normalised.push(clip);
      reused.push({ layer: "shots", shotId: clip.shotId, path: file, sha256, note: "复用上次归一化产物（哈希与工程文件一致）" });
    }
    if (quality === "uhd") await verifyUhdEvidence(normalised, [width, height], bins);

    const nextMasterStems = priorMasterStems && patch.shots
      ? await timelineStems({
        project, clips: normalised, transitions: project.layers.transitions ?? {},
        /** 返修重拼母版时同样按逐刀回执对齐节目声（母版回执随工程文件保存）。 */
        cuts: readTransitionCuts(project.layers?.master?.receipt ? resolveStored(projectDir, project.layers.master.receipt) : null),
        /** 母版画面时长记录在工程文件里（旧工程没有就退回自然长度）。 */
        padToSeconds: Number(project.layers?.master?.durationSeconds ?? 0) > 0 ? Number(project.layers.master.durationSeconds) : null,
        workDir, env, bins,
      })
      : priorMasterStems;
    const variantIds = (project.layers?.variants ?? []).map((variant) => variant.id);
    const variantsOut = [];
    for (const variantId of variantIds) {
      const stored = project.layers.variants.find((variant) => variant.id === variantId);
      const pack = structuredClone(findVariantPack(variantId));
      const appliesToVariant = (change) => Boolean(change)
        && (change.variantId === undefined || change.variantId === variantId);
      const scoped = {
        subtitles: appliesToVariant(patch.subtitles),
        bgm: appliesToVariant(patch.bgm),
        color: appliesToVariant(patch.color),
        transitions: appliesToVariant(patch.transitions),
        cover: appliesToVariant(patch.cover),
        copy: appliesToVariant(patch.copy),
      };
      const rebuildVariant = {
        assemble: Boolean(patch.shots) || scoped.transitions,
        color: Boolean(patch.shots) || scoped.transitions || scoped.color,
        audio: Boolean(patch.shots) || scoped.transitions || scoped.color || scoped.bgm,
        text: Boolean(patch.shots) || scoped.transitions || scoped.subtitles,
        cover: Boolean(patch.shots) || scoped.transitions || scoped.color || scoped.cover,
      };
      const priorStyle = stored?.style ?? {};
      if (priorStyle.color) pack.color = { ...(pack.color ?? {}), ...priorStyle.color };
      else if (stored?.color) {
        for (const key of ["profile", "lut", "intensity"]) {
          if (stored.color[key] !== undefined) pack.color = { ...(pack.color ?? {}), [key]: stored.color[key] };
        }
      }
      if (priorStyle.bgm) pack.bgm = { ...(pack.bgm ?? {}), ...priorStyle.bgm };
      const bgmSelectionChanged = scoped.bgm
        && ["trackId", "mood", "genre", "style", "enabled"].some((key) => Object.hasOwn(patch.bgm, key));
      if (stored?.bgm?.trackId && !bgmSelectionChanged) {
        pack.bgm = {
          ...(pack.bgm ?? {}), trackId: stored.bgm.trackId, policy: stored.bgm.policy ?? pack.bgm?.policy,
          mood: undefined, genre: undefined, style: undefined,
        };
      }
      if (priorStyle.transitions) pack.transitions = { ...(pack.transitions ?? {}), ...priorStyle.transitions };
      else if (stored?.assembly?.mode) pack.transitions = { ...(pack.transitions ?? {}), mode: stored.assembly.mode };
      if (priorStyle.cover) pack.cover = { ...(pack.cover ?? {}), ...priorStyle.cover };
      if (priorStyle.copyTone) pack.copy = { ...(pack.copy ?? {}), tone: priorStyle.copyTone };
      if (scoped.bgm) {
        pack.bgm = {
          ...pack.bgm,
          ...(bgmSelectionChanged ? { trackId: undefined, mood: undefined, genre: undefined, style: undefined } : {}),
          ...patch.bgm,
        };
        delete pack.bgm.variantId;
      }
      if (scoped.color) {
        pack.color = { ...(pack.color ?? {}), ...patch.color };
        delete pack.color.variantId;
      }
      if (scoped.transitions) {
        pack.transitions = { ...(pack.transitions ?? {}), ...patch.transitions };
        delete pack.transitions.variantId;
      }
      if (scoped.cover) {
        pack.cover = { ...(pack.cover ?? {}), ...patch.cover };
        delete pack.cover.variantId;
      }
      if (scoped.copy) {
        pack.copy = { ...(pack.copy ?? {}), ...patch.copy };
        delete pack.copy.variantId;
      }

      const variantDir = path.join(targetDir, "variants", variantId);
      await fsp.mkdir(variantDir, { recursive: true });
      const previousVideo = stored?.artifacts?.video?.path ? resolveStored(projectDir, stored.artifacts.video.path) : null;
      const previousSoftsub = stored?.artifacts?.softsub?.path ? resolveStored(projectDir, stored.artifacts.softsub.path) : null;
      const previousCover = stored?.artifacts?.cover?.path ? resolveStored(projectDir, stored.artifacts.cover.path) : null;

      // 拼接层（只有转场/镜头变化才重算）
      let assemblyPath = stored?.assembly?.path ? resolveStored(projectDir, stored.assembly.path) : null;
      let assemblyReused = true;
      const assemblyTrustedFromStored = !rebuildVariant.assemble && Boolean(stored?.assembly?.sha256)
        && Boolean(assemblyPath) && fs.existsSync(assemblyPath);
      if (assemblyTrustedFromStored) {
        await assertStoredArtifact(assemblyPath, stored.assembly.sha256, `返修变体 ${variantId} 拼接层`);
      } else {
        const transitions = { ...(project.layers.transitions ?? {}), ...(pack.transitions ?? {}) };
        const key = await contentKey({ shots: normalised.map((clip) => clip.sha256), transitions, v: 2 });
        const receiptKey = await contentKey({ key, type: "assembly" });
        assemblyPath = path.join(workDir, "assemble", `${variantId}-${key}.mp4`);
        const metaPath = path.join(workDir, "assemble", `${variantId}-${key}.json`);
        if (fs.existsSync(assemblyPath) && fs.existsSync(metaPath)) {
          let meta;
          try { meta = JSON.parse(await fsp.readFile(metaPath, "utf8")); }
          catch (error) {
            throw new PostError(`返修变体 ${variantId} 拼接缓存回执不可读：${error instanceof Error ? error.message : String(error)}`, "verify_failed");
          }
          if (meta.key !== receiptKey) throw new PostError(`返修变体 ${variantId} 拼接缓存键不匹配`, "verify_failed");
          await assertStoredArtifact(assemblyPath, meta.sha256, `返修变体 ${variantId} 拼接缓存`);
        } else {
          await assembleTimeline({ clips: normalised, transitions, output: assemblyPath, resolution: [width, height], fps, quality, bins });
          await writeJson(metaPath, { sha256: await sha256File(assemblyPath), key: receiptKey });
          assemblyReused = false;
        }
      }
      const assemblyProbe = await probeMedia(assemblyPath, { bins });
      if (assemblyProbe.width !== width || assemblyProbe.height !== height || !assemblyProbe.hasAudio) {
        throw new PostError(`返修变体 ${variantId} 拼接层规格不符`, "verify_failed");
      }
      const assemblySha256 = await sha256File(assemblyPath);
      (assemblyReused ? reused : rebuilt).push({ layer: "assemble", variant: variantId, path: assemblyPath, reused: assemblyReused });

      // 调色层
      let gradedInput = assemblyPath;
      let colorReused = true;
      const storedColorPath = stored?.color?.path ? resolveStored(projectDir, stored.color.path) : null;
      const colorTrustedFromStored = pack.color && !rebuildVariant.color && assemblyTrustedFromStored
        && Boolean(stored?.color?.sha256) && Boolean(storedColorPath) && fs.existsSync(storedColorPath);
      if (pack.color && !colorTrustedFromStored) {
        const gradedPath = path.join(workDir, "graded", `${variantId}-re${version}.mp4`);
        const report = await colorGrade({
          input: assemblyPath,
          output: gradedPath,
          profile: pack.color.profile ?? null,
          lutPath: pack.color.lut ? resolveLut(pack.color.lut) : null,
          intensity: optionalNumber(pack.color.intensity, 0.8),
          quality,
          bins,
        });
        gradedInput = gradedPath;
        colorReused = false;
        (rebuilt).push({ layer: "color", variant: variantId, path: gradedPath, sha256: report.sha256 });
      } else if (colorTrustedFromStored) {
        await assertStoredArtifact(storedColorPath, stored.color.sha256, `返修变体 ${variantId} 调色层`);
        gradedInput = storedColorPath;
        reused.push({ layer: "color", variant: variantId, path: gradedInput, sha256: stored.color.sha256 });
      }
      const gradedSha256 = await sha256File(gradedInput);

      const stemTransitions = { ...(project.layers.transitions ?? {}), ...(pack.transitions ?? {}) };
      let stems = null;
      if (hasIndependentAudio) {
        const variantPicture = rebuildVariant.assemble || !stored.audioStems ? await probeMedia(gradedInput, { bins }) : null;
        stems = rebuildVariant.assemble || !stored.audioStems
          ? await timelineStems({
            project, clips: normalised, transitions: stemTransitions,
            /** 逐刀口径取自本变体拼接回执（重拼时写在 work/assemble，复用缓存时在旁边）。 */
            cuts: readTransitionCuts(assemblyPath ? `${assemblyPath}.transition-receipt.json` : null),
            padToSeconds: variantPicture?.videoDuration ?? variantPicture?.duration ?? null,
            workDir, env, bins,
          })
          : await verifyStoredStems(stored.audioStems, project, projectDir, env, bins);
      }
      // 音频层
      const videoTarget = path.join(variantDir, `${variantId}.mp4`);
      const audioReceiptPath = path.join(variantDir, "audio.json");
      let audioPassed = false;
      let trackId = stored?.bgm?.trackId ?? null;
      if (rebuildVariant.audio || !assemblyTrustedFromStored || (pack.color && !colorTrustedFromStored)) {
        const audioOutcome = await mixVariantAudio({ pack, gradedInput, workDir, output: videoTarget, bins, env, stems });
        trackId = audioOutcome.track?.id ?? null;
        audioPassed = !audioOutcome.failure;
        await writeJson(path.join(variantDir, "audio.json"), audioOutcome.failure
          ? { track: null, failed: true, code: audioOutcome.failure.code, message: audioOutcome.failure.message, note: "配乐复检未通过：本变体按原声降级交付" }
          : audioOutcome.report
            ? {
              track: audioOutcome.track,
              policy: pack.bgm?.policy ?? "keep-dialogue",
              musicLevelDb: pack.bgm?.musicLevelDb ?? null,
              mixing: audioOutcome.report.mixing ?? null,
              loudness: audioOutcome.report.loudness,
              checks: audioOutcome.report.checks,
              levels: audioOutcome.report.levels,
              applicability: audioOutcome.report.applicability,
              retainedTracks: audioOutcome.report.retainedTracks,
              independentAudio: audioOutcome.report.independentAudio,
              ...(audioOutcome.reused ? { reused: true, cacheKey: audioOutcome.cacheKey } : {}),
            }
            : { track: null, policy: "原声（变体刻意不配乐）" });
        const row = { layer: "audio", variant: variantId, path: videoTarget, sha256: await sha256File(videoTarget) };
        if (audioOutcome.reused && !audioOutcome.failure) reused.push({ ...row, note: "混音缓存命中（画面与曲目未变，未重跑混音）" });
        else rebuilt.push(audioOutcome.failure ? { ...row, failure: audioOutcome.failure } : row);
      } else {
        await assertStoredArtifact(previousVideo, stored?.artifacts?.video?.sha256, `返修变体 ${variantId} 视频`);
        await fsp.copyFile(previousVideo, videoTarget);
        if (stored?.artifacts?.audio) {
          const previousAudio = resolveStored(projectDir, stored.artifacts.audio.path);
          await assertStoredArtifact(previousAudio, stored.artifacts.audio.sha256, `返修变体 ${variantId} 音频回执`);
          await fsp.copyFile(previousAudio, audioReceiptPath);
          const priorAudio = JSON.parse(await fsp.readFile(audioReceiptPath, "utf8"));
          audioPassed = priorAudio.failed !== true;
        } else {
          audioPassed = true;
          await writeJson(audioReceiptPath, { output: { sha256: await sha256File(videoTarget) }, sourceAuthority: "stored-original-media-bytes", qualityReviewed: false });
        }
        reused.push({ layer: "audio", variant: variantId, path: previousVideo, sha256: stored?.artifacts?.video?.sha256 ?? null });
      }

      // 文字层：旁挂字幕 + 软字幕轨
      const subtitleFiles = (project.layers?.text?.files ?? []);
      let textDir = project.layers?.text?.sidecarDir ? resolveStored(projectDir, project.layers.text.sidecarDir) : path.join(projectDir, "subtitles");
      let softsub = null;
      let softsubReused = true;
      if (rebuildVariant.text) {
        const { parseSrt } = await import("../subtitle-bridge/core.mjs");
        const baseCuesPath = subtitleFiles.find((file) => file.format === "srt" && file.lang === "chi")?.path;
        const zhText = patch.subtitles?.zhText
          ?? (patch.subtitles?.zhPath ? await fsp.readFile(path.resolve(patch.subtitles.zhPath), "utf8") : null)
          ?? (baseCuesPath ? await fsp.readFile(path.join(projectDir, baseCuesPath), "utf8") : null);
        if (!zhText) throw new PostError("返修文字层缺少字幕内容（既没有 patch.subtitles，也没有原字幕）", "bad_request");
        const enText = patch.subtitles?.enText
          ?? (patch.subtitles?.enPath ? await fsp.readFile(path.resolve(patch.subtitles.enPath), "utf8") : null)
          ?? (() => {
            const enPath = subtitleFiles.find((file) => file.format === "srt" && file.lang === "eng")?.path;
            return enPath ? fs.readFileSync(path.join(projectDir, enPath), "utf8") : null;
          })();
        textDir = path.join(targetDir, "subtitles");
        const sidecar = await exportSidecars({
          input: videoTarget,
          outputDir: textDir,
          name: project.projectId,
          cues: parseSrt(zhText),
          cuesEn: enText ? parseSrt(enText) : [],
          platform: project.platform ?? null,
          brief: { 平台: project.platform ?? "默认" },
          bins,
        });
        softsubReused = false;
        rebuilt.push({ layer: "text", variant: variantId, path: sidecar.manifestPath, files: sidecar.files.length, checks: sidecar.checks.map((check) => ({ kind: check.kind, ok: check.ok })) });
      }
      if (scoped.subtitles && patch.subtitles?.burn === true) {
        const { renderWithSubtitles, parseSrt } = await import("../subtitle-bridge/core.mjs");
        const cues = parseSrt(await fsp.readFile(path.join(textDir, `${project.projectId}.zh.srt`), "utf8"));
        const burned = await renderWithSubtitles({
          mode: "subtitle", input: videoTarget, output: path.join(variantDir, `${variantId}.burned.mp4`),
          cues, platform: project.platform ?? null, brief: { 平台: project.platform ?? "默认" }, bins,
        });
        rebuilt.push({ layer: "text-burn", variant: variantId, path: burned.output.path, sha256: burned.output.hash });
      }
      const shouldSoftMux = rebuildVariant.text || rebuildVariant.audio || rebuildVariant.color || rebuildVariant.assemble
        || !assemblyTrustedFromStored || (pack.color && !colorTrustedFromStored) || !previousSoftsub;
      if (shouldSoftMux) {
        const srtFiles = fs.existsSync(textDir)
          ? (await fsp.readdir(textDir)).filter((file) => file.endsWith(".srt")).sort()
          : [];
        if (srtFiles.length) {
          softsub = await softMux({
            input: videoTarget,
            output: path.join(variantDir, `${variantId}.softsub.mp4`),
            subtitles: srtFiles.map((file, index) => ({
              path: path.join(textDir, file),
              lang: file.includes(".en.") ? "eng" : "chi",
              title: file.includes(".en.") ? "English" : "中文",
              default: index === 0,
            })),
            bins,
          });
          softsubReused = false;
          rebuilt.push({ layer: "text", variant: variantId, path: softsub.output, tracks: softsub.tracks.length, videoUnchanged: true });
        }
      } else if (previousSoftsub) {
        await assertStoredArtifact(previousSoftsub, stored?.artifacts?.softsub?.sha256, `返修变体 ${variantId} 软字幕视频`);
        await fsp.copyFile(previousSoftsub, path.join(variantDir, `${variantId}.softsub.mp4`));
        softsub = { output: path.join(variantDir, `${variantId}.softsub.mp4`), sha256: await sha256File(previousSoftsub) };
        reused.push({ layer: "text", variant: variantId, path: previousSoftsub, sha256: stored?.artifacts?.softsub?.sha256 ?? null });
      }

      // 封面 + 文案
      const coverTarget = path.join(variantDir, "cover.png");
      if (rebuildVariant.cover || !assemblyTrustedFromStored || (pack.color && !colorTrustedFromStored) || !previousCover) {
        const cover = await buildCover({
          input: gradedInput, output: coverTarget, project, variant: pack, resolution: [width, height],
          platform: project.platform ?? null, bins, workDir,
        });
        rebuilt.push({ layer: "cover", variant: variantId, path: cover.output, sha256: cover.sha256 });
      } else {
        await assertStoredArtifact(previousCover, stored?.artifacts?.cover?.sha256, `返修变体 ${variantId} 封面`);
        await fsp.copyFile(previousCover, coverTarget);
        reused.push({ layer: "cover", variant: variantId, path: previousCover, sha256: stored?.artifacts?.cover?.sha256 ?? null });
      }
      const copy = buildCopyPack({ project: { ...project, copy: { ...(project.layers.copy ?? {}), ...(scoped.copy ? patch.copy : {}) } }, variant: pack });
      await fsp.writeFile(path.join(variantDir, "copy.md"), copy.markdown, "utf8");
      await writeJson(path.join(variantDir, "copy.json"), { ...copy, checks: copy.checks });

      const videoProbe = await probeMedia(videoTarget, { bins });
      if (videoProbe.width !== width || videoProbe.height !== height) {
        throw new PostError(`返修变体 ${variantId} 规格不符：实测 ${videoProbe.width}×${videoProbe.height}，目标 ${width}×${height}`, "verify_failed");
      }
      variantsOut.push({
        id: variantId,
        name: pack.name,
        dir: variantDir,
        layers: {
          audioStems: stems ? stemReference(stems) : null,
          assembly: { path: assemblyPath, sha256: assemblySha256, reused: assemblyReused },
          color: pack.color ? { path: gradedInput, sha256: gradedSha256, reused: colorReused } : null,
        },
        video: { path: videoTarget, sha256: await sha256File(videoTarget), duration: videoProbe.duration, resolution: [videoProbe.width, videoProbe.height] },
        softsub: softsub ? { path: softsub.output, sha256: await sha256File(softsub.output), reused: softsubReused } : null,
        cover: { path: coverTarget, sha256: await sha256File(coverTarget) },
        copy: { path: path.join(variantDir, "copy.md"), title: copy.title, hashtags: copy.hashtags, checks: copy.checks },
        bgm: trackId ? { trackId, policy: pack.bgm?.policy ?? "keep-dialogue" } : null,
        audioReceipt: { path: audioReceiptPath, sha256: await sha256File(audioReceiptPath), passed: audioPassed },
        style: { color: pack.color ?? null, bgm: pack.bgm ?? null, transitions: pack.transitions ?? null, cover: pack.cover ?? null, copyTone: pack.copy?.tone ?? null },
      });
    }

    const revision = {
      schemaVersion: "workloom.delivery-revision/v1",
      at: new Date().toISOString(),
      version,
      patch,
      impact,
      rebuilt,
      reused,
      quality,
      resolution: [width, height],
      checks: [{ kind: "audio_sources", ok: true, detail: { embeddedAudioUsed: !hasIndependentAudio, independentStems: hasIndependentAudio, qualityReviewed: false } },
        { kind: "bgm_layer", ok: variantsOut.every((variant) => variant.audioReceipt.passed === true), detail: variantsOut.map((variant) => ({ id: variant.id, passed: variant.audioReceipt.passed })) },
        { kind: "resolution_exact", ok: variantsOut.every((variant) => variant.video.resolution[0] === width && variant.video.resolution[1] === height), detail: { requested: [width, height], variants: variantsOut.map((variant) => ({ id: variant.id, resolution: variant.video.resolution })) } }],
      outDir: targetDir,
      note: impact.localOnly ? "本地重合成（未重新生成镜头）" : "含镜头重生成后重新合成",
    };
    const nextProject = {
      ...project,
      version,
      deliveryRoot: path.relative(targetDir, base) || ".",
      updatedAt: revision.at,
      layers: {
        ...project.layers,
        audioStems: nextMasterStems ? stemReference(nextMasterStems, targetDir) : null,
        /**
         * 路径一律相对**新工程文件所在目录**重写：返修可以连续做多轮（v2 → v3 → v4），
         * 每轮的工程文件都必须能独立解析到自己用到的镜头/拼接/调色产物，
         * 否则第二轮返修会指着上一轮目录里的相对路径找不到文件（真机第一版就踩了这个坑）。
         */
        shots: (project.layers?.shots ?? []).map((shot) => {
          const fresh = normalised.find((clip) => clip.shotId === shot.shotId);
          if (!fresh) throw new PostError(`返修缺少镜头产物：${shot.shotId}`, "not_found");
          return {
            ...shot,
            source: path.relative(targetDir, path.resolve(fresh.source)),
            normalised: path.relative(targetDir, fresh.path),
            sha256: fresh.sha256,
            sourceSha256: fresh.sourceHash,
            sourceDuration: fresh.sourceDuration,
            sourceHasAudio: fresh.sourceHasAudio,
            duration: fresh.duration,
            kind: fresh.sourceKind ?? shot.kind ?? "live-action",
            enhancement: fresh.enhancement ? {
              ...fresh.enhancement,
              output: fresh.enhancement.output ? path.relative(targetDir, fresh.enhancement.output) : null,
              provenancePath: fresh.enhancement.provenancePath ? path.relative(targetDir, fresh.enhancement.provenancePath) : null,
            } : null,
          };
        }),
        variants: (project.layers?.variants ?? []).map((stored) => {
          const fresh = variantsOut.find((variant) => variant.id === stored.id);
          if (!fresh) return stored;
          return {
            ...stored,
            bgm: fresh.bgm,
            style: fresh.style,
            audioStems: fresh.layers.audioStems ? { ...fresh.layers.audioStems, dir: path.relative(targetDir, fresh.layers.audioStems.dir) } : null,
            assembly: fresh.layers?.assembly
              ? { ...(stored.assembly ?? {}), path: path.relative(targetDir, fresh.layers.assembly.path), sha256: fresh.layers.assembly.sha256, reused: fresh.layers.assembly.reused }
              : stored.assembly ?? null,
            color: fresh.layers?.color
              ? {
                ...(stored.color ?? {}),
                path: path.relative(targetDir, fresh.layers.color.path),
                sha256: fresh.layers.color.sha256,
                reused: fresh.layers.color.reused,
              }
              : null,
            artifacts: {
              ...stored.artifacts,
              audio: { path: path.relative(targetDir, fresh.audioReceipt.path), sha256: fresh.audioReceipt.sha256 },
              video: { path: path.relative(targetDir, fresh.video.path), sha256: fresh.video.sha256 },
              softsub: fresh.softsub ? { path: path.relative(targetDir, fresh.softsub.path), sha256: fresh.softsub.sha256 } : null,
              cover: { path: path.relative(targetDir, fresh.cover.path), sha256: fresh.cover.sha256 },
              copy: { path: path.relative(targetDir, fresh.copy.path) },
            },
          };
        }),
      },
      history: [...(project.history ?? []), { at: revision.at, kind: "revision", version, patch, localOnly: impact.localOnly }],
    };
    const projectPathOut = await publish(nextProject, revision);
    return {
      executed: true,
      version,
      targetDir,
      projectPath: projectPathOut,
      impact,
      revisionPath: path.join(targetDir, "revision.json"),
      revision,
      variants: variantsOut,
      rebuilt,
      reused,
      summary: {
        rebuiltLayers: [...new Set(rebuilt.map((row) => row.layer))],
        reusedLayers: [...new Set(reused.map((row) => row.layer))],
        // 同一次返修里"哪些层被重算、哪些层被复用"要能按变体看清楚：
        // 比如"只改了 clean-tech 的配乐"，就不该让 warm-story / bold-promo 显得也被重算。
        rebuiltByLayer: [...new Set(rebuilt.map((row) => row.layer))].map((layer) => ({
          layer,
          variants: [...new Set(rebuilt.filter((row) => row.layer === layer).map((row) => row.variant).filter(Boolean))],
          count: rebuilt.filter((row) => row.layer === layer).length,
        })),
        reusedByLayer: [...new Set(reused.map((row) => row.layer))].map((layer) => ({
          layer,
          variants: [...new Set(reused.filter((row) => row.layer === layer).map((row) => row.variant).filter(Boolean))],
          count: reused.filter((row) => row.layer === layer).length,
        })),
        tokenCostDelta: impact.costHint.tokenCostDelta,
        note: impact.costHint.note,
      },
    };
  });
}

/* ============================ 反馈分诊（把话变成返修任务） ============================ */

/**
 * 反馈 → 归因 → 路由（确定性规则表，不依赖 LLM，可复算、可考试）。
 * 规则表只回答"改哪一层"，不替代人做取舍：命中画面内容即要求走镜头重生成 + 人审。
 */
export const REVISION_RULES = [
  {
    kind: "shot",
    attribution: "rev.shot.content",
    layers: ["shots", "assemble", "color", "audio", "text"],
    requiresShotRegen: true,
    patterns: [/镜头|画面里|画面中|人物|主角|脸|穿帮|重拍|换镜头|重生成|不清楚|模糊|晃动|变形|走形|手|穿模|少了|多了个/i],
    reply: "这条意见动到画面内容：需要重新生成被点名的镜头（会消耗额度，先过 G8 人审），其余镜头与后期全部复用。",
  },
  {
    kind: "audio",
    attribution: "rev.audio.mix",
    layers: ["audio", "text"],
    requiresShotRegen: false,
    patterns: [/音乐|配乐|bgm|背景音|太吵|太响|声音小|没声音|音量大|音量小|换个曲|曲风|节奏感不够/i],
    reply: "配乐问题走本地重混：换曲/调音量只重算音频层，画面逐帧不动。",
  },
  {
    kind: "color",
    attribution: "rev.color.look",
    layers: ["color", "audio", "text"],
    requiresShotRegen: false,
    patterns: [/颜色|调色|色调|太暗|太亮|偏黄|偏蓝|偏冷|偏暖|发灰|饱和|对比度|黑白/i],
    reply: "调色问题走本地重调：从既有拼接母版重跑调色，镜头不重新生成。",
  },
  {
    kind: "text",
    attribution: "rev.text.track",
    layers: ["text"],
    requiresShotRegen: false,
    patterns: [/字幕|错别字|错字|文字|时间轴|台词|听译|标点|双语|英文|繁体|字号|描边/i],
    reply: "字幕问题走本地重出：旁挂字幕文件 + 软字幕轨重算，画面逐帧不动。",
  },
  {
    kind: "cover",
    attribution: "rev.cover.layout",
    layers: ["cover"],
    requiresShotRegen: false,
    patterns: [/封面|首图|头图|缩略图|封面图|封面字/i],
    reply: "封面问题只重出封面图，成片不动。",
  },
  {
    kind: "copy",
    attribution: "rev.copy.tone",
    layers: ["copy"],
    requiresShotRegen: false,
    patterns: [/文案|标题|话题|标签|#|简介|口吻|语气|措辞|导语|卖点/i],
    reply: "文案问题只重出文案包（标题/钩子/话题/CTA），成片不动。",
  },
  {
    kind: "edit",
    attribution: "rev.edit.pacing",
    layers: ["assemble", "color", "audio", "text"],
    requiresShotRegen: false,
    patterns: [/转场|节奏|太慢|太快|顺序|剪辑|镜头顺序|时长|拖沓|卡点/i],
    reply: "剪辑问题走本地重拼：转场/节奏/顺序从既有镜头产物重算，镜头不重新生成。",
  },
];

/**
 * 从自由文本里点名镜头。用户不会按我们的命名习惯说话，所以四种常见说法都要认：
 *   `SC-03` / `sc03`（内部编号）、`镜头3` / `第三个镜头`（按序号）、`shot 3`（英文）。
 * 认不出来就**不猜**：返回空数组，由调用方按"未点名"处理（而不是随便挑一个镜头重跑）。
 */
export function extractShotIds(feedback, knownShotIds = []) {
  const text = String(feedback ?? "");
  const found = new Set();
  const byIndex = (raw) => {
    const index = Number(raw);
    if (!Number.isFinite(index) || index <= 0) return null;
    return knownShotIds[index - 1]
      ?? knownShotIds.find((shotId) => new RegExp(`0*${index}$`).test(shotId))
      ?? null;
  };
  for (const match of text.matchAll(/\b([A-Za-z]{1,4}-?\d{1,3})\b/g)) {
    const raw = match[1];
    const hit = knownShotIds.find((shotId) => shotId.toLowerCase() === raw.toLowerCase());
    if (hit) found.add(hit);
  }
  const ordinalPatterns = [
    /镜头\s*([0-9]{1,3})/g,          // 镜头3 / 镜头 3
    /第\s*([0-9]{1,3})\s*个?\s*镜头/g, // 第3个镜头 / 第 3 镜头
    /第\s*([0-9]{1,3})\s*镜/g,        // 第3镜
    /\bshot\s*([0-9]{1,3})\b/gi,      // shot 3
    /\bsc(?:ene)?\s*([0-9]{1,3})\b/gi, // scene 3
  ];
  for (const pattern of ordinalPatterns) {
    for (const match of text.matchAll(pattern)) {
      const hit = byIndex(match[1]);
      if (hit) found.add(hit);
    }
  }
  return [...found];
}

export function triageFeedback({ feedback, project = null, variants = null } = {}) {
  const message = text(feedback, "feedback");
  const knownShotIds = (project?.layers?.shots ?? []).map((shot) => String(shot.shotId));
  const hits = REVISION_RULES.filter((rule) => rule.patterns.some((pattern) => pattern.test(message)));
  const rules = hits.length ? hits : [{
    kind: "unclear",
    attribution: "other",
    layers: [],
    requiresShotRegen: false,
    reply: "这条意见没落到已定义的返修轴上：请指认要改的是字幕 / 配乐 / 调色 / 封面 / 文案 / 剪辑，还是画面内容（镜头）。",
  }];
  const shotIds = extractShotIds(message, knownShotIds);
  const requiresShotRegen = rules.some((rule) => rule.requiresShotRegen);
  const layers = [...new Set(rules.flatMap((rule) => rule.layers))];
  const orderedLayers = LAYER_ORDER.filter((layer) => layers.includes(layer));
  const namedVariants = Array.isArray(variants) && variants.length
    ? variants.filter((variant) => message.includes(variant) || message.includes(variant))
    : [];
  return {
    schemaVersion: "workloom.delivery-triage/v1",
    feedback: message,
    kinds: rules.map((rule) => rule.kind),
    attributions: rules.map((rule) => rule.attribution),
    layers: orderedLayers,
    requiresShotRegeneration: requiresShotRegen,
    shotIds,
    namedVariants,
    gate: requiresShotRegen ? "G8" : null,
    costHint: requiresShotRegen
      ? { tokenCostDelta: ">0", note: "需要重生成点名镜头（人审后执行）" }
      : { tokenCostDelta: 0, note: "本地重合成即可，无需重新生成镜头" },
    reply: rules.map((rule) => rule.reply).join(" "),
    nextActions: requiresShotRegen
      ? [
        "① 生成返修单（含点名镜头）→ G8 人审",
        "② 只重跑点名镜头（render-project.mts --only <shotIds>）",
        "③ 带新镜头路径调 postwrite.reedit 完成本地合成",
      ]
      : [
        "① 生成 patch（只含受影响层）",
        "② 调 postwrite.reedit：本地重合成出新版本（镜头与未受影响层复用）",
        "③ 对比新旧版本 sha256 与差异，出返修回执",
      ],
    patchHint: {
      ...(orderedLayers.includes("text") ? { subtitles: { zhText: "<新字幕文本或路径>" } } : {}),
      ...(orderedLayers.includes("audio") ? { bgm: { trackId: "<曲目 id> 或 mood/style" } } : {}),
      ...(orderedLayers.includes("color") ? { color: { profile: "<profile 或 lut>", intensity: 0.8 } } : {}),
      ...(orderedLayers.includes("cover") ? { cover: { at: 0.35 } } : {}),
      ...(orderedLayers.includes("copy") ? { copy: { cta: "<新 CTA>" } } : {}),
      ...(orderedLayers.includes("assemble") ? { transitions: { mode: "fade", fadeSec: 0.6 } } : {}),
      ...(requiresShotRegen ? { shots: { regenerate: shotIds.length ? shotIds : ["<shotId>"] } } : {}),
    },
  };
}

/* ============================ 健康探针 ============================ */

export async function health({ bins = resolveBinaries(), env = process.env } = {}) {
  const result = { ffmpeg: null, ffprobe: null, variants: null, luts: null, subtitle: null, bgm: null, enhance: null, errors: [] };
  try {
    const { binaryVersion } = await import("../subtitle-bridge/measure.mjs");
    result.ffmpeg = await binaryVersion(bins.ffmpeg);
    result.ffprobe = await binaryVersion(bins.ffprobe);
  } catch (error) {
    result.errors.push(`ffmpeg 探针失败：${String(error)}`);
  }
  try {
    result.variants = listVariantPacks().map((pack) => ({ id: pack.id, name: pack.name }));
  } catch (error) {
    result.errors.push(`变体索引不可用：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const manifest = JSON.parse(await fsp.readFile(path.join(LUT_DIR, "manifest.json"), "utf8"));
    result.luts = { count: manifest.luts?.length ?? 0, dir: LUT_DIR };
  } catch (error) {
    result.errors.push(`LUT 清单不可用：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const { health: subtitleHealth } = await import("../subtitle-bridge/core.mjs");
    const probe = await subtitleHealth({ bins, env });
    result.subtitle = {
      ok: probe.ok === true,
      videoEncoder: probe.videoEncoder ?? null,
      fonts: probe.fonts?.installed ?? null,
      fontsTotal: probe.fonts?.total ?? null,
      renderCapabilities: probe.renderCapabilities ?? null,
      platforms: probe.platforms ?? [],
    };
  } catch (error) {
    result.errors.push(`字幕工位不可用：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const tracks = findTracks({}, env);
    result.bgm = { libraryPresent: tracks.libraryPresent, total: tracks.total, matched: tracks.matched };
  } catch (error) {
    result.errors.push(`曲库不可用：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const { checkEnhanceEngine } = await import("../enhance-bridge/core.mjs");
    result.enhance = await checkEnhanceEngine({ bins });
  } catch (error) {
    result.enhance = { ready: false, error: error instanceof Error ? error.message : String(error) };
  }
  return result;
}

/* ============================ 工具入口 ============================ */

function resolveCues(params = {}) {
  return { zh: params.zh_text ?? params.zhText ?? null, ...params };
}

export async function callTool(name, params = {}, { bins = resolveBinaries(), env = process.env } = {}) {
  if (!isPostTool(name)) throw new PostError(`未提供的工具：${name}`, "not_provided");
  const roots = allowedRoots(env);
  switch (name) {
    case "postread.health":
      return { result: await health({ bins, env }), receipt: { synced: true, verified_at: new Date().toISOString() } };
    case "postread.plan": {
      const project = params.project ?? {};
      const shots = (params.shots ?? []).map((shot) => ({ ...shot, path: assertPathAllowed(shot.path ?? shot.localPath, roots, "shots[].path") }));
      const result = await planDelivery({ project, shots, variants: params.variants ?? null, bins });
      return { result, receipt: { synced: true, verified_at: new Date().toISOString() } };
    }
    case "postread.impact": {
      const result = analyzeImpact({ project: params.project ?? null, patch: params.patch ?? {} });
      return { result, receipt: { synced: true, verified_at: new Date().toISOString() } };
    }
    case "postwrite.package": {
      const outDir = assertPathAllowed(params.out_dir ?? params.outDir, roots, "out_dir");
      const shots = (params.shots ?? []).map((shot) => ({ ...shot, path: assertPathAllowed(shot.path ?? shot.localPath, roots, "shots[].path") }));
      const outcome = await buildDeliveryPackage({
        project: params.project ?? {},
        shots,
        subtitles: params.subtitles ?? null,
        variants: params.variants ?? null,
        outDir,
        burnSubtitles: params.burn_subtitles === true,
        softSubtitles: params.soft_subtitles !== false,
        bins,
        env,
      });
      const primary = outcome.manifest.variants[0]?.softsub ?? outcome.manifest.variants[0]?.video;
      return {
        result: {
          out_dir: outcome.outDir,
          project_id: outcome.projectId,
          package_key: outcome.packageKey,
          manifest_path: outcome.manifestPath,
          report_path: outcome.reportPath,
          project_path: outcome.projectPath,
          master: outcome.manifest.master,
          quality: outcome.manifest.quality,
          enhancements: outcome.manifest.enhancements,
          subtitles: outcome.manifest.subtitles,
          variants: outcome.manifest.variants,
          divergence: outcome.manifest.divergence,
          checks: outcome.checks,
          passed: outcome.passed,
        },
        receipt: {
          synced: outcome.passed === true,
          snapshot_uri: primary ? `post://package/${path.basename(String(primary.path))}` : `post://package/${outcome.packageKey}`,
          sha256: primary?.sha256 ?? null,
          verified_at: new Date().toISOString(),
        },
      };
    }
    case "postwrite.reedit": {
      const projectPath = assertPathAllowed(params.project_path ?? params.projectPath, roots, "project_path");
      const shotPaths = params.shot_paths
        ? Object.fromEntries(Object.entries(params.shot_paths).map(([shotId, file]) => [shotId, assertPathAllowed(file, roots, `shot_paths.${shotId}`)]))
        : null;
      const outcome = await reedit({
        projectPath,
        deliveryDir: params.delivery_dir ? assertPathAllowed(params.delivery_dir, roots, "delivery_dir") : null,
        expectedVersion: params.expected_version ?? null,
        expectedProjectSha256: params.expected_project_sha256 ?? null,
        patch: params.patch ?? {},
        outDir: params.out_dir ? assertPathAllowed(params.out_dir, roots, "out_dir") : null,
        shotPaths,
        ...(Object.hasOwn(params, "audio_stems_by_shot") ? { audioStemsByShot: params.audio_stems_by_shot } : {}),
        bins,
        dryRun: params.dry_run === true,
        env,
      });
      return {
        result: outcome,
        receipt: {
          synced: !outcome.executed || outcome.revision?.checks?.every((check) => check.ok === true) === true,
          snapshot_uri: outcome.executed ? `post://revision/v${outcome.version}` : "post://revision/planned",
          verified_at: new Date().toISOString(),
        },
      };
    }
    case "postwrite.triage": {
      const result = triageFeedback({ feedback: params.feedback, project: params.project ?? null, variants: params.variants ?? null });
      return { result, receipt: { synced: true, verified_at: new Date().toISOString() } };
    }
    default:
      throw new PostError(`未实现的工具：${name}`, "not_provided");
  }
}

/** 作业留痕（与其它三个工位同款：每次调用一行 jsonl，失败也留痕）。 */
export function jobsDir(env = process.env) {
  return env.WORKLOOM_POST_JOBS_DIR || path.join(os.homedir(), ".workloom-post", "jobs");
}

export async function jobAppend(dir, record) {
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, "jobs.jsonl");
  await fsp.appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf8");
  return file;
}

/** 稳定序列化（键排序）用于幂等键与请求哈希。 */
export function STABLE_JSON(value) {
  const sort = (input) => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, sort(input[key])]));
    }
    return input;
  };
  return JSON.stringify(sort(value));
}

export function hashKey(text) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, 32);
}

export { SubtitleError };
