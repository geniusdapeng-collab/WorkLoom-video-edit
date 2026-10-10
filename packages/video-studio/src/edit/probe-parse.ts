/**
 * edit/probe-parse.ts —— 信号层解析（确定性、可复现、零模型成本）
 *
 * 输入是 ffprobe / ffmpeg 的原始文本输出，输出是 footage-analysis 契约里的 `probe` 结构。
 * 为什么把解析独立成纯函数：真机里"解析错"与"检测错"经常被混为一谈；把文本→结构的换算
 * 做成纯函数后，两类问题可以分别复现（喂同一段日志必须得到同一个结果）。
 *
 * 支持的 ffmpeg 通道（与 skills/shot-understanding 的口径一致）：
 *   ① 场景切点：`-vf "scdet=threshold=…,metadata=print"` → `lavfi.scd.time/score`（首选，带分数）；
 *      兼容旧通道 `select='gt(scene,0.3)',showinfo` → `pts_time:`（无分数，置信度按"检出即 1"处理）
 *   ② 静音/停顿：`-af silencedetect=noise=-30dB:d=0.25` → `silence_start/silence_end`
 *   ③ 响度包络：`-af "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level"`
 *   ④ 峰值电平：`-af volumedetect` → `mean_volume / max_volume`
 *   ⑤ 逐镜技术指标：`-vf "blurdetect,signalstats,metadata=print"` → 清晰度（blurdetect）/曝光（YAVG）
 *
 * 纪律：
 *   · 解析不到就如实返回空数组/0，不编造数值；
 *   · 没测过的指标写 null（例如未测 LUFS 时不冒充）；
 *   · 代理指标（清晰度/曝光）在 `technical.ts` 里只做"粗筛"，语义质量仍由镜头理解与人工复核负责；
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

/** 场景切点（带检测器分数；旧通道拿不到分数时 score=null） */
export interface SceneCutDetail {
  time: number;
  score: number | null;
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

/**
 * 场景检测日志 → 切点明细（秒 + 分数）。
 * 支持两种通道：
 *   · scdet：`[scdet @ …] lavfi.scd.score: 15.887, lavfi.scd.time: 2`（一行同时给分数与时刻）；
 *   · 旧 select+showinfo：`pts_time:2.02297`（只有时刻）。
 * 同一时刻重复出现时保留最大分数（同一帧可能被多次打印）。
 */
export function parseSceneCutDetails(log: string): SceneCutDetail[] {
  const byTime = new Map<number, number | null>();
  // scdet 一行式：score 在前、time 在后（顺序以 ffmpeg 6.0 实测为准，也兼容 time 在前的变体）
  for (const line of log.split(/\r?\n/u)) {
    const scoreMatched = /lavfi\.scd\.score:\s*([0-9]+(?:\.[0-9]+)?)/u.exec(line);
    const timeMatched = /lavfi\.scd\.time:\s*([0-9]+(?:\.[0-9]+)?)/u.exec(line);
    if (scoreMatched && timeMatched) {
      const time = Number(timeMatched[1]);
      const score = Number(scoreMatched[1]);
      if (!Number.isFinite(time) || time < 0 || !Number.isFinite(score)) continue;
      const previous = byTime.get(time);
      byTime.set(time, previous === undefined || previous === null ? score : Math.max(previous, score));
    }
  }
  for (const line of log.split(/\r?\n/u)) {
    /**
     * 只有 showinfo 的帧行才算旧通道切点。
     * `metadata=print` 的块头也长成 `frame:N pts:… pts_time:…`——如果不排除，
     * 每个视频帧都会被当成一个"切点"（实机踩坑：4 秒测试片被解析成 9 个镜头）。
     */
    if (!/\[Parsed_showinfo_[^\]]*\]/u.test(line) && !/\bn:\s*\d+\s+pts:/u.test(line)) continue;
    const matched = /pts_time:([0-9]+(?:\.[0-9]+)?)/u.exec(line);
    if (!matched) continue;
    const t = Number(matched[1]);
    if (!Number.isFinite(t) || t < 0) continue;
    if (!byTime.has(t)) byTime.set(t, null);
  }
  return [...byTime.entries()]
    .map(([time, score]) => ({ time, score }))
    .sort((a, b) => a.time - b.time);
}

/** 场景检测日志 → 切点时刻（秒）；保留旧签名，内部走 `parseSceneCutDetails`。 */
export function parseSceneCuts(log: string): number[] {
  return parseSceneCutDetails(log).map((cut) => cut.time);
}

/**
 * 切点置信度：`score / (score + threshold)`。
 *
 * 为什么不用固定值：scdet 分数与阈值同量纲（0–100 的 MAFD 百分比，阈值默认 10），
 * 15 分与 80 分显然不是同一种"确定"；soft-clamp 让置信度随分数单调上升且恒在 (0,1)，
 * 不复用任何拍脑袋常数。旧通道拿不到分数时返回 1（=仅代表"检测器报了这条切点"，
 * 不冒充概率，回执里用 `detector` 字段区分）。
 */
export function confidenceFromSceneScore(score: number | null | undefined, threshold: number | null | undefined): number {
  if (score === null || score === undefined || !Number.isFinite(score)) return 1;
  const safeThreshold = Number.isFinite(threshold as number) && (threshold as number) > 0 ? (threshold as number) : 10;
  if (score <= 0) return 0;
  return Number(Math.min(1, score / (score + safeThreshold)).toFixed(3));
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
    /**
     * RMS_level 可能是 `-inf`（数字静音/无信号）：如实折算成一个可计算的下限值（-120dB），
     * 而不是丢弃该采样点——否则整段静音素材会被误判成"没有包络"，噪声底与静音覆盖都会失真。
     */
    const rmsMatched = /RMS_level=(-?(?:inf|[0-9]+(?:\.[0-9]+)?))/u.exec(line);
    if (rmsMatched && pendingTime !== null) {
      const db = /inf/u.test(rmsMatched[1]!) ? -120 : Number(rmsMatched[1]);
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

/* ============================ 逐镜技术指标（代理指标） ============================ */

/**
 * 单帧技术统计（来自 `blurdetect,signalstats,metadata=print` 一次解码）。
 * 只收"能直接量出来"的字段；拿不到的写 null，不用默认值冒充。
 */
export interface FrameStat {
  t: number;
  /** blurdetect 的 `lavfi.blur`：越小越锐（静止纯色画面也会偏小，仅作代理） */
  blur: number | null;
  /** 帧平均亮度（signalstats YAVG，0–255） */
  yavg: number | null;
  /** 高光/阴影分位（用于判断过曝/死黑，0–255） */
  yhigh: number | null;
  ylow: number | null;
  /** 平均饱和度（SATAVG） */
  satavg: number | null;
}

/**
 * 解析 `metadata=print:file=-` 输出（blurdetect + signalstats 混排）。
 * 结构是"以 `frame:N pts_time:t` 开头的一块，块内若干 `lavfi.*=v`"，按块合并；
 * 同一时刻重复出现时后写的非空值优先（调用方只喂一次解码，重复只为容错）。
 */
export function parseFrameStats(log: string): FrameStat[] {
  const byTime = new Map<number, FrameStat>();
  let current: { t: number; blur: number | null; yavg: number | null; yhigh: number | null; ylow: number | null; satavg: number | null } | null = null;
  const flush = () => {
    if (!current) return;
    const previous = byTime.get(current.t);
    byTime.set(current.t, {
      t: current.t,
      blur: current.blur ?? previous?.blur ?? null,
      yavg: current.yavg ?? previous?.yavg ?? null,
      yhigh: current.yhigh ?? previous?.yhigh ?? null,
      ylow: current.ylow ?? previous?.ylow ?? null,
      satavg: current.satavg ?? previous?.satavg ?? null,
    });
    current = null;
  };
  for (const line of log.split(/\r?\n/u)) {
    const header = /frame:\s*\d+\s+pts:\s*\d+\s+pts_time:\s*([0-9]+(?:\.[0-9]+)?)/u.exec(line);
    if (header) {
      flush();
      const t = Number(header[1]);
      if (!Number.isFinite(t)) continue;
      current = { t, blur: null, yavg: null, yhigh: null, ylow: null, satavg: null };
      continue;
    }
    if (!current) continue;
    const value = (key: string): number | null => {
      const matched = new RegExp(`lavfi\\.${key}=(-?[0-9]+(?:\\.[0-9]+)?)`, "u").exec(line);
      return matched ? Number(matched[1]) : null;
    };
    if (line.includes("lavfi.blur=")) current.blur = value("blur");
    else if (line.includes("lavfi.signalstats.YAVG=")) current.yavg = value("signalstats\\.YAVG");
    else if (line.includes("lavfi.signalstats.YHIGH=")) current.yhigh = value("signalstats\\.YHIGH");
    else if (line.includes("lavfi.signalstats.YLOW=")) current.ylow = value("signalstats\\.YLOW");
    else if (line.includes("lavfi.signalstats.SATAVG=")) current.satavg = value("signalstats\\.SATAVG");
  }
  flush();
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/**
 * 清晰度代理：blurdetect 实测标定（本机 ffmpeg 6.0，testsrc2 合成素材）。
 *   · 锐利 ≈ 5（含静止纯色画面的下限）；软 ≈ 10.5（高斯 σ=1.5）；糊 ≈ 17+（σ=4）。
 * 线性映射到 0–1，低于 SHARP 记 1（"没有可辨的糊"），高于 BLURRED 记 0。
 * ⚠ 局限：blurdetect 对"无细节纯色/大天空"会给出低分（看似很锐），所以它只用于
 *   同片内相对筛选与明显糊帧拦截，不作为美学结论；语义质量由镜头理解与人工复核负责。
 */
export const BLUR_PROXY = { sharp: 5, blurred: 18 } as const;

export function sharpnessScore(blur: number | null | undefined): number | null {
  if (blur === null || blur === undefined || !Number.isFinite(blur)) return null;
  const { sharp, blurred } = BLUR_PROXY;
  return Number(Math.min(1, Math.max(0, (blurred - blur) / (blurred - sharp))).toFixed(3));
}

/**
 * 曝光代理：以 YAVG 落在 [YAVG_LOW, YAVG_HIGH] 为满分区（与 color-recipes 的 YAVG 目标 80–140 同口径），
 * 越暗/越亮按距离线性扣分；YHIGH 贴顶（≥250）或 YLOW 贴底（≤5）时按 0.15/次扣（过曝/死黑惩罚）。
 */
export const EXPOSURE_PROXY = { yavgLow: 80, yavgHigh: 140, clippedHigh: 250, clippedLow: 5 } as const;

export function exposureScore(yavg: number | null | undefined, options: { yhigh?: number | null; ylow?: number | null } = {}): number | null {
  if (yavg === null || yavg === undefined || !Number.isFinite(yavg)) return null;
  const { yavgLow, yavgHigh, clippedHigh, clippedLow } = EXPOSURE_PROXY;
  let score: number;
  if (yavg < yavgLow) score = Math.max(0, 1 - (yavgLow - yavg) / yavgLow);
  else if (yavg > yavgHigh) score = Math.max(0, 1 - (yavg - yavgHigh) / (255 - yavgHigh));
  else score = 1;
  if (Number.isFinite(options.yhigh as number) && (options.yhigh as number) >= clippedHigh) score -= 0.15;
  if (Number.isFinite(options.ylow as number) && (options.ylow as number) <= clippedLow) score -= 0.15;
  return Number(Math.min(1, Math.max(0, score)).toFixed(3));
}

/**
 * 逐镜技术指标聚合：把帧级统计按镜头区间取中位数（抗单帧噪声），输出契约
 * `probe.technical.perShot[]` 形状。stability/noise/colorTempK 保持 null——
 * 它们需要光流/噪声模型/白平衡估计，本模块不冒充（见 docs/video-edit-architecture.md §10 已知未完成清单）。
 */
export function aggregateShotTechnicals(
  boundaries: Array<Pick<ShotBoundary, "index" | "inFrame" | "outFrame" | "inTimecode" | "outTimecode">>,
  frames: FrameStat[],
): Array<{ index: number; sharpness: number | null; exposure: number | null; stability: number | null; noise: number | null; colorTempK: number | null }> {
  const sorted = [...frames].sort((a, b) => a.t - b.t);
  const median = (values: number[]): number | null => {
    if (values.length === 0) return null;
    const list = [...values].sort((a, b) => a - b);
    const middle = Math.floor(list.length / 2);
    return list.length % 2 === 0 ? (list[middle - 1]! + list[middle]!) / 2 : list[middle]!;
  };
  return boundaries.map((boundary) => {
    const start = parseTimecodeSeconds(boundary.inTimecode);
    const end = parseTimecodeSeconds(boundary.outTimecode);
    const inside = sorted.filter((frame) => frame.t >= start && frame.t < end);
    const blur = median(inside.map((frame) => frame.blur).filter((value): value is number => value !== null));
    const yavg = median(inside.map((frame) => frame.yavg).filter((value): value is number => value !== null));
    const yhigh = inside.map((frame) => frame.yhigh).filter((value): value is number => value !== null);
    const ylow = inside.map((frame) => frame.ylow).filter((value): value is number => value !== null);
    return {
      index: boundary.index,
      sharpness: sharpnessScore(blur),
      exposure: exposureScore(yavg, {
        yhigh: yhigh.length ? Math.max(...yhigh) : null,
        ylow: ylow.length ? Math.min(...ylow) : null,
      }),
      stability: null,
      noise: null,
      colorTempK: null,
    };
  });
}

/** `HH:MM:SS.mmm` → 秒（本模块内部用；非法格式返回 0，由上游保证格式合法） */
function parseTimecodeSeconds(timecode: string): number {
  const matched = /^([0-9]{2}):([0-9]{2}):([0-9]{2})\.([0-9]{3})$/u.exec(timecode);
  if (!matched) return 0;
  return Number(matched[1]) * 3600 + Number(matched[2]) * 60 + Number(matched[3]) + Number(matched[4]) / 1000;
}

/**
 * 自适应静音阈值：`noiseFloorDb + margin`，再夹取到 [min, max]。
 * 为什么不用固定 -30dB：高底噪素材（街头/厨房/风噪）里固定阈值会把"停顿"全吃掉，
 * 低底噪素材里又过于宽松；噪声底由 RMS 包络 10 分位给出（本模块不测音频，值由调用方传入）。
 */
export function deriveSilenceThresholdDb(input: {
  noiseFloorDb: number | null | undefined;
  fallbackDb?: number;
  marginDb?: number;
  minDb?: number;
  maxDb?: number;
}): number {
  const { noiseFloorDb, fallbackDb = -30, marginDb = 6, minDb = -50, maxDb = -20 } = input;
  if (noiseFloorDb === null || noiseFloorDb === undefined || !Number.isFinite(noiseFloorDb)) return fallbackDb;
  return Number(Math.min(maxDb, Math.max(minDb, noiseFloorDb + marginDb)).toFixed(1));
}

/**
 * 切点 → 镜头区间（MECE：首尾闭合、无重叠、覆盖全片）。
 * 传入的 cut 时刻若超出时长或与相邻切点过近（< minShotSeconds）会被丢弃，避免产生碎片镜头。
 */
export function deriveShotBoundaries(
  media: Pick<ProbeMedia, "durationSeconds" | "fps">,
  cuts: Array<number | SceneCutDetail>,
  options: { detector?: string; threshold?: number | null; minShotSeconds?: number } = {},
): ShotBoundary[] {
  const { detector = "ffmpeg-scene", threshold = null, minShotSeconds = 0.4 } = options;
  const details: SceneCutDetail[] = cuts
    .map((cut) => (typeof cut === "number" ? { time: cut, score: null } : cut))
    .filter((cut) => Number.isFinite(cut.time) && cut.time > minShotSeconds && cut.time < media.durationSeconds - minShotSeconds)
    .sort((a, b) => a.time - b.time);
  const marks: number[] = [0];
  const keptScores: Array<number | null> = [];
  for (const cut of details) {
    if (cut.time - marks[marks.length - 1]! >= minShotSeconds) {
      marks.push(cut.time);
      keptScores.push(cut.score);
    }
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
      /**
       * 置信度语义：该镜头"起始切点"是真实切点的把握。
       *   · 首镜（i=0）：没有前置切点，恒 1（整段起点由素材时长决定，不存在漏检问题）；
       *   · 其余镜：scdet 有分数时按 `score/(score+threshold)`；旧通道无分数时为 1（见函数注释）。
       */
      confidence: i === 0 ? 1 : confidenceFromSceneScore(keptScores[i - 1] ?? null, threshold),
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
  cuts: Array<number | SceneCutDetail>;
  silences: SilenceSpan[];
  envelope: LoudnessPoint[];
  volume?: VolumeDetect;
  detector?: string;
  threshold?: number | null;
  language?: string;
  speechEngine?: string | null;
  bpm?: number | null;
  beatGrid?: number[];
  /** 逐镜技术指标（由 `aggregateShotTechnicals` 计算；缺省时如实写空表） */
  technicalPerShot?: Array<Record<string, number | null>>;
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
      // sharpness/exposure 由 blurdetect+signalstats 代理计算；stability/noise/colorTempK 未实现，保持 null 不冒充
      perShot: input.technicalPerShot
        ?? boundaries.map((boundary) => ({ index: boundary.index, sharpness: null, exposure: null, stability: null, noise: null, colorTempK: null })),
    },
    ...(input.volume ? { volumeDetect: input.volume } : {}),
  };
}
