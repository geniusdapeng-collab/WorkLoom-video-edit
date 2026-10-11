/**
 * edit/talk.ts —— AI 口播精剪（talking-head）确定性内核
 *
 * 口播（对着镜头说话）与"素材重组式剪辑"的差别：一条长镜头里全是同一个人、同一机位，
 * 剪辑动作不是"选哪条素材"，而是"这一句留不留、这个停顿留多长、这个语气词删不删"。
 * 本模块把这类判断做成可复算的纯函数：
 *
 *   ① 逐字稿标记：语气词 / 停顿 / 重复 / 卡壳 / 口误自纠（`analyzeTalkTranscript`）；
 *   ② 情绪与活人感：句级语速-能量-停顿画像 + 情绪峰值 + 活人感信号（`buildEmotionCurve`）；
 *   ③ 剪取决策：删什么、保什么、每个决定带理由与"人味价值"（`planTalkCut`）；
 *   ④ 交付物：帧级时间轴（含跳切遮盖 punch-in）、逐字字幕、口播质检（`buildTalkTimeline` /
 *      `buildTalkCaptions` / `validateTalkCut`）。
 *
 * 三条产品纪律（与 docs/talking-head-pipeline.md、skills/talk-cutting 同口径）：
 *   1. **逐字为是**：字幕与文案必须来自逐字稿原文，禁止"润色成书面语"（要改字必须显式授权）；
 *   2. **不追求完美**：删的是"伤理解"的东西（死停、卡壳、无信息重复），留的是"像人"的东西
 *      （换气、笑声、自问自答、口误后自纠）——删得越干净，片子越像 AI 念稿；
 *   3. **每个删除可追溯**：任何 cut/trim 都必须带理由、时间码与人味价值，否则视为未决策。
 *
 * 失败语义：输入非法（时间码越界/词区间倒置/空逐字稿）直接抛错，不静默跳过——剪口播最贵的
 * 返工是"剪断半句话"，宁可在决策层报错，也不要在成片里发现。
 */

import { srtTimestamp } from "./caption.js";

/* ============================ 基础类型 ============================ */

/** 词级转写单元（时间码为源素材秒数） */
export interface TalkWord {
  text: string;
  start: number;
  end: number;
}

/** 句级转写单元（句内带词级时间戳） */
export interface TalkSentence {
  id: string;
  text: string;
  start: number;
  end: number;
  pauseAfterSeconds?: number | null;
  words: TalkWord[];
}

export type TalkFillerKind = "hesitation" | "discourse";

export interface TalkMarker {
  id: string;
  /** 源素材时间区间（秒） */
  start: number;
  end: number;
  /** 该标记的原文（用于字幕一致性与人工复核） */
  text: string;
}

export interface TalkFillerMark extends TalkMarker {
  kind: TalkFillerKind;
  /** 可删性（0–1）：0.3 = 语篇连接词（删了容易断气），0.9 = 纯填充（删了更利落） */
  removability: number;
}

export type TalkPauseKind = "breath" | "thinking" | "dead";

export interface TalkPauseMark extends TalkMarker {
  kind: TalkPauseKind;
  durationSeconds: number;
  /** 句间停顿（true）还是句内停顿（false）——句间停顿优先保留（换气/段落感） */
  betweenSentences: boolean;
}

export type TalkRepetitionKind = "word-repeat" | "phrase-repeat" | "restart" | "rhetorical";

export interface TalkRepetitionMark extends TalkMarker {
  kind: TalkRepetitionKind;
  /** 重复单元的词数（1 = 单字/单词重复） */
  unitWords: number;
  /** 重复次数（≥2） */
  times: number;
  /** 两次重复之间的间隔（秒）：越小越像卡壳/口头禅，越大越像"重录一遍" */
  gapSeconds: number;
  /** 建议保留哪一次（rhetorical 保留全部） */
  keepOccurrence: "first" | "last" | "all";
}

export interface TalkSelfCorrectionMark extends TalkMarker {
  /** 自纠提示词（"不对""我是说""应该是"…） */
  cue: string;
  /** 被纠正的原文（错的那一句） */
  mistaken: string;
  /** 纠正后的原文 */
  corrected: string;
  /** 整段自纠的时长（秒）：太长会拖慢节奏 */
  durationSeconds: number;
}

export interface TalkBlock {
  id: string;
  /** 话题块标题（取块内首句前 14 字，供人工勾选与多片拆分命名） */
  title: string;
  start: number;
  end: number;
  sentenceIds: string[];
  /** 话题切换是否由显式连接词触发（第一个/接下来/最后/另外…） */
  cue: string | null;
}

export interface TalkTranscriptStats {
  wordCount: number;
  sentenceCount: number;
  speechSeconds: number;
  /** 语气词数量与占比（占词数） */
  fillerCount: number;
  fillerRate: number;
  /** 停顿总秒数与死停秒数（>1.2s） */
  pauseSeconds: number;
  deadAirSeconds: number;
  /** 有效语速（字/分钟，按讲话净时长，不含停顿） */
  wpm: number;
}

export interface TalkAnalysis {
  fillers: TalkFillerMark[];
  pauses: TalkPauseMark[];
  repetitions: TalkRepetitionMark[];
  selfCorrections: TalkSelfCorrectionMark[];
  blocks: TalkBlock[];
  stats: TalkTranscriptStats;
}

/* ============================ 词表与阈值 ============================ */

/**
 * 语气词/口头语词表。**不是"见到就删"**：词表只负责"标记"，删不删由决策树按语境判
 * （见 planTalkCut）。`removability` 是默认可删性，语篇连接词（然后/其实/就是）删了容易断气，
 * 所以给低分；纯填充（嗯/呃/啊）给高分。
 */
const FILLER_LEXICON: Record<string, { kind: TalkFillerKind; removability: number }> = {
  嗯: { kind: "hesitation", removability: 0.85 },
  呃: { kind: "hesitation", removability: 0.9 },
  唔: { kind: "hesitation", removability: 0.9 },
  啊: { kind: "hesitation", removability: 0.7 },
  哎: { kind: "hesitation", removability: 0.7 },
  唉: { kind: "hesitation", removability: 0.5 },
  哦: { kind: "hesitation", removability: 0.7 },
  这个: { kind: "discourse", removability: 0.6 },
  那个: { kind: "discourse", removability: 0.6 },
  就是: { kind: "discourse", removability: 0.45 },
  然后: { kind: "discourse", removability: 0.3 },
  其实: { kind: "discourse", removability: 0.35 },
  反正: { kind: "discourse", removability: 0.4 },
  就是说: { kind: "discourse", removability: 0.45 },
  怎么说呢: { kind: "discourse", removability: 0.6 },
  对不对: { kind: "discourse", removability: 0.55 },
  是吧: { kind: "discourse", removability: 0.55 },
  嘛: { kind: "discourse", removability: 0.5 },
  呢: { kind: "discourse", removability: 0.4 },
  吧: { kind: "discourse", removability: 0.4 },
};

/** 话题切换连接词（话题块切分用；不是语气词） */
const TOPIC_CUES = [
  "第一个", "第二", "第三", "首先", "其次", "接下来", "然后我们", "最后", "另外", "再一个", "总结一下", "所以说", "回到刚才",
];

/** 自纠提示词（命中即认为说话人意识到前面说错了，属于"活人感"高价值区） */
const SELF_CORRECTION_CUES = [
  "不对", "不是", "我是说", "应该是", "准确说", "更准确地说", "重新说", "说错了", "换句话说", "或者说", "纠正一下",
];

export const TALK_DEFAULTS = {
  /** 停顿分级（秒）：<breath 保留；breath–thinking 保留；thinking–dead 压缩；>dead 死停 */
  pauseBreathSeconds: 0.28,
  pauseThinkingSeconds: 0.65,
  pauseDeadSeconds: 1.2,
  /** 死停压缩后的保留时长（秒）：保留一点气口，避免"机器式无缝" */
  deadAirKeepSeconds: 0.4,
  /** 思考型停顿压缩后的保留时长（秒） */
  thinkingKeepSeconds: 0.5,
  /** 自纠/情绪峰值附近的停顿保留时长（秒）：留白比剪干净更有感染力 */
  protectedPauseKeepSeconds: 0.75,
  /** 语气词保留率下限：低于它 = 删过头（片子发假），需要人审放行 */
  fillerKeepRateFloor: 0.2,
  /** 停顿保留率下限（保留秒数 / 原停顿秒数）：全剪光会失去呼吸感 */
  pauseKeepRateFloor: 0.15,
  /** 连续单字重复达到该次数即判卡壳 */
  stumbleRepeatTimes: 3,
  /** 重复检测窗口（秒）：同一单元在该窗口内再次出现视为重复 */
  repetitionWindowSeconds: 3.5,
  /** 修辞性重复的判定间隔上限（秒）：一口气复述 = 强调，长时间后再提 = 重录 */
  rhetoricalGapSeconds: 0.5,
  /** 话题块最大时长（秒）：超过即强制切块，便于多片拆分 */
  blockMaxSeconds: 45,
  /** 情绪峰值分位（句级强度分位 ≥ 该值且为局部最大才算峰值） */
  emotionPeakPercentile: 0.85,
  /** 平滑风险告警阈值（0–1，越高越像"AI 念稿"） */
  smoothingRiskWarn: 0.7,
  /**
   * 口播单段最短时长（秒）：与时间轴硬闸 `MIN_SEGMENT_SECONDS=0.4` 对齐。
   * 旧值 0.3 会产出 0.3–0.39s 的"合法碎片"，被时间轴校验直接拒绝（实测：一句"就是"就让整条链路 ok:false）。
   */
  minSegmentSeconds: 0.4,
} as const;

/* ============================ 工具函数 ============================ */

const round = (value: number, digits = 3): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** 归一化文本：去空白与标点（用于逐字一致比对，不改变任何汉字/字母/数字） */
export function normalizeTalkText(text: string): string {
  /**
   * 本机生产补丁（2026-10-11）：数字/字母之间的点必须保留。
   * 旧实现一律去标点，把模型名 "V4.1 Flash" 变成 "V41Flash"——这不是排版风格问题，是改事实。
   * 与字幕工位 `stripSubtitlePunctuation`（NUMERIC_INFIX 保留小数点）的口径保持一致。
   */
  const DOT = "\u0001";
  return text
    .replace(/(?<=[0-9A-Za-z])\.(?=[0-9A-Za-z])/gu, DOT)
    .replace(/[\s，。！？、,.!?;；:："'“”‘’()（）\[\]【】…—\-·~@#$%^&*+=|\\/<>{}]/gu, "")
    .replaceAll(DOT, ".");
}

const textLength = (text: string): number => [...normalizeTalkText(text)].length;

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index]!;
}

function assertSentence(sentence: TalkSentence, index: number): void {
  if (!sentence.id) throw new Error(`第 ${index + 1} 句缺 id（逐字稿必须可追溯到句）`);
  if (!(sentence.end > sentence.start)) throw new Error(`句子 ${sentence.id} 时间区间非法：${sentence.start}–${sentence.end}`);
  for (const [wordIndex, word] of sentence.words.entries()) {
    if (!(word.end > word.start)) throw new Error(`句子 ${sentence.id} 第 ${wordIndex + 1} 个词区间非法：${word.start}–${word.end}`);
    if (word.start < sentence.start - 0.05 || word.end > sentence.end + 0.05) {
      throw new Error(`句子 ${sentence.id} 的词「${word.text}」越出句区间（${word.start}–${word.end}，句 ${sentence.start}–${sentence.end}）`);
    }
  }
}

/** 扁平化词表（按时间排序；词级决策与停顿检测都基于它） */
export function flattenTalkWords(sentences: TalkSentence[]): TalkWord[] {
  return sentences.flatMap((sentence) => sentence.words.map((word) => ({ ...word }))).sort((a, b) => a.start - b.start);
}

/**
 * 词表 → 句子：ASR 引擎只给词级时间戳时用它断句。
 *
 * 断句纪律（口播）：优先按"气口"（词间停顿 ≥ pauseSeconds）切；连续说话没有气口时按字数上限
 * 兜底切分（maxChars），但**不允许切在未闭合的引号/括号里**——口播字幕按句绑定，
 * 半句话进字幕是返修单里最贵的一类。
 */
export function splitTalkSentences(
  words: TalkWord[],
  options: { pauseSeconds?: number; maxChars?: number; firstId?: number } = {},
): TalkSentence[] {
  const pauseSeconds = options.pauseSeconds ?? 0.45;
  const maxChars = options.maxChars ?? 42;
  const sentences: TalkSentence[] = [];
  let current: TalkWord[] = [];
  let counter = options.firstId ?? 1;
  const unclosed = (text: string): boolean => {
    const pairs: Array<[string, string]> = [["「", "」"], ["“", "”"], ["（", "）"], ["(", ")"], ["《", "》"]];
    return pairs.some(([open, close]) => text.split(open).length !== text.split(close).length);
  };
  const flush = () => {
    if (current.length === 0) return;
    const first = current[0]!;
    const last = current[current.length - 1]!;
    sentences.push({
      id: `s${String(counter).padStart(3, "0")}`,
      text: current.map((word) => word.text).join(""),
      start: round(first.start),
      end: round(last.end),
      pauseAfterSeconds: null,
      words: current.map((word) => ({ ...word })),
    });
    counter += 1;
    current = [];
  };
  for (const [index, word] of words.entries()) {
    current.push(word);
    const next = words[index + 1];
    const gap = next ? next.start - word.end : Number.POSITIVE_INFINITY;
    const text = current.map((entry) => entry.text).join("");
    const chars = textLength(text);
    if (gap >= pauseSeconds || (chars >= maxChars && !unclosed(text))) flush();
  }
  flush();
  return sentences.map((sentence, index) => {
    const next = sentences[index + 1];
    return {
      ...sentence,
      pauseAfterSeconds: next ? round(Math.max(0, next.start - sentence.end)) : 0,
    };
  });
}

/** 逐字稿文档（执行器产物契约：bundles/video-edit/schemas/talk-transcript.schema.json 同口径） */
export interface TalkTranscriptDoc {
  schemaVersion: "workloom.video-edit/talk-transcript/v1";
  asset: {
    assetId: string;
    sha256: string;
    path: string;
    durationSeconds: number | null;
    fps: number | null;
    language: string;
  };
  backend: {
    channel: "imported" | "local-mlx" | "engine-http";
    engine: string | null;
    precision: "word" | "segment" | "none";
    engineNote?: string | null;
  };
  sentences: TalkSentence[];
  words: TalkWord[];
  blocks: TalkBlock[];
  marks: {
    fillers: TalkFillerMark[];
    pauses: TalkPauseMark[];
    repetitions: TalkRepetitionMark[];
    selfCorrections: TalkSelfCorrectionMark[];
  };
  stats: TalkTranscriptStats;
}

/** 组装逐字稿文档（执行器只做 IO，结构在这里定） */
export function buildTalkTranscriptDoc(input: {
  sentences: TalkSentence[];
  asset: TalkTranscriptDoc["asset"];
  backend: TalkTranscriptDoc["backend"];
  analysis?: TalkAnalysis;
}): TalkTranscriptDoc {
  const analysis = input.analysis ?? analyzeTalkTranscript(input.sentences);
  return {
    schemaVersion: "workloom.video-edit/talk-transcript/v1",
    asset: input.asset,
    backend: input.backend,
    sentences: input.sentences,
    words: flattenTalkWords(input.sentences),
    blocks: analysis.blocks,
    marks: {
      fillers: analysis.fillers,
      pauses: analysis.pauses,
      repetitions: analysis.repetitions,
      selfCorrections: analysis.selfCorrections,
    },
    stats: analysis.stats,
  };
}

/** 从逐字稿文档还原 TalkAnalysis（执行器读回产物时用，避免把标记与句表混成两套事实） */
export function analysisFromTranscriptDoc(doc: TalkTranscriptDoc): TalkAnalysis {
  const base = {
    fillers: doc.marks.fillers,
    pauses: doc.marks.pauses,
    repetitions: doc.marks.repetitions,
    selfCorrections: doc.marks.selfCorrections,
    blocks: doc.blocks,
  };
  return { ...base, stats: doc.stats };
}

/* ============================ ① 逐字稿标记 ============================ */

/** 语气词标记：命中词表才标记；不判断删留（那是 planTalkCut 的事） */
export function detectTalkFillers(words: TalkWord[]): TalkFillerMark[] {
  const marks: TalkFillerMark[] = [];
  for (const [index, word] of words.entries()) {
    const entry = FILLER_LEXICON[word.text.trim()];
    if (!entry) continue;
    marks.push({
      id: `filler-${String(index).padStart(4, "0")}`,
      text: word.text,
      start: round(word.start),
      end: round(word.end),
      kind: entry.kind,
      removability: entry.removability,
    });
  }
  return marks;
}

/**
 * 停顿标记：取"相邻词之间的空档"与"句末到下句首的空档"。
 * 分级：breath（换气，保留）/ thinking（思考，压缩）/ dead（死停，压缩）。
 *
 * 2026-10-11 修复：**片头静音**（0s → 第一句话）也纳入停顿标记。
 * 旧实现只看词与词之间的空档，随手拍常见的"开头 2–5 秒没说话"会原样进片；
 * 实测里 2s 片头静音被完整保留，与"死停压缩到 0.4s、钩子画面干净"的口径冲突。
 * 片尾静音不在本函数处理：planTalkCut 的 deadline 落在最后一句话末尾，尾部天然不保留。
 */
export function detectTalkPauses(
  sentences: TalkSentence[],
  options: { minPauseSeconds?: number } = {},
): TalkPauseMark[] {
  const minPause = options.minPauseSeconds ?? TALK_DEFAULTS.pauseBreathSeconds;
  const marks: TalkPauseMark[] = [];
  /**
   * 句子归属按"词的中点"判定：相邻句在时间上首尾相接时（前句 end = 后句 start），
   * 用端点判定会把后句的首词误判成前句的词，进而漏掉"句间停顿"。
   */
  const sentenceAt = (midpoint: number): string | null => {
    for (const sentence of sentences) if (midpoint >= sentence.start - 0.02 && midpoint <= sentence.end + 0.02) return sentence.id;
    return null;
  };
  const push = (start: number, end: number, betweenSentences: boolean) => {
    const duration = end - start;
    if (duration < minPause) return;
    const kind: TalkPauseKind = duration >= TALK_DEFAULTS.pauseDeadSeconds
      ? "dead"
      : duration >= TALK_DEFAULTS.pauseThinkingSeconds ? "thinking" : "breath";
    marks.push({
      id: `pause-${String(marks.length).padStart(4, "0")}`,
      text: "（停顿）",
      start: round(start),
      end: round(end),
      kind,
      durationSeconds: round(duration),
      betweenSentences,
    });
  };
  const words = flattenTalkWords(sentences);
  if (words.length > 0 && words[0]!.start >= minPause) {
    push(0, words[0]!.start, true);
  }
  for (let i = 1; i < words.length; i += 1) {
    const previous = words[i - 1]!;
    const current = words[i]!;
    const gap = current.start - previous.end;
    if (gap < minPause) continue;
    const previousSentence = sentenceAt((previous.start + previous.end) / 2);
    const currentSentence = sentenceAt((current.start + current.end) / 2);
    push(previous.end, current.start, Boolean(previousSentence && currentSentence && previousSentence !== currentSentence));
  }
  return marks;
}

interface Occurrence {
  index: number;
  start: number;
  end: number;
  text: string;
}

function findOccurrences(words: TalkWord[], unit: number): Occurrence[] {
  const occurrences: Occurrence[] = [];
  for (let i = 0; i + unit <= words.length; i += 1) {
    const slice = words.slice(i, i + unit);
    const text = slice.map((word) => word.text).join("");
    if (!text) continue;
    occurrences.push({ index: i, start: slice[0]!.start, end: slice[slice.length - 1]!.end, text });
  }
  return occurrences;
}

/**
 * 重复标记：
 *   · word-repeat：同一个词/字相邻重复（"我我"）；
 *   · phrase-repeat：同一词组（2–4 词）在窗口内重复（"这个产品… 这个产品…"）；
 *   · rhetorical：一口气紧挨着复述（修辞性强调，如"很重要，很重要"）——**保留**。
 */
export function detectTalkRepetitions(
  sentences: TalkSentence[],
  options: { windowSeconds?: number } = {},
): TalkRepetitionMark[] {
  const windowSeconds = options.windowSeconds ?? TALK_DEFAULTS.repetitionWindowSeconds;
  const words = flattenTalkWords(sentences);
  const marks: TalkRepetitionMark[] = [];
  const claimed = new Set<number>();
  /**
   * 先扫"单个词连续重复"（"我我我"这类卡壳）：必须在大单元之前处理，
   * 否则 "我我我" 会被 unit=2 抢先判成两次 "我我" 的词组重复，卡壳强度被稀释。
   */
  let cursor = 0;
  while (cursor < words.length) {
    const text = words[cursor]!.text;
    let run = 1;
    while (
      cursor + run < words.length
      && words[cursor + run]!.text === text
      && words[cursor + run]!.start - words[cursor + run - 1]!.end <= windowSeconds
    ) {
      run += 1;
    }
    if (run >= 2) {
      for (let i = cursor; i < cursor + run; i += 1) claimed.add(i);
      const first = words[cursor]!;
      const last = words[cursor + run - 1]!;
      const gapSeconds = round(Math.max(0, words[cursor + 1]!.start - first.end));
      /**
       * 单字重复（"我我我"）= 卡壳；整词重复两遍且紧挨着（"很重要，很重要"）= 修辞强调。
       * 区分标准是"被重复单元的长度 + 间隔"：越短越像找词，越长越像有意强调。
       */
      const singleChar = textLength(text) === 1;
      /** 语气词自身的重复（"这个这个"/"嗯嗯"）是口头禅，不是修辞；只有实词复述才算强调。 */
      const fillerToken = Boolean(FILLER_LEXICON[text]);
      const rhetorical = !singleChar && !fillerToken && run === 2 && gapSeconds <= TALK_DEFAULTS.rhetoricalGapSeconds;
    marks.push({
      id: `repeat-${String(marks.length).padStart(4, "0")}`,
      text,
      start: round(first.start),
      end: round(last.end),
      kind: rhetorical ? "rhetorical" : "word-repeat",
      unitWords: 1,
      times: run,
      gapSeconds,
      /**
       * 保留哪一次要与**语气词口径**一致：填充词连续重复是卡壳/口头禅，只留第一次
       * （skills/talk-cutting）；实词重复才是"重说一遍"，留更完整的最后一次。
       * 旧实现一律 "last"，与语气词"只留第一次"打架——实测里被判定"保留"的语气词又被重复处理器删掉。
       */
      keepOccurrence: rhetorical ? "all" : fillerToken ? "first" : "last",
      });
    }
    cursor += run;
  }
  for (const unit of [4, 3, 2]) {
    const occurrences = findOccurrences(words, unit);
    for (let i = 0; i < occurrences.length; i += 1) {
      const first = occurrences[i]!;
      if (claimed.has(first.index)) continue;
      let times = 1;
      let last = first;
      let j = i + 1;
      while (j < occurrences.length) {
        const candidate = occurrences[j]!;
        if (candidate.text !== first.text) break;
        if (candidate.start - last.end > windowSeconds) break;
        if (claimed.has(candidate.index)) break;
        times += 1;
        last = candidate;
        j += 1;
      }
      if (times < 2) continue;
      for (let k = i; k < i + times; k += 1) claimed.add(occurrences[k]!.index);
      const gapSeconds = round(Math.max(0, last.start - first.end));
      const consecutive = gapSeconds <= TALK_DEFAULTS.rhetoricalGapSeconds;
      /** 整段都是语气词的复述（"这个那个这个那个"）不构成修辞强调。 */
      const allFiller = words.slice(first.index, first.index + unit).every((word) => Boolean(FILLER_LEXICON[word.text]));
      const rhetorical = unit >= 2 && consecutive && !allFiller;
      const kind: TalkRepetitionKind = rhetorical ? "rhetorical" : "phrase-repeat";
    marks.push({
      id: `repeat-${String(marks.length).padStart(4, "0")}`,
      text: first.text,
      start: round(first.start),
      end: round(last.end),
      kind,
      unitWords: unit,
      times,
      gapSeconds,
      keepOccurrence: rhetorical ? "all" : allFiller ? "first" : "last",
    });
    }
  }
  return marks.sort((a, b) => a.start - b.start);
}

/**
 * 口误自纠标记：命中提示词（不对/我是说/应该是…）→ 把提示词之前一小段视作"被纠正的原文"，
 * 提示词之后到句末视作"纠正后的原文"。
 *
 * 为什么单独建模：自纠是**活人感的高价值证据**（听众会觉得"他是真的在想"），
 * 默认策略是保留（只压缩中间的死停），而不是像卡壳一样删掉。
 */
export function detectTalkSelfCorrections(
  sentences: TalkSentence[],
  pauses: TalkPauseMark[] = [],
): TalkSelfCorrectionMark[] {
  const marks: TalkSelfCorrectionMark[] = [];
  const words = flattenTalkWords(sentences);
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const cue = SELF_CORRECTION_CUES.find((candidate) => word.text === candidate || word.text.startsWith(candidate));
    if (!cue) continue;
    /** 已落在某个自纠区间内的提示词不再重复建标记（"不对…我是说…"只记一条）。 */
    if (marks.some((mark) => word.start >= mark.start - 0.02 && word.start <= mark.end + 0.02)) continue;
    /**
     * 句子归属用"词的中点"判定，并在多句命中时取最靠后的一句：
     * 相邻句首尾相接时，后句的首词（如"不对"）不能被误判成前句的词，否则自纠标记会被跳过。
     */
    const mid = (word.start + word.end) / 2;
    const candidates = sentences.filter((entry) => mid >= entry.start - 0.02 && mid <= entry.end + 0.02);
    const sentence = candidates.length > 0 ? candidates[candidates.length - 1] : undefined;
    if (!sentence) continue;
    /**
     * 被纠正的原文允许跨句往回取（"上一句说错了，不对"是口播里最常见的形态），
     * 但窗口**最多回到上一句开头**（缺上一句时取前 6 秒）且最多 10 个词——
     * 窗口一放开就会把整段话都划成"错句"，保护窗口过大反而让该删的语气词删不掉。
     */
    const sentenceIndex = sentences.indexOf(sentence);
    const previousSentence = sentences[sentenceIndex - 1];
    const windowStart = Math.max(word.start - 6, previousSentence ? previousSentence.start : Number.NEGATIVE_INFINITY);
    const mistakenWords = words
      .filter((entry) => entry.end <= word.start + 0.02 && entry.start >= windowStart)
      .slice(-10);
    const correctedWords = words.filter((entry) => entry.start >= word.end - 0.02 && entry.start <= sentence.end + 0.02);
    if (mistakenWords.length === 0 || correctedWords.length === 0) continue;
  const start = mistakenWords[0]!.start;
  const lastCorrected = correctedWords[correctedWords.length - 1]!;
  const mistakenIndex = words.indexOf(mistakenWords[0]!);
  const correctedIndex = words.indexOf(lastCorrected);
  marks.push({
    id: `selfcorr-${String(marks.length).padStart(3, "0")}`,
    cue,
    text: words.slice(mistakenIndex, correctedIndex + 1).map((entry) => entry.text).join(""),
    mistaken: mistakenWords.map((entry) => entry.text).join(""),
    corrected: correctedWords.map((entry) => entry.text).join(""),
    start: round(start),
    end: round(lastCorrected.end),
    /** 整段自纠的时长（含中间停顿）：start→纠正结束，供剪取时判断"太长会拖节奏"。 */
    durationSeconds: round(lastCorrected.end - start),
  });
  }
  return marks;
}

/** 话题块切分：显式连接词 > 长停顿 > 块内超时（默认 45s） */
export function segmentTalkBlocks(
  sentences: TalkSentence[],
  pauses: TalkPauseMark[] = [],
  options: { maxBlockSeconds?: number } = {},
): TalkBlock[] {
  const maxBlockSeconds = options.maxBlockSeconds ?? TALK_DEFAULTS.blockMaxSeconds;
  const blocks: TalkBlock[] = [];
  let current: TalkSentence[] = [];
  let cue: string | null = null;
  const flush = () => {
    if (current.length === 0) return;
    const first = current[0]!;
    const last = current[current.length - 1]!;
    blocks.push({
      id: `block-${String(blocks.length + 1).padStart(2, "0")}`,
      title: [...normalizeTalkText(first.text)].slice(0, 14).join("") || `块 ${blocks.length + 1}`,
      start: round(first.start),
      end: round(last.end),
      sentenceIds: current.map((sentence) => sentence.id),
      cue,
    });
    current = [];
  };
  for (const sentence of sentences) {
    const hitCue = TOPIC_CUES.find((candidate) => sentence.text.startsWith(candidate) || sentence.text.includes(candidate));
    /**
     * 只有"死停"或显式连接词才算话题切换：思考型停顿（0.65–1.2s）在口播里非常常见，
     * 拿它切块会把一条完整的讲述切成十几个碎块，章节与多片拆分都会失真。
     */
    const boundaryPause = pauses.find((entry) => entry.betweenSentences && Math.abs(entry.end - sentence.start) <= 0.06 && entry.kind === "dead");
    const startNew = current.length > 0 && (Boolean(hitCue) || Boolean(boundaryPause));
    if (startNew) {
      flush();
      cue = hitCue ?? (boundaryPause ? "（长停顿分段）" : null);
    } else if (current.length === 0) {
      cue = hitCue ?? null;
    }
    current.push(sentence);
    const span = current[current.length - 1]!.end - current[0]!.start;
    if (span >= maxBlockSeconds) {
      flush();
      cue = null;
    }
  }
  flush();
  return blocks;
}

export function computeTalkStats(
  sentences: TalkSentence[],
  analysis: Omit<TalkAnalysis, "stats">,
): TalkTranscriptStats {
  const words = flattenTalkWords(sentences);
  const speechSeconds = sentences.reduce((sum, sentence) => sum + (sentence.end - sentence.start), 0);
  const pauseSeconds = analysis.pauses.reduce((sum, pause) => sum + pause.durationSeconds, 0);
  const deadAirSeconds = analysis.pauses
    .filter((pause) => pause.kind === "dead")
    .reduce((sum, pause) => sum + pause.durationSeconds, 0);
  const wordCount = words.length;
  return {
    wordCount,
    sentenceCount: sentences.length,
    speechSeconds: round(speechSeconds),
    fillerCount: analysis.fillers.length,
    fillerRate: wordCount > 0 ? round(analysis.fillers.length / wordCount) : 0,
    pauseSeconds: round(pauseSeconds),
    deadAirSeconds: round(deadAirSeconds),
    wpm: speechSeconds > 0.5 ? Math.round((wordCount / speechSeconds) * 60) : 0,
  };
}

/** 逐字稿一次全量标记（执行器与测试的唯一入口） */
export function analyzeTalkTranscript(
  sentences: TalkSentence[],
  options: { pauses?: TalkPauseMark[]; maxBlockSeconds?: number; repetitionWindowSeconds?: number } = {},
): TalkAnalysis {
  if (sentences.length === 0) throw new Error("逐字稿为空：口播精剪至少需要一句话");
  sentences.forEach(assertSentence);
  const sorted = [...sentences].sort((a, b) => a.start - b.start);
  const pauses = options.pauses ?? detectTalkPauses(sorted);
  const fillers = detectTalkFillers(flattenTalkWords(sorted));
  const repetitions = detectTalkRepetitions(sorted, {
    ...(options.repetitionWindowSeconds !== undefined ? { windowSeconds: options.repetitionWindowSeconds } : {}),
  });
  const selfCorrections = detectTalkSelfCorrections(sorted, pauses);
  const blocks = segmentTalkBlocks(sorted, pauses, {
    ...(options.maxBlockSeconds !== undefined ? { maxBlockSeconds: options.maxBlockSeconds } : {}),
  });
  const base = { fillers, pauses, repetitions, selfCorrections, blocks };
  return { ...base, stats: computeTalkStats(sorted, base) };
}

/* ============================ ② 情绪与活人感 ============================ */

export interface LoudnessLikePoint {
  t: number;
  db: number;
}

export interface TalkProsodySentence {
  sentenceId: string;
  text: string;
  start: number;
  end: number;
  durationSeconds: number;
  /** 语速：字/秒（按句内词时长，不含句末停顿） */
  charsPerSecond: number;
  /** 相对该片语速中位数的倍数（>1 = 比平时快） */
  paceRatio: number;
  /** 句内能量（dB，来自响度包络；无包络时为 null） */
  energyDb: number | null;
  /** 句末停顿（秒） */
  pauseAfterSeconds: number;
  /** 句内最大停顿（秒） */
  maxInnerPauseSeconds: number;
}

export type TalkEmotionLabel =
  | "平静" | "认真" | "兴奋" | "激动" | "温暖" | "低落" | "幽默" | "自嘲" | "无奈" | "笃定" | "疑问" | "感叹" | "其他";

export interface TalkEmotionPoint {
  sentenceId: string;
  t: number;
  /** 唤起度（0–1）：语速 + 能量 + 能量变化合成，纯本地可算 */
  arousal: number;
  /** 效价（−1–1）：只有模型/人工标签通道给出，本地不猜（null 表示未标注） */
  valence: number | null;
  intensity: number;
  label: TalkEmotionLabel | null;
  evidence: string[];
}

export interface TalkEmotionPeak {
  sentenceId: string;
  t: number;
  intensity: number;
  kind: "emotion_peak" | "insight_peak" | "humor_peak";
  reason: string;
}

export interface TalkHumannessSignals {
  /** 笑声/叹气等非语音标记（来自引擎注记或人工标注） */
  laughter: number;
  sighs: number;
  selfCorrections: number;
  /** 修辞性重复（强调） */
  emphasisRepeats: number;
  /** 语速变异系数（越大越"人"，0 = 机器平铺） */
  paceVariation: number;
  /** 动态范围（dB，来自响度包络；无包络 null） */
  loudnessRangeDb: number | null;
}

export interface TalkEmotionDoc {
  schemaVersion: "workloom.video-edit/talk-emotion/v1";
  channel: { acoustic: "local" | "none"; semantic: "model" | "labels" | "none" };
  prosody: { sentences: TalkProsodySentence[]; meanCharsPerSecond: number; paceVariation: number };
  curve: TalkEmotionPoint[];
  peaks: TalkEmotionPeak[];
  humanness: { score: number; signals: TalkHumannessSignals; notes: string[] };
}

export interface TalkEmotionLabelInput {
  sentenceId: string;
  valence?: number | null;
  label?: string | null;
  /** 笑声/叹气的句级注记（模型或人工） */
  laughter?: boolean;
  sigh?: boolean;
}

function energyIn(envelope: LoudnessLikePoint[], start: number, end: number): number | null {
  const hits = envelope.filter((point) => point.t >= start && point.t <= end);
  if (hits.length === 0) return null;
  return round(mean(hits.map((point) => point.db)), 2);
}

function normalizeWithin(values: Array<number | null>): Array<number | null> {
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (present.length < 2) return values.map(() => null);
  const min = Math.min(...present);
  const max = Math.max(...present);
  if (max - min < 1e-6) return values.map((value) => (value === null ? null : 0.5));
  return values.map((value) => (value === null ? null : (value - min) / (max - min)));
}

/** 句级韵律画像（语速/能量/停顿），是情绪曲线的确定性底座 */
export function computeTalkProsody(
  sentences: TalkSentence[],
  options: { envelope?: LoudnessLikePoint[]; pauses?: TalkPauseMark[] } = {},
): { sentences: TalkProsodySentence[]; meanCharsPerSecond: number; paceVariation: number } {
  const pauses = options.pauses ?? [];
  const raw = sentences.map((sentence) => {
    const chars = textLength(sentence.text);
    const inner = sentence.words.length > 0
      ? sentence.words[sentence.words.length - 1]!.end - sentence.words[0]!.start
      : 0;
    const spokenSeconds = inner > 0.2 ? inner : sentence.end - sentence.start;
    const charsPerSecond = spokenSeconds > 0 ? chars / spokenSeconds : 0;
    const innerPauses = pauses.filter((pause) => pause.start >= sentence.start - 0.02 && pause.end <= sentence.end + 0.02);
    return {
      sentenceId: sentence.id,
      text: sentence.text,
      start: round(sentence.start),
      end: round(sentence.end),
      durationSeconds: round(sentence.end - sentence.start),
      charsPerSecond: round(charsPerSecond, 2),
      paceRatio: 1,
      energyDb: options.envelope ? energyIn(options.envelope, sentence.start, sentence.end) : null,
      pauseAfterSeconds: round(Math.max(0, sentence.pauseAfterSeconds ?? 0)),
      maxInnerPauseSeconds: round(innerPauses.reduce((max, pause) => Math.max(max, pause.durationSeconds), 0)),
    };
  });
  const medianPace = median(raw.map((entry) => entry.charsPerSecond).filter((value) => value > 0));
  const withRatio = raw.map((entry) => ({
    ...entry,
    paceRatio: medianPace > 0 ? round(entry.charsPerSecond / medianPace, 2) : 1,
  }));
  const paces = withRatio.map((entry) => entry.charsPerSecond).filter((value) => value > 0);
  const m = mean(paces);
  return {
    sentences: withRatio,
    meanCharsPerSecond: round(m, 2),
    paceVariation: m > 0 ? round(stdDev(paces) / m, 3) : 0,
  };
}

/**
 * 情绪曲线 + 活人感画像。
 *
 * 通道纪律：
 *   · 唤起度（arousal）由本地声学确定（语速/能量/能量变化）——不花模型钱、可复算；
 *   · 效价（valence）与情绪词来自模型或人工标签（`labels`）；**没有标签就写 null，不猜**；
 *   · 笑声/叹气优先取引擎注记或人工标注；缺失时如实为 0，不用"能量峰值"冒充笑声。
 */
export function buildEmotionCurve(
  sentences: TalkSentence[],
  analysis: TalkAnalysis,
  options: { envelope?: LoudnessLikePoint[]; labels?: TalkEmotionLabelInput[] } = {},
): TalkEmotionDoc {
  const prosody = computeTalkProsody(sentences, {
    ...(options.envelope ? { envelope: options.envelope } : {}),
    pauses: analysis.pauses,
  });
  const paceNorm = normalizeWithin(prosody.sentences.map((entry) => entry.paceRatio));
  const energyNormAll = normalizeWithin(prosody.sentences.map((entry) => entry.energyDb));
  const energyTrend = prosody.sentences.map((entry, index) => {
    const window = prosody.sentences.slice(Math.max(0, index - 2), index + 1).map((item) => item.energyDb);
    const present = window.filter((value): value is number => value !== null);
    if (present.length === 0 || entry.energyDb === null) return null;
    return entry.energyDb - mean(present);
  });
  const energyDeltaNorm = normalizeWithin(energyTrend);
  const labelsById = new Map((options.labels ?? []).map((label) => [label.sentenceId, label]));

  const curve: TalkEmotionPoint[] = prosody.sentences.map((entry, index) => {
    const pace = paceNorm[index] ?? 0.5;
    const energy = energyNormAll[index] ?? 0.5;
    const delta = energyDeltaNorm[index] ?? 0.5;
    const label = labelsById.get(entry.sentenceId);
    /** arousal 合成：语速 0.45 / 能量 0.35 / 能量变化 0.2；缺通道时按 0.5 中性处理。 */
    const arousal = round(Math.min(1, Math.max(0, 0.45 * pace + 0.35 * energy + 0.2 * delta)), 3);
    const evidence: string[] = [`语速 ${entry.charsPerSecond} 字/秒（片中中位 ×${entry.paceRatio}）`];
    if (entry.energyDb !== null) evidence.push(`句内能量 ${entry.energyDb}dB`);
    if (entry.maxInnerPauseSeconds >= TALK_DEFAULTS.pauseThinkingSeconds) evidence.push(`句内停顿 ${entry.maxInnerPauseSeconds}s`);
    if (label?.laughter) evidence.push("含笑声（标注通道）");
    if (label?.sigh) evidence.push("含叹气（标注通道）");
    return {
      sentenceId: entry.sentenceId,
      t: entry.start,
      arousal,
      valence: label?.valence ?? null,
      intensity: arousal,
      label: (label?.label as TalkEmotionLabel | undefined) ?? null,
      evidence,
    };
  });

  const intensities = curve.map((point) => point.intensity);
  const threshold = percentile(intensities, TALK_DEFAULTS.emotionPeakPercentile);
  const peaks: TalkEmotionPeak[] = [];
  for (const [index, point] of curve.entries()) {
    const prev = curve[index - 1]?.intensity ?? Number.NEGATIVE_INFINITY;
    const next = curve[index + 1]?.intensity ?? Number.NEGATIVE_INFINITY;
    const text = sentences.find((sentence) => sentence.id === point.sentenceId)?.text ?? "";
    const label = point.label ?? "";
    const humorMarked = /幽默|自嘲/u.test(label) || Boolean(labelsById.get(point.sentenceId)?.laughter);
    const insightMarked = looksLikeTalkInsight(text);
    /**
     * 峰值有两条入口：
     *   ① 声学入口——强度达到分位阈值且是局部最大（真正"喊出来/快起来"的句子）；
     *   ② 价值入口——标注通道明确说这句有笑点（笑声/幽默）或本身就是金句（数字/关键结论）。
     * 后者即使说得平静也算峰值：笑点与金句是口播最值钱的两类素材，不能因为"语气平"被漏掉。
     */
    /**
     * 声学峰值要求"先升后平/降"（index>0 且严格高于前一句）：
     * 否则当全片语速/能量接近时（归一化后全是 0.5），每一句都会被判成"局部最大"，
     * 保护窗口就会铺满全片，语气词一个都删不掉。
     */
    const acousticPeak = index > 0 && point.intensity >= threshold && point.intensity > prev && point.intensity >= next;
    if (!acousticPeak && !humorMarked && !insightMarked) continue;
    const kind: TalkEmotionPeak["kind"] = humorMarked ? "humor_peak" : insightMarked ? "insight_peak" : "emotion_peak";
    const intensity = humorMarked || insightMarked ? round(Math.max(point.intensity, 0.7), 3) : point.intensity;
    peaks.push({
      sentenceId: point.sentenceId,
      t: point.t,
      intensity,
      kind,
      reason: [point.evidence.join("；"), humorMarked ? "标注通道判定为笑点/幽默" : insightMarked ? "含数字或结论性表述（金句候选）" : "声学强度进入峰值分位"]
        .filter(Boolean)
        .join("；"),
    });
  }

  const laughter = (options.labels ?? []).filter((label) => label.laughter).length;
  const sighs = (options.labels ?? []).filter((label) => label.sigh).length;
  const emphasisRepeats = analysis.repetitions.filter((mark) => mark.kind === "rhetorical").length;
  const energies = prosody.sentences.map((entry) => entry.energyDb).filter((value): value is number => value !== null);
  const loudnessRangeDb = energies.length >= 2 ? round(Math.max(...energies) - Math.min(...energies), 2) : null;
  const signals: TalkHumannessSignals = {
    laughter,
    sighs,
    selfCorrections: analysis.selfCorrections.length,
    emphasisRepeats,
    paceVariation: prosody.paceVariation,
    loudnessRangeDb,
  };
  const notes: string[] = [];
  const paceScore = Math.min(1, signals.paceVariation / 0.35);
  const dynamicsScore = loudnessRangeDb === null ? 0.5 : Math.min(1, loudnessRangeDb / 12);
  const momentScore = Math.min(1, (laughter * 0.5 + sighs * 0.35 + signals.selfCorrections * 0.4 + emphasisRepeats * 0.3) / 2);
  /** 活人感分只做指标（不进硬闸）：语速起伏 0.4 + 动态范围 0.25 + 真实瞬间 0.35。 */
  const score = round(Math.min(1, Math.max(0, 0.4 * paceScore + 0.25 * dynamicsScore + 0.35 * momentScore)), 3);
  if (prosody.paceVariation < 0.12) notes.push("语速几乎平铺（CV < 0.12）：像念稿，检查是否删得太干净或原素材本身平");
  if (loudnessRangeDb !== null && loudnessRangeDb < 4) notes.push("句间动态 < 4dB：情绪起伏弱，优先在选段阶段找更有劲的段落");
  if (laughter === 0 && sighs === 0 && signals.selfCorrections === 0) {
    notes.push("未检出笑声/叹气/自纠：不是问题，但这条片子的'人味'只能靠停顿与语速节奏承担");
  }

  return {
    schemaVersion: "workloom.video-edit/talk-emotion/v1",
    channel: {
      acoustic: options.envelope && options.envelope.length > 0 ? "local" : "none",
      semantic: (options.labels ?? []).length > 0 ? "labels" : "none",
    },
    prosody: { sentences: prosody.sentences, meanCharsPerSecond: prosody.meanCharsPerSecond, paceVariation: prosody.paceVariation },
    curve,
    peaks,
    humanness: { score, signals, notes },
  };
}

/* ============================ ③ 剪取决策 ============================ */

export type TalkCutReason =
  | "dead-air" | "thinking-pause-trim" | "breath-keep" | "filler-noise" | "filler-rhythm-keep"
  | "stumble" | "repetition" | "rhetorical-keep" | "self-correction-keep" | "humor-keep"
  | "emotion-peak-keep" | "tangent" | "human-floor-keep" | "keep";

export type TalkDecisionAction = "keep" | "cut" | "trim";

export interface TalkCutDecision {
  id: string;
  action: TalkDecisionAction;
  target: "pause" | "filler" | "repetition" | "self-correction" | "block" | "segment";
  start: number;
  end: number;
  /** trim 时保留的区间（cut 时为空） */
  keepFrom?: number;
  keepTo?: number;
  reason: TalkCutReason;
  /** 人味价值（0–1）：越高越应该保留；删除决策必须能说明"被删的东西人味价值低在哪" */
  humanValue: number;
  /** 关联的句/词标记（便于返修定位） */
  refs: string[];
  note: string;
}

export interface TalkCutOptions {
  /** 目标成片时长（秒）：只影响配额告警与多片拆分建议，不硬凑 */
  targetDurationSeconds?: number;
  /** 语气词保留率下限（0–1），低于它必须人审放行 */
  fillerKeepRateFloor?: number;
  /** 停顿保留率下限（保留秒 / 原停顿秒） */
  pauseKeepRateFloor?: number;
  /** 自纠处理：keep（默认，保留错句+纠正，只压缩死停）/ trim-mistake（只保留纠正后的说法） */
  selfCorrectionPolicy?: "keep" | "trim-mistake";
/**
 * 是否把低分话题块从本片**剔出**（true = 从本片删除该块）。
 * 缺省 false：按 skills/talk-cutting 的口径"只列为拆分候选，不硬删素材"——
 * 选段/多片拆分是 G-TK4 的人在环决定，系统不替人删掉一整块内容。
 */
splitTangents?: boolean;
  /** 跳切遮盖：alternate = 相邻段交替推近；none = 不推近（需人工确认） */
  punchIn?: "alternate" | "none";
  /** 情绪峰值保护窗口（秒）：峰值句前后不删气口 */
  protectPeakSeconds?: number;
}

export interface TalkCutMetrics {
  fillerTotal: number;
  fillerKept: number;
  fillerKeepRate: number;
  pauseTotalSeconds: number;
  pauseKeptSeconds: number;
  pauseKeepRate: number;
  removedSeconds: number;
  keptSeconds: number;
  humanSignalsKept: number;
  /** 平滑风险（0–1，越高越像 AI 念稿）：语气词删除率 0.4 + 停顿删除率 0.3 + 语速平铺 0.2 + 跳切无遮盖 0.1 */
  smoothingRisk: number;
  decisions: { keep: number; cut: number; trim: number };
}

export interface TalkCutPlan {
  schemaVersion: "workloom.video-edit/talk-cut-list/v1";
  options: Required<Pick<TalkCutOptions,
    "fillerKeepRateFloor" | "pauseKeepRateFloor" | "selfCorrectionPolicy" | "splitTangents" | "punchIn" | "protectPeakSeconds">> & {
      targetDurationSeconds: number | null;
    };
  decisions: TalkCutDecision[];
  /** 保留区间（升序、互不重叠） */
  keepSpans: Array<{ start: number; end: number }>;
  /** 删除/压缩掉的区间（供人工复核"删了什么"） */
  cutSpans: Array<{ start: number; end: number; reason: TalkCutReason }>;
  metrics: TalkCutMetrics;
  /** 低分话题块（拆分候选，不删素材） */
  splitCandidates: Array<{ blockId: string; title: string; start: number; end: number; reason: string }>;
  notes: string[];
}

interface ProtectedWindow {
  start: number;
  end: number;
  kind: "self-correction" | "emotion-peak" | "humor" | "rhetorical";
}

function overlaps(start: number, end: number, window: { start: number; end: number }): boolean {
  return start < window.end + 0.05 && end > window.start - 0.05;
}

/** 合并重叠/相邻的删除区间（间隔 <0.02s 视为相邻），并保留主因用于复核 */
export function mergeSpans(
  spans: Array<{ start: number; end: number; reason?: TalkCutReason }>,
  deadline: number,
): Array<{ start: number; end: number; reason: TalkCutReason }> {
  const sorted = spans
    .map((span) => ({
      start: Math.max(0, round(span.start)),
      end: Math.min(deadline, round(span.end)),
      reason: span.reason ?? "keep",
    }))
    .filter((span) => span.end - span.start > 0.005)
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number; reason: TalkCutReason }> = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end + 0.02) {
      last.end = round(Math.max(last.end, span.end));
      if (last.reason !== span.reason && last.reason !== "tangent") last.reason = span.reason;
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

/** 求差：给定总区间与删除区间，返回保留区间（升序、互不重叠） */
export function subtractSpans(
  total: { start: number; end: number },
  cuts: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  const keep: Array<{ start: number; end: number }> = [];
  let cursor = total.start;
  for (const cut of sorted) {
    if (cut.start > cursor) keep.push({ start: round(cursor), end: round(Math.min(cut.start, total.end)) });
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < total.end) keep.push({ start: round(cursor), end: round(total.end) });
  return keep.filter((span) => span.end - span.start > 0.01);
}

/** 区间重叠长度（秒）：用于"指标与区间互证"（不信任决策台账里的自报数） */
export function overlapSeconds(span: { start: number; end: number }, interval: { start: number; end: number }): number {
  return Math.max(0, Math.min(span.end, interval.end) - Math.max(span.start, interval.start));
}

/**
 * 从删除区间列表中"抠掉"一段（可能切开一个合并区间）。
 *
 * 为什么必须切开而不是找完全相等的区间：删除区间会被 `mergeSpans` 合并
 * （相邻 0.02s 内的两段合成一段）。人味下限补偿要恢复某个语气词/停顿的头几秒时，
 * 它往往已经被合并进一大段删除区间——旧实现用 `findIndex` 找"完全相等"的区间，
 * 找不到就**静默不恢复**，于是台账/指标说"保留了"，成片里却仍然被删掉（实测复现的假达标）。
 */
export function removeIntervalFromSpans(
  spans: Array<{ start: number; end: number; reason: TalkCutReason }>,
  interval: { start: number; end: number },
): Array<{ start: number; end: number; reason: TalkCutReason }> {
  const out: Array<{ start: number; end: number; reason: TalkCutReason }> = [];
  for (const span of spans) {
    const overlap = overlapSeconds(span, interval);
    if (overlap <= 0.001) {
      out.push({ ...span });
      continue;
    }
    const head = { start: round(span.start), end: round(Math.max(span.start, interval.start)), reason: span.reason };
    const tail = { start: round(Math.min(span.end, interval.end)), end: round(span.end), reason: span.reason };
    if (head.end - head.start > 0.005) out.push(head);
    if (tail.end - tail.start > 0.005) out.push(tail);
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * 口播剪取决策树（核心）：逐项决定 保留 / 删除 / 压缩，并给出理由与人味价值。
 *
 * 排序纪律：**先保护，后删除**——先圈定"必须保留"的窗口（自纠/情绪峰值/修辞强调），
 * 再在剩余区间上执行删除。这样"人味保护"永远优先于"剪辑洁癖"。
 */
export function planTalkCut(
  sentences: TalkSentence[],
  analysis: TalkAnalysis,
  emotion: TalkEmotionDoc,
  options: TalkCutOptions = {},
): TalkCutPlan {
const fillerFloor = options.fillerKeepRateFloor ?? TALK_DEFAULTS.fillerKeepRateFloor;
const pauseFloor = options.pauseKeepRateFloor ?? TALK_DEFAULTS.pauseKeepRateFloor;
const selfCorrectionPolicy = options.selfCorrectionPolicy ?? "keep";
/** 缺省"只列候选、不硬删"（与技能口径一致；要剔出必须显式传 true，执行器用 --drop-tangents 打开）。 */
const splitTangents = options.splitTangents ?? false;
  const punchIn = options.punchIn ?? "alternate";
  const protectPeakSeconds = options.protectPeakSeconds ?? 1.5;
  const deadline = sentences[sentences.length - 1]!.end;
  const notes: string[] = [];

  const decisions: TalkCutDecision[] = [];
  const protectedWindows: ProtectedWindow[] = [];
  for (const correction of analysis.selfCorrections) {
    if (selfCorrectionPolicy === "keep") {
      protectedWindows.push({ start: correction.start, end: correction.end, kind: "self-correction" });
    }
  }
  for (const peak of emotion.peaks) {
    protectedWindows.push({
      start: Math.max(0, peak.t - protectPeakSeconds),
      end: Math.min(deadline, peak.t + protectPeakSeconds),
      kind: peak.kind === "humor_peak" ? "humor" : "emotion-peak",
    });
  }
  for (const mark of analysis.repetitions) {
    if (mark.kind === "rhetorical") protectedWindows.push({ start: mark.start, end: mark.end, kind: "rhetorical" });
  }
  const protectionOf = (start: number, end: number): ProtectedWindow | null =>
    protectedWindows.find((window) => overlaps(start, end, window)) ?? null;
  /** 保护窗口 → 决策理由：自纠/笑点/情绪峰值各有自己的理由，便于人工按类别复核。 */
  const protectionReason = (window: ProtectedWindow): TalkCutReason =>
    window.kind === "self-correction" ? "self-correction-keep"
    : window.kind === "humor" ? "humor-keep"
    : window.kind === "rhetorical" ? "rhetorical-keep" : "emotion-peak-keep";

  const cuts: Array<{ start: number; end: number; reason: TalkCutReason }> = [];
  const pushDecision = (decision: Omit<TalkCutDecision, "id">): TalkCutDecision => {
    const withId: TalkCutDecision = { id: `d-${String(decisions.length + 1).padStart(3, "0")}`, ...decision };
    decisions.push(withId);
    return withId;
  };

/* ---- ① 语气词 ---- */
const keptFillers = new Set<string>();
const fillerRun = new Map<string, number>();
/**
 * 连续重复的"整段长度"（同文本、间隔 ≤0.25s）。
 * 技能口径：语气词连续重复**只留第一次**；旧实现把整段都删了（备注却写"只留第一次"，自相矛盾），
 * 结果连"嗯嗯嗯"这种卡壳的语气词一个都不剩，人味下限全靠事后回补。
 */
const fillerRunSize = new Map<string, number>();
{
  let start = 0;
  while (start < analysis.fillers.length) {
    let end = start + 1;
    while (
      end < analysis.fillers.length
      && analysis.fillers[end]!.text === analysis.fillers[start]!.text
      && analysis.fillers[end]!.start - analysis.fillers[end - 1]!.end <= 0.25
    ) end += 1;
    for (let index = start; index < end; index += 1) fillerRunSize.set(analysis.fillers[index]!.id, end - start);
    start = end;
  }
}
for (const [index, filler] of analysis.fillers.entries()) {
  const previous = analysis.fillers[index - 1];
  const runIndex = previous && previous.end >= filler.start - 0.25 && previous.text === filler.text
    ? (fillerRun.get(previous.id) ?? 0) + 1
    : 0;
  fillerRun.set(filler.id, runIndex);
  const runSize = fillerRunSize.get(filler.id) ?? 1;
  const protection = protectionOf(filler.start, filler.end);
  const duration = filler.end - filler.start;
  /**
   * 规则：受保护窗口内、短促语气词（<0.25s，节奏功能）、语篇连接词（可删性 <0.5）、
   * 连续重复段的第一次（只留第一次）默认保留。
   */
  const keepFirstOfRun = runSize >= 2 && runIndex === 0;
  const keepRule = Boolean(protection) || duration < 0.25 || filler.removability < 0.5 || keepFirstOfRun;
  if (keepRule) {
    keptFillers.add(filler.id);
    pushDecision({
      action: "keep",
      target: "filler",
      start: filler.start,
      end: filler.end,
      reason: protection ? protectionReason(protection) : "filler-rhythm-keep",
      humanValue: protection ? 0.9 : 0.5,
      refs: [filler.id],
      note: protection
        ? `位于「${protection.kind}」保护窗口内：语气词是真实思考的一部分，保留`
        : keepFirstOfRun
          ? `「${filler.text}」连续出现 ${runSize} 次：按"连续重复只留第一次"保留第一次，其余删除`
          : `「${filler.text}」时长 ${round(duration, 2)}s：短促语气词承担口语节奏，删除会更像念稿`,
    });
    continue;
  }
  cuts.push({ start: filler.start, end: filler.end, reason: "filler-noise" });
  pushDecision({
      action: "cut",
      target: "filler",
      start: filler.start,
      end: filler.end,
      reason: "filler-noise",
    humanValue: round(1 - filler.removability, 2),
    refs: [filler.id],
    note: runIndex > 0
      ? `「${filler.text}」连续重复第 ${runIndex + 1} 次（共 ${runSize} 次）：只留第一次，其余删除`
      : `「${filler.text}」为纯填充（可删性 ${filler.removability}），且不在保护窗口、无节奏功能`,
  });
}

  /* ---- ② 停顿 ---- */
  let pauseKeptSeconds = 0;
  const pauseTotalSeconds = analysis.pauses.reduce((sum, pause) => sum + pause.durationSeconds, 0);
  for (const pause of analysis.pauses) {
    const protection = protectionOf(pause.start, pause.end);
    let keep = pause.durationSeconds;
    let reason: TalkCutReason = pause.kind === "breath" ? "breath-keep" : pause.kind === "thinking" ? "thinking-pause-trim" : "dead-air";
    let humanValue = 0.4;
    if (protection) {
      keep = Math.min(pause.durationSeconds, TALK_DEFAULTS.protectedPauseKeepSeconds);
      reason = protectionReason(protection);
      humanValue = 0.85;
    } else if (pause.kind === "thinking") {
      keep = Math.min(pause.durationSeconds, TALK_DEFAULTS.thinkingKeepSeconds);
      humanValue = 0.55;
    } else if (pause.kind === "dead") {
      keep = Math.min(pause.durationSeconds, TALK_DEFAULTS.deadAirKeepSeconds);
      humanValue = 0.25;
    }
    const removed = round(pause.durationSeconds - keep);
    pauseKeptSeconds += keep;
    if (removed <= 0.02) {
      pushDecision({
        action: "keep",
        target: "pause",
        start: pause.start,
        end: pause.end,
        reason,
        humanValue,
        refs: [pause.id],
        note: `停顿 ${pause.durationSeconds}s（${pause.kind}${pause.betweenSentences ? "，句间" : "，句内"}）：换气与段落感需要它，保留`,
      });
      continue;
    }
    cuts.push({ start: pause.start + keep, end: pause.end, reason });
    pushDecision({
      action: "trim",
      target: "pause",
      start: pause.start,
      end: pause.end,
      keepFrom: pause.start,
      keepTo: round(pause.start + keep),
      reason,
      humanValue,
      refs: [pause.id],
      note: `停顿 ${pause.durationSeconds}s → ${round(keep)}s（${pause.kind}）：死停会掉完播，但全删会失去呼吸感`,
    });
  }

  /* ---- ③ 重复与卡壳 ---- */
  const words = flattenTalkWords(sentences);
  for (const mark of analysis.repetitions) {
    if (mark.kind === "rhetorical") {
      pushDecision({
        action: "keep",
        target: "repetition",
        start: mark.start,
        end: mark.end,
        reason: "rhetorical-keep",
        humanValue: 0.85,
        refs: [mark.id],
        note: `一口气复述「${mark.text}」${mark.times} 次：这是强调，不是卡壳，保留`,
      });
      continue;
    }
  const inside = words.filter((word) => word.start >= mark.start - 0.02 && word.end <= mark.end + 0.02);
  const occurrences: Array<{ start: number; end: number }> = [];
  for (let i = 0; i + mark.unitWords <= inside.length; i += mark.unitWords) {
    const slice = inside.slice(i, i + mark.unitWords);
    occurrences.push({ start: slice[0]!.start, end: slice[slice.length - 1]!.end });
  }
  if (occurrences.length < 2) continue;
  /**
   * 与"语气词保留 / 保护窗口"联动：已被判定保留（含连续重复只留第一次）或落在保护窗口里的
   * 出现次数，不允许再被重复处理器删掉——两套规则必须收敛到同一个成片事实。
   */
  const keptFillerSpans = analysis.fillers.filter((filler) => keptFillers.has(filler.id));
  const alreadyKept = (start: number, end: number): boolean =>
    Boolean(protectionOf(start, end))
    || keptFillerSpans.some((filler) => start >= filler.start - 0.03 && end <= filler.end + 0.03);
  const keepIndex = mark.keepOccurrence === "first" ? 0 : occurrences.length - 1;
  for (const [index, occurrence] of occurrences.entries()) {
    if (index === keepIndex) continue;
    if (alreadyKept(occurrence.start, occurrence.end)) {
      pushDecision({
        action: "keep",
        target: "repetition",
        start: occurrence.start,
        end: occurrence.end,
        reason: "keep",
        humanValue: 0.5,
        refs: [mark.id],
        note: `第 ${index + 1} 次「${mark.text}」已被语气词/保护窗口径判定保留：重复处理器不再重复删除（两套规则收敛）`,
      });
      continue;
    }
    cuts.push({ start: occurrence.start, end: occurrence.end, reason: mark.kind === "restart" ? "repetition" : "stumble" });
      pushDecision({
        action: "cut",
        target: "repetition",
        start: occurrence.start,
        end: occurrence.end,
        reason: mark.kind === "restart" ? "repetition" : "stumble",
        humanValue: 0.2,
        refs: [mark.id],
        note: `第 ${index + 1} 次「${mark.text}」被第 ${keepIndex + 1} 次覆盖（间隔 ${mark.gapSeconds}s）：删除更弱的一次，保留最完整的一次`,
      });
    }
    pushDecision({
      action: "keep",
      target: "repetition",
      start: occurrences[keepIndex]!.start,
      end: occurrences[keepIndex]!.end,
      reason: "keep",
      humanValue: 0.5,
      refs: [mark.id],
      note: `保留第 ${keepIndex + 1} 次「${mark.text}」：语意最完整`,
    });
  }

  /* ---- ④ 自纠 ---- */
  for (const correction of analysis.selfCorrections) {
    if (selfCorrectionPolicy === "trim-mistake") {
      const mistakeEnd = Math.min(correction.end, correction.start + Math.max(0.2, Math.min(2, correction.durationSeconds / 2)));
      cuts.push({ start: correction.start, end: mistakeEnd, reason: "repetition" });
      pushDecision({
        action: "cut",
        target: "self-correction",
        start: correction.start,
        end: mistakeEnd,
        reason: "repetition",
        humanValue: 0.35,
        refs: [correction.id],
        note: `按 trim-mistake 口径删除错句「${correction.mistaken}」，只保留纠正后的说法`,
      });
      continue;
    }
    pushDecision({
      action: "keep",
      target: "self-correction",
      start: correction.start,
      end: correction.end,
      reason: "self-correction-keep",
      humanValue: 0.9,
      refs: [correction.id],
      note: `口误自纠（${correction.cue}）：错句「${correction.mistaken}」→「${correction.corrected}」；这是"真人在想"的证据，保留两者，只压缩中间死停`,
    });
  }

  /* ---- ⑤ 话题块与跑题拆分 ---- */
  const splitCandidates: TalkCutPlan["splitCandidates"] = [];
  for (const block of scoreTalkBlocks(sentences, analysis, emotion)) {
    const weak = block.score < 0.35;
    const protectedBlock = block.peakIntensity >= 0.7;
    if (!weak || protectedBlock) continue;
  splitCandidates.push({
    blockId: block.blockId,
    title: block.title,
    start: block.start,
    end: block.end,
    reason: `块评分 ${block.score}（信息密度/情绪/完整度综合偏低），建议拆成独立片子或舍弃`,
  });
  if (splitTangents) {
    cuts.push({ start: block.start, end: block.end, reason: "tangent" });
    pushDecision({
      action: "cut",
      target: "block",
      start: block.start,
      end: block.end,
      reason: "tangent",
      humanValue: 0.3,
      refs: [block.blockId],
      note: `按显式选择把低分块「${block.title}」从本片剔出（块评分 ${block.score}）；素材不删除，可单独成片`,
    });
  }
}
if (splitCandidates.length > 0 && !splitTangents) {
  notes.push(`发现 ${splitCandidates.length} 个低分话题块：仅列为拆分候选（不硬删）——是否剔出/独立成片由人选（G-TK4）`);
}

  /* ---- ⑥ 合并删除区间 → 保留区间 ---- */
  const merged = mergeSpans(cuts, deadline);
  let fillerKept = keptFillers.size;
  let fillerKeepRate = analysis.fillers.length > 0 ? round(fillerKept / analysis.fillers.length, 3) : 1;
  let pauseKeepRate = pauseTotalSeconds > 0 ? round(pauseKeptSeconds / pauseTotalSeconds, 3) : 1;

  /* ---- ⑦ 人味下限补偿：删过头时把"最该留的"恢复回来 ---- */
  if (analysis.fillers.length > 0 && fillerKeepRate < fillerFloor) {
    const byValue = analysis.fillers
      .filter((filler) => !keptFillers.has(filler.id))
      .sort((a, b) => a.removability - b.removability);
    let needed = Math.ceil(fillerFloor * analysis.fillers.length) - fillerKept;
    for (const filler of byValue) {
      if (needed <= 0) break;
      keptFillers.add(filler.id);
      /**
       * 关键修复（实测假达标）：恢复必须**真的从删除区间里抠掉这一段**。
       * 旧实现按"完全相等"找区间，一旦该语气词已被 mergeSpans 并入更大的删除区间就找不到，
       * 于是台账与指标显示"已恢复"，成片里却仍被删掉。这里用区间减法（可切开合并区间）保证一致。
       */
      const restored = removeIntervalFromSpans(merged, { start: filler.start, end: filler.end });
      merged.splice(0, merged.length, ...restored);
      fillerKept = keptFillers.size;
      fillerKeepRate = round(fillerKept / analysis.fillers.length, 3);
      pushDecision({
        action: "keep",
        target: "filler",
        start: filler.start,
        end: filler.end,
        reason: "human-floor-keep",
        humanValue: 0.6,
        refs: [filler.id],
        note: `语气词保留率跌到 ${fillerKeepRate}（下限 ${fillerFloor}）：按人味下限恢复「${filler.text}」，避免全片像念稿`,
      });
      needed -= 1;
    }
    notes.push("触发人味下限补偿：语气词删除比例过高，已按可删性从低到高恢复若干语气词");
  }
  if (pauseTotalSeconds > 0 && pauseKeepRate < pauseFloor) {
    const between = analysis.pauses
      .filter((pause) => pause.betweenSentences)
      .sort((a, b) => b.durationSeconds - a.durationSeconds);
    for (const pause of between) {
      if (pauseKeepRate >= pauseFloor) break;
      const currentCut = merged.find((span) => span.start >= pause.start - 0.03 && span.end <= pause.end + 0.03);
      if (!currentCut) continue;
      const cutInPause = merged.reduce((sum, span) => sum + overlapSeconds(span, pause), 0);
      const keepSoFar = round(pause.durationSeconds - cutInPause);
      const add = Math.min(currentCut.end - currentCut.start, round(TALK_DEFAULTS.protectedPauseKeepSeconds - keepSoFar));
      if (add <= 0.05) continue;
      /** 同样用区间减法恢复（从被删部分的第一秒往回restore），保证指标与区间一致。 */
      const restored = removeIntervalFromSpans(merged, { start: currentCut.start, end: round(currentCut.start + add) });
      merged.splice(0, merged.length, ...restored);
      /** 立刻按最终区间重算指标：循环的停止条件与决策备注都要用真数，不能用自报数。 */
      pauseKeptSeconds = round(analysis.pauses.reduce((sum, entry) => {
        const cut = merged.reduce((acc, span) => acc + overlapSeconds(span, entry), 0);
        return sum + Math.max(0, entry.durationSeconds - cut);
      }, 0), 3);
      pauseKeepRate = pauseTotalSeconds > 0 ? round(pauseKeptSeconds / pauseTotalSeconds, 3) : 1;
      pushDecision({
        action: "keep",
        target: "pause",
        start: pause.start,
        end: round(pause.start + add),
        reason: "human-floor-keep",
        humanValue: 0.7,
        refs: [pause.id],
        note: `停顿保留率 ${pauseKeepRate} 低于下限 ${pauseFloor}：恢复句间停顿 ${round(add)}s，段落之间需要呼吸`,
      });
    }
    notes.push("触发人味下限补偿：停顿保留不足，已恢复部分句间停顿");
  }

  /**
   * 指标一律以**最终区间**为准重算（不信任台账自报数）。
   * 这是"假达标"的根治：无论补偿逻辑怎么改，指标与成片区间永远同源。
   */
  fillerKept = analysis.fillers.filter((filler) =>
    analysis.fillers.length > 0
    && merged.reduce((sum, span) => sum + overlapSeconds(span, filler), 0) < (filler.end - filler.start) * 0.5).length;
  fillerKeepRate = analysis.fillers.length > 0 ? round(fillerKept / analysis.fillers.length, 3) : 1;
  pauseKeptSeconds = round(analysis.pauses.reduce((sum, pause) => {
    const cut = merged.reduce((acc, span) => acc + overlapSeconds(span, pause), 0);
    return sum + Math.max(0, pause.durationSeconds - cut);
  }, 0), 3);
  pauseKeepRate = pauseTotalSeconds > 0 ? round(pauseKeptSeconds / pauseTotalSeconds, 3) : 1;

  const keepSpans = subtractSpans({ start: 0, end: deadline }, merged);
  const keptSeconds = round(keepSpans.reduce((sum, span) => sum + (span.end - span.start), 0));
  const humanSignalsKept = decisions.filter((decision) =>
    decision.action === "keep"
    && ["human-floor-keep", "self-correction-keep", "rhetorical-keep", "humor-keep", "emotion-peak-keep"].includes(decision.reason)).length;
  const fillerRemovalRate = analysis.fillers.length > 0 ? 1 - fillerKeepRate : 0;
  const pauseRemovalRate = pauseTotalSeconds > 0 ? 1 - pauseKeepRate : 0;
  const paceUniformity = Math.max(0, 1 - emotion.prosody.paceVariation / 0.35);
  const jumpCutCoverage = punchIn === "alternate" ? 1 : 0.4;
  const smoothingRisk = round(Math.min(1, Math.max(0,
    0.4 * fillerRemovalRate + 0.3 * pauseRemovalRate + 0.2 * paceUniformity + 0.1 * (1 - jumpCutCoverage))), 3);
  if (smoothingRisk >= TALK_DEFAULTS.smoothingRiskWarn) {
    notes.push(`平滑风险 ${smoothingRisk} ≥ ${TALK_DEFAULTS.smoothingRiskWarn}：删得偏狠，建议放宽语气词/停顿保留或补 punch-in 与切镜`);
  }
  const target = options.targetDurationSeconds ?? null;
  if (target !== null && keptSeconds > target * 1.25) {
    notes.push(`保留 ${keptSeconds}s 高于目标 ${target}s 的 125%：优先拆分成多条片子，而不是继续删语气词与停顿`);
  }
  if (target !== null && keptSeconds < target * 0.6) {
    notes.push(`保留 ${keptSeconds}s 低于目标 ${target}s 的 60%：素材可能不够，建议补录或降低目标时长`);
  }

  return {
    schemaVersion: "workloom.video-edit/talk-cut-list/v1",
    options: {
      fillerKeepRateFloor: fillerFloor,
      pauseKeepRateFloor: pauseFloor,
      selfCorrectionPolicy,
      splitTangents,
      punchIn,
      protectPeakSeconds,
      targetDurationSeconds: target,
    },
    decisions,
    keepSpans,
    cutSpans: merged,
    metrics: {
      fillerTotal: analysis.fillers.length,
      fillerKept,
      fillerKeepRate,
      pauseTotalSeconds: round(pauseTotalSeconds),
      pauseKeptSeconds: round(pauseKeptSeconds),
      pauseKeepRate,
      removedSeconds: round(deadline - keptSeconds),
      keptSeconds,
      humanSignalsKept,
      smoothingRisk,
      decisions: {
        keep: decisions.filter((decision) => decision.action === "keep").length,
        cut: decisions.filter((decision) => decision.action === "cut").length,
        trim: decisions.filter((decision) => decision.action === "trim").length,
      },
    },
    splitCandidates,
    notes,
  };
}

/* ============================ ③′ 选段定稿（G-TK4 人审） ============================ */

export interface TalkSelectionInput {
  /** 保留的句子 id（G-TK4 人选定稿）：未列出的句子**整体**剔除（不做句内切割，避免残句） */
  sentenceIds: string[];
  /** 平滑风险重算用：取自 emotion.prosody.paceVariation（缺省 0.35 = 最平铺） */
  paceVariation?: number;
}

export interface TalkSelectionResult {
  plan: TalkCutPlan;
  selection: {
    sentenceIds: string[];
    spans: Array<{ start: number; end: number }>;
    droppedSeconds: number;
    notes: string[];
  };
}

/**
 * 选段定稿：把"整句留删"的人选结果落到剪取计划上（口播长素材 → 1 条明确主题的短片）。
 *
 * 与 planTalkCut 的分工：
 * - `planTalkCut` 管"这条片子**内部**怎么剪"（语气词/停顿/卡壳/自纠的留删）；
 * - 本函数管"**哪几段话属于这条片子**"（G-TK4 选题与拆分候选的人选定稿）。
 *
 * 三条纪律：
 * 1. 只按**整句**取舍：不产生残句（对应 validateTalkCut 的 `sentence.fragment` 硬项）；
 * 2. 删除端点必须落在词边界或停顿区间上：句边界天然是词边界，越界只往停顿里吸附；
 * 3. 人味指标按**成片 scope**重算：分母取选中句段范围内原有的语气词/停顿——
 *    选段不是"删语气词"，既不拿整片分母虚增人味，也不拿它虚降。
 */
export function applyTalkSelection(
  sentences: TalkSentence[],
  analysis: TalkAnalysis,
  plan: TalkCutPlan,
  selection: TalkSelectionInput,
): TalkSelectionResult {
  const byId = new Map(sentences.map((sentence) => [sentence.id, sentence]));
  const unknown = selection.sentenceIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) throw new Error(`选段引用了不存在的句子：${unknown.join("、")}`);
  const chosen = selection.sentenceIds.map((id) => byId.get(id)!);
  if (chosen.length === 0) {
    return {
      plan,
      selection: { sentenceIds: [], spans: [], droppedSeconds: 0, notes: ["未提供选段：保持 planTalkCut 原计划"] },
    };
  }

  const deadline = Math.max(
    0,
    ...plan.keepSpans.map((span) => span.end),
    ...plan.cutSpans.map((span) => span.end),
  );

  // 1) 连续句 → 区间（区间端点 = 句边界 = 词边界）
  const indexOf = new Map(sentences.map((sentence, index) => [sentence.id, index]));
  const indexes = chosen.map((sentence) => indexOf.get(sentence.id)!).sort((a, b) => a - b);
  const runs: Array<{ startIndex: number; endIndex: number }> = [];
  for (const index of indexes) {
    const last = runs[runs.length - 1];
    if (last && index === last.endIndex + 1) last.endIndex = index;
    else runs.push({ startIndex: index, endIndex: index });
  }
  const spans = runs
    .map((run) => ({
      start: round(sentences[run.startIndex]!.start, 3),
      end: round(sentences[run.endIndex]!.end, 3),
    }))
    .filter((span) => span.end - span.start > 0.02);

  // 2) 计划内保留区（已删语气词/停顿）∩ 选段区间
  const scoped = plan.keepSpans
    .flatMap((span) => spans.map((region) => ({
      start: round(Math.max(span.start, region.start), 3),
      end: round(Math.min(span.end, region.end), 3),
    })))
    .filter((span) => span.end - span.start > 0.02);
  const keepSpans = mergeSpans(scoped, deadline).map((span) => ({ start: span.start, end: span.end }));

  // 3) 选段剔除 = 保留区的补集；端点吸附到词边界/停顿（否则会切进词里）
  const words = flattenTalkWords(sentences);
  const alignedToBoundary = (t: number): boolean => {
    const eps = 0.03;
    if (words.some((word) => Math.abs(word.start - t) <= eps || Math.abs(word.end - t) <= eps)) return true;
    return analysis.pauses.some((pause) => t >= pause.start - eps && t <= pause.end + eps);
  };
  const snap = (t: number, edge: "start" | "end"): number => {
    if (alignedToBoundary(t)) return t;
    const candidates = [
      ...words.flatMap((word) => [word.start, word.end]),
      ...analysis.pauses.flatMap((pause) => [pause.start, pause.end]),
    ];
    let best: number | null = null;
    for (const value of candidates) {
      if (Math.abs(value - t) > 0.5) continue;
      if (best === null || Math.abs(value - t) < Math.abs(best - t)) best = value;
    }
    if (best === null) return t;
    return edge === "start" ? Math.min(best, t) : Math.max(best, t);
  };
  const removed = subtractSpans({ start: 0, end: deadline }, keepSpans)
    .map((span) => ({
      start: round(span.start <= 0.001 ? 0 : snap(span.start, "start"), 3),
      end: round(span.end >= deadline - 0.001 ? snap(deadline, "end") : snap(span.end, "end"), 3),
    }))
    .filter((span) => span.end - span.start > 0.02);
  const cutSpans = mergeSpans(
    removed.map((span) => ({ ...span, reason: "tangent" as TalkCutReason })),
    deadline,
  );

  // 4) 指标按成片 scope 重算（分子/分母都跟 scope 走）
  const keptSeconds = round(keepSpans.reduce((sum, span) => sum + (span.end - span.start), 0), 3);
  const inSpans = (t: number): boolean => spans.some((span) => t >= span.start - 0.001 && t <= span.end + 0.001);
  const keptBetween = (start: number, end: number): number =>
    keepSpans.reduce((sum, span) => sum + Math.max(0, Math.min(span.end, end) - Math.max(span.start, start)), 0);
  const fillersInScope = analysis.fillers.filter((filler) => inSpans((filler.start + filler.end) / 2));
  const fillerKept = fillersInScope.filter(
    (filler) => keptBetween(filler.start, filler.end) > (filler.end - filler.start) * 0.6,
  ).length;
  const fillerKeepRate = fillersInScope.length > 0 ? round(fillerKept / fillersInScope.length, 3) : 1;
  const pausesInScope = analysis.pauses.filter((pause) => inSpans((pause.start + pause.end) / 2));
  const pauseTotalSeconds = round(pausesInScope.reduce((sum, pause) => sum + (pause.end - pause.start), 0), 3);
  const pauseKeptSeconds = round(
    pausesInScope.reduce((sum, pause) => sum + keptBetween(pause.start, pause.end), 0),
    3,
  );
  const pauseKeepRate = pauseTotalSeconds > 0 ? round(pauseKeptSeconds / pauseTotalSeconds, 3) : 1;
  const paceUniformity = Math.max(0, 1 - (selection.paceVariation ?? 0.35) / 0.35);
  const jumpCutCoverage = plan.options.punchIn === "alternate" ? 1 : 0.4;
  const smoothingRisk = round(Math.min(1, Math.max(0,
    0.4 * (1 - fillerKeepRate) + 0.3 * (1 - pauseKeepRate) + 0.2 * paceUniformity + 0.1 * (1 - jumpCutCoverage))), 3);

  const coveredByPlan = (span: { start: number; end: number }): boolean =>
    plan.cutSpans.some((cut) => cut.start <= span.start + 0.02 && cut.end >= span.end - 0.02);
  const selectionDecisions: TalkCutDecision[] = cutSpans
    .filter((span) => !coveredByPlan(span))
    .map((span, index) => ({
      id: `selection-${String(index + 1).padStart(3, "0")}`,
      action: "cut" as TalkDecisionAction,
      target: "segment" as const,
      start: span.start,
      end: span.end,
      reason: "tangent" as TalkCutReason,
      humanValue: 0.2,
      refs: sentences
        .filter((sentence) => sentence.end > span.start + 0.02 && sentence.start < span.end - 0.02)
        .map((sentence) => sentence.id),
      note: "选段剔除（G-TK4 人选定稿）：该区间不属于本条片子的主题范围；句子可另组成其它片子，素材不丢",
    }));

  const spanSeconds = round(spans.reduce((sum, span) => sum + (span.end - span.start), 0), 3);
  /** 选段后成片长度变了：基础计划里按"整片保留量"算的目标提示必须作废重算，否则回执自相矛盾 */
  const staleTargetNotes = plan.notes.filter((note) => /高于目标|低于目标/u.test(note));
  const targetSeconds = plan.options.targetDurationSeconds;
  const notes = [
    ...plan.notes.filter((note) => !staleTargetNotes.includes(note)),
    `选段定稿（G-TK4）：选中 ${spans.length} 段 / ${spanSeconds}s；成片保留 ${keptSeconds}s，剔除 ${round(deadline - keptSeconds, 3)}s`,
    `人味指标按成片 scope 重算：语气词保留率 ${fillerKeepRate}（scope 内 ${fillersInScope.length} 个）· 停顿保留率 ${pauseKeepRate}（scope 内 ${pauseTotalSeconds}s）`,
  ];
  if (targetSeconds !== null && keptSeconds > targetSeconds * 1.25) {
    notes.push(`成片保留 ${keptSeconds}s 高于目标 ${targetSeconds}s 的 125%：内容多但不硬删——要么按此长度出片，要么再砍选段（不要靠删语气词凑时长）`);
  }
  if (targetSeconds !== null && keptSeconds < targetSeconds * 0.6) {
    notes.push(`成片保留 ${keptSeconds}s 低于目标 ${targetSeconds}s 的 60%：选段偏薄，建议补选或降低目标时长`);
  }
  if (fillerKeepRate < plan.options.fillerKeepRateFloor) {
    notes.push(`语气词保留率 ${fillerKeepRate} < 下限 ${plan.options.fillerKeepRateFloor}：需人审放行（--human-approved-below-floor）或调整选段`);
  }
  if (pauseKeepRate < plan.options.pauseKeepRateFloor) {
    notes.push(`停顿保留率 ${pauseKeepRate} < 下限 ${plan.options.pauseKeepRateFloor}：需人审放行（--human-approved-below-floor）或调整选段`);
  }
  if (smoothingRisk >= TALK_DEFAULTS.smoothingRiskWarn) {
    notes.push(`平滑风险 ${smoothingRisk} ≥ ${TALK_DEFAULTS.smoothingRiskWarn}：片子偏"平"，建议在选段内补 punch-in 或保留更多气口`);
  }

  return {
    plan: {
      ...plan,
      decisions: [...plan.decisions, ...selectionDecisions],
      keepSpans,
      cutSpans,
      metrics: {
        ...plan.metrics,
        fillerTotal: fillersInScope.length,
        fillerKept,
        fillerKeepRate,
        pauseTotalSeconds,
        pauseKeptSeconds,
        pauseKeepRate,
        removedSeconds: round(deadline - keptSeconds, 3),
        keptSeconds,
        decisions: {
          keep: plan.decisions.filter((decision) => decision.action === "keep").length,
          cut: plan.decisions.filter((decision) => decision.action === "cut").length + selectionDecisions.length,
          trim: plan.decisions.filter((decision) => decision.action === "trim").length,
        },
        smoothingRisk,
      },
      notes,
    },
    selection: {
      sentenceIds: chosen.map((sentence) => sentence.id),
      spans,
      droppedSeconds: round(deadline - keptSeconds, 3),
      notes,
    },
  };
}

export interface TalkBlockScore {
  blockId: string;
  title: string;
  start: number;
  end: number;
  durationSeconds: number;
  /** 信息密度（字/秒，归一化前原值） */
  informationDensity: number;
  peakIntensity: number;
  /** 综合分（0–1）：密度 0.4 + 情绪峰值 0.35 + 完整度 0.25 */
  score: number;
}

/**
 * 话题块打分：信息密度 + 情绪峰值 + 完整度。
 * 完整度用"块内平均句长"近似：平均句长太短说明这段是在找词，不是在讲。
 */
export function scoreTalkBlocks(
  sentences: TalkSentence[],
  analysis: TalkAnalysis,
  emotion: TalkEmotionDoc,
): TalkBlockScore[] {
  const densities: number[] = [];
  const base = analysis.blocks.map((block) => {
    const blockSentences = sentences.filter((sentence) => block.sentenceIds.includes(sentence.id));
    const chars = blockSentences.reduce((sum, sentence) => sum + textLength(sentence.text), 0);
    const duration = Math.max(0.001, block.end - block.start);
    const density = chars / duration;
    densities.push(density);
    const peakIntensity = emotion.peaks
      .filter((peak) => peak.t >= block.start - 0.02 && peak.t <= block.end + 0.02)
      .reduce((max, peak) => Math.max(max, peak.intensity), 0);
    const meanSentenceSeconds = blockSentences.length > 0
      ? blockSentences.reduce((sum, sentence) => sum + (sentence.end - sentence.start), 0) / blockSentences.length
      : 0;
    return { block, density, peakIntensity, completeness: Math.min(1, meanSentenceSeconds / 6) };
  });
  const maxDensity = Math.max(0.001, ...densities);
  return base.map((entry) => ({
    blockId: entry.block.id,
    title: entry.block.title,
    start: entry.block.start,
    end: entry.block.end,
    durationSeconds: round(entry.block.end - entry.block.start),
    informationDensity: round(entry.density, 3),
    peakIntensity: round(entry.peakIntensity, 3),
    score: round(0.4 * (entry.density / maxDensity) + 0.35 * entry.peakIntensity + 0.25 * entry.completeness, 3),
  }));
}

/* ============================ ④ 交付物：时间轴 / 字幕 / 质检 ============================ */

export interface TalkTimelineOptions {
  timelineId: string;
  filmId?: string | null;
  source: {
    sourceId: string;
    sha256: string;
    path: string;
    fps: number;
    durationSeconds?: number | null;
    hasAudio?: boolean | null;
  };
  target: {
    durationSeconds: number;
    aspectRatio: string;
    fps: number;
    platform: string;
    loudnessTargetLufs?: number | null;
  };
  /** 单段最大时长（秒）：超过即按句边界切开，便于 punch-in 交替与字幕对齐 */
  maxSegmentSeconds?: number;
  /** punch-in 缩放（相邻段交替）：默认 [1.0, 1.12] */
  punchInScales?: [number, number];
  /** 是否加 punch-in（缺省取 cut plan 的选项） */
  punchIn?: "alternate" | "none";
}

export interface TalkSegmentDraft {
  segmentId: string;
  start: number;
  end: number;
  text: string;
  sentenceIds: string[];
  blockId: string | null;
  jumpCut: boolean;
  punchIn: { scale: number; note: string } | null;
}

type TalkPiece = { start: number; end: number; sentenceIds: string[]; text: string };

/**
 * 把超长片段按**词边界**拆小（本机生产补丁，2026-10-11）。
 *
 * 为什么必须有：口播字幕规则是"一屏 ≤2 行 × 12 字（≤24 字）"，但 ASR 的一句话常常 40+ 字，
 * 且同一保留区间里没有别的切点——旧实现只能把 42 字压进一屏（实测 44 条字幕里 19 条 4 行），
 * 或者靠"每 12 字硬切"断行（把 "AI"、"skill" 从词中间切开）。这里在片段层按词边界分段，
 * 让每个字幕段天然 ≤ maxChars；断行交给 `splitTalkCaptionLines` 的词边界折行。
 */
function splitOversizedPieces(pieces: TalkPiece[], words: TalkWord[], maxChars: number): TalkPiece[] {
  const output: TalkPiece[] = [];
  for (const piece of pieces) {
    if (textLength(piece.text) <= maxChars) {
      output.push({ ...piece });
      continue;
    }
    const scoped = words.filter((word) => word.start >= piece.start - 0.02 && word.end <= piece.end + 0.02);
    if (scoped.length === 0) {
      output.push({ ...piece });
      continue;
    }
    const chunks: TalkWord[][] = [];
    let current: TalkWord[] = [];
    let chars = 0;
    for (const word of scoped) {
      const next = chars + textLength(word.text);
      if (current.length > 0 && next > maxChars) {
        chunks.push(current);
        current = [];
        chars = 0;
      }
      current.push(word);
      chars += textLength(word.text);
    }
    if (current.length > 0) chunks.push(current);
    const subPieces: TalkPiece[] = chunks.map((chunk) => ({
      start: round(chunk[0]!.start),
      end: round(chunk[chunk.length - 1]!.end),
      sentenceIds: [...piece.sentenceIds],
      text: chunk.map((word) => word.text).join(""),
    }));
    /** 过短的尾块并入前一块（单段 0.4s 是时间轴硬闸）：宁可这一块多几个字，也不要 0.2s 的碎片。 */
    const normalized: TalkPiece[] = [];
    for (const sub of subPieces) {
      const last = normalized[normalized.length - 1];
      if (last && sub.end - sub.start < 0.4) {
        last.end = sub.end;
        last.text += sub.text;
        continue;
      }
      normalized.push(sub);
    }
    output.push(...normalized);
  }
  return output;
}

/**
 * 把保留区间切成"可执行的段"：按句边界切分（每段 1..n 句，≤ maxSegmentSeconds）。
 * 两个理由：① 字幕与段时间对齐；② 相邻段交替 punch-in 需要足够的段数。
 */
export function draftTalkSegments(
  sentences: TalkSentence[],
  analysis: TalkAnalysis,
  plan: TalkCutPlan,
  options: {
    maxSegmentSeconds?: number;
    /** 单段字幕字数上限（口播一屏 ≤2 行 × 12 字）：段太长会变成"读不完的字幕" */
    maxSegmentChars?: number;
    punchIn?: "alternate" | "none";
    punchInScales?: [number, number];
  } = {},
): TalkSegmentDraft[] {
  const maxSegmentSeconds = options.maxSegmentSeconds ?? 12;
  const maxSegmentChars = options.maxSegmentChars ?? 24;
  const punchIn = options.punchIn ?? plan.options.punchIn;
  const scales = options.punchInScales ?? [1.0, 1.12];
  const drafts: TalkSegmentDraft[] = [];
  for (const span of plan.keepSpans) {
    /**
     * 段边界必须落在**保留区间的边界**上，且段的并集必须精确等于保留区间：
     *   · 口播经常在一句话中间删掉语气词/卡壳，按整句回退会把删掉的半句又剪回片子里；
     *   · 保留区间里也有"句间停顿"（换气），它不属于任何句子——如果只按句子做交集，
     *     这些秒数会凭空消失，成片时长与决策回执对不上（实测偏差 11.9%）。
     * 做法：把保留区间按"句子边界 + 区间端点"切成小格，空格（停顿）归到相邻句子的段里，
     * 再按"同句合并 + 碎片并入 + 时长/字数上限"分组。
     */
    const boundaries = new Set<number>([round(span.start), round(span.end)]);
    for (const sentence of sentences) {
      if (sentence.end <= span.start + 0.01 || sentence.start >= span.end - 0.01) continue;
      boundaries.add(round(Math.max(span.start, sentence.start)));
      boundaries.add(round(Math.min(span.end, sentence.end)));
    }
    const sortedBoundaries = [...boundaries].sort((a, b) => a - b);
    const cells: Array<{ start: number; end: number; sentenceIds: string[]; text: string }> = [];
    for (let index = 1; index < sortedBoundaries.length; index += 1) {
      const start = sortedBoundaries[index - 1]!;
      const end = sortedBoundaries[index]!;
      if (end - start <= 0.01) continue;
      /** 与这一格相交的句子；纯停顿格（无交集）归给"紧邻的前一句"，没有前一句则归后一句。 */
      const overlapping = sentences.filter((sentence) => sentence.end > start + 0.01 && sentence.start < end - 0.01);
      const previous = [...sentences].reverse().find((sentence) => sentence.end <= start + 0.01);
      const next = sentences.find((sentence) => sentence.start >= end - 0.01);
      const owner = overlapping.length > 0 ? overlapping[0]! : previous ?? next;
      const text = owner
        ? owner.words
          .filter((word) => word.start >= start - 0.02 && word.end <= end + 0.02)
          .map((word) => word.text)
          .join("")
        : "";
      cells.push({
        start: round(start),
        end: round(end),
        sentenceIds: overlapping.map((sentence) => sentence.id),
        text,
      });
    }
    /** 同一句的相邻格合并（句子 + 它的句末停顿 = 一段），空格合并到邻段。 */
    const glued: typeof cells = [];
    for (const cell of cells) {
      const last = glued[glued.length - 1];
      const sameSentence = last
        && JSON.stringify(last.sentenceIds) === JSON.stringify(cell.sentenceIds)
        && cell.sentenceIds.length > 0;
      if (sameSentence) {
        last.end = cell.end;
        continue;
      }
      if (last && cell.sentenceIds.length === 0) {
        last.end = cell.end;
        continue;
      }
      glued.push({ ...cell });
    }
  /**
   * 先按**词边界**切开超长片段（>maxSegmentChars）。
   * 为什么必须切：字幕上限是一屏 24 字，而 ASR 句子在无气口时可达 42 字；
   * 不切的话，talk-cut 自己产出的时间轴会被自己的字幕硬闸（>24 字 / >2 行）拒绝。
   * 切点落在词边界，保持"不切词、不残句"（保留区间不变，切的是段不是内容）。
   */
  const allWords = flattenTalkWords(sentences);
  const splitLongPiece = (piece: (typeof glued)[number]): typeof glued => {
    if (textLength(piece.text) <= maxSegmentChars) return [piece];
    const words = allWords.filter((word) => word.start >= piece.start - 0.02 && word.end <= piece.end + 0.02);
    if (words.length < 2) return [piece];
    const out: typeof glued = [];
    let current: (typeof glued)[number] | null = null;
    for (const word of words) {
      const wordChars = textLength(word.text);
      if (current && textLength(current.text) + wordChars > maxSegmentChars) {
        out.push(current);
        current = null;
      }
      if (!current) {
        current = { start: round(word.start), end: round(word.end), sentenceIds: [...piece.sentenceIds], text: word.text };
      } else {
        current.end = round(word.end);
        current.text += word.text;
      }
    }
    if (current) out.push(current);
    return out.length > 0 ? out : [piece];
  };
  const pieces = glued.flatMap(splitLongPiece);
  /**
   * 碎片并入相邻段：阈值与时间轴硬闸（0.4s）对齐。
   * 旧阈值 0.3 会漏下 0.3–0.39s 的"合法碎片"，被 validateEditTimeline 直接判硬失败——
   * 实测一句话"就是"（0.3s）就让整条口播链路 ok:false。
   */
  const minSegment = TALK_DEFAULTS.minSegmentSeconds;
  const merged: typeof pieces = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    /** 纯停顿碎片（无文字）也要并入相邻段：单独成段 = 无字幕段，口播口径不允许。 */
    if (last && (piece.end - piece.start < minSegment || textLength(piece.text) === 0)) {
      last.end = piece.end;
      last.sentenceIds = [...new Set([...last.sentenceIds, ...piece.sentenceIds])];
      last.text += piece.text;
      continue;
    }
    merged.push({ ...piece });
  }
  /**
   * 片头留白不能单独成段：它是"纯停顿"（没有词），单独成段会产出**无字幕段**，
   * 与口播"每段都有字幕（跟着说话出字）"的硬口径冲突（实测：片头 0.4s 留白让整条链路 ok:false）。
   * 处理：把片头留白并入第一段正式语料，保留呼吸感，同时保证每段都有台词。
   */
  const headIsSilence = merged.length > 1 && textLength(merged[0]!.text) === 0;
  if (merged.length > 1 && (merged[0]!.end - merged[0]!.start < minSegment || headIsSilence)) {
    const head = merged.shift()!;
    merged[0]!.start = head.start;
    merged[0]!.sentenceIds = [...new Set([...head.sentenceIds, ...merged[0]!.sentenceIds])];
    merged[0]!.text = head.text + merged[0]!.text;
  }
    /**
     * 超长片段先按词边界拆小，再按上限分组（本机补丁：一屏 ≤2 行 ×12 字，24 字没有 12/12 词边界时会落第三行）。
     */
    const sized = splitOversizedPieces(merged, flattenTalkWords(sentences), Math.max(8, maxSegmentChars - 2));
    let current: typeof pieces = [];
    const flush = () => {
      if (current.length === 0) return;
      const start = current[0]!.start;
      const end = current[current.length - 1]!.end;
      const sentenceIds = [...new Set(current.flatMap((piece) => piece.sentenceIds))];
      const blockId = analysis.blocks.find((block) => block.sentenceIds.includes(sentenceIds[0]!))?.id ?? null;
      drafts.push({
        segmentId: `talk-${String(drafts.length + 1).padStart(3, "0")}`,
        start: round(start),
        end: round(end),
        text: current.map((piece) => piece.text).join(""),
        sentenceIds,
        blockId,
        jumpCut: false,
        punchIn: null,
      });
      current = [];
    };
    for (const piece of sized) {
      const nextChars = current.reduce((sum, entry) => sum + textLength(entry.text), 0) + textLength(piece.text);
      if (current.length > 0 && (piece.end - current[0]!.start > maxSegmentSeconds || nextChars > maxSegmentChars)) flush();
      current.push(piece);
    }
  flush();
}
/**
 * 跨保留区间的"纯留白段"收口：片头留白（0→第一句）是独立保留区间，上一节的合并只在区间内生效，
 * 必须在这里并入相邻的正式语料段——否则会产出无字幕段，被口播字幕硬闸拒绝（实测 ok:false）。
 */
for (let index = drafts.length - 1; index >= 0; index -= 1) {
  const draft = drafts[index]!;
  if (textLength(draft.text) > 0) continue;
  if (index > 0) {
    const previous = drafts[index - 1]!;
    previous.end = draft.end;
    previous.sentenceIds = [...new Set([...previous.sentenceIds, ...draft.sentenceIds])];
    previous.text += draft.text;
  } else if (drafts.length > 1) {
    const next = drafts[index + 1]!;
    next.start = draft.start;
    next.sentenceIds = [...new Set([...draft.sentenceIds, ...next.sentenceIds])];
    next.text = draft.text + next.text;
  }
  drafts.splice(index, 1);
}
/** 合并后重排段号：段号是字幕与返修定位的引用键，必须连续。 */
drafts.forEach((draft, index) => {
  draft.segmentId = `talk-${String(index + 1).padStart(3, "0")}`;
});
/**
* 跳切判定 + punch-in 遮盖：同源相邻段之间只要源轨有空档就是跳切。
   *
   * 遮盖纪律：**每一处跳切边界都必须让景别发生变化**——直接把"上一段的景别"翻到另一档
   * （1.0 ↔ 1.12），而不是简单地"隔一个跳切推一次"；后者遇到"连续段 1.0 + 跳切段 1.0"
   * 的排列就会出现没有遮盖的边界（实测覆盖率只有 80%）。连续段（同一条语料被字数上限切开）
   * 沿用同一景别，保证画面不无故变焦。
   */
  let currentScale = scales[0] ?? 1;
  for (const [index, draft] of drafts.entries()) {
    const previous = drafts[index - 1];
    if (!previous || draft.start <= previous.end + 0.02) {
      draft.punchIn = currentScale > 1.0001
        ? { scale: currentScale, note: `连续段沿用推近 ${round((currentScale - 1) * 100, 1)}%（同一条语料，不无故变焦）` }
        : null;
      continue;
    }
    draft.jumpCut = true;
    if (punchIn === "none") continue;
    currentScale = currentScale > 1.0001 ? (scales[0] ?? 1) : (scales[1] ?? 1);
    draft.punchIn = currentScale > 1.0001
      ? { scale: currentScale, note: `跳切遮盖：推近 ${round((currentScale - 1) * 100, 1)}%（同机位跳切必须给眼睛一个"换镜头"的理由）` }
      : null;
  }
  return drafts;
}

export interface TalkCaptionCue {
  segmentId: string;
  /** 源素材时间（秒）：用于逐字一致校验与返修定位 */
  sourceStart: number;
  sourceEnd: number;
  /** 成片主轨时间（秒） */
  masterStart: number;
  masterEnd: number;
  /** 逐字稿原文（保留口语，不做书面化润色） */
  text: string;
  lines: string[];
  /** 关键词强调（字幕工位用于变色/放大）：数字、观点词等 */
  emphasis: string[];
}

/** 关键词强调：数字/百分比与"观点词"，供字幕工位做变色或放大 */
const EMPHASIS_PATTERN = /([0-9０-９]+(?:[%％]|个字|分钟|秒|年|天|块|元|万|亿|次|条|本)?)|(关键|核心|本质|记住|一定要|千万别|其实|因为|所以|结果|第一|第二|第三|最重要)/gu;

/**
 * 金句/洞察判定（用于情绪峰值与保护窗口）。注意：中文里"一/个/天"等字大量出现在日常词里
 * （一个、一定、今天），所以**不能只按单个汉字数字命中**——必须带中文量词或显式列举词，
 * 否则"今天我想聊一个事情"会被误判成金句，把整句划进保护窗口、让该删的语气词删不掉。
 */
const TALK_INSIGHT_PATTERNS = {
  digits: /[0-9０-９]/u,
  measuredNumber: /[一二三四五六七八九十百千万两]\s*(次|条|年|天|分钟|小时|秒|块|元|万|亿|倍|成|%|％)/u,
  enumeration: /第[一二三四五六七八九十](点|条|步|个要点|部分)/u,
  phrase: /记住|关键|本质|核心|最重要的是|我告诉你|总结一下/u,
} as const;

/** 是否像"金句/结论"（带可核对的锚点：数字、列举或观点词） */
export function looksLikeTalkInsight(text: string): boolean {
  return TALK_INSIGHT_PATTERNS.digits.test(text)
    || TALK_INSIGHT_PATTERNS.measuredNumber.test(text)
    || TALK_INSIGHT_PATTERNS.enumeration.test(text)
    || TALK_INSIGHT_PATTERNS.phrase.test(text);
}

export function buildTalkCaptions(
  sentences: TalkSentence[],
  drafts: TalkSegmentDraft[],
  options: { maxLineChars?: number } = {},
): { cues: TalkCaptionCue[]; totalDurationSeconds: number; videoTitle: string } {
  const maxLineChars = options.maxLineChars ?? 12;
  let cursor = 0;
  const cues: TalkCaptionCue[] = drafts.map((draft) => {
    const duration = draft.end - draft.start;
    const masterStart = round(cursor);
    cursor = round(cursor + duration);
    const words = sentences
      .filter((sentence) => draft.sentenceIds.includes(sentence.id))
      .flatMap((sentence) => sentence.words)
      .filter((word) => word.start >= draft.start - 0.02 && word.end <= draft.end + 0.02);
  const raw = words.length > 0 ? words.map((word) => word.text).join("") : draft.text;
  const text = raw.replace(/\s+/gu, "");
  /** 词边界优先断行（不把「特别」切成「特/别」）；词分布不允许时退回字符均分。 */
  const lines = words.length > 0
    ? splitTalkCaptionLinesByWords(words, maxLineChars, 2)
    : splitTalkCaptionLines(text, maxLineChars, 2);
    const emphasis = [...new Set(text.match(EMPHASIS_PATTERN) ?? [])];
    return {
      segmentId: draft.segmentId,
      sourceStart: draft.start,
      sourceEnd: draft.end,
      masterStart,
      masterEnd: round(cursor),
      text,
      lines,
      emphasis,
    };
  });
  const videoTitle = [...normalizeTalkText(drafts[0]?.text ?? "")].slice(0, 12).join("");
  return { cues, totalDurationSeconds: round(cursor), videoTitle };
}

/**
 * 字幕断行（字符兜底）：口播字幕不追求"标点断句"，追求一屏可读完。
 * 行数按 `min(maxLines, ceil(字数/maxLineChars))` 均分——24 字固定切 12+12，
 * 而不是"每 12 字硬切"（后者遇到 13 字会产出 12+1 的尴尬第二行）。
 */
export function splitTalkCaptionLines(text: string, maxLineChars = 12, maxLines = 2): string[] {
  const normalized = normalizeTalkText(text);
  if ([...normalized].length <= maxLineChars) return [normalized];
  const chars = [...normalized];
  const lineCount = Math.min(maxLines, Math.max(1, Math.ceil(chars.length / maxLineChars)));
  const per = Math.ceil(chars.length / lineCount);
  const parts: string[] = [];
  for (let i = 0; i < chars.length; i += per) parts.push(chars.slice(i, i + per).join(""));
  return parts.slice(0, maxLines);
}

/**
 * 字幕断行（词边界优先）：按词累积，尽量不把词/数字/单位切开。
 * 若词分布导致无法满足"≤2 行且每行 ≤12 字"（例如 11+11+2 三词 24 字），
 * 退回字符均分（宁可切字也不让一屏超过两行）。
 */
export function splitTalkCaptionLinesByWords(
  words: Array<{ text: string }>,
  maxLineChars = 12,
  maxLines = 2,
): string[] {
  const tokens = words.map((word) => normalizeTalkText(word.text)).filter((text) => text.length > 0);
  const total = tokens.reduce((sum, token) => sum + [...token].length, 0);
  if (total === 0) return [""];
  if (total <= maxLineChars) return [tokens.join("")];
  const lineCount = Math.min(maxLines, Math.max(1, Math.ceil(total / maxLineChars)));
  const target = Math.ceil(total / lineCount);
  const lines: string[] = [];
  let current = "";
  for (const token of tokens) {
    if (current.length > 0 && [...current].length >= target && lines.length < lineCount - 1) {
      lines.push(current);
      current = "";
    }
    current += token;
  }
  if (current) lines.push(current);
  const valid = lines.length <= maxLines && lines.every((line) => [...line].length <= maxLineChars);
  return valid ? lines : splitTalkCaptionLines(tokens.join(""), maxLineChars, maxLines);
}

export interface TalkTimelineBuild {
  timeline: import("./timeline.js").EditTimeline;
  drafts: TalkSegmentDraft[];
  captions: ReturnType<typeof buildTalkCaptions>;
}

/**
 * 组装口播时间轴：单素材（一条长镜头）+ `sourceGapPolicy=single-take-talking-head`。
 *
 * 为什么要这个策略位：通用剪辑的"同源片段间隔 ≥1s"是防止同镜反复使用；而口播精剪**本质上**
 * 就是在同一条长镜头内做密集跳切，间隔天然 <1s。策略位把这条规则改为"按体裁适用"，
 * 同时保留真正的事实硬闸：不重叠、源轨顺序单调、主轨连续、逐段溯源。
 */
export function buildTalkTimeline(
  sentences: TalkSentence[],
  analysis: TalkAnalysis,
  plan: TalkCutPlan,
  options: TalkTimelineOptions,
): TalkTimelineBuild {
  const drafts = draftTalkSegments(sentences, analysis, plan, {
    ...(options.maxSegmentSeconds !== undefined ? { maxSegmentSeconds: options.maxSegmentSeconds } : {}),
    punchIn: options.punchIn ?? plan.options.punchIn,
    ...(options.punchInScales ? { punchInScales: options.punchInScales } : {}),
  });
  if (drafts.length === 0) throw new Error("剪取计划没有产生任何保留段：检查输入逐字稿与选项");
  const captions = buildTalkCaptions(sentences, drafts, {});
  const segments: Array<import("./timeline.js").EditTimelineSegment> = drafts.map((draft, index) => {
    const cue = captions.cues[index]!;
    const previous = drafts[index - 1];
    return {
      seq: index,
      segmentId: draft.segmentId,
      groupId: draft.blockId,
      sourceId: options.source.sourceId,
      sourceIn: draft.start,
      sourceOut: draft.end,
      durationSeconds: round(draft.end - draft.start),
      speed: 1,
      motive: draft.jumpCut
        ? `口播跳切：删除停顿/语气词后压缩 ${round(draft.start - (previous?.end ?? draft.start))}s，${draft.punchIn ? "已用推近遮盖" : "未遮盖（需人工确认）"}`
        : "口播连续段：保持原语气与节奏",
      transitionIn: { type: "cut", durationSeconds: 0, params: draft.punchIn ? { punchIn: draft.punchIn.scale } : null },
      audio: { mode: "original", gainDb: 0, note: "保留现场原声：口播的声音质地就是信任感" },
      subtitle: { lines: cue.lines, placement: "bottom", emphasis: cue.emphasis.join("/") || null },
      masterIn: cue.masterStart,
      masterOut: cue.masterEnd,
      ...(draft.punchIn ? { punchIn: { scale: draft.punchIn.scale, note: draft.punchIn.note } } : {}),
    };
  });
  const timeline: import("./timeline.js").EditTimeline = {
    schemaVersion: "workloom.video-edit/edit-timeline/v2",
    timelineId: options.timelineId,
    filmId: options.filmId ?? null,
    revision: 1,
    prevRevision: null,
    pacing: { profile: "talk", enforce: false },
    sourceGapPolicy: "single-take-talking-head",
    target: options.target,
    sources: [{ ...options.source }],
    groups: analysis.blocks
      .filter((block) => drafts.some((draft) => draft.blockId === block.id))
      .map((block) => ({ groupId: block.id, name: block.title, storyline: null, emotion: null, intensity: null })),
    segments,
    audioDesign: {
      originalAudioPolicy: "duck_under_bgm",
      bgm: { needed: true, style: "轻底噪", levelDb: -24, note: "轻度 BGM：让位人声，不抢口播的情绪" },
      soundEffects: [],
      silenceNotes: "口播不卡点：BGM 不按拍子切，只在段落转场处做轻微让位",
    },
    validation: {
      continuous: true,
      noSourceOverlap: true,
      totalDurationSeconds: captions.totalDurationSeconds,
      sourceGapPolicy: "single-take-talking-head",
      generatedBy: "edit-talk-cut",
    },
  };
  return { timeline, drafts, captions };
}

export interface TalkCheck {
  id: string;
  pass: boolean;
  hard: boolean;
  detail: string;
}

export interface TalkFix {
  decisionId: string;
  field: string;
  action: string;
  severity: "hard" | "advisory";
}

export interface TalkValidation {
  ok: boolean;
  checks: TalkCheck[];
  fixes: TalkFix[];
}

/**
 * 口播质检（在通用时间轴校验之外的口播专属项）：
 *   · 事实硬闸：字幕逐字一致、删除不得切进词内、句子不得被剪成残句；
 *   · 人味护栏：语气词/停顿保留率低于下限即挂起（除非人审显式放行）；
 *   · 咨询项：平滑风险、跳切遮盖、单条字幕过长。
 */
export function validateTalkCut(input: {
  sentences: TalkSentence[];
  analysis: TalkAnalysis;
  plan: TalkCutPlan;
  captions: { cues: TalkCaptionCue[] };
  timelineOk?: boolean;
  timelineChecks?: Array<{ id: string; pass: boolean; hard: boolean; detail: string }>;
  /** 显式人审放行：允许跌破人味下限（必须由人给出并写进回执） */
  humanApprovedBelowFloor?: boolean;
}): TalkValidation {
  const { sentences, analysis, plan, captions } = input;
  const checks: TalkCheck[] = [];
  const fixes: TalkFix[] = [];
  const words = flattenTalkWords(sentences);

  /** ① 逐字一致：每条字幕必须等于该段保留词的逐字拼接（不许多字、不许少字、不许润色） */
  for (const cue of captions.cues) {
    const expected = words
      .filter((word) => word.start >= cue.sourceStart - 0.02 && word.end <= cue.sourceEnd + 0.02)
      .map((word) => word.text)
      .join("")
      .replace(/\s+/gu, "");
    const actual = normalizeTalkText(cue.text);
    const pass = normalizeTalkText(expected) === actual && actual.length > 0;
    checks.push({
      id: `caption.verbatim:${cue.segmentId}`,
      pass,
      hard: true,
      detail: pass
        ? `${cue.segmentId} 字幕与逐字稿逐字一致（${actual.length} 字）`
        : `${cue.segmentId} 字幕与逐字稿不一致：稿=「${expected}」字幕=「${actual}」`,
    });
    if (!pass) {
      fixes.push({ decisionId: cue.segmentId, field: "subtitle_text", action: "字幕改回逐字稿原文（要改写必须先取得改写授权）", severity: "hard" });
    }
  }

  /** ② 删除边界：不得切进词内（容差 30ms） */
  let boundaryFailures = 0;
  for (const [index, cut] of plan.cutSpans.entries()) {
    const startAligned = words.some((word) => Math.abs(word.start - cut.start) <= 0.03 || Math.abs(word.end - cut.start) <= 0.03)
      || analysis.pauses.some((pause) => cut.start >= pause.start - 0.03 && cut.start <= pause.end + 0.03);
    const endAligned = words.some((word) => Math.abs(word.start - cut.end) <= 0.03 || Math.abs(word.end - cut.end) <= 0.03)
      || analysis.pauses.some((pause) => cut.end >= pause.start - 0.03 && cut.end <= pause.end + 0.03);
    if (!startAligned || !endAligned) {
      boundaryFailures += 1;
      checks.push({
        id: `cut.boundary:${index}`,
        pass: false,
        hard: true,
        detail: `删除区间 ${round(cut.start)}–${round(cut.end)}s 未对齐词边界或停顿区间（会切进词内）`,
      });
      fixes.push({ decisionId: `cut-${index}`, field: "start/end", action: "把删除端点对齐到词边界或停顿两端", severity: "hard" });
    }
  }
  checks.push({
    id: "cut.boundaryAll",
    pass: boundaryFailures === 0,
    hard: true,
    detail: boundaryFailures === 0
      ? `全部 ${plan.cutSpans.length} 个删除区间的端点都落在词边界/停顿上`
      : `${boundaryFailures} 个删除区间端点未对齐`,
  });

  /** ③ 句子完整性：被部分保留的句子不得只剩残句（<25% 保留且仍保留） */
  for (const sentence of sentences) {
    const keptSpans = plan.keepSpans.filter((span) => span.end > sentence.start + 0.02 && span.start < sentence.end - 0.02);
    if (keptSpans.length === 0) continue;
    const keptSeconds = keptSpans.reduce((sum, span) =>
      sum + (Math.min(span.end, sentence.end) - Math.max(span.start, sentence.start)), 0);
    const sentenceSeconds = Math.max(0.001, sentence.end - sentence.start);
    const keptRatio = keptSeconds / sentenceSeconds;
    if (keptRatio < 0.25) {
      checks.push({
        id: `sentence.fragment:${sentence.id}`,
        pass: false,
        hard: true,
        detail: `句子「${sentence.text.slice(0, 12)}…」只剩 ${round(keptRatio * 100, 0)}% 被保留：要么整句保留，要么整句删除，不要留残句`,
      });
      fixes.push({ decisionId: sentence.id, field: "keepSpans", action: "把这一句整句保留或整句删除（避免「但是…」这类残句）", severity: "hard" });
    }
    if (/[的了和跟因为但是所以然后而且]$/u.test(sentence.text.trim()) && keptRatio < 0.9) {
      checks.push({
        id: `sentence.dangling:${sentence.id}`,
        pass: false,
        hard: false,
        detail: `句子「${sentence.text.slice(0, 12)}…」以连接词收尾且被部分删除：注意后半句是否还在`,
      });
    }
  }

  /** ④ 人味下限（可被人审显式放行） */
  const belowFiller = plan.metrics.fillerTotal > 0 && plan.metrics.fillerKeepRate < plan.options.fillerKeepRateFloor;
  const belowPause = plan.metrics.pauseTotalSeconds > 0 && plan.metrics.pauseKeepRate < plan.options.pauseKeepRateFloor;
  const floorChecks: Array<[string, boolean, string]> = [
    ["humanness.fillerFloor", belowFiller, `语气词保留率 ${plan.metrics.fillerKeepRate} < 下限 ${plan.options.fillerKeepRateFloor}`],
    ["humanness.pauseFloor", belowPause, `停顿保留率 ${plan.metrics.pauseKeepRate} < 下限 ${plan.options.pauseKeepRateFloor}`],
  ];
  for (const [id, below, detail] of floorChecks) {
    if (!below) {
      checks.push({ id, pass: true, hard: true, detail: "人味下限达标" });
      continue;
    }
    const approved = input.humanApprovedBelowFloor === true;
    checks.push({
      id,
      pass: approved,
      hard: !approved,
      detail: approved
        ? `${detail}，但已有人审显式放行（留痕）`
        : `${detail}：删过头会"像 AI 念稿"，需人审显式放行或恢复语气词/停顿`,
    });
    if (!approved) {
      fixes.push({
        decisionId: id,
        field: "fillerKeepRate/pauseKeepRate",
        action: "恢复若干语气词或在句间恢复停顿；确要更紧凑须人审显式放行",
        severity: "hard",
      });
    }
  }

  /** ⑤ 咨询项 */
  checks.push({
    id: "humanness.smoothingRisk",
    pass: plan.metrics.smoothingRisk < TALK_DEFAULTS.smoothingRiskWarn,
    hard: false,
    detail: `平滑风险 ${plan.metrics.smoothingRisk}（阈值 ${TALK_DEFAULTS.smoothingRiskWarn}）`,
  });
  checks.push({
    id: "talk.punchInCoverage",
    pass: plan.options.punchIn === "alternate" || plan.cutSpans.length === 0,
    hard: false,
    detail: plan.options.punchIn === "alternate"
      ? `跳切 ${plan.cutSpans.length} 处，全部纳入交替推近遮盖计划`
      : `跳切 ${plan.cutSpans.length} 处且未启用推近遮盖：同机位密集跳切观感会"跳帧"`,
  });
  /**
   * 字幕长度口径：竖屏口播一屏最多两行（每行 12 字），所以"超长"的判定是
   * 行数 >2 或总字数 >24；只按总字数判会把"两行正常句"误标成超长。
   */
  const longCues = captions.cues.filter((cue) => cue.lines.length > 2 || textLength(cue.text) > 24);
  checks.push({
    id: "caption.length",
    pass: longCues.length === 0,
    hard: false,
    detail: longCues.length === 0 ? "无超长字幕条（≤2 行 / ≤24 字）" : `${longCues.length} 条字幕超过两行或 24 字：口播字幕应短、可扫读`,
  });
  if (input.timelineChecks) {
    for (const check of input.timelineChecks) {
      checks.push({ id: `timeline.${check.id}`, pass: check.pass, hard: check.hard, detail: check.detail });
    }
  }

  /**
   * ⑥ 区间与指标互证（2026-10-11 新增，硬项）：
   * "台账/指标自报达标、成片区间却没变"是本管线最危险的假达标——
   * 实测复现：人味下限补偿恢复了 3 个语气词并让保留率从 0.417 涨到 0.667，
   * 但 cutSpans 仍是整段 (6.4, 8.5)，成片里那 3 个字照样被删。
   * 这里强制三件事：保留/删除区间互补、被"恢复"的项真的不在删除区、指标与区间同源。
   */
  const deadline = sentences[sentences.length - 1]!.end;
  const keepTotal = plan.keepSpans.reduce((sum, span) => sum + (span.end - span.start), 0);
  const cutTotal = plan.cutSpans.reduce((sum, span) => sum + (span.end - span.start), 0);
  const cutOverlaps = plan.cutSpans.some((span, index) => index > 0 && span.start < plan.cutSpans[index - 1]!.end - 0.02);
  const keepOverlaps = plan.keepSpans.some((span, index) => index > 0 && span.start < plan.keepSpans[index - 1]!.end - 0.02);
  const complementOk = Math.abs(keepTotal + cutTotal - deadline) < 0.05 && !cutOverlaps && !keepOverlaps;
  checks.push({
    id: "spans.complement",
    pass: complementOk,
    hard: true,
    detail: complementOk
      ? `保留 ${round(keepTotal)}s + 删除 ${round(cutTotal)}s = 全片 ${round(deadline)}s，且区间互不重叠`
      : `保留/删除区间与全片不互补（保留 ${round(keepTotal)}s + 删除 ${round(cutTotal)}s ≠ ${round(deadline)}s）或存在重叠`,
  });
  if (!complementOk) {
    fixes.push({ decisionId: "keepSpans/cutSpans", field: "spans", action: "按最终删除区间重算保留区间（用 removeIntervalFromSpans/subtractSpans）", severity: "hard" });
  }

  const restored = plan.decisions.filter((decision) => decision.reason === "human-floor-keep");
  const stillCut = restored.filter((decision) =>
    plan.cutSpans.reduce((sum, span) => sum + overlapSeconds(span, decision), 0) > (decision.end - decision.start) * 0.5);
  checks.push({
    id: "spans.humanFloorRestored",
    pass: stillCut.length === 0,
    hard: true,
    detail: stillCut.length === 0
      ? `人味下限恢复的 ${restored.length} 项都确实留在了成片区间里`
      : `${stillCut.length} 项"人味下限恢复"实际仍在删除区间里（台账与成片不一致）：${stillCut.map((decision) => `${round(decision.start)}–${round(decision.end)}`).join("、")}`,
  });
  if (stillCut.length > 0) {
    fixes.push({ decisionId: "human-floor-keep", field: "cutSpans", action: "把恢复项从删除区间中抠掉（可切开合并区间），或撤销该 keep 决策", severity: "hard" });
  }

  const derivedFillerKept = analysis.fillers.filter((filler) =>
    plan.cutSpans.reduce((sum, span) => sum + overlapSeconds(span, filler), 0) < (filler.end - filler.start) * 0.5).length;
  const fillerConsistent = derivedFillerKept === plan.metrics.fillerKept;
  checks.push({
    id: "metrics.fillerConsistent",
    pass: fillerConsistent,
    hard: true,
    detail: fillerConsistent
      ? `语气词保留数 ${plan.metrics.fillerKept} 与最终区间一致`
      : `语气词保留数自报 ${plan.metrics.fillerKept}，按最终区间实际为 ${derivedFillerKept}`,
  });
  if (!fillerConsistent) {
    fixes.push({ decisionId: "metrics.fillerKept", field: "metrics", action: "指标改为按最终 keepSpans/cutSpans 重算（不信任决策自报数）", severity: "hard" });
  }

  const derivedPauseKept = round(analysis.pauses.reduce((sum, pause) => {
    const cut = plan.cutSpans.reduce((acc, span) => acc + overlapSeconds(span, pause), 0);
    return sum + Math.max(0, pause.durationSeconds - cut);
  }, 0), 3);
  const pauseConsistent = Math.abs(derivedPauseKept - plan.metrics.pauseKeptSeconds) <= 0.05;
  checks.push({
    id: "metrics.pauseConsistent",
    pass: pauseConsistent,
    hard: true,
    detail: pauseConsistent
      ? `停顿保留秒数 ${plan.metrics.pauseKeptSeconds}s 与最终区间一致`
      : `停顿保留秒数自报 ${plan.metrics.pauseKeptSeconds}s，按最终区间实际为 ${derivedPauseKept}s`,
  });
  if (!pauseConsistent) {
    fixes.push({ decisionId: "metrics.pauseKeptSeconds", field: "metrics", action: "指标改为按最终 keepSpans/cutSpans 重算（不信任决策自报数）", severity: "hard" });
  }

  const ok = checks.every((check) => check.pass || !check.hard) && (input.timelineOk ?? true);
  return { ok, checks, fixes };
}

/** 口播字幕 → SRT（逐字、按行、无标点） */
export function talkCuesToSrt(cues: TalkCaptionCue[]): string {
  /** 复用 caption.ts 的稳健实现：毫秒进位不会产出非法 `,1000`（旧实现有同样的问题）。 */
  const format = srtTimestamp;
  return cues
    .map((cue, index) => `${index + 1}\n${format(cue.masterStart)} --> ${format(cue.masterEnd)}\n${cue.lines.join("\n")}\n`)
    .join("\n");
}

/** 口播字幕 → 剪辑脚本字幕版（caption_script 契约兼容，供 edit:subtitle 消费） */
export function buildTalkCaptionDoc(input: {
  cues: TalkCaptionCue[];
  videoTitle: string;
  videoId: string;
  totalDurationSeconds: number;
  groupName?: string;
}): Record<string, unknown> {
  const mmss = (seconds: number): string => {
    const total = Math.round(seconds);
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  };
  return {
    video_title: input.videoTitle,
    video_id: input.videoId,
    total_duration: mmss(input.totalDurationSeconds),
    video_groups: [{
      group_name: input.groupName ?? "口播正片",
      group_duration: mmss(input.totalDurationSeconds),
      shots: input.cues.map((cue) => ({
        segmentId: cue.segmentId,
        /** 源素材时间码：口播字幕的逐字一致校验（与 ASR 稿比对）用它，不用成片时间码。 */
        source_timestamp: `${cue.sourceStart.toFixed(3)}-${cue.sourceEnd.toFixed(3)}`,
        original_timestamp: `${cue.masterStart.toFixed(3)}-${cue.masterEnd.toFixed(3)}`,
        subtitle_text: [{ text: cue.lines.join("\n") }],
        emphasis: cue.emphasis,
      })),
    }],
    notes: "口播字幕版：逐字来自 ASR，不做书面化润色；不卡 BGM 拍点（卡点会让口播显得假）。",
  };
}
