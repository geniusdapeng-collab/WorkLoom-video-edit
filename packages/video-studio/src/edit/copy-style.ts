/**
 * edit/copy-style.ts —— 字幕文案的"风格 × 目标 × 人设"层（2026-10-11 产品所有者口径）。
 *
 * 问题（客户原话）：字幕文案要更像"人说的话"，而且要跟短片风格相关——
 * vlog / 带货 / 知识分享各有各的说法，文案服务于短片风格与目标，还要符合博主的人设。
 *
 * 分工：
 *   · 本模块只做三件事：① 把风格/人设解析成**可执行档案**；② 给数字员工出**写作简报**；
 *     ③ 对回来的文案做**机检评分**（AI 腔、书面语、人设命中、字数带、句式重复、标点纪律）；
 *   · 真正的创作仍由"文案字幕师"岗位完成（LLM），机检只拦明显废稿，不代写。
 *
 * 边界：不做事实增补——所有事实以镜头表/素材证据为准（facts 入参）；无证据的数字/地名一律报 issue。
 */

export interface CopyStylePreset {
  id: string;
  name: string;
  /** 适用短片风格 */
  positioning: string;
  /** 服务的目标 */
  goals: string[];
  sentence: {
    /** 单条字幕的最短/最长字数（中文字符） */
    minChars: number;
    maxChars: number;
    maxLines: number;
    /** 节奏描述（写作时执行） */
    rhythm: string;
  };
  voice: {
    person: "第一人称" | "第二人称" | "第三人称" | "混合";
    /** 该风格鼓励的口语标记 */
    oralMarkers: string[];
    /** 该风格禁用/慎用词 */
    banned: string[];
    /** 标点口径 */
    punctuation: string;
  };
  examples: Array<{ plain: string; styled: string }>;
}

/** 风格预设：id 与短视频风格一一对应，写作与机检共用同一份档案。 */
export const COPY_STYLES: Record<string, CopyStylePreset> = {
  vlog: {
    id: "vlog",
    name: "生活流 vlog",
    positioning: "日常记录/旅行/回家：像跟朋友唠嗑，有现场感与情绪起伏",
    goals: ["陪伴感", "完播", "关注"],
    sentence: { minChars: 4, maxChars: 16, maxLines: 2, rhythm: "短句为主，长短交替；一句一个动作或一个感受" },
    voice: {
      person: "混合",
      oralMarkers: ["了", "呢", "就", "都", "真", "还", "吧", "没", "可", "挺", "咱"],
      banned: ["让我们一起", "不妨", "值得一试", "尽享", "开启", "之旅"],
      punctuation: "行内不加标点（字幕排版统一），断句用换行",
    },
    examples: [
      { plain: "这里非常美丽，让人感受到宁静", styled: "风一停 整条街都安静了" },
      { plain: "品尝当地的特色美食", styled: "先来碗羊汤 热乎的" },
    ],
  },
  promo: {
    id: "promo",
    name: "带货推荐",
    positioning: "带货/本地生活/促销：直给利益点，先结论后理由，行动号召清楚",
    goals: ["转化", "点击", "下单"],
    sentence: { minChars: 4, maxChars: 15, maxLines: 2, rhythm: "短促、信息密度高；卖点句 + 证明句交替" },
    voice: {
      person: "第一人称",
      oralMarkers: ["就", "只要", "真", "才", "直接", "够", "顶"],
      banned: ["让我们一起", "众所周知", "毋庸置疑", "堪称", "尽享"],
      punctuation: "行内不加标点；数字与价格写清楚，不写极限词",
    },
    examples: [
      { plain: "这款产品非常值得购买", styled: "39块 我直接囤了三箱" },
      { plain: "口感非常好，推荐大家尝试", styled: "汤是真浓 喝完还想续" },
    ],
  },
  knowledge: {
    id: "knowledge",
    name: "知识分享",
    positioning: "知识/教程/测评：一句一个结论，先给结论再给依据，不绕弯",
    goals: ["收藏", "信任", "涨粉"],
    sentence: { minChars: 5, maxChars: 18, maxLines: 2, rhythm: "陈述句为主；结论句短，依据句稍长" },
    voice: {
      person: "第一人称",
      oralMarkers: ["其实", "就是", "记住", "注意", "关键是", "简单说"],
      banned: ["让我们一起", "不妨", "尽享", "之旅", "绝绝子"],
      punctuation: "行内不加标点；数字用阿拉伯数字",
    },
    examples: [
      { plain: "接下来我们需要进行系统的分析", styled: "记住这三点 顺序别乱" },
      { plain: "这个方法十分有效", styled: "这招最省事 一遍就会" },
    ],
  },
  story: {
    id: "story",
    name: "情感故事",
    positioning: "情感/人物/纪录片：克制、有画面感，留白比解释更打动人",
    goals: ["共情", "完播", "转发"],
    sentence: { minChars: 4, maxChars: 14, maxLines: 2, rhythm: "短句留白；一段话只说一件事" },
    voice: {
      person: "第三人称",
      oralMarkers: ["了", "还", "就", "又", "才", "再"],
      banned: ["让我们一起", "治愈", "美好", "仪式感", "氛围感", "值得"],
      punctuation: "行内不加标点",
    },
    examples: [
      { plain: "她感受到了一种幸福的氛围", styled: "她抬头 笑得像个孩子" },
      { plain: "这是一段美好的回忆", styled: "那天的话 她记了很多年" },
    ],
  },
  food: {
    id: "food",
    name: "美食探店",
    positioning: "美食/探店：先馋人再讲理，味道要有具体参照物",
    goals: ["种草", "到店", "完播"],
    sentence: { minChars: 4, maxChars: 15, maxLines: 2, rhythm: "拟声/质感词 + 具体参照；每 2–3 句一个味觉信息" },
    voice: {
      person: "第一人称",
      oralMarkers: ["就", "真", "够", "才", "顶", "嫩", "香"],
      banned: ["让我们一起", "不妨一试", "尽享", "味蕾的盛宴", "垂涎欲滴"],
      punctuation: "行内不加标点",
    },
    examples: [
      { plain: "这道菜味道非常鲜美，令人垂涎欲滴", styled: "羊汤得趁热喝 一口下去全是胡椒香" },
      { plain: "面条十分劲道", styled: "面是手擀的 弹牙" },
    ],
  },
};

export interface PersonaProfile {
  id?: string;
  name?: string;
  /** 博主身份（如：山东姑娘 / 数码测评师） */
  identity?: string;
  /** 受众（如：同龄朋友 / 宝妈） */
  audience?: string;
  /** 自称（如：我 / 咱） */
  selfAddress?: string;
  /** 对观众的称呼（如：你们 / 家人们 / 朋友们；不强制出现） */
  audienceAddress?: string;
  /** 口头禅（人设词，机检鼓励自然出现） */
  verbalTics?: string[];
  /** 方言/地域词 */
  dialectWords?: string[];
  /** 人设禁用词（优先级高于风格禁用词） */
  bannedWords?: string[];
  /** 幽默度 0–1（仅作档案记录，机检不做审美判断） */
  humor?: number;
}

export function normalizePersona(raw: unknown): PersonaProfile {
  if (!raw || typeof raw !== "object") return {};
  const doc = raw as Record<string, unknown>;
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : []);
  return {
    id: doc.id == null ? undefined : String(doc.id),
    name: doc.name == null ? undefined : String(doc.name),
    identity: doc.identity == null ? undefined : String(doc.identity),
    audience: doc.audience == null ? undefined : String(doc.audience),
    selfAddress: doc.selfAddress == null ? undefined : String(doc.selfAddress),
    audienceAddress: doc.audienceAddress == null ? undefined : String(doc.audienceAddress),
    verbalTics: strings(doc.verbalTics),
    dialectWords: strings(doc.dialectWords),
    bannedWords: strings(doc.bannedWords),
    humor: Number.isFinite(Number(doc.humor)) ? Number(doc.humor) : undefined,
  };
}

export interface CopyProfile {
  style: CopyStylePreset;
  persona: PersonaProfile;
  /** 风格 + 人设合并后的禁用词（人设优先叠加） */
  bannedWords: string[];
}

/** 按"短片风格 → 预设"解析；未命中时按题材关键词兜底（仍失败则用 vlog）。 */
export function resolveCopyStyle(styleId?: string | null, genre?: string | null): CopyStylePreset {
  const key = String(styleId ?? "").trim().toLowerCase();
  if (COPY_STYLES[key]) return COPY_STYLES[key]!;
  const genreText = String(genre ?? "");
  if (/带货|促销|电商|本地生活|团购/.test(genreText)) return COPY_STYLES.promo!;
  if (/知识|教程|测评|科普|数码|课程/.test(genreText)) return COPY_STYLES.knowledge!;
  if (/情感|人物|纪录|故事/.test(genreText)) return COPY_STYLES.story!;
  if (/美食|探店|餐饮|菜/.test(genreText)) return COPY_STYLES.food!;
  return COPY_STYLES.vlog!;
}

export function resolveCopyProfile(options: {
  styleId?: string | null;
  genre?: string | null;
  persona?: unknown;
}): CopyProfile {
  const style = resolveCopyStyle(options.styleId, options.genre);
  const persona = normalizePersona(options.persona);
  const bannedWords = [...new Set([...style.voice.banned, ...(persona.bannedWords ?? [])])];
  return { style, persona, bannedWords };
}

export interface CopyCue {
  index?: number;
  start?: number;
  end?: number;
  text: string;
}

export interface CopyIssue {
  cueIndex: number;
  text: string;
  code: "ai-phrase" | "banned-word" | "written-word" | "length-band" | "punctuation" | "opening-repeat" | "persona-miss" | "fabrication-risk";
  severity: "hard" | "soft";
  detail: string;
  suggestion?: string;
}

export interface CopyMetrics {
  cues: number;
  avgChars: number;
  oralMarkerRate: number;
  personaTicRate: number;
  styleFitScore: number;
}

export interface CopyEvaluation {
  ok: boolean;
  score: number;
  metrics: CopyMetrics;
  issues: CopyIssue[];
}

/** AI 腔/说明书腔：出现即扣分，其中"让我们一起/尽享/堪程"等属硬伤。 */
const AI_PHRASES: Array<{ phrase: string; severity: "hard" | "soft"; suggestion: string }> = [
  { phrase: "让我们一起", severity: "hard", suggestion: "改成「咱们」「我带你」这类真实说法" },
  { phrase: "不妨", severity: "soft", suggestion: "改成「可以」「要不」" },
  { phrase: "值得一试", severity: "soft", suggestion: "改成具体到味觉/触感的短句" },
  { phrase: "尽享", severity: "hard", suggestion: "删掉，换成具体动作或感受" },
  { phrase: "垂涎欲滴", severity: "hard", suggestion: "写具体的香/浓/烫，不写成语" },
  { phrase: "味蕾的盛宴", severity: "hard", suggestion: "写具体味道" },
  { phrase: "仪式感", severity: "soft", suggestion: "写具体动作（摆盘/点灯/碰杯）" },
  { phrase: "氛围感", severity: "soft", suggestion: "写画面里真实存在的元素（灯/雨/音乐）" },
  { phrase: "疗愈", severity: "soft", suggestion: "别贴标签，把情绪写进细节" },
  { phrase: "治愈", severity: "soft", suggestion: "写让人放松的具体场景" },
  { phrase: "美好", severity: "soft", suggestion: "换具体形容词或直接给画面" },
  { phrase: "开启", severity: "soft", suggestion: "改成「开始」「上手」" },
  { phrase: "之旅", severity: "soft", suggestion: "删掉，直接说去哪/做什么" },
  { phrase: "进行", severity: "soft", suggestion: "删掉「进行」，动词直接上" },
  { phrase: "以及", severity: "soft", suggestion: "改成「还有」「和」" },
  { phrase: "并且", severity: "soft", suggestion: "改成「还」「而且」" },
  { phrase: "然而", severity: "soft", suggestion: "改成「不过」" },
  { phrase: "使得", severity: "soft", suggestion: "改成「让」" },
  { phrase: "令人", severity: "soft", suggestion: "改成「让人」" },
  { phrase: "非常", severity: "soft", suggestion: "改成「特别」「真」「贼」" },
  { phrase: "十分", severity: "soft", suggestion: "改成「特别」「特」" },
  { phrase: "品尝", severity: "soft", suggestion: "改成「尝」「喝」「吃」" },
  { phrase: "位于", severity: "soft", suggestion: "改成「在」" },
  { phrase: "众所周知", severity: "hard", suggestion: "删掉，直接给信息" },
  { phrase: "毋庸置疑", severity: "hard", suggestion: "删掉，直接给证据" },
];

/** 通用"书面词 → 口语"替换（rewriteCue 只做安全替换）。 */
const ORAL_REPLACEMENTS: Array<[RegExp, string]> = [
  [/让我们一起/g, "咱们"],
  [/众所周知/g, ""],
  [/毋庸置疑/g, ""],
  [/不妨/g, "可以"],
  [/值得一试/g, "可以试试"],
  [/尽享/g, ""],
  [/垂涎欲滴/g, "香得很"],
  [/非常/g, "特别"],
  [/十分/g, "特"],
  [/品尝/g, "尝"],
  [/位于/g, "在"],
  [/以及/g, "还有"],
  [/并且/g, "还"],
  [/然而/g, "不过"],
  [/使得/g, "让"],
  [/令人/g, "让人"],
  [/进行([^\s，。！？,.!?]*)/g, "$1"],
];

const DEFAULT_ORAL_MARKERS = ["了", "呢", "吧", "啊", "嘛", "呗", "哈", "就", "都", "还", "真", "挺", "可", "没", "别"];

export interface CopyFacts {
  /** 允许出现的实体/地名/品牌/数字（字幕里出现集合外的数字或专名会被标 fabrication-risk） */
  allowedTerms?: string[];
  /** 镜头事实（供简报与核对）：每段的画面要点 */
  shots?: Array<{ segmentId?: string; summary?: string }>;
}

function visualLength(text: string): number {
  let total = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/u.test(ch)) total += 1;
    else if (/[0-9A-Za-z]/u.test(ch)) total += 0.5;
  }
  return total;
}

/**
 * 文案机检：AI 腔/书面词/字数带/标点/句首重复/人设命中。
 * 评分 0–100：硬伤每条 -8，软伤 -2，长度带外 -3，句首重复 -2；人设词缺失仅提示不扣分。
 */
export function evaluateCopy(options: {
  cues: CopyCue[];
  profile: CopyProfile;
  facts?: CopyFacts;
  /** 字数带（默认用风格预设；传入 durationSeconds 时按 2.0–2.5 字/秒夹取） */
  charsPerSecond?: { min: number; max: number };
}): CopyEvaluation {
  const { cues, profile } = options;
  const facts = options.facts ?? {};
  const charsPerSecond = options.charsPerSecond ?? { min: 2.0, max: 2.5 };
  const issues: CopyIssue[] = [];
  const oralMarkers = [...new Set([...profile.style.voice.oralMarkers, ...DEFAULT_ORAL_MARKERS])];
  const personaTics = [...(profile.persona.verbalTics ?? []), ...(profile.persona.dialectWords ?? [])];
  let oralMarkerCues = 0;
  let personaTicCues = 0;
  let previousOpening = "";
  let previousRun = 0;

  cues.forEach((cue, index) => {
    const text = String(cue.text ?? "").trim();
    const cueIndex = cue.index ?? index + 1;
    if (!text) {
      issues.push({ cueIndex, text, code: "fabrication-risk", severity: "hard", detail: "空字幕" });
      return;
    }
    const length = visualLength(text);
    const duration = cue.start != null && cue.end != null ? Math.max(0, Number(cue.end) - Number(cue.start)) : null;
    const minChars = duration ? Math.max(profile.style.sentence.minChars, Math.ceil(duration * charsPerSecond.min)) : profile.style.sentence.minChars;
    const maxChars = duration ? Math.min(profile.style.sentence.maxChars, Math.floor(duration * charsPerSecond.max)) : profile.style.sentence.maxChars;
    if (length < minChars || length > maxChars) {
      issues.push({
        cueIndex, text, code: "length-band", severity: "soft",
        detail: `视觉字数 ${length} 超出 ${minChars}–${maxChars} 带${duration ? `（时长 ${duration.toFixed(1)}s）` : ""}`,
        suggestion: length > maxChars ? "砍修饰或拆句" : "补一条画面事实，不补空话",
      });
    }
    for (const { phrase, severity, suggestion } of AI_PHRASES) {
      if (text.includes(phrase)) issues.push({ cueIndex, text, code: "ai-phrase", severity, detail: `AI 腔/书面语「${phrase}」`, suggestion });
    }
    for (const word of profile.bannedWords) {
      if (word && text.includes(word)) issues.push({ cueIndex, text, code: "banned-word", severity: "soft", detail: `命中禁用词「${word}」`, suggestion: "换成本风格的口语说法" });
    }
    if (/[，。！？；：,.!?;:]/u.test(text)) {
      issues.push({ cueIndex, text, code: "punctuation", severity: "soft", detail: "行内出现标点（字幕排版统一无标点）", suggestion: "用换行断句" });
    }
    const opening = text[0] ?? "";
    if (opening === previousOpening) {
      previousRun += 1;
      if (previousRun >= 2) {
        issues.push({ cueIndex, text, code: "opening-repeat", severity: "soft", detail: `连续 ${previousRun + 1} 条以「${opening}」开头`, suggestion: "换句式，长短句交替" });
      }
    } else {
      previousRun = 0;
    }
    previousOpening = opening;
    if (oralMarkers.some((marker) => text.includes(marker))) oralMarkerCues += 1;
    if (personaTics.length && personaTics.some((tic) => text.includes(tic))) personaTicCues += 1;
    const allowed = facts.allowedTerms ?? [];
    const numbers = text.match(/[0-9]+/gu) ?? [];
    for (const number of numbers) {
      if (allowed.length && !allowed.some((term) => term.includes(number))) {
        issues.push({ cueIndex, text, code: "fabrication-risk", severity: "hard", detail: `数字「${number}」不在事实清单里`, suggestion: "核对素材事实，或删掉数字" });
      }
    }
  });

  const hard = issues.filter((issue) => issue.severity === "hard").length;
  const soft = issues.filter((issue) => issue.severity === "soft").length;
  const score = Math.max(0, 100 - hard * 8 - soft * 2);
  const oralMarkerRate = cues.length ? oralMarkerCues / cues.length : 0;
  const personaTicRate = personaTics.length && cues.length ? personaTicCues / cues.length : 0;
  const metrics: CopyMetrics = {
    cues: cues.length,
    avgChars: cues.length ? Math.round((cues.reduce((total, cue) => total + visualLength(String(cue.text ?? "")), 0) / cues.length) * 10) / 10 : 0,
    oralMarkerRate: Math.round(oralMarkerRate * 100) / 100,
    personaTicRate: Math.round(personaTicRate * 100) / 100,
    styleFitScore: Math.max(0, 100 - soft * 4 - hard * 10),
  };
  return { ok: hard === 0, score, metrics, issues };
}

/** 规则化"去 AI 腔"（保守替换；真正的重写交给文案字幕师，本函数只做安全兜底）。 */
export function rewriteCue(text: string, profile: CopyProfile): string {
  let output = String(text ?? "");
  for (const [pattern, replacement] of ORAL_REPLACEMENTS) output = output.replace(pattern, replacement);
  for (const word of profile.bannedWords) {
    if (word && output.includes(word)) output = output.split(word).join("");
  }
  return output.replace(/[，。！？；：,.!?;:]/gu, " ").replace(/\s+/gu, " ").trim();
}

/** 写作简报：交给"文案字幕师"岗位的提示词正文（风格 × 目标 × 人设 × 镜头事实）。 */
export function buildCopyBrief(options: {
  profile: CopyProfile;
  cues: CopyCue[];
  facts?: CopyFacts;
  goal?: string | null;
  platform?: string | null;
}): string {
  const { profile, cues, facts } = options;
  const lines: string[] = [];
  lines.push(`【短片风格】${profile.style.name}（${profile.style.positioning}）`);
  lines.push(`【目标】${options.goal || profile.style.goals.join(" / ")}${options.platform ? `· ${options.platform}` : ""}`);
  lines.push(`【写法】${profile.style.sentence.rhythm}；单条 ${profile.style.sentence.minChars}–${profile.style.sentence.maxChars} 字，最多 ${profile.style.sentence.maxLines} 行；${profile.style.voice.punctuation}`);
  lines.push(`【人称】${profile.style.voice.person}${profile.persona.selfAddress ? `；自称「${profile.persona.selfAddress}」` : ""}${profile.persona.audienceAddress ? `；称呼观众「${profile.persona.audienceAddress}」（克制使用）` : ""}`);
  if (profile.persona.identity || profile.persona.audience) {
    lines.push(`【人设】${profile.persona.identity ?? "未标注身份"}${profile.persona.audience ? `；说给「${profile.persona.audience}」听` : ""}`);
  }
  if (profile.persona.verbalTics?.length) lines.push(`【口头禅】${profile.persona.verbalTics.join(" / ")}（自然出现，宁可少不要硬塞）`);
  if (profile.persona.dialectWords?.length) lines.push(`【地域词】${profile.persona.dialectWords.join(" / ")}`);
  if (profile.bannedWords.length) lines.push(`【禁用】${profile.bannedWords.join(" / ")}`);
  lines.push(`【反例】${profile.style.examples.map((example) => `${example.plain} → ${example.styled}`).join("；")}`);
  if (facts?.shots?.length) {
    lines.push("【镜头事实】");
    for (const shot of facts.shots) lines.push(`  ${shot.segmentId ?? "-"}：${shot.summary ?? "-"}`);
  }
  if (facts?.allowedTerms?.length) lines.push(`【允许出现的实体/数字】${facts.allowedTerms.join(" / ")}`);
  lines.push("【要求】按时间轴逐条改写下列字幕：保留事实与信息点，说人话；输出 SRT（无行内标点）。");
  lines.push("【原字幕】");
  for (const cue of cues) lines.push(`  ${cue.index ?? "-"}. ${cue.text}`);
  return lines.join("\n");
}
