/**
 * edit/transitions.ts —— 转场计划（编辑意图 → 引擎转场）纯函数层。
 *
 * 边界（与 timeline.ts 同口径）：
 *   · 本层只做**编辑意图与时长**的判定：哪一刀要转场、用哪种意图、多长、是否缓动；
 *   · 具体渲染成哪个 FFmpeg xfade 转场，由引擎层（post-bridge/core.mjs）结合
 *     `bundles/ai-video/library/transitions/catalog.json` 与各变体配方的 intentMap 决定；
 *   · 纯函数：同输入 → 同输出，不做 IO、不读系统时间，产物可复算、可断言。
 *
 * 为什么需要这一层（2026-10-11 事故复盘）：
 *   旧链路只有 hard（硬切）与 fade（逐段淡入淡出经黑场）两条路：前者没有转场，
 *   后者在镜头之间插黑，观感"廉价"。剪辑脚本里其实早已声明 `transitionIn`
 *   （dissolve/wipe/whip_pan/zoom_blur…），但后期从不消费它——本层把声明变成可执行计划。
 *
 * 契约：`bundles/video-edit/schemas/edit-timeline.schema.json#transitionIn`（意图枚举与 0–2s 上限）。
 */

import {
  type EditTimelineTransition, type PacingProfileId, type PacingSpec, type TransitionType,
} from "./timeline.js";

export const TRANSITION_PLAN_SCHEMA = "workloom.video-edit/transition-plan/v1";

/** 转场计划模式：hard=全硬切（默认，产品所有者 2026-10-10 口径）；declared=只渲染脚本声明；auto=声明优先 + 场景切换自动补。 */
export const TRANSITION_MODES = ["hard", "declared", "auto"] as const;
export type TransitionMode = (typeof TRANSITION_MODES)[number];

export const TRANSITION_EASINGS = ["native", "smooth"] as const;
export type TransitionEasing = (typeof TRANSITION_EASINGS)[number];

export interface IntentTiming {
  /** 引擎默认转场名（null = 硬切，不进引擎）；与 catalog.json#intents 交叉校验。 */
  type: string | null;
  durationSeconds: number;
  easing: TransitionEasing;
  /** 方向参数 → 引擎转场名（params.direction）。 */
  directions?: Record<string, string>;
  /** 该意图本身允许黑场（黑场机检豁免）。 */
  blackDip?: boolean;
}

/**
 * 编辑意图 → 引擎转场与默认时长。
 *
 * 口径来源（2026-10-11 依据 FFmpeg 6.0 `-h filter=xfade` 实测与源码曲线确认）：
 *   · dissolve      → fade      线性交叉溶解（最通用的叠化）
 *   · fade_from/to  → fadeblack 黑场；仅用于时空跳变，不作为镜头间默认
 *   · wipe          → wipeleft  方向可换 wipeleft/right/up/down
 *   · whip_pan      → smoothleft 柔边推移（甩镜感），≤0.35s，再长就"像幻灯片"
 *   · zoom_blur     → zoomin    推近穿越；FFmpeg 6.0 源码用 smoothstep(0.5,1,P)，自带缓动
 *   · match_cut / jump_cut / cut → 硬切（编辑技法要求帧精确，混合即失效）
 */
export const INTENT_TIMING: Record<TransitionType, IntentTiming> = {
  cut: { type: null, durationSeconds: 0, easing: "native" },
  dissolve: { type: "fade", durationSeconds: 0.5, easing: "native" },
  fade_from_black: { type: "fadeblack", durationSeconds: 0.5, easing: "native", blackDip: true },
  fade_to_black: { type: "fadeblack", durationSeconds: 0.5, easing: "native", blackDip: true },
  wipe: {
    type: "wipeleft",
    durationSeconds: 0.4,
    easing: "native",
    directions: { left: "wipeleft", right: "wiperight", up: "wipeup", down: "wipedown" },
  },
  match_cut: { type: null, durationSeconds: 0, easing: "native" },
  jump_cut: { type: null, durationSeconds: 0, easing: "native" },
  whip_pan: {
    type: "smoothleft",
    durationSeconds: 0.25,
    easing: "native",
    directions: { left: "smoothleft", right: "smoothright", up: "smoothup", down: "smoothdown" },
  },
  zoom_blur: { type: "zoomin", durationSeconds: 0.3, easing: "native" },
};

/** 节奏档案 → 场景切换意图与时长系数（与 catalog.json#packs 交叉校验）。 */
export const PACING_SCENE_INTENT: Record<PacingProfileId, { intent: TransitionType; scale: number }> = {
  documentary: { intent: "dissolve", scale: 1.15 },
  vlog: { intent: "whip_pan", scale: 1.0 },
  fast_cut: { intent: "wipe", scale: 0.7 },
  information: { intent: "dissolve", scale: 0.8 },
  /** 口播精剪（talk）：段内是句子级硬切（跳切），只有话题/场景切换才用一次短叠化。 */
  talk: { intent: "dissolve", scale: 0.8 },
};

export interface TransitionPlanOptions {
  segments: Array<{
    segmentId: string;
    groupId?: string | null;
    durationSeconds: number;
    transitionIn?: EditTimelineTransition | null;
    motive?: string | null;
  }>;
  mode: TransitionMode;
  /** 显式指定节奏档案；缺省取 timeline.pacing.profile，再缺省 documentary。 */
  pack?: PacingProfileId | null;
  pacing?: PacingSpec | null;
  fps?: number;
  easing?: TransitionEasing;
  maxSeconds?: number;
  minSeconds?: number;
  maxShareOfClip?: number;
}

export interface TransitionPlanCut {
  /** 第几刀（1-based：第 i 段与前一段之间）。 */
  cutIndex: number;
  afterSegmentId: string;
  incomingSegmentId: string;
  /** 编辑意图（timeline 契约枚举）。 */
  intent: TransitionType;
  /** 默认引擎转场名；null 表示硬切（不会进入计划）。变体 intentMap 可在渲染期覆盖具体类型。 */
  engineType: string | null;
  /** true 表示脚本用 `params.xfade` 显式点名了引擎转场——变体 intentMap 不得覆盖。 */
  explicit: boolean;
  durationSeconds: number;
  /** 相邻镜头允许的最大转场时长（= min(上限, 前后镜头 × maxShare)）。 */
  maxDurationSeconds: number;
  easing: TransitionEasing;
  direction: string | null;
  /** 计划依据：declared（脚本声明）/ scene-change（场景组切换自动补）。 */
  source: "declared" | "scene-change";
  reason: string;
}

export interface TransitionPlan {
  schemaVersion: typeof TRANSITION_PLAN_SCHEMA;
  mode: TransitionMode;
  pack: PacingProfileId;
  fps: number;
  cuts: TransitionPlanCut[];
  hardCuts: number;
  transitionCount: number;
  totalTransitionSeconds: number;
  expectedOutputDurationSeconds: number;
  advisories: string[];
}

/**
 * 时长安全边界（与 catalog.json#durationPolicy 交叉校验）：
 * 转场最多吃掉相邻较短镜头的 1/3 —— 超过这个比例，转场就会把镜头本身"吃掉"，
 * 观感变成幻灯片；宁可降级硬切，也不硬凑转场。
 */
export const TRANSITION_LIMITS = {
  minSeconds: 0.15,
  maxSeconds: 2,
  maxShareOfClip: 1 / 3,
  minFrames: 2,
} as const;

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function directionOf(transition: EditTimelineTransition | null | undefined): string | null {
  const raw = transition?.params?.direction;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function explicitEngineType(transition: EditTimelineTransition | null | undefined): string | null {
  const raw = transition?.params?.xfade;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  return raw.trim();
}

function easingOf(transition: EditTimelineTransition | null | undefined, fallback: TransitionEasing): TransitionEasing {
  const raw = transition?.params?.easing;
  if (raw === "native" || raw === "smooth") return raw;
  return fallback;
}

/**
 * 生成转场计划（纯函数）。
 *
 * 决策顺序（每一切点）：脚本声明优先 → auto 模式下场景组切换补默认 → 其余硬切。
 * 安全降级：相邻镜头过短导致可用时长低于下限时，**降级为硬切**并记入 advisories，
 * 不会为了"有转场"而挤压镜头（宁可硬切，不做出幻灯片式的短促黑闪）。
 */
export function planTransitions(options: TransitionPlanOptions): TransitionPlan {
  const segments = options.segments ?? [];
  const fps = options.fps ?? 30;
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`fps 非法：${String(options.fps)}`);
  const mode = options.mode;
  if (!TRANSITION_MODES.includes(mode)) throw new Error(`未知转场模式：${String(mode)}（可用：${TRANSITION_MODES.join(" / ")}）`);
  const globalEasing = options.easing ?? "native";
  if (!TRANSITION_EASINGS.includes(globalEasing)) throw new Error(`未知缓动：${String(options.easing)}（可用：${TRANSITION_EASINGS.join(" / ")}）`);
  const pack = options.pack ?? options.pacing?.profile ?? "documentary";
  const packSpec = PACING_SCENE_INTENT[pack];
  if (!packSpec) throw new Error(`未知节奏档案：${String(pack)}（可用：${Object.keys(PACING_SCENE_INTENT).join(" / ")}）`);
  const maxSeconds = options.maxSeconds ?? TRANSITION_LIMITS.maxSeconds;
  const minSeconds = Math.max(options.minSeconds ?? TRANSITION_LIMITS.minSeconds, TRANSITION_LIMITS.minFrames / fps);
  const maxShare = options.maxShareOfClip ?? TRANSITION_LIMITS.maxShareOfClip;

  const cuts: TransitionPlanCut[] = [];
  const advisories: string[] = [];
  let totalTransitionSeconds = 0;
  const totalSeconds = segments.reduce((sum, segment) => sum + Math.max(0, segment.durationSeconds), 0);

  if (mode === "hard") {
    advisories.push("模式 hard：全部硬切（默认口径）；如需脚本声明的转场，请显式使用 declared / auto。");
    return {
      schemaVersion: TRANSITION_PLAN_SCHEMA,
      mode,
      pack,
      fps,
      cuts,
      hardCuts: Math.max(0, segments.length - 1),
      transitionCount: 0,
      totalTransitionSeconds: 0,
      expectedOutputDurationSeconds: round(totalSeconds),
      advisories,
    };
  }

  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1]!;
    const current = segments[index]!;
    const declared = current.transitionIn ?? null;
    const declaredIntent = declared?.type ?? null;
    let intent: TransitionType | null = null;
    let source: TransitionPlanCut["source"] = "declared";
    let reason = "";
    let scale = 1;

    if (declaredIntent && declaredIntent !== "cut") {
      intent = declaredIntent;
      source = "declared";
      reason = `脚本声明 transitionIn=${declaredIntent}`;
    } else if (mode === "auto" && previous.groupId && current.groupId && previous.groupId !== current.groupId) {
      intent = packSpec.intent;
      scale = packSpec.scale;
      source = "scene-change";
      reason = `场景组切换 ${previous.groupId} → ${current.groupId}（节奏档案 ${pack} 默认 ${packSpec.intent}）`;
    }

    if (!intent) continue;
    const timing = INTENT_TIMING[intent];
    if (!timing) {
      advisories.push(`切点 ${index}（${previous.segmentId}→${current.segmentId}）意图 ${intent} 无默认映射，已按硬切处理。`);
      continue;
    }
    const direction = directionOf(declared);
    const explicitType = explicitEngineType(declared);
    const engineType = explicitType
      ?? (direction && timing.directions ? timing.directions[direction] ?? timing.type : timing.type);
    if (engineType === null) {
      advisories.push(`切点 ${index}（${previous.segmentId}→${current.segmentId}）意图 ${intent} 要求硬切（编辑技法），保持帧精确拼接。`);
      continue;
    }

    const headroom = Math.min(
      maxSeconds,
      Math.max(0, previous.durationSeconds) * maxShare,
      Math.max(0, current.durationSeconds) * maxShare,
    );
    const maxDurationSeconds = round(headroom);
    if (maxDurationSeconds < minSeconds) {
      advisories.push(`切点 ${index}（${previous.segmentId}→${current.segmentId}）相邻镜头过短（可用 ${maxDurationSeconds}s < 下限 ${round(minSeconds)}s），已降级为硬切。`);
      continue;
    }
    const requested = declared?.durationSeconds !== null && declared?.durationSeconds !== undefined
      ? declared.durationSeconds
      : timing.durationSeconds * scale;
    const durationSeconds = round(Math.min(Math.max(requested, minSeconds), maxDurationSeconds));
    let easing = easingOf(declared, globalEasing);
    if (easing === "smooth" && engineType !== "fade") {
      advisories.push(`切点 ${index} 的转场 ${engineType} 不支持 custom 缓动，已回退 native 曲线。`);
      easing = "native";
    }

    cuts.push({
      cutIndex: index,
      afterSegmentId: previous.segmentId,
      incomingSegmentId: current.segmentId,
      intent,
      engineType,
      explicit: explicitType !== null,
      durationSeconds,
      maxDurationSeconds,
      easing,
      direction,
      source,
      reason,
    });
    totalTransitionSeconds += durationSeconds;
  }

  const transitionCount = cuts.length;
  const hardCuts = Math.max(0, segments.length - 1 - transitionCount);
  return {
    schemaVersion: TRANSITION_PLAN_SCHEMA,
    mode,
    pack,
    fps,
    cuts,
    hardCuts,
    transitionCount,
    totalTransitionSeconds: round(totalTransitionSeconds),
    expectedOutputDurationSeconds: round(Math.max(0, totalSeconds - totalTransitionSeconds)),
    advisories,
  };
}

/** 人类可读的计划摘要（给 CLI / 交付报告；不参与判定）。 */
export function describeTransitionPlan(plan: TransitionPlan): string[] {
  const lines = [
    `转场计划：模式 ${plan.mode} · 节奏档案 ${plan.pack} · 转场 ${plan.transitionCount} 刀 / 硬切 ${plan.hardCuts} 刀 · 预计成片 ${plan.expectedOutputDurationSeconds}s`,
  ];
  for (const cut of plan.cuts) {
    lines.push(
      `  - 第 ${cut.cutIndex} 刀 ${cut.afterSegmentId}→${cut.incomingSegmentId}：${cut.intent} → ${cut.engineType} ${cut.durationSeconds}s（${cut.easing}，${cut.source}）`,
    );
  }
  for (const advisory of plan.advisories) lines.push(`  ! ${advisory}`);
  return lines;
}

/**
 * 把计划转成引擎层 `transitions.perCut`（以**进入镜头** shotId 为键）。
 * 引擎会按变体配方的 intentMap 再解析一次具体类型，因此这里只传意图与已解析的默认值。
 */
export function planToPerCut(plan: TransitionPlan): Record<string, {
  intent: TransitionType;
  type: string | null;
  explicit: boolean;
  durationSeconds: number;
  easing: TransitionEasing;
  direction: string | null;
  source: TransitionPlanCut["source"];
  reason: string;
}> {
  const perCut: ReturnType<typeof planToPerCut> = {};
  for (const cut of plan.cuts) {
    perCut[cut.incomingSegmentId] = {
      intent: cut.intent,
      type: cut.engineType,
      explicit: cut.explicit,
      durationSeconds: cut.durationSeconds,
      easing: cut.easing,
      direction: cut.direction,
      source: cut.source,
      reason: cut.reason,
    };
  }
  return perCut;
}
