/**
 * frame-scan —— 封面/关键帧的本地"最佳帧"扫描（共享工具，纯本地、零模型成本）。
 *
 * 为什么需要：封面取帧不能只吃"第 35% 那一帧"或某一支演示片写死的秒数。
 * 有镜头理解/高光产物时优先用关键帧候选；没有时，这里用 blurdetect + signalstats
 * 抽样打分（清晰度 × 曝光），给出**可解释**的最佳帧与全部候选分数。
 *
 * 局限（如实声明）：不做人脸/语义判断，纯空镜与人物特写的"好看"不在本工具能力内；
 * 它解决的是"明显糊帧/过曝帧不会被选成封面"这类低级错误。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { exposureScore, parseFrameStats, sharpnessScore } from "../../../packages/video-studio/src/edit/index.js";

export interface FrameScanResult {
  ratio: number;
  seconds: number;
  score: number;
  sharpness: number | null;
  exposure: number | null;
  candidates: Array<{ ratio: number; score: number; sharpness: number | null; exposure: number | null }>;
  note: string;
}

function probeDuration(file: string, ffprobe: string): number | null {
  try {
    const out = execFileSync(ffprobe, [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
    ], { encoding: "utf8" }).trim();
    const duration = Number(out);
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null;
  }
}

/** 对单帧 PNG 跑 blurdetect+signalstats，返回清晰度/曝光两个 0–1 代理分 */
function scoreFrame(file: string, ffmpeg: string): { sharpness: number | null; exposure: number | null } {
  const result = spawnSync(ffmpeg, [
    "-hide_banner", "-i", file,
    "-vf", "blurdetect,signalstats,metadata=print:file=-",
    "-frames:v", "1", "-f", "null", "-",
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) return { sharpness: null, exposure: null };
  const frames = parseFrameStats(result.stdout ?? "");
  const frame = frames[0];
  if (!frame) return { sharpness: null, exposure: null };
  return {
    sharpness: sharpnessScore(frame.blur),
    exposure: exposureScore(frame.yavg, { yhigh: frame.yhigh, ylow: frame.ylow }),
  };
}

/**
 * 扫描最佳封面帧。`ratios` 默认 7 档（避开片头片尾 8%），逐帧打分取最高；
 * 全部帧都测不出指标时返回 `null`（调用方回退配方默认比例，不假装扫过）。
 */
export function scanBestFrame(input: {
  file: string;
  workDir: string;
  ffmpeg?: string;
  ffprobe?: string;
  ratios?: number[];
}): FrameScanResult | null {
  const ffmpeg = input.ffmpeg ?? process.env.WL_FFMPEG ?? "ffmpeg";
  const ffprobe = input.ffprobe ?? process.env.WL_FFPROBE ?? "ffprobe";
  if (!existsSync(input.file)) throw new Error(`扫描素材不存在：${input.file}`);
  const duration = probeDuration(input.file, ffprobe);
  if (!duration) return null;
  const ratios = input.ratios ?? [0.08, 0.2, 0.32, 0.45, 0.58, 0.72, 0.85];
  mkdirSync(input.workDir, { recursive: true });
  const candidates: FrameScanResult["candidates"] = [];
  for (const ratio of ratios) {
    const seconds = Number((duration * ratio).toFixed(3));
    const frame = join(input.workDir, `scan-${String(Math.round(ratio * 100)).padStart(3, "0")}.png`);
    const grab = spawnSync(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", String(seconds), "-i", input.file, "-frames:v", "1", "-update", "1", frame,
    ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (grab.status !== 0 || !existsSync(frame)) continue;
    const { sharpness, exposure } = scoreFrame(frame, ffmpeg);
    rmSync(frame, { force: true });
    if (sharpness === null && exposure === null) continue;
    const score = Number((0.6 * (sharpness ?? 0.5) + 0.4 * (exposure ?? 0.5)).toFixed(3));
    candidates.push({ ratio, score, sharpness, exposure });
  }
  if (candidates.length === 0) return null;
  const best = candidates.reduce((top, candidate) => (candidate.score > top.score ? candidate : top), candidates[0]!);
  return {
    ratio: best.ratio,
    seconds: Number((duration * best.ratio).toFixed(3)),
    score: best.score,
    sharpness: best.sharpness,
    exposure: best.exposure,
    candidates: [...candidates].sort((a, b) => b.score - a.score),
    note: `本地扫描 ${candidates.length} 帧：清晰度×0.6 + 曝光×0.4，最佳在第 ${(best.ratio * 100).toFixed(0)}%（${(duration * best.ratio).toFixed(1)}s，分 ${best.score}）`,
  };
}
