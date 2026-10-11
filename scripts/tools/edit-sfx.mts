#!/usr/bin/env tsx
/**
 * edit-sfx —— 把注意力排期里的音效点位落成声音层（本地合成，零版权素材）。
 *
 * 为什么音效也算"注意力层"：卡片进出、景别切换、金句前抬升，靠一记 0.2–1.2s 的短音效
 * 把观众的注意力"钉"在画面上（行业实务：声音是留存工具的一半）。仓内 `sfx-synth` 用
 * ffmpeg 噪声/正弦滤波合成 whoosh/impact/riser——确定性、可复现、无第三方采样。
 *
 * 纪律：
 *   · 音效只在注意力排期给出的点位出现，不手抖加点；
 *   · 混音链尾带 -1dBFS 真峰值限制器（与 bgm-bridge 同口径），保证不削波、不盖人声；
 *   · 视频流 `-c:v copy` 不重编码（只动声音）。
 *
 * 用法：
 *   pnpm edit:sfx -- --input <成片.mp4> --attention <attention-plan.json> --out <输出.mp4> \
 *     [--level-db -4] [--evidence-dir <目录>] [--json]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { buildSfxArgs, type SfxKind } from "../../packages/video-studio/src/sfx-synth.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const FFMPEG = process.env.WL_FFMPEG ?? "ffmpeg";
const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

try {
  const inputPath = abs(arg("--input"));
  const attentionPath = abs(arg("--attention"));
  const outPath = abs(arg("--out"));
  const levelDb = Number(arg("--level-db", "-4"));
  if (!inputPath || !attentionPath || !outPath) {
    throw new Error("用法：pnpm edit:sfx -- --input <成片.mp4> --attention <attention-plan.json> --out <输出.mp4>");
  }
  if (!existsSync(inputPath)) throw new Error(`输入不存在：${inputPath}`);
  if (!existsSync(attentionPath)) throw new Error(`注意力排期不存在：${attentionPath}`);
  const plan = JSON.parse(readFileSync(attentionPath, "utf8")) as {
    sfx: Array<{ id: string; kind: SfxKind; at: number; gainDb: number; reason: string }>;
  };
  const placements = (plan.sfx ?? []).sort((a, b) => a.at - b.at);
  if (placements.length === 0) throw new Error("注意力排期里没有音效点位（先跑 edit:attention）");

  const evidenceDir = abs(arg("--evidence-dir", dirname(outPath)));
  const sfxDir = join(evidenceDir, "sfx");
  mkdirSync(sfxDir, { recursive: true });
  const rendered: Array<Record<string, unknown>> = [];
  const inputs: string[] = [];
  const chains: string[] = [];
  placements.forEach((placement, index) => {
    const wav = join(sfxDir, `${placement.id}-${placement.kind}.wav`);
    if (!existsSync(wav)) {
      execFileSync(FFMPEG, ["-hide_banner", "-v", "error", "-y", ...buildSfxArgs({ kind: placement.kind }), "-f", "wav", wav], { stdio: ["ignore", "pipe", "pipe"] });
    }
    inputs.push(wav);
    const delayMs = Math.max(0, Math.round(placement.at * 1000));
    const gain = Number((placement.gainDb + levelDb).toFixed(2));
    chains.push(`[${index + 1}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${gain}dB,adelay=${delayMs}|${delayMs}[s${index}]`);
    rendered.push({
      id: placement.id, kind: placement.kind, at: placement.at, gainDb: gain, reason: placement.reason,
      wav, sha256: createHash("sha256").update(readFileSync(wav)).digest("hex"),
    });
  });
  const mixInputs = rendered.map((_item, index) => `[s${index}]`).join("");
  const filter = [
    ...chains,
    `[0:a]aformat=sample_rates=48000:channel_layouts=stereo[voice]`,
    `[voice]${mixInputs}amix=inputs=${rendered.length + 1}:duration=first:dropout_transition=0:normalize=0[mixed]`,
    `[mixed]alimiter=limit=0.891:attack=5:release=50:level=disabled[out]`,
  ].join(";");

  mkdirSync(dirname(outPath), { recursive: true });
  execFileSync(FFMPEG, [
    "-hide_banner", "-v", "error", "-y", "-i", inputPath,
    ...inputs.flatMap((file) => ["-i", file]),
    "-filter_complex", filter,
    "-map", "0:v:0", "-map", "[out]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart", outPath,
  ], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });

  /** 事实机检：音效加完不能削波（抽一段做 volumedetect，峰值必须 < 0dBFS） */
  const analyse = (file: string): { maxVolumeDb: number | null } => {
    /** volumedetect 的读数在 **stderr**（不是 stdout）；读错流会得到 null，让"不削波"变成假通过 */
    const result = spawnSync(FFMPEG, ["-hide_banner", "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    const match = /max_volume:\s*(-?[0-9.]+) dB/u.exec(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    return { maxVolumeDb: match ? Number(match[1]) : null };
  };
  const before = analyse(inputPath);
  const after = analyse(outPath);
  const hardFailures: string[] = [];
  if (after.maxVolumeDb === null) hardFailures.push("无法测量混音后峰值（volumedetect 读数缺失）：不能声明不削波");
  else if (after.maxVolumeDb >= 0) hardFailures.push(`混音后峰值 ${after.maxVolumeDb} dB：出现削波（限制器未生效）`);

  const receipt = {
    schemaVersion: "workloom.video-edit/sfx-receipt/v1",
    input: inputPath, output: { path: outPath, sha256: createHash("sha256").update(readFileSync(outPath)).digest("hex") },
    levelDb, placements: rendered,
    loudness: { before, after },
    checks: { noClipping: after.maxVolumeDb === null || after.maxVolumeDb < 0, videoStreamCopied: true },
    hardFailures, ok: hardFailures.length === 0,
    generatedAt: new Date().toISOString(),
  };
  const receiptPath = join(evidenceDir, "sfx-receipt.json");
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  if (flag("--json")) console.log(JSON.stringify(receipt, null, 2));
  else {
    console.log(`✓ 音效轨完成：${rendered.length} 记（本地合成）｜峰值 ${before.maxVolumeDb} → ${after.maxVolumeDb} dB`);
    console.log(`  产物：${outPath}｜回执：${receiptPath}`);
  }
  if (!receipt.ok) process.exit(1);
} catch (error) {
  console.error(`✗ edit-sfx 失败：${(error as Error).message}`);
  process.exit(1);
}
