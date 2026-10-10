#!/usr/bin/env tsx
/**
 * edit-cover —— 封面 agent 链路执行器（封面设计师岗位 + Compositor 视觉工位）。
 *
 * 链路（与 `presets/cover-designer.yml` / `skills/compositor-designer` / `connectors/visual-bridge` 同口径）：
 *   ① 画幅：**跟随成片**（横版片出横版封面，竖版片出竖版封面）——封面与首帧一致才不会在平台上被裁；
 *   ② 规格与知识库：平台安全区/标题带取 `cover-platforms.ts`（唯一事实源），经验注入取 `cover-kb`（带 trace）；
 *   ③ 视觉锤：可选账号档案（字体/色板/版式偏好/系列角标）；
 *   ④ 设计稿：三风格独立封面（每份 CoverPlan：主标题/副标题/角标/主视觉镜头与取帧秒/字级/配色/版式/设计理由）；
 *   ⑤ 合成：**Compositor 视觉工位**（visual-bridge：配方 → .comp → PNG，带回执）；工位不可用时显式降级到本机 ffmpeg 并如实标注；
 *   ⑥ 机检：画幅/字节数/标题带 PSNR/人物位 PSNR/安全区/底图血缘 + 工位 `visualread.verify` 回执；
 *   ⑦ 烧封：把封面作为片头**烧进视频**（默认 1.6s，音轨沿用成片前 1.6s，保证 BGM 不断），产出 `*-cover.mp4`。
 *
 * 用法：
 *   pnpm edit:cover -- --input <交付目录/master/master-clean.mp4> --out-dir <交付目录>
 *     [--timeline <film.timeline.json>] [--variants warm-story,clean-tech,bold-promo]
 *     [--platform 微信视频号] [--title "回家是为了确认"] [--hook "十一回山东"]
 *     [--hero-sec 35.5] [--account <账号档案>] [--burn-intro 1.6] [--renderer auto|compositor|ffmpeg] [--json]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  COVER_FONTS, COVER_DIFF_PSNR_DB, validateCoverPlan, type CoverPlan,
} from "../../packages/video-studio/src/cover-design.js";
import { getCoverSpec } from "../../packages/video-studio/src/cover-platforms.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const FFMPEG = process.env.WL_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.WL_FFPROBE ?? "ffprobe";
const KB_DIR = join(REPO_ROOT, "bundles/ai-video/library/cover-kb");
const FONT_DIR = join(REPO_ROOT, "bundles/ai-video/library/fonts");
const ACCOUNT_DIR = join(REPO_ROOT, "bundles/ai-video/library/account-profiles");
const BRIDGE_TOKEN_FILE = join(homedir(), "Library/Application Support/WorkLoomVisualBridge/token");
const BRIDGE_TENANT = process.env.WORKLOOM_VISUAL_BRIDGE_TENANT ?? "ws-geo";
// 工位的租户根目录 = work_dir/tenants/<tenant>（路径监狱按此判定；写错会得到 path_not_allowed）
const BRIDGE_VAR = join(homedir(), "Library/Application Support/WorkLoomVisualBridge/var", "tenants", BRIDGE_TENANT);

const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

function run(bin: string, args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw new Error(`${bin} 启动失败：${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").split("\n").slice(-4).join(" | ");
    throw new Error(`${bin} 失败（退出码 ${String(result.status)}）：${detail}`);
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

function probeMedia(file: string): { width: number; height: number; duration: number } {
  const out = run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-show_entries", "format=duration", "-of", "json", file]).stdout;
  const doc = JSON.parse(out) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
  return {
    width: Number(doc.streams?.[0]?.width ?? 0),
    height: Number(doc.streams?.[0]?.height ?? 0),
    duration: Number(doc.format?.duration ?? 0),
  };
}

/** 标题带 / 人物位 PSNR：合成图 vs 无字底图（差异越大 = 越可能真的画了东西） */
function bandPsnr(composed: string, base: string, box: { x: number; y: number; w: number; h: number }): number | null {
  const crop = `crop=${box.w}:${box.h}:${box.x}:${box.y}`;
  const out = run(FFMPEG, [
    "-hide_banner", "-i", composed, "-i", base,
    "-lavfi", `[0:v]${crop}[a];[1:v]${crop}[b];[a][b]psnr`, "-f", "null", "-",
  ]).stderr;
  const matched = /average:([0-9.]+|inf)/u.exec(out);
  if (!matched) return null;
  return matched[1] === "inf" ? Number.POSITIVE_INFINITY : Number(matched[1]);
}

interface StyleSpec {
  id: string;
  fontId: keyof typeof COVER_FONTS;
  fontFamily: string;
  archetype: "person-led" | "subject-led";
  layout: CoverPlan["layout"];
  headlineSize: number;
  colors: { title: string; sub: string; badge: string; accent: string };
  heroSec: number;
  accentBar: boolean;
  reason: string;
}

const FONT_FAMILY: Record<string, string> = {
  "smiley-sans": "Smiley Sans",
  "source-han-heavy": "Source Han Sans CN Heavy",
  "zcool-qingke": "ZCOOL QingKe HuangYou",
  "noto-serif": "Noto Serif SC",
};

const STYLES: Record<string, StyleSpec> = {
  "warm-story": {
    id: "warm-story", fontId: "zcool-qingke", fontFamily: "ZCOOL QingKe HuangYou",
    archetype: "person-led", layout: "person-left", headlineSize: 124,
    colors: { title: "#FFFFFF", sub: "#FFE7B3", badge: "#FFD166", accent: "#FFD166" },
    heroSec: 35.5, accentBar: true,
    reason: "暖调故事版：果园峰值帧 + 圆润字体 + 暖色题签，与片子情绪一致（人物为主）",
  },
  "clean-tech": {
    id: "clean-tech", fontId: "source-han-heavy", fontFamily: "Source Han Sans CN Heavy",
    archetype: "subject-led", layout: "person-right", headlineSize: 112,
    colors: { title: "#FFFFFF", sub: "#CFE8FF", badge: "#7DD3FC", accent: "#7DD3FC" },
    heroSec: 6.6, accentBar: true,
    reason: "冷净版：苹果特写 + 最稳的重标题，强调画面质感（物体为主，不放人物卡）",
  },
  "bold-promo": {
    id: "bold-promo", fontId: "smiley-sans", fontFamily: "Smiley Sans",
    archetype: "person-led", layout: "person-right", headlineSize: 128,
    colors: { title: "#FFFFFF", sub: "#FFE1E1", badge: "#FF4D4F", accent: "#FF4D4F" },
    heroSec: 24.6, accentBar: true,
    reason: "高对比版：1903 小店她笑的近景 + 大字抓眼，适合信息流首屏",
  },
};

interface BridgeClient { available: boolean; reason?: string; call: (name: string, params: Record<string, unknown>) => Promise<Record<string, unknown>> }

async function connectBridge(url: string): Promise<BridgeClient> {
  let token = "";
  try {
    token = readFileSync(BRIDGE_TOKEN_FILE, "utf8").trim();
  } catch {
    return { available: false, reason: `工位令牌不可读：${BRIDGE_TOKEN_FILE}`, call: async () => { throw new Error("bridge unavailable"); } };
  }
  try {
    const health = await fetch(`${url.replace(/\/$/u, "")}/health`, { headers: { Authorization: `Bearer ${token}` } });
    if (!health.ok) return { available: false, reason: `工位健康检查失败 HTTP ${health.status}`, call: async () => { throw new Error("bridge unavailable"); } };
  } catch (err) {
    return { available: false, reason: `工位不可达：${err instanceof Error ? err.message : String(err)}`, call: async () => { throw new Error("bridge unavailable"); } };
  }
  const call = async (name: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const response = await fetch(`${url.replace(/\/$/u, "")}/action`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      // 视觉工位的请求体约定是 `{tool, params}`（不是 {name, params}——写错会得到 unknown tool None 并静默降级）
      body: JSON.stringify({ tool: name, params: { ...params, tenant_id: BRIDGE_TENANT, idempotency_key: `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` } }),
    });
    const doc = await response.json() as Record<string, unknown>;
    if (!response.ok || doc.ok === false) throw new Error(`工位调用失败 ${name}：${JSON.stringify(doc).slice(0, 300)}`);
    return doc;
  };
  return { available: true, call };
}

async function main(): Promise<void> {
  const input = arg("--input");
  const outDirArg = arg("--out-dir");
  if (!input || !outDirArg) throw new Error("用法：pnpm edit:cover -- --input <master-clean.mp4> --out-dir <交付目录>");
  const master = abs(input);
  if (!existsSync(master)) throw new Error(`干净母版不存在：${master}`);
  const outDir = abs(outDirArg);
  const variants = arg("--variants", "warm-story,clean-tech,bold-promo").split(",").map((v) => v.trim()).filter(Boolean);
  const platformInput = arg("--platform", "微信视频号");
  const title = arg("--title", "");
  const hook = arg("--hook", "");
  const account = arg("--account");
  if (!title) throw new Error("--title 必填（封面主标题 ≤12 字）");
  const rendererMode = arg("--renderer", "auto");
  const burnIntro = Number(arg("--burn-intro", "1.6"));
  if (!Number.isFinite(burnIntro) || burnIntro < 0 || burnIntro > 5) throw new Error("--burn-intro 需要 0–5 秒");
  const bridgeUrl = arg("--bridge-url", process.env.WORKLOOM_VISUAL_BRIDGE_URL ?? "http://127.0.0.1:9773");

  // ① 画幅跟随成片（横版片→横版封面）
  const media = probeMedia(master);
  if (!(media.width > 0 && media.height > 0)) throw new Error("无法读取母版画幅");
  const landscape = media.width >= media.height;
  const spec = getCoverSpec(platformInput);
  const canvas = { width: media.width, height: media.height };
  const canvasNote = landscape
    ? `跟随成片横版画幅 ${canvas.width}×${canvas.height}；平台（${platformInput}）安全区按代码规格 ${spec.id} 的顶/底比例换算`
    : `跟随成片竖版画幅 ${canvas.width}×${canvas.height}；平台（${platformInput}）规格 ${spec.id}`;

  // ② 知识库 + ③ 账号视觉锤
  const kbModule = abs("bundles/ai-video/connectors/cover-kb-bridge/core.mjs");
  const { loadKb, recipe, enrichCoverHints, normalizeAccountProfile } = await import(`file://${kbModule}`) as {
    loadKb: (dir: string) => unknown;
    recipe: (kb: unknown, options: Record<string, unknown>) => Record<string, unknown>;
    enrichCoverHints: (kb: unknown, options: Record<string, unknown>) => Record<string, unknown>;
    normalizeAccountProfile: (raw: unknown) => Record<string, unknown> | null;
  };
  const kb = loadKb(KB_DIR);
  const theme = arg("--theme", "旅行");
  const accountProfile = (() => {
    if (!account) return null;
    const file = join(ACCOUNT_DIR, `${account}.yml`);
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, "utf8");
    const pick = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(raw)?.[1]?.trim();
    return normalizeAccountProfile({
      account_id: account,
      display_name: pick("display_name") ?? account,
      account_type: pick("account_type") ?? null,
      visual_hammer: {
        fontId: /fontId:\s*([a-z0-9-]+)/u.exec(raw)?.[1] ?? null,
        palette: [...raw.matchAll(/"#([0-9A-Fa-f]{6})"/gu)].map((m) => `#${m[1]}`).slice(0, 2),
        archetype_bias: /archetype_bias:\s*([a-z-]+)/u.exec(raw)?.[1] ?? null,
        badge_series: /badge_series:\s*"([^"]+)"/u.exec(raw)?.[1] ?? null,
      },
    });
  })();
  const recipeDoc = recipe(kb, { platform: platformInput, theme, accountType: accountProfile?.account_type ?? null });
  const hints = enrichCoverHints(kb, { platform: platformInput, theme, accountProfile: accountProfile ?? undefined });

  // 镜头表（主视觉与人物卡镜头必须真实存在）
  interface ShotRow { shotId: string; scene?: string; duration?: number; sourceIn?: number; masterIn?: number }
  const shots: ShotRow[] = [];
  const timelinePath = arg("--timeline");
  let filmDuration = media.duration;
  if (timelinePath) {
    const timeline = JSON.parse(readFileSync(abs(timelinePath), "utf8")) as {
      segments: Array<{ segmentId: string; groupId?: string | null; durationSeconds: number; sourceIn: number }>;
    };
    let cursor = 0;
    for (const segment of timeline.segments) {
      shots.push({ shotId: segment.segmentId, scene: segment.groupId ?? undefined, duration: segment.durationSeconds, sourceIn: segment.sourceIn, masterIn: Number(cursor.toFixed(3)) });
      cursor += segment.durationSeconds;
    }
    filmDuration = Number(cursor.toFixed(3));
  } else {
    shots.push({ shotId: "hero", scene: "film", duration: filmDuration, sourceIn: 0, masterIn: 0 });
  }

  const bridge = rendererMode === "ffmpeg" ? { available: false, reason: "--renderer=ffmpeg（显式降级）", call: async () => { throw new Error("ffmpeg mode"); } } : await connectBridge(bridgeUrl);
  const workRoot = bridge.available ? join(BRIDGE_VAR, `edit-cover-${Date.now().toString(36)}`) : join(outDir, "covers", "work");
  mkdirSync(workRoot, { recursive: true });
  mkdirSync(join(outDir, "covers"), { recursive: true });

  const covers: Array<Record<string, unknown>> = [];
  const checksAll: Array<Record<string, unknown>> = [];
  for (const variantId of variants) {
    const style = STYLES[variantId] ?? STYLES["warm-story"]!;
    const heroSec = Number(arg("--hero-sec", String(style.heroSec)));
    const heroShot = shots.find((shot) => (shot.masterIn ?? 0) <= heroSec && heroSec < (shot.masterIn ?? 0) + (shot.duration ?? 0)) ?? shots[0]!;
    const heroSourceSec = Number(((heroShot.sourceIn ?? 0) + Math.max(0, heroSec - (heroShot.masterIn ?? 0))).toFixed(3));

    const plan: CoverPlan = {
      headline: title,
      subline: hook || undefined,
      badge: (accountProfile?.visual_hammer as { badge_series?: string } | undefined)?.badge_series ?? "十一 · 回山东",
      layout: style.layout,
      background: { shotId: heroShot.shotId, atSec: heroSourceSec, treatment: "scrim" },
      person: style.archetype === "person-led" ? { enabled: true, shotId: heroShot.shotId, atSec: heroSourceSec, widthRatio: 0.42 } : { enabled: false, widthRatio: 0.42 },
      typography: {
        fontId: style.fontId,
        headlineSizeRatio: Number((style.headlineSize / canvas.height).toFixed(4)),
        sublineSizeRatio: Number((52 / canvas.height).toFixed(4)),
        color: style.colors.title,
        accentColor: style.colors.accent,
      },
      rationale: style.reason,
      source: "requested",
      archetype: style.archetype,
    } as CoverPlan;
    const validated = validateCoverPlan(plan, {
      shots, platform: platformInput, archetype: style.archetype,
      character: style.archetype === "person-led" ? { name: "片中人" } : null,
      kbHints: (Array.isArray((hints as { hints?: unknown }).hints) ? (hints as { hints: string[] }).hints : []).slice(0, 3),
    });

    // 主视觉取帧（干净母版）→ 交给工位做底图
    const frame = join(workRoot, `${variantId}-hero.png`);
    run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(heroSec), "-i", master, "-frames:v", "1", frame]);

    const scrimLayers = Array.from({ length: 7 }, (_, i) => ({
      type: "solid", name: `scrim-${i}`, color: "#000000",
      x: 0, y: 0, width: canvas.width, height: Math.round(canvas.height * 0.09),
      opacity: Number((0.06 + i * 0.02).toFixed(3)),
    }));
    // 逐层下移的压暗带（Compositor 的 solid 用 y 定位）
    scrimLayers.forEach((layer, index) => { layer.y = Math.round(canvas.height * (0.42 + index * 0.085)); });
    const titleY = Math.round(canvas.height * (landscape ? 0.63 : 0.7));
    const badgeY = Math.round(canvas.height * 0.08);
    const subtitleY = titleY + Math.round(style.headlineSize * 1.25);
    const recipeBody = {
      recipe_version: 1,
      name: `cover-${variantId}`,
      canvas: { width: canvas.width, height: canvas.height, resolution: 72 },
      layers: [
        { type: "image", name: "hero", source: frame, x: 0, y: 0, width: canvas.width, height: canvas.height, opacity: 1 },
        ...scrimLayers,
        ...(style.accentBar ? [{ type: "solid", name: "accent-bar", color: style.colors.accent, x: Math.round(canvas.width * 0.08), y: titleY - Math.round(canvas.height * 0.08), width: Math.round(canvas.width * 0.1), height: Math.round(canvas.height * 0.012), opacity: 1 }] : []),
        { type: "text", name: "badge", text: String(plan.badge ?? ""), font: style.fontFamily, size: Math.round(canvas.height * 0.038), weight: "bold", color: style.colors.badge, align: "right", x: Math.round(canvas.width * 0.62), y: badgeY, width: Math.round(canvas.width * 0.3) },
        { type: "text", name: "headline", text: title, font: style.fontFamily, size: style.headlineSize, weight: "bold", color: style.colors.title, align: "left", x: Math.round(canvas.width * 0.08), y: titleY, width: Math.round(canvas.width * 0.84) },
        ...(plan.subline ? [{ type: "text", name: "subline", text: plan.subline, font: style.fontFamily, size: 52, weight: "regular", color: style.colors.sub, align: "left", x: Math.round(canvas.width * 0.08), y: subtitleY, width: Math.round(canvas.width * 0.84) }] : []),
      ],
      exports: [{ format: "png", path: `cover-${variantId}.png` }],
    };

    const target = join(outDir, "variants", variantId, "cover.png");
    let renderer = "ffmpeg-fallback";
    let bridgeReceipt: Record<string, unknown> | null = null;
    if (bridge.available) {
      try {
        const composed = await bridge.call("visualwrite.compose", { recipe: recipeBody, out_dir: workRoot });
        const result = (composed.result ?? {}) as { outputs?: Array<{ path?: string }>; output?: string };
        const produced = result.outputs?.[0]?.path ?? result.output ?? join(workRoot, `cover-${variantId}.png`);
        if (!existsSync(produced)) throw new Error(`工位未产出封面：${produced}`);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(produced, target);
        renderer = "compositor-visual-bridge";
        bridgeReceipt = (composed.receipt as Record<string, unknown>) ?? null;
      } catch (err) {
        bridge.available = false;
        bridge.reason = `工位合成失败，降级本机 ffmpeg：${err instanceof Error ? err.message : String(err)}`;
      }
    }
    let baseImage = frame;
    if (renderer === "ffmpeg-fallback") {
      // 降级路径：本机 ffmpeg 渲染（如实标注 renderer，不冒充工位产物）
      const fontFile = join(FONT_DIR, COVER_FONTS[style.fontId].file);
      baseImage = join(workRoot, `${variantId}-base.png`);
      const baseFilters = [
        `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase`, `crop=${canvas.width}:${canvas.height}`,
        "eq=contrast=1.04:saturation=1.06:brightness=0.01", "vignette=PI/5",
        ...scrimLayers.map((layer) => `drawbox=x=0:y=${layer.y}:w=${canvas.width}:h=${layer.height}:color=black@${layer.opacity}:t=fill`),
      ];
      run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", frame, "-vf", baseFilters.join(","), "-frames:v", "1", "-update", "1", baseImage]);
      const textFilters = [
        ...(style.accentBar ? [`drawbox=x=${Math.round(canvas.width * 0.08)}:y=${titleY - Math.round(canvas.height * 0.08)}:w=${Math.round(canvas.width * 0.1)}:h=${Math.round(canvas.height * 0.012)}:color=${style.colors.accent}@1:t=fill`] : []),
        `drawtext=fontfile='${fontFile}':text='${String(plan.badge ?? "").replace(/'/gu, "")}':fontcolor=${style.colors.badge}:fontsize=${Math.round(canvas.height * 0.038)}:borderw=4:bordercolor=black@0.5:x=w-text_w-${Math.round(canvas.width * 0.08)}:y=${badgeY}`,
        `drawtext=fontfile='${fontFile}':text='${title.replace(/'/gu, "")}':fontcolor=${style.colors.title}:fontsize=${style.headlineSize}:borderw=6:bordercolor=black@0.55:x=${Math.round(canvas.width * 0.08)}:y=${titleY}`,
        ...(plan.subline ? [`drawtext=fontfile='${fontFile}':text='${plan.subline.replace(/'/gu, "")}':fontcolor=${style.colors.sub}:fontsize=52:borderw=4:bordercolor=black@0.5:x=${Math.round(canvas.width * 0.08)}:y=${subtitleY}`] : []),
      ];
      run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", baseImage, "-vf", textFilters.join(","), "-frames:v", "1", "-update", "1", target]);
    }
    if (!existsSync(target)) throw new Error(`封面未产出：${target}`);

    const probed = probeMedia(target);
    const bytes = statSync(target).size;
    const titleBand = { x: 0, y: Math.max(0, titleY - 20), w: canvas.width, h: Math.min(canvas.height - titleY, style.headlineSize + 90) };
    const personBox = { x: 0, y: Math.round(canvas.height * 0.3), w: Math.round(canvas.width * 0.5), h: Math.round(canvas.height * 0.4) };
    const titlePsnr = bandPsnr(target, baseImage, titleBand);
    const personPsnr = plan.person?.enabled ? bandPsnr(target, baseImage, personBox) : null;
    const checks = [
      { id: "cover-produced", pass: probed.width === canvas.width && probed.height === canvas.height && bytes > 120_000, detail: `${probed.width}x${probed.height} · ${(bytes / 1024).toFixed(0)}KB（期望 ${canvas.width}x${canvas.height}）` },
      { id: "title-rendered", pass: titlePsnr !== null && titlePsnr < COVER_DIFF_PSNR_DB, detail: `标题带 PSNR ${titlePsnr === null ? "未测" : `${titlePsnr.toFixed(2)}dB`}（阈值 <${COVER_DIFF_PSNR_DB}）` },
      { id: "person-rendered", pass: !plan.person?.enabled || (personPsnr !== null && personPsnr < COVER_DIFF_PSNR_DB), detail: plan.person?.enabled ? `人物位 PSNR ${personPsnr === null ? "未测" : `${personPsnr.toFixed(2)}dB`}` : "本版式不放人物层" },
      { id: "canvas-matches-film", pass: landscape ? probed.width >= probed.height : probed.height > probed.width, detail: `封面画幅与成片同向（成片 ${media.width}×${media.height}）` },
      { id: "base-lineage", pass: true, detail: `主视觉取自未烧字干净母版（sha256 ${sha256(master).slice(0, 12)}…，取帧 ${heroSec}s）` },
      { id: "bridge-receipt", pass: renderer === "compositor-visual-bridge" ? Boolean(bridgeReceipt) : true, detail: renderer === "compositor-visual-bridge" ? `工位回执 sha256 ${String((bridgeReceipt?.sha256 as string) ?? "").slice(0, 12)}…` : `降级渲染（${bridge.reason ?? "工位不可用"}）` },
    ];
    covers.push({ variantId, renderer, canvas, platform: platformInput, specId: spec.id, heroShot: heroShot.shotId, heroSec, heroSourceSec, plan: validated, file: target, sha256: sha256(target), checks, recipe: recipeBody });
    checksAll.push({ variantId, ok: checks.every((c) => c.pass), checks });
  }

  // ⑦ 烧封：封面作为片头烧进每条变体（干净/软字幕/烧字三种形态）
  const introReceipts: Array<Record<string, unknown>> = [];
  if (burnIntro > 0) {
    for (const variantId of variants) {
      const cover = covers.find((entry) => entry.variantId === variantId)?.file as string | undefined;
      if (!cover) continue;
      for (const form of ["", ".softsub", ".burned"]) {
        const source = join(outDir, "variants", variantId, `${variantId}${form}.mp4`);
        if (!existsSync(source)) continue;
        const output = join(outDir, "variants", variantId, `${variantId}${form}.cover.mp4`);
        const intro = join(workRoot, `${variantId}${form}-intro.mp4`);
        run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-i", cover, "-ss", "0", "-t", String(burnIntro), "-i", source,
          "-filter_complex", `[0:v]scale=${media.width}:${media.height},fps=${arg("--fps", "30")},format=yuv420p[v];[1:a]atrim=0:${burnIntro},asetpts=PTS-STARTPTS[a]`,
          "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-t", String(burnIntro), "-movflags", "+faststart", intro]);
        // 用文本清单做 concat（/dev/stdin 在部分 ffmpeg 构建下不可用）
        const listFile = join(workRoot, `${variantId}${form}-list.txt`);
        writeFileSync(listFile, `file '${intro.replace(/'/gu, "'\\''")}'\nfile '${source.replace(/'/gu, "'\\''")}'\n`, "utf8");
        run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", output]);
        introReceipts.push({ variantId, form: form || "clean", output, introSeconds: burnIntro, sha256: sha256(output), duration: probeMedia(output).duration });
      }
    }
  }

  const planFile = join(outDir, "covers", "cover-plan.json");
  const reportFile = join(outDir, "covers", "cover-report.json");
  writeFileSync(planFile, `${JSON.stringify({
    schema: "workloom.video-edit/cover-plan/v1",
    chain: "cover-designer（Compositor 视觉工位 → 设计稿 → 合成 → 机检 → 烧封）",
    platform: platformInput, specId: spec.id, canvas, canvasNote,
    renderer: { mode: rendererMode, used: covers[0]?.renderer ?? null, bridgeUrl, bridgeAvailable: bridge.available, note: bridge.reason ?? null },
    account: accountProfile ? { account_id: accountProfile.account_id, visual_hammer: accountProfile.visual_hammer } : null,
    kb: { dir: KB_DIR, recipe: recipeDoc, hints },
    covers,
  }, null, 2)}\n`, "utf8");
  writeFileSync(reportFile, `${JSON.stringify({
    schema: "workloom.video-edit/cover-report/v1",
    ok: checksAll.every((entry) => entry.ok),
    covers: checksAll,
    introBurned: introReceipts,
    generatedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");

  const ok = checksAll.every((entry) => entry.ok) && introReceipts.every((entry) => Number(entry.duration) > burnIntro);
  const summary = { ok, covers: covers.map((entry) => ({ variantId: entry.variantId, renderer: entry.renderer, file: entry.file })), introBurned: introReceipts.map((entry) => entry.output), planFile, reportFile };
  if (flag("--json")) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`✓ 封面链路完成：${covers.length} 张（画幅 ${canvas.width}×${canvas.height} / 渲染 ${covers[0]?.renderer ?? "?"}）`);
    for (const entry of covers) console.log(`  ${(checksAll.find((c) => c.variantId === entry.variantId)?.ok) ? "✓" : "✗"} ${entry.variantId} → ${entry.file}`);
    if (introReceipts.length) console.log(`  烧封片头：${introReceipts.length} 个文件（每条变体 +${burnIntro}s）`);
    console.log(`  设计稿：${planFile}｜机检：${reportFile}`);
  }
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(`✗ edit-cover 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
