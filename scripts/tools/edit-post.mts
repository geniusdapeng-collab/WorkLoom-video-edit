#!/usr/bin/env tsx
/**
 * edit-post —— 把「视频AI剪辑」的成片**交回 AI 视频既有后期链路**执行正式后期。
 *
 * 分工（这是 2026-10-10 复盘后的口径修正）：
 *   · `edit:assemble` = 本地粗剪：逐段裁切 + 归一化 + 拼接，产出"画面母版"，用于快速预览与迭代；
 *   · `edit:post`     = 正式后期：调用 **post-bridge（既有后期工位）**，一次产出——
 *                     干净母版 → 旁挂字幕/弹幕轨（srt/ass/vtt + 清单）→ 逐变体调色（LUT 配方）
 *                     → 逐变体配乐（曲库 + 让位 + 响度）→ 逐变体封面 + 文案包 → 软字幕轨版
 *                     → 交付清单 + 工程文件（film-project.json，供本地返修）。
 *
 * 为什么必须有这一步（事故复盘）：粗剪直接当交付，等于绕过了调色/封面/多风格/字幕交付规范，
 * 片子看起来"就是素材拼起来"。剪辑管线的价值是"把素材看懂并重组"，**交付质量仍然依赖既有后期链路**。
 *
 * 用法：
 *   pnpm edit:post -- --timeline <film.timeline.json> --out-dir <交付目录>
 *     [--variants warm-story,clean-tech,bold-promo] [--subtitle <字幕.srt>]
 *     [--analysis <probe.json>]…（封面自动取帧与分段调色投票用）
 *     [--title "标题"] [--hook "一句话钩子"] [--platform "微信视频号"]
 *     [--width <显式宽> --height <显式高>] [--fps 30] [--crf 16] [--burn-subtitles] [--json]
 *     [--transitions hard|pack|declared|auto] [--transitions-easing native|smooth]
 *     [--transition-pack documentary|vlog|fast_cut|information]
 *   输出分辨率默认**跟随素材原生分辨率**（取与目标画幅一致的最大素材档位；4K 素材 → 3840×2160，
 *   清晰度档随之推导为 uhd），只有显式 `--width/--height` 才覆盖——不允许管线自行降低分辨率（2026-10-11 产品所有者口径）。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  describeReframePlan, describeTransitionPlan, planAssembly, planCoverMoment, planSegmentColor, planToPerCut, planTransitions,
  resolveTimelineSourcePaths, validateEditTimeline, type EditTimeline, type PostAnalysisDoc,
} from "../../packages/video-studio/src/edit/index.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const FFMPEG = process.env.WL_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.WL_FFPROBE ?? "ffprobe";

const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

function run(bin: string, args: string[], env?: NodeJS.ProcessEnv): void {
  try {
    execFileSync(bin, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...(env ? { env } : {}) });
  } catch (err) {
    const failure = err as { stderr?: string; message?: string };
    const detail = (failure.stderr || failure.message || "").toString().split("\n").slice(-6).join(" | ");
    throw new Error(`${bin} 执行失败：${detail}`);
  }
}

/** 素材原生分辨率探测（输出分辨率默认跟随素材，避免把 4K 素材降成 1080p）。 */
function probeVideoSize(file: string): { width: number; height: number } | null {
  try {
    const out = execFileSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8" }).trim();
    const [w, h] = out.split(",").map((value) => Number(value.trim()));
    return Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 ? { width: w, height: h } : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const timelinePath = arg("--timeline");
  const outDirArg = arg("--out-dir");
  if (!timelinePath || !outDirArg) {
    throw new Error("用法：pnpm edit:post -- --timeline <film.timeline.json> --out-dir <交付目录>");
  }
  const timelineFile = abs(timelinePath);
  if (!existsSync(timelineFile)) throw new Error(`时间轴不存在：${timelineFile}`);
  const outDir = abs(outDirArg);

  /**
   * `--clean`：清理上一次**失败**的交付目录（只在没有 delivery-manifest.json 时允许）。
   * 为什么需要：post-bridge 的产物写入用独占创建（`wx`），失败重试会被残留文件挡住；
   * 已完成的交付目录（有清单）一律拒绝清理——那是成果，不许覆盖。
   */
  if (flag("--clean")) {
    const manifest = join(outDir, "delivery-manifest.json");
    if (existsSync(manifest)) {
      throw new Error(`交付目录已完成（存在 delivery-manifest.json）：${outDir}；如需返修请改用新版本目录`);
    }
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });

  const timeline = resolveTimelineSourcePaths(
    JSON.parse(readFileSync(timelineFile, "utf8")) as EditTimeline,
    dirname(timelineFile),
  );
  const validation = validateEditTimeline(timeline);
  if (!validation.ok) {
    const failed = validation.checks.filter((c) => c.hard && !c.pass).map((c) => `${c.id}：${c.detail}`);
    throw new Error(`时间轴未通过契约校验，拒绝进入后期（${failed.length} 项硬失败）：\n  - ${failed.join("\n  - ")}`);
  }

  /**
   * 素材解析结果（`--analysis <probe.json>`，可重复）：供两条自动决策使用——
   *   · 封面取帧：优先吃关键帧候选（composition_best / emotion_peak）；
   *   · 分段调色：吃镜头理解的调色建议/场景类型/情绪效价。
   * 不传也能跑（回退配方默认），但会把 `--segment-color` 降级为关键词投票。
   */
  const analyses: PostAnalysisDoc[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === "--analysis" && process.argv[index + 1]) {
      const file = abs(process.argv[index + 1]!);
      if (!existsSync(file)) throw new Error(`解析结果不存在：${file}`);
      analyses.push(JSON.parse(readFileSync(file, "utf8")) as PostAnalysisDoc);
    }
  }

  /**
   * 输出分辨率口径（2026-10-11 产品所有者）：**默认跟随素材原生分辨率**——取与目标画幅一致、
   * 面积最大的素材档位（4K 素材默认输出 3840×2160，不再由管线"自行降低分辨率"）；
   * 只有显式传 `--width/--height` 才覆盖。素材探测不到时退回 1920×1080 并在回执里如实标注。
   */
  const explicitWidth = arg("--width", "");
  const explicitHeight = arg("--height", "");
  const sourceSizes = (timeline.sources ?? []).map((source) => {
    /** 时间轴源字段是 `path`（EditTimelineSource）；兼容历史 `file` 写法。 */
    const rawPath = String((source as { path?: string }).path ?? (source as { file?: string }).file ?? "");
    const file = rawPath ? abs(rawPath) : "";
    const size = file && existsSync(file) ? probeVideoSize(file) : null;
    return { sourceId: source.sourceId, file, width: size?.width ?? null, height: size?.height ?? null };
  });
  let width: number;
  let height: number;
  let resolutionPolicy: string;
  if (explicitWidth && explicitHeight) {
    width = Number(explicitWidth);
    height = Number(explicitHeight);
    resolutionPolicy = "explicit（调用方显式指定，尊重指定值）";
  } else {
    const targetAspect = (() => {
      const raw = String(timeline.target?.aspectRatio ?? "");
      const [a, b] = raw.split(":").map((value) => Number(value));
      return Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0 ? a / b : null;
    })();
    const usable = sourceSizes.filter((entry) => entry.width && entry.height);
    const matching = targetAspect
      ? usable.filter((entry) => Math.abs(entry.width! / entry.height! - targetAspect) < 0.05)
      : usable;
    const pool = matching.length > 0 ? matching : usable;
    const best = [...pool].sort((a, b) => (b.width! * b.height!) - (a.width! * a.height!))[0];
    if (best) {
      width = best.width!;
      height = best.height!;
      resolutionPolicy = `source-max（${best.sourceId} ${best.width}×${best.height}）`;
    } else {
      width = 1920;
      height = 1080;
      resolutionPolicy = "fallback-1080p（素材不可探测）";
    }
  }
  const fps = Number(arg("--fps", String(timeline.target?.fps ?? 30)));
  const crf = Number(arg("--crf", "16"));
  /** 清晰度档位随分辨率推导：4K 级默认 uhd，其余 hd；显式 `--quality` 优先。 */
  const qualityArg = arg("--quality", "");
  const quality = qualityArg || (Math.min(width, height) >= 2160 ? "uhd" : "hd");
  if (!["hd", "uhd"].includes(quality)) throw new Error(`--quality 只接受 hd / uhd（收到：${quality}）`);
  console.log(`分辨率：${width}×${height}（${resolutionPolicy}）· 清晰度档 ${quality} · ${fps}fps`);
  const variants = arg("--variants", "warm-story,clean-tech,bold-promo").split(",").map((v) => v.trim()).filter(Boolean);
  /**
   * 转场口径（2026-10-11 升级为四档）：
   *   · hard（默认，产品所有者 2026-10-10 口径）：全部硬切；
   *   · pack：沿用变体配方里的整段转场（legacy 兼容：warm-story=fade 经黑场、clean-tech=hard、bold-promo=xfade）；
   *   · declared：只渲染剪辑脚本声明的 `transitionIn`（未声明处硬切）；
   *   · auto：声明优先 + 场景组切换处按节奏档案自动补（叙事片推荐；组内保持硬切）。
   * declared/auto 的计划由 `packages/video-studio/src/edit/transitions.ts` 纯函数产出，
   * 交给 post-bridge 逐刀渲染（变体配方再用 intentMap 决定各风格的观感）。
   */
  const transitionsMode = (() => {
    const value = arg("--transitions", "hard");
    if (value !== "hard" && value !== "pack" && value !== "declared" && value !== "auto") {
      throw new Error("--transitions 只接受 hard / pack / declared / auto");
    }
    return value;
  })();
  const transitionsEasing = (() => {
    const value = arg("--transitions-easing", "native");
    if (value !== "native" && value !== "smooth") throw new Error("--transitions-easing 只接受 native / smooth");
    return value;
  })();
  const transitionPack = arg("--transition-pack", timeline.pacing?.profile ?? "documentary");
  const transitionPlan = transitionsMode === "declared" || transitionsMode === "auto"
    ? planTransitions({
      segments: (timeline.segments ?? []).map((segment) => ({
        segmentId: segment.segmentId,
        groupId: segment.groupId ?? null,
        durationSeconds: segment.durationSeconds,
        transitionIn: segment.transitionIn ?? null,
        motive: segment.motive ?? null,
      })),
      mode: transitionsMode,
      pack: transitionPack as Parameters<typeof planTransitions>[0]["pack"],
      pacing: timeline.pacing ?? null,
      fps: timeline.target?.fps ?? 30,
      easing: transitionsEasing,
    })
    : null;
  if (transitionPlan) {
    for (const line of describeTransitionPlan(transitionPlan)) console.log(line);
  }
  /**
   * 分段调色（`--segment-color`）：把"家里暖 / 城市冷"落到**片段级**，而不是全片一个 LUT。
   * 做法：先按时间轴的场景组给每段预调色（warm-film / cool-technical，带强度混合），再交给后期装配；
   * 同时生成一个 `segmented-story` 变体配方（关掉变体自带的统一调色，避免二次调色），随本次交付一起出。
   */
  const segmentColor = flag("--segment-color");
  /**
   * 配乐 agent（`--bgm agent`）：把"选曲"交给配乐岗，而不是让变体配方按风格名随手取一首。
   * 流程：① 给本地大曲库（`--bgm-pack`，默认 ~/Downloads/1200可商用纯音乐，按情绪/题材文件夹打标）
   * 生成 tracks.json 索引 → ② 用 bgm-bridge 的 findTracks 按变体风格匹配候选（许可必须可商用）
   * → ③ 选定曲目写进变体覆盖配方（bgm.trackId），后续混音仍由配乐工位执行与复检。
   */
  const bgmAgent = arg("--bgm", "pack") === "agent";
  const bgmPack = abs(arg("--bgm-pack", join(homedir(), "Downloads/1200可商用纯音乐")));
  const bgmAgentReceipt: Array<Record<string, unknown>> = [];
  const subtitlePath = arg("--subtitle") ? abs(arg("--subtitle")) : null;
  if (subtitlePath && !existsSync(subtitlePath)) throw new Error(`字幕文件不存在：${subtitlePath}`);
  const platform = arg("--platform", timeline.target?.platform ?? "微信视频号");
  const title = arg("--title", timeline.filmId ?? timeline.timelineId);
  const hook = arg("--hook", "");

  /**
   * 二次构图（取景轨道，T-2026-1011-0008）：
   *   off（默认）= 完全沿用现状；declared = 渲染时间轴声明的 reframe/legacy punchIn；
   *   auto = 声明优先 + 未声明段落给确定性呼吸感微推（主体跟随要等 P1 分析站）。
   * 填充：pad（兼容）/cover（横转竖推荐）/blur/brand；预算：默认 1.5 上限，`budget` = 只做无损。
   */
  const reframeMode = arg("--reframe", "off");
  if (!["off", "declared", "auto"].includes(reframeMode)) throw new Error("--reframe 只接受 off / declared / auto");
  const reframeFill = arg("--reframe-fill", "pad");
  if (!["pad", "cover", "blur", "brand"].includes(reframeFill)) throw new Error("--reframe-fill 只接受 pad / cover / blur / brand");
  const reframeMaxZoomRaw = arg("--reframe-max-zoom", "1.5");
  const reframeMaxZoom: number | "budget" = reframeMaxZoomRaw === "budget" ? "budget" : Number(reframeMaxZoomRaw);
  if (reframeMaxZoom !== "budget" && (!Number.isFinite(reframeMaxZoom) || reframeMaxZoom < 1 || reframeMaxZoom > 3)) {
    throw new Error("--reframe-max-zoom 只接受 1–3 的数字或 budget（只做无损）");
  }
  const reframeEasingRaw = arg("--reframe-easing", "smooth");
  if (!["native", "smooth", "linear", "ease-in-out"].includes(reframeEasingRaw)) {
    throw new Error("--reframe-easing 只接受 native / smooth / linear / ease-in-out");
  }
  const reframeEasing = reframeEasingRaw === "native" ? "linear" : (reframeEasingRaw as "smooth" | "linear" | "ease-in-out");
  /** 全局一键推近（只作用于未声明 reframe 的段落）：`--reframe-scale 1.0,1.15` */
  const reframeScaleArg = arg("--reframe-scale", "");
  const reframeDefaultScale = reframeScaleArg
    ? (() => {
      const [from, to] = reframeScaleArg.split(",").map((value) => Number(value.trim()));
      if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error("--reframe-scale 格式：from,to（例 1.0,1.15）");
      return { from, to };
    })()
    : null;
  const sourceSizeBySourceId = new Map(sourceSizes
    .filter((entry) => entry.width && entry.height)
    .map((entry) => [entry.sourceId, { width: entry.width as number, height: entry.height as number }]));
  const reframeSourceSizes: Record<string, { width: number; height: number }> = {};
  for (const segment of timeline.segments ?? []) {
    const size = sourceSizeBySourceId.get(segment.sourceId);
    if (size) reframeSourceSizes[segment.segmentId] = size;
  }
  const reframeOptions = reframeMode === "off"
    ? null
    : { mode: reframeMode as "declared" | "auto", fill: reframeFill as "pad" | "cover" | "blur" | "brand", maxZoom: reframeMaxZoom, easing: reframeEasing, sourceSizes: reframeSourceSizes, defaultScale: reframeDefaultScale };

  // ① 逐段裁切：把时间轴的源轨 in/out 真正切出来，成为后期链路可以直接吃的一份"镜头清单"
  //    取景开启时改为**源分辨率预切**（preserveSource）：把 crop-first 留给 post-bridge，
  //    这样取景才能按变体调制、且从源像素开裁。
  const clipsDir = join(outDir, "clips");
  mkdirSync(clipsDir, { recursive: true });
  const plan = planAssembly(timeline, {
    workDir: clipsDir,
    outputPath: join(clipsDir, "concat.mp4"),
    width,
    height,
    fps,
    crf,
    reframe: reframeOptions,
    preserveSource: Boolean(reframeOptions),
  });
  if (plan.reframePlan && reframeMode !== "off") {
    for (const line of describeReframePlan(plan.reframePlan)) console.log(line);
  }
  const shots: Array<{ shotId: string; path: string; reframe?: Record<string, unknown> }> = [];
  for (const step of plan.normalize) {
    if (!existsSync(step.input)) throw new Error(`片段 ${step.segmentId} 的素材不在本地：${step.input}`);
    const target = join(clipsDir, `${step.segmentId}.mp4`);
    const args = [...step.args];
    args[args.length - 1] = target; // plan 里的输出名换成交付目录里的正式命名
    run(FFMPEG, args);
    if (!existsSync(target)) throw new Error(`片段 ${step.segmentId} 裁切后无产物`);
    shots.push({
      shotId: step.segmentId,
      path: target,
      ...(step.reframe ? { reframe: step.reframe as unknown as Record<string, unknown> } : {}),
    });
  }

  /**
   * 分段调色：按场景组"内容投票"给每段预调色（家里暖 / 城市冷），强度用 `blend(all_opacity)` 混合实现，
   * 调色只发生一次；配套的 `segmented-story` 变体配方已关闭统一 LUT，避免二次调色。
   *
   * 2026-10-11 升级：投票来源 = 镜头理解的 `editing.colorGradeBase` + sceneType + 情绪效价 + 组名/情绪关键词
   * （`packages/video-studio/src/edit/post-auto.ts`）；老的"场景1..4 → 固定 LUT"只作为显式覆盖保留，
   * 不再对任意项目生效。中性/证据不足的场景组**不叠加**统一调色（宁少不滥）。
   */
  const segmentColorNotes: Array<{ segmentId: string; groupId: string; lut: string | null; intensity: number; basis: string; sha256: string | null }> = [];
  if (segmentColor) {
    const lutDir = join(REPO_ROOT, "bundles/ai-video/library/luts");
    const availableLuts = readdirSync(lutDir).filter((file) => file.toLowerCase().endsWith(".cube"));
    const recipeDoc = JSON.parse(readFileSync(join(REPO_ROOT, "bundles/ai-video/library/color-recipes/recipes.json"), "utf8")) as { recipes?: Array<Record<string, unknown>> };
    const recipes = (recipeDoc.recipes ?? []).map((recipe) => ({
      id: String(recipe.id ?? ""),
      genre: recipe.genre ? String(recipe.genre) : undefined,
      scene: recipe.scene ? String(recipe.scene) : undefined,
      mood: recipe.mood ? String(recipe.mood) : undefined,
      profile: String(recipe.profile ?? ""),
      lut: String(recipe.lut ?? ""),
      intensity: Number(recipe.intensity ?? 0.7),
    })).filter((recipe) => recipe.id && recipe.profile && recipe.lut);
    /**
     * 显式覆盖仅保留给历史演示场景名（场景1..4）。
     * 新项目一律走内容投票；确需指定时用时间轴 groupId 命名或改造 `--color-map`（后续任务）。
     */
    const legacyGroupMap: Record<string, { lut: string; intensity: number }> = {
      "场景1": { lut: "look-warm-film.cube", intensity: 0.7 },
      "场景2": { lut: "look-warm-film.cube", intensity: 0.75 },
      "场景3": { lut: "look-warm-film.cube", intensity: 0.75 },
      "场景4": { lut: "look-cool-technical.cube", intensity: 0.6 },
    };
    const colorPlan = planSegmentColor({ timeline, analyses, recipes, availableLuts, legacyGroupMap });
    for (const warning of colorPlan.warnings) console.warn(`⚠ ${warning}`);
    const assignmentOf = new Map(colorPlan.assignments.map((entry) => [entry.segmentId, entry]));
    for (const [index, step] of plan.normalize.entries()) {
      const segment = timeline.segments[index]!;
      const assignment = assignmentOf.get(segment.segmentId);
      if (!assignment || !assignment.lut) {
        segmentColorNotes.push({
          segmentId: step.segmentId,
          groupId: segment.groupId ?? "",
          lut: null,
          intensity: 0,
          basis: assignment?.basis ?? "无调色计划（保持原色）",
          sha256: null,
        });
        continue;
      }
      const lutFile = join(lutDir, assignment.lut);
      if (!existsSync(lutFile)) throw new Error(`LUT 不存在：${lutFile}`);
      const target = join(clipsDir, `${step.segmentId}.mp4`);
      const graded = join(clipsDir, `${step.segmentId}.graded.mp4`);
      run(FFMPEG, [
        "-hide_banner", "-loglevel", "error", "-y", "-i", target,
        "-vf", `split=2[a][b];[b]lut3d=file=${lutFile}[b2];[a][b2]blend=all_mode=normal:all_opacity=${assignment.intensity},format=yuv420p`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "copy", graded,
      ]);
      renameSync(graded, target);
      const shot = shots.find((entry) => entry.shotId === step.segmentId);
      if (shot) shot.path = target;
      segmentColorNotes.push({
        segmentId: step.segmentId,
        groupId: segment.groupId ?? "",
        lut: assignment.lut,
        intensity: assignment.intensity,
        basis: assignment.basis,
        sha256: createHash("sha256").update(readFileSync(target)).digest("hex"),
      });
    }
  }

  // ② 交回既有后期链路：post-bridge 的 buildDeliveryPackage（本地工位，不联网、不烧额度）
  /**
   * 路径监狱：post-bridge 与它调用的三个工位（调色/字幕/配乐）**各有自己的白名单环境变量**，
   * 只设 post 的那一个会在"逐变体调色"一步被拒（实机教训：output 越出允许目录）。
   * 这里一次性把工作目录、交付目录与全部源素材目录加进四个白名单。
   */
  const jailRoots = [
    REPO_ROOT,
    outDir,
    /**
     * 配乐工位的本地曲库是"用户资产"，天然在仓外（~/Downloads/…、~/.workloom-bgm）：
     * 不把它加进 BGM 白名单时，`loadAllLocalTracks` 选出的曲目会被路径监狱拦下
     * （实机：bgmPath 越出允许目录），"本地 1034 首大库优先"实际不可用。
     */
    bgmPack,
    join(homedir(), ".workloom-bgm"),
    ...new Set(timeline.sources.map((source) => dirname(source.path))),
  ];
  for (const key of ["WORKLOOM_POST_ALLOWED_ROOTS", "WORKLOOM_COLOR_ALLOWED_ROOTS", "WORKLOOM_SUBTITLE_ALLOWED_ROOTS", "WORKLOOM_BGM_ALLOWED_ROOTS"]) {
    const existing = process.env[key]?.trim();
    process.env[key] = [existing, ...jailRoots].filter(Boolean).join(":");
  }
  process.env.WL_FFMPEG ??= FFMPEG;

  /**
   * 转场口径：`hard`（默认，产品所有者 2026-10-10 口径：叙事剪辑默认硬切）或 `pack`（用变体配方）。
   * 实现：复制三份变体配方到交付目录下的覆盖副本、改写 transitions，再交给 post-bridge 的
   * `WORKLOOM_POST_VARIANT_DIR`。**必须在动态 import 之前设置**——该模块在加载时解析这个环境变量。
   */
  if (transitionsMode === "hard") {
    const baseVariantDir = join(REPO_ROOT, "bundles/ai-video/library/style-variants");
    const overrideDir = join(outDir, "work", "variant-overrides");
    mkdirSync(overrideDir, { recursive: true });
    const index = JSON.parse(readFileSync(join(baseVariantDir, "index.json"), "utf8")) as { variants: Array<{ id: string; file: string }> };
    for (const entry of index.variants) {
      const pack = JSON.parse(readFileSync(join(baseVariantDir, entry.file), "utf8")) as Record<string, unknown>;
      pack.transitions = { mode: "hard", fadeSec: 0, note: "本片全部硬切（覆盖配方默认的叠化/交叉转场）" };
      writeFileSync(join(overrideDir, entry.file), `${JSON.stringify(pack, null, 2)}\n`, "utf8");
    }
    writeFileSync(join(overrideDir, "index.json"), `${JSON.stringify({ ...index, updatedAt: new Date().toISOString(), principle: "本片全部硬切（覆盖副本）" }, null, 2)}\n`, "utf8");
    process.env.WORKLOOM_POST_VARIANT_DIR = overrideDir;
  }
  if (bgmAgent) {
    const overrideDir = process.env.WORKLOOM_POST_VARIANT_DIR ?? join(outDir, "work", "variant-overrides");
    mkdirSync(overrideDir, { recursive: true });
    const libraryDir = join(homedir(), ".workloom-bgm", "library");
    mkdirSync(libraryDir, { recursive: true });
    const indexFile = join(libraryDir, "tracks.json");
    const packFolders = existsSync(bgmPack)
      ? readdirSync(bgmPack, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      : [];
    // 已有打标索引（工位本地 1034 首）一律不覆盖：只在缺失时从素材包快速建一份
    if (packFolders.length > 0 && !existsSync(indexFile)) {
      const tracks: Array<Record<string, unknown>> = [];
      for (const folder of packFolders) {
        const dir = join(bgmPack, folder);
        for (const file of readdirSync(dir)) {
          if (!/\.(m4a|mp3|wav|flac|aac)$/iu.test(file)) continue;
          const id = `${folder.replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, "-").toLowerCase()}-${file.replace(/\.[^.]+$/u, "").replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, "-").toLowerCase()}`.slice(0, 120);
          tracks.push({
            id, title: file.replace(/\.[^.]+$/u, ""), file: join(dir, file),
            style: folder, mood: folder, genre: folder, tags: [folder],
            license: "royalty-free",
            licenseNote: "产品所有者提供的可商用曲库包（按情绪/题材文件夹打标；逐曲上游许可文件未随包，按所有者声明登记）",
            source: "owner-provided-pack:~/Downloads/1200可商用纯音乐",
          });
        }
      }
      writeFileSync(indexFile, `${JSON.stringify({ schemaVersion: "workloom.bgm-library/v1", updatedAt: new Date().toISOString(), note: "由 edit:post --bgm agent 从本地打标曲库包生成", tracks }, null, 1)}\n`, "utf8");
    }
    process.env.WORKLOOM_BGM_LIBRARY_DIR = libraryDir;
    // 选曲器来自后期链路（本地优先/随仓兜底的排序已在那里实现）；此处按需导入，避免与后面的主 import 顺序耦合
    const bgmSelector = await import("../../bundles/ai-video/connectors/post-bridge/core.mjs") as unknown as {
      pickTrackForVariant: (pack: Record<string, unknown>, options?: Record<string, unknown>) => Record<string, unknown> | null;
    };
    const bgmCore = await import(`file://${abs("bundles/ai-video/connectors/bgm-bridge/core.mjs")}`) as {
      loadAllLocalTracks: (env?: NodeJS.ProcessEnv) => { total: number; sources: Array<{ kind: string; tracks: number; present: boolean }> };
      findTracks: (query: Record<string, unknown>, env?: NodeJS.ProcessEnv) => { track?: Record<string, unknown>; items?: Array<Record<string, unknown>> };
      licenseInfo: (license: unknown) => { key: string; commercialOk?: boolean; label?: string };
    };
    const inventory = bgmCore.loadAllLocalTracks(process.env);
    const styleToFolderKeyword: Record<string, string> = {
      "acoustic-warm": "Vlog-旅拍", "corporate-clean": "企业-宣传", "sports-hype": "卡点-节奏",
      "cinematic-build": "史诗-震撼", "festive-bright": "欢快-轻松", "ambient-calm": "安静-舒缓",
      "documentary-bed": "自然-特效", "tension-dark": "悲伤-负面", "lo-fi-chill": "安静-舒缓",
      "modern-pop": "欢快-轻松", "electronic-pulse": "卡点-节奏",
    };
    if (!existsSync(overrideDir)) {
      const baseVariantDir = join(REPO_ROOT, "bundles/ai-video/library/style-variants");
      const baseIndex = JSON.parse(readFileSync(join(baseVariantDir, "index.json"), "utf8")) as { variants: Array<{ id: string; file: string }> };
      for (const item of baseIndex.variants) copyFileSync(join(baseVariantDir, item.file), join(overrideDir, item.file));
      writeFileSync(join(overrideDir, "index.json"), `${JSON.stringify({ ...baseIndex, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
      process.env.WORKLOOM_POST_VARIANT_DIR = overrideDir;
    }
    const variantIndexFile = join(overrideDir, "index.json");
    const variantIndex = JSON.parse(readFileSync(variantIndexFile, "utf8")) as { variants: Array<{ id: string; file: string }> };
    for (const variantId of variants) {
      const entry = variantIndex.variants.find((item) => item.id === variantId);
      if (!entry) continue;
      const packFile = join(overrideDir, entry.file);
      const pack = JSON.parse(readFileSync(packFile, "utf8")) as Record<string, unknown>;
      const bgm = (pack.bgm ?? {}) as Record<string, unknown>;
      const style = String(bgm.style ?? "");
      const keyword = styleToFolderKeyword[style] ?? style;
      // 用后期链路的配乐选曲器（全量库风格匹配 + 许可复检 + 本地优先/随仓兜底），而不是自己按文件夹猜
      const picked = bgmSelector.pickTrackForVariant(pack, { env: process.env });
      if (!picked) {
        bgmAgentReceipt.push({ variantId, style, picked: null, reason: `曲库中未找到「${style}」可用候选（保持配方默认选曲）` });
        continue;
      }
      pack.bgm = { ...bgm, trackId: picked.id, selectionBy: "bgm-agent", selectionNote: `按风格「${style}」匹配本地打标曲库（由配乐选曲器在合并曲库中按风格匹配并复检许可；本地大库优先、随仓 50 首兜底）` };
      writeFileSync(packFile, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
      bgmAgentReceipt.push({ variantId, style, picked: picked.id, title: picked.title, license: picked.license, libraryKind: picked.libraryKind, libraryTotal: inventory.total });
    }
    process.env.WORKLOOM_BGM_LIBRARY_DIR = libraryDir;
  }
  if (segmentColor) {
    // 变体配方目录（若上面已写过覆盖副本，则复用同一目录）
    const overrideDir = process.env.WORKLOOM_POST_VARIANT_DIR
      ?? join(outDir, "work", "variant-overrides");
    mkdirSync(overrideDir, { recursive: true });
    if (!process.env.WORKLOOM_POST_VARIANT_DIR) {
      const baseVariantDir = join(REPO_ROOT, "bundles/ai-video/library/style-variants");
      const index = JSON.parse(readFileSync(join(baseVariantDir, "index.json"), "utf8")) as { variants: Array<{ id: string; file: string }> };
      for (const entry of index.variants) {
        copyFileSync(join(baseVariantDir, entry.file), join(overrideDir, entry.file));
      }
      writeFileSync(join(overrideDir, "index.json"), `${JSON.stringify({ ...index, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
    }
    const variantFile = join(overrideDir, "index.json");
    const variantIndex = JSON.parse(readFileSync(variantFile, "utf8")) as { variants: Array<{ id: string; file: string; name?: string; positioning?: string }> };
    if (!variantIndex.variants.some((entry) => entry.id === "segmented-story")) {
      const base = JSON.parse(readFileSync(join(overrideDir, "warm-story.json"), "utf8")) as Record<string, unknown>;
      const segmented = {
        ...base,
        id: "segmented-story",
        name: "分段调色版",
        positioning: "家里暖、城市冷：同一支片子按场景组分段调色（果园/饭桌暖调胶片，古城/人潮冷净）",
        /**
         * color=null：调色已在片段级完成（warm-film / cool-technical 按场景组执行），
         * 变体层**必须不再叠加统一调色**——post-bridge 看到 pack.color 为空则记「不调色」。
         * 不要在这里写自定义 profile 名：color-bridge 只认内置 profile 清单，会直接抛「未知 profile」。
         */
        color: null,
        colorNote: "调色已在片段级完成（warm-film / cool-technical 分段执行）；变体不叠加统一调色",
        transitions: {
          mode: "hard",
          fadeSec: 0,
          note: "整段口径为硬切；有逐切计划（declared/auto）时按 warm-story 的 intentMap 逐刀执行",
          scale: (base.transitions as { scale?: number } | undefined)?.scale ?? 1,
          intentMap: (base.transitions as { intentMap?: Record<string, unknown> } | undefined)?.intentMap ?? null,
        },
      };
      writeFileSync(join(overrideDir, "segmented-story.json"), `${JSON.stringify(segmented, null, 2)}\n`, "utf8");
      variantIndex.variants.push({ id: "segmented-story", file: "segmented-story.json", name: "分段调色版", positioning: segmented.positioning as string });
      writeFileSync(variantFile, `${JSON.stringify(variantIndex, null, 2)}\n`, "utf8");
    }
    process.env.WORKLOOM_POST_VARIANT_DIR = overrideDir;
  }

  const core = await import("../../bundles/ai-video/connectors/post-bridge/core.mjs") as unknown as {
    buildDeliveryPackage: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
    buildCover: (options: Record<string, unknown>) => Promise<{ output?: string }>;
    findVariantPack: (id: string, options?: Record<string, unknown>) => Record<string, unknown>;
    VARIANT_DIR: string;
  };

  const project = {
    projectId: timeline.filmId ?? timeline.timelineId,
    title,
    resolution: [width, height],
    fps,
    quality,   // 由分辨率推导（4K 级 → uhd）或显式 --quality；post-bridge 只认 hd / uhd
    platform,
    /**
     * 逐切转场计划（declared/auto）：交给 post-bridge 逐刀渲染；
     * 变体配方通过 intentMap 决定各自观感（同一剪辑脚本 → 三种风格转场）。
     */
    transitions: transitionPlan && transitionPlan.cuts.length > 0
      ? { mode: "xfade" as const, fadeSec: 0, perCut: planToPerCut(transitionPlan), easing: transitionsEasing }
      : { mode: "hard" as const, fadeSec: 0 },
    copy: {
      title,
      hook,
      tone: "温暖克制",
    },
  };
  const result = await core.buildDeliveryPackage({
    project,
    shots,
    variants,
    outDir,
    ...(subtitlePath ? { subtitles: { zhPath: subtitlePath } } : {}),
    burnSubtitles: flag("--burn-subtitles"),
    softSubtitles: true,
  });

  /**
   * 封面取帧：变体配方里的 `cover.at` 是"成片比例"，默认值未必落在最好看的那一帧
   * （实机教训：默认 0.32 落在一个普通内景）。顺序：
   *   ① 显式 `--cover-at <0–1>`（人指定，最高优先）；
   *   ② 自动：从素材理解的关键帧候选（composition_best → emotion_peak）映射到主轨比例；
   *   ③ 回退：配方默认比例（0.35），basis=fallback，在回执里如实标注。
   * 选定后用同一个封面工位（post-bridge 的 buildCover）重出每个变体的封面，不自己拼图。
   */
  const explicitCoverAt = arg("--cover-at");
  const autoCover = explicitCoverAt
    ? { ratio: Number(explicitCoverAt), basis: "explicit", note: "调用方显式指定 --cover-at", keyframeId: undefined as string | undefined, segmentId: undefined as string | undefined }
    : planCoverMoment({ timeline, analyses, fallbackRatio: 0.35 });
  if (!Number.isFinite(autoCover.ratio) || autoCover.ratio < 0 || autoCover.ratio > 1) throw new Error("--cover-at 必须是 0–1 的比例");
  {
    const ratio = autoCover.ratio;
    for (const variantId of variants) {
      const pack = core.findVariantPack(variantId) as { id: string; cover?: Record<string, unknown>; copy?: Record<string, unknown> };
      const input = join(outDir, "variants", variantId, `${variantId}.mp4`);
      if (!existsSync(input)) continue;
      await core.buildCover({
        input,
        output: join(outDir, "variants", variantId, "cover.png"),
        project,
        variant: { ...pack, cover: { ...(pack.cover ?? {}), at: ratio } },
        resolution: [width, height],
        platform,
        workDir: join(outDir, "work", "cover-override", variantId),
      });
    }
  }

  const manifestPath = join(outDir, "delivery-manifest.json");
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
    : null;
  const transitionSummaryPath = join(outDir, "transitions", "transition-receipt.json");
  const transitionSummary = existsSync(transitionSummaryPath)
    ? JSON.parse(readFileSync(transitionSummaryPath, "utf8")) as {
      scopes?: Array<{ scope: string; mode: string | null; transitionCount: number; hardCutCount: number | null; types: string[] }>;
    }
    : null;
  const summary = {
    ok: true,
    outDir,
    clips: shots.length,
    variants: variants,
    resolution: {
      width,
      height,
      quality,
      policy: resolutionPolicy,
      sources: sourceSizes,
      upscaledSources: sourceSizes
        .filter((entry) => entry.width && entry.height && entry.width * entry.height < width * height)
        .map((entry) => entry.sourceId),
    },
    transitions: {
      mode: transitionsMode,
      easing: transitionsEasing,
      pack: transitionPlan?.pack ?? transitionPack,
      plannedCuts: transitionPlan?.cuts.length ?? 0,
      expectedOutputDurationSeconds: transitionPlan?.expectedOutputDurationSeconds ?? null,
      advisories: transitionPlan?.advisories ?? [],
      summaryPath: transitionSummary ? transitionSummaryPath : null,
      scopes: transitionSummary?.scopes ?? [],
    },
    reframe: {
      mode: reframeMode,
      fill: reframeFill,
      maxZoom: reframeMaxZoom,
      easing: reframeEasing,
      planned: plan.reframePlan?.plannedCount ?? 0,
      advisories: plan.reframePlan?.advisories ?? [],
      shots: plan.normalize
        .filter((step) => step.reframe)
        .map((step) => ({
          segmentId: step.segmentId,
          mode: step.reframe!.mode,
          fill: step.reframe!.fill,
          scale: step.reframe!.scale,
          legacyPunchIn: step.reframe!.legacyPunchIn,
          effectiveUpscale: step.reframe!.budget.effectiveUpscale,
        })),
      summaryPath: existsSync(join(outDir, "reframe", "reframe-receipt.json")) ? join(outDir, "reframe", "reframe-receipt.json") : null,
    },
    subtitle: subtitlePath,
    coverAtSource: {
      ratio: Number(autoCover.ratio.toFixed(4)),
      basis: autoCover.basis,
      keyframeId: autoCover.keyframeId ?? null,
      segmentId: autoCover.segmentId ?? null,
      note: autoCover.note,
      explicit: Boolean(explicitCoverAt),
    },
    analyses: analyses.length,
    segmentColor: segmentColor ? { applied: segmentColorNotes.length, plan: segmentColorNotes } : null,
    bgmAgent: bgmAgent ? { libraryTotal: null, picks: bgmAgentReceipt } : null,
    manifest: manifestPath,
    files: (manifest?.files ?? manifest?.artifacts ?? null),
    resultKeys: Object.keys(result ?? {}),
  };
  if (flag("--json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`✓ 正式后期完成：${shots.length} 段 → 母版 + ${variants.length} 个风格变体`);
    console.log(`  交付目录：${outDir}`);
    console.log(`  封面取帧：${(autoCover.ratio * 100).toFixed(1)}%（${autoCover.basis}${autoCover.keyframeId ? ` · ${autoCover.keyframeId}` : ""}）`);
    if (segmentColor) {
      const graded = segmentColorNotes.filter((entry) => entry.lut);
      console.log(`  分段调色：${graded.length}/${segmentColorNotes.length} 段落 LUT（其余保持原色）`);
    }
    if (subtitlePath) console.log(`  旁挂字幕：${subtitlePath}（已生成 srt/ass/vtt + 清单）`);
    console.log(`  交付清单：${manifestPath}`);
    if (transitionSummary?.scopes?.length) {
      console.log("  转场回执：");
      for (const scope of transitionSummary.scopes) {
        console.log(`    - ${scope.scope}：${scope.mode ?? "-"} · 转场 ${scope.transitionCount} 刀 / 硬切 ${scope.hardCutCount ?? "-"} 处${scope.types.length ? `（${scope.types.join("/")}）` : ""}`);
      }
    }
    if (reframeMode !== "off") {
      const reframeSummary = manifest?.reframe as { shots?: Array<{ shotId: string; fill: string | null; scale: { from: number; to: number } | null; effectiveUpscale: number | null }> } | undefined;
      console.log(`  二次构图：${reframeMode} · 填充 ${reframeFill} · 命中 ${plan.reframePlan?.plannedCount ?? 0}/${shots.length} 段（倍率上限 ${reframeMaxZoom}）`);
      for (const shot of reframeSummary?.shots ?? []) {
        console.log(`    - ${shot.shotId}：${shot.fill ?? "-"} ${shot.scale ? `${shot.scale.from}–${shot.scale.to}×` : ""}${shot.effectiveUpscale ? `（等效上采样 ${shot.effectiveUpscale}×）` : ""}`);
      }
      for (const advisory of plan.reframePlan?.advisories ?? []) console.log(`    ! ${advisory}`);
    }
    console.log("  说明：调色/封面/配乐/软字幕轨均由既有后期链路（post-bridge）按变体配方执行。");
  }
  void homedir;
  void writeFileSync;
}

main().catch((err) => {
  console.error(`✗ edit-post 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
