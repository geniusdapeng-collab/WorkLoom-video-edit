import { createHash } from "node:crypto";
import { splitShotAssertions } from "./shot-intent.js";

/**
 * Frozen production intent is the customer's source of truth across model hops.
 *
 * A brief can be transformed by routing, discovery, PRD generation, prompt
 * fusion and late defaults. Keeping only prose in each prompt allowed a later
 * stage to replace a customer directive with a generic safe default. This
 * contract records the original clauses, their source paths and hashes, then
 * gives every stage the same compact authority block to carry forward.
 */
export const PRODUCTION_INTENT_CONTRACT_VERSION = "workloom.production-intent-contract/v1";
export const PRODUCTION_INTENT_PROMPT_HEADING = "【需求意图延续合同】";

export type ProductionIntentCategory =
  | "motion"
  | "identity"
  | "wardrobe"
  | "product"
  | "audio"
  | "text"
  | "platform"
  | "duration"
  | "continuity"
  | "other";

export interface ProductionIntentDirective {
  id: string;
  category: ProductionIntentCategory;
  statement: string;
  sourcePath: string;
  sourceSha256: string;
  enforcement: "hard";
}
export type ProjectMotionProfile = "high-energy-action" | "dynamic" | "steady" | "unspecified";

export interface MotionIntentEvidence {
  sourcePath: string;
  matches: string[];
}

export interface MotionIntentContract {
  profile: ProjectMotionProfile;
  highEnergy: boolean;
  actionDriven: boolean;
  requiresAcceleration: boolean;
  evidence: MotionIntentEvidence[];
}

export interface ProductionIntentContract {
  schemaVersion: typeof PRODUCTION_INTENT_CONTRACT_VERSION;
  contractSha256: string;
  sourceRootSha256: string;
  sources: Array<{ path: string; sha256: string }>;
  directives: ProductionIntentDirective[];
  motion: MotionIntentContract;
}

export interface ShotMotionIntentDecision {
  intent: "locked" | "steady" | "dynamic" | "speed-ramp";
  requiresSpeedRamp: boolean;
  source: "shot-explicit" | "project-action" | "project-dynamic" | "shot-text" | "default";
  reason: string;
  evidence: string[];
}

const MOTION_ACTION = /竞速|追车|追逐|追击|贴追|超车|超越|连超|冲线|冲过终点|疾驰|飞驰|冲刺|加速|提速|急加速|重刹|压弯|甩镜|俯冲|高速|极速/u;
const MOTION_ENERGY = /高燃|全程高燃|极速|高速|热血|肾上腺素|动作片|爆发|冲击|快剪|快切|快节奏/u;
const MOTION_DRIVING = /赛车|赛摩托|摩托|机车|车手|赛道|弯道|冲线|追车|引擎|车轮/u;
const MOTION_FAST_PACE = /快速|高速|加速|疾驰|飞驰|紧迫|快节奏|快剪|快切|强运动/u;
const MOTION_CRUISE = /恒速|匀速|平稳(?:跟拍|巡航|推进|行驶|跟随)|巡航|轻微收油|不加速|无加速|无超车|无减速/u;
const CONSTRAINT = /必须|需要|希望|要求|禁止|不要|不得|不能|只(?:用|要|保留|出现)|保持|全程|始终|务必|优先/u;
const NAMED_PERSON = /(?:^|[，。；、\s])([\p{Script=Han}·]{2,8})(?:穿|着|戴|骑|驾驶|出镜|主演)/u;
const IDENTITY = /人物|角色|模特|演员|女主|男主|主角|身份|长相|脸|发型|成人|年龄|性别/iu;
const WARDROBE = /服装|赛车服|服饰|衣着|穿搭|造型|定妆|护具|头盔|鞋|手套|wardrobe|costume/iu;
const PRODUCT = /商品|产品|型号|品牌|车款|整车|外观|涂装|部件|配置|[A-Z0-9]{2,}(?:-[A-Z0-9]+)+/u;
const AUDIO = /声音|引擎声|轮胎声|机械声|动作声|音频|人声|台词|对白|旁白|口播|配音|音效|音乐|BGM|原生声|环境声/iu;
const TEXT = /字幕|文字|标题|文案|屏上|画面内文字|水印|LOGOU?|CTA/iu;
const PLATFORM = /抖音|快手|小红书|视频号|B站|YouTube|TikTok|Instagram|平台|画幅|竖屏|横屏|9:16|16:9/iu;
const DURATION = /总时长|时长|秒数|秒片|\d+\s*秒/iu;
const CONTINUITY = /一致|连续|连贯|连贯性|衔接|顺序|前后|保持一致|连续性/iu;

const INTENT_SKIP_KEYS = new Set([
  "shots",
  "sceneBible",
  "metadata",
  "themeDraft",
  "pipelineRoute",
  "builtinCharacterSelection",
  "characters",
  "products",
  "assetRef",
  "photo",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => canonical(item) ?? null);
  if (!isRecord(value)) throw new Error("PRODUCTION_INTENT_NON_JSON_VALUE");
  return Object.fromEntries(Object.keys(value).sort().flatMap((key) => {
    const next = canonical(value[key]);
    return next === undefined ? [] : [[key, next]];
  }));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function textSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clean(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function sourceEntries(value: unknown, path: string, out: Array<{ path: string; text: string }>, seen = new Set<object>()): void {
  if (typeof value === "string") {
    const source = clean(value);
    if (source) out.push({ path, text: source });
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("PRODUCTION_INTENT_SOURCE_CYCLE");
    seen.add(value);
    try {
      value.forEach((item, index) => sourceEntries(item, `${path}/${index}`, out, seen));
    } finally {
      seen.delete(value);
    }
    return;
  }
  if (!isRecord(value)) return;
  if (seen.has(value)) throw new Error("PRODUCTION_INTENT_SOURCE_CYCLE");
  seen.add(value);
  try {
    for (const [key, item] of Object.entries(value)) {
      if (INTENT_SKIP_KEYS.has(key)) continue;
      sourceEntries(item, `${path}/${key}`, out, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function categoriesOf(statement: string): ProductionIntentCategory[] {
  const positive = splitShotAssertions(statement).positive;
  const categories: ProductionIntentCategory[] = [];
  const namedPerson = NAMED_PERSON.test(positive);
  const explicitlySpecific = namedPerson || /\bw\d+\b|[A-Z0-9]{2,}(?:-[A-Z0-9]+)+/u.test(positive);
  if (CONTINUITY.test(positive) && !MOTION_ACTION.test(positive) && !MOTION_ENERGY.test(positive)
    && !explicitlySpecific && /一致|连续|连贯|衔接/.test(positive)) {
    categories.push("continuity");
    if (TEXT.test(positive)) categories.push("text");
    if (PLATFORM.test(positive)) categories.push("platform");
    if (DURATION.test(positive)) categories.push("duration");
    return categories;
  }
  const motion = MOTION_ACTION.test(positive) || MOTION_ENERGY.test(positive) || MOTION_FAST_PACE.test(positive);
  if (motion) categories.push("motion");
  else if (CONTINUITY.test(positive)) categories.push("continuity");
  if ((IDENTITY.test(positive) || namedPerson)
    && !(AUDIO.test(positive) && !namedPerson && !/主角|女主|男主/u.test(positive))) categories.push("identity");
  else if (WARDROBE.test(positive)) categories.push("wardrobe");
  if (PRODUCT.test(positive)) categories.push("product");
  if (AUDIO.test(positive)) categories.push("audio");
  if (TEXT.test(positive)) categories.push("text");
  if (DURATION.test(positive)) categories.push("duration");
  if (PLATFORM.test(positive)) categories.push("platform");
  return categories.length > 0 ? categories : ["other"];
}

function categoryRank(category: ProductionIntentCategory): number {
  return ({
    motion: 0,
    continuity: 1,
    identity: 2,
    wardrobe: 3,
    product: 4,
    audio: 5,
    text: 6,
    duration: 7,
    platform: 8,
    other: 9,
  } as const)[category];
}

function statements(text: string): string[] {
  return text
    .split(/[。！？!?；;\n]+/u)
    .map(clean)
    .filter((statement) => statement.length >= 3);
}

function directiveId(category: ProductionIntentCategory, statement: string, sourcePath: string): string {
  return `PI-${category.toUpperCase()}-${sha256({ category, statement, sourcePath }).slice(0, 10)}`;
}

function selectedDirectives(entries: Array<{ path: string; text: string }>): ProductionIntentDirective[] {
  const found: ProductionIntentDirective[] = [];
  const seen = new Set<string>();
  for (const source of entries) {
    for (const statement of statements(source.text)) {
      for (const category of categoriesOf(statement)) {
        if (category === "other" && !CONSTRAINT.test(statement) && !MOTION_FAST_PACE.test(statement)) continue;
        const key = `${category}\u0000${statement}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({
          id: directiveId(category, statement, source.path),
          category,
          statement,
          sourcePath: source.path,
          sourceSha256: textSha256(source.text),
          enforcement: "hard",
        });
      }
    }
  }
  return found.sort((left, right) =>
    categoryRank(left.category) - categoryRank(right.category)
    || left.sourcePath.localeCompare(right.sourcePath)
    || left.statement.localeCompare(right.statement));
}

function matches(text: string, pattern: RegExp): string[] {
  return [...new Set([...text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))]
    .map((match) => match[0]))];
}

function motionIntent(entries: Array<{ path: string; text: string }>): MotionIntentContract {
  let actionDriven = false;
  let highEnergy = false;
  let fastPace = false;
  const evidence: MotionIntentEvidence[] = [];
  for (const entry of entries) {
    const positive = splitShotAssertions(entry.text).positive;
    const action = matches(positive, MOTION_ACTION);
    const energy = matches(positive, MOTION_ENERGY);
    const driving = matches(positive, MOTION_DRIVING);
    const pace = matches(positive, MOTION_FAST_PACE);
    const row = [...new Set([...action, ...energy, ...driving, ...pace])];
    if (row.length > 0) evidence.push({ sourcePath: entry.path, matches: row });
    actionDriven ||= action.length > 0;
    highEnergy ||= energy.length > 0 && (action.length > 0 || pace.length > 0 || driving.length > 0);
    fastPace ||= pace.length > 0;
  }
  const profile: ProjectMotionProfile = highEnergy
    ? "high-energy-action"
    : actionDriven
      ? "dynamic"
      : fastPace
        ? "dynamic"
        : evidence.length > 0
          ? "steady"
          : "unspecified";
  return {
    profile,
    highEnergy,
    actionDriven,
    requiresAcceleration: highEnergy && actionDriven,
    evidence,
  };
}

/**
 * Build a deterministic contract from frozen customer sources. Generated shot
 * cards are intentionally excluded: a later model output cannot become the
 * authority that validates itself.
 */
export function deriveProductionIntentContract(input: {
  rawIntent?: unknown;
  brief?: unknown;
  shotlist?: unknown;
  creativeContext?: unknown;
}): ProductionIntentContract {
  const customerEntries: Array<{ path: string; text: string }> = [];
  if (typeof input.rawIntent === "string") sourceEntries(input.rawIntent, "customerOriginalIntent", customerEntries);
  sourceEntries(input.brief, "brief", customerEntries);
  sourceEntries(input.shotlist, "shotlist", customerEntries);
  const creativeEntries: Array<{ path: string; text: string }> = [];
  sourceEntries(input.creativeContext, "creativeContext", creativeEntries);
  const sources = customerEntries.map((entry) => ({ path: entry.path, sha256: textSha256(entry.text) }));
  const directives = selectedDirectives(customerEntries);
  const payload = {
    schemaVersion: PRODUCTION_INTENT_CONTRACT_VERSION as typeof PRODUCTION_INTENT_CONTRACT_VERSION,
    sources,
    directives,
    motion: motionIntent([...customerEntries, ...creativeEntries]),
  };
  return {
    ...payload,
    contractSha256: sha256(payload),
    sourceRootSha256: sha256(sources),
  };
}

function shotIntentText(shot: Record<string, unknown> | undefined): string {
  if (!shot) return "";
  const fields = isRecord(shot.fields) ? shot.fields : {};
  return [
    shot.action,
    shot.timeline,
    shot.pacing,
    shot.motion,
    shot.camera_movement,
    shot.director_instruction,
    shot.scene,
    shot.sceneDescription,
    fields.action,
    fields.timeline,
    fields.pacing,
    fields.camera_movement,
  ].filter((value): value is string => typeof value === "string" && Boolean(value.trim())).join("；");
}

/** Choose a shot-level motion profile from explicit shot intent plus project authority. */
export function motionIntentForShot(
  shot: Record<string, unknown> | undefined,
  project: MotionIntentContract,
): ShotMotionIntentDecision {
  const source = shotIntentText(shot);
  const positive = splitShotAssertions(source).positive;
  const explicit = typeof shot?.motionProfile === "string" ? shot.motionProfile : "";
  const locked = /固定机位|锁定机位|静态机位|locked|static|tripod/iu.test(positive);
  const action = matches(positive, MOTION_ACTION);
  const pace = matches(positive, MOTION_FAST_PACE);
  const driving = matches(positive, MOTION_DRIVING);
  const explicitIntent = ["locked", "steady", "dynamic", "speed-ramp"].includes(explicit)
    ? explicit as ShotMotionIntentDecision["intent"]
    : null;
  const textSpeedRamp = /速度坡道|speed[ -]?ramp/iu.test(positive);

  if (explicitIntent === "speed-ramp" || textSpeedRamp) {
    return { intent: "speed-ramp", requiresSpeedRamp: true, source: "shot-explicit",
      reason: "镜头卡显式声明速度坡道", evidence: [explicitIntent === "speed-ramp" ? "motionProfile=speed-ramp" : "速度坡道表达"] };
  }
  if (locked || explicitIntent === "locked") {
    return { intent: "locked", requiresSpeedRamp: false, source: explicitIntent === "locked" ? "shot-explicit" : "shot-text",
      reason: "镜头卡显式锁定机位", evidence: [explicitIntent === "locked" ? "motionProfile=locked" : "固定机位表达"] };
  }
  if (project.profile === "high-energy-action" && (action.length > 0 || driving.length > 0)) {
    return { intent: "speed-ramp", requiresSpeedRamp: true, source: "project-action",
      reason: "原始需求要求高燃动作，当前镜头包含可辨的速度/位移事件", evidence: [...new Set([...action, ...pace, ...driving])] };
  }
  if (project.profile === "high-energy-action") {
    return { intent: "dynamic", requiresSpeedRamp: false, source: "project-dynamic",
      reason: "原始需求为高燃动作片，镜头必须保持明确运动能量", evidence: project.evidence.flatMap((row) => row.matches).slice(0, 12) };
  }
  if (explicitIntent === "dynamic" || action.length > 0 || pace.length > 0) {
    return { intent: "dynamic", requiresSpeedRamp: false, source: explicitIntent === "dynamic" ? "shot-explicit" : "shot-text",
      reason: "镜头卡或项目包含明确快速运动", evidence: [...new Set([...action, ...pace])] };
  }
  if (project.profile === "dynamic") {
    return { intent: "dynamic", requiresSpeedRamp: false, source: "project-dynamic",
      reason: "原始需求明确快节奏/强运动", evidence: project.evidence.flatMap((row) => row.matches).slice(0, 12) };
  }
  return {
    intent: explicitIntent === "steady" ? "steady" : "steady",
    requiresSpeedRamp: false,
    source: explicitIntent === "steady" ? "shot-explicit" : "default",
    reason: explicitIntent === "steady" ? "镜头卡声明稳定节奏" : "未发现需要覆盖稳定默认的运动意图",
    evidence: explicitIntent === "steady" ? ["motionProfile=steady"] : [],
  };
}

function relevantDirective(directive: ProductionIntentDirective, shot?: Record<string, unknown>): boolean {
  if (!shot) return true;
  if (directive.category !== "identity" && directive.category !== "wardrobe" && directive.category !== "product") return true;
  const source = [
    shot.character,
    shot.characterId,
    shot.characters,
    shot.cast,
    shot.costume,
    shot.wardrobeId,
    shot.product,
    shot.productRef,
    shot.photo,
  ].map((value) => typeof value === "string" ? value : JSON.stringify(value ?? "")).join(" ");
  if (directive.category === "wardrobe") return WARDROBE.test(source) || Boolean(shot.wardrobeId) || Boolean(shot.costume);
  if (directive.category === "product") return PRODUCT.test(source) || Boolean(shot.productRef) || Boolean(shot.product);
  return IDENTITY.test(source) || Boolean(shot.character) || Boolean(shot.characterId) || Boolean(shot.characters) || Boolean(shot.cast);
}

function requiredDirectives(
  contract: ProductionIntentContract,
  shot?: Record<string, unknown>,
): ProductionIntentDirective[] {
  return contract.directives.filter((directive) => relevantDirective(directive, shot));
}

/**
 * Stable binding for the complete applicable directive set.
 *
 * Provider prompts have model-specific character ceilings. The full contract
 * stays in the project artifacts; a constrained provider projection can bind
 * every applicable clause with this digest instead of repeating every ID.
 */
export function productionIntentDirectiveSetSha256(
  directives: readonly ProductionIntentDirective[],
): string {
  return sha256(directives.map((directive) => directive.id).sort());
}

/**
 * Render the same authority block at every model boundary. The block fails
 * closed instead of truncating directives when a caller sets a hard budget.
 */
export function productionIntentPrompt(
  contract: ProductionIntentContract,
  options: {
    stage: string;
    shot?: Record<string, unknown>;
    maxChars?: number;
    compact?: boolean;
    /** Bind the complete applicable set with a digest when the provider has a hard prompt ceiling. */
    directiveDigest?: boolean;
    /** Allowed only when the complete Brief is included beside this block. */
    includeOtherStatements?: boolean;
  },
): string {
  const directives = requiredDirectives(contract, options.shot);
  if (directives.length === 0) return "";
  const motion = contract.motion.profile === "unspecified"
    ? ""
    : `运动意图：${contract.motion.profile}${contract.motion.requiresAcceleration ? "；必须出现可辨的加速与位移结果" : ""}。`;
  const categoryInstruction: Record<ProductionIntentCategory, string> = {
    motion: contract.motion.requiresAcceleration
      ? "关键动作必须出现可辨的加速、追近、并排、超越或冲线结果；禁止恒速巡航、平稳跟拍或轻微收油替代速度变化。"
      : "保持客户明确的速度、运镜与节奏方向。",
    identity: "保持客户指定人物身份、年龄感、脸型与可见特征；不得换人或用相似角色替代。",
    wardrobe: "保持客户指定服装及已封存定妆版本的主色、结构、标识和护具；不得回落基线服装。",
    product: "保持客户指定商品型号、结构、比例、配色、涂装与已核实标识；不得替换成相似商品。",
    audio: "保持客户明确的原生声音、口播与音乐政策；不得静默换声或用后期变速破坏口播。",
    text: "保持客户明确的字幕、屏上文字与标题政策；不新增或遗漏文字层。",
    platform: "保持客户明确的平台、画幅、分辨率与交付方向。",
    duration: "保持客户明确的时长与节奏预算，不靠截断或静默拉伸兑现。",
    continuity: "跨镜保持客户要求的动作、人物、服装、商品、空间与声音连续性。",
    other: "保持客户明确约束，不得用通用默认值替换。",
  };
  const grouped = new Map<ProductionIntentCategory, ProductionIntentDirective[]>();
  for (const directive of directives) grouped.set(directive.category, [...(grouped.get(directive.category) ?? []), directive]);
  const lines = options.directiveDigest
    ? [
        `directiveCount=${directives.length}｜directiveSetSha256=${productionIntentDirectiveSetSha256(directives)}`,
        `categories=${[...grouped.keys()].join(",")}｜全部适用客户条款由完整合同冻结并绑定；冲突时修复来源，不得静默降级。`,
      ]
    : options.compact
    ? [...grouped.entries()].map(([category, rows]) => `- [${category}｜${rows.map((row) => row.id).join(",")}] ${categoryInstruction[category]}`
      + (category === "other" && options.includeOtherStatements !== false
        ? ` 原文：${rows.map((row) => row.statement).join("；")}`
        : ""))
    : directives.map((directive) => `- [${directive.category}｜${directive.id}] ${directive.statement}`);
  const block = [
    `${PRODUCTION_INTENT_PROMPT_HEADING}${contract.schemaVersion}｜${contract.contractSha256}`,
    ...(options.directiveDigest
      ? [`阶段=${options.stage}；完整合同与来源哈希保留在任务产物，供应商提示词只提交可校验投影。`]
      : ["阶段=" + options.stage + "。以下为客户原始需求，后续镜头卡、模型输出、默认参数和后期策略必须继承；冲突时修复来源，不得静默降级。"]),
    ...(motion ? [motion] : []),
    ...lines,
  ].join("\n");
  const maxChars = options.maxChars ?? 2200;
  if (!Number.isSafeInteger(maxChars) || maxChars < 120) throw new Error("PRODUCTION_INTENT_PROMPT_BUDGET_INVALID");
  if (block.length > maxChars) {
    throw new Error(`PRODUCTION_INTENT_PROMPT_BUDGET_EXCEEDED: ${block.length}>${maxChars}; preserve all directives by shortening upstream duplication`);
  }
  return block;
}

export function productionIntentConflictIssues(
  contract: ProductionIntentContract,
  shot: Record<string, unknown> | undefined,
): string[] {
  if (!shot || !contract.motion.requiresAcceleration) return [];
  const decision = motionIntentForShot(shot, contract.motion);
  if (!["dynamic", "speed-ramp"].includes(decision.intent)) return [];
  const positive = splitShotAssertions(shotIntentText(shot)).positive;
  const conflicts = matches(positive, MOTION_CRUISE);
  return conflicts.length === 0
    ? []
    : [`镜头 ${String(shot.shotId ?? "?")} 与高燃/竞速需求冲突：${conflicts.join("、")}；必须改为可拍的加速、追近、并排、超越或冲线过程`];
}

export interface ProductionIntentPromptAudit {
  ok: boolean;
  contractSha256: string;
  requiredDirectiveIds: string[];
  issues: string[];
}

export function auditProductionIntentPrompt(
  contract: ProductionIntentContract,
  prompt: string,
  shot?: Record<string, unknown>,
  options: { compact?: boolean } = {},
): ProductionIntentPromptAudit {
  const required = requiredDirectives(contract, shot);
  const issues: string[] = [];
  if (!prompt.includes(PRODUCTION_INTENT_PROMPT_HEADING)) issues.push("最终提示词缺少需求意图延续合同");
  if (!prompt.includes(contract.contractSha256)) issues.push("最终提示词未绑定当前需求合同摘要");
  const directiveSetSha256 = productionIntentDirectiveSetSha256(required);
  const digestBound = prompt.includes(`directiveCount=${required.length}`)
    && prompt.includes(`directiveSetSha256=${directiveSetSha256}`);
  for (const directive of required) {
    if (!digestBound && (!prompt.includes(directive.id) || (!options.compact && !prompt.includes(directive.statement)))) {
      issues.push(`最终提示词遗漏客户意图 ${directive.id}`);
    }
  }
  issues.push(...productionIntentConflictIssues(contract, shot));
  return {
    ok: issues.length === 0,
    contractSha256: contract.contractSha256,
    requiredDirectiveIds: required.map((directive) => directive.id),
    issues,
  };
}
