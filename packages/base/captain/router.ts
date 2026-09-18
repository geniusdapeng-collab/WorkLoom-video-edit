/**
 * base/captain · 五级审批路由 + 公司CEO 裁决策略（D21，方案 §三）
 *
 * 路由（纯函数）：review 级审批行创建时定 tier——
 *   L4 董事长：命中宪章必请示清单 / 超出自治边界（价格带外、超采购上限）/ 跨工作区升级 / 围栏放宽 / 宪章变更
 *   L3 集团CEO：跨工作区事项（预留；单店模型下不产生）
 *   L2 公司CEO：其余全部（原「店长级 review」的 ~90%）
 * 裁决（consumeQueue）：公司CEO 对 L2 队列按宪章自动 approve/reject/escalate，逐件附 Decision Memo 留痕。
 */
import type { Charter } from "./charter.js";
import { effectiveAutonomy } from "./charter.js";

export type ApprovalTier = "l2_captain" | "l3_fleet" | "l4_chairman";

export interface RouteInput {
  action: string;
  params: Record<string, unknown>;
  /** 命中的围栏规则 ID 列表（只用于审计，不推断行业语义） */
  ruleIds?: string[];
  crossWorkspace?: boolean;
  /** Bundle 声明的通用区间和值；找不到 key 时失败关闭到 L4。 */
  rangeCtx?: { key?: string; value?: number };
  amountCtx?: { amount?: number; capKey?: string };
  /**
   * 价格类动作：调价后价与基准价。框架按宪章声明的报价带判定「带内可自决 / 越带上浮董事长」——
   * 键名沿用产品词汇（docs/workforce-v2.md 的 price_quote_band），行业包可用 bandKey 覆盖。
   */
  priceCtx?: { afterPrice?: number; basePrice?: number; bandKey?: string };
  isFenceWiden?: boolean;          // 围栏放宽提案（一律 L4）
  isCharterChange?: boolean;       // 宪章变更（一律 L4）
}

/** 价格动作默认报价带键名（宪章 autonomy.ranges 里由行业包命名的键）。 */
export const DEFAULT_QUOTE_BAND_KEY = "price_quote_band";

/**
 * 报价带判定：比值口径 = 调价后 / 基准（1 = 不变），与宪章 anchor 同义。
 * 返回 null = 未声明区间或输入不完整 → 调用方按失败关闭处理（L4）。
 */
export function quoteBandBand(
  autonomy: ReturnType<typeof effectiveAutonomy>,
  priceCtx: NonNullable<RouteInput["priceCtx"]>,
): { ratio: number; lower: number; upper: number } | null {
  if (priceCtx.afterPrice === undefined || !priceCtx.basePrice) return null;
  const band = autonomy.ranges[priceCtx.bandKey ?? DEFAULT_QUOTE_BAND_KEY];
  if (!band) return null;
  return { ratio: priceCtx.afterPrice / priceCtx.basePrice, lower: band.lower, upper: band.upper };
}

export function routeTier(c: Charter, i: RouteInput): ApprovalTier {
  if (i.isFenceWiden || i.isCharterChange) return "l4_chairman";
  const a = effectiveAutonomy(c);
  // 价格类动作：比值必须落在宪章声明的报价带内；未声明区间 → 董事长（失败关闭）
  if (i.priceCtx?.afterPrice !== undefined) {
    const band = quoteBandBand(a, i.priceCtx);
    if (!band || band.ratio < band.lower || band.ratio > band.upper) return "l4_chairman";
  }
  // 任一声明区间越界或未配置 → 董事长
  if (i.rangeCtx?.value !== undefined) {
    const range = i.rangeCtx.key ? a.ranges[i.rangeCtx.key] : undefined;
    if (!range || i.rangeCtx.value < range.lower || i.rangeCtx.value > range.upper) return "l4_chairman";
  }
  // 金额超自治上限 → 董事长
  if (i.amountCtx?.amount !== undefined) {
    const cap = i.amountCtx.capKey ? a.caps[i.amountCtx.capKey]?.limit : undefined;
    if (cap === undefined) return "l4_chairman";
    if (i.amountCtx.amount > cap) return "l4_chairman";
  }
  // 跨工作区 → 集团CEO
  if (i.crossWorkspace) return "l3_fleet";
  return "l2_captain";
}

/* ================= 公司CEO 裁决策略（L2 队列消费） ================= */

export interface QueueItem {
  approvalId: string;
  eventId: string;
  action: string;
  params: Record<string, unknown>;
  ruleIds: string[];
  rangeCtx?: { key?: string; value?: number };
  amountCtx?: { amount?: number; capKey?: string };
  /** 价格类动作：调价后/基准价（队列从审批快照回填，见 priceContextFromSnapshot） */
  priceCtx?: { afterPrice?: number; basePrice?: number; bandKey?: string };
  irreversible?: boolean;
  affectedDomains?: string[];
  title: string;
}

function finiteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 从审批快照还原价格上下文（价格类动作的自治判定输入）。
 *
 * 兼容两种落库口径：
 *   ① 运行时审批快照：before.price + after（= params）
 *   ② 历史/外部注入：base_price + params.price
 * 两者都拿不到 → undefined（调用方按"无判据"保守处理，不猜价格）。
 */
export function priceContextFromSnapshot(
  snapshot: Record<string, unknown>,
  params: Record<string, unknown>,
): QueueItem["priceCtx"] {
  const before = (snapshot.before ?? {}) as Record<string, unknown>;
  const after = (snapshot.after ?? {}) as Record<string, unknown>;
  const afterPrice = finiteNumber(after.price) ?? finiteNumber(params.price);
  const basePrice = finiteNumber(before.price) ?? finiteNumber(snapshot.base_price) ?? finiteNumber(params.base_price);
  if (afterPrice === undefined || basePrice === undefined) return undefined;
  const bandKey = typeof snapshot.autonomy_band_key === "string" && snapshot.autonomy_band_key.trim()
    ? snapshot.autonomy_band_key.trim()
    : undefined;
  return { afterPrice, basePrice, ...(bandKey ? { bandKey } : {}) };
}

export type CeoVerdict =
  | { kind: "approve"; rationale: string }
  | { kind: "reject"; rationale: string }
  | { kind: "escalate"; rationale: string }; // 升 L4 请董事长

/** 公司CEO 裁决：宪章内放行（approve），明显越界否决（reject），拿不准/临边上浮（escalate）。
 *  保守默认：无法判明一律 escalate（拒绝默认的镜像——宁可请示不可错放）。 */
export function decideForCaptain(c: Charter, item: QueueItem): CeoVerdict {
  const a = effectiveAutonomy(c);
  // 价格类：带内 approve；越带/贴边/未声明报价带一律上浮董事长
  if (item.priceCtx?.afterPrice !== undefined) {
    const band = quoteBandBand(a, item.priceCtx);
    if (!band) return { kind: "escalate", rationale: "价格动作未引用宪章声明的报价带，上浮董事长复核" };
    const { ratio, lower, upper } = band;
    if (ratio < lower || ratio > upper) {
      return { kind: "escalate", rationale: `调价比值 ${ratio.toFixed(4)} 超出报价带 [${lower}, ${upper}]，上浮董事长` };
    }
    const edge = Math.abs(upper - lower) * 0.1;
    if (ratio - lower < edge || upper - ratio < edge) {
      return { kind: "escalate", rationale: `调价比值 ${ratio.toFixed(4)} 贴近报价带边缘，谨慎上浮复核` };
    }
    return { kind: "approve", rationale: `调价比值 ${ratio.toFixed(4)} 位于报价带 [${lower}, ${upper}] 内，符合宪章` };
  }
  // 通用区间：带内 approve；贴近边缘（区间宽度 10% 内）escalate；未声明失败关闭
  if (item.rangeCtx?.value !== undefined) {
    const range = item.rangeCtx.key ? a.ranges[item.rangeCtx.key] : undefined;
    if (!range) return { kind: "escalate", rationale: "请求引用了未声明的自治区间，上浮董事长" };
    const value = item.rangeCtx.value;
    if (value < range.lower || value > range.upper) {
      return { kind: "escalate", rationale: `${range.label} ${value} 超出自治区间 [${range.lower}, ${range.upper}]，上浮董事长` };
    }
    const edge = Math.abs(range.upper - range.lower) * 0.1;
    if (value - range.lower < edge || range.upper - value < edge) {
      return { kind: "escalate", rationale: `${range.label} ${value} 贴近自治边缘，谨慎上浮复核` };
    }
    return { kind: "approve", rationale: `${range.label} ${value} 位于自治区间内，符合宪章` };
  }
  // 金额类：上限 70% 以内 approve，70–100% escalate（临边谨慎），超上限 escalate
  if (item.amountCtx?.amount !== undefined) {
    const capEntry = item.amountCtx.capKey ? a.caps[item.amountCtx.capKey] : undefined;
    if (!capEntry) return { kind: "escalate", rationale: "请求引用了未声明的自治上限，上浮董事长" };
    const cap = capEntry.limit;
    const amt = item.amountCtx.amount;
    if (amt > cap) return { kind: "escalate", rationale: `金额 ¥${amt} 超自治上限 ¥${cap}，上浮董事长` };
    if (amt > cap * 0.7) return { kind: "escalate", rationale: `金额 ¥${amt} 达上限 70% 以上，谨慎上浮复核` };
    return { kind: "approve", rationale: `金额 ¥${amt} 在自治上限 ¥${cap} 的 70% 以内，符合宪章` };
  }
  // 无判据的杂项：保守上浮（拒绝默认镜像）
  return { kind: "escalate", rationale: "无明确自治判据，按保守默认上浮董事长复核" };
}
