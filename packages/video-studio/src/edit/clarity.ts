/**
 * edit/clarity.ts —— 镜头级"去雾 / 清晰度"计划（纯函数）。
 *
 * 背景（2026-10-18 产品所有者）：实拍素材常因逆光/雾/镜头眩光出现"发灰、朦胧、发光"，
 * 现有后期以调色为主，清晰度只有固定 3×3/0.25 的保守锐化。需要在**镜头级**补：
 * 糊得厉害的镜头加强，本来就清晰的镜头轻处理。
 *
 * 事实依据（2026-10-18 本机实测 + FFmpeg 官方滤镜文档）：
 *   · FFmpeg **没有原生 dehaze 滤镜**；可用 `eq`（对比度/亮度/伽马/饱和）、`curves`（色调曲线）、
 *     `unsharp`（luma 3–23 半径，amount -1.5..1.5）与 `cas`（Contrast Adaptive Sharpen，strength）。
 *   · 2026-10-18 第二轮 A/B：只做锐化的首版在黑位抬高的雾镜上肉眼变化太弱；三档改为
 *     先用 `curves` 压回被空气光抬起的灰雾，再用大半径局部对比与 CAS 恢复层次。真实雾镜
 *     p5 88→71、detail 52→137；逆光高黑位镜头 p5 129→123、detail 41→70。
 *
 * 判定只用确定性统计量（不做审美评分）：
 *   · p5 黑位越高 → 雾感越重（空气光抬高黑位）；
 *   · 亮度标准差越低 → 全局对比越弱；
 *   · 拉普拉斯方差（细节能量）越低 → 越"糊"。
 */

export type ClarityLevel = "off" | "light" | "medium" | "strong";

/** 历史 `conservative` 别名保持原 3×3/0.25 语义；新三档才是去雾链。 */
export const LEGACY_CONSERVATIVE_CLARITY = "unsharp=luma_msize_x=3:luma_msize_y=3:luma_amount=0.25:chroma_amount=0";

/**
 * 滤镜链（顺序：先轻压抬起的黑位，再做小半径局部对比，最后少量自适应锐化）。
 * 2026-10-18 产品反馈修订：前一版 strong 的 13×13/0.85 + CAS 0.50 会把正常纹理推成硬边，
 * 同一帧细节能量约为 4K 参考帧的 2 倍。现在以“恢复通透”而不是“做强锐化”为目标：
 * 半径和幅度都收一档，正常清晰镜头不再进入 strong。
 */
export const CLARITY_CHAINS: Record<Exclude<ClarityLevel, "off">, string> = {
  light: "curves=all='0/0 0.20/0.18 0.50/0.50 0.80/0.81 1/1',unsharp=3:3:0.18",
  medium: "curves=all='0/0 0.18/0.13 0.40/0.36 0.70/0.72 0.92/0.94 1/1',unsharp=5:5:0.30:5:5:0.03,cas=strength=0.15",
  strong: "curves=all='0/0 0.15/0.09 0.35/0.30 0.65/0.67 0.90/0.92 1/1',unsharp=7:7:0.45:5:5:0.04,cas=strength=0.25",
};

export interface ClarityMetrics {
  /** 5% 分位亮度（0–255）：越高越像有雾/空气光 */
  lumaP5: number;
  /** 亮度标准差（0–~80）：越低越平 */
  lumaStd: number;
  /** 拉普拉斯方差（细节能量）：越低越糊 */
  detailEnergy: number;
}

export interface ClarityDecision {
  level: ClarityLevel;
  chain: string | null;
  /** 0–1：雾感/低对比的合成分，仅用于解释与回执 */
  hazeScore: number;
  reason: string;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * 镜头级档位判定（2026-10-18 第二轮收敛：黑位和细节必须共同支持“发灰/发糊”）：
 *   strong：雾感合成分 ≥0.65 或 细节 <35
 *   medium：雾感合成分 ≥0.48 或 细节 <60
 *   light ：雾感合成分 ≥0.28 或 细节 <85
 *   off   ：高黑位但细节充足、或低黑位且细节正常，均不再强锐化
 */
export function planClarity(metrics: ClarityMetrics): ClarityDecision {
  const { lumaP5, lumaStd, detailEnergy } = metrics;
  if (![lumaP5, lumaStd, detailEnergy].every((value) => Number.isFinite(value))) {
    throw new Error("planClarity 需要有限的 lumaP5 / lumaStd / detailEnergy");
  }
  const hazeScore = clamp01(
    0.6 * clamp01((lumaP5 - 30) / 70) + 0.25 * clamp01((45 - lumaStd) / 45) + 0.15 * clamp01((140 - detailEnergy) / 140),
  );
  if (hazeScore >= 0.65 || detailEnergy < 35) {
    return { level: "strong", chain: CLARITY_CHAINS.strong, hazeScore, reason: `黑位 ${lumaP5} / 细节 ${detailEnergy.toFixed(1)}：明显雾感或糊，强档` };
  }
  if (hazeScore >= 0.48 || detailEnergy < 60) {
    return { level: "medium", chain: CLARITY_CHAINS.medium, hazeScore, reason: `黑位 ${lumaP5} / 细节 ${detailEnergy.toFixed(1)}：中等雾感，中档` };
  }
  if (hazeScore >= 0.28 || detailEnergy < 85) {
    return { level: "light", chain: CLARITY_CHAINS.light, hazeScore, reason: `黑位 ${lumaP5} / 细节 ${detailEnergy.toFixed(1)}：轻微发灰，轻档` };
  }
  return { level: "off", chain: null, hazeScore, reason: `黑位 ${lumaP5} / 细节 ${detailEnergy.toFixed(1)}：清晰度正常，不处理` };
}

/** 显式档位（CLI `--clarity light|medium|strong|off` 或变体覆盖）。 */
export function clarityForLevel(level: ClarityLevel): string | null {
  return level === "off" ? null : CLARITY_CHAINS[level];
}
