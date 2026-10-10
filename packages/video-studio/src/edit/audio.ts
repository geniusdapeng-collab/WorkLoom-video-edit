/**
 * edit/audio.ts —— 声音侧纯函数：节拍估计、环境音画像、ASR/OCR 结果归一化。
 *
 * 为什么单独一层：
 *   · 声音在剪辑里是"半个片子"，但可量化的部分必须可复现（节拍网格/噪声底/覆盖率），
 *     不可量化的部分（环境音语义、音乐情绪）交理解层与配乐工位，不要让模型去算数学；
 *   · ASR/OCR 的原始输出各家格式不同，统一在这里归一化成契约字段，避免每个调用点各写一套。
 *
 * 纪律：估计不出来就返回 null + confidence（不猜一个"大概 120"糊过去）。
 */

export interface LoudnessPointLike {
  t: number;
  db: number;
}

export interface TempoEstimate {
  bpm: number | null;
  confidence: number;
  /** 节拍时刻（秒），用于卡点；估计失败时为空数组 */
  beatGrid: number[];
}

function toEnergy(db: number): number {
  return 10 ** (db / 20);
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index]!;
}

/**
 * 从响度包络估 BPM：能量归一化 → 起点强度（正向差分）→ 自相关取峰 → 相位对齐生成节拍网格。
 * 适用：有稳定鼓点/律动的素材（片头音乐、市集环境、活动现场）；纯人声/风噪会得到低置信度。
 */
export function estimateTempo(
  envelope: LoudnessPointLike[],
  options: { minBpm?: number; maxBpm?: number; hopSeconds?: number } = {},
): TempoEstimate {
  const minBpm = options.minBpm ?? 60;
  const maxBpm = options.maxBpm ?? 180;
  const hop = options.hopSeconds ?? 0.25;
  if (!(minBpm > 0 && maxBpm > minBpm && hop > 0)) throw new Error("节拍估计参数非法");
  if (envelope.length < 8) return { bpm: null, confidence: 0, beatGrid: [] };
  const span = envelope.at(-1)!.t - envelope[0]!.t;
  if (span < 8) return { bpm: null, confidence: 0, beatGrid: [] };

  const count = Math.floor(span / hop) + 1;
  const energy = new Array<number>(count).fill(0);
  let cursor = 0;
  for (let i = 0; i < count; i += 1) {
    const target = envelope[0]!.t + i * hop;
    while (cursor < envelope.length - 1 && envelope[cursor + 1]!.t <= target) cursor += 1;
    energy[i] = toEnergy(envelope[cursor]!.db);
  }
  const mean = energy.reduce((sum, value) => sum + value, 0) / count;
  const variance = energy.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count;
  const std = Math.sqrt(variance);
  if (!(std > 0)) return { bpm: null, confidence: 0, beatGrid: [] };
  const normalized = energy.map((value) => (value - mean) / std);
  const onset = normalized.map((value, index) => (index === 0 ? 0 : Math.max(0, value - normalized[index - 1]!)));

  const minLag = Math.max(1, Math.round(60 / maxBpm / hop));
  const maxLag = Math.min(count - 1, Math.round(60 / minBpm / hop));
  if (maxLag <= minLag) return { bpm: null, confidence: 0, beatGrid: [] };

  let bestLag = 0;
  let bestScore = 0;
  let scoreSum = 0;
  let scoreCount = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let score = 0;
    for (let i = lag; i < count; i += 1) score += onset[i]! * onset[i - lag]!;
    score /= count - lag;
    // 谐波惩罚：优先取"基础拍"而不是它的 2 倍（同一律动的常见误判）
    if (bestLag > 0 && Math.abs(lag - bestLag * 2) <= 1) score *= 0.8;
    scoreSum += score;
    scoreCount += 1;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  const meanScore = scoreCount > 0 ? scoreSum / scoreCount : 0;
  // 置信度 = 峰值/均值（按 3 倍均值为满分）。门槛 0.5：宁可返回 null，也不给风噪/人声标一个假 BPM
  // （实机教训：门槛 0.3 时，行车噪音/厨房环境音也会被标成 60/80/120 BPM）。
  const confidence = meanScore > 0 ? Math.min(1, bestScore / (meanScore * 3)) : 0;
  const onsetEvents = onset.filter((value) => value > 0.5).length;
  if (bestLag === 0 || confidence < 0.5 || onsetEvents < 12) {
    return { bpm: null, confidence: Number(confidence.toFixed(3)), beatGrid: [] };
  }

  const period = bestLag * hop;
  /**
   * 起音间隔规律性闸（把"说话节奏"挡在音乐之外）：
   *   取局部极值作为起音点，算相邻间隔（IOI）的变异系数 CV；CV > 0.3 视为非律动（对话/环境音），
   *   同时要求中位间隔与候选周期相差 ≤25%。实机教训：只靠自相关峰值，说话与市集噪音也会被标成 60/80 BPM。
   */
  const onsets: number[] = [];
  for (let i = 1; i < count - 1; i += 1) {
    if (onset[i]! > 0.5 && onset[i]! >= onset[i - 1]! && onset[i]! >= onset[i + 1]!) onsets.push(i * hop);
  }
  const intervals = onsets.slice(1).map((t, index) => t - onsets[index]!).filter((value) => value > 0);
  if (intervals.length < 8) return { bpm: null, confidence: Number(confidence.toFixed(3)), beatGrid: [] };
  const meanInterval = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  const varianceInterval = intervals.reduce((sum, value) => sum + (value - meanInterval) ** 2, 0) / intervals.length;
  const cv = meanInterval > 0 ? Math.sqrt(varianceInterval) / meanInterval : 1;
  const sortedIntervals = [...intervals].sort((a, b) => a - b);
  const medianInterval = sortedIntervals[Math.floor(sortedIntervals.length / 2)]!;
  const periodMismatch = Math.abs(medianInterval - period) / period;
  if (cv > 0.3 || periodMismatch > 0.25) {
    return { bpm: null, confidence: Number(confidence.toFixed(3)), beatGrid: [] };
  }

  const bpm = Number((60 / period).toFixed(1));
  let bestOffset = 0;
  let bestPhaseScore = -1;
  for (let step = 0; step < bestLag; step += 1) {
    let score = 0;
    for (let i = step; i < count; i += bestLag) score += onset[i]!;
    if (score > bestPhaseScore) {
      bestPhaseScore = score;
      bestOffset = step;
    }
  }
  const start = envelope[0]!.t + bestOffset * hop;
  const beatGrid: number[] = [];
  for (let t = start; t <= envelope.at(-1)!.t; t += period) beatGrid.push(Number(t.toFixed(3)));
  return { bpm, confidence: Number(confidence.toFixed(3)), beatGrid };
}

export interface AmbienceMetrics {
  /** 噪声底（响度包络 10 分位，dB） */
  noiseFloorDb: number | null;
  /** 动态范围（90 分位 − 10 分位，dB） */
  loudnessRangeDb: number | null;
  /** 静音覆盖率（0–1） */
  silenceCoverage: number | null;
  /** 人声覆盖率（0–1，来自 ASR 分段并集） */
  speechCoverage: number | null;
  /** 峰值点数量（供卡点/高光参考） */
  peakCount: number;
}

function unionSeconds(spans: Array<{ start: number; end: number }>): number {
  const sorted = [...spans].filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  let total = 0;
  let currentEnd = Number.NEGATIVE_INFINITY;
  for (const span of sorted) {
    if (span.start > currentEnd) {
      total += span.end - span.start;
      currentEnd = span.end;
    } else if (span.end > currentEnd) {
      total += span.end - currentEnd;
      currentEnd = span.end;
    }
  }
  return total;
}

/**
 * 环境音画像（可量化部分）：
 *   噪声底 / 动态范围 / 静音覆盖率 / 人声覆盖率 / 峰值点数量。
 * 语义标签（风声、市集人声、车流、厨房）由理解层写进 `shots[].audio.ambience`，本函数不猜语义。
 */
export function deriveAmbienceMetrics(input: {
  envelope: LoudnessPointLike[];
  silences: Array<{ start: number; end: number }>;
  speechSegments: Array<{ start: number; end: number }>;
  durationSeconds: number;
}): AmbienceMetrics {
  const { envelope, silences, speechSegments, durationSeconds } = input;
  if (!(durationSeconds > 0)) throw new Error("durationSeconds 必须为正数");
  const dbs = envelope.map((point) => point.db);
  const p10 = percentile(dbs, 0.1);
  const p90 = percentile(dbs, 0.9);
  const p75 = percentile(dbs, 0.75);
  const peaks = p75 === null ? 0 : envelope.filter((point) => point.db >= p75 + 6).length;
  return {
    noiseFloorDb: p10 === null ? null : Number(p10.toFixed(2)),
    loudnessRangeDb: p10 === null || p90 === null ? null : Number((p90 - p10).toFixed(2)),
    silenceCoverage: Number((unionSeconds(silences) / durationSeconds).toFixed(3)),
    speechCoverage: Number((unionSeconds(speechSegments) / durationSeconds).toFixed(3)),
    peakCount: peaks,
  };
}

export interface NormalizedSpeech {
  language: string;
  engine: string | null;
  precision: "word" | "segment" | "none";
  words: Array<{ text: string; start: number; end: number; confidence?: number | null }>;
  sentences: Array<{ text: string; start: number; end: number; pauseAfterSeconds?: number | null }>;
}

/**
 * 归一化 ASR 引擎返回（OpenAI 兼容 `/v1/audio/transcriptions` 的 verbose_json 形态）。
 * 只有句级时间戳时 `precision="segment"` —— 如实标注精度，不冒充词级（下游据此决定能否做逐字对齐）。
 */
export function normalizeAsrResponse(parsed: unknown, options: { language?: string; engine?: string | null } = {}): NormalizedSpeech {
  const doc = (parsed ?? {}) as {
    segments?: Array<{ start?: number; end?: number; text?: string; words?: Array<{ word?: string; start?: number; end?: number }> }>;
  };
  const sentences: NormalizedSpeech["sentences"] = [];
  const words: NormalizedSpeech["words"] = [];
  for (const segment of doc.segments ?? []) {
    const text = String(segment.text ?? "").trim();
    if (!text) continue;
    const start = Number(segment.start ?? 0);
    const end = Number(segment.end ?? start);
    sentences.push({ text, start: Number(start.toFixed(3)), end: Number(end.toFixed(3)), pauseAfterSeconds: null });
    for (const word of segment.words ?? []) {
      const value = String(word.word ?? "").trim();
      if (!value) continue;
      words.push({
        text: value,
        start: Number(Number(word.start ?? start).toFixed(3)),
        end: Number(Number(word.end ?? end).toFixed(3)),
        confidence: null,
      });
    }
  }
  for (let i = 0; i < sentences.length - 1; i += 1) {
    sentences[i]!.pauseAfterSeconds = Number(Math.max(0, sentences[i + 1]!.start - sentences[i]!.end).toFixed(3));
  }
  const precision: NormalizedSpeech["precision"] = words.length > 0 ? "word" : sentences.length > 0 ? "segment" : "none";
  return {
    language: options.language ?? "zh",
    engine: options.engine ?? null,
    precision,
    words,
    sentences,
  };
}

export interface OcrObservation {
  t: number;
  texts: string[];
}

/** 解析 OCR 工具输出的 JSONL（每行 {t, texts[]}）；坏行跳过但计数，由调用方写入回执 */
export function parseOcrJsonl(text: string): { observations: OcrObservation[]; skippedLines: number } {
  const observations: OcrObservation[] = [];
  let skippedLines = 0;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { t?: unknown; texts?: unknown };
      const t = Number(parsed.t);
      const texts = Array.isArray(parsed.texts) ? parsed.texts.map((value) => String(value).trim()).filter(Boolean) : [];
      if (!Number.isFinite(t) || texts.length === 0) {
        skippedLines += 1;
        continue;
      }
      observations.push({ t: Number(t.toFixed(3)), texts });
    } catch {
      skippedLines += 1;
    }
  }
  return { observations: observations.sort((a, b) => a.t - b.t), skippedLines };
}
