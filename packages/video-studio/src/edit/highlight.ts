/**
 * edit/highlight.ts —— 高光打分与关键帧选择（可解释、可复算）
 *
 * 设计口径（与 skills/highlight-mining 一致）：
 *   · 正向信号加权求和，缺陷惩罚**单列扣除**（不平均进正向分里被稀释）；
 *   · 权重按内容 profile 给默认值，允许按项目覆盖，但覆盖必须落回执；
 *   · 关键帧分三类（情绪峰值/动作峰值/构图最优），各自有独立门槛；
 *   · 打分函数是纯函数：同一份输入必须得到同一个分数（可复算 = 可审计）。
 *
 * 纪律：本模块不做审美判断，只做"信号 → 分数"的确定性换算；"好不好"由人审与评审链决定。
 */

export interface HighlightSignals {
  /** 语音强调（相对说话人基线的重音程度） */
  speechEmphasis?: number | null;
  /** 音频能量峰值 */
  audioEnergy?: number | null;
  /** 运动强度 */
  motion?: number | null;
  /** 人脸与表情强度 */
  faceExpression?: number | null;
  /** 视觉显著性（对比/饱和/主体占比） */
  visualSalience?: number | null;
  /** 语义价值（唯一需要模型的信号） */
  semanticValue?: number | null;
  /** 稀缺性（同片内逆频率） */
  novelty?: number | null;
}

export interface HighlightPenalties {
  shake?: number | null;
  blur?: number | null;
  occlusion?: number | null;
  repetition?: number | null;
}

export type WeightProfile = "knowledge" | "travel" | "review" | "drama" | "talking";

export type HighlightWeights = Record<keyof HighlightSignals, number>;

const WEIGHT_PROFILES: Record<WeightProfile, HighlightWeights> = {
  knowledge: { speechEmphasis: 0.3, audioEnergy: 0.05, motion: 0.05, faceExpression: 0.05, visualSalience: 0.15, semanticValue: 0.3, novelty: 0.1 },
  travel: { speechEmphasis: 0.1, audioEnergy: 0.15, motion: 0.15, faceExpression: 0.1, visualSalience: 0.25, semanticValue: 0.1, novelty: 0.15 },
  review: { speechEmphasis: 0.25, audioEnergy: 0.1, motion: 0.1, faceExpression: 0.15, visualSalience: 0.15, semanticValue: 0.2, novelty: 0.05 },
  drama: { speechEmphasis: 0.2, audioEnergy: 0.15, motion: 0.15, faceExpression: 0.3, visualSalience: 0.1, semanticValue: 0.05, novelty: 0.05 },
  talking: { speechEmphasis: 0.35, audioEnergy: 0.05, motion: 0.05, faceExpression: 0.25, visualSalience: 0.05, semanticValue: 0.2, novelty: 0.05 },
};

const PENALTY_WEIGHTS = { shake: 0.5, blur: 0.6, occlusion: 0.4, repetition: 0.7 } as const;

export function weightsFor(profile: WeightProfile): HighlightWeights {
  const weights = WEIGHT_PROFILES[profile];
  if (!weights) throw new Error(`未知高光权重档案：${String(profile)}`);
  return { ...weights };
}

function unit(value: number | null | undefined, label: string): number {
  if (value === null || value === undefined) return 0;
  if (!Number.isFinite(value)) throw new Error(`${label} 必须是有限数字，收到：${String(value)}`);
  if (value < 0 || value > 1) throw new Error(`${label} 必须落在 0–1，收到：${String(value)}`);
  return value;
}

/** 把一个原始测量值线性归一化到 0–1（超出区间截断；区间非法即抛错） */
export function normalizeToUnit(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    throw new Error(`归一化参数非法：value=${String(value)} min=${String(min)} max=${String(max)}`);
  }
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

export interface HighlightScore {
  score: number;
  base: number;
  penalty: number;
  weights: HighlightWeights;
  contributions: Record<keyof HighlightSignals, number>;
}

/**
 * 高光打分：`score = clamp(Σ wᵢ·sᵢ − Σ pⱼ·penaltyⱼ, 0, 1)`
 * 误差处理：信号缺省视为 0（无证据不加分），越界或非数字直接抛错（不静默钳制）。
 */
export function scoreHighlight(
  signals: HighlightSignals,
  penalties: HighlightPenalties = {},
  options: { profile?: WeightProfile; weights?: Partial<HighlightWeights> } = {},
): HighlightScore {
  const baseWeights = options.profile ? weightsFor(options.profile) : weightsFor("knowledge");
  const weights: HighlightWeights = { ...baseWeights, ...(options.weights ?? {}) };
  const contributions = {} as Record<keyof HighlightSignals, number>;
  let base = 0;
  for (const key of Object.keys(weights) as Array<keyof HighlightSignals>) {
    const weight = weights[key];
    if (!Number.isFinite(weight) || weight < 0) throw new Error(`权重 ${key} 非法：${String(weight)}`);
    const contribution = weight * unit(signals[key], `signals.${key}`);
    contributions[key] = Number(contribution.toFixed(6));
    base += contribution;
  }
  let penalty = 0;
  for (const key of Object.keys(PENALTY_WEIGHTS) as Array<keyof typeof PENALTY_WEIGHTS>) {
    penalty += PENALTY_WEIGHTS[key] * unit(penalties[key], `penalties.${key}`);
  }
  const score = Math.min(1, Math.max(0, base - penalty));
  return {
    score: Number(score.toFixed(4)),
    base: Number(base.toFixed(4)),
    penalty: Number(penalty.toFixed(4)),
    weights,
    contributions,
  };
}

export interface HighlightCandidate {
  highlightId: string;
  shotId: string;
  /** 峰值时刻（秒） */
  peakSeconds: number;
  score: number;
  kind?: string;
}

/**
 * 去重：同一镜头、峰值间隔小于 `minGapSeconds` 的候选视为同一事件，保留分高者。
 * 返回被合并的候选 id 列表（供回执说明"为什么少了候选"）。
 */
export function dedupeHighlights<T extends HighlightCandidate>(
  candidates: T[],
  options: { minGapSeconds?: number } = {},
): { kept: T[]; merged: Array<{ keptId: string; mergedId: string; gapSeconds: number }> } {
  const minGapSeconds = options.minGapSeconds ?? 1.5;
  if (!Number.isFinite(minGapSeconds) || minGapSeconds < 0) throw new Error("minGapSeconds 必须是非负数");
  const sorted = [...candidates].sort((a, b) => b.score - a.score || a.peakSeconds - b.peakSeconds);
  const kept: T[] = [];
  const merged: Array<{ keptId: string; mergedId: string; gapSeconds: number }> = [];
  for (const candidate of sorted) {
    const clash = kept.find((k) => k.shotId === candidate.shotId && Math.abs(k.peakSeconds - candidate.peakSeconds) < minGapSeconds);
    if (clash) {
      merged.push({ keptId: clash.highlightId, mergedId: candidate.highlightId, gapSeconds: Number(Math.abs(clash.peakSeconds - candidate.peakSeconds).toFixed(3)) });
      continue;
    }
    kept.push(candidate);
  }
  return { kept: kept.sort((a, b) => a.peakSeconds - b.peakSeconds), merged };
}

export type KeyframeKind = "emotion_peak" | "action_peak" | "composition_best";

export interface KeyframeObservation {
  keyframeId: string;
  shotId: string;
  seconds: number;
  kind: KeyframeKind;
  score: number;
  sharpness?: number | null;
  stability?: number | null;
  exposure?: number | null;
  faceVisible?: boolean | null;
  textSafe?: boolean | null;
  reasons?: string[];
}

export interface KeyframeThresholds {
  compositionMinSharpness: number;
  compositionMinStability: number;
  emotionMinSharpness: number;
  actionMinStability: number;
  /** 是否允许在无合格候选时降级使用次优帧（默认 false：宁可报缺口，不糊弄封面） */
  allowFallback: boolean;
}

export const DEFAULT_KEYFRAME_THRESHOLDS: KeyframeThresholds = {
  compositionMinSharpness: 0.7,
  compositionMinStability: 0.8,
  emotionMinSharpness: 0.6,
  actionMinStability: 0.5,
  allowFallback: false,
};

export interface KeyframeSelection {
  picked: KeyframeObservation[];
  rejected: Array<{ keyframeId: string; reason: string }>;
  /** 按用途汇总的缺口（例如"没有合格封面帧"），供人审与补料决策 */
  gaps: string[];
}

/**
 * 关键帧筛选：按三类门槛过滤 + 每类只保留最高分（同类多留会让人审无从选择）。
 * 门槛判定只用可测指标（清晰度/稳定度/安全区），不引入审美评价。
 */
export function selectKeyframes(
  observations: KeyframeObservation[],
  thresholds: Partial<KeyframeThresholds> = {},
): KeyframeSelection {
  const limits: KeyframeThresholds = { ...DEFAULT_KEYFRAME_THRESHOLDS, ...thresholds };
  const picked: KeyframeObservation[] = [];
  const rejected: Array<{ keyframeId: string; reason: string }> = [];
  const gaps: string[] = [];
  for (const kind of ["emotion_peak", "action_peak", "composition_best"] as const) {
    const pool = observations.filter((o) => o.kind === kind);
    if (pool.length === 0) {
      gaps.push(`缺少 ${kind} 候选（未标注或未抽帧）`);
      continue;
    }
    const qualified = pool.filter((o) => {
      if (kind === "composition_best") {
        const sharpOk = (o.sharpness ?? 0) >= limits.compositionMinSharpness;
        const stableOk = (o.stability ?? 0) >= limits.compositionMinStability;
        const safeOk = o.textSafe !== false;
        if (!sharpOk || !stableOk || !safeOk) {
          rejected.push({
            keyframeId: o.keyframeId,
            reason: `构图门槛未达标（sharpness=${String(o.sharpness)} stability=${String(o.stability)} textSafe=${String(o.textSafe)}）`,
          });
          return false;
        }
        return true;
      }
      if (kind === "emotion_peak") {
        const sharpOk = (o.sharpness ?? 0) >= limits.emotionMinSharpness;
        const faceOk = o.faceVisible !== false;
        if (!sharpOk || !faceOk) {
          rejected.push({ keyframeId: o.keyframeId, reason: `情绪帧门槛未达标（sharpness=${String(o.sharpness)} faceVisible=${String(o.faceVisible)}）` });
          return false;
        }
        return true;
      }
      const stableOk = (o.stability ?? 0) >= limits.actionMinStability;
      if (!stableOk) {
        rejected.push({ keyframeId: o.keyframeId, reason: `动作帧不稳定（stability=${String(o.stability)}）` });
        return false;
      }
      return true;
    });
    if (qualified.length === 0) {
      gaps.push(`没有合格 ${kind}（全部未过门槛）`);
      if (limits.allowFallback && pool.length > 0) {
        picked.push({ ...pool.reduce((best, item) => (item.score > best.score ? item : best)), reasons: [...(pool[0]!.reasons ?? []), "降级使用（显式开启 allowFallback）"] });
      }
      continue;
    }
    picked.push(qualified.reduce((best, item) => (item.score > best.score ? item : best)));
  }
  return { picked: picked.sort((a, b) => b.score - a.score), rejected, gaps };
}
