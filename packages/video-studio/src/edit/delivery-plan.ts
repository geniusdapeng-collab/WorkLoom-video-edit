/**
 * edit/delivery-plan.ts —— 交付时长估算与"1080P 先行"分批发货计划（纯函数）。
 *
 * 产品口径（2026-10-17 产品所有者）：
 *   ① 用户在等成片，等待时间本身是产品体验的一部分——先用 1080P 快速交一版可看的，
 *      4K / 多风格 / 封面烧封再分批补；
 *   ② 开工前就把"先给你什么、多久、后面还有什么、几个版本"讲清楚；
 *   ③ 时长必须如实归因：素材时长、成片时长、目标分辨率、变体数、本机配置。
 *
 * 这不是承诺 SLA：系数来自本机实测（Apple M3 / 8 核 / 8GB，2026-10-17 的
 * 真实素材运行：1080P assemble 2:12、烧字 1:11、混音 0:44、4K 双变体后期约 3 小时）。
 * 换机器/换片型会有偏差，输出必须带"估算"字样与依据。
 */

export interface MachineProfile {
  /** CPU/SoC 名称（如 Apple M3） */
  chip: string;
  cores: number;
  memoryGb: number;
}

export interface DeliveryRates {
  /** 1080P 先行版：每秒成片的裁切/归一化耗时 */
  fastAssembleSecondsPerSecond: number;
  /** 1080P 先行版：每秒成片的烧字耗时 */
  fastBurnSecondsPerSecond: number;
  /** 1080P 先行版：每秒成片的混音耗时 */
  fastMixSecondsPerSecond: number;
  /** 正式后期：每秒**素材**的源片逐帧核验耗时（preflight 的 -count_frames 大头） */
  preflightSecondsPerSourceSecond: number;
  /** 正式后期：每个变体、每秒成片的 1080P 三形态渲染耗时 */
  full1080SecondsPerSecondPerVariant: number;
  /** 正式后期：每个变体、每秒成片的 4K 三形态渲染耗时 */
  full4kSecondsPerSecondPerVariant: number;
  /** 清单/封面/复验等固定开销（分钟） */
  fixedOverheadMinutes: number;
}

/**
 * 基准系数：Apple M3 / 8 核 / 8GB（= 本机实测）。
 * 其他机器用 machineFactor 线性缩放；这是保守工程估算，不是跑分承诺。
 */
export const BASELINE_RATES: DeliveryRates = {
  fastAssembleSecondsPerSecond: 1.1,
  fastBurnSecondsPerSecond: 0.6,
  fastMixSecondsPerSecond: 0.4,
  preflightSecondsPerSourceSecond: 3.6,
  full1080SecondsPerSecondPerVariant: 8.0,
  full4kSecondsPerSecondPerVariant: 32.0,
  fixedOverheadMinutes: 8,
};

export interface DeliveryPlanInput {
  /** 素材总时长（去重后的唯一源片时长和） */
  sourceSeconds: number;
  /** 成片时长（时间轴总时长，含首尾快切） */
  outputSeconds: number;
  /** 素材长边：2160 视为 4K 源，1080 视为高清源 */
  sourceMaxEdge: number;
  /** 变体数（warm-story/clean-tech/...）；正式后期至少 2 */
  variants: number;
  machine: MachineProfile;
  overrides?: Partial<DeliveryRates>;
}

export interface LaneEstimate {
  resolution: "1080p" | "4k";
  minutes: number;
  steps: Array<{ step: string; minutes: number; note: string }>;
}

export interface UpgradeScenario {
  label: string;
  chipExample: string;
  factor: number;
  fullLaneMinutes: number;
  savesPercent: number;
  note: string;
}

export interface DeliveryPlan {
  schemaVersion: "workloom.video-edit/delivery-plan/v1";
  sourceSeconds: number;
  outputSeconds: number;
  sourceMaxEdge: number;
  variants: number;
  machine: MachineProfile & { tier: "entry" | "standard" | "pro"; factor: number; note: string };
  fastLane: LaneEstimate;
  fullLane: LaneEstimate & { resolutionLabel: string };
  upgrades: UpgradeScenario[];
  headline: string;
  assumptions: string[];
}

const roundMinutes = (seconds: number): number => Math.max(1, Math.round(seconds / 60));

/** 机器档位 → 相对基准（M3 8 核 8GB = 1.0）的经验倍率。 */
export function machineFactor(machine: MachineProfile): { tier: "entry" | "standard" | "pro"; factor: number; note: string } {
  const { cores, memoryGb, chip } = machine;
  if (cores >= 12 && memoryGb >= 32) {
    return { tier: "pro", factor: 0.55, note: "高配，4K 多变体后期明显更快" };
  }
  if (cores >= 10 && memoryGb >= 16) {
    return { tier: "pro", factor: 0.7, note: "中高配，4K 渲染耗时约为基准的 0.7 倍" };
  }
  if (cores >= 8 && memoryGb >= 16) {
    return { tier: "standard", factor: 0.9, note: "主流配置，接近基准速度" };
  }
  if (cores >= 8 && memoryGb >= 8) {
    return { tier: "standard", factor: 1, note: "基准配置（本估算的标定机）" };
  }
  return { tier: "entry", factor: 1.6, note: "入门配置，4K 多变体后期会明显更久" };
}

/**
 * 估算两条车道的耗时，并给出"先交 1080P、后补正式版"的话术。
 * 输入全部来自当前时间轴与真实素材规格；缺省系数以 BASELINE_RATES 为准。
 */
export function planDelivery(input: DeliveryPlanInput): DeliveryPlan {
  const rates: DeliveryRates = { ...BASELINE_RATES, ...(input.overrides ?? {}) };
  const machine = machineFactor(input.machine);
  const f = machine.factor;
  const output = Math.max(1, input.outputSeconds);
  const sources = Math.max(0, input.sourceSeconds);
  const variants = Math.max(1, Math.round(input.variants));

  const fastAssemble = output * rates.fastAssembleSecondsPerSecond * f;
  const fastBurn = output * rates.fastBurnSecondsPerSecond * f;
  const fastMix = output * rates.fastMixSecondsPerSecond * f;
  const fastTotal = fastAssemble + fastBurn + fastMix;

  const full4k = input.sourceMaxEdge >= 2160;
  const preflight = sources * rates.preflightSecondsPerSourceSecond * f;
  const perVariant = full4k
    ? output * rates.full4kSecondsPerSecondPerVariant * f
    : output * rates.full1080SecondsPerSecondPerVariant * f;
  const render = perVariant * variants;
  const overhead = rates.fixedOverheadMinutes * 60 * f;
  const fullTotal = preflight + render + overhead;

  const fullLane: LaneEstimate & { resolutionLabel: string } = {
    resolution: full4k ? "4k" : "1080p",
    resolutionLabel: full4k ? "4K（跟素材原生档位）" : "1080P（素材原生档位即为 1080P）",
    minutes: roundMinutes(fullTotal),
    steps: [
      { step: "源片逐帧核验（preflight）", minutes: roundMinutes(preflight), note: `按 ${Math.round(sources)}s 素材逐帧计数，防止拿错源片` },
      { step: `正式后期 ×${variants} 变体（干净/软字幕/烧字）`, minutes: roundMinutes(render), note: full4k ? "4K 三形态 + 调色 + BGM + 封面" : "1080P 三形态 + 调色 + BGM + 封面" },
      { step: "清单/封面/复验", minutes: roundMinutes(overhead), note: "delivery-manifest、封面机检、节奏复验回执" },
    ],
  };

  const fastLane: LaneEstimate = {
    resolution: "1080p",
    minutes: roundMinutes(fastTotal),
    steps: [
      { step: "1080P 裁切合成", minutes: roundMinutes(fastAssemble), note: "按同一份帧级时间轴裁切/归一化，含首尾快切" },
      { step: "烧字幕", minutes: roundMinutes(fastBurn), note: "字库/安全区/标点体检与正式版同源" },
      { step: "配乐混音", minutes: roundMinutes(fastMix), note: "BGM 让位原声，-14 LUFS 单次处理" },
    ],
  };

  const upgrades: UpgradeScenario[] = [
    {
      label: "升级到 Pro 级（12+ 核 / 32GB）",
      chipExample: "如 M3 Pro / M4 Pro 12–14 核 + 32GB",
      factor: 0.55,
      fullLaneMinutes: roundMinutes(fullTotal / f * 0.55),
      savesPercent: Math.round((1 - 0.55) * 100),
      note: "4K 多变体的逐帧核验与渲染都吃 CPU/内存带宽，升级收益主要落在正式版",
    },
    {
      label: "升级到 Max 级（14–16 核 / 36GB+）",
      chipExample: "如 M3 Max / M4 Max 14–16 核 + 36GB+",
      factor: 0.4,
      fullLaneMinutes: roundMinutes(fullTotal / f * 0.4),
      savesPercent: Math.round((1 - 0.4) * 100),
      note: "适合经常出 4K 多版本；1080P 先行版本来就只有几分钟，收益有限",
    },
  ];

  const headline = [
    `先用约 ${fastLane.minutes} 分钟给你 1080P 先行版（烧字+配乐，能直接看）。`,
    `正式版为 ${fullLane.resolutionLabel} × ${variants} 个风格（干净/软字幕/烧字三形态 + 封面），预计约 ${fullLane.minutes} 分钟。`,
    `本机 ${input.machine.chip} ${input.machine.cores} 核 / ${input.machine.memoryGb}GB：${machine.note}。`,
  ].join(" ");

  return {
    schemaVersion: "workloom.video-edit/delivery-plan/v1",
    sourceSeconds: Math.round(sources),
    outputSeconds: Math.round(output),
    sourceMaxEdge: input.sourceMaxEdge,
    variants,
    machine: { ...input.machine, ...machine },
    fastLane,
    fullLane,
    upgrades,
    headline,
    assumptions: [
      "估算基于本机实测系数（Apple M3 / 8 核 / 8GB，2026-10-17 真实素材运行），不是 SLA 承诺",
      "正式版的源片逐帧核验与素材总量成正比，是 4K 多版本耗时的大头",
      "变体数、成片时长、目标分辨率与本地配置共同决定总时长；不做静默降分辨率或减变体",
      "1080P 先行版与正式版共用同一份帧级时间轴与字幕，不存在两套剪辑",
    ],
  };
}
