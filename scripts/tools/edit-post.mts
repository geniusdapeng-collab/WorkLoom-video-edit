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
 *     [--title "标题"] [--hook "一句话钩子"] [--platform "微信视频号"]
 *     [--width 1920 --height 1080 --fps 30] [--crf 16] [--burn-subtitles] [--json]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  planAssembly, validateEditTimeline, type EditTimeline,
} from "../../packages/video-studio/src/edit/index.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const FFMPEG = process.env.WL_FFMPEG ?? "ffmpeg";

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

  const timeline = JSON.parse(readFileSync(timelineFile, "utf8")) as EditTimeline;
  const validation = validateEditTimeline(timeline);
  if (!validation.ok) {
    const failed = validation.checks.filter((c) => c.hard && !c.pass).map((c) => `${c.id}：${c.detail}`);
    throw new Error(`时间轴未通过契约校验，拒绝进入后期（${failed.length} 项硬失败）：\n  - ${failed.join("\n  - ")}`);
  }

  const width = Number(arg("--width", "1920"));
  const height = Number(arg("--height", "1080"));
  const fps = Number(arg("--fps", String(timeline.target?.fps ?? 30)));
  const crf = Number(arg("--crf", "16"));
  const variants = arg("--variants", "warm-story,clean-tech,bold-promo").split(",").map((v) => v.trim()).filter(Boolean);
  /**
   * 转场口径：`pack`（默认，用变体配方，暖调故事版是 fade=经黑场叠化）或 `hard`（全部硬切）。
   * 产品所有者口径（2026-10-10）：叙事剪辑默认硬切，叠化只在明确要求时使用。
   * 实现方式：把三份变体配方复制到交付目录下的临时覆盖目录，改写 transitions 后交给
   * post-bridge 的 `WORKLOOM_POST_VARIANT_DIR` 覆盖（不改随包资产）。
   */
  const transitionsMode = arg("--transitions", "hard");
  if (!["hard", "pack"].includes(transitionsMode)) throw new Error("--transitions 只接受 hard / pack");
  const subtitlePath = arg("--subtitle") ? abs(arg("--subtitle")) : null;
  if (subtitlePath && !existsSync(subtitlePath)) throw new Error(`字幕文件不存在：${subtitlePath}`);
  const platform = arg("--platform", timeline.target?.platform ?? "微信视频号");
  const title = arg("--title", timeline.filmId ?? timeline.timelineId);
  const hook = arg("--hook", "");

  // ① 逐段裁切：把时间轴的源轨 in/out 真正切出来，成为后期链路可以直接吃的一份"镜头清单"
  const clipsDir = join(outDir, "clips");
  mkdirSync(clipsDir, { recursive: true });
  const plan = planAssembly(timeline, { workDir: clipsDir, outputPath: join(clipsDir, "concat.mp4"), width, height, fps, crf });
  const shots: Array<{ shotId: string; path: string }> = [];
  for (const step of plan.normalize) {
    if (!existsSync(step.input)) throw new Error(`片段 ${step.segmentId} 的素材不在本地：${step.input}`);
    const target = join(clipsDir, `${step.segmentId}.mp4`);
    const args = [...step.args];
    args[args.length - 1] = target; // plan 里的输出名换成交付目录里的正式命名
    run(FFMPEG, args);
    if (!existsSync(target)) throw new Error(`片段 ${step.segmentId} 裁切后无产物`);
    shots.push({ shotId: step.segmentId, path: target });
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
    quality: arg("--quality", "hd"),   // post-bridge 只认 hd / uhd（ux 档位名不同，别再猜）
    platform,
    transitions: { mode: "hard", fadeSec: 0 },
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
   * 封面帧可选覆盖：变体配方里的 `cover.at` 是"成片比例"，默认值未必落在最好看的那一帧
   * （实机教训：默认 0.32 落在一个普通内景）。传 `--cover-at <0–1>` 时，用同一个封面工位
   * （post-bridge 的 buildCover）按指定比例重出每个变体的封面，不自己拼图。
   */
  const coverAt = arg("--cover-at");
  if (coverAt) {
    const ratio = Number(coverAt);
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new Error("--cover-at 必须是 0–1 的比例");
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
  const summary = {
    ok: true,
    outDir,
    clips: shots.length,
    variants: variants,
    transitions: transitionsMode,
    subtitle: subtitlePath,
    coverAt: coverAt ? Number(coverAt) : null,
    manifest: manifestPath,
    files: (manifest?.files ?? manifest?.artifacts ?? null),
    resultKeys: Object.keys(result ?? {}),
  };
  if (flag("--json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`✓ 正式后期完成：${shots.length} 段 → 母版 + ${variants.length} 个风格变体`);
    console.log(`  交付目录：${outDir}`);
    if (subtitlePath) console.log(`  旁挂字幕：${subtitlePath}（已生成 srt/ass/vtt + 清单）`);
    console.log(`  交付清单：${manifestPath}`);
    console.log("  说明：调色/封面/配乐/软字幕轨均由既有后期链路（post-bridge）按变体配方执行。");
  }
  void homedir;
  void writeFileSync;
}

main().catch((err) => {
  console.error(`✗ edit-post 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
