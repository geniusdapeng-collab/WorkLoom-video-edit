/**
 * edit/reframe.ts —— 二次构图（取景轨道）计划层（纯函数，T-2026-1011-0008）
 *
 * 定位：把"中景切近景 / 局部放大 / 横转竖不留黑边"从一句主观要求，变成**可复算的取景计划**。
 * 边界（与 timeline/transitions 同口径）：
 *   · 只做确定性的几何与预算判定（窗口/倍率/填充/缓冲），不做审美判断，不调用模型；
 *   · 一切都是纯函数：同一份时间轴 + 同一份素材规格 → 同一份计划（可断言、可回执）；
 *   · 引擎（post-bridge / planAssembly）只负责忠实渲染，不自行改口径。
 *
 * 三条第一性纪律：
 *   ① **源原生裁切（crop-first）**：先在源像素上取窗口，再缩放到画布——不允许"先降到画布再放大裁回来"；
 *   ② **无损放大预算**：`s_max = min(基窗宽/画布宽, 基窗高/画布高)`；超预算必须显式 allow-upscale 并如实记账；
 *   ③ **只做减法**：二次构图不引入素材外内容（与 docs/video-edit-creation-doctrine.md 一致）。
 */

import type { EditTimeline, EditTimelineSegment } from "./timeline.js";

/* ============================ 契约常量 ============================ */

export const REFRAME_MODES = ["static", "push", "pull", "follow", "locked-cut"] as const;
export type ReframeMode = (typeof REFRAME_MODES)[number];

export const REFRAME_INTENTS = ["shot-size", "emphasis", "aspect-fill", "breathing"] as const;
export type ReframeIntent = (typeof REFRAME_INTENTS)[number];

export const REFRAME_FILLS = ["pad", "cover", "blur", "brand"] as const;
export type ReframeFill = (typeof REFRAME_FILLS)[number];

export const REFRAME_EASINGS = ["linear", "smooth", "ease-in-out"] as const;
export type ReframeEasing = (typeof REFRAME_EASINGS)[number];

export const REFRAME_ANCHORS = ["manual", "center", "subject", "face", "saliency", "keyframe"] as const;
export type ReframeAnchor = (typeof REFRAME_ANCHORS)[number];

export const REFRAME_MAX_ZOOM_DEFAULT = 1.5;
export const REFRAME_MAX_ZOOM_CEILING = 3;

/** 景别档位（与 bundles/ai-video/library/cinematography-kb/CINE-002-景别系统.md 同词汇）。 */
export const SHOT_SIZES = ["ELS", "LS", "FS", "MS", "MCU", "CU", "ECU", "INSERT"] as const;
export type ShotSizeId = (typeof SHOT_SIZES)[number];

/**
 * 景别 → "主体（人脸优先，其次人/物）高度占画幅比例"的代理阶梯。
 * ⚠ 初值为业界经验区间（D 级），P1 用真实素材标定后固化进受签名资产；
 * 本模块只用它换算"要到某一档还需要几倍"，钳制后达不到就如实降级并写回执。
 */
export const SHOT_SIZE_LADDER: Record<ShotSizeId, { min: number; max: number; target: number }> = {
  ELS: { min: 0, max: 0.02, target: 0.015 },
  LS: { min: 0.02, max: 0.05, target: 0.035 },
  FS: { min: 0.04, max: 0.08, target: 0.06 },
  MS: { min: 0.08, max: 0.14, target: 0.11 },
  MCU: { min: 0.15, max: 0.24, target: 0.19 },
  CU: { min: 0.25, max: 0.42, target: 0.32 },
  ECU: { min: 0.5, max: 1, target: 0.6 },
  INSERT: { min: 0.2, max: 1, target: 0.4 },
};

/* ============================ 契约类型 ============================ */

export interface ReframeSpec {
  mode?: ReframeMode | null;
  intent?: ReframeIntent | null;
  shotSize?: { from?: ShotSizeId | null; to?: ShotSizeId | null } | null;
  scale?: { from?: number | null; to?: number | null } | null;
  center?: { from?: { x?: number | null; y?: number | null } | null; to?: { x?: number | null; y?: number | null } | null } | null;
  anchor?: ReframeAnchor | null;
  easing?: ReframeEasing | null;
  fill?: ReframeFill | null;
  maxZoomPolicy?: "lossless" | "allow-upscale" | null;
  safeArea?: "respect" | "ignore" | null;
  note?: string | null;
}

export interface ReframeBudget {
  /** 画布同比例、能放进源画面的最大基窗（像素） */
  baseWindow: { w: number; h: number } | null;
  /** 不放大像素的最大裁切倍率；null = 源规格未知（无法判定，按未知如实标注） */
  sMaxLossless: number | null;
  /** 画幅转换本身带来的上采样（= 画布宽 / 基窗宽；>1 表示源像素不够，与推近无关） */
  fillUpscale: number | null;
  /** 计划倍率 ÷ 无损预算（≤1 = 无损；>1 = 等效上采样倍率） */
  effectiveUpscale: number | null;
}

export interface ReframePlanEntry {
  segmentId: string;
  groupId: string | null;
  descriptor: ReframeDescriptor | null;
  budget: ReframeBudget;
  advisories: string[];
}

export interface ReframeDescriptor {
  mode: ReframeMode;
  intent: ReframeIntent;
  shotSize: { from: ShotSizeId; to: ShotSizeId } | null;
  scale: { from: number; to: number };
  center: { from: { x: number; y: number }; to: { x: number; y: number } };
  anchor: ReframeAnchor;
  easing: ReframeEasing;
  fill: ReframeFill;
  maxZoomPolicy: "lossless" | "allow-upscale";
  safeArea: "respect" | "ignore";
  note: string | null;
  /** true = 由 legacy `punchIn` 归一而来（跳切遮盖场景），回执里单列 */
  legacyPunchIn: boolean;
  budget: ReframeBudget;
}

export interface ReframePlan {
  schemaVersion: "workloom.video-edit/reframe-plan/v1";
  mode: "off" | "declared" | "auto";
  fill: ReframeFill;
  maxZoom: number | "budget";
  easing: ReframeEasing;
  segments: ReframePlanEntry[];
  plannedCount: number;
  advisories: string[];
}

export interface ReframePlanOptions {
  mode?: "off" | "declared" | "auto";
  fill?: ReframeFill;
  maxZoom?: number | "budget";
  easing?: ReframeEasing;
  /** segmentId → 源像素规格（由调用方探测；缺省时预算按未知处理） */
  sourceSizes?: Record<string, { width: number; height: number }>;
  /**
   * 全局默认推近（CLI `--reframe-scale from,to`）：只对**未声明 reframe** 的段落生效，
   * 用于"整片一键推近"的快速场景；声明过的段落永远以声明为准。
   */
  defaultScale?: { from: number; to: number } | null;
  /** 全局推近的中心点（默认 0.5, 0.45：口播/人物常用眼位线） */
  defaultCenter?: { x: number; y: number } | null;
}

/* ============================ 工具函数 ============================ */

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function ratioOf(center: { x?: number | null; y?: number | null } | null | undefined, axis: "x" | "y"): number {
  const value = center?.[axis];
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, 0, 1) : 0.5;
}

/**
 * 把 legacy `punchIn`（静态推近）与 v2 `reframe` 统一成一个描述子。
 * 优先级：显式 `reframe` > `punchIn`（legacy，语义=静态推近、中心/手动锚点）。
 */
export function normalizeReframeSegment(segment: Pick<EditTimelineSegment, "segmentId" | "reframe" | "punchIn">): ReframeDescriptor | null {
  const spec = segment.reframe ?? null;
  const punch = segment.punchIn ?? null;
  if (!spec && !punch) return null;
  const legacy = !spec && Boolean(punch);
  const scaleFrom = Number.isFinite(spec?.scale?.from as number) ? (spec!.scale!.from as number) : 1;
  const rawScaleTo = Number.isFinite(spec?.scale?.to as number) ? (spec!.scale!.to as number) : null;
  const punchScale = Number.isFinite(punch?.scale as number) ? (punch!.scale as number) : 1;
  const scaleTo = rawScaleTo ?? punchScale;
  const mode: ReframeMode = spec?.mode ?? (scaleTo > 1.0001 ? "static" : "static");
  /** legacy punchIn 的中心点是 `punchIn.x/y`；显式 reframe 优先。 */
  const legacyCenter = { x: punch?.x ?? null, y: punch?.y ?? null };
  const centerFromRaw = spec?.center?.from ?? legacyCenter;
  const centerToRaw = spec?.center?.to ?? spec?.center?.from ?? legacyCenter;
  return {
    mode,
    intent: spec?.intent ?? "shot-size",
    shotSize: spec?.shotSize?.from && spec?.shotSize?.to
      ? { from: spec.shotSize.from, to: spec.shotSize.to }
      : null,
    scale: { from: clamp(scaleFrom, 1, REFRAME_MAX_ZOOM_CEILING), to: clamp(scaleTo, 1, REFRAME_MAX_ZOOM_CEILING) },
    center: {
      from: { x: ratioOf(centerFromRaw, "x"), y: ratioOf(centerFromRaw, "y") },
      to: { x: ratioOf(centerToRaw, "x"), y: ratioOf(centerToRaw, "y") },
    },
    anchor: spec?.anchor ?? (legacy ? "manual" : "subject"),
    easing: spec?.easing ?? "smooth",
    fill: spec?.fill ?? "pad",
    maxZoomPolicy: spec?.maxZoomPolicy ?? "lossless",
    safeArea: spec?.safeArea ?? "respect",
    note: spec?.note ?? (legacy ? "legacy punchIn：跳切遮盖推近" : null),
    legacyPunchIn: legacy,
    // budget 由 planReframe 填（依赖源规格），这里给占位
    budget: { baseWindow: null, sMaxLossless: null, fillUpscale: null, effectiveUpscale: null },
  };
}

/** 单段 reframe 字段的事实类校验（由 timeline.validateEditTimeline 调用）。 */
export interface ReframeFieldCheck {
  id: string;
  pass: boolean;
  hard: boolean;
  detail: string;
  fix?: { segmentId: string; field: string; action: string; severity: "hard" | "advisory" };
}

export function validateReframeSegment(segment: EditTimelineSegment): ReframeFieldCheck[] {
  const checks: ReframeFieldCheck[] = [];
  const spec = segment.reframe ?? null;
  if (!spec) return checks;
  const fail = (id: string, detail: string, field: string, action: string): void => {
    checks.push({
      id, pass: false, hard: true, detail,
      fix: { segmentId: segment.segmentId, field, action, severity: "hard" },
    });
  };
  if (spec.mode !== undefined && spec.mode !== null && !REFRAME_MODES.includes(spec.mode)) {
    fail(`reframe.mode:${segment.segmentId}`, `片段 ${segment.segmentId} 取景模式 ${String(spec.mode)} 不在枚举内`, "reframe.mode", `改用 ${REFRAME_MODES.join("/")} 之一`);
  }
  if (spec.intent !== undefined && spec.intent !== null && !REFRAME_INTENTS.includes(spec.intent)) {
    fail(`reframe.intent:${segment.segmentId}`, `片段 ${segment.segmentId} 取景意图 ${String(spec.intent)} 不在枚举内`, "reframe.intent", `改用 ${REFRAME_INTENTS.join("/")} 之一`);
  }
  if (spec.anchor !== undefined && spec.anchor !== null && !REFRAME_ANCHORS.includes(spec.anchor)) {
    fail(`reframe.anchor:${segment.segmentId}`, `片段 ${segment.segmentId} 取景锚点 ${String(spec.anchor)} 不在枚举内`, "reframe.anchor", `改用 ${REFRAME_ANCHORS.join("/")} 之一`);
  }
  if (spec.easing !== undefined && spec.easing !== null && !REFRAME_EASINGS.includes(spec.easing)) {
    fail(`reframe.easing:${segment.segmentId}`, `片段 ${segment.segmentId} 取景缓动 ${String(spec.easing)} 不在枚举内`, "reframe.easing", `改用 ${REFRAME_EASINGS.join("/")} 之一`);
  }
  if (spec.fill !== undefined && spec.fill !== null && !REFRAME_FILLS.includes(spec.fill)) {
    fail(`reframe.fill:${segment.segmentId}`, `片段 ${segment.segmentId} 填充策略 ${String(spec.fill)} 不在枚举内`, "reframe.fill", `改用 ${REFRAME_FILLS.join("/")} 之一`);
  }
  for (const [key, value] of [["from", spec.scale?.from], ["to", spec.scale?.to]] as const) {
    if (value === null || value === undefined) continue;
    if (!Number.isFinite(value) || value < 1 || value > REFRAME_MAX_ZOOM_CEILING) {
      fail(`reframe.scale.${key}:${segment.segmentId}`, `片段 ${segment.segmentId} 取景倍率 ${key}=${String(value)} 越界（1.0–${REFRAME_MAX_ZOOM_CEILING}）`, `reframe.scale.${key}`, `收窄到 1.0–${REFRAME_MAX_ZOOM_CEILING}`);
    }
  }
  for (const which of ["from", "to"] as const) {
    for (const axis of ["x", "y"] as const) {
      const value = spec.center?.[which]?.[axis];
      if (value === null || value === undefined) continue;
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        fail(`reframe.center.${which}.${axis}:${segment.segmentId}`, `片段 ${segment.segmentId} 取景中心 ${which}.${axis}=${String(value)} 越界（0–1）`, `reframe.center.${which}.${axis}`, "改为 0–1 的比例（0.5 = 居中）");
      }
    }
  }
  const shotFrom = spec.shotSize?.from ?? null;
  const shotTo = spec.shotSize?.to ?? null;
  for (const [key, value] of [["from", shotFrom], ["to", shotTo]] as const) {
    if (value !== null && value !== undefined && !SHOT_SIZES.includes(value)) {
      fail(`reframe.shotSize.${key}:${segment.segmentId}`, `片段 ${segment.segmentId} 景别 ${key}=${String(value)} 不在枚举内`, `reframe.shotSize.${key}`, `改用 ${SHOT_SIZES.join("/")} 之一`);
    }
  }
  return checks;
}

/* ============================ 预算与景别换算 ============================ */

/** 画布同比例、能放进源画面的最大基准窗口（crop-first 的起点）。 */
export function computeBaseWindow(source: { width: number; height: number }, canvas: { width: number; height: number }): { w: number; h: number } {
  const aspect = canvas.width / canvas.height;
  const sourceAspect = source.width / source.height;
  if (sourceAspect >= aspect) {
    const h = source.height;
    const w = h * aspect;
    return { w, h };
  }
  const w = source.width;
  const h = w / aspect;
  return { w, h };
}

/**
 * 无损放大预算：`s_max = min(基窗宽/画布宽, 基窗高/画布高)`。
 * 例：4K 16:9 → 1080p 16:9 = 2.0×；4K 16:9 → 1080×1920 = 1.125×；1080p 9:16 → 1080×1920 = 1.0×。
 */
export function computeLosslessBudget(
  source: { width: number; height: number } | null,
  canvas: { width: number; height: number },
): ReframeBudget {
  if (!source || !(source.width > 0) || !(source.height > 0)) {
    return { baseWindow: null, sMaxLossless: null, fillUpscale: null, effectiveUpscale: null };
  }
  const base = computeBaseWindow(source, canvas);
  const sMax = Math.min(base.w / canvas.width, base.h / canvas.height);
  return {
    baseWindow: { w: round(base.w, 2), h: round(base.h, 2) },
    sMaxLossless: round(sMax, 4),
    fillUpscale: round(canvas.width / base.w, 4),
    effectiveUpscale: null,
  };
}

/**
 * 取景倍率上限：**无损策略允许的 s 上限** = max(1, sMaxLossless)。
 * 为什么是 max(1, …)：`sMaxLossless < 1` 表示"源像素连画幅转换都不够"（横转竖小源常见），
 * 这是填充本身带来的上采样、与推近无关——此时只禁止"额外推近"（s > 1），
 * 并把 fillUpscale 如实记账（见 reframe-receipt 的 budget）。
 */
export function losslessScaleCap(budget: ReframeBudget): number {
  if (budget.sMaxLossless === null) return REFRAME_MAX_ZOOM_CEILING;
  return Math.max(1, budget.sMaxLossless);
}

/**
 * 景别换算：给定当前主体高度占比与目标景别，返回"还需要几倍"。
 * 无当前占比（还没跑分析）时返回 null——不猜。
 */
export function requiredScaleForShotSize(currentSubjectRatio: number | null | undefined, to: ShotSizeId): number | null {
  if (currentSubjectRatio === null || currentSubjectRatio === undefined || !(currentSubjectRatio > 0)) return null;
  const target = SHOT_SIZE_LADDER[to]?.target;
  if (!target) return null;
  return round(target / currentSubjectRatio, 4);
}

/* ============================ 计划 ============================ */

export interface PlanReframeInput {
  timeline: EditTimeline;
  options?: ReframePlanOptions;
}

/**
 * 生成取景计划（纯函数）：
 *   · mode=off：不产出任何取景（保持现有行为；legacy punchIn 也不在此路径渲染）；
 *   · mode=declared：只渲染时间轴显式声明的 `reframe` / `punchIn`；
 *   · mode=auto：声明优先；未声明但有源规格时，给"轻微呼吸感微推"（1.00→1.03，intent=breathing）——
 *     该模式需要分析层给出主体信息才会做真正的跟随（P1），P0 的 auto 仅做确定性微推。
 * 所有降级/超预算都在 advisories 里如实写明。
 */
export function planReframe(input: PlanReframeInput): ReframePlan {
  const options = input.options ?? {};
  const mode = options.mode ?? "off";
  const fill = options.fill ?? "pad";
  const maxZoom = options.maxZoom ?? REFRAME_MAX_ZOOM_DEFAULT;
  const easing = options.easing ?? "smooth";
  const canvasSpec = input.timeline.target ?? { aspectRatio: "9:16", fps: 30 };
  const canvas = resolutionOfAspect(String(canvasSpec.aspectRatio ?? "9:16"));
  const advisories: string[] = [];
  const segments: ReframePlanEntry[] = [];
  for (const segment of input.timeline.segments ?? []) {
    const declared = normalizeReframeSegment(segment);
    let descriptor: ReframeDescriptor | null = declared;
    if (mode === "off") descriptor = null;
    if ((mode === "declared" || mode === "auto") && !descriptor && options.defaultScale) {
      const scaleFrom = Math.max(1, Number(options.defaultScale.from) || 1);
      const scaleTo = Math.max(scaleFrom, Number(options.defaultScale.to) || scaleFrom);
      descriptor = {
        mode: scaleTo > scaleFrom + 1e-6 ? "push" : "static",
        intent: "shot-size",
        shotSize: null,
        scale: { from: clamp(scaleFrom, 1, REFRAME_MAX_ZOOM_CEILING), to: clamp(scaleTo, 1, REFRAME_MAX_ZOOM_CEILING) },
        center: {
          from: { x: clamp(options.defaultCenter?.x ?? 0.5, 0, 1), y: clamp(options.defaultCenter?.y ?? 0.45, 0, 1) },
          to: { x: clamp(options.defaultCenter?.x ?? 0.5, 0, 1), y: clamp(options.defaultCenter?.y ?? 0.45, 0, 1) },
        },
        anchor: "center",
        easing: "smooth",
        fill,
        maxZoomPolicy: "lossless",
        safeArea: "respect",
        note: `CLI 全局推近 ${scaleFrom}–${scaleTo}×`,
        legacyPunchIn: false,
        budget: { baseWindow: null, sMaxLossless: null, fillUpscale: null, effectiveUpscale: null },
      };
    }
    if (mode === "auto" && !descriptor) {
      descriptor = {
        mode: "push",
        intent: "breathing",
        shotSize: null,
        scale: { from: 1, to: 1.03 },
        center: { from: { x: 0.5, y: 0.5 }, to: { x: 0.5, y: 0.5 } },
        anchor: "center",
        easing: "smooth",
        fill,
        maxZoomPolicy: "lossless",
        safeArea: "respect",
        note: "auto：静止段呼吸感微推（P0 确定性策略；主体跟随需 P1 分析站）",
        legacyPunchIn: false,
        budget: { baseWindow: null, sMaxLossless: null, fillUpscale: null, effectiveUpscale: null },
      };
    }
    const entryAdvisories: string[] = [];
    let budget: ReframeBudget = { baseWindow: null, sMaxLossless: null, fillUpscale: null, effectiveUpscale: null };
    if (descriptor) {
      const source = options.sourceSizes?.[segment.segmentId] ?? null;
      budget = computeLosslessBudget(source, canvas);
      const requested = Math.max(descriptor.scale.from, descriptor.scale.to);
      const policyCap = descriptor.maxZoomPolicy === "allow-upscale" ? REFRAME_MAX_ZOOM_CEILING : (maxZoom === "budget" ? Number.POSITIVE_INFINITY : Math.max(1, maxZoom as number));
      /** 无损预算只限制"额外推近"：s 上限 = max(1, sMaxLossless)；allow-upscale 走硬上限。 */
      const budgetCap = losslessScaleCap(budget);
      const cap = descriptor.maxZoomPolicy === "allow-upscale"
        ? REFRAME_MAX_ZOOM_CEILING
        : Math.min(policyCap, budgetCap, REFRAME_MAX_ZOOM_CEILING);
      if (requested > cap + 1e-6) {
        const capped = Math.max(1, cap);
        const cappedTo = Math.min(descriptor.scale.to, capped);
        const cappedFrom = Math.min(descriptor.scale.from, cappedTo);
        entryAdvisories.push(
          `片段 ${segment.segmentId} 请求倍率 ${round(requested)}× 超出预算 ${round(capped)}×（${budget.sMaxLossless === null ? "源规格未知，按上限钳制" : `无损预算 ${budget.sMaxLossless}×`}）：已降级到 ${round(cappedFrom)}–${round(cappedTo)}×；需要更大倍率请声明 maxZoomPolicy=allow-upscale 或先做 AI 增强`,
        );
        descriptor = { ...descriptor, scale: { from: round(cappedFrom), to: round(cappedTo) } };
      }
      const maxRequested = Math.max(descriptor.scale.from, descriptor.scale.to);
      budget = {
        ...budget,
        effectiveUpscale: budget.sMaxLossless === null
          ? null
          : round((budget.fillUpscale ?? 1) * maxRequested, 4),
      };
      descriptor = { ...descriptor, budget };
      if (budget.fillUpscale !== null && budget.fillUpscale > 1.001) {
        entryAdvisories.push(
          `片段 ${segment.segmentId} 画幅转换本身需要 ${budget.fillUpscale}× 上采样（源 ${source?.width}×${source?.height} 不足以填满画布 ${canvas.width}×${canvas.height}）——这不是推近造成的；建议提高素材分辨率或改用 blur/brand 填充`,
        );
      }
      if (budget.effectiveUpscale !== null && budget.effectiveUpscale > 1.001) {
        entryAdvisories.push(
          `片段 ${segment.segmentId} 等效上采样 ${budget.effectiveUpscale}×（源 ${source?.width}×${source?.height} → 画布 ${canvas.width}×${canvas.height}）：画质以下降换景别，回执已如实记账`,
        );
      }
      if (descriptor.shotSize && descriptor.anchor === "face" && !entryAdvisories.length) {
        entryAdvisories.push(`片段 ${segment.segmentId} 景别 ${descriptor.shotSize.from}→${descriptor.shotSize.to}：锚点 face 需要 P1 分析站提供人脸框，未提供时按 center 渲染`);
      }
    }
    segments.push({ segmentId: segment.segmentId, groupId: segment.groupId ?? null, descriptor, budget, advisories: entryAdvisories });
    advisories.push(...entryAdvisories);
  }
  return {
    schemaVersion: "workloom.video-edit/reframe-plan/v1",
    mode,
    fill,
    maxZoom,
    easing,
    segments,
    plannedCount: segments.filter((entry) => entry.descriptor !== null).length,
    advisories,
  };
}

/** `9:16` → 1080×1920（与 timeline.resolutionForAspect 同口径的局部实现，避免循环依赖）。 */
export function resolutionOfAspect(aspectRatio: string, shortSide = 1080): { width: number; height: number } {
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

/* ============================ 渲染链（计划 → FFmpeg 滤镜） ============================ */

export interface ReframeRenderInput {
  descriptor: ReframeDescriptor;
  source: { width: number; height: number } | null;
  canvas: { width: number; height: number };
  durationSeconds: number;
  fps: number;
  /** true = 只输出滤镜（不含 setsar/fps），由调用方决定是否补 */
  includeTail?: boolean;
}

const EVEN = (expr: string): string => `floor((${expr})/2)*2`;

function easingExpr(easing: ReframeEasing, t: string): string {
  if (easing === "smooth") return `(${t})*(${t})*(3-2*(${t}))`;
  if (easing === "ease-in-out") return `if(lt(${t},0.5),2*(${t})*(${t}),1-2*(1-(${t}))*(1-(${t})))`;
  return t;
}

/**
 * 生成取景滤镜链（crop-first）。返回的字符串数组可直接 join(",")。
 * - 静态（scale.from === scale.to 且 centers 相同）：`crop=…,scale=…`
 * - 动态（push/pull/follow）：`crop(基窗),scale(eval=frame),crop(画布)`
 * - fill=pad：保留"整幅入画 + 黑边"的语义（zoom 作用于整幅），仅供兼容
 * - fill=cover：裁切填满（默认用于横转竖）
 * - fill=blur：模糊背景 + 前景 fit 叠加（横转竖的"高级感"填充）
 * - 源规格未知时用相对表达式（iw/ih），不猜像素。
 */
export function buildReframeFilters(input: ReframeRenderInput): { filters: string[]; mode: "static" | "animated"; window: string } {
  const { descriptor, source, canvas, durationSeconds, fps } = input;
  const includeTail = input.includeTail !== false;
  const A = canvas.width / canvas.height;
  const sFrom = descriptor.scale.from;
  const sTo = descriptor.scale.to;
  const cxFrom = descriptor.center.from.x;
  const cyFrom = descriptor.center.from.y;
  const cxTo = descriptor.center.to.x;
  const cyTo = descriptor.center.to.y;
  const animated = Math.abs(sTo - sFrom) > 1e-6 || Math.abs(cxTo - cxFrom) > 1e-6 || Math.abs(cyTo - cyFrom) > 1e-6;
  const tail = includeTail ? ["setsar=1", `fps=${fps}`] : [];
  const filters: string[] = [];
  const duration = Math.max(0.1, durationSeconds);

  if (descriptor.fill === "pad") {
    // 兼容语义：整幅入画 + 黑边；推近作用于整幅（legacy punchIn 的旧观感，但改为 crop-first 排序）
    if (!animated && Math.abs(sTo - 1) < 1e-6) {
      filters.push(`scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease`);
      filters.push(`pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2`);
      filters.push(...tail);
      return { filters, mode: "static", window: "fit" };
    }
    /**
     * zoompan 的逐帧变量用 `on`（输出帧号）而不是 `time`：
     * `time`/`frame` 变量是 FFmpeg 6.0 才加的，而 CNB test-gate 的 Debian 12 装的是 ffmpeg 5.1——
     * 用 `time` 会在 5.x 上直接失败（T-2026-1011-0008 CI 实测根因）。`on` 自 4.x 起就有。
     */
    const totalFrames = Math.max(1, Math.round(duration * fps));
    const sExpr = animated ? `(${sFrom}+(${sTo}-${sFrom})*${easingExpr(descriptor.easing, `clip(on/${totalFrames},0,1)`)}` : `${sTo}`;
    // 先整幅 fit + pad 出画布，再用 zoompan 做恒定输出尺寸的推近（zoompan 是 ffmpeg 里
    // 唯一能在 `-vf` 链中逐帧改缩放而不触发重初始化失败的成熟滤镜，见 full-chain-film.mts 的既有写法）。
    filters.push(`scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease`);
    filters.push(`pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2`);
    filters.push(`zoompan=z='${sExpr}':x='(iw-iw/zoom)*0.5':y='(ih-ih/zoom)*0.5':d=1:s=${canvas.width}x${canvas.height}:fps=${fps}`);
    filters.push(...tail);
    return { filters, mode: animated ? "animated" : "static", window: "fit-zoom" };
  }

  // cover / blur / brand：先在源上取画布同比例的基窗（crop-first）
  const baseWExpr = source ? String(source.width) : "(iw)";
  const baseHExpr = source ? String(source.height) : "(ih)";
  const cropBw = source
    ? (source.width / source.height >= A ? `floor(${baseHExpr}*${round(A, 6)}/2)*2` : `floor(${baseWExpr}/2)*2`)
    : `floor(min(iw,ih*${round(A, 6)})/2)*2`;
  const cropBh = source
    ? (source.width / source.height >= A ? `floor(${baseHExpr}/2)*2` : `floor(${baseWExpr}/${round(A, 6)}/2)*2`)
    : `floor(min(ih,iw/${round(A, 6)})/2)*2`;
  const bx = `(iw-ow)*${round(cxFrom, 4)}`;
  const by = `(ih-oh)*${round(cyFrom, 4)}`;
  const windowArg = `w=${cropBw}:h=${cropBh}:x='${bx}':y='${by}'`;

  if (descriptor.fill === "blur" || descriptor.fill === "brand") {
    /**
     * 背景：整幅 cover + 模糊（brand = 更重的模糊 + 压暗降饱和，等价"品牌底"观感，不引入外部源）；
     * 前景：基窗（crop-first）fit 居中叠加。
     * 说明：这是一张带标签的多路图，必须以 `;` 连接——因此整段作为**单个字符串**返回，
     * 由调用方与其余滤镜用 `,` 串接时保持语法正确。
     */
    const background = descriptor.fill === "blur"
      ? `[bgsrc]scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase,crop=${canvas.width}:${canvas.height},gblur=sigma=20[bg]`
      : `[bgsrc]scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase,crop=${canvas.width}:${canvas.height},gblur=sigma=40,eq=brightness=-0.15:saturation=0.4[bg]`;
    const foreground = `[fgsrc]crop=${windowArg},scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease[fg]`;
    const tailStr = tail.length ? `,${tail.join(",")}` : "";
    filters.push(`split=2[bgsrc][fgsrc];${background};${foreground};[bg][fg]overlay=(W-w)/2:(H-h)/2${tailStr}`);
    return { filters, mode: "static", window: "base+foreground" };
  }

  // fill=cover：静态 → 单次 crop+scale；动态 → 基窗 crop + 动画 scale + 画布 crop
  if (!animated) {
    const sw = source ? `floor(${cropBw}/${round(sTo, 4)}/2)*2` : `floor((${cropBw})/${round(sTo, 4)}/2)*2`;
    const sh = source ? `floor(${cropBh}/${round(sTo, 4)}/2)*2` : `floor((${cropBh})/${round(sTo, 4)}/2)*2`;
    filters.push(`crop=w='${sw}':h='${sh}':x='(iw-ow)*${round(cxFrom, 4)}':y='(ih-oh)*${round(cyFrom, 4)}'`);
    filters.push(`scale=${canvas.width}:${canvas.height}:flags=lanczos`);
    filters.push(...tail);
    return { filters, mode: "static", window: "cover" };
  }
  const totalFrames = Math.max(1, Math.round(duration * fps));
  const tNorm = `clip(on/${totalFrames},0,1)`;
  const e = easingExpr(descriptor.easing, tNorm);
  const sExpr = `(${round(sFrom, 4)}+(${round(sTo, 4)}-${round(sFrom, 4)})*${e})`;
  const cxExpr = `(${round(cxFrom, 4)}+(${round(cxTo, 4)}-${round(cxFrom, 4)})*${e})`;
  const cyExpr = `(${round(cyFrom, 4)}+(${round(cyTo, 4)}-${round(cyFrom, 4)})*${e})`;
  filters.push(`crop=${windowArg}`);
  /**
   * 动态 cover：基窗（crop-first）→ zoompan（逐帧 z/x/y，输出恒定画布尺寸）。
   * 用 zoompan 而不是 `scale=eval=frame`：后者在 `-vf` 链中逐帧改尺寸会触发
   * "Error reinitializing filters"，必须避免（本任务真机冒烟实测）。
   */
  filters.push(`zoompan=z='${sExpr}':x='(iw-iw/zoom)*${cxExpr}':y='(ih-ih/zoom)*${cyExpr}':d=1:s=${canvas.width}x${canvas.height}:fps=${fps}`);
  filters.push(...tail);
  return { filters, mode: "animated", window: "cover+zoom" };
}

/** 计划 → 人类可读摘要（给 CLI/交付报告，不参与判定）。 */
export function describeReframePlan(plan: ReframePlan): string[] {
  const lines = [`取景计划：模式 ${plan.mode} · 填充 ${plan.fill} · 命中片段 ${plan.plannedCount}/${plan.segments.length}`];
  for (const entry of plan.segments) {
    if (!entry.descriptor) continue;
    const d = entry.descriptor;
    const shot = d.shotSize ? `${d.shotSize.from}→${d.shotSize.to}` : d.intent;
    const up = entry.budget.effectiveUpscale;
    lines.push(
      `  - ${entry.segmentId}：${d.mode} ${shot} ${round(d.scale.from)}–${round(d.scale.to)}× 锚点 ${d.anchor}`
      + `${up === null ? "" : `（等效上采样 ${up}×）`}${d.legacyPunchIn ? " [legacy punchIn]" : ""}`,
    );
  }
  for (const advisory of plan.advisories) lines.push(`  ! ${advisory}`);
  return lines;
}

/** 描述子稳定哈希（供缓存键与回执绑定；不依赖具体 JSON 键顺序）。 */
export function reframeDescriptorKey(descriptor: ReframeDescriptor | null): string {
  if (!descriptor) return "none";
  const stable = JSON.stringify({
    mode: descriptor.mode,
    intent: descriptor.intent,
    shotSize: descriptor.shotSize,
    scale: descriptor.scale,
    center: descriptor.center,
    anchor: descriptor.anchor,
    easing: descriptor.easing,
    fill: descriptor.fill,
    maxZoomPolicy: descriptor.maxZoomPolicy,
    safeArea: descriptor.safeArea,
  });
  let hash = 2166136261;
  for (let index = 0; index < stable.length; index += 1) {
    hash ^= stable.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `rf-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
