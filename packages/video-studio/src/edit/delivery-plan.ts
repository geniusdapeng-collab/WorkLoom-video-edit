/**
 * edit/delivery-plan.ts —— 交付时长估算与「默认 1080P 完整版、4K 先确认」计划（纯函数）。
 *
 * 产品口径（2026-10-17 产品所有者，第二版）：
 *   ① 默认先交 **1080P 完整版**——不是残缺预览，而是全链路成片：
 *      调色 + BGM + 字幕 + 转场 + 首尾快切 + 封面烧封 + 弹幕 + 交付清单；
 *   ② 极速预览（轻链路 1080P，无调色/无封面/无弹幕）只作为可选，不冒充完整版；
 *   ③ 若素材是 4K，**1080P 完整版交付后主动询问**是否需要 4K，不自动开跑；
 *   ④ 开工前把预计时长、先给什么、后面还有什么、本机配置影响讲清楚。
 *
 * 系数来自本机真实素材实测（Apple M3 / 8 核 / 8GB，2026-10-17）：
 *   轻链路 1080P：assemble 2:12 + 烧字 1:11 + 混音 0:44（124s 成片）；
 *   4K 双变体正式后期（含逐帧核验）约 175 分钟；1080P 全链路按像素量折算。
 * 这是估算，不是 SLA；素材量、成片时长、变体数、分辨率与本机配置共同决定时长。
 */

export interface MachineProfile {
  chip: string;
  cores: number;
  memoryGb: number;
}

export interface DeliveryRates {
  /** 极速预览：每秒成片的裁切/归一化耗时 */
  previewAssembleSecondsPerSecond: number;
  /** 极速预览：每秒成片的烧字耗时 */
  previewBurnSecondsPerSecond: number;
  /** 极速预览：每秒成片的混音耗时 */
  previewMixSecondsPerSecond: number;
  /** 正式后期：每秒**素材**的源片逐帧核验耗时（preflight 的大头） */
  preflightSecondsPerSourceSecond: number;
  /** 1080P 完整版：每个变体、每秒成片的渲染耗时（三形态 + 调色 + BGM） */
  full1080SecondsPerSecondPerVariant: number;
  /** 4K 完整版：每个变体、每秒成片的渲染耗时 */
  full4kSecondsPerSecondPerVariant: number;
  /** 1080P 封面（设计稿+机检+烧封）固定耗时（分钟） */
  cover1080Minutes: number;
  /** 4K 封面（设计稿+机检+烧封）固定耗时（分钟） */
  cover4kMinutes: number;
  /** 清单/节奏复验等固定开销（分钟） */
  fixedOverheadMinutes: number;
}

/** 基准系数：Apple M3 / 8 核 / 8GB（= 本机实测标定）。 */
export const BASELINE_RATES: DeliveryRates = {
  previewAssembleSecondsPerSecond: 1.1,
  previewBurnSecondsPerSecond: 0.6,
  previewMixSecondsPerSecond: 0.4,
  preflightSecondsPerSourceSecond: 3.6,
  full1080SecondsPerSecondPerVariant: 8.0,
  full4kSecondsPerSecondPerVariant: 32.0,
  cover1080Minutes: 4,
  cover4kMinutes: 12,
  fixedOverheadMinutes: 8,
};

export interface DeliveryPlanInput {
  sourceSeconds: number;
  outputSeconds: number;
  /** 素材长边：>=2160 视为 4K 源 */
  sourceMaxEdge: number;
  /** 变体数（正式版至少 2） */
  variants: number;
  machine: MachineProfile;
  overrides?: Partial<DeliveryRates>;
}

export interface LaneStep {
  step: string;
  minutes: number;
  note: string;
}

export interface LaneEstimate {
  resolution: "1080p" | "4k";
  minutes: number;
  steps: LaneStep[];
}

export interface UpgradeScenario {
  label: string;
  chipExample: string;
  factor: number;
  fourKMinutes: number;
  savesPercent: number;
  note: string;
}

export interface DeliveryPlan {
  schemaVersion: "workloom.video-edit/delivery-plan/v1";
  sourceSeconds: number;
  outputSeconds: number;
  sourceMaxEdge: number;
  variants: number;
  sourceIs4K: boolean;
  machine: MachineProfile & { tier: "entry" | "standard" | "pro"; factor: number; note: string };
  /** 可选极速预览（轻链路 1080P：无调色/无封面/无弹幕） */
  previewLane: LaneEstimate;
  /** 默认第一条交付：1080P 完整版（全链路） */
  fastLane: LaneEstimate & { resolutionLabel: string };
  /** 可选第二条交付：4K 完整版（素材是 4K 时，1080P 交付后再确认） */
  fourKLane: (LaneEstimate & { resolutionLabel: string }) | null;
  upgrades: UpgradeScenario[];
  /** 交付 1080P 之后要主动问用户的话（素材非 4K 时为 null） */
  confirmFourK: string | null;
  headline: string;
  assumptions: string[];
}

const roundMinutes = (seconds: number): number => Math.max(1, Math.round(seconds / 60));

/** 机器档位 → 相对基准（M3 8 核 8GB = 1.0）的经验倍率。 */
export function machineFactor(machine: MachineProfile): { tier: "entry" | "standard" | "pro"; factor: number; note: string } {
  const { cores, memoryGb } = machine;
  if (cores >= 12 && memoryGb >= 32) return { tier: "pro", factor: 0.55, note: "高配，4K 多变体后期明显更快" };
  if (cores >= 10 && memoryGb >= 16) return { tier: "pro", factor: 0.7, note: "中高配，4K 渲染耗时约为基准的 0.7 倍" };
  if (cores >= 8 && memoryGb >= 16) return { tier: "standard", factor: 0.9, note: "主流配置，接近基准速度" };
  if (cores >= 8 && memoryGb >= 8) return { tier: "standard", factor: 1, note: "基准配置（本估算的标定机）" };
  return { tier: "entry", factor: 1.6, note: "入门配置，4K 多变体后期会明显更久" };
}

/**
 * 估算三条车道：
 *   preview（可选极速预览）→ fast（默认 1080P 完整版）→ fourK（素材 4K 且用户确认后才跑）。
 */
export function planDelivery(input: DeliveryPlanInput): DeliveryPlan {
  const rates: DeliveryRates = { ...BASELINE_RATES, ...(input.overrides ?? {}) };
  const machine = machineFactor(input.machine);
  const f = machine.factor;
  const output = Math.max(1, input.outputSeconds);
  const sources = Math.max(0, input.sourceSeconds);
  const variants = Math.max(1, Math.round(input.variants));
  const sourceIs4K = input.sourceMaxEdge >= 2160;

  const previewSeconds = output * (rates.previewAssembleSecondsPerSecond + rates.previewBurnSecondsPerSecond + rates.previewMixSecondsPerSecond) * f;
  const previewLane: LaneEstimate = {
    resolution: "1080p",
    minutes: roundMinutes(previewSeconds),
    steps: [
      { step: "1080P 裁切合成", minutes: roundMinutes(output * rates.previewAssembleSecondsPerSecond * f), note: "轻链路：只拼接，不做调色/封面/弹幕" },
      { step: "烧字幕", minutes: roundMinutes(output * rates.previewBurnSecondsPerSecond * f), note: "字幕口径与完整版同源" },
      { step: "配乐混音", minutes: roundMinutes(output * rates.previewMixSecondsPerSecond * f), note: "BGM 让位原声，-14 LUFS 单次处理" },
    ],
  };

  const preflight = sources * rates.preflightSecondsPerSourceSecond * f;
  const full1080Render = output * rates.full1080SecondsPerSecondPerVariant * f * variants;
  const full1080Total = preflight + full1080Render + (rates.cover1080Minutes + rates.fixedOverheadMinutes) * 60 * f;
  const fastLane = {
    resolution: "1080p" as const,
    resolutionLabel: "1080P 完整版（调色/BGM/字幕/转场/快切/封面烧封/弹幕/交付清单）",
    minutes: roundMinutes(full1080Total),
    steps: [
      { step: "源片逐帧核验（preflight）", minutes: roundMinutes(preflight), note: `按 ${Math.round(sources)}s 素材逐帧计数，防止拿错源片` },
      { step: `1080P 全链路 ×${variants} 变体`, minutes: roundMinutes(full1080Render), note: "调色 + BGM + 字幕 + 转场 + 干净/软字幕/烧字三形态 + 弹幕" },
      { step: "封面设计/机检/烧封 + 清单复验", minutes: roundMinutes((rates.cover1080Minutes + rates.fixedOverheadMinutes) * 60 * f), note: "封面三风格机检、1.6s 烧封片头、delivery-manifest" },
    ],
  };

  const fourKRender = output * rates.full4kSecondsPerSecondPerVariant * f * variants;
  const fourKTotal = preflight + fourKRender + (rates.cover4kMinutes + rates.fixedOverheadMinutes) * 60 * f;
  const fourKLane = sourceIs4K
    ? {
      resolution: "4k" as const,
      resolutionLabel: "4K 完整版（跟素材原生档位）",
      minutes: roundMinutes(fourKTotal),
      steps: [
        { step: "源片逐帧核验（preflight）", minutes: roundMinutes(preflight), note: "每次独立后期都要重新核验源片字节" },
        { step: `4K 全链路 ×${variants} 变体`, minutes: roundMinutes(fourKRender), note: "4K 三形态 + 调色 + BGM + 弹幕" },
        { step: "4K 封面/烧封 + 清单复验", minutes: roundMinutes((rates.cover4kMinutes + rates.fixedOverheadMinutes) * 60 * f), note: "封面机检、烧封片头、delivery-manifest" },
      ],
    }
    : null;

  const upgrades: UpgradeScenario[] = [
    {
      label: "升级到 Pro 级（12+ 核 / 32GB）",
      chipExample: "如 M3 Pro / M4 Pro 12–14 核 + 32GB",
      factor: 0.55,
      fourKMinutes: roundMinutes(fourKTotal / f * 0.55),
      savesPercent: Math.round((1 - 0.55) * 100),
      note: "4K 多变体的逐帧核验与渲染都吃 CPU/内存带宽，升级收益主要落在 4K 与完整版",
    },
    {
      label: "升级到 Max 级（14–16 核 / 36GB+）",
      chipExample: "如 M3 Max / M4 Max 14–16 核 + 36GB+",
      factor: 0.4,
      fourKMinutes: roundMinutes(fourKTotal / f * 0.4),
      savesPercent: Math.round((1 - 0.4) * 100),
      note: "适合经常出 4K 多版本；1080P 完整版本就在一小时内，收益较小",
    },
  ];

  const confirmFourK = sourceIs4K
    ? `素材是 4K。1080P 完整版交付后，是否需要我再出一版 4K（同款变体×3 形态 + 封面 + 弹幕，预计约 ${roundMinutes(fourKTotal)} 分钟）？不确认就不跑，避免白等。`
    : null;
  const headline = [
    `默认先用约 ${fastLane.minutes} 分钟交付 1080P 完整版（调色+BGM+字幕+转场+快切+封面烧封+弹幕+清单，全链路）。`,
    sourceIs4K
      ? `素材本身是 4K：1080P 交付后我先问你，需要的话再出 4K（约 ${roundMinutes(fourKTotal)} 分钟），不会自动开跑。`
      : "素材原生就是 1080P，无需再出 4K。",
    `本机 ${input.machine.chip} ${input.machine.cores} 核 / ${input.machine.memoryGb}GB（${machine.tier}）：${machine.note}。`,
  ].join(" ");

  return {
    schemaVersion: "workloom.video-edit/delivery-plan/v1",
    sourceSeconds: Math.round(sources),
    outputSeconds: Math.round(output),
    sourceMaxEdge: input.sourceMaxEdge,
    variants,
    sourceIs4K,
    machine: { ...input.machine, ...machine },
    previewLane,
    fastLane,
    fourKLane,
    upgrades,
    confirmFourK,
    headline,
    assumptions: [
      "估算基于本机实测系数（Apple M3 / 8 核 / 8GB，2026-10-17 真实素材运行），不是 SLA 承诺",
      "1080P 完整版与 4K 完整版共用同一份帧级时间轴与字幕；4K 需要单独一次后期（含重新核验源片）",
      "变体数、成片时长、目标分辨率与本地配置共同决定总时长；不做静默降分辨率、减变体或跳过封面/弹幕",
      "极速预览是可选轻链路，不含调色/封面/弹幕，不作为默认交付件",
    ],
  };
}
