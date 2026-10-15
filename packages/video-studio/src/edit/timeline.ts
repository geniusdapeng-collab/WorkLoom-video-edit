/**
 * edit/timeline.ts —— 剪辑时间轴校验与本地合成计划（v2 契约执行层）
 *
 * 这一层的职责边界：
 *   · 只做**事实类**判定（连续性/重叠/时长/枚举/溯源），不做审美判断（T-2026-0930-0015）；
 *   · 校验与合成计划都是纯函数——给定同一份时间轴，必须得到同一份结论与同一串命令；
 *   · 失败给"改哪一段、哪个字段、改成什么"，而不是"节奏不对，重来"。
 *
 * 契约口径见 bundles/video-edit/schemas/edit-timeline.schema.json：
 *   · 源轨（sourceIn/sourceOut）与主轨（masterIn/masterOut）分离；
 *   · 同一源素材的多段选择不得重叠、间隔 ≥1s（理想 ≥2s）；
 *   · 主轨必须连续无空隙（前段结束 = 后段开始）。
 */

import { toTimecode } from "./timecode.js";
import { planTransitions } from "./transitions.js";
import {
  buildReframeFilters, normalizeReframeSegment, planReframe, validateReframeSegment,
  type ReframeDescriptor, type ReframePlan, type ReframePlanOptions, type ReframeSpec,
} from "./reframe.js";

export const TRANSITION_TYPES = [
  "cut", "dissolve", "fade_from_black", "fade_to_black", "wipe", "match_cut", "jump_cut", "whip_pan", "zoom_blur",
] as const;
export type TransitionType = (typeof TRANSITION_TYPES)[number];

export const AUDIO_MODES = ["original", "mute", "ambience_only", "bgm_only", "duck_original", "j_cut", "l_cut"] as const;
export type AudioMode = (typeof AUDIO_MODES)[number];

export const ORIGINAL_AUDIO_POLICIES = ["keep", "duck_under_bgm", "replace", "mute"] as const;

/**
 * 同源片段间隔策略（2026-10-11 新增，口播精剪所需）：
 *   · `standard`（默认）：同一源素材的多段选择必须间隔 ≥1s——防止"同一条素材反复用"造成跳帧感；
 *   · `single-take-talking-head`：口播精剪场景。一条长镜头内按句删停顿/语气词，间隔天然 <1s，
 *     这是**体裁本身的要求**，不是复用错误；此策略下间隔检查不再作为硬闸，取而代之的是
 *     更严的"源轨顺序必须单调递增（不允许回跳）"与"跳切必须有遮盖计划"两条。
 */
export const SOURCE_GAP_POLICIES = ["standard", "single-take-talking-head"] as const;
export type SourceGapPolicy = (typeof SOURCE_GAP_POLICIES)[number];

export interface EditTimelineSource {
  sourceId: string;
  sha256: string;
  path: string;
  fps: number;
  durationSeconds?: number | null;
  hasAudio?: boolean | null;
}

export interface EditTimelineTransition {
  type: TransitionType;
  durationSeconds?: number | null;
  params?: Record<string, unknown> | null;
}

export interface EditTimelineSegment {
  seq: number;
  segmentId: string;
  groupId?: string | null;
  sourceId: string;
  sourceIn: number;
  sourceOut: number;
  durationSeconds: number;
  speed?: number | null;
  motive?: string | null;
  highlightRef?: string | null;
  keyframeRef?: string | null;
  transitionIn?: EditTimelineTransition | null;
  audio?: { mode?: AudioMode | null; gainDb?: number | null; jCutOffsetSeconds?: number | null; note?: string | null } | null;
  subtitle?: { lines?: string[]; placement?: string | null; emphasis?: string | null } | null;
  /**
   * 跳切遮盖用的推近（punch-in）：scale 1.0–1.5（1.12 = 放大 12%），x/y 为裁切中心比例（0–1，缺省居中）。
   * 口播精剪里"删掉停顿后的同机位跳切"必须靠推近或切镜遮盖，否则观众会看到"跳帧"。
   */
  punchIn?: { scale?: number | null; x?: number | null; y?: number | null; note?: string | null } | null;
  /**
   * 二次构图（取景轨道，T-2026-1011-0008）：把"中景切近景 / 局部放大 / 横转竖不留黑边"
   * 变成可执行契约。`punchIn` 是它的 legacy 子集（静态推近），两者同时存在时以本字段为准。
   * 渲染口径：源原生裁切（crop-first）→ 填充（pad/cover/blur/brand）→ 画布；详见 docs/video-edit-reframe.md。
   */
  reframe?: ReframeSpec | null;
  masterIn?: number | null;
  masterOut?: number | null;
}

export interface EditTimeline {
  schemaVersion: string;
  timelineId: string;
  filmId?: string | null;
  revision?: number;
  prevRevision?: number | null;
  /** 同源片段间隔策略（缺省 standard；口播精剪用 single-take-talking-head） */
  sourceGapPolicy?: SourceGapPolicy | null;
  /** 节奏档案（可选）：缺省按 documentary 咨询项给出；不写也能出片 */
  pacing?: PacingSpec | null;
  target: {
    durationSeconds: number;
    /** Explicit requested range, measured after declared transition overlaps. */
    durationBand?: { minSeconds: number; maxSeconds: number };
    aspectRatio: string;
    fps: number;
    platform: string;
    loudnessTargetLufs?: number | null;
  };
  sources: EditTimelineSource[];
  groups?: Array<{ groupId: string; name: string; storyline?: string | null; emotion?: string | null; intensity?: number | null }>;
  segments: EditTimelineSegment[];
  audioDesign: { originalAudioPolicy: (typeof ORIGINAL_AUDIO_POLICIES)[number]; bgm?: Record<string, unknown> | null; soundEffects?: Array<{ at: number; kind: string; note?: string | null }>; silenceNotes?: string | null };
  validation?: Record<string, unknown>;
}

export interface TimelineCheck {
  id: string;
  pass: boolean;
  hard: boolean;
  detail: string;
}

export interface TimelineFix {
  segmentId: string;
  field: string;
  action: string;
  severity: "hard" | "advisory";
}

export interface TimelineValidation {
  ok: boolean;
  checks: TimelineCheck[];
  fixes: TimelineFix[];
  totalDurationSeconds: number;
}

const MAX_SEGMENT_SECONDS = 20;
const MIN_SEGMENT_SECONDS = 0.4;
const MIN_SAME_SOURCE_GAP_SECONDS = 1;
const IDEAL_SAME_SOURCE_GAP_SECONDS = 2;
const MAX_TRANSITION_SECONDS = 2;

/**
 * 节奏档案（pacing profile）——把封板资产里的"≤4 场景 / 每场景 ≤5 片段"重新评估为**按体裁的默认值**：
 *   · 那组数字来自口播型营销短片的实践，不等于所有体裁的上限；快剪/信息流片的镜头密度天然更大；
 *   · 档案只产出**咨询项**（可见、可解释、可覆盖），不阻断出片；真正的硬闸只有事实类
 *     （素材溯源、同源不重叠、主轨连续、单镜 0.4–15s、字幕 ≥2s 等）。
 *   · 需要严格卡住时，在时间轴里写 `pacing.enforce = true`，对应项升级为硬项。
 */
export const PACING_PROFILES = {
  /** 纪录/纪实（封板默认档）：慢燃，镜头长、场景少 —— 本片使用此档 */
  documentary: { maxScenes: 4, maxClipsPerScene: 5, clipSeconds: [2.0, 6.0] as [number, number], cutsPerMinute: [12, 20] as [number, number], scene1MinSeconds: 15, hookSeconds: 5 },
  /** 生活 Vlog：中速，场景略多、镜头略短 */
  vlog: { maxScenes: 5, maxClipsPerScene: 6, clipSeconds: [1.5, 5.0] as [number, number], cutsPerMinute: [18, 30] as [number, number], scene1MinSeconds: 6, hookSeconds: 3 },
  /** 快剪/卡点：高密度，镜头短、切点密（营销混剪、运动、节庆） */
  fast_cut: { maxScenes: 8, maxClipsPerScene: 10, clipSeconds: [0.5, 3.0] as [number, number], cutsPerMinute: [30, 70] as [number, number], scene1MinSeconds: 3, hookSeconds: 3 },
  /** 信息流/产品：前 3 秒给结论，之后按信息点推进 */
  information: { maxScenes: 6, maxClipsPerScene: 8, clipSeconds: [1.0, 4.0] as [number, number], cutsPerMinute: [20, 40] as [number, number], scene1MinSeconds: 3, hookSeconds: 3 },
  /**
   * 口播精剪（talking-head）：一条长镜头内按句子切分，段长天然比 Vlog 长（说话要成句），
   * 切点密度也低于快剪——口播的节奏靠"内容与情绪推进"，不靠切点堆量。
   */
  talk: { maxScenes: 10, maxClipsPerScene: 12, clipSeconds: [1.0, 12.0] as [number, number], cutsPerMinute: [8, 30] as [number, number], scene1MinSeconds: 3, hookSeconds: 3 },
} as const;
export type PacingProfileId = keyof typeof PACING_PROFILES;
export interface PacingSpec {
  profile: PacingProfileId;
  enforce?: boolean;
  overrides?: Partial<{ maxScenes: number; maxClipsPerScene: number; clipSeconds: [number, number]; cutsPerMinute: [number, number]; scene1MinSeconds: number; hookSeconds: number }>;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 片段在成片里的时长（考虑变速） */
export function outputDurationOf(segment: Pick<EditTimelineSegment, "sourceIn" | "sourceOut" | "speed">): number {
  const speed = segment.speed ?? 1;
  if (!Number.isFinite(speed) || speed <= 0) throw new Error(`speed 非法：${String(segment.speed)}`);
  return (segment.sourceOut - segment.sourceIn) / speed;
}

/** 主轨落点：由片段顺序推导（连续无空隙），与片段声明值互相校验 */
export function computeMasterTimeline(segments: EditTimelineSegment[]): Array<{ segmentId: string; masterIn: number; masterOut: number }> {
  let cursor = 0;
  return segments.map((segment) => {
    const duration = outputDurationOf(segment);
    const masterIn = cursor;
    cursor = round(cursor + duration);
    return { segmentId: segment.segmentId, masterIn, masterOut: cursor };
  });
}

/**
 * 校验时间轴。
 * 硬项（hard=true）：契约字段缺失/非法、源轨重叠、同源间隔不足、主轨不连续、总时长严重偏离。
 * 咨询项（hard=false）：间隔未达理想值、片段偏长、总时长轻微偏离。
 */
export function validateEditTimeline(timeline: EditTimeline): TimelineValidation {
  const checks: TimelineCheck[] = [];
  const fixes: TimelineFix[] = [];
  const add = (id: string, pass: boolean, hard: boolean, detail: string, fix?: TimelineFix) => {
    checks.push({ id, pass, hard, detail });
    if (!pass && fix) fixes.push(fix);
  };

  add("contract.schemaVersion", timeline.schemaVersion === "workloom.video-edit/edit-timeline/v2", true,
    `schemaVersion=${String(timeline.schemaVersion)}`,
    { segmentId: "-", field: "schemaVersion", action: "改为 workloom.video-edit/edit-timeline/v2", severity: "hard" });
  add("contract.sources", Array.isArray(timeline.sources) && timeline.sources.length > 0, true,
    `素材 ${timeline.sources?.length ?? 0} 条`,
    { segmentId: "-", field: "sources", action: "补齐素材清单（sourceId/sha256/path/fps）", severity: "hard" });
  add("contract.segments", Array.isArray(timeline.segments) && timeline.segments.length > 0, true,
    `片段 ${timeline.segments?.length ?? 0} 条`,
    { segmentId: "-", field: "segments", action: "至少需要一个片段", severity: "hard" });

  const sources = new Map<string, EditTimelineSource>();
  for (const source of timeline.sources ?? []) {
    if (!/^[a-f0-9]{64}$/u.test(source.sha256 ?? "")) {
      add(`source.sha256:${source.sourceId}`, false, true, `素材 ${source.sourceId} 的 sha256 非法`,
        { segmentId: "-", field: `sources[${source.sourceId}].sha256`, action: "补内容指纹（64 位小写 hex）", severity: "hard" });
    }
    if (sources.has(source.sourceId)) {
      add(`source.unique:${source.sourceId}`, false, true, `素材 ${source.sourceId} 重复声明`,
        { segmentId: "-", field: "sources", action: "合并重复素材声明", severity: "hard" });
    }
    sources.set(source.sourceId, source);
  }

  const bySource = new Map<string, Array<{ segmentId: string; in: number; out: number }>>();
  let seqOk = true;
  for (const [index, segment] of (timeline.segments ?? []).entries()) {
    if (segment.seq !== index) seqOk = false;
    const source = sources.get(segment.sourceId);
    if (!source) {
      add(`segment.source:${segment.segmentId}`, false, true, `片段 ${segment.segmentId} 引用未声明的素材 ${segment.sourceId}`,
        { segmentId: segment.segmentId, field: "sourceId", action: "改为已声明的素材 id", severity: "hard" });
      continue;
    }
    if (!(segment.sourceIn < segment.sourceOut)) {
      add(`segment.range:${segment.segmentId}`, false, true, `片段 ${segment.segmentId} 源轨区间非法（${segment.sourceIn}–${segment.sourceOut}）`,
        { segmentId: segment.segmentId, field: "sourceIn/sourceOut", action: "修正为 in < out", severity: "hard" });
      continue;
    }
    if (typeof source.durationSeconds === "number" && segment.sourceOut > source.durationSeconds + 0.05) {
      add(`segment.bounds:${segment.segmentId}`, false, true, `片段 ${segment.segmentId} 超出素材时长（${segment.sourceOut} > ${source.durationSeconds}）`,
        { segmentId: segment.segmentId, field: "sourceOut", action: `收窄到素材时长 ${source.durationSeconds}s 以内`, severity: "hard" });
    }
    const duration = outputDurationOf(segment);
    if (Math.abs(duration - segment.durationSeconds) > 0.05) {
      add(`segment.duration:${segment.segmentId}`, false, true, `片段 ${segment.segmentId} 声明时长 ${segment.durationSeconds}s 与源轨换算 ${round(duration)}s 不符`,
        { segmentId: segment.segmentId, field: "durationSeconds", action: `改为 ${round(duration)}s`, severity: "hard" });
    }
    if (duration < MIN_SEGMENT_SECONDS) {
      add(`segment.minLength:${segment.segmentId}`, false, true, `片段 ${segment.segmentId} 时长 ${round(duration)}s 低于下限 ${MIN_SEGMENT_SECONDS}s`,
        { segmentId: segment.segmentId, field: "sourceOut", action: `延长至 ≥${MIN_SEGMENT_SECONDS}s 或改用其他素材`, severity: "hard" });
    }
    if (duration > MAX_SEGMENT_SECONDS) {
      add(`segment.maxLength:${segment.segmentId}`, false, false, `片段 ${segment.segmentId} 时长 ${round(duration)}s 超过 ${MAX_SEGMENT_SECONDS}s（需理由）`, undefined);
    }
    const speed = segment.speed ?? 1;
    if (!(speed >= 0.1 && speed <= 8)) {
      add(`segment.speed:${segment.segmentId}`, false, true, `片段 ${segment.segmentId} 速度 ${speed} 越界（0.1–8）`,
        { segmentId: segment.segmentId, field: "speed", action: "调整到 0.1–8 之间", severity: "hard" });
    }
    const transition = segment.transitionIn;
    if (transition) {
      if (!TRANSITION_TYPES.includes(transition.type)) {
        add(`transition.type:${segment.segmentId}`, false, true, `片段 ${segment.segmentId} 转场 ${String(transition.type)} 不在枚举内`,
          { segmentId: segment.segmentId, field: "transitionIn.type", action: `改用 ${TRANSITION_TYPES.join("/")} 之一`, severity: "hard" });
      }
      if (transition.durationSeconds !== null && transition.durationSeconds !== undefined
        && (transition.durationSeconds < 0 || transition.durationSeconds > MAX_TRANSITION_SECONDS)) {
        add(`transition.duration:${segment.segmentId}`, false, true, `片段 ${segment.segmentId} 转场时长 ${transition.durationSeconds}s 越界（0–${MAX_TRANSITION_SECONDS}s）`,
          { segmentId: segment.segmentId, field: "transitionIn.durationSeconds", action: `收窄到 0–${MAX_TRANSITION_SECONDS}s`, severity: "hard" });
      }
    }
    if (segment.audio?.mode && !AUDIO_MODES.includes(segment.audio.mode)) {
      add(`audio.mode:${segment.segmentId}`, false, true, `片段 ${segment.segmentId} 声音模式 ${String(segment.audio.mode)} 不在枚举内`,
        { segmentId: segment.segmentId, field: "audio.mode", action: `改用 ${AUDIO_MODES.join("/")} 之一`, severity: "hard" });
    }
    const punchIn = segment.punchIn;
    if (punchIn) {
      const scale = punchIn.scale ?? 1;
      if (!Number.isFinite(scale) || scale < 1 || scale > 1.5) {
        add(`punchIn.scale:${segment.segmentId}`, false, true, `片段 ${segment.segmentId} 推近倍率 ${String(punchIn.scale)} 越界（1.0–1.5）`,
          { segmentId: segment.segmentId, field: "punchIn.scale", action: "收窄到 1.0–1.5（口播跳切常用 1.08–1.15）", severity: "hard" });
      }
      for (const axis of ["x", "y"] as const) {
        const value = punchIn[axis];
        if (value === null || value === undefined) continue;
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          add(`punchIn.${axis}:${segment.segmentId}`, false, true, `片段 ${segment.segmentId} 推近中心 ${axis}=${String(value)} 越界（0–1）`,
            { segmentId: segment.segmentId, field: `punchIn.${axis}`, action: "改为 0–1 的比例（0.5 = 居中）", severity: "hard" });
        }
      }
    }
    /**
     * 二次构图契约（T-2026-1011-0008）：字段级事实校验（枚举/区间）。
     * 预算类判定（无损上限、等效上采样）在计划层 reframe.planReframe 里做——
     * 它需要源像素规格，校验层不假装知道。
     */
    for (const check of validateReframeSegment(segment)) {
      add(check.id, check.pass, check.hard, check.detail, check.fix);
    }
    const list = bySource.get(segment.sourceId) ?? [];
    list.push({ segmentId: segment.segmentId, in: segment.sourceIn, out: segment.sourceOut });
    bySource.set(segment.sourceId, list);
  }
  add("segments.seq", seqOk, true, seqOk ? "片段序号从 0 连续" : "片段序号必须从 0 连续递增",
    seqOk ? undefined : { segmentId: "-", field: "segments[].seq", action: "重排序号", severity: "hard" });

  let overlapOk = true;
  let gapOk = true;
  let jumpCutCount = 0;
  let punchInCovered = 0;
  let minGap = Number.POSITIVE_INFINITY;
  const gapPolicy: SourceGapPolicy = timeline.sourceGapPolicy ?? "standard";
  if (timeline.sourceGapPolicy !== undefined && timeline.sourceGapPolicy !== null
    && !SOURCE_GAP_POLICIES.includes(timeline.sourceGapPolicy)) {
    add("timeline.sourceGapPolicy", false, true, `未知同源间隔策略：${String(timeline.sourceGapPolicy)}`,
      { segmentId: "-", field: "sourceGapPolicy", action: `改用 ${SOURCE_GAP_POLICIES.join(" / ")}`, severity: "hard" });
  }
  for (const [sourceId, spans] of bySource) {
    const sorted = [...spans].sort((a, b) => a.in - b.in);
    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1]!;
      const current = sorted[i]!;
      if (current.in < previous.out) {
        overlapOk = false;
        add(`source.overlap:${sourceId}:${current.segmentId}`, false, true,
          `素材 ${sourceId} 的片段 ${previous.segmentId} 与 ${current.segmentId} 源轨重叠`,
          { segmentId: current.segmentId, field: "sourceIn", action: `后移到 ${round(previous.out, 3)}s 之后（或换素材）`, severity: "hard" });
        continue;
      }
      const gap = current.in - previous.out;
      minGap = Math.min(minGap, gap);
      if (gap > 0.02) {
        jumpCutCount += 1;
        /**
         * 遮盖口径是"边界"而不是"单段"：跳切发生在两段之间，只要前后两段的推近倍率不同，
         * 观众看到的就是一次景别变化（1.0 ↔ 1.12 交替即 100% 覆盖），而不是跳帧。
         */
        const currentSegment = (timeline.segments ?? []).find((entry) => entry.segmentId === current.segmentId);
        const previousSegment = (timeline.segments ?? []).find((entry) => entry.segmentId === previous.segmentId);
        const currentScale = currentSegment?.punchIn?.scale ?? 1;
        const previousScale = previousSegment?.punchIn?.scale ?? 1;
        if (Math.abs(currentScale - previousScale) > 0.001) punchInCovered += 1;
      }
      /**
       * 口播策略：允许密集跳切（间隔天然 <1s），但要求"跳切有遮盖计划"（推近 punch-in），
       * 遮盖不足只作咨询项——审美口径不得写成硬闸（T-2026-0930-0015）。
       */
      if (gapPolicy === "single-take-talking-head") {
        /** 口播的密集跳切是体裁要求：逐条提示会淹没报告，改成末尾一条聚合项（talk.jumpCutCoverage）。 */
        continue;
      }
      if (gap < MIN_SAME_SOURCE_GAP_SECONDS) {
        gapOk = false;
        add(`source.gap:${sourceId}:${current.segmentId}`, false, true,
          `素材 ${sourceId} 的相邻片段间隔 ${round(gap)}s < ${MIN_SAME_SOURCE_GAP_SECONDS}s`,
          { segmentId: current.segmentId, field: "sourceIn", action: `间隔拉到 ≥${MIN_SAME_SOURCE_GAP_SECONDS}s（理想 ≥${IDEAL_SAME_SOURCE_GAP_SECONDS}s）`, severity: "hard" });
      } else if (gap < IDEAL_SAME_SOURCE_GAP_SECONDS) {
        add(`source.gapIdeal:${sourceId}:${current.segmentId}`, false, false, `素材 ${sourceId} 的相邻片段间隔 ${round(gap)}s 未达理想值 ${IDEAL_SAME_SOURCE_GAP_SECONDS}s`, undefined);
      }
    }
  }
  add("timeline.noOverlap", overlapOk, true, overlapOk ? "同源片段无重叠" : "存在同源重叠", undefined);
  if (gapPolicy === "single-take-talking-head") {
    /** 口播的替代硬闸：源轨顺序必须单调递增（允许删中间，不允许回跳复用）。 */
    let monotonic = true;
    let previousStart = Number.NEGATIVE_INFINITY;
    for (const segment of timeline.segments ?? []) {
      if (segment.sourceIn < previousStart - 0.001) monotonic = false;
      previousStart = segment.sourceIn;
    }
    add("talk.monotonicOrder", monotonic, true,
      monotonic ? "口播策略：源轨顺序单调递增（无回跳复用）" : "口播策略下片段源轨出现回跳（同一段被复用）",
      monotonic ? undefined : { segmentId: "-", field: "segments[].sourceIn", action: "按源轨时间顺序重排；确要复用同一句请显式声明新版本", severity: "hard" });
    const coverage = jumpCutCount === 0 ? 1 : round(punchInCovered / jumpCutCount, 2);
    add("talk.jumpCutCoverage", true, false,
      `跳切 ${jumpCutCount} 处，推近遮盖 ${punchInCovered} 处（覆盖率 ${coverage}）；低于 50% 时同机位跳切会有"跳帧"观感`,
      undefined);
    add("timeline.sameSourceGap", true, false,
      `口播精剪策略：允许同源密集跳切（最小间隔 ${Number.isFinite(minGap) ? `${round(minGap)}s` : "不适用"}）——由 talk.monotonicOrder 与 talk.jumpCutCoverage 替代管理`,
      undefined);
  } else {
    add("timeline.sameSourceGap", gapOk, true, gapOk ? `同源最小间隔 ${Number.isFinite(minGap) ? `${round(minGap)}s` : "不适用"}` : "存在间隔不足", undefined);
  }

  const master = computeMasterTimeline(timeline.segments ?? []);
  let continuous = true;
  for (const [index, entry] of master.entries()) {
    const declared = timeline.segments[index]!;
    if (declared.masterIn !== null && declared.masterIn !== undefined && Math.abs(declared.masterIn - entry.masterIn) > 0.05) {
      continuous = false;
      add(`master.continuous:${entry.segmentId}`, false, true, `片段 ${entry.segmentId} 主轨落点 ${declared.masterIn}s 与推导值 ${entry.masterIn}s 不符`,
        { segmentId: entry.segmentId, field: "masterIn", action: "清空或改为推导值", severity: "hard" });
    }
  }
  add("master.continuous", continuous, true, continuous ? "主轨连续无空隙" : "主轨存在声明冲突", undefined);

  const totalDuration = round(master.at(-1)?.masterOut ?? 0);
  const target = timeline.target?.durationSeconds;
  const band = timeline.target?.durationBand;
  if (band !== undefined) {
    const valid = Number.isFinite(band.minSeconds) && Number.isFinite(band.maxSeconds)
      && band.minSeconds > 0 && band.maxSeconds >= band.minSeconds && band.maxSeconds <= 1800;
    const outputSeconds = valid ? planTransitions({ segments: timeline.segments, mode: "declared", pacing: timeline.pacing, fps: timeline.target.fps }).expectedOutputDurationSeconds : NaN;
    const tolerance = 1 / timeline.target.fps;
    const pass = valid && outputSeconds >= band.minSeconds - tolerance && outputSeconds <= band.maxSeconds + tolerance;
    add("duration.targetBand", pass, true, `声明转场后 ${outputSeconds}s / 请求 ${band.minSeconds}–${band.maxSeconds}s`,
      pass ? undefined : { segmentId: "-", field: "target.durationBand", action: "保留原请求，调整正文与节奏段以满足成片时长", severity: "hard" });
  } else if (typeof target === "number" && target > 0) {
    const deviation = Math.abs(totalDuration - target) / target;
    add("duration.target", deviation <= 0.2, true,
      `成片 ${totalDuration}s / 目标 ${target}s（偏差 ${(deviation * 100).toFixed(1)}%）`,
      deviation > 0.2
        ? { segmentId: "-", field: "target.durationSeconds", action: `增删片段把总时长拉回 ${round(target * 0.8)}–${round(target * 1.2)}s`, severity: "hard" }
        : undefined);
    if (deviation > 0.05) {
      add("duration.targetIdeal", false, false, `总时长与目标偏差 ${(deviation * 100).toFixed(1)}%（建议 ≤5%）`, undefined);
    }
  }

  const policy = timeline.audioDesign?.originalAudioPolicy;
  add("audio.policy", ORIGINAL_AUDIO_POLICIES.includes(policy as (typeof ORIGINAL_AUDIO_POLICIES)[number]), true,
    `originalAudioPolicy=${String(policy)}`,
    ORIGINAL_AUDIO_POLICIES.includes(policy as (typeof ORIGINAL_AUDIO_POLICIES)[number])
      ? undefined
      : { segmentId: "-", field: "audioDesign.originalAudioPolicy", action: `改用 ${ORIGINAL_AUDIO_POLICIES.join("/")}`, severity: "hard" });

  // —— 节奏档案（咨询项；pacing.enforce=true 时升级为硬项）——
  const spec: PacingSpec = timeline.pacing ?? { profile: "documentary" };
  const profile = PACING_PROFILES[spec.profile];
  if (!profile) {
    add("pacing.profile", false, true, `未知节奏档案：${String(spec.profile)}`,
      { segmentId: "-", field: "pacing.profile", action: `改用 ${Object.keys(PACING_PROFILES).join(" / ")}`, severity: "hard" });
  } else {
    const hard = spec.enforce === true;
    const limits = { ...profile, ...(spec.overrides ?? {}) };
    const sceneIds = [...new Set((timeline.groups ?? []).map((group) => group.groupId))];
    const clipsPerScene = new Map<string, number>();
    for (const segment of timeline.segments ?? []) {
      const key = segment.groupId ?? "(未分组)";
      clipsPerScene.set(key, (clipsPerScene.get(key) ?? 0) + 1);
    }
    const sceneCount = Math.max(sceneIds.length, clipsPerScene.size);
    add("pacing.scenes", sceneCount <= limits.maxScenes, hard,
      `场景数 ${sceneCount}（档案 ${spec.profile} 默认 ≤${limits.maxScenes}）`,
      sceneCount > limits.maxScenes
        ? { segmentId: "-", field: "groups", action: `合并相邻场景到 ≤${limits.maxScenes}，或改用更高密度的档案（vlog / fast_cut / information）`, severity: hard ? "hard" : "advisory" }
        : undefined);
    const crowded = [...clipsPerScene.entries()].filter(([, count]) => count > limits.maxClipsPerScene);
    add("pacing.clipsPerScene", crowded.length === 0, hard,
      crowded.length === 0 ? `每场景片段数 ≤${limits.maxClipsPerScene}` : `${crowded.map(([id, n]) => `${id}=${n}`).join("、")} 超出 ≤${limits.maxClipsPerScene}`,
      crowded.length > 0
        ? { segmentId: crowded[0]![0], field: "segments[].groupId", action: `把高密度场景改为 fast_cut 档案，或把镜头归纳为镜头组`, severity: hard ? "hard" : "advisory" }
        : undefined);
    const durations = (timeline.segments ?? []).map((segment) => outputDurationOf(segment));
    const shortCount = durations.filter((value) => value < limits.clipSeconds[0]).length;
    const longCount = durations.filter((value) => value > limits.clipSeconds[1]).length;
    add("pacing.clipSeconds", shortCount === 0 && longCount === 0, hard,
      `单镜时长 ${limits.clipSeconds[0]}–${limits.clipSeconds[1]}s（偏短 ${shortCount} 个 / 偏长 ${longCount} 个）`, undefined);
    const cutsPerMinute = totalDuration > 0 ? Number(((timeline.segments?.length ?? 0) / totalDuration * 60).toFixed(1)) : 0;
    const [cutLo, cutHi] = limits.cutsPerMinute;
    add("pacing.cutsPerMinute", cutsPerMinute >= cutLo && cutsPerMinute <= cutHi, hard,
      `切点密度 ${cutsPerMinute}/min（档案 ${spec.profile} 目标 ${cutLo}–${cutHi}）`, undefined);
    const firstSceneEnd = (() => {
      const firstSceneId = timeline.segments?.[0]?.groupId;
      if (!firstSceneId) return 0;
      return (timeline.segments ?? []).filter((segment) => segment.groupId === firstSceneId)
        .reduce((sum, segment) => sum + outputDurationOf(segment), 0);
    })();
    add("pacing.scene1", firstSceneEnd >= limits.scene1MinSeconds, hard,
      `首场景 ${round(firstSceneEnd)}s（档案 ${spec.profile} 目标 ≥${limits.scene1MinSeconds}s；素材不足时保留短首场景并在回执说明）`, undefined);
    add("pacing.hook", (timeline.segments?.length ?? 0) > 0, false,
      `钩子窗口：档案 ${spec.profile} 建议前 ${limits.hookSeconds}s 内给出信息/情绪钩子（人工确认）`, undefined);
  }
  // 结论在所有检查（含节奏档案）之后统一计算：enforce=true 时节奏项参与硬判定
  const ok = checks.every((check) => check.pass || !check.hard);
  return { ok, checks, fixes, totalDurationSeconds: totalDuration };
}

export interface AssemblyPlan {
  normalize: Array<{
    segmentId: string;
    input: string;
    sourceIn: number;
    sourceOut: number;
    output: string;
    args: string[];
    /** 该段生效的取景描述子（null = 沿用既有归一化路径） */
    reframe?: ReframeDescriptor | null;
  }>;
  concat: { listPath: string; output: string; args: string[] };
  totalDurationSeconds: number;
  /** 取景计划（供 CLI 打日志/写回执；未开启取景时为 null） */
  reframePlan?: ReframePlan | null;
}

/**
 * 时间轴素材路径归一：相对路径按**时间轴文件所在目录**解析成绝对路径。
 * 为什么：执行器（assemble/post/verify）都以进程 cwd 解析相对路径；项目目录搬走后，
 * "timeline 在同级、素材在同级"的相对写法会在别的 cwd 下解析失败（实机踩坑：t.mp4 not found）。
 * 只做字符串归一（不查文件是否存在），是否可用仍由执行器的存在性检查负责。
 */
export function resolveTimelineSourcePaths(timeline: EditTimeline, baseDir: string): EditTimeline {
  const isAbsolutePath = (value: string) => value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value);
  const normalize = (value: string): string => {
    if (!value || isAbsolutePath(value)) return value;
    return `${baseDir.replace(/\/+$/u, "")}/${value.replace(/^\.\//u, "")}`;
  };
  return {
    ...timeline,
    sources: (timeline.sources ?? []).map((source) => ({ ...source, path: normalize(source.path) })),
  };
}

/**
 * 目标画幅 → 输出分辨率（短边默认 1080，偶数对齐）。
 * `planAssembly` 的旧默认是写死的 1080×1920（竖屏）——对 16:9 项目会静默竖屏化，
 * 属于"主流程没变、但成片被悄悄改画幅"的事故。这里把画幅跟随 `timeline.target.aspectRatio`。
 */
export function resolutionForAspect(aspectRatio: string, options: { shortSide?: number } = {}): { width: number; height: number } {
  const shortSide = Number.isFinite(options.shortSide) && (options.shortSide as number) > 0 ? Math.round(options.shortSide as number) : 1080;
  const matched = /^\s*(\d+)\s*:\s*(\d+)\s*$/u.exec(String(aspectRatio ?? ""));
  if (!matched) return { width: 1080, height: 1920 };
  const a = Number(matched[1]);
  const b = Number(matched[2]);
  if (!(a > 0) || !(b > 0)) return { width: 1080, height: 1920 };
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return a >= b
    ? { width: even(shortSide * (a / b)), height: even(shortSide) }
    : { width: even(shortSide), height: even(shortSide * (b / a)) };
}

/** 变速时的 atempo 链（atempo 单实例只支持 0.5–2.0，超出必须串接） */
export function atempoChain(speed: number): string[] {
  if (!Number.isFinite(speed) || speed <= 0) throw new Error(`speed 非法：${String(speed)}`);
  const filters: string[] = [];
  let remaining = speed;
  while (remaining > 2.0) {
    filters.push("atempo=2");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1) > 1e-9 || filters.length === 0) filters.push(`atempo=${Number(remaining.toFixed(6))}`);
  return filters;
}

/**
 * 生成合成计划（纯函数，不执行）。
 * 逐段裁切 + 归一化（画幅/帧率/像素格式/音轨统一）→ concat demuxer 无损拼接。
 * `-ss/-to` 放在 `-i` 之前（快速定位）+ 结尾 `-t` 精确裁剪，避免长素材定位误差。
 */
export function planAssembly(
  timeline: EditTimeline,
  options: {
    workDir: string;
    outputPath: string;
    width?: number;
    height?: number;
    fps?: number;
    crf?: number;
    /**
     * 取景口径（T-2026-1011-0008）：缺省 undefined = 完全沿用既有行为（含 legacy punchIn 旧路径）。
     * 传入 `{ mode: "declared" }` 后，声明了 `reframe`（或 legacy `punchIn`）的段落走 crop-first 取景链。
     */
    reframe?: ReframePlanOptions | null;
    /**
     * true = 只做**源分辨率**裁切（trim + 变速 + SAR 归一），不缩放到画布。
     * 供 `edit:post` 把取景留给后期引擎（post-bridge 在源像素上做 crop-first，
     * 并按变体缓存）；`edit:assemble` 粗剪不使用本模式。
     */
    preserveSource?: boolean;
  },
): AssemblyPlan {
  const { workDir, outputPath } = options;
  const fps = options.fps ?? timeline.target.fps;
  const crf = options.crf ?? 20;
  const derived = resolutionForAspect(timeline.target?.aspectRatio ?? "");
  const width = options.width ?? derived.width;
  const height = options.height ?? derived.height;
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`fps 非法：${String(fps)}`);
  const reframePlan = options.reframe ? planReframe({ timeline, options: options.reframe }) : null;
  const sources = new Map(timeline.sources.map((s) => [s.sourceId, s]));
  const normalize = (timeline.segments ?? []).map((segment, index) => {
    const source = sources.get(segment.sourceId);
    if (!source) throw new Error(`片段 ${segment.segmentId} 引用未声明素材 ${segment.sourceId}`);
    const duration = outputDurationOf(segment);
    const speed = segment.speed ?? 1;
    const descriptor = reframePlan?.segments.find((entry) => entry.segmentId === segment.segmentId)?.descriptor ?? null;
    let filters: string[];
    if (options.preserveSource) {
      /** 保留源分辨率：取景交给后期引擎（crop-first 需要源像素），这里只做 SAR 归一。 */
      filters = ["setsar=1"];
    } else if (descriptor) {
      /** 取景链：源原生裁切（crop-first）→ 填充/画布；顺序即质量（见 reframe.ts 头注）。 */
      const built = buildReframeFilters({
        descriptor,
        source: options.reframe?.sourceSizes?.[segment.segmentId] ?? null,
        canvas: { width, height },
        durationSeconds: duration,
        fps,
      });
      filters = built.filters;
    } else {
      filters = [
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
      ];
    }
    /**
     * 跳切遮盖（punch-in）：把已归一化的画面再放大后中心裁切，产出同尺寸的"推近版"。
     * 只放大不改变音频（口播靠推近给观众"换镜头"的错觉，避免密集跳切的跳帧感）。
     * legacy 路径：未开启取景计划时保持既有像素路径（零行为变化）。
     */
    const punchScale = descriptor ? 1 : (segment.punchIn?.scale ?? 1);
    if (!descriptor && Number.isFinite(punchScale) && punchScale > 1.0001) {
      const xRatio = segment.punchIn?.x ?? 0.5;
      const yRatio = segment.punchIn?.y ?? 0.5;
      filters.push(`scale=w='ceil(iw*${round(punchScale, 4)}/2)*2':h='ceil(ih*${round(punchScale, 4)}/2)*2'`);
      filters.push(`crop=w=${width}:h=${height}:x='(iw-ow)*${round(xRatio, 4)}':y='(ih-oh)*${round(yRatio, 4)}'`);
    }
    if (!descriptor && !options.preserveSource) filters.push("setsar=1", `fps=${fps}`);
    if (speed !== 1) filters.unshift(`setpts=${round(1 / speed, 6)}*PTS`);
    const output = `${workDir}/seg-${String(index).padStart(3, "0")}-${segment.segmentId}.mp4`;
    /**
     * 音轨口径（2026-10-11）：
     *   · 声明 `hasAudio:false` 的素材补 `anullsrc` 静音轨，避免 concat 时"有轨/无轨"混拼出错；
     *   · 未声明 `hasAudio` 时用 `-map 0:a:0?`（可选映射），有音轨就带、没有也不失败；
     *   · 变速 2× 只改视频 PTS 会把音轨留在原速 → 音画不同步；这里同时给音轨串 atempo 链。
     */
    const args = ["-hide_banner", "-loglevel", "error", "-y"];
    args.push(
      "-ss", String(round(segment.sourceIn, 3)), "-to", String(round(segment.sourceOut, 3)),
      "-i", source.path,
    );
    if (source.hasAudio === false) args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
    args.push(
      "-t", String(round(duration, 3)),
      "-vf", filters.join(","),
    );
    if (source.hasAudio === false) {
      args.push("-map", "0:v:0", "-map", "1:a:0", "-shortest");
    } else if (source.hasAudio === true) {
      args.push("-map", "0:v:0", "-map", "0:a:0");
    } else {
      args.push("-map", "0:v:0", "-map", "0:a:0?");
    }
    if (speed !== 1) args.push("-filter:a", atempoChain(speed).join(","));
    args.push(
      "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ar", "48000", "-ac", "2",
      output,
    );
    return { segmentId: segment.segmentId, input: source.path, sourceIn: segment.sourceIn, sourceOut: segment.sourceOut, output, args, reframe: descriptor };
  });
  const listPath = `${workDir}/concat.txt`;
  return {
    normalize,
    concat: {
      listPath,
      output: outputPath,
      args: ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", outputPath],
    },
    totalDurationSeconds: round(computeMasterTimeline(timeline.segments ?? []).at(-1)?.masterOut ?? 0),
    reframePlan,
  };
}
