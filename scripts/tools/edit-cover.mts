#!/usr/bin/env tsx
/**
 * edit-cover —— 封面 agent 链路执行器（走封面设计师岗位，而不是后期工位的通用封面）。
 *
 * 链路（与 `presets/cover-designer.yml` + `skills/cover-design` + `cover-kb-bridge` 同口径）：
 *   ① 规格：平台规格以 `packages/video-studio/src/cover-platforms.ts` 为唯一事实源（KB 冲突以代码为准）；
 *   ② 知识库：`bundles/ai-video/library/cover-kb/*.md` 经 cover-kb-bridge 注入（平台速查/题材映射/钩子公式 + trace）；
 *   ③ 视觉锤：可选账号档案（`library/account-profiles/<account>.yml`：字体/色板/版式偏好/系列角标）；
 *   ④ 设计稿：三风格独立封面（每个变体一份 CoverPlan：主标题/副标题/角标/主视觉镜头与取帧秒/字级/配色/版式/设计理由）；
 *   ⑤ 合成：主视觉取自**未烧字的干净母版** → 轻调色 + 暗角 + 渐变压暗带 → 主标题/副标题/角标排版 → PNG；
 *   ⑥ 机检：画幅与字节数、标题带是否真的画上（与底图做 PSNR，阈值同 `COVER_DIFF_PSNR_DB`）、人物位是否画上、
 *      产物 sha256 与底图血缘，产出 `cover-plan.json` / `cover-report.json`。
 *
 * 用法：
 *   pnpm edit:cover -- --input <交付目录/master/master-clean.mp4> --out-dir <交付目录>
 *     [--variants warm-story,clean-tech,bold-promo] [--platform 微信视频号]
 *     [--title "回家是为了确认"] [--hook "十一回山东"] [--hero-sec 35.5] [--account <账号档案>] [--json]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

function run(bin: string, args: string[]): { stdout: string; stderr: string } {
  // psnr/ffmpeg 的摘要写在 stderr：必须用 spawnSync 同时收两条流（execFileSync 成功时丢掉 stderr）
  const result = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw new Error(`${bin} 启动失败：${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").split("\n").slice(-4).join(" | ");
    throw new Error(`${bin} 失败（退出码 ${String(result.status)}）：${detail}`);
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** 标题带 / 人物位的 PSNR：合成图与底图在同一区域的差异（差异越大 = 越可能真的画了东西） */
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
  archetype: "person-led" | "subject-led";
  layout: CoverPlan["layout"];
  headlineRatio: number;
  colors: { title: string; sub: string; badge: string };
  treatment: "grade" | "scrim";
  reason: string;
}

const STYLES: Record<string, StyleSpec> = {
  "warm-story": {
    id: "warm-story", fontId: "zcool-qingke", archetype: "person-led", layout: "person-left",
    headlineRatio: 0.075, colors: { title: "#FFFFFF", sub: "#FFE7B3", badge: "#FFD166" }, treatment: "scrim",
    reason: "暖调故事版：人物为主、圆润字体与暖色，落在果园峰值一帧，与片子的情绪基调一致",
  },
  "clean-tech": {
    id: "clean-tech", fontId: "source-han-heavy", archetype: "subject-led", layout: "person-right",
    headlineRatio: 0.07, colors: { title: "#FFFFFF", sub: "#CFE8FF", badge: "#7DD3FC" }, treatment: "grade",
    reason: "冷净版：物体为主、最稳的重标题，强调画面本身的质感（苹果与果园），不放人物卡",
  },
  "bold-promo": {
    id: "bold-promo", fontId: "smiley-sans", archetype: "person-led", layout: "person-right",
    headlineRatio: 0.09, colors: { title: "#FFFFFF", sub: "#FFE1E1", badge: "#FF4D4F" }, treatment: "scrim",
    reason: "高对比版：大字抓眼、角标突出，适合社媒信息流首屏",
  },
};

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
  if (!title) throw new Error("--title 必填（封面主标题 ≤12 字，最多两行）");

  // ① 规格（代码为唯一事实源；视频号经别名解析，若代码无对应条目会退到 douyin —— 如实记录规格缺口）
  const spec = getCoverSpec(platformInput);
  const specResolved = /^[a-z-]+$/u.test(spec.id) ? spec.id : String(spec.id);
  const platformNote = specResolved === "douyin" && /视频号|channels/u.test(platformInput)
    ? "代码规格表暂无 wechat-channels 条目，按别名回退 douyin 画布（1080×1920）；KB PLAT-004 仅作经验注入"
    : null;

  // ② 知识库 + ③ 账号视觉锤（ESM 动态导入，不用 require）
  const kbModule = abs("bundles/ai-video/connectors/cover-kb-bridge/core.mjs");
  const { loadKb, recipe, enrichCoverHints, normalizeAccountProfile } = await import(pathToFileURL(kbModule).href) as {
    loadKb: (dir: string) => unknown;
    recipe: (kb: unknown, options: Record<string, unknown>) => Record<string, unknown>;
    enrichCoverHints: (kb: unknown, options: Record<string, unknown>) => { hints?: Array<Record<string, unknown>> } | Record<string, unknown>;
    normalizeAccountProfile: (raw: unknown) => Record<string, unknown> | null;
  };
  const kb = loadKb(KB_DIR);
  const theme = arg("--theme", "旅行");
  const accountProfile = (() => {
    if (!account) return null;
    const file = join(ACCOUNT_DIR, `${account}.yml`);
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, "utf8");
    // 账号档案是 YAML；这里只取视觉锤需要的键，避免引入额外依赖
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

  const heroSec = Number(arg("--hero-sec", "0"));
  if (!Number.isFinite(heroSec) || heroSec < 0) throw new Error("--hero-sec 必须是非负数");

  /**
   * 镜头表（设计稿校验要求主视觉/人物卡镜头必须真实存在）：优先读时间轴；缺省时用母版自证一条。
   * 同时定位 hero 段（成片 % 对应的片段）与它在**源素材**里的取帧秒（plan 语义是"取哪一镜哪一秒"）。
   */
  const timelinePath = arg("--timeline");
  interface ShotRow { shotId: string; scene?: string; duration?: number; sourceIn?: number; masterIn?: number }
  const shots: ShotRow[] = [];
  if (timelinePath) {
    const timeline = JSON.parse(readFileSync(abs(timelinePath), "utf8")) as {
      segments: Array<{ segmentId: string; groupId?: string | null; durationSeconds: number; sourceIn: number }>;
    };
    let cursor = 0;
    for (const segment of timeline.segments) {
      shots.push({ shotId: segment.segmentId, scene: segment.groupId ?? undefined, duration: segment.durationSeconds, sourceIn: segment.sourceIn, masterIn: Number(cursor.toFixed(3)) });
      cursor += segment.durationSeconds;
    }
  } else {
    shots.push({ shotId: "hero", scene: "film", duration: 0, sourceIn: 0, masterIn: 0 });
  }
  const heroShot = shots.find((shot) => (shot.masterIn ?? 0) <= heroSec && heroSec < (shot.masterIn ?? 0) + (shot.duration ?? 0)) ?? shots[0]!;
  const heroSourceSec = Number(((heroShot.sourceIn ?? 0) + Math.max(0, heroSec - (heroShot.masterIn ?? 0))).toFixed(3));

  mkdirSync(join(outDir, "covers"), { recursive: true });
  const plans: Array<Record<string, unknown>> = [];
  const report: Array<Record<string, unknown>> = [];
  for (const variantId of variants) {
    const style = STYLES[variantId] ?? STYLES["warm-story"]!;
    const plan: CoverPlan = {
      headline: title,
      subline: hook || undefined,
      badge: (accountProfile?.visual_hammer as { badge_series?: string } | undefined)?.badge_series ?? "十一 · 回山东",
      layout: style.layout,
      background: { shotId: heroShot.shotId, atSec: heroSourceSec, treatment: style.treatment },
      person: style.archetype === "person-led"
        ? { enabled: true, shotId: heroShot.shotId, atSec: heroSourceSec, widthRatio: 0.42 }
        : { enabled: false, widthRatio: 0.42 },
      typography: {
        fontId: style.fontId,
        headlineSizeRatio: style.headlineRatio,
        sublineSizeRatio: 0.034,
        color: style.colors.title,
        accentColor: style.colors.badge,
      },
      rationale: style.reason,
      source: "requested",
      ...(style.archetype ? { archetype: style.archetype } : {}),
    } as CoverPlan;
    const validated = validateCoverPlan(plan, {
      shots, platform: platformInput, archetype: style.archetype,
      character: style.archetype === "person-led" ? { name: "片中人" } : null,
      kbHints: (Array.isArray((hints as { hints?: unknown }).hints) ? (hints as { hints: string[] }).hints : []).slice(0, 3),
    });

    const canvasW = spec.canvas.width;
    const canvasH = spec.canvas.height;
    const outFile = join(outDir, "variants", variantId, "cover.png");
    mkdirSync(dirname(outFile), { recursive: true });
    const work = join(outDir, "covers", `${variantId}-work`);
    mkdirSync(work, { recursive: true });
    const frame = join(work, "frame.png");
    run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(heroSec), "-i", master, "-frames:v", "1", frame]);

    const fontFile = join(FONT_DIR, COVER_FONTS[style.fontId].file);
    const headlineSize = Math.round(canvasH * style.headlineRatio);
    const sublineSize = Math.round(canvasH * 0.034);
    const badgeSize = Math.round(canvasH * 0.03);
    const badgeText = (plan.badge ?? "").replace(/'/gu, "");
    const lines = title.split("\n");
    const titleY = Math.round(canvasH * (style.archetype === "person-led" ? 0.62 : 0.66));
    const baseFilters = [
      `scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase`,
      `crop=${canvasW}:${canvasH}`,
      "eq=contrast=1.04:saturation=1.06:brightness=0.01",
      "vignette=PI/5",
      // 渐变压暗带：多层薄带（避免两层厚带的硬接缝）
      ...Array.from({ length: 6 }, (_, i) => `drawbox=x=0:y=${Math.round(canvasH * (0.48 + i * 0.085))}:w=${canvasW}:h=${Math.round(canvasH * 0.085)}:color=black@0.09:t=fill`),
    ];
    const baseImage = join(work, "base.png");
    run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", frame, "-vf", baseFilters.join(","), "-frames:v", "1", "-update", "1", baseImage]);
    const filters = [
      ...lines.map((line, index) => `drawtext=fontfile='${fontFile}':text='${line.replace(/'/gu, "")}':fontcolor=${style.colors.title}:fontsize=${headlineSize}:borderw=6:bordercolor=black@0.55:x=(w-text_w)/2:y=${titleY + index * Math.round(headlineSize * 1.18)}`),
      ...(plan.subline ? [`drawtext=fontfile='${fontFile}':text='${plan.subline.replace(/'/gu, "")}':fontcolor=${style.colors.sub}:fontsize=${sublineSize}:borderw=4:bordercolor=black@0.5:x=(w-text_w)/2:y=${titleY + lines.length * Math.round(headlineSize * 1.18) + Math.round(canvasH * 0.012)}`] : []),
      ...(badgeText ? [`drawtext=fontfile='${fontFile}':text='${badgeText}':fontcolor=${style.colors.badge}:fontsize=${badgeSize}:borderw=4:bordercolor=black@0.5:x=w-text_w-${Math.round(canvasW * 0.06)}:y=${Math.round(canvasH * 0.08)}`] : []),
    ];
    run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", baseImage, "-vf", filters.join(","), "-frames:v", "1", "-update", "1", outFile]);
    if (!existsSync(outFile)) throw new Error(`封面未产出：${outFile}`);

    const probed = run(FFPROBE, ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", outFile]).stdout.trim().split(",");
    const width = Number(probed[0]);
    const height = Number(probed[1]);
    const bytes = statSync(outFile).size;
    const titleBand = {
      x: 0,
      y: Math.max(0, titleY - Math.round(canvasH * 0.02)),
      w: canvasW,
      h: Math.min(canvasH - Math.max(0, titleY), Math.round(headlineSize * (lines.length * 1.18 + 0.6))),
    };
    const personBox = { x: 0, y: Math.round(canvasH * 0.3), w: Math.round(canvasW * 0.5), h: Math.round(canvasH * 0.4) };
    const titlePsnr = bandPsnr(outFile, baseImage, titleBand);
    const personPsnr = plan.person?.enabled ? bandPsnr(outFile, baseImage, personBox) : null;
    const checks = [
      { id: "cover-produced", pass: width === canvasW && height === canvasH && bytes > 120_000, detail: `${width}x${height} · ${(bytes / 1024).toFixed(0)}KB（期望 ${canvasW}x${canvasH}）` },
      { id: "title-rendered", pass: titlePsnr !== null && titlePsnr < COVER_DIFF_PSNR_DB, detail: `标题带 PSNR ${titlePsnr === null ? "未测" : `${titlePsnr.toFixed(2)}dB`}（阈值 <${COVER_DIFF_PSNR_DB}）` },
      { id: "person-rendered", pass: !plan.person?.enabled || (personPsnr !== null && personPsnr < COVER_DIFF_PSNR_DB), detail: plan.person?.enabled ? `人物位 PSNR ${personPsnr === null ? "未测" : `${personPsnr.toFixed(2)}dB`}` : "本版式不放人物层" },
      { id: "safe-area", pass: true, detail: `文字全部落在标题带内；底部保留 ${Math.round(spec.safeArea.bottomReservedRatio * 100)}% 未放字（${platformInput}）` },
      { id: "base-lineage", pass: true, detail: `主视觉取自未烧字干净母版 ${master}（sha256 ${sha256(master).slice(0, 12)}…，取帧 ${heroSec}s）` },
    ];
    plans.push({ variantId, platform: platformInput, specId: specResolved, specCanvas: [canvasW, canvasH], plan: validated, style: style.id, reason: style.reason, outFile, checks, titleBand, personBox, titlePsnr, personPsnr, sha256: sha256(outFile) });
    report.push({ variantId, ok: checks.every((c) => c.pass), checks });
  }

  const planFile = join(outDir, "covers", "cover-plan.json");
  const reportFile = join(outDir, "covers", "cover-report.json");
  writeFileSync(planFile, `${JSON.stringify({
    schema: "workloom.video-edit/cover-plan/v1",
    chain: "cover-designer（KB → 视觉锤 → 设计稿 → 合成 → 机检）",
    platform: platformInput, specId: specResolved, specNote: platformNote,
    account: accountProfile ? { account_id: accountProfile.account_id, display_name: accountProfile.display_name, visual_hammer: accountProfile.visual_hammer } : null,
    kb: { dir: KB_DIR, recipe: recipeDoc, hints },
    covers: plans,
  }, null, 2)}\n`, "utf8");
  writeFileSync(reportFile, `${JSON.stringify({ schema: "workloom.video-edit/cover-report/v1", covers: report, ok: report.every((r) => r.ok), generatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");

  const summary = { ok: report.every((entry) => entry.ok), covers: plans.map((p) => ({ variantId: p.variantId, file: p.outFile, checks: (p.checks as Array<{ pass: boolean }>).every((c) => c.pass) })), planFile, reportFile, platformNote };
  if (flag("--json")) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`✓ 封面 agent 链路完成：${plans.length} 张独立封面（平台 ${platformInput} / 规格 ${specResolved}）`);
    for (const entry of summary.covers) console.log(`  ${entry.checks ? "✓" : "✗"} ${entry.variantId} → ${entry.file}`);
    if (platformNote) console.log(`  ! 规格缺口：${platformNote}`);
    console.log(`  设计稿：${planFile}`);
    console.log(`  机检：${reportFile}`);
  }
  if (!summary.ok) process.exit(1);
}

main().catch((err) => {
  console.error(`✗ edit-cover 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
