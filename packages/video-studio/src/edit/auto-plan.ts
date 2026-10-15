/**
 * edit/auto-plan.ts —— 零输入自动排片（确定性粗剪计划，纯函数）。
 *
 * 定位：**本地兜底/起手式**。当用户只丢素材、没有任何创作输入时，系统仍然要交出一条
 * "能看、能懂、能改"的粗剪：按素材顺序选镜、按质量与信息量打分、凑到目标时长，
 * 再由后期链路补调色/字幕/配乐/封面/多变体。
 *
 * 它不是要替代镜头理解与创意评审（那条链更懂内容），而是解决三个现实问题：
 *   ① LLM 阶段尚未跑、或用户就想先看一版时，能立刻出片；
 *   ② 给创意岗一个"素材事实骨架"（哪些镜头质量可用、哪些有语音/画面文字）；
 *   ③ 全流程可复算、可解释（每个入选镜头带分数与理由）。
 *
 * 纪律：
 *   · 只选真实存在的镜头区间，不改写时间码；质量分缺失写 0.5（中性）并标注，不编造；
 *   · 不违反时间轴契约：同源片段间隔 ≥1s（相邻镜头优先合并，不可合并则窗口平移）；
 *   · 目标时长不足时如实少给（不硬凑），超出时截断并记录。
 */

import type { EditTimeline, EditTimelineSegment } from "./timeline.js";

export interface AutoPlanAnalysisDoc {
  asset?: {
    sha256?: string;
    localPath?: string | null;
    filename?: string;
    durationSeconds?: number | null;
    fps?: number | null;
    hasAudio?: boolean | null;
  } | null;
  probe?: {
    shotBoundaries?: Array<{ index?: number; inTimecode?: string; outTimecode?: string; durationSeconds?: number }> | null;
    technical?: { perShot?: Array<{ index?: number; sharpness?: number | null; exposure?: number | null }> } | null;
    speech?: { sentences?: Array<{ text?: string; start?: number; end?: number }>; words?: Array<{ text?: string; start?: number; end?: number }> } | null;
  } | null;
  shots?: Array<{
    shotId?: string;
    index?: number;
    inTimecode?: string;
    outTimecode?: string;
    durationSeconds?: number;
    sceneType?: string;
    content?: { keyEntities?: string[]; speechText?: string | null } | null;
    quality?: { score?: number | null } | null;
    editing?: { usage?: string[] } | null;
  }> | null;
}

export interface AutoPlanSource {
  sourceId: string;
  path: string;
  sha256: string;
  fps: number;
  durationSeconds?: number | null;
  hasAudio?: boolean | null;
  analysis: AutoPlanAnalysisDoc;
}

export interface AutoPlanSelected {
  segmentId: string;
  sourceId: string;
  shotId: string;
  sourceIn: number;
  sourceOut: number;
  durationSeconds: number;
  score: number;
  reason: string;
  mergedFrom: number;
  shiftedForGap: number;
}

export interface AutoPlanResult {
  timeline: EditTimeline;
  selected: AutoPlanSelected[];
  skipped: Array<{ sourceId: string; shotId: string; reason: string }>;
  targetSeconds: number;
  plannedSeconds: number;
  notes: string[];
}

function parseTimecodeSeconds(value: string | undefined | null): number | null {
  if (!value) return null;
  const matched = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/u.exec(value);
  if (!matched) return null;
  return Number(matched[1]) * 3600 + Number(matched[2]) * 60 + Number(matched[3]) + Number(matched[4]) / 1000;
}

function textLength(text: string): number {
  return [...String(text ?? "").replace(/[\s，。！？、,.!?;；:："'“”‘’()（）\[\]【】…—\-·~@#$%^&*+=|\\/<>{}]/gu, "")].length;
}

interface Candidate {
  sourceId: string;
  shotId: string;
  inSeconds: number;
  outSeconds: number;
  durationSeconds: number;
  sceneType: string;
  speechChars: number;
  qualityScore: number | null;
  score: number;
  reason: string;
}

function durationFitScore(duration: number, min: number, max: number): number {
  if (duration < min) return 0;
  if (duration <= max) return 1;
  return Math.max(0, 1 - (duration - max) / Math.max(1, max));
}

/**
 * 生成自动粗剪时间轴。
 *
 * 选镜策略（可复算）：
 *   · 候选 = 每个素材的镜头（优先镜头理解产物，其次信号层 shotBoundaries）；
 *   · 单镜窗口 = min(镜头时长, maxShotSeconds)；超长镜头取**居中窗口**（不硬去头去尾）；
 *   · 打分 = 0.35×画质 + 0.25×语音信息量 + 0.25×时长适配 + 0.15×镜头类型；
 *   · 选择 = 按素材/源轨顺序走（保持时间因果），质量分低于阈值的先跳过，不足时长再按分数回填；
 *     同源相邻候选优先合并（≤maxShotSeconds×1.5），不可合并则把窗口后移补足 ≥1s 间隔，
 *     保证满足"同源片段间隔 ≥1s"的硬契约。
 */
export function planAutoTimeline(input: {
  sources: AutoPlanSource[];
  timelineId: string;
  filmId?: string | null;
  target: { durationSeconds: number; aspectRatio: string; fps: number; platform: string; loudnessTargetLufs?: number | null };
  pacing?: "documentary" | "vlog" | "fast_cut" | "information" | "talk";
  minShotSeconds?: number;
  maxShotSeconds?: number;
  qualityFloor?: number;
  /** Source-scoped shot reservations for a downstream rhythm director; never synthesize missing clips. */
  reservedShotIds?: Record<string, string[]>;
}): AutoPlanResult {
  const minShotSeconds = input.minShotSeconds ?? 1.0;
  const maxShotSeconds = input.maxShotSeconds ?? 8;
  const qualityFloor = input.qualityFloor ?? 0.35;
  const targetSeconds = input.target.durationSeconds;
  const notes: string[] = [];
  const skipped: AutoPlanResult["skipped"] = [];

  const candidates: Candidate[] = [];
  for (const source of input.sources) {
    const analysis = source.analysis;
    const technical = new Map<number, { sharpness: number | null; exposure: number | null }>();
    for (const entry of analysis.probe?.technical?.perShot ?? []) {
      if (typeof entry.index === "number") technical.set(entry.index, { sharpness: entry.sharpness ?? null, exposure: entry.exposure ?? null });
    }
    const speechSentences = analysis.probe?.speech?.sentences ?? [];
    const shots = analysis.shots && analysis.shots.length > 0
      ? analysis.shots.map((shot, index) => ({
        shotId: shot.shotId ?? `${source.sourceId}-shot-${index + 1}`,
        index: shot.index ?? index,
        inSeconds: parseTimecodeSeconds(shot.inTimecode ?? null),
        outSeconds: parseTimecodeSeconds(shot.outTimecode ?? null),
        durationSeconds: shot.durationSeconds ?? null,
        sceneType: shot.sceneType ?? "unknown",
        qualityScore: shot.quality?.score ?? null,
      }))
      : (analysis.probe?.shotBoundaries ?? []).map((boundary, index) => ({
        shotId: `${source.sourceId}-s${String((boundary.index ?? index) + 1).padStart(3, "0")}`,
        index: boundary.index ?? index,
        inSeconds: parseTimecodeSeconds(boundary.inTimecode ?? null),
        outSeconds: parseTimecodeSeconds(boundary.outTimecode ?? null),
        durationSeconds: boundary.durationSeconds ?? null,
        sceneType: "unknown",
        qualityScore: null,
      }));
    for (const shot of shots) {
      if (input.reservedShotIds?.[source.sourceId]?.includes(shot.shotId)) {
        skipped.push({ sourceId: source.sourceId, shotId: shot.shotId, reason: "为首尾节奏段预留，正文不抢占同一源区间" });
        continue;
      }
      if (shot.inSeconds === null || shot.outSeconds === null || !(shot.outSeconds > shot.inSeconds)) {
        skipped.push({ sourceId: source.sourceId, shotId: shot.shotId, reason: "时间码缺失或非法" });
        continue;
      }
      const rawDuration = shot.outSeconds - shot.inSeconds;
      if (rawDuration < minShotSeconds) {
        skipped.push({ sourceId: source.sourceId, shotId: shot.shotId, reason: `镜头 ${rawDuration.toFixed(2)}s < 下限 ${minShotSeconds}s` });
        continue;
      }
      const windowDuration = Math.min(rawDuration, maxShotSeconds);
      const inSeconds = Number((shot.inSeconds + (rawDuration - windowDuration) / 2).toFixed(3));
      const outSeconds = Number((inSeconds + windowDuration).toFixed(3));
      const speechChars = speechSentences
        .filter((sentence) => Number(sentence.end ?? 0) > inSeconds && Number(sentence.start ?? 0) < outSeconds)
        .reduce((sum, sentence) => sum + textLength(String(sentence.text ?? "")), 0);
      const tech = technical.get(shot.index) ?? { sharpness: null, exposure: null };
      const qualityValues = [tech.sharpness, tech.exposure].filter((value): value is number => typeof value === "number");
      const quality = qualityValues.length > 0 ? qualityValues.reduce((sum, value) => sum + value, 0) / qualityValues.length : null;
      const effectiveQuality = quality ?? shot.qualityScore ?? 0.5;
      const speechScore = Math.min(1, speechChars / 20);
      const fit = durationFitScore(windowDuration, 2, 6);
      const sceneScore = shot.sceneType === "b_roll_insert" ? 0.4 : shot.sceneType === "unknown" ? 0.5 : 0.7;
      const score = Number((0.35 * effectiveQuality + 0.25 * speechScore + 0.25 * fit + 0.15 * sceneScore).toFixed(3));
      candidates.push({
        sourceId: source.sourceId,
        shotId: shot.shotId,
        inSeconds,
        outSeconds,
        durationSeconds: Number(windowDuration.toFixed(3)),
        sceneType: shot.sceneType,
        speechChars,
        qualityScore: quality,
        score,
        reason: `画质 ${quality === null ? "未测(0.5)" : quality.toFixed(2)}｜语音 ${speechChars} 字｜时长适配 ${fit.toFixed(2)}｜场景 ${shot.sceneType}`,
      });
    }
  }

  const selected: AutoPlanSelected[] = [];
  const lastOutBySource = new Map<string, number>();
  const recomputePlanned = (): number => Number(selected.reduce((sum, entry) => sum + entry.durationSeconds, 0).toFixed(3));
  let planned = 0;
  const accept = (candidate: Candidate, mergedFrom = 1, shiftedForGap = 0): void => {
    selected.push({
      segmentId: `auto-${String(selected.length + 1).padStart(3, "0")}`,
      sourceId: candidate.sourceId,
      shotId: candidate.shotId,
      sourceIn: candidate.inSeconds,
      sourceOut: candidate.outSeconds,
      durationSeconds: candidate.durationSeconds,
      score: candidate.score,
      reason: candidate.reason,
      mergedFrom,
      shiftedForGap,
    });
    lastOutBySource.set(candidate.sourceId, candidate.outSeconds);
    planned = recomputePlanned();
  };
  const sourceOrder = new Map(input.sources.map((source, index) => [source.sourceId, index]));
  const ordered = [...candidates].sort((a, b) => {
    const delta = (sourceOrder.get(a.sourceId) ?? 0) - (sourceOrder.get(b.sourceId) ?? 0);
    return delta !== 0 ? delta : a.inSeconds - b.inSeconds;
  });
  const remaining: Candidate[] = [];
  for (const candidate of ordered) {
    if (planned >= targetSeconds) break;
    const hasBetterUnselected = candidates.some((other) =>
      other.score >= qualityFloor && other !== candidate && !selected.some((entry) => entry.shotId === other.shotId));
    if (candidate.score < qualityFloor && hasBetterUnselected) {
      skipped.push({ sourceId: candidate.sourceId, shotId: candidate.shotId, reason: `质量分 ${candidate.score} < 阈值 ${qualityFloor}（留待回填）` });
      remaining.push(candidate);
      continue;
    }
    const lastOut = lastOutBySource.get(candidate.sourceId) ?? Number.NEGATIVE_INFINITY;
    const gap = candidate.inSeconds - lastOut;
    if (Number.isFinite(gap) && gap < 1.0 && gap > -0.02) {
      const previous = [...selected].reverse().find((entry) => entry.sourceId === candidate.sourceId);
      const mergedDuration = previous ? Number((candidate.outSeconds - previous.sourceIn).toFixed(3)) : Number.POSITIVE_INFINITY;
      if (previous && mergedDuration <= maxShotSeconds * 1.5 && recomputePlanned() - previous.durationSeconds + mergedDuration <= targetSeconds * 1.08) {
        previous.sourceOut = candidate.outSeconds;
        previous.durationSeconds = mergedDuration;
        previous.score = Number(((previous.score * previous.mergedFrom + candidate.score) / (previous.mergedFrom + 1)).toFixed(3));
        previous.mergedFrom += 1;
        previous.reason = `${previous.reason}；并入相邻镜头 ${candidate.shotId}`;
        lastOutBySource.set(candidate.sourceId, candidate.outSeconds);
        planned = recomputePlanned();
        continue;
      }
      const shift = Number((1.0 - gap).toFixed(3));
      const shiftedIn = Number((candidate.inSeconds + shift).toFixed(3));
      if (candidate.outSeconds - shiftedIn >= minShotSeconds) {
        candidate.inSeconds = shiftedIn;
        candidate.durationSeconds = Number((candidate.outSeconds - shiftedIn).toFixed(3));
        skipped.push({ sourceId: candidate.sourceId, shotId: candidate.shotId, reason: `为满足同源间隔 ≥1s 平移 +${shift}s` });
        accept(candidate, 1, shift);
      } else {
        skipped.push({ sourceId: candidate.sourceId, shotId: candidate.shotId, reason: "与上一段间隔不足且无法平移（长度不够）" });
      }
      continue;
    }
    if (Number.isFinite(gap) && gap < 0) {
      skipped.push({ sourceId: candidate.sourceId, shotId: candidate.shotId, reason: "与已选片段源轨重叠" });
      continue;
    }
    accept(candidate);
  }
  if (planned < targetSeconds * 0.6) {
    for (const candidate of [...remaining].sort((a, b) => b.score - a.score)) {
      if (planned >= targetSeconds) break;
      if (selected.some((entry) => entry.shotId === candidate.shotId)) continue;
      const lastOut = lastOutBySource.get(candidate.sourceId) ?? Number.NEGATIVE_INFINITY;
      const gap = candidate.inSeconds - lastOut;
      if (Number.isFinite(gap) && gap < 1.0 && gap > -0.02) continue;
      accept(candidate);
      notes.push(`素材不足：回填质量分较低镜头 ${candidate.shotId}（分 ${candidate.score}）`);
    }
  }

  const segments: EditTimelineSegment[] = selected.map((entry, index) => ({
    seq: index,
    segmentId: entry.segmentId,
    groupId: null,
    sourceId: entry.sourceId,
    sourceIn: entry.sourceIn,
    sourceOut: entry.sourceOut,
    durationSeconds: entry.durationSeconds,
    speed: 1,
    motive: `自动粗剪：${entry.reason}`,
    transitionIn: { type: "cut", durationSeconds: 0 },
    audio: { mode: "original", gainDb: 0, note: "自动粗剪保留原声" },
  }));
  const totalDuration = Number(segments.reduce((sum, segment) => sum + segment.durationSeconds, 0).toFixed(3));
  if (totalDuration < targetSeconds * 0.85) {
    notes.push(`计划时长 ${totalDuration}s 低于目标 ${targetSeconds}s 的 85%：可用素材/质量门槛不足，如实少给（不硬凑）`);
  }
  const timeline: EditTimeline = {
    schemaVersion: "workloom.video-edit/edit-timeline/v2",
    timelineId: input.timelineId,
    filmId: input.filmId ?? null,
    revision: 1,
    prevRevision: null,
    sourceGapPolicy: "standard",
    pacing: { profile: input.pacing ?? "documentary", enforce: false },
    target: { ...input.target, durationSeconds: totalDuration },
    sources: input.sources.map((source) => ({
      sourceId: source.sourceId,
      sha256: source.sha256,
      path: source.path,
      fps: source.fps,
      durationSeconds: source.durationSeconds ?? source.analysis.asset?.durationSeconds ?? null,
      hasAudio: source.hasAudio ?? source.analysis.asset?.hasAudio ?? null,
    })),
    segments,
    audioDesign: { originalAudioPolicy: "duck_under_bgm", bgm: { needed: true, style: null, energyCurve: null, beatSync: true } },
    validation: {
      continuous: true,
      noSourceOverlap: true,
      totalDurationSeconds: totalDuration,
      sourceGapPolicy: "standard",
      generatedBy: "edit:auto",
    },
  };
  return { timeline, selected, skipped, targetSeconds, plannedSeconds: totalDuration, notes };
}

export interface AutoCaptionWord {
  text: string;
  start: number;
  end: number;
  /** ASR word boundaries are measured; sentence/oversized-token subdivisions are estimates. */
  timingPrecision?: "asr-word" | "sentence-estimated" | "word-estimated";
  /** Preserve the complete original ASR token when a long token needs multiple screens. */
  originalWord?: { text: string; start: number; end: number };
}

export interface AutoCaptionSentence {
  id: string;
  sourceId?: string;
  text: string;
  start: number;
  end: number;
  words: AutoCaptionWord[];
}

/**
 * 自动字幕与逐字稿：只使用 ASR 原文；一个镜头可有多屏，完整保留词序。
 * 每屏 ≤24 字、≤2 行且每行 ≤12 字。常规切屏只使用真实词边界；句级兜底与
 * 超长单词内部切屏明确标注估计。源轨按 speed 映射到 concat 时钟，转场留给后期映射一次。
 */
export function planAutoCaptions(input: {
  timeline: EditTimeline;
  sources: Array<{ sourceId: string; analysis: AutoPlanAnalysisDoc }>;
  maxCharsPerCue?: number;
}): { captionDoc: Record<string, unknown>; transcript: { sentences: AutoCaptionSentence[] }; gaps: string[]; cues: number } {
  const maxChars = input.maxCharsPerCue ?? 24;
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 24) throw new Error("maxCharsPerCue 必须是 1–24 的整数");
  const gaps: string[] = [];
  const sentences: AutoCaptionSentence[] = [];
  const wordsBySource = new Map<string, AutoCaptionWord[]>();
  const validRange = (start: number, end: number): boolean => Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start;
  const round = (value: number): number => Number(value.toFixed(6));
  const timestamp = (start: number, end: number): string => `${round(start)}-${round(end)}`;
  for (const source of input.sources) {
    if (wordsBySource.has(source.sourceId)) throw new Error(`字幕素材 sourceId 重复：${source.sourceId}`);
    const probe = source.analysis.probe;
    const words: AutoCaptionWord[] = [];
    for (const word of probe?.speech?.words ?? []) {
      const text = String(word.text ?? "");
      if (!text.trim()) continue;
      const start = word.start!;
      const end = word.end!;
      if (!validRange(start, end)) throw new Error(`${source.sourceId} ASR 词时间区间非法`);
      const chars = [...text];
      if (chars.length <= maxChars) words.push({ text, start, end, timingPrecision: "asr-word" });
      else {
        // A provider may return an entire sentence as one word. Keep its original evidence,
        // and disclose that only the internal display split is estimated, never word-level ASR.
        for (let offset = 0; offset < chars.length; offset += maxChars) {
          const stop = Math.min(offset + maxChars, chars.length);
          words.push({ text: chars.slice(offset, stop).join(""),
            start: start + (end - start) * offset / chars.length,
            end: start + (end - start) * stop / chars.length,
            timingPrecision: "word-estimated", originalWord: { text, start, end } });
        }
      }
    }
    if (words.length === 0) {
      for (const [index, sentence] of (probe?.speech?.sentences ?? []).entries()) {
        const text = String(sentence.text ?? "");
        if (!text.trim()) continue;
        const start = sentence.start!;
        const end = sentence.end!;
        if (!validRange(start, end)) throw new Error(`${source.sourceId} ASR 句时间区间非法`);
        const chars = [...text];
        const sentenceWords: AutoCaptionWord[] = chars.map((char, index) => ({
          text: char, start: start + (end - start) * index / chars.length,
          end: start + (end - start) * (index + 1) / chars.length,
          timingPrecision: "sentence-estimated",
        }));
        words.push(...sentenceWords);
        sentences.push({ id: `${source.sourceId}-s${String(index + 1).padStart(3, "0")}`, sourceId: source.sourceId, text, start, end, words: sentenceWords });
      }
    } else {
      words.sort((a, b) => a.start - b.start || a.end - b.end);
      let current: AutoCaptionWord[] = [];
      let sentenceIndex = 0;
      const flush = (): void => {
        if (current.length === 0) return;
        sentences.push({ id: `${source.sourceId}-s${String(++sentenceIndex).padStart(3, "0")}`, sourceId: source.sourceId,
          text: current.map(word => word.text).join(""), start: current[0]!.start, end: current.at(-1)!.end, words: [...current] });
        current = [];
      };
      for (const [index, word] of words.entries()) {
        current.push(word);
        const next = words[index + 1];
        if (!next || next.start - word.end >= 0.6) flush();
      }
    }
    words.sort((a, b) => a.start - b.start || a.end - b.end);
    if (words.some((word, index) => index > 0 && word.start < words[index - 1]!.end - 1e-6)) {
      throw new Error(`${source.sourceId} ASR 词时间重叠，无法生成顺序字幕`);
    }
    wordsBySource.set(source.sourceId, words);
  }

  let cursor = 0;
  let cues = 0;
  const shots: Array<Record<string, unknown>> = [];
  for (const segment of input.timeline.segments ?? []) {
    const speed = segment.speed ?? 1;
    const outputDuration = (segment.sourceOut - segment.sourceIn) / speed;
    if (!validRange(segment.sourceIn, segment.sourceOut) || !Number.isFinite(speed) || speed <= 0
      || !Number.isFinite(segment.durationSeconds) || segment.durationSeconds <= 0
      || Math.abs(outputDuration - segment.durationSeconds) > 0.05) throw new Error(`${segment.segmentId} 字幕片段时间或速度非法`);
    const masterStart = cursor;
    cursor = Number((cursor + outputDuration).toFixed(3));
    const words = (wordsBySource.get(segment.sourceId) ?? [])
      .filter(word => word.start >= segment.sourceIn - 0.02 && word.end <= segment.sourceOut + 0.02);
    const subtitle: Array<Record<string, unknown>> = [];
    let current: AutoCaptionWord[] = [];
    let chars = 0;
    const flush = (): void => {
      if (!current.length) return;
      const text = [...current.map(word => word.text).join("")];
      const per = Math.ceil(text.length / (text.length > 12 ? 2 : 1));
      const lines: string[] = [];
      for (let index = 0; index < text.length; index += per) lines.push(text.slice(index, index + per).join(""));
      const from = current[0]!.start;
      const to = current.at(-1)!.end;
      const start = masterStart + (Math.max(segment.sourceIn, from) - segment.sourceIn) / speed;
      const end = Math.min(cursor, masterStart + (Math.min(segment.sourceOut, to) - segment.sourceIn) / speed);
      if (Math.round(end * 1000) <= Math.round(start * 1000)) throw new Error(`${segment.segmentId} 字幕屏短于 SRT 毫秒精度`);
      subtitle.push({ text: lines.join("\n"), source_timestamp: timestamp(from, to), original_timestamp: timestamp(start, end),
        timingPrecision: current.some(word => word.timingPrecision === "sentence-estimated") ? "sentence-estimated"
          : current.some(word => word.timingPrecision === "word-estimated") ? "word-estimated" : "asr-word" });
      current = [];
      chars = 0;
    };
    for (const word of words) {
      const count = [...word.text].length;
      if (current.length && (chars + count > maxChars || word.start - current.at(-1)!.end >= 0.6)) flush();
      current.push(word);
      chars += count;
    }
    flush();
    cues += subtitle.length;
    if (!subtitle.length) gaps.push(`${segment.segmentId}（${segment.sourceIn.toFixed(1)}–${segment.sourceOut.toFixed(1)}s）没有可用语音转写：自动模式留空，建议人工补字幕或剪掉`);
    shots.push({ segmentId: segment.segmentId,
      source_timestamp: timestamp(segment.sourceIn, segment.sourceOut), original_timestamp: timestamp(masterStart, cursor),
      subtitle_text: subtitle, ...(!subtitle.length ? { note: "无语音转写：自动模式留空（不编字）" } : {}) });
  }
  const mmss = (seconds: number): string => {
    const rounded = Math.round(seconds);
    return `${String(Math.floor(rounded / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
  };
  const captionDoc = {
    video_title: "自动粗剪", video_id: `${new Date().toISOString().slice(0, 10).replace(/-/gu, "")}-auto0000`,
    total_duration: mmss(cursor), video_groups: [{ group_name: "自动粗剪", group_duration: mmss(cursor), shots }],
  };
  return { captionDoc, transcript: { sentences }, gaps, cues };
}
