/**
 * 注意力层（Attention Layer）——口播知识视频的"视觉事件排期 + 体检"。
 *
 * 为什么单独一层：口播精剪（talk-cut）解决"说哪些话、怎么剪顺"，但不解决
 * "每 5–7 秒给观众一次视觉新信息"。行业口径（创作者教育/剪辑实务，C 级二手证据）：
 *   · 单一机位长镜头必须靠 pattern interrupt 维持注意力：punch-in / 字幕强调 / 信息卡 / 换角度；
 *   · B-roll（或替代它的文字层）只上四种时刻——清单、数字、抽象名词、长铺垫；
 *   · 重点句前"故意留白"比一味删停顿更有效（删 >0.4s 停顿，再在重点前留 0.3–0.5s）。
 *
 * 本模块只做**确定性计算**：不调用模型、不渲染像素。
 *   · `planAttention()`：输入逐字稿/时间轴/卡片计划/已有弹幕 → 输出事件表（含音效点位）与体检建议；
 *   · `auditAttention()`：输入事件表 → 输出覆盖率、最大空窗、关键词密度、卡片约束等指标，
 *     以及硬项（遮挡类由渲染回执负责，这里只管"同刻多主事件""卡片越界"这类可判定项）与咨询项。
 *
 * 口径边界：密度/时长/覆盖率是**咨询项**（审美不写硬闸）；只有"同一时刻两个主事件""卡片超出安全区"
 * "外部素材无许可回执"这类事实项才是硬项。
 */

export type AttentionEventKind =
  | "hook-card" | "knowledge-card" | "full-card" | "pip" | "lower-third"
  | "keyword-emphasis" | "danmaku" | "angle-switch" | "sfx" | "beat";

/** 主事件：同一时刻只允许一个（硬项），因为它们都是"盖画面"的动作 */
const MAIN_EVENT_KINDS = new Set<AttentionEventKind>(["hook-card", "knowledge-card", "full-card", "pip", "lower-third"]);

export interface AttentionWord {
  text: string;
  start: number;
  end: number;
}

export interface AttentionSpan {
  text: string;
  start: number;
  end: number;
  kind: "number" | "insight" | "custom";
}

export interface AttentionSegmentLike {
  segmentId: string;
  masterIn: number;
  masterOut: number;
  sourceIn?: number;
  sourceOut?: number;
  text?: string;
}

export interface AttentionCardPlan {
  id: string;
  kind: "knowledge-card" | "full-card" | "lower-third" | "pip";
  /** 成片主轨时间（秒） */
  start: number;
  end: number;
  /** 卡片占据的画面区域（归一化 0–1，原点左上）；用于安全区判定 */
  layout?: { x: number; y: number; w: number; h: number };
  /** 该卡片讲的是哪一句/哪一段（写进事件表，便于复核是否"卡到句子"） */
  anchor?: string;
}

export interface AttentionOptions {
  /** 视觉事件的目标间隔（秒）：行业口径 5–7s，取窗口粒度 */
  targetGapSec?: number;
  /** 允许的最大空窗（秒）：超过进咨询项 */
  maxGapSec?: number;
  /** 伪机位（景别切换）间隔（秒）：行业口径 45–60s */
  angleEverySec?: number;
  /** 片头钩子卡（0s 起）时长（秒） */
  hookCardSec?: number;
  /** 一屏底部字幕带比例（相对画布高）与顶部安全区：用于卡片越界判定 */
  subtitleBand?: { topRatio: number; bottomRatio: number };
  /** 平台右侧操作栏安全区比例（相对画布宽） */
  rightRailRatio?: number;
  /** 关键词密度带上限（个/分钟） */
  keywordPerMinute?: { min: number; max: number };
  /** 全片知识卡数量上限 */
  maxCards?: number;
  /** 单张知识卡允许的停留时长（秒） */
  cardDuration?: { min: number; max: number };
  /** 全屏字卡允许的停留时长（秒）与全片上限 */
  fullCardDuration?: { min: number; max: number };
  maxFullCards?: number;
  /** 额外关键词正则（领域锚点，字符串形式，便于 JSON 传递） */
  extraKeywordPatterns?: string[];
  /** 前 N 秒只允许钩子（不许别的花活） */
  hookWindowSec?: number;
  /** 全屏字卡是全屏接管：允许覆盖字幕带（每片 ≤maxFullCards 张，时长 3–5s） */
  allowFullBleed?: boolean;
}

export interface AttentionEvent {
  id: string;
  kind: AttentionEventKind;
  at: number;
  durationSec: number;
  source: "card" | "keyword" | "angle" | "danmaku" | "sfx" | "manual";
  detail: string;
  hard?: boolean;
}

export interface AttentionSfxPlacement {
  id: string;
  kind: "whoosh" | "impact" | "riser";
  at: number;
  gainDb: number;
  reason: string;
}

export interface AttentionWindow {
  index: number;
  start: number;
  end: number;
  eventIds: string[];
  covered: boolean;
}

export interface AttentionGap {
  start: number;
  end: number;
  seconds: number;
}

export interface AttentionMetrics {
  durationSeconds: number;
  windowSeconds: number;
  windows: number;
  windowsCovered: number;
  coverageRate: number;
  maxGapSeconds: number;
  keywordCount: number;
  keywordPerMinute: number;
  cards: number;
  fullCards: number;
  angleSwitches: number;
  sfxCount: number;
  firstHookWindowClean: boolean;
}

export interface AttentionAudit {
  ok: boolean;
  hardFailures: string[];
  advisories: string[];
  metrics: AttentionMetrics;
  windows: AttentionWindow[];
  gaps: AttentionGap[];
}

export interface AttentionPlan {
  schemaVersion: "workloom.video-edit/attention-plan/v1";
  generatedFor: { timelineId?: string | null; durationSeconds: number; platform?: string | null };
  options: Required<Pick<AttentionOptions,
    "targetGapSec" | "maxGapSec" | "angleEverySec" | "hookCardSec" | "maxCards" | "keywordPerMinute">>;
  keywords: AttentionSpan[];
  events: AttentionEvent[];
  sfx: AttentionSfxPlacement[];
  audit: AttentionAudit;
  notes: string[];
}

const round = (value: number, digits = 3): number => Math.round(value * 10 ** digits) / 10 ** digits;

const DEFAULT_OPTIONS: Required<Pick<AttentionOptions,
  "targetGapSec" | "maxGapSec" | "angleEverySec" | "hookCardSec" | "maxCards" | "keywordPerMinute">> = {
  targetGapSec: 6,
  maxGapSec: 7,
  angleEverySec: 52,
  hookCardSec: 3,
  maxCards: 10,
  keywordPerMinute: { min: 3, max: 6 },
};

/** 数字锚点：阿拉伯数字（含 12 个维度 / 1-2 块 / 45 分钟）与中文数量（一两块钱 / 一二十块 / 一两个小时） */
const NUMBER_PATTERNS: RegExp[] = [
  /[0-9０-９]+(?:[.．][0-9０-９]+)?\s*(?:个维度|条|块|元|分钟|小时|秒|年|个月|天|倍|%|％)?/gu,
  /** 中文数量词：允许"个/多/半"夹在中间（一两个小时 / 半年多 / 一二十块钱） */
  /[一二两三四五六七八九十百千万半]+(?:[十百千万])*(?:个|多|半)?(?:块钱|块|条|分钟|小时|秒|年|个月|天|倍|个维度)/gu,
];

/** 结论/金句锚点：说"这是结论"的词，不是形容词堆积 */
const INSIGHT_PATTERN = /(范式|核心|关键|本质|结论|链路跑通|跑通了|成本特别低|模型成本)/gu;

/**
 * 从词级逐字稿里找"值得划重点"的锚点（数字/结论）。
 *
 * 为什么按字符映射而不是按词匹配：ASR 的中文词表大量是单字 token（"一/两/块/钱"），
 * 按词匹配会漏掉跨词的"一两块钱"；这里先把词拼成字符串并记录每个字符的时间，
 * 再用正则找锚点，最后把字符区间映射回时间。
 */
export function detectAttentionKeywords(words: AttentionWord[], options: AttentionOptions = {}): AttentionSpan[] {
  const chars: string[] = [];
  const times: Array<{ start: number; end: number }> = [];
  for (const word of words) {
    const text = String(word.text ?? "");
    for (const char of text) {
      chars.push(char);
      times.push({ start: word.start, end: word.end });
    }
  }
  const joined = chars.join("");
  if (!joined) return [];
  const spans: AttentionSpan[] = [];
  const pushMatches = (pattern: RegExp, kind: AttentionSpan["kind"]): void => {
    for (const match of joined.matchAll(pattern)) {
      const index = match.index ?? -1;
      if (index < 0) continue;
      const text = match[0];
      if (!text) continue;
      const start = times[index]?.start ?? 0;
      const end = times[Math.min(times.length - 1, index + text.length - 1)]?.end ?? start;
      spans.push({ text, start: round(start), end: round(end), kind });
    }
  };
  for (const pattern of NUMBER_PATTERNS) pushMatches(new RegExp(pattern.source, pattern.flags), "number");
  pushMatches(new RegExp(INSIGHT_PATTERN.source, INSIGHT_PATTERN.flags), "insight");
  for (const extra of options.extraKeywordPatterns ?? []) {
    try {
      pushMatches(new RegExp(extra, "gu"), "custom");
    } catch {
      throw new Error(`extraKeywordPatterns 里有非法正则：${extra}`);
    }
  }
  /** 去重与合并：同一锚点可能被多条正则命中；重叠的只留更长的那个 */
  const sorted = spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const deduped: AttentionSpan[] = [];
  for (const span of sorted) {
    const last = deduped[deduped.length - 1];
    if (last && span.start <= last.end + 0.02) {
      if (span.end - span.start > last.end - last.start) deduped[deduped.length - 1] = span;
      continue;
    }
    deduped.push(span);
  }
  return deduped;
}

/** 卡片是否落在安全区（不压字幕带、不越画布、不压右侧操作栏） */
export function cardFitsSafeArea(
  layout: { x: number; y: number; w: number; h: number },
  options: AttentionOptions = {},
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const band = options.subtitleBand ?? { topRatio: 0.78, bottomRatio: 1 };
  const rail = options.rightRailRatio ?? 0.11;
  if (layout.x < 0 || layout.y < 0 || layout.w <= 0 || layout.h <= 0 || layout.x + layout.w > 1.0001 || layout.y + layout.h > 1.0001) {
    reasons.push(`卡片区域越出画布：x=${layout.x} y=${layout.y} w=${layout.w} h=${layout.h}`);
  }
  if (!options.allowFullBleed && layout.y + layout.h > band.topRatio + 0.0001) {
    reasons.push(`卡片压到字幕带（底部 ${Math.round((1 - band.topRatio) * 100)}%）：y+h=${round(layout.y + layout.h, 2)} > ${band.topRatio}`);
  }
  /**
   * 右侧操作栏（点赞/评论/分享）只遮挡画面**下半部**；上半部的知识卡可以占满宽度。
   * 全屏达标卡（allowFullBleed）不受这条限制。
   */
  const cardCenterY = layout.y + layout.h / 2;
  const railForThis = options.allowFullBleed || cardCenterY <= 0.5 ? 0 : rail;
  if (railForThis > 0 && layout.x + layout.w > 1 - railForThis + 0.0001) {
    reasons.push(`卡片压到右侧操作栏安全区（右侧 ${Math.round(rail * 100)}%）：x+w=${round(layout.x + layout.w, 2)}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * 关键词筛选：检测到的锚点往往远超"重点"的量（实测 26 个 / 100s = 15.8 个/分钟），
 * 全量高亮等于没有重点。这里按"价值优先级 + 最小间隔 + 每分钟上限"挑选：
 *   · 优先级：金额/价格（块/元/钱）> 结论词（范式/核心/成本特别低…）> 其他数字；
 *   · 相邻两个强调点至少隔 `minSpacingSec`（默认 8s）；
 *   · 全片上限 = 每分钟 min(上限) 个（默认 6/分钟）。
 * 被丢掉的锚点写进返回值的 dropped，供复核——不静默丢。
 */
export function selectEmphasisKeywords(
  spans: AttentionSpan[],
  options: { perMinute?: number; durationSeconds?: number; minSpacingSec?: number } = {},
): { selected: AttentionSpan[]; dropped: AttentionSpan[] } {
  const perMinute = Math.max(1, Number(options.perMinute ?? 6));
  const duration = Math.max(1, Number(options.durationSeconds ?? 60));
  const minSpacing = Math.max(0, Number(options.minSpacingSec ?? 8));
  const quota = Math.max(1, Math.floor((duration / 60) * perMinute + 1e-6));
  const priority = (span: AttentionSpan): number => {
    if (/[块钱元]|块|元/u.test(span.text)) return 3;
    if (span.kind === "insight") return 2;
    return 1;
  };
  const sorted = [...spans].sort((a, b) => priority(b) - priority(a) || a.start - b.start);
  const selected: AttentionSpan[] = [];
  const dropped: AttentionSpan[] = [];
  for (const span of sorted) {
    const tooClose = selected.some((picked) => Math.abs(picked.start - span.start) < minSpacing);
    if (selected.length >= quota || tooClose) {
      dropped.push(span);
      continue;
    }
    selected.push(span);
  }
  return { selected: selected.sort((a, b) => a.start - b.start), dropped: dropped.sort((a, b) => a.start - b.start) };
}

/** 视觉事件 → 音效点位（本地 sfx-synth 合成，无版权风险） */
export function planAttentionSfx(events: AttentionEvent[], options: AttentionOptions = {}): AttentionSfxPlacement[] {
  const placements: AttentionSfxPlacement[] = [];
  const hookWindow = options.hookWindowSec ?? 2;
  for (const event of events) {
    if (event.kind === "hook-card" || (MAIN_EVENT_KINDS.has(event.kind) && event.at <= hookWindow)) {
      placements.push({ id: `sfx-${placements.length + 1}`, kind: "impact", at: round(Math.max(0.05, event.at)), gainDb: -12, reason: `${event.kind} 进场（${event.detail}）` });
      continue;
    }
    if (MAIN_EVENT_KINDS.has(event.kind)) {
      placements.push({ id: `sfx-${placements.length + 1}`, kind: "whoosh", at: round(Math.max(0, event.at - 0.18)), gainDb: -16, reason: `知识卡进出（${event.detail}）` });
      continue;
    }
    if (event.kind === "angle-switch") {
      placements.push({ id: `sfx-${placements.length + 1}`, kind: "whoosh", at: round(Math.max(0, event.at - 0.12)), gainDb: -18, reason: `景别切换（${event.detail}）` });
    }
  }
  /** 金句前 1.2s 一记 riser：只在"全屏字卡"之前，全片最多 2 次 */
  const fullCards = events.filter((event) => event.kind === "full-card").slice(0, 2);
  for (const card of fullCards) {
    placements.push({ id: `sfx-${placements.length + 1}`, kind: "riser", at: round(Math.max(0, card.at - 1.2)), gainDb: -20, reason: `金句段推进（${card.detail}）` });
  }
  return placements.sort((a, b) => a.at - b.at);
}

/**
 * 排期：在"已有事件"（卡片/弹幕）基础上补足空窗，产出伪机位与关键词强调事件。
 * 规则：空窗即"连续没有视觉事件"的区间；超过 targetGapSec 就在该空窗内的**段边界**上补一个
 * 低干扰事件（景别切换或关键词强调），不硬塞卡片（卡片由内容决定，不由密度反推）。
 */
export function planAttention(input: {
  durationSeconds: number;
  segments: AttentionSegmentLike[];
  keywords?: AttentionSpan[];
  cards?: AttentionCardPlan[];
  danmaku?: Array<{ time: number; text?: string }>;
  options?: AttentionOptions;
  timelineId?: string | null;
  platform?: string | null;
}): AttentionPlan {
  const options = { ...DEFAULT_OPTIONS, ...(input.options ?? {}) } as AttentionOptions & typeof DEFAULT_OPTIONS;
  /**
   * 关键词不是"检测到多少就强调多少"：全量高亮 = 没有重点（实测 26 个锚点 / 100s 会被体检判超密）。
   * 这里按价值优先级 + 最小间隔 + 每分钟上限筛选出真正的强调点，被丢掉的写进 notes 供复核。
   */
  const emphasis = selectEmphasisKeywords(input.keywords ?? [], {
    perMinute: options.keywordPerMinute.max,
    durationSeconds: input.durationSeconds,
  });
  const keywords = emphasis.selected;
  const events: AttentionEvent[] = [];
  const add = (event: Omit<AttentionEvent, "id">): AttentionEvent => {
    const created: AttentionEvent = { ...event, id: `att-${String(events.length + 1).padStart(3, "0")}` };
    events.push(created);
    return created;
  };

  if (options.hookCardSec > 0) {
    add({
      kind: "hook-card", at: 0, durationSec: options.hookCardSec, source: "manual",
      detail: `片头钩子卡（${options.hookCardSec}s，承诺前置）`,
    });
  }
  for (const card of input.cards ?? []) {
    add({
      kind: card.kind, at: round(card.start), durationSec: round(Math.max(0.1, card.end - card.start)), source: "card",
      detail: `${card.id}${card.anchor ? ` @${card.anchor}` : ""}`,
    });
  }
  for (const danmaku of input.danmaku ?? []) {
    add({ kind: "danmaku", at: round(danmaku.time), durationSec: 3, source: "danmaku", detail: danmaku.text ?? "弹幕" });
  }
  for (const keyword of keywords) {
    add({
      kind: "keyword-emphasis", at: round(keyword.start), durationSec: round(Math.max(0.3, keyword.end - keyword.start)),
      source: "keyword", detail: `${keyword.kind}:${keyword.text}`,
    });
  }

  // 伪机位：按 angleEverySec 排，落点优先选"段边界"（切换不切在句子中间）
  const boundaries = input.segments
    .map((segment) => round(segment.masterOut))
    .filter((value) => value > 0 && value < input.durationSeconds - 0.5)
    .sort((a, b) => a - b);
  if (boundaries.length > 0) {
    let last = 0;
    for (const boundary of boundaries) {
      if (boundary - last >= options.angleEverySec) {
        add({ kind: "angle-switch", at: boundary, durationSec: 0.2, source: "angle", detail: `段落边界 ${round(boundary)}s 切景别（伪机位）` });
        last = boundary;
      }
    }
  }

  // 空窗补齐：按 targetGapSec 扫，空窗里没有事件就用关键词强调（若该空窗有锚点）或景别切换补
  /**
   * 逐轮补缺：一次只补一个事件，然后**重算空窗**再补——一段 40s 的空白需要 5–6 个事件，
   * 一次补一个就以为"补完了"是密度体检最容易自欺的地方（本机实测：只补一个时最大空窗仍有 39.8s）。
   * 上限 `maxRounds` 防止病态输入死循环。
   */
  const maxRounds = 200;
  for (let pass = 0; pass < maxRounds; pass += 1) {
    const gaps = findGaps(input.durationSeconds, events.map((event) => ({
      start: event.at,
      end: event.at + Math.max(0.2, event.durationSec),
    })));
    const worst = gaps.filter((gap) => gap.seconds > options.targetGapSec + 0.001).sort((a, b) => b.seconds - a.seconds)[0];
    if (!worst) break;
    /** 落点：空窗内最靠前、且离窗口起点 ≥ targetGapSec 的段边界；没有边界就落在窗口内第一个 6s 刻度上 */
    const preferred = worst.start + options.targetGapSec;
    const boundary = boundaries.find((value) => value >= preferred && value < worst.end - 0.3)
      ?? boundaries.find((value) => value > worst.start + 0.5 && value < worst.end - 0.3);
    const at = boundary ?? round(Math.min(worst.end - 0.3, preferred));
    add({ kind: "angle-switch", at, durationSec: 0.2, source: "angle", detail: `空窗 ${round(worst.seconds)}s 补景别切换（缺口 ${round(worst.start)}–${round(worst.end)}s）` });
  }

  events.sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind));
  events.forEach((event, index) => { event.id = `att-${String(index + 1).padStart(3, "0")}`; });
  const sfx = planAttentionSfx(events, options);
  const audit = auditAttention({
    durationSeconds: input.durationSeconds,
    events,
    cards: input.cards ?? [],
    /** 体检用"筛选后的强调点"，不是原始检测结果——否则密度永远显示超标（自欺式告警） */
    keywords,
    options,
  });
  const notes = [
    `排期：${events.length} 个视觉事件 · ${sfx.length} 个音效点位（本地合成，无版权风险）`,
    `关键词：检测 ${(input.keywords ?? []).length} 个锚点 → 强调 ${keywords.length} 个（丢弃 ${emphasis.dropped.length} 个：${emphasis.dropped.slice(0, 6).map((span) => span.text).join("、")}${emphasis.dropped.length > 6 ? "…" : ""}）`,
    `密度口径：目标间隔 ${options.targetGapSec}s（行业 5–7s），最大空窗 ${options.maxGapSec}s 进咨询项`,
    "卡片密度由内容决定（清单/数字/抽象名词/长铺垫四处），不由密度反推硬塞",
  ];
  return {
    schemaVersion: "workloom.video-edit/attention-plan/v1",
    generatedFor: { timelineId: input.timelineId ?? null, durationSeconds: round(input.durationSeconds), platform: input.platform ?? null },
    options: {
      targetGapSec: options.targetGapSec,
      maxGapSec: options.maxGapSec,
      angleEverySec: options.angleEverySec,
      hookCardSec: options.hookCardSec,
      maxCards: options.maxCards,
      keywordPerMinute: options.keywordPerMinute,
    },
    keywords,
    events,
    sfx,
    audit,
    notes,
  };
}

/** 空窗：给定区间与事件占用，返回没有被任何事件覆盖的区间（>0.05s） */
export function findGaps(durationSeconds: number, spans: Array<{ start: number; end: number }>): AttentionGap[] {
  const merged = spans
    .map((span) => ({ start: Math.max(0, span.start), end: Math.min(durationSeconds, span.end) }))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start);
  const gaps: AttentionGap[] = [];
  let cursor = 0;
  for (const span of merged) {
    if (span.start > cursor + 0.05) gaps.push({ start: round(cursor), end: round(span.start), seconds: round(span.start - cursor) });
    cursor = Math.max(cursor, span.end);
  }
  if (durationSeconds - cursor > 0.05) {
    gaps.push({ start: round(cursor), end: round(durationSeconds), seconds: round(durationSeconds - cursor) });
  }
  return gaps;
}

/** 体检：覆盖率 / 最大空窗 / 关键词密度 / 卡片约束 / 同刻多主事件（硬项） */
export function auditAttention(input: {
  durationSeconds: number;
  events: AttentionEvent[];
  cards?: AttentionCardPlan[];
  keywords?: AttentionSpan[];
  options?: AttentionOptions;
}): AttentionAudit {
  const options = { ...DEFAULT_OPTIONS, ...(input.options ?? {}) } as AttentionOptions & typeof DEFAULT_OPTIONS;
  const duration = Math.max(0.001, input.durationSeconds);
  const windowSeconds = options.targetGapSec;
  const windows: AttentionWindow[] = [];
  const count = Math.max(1, Math.ceil(duration / windowSeconds));
  for (let index = 0; index < count; index += 1) {
    const start = round(index * windowSeconds);
    const end = round(Math.min(duration, start + windowSeconds));
    const eventIds = input.events
      .filter((event) => event.at < end && event.at + Math.max(0.2, event.durationSec) > start)
      .map((event) => event.id);
    windows.push({ index, start, end, eventIds, covered: eventIds.length > 0 });
  }
  const windowsCovered = windows.filter((window) => window.covered).length;
  const coverageRate = round(windowsCovered / windows.length, 3);
  const occupied = input.events.map((event) => ({ start: event.at, end: event.at + Math.max(0.2, event.durationSec) }));
  const gaps = findGaps(duration, occupied);
  const maxGapSeconds = gaps.reduce((max, gap) => Math.max(max, gap.seconds), 0);
  const keywords = input.keywords ?? [];
  const keywordPerMinute = round((keywords.length / duration) * 60, 2);
  const cards = input.cards ?? [];
  /** 同一张卡的"分阶段亮"（id-s1/s2/s3）算一张：计数失真会让"卡片太多"变成假警报 */
  const baseId = (id: string): string => id.replace(/-s?[0-9]+$/u, "");
  const distinct = (list: AttentionCardPlan[]): AttentionCardPlan[] => {
    const seen = new Map<string, AttentionCardPlan>();
    for (const card of list) if (!seen.has(baseId(card.id))) seen.set(baseId(card.id), card);
    return [...seen.values()];
  };
  const knowledgeCards = distinct(cards.filter((card) => card.kind === "knowledge-card" || card.kind === "lower-third"));
  const fullCards = distinct(cards.filter((card) => card.kind === "full-card"));

  const hardFailures: string[] = [];
  const advisories: string[] = [];

  // 硬项 1：同一时刻两个"盖画面"的主事件
  const mainEvents = input.events.filter((event) => MAIN_EVENT_KINDS.has(event.kind));
  for (let i = 0; i < mainEvents.length; i += 1) {
    for (let j = i + 1; j < mainEvents.length; j += 1) {
      const a = mainEvents[i]!;
      const b = mainEvents[j]!;
      const aEnd = a.at + Math.max(0.2, a.durationSec);
      const bEnd = b.at + Math.max(0.2, b.durationSec);
      if (a.at < bEnd - 0.02 && b.at < aEnd - 0.02) {
        hardFailures.push(`同刻两个主事件：${a.id}(${a.kind}@${a.at}) 与 ${b.id}(${b.kind}@${b.at}) 重叠`);
      }
    }
  }
  // 硬项 2：卡片自带 layout 时必须在安全区
  for (const card of cards) {
    if (!card.layout) continue;
    const fit = cardFitsSafeArea(card.layout, { ...options, allowFullBleed: card.kind === "full-card" });
    if (!fit.ok) hardFailures.push(`卡片 ${card.id} 越界：${fit.reasons.join("；")}`);
  }

  // 咨询项：覆盖率、最大空窗、关键词密度、卡片数量与时长
  if (coverageRate < 0.85) advisories.push(`视觉事件覆盖率 ${(coverageRate * 100).toFixed(0)}% < 85%（建议在空窗补景别切换或关键词强调）`);
  if (maxGapSeconds > options.maxGapSec + 0.001) advisories.push(`最大空窗 ${maxGapSeconds}s > ${options.maxGapSec}s（观众在这段没有新视觉）`);
  if (keywordPerMinute < options.keywordPerMinute.min) advisories.push(`关键词锚点 ${keywordPerMinute}/分钟 < ${options.keywordPerMinute.min}（划重点偏少）`);
  if (keywordPerMinute > options.keywordPerMinute.max) advisories.push(`关键词锚点 ${keywordPerMinute}/分钟 > ${options.keywordPerMinute.max}（重点过多=没有重点）`);
  if (knowledgeCards.length > options.maxCards) advisories.push(`知识卡 ${knowledgeCards.length} 张 > 上限 ${options.maxCards}`);
  const cardDuration = options.cardDuration ?? { min: 1.5, max: 3 };
  for (const card of knowledgeCards) {
    const seconds = card.end - card.start;
    if (seconds < cardDuration.min - 0.001 || seconds > cardDuration.max + 0.001) {
      advisories.push(`卡片 ${card.id} 停留 ${round(seconds)}s 超出建议带 ${cardDuration.min}–${cardDuration.max}s`);
    }
  }
  const fullCardDuration = options.fullCardDuration ?? { min: 3, max: 5 };
  for (const card of fullCards) {
    const seconds = card.end - card.start;
    if (seconds < fullCardDuration.min - 0.001 || seconds > fullCardDuration.max + 0.001) {
      advisories.push(`全屏字卡 ${card.id} 停留 ${round(seconds)}s 超出建议带 ${fullCardDuration.min}–${fullCardDuration.max}s（全屏卡只有"唯一最重要的点"才用）`);
    }
  }
  if (fullCards.length > (options.maxFullCards ?? 1)) advisories.push(`全屏字卡 ${fullCards.length} 张 > ${options.maxFullCards ?? 1}（用多了就失去"清屏强调"的分量）`);
  const hookWindow = options.hookWindowSec ?? 2;
  const earlyEvents = input.events.filter((event) => event.at < hookWindow && event.kind !== "hook-card" && event.kind !== "sfx");
  if (earlyEvents.length > 0) advisories.push(`前 ${hookWindow}s 出现非钩子事件 ${earlyEvents.length} 个：钩子窗口应保持干净`);

  return {
    ok: hardFailures.length === 0,
    hardFailures,
    advisories,
    metrics: {
      durationSeconds: round(duration),
      windowSeconds,
      windows: windows.length,
      windowsCovered,
      coverageRate,
      maxGapSeconds: round(maxGapSeconds),
      keywordCount: keywords.length,
      keywordPerMinute,
      cards: knowledgeCards.length,
      fullCards: fullCards.length,
      angleSwitches: input.events.filter((event) => event.kind === "angle-switch").length,
      sfxCount: input.events.filter((event) => event.kind === "sfx").length,
      firstHookWindowClean: earlyEvents.length === 0,
    },
    windows,
    gaps,
  };
}
