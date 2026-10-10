/**
 * edit/caption.ts —— 剪辑脚本字幕版（音画强关联）规则引擎（纯函数，可单测）。
 *
 * 为什么单独一层：字幕在剪辑链路里是"剪辑的一部分"，不是后期补的一层字。
 * 出现规则（≥2s 必上 / <2s 不上 / VMG 合并）、字数带、断句格式、信息密度与语速口径
 * 必须可复算、可复现，否则每一稿的"合格"标准都不一样。
 *
 * 口径来源（不改契约字段，只把判定收口）：
 *   · docs/video-edit-creation-doctrine.md §5（字幕即剪辑）
 *   · skills/caption-craft（出现规则 / 字数带 / 文字纪律 / 结尾话术位）
 *   · docs/video-edit-prompt-suite.md P6
 *
 * 本模块只做**事实类判定**：VMG 归属、字数带、标点/Emoji/行数、时间轴完整性、
 * 口语与字幕的信息密度对比。审美判断（这句话写得好不好）不在这里。
 */

import type { EditTimeline } from "./timeline.js";

export interface CaptionShotInput {
  segmentId?: string;
  original_timestamp?: string;
  /** 源素材时间码（口播字幕版会写）：口播口径的逐字一致校验用它，而不是成片时间码 */
  source_timestamp?: string;
  subtitle_text?: Array<{ text?: string }>;
  role?: string;
}

/**
 * 口播字幕口径（2026-10-11 随 AI 口播精剪管线新增）。
 *
 * 口播的字幕是「跟着人说话走」的：段多短都要出字，不套通用剪辑的 ≥2s 门槛与字数带；
 * 取而代之的是三条**口播专属**事实纪律：一屏 ≤2 行、每行 ≤12 字、总字数 ≤24，
 * 且字幕必须逐字等于 ASR 逐字稿原文（需要 `transcript` 才能校验；缺失时只出咨询提示）。
 */
export interface CaptionTalkOptions {
  mode?: "standard" | "talk";
  transcript?: {
    sentences?: Array<{ id?: string; words?: Array<{ text?: string; start?: number; end?: number }> }>;
  } | null;
}

export interface CaptionDocInput {
  video_title?: string;
  video_id?: string;
  total_duration?: string;
  video_groups?: Array<{ group_name?: string; group_duration?: string; shots?: CaptionShotInput[] }>;
}

export interface CaptionIssue {
  id: string;
  severity: "hard" | "advisory";
  detail: string;
  segmentId?: string;
}

export interface CaptionCue {
  segmentId: string;
  start: number;
  end: number;
  text: string;
  role: string;
  /** VMG（虚拟拼接组）归属：只有合并总时长 >3.9s 的首镜允许承载概括字幕 */
  vmg: { head: boolean; size: number; totalSeconds: number } | null;
}

interface VmgInfo {
  head: boolean;
  headSegmentId: string;
  size: number;
  totalSeconds: number;
}

export interface CaptionDensityRow {
  segmentId: string;
  durationSeconds: number;
  captionChars: number | null;
  /** 该段源轨里实测口语字数（无解析结果或无人声时为 null） */
  speechChars: number | null;
  speechRateCps: number | null;
  /** 字幕字数 / 口语字数（信息密度比；>1.6 说明字幕远超口语内容） */
  densityRatio: number | null;
  /** 在信息密度不低于 40% 口语内容时的建议最小字数（仅建议，不改变硬字数带） */
  recommendedMinChars: number | null;
}

export interface CaptionAnalysis {
  ok: boolean;
  cues: CaptionCue[];
  issues: CaptionIssue[];
  metrics: {
    totalSeconds: number;
    cueCount: number;
    vmgGroups: Array<{ headSegmentId: string; segmentIds: string[]; totalSeconds: number; captionChars: number | null }>;
    density: CaptionDensityRow[];
    maxCueSeconds: number;
    minGapSeconds: number | null;
  };
}

/** 单镜出现阈值：≥2.0s 必上，<2.0s 不上（连续短镜走 VMG） */
export const CAPTION_MIN_SHOT_SECONDS = 2.0;
/** VMG 合并超过该时长时，只在首镜写一条概括字幕 */
export const VMG_SUMMARY_MIN_SECONDS = 3.9;
/** 字数带系数：ceil(时长×2.0) – floor(时长×2.5) */
export const CAPTION_CHAR_RATE = { min: 2.0, max: 2.5 } as const;
/** 信息密度告警线：字幕字数低于同段口语字数的该比例时提示"信息量不够" */
export const CAPTION_DENSITY_MIN_RATIO = 0.4;
/** 信息密度告警线：字幕字数高于同段口语字数的该比例时提示"可能超出画面事实" */
export const CAPTION_DENSITY_MAX_RATIO = 1.6;
/** 读感保护：单条字幕建议不超过该时长（超过只是咨询项，需要人决定是否拆句） */
export const CAPTION_MAX_CUE_SECONDS = 10;
/** 两条字幕之间建议至少留出的间隔（防止闪断） */
export const CAPTION_MIN_CUE_GAP_SECONDS = 0.2;
/** 口播字幕上限：一屏两行 × 每行 12 字 */
export const TALK_CAPTION_MAX_LINE_CHARS = 12;
export const TALK_CAPTION_MAX_CHARS = 24;
export const TALK_CAPTION_MAX_LINES = 2;

const INLINE_FORBIDDEN = /[，。！？、,.!?;；:："'“”‘’()（）[\]【】…—\-·~@#$%^&*+=|\\/<>{}]/u;
const LATIN = /[A-Za-z]{2,}/u;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{FE0F}]/u;

export function captionCharBand(durationSeconds: number): { min: number; max: number } {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error(`字幕时长必须为正数，收到：${String(durationSeconds)}`);
  return {
    min: Math.ceil(durationSeconds * CAPTION_CHAR_RATE.min),
    max: Math.floor(durationSeconds * CAPTION_CHAR_RATE.max),
  };
}

export function countVisualChars(text: string): number {
  return [...String(text ?? "").replace(/\n/gu, "")].length;
}

/** 逐字比对用的归一化：去空白与标点，只保留汉字/字母/数字（口播字幕的"逐字一致"口径） */
export function normalizeCaptionText(text: string): string {
  return String(text ?? "").replace(/[\s，。！？、,.!?;；:："'“”‘’()（）\[\]【】…—\-·~@#$%^&*+=|\\/<>{}]/gu, "");
}

function parseDurationText(value: string | undefined): number {
  if (!value) return Number.NaN;
  const parts = value.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return Number.NaN;
  return parts.reduce((sum, part) => sum * 60 + part, 0);
}

interface AnalysisDoc {
  asset?: { sha256?: string; localPath?: string };
  probe?: { speech?: { sentences?: Array<{ text?: string; start?: number; end?: number }> } };
}

/** 源轨区间与解析结果里的句级转写求交，得到该段实测口语字数/时长/语速 */
function speechStatsForRange(
  doc: AnalysisDoc | null,
  sourceIn: number,
  sourceOut: number,
): { chars: number; seconds: number; rateCps: number | null } | null {
  const sentences = doc?.probe?.speech?.sentences;
  if (!Array.isArray(sentences) || sentences.length === 0) return null;
  let chars = 0;
  let seconds = 0;
  for (const sentence of sentences) {
    const start = Number(sentence.start);
    const end = Number(sentence.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const overlap = Math.min(end, sourceOut) - Math.max(start, sourceIn);
    if (overlap <= 0) continue;
    const text = String(sentence.text ?? "").replace(/\s/gu, "");
    const share = overlap / (end - start);
    chars += [...text].length * share;
    seconds += overlap;
  }
  if (seconds <= 0) return null;
  return { chars: Math.round(chars), seconds: Number(seconds.toFixed(3)), rateCps: Number((chars / seconds).toFixed(2)) };
}

/**
 * 主入口：按时间轴 + 字幕脚本 + （可选）素材解析结果做全量规则判定。
 * `analyses` 用于信息密度/语速对比：按 `asset.sha256` 或 `asset.localPath` 与时间轴 source 对齐。
 */
export function analyzeCaption(input: {
  timeline: EditTimeline;
  caption: CaptionDocInput;
  analyses?: AnalysisDoc[];
  /** 口播口径开关（缺省为通用剪辑口径，行为与既有完全一致） */
  mode?: "standard" | "talk";
  /** 口播模式下用于逐字一致校验的 ASR 逐字稿 */
  transcript?: CaptionTalkOptions["transcript"];
}): CaptionAnalysis {
  const { timeline, caption } = input;
  const analyses = input.analyses ?? [];
  const talkMode = input.mode === "talk";
  const talkTranscript = talkMode ? input.transcript ?? null : null;
  const issues: CaptionIssue[] = [];
  const cues: CaptionCue[] = [];
  const density: CaptionDensityRow[] = [];

  const masterStart = new Map<string, number>();
  const segmentById = new Map<string, EditTimeline["segments"][number]>();
  let cursor = 0;
  for (const segment of timeline.segments ?? []) {
    masterStart.set(segment.segmentId, Number(cursor.toFixed(3)));
    segmentById.set(segment.segmentId, segment);
    cursor = Number((cursor + segment.durationSeconds).toFixed(3));
  }
  const totalSeconds = Number(cursor.toFixed(3));

  const analysisFor = (segment: EditTimeline["segments"][number]): AnalysisDoc | null => {
    const source = (timeline.sources ?? []).find((entry) => entry.sourceId === segment.sourceId);
    if (!source) return null;
    return analyses.find((doc) => doc?.asset?.sha256 === source.sha256 || (doc?.asset?.localPath && doc.asset.localPath === source.path)) ?? null;
  };

  // —— VMG 分组：连续 <2s 的片段（按主轨顺序）—— 
  const vmgRuns: Array<{ segmentIds: string[]; totalSeconds: number }> = [];
  let run: { segmentIds: string[]; totalSeconds: number } | null = null;
  for (const segment of timeline.segments ?? []) {
    if (segment.durationSeconds < CAPTION_MIN_SHOT_SECONDS) {
      if (!run) run = { segmentIds: [], totalSeconds: 0 };
      run.segmentIds.push(segment.segmentId);
      run.totalSeconds = Number((run.totalSeconds + segment.durationSeconds).toFixed(3));
    } else if (run) {
      vmgRuns.push(run);
      run = null;
    }
  }
  if (run) vmgRuns.push(run);
  const vmgOf = new Map<string, VmgInfo>();
  for (const vmg of vmgRuns) {
    vmg.segmentIds.forEach((segmentId, index) => {
      vmgOf.set(segmentId, { head: index === 0, headSegmentId: vmg.segmentIds[0]!, size: vmg.segmentIds.length, totalSeconds: vmg.totalSeconds });
    });
  }

  // —— 字幕条目：定位、归属、字数带 —— 
  const seen = new Set<string>();
  const textOf = new Map<string, { text: string; role: string }>();
  /** 口播口径的逐字比对原料：源轨区间 → 逐字稿原文 */
  const sourceRangeOf = new Map<string, { from: number; to: number }>();
  for (const group of caption.video_groups ?? []) {
    let groupSum = 0;
    for (const shot of group.shots ?? []) {
      const segmentId = shot.segmentId;
      if (!segmentId) {
        issues.push({ id: "caption.segmentId", severity: "hard", detail: `镜头 ${shot.original_timestamp ?? "(缺时间码)"} 缺 segmentId（流水线匹配字段）` });
        continue;
      }
      const segment = segmentById.get(segmentId);
      if (!segment) {
        issues.push({ id: `caption.segment:${segmentId}`, severity: "hard", detail: `${segmentId} 不在时间轴里`, segmentId });
        continue;
      }
      if (seen.has(segmentId)) issues.push({ id: `caption.duplicate:${segmentId}`, severity: "hard", detail: `${segmentId} 在字幕脚本里出现两次`, segmentId });
      seen.add(segmentId);
      groupSum += segment.durationSeconds;
      const text = String(shot.subtitle_text?.[0]?.text ?? "");
      const role = shot.role ?? "normal";
      textOf.set(segmentId, { text, role });
      const sourceTimestamp = shot.source_timestamp;
      if (talkMode && sourceTimestamp) {
        const [from, to] = sourceTimestamp.split("-").map((value) => Number(value));
        if (Number.isFinite(from) && Number.isFinite(to)) sourceRangeOf.set(segmentId, { from: from!, to: to! });
      }
    }
    const declared = parseDurationText(group.group_duration);
    if (Number.isFinite(declared) && Math.abs(declared - groupSum) > 1.0) {
      issues.push({ id: `caption.group:${group.group_name ?? "?"}`, severity: "hard", detail: `组「${group.group_name ?? "?"}」时长 ${String(group.group_duration)} 与镜头时长之和 ${groupSum.toFixed(2)}s 不符` });
    }
  }

  for (const segment of timeline.segments ?? []) {
    const entry = textOf.get(segment.segmentId);
    /** 口播口径下不走 VMG：口播的每一段就是一条字幕（跟着说话出字）。 */
    const vmg = talkMode ? null : vmgOf.get(segment.segmentId) ?? null;
    const text = entry?.text ?? "";
    const role = entry?.role ?? "normal";
    const duration = segment.durationSeconds;

    if (!text) {
      if (talkMode) {
        issues.push({
          id: `caption.missing:${segment.segmentId}`,
          severity: "hard",
          detail: `${segment.segmentId} 口播段缺字幕：口播字幕必须跟着说话出字（段多短都不例外）`,
          segmentId: segment.segmentId,
        });
      } else if (duration >= CAPTION_MIN_SHOT_SECONDS) {
        issues.push({ id: `caption.missing:${segment.segmentId}`, severity: "hard", detail: `${segment.segmentId} 时长 ${duration}s ≥2s 必须有字幕`, segmentId: segment.segmentId });
      } else if (vmg && vmg.head && vmg.totalSeconds > VMG_SUMMARY_MIN_SECONDS) {
        issues.push({
          id: `caption.vmgMissing:${segment.segmentId}`,
          severity: "advisory",
          detail: `连续 ${vmg.size} 个短镜合并 ${vmg.totalSeconds}s（>${VMG_SUMMARY_MIN_SECONDS}s）：建议在首镜写一条概括字幕`,
          segmentId: segment.segmentId,
        });
      }
    } else if (!vmg) {
      if (duration < CAPTION_MIN_SHOT_SECONDS) {
        issues.push({ id: `caption.tooShort:${segment.segmentId}`, severity: "hard", detail: `${segment.segmentId} 时长 ${duration}s <2s 不应有字幕（连续短镜请走 VMG 合并）`, segmentId: segment.segmentId });
      }
    } else if (!vmg.head) {
      issues.push({
        id: `caption.vmgPlacement:${segment.segmentId}`,
        severity: "hard",
        detail: `${segment.segmentId} 属于 ${vmg.size} 个连续短镜的 VMG：字幕只能写在首镜（${vmg.headSegmentId}）`,
        segmentId: segment.segmentId,
      });
    } else if (vmg.totalSeconds <= VMG_SUMMARY_MIN_SECONDS) {
      issues.push({
        id: `caption.vmgTooShort:${segment.segmentId}`,
        severity: "hard",
        detail: `VMG 合并总时长 ${vmg.totalSeconds}s ≤${VMG_SUMMARY_MIN_SECONDS}s：太短读不完，不应上字幕`,
        segmentId: segment.segmentId,
      });
    }

    // 字数带按"可读总时长"计算：普通镜=单镜时长；VMG 首镜=合并总时长
    const bandSeconds = vmg && vmg.head ? vmg.totalSeconds : duration;
    const chars = countVisualChars(text);
    if (text) {
      const band = captionCharBand(bandSeconds);
      if (talkMode) {
        /**
         * 口播口径：不套字数带与 ≥2s 门槛，改守三条可读性上限 + 逐字一致。
         * 理由：口播字幕是"他说的话"，人为压到字数带里等于改写原话（G-TK1）。
         */
        if (role !== "ending-cta") {
          const lines = text.split("\n");
          if (chars > TALK_CAPTION_MAX_CHARS) {
            issues.push({
              id: `caption.talkLength:${segment.segmentId}`,
              severity: "hard",
              detail: `${segment.segmentId} 口播字幕 ${chars} 字超过一屏上限 ${TALK_CAPTION_MAX_CHARS} 字（拆段或拆句）`,
              segmentId: segment.segmentId,
            });
          }
          if (lines.length > TALK_CAPTION_MAX_LINES) {
            issues.push({
              id: `caption.talkLines:${segment.segmentId}`,
              severity: "hard",
              detail: `${segment.segmentId} 口播字幕 ${lines.length} 行超过一屏 ${TALK_CAPTION_MAX_LINES} 行`,
              segmentId: segment.segmentId,
            });
          }
          for (const line of lines) {
            if ([...line].length > TALK_CAPTION_MAX_LINE_CHARS) {
              issues.push({
                id: `caption.talkLineChars:${segment.segmentId}`,
                severity: "hard",
                detail: `${segment.segmentId} 行宽 ${[...line].length} 字超过 ${TALK_CAPTION_MAX_LINE_CHARS} 字（竖屏一屏读不完）`,
                segmentId: segment.segmentId,
              });
            }
          }
        }
        /** 逐字一致：字幕必须等于逐字稿在该源区间内的原文（去标点逐字比对）。 */
        const range = sourceRangeOf.get(segment.segmentId);
        if (!talkTranscript) {
          issues.push({
            id: `caption.verbatimUnchecked:${segment.segmentId}`,
            severity: "advisory",
            detail: `${segment.segmentId} 未提供逐字稿（--transcript）：逐字一致未校验`,
            segmentId: segment.segmentId,
          });
        } else if (!range) {
          issues.push({
            id: `caption.verbatimSource:${segment.segmentId}`,
            severity: "advisory",
            detail: `${segment.segmentId} 缺源素材时间码（source_timestamp）：无法做逐字一致校验`,
            segmentId: segment.segmentId,
          });
        } else {
          const expected = (talkTranscript.sentences ?? [])
            .flatMap((sentence) => sentence.words ?? [])
            .filter((word) => Number(word.start) >= range.from - 0.02 && Number(word.end) <= range.to + 0.02)
            .map((word) => String(word.text ?? ""))
            .join("");
          const normalizedExpected = normalizeCaptionText(expected);
          const normalizedActual = normalizeCaptionText(text);
          if (normalizedExpected !== normalizedActual) {
            issues.push({
              id: `caption.verbatim:${segment.segmentId}`,
              severity: "hard",
              detail: `${segment.segmentId} 字幕与逐字稿不一致：稿=「${expected}」字幕=「${text.replace(/\n/gu, "")}」`,
              segmentId: segment.segmentId,
            });
          }
        }
      } else if (role === "ending-cta") {
        const start = masterStart.get(segment.segmentId)!;
        if (start < totalSeconds - 10.5) {
          issues.push({ id: `caption.ctaWindow:${segment.segmentId}`, severity: "advisory", detail: `结尾话术应在最后 10s 内（当前起于 ${start.toFixed(1)}s / 全片 ${totalSeconds}s）`, segmentId: segment.segmentId });
        }
      } else if (chars < band.min || chars > band.max) {
        issues.push({
          id: `caption.band:${segment.segmentId}`,
          severity: "hard",
          detail: `${segment.segmentId} 字数 ${chars} 不在 ${band.min}–${band.max}（${vmg && vmg.head ? `VMG 合并 ${bandSeconds}s` : `时长 ${duration}s`}）`,
          segmentId: segment.segmentId,
        });
      }
      const lines = text.split("\n");
      if (lines.length > 4) {
        issues.push({ id: `caption.lines:${segment.segmentId}`, severity: "hard", detail: `${segment.segmentId} 字幕 ${lines.length} 行 >4 行（超出可读行数）`, segmentId: segment.segmentId });
      }
      for (const line of lines) {
        if (INLINE_FORBIDDEN.test(line)) {
          issues.push({ id: `caption.punct:${segment.segmentId}`, severity: "hard", detail: `${segment.segmentId} 行内含标点/空格：${line}`, segmentId: segment.segmentId });
          break;
        }
        if (EMOJI.test(line)) {
          issues.push({ id: `caption.emoji:${segment.segmentId}`, severity: "hard", detail: `${segment.segmentId} 行内含 Emoji：${line}`, segmentId: segment.segmentId });
          break;
        }
        if (LATIN.test(line) && !/^[A-Za-z]{1,3}$/u.test(line)) {
          issues.push({ id: `caption.latin:${segment.segmentId}`, severity: "advisory", detail: `${segment.segmentId} 含外文（专有名词可保留）：${line}`, segmentId: segment.segmentId });
        }
      }
      const overlyLongLine = lines.find((line) => [...line].length > 14);
      if (overlyLongLine) {
        issues.push({
          id: `caption.lineLength:${segment.segmentId}`,
          severity: "advisory",
          detail: `${segment.segmentId} 单行 ${[...overlyLongLine].length} 字 >14（竖屏可读性上限约 6–11 字，建议断行）`,
          segmentId: segment.segmentId,
        });
      }
      const start = masterStart.get(segment.segmentId)!;
      cues.push({
        segmentId: segment.segmentId,
        start,
        end: Number((start + duration).toFixed(3)),
        text,
        role,
        vmg: vmg && vmg.head ? { head: true, size: vmg.size, totalSeconds: vmg.totalSeconds } : null,
      });
    }

    // —— 信息密度 / 语速（有解析结果时才算，没证据不猜）——
    const doc = analysisFor(segment);
    const speech = doc ? speechStatsForRange(doc, segment.sourceIn, segment.sourceOut) : null;
    const row: CaptionDensityRow = {
      segmentId: segment.segmentId,
      durationSeconds: duration,
      captionChars: text ? chars : null,
      speechChars: speech?.chars ?? null,
      speechRateCps: speech?.rateCps ?? null,
      densityRatio: null,
      recommendedMinChars: null,
    };
    if (speech && text) {
      const ratio = Number((chars / Math.max(1, speech.chars)).toFixed(2));
      row.densityRatio = ratio;
      const band = captionCharBand(bandSeconds);
      row.recommendedMinChars = Math.min(band.max, Math.max(band.min, Math.floor(speech.chars * CAPTION_DENSITY_MIN_RATIO)));
      if (speech.chars >= 8 && ratio < CAPTION_DENSITY_MIN_RATIO) {
        issues.push({
          id: `caption.densityLow:${segment.segmentId}`,
          severity: "advisory",
          detail: `${segment.segmentId} 信息密度偏低：同段口语 ${speech.chars} 字 / 字幕 ${chars} 字（${Math.round(ratio * 100)}%）；建议至少覆盖 ${row.recommendedMinChars} 字的关键信息`,
          segmentId: segment.segmentId,
        });
      }
      if (ratio > CAPTION_DENSITY_MAX_RATIO && chars > band.max) {
        issues.push({
          id: `caption.densityHigh:${segment.segmentId}`,
          severity: "advisory",
          detail: `${segment.segmentId} 字幕远超口语内容：口语 ${speech.chars} 字 / 字幕 ${chars} 字；确认没有引入画面/语音之外的事实`,
          segmentId: segment.segmentId,
        });
      }
    }
    density.push(row);
  }

  // —— 时间轴完整性：重叠 / 间隔 / 单条过长 —— 
  const ordered = [...cues].sort((a, b) => a.start - b.start);
  let minGap: number | null = null;
  for (let i = 0; i < ordered.length; i += 1) {
    const cue = ordered[i]!;
    if (cue.end - cue.start > CAPTION_MAX_CUE_SECONDS) {
      issues.push({ id: `caption.cueLong:${cue.segmentId}`, severity: "advisory", detail: `${cue.segmentId} 单条字幕 ${(cue.end - cue.start).toFixed(1)}s >${CAPTION_MAX_CUE_SECONDS}s（建议拆句或调整镜头）`, segmentId: cue.segmentId });
    }
    if (i === 0) continue;
    const previous = ordered[i - 1]!;
    const gap = Number((cue.start - previous.end).toFixed(3));
    minGap = minGap === null ? gap : Math.min(minGap, gap);
    if (gap < 0) {
      issues.push({ id: `caption.overlap:${cue.segmentId}`, severity: "hard", detail: `${previous.segmentId} 与 ${cue.segmentId} 的字幕时间重叠 ${Math.abs(gap)}s`, segmentId: cue.segmentId });
    } else if (gap < CAPTION_MIN_CUE_GAP_SECONDS) {
      issues.push({ id: `caption.gap:${cue.segmentId}`, severity: "advisory", detail: `${previous.segmentId} → ${cue.segmentId} 间隔仅 ${gap}s（建议 ≥${CAPTION_MIN_CUE_GAP_SECONDS}s，避免闪断）`, segmentId: cue.segmentId });
    }
  }

  // —— 标题 / video_id / 总时长 —— 
  const title = String(caption.video_title ?? "");
  if ([...title].length > 12) issues.push({ id: "caption.title", severity: "hard", detail: `标题超过 12 字：${title}` });
  if (INLINE_FORBIDDEN.test(title)) issues.push({ id: "caption.titlePunct", severity: "hard", detail: `标题含标点/空格：${title}` });
  if (caption.video_id && !/^\d{8}-[0-9a-f]{8}$/u.test(caption.video_id)) {
    issues.push({ id: "caption.videoId", severity: "advisory", detail: `video_id 建议形如 YYYYMMDD-8位哈希：${caption.video_id}` });
  }
  const declaredTotal = parseDurationText(caption.total_duration);
  if (Number.isFinite(declaredTotal)) {
    if (declaredTotal + 1 < totalSeconds) {
      issues.push({ id: "caption.total", severity: "hard", detail: `total_duration ${String(caption.total_duration)} 小于成片时长 ${totalSeconds.toFixed(1)}s` });
    } else if (declaredTotal > totalSeconds + 5) {
      issues.push({ id: "caption.totalDrift", severity: "advisory", detail: `total_duration ${String(caption.total_duration)} 比成片时长 ${totalSeconds.toFixed(1)}s 多 ${(declaredTotal - totalSeconds).toFixed(1)}s，建议与实际对齐` });
    }
  } else if (caption.total_duration === undefined) {
    issues.push({ id: "caption.totalMissing", severity: "advisory", detail: "缺 total_duration（建议写 MM:SS，便于交付核对）" });
  }

  const vmgGroups = vmgRuns.map((vmg) => ({
    headSegmentId: vmg.segmentIds[0]!,
    segmentIds: vmg.segmentIds,
    totalSeconds: vmg.totalSeconds,
    captionChars: textOf.get(vmg.segmentIds[0]! )?.text ? countVisualChars(textOf.get(vmg.segmentIds[0]!)!.text) : null,
  }));

  return {
    ok: issues.every((issue) => issue.severity !== "hard"),
    cues: ordered,
    issues,
    metrics: {
      totalSeconds,
      cueCount: ordered.length,
      vmgGroups,
      density,
      maxCueSeconds: ordered.reduce((max, cue) => Math.max(max, Number((cue.end - cue.start).toFixed(3))), 0),
      minGapSeconds: minGap,
    },
  };
}

/** 秒 → SRT 时间码（`HH:MM:SS,mmm`）；毫秒四舍五入到整秒时进位，不产出 `,1000` 非法值 */
export function srtTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`SRT 时间码必须是非负有限数字，收到：${String(seconds)}`);
  let totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  totalMs = (totalMs - ms) / 1000;
  const s = totalMs % 60;
  const totalMinutes = (totalMs - s) / 60;
  const m = totalMinutes % 60;
  const h = (totalMinutes - m) / 60;
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** 字幕条目 → SRT 文本（按开始时间排序；空文本条目剔除） */
export function cuesToSrtBody(cues: CaptionCue[]): string {
  return [...cues]
    .filter((cue) => cue.text.trim().length > 0)
    .sort((a, b) => a.start - b.start)
    .map((cue, index) => `${index + 1}\n${srtTimestamp(cue.start)} --> ${srtTimestamp(cue.end)}\n${cue.text}\n`)
    .join("\n");
}
