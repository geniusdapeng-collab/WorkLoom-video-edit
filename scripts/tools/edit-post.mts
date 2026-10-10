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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  process.env.WORKLOOM_POST_ALLOWED_ROOTS = [
    process.env.WORKLOOM_POST_ALLOWED_ROOTS?.trim(),
    REPO_ROOT,
    outDir,
    ...new Set(timeline.sources.map((source) => dirname(source.path))),
  ].filter(Boolean).join(":");
  process.env.WL_FFMPEG ??= FFMPEG;

  const core = await import("../../bundles/ai-video/connectors/post-bridge/core.mjs") as {
    buildDeliveryPackage: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  const project = {
    projectId: timeline.filmId ?? timeline.timelineId,
    title,
    resolution: [width, height],
    fps,
    quality: "standard",
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

  const manifestPath = join(outDir, "delivery-manifest.json");
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
    : null;
  const summary = {
    ok: true,
    outDir,
    clips: shots.length,
    variants: variants,
    subtitle: subtitlePath,
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
