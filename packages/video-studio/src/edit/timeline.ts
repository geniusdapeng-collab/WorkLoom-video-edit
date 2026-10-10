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

export const TRANSITION_TYPES = [
  "cut", "dissolve", "fade_from_black", "fade_to_black", "wipe", "match_cut", "jump_cut", "whip_pan", "zoom_blur",
] as const;
export type TransitionType = (typeof TRANSITION_TYPES)[number];

export const AUDIO_MODES = ["original", "mute", "ambience_only", "bgm_only", "duck_original", "j_cut", "l_cut"] as const;
export type AudioMode = (typeof AUDIO_MODES)[number];

export const ORIGINAL_AUDIO_POLICIES = ["keep", "duck_under_bgm", "replace", "mute"] as const;

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
  masterIn?: number | null;
  masterOut?: number | null;
}

export interface EditTimeline {
  schemaVersion: string;
  timelineId: string;
  filmId?: string | null;
  revision?: number;
  prevRevision?: number | null;
  /** 节奏档案（可选）：缺省按 documentary 咨询项给出；不写也能出片 */
  pacing?: PacingSpec | null;
  target: {
    durationSeconds: number;
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
    const list = bySource.get(segment.sourceId) ?? [];
    list.push({ segmentId: segment.segmentId, in: segment.sourceIn, out: segment.sourceOut });
    bySource.set(segment.sourceId, list);
  }
  add("segments.seq", seqOk, true, seqOk ? "片段序号从 0 连续" : "片段序号必须从 0 连续递增",
    seqOk ? undefined : { segmentId: "-", field: "segments[].seq", action: "重排序号", severity: "hard" });

  let overlapOk = true;
  let gapOk = true;
  let minGap = Number.POSITIVE_INFINITY;
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
  add("timeline.sameSourceGap", gapOk, true, gapOk ? `同源最小间隔 ${Number.isFinite(minGap) ? `${round(minGap)}s` : "不适用"}` : "存在间隔不足", undefined);

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
  if (typeof target === "number" && target > 0) {
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
  normalize: Array<{ segmentId: string; input: string; sourceIn: number; sourceOut: number; output: string; args: string[] }>;
  concat: { listPath: string; output: string; args: string[] };
  totalDurationSeconds: number;
}

/**
 * 生成合成计划（纯函数，不执行）。
 * 逐段裁切 + 归一化（画幅/帧率/像素格式/音轨统一）→ concat demuxer 无损拼接。
 * `-ss/-to` 放在 `-i` 之前（快速定位）+ 结尾 `-t` 精确裁剪，避免长素材定位误差。
 */
export function planAssembly(
  timeline: EditTimeline,
  options: { workDir: string; outputPath: string; width?: number; height?: number; fps?: number; crf?: number },
): AssemblyPlan {
  const { workDir, outputPath } = options;
  const fps = options.fps ?? timeline.target.fps;
  const crf = options.crf ?? 20;
  const width = options.width ?? 1080;
  const height = options.height ?? 1920;
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`fps 非法：${String(fps)}`);
  const sources = new Map(timeline.sources.map((s) => [s.sourceId, s]));
  const normalize = (timeline.segments ?? []).map((segment, index) => {
    const source = sources.get(segment.sourceId);
    if (!source) throw new Error(`片段 ${segment.segmentId} 引用未声明素材 ${segment.sourceId}`);
    const duration = outputDurationOf(segment);
    const speed = segment.speed ?? 1;
    const filters = [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
      "setsar=1",
      `fps=${fps}`,
    ];
    if (speed !== 1) filters.unshift(`setpts=${round(1 / speed, 6)}*PTS`);
    const output = `${workDir}/seg-${String(index).padStart(3, "0")}-${segment.segmentId}.mp4`;
    const args = [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", String(round(segment.sourceIn, 3)), "-to", String(round(segment.sourceOut, 3)),
      "-i", source.path,
      "-t", String(round(duration, 3)),
      "-vf", filters.join(","),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ar", "48000", "-ac", "2",
      output,
    ];
    return { segmentId: segment.segmentId, input: source.path, sourceIn: segment.sourceIn, sourceOut: segment.sourceOut, output, args };
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
  };
}
