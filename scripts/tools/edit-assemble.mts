#!/usr/bin/env tsx
/**
 * edit-assemble —— 按剪辑时间轴做本地合成（裁切 / 归一化 / 拼接）
 *
 * 纪律（与 post-bridge 同源）：
 *   · 纯本地算力，不调用任何生成模型——剪辑管线不重新渲染画面；
 *   · 先校验后执行：硬项失败直接拒绝合成（不让"有问题的轴"变成"有问题的片"）；
 *   · 一切加工写新文件：原件只读，输出目录独立；
 *   · 失败显式：缺 ffmpeg / 素材不存在 / 拼接失败 / 产物时长不符 → 报错退出，不产出半成品交付；
 *   · 产物带回执：时长、分辨率、音轨、sha256 与分段清单写进 `<out>.receipt.json`。
 *
 * 用法：
 *   pnpm edit:assemble -- --timeline work/edit/<film>.timeline.json --out work/edit/<film>.mp4 \
 *     [--width 1080 --height 1920 --fps 30 --crf 20] [--keep-segments] [--json]
 *
 * 注：`--keep-segments` 保留中间分段（排查用）；默认清理，只留成片与回执。
 */
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  parseFfprobeJson, planAssembly, validateEditTimeline, type EditTimeline,
} from "../../packages/video-studio/src/edit/index.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const FFMPEG = process.env.WL_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.WL_FFPROBE ?? "ffprobe";
const DURATION_TOLERANCE_SECONDS = 0.35;

const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

function run(bin: string, args: string[]): void {
  try {
    execFileSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const failure = err as { stderr?: string; message?: string };
    const detail = (failure.stderr || failure.message || "").toString().split("\n").slice(-6).join(" | ");
    throw new Error(`${bin} 执行失败：${detail}`);
  }
}

function assertAvailable(bin: string): void {
  try {
    execFileSync(bin, ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error(`找不到可用的 ${bin}；请安装 ffmpeg 或用 WL_FFMPEG/WL_FFPROBE 指定路径`);
  }
}

async function sha256File(file: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

async function main(): Promise<void> {
  const timelinePath = arg("--timeline");
  const outArg = arg("--out");
  if (!timelinePath || !outArg) throw new Error("用法：pnpm edit:assemble -- --timeline <timeline.json> --out <成片.mp4>");
  const timelineFile = abs(timelinePath);
  if (!existsSync(timelineFile)) throw new Error(`时间轴文件不存在：${timelineFile}`);
  const outPath = abs(outArg);
  const workDir = abs(arg("--work", `${dirname(outPath)}/.edit-work-${Date.now().toString(36)}`));

  const timeline = JSON.parse(readFileSync(timelineFile, "utf8")) as EditTimeline;
  const validation = validateEditTimeline(timeline);
  if (!validation.ok) {
    const failed = validation.checks.filter((c) => c.hard && !c.pass).map((c) => `${c.id}：${c.detail}`);
    throw new Error(`时间轴未通过契约校验，拒绝合成（${failed.length} 项硬失败）：\n  - ${failed.join("\n  - ")}`);
  }

  assertAvailable(FFMPEG);
  assertAvailable(FFPROBE);

  const width = Number(arg("--width", "1080"));
  const height = Number(arg("--height", "1920"));
  const fps = Number(arg("--fps", String(timeline.target?.fps ?? 30)));
  const crf = Number(arg("--crf", "20"));

  const plan = planAssembly(timeline, { workDir, outputPath: outPath, width, height, fps, crf });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(dirname(outPath), { recursive: true });

  for (const step of plan.normalize) {
    if (!existsSync(step.input)) throw new Error(`片段 ${step.segmentId} 的素材不在本地：${step.input}`);
    run(FFMPEG, step.args);
    if (!existsSync(step.output)) throw new Error(`片段 ${step.segmentId} 归一化后没有产物：${step.output}`);
  }

  const listBody = plan.normalize.map((step) => `file '${step.output.replace(/'/gu, "'\\''")}'`).join("\n");
  writeFileSync(plan.concat.listPath, `${listBody}\n`, "utf8");
  run(FFMPEG, plan.concat.args);
  if (!existsSync(outPath)) throw new Error("拼接结束但没有产出成片文件");

  const probed = parseFfprobeJson(execFileSync(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration:stream=index,codec_type,width,height,r_frame_rate,sample_rate,channels",
    "-of", "json", outPath,
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
  const deviation = Math.abs(probed.durationSeconds - plan.totalDurationSeconds);
  if (deviation > DURATION_TOLERANCE_SECONDS) {
    throw new Error(`成片时长 ${probed.durationSeconds.toFixed(3)}s 与时间轴 ${plan.totalDurationSeconds}s 偏差 ${deviation.toFixed(3)}s，超过容差 ${DURATION_TOLERANCE_SECONDS}s`);
  }

  const outputSha256 = await sha256File(outPath);
  const receipt = {
    schema: "workloom.video-edit/assemble-receipt/v1",
    timeline: timelineFile,
    timelineId: timeline.timelineId,
    revision: timeline.revision ?? 1,
    output: outPath,
    outputSha256,
    durationSeconds: Number(probed.durationSeconds.toFixed(3)),
    resolution: `${probed.width}x${probed.height}`,
    fps: Number(probed.fps.toFixed(3)),
    sampleRate: probed.sampleRate,
    channels: probed.channels,
    segments: plan.normalize.map((step) => ({
      segmentId: step.segmentId,
      source: step.input,
      sourceIn: step.sourceIn,
      sourceOut: step.sourceOut,
    })),
    checks: validation.checks,
    advisory: validation.checks.filter((c) => !c.hard && !c.pass).map((c) => `${c.id}：${c.detail}`),
    generatedAt: new Date().toISOString(),
  };
  const receiptPath = `${outPath}.receipt.json`;
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  if (!flag("--keep-segments")) rmSync(workDir, { recursive: true, force: true });

  const summary = {
    ok: true,
    output: outPath,
    receipt: receiptPath,
    durationSeconds: receipt.durationSeconds,
    resolution: receipt.resolution,
    segments: receipt.segments.length,
    advisory: receipt.advisory,
    outputSha256,
  };
  if (flag("--json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`✓ 本地合成完成：${summary.segments} 段 → ${summary.durationSeconds}s @ ${summary.resolution}`);
    console.log(`  成片：${outPath}（sha256 ${outputSha256.slice(0, 12)}…）`);
    console.log(`  回执：${receiptPath}`);
    if (summary.advisory.length > 0) console.log(`  咨询项：${summary.advisory.join("；")}`);
    console.log("  下一步：交回 AI 视频既有后期链路（调色/字幕/配音/配乐/封面/多风格交付）。");
  }
}

main().catch((err) => {
  console.error(`✗ edit-assemble 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
