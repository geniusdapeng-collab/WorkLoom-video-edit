/**
 * edit/probe-parse.ts —— 信号层解析（确定性、可复现、零模型成本）
 *
 * 输入是 ffprobe / ffmpeg 的原始文本输出，输出是 footage-analysis 契约里的 `probe` 结构。
 * 为什么把解析独立成纯函数：真机里"解析错"与"检测错"经常被混为一谈；把文本→结构的换算
 * 做成纯函数后，两类问题可以分别复现（喂同一段日志必须得到同一个结果）。
 *
 * 支持的 ffmpeg 通道（与 skills/shot-understanding 的口径一致）：
 *   ① 场景切点：`-vf "select='gt(scene,0.3)',showinfo"` → `pts_time:`
 *   ② 静音/停顿：`-af silencedetect=noise=-30dB:d=0.25` → `silence_start/silence_end`
 *   ③ 响度包络：`-af "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level"`
 *   ④ 峰值电平：`-af volumedetect` → `mean_volume / max_volume`
 *
 * 纪律：
 *   · 解析不到就如实返回空数组/0，不编造数值；
 *   · 没测过的指标写 null（例如未测 LUFS 时不冒充）；
 *   · 切点永远是"候选"，最终切点由 cut-review 与剪辑指导确认。
 */

import { frameOf, toTimecode } from "./timecode.js";

export interface ProbeMedia {
  durationSeconds: number;
  fps: number;
  width: number;
  height: number;
  aspectRatio: string;
  hasAudio: boolean;
  channels: number | null;
  sampleRate: number | null;
}

export interface ShotBoundary {
  index: number;
  inFrame: number;
  outFrame: number;
  inTimecode: string;
  outTimecode: string;
  durationSeconds: number;
  detector: string;
  threshold: number | null;
  confidence: number;
}

export interface SilenceSpan {
  start: number;
  end: number;
  duration: number;
}

export interface LoudnessPoint {
  t: number;
  db: number;
}

export interface VolumeDetect {
  meanDb: number | null;
  maxDb: number | null;
}

export interface FootageProbeDocument {
  shotBoundaries: ShotBoundary[];
  silences: SilenceSpan[];
  speech: { language: string; engine: string | null; words: unknown[]; sentences: unknown[] };
  music: { detected: boolean; bpm: number | null; beatGrid: number[]; downbeats: number[]; sections: unknown[] };
  loudness: { envelope: LoudnessPoint[]; peakMoments: LoudnessPoint[] };
  technical: { perShot: Array<Record<string, number | null>> };
  /** OCR 观测（`--ocr` 通道；未运行时为空数组） */
  onScreenText?: Array<{ t: number; texts: string[] }>;
  /** 环境音画像（可量化部分；语义标签由理解层写进 shots[].audio.ambience） */
  ambience?: {
    noiseFloorDb: number | null;
    loudnessRangeDb: number | null;
    silenceCoverage: number | null;
    speechCoverage: number | null;
    peakCount: number;
  };
  volumeDetect?: VolumeDetect;
}

/** `25/1` / `30000/1001` → 数值 fps；非法返回 NaN（由调用方 fail-closed） */
export function parseRate(value: string | undefined): number {
  if (typeof value !== "string" || !value.trim()) return Number.NaN;
  const [num, den] = value.split("/");
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return Number.NaN;
  return n / d;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** 宽高 → 最简比（`1080x1920` → `9:16`）；非整数或非正返回 `1:1` 之外的近似值 */
export function aspectRatioOf(width: number, height: number): string {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`画幅计算需要正整数宽高，收到：${width}x${height}`);
  }
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

/** ffprobe JSON（`-show_entries format=duration:stream=...`）→ 媒体信息 */
export function parseFfprobeJson(text: string): ProbeMedia {
  let doc: {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number; r_frame_rate?: string; sample_rate?: string; channels?: number }>;
  };
  try {
    doc = JSON.parse(text) as typeof doc;
  } catch {
    throw new Error("ffprobe 输出不是合法 JSON");
  }
  const duration = Number(doc.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("ffprobe 未给出有效时长");
  const video = (doc.streams ?? []).find((s) => s.codec_type === "video");
  const audio = (doc.streams ?? []).find((s) => s.codec_type === "audio");
  if (!video) throw new Error("素材没有视频流");
  const fps = parseRate(video.r_frame_rate);
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`无法解析帧率：${String(video.r_frame_rate)}`);
  const width = Number(video.width);
  const height = Number(video.height);
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error("无法解析画幅尺寸");
  return {
    durationSeconds: duration,
    fps,
    width,
    height,
    aspectRatio: aspectRatioOf(width, height),
    hasAudio: Boolean(audio),
    channels: audio?.channels ?? null,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
  };
}

/** 场景检测日志 → 切点时刻（秒） */
export function parseSceneCuts(log: string): number[] {
  const cuts: number[] = [];
  for (const line of log.split(/\r?\n/u)) {
    const matched = /pts_time:([0-9]+(?:\.[0-9]+)?)/u.exec(line);
    if (!matched) continue;
    const t = Number(matched[1]);
    if (Number.isFinite(t) && t >= 0) cuts.push(t);
  }
  return [...new Set(cuts)].sort((a, b) => a - b);
}

/** silencedetect 日志 → 静音区间 */
export function parseSilences(log: string): SilenceSpan[] {
  const spans: SilenceSpan[] = [];
  let pendingStart: number | null = null;
  for (const line of log.split(/\r?\n/u)) {
    const startMatched = /silence_start:\s*(-?[0-9]+(?:\.[0-9]+)?)/u.exec(line);
    if (startMatched) {
      const start = Number(startMatched[1]);
      if (Number.isFinite(start) && start >= 0) pendingStart = start;
      continue;
    }
    const endMatched = /silence_end:\s*(-?[0-9]+(?:\.[0-9]+)?)\s*\|\s*silence_duration:\s*([0-9]+(?:\.[0-9]+)?)/u.exec(line);
    if (endMatched) {
      const end = Number(endMatched[1]);
      const duration = Number(endMatched[2]);
      const start = pendingStart ?? Math.max(0, end - duration);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        spans.push({ start, end, duration: Number.isFinite(duration) ? duration : end - start });
      }
      pendingStart = null;
    }
  }
  return spans;
}

/**
 * astats+ametadata 日志 → 响度包络。
 * 原始输出是逐音频帧（约 20ms）一行 `pts_time` + 一行 `RMS_level`，直接进契约会过大；
 * 这里按 `bucketSeconds` 分桶取最大值（峰值保留，避免平均把高光抹平）。
 */
export function parseRmsEnvelope(log: string, bucketSeconds = 0.25): LoudnessPoint[] {
  if (!Number.isFinite(bucketSeconds) || bucketSeconds <= 0) throw new Error("bucketSeconds 必须是正数");
  const points: LoudnessPoint[] = [];
  let pendingTime: number | null = null;
  for (const line of log.split(/\r?\n/u)) {
    const timeMatched = /pts_time:([0-9]+(?:\.[0-9]+)?)/u.exec(line);
    if (timeMatched) {
      const t = Number(timeMatched[1]);
      pendingTime = Number.isFinite(t) ? t : null;
      continue;
    }
    const rmsMatched = /RMS_level=(-?[0-9]+(?:\.[0-9]+)?)/u.exec(line);
    if (rmsMatched && pendingTime !== null) {
      const db = Number(rmsMatched[1]);
      if (Number.isFinite(db)) points.push({ t: pendingTime, db });
      pendingTime = null;
    }
  }
  if (points.length === 0) return [];
  const buckets = new Map<number, number>();
  for (const point of points) {
    const key = Math.floor(point.t / bucketSeconds);
    const current = buckets.get(key);
    if (current === undefined || point.db > current) buckets.set(key, point.db);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, db]) => ({ t: Number((key * bucketSeconds).toFixed(3)), db: Number(db.toFixed(2)) }));
}

/** volumedetect 日志 → 整片均值/峰值（LUFS 未测时不冒充，由调用方写 null） */
export function parseVolumeDetect(log: string): VolumeDetect {
  const mean = /mean_volume:\s*(-?[0-9]+(?:\.[0-9]+)?)\s*dB/u.exec(log);
  const max = /max_volume:\s*(-?[0-9]+(?:\.[0-9]+)?)\s*dB/u.exec(log);
  return {
    meanDb: mean ? Number(mean[1]) : null,
    maxDb: max ? Number(max[1]) : null,
  };
}

/**
 * 切点 → 镜头区间（MECE：首尾闭合、无重叠、覆盖全片）。
 * 传入的 cut 时刻若超出时长或与相邻切点过近（< minShotSeconds）会被丢弃，避免产生碎片镜头。
 */
export function deriveShotBoundaries(
  media: Pick<ProbeMedia, "durationSeconds" | "fps">,
  cuts: number[],
  options: { detector?: string; threshold?: number | null; minShotSeconds?: number } = {},
): ShotBoundary[] {
  const { detector = "ffmpeg-scene", threshold = null, minShotSeconds = 0.4 } = options;
  const usable = cuts
    .filter((t) => Number.isFinite(t) && t > minShotSeconds && t < media.durationSeconds - minShotSeconds)
    .sort((a, b) => a - b);
  const marks: number[] = [0];
  for (const cut of usable) {
    if (cut - marks[marks.length - 1]! >= minShotSeconds) marks.push(cut);
  }
  marks.push(media.durationSeconds);
  const boundaries: ShotBoundary[] = [];
  for (let i = 0; i < marks.length - 1; i += 1) {
    const start = marks[i]!;
    const end = marks[i + 1]!;
    const durationSeconds = Number((end - start).toFixed(3));
    if (durationSeconds <= 0) continue;
    boundaries.push({
      index: boundaries.length,
      inFrame: frameOf(start, media.fps),
      outFrame: frameOf(end, media.fps),
      inTimecode: toTimecode(start),
      outTimecode: toTimecode(end),
      durationSeconds,
      detector,
      threshold,
      // 场景检测只给"有边界"这一事实，不给概率；置信度按检测到切点=1、首尾=1 表达
      confidence: 1,
    });
  }
  return boundaries;
}

/** 音量包络 → 峰值时刻（每个分桶的局部峰值，供高光/卡点使用） */
export function peakMomentsOf(envelope: LoudnessPoint[], options: { topN?: number } = {}): LoudnessPoint[] {
  const topN = options.topN ?? 24;
  return [...envelope]
    .sort((a, b) => b.db - a.db)
    .slice(0, Math.max(0, topN))
    .sort((a, b) => a.t - b.t);
}

/** 组装 footage-analysis 契约里的 `probe` 段（缺项如实留空，不编造） */
export function buildFootageProbe(input: {
  media: ProbeMedia;
  cuts: number[];
  silences: SilenceSpan[];
  envelope: LoudnessPoint[];
  volume?: VolumeDetect;
  detector?: string;
  threshold?: number | null;
  language?: string;
  speechEngine?: string | null;
  bpm?: number | null;
  beatGrid?: number[];
}): FootageProbeDocument {
  const boundaries = deriveShotBoundaries(input.media, input.cuts, {
    detector: input.detector ?? "ffmpeg-scene",
    threshold: input.threshold ?? null,
  });
  return {
    shotBoundaries: boundaries,
    silences: input.silences,
    speech: {
      language: input.language ?? "zh",
      engine: input.speechEngine ?? null,
      words: [],
      sentences: [],
    },
    music: {
      detected: Boolean(input.bpm),
      bpm: input.bpm ?? null,
      beatGrid: input.beatGrid ?? [],
      downbeats: [],
      sections: [],
    },
    loudness: {
      envelope: input.envelope,
      peakMoments: peakMomentsOf(input.envelope),
    },
    technical: {
      // 逐镜技术指标需要逐镜抽帧计算（sharpness/stability/noise）；未计算时如实返回空表
      perShot: boundaries.map((boundary) => ({ index: boundary.index, sharpness: null, exposure: null, stability: null, noise: null, colorTempK: null })),
    },
    ...(input.volume ? { volumeDetect: input.volume } : {}),
  };
}
