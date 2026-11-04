import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import {
  frozenSegmentContract, prdAudioReferencesOverflow, prdCharacterShapePath, requirementHash, requirementRecord, verifiedRequirementContract,
  type RequirementContract, type RequirementRecord
} from "./requirement-contract.js";
import {
  authoritativeDelivery, authoritativeProduct, bindPrdProvenance, effectivePrdModelSchema, frozenVisualPrdSegments,
  prdAuthorityPrompt, prdContractExecutionView, prdFail,
  validatePrdDelivery, validatePrdModelPayload, validatePrdProduction, type PrdAuthority
} from "./prd-authority.js";
import { marketingPrdReferenceView, normalizeMarketingPrdContract } from "./marketing-prd-contract.js";
import { preparePrdPortraitReferenceSelection, verifyPrdPortraitSources } from "./prd-portrait-source.js";
import { assertNoSpokenPromptPackage } from "./frozen-speech-policy.js";
import { isNoSpeechDeclaration } from "./dialogue-contract.js";
import { acquireVendorRequirementEntry } from "./vendor-requirement-entry.js";
import { parseStrictSceneJsonObject } from "./scene-json-comma-recovery.js";
import { splitShotAssertions } from "./shot-intent.js";
import {
  attestVendorStructuredRedirect,
  nativeBlankJsonCorrected, nativeBlankJsonObjectCorrected, nativeBlankJsonRouteCurrent,
  nativeChatJsonObjectCorrected, nativeChatJsonObjectRouteCurrent,
  nativeChatJsonSyntaxCorrected, nativeChatJsonSyntaxRouteCurrent,
  nativeReasonBlankJson, nativeReasonCompleted, nativeReasonFailure,
  WorkloomLLMEngine, type LLMReasonResult,
} from "./llm-adapter.js";

type Method = (this: RequirementRecord, ...args: unknown[]) => unknown;
const QUALITY_KEYS = ["visual", "audio", "narrative", "consistency"] as const;
const prdCreativeJsonPresentation = "\n\n## 原生创意核心 JSON 自检\n"
  + "使用标准 JSON：每个键值或数组元素另起一行，相邻元素用 ASCII 逗号分隔，正确转义内嵌引号。"
  + "先核对数组、对象和字符串都闭合，再只提交完整创意核心对象。";
const prdCreativeJsonCorrection = "\n\n## 本次原生创意核心 JSON 格式修正\n"
  + "第一次已完整返回，但正文没有通过 JSON 语法解析。请依据本次完整原始任务、已审材料和同一实际 schema 重新生成完整创意核心。"
  + "检查逗号、括号、引号和转义；只输出严格 JSON 对象，不输出代码围栏、解释、部分字段或上次草稿。";
const prdCreativeFactBoundary = "\n\n## 本次创意商品事实边界\n"
  + "客户只允许使用本次 G1 已核实的商品身份与用途。创意核心的主题、钩子、关键信息和高潮以已审可见动作、摄影和原生声音表达，"
  + "不得使用实车前倾角、转向角等车辆规格或用数值性能解释胜负。G1 原件保留完整供核对，其中的其他参数不进入创意。"
  + "照常保留原要求的片长、场景数、赛道动作和摄影角度。";
const prdCreativeFactCorrection = "\n\n## 本次原生创意核心商品事实修正\n"
  + "第一次已完整返回，但创意核心使用了当前 Brief 未授权的数值化车辆几何。请依据完整原始任务、已审材料和同一实际 schema 重写完整创意核心。"
  + "商品事实仅使用已核实的身份与用途；以已审可见动作、摄影和原生声音表现创意，不复用任何上次草稿或车辆规格。只输出严格 JSON 对象。";

function identityAndUseOnly(authority: PrdAuthority): boolean {
  const { requirements } = requirementRecord(authority.metadata.brief, "本次创意 Brief");
  return typeof requirements === "string"
    && /(?:^|[。！？；\n])\s*商品事实仅限本次\s*G1\s*核实的身份与用途\s*(?:[。！？；\n]|$)/u.test(requirements);
}

const VEHICLE_GEOMETRY = /\d+(?:\.\d+)?\s*(?:°|度)\s*(?:前倾角|转向角)|(?:前倾角|转向角)\s*(?:约为|为|约|是|达到|设为|[:：])?\s*\d+(?:\.\d+)?\s*(?:°|度)/gu;
const LABELED_VEHICLE_ANGLE = /(?:实车|量产车|商品|车款|前叉|车架|转向机构)(?:的|采用|具有|提供)?\s*(?:\d+(?:\.\d+)?\s*(?:°|度)\s*(?:前倾|转向)|(?:前倾|转向)\s*(?:为|约|[:：])?\s*\d+(?:\.\d+)?\s*(?:°|度))/u;
const ACTOR_OR_CAMERA_ANGLE = /(?:镜头|机位|摄影机|摄像机|云台|骑手|车手|主角|人物|身体|上身)(?:的|以|取|用|按|保持|采用)?\s*$/u;

function hasCreativeVehicleGeometry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { coreTheme, creativeHook, keyMessages, twistPoint } = value as RequirementRecord;
  return [coreTheme, creativeHook, twistPoint, ...(Array.isArray(keyMessages) ? keyMessages : [])].some(field => {
    if (typeof field !== "string") return false;
    const text = splitShotAssertions(field.normalize("NFKC")).positive;
    return LABELED_VEHICLE_ANGLE.test(text)
      || [...text.matchAll(VEHICLE_GEOMETRY)].some(match => !ACTOR_OR_CAMERA_ANGLE.test(text.slice(0, match.index)));
  });
}

function rejectCreativeVehicleGeometry(value: unknown): void {
  if (hasCreativeVehicleGeometry(value)) {
    prdFail("PRD_CREATIVE_FACT_UNVERIFIED", "原生创意核心未遵守本次商品事实仅限已核实身份与用途的要求");
  }
}
type QualityThresholds = Record<typeof QUALITY_KEYS[number], number>;
interface QualityPolicy {
  production: QualityThresholds;
  nativeAcceptance: QualityThresholds;
  thresholds: QualityThresholds;
  fallbackTrigger: string;
}
interface TruthBoundary {
  nativeLines: string[];
  constraints: string[];
}
interface Scope {
  authority: PrdAuthority;
  authoritySource: PrdAuthority;
  authorityHash: string;
  validateAuthority?: () => void;
  approvedTheme?: () => unknown;
  reviewedTheme?: unknown;
  reviewedThemeHash?: string;
  active: boolean;
  fatal?: { error: unknown };
  system?: RequirementRecord;
  generator?: RequirementRecord;
  list?: RequirementRecord;
  listHash?: string;
  contract?: RequirementContract;
  reviewedHash?: string;
  reviewedProjectionHash?: string;
  reviewedResult?: RequirementRecord;
  reviewedContent?: string;
  reviewedVerdict?: RequirementRecord;
  portraitReviewArtifactHash?: string;
  g4Decision?: "pending" | "approved" | "rejected";
  generated: WeakSet<object>;
  quality: WeakMap<object, QualityPolicy>;
  truth?: TruthBoundary;
}
const scopes = new AsyncLocalStorage<Scope | undefined>();
const systems = new WeakMap<object, Scope>();
const generators = new WeakMap<object, Scope>();

function fatal(scope: Scope, error: unknown): never {
  scope.fatal ??= { error };
  throw scope.fatal.error;
}
function guard<T>(scope: Scope, operation: () => T): T {
  try {
    if (!scope.active || scopes.getStore() !== scope) prdFail("PRD_SCOPE_CLOSED", "PRD 不能在本次运行结束后继续消耗权威输入");
    if (scope.fatal !== undefined) throw scope.fatal.error;
    if (requirementHash(scope.authoritySource) !== scope.authorityHash) {
      prdFail("PRD_AUTHORITY_CHANGED", "本次宿主私有 PRD 权威输入已经变化");
    }
    return operation();
  } catch (error) { return fatal(scope, error); }
}
async function awaited<T>(scope: Scope, operation: () => T | Promise<T>): Promise<T> {
  try {
    guard(scope, () => undefined);
    const result = await operation();
    guard(scope, () => undefined);
    return result;
  } catch (error) { return fatal(scope, error); }
}
function current(): Scope | undefined {
  const scope = scopes.getStore();
  if (scope) guard(scope, () => undefined);
  return scope;
}

function scopedReceiver(receiver: RequirementRecord, kind: "system" | "generator"): Scope | undefined {
  const scope = current(), bound = (kind === "system" ? systems : generators).get(receiver);
  if (bound && bound !== scope) {
    const error = bound.fatal?.error ?? new Error("PRD_SCOPE_CONFLICT: 已绑定的系统或生成器不能脱离本次权威作用域调用");
    bound.fatal ??= { error };
    return fatal(scope ?? bound, error);
  }
  return scope;
}

/** A swallowed vendor exception stays fatal when the outer operation eventually returns. */
export async function withPrdAuthorityScope<T>(
  authority: PrdAuthority | undefined, operation: () => T | Promise<T>, validateAuthority?: () => void, approvedTheme?: () => unknown
): Promise<T> {
  if (!authority) return scopes.run(undefined, operation);
  const scope: Scope = { authority: structuredClone(authority), authoritySource: authority,
    authorityHash: requirementHash(authority), validateAuthority, approvedTheme, active: true,
    generated: new WeakSet(), quality: new WeakMap() };
  return scopes.run(scope, async () => {
    try {
      const result = await awaited(scope, operation);
      if (result && typeof result === "object" && (result as RequirementRecord).success === true) {
        const stages = requirementRecord((result as RequirementRecord).stages, "成功运行 stages");
        const finalPrd = requirementRecord(requirementRecord(stages.prdGeneration, "成功运行 prdGeneration").data, "成功运行 PRD");
        if (scope.g4Decision !== "approved" || !scope.reviewedHash || finalPrd !== scope.reviewedResult
          || reviewProjectionHash(finalPrd) !== scope.reviewedProjectionHash) {
          prdFail("PRD_REVIEW_UNVERIFIED", "成功返回前最终 PRD 未绑定本次真实 G4 或审核后内容发生变化");
        }
      }
      return result;
    } catch (error) { return fatal(scope, error); }
    finally { scope.active = false; }
  });
}

function assertProductionAuthority(scope: Scope): void {
  guard(scope, () => {
    scope.validateAuthority?.();
    if (scope.reviewedHash && scope.approvedTheme && (!scope.reviewedThemeHash
      || requirementHash(scope.approvedTheme()) !== scope.reviewedThemeHash)) {
      prdFail("PRD_REVIEW_UNVERIFIED", "G4 后本次真实 G2 已审主题发生变化");
    }
    if (scope.reviewedHash && (!scope.reviewedResult || !scope.contract || !scope.reviewedContent || !scope.reviewedVerdict
      || reviewProjectionHash(scope.reviewedResult) !== scope.reviewedProjectionHash)) {
      prdFail("PRD_REVIEW_UNVERIFIED", "下游制作调用缺少本次真实 G4 版本，或审核后内容已经变化");
    }
  });
}

/** The existing request boundary uses this private run snapshot, never metadata declarations. */
export function productionModelInput(prompt: string): { prompt: string; verify: () => void } {
  const scope = current();
  if (!scope) return { prompt, verify: () => undefined };
  const verify = () => assertProductionAuthority(scope);
  verify();
  // Before G4 the native theme/discovery/PRD paths retain their own prompts and contracts.
  if (scope.g4Decision !== "approved" || !scope.reviewedHash) return { prompt, verify };
  const visualSegments = frozenVisualPrdSegments(scope.authority);
  const reviewedExecution = visualSegments ? {
    ...scope.reviewedResult,
    _workloomRequirementContract: prdContractExecutionView(scope.authority, scope.contract!),
  } : scope.reviewedResult;
  const addition = `\n\n## 本次宿主已审制作权威输入 ${scope.reviewedHash}\n`
    + `以下是当前运行的完整来源，不是新的创作稿或批准。客户完整 Brief 与 G1 的用途限定优先于通用模板、艺术参考和已审 PRD 中的创作句子。`
    + `G4 批准不把 PRD 新增的修辞、设计目的、未知颜色或部件推测升级为 G1 已接受事实。`
    + `后续剧本、场景、摄影、色彩、音频、融合、精炼、检查与修复都须按相同层级理解；本次模型自主生成内容，不能用规则补造缺失字段。\n`
    + prdAuthorityPrompt(scope.authority, scope.contract!)
    + (scope.reviewedThemeHash ? `\n本次真实 G2 已审完整主题与原始裁决（SHA256 ${scope.reviewedThemeHash}）：\n${JSON.stringify(scope.reviewedTheme)}\n` : "")
    + `\n本次真实 G4 完整审核原文（SHA256 ${createHash("sha256").update(scope.reviewedContent!).digest("hex")}）：\n${scope.reviewedContent}\n`
    + `本次 G4 原始返回裁决（建议保持非阻断层级，不驱动额外调用）：\n${JSON.stringify(scope.reviewedVerdict)}\n`
    + `本次 G4 绑定的${visualSegments ? " PRD 执行视图（受众推测原件仅供审计）" : "完整 PRD 对象"}（人物 portraitPath 可在后续合法填入；其他创作内容不得继承未经重审的修改）：\n${JSON.stringify(reviewedExecution)}\n`
    + `保留当前调用的输出结构、真实镜号、字段、模型参数、超时、重试与输出预算。`
    + `仅生成当前任务要求的内容；不把来源文本、JSON 键名、审核说明或本节文字抄成场景、服装、台词与音频。`
    + `客户明确的字幕与封面要求属于正式后期，生成画面内禁止额外文字不代表取消后期规定字幕。`
    + `本输入不批准 G5/G6/G7，不降低其检查；模型结果仍原样交给原消费者与正式审核。\n`;
  return { prompt: prompt + addition, verify };
}

function reviewProjectionHash(value: RequirementRecord): string {
  const projection = structuredClone(value);
  const characters = requirementRecord(projection.characterSystem, "已审人物系统").characters;
  if (!Array.isArray(characters)) prdFail("PRD_REVIEW_UNVERIFIED", "已审人物系统缺少名单");
  for (const value of characters) {
    const character = requirementRecord(value, "已审人物");
    if (typeof character.portraitPath !== "string") prdFail("PRD_REVIEW_UNVERIFIED", "定妆照路径必须为明确文本");
    // G5 may later fill this lifecycle field. It never alters the G4 creation contract.
    character.portraitPath = "";
  }
  return requirementHash(projection);
}

function method(owner: RequirementRecord, key: string): Method {
  const value = owner[key];
  if (typeof value !== "function") prdFail("PRD_VENDOR_UNAVAILABLE", `vendor 缺少 ${key}`);
  return value as Method;
}

function qualityThresholds(value: unknown, label: string): QualityThresholds {
  const input = requirementRecord(value, label);
  if (Object.keys(input).length !== QUALITY_KEYS.length || QUALITY_KEYS.some(key =>
    typeof input[key] !== "number" || !Number.isFinite(input[key]) || Number(input[key]) < 0.5 || Number(input[key]) > 1)) {
    prdFail("PRD_QUALITY_INVALID", `${label} 必须保留四个有效原生质量阈值`);
  }
  return Object.fromEntries(QUALITY_KEYS.map(key => [key, input[key]])) as QualityThresholds;
}

/** Rule-generated thresholds only: retain every existing production and acceptance promise. */
function unifiedQuality(production: QualityThresholds, acceptance: QualityThresholds): QualityThresholds {
  return Object.fromEntries(QUALITY_KEYS.map(key => [key, Math.max(production[key], acceptance[key])])) as QualityThresholds;
}

/** Native fact-redline wording is an internal restriction, never a new official or creative claim. */
function truthBoundary(scope: Scope, nativeLines: string[]): TruthBoundary {
  const artifact = scope.authority.marketing.g1Artifact;
  const facts = requirementRecord(requirementRecord(JSON.parse(artifact.content), "G1 原件").facts, "G1 facts");
  const sources = Array.isArray(facts.sources) ? facts.sources.map(value => requirementRecord(value, "G1 source")) : [];
  const claims = (Array.isArray(facts.stages) ? facts.stages : []).flatMap(value => {
    const stage = requirementRecord(value, "G1 stage");
    const data = stage.facts && typeof stage.facts === "object" ? requirementRecord(stage.facts, "G1 stage facts") : {};
    return Array.isArray(data.claims) ? data.claims.map(value => requirementRecord(value, "G1 claim")) : [];
  });
  const constraints = [
    `内部事实用途边界：完整底账保留于本次 G1 原件 ${artifact.path} / SHA256 ${artifact.sha256}；已接受 facts 不等于本片可用创意。客户 Brief 禁用的参数、部件、背书或比较即使可核实也不得进入画面、台词或情绪卖点；媒体来源不得升级为厂家官方确认。`,
  ];
  if (Array.isArray(facts.restrictions)) for (const restriction of facts.restrictions) {
    if (typeof restriction !== "string") prdFail("PRD_G1_UNVERIFIED", "G1 用途限制不是明确文本");
    constraints.push(`本次 G1 用途限制：${restriction}`);
  }
  for (const line of nativeLines) {
    if (line.startsWith("宣称上限：")) {
      // The native bridge classifies unrecognized specifications as official,
      // then concatenates them here. Keep the original in diagnostic evidence;
      // the complete G1 already retains every fact and its original review.
      continue;
    }
    const prerequisite = /^使用前提：([\s\S]*)（信源：[\s\S]*）——镜头叙事不得与此前提矛盾$/.exec(line);
    if (prerequisite) {
      const fact = prerequisite[1]!;
      const matches = claims.flatMap(claim => {
        if (claim.status !== "source-bound" || typeof claim.value !== "string"
          || (claim.value !== fact && !fact.endsWith(`：${claim.value}`)) || typeof claim.claimId !== "string") return [];
        const matchingSources = sources.filter(source => source.sourceId === claim.sourceId && source.textSha256 === claim.textSha256
          && typeof source.finalUrl === "string" && /^https?:\/\//.test(source.finalUrl)
          && /^[a-f0-9]{64}$/.test(String(source.textSha256)));
        return matchingSources.length === 1 ? [{ claim, source: matchingSources[0]! }] : [];
      });
      const attribution = matches.length === 1
        ? `本次 G1 claim ${String(matches[0]!.claim.claimId)} → source ${String(matches[0]!.source.sourceId)}；原始来源 ${String(matches[0]!.source.finalUrl)}；正文 SHA256 ${String(matches[0]!.source.textSha256)}`
        : "没有唯一的本次 G1 claim/source 绑定，来源未核实，不得宣称厂家确认或对外使用";
      constraints.push(`内部使用前提（不是创意文案）：${fact}（${attribution}）；镜头不得与此前提矛盾，具体表达仍服从完整 Brief 与本次审核。`);
    } else {
      constraints.push(`内部既有事实限制（不授予新的事实来源或创意许可）：${line}`);
    }
  }
  return { nativeLines: structuredClone(nativeLines), constraints: [...new Set(constraints)] };
}

/** Request executable planning in existing schema fields; never manufacture that plan after the response. */
function productionPlanningPrompt(scope: Scope): string {
  const profile = scope.authority.profile;
  const brief = scope.authority.metadata.brief === undefined ? {} : requirementRecord(scope.authority.metadata.brief, "本次制作计划Brief");
  const contract = scope.contract!;
  const declarations = Object.fromEntries(["coverDelivery", "sidecarPolicy", "persistentSubtitleText"]
    .filter(key => Object.hasOwn(profile, key)).map(key => [key, profile[key as keyof typeof profile]]));
  const castAnchors = { selection: contract.cast.selection, characters: contract.cast.characters.map(character =>
    Object.fromEntries(["id", "name", "portraitVersion", "activeWardrobeId", "wardrobeId"]
      .filter(key => Object.hasOwn(character, key)).map(key => [key, character[key]]))) };
  const selection = scope.authority.portraitReferenceSelection;
  const selectedAngles = selection?.angles.join("/") ?? "front/closeup";
  const persistentOnly = profile.speechPolicy === "none" && profile.persistentSubtitleText !== undefined
    && profile.sidecarPolicy === "dialogue-and-composite-ass";
  return `\n\n## 本次 G4 制作执行计划（由本次模型填写现有字段）\n`
    + `角色的 consistencyRequirements 除脸型、发型、服装外，还须写出 G5 前定妆照执行计划：逐角色绑定本次 characterId、档案 profilePath/profileSha256、registrySha256、已选服装与已知版本；`
    + `明确先从这些来源解析并复用该版本原始 ${selectedAngles} PNG，不把构图稿或新猜测人脸当原始参考。已列出的四角度来源 path/hash 和既有用途证据已核对，待本次 G5 复制与评审；缺少输入证据时才写“G5 前待解析和核验”，不得编造文件、摘要、授权或已批准状态。`
    + (selection ? `本次冻结参考选择 ${JSON.stringify(selection)}。先在 consistencyRequirements 分开列明该版本的全部档案原图和本次实际逐镜选图：档案来源逐张核验；每个含该人物的 G3 场景只提交选定的 ${selection.angles.length} 张，按 ${selection.angles.join(" → ")} 顺序使用，不混入其他已核验角度。核对动作连续性；有问题在 G4 如实审查，不能擅换角度。\n` : "")
    + (scope.authority.portraitSources?.length ? "catalogProfile 是当前制作执行的人物档案；archiveProfile 仅作为既有肖像身份、授权和原始字节核对依据。它们是不同档案角色，保留各自路径与 SHA256，不要求改成相同摘要。\n" : "")
    + `写明 G5 前核验人物/版本/服装、原始 PNG 字节、来源与用途授权；不一致或缺件则保留未核实并停止依赖它的生成。其他必需角度按原有 G5 流程核验，只有本次实际图片和原有审核才能支持完成。`
    + `portraitPath 此时留空；不得新增 needsPortrait/portraitPlan 等 schema 未声明键，不得宣称 G5 或跨镜一致性已经通过。明确无人时不添加人物任务。\n`
    + `在 audioSpecification.soundDesign 和各场景既有 visualRequirements/audioRequirements 中写出本次字幕与声音的后续执行、验证方法，不新增模块。`
    + `本次明确字幕口径为 ${profile.subtitleMode ?? "客户未显式指定，沿用已有任务"}；如要求持续警示字幕，明确文字来源、覆盖起止、平台安全区、字号/对比度和遮挡检查方法；`
    + (persistentOnly ? "本次没有可生成的台词字幕；持续文字烧录与完整组合ASS按实际区间核对，便携对白SRT/VTT不适用。不能创建空文件代替验证。"
      : "要求烧录或 sidecar 时说明如何与同一台词、总时长和时间线核对；both 时按明确口径核对烧录与旁挂共有的台词及时间线，台词侧车与完整组合ASS分别说明，不能要求dialogue-only侧车包含持续文字。没有请求的字幕不得额外添加。")
    + `本次 nativeAudio=${profile.nativeAudio === undefined ? "未显式指定" : String(profile.nativeAudio)}；明确保留原生声音时，写出原始片段/音轨来源与时长核对、原速拼接、不加速口播、不静默换声或补 TTS 的后续验证计划；`
    + `枚举 voicePolicy、具体对白和音乐/环境音安排须彼此一致。所有这些是待执行计划，当前没有成片、听音或字幕通过证据。\n`
    + `若当前 Brief 明确约定一场对应一个生成片段，shotMapping.estimatedShots 每场写 1；段内机位、动作与声音变化仍写在场景计划，不另增生成片段。\n`
    + `本次明确的独立交付声明（未出现的键没有新增客户承诺）：${JSON.stringify(declarations)}。`
    + `若明确要求standalone封面，在既有visualRequirements中规划PNG/JPEG独立图、目标画幅/分辨率、来源绑定和文件核验；不要把独立交付推断成开启片头封面。`
    + (persistentOnly ? "完整组合ASS（complete-composition）仅含本次批准的文字层，持续文字覆盖实际视频0秒至末帧；"
      : "若明确要求dialogue-and-composite-ass，在既有字段内区分SRT/VTT台词侧车（dialogue-only）与完整组合ASS（complete-composition），说明ASS包含台词及本次请求的持续文字、覆盖实际视频0秒至末帧，")
    + `并规划文字、区间、字体样式及compositionSha256的核对；both时烧录和ASS使用同一组合。没有明确请求的持续文字、封面或其他文字层不得新增。`
    + (profile.postTailOverlayText !== undefined
      ? `片尾独立层的准确文字和区间由宿主的交付合同登记；场景计划写画面净区、遮挡、可读性与核验方法，引用已登记区间，不另写片尾层起止秒数。`
      : "")
    + `将下面原文已给出的字号、边距、描边、墨迹范围、平台遮挡区和字体核验要求落实为本次模型计划，不以泛称“安全区”代替明确数值；未给数值时由本次模型按实际要求规划并标明待验证，不伪称已测量。\n`
    + (typeof brief.description === "string" ? `\n### 客户执行要求原文（Brief.description，保留原文；输入资料，不是完成回执）\n${brief.description}\n` : "")
    + `\n### 本次已知人物来源锚点（原G3选角来源，不是G5完成凭据）\n${JSON.stringify(castAnchors)}\n`
    + `按以上已给出的profilePath/profileSha256/registrySha256、人物与已知版本/服装逐项引用；已经给出的档案来源不得写成“待解析”。`
    + `“待解析和核验”仅适用于输入确实未提供的原始PNG路径、字节摘要或尚未完成的G5核验；即使原文提供PNG路径和摘要，也仅作为待G5核对的输入来源，不能提前批准。`
    + `portraitPath仍留空，计划仍须由本次模型写入既有合法字段并交真实G4审核；宿主不会在响应后补写遗漏计划。\n`;
}
interface Change { owner: RequirementRecord; key: string; original: PropertyDescriptor; patched: Method }
interface Installed { changes: Change[]; schema: RequirementRecord; schemaHash: string }
const active = new WeakMap<object, Installed>();
const nativeIdentities = new WeakMap<object, Array<{ owner: RequirementRecord; key: string; descriptor: PropertyDescriptor }>>();
function bindPrdPortraitRule(prompt: string): string {
  const native = "\n9. 角色 portraitPath 留空字符串（系统后续填充），但需标注是否需要生成定妆照\n10. 只输出 JSON，不要任何 markdown 代码块标记，不要解释文本";
  const parts = prompt.split(native);
  if (parts.length !== 2) prdFail("PRD_VENDOR_UNAVAILABLE", "Agent3 的定妆照原生模板规则已经变化");
  return parts.join("\n9. 角色 portraitPath 保持空字符串。按本次封闭角色 schema 输出，定妆照由后续正式阶段核验。\n10. 只输出 JSON，不要任何 markdown 代码块标记，不要解释文本");
}

function frozenVisualCreativeRule(prompt: string, hasStory: boolean, sceneCount: number): string {
  const replace = (from: string, to: string) => {
    const parts = prompt.split(from);
    if (parts.length !== 2) prdFail("PRD_VENDOR_UNAVAILABLE", "无对白创意的原生模板规则已经变化");
    prompt = parts.join(to);
  };
  if (hasStory) replace(
    "请从中提炼核心意象、钉子台词、情感锚点，转化为导演视角的创意语言。",
    "从中提炼能由已审动作、画面和原生声音验证的意象与情感锚点，不创作台词或增加上屏文字。",
  );
  replace(
    "\n4. keyMessages 的 P0 必须能用一句钉子台词说出来，且这句台词要'具体到只有这个故事能讲'（'钉子会锈，绳结会记住手心的汗'），禁止放之四海皆准的鸡汤。",
    "\n4. keyMessages 的 P0 是导演的内部执行要求，写明本次已审场景里观众可实际看到或听到的证据；不得写成角色台词、旁白、口播、可转发短句或新的字幕。",
  );
  replace(
    "\n5. 【用户原始输入】是最高事实源：原文的台词、特写、物理细节一字不减地融进你的提炼，禁止用抽象概括覆盖原文细节。",
    "\n5. 客户原文、已审场景的动作与物理细节必须保留。只使用明确批准的后期文字，禁止增加口号或把内部创意语言当作上屏文案。",
  );
  replace(
    '  "emotionalArc": "setup→rising→climax→falling→resolution",',
    `  "emotionalArc": "按下面枚举选择与本次 ${sceneCount} 个已审节点对应的弧线",`,
  );
  return prompt + `\n\n情绪弧线必须与本次 ${sceneCount} 个已审节点对应。如果实际节点依次是铺垫、高潮、收束，选择 setup→climax→resolution；段内升温写在对应节点的执行描述，不要增加独立 rising 节点。选择仍由本次创意模型根据实际动作完成。`;
}

/** Project execution inputs; keep the reviewed G3 object and its audience hypothesis as original evidence. */
function frozenVisualDiscoveryView(scope: Scope, discovery: RequirementRecord, contract: RequirementContract) {
  const frozen = frozenVisualPrdSegments(scope.authority);
  if (!frozen) return undefined;
  if (contract.scenes.length !== frozen.count) prdFail("PRD_SCENE_UNVERIFIED", "已审场景与本次冻结分段不一致");
  const upstream = requirementRecord(discovery.upstreamFields, "本次 G3 上游字段");
  const selection = scope.authority.portraitReferenceSelection;
  const portraitSource = scope.authority.portraitSources?.find(source => source.characterId === selection?.characterId
    && source.portraitVersion === selection.portraitVersion);
  // Agent4 treats the inherited G2 notes as literal constraints. Project the
  // frozen inputs in the cloned G3 view, keeping the approved sources intact.
  discovery.upstreamFields = {
    ...upstream,
    special_notes: [
      `客户冻结分段：${frozen.count} 个连续生成片段，每段 ${frozen.secondsPerSegment} 秒，共 ${frozen.totalSeconds} 秒，相邻片段之间恰好 ${frozen.count - 1} 处硬切。`,
      `动作、素材、原生声音和后期文字按完整客户 Brief、当前 G1 用途和 G3 已审节点执行；无对白，不增加双语轨或其他未声明文字。`,
      ...(selection && portraitSource ? [
        `人物档案 V${portraitSource.portraitVersion} 原图共 ${Object.keys(portraitSource.originals).length} 张待 G5 核验；每个含该人物的生成片段只按 ${selection.angles.join(" → ")} 顺序引用其中 ${selection.angles.length} 张，不能换角度或把全档案作为单镜输入。`,
      ] : []),
    ].join(" "),
  };
  const audience = requirementRecord(discovery.audienceProfile ?? {}, "本次 G3 受众");
  discovery.audienceProfile = {
    ...audience,
    emotionTriggers: contract.scenes.slice(0, 5).map(scene => scene.purpose),
    contentExpectations: frozen.intervals.slice(0, 4).map(interval => interval.brief),
  };
  const risk = requirementRecord(discovery.riskAssessment ?? {}, "本次 G3 风险");
  const source = scope.truth ?? truthBoundary(scope, []);
  const boundUsage = source.constraints.filter(line => line.startsWith("内部使用前提（不是创意文案）："));
  discovery.riskAssessment = {
    ...risk,
    businessConstraints: [...new Set([...boundUsage, ...source.constraints])].slice(0, 3),
  };
  return frozen;
}

function prdCharacterShapeFeedback(error: unknown, schema: RequirementRecord): string | undefined {
  const path = prdCharacterShapePath(error);
  if (!path) return undefined;
  const root = requirementRecord(schema.properties, "制作规格 schema 字段");
  const characterSystem = requirementRecord(requirementRecord(root.characterSystem, "角色系统 schema").properties, "角色系统 schema 字段");
  const character = requirementRecord(requirementRecord(characterSystem.characters, "角色数组 schema").items, "角色项 schema");
  const allowedProperties = Object.keys(requirementRecord(character.properties, "角色项 schema 字段"));
  const facts = { path, keyword: "additionalProperties", allowedProperties };
  return `\n\n## 上一次原生制作规格结构校验反馈\n${JSON.stringify(facts)}\n依据完整原始任务和同一 schema，重新生成完整四模块 JSON。此对象仅允许列出的键，保留冻结人物、场景、时长和制作约束。不得引用上次回复。`;
}

function prdAudioReferenceBounds(schema: RequirementRecord): { min: number; max: number } {
  const properties = requirementRecord(schema.properties, "制作规格 schema 字段");
  const audio = requirementRecord(requirementRecord(properties.audioSpecification, "音频规格 schema").properties, "音频规格字段");
  const references = requirementRecord(audio.audioReferences, "音频参考 schema");
  const min = references.minItems ?? 0, max = references.maxItems;
  if (references.type !== "array" || typeof min !== "number" || typeof max !== "number"
    || !Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 0 || max < min) {
    prdFail("PRD_VENDOR_UNAVAILABLE", "Agent3 音频参考 schema 数量边界已经变化");
  }
  return { min, max };
}

function descriptorEqual(a: PropertyDescriptor | undefined, b: PropertyDescriptor): boolean {
  return Boolean(a && a.value === b.value && a.writable === b.writable && a.configurable === b.configurable
    && a.enumerable === b.enumerable && a.get === b.get && a.set === b.set);
}

export function assertPrdAuthorityBridge(vendorPrototype: object): void {
  const installed = active.get(vendorPrototype);
  if (!installed || installed.schemaHash !== requirementHash(installed.schema) || installed.changes.some(change =>
    !descriptorEqual(Object.getOwnPropertyDescriptor(change.owner, change.key), { ...change.original, value: change.patched }))) {
    prdFail("PRD_BRIDGE_CHANGED", "PRD 权威桥的方法、属性或 schema 身份已经变化");
  }
}

/** Detect an explicit competing schedule without interpreting ordinary shot timing prose. */
function verifyExplicitPostTailSchedule(result: RequirementRecord, profile: PrdAuthority["profile"]): void {
  const { postTailOverlayText: text, postTailOverlaySeconds: seconds, targetDuration: end } = profile;
  if (text === undefined || seconds === undefined || end === undefined) return;
  const start = Math.round((end - seconds) * 100) / 100;
  const scenes = requirementRecord(result.scenePlan, "G4 场景计划").scenes as RequirementRecord[];
  for (const scene of scenes) {
    for (const key of ["visualRequirements", "audioRequirements"] as const) {
      if (!Array.isArray(scene[key])) continue;
      for (const note of scene[key]) {
        if (typeof note !== "string") continue;
        for (const clause of note.split(/[，。；;\n]/u)) {
          if (!clause.includes(text)) continue;
          const range = clause.match(/^\s*(?:仅在|只在|在)?\s*(\d+(?:\.\d+)?)\s*(?:秒\s*)?[-–—~～至]\s*(\d+(?:\.\d+)?)\s*秒\s*(?:在原生画面上)?\s*(?:由)?\s*本地后期(?:独立)?(?:文字)?层\s*(?:叠加|显示)/u);
          if (range && (Math.abs(Number(range[1]) - start) > 1e-9 || Math.abs(Number(range[2]) - end) > 1e-9)) {
            prdFail("PRD_DELIVERY_INVALID", "场景计划的本地片尾层区间与本次明确的交付合同冲突");
          }
        }
      }
    }
  }
}

function verifyOutput(scope: Scope, value: unknown, schema: RequirementRecord): RequirementRecord {
  return guard(scope, () => {
    const result = requirementRecord(value, "PRD 当前结果");
    if (!scope.contract || !scope.generated.has(result)) prdFail("PRD_RESULT_UNBOUND", "PRD 不属于本次真实生成调用");
    validatePrdProduction(result, scope.contract, scope.authority.profile);
    verifyExplicitPostTailSchedule(result, scope.authority.profile);
    validatePrdDelivery(result, scope.authority.profile, schema);
    const quality = scope.quality.get(result);
    const constraints = requirementRecord(result.productionConstraints, "PRD 制作约束");
    const delivery = requirementRecord(result.deliveryStandard, "PRD 交付标准");
    if (!quality || requirementHash(constraints.qualityThresholds) !== requirementHash(quality.thresholds)
      || requirementHash(delivery.acceptanceCriteria) !== requirementHash(quality.thresholds)
      || requirementRecord(delivery.fallbackPlan, "PRD 降级预案").trigger !== quality.fallbackTrigger) {
      prdFail("PRD_QUALITY_CHANGED", "制作、验收和降级触发未使用本次同一真实规则阈值");
    }
    if (scope.truth && (!Array.isArray(constraints.businessConstraints)
      || scope.truth.nativeLines.filter(line => line.startsWith("宣称上限：")).some(line => (constraints.businessConstraints as unknown[]).includes(line)))) {
      prdFail("PRD_TRUTH_CHANGED", "旧自动宣称上限不能重新成为本片创作约束");
    }
    const marker = requirementRecord(result._workloomPrdAuthority, "PRD 来源凭据");
    const positioning = requirementRecord(result.productPositioning, "PRD 产品定位");
    const output = requirementRecord(requirementRecord(result.deliveryStandard, "PRD 交付标准").outputFormat, "PRD 输出格式");
    const profile = scope.authority.profile;
    const g1 = requirementRecord(marker.g1, "PRD G1 来源锚点");
    const characters = requirementRecord(result.characterSystem, "PRD characterSystem").characters as RequirementRecord[];
    const scenes = requirementRecord(result.scenePlan, "PRD scenePlan").scenes as RequirementRecord[];
    const audienceAuthority = requirementRecord(requirementRecord(result.audienceProfile, "PRD 受众")._workloomAudienceAuthority, "PRD 受众权威标记");
    if (marker.schemaVersion !== "workloom.prd-authority/v1" || marker.status !== "ready-for-g4"
      || g1.path !== scope.authority.marketing.g1Artifact.path || g1.sha256 !== scope.authority.marketing.g1Artifact.sha256
      || marker.requirementContractHash !== scope.contract.hash || marker.castHash !== scope.contract.cast.hash
      || marker.scenePlanHash !== requirementHash(result.scenePlan) || marker.characterSystemHash !== requirementHash(result.characterSystem)
      || requirementHash(result._workloomRequirementContract) !== requirementHash(scope.contract)
      || audienceAuthority.schemaVersion !== "workloom.prd-audience-authority/v1"
      || audienceAuthority.customerOriginal !== scope.contract.ownerAudience || audienceAuthority.modelStatus !== "model-hypothesis"
      || scenes.some((scene, index) => requirementHash(scene._workloomRequirementScene) !== requirementHash(scope.contract!.scenes[index]))
      || characters.some(character => {
        const selected = scope.contract!.cast.characters.find(item => item.id === character.characterId);
        return requirementHash(character._workloomCharacterSource) !== requirementHash(selected)
          || requirementHash(character._workloomCharacterSelection) !== requirementHash(scope.contract!.cast.selection);
      })
      || requirementHash(marker.scope) !== requirementHash(scope.authority.marketing.scope)
      || requirementHash(marker.profile) !== requirementHash(profile) || positioning.productType !== "商业广告"
      || ["targetDuration", "aspectRatio", "targetPlatform", "resolution", "frameRate"].some(key => Object.hasOwn(profile, key) && positioning[key] !== profile[key as keyof typeof profile])
      || Object.keys(profile).some(key => output[key] !== profile[key as keyof typeof profile])) {
      prdFail("PRD_AUTHORITY_CHANGED", "PRD 权威规格或本次场景/人物来源在生成后发生变化");
    }
    return result;
  });
}

/** Dependency seam: production supplies the exact pinned CJS prototypes and native PRD schema. */
export function installPrdAuthorityBridge(
  vendorPrototype: RequirementRecord, prdPrototype: RequirementRecord, schema: RequirementRecord
): () => void {
  if (active.has(vendorPrototype)) prdFail("PRD_BRIDGE_ACTIVE", "PRD 权威桥只能由共享引用计数安装");
  if (nativeIdentities.get(vendorPrototype)?.some(item => !descriptorEqual(Object.getOwnPropertyDescriptor(item.owner, item.key), item.descriptor))) {
    prdFail("PRD_BRIDGE_CHANGED", "原始 PRD 方法与首次受控身份不一致");
  }
  const schemaHash = requirementHash(schema);
  const confirmList = method(vendorPrototype, "_confirmRequirementList");
  const minimal = method(vendorPrototype, "_generateMinimalPRD");
  const confirmPrd = method(vendorPrototype, "_confirmPRD");
  const nativeTruth = Object.hasOwn(vendorPrototype, "_runProductTruthCheckGate")
    ? method(vendorPrototype, "_runProductTruthCheckGate") : undefined;
  const generate = method(prdPrototype, "generate");
  const markdown = method(prdPrototype, "generateMarkdown");
  const changes: Change[] = [];
  const check = (scope: Scope) => guard(scope, () => assertPrdAuthorityBridge(vendorPrototype));

  const checkedTruth: Method = function (metadataValue, resultValue, ...args) {
    const scope = scopedReceiver(this, "system");
    if (!scope) return Reflect.apply(nativeTruth!, this, [metadataValue, resultValue, ...args]);
    return guard(scope, () => {
      check(scope);
      if (scope.reviewedHash) prdFail("PRD_UNREVIEWED_REGENERATION", "G4 后不能替换本次事实用途边界");
      if (scope.system && scope.system !== this) prdFail("PRD_SCOPE_CONFLICT", "事实红线不属于本次系统");
      systems.set(this, scope); scope.system = this;
      const metadata = requirementRecord(metadataValue, "事实红线 metadata");
      const result = requirementRecord(resultValue, "事实红线 result");
      const verdict = Reflect.apply(nativeTruth!, this, [metadataValue, resultValue, ...args]);
      // Preserve the real native pass/blocking/degraded/conflicts and return
      // object. Only rule-generated use-boundary wording is replaced.
      const stages = result.stages && typeof result.stages === "object" ? requirementRecord(result.stages, "事实红线 stages") : {};
      if (!stages.truthCheck) return verdict;
      const stage = requirementRecord(stages.truthCheck, "本次原生事实红线");
      if (stage.factRedLines === undefined) return verdict;
      if (!Array.isArray(stage.factRedLines) || stage.factRedLines.some(line => typeof line !== "string")) {
        prdFail("PRD_VENDOR_UNAVAILABLE", "原生事实红线必须为完整文本数组");
      }
      const boundary = truthBoundary(scope, stage.factRedLines as string[]);
      scope.truth = boundary;
      stage._workloomNativeFactRedLines = structuredClone(boundary.nativeLines);
      metadata._workloomNativeFactRedLines = structuredClone(boundary.nativeLines);
      stage.factRedLines = structuredClone(boundary.constraints);
      metadata._factRedLines = structuredClone(boundary.constraints);
      return verdict;
    });
  };

  const confirmed: Method = async function (content, listValue) {
    const scope = scopedReceiver(this, "system");
    if (!scope) return Reflect.apply(confirmList, this, [content, listValue]);
    return awaited(scope, async () => {
      check(scope);
      const list = requirementRecord(listValue, "G3 实际需求清单");
      const generator = requirementRecord(this.prdGenerator, "本次 PRDGenerator");
      const previousSystem = systems.get(this), previousGenerator = generators.get(generator);
      if ((previousSystem && previousSystem !== scope) || (previousGenerator && previousGenerator !== scope)
        || (scope.system && scope.system !== this) || (scope.generator && scope.generator !== generator)) {
        prdFail("PRD_SCOPE_CONFLICT", "系统或 PRDGenerator 属于另一运行的权威作用域");
      }
      systems.set(this, scope); generators.set(generator, scope);
      scope.system = this; scope.generator = generator;
      const before = requirementHash(list);
      const result = requirementRecord(await Reflect.apply(confirmList, this, [content, listValue]), "G3 实际确认结果");
      check(scope);
      if (requirementHash(list) !== before || result.requirementList !== listValue) prdFail("PRD_G3_CHANGED", "G3 审核前后的实际需求合同不是同一内容");
      if (result.approved === true) {
        scope.list = structuredClone(list);
        scope.listHash = requirementHash(scope.list);
      }
      return result;
    });
  };
  const noMinimal: Method = function (...args) {
    const scope = scopedReceiver(this, "system");
    if (!scope) return Reflect.apply(minimal, this, args);
    return guard(scope, () => prdFail("PRD_FALLBACK_FORBIDDEN", "本次 PRD 失败不能改用最小规则文档继续生产"));
  };

  const generated: Method = async function (discoveryValue) {
    const scope = scopedReceiver(this, "generator");
    if (!scope) return Reflect.apply(generate, this, [discoveryValue]);
    return awaited(scope, async () => {
      check(scope);
      if (!scope.system || scope.generator !== this || systems.get(scope.system) !== scope || generators.get(this) !== scope
        || !scope.list || requirementHash(scope.list) !== scope.listHash) prdFail("PRD_G3_UNVERIFIED", "PRD 缺少本次已获真实 G3 批准的完整合同");
      if (scope.reviewedHash) prdFail("PRD_UNREVIEWED_REGENERATION", "G4 批准后不能用未经重新审核的 PRD 覆盖已审版本");
      const discovery = structuredClone(requirementRecord(discoveryValue, "PRD 原始 discovery"));
      const sourceHash = requirementHash(discovery.sceneStructure);
      const metadata = { ...scope.authority.metadata, _workloomRequirementContract: scope.list._workloomRequirementContract };
      const contract = verifiedRequirementContract(scope.list, metadata, discovery);
      scope.contract = structuredClone(contract);
      const visualSegments = frozenVisualDiscoveryView(scope, discovery, contract);
      const scopedIdentityAndUseOnly = visualSegments !== undefined && identityAndUseOnly(scope.authority);
      const tone = visualSegments ? requirementRecord(discovery.upstreamFields, "本次 G3 上游字段").tone : undefined;
      const references = marketingPrdReferenceView(discovery.referenceCases, scope.authority.metadata);
      // The original G3 review retains discovery advice. Its free text can
      // combine style with new action timings and cut positions; only the
      // approved contract and frozen brief supply execution for these shots.
      if (references) discovery.referenceCases = visualSegments ? { ...references, styleReferences: [] } : references;
      const promptContext = prdAuthorityPrompt(scope.authority, contract)
        + (scope.truth ? `\n\n本次规则事实边界（仅作内部限制，不是创意任务；完整原件不变）：\n${JSON.stringify(scope.truth.constraints)}\n` : "")
        + (visualSegments ? `\n\n## 本次无对白制作采用边界\n`
          + `完整 G3 原件中的 modelAudienceHypothesis 仅供审计；禁止采用其固定短句、额外动作或推测数值作为剧情、台词、字幕、时间节点或制作约束。`
          + `未采纳的 G3 风格建议只留在原始审核材料；用客户原文和已审 G2/G3 场景来决定摄影与声音，不把参考当作另一套动作或剪辑指令。`
          + `实际创意动作顺序、时长与连续性来自本次 ${visualSegments.count} 个已审场景及客户冻结段。每段是一个 ${visualSegments.secondsPerSegment} 秒的生成镜头，整片只有相邻两段之间共 ${visualSegments.count - 1} 处硬切；段内机位变化不计作剪辑或额外生成镜头。`
          + `情绪弧线选择与这些现有节点可逐项对应的枚举，段内情绪变化仍是原场景的一部分。出现产品名或型号时直接复制已接受 G1 对应身份，不改写字符。`
          + `全片保留客户要求的原生环境和动作声，无可辨识人声。不增加双语轨。已声明的持续标识保留至末帧；如声明了独立片尾文字，只在声明的结尾区间本地后期叠加，禁止放在生成画面、前段或片头。P0 等导演内部要求也要分别说明两个适用区间，不得用“后期只叠加产品名”覆盖已声明的持续标识。\n` : "");
      const view = Object.create(this) as RequirementRecord;
      let constraintResult: RequirementRecord | undefined;
      let originalThresholds: QualityThresholds | undefined;
      let qualityPolicy: QualityPolicy | undefined;
      for (let number = 1; number <= 5; number++) {
        const key = `agent${number}`, agent = requirementRecord(this[key], key);
        const agentView = Object.create(agent) as RequirementRecord;
        const process = method(agent, "process");
        if (number === 1) {
          agentView.process = function (this: RequirementRecord, ...args: unknown[]) {
            return guard(scope, () => {
              check(scope);
              const result = authoritativeProduct(Reflect.apply(process, this, args), scope.authority.profile);
              requirementRecord(result.productPositioning, "营销产品定位").productType = "商业广告";
              return result;
            });
          };
        } else if (number === 4) {
          agentView.process = function (this: RequirementRecord, ...args: unknown[]) {
            return guard(scope, () => {
              check(scope);
              const result = requirementRecord(Reflect.apply(process, this, args), "原生 Agent4 结果");
              const references = requirementRecord(result.referenceCases, "原生 Agent4 参考案例");
              if (Array.isArray(references.filmReferences) && !references.filmReferences.length) {
                references.filmReferences = ["客户未指定命名影片，采用本次视觉规格中的摄影手法"];
              }
              if (Array.isArray(references.styleReferences) && !references.styleReferences.length) {
                references.styleReferences = ["具体手法见本次视觉与声音规格"];
              }
              originalThresholds = qualityThresholds(requirementRecord(result.productionConstraints, "Agent4 制作约束").qualityThresholds, "Agent4 制作阈值");
              constraintResult = result;
              return result;
            });
          };
        } else if (number === 5) {
          const criteria = method(agent, "_buildAcceptanceCriteria"), fallback = method(agent, "_buildFallbackPlan");
          agentView._buildAcceptanceCriteria = function (this: RequirementRecord, ...args: unknown[]) {
            return guard(scope, () => {
              check(scope);
              if (!constraintResult || !originalThresholds) prdFail("PRD_QUALITY_INVALID", "Agent5 缺少本次真实 Agent4 制作阈值");
              const acceptance = qualityThresholds(Reflect.apply(criteria, this, args), "Agent5 原生验收阈值");
              const thresholds = unifiedQuality(originalThresholds, acceptance);
              requirementRecord(constraintResult.productionConstraints, "本次制作约束").qualityThresholds = structuredClone(thresholds);
              qualityPolicy = { production: originalThresholds, nativeAcceptance: acceptance, thresholds, fallbackTrigger: "" };
              return structuredClone(thresholds);
            });
          };
          agentView._buildFallbackPlan = function (this: RequirementRecord, ...args: unknown[]) {
            return guard(scope, () => {
              check(scope);
              if (!qualityPolicy) prdFail("PRD_QUALITY_INVALID", "降级预案缺少本次统一阈值");
              const result = requirementRecord(Reflect.apply(fallback, this, args), "Agent5 原生降级预案");
              const trigger = typeof result.trigger === "string" ? /^视觉质量低于 (0(?:\.\d+)?|1(?:\.0+)?) 或连续 (\d+) 次迭代无改善$/.exec(result.trigger) : null;
              if (!trigger || Number(trigger[1]) !== qualityPolicy.nativeAcceptance.visual) {
                prdFail("PRD_VENDOR_UNAVAILABLE", "原生降级触发与原生验收结构已变化，不能猜测或降低要求");
              }
              qualityPolicy.fallbackTrigger = `视觉质量低于 ${qualityPolicy.thresholds.visual} 或连续 ${trigger[2]} 次迭代无改善`;
              return { ...result, trigger: qualityPolicy.fallbackTrigger };
            });
          };
          agentView.process = function (this: RequirementRecord, ...args: unknown[]) {
            return guard(scope, () => {
              check(scope);
              if (!constraintResult || args[3] !== constraintResult) prdFail("PRD_QUALITY_INVALID", "Agent5 未消费本次真实 Agent4 结果");
              const result = authoritativeDelivery(Reflect.apply(process, this, args), scope.authority.profile, scope.authority);
              validatePrdDelivery(result, scope.authority.profile, schema);
              if (!qualityPolicy || !qualityPolicy.fallbackTrigger) prdFail("PRD_QUALITY_INVALID", "原生 Agent5 未产生完整统一阈值与降级预案");
              return result;
            });
          };
        } else if (number === 2 || number === 3) {
          const build = method(agent, "_buildPrompt"), call = method(agent, "_callLLM"), parse = method(agent, "_parseResult");
          const getEngine = method(agent, "_getLLMEngine");
          method(agent, "fallback");
          const kind = number === 2 ? "creative" : "production";
          const scopedCreative = kind === "creative" && visualSegments !== undefined;
          const scopedCreativeFacts = kind === "creative" && scopedIdentityAndUseOnly;
          const scopedProduction = kind === "production" && visualSegments !== undefined;
          const scopedAudio = scopedProduction && scope.authority.profile.nativeAudio === true;
          const effectiveSchema = effectivePrdModelSchema(kind, schema, contract);
          const audioBounds = kind === "production" ? prdAudioReferenceBounds(effectiveSchema) : undefined;
          const schemaHeading = `\n\n## 本次宿主 PRD ${kind} 响应 JSON Schema（${requirementHash(effectiveSchema)}）\n`;
          const responseContext = schemaHeading
            + `本次实际模型响应必须符合以下完整 JSON Schema；它与宿主严格校验使用同一份有效结构，补充前述通用示例。`
            + (kind === "creative" ? `只输出创意核心的裸 JSON 对象，不要包裹 creativeCore。\n` : `只输出以下四个制作模块组成的 JSON 对象。\n`)
            + `\`\`\`json\n${JSON.stringify(effectiveSchema)}\n\`\`\`\n` + promptContext
            + (number === 3 ? productionPlanningPrompt(scope) : "")
            + (audioBounds ? `\n\naudioSpecification.audioReferences 必须是 ${audioBounds.min}–${audioBounds.max} 项。按声音手法分组写相关内容，提交前核对项目数；不得编造参考来源。\n`
              + (scope.authority.profile.speechPolicy === "none"
                ? "沿用本次无对白要求，不能生成可辨识人声。没有明确要求的配乐不作为参考或占位配乐，原生环境和动作声音按已审要求保留。\n" : "") : "")
            + (scopedCreativeFacts ? prdCreativeFactBoundary : "")
            + (scopedCreative ? prdCreativeJsonPresentation : "")
            + (number === 3 && visualSegments ? `\n场景的 scenePlan.scenes[].emotionalBeat 与当前创意弧线和实际 G3 节点逐项对应；用对应场景的动作安排表现节点内情绪变化。shotMapping.estimatedShots 每场写 1，摄影、剪辑和连续性计划遵守上述冻结切点。`
              + (typeof tone === "string" && tone.trim() ? `在 visualSpecification.colorPalette.mood 明写本次 G2 已审调性：${tone}；同一调性下可用本次动作、色彩和声音写出不同强度，不以新的调性或描述替换已审名称。\n` : "") : "");
          let builtPrompt: { original: string; complete: string } | undefined;
          let nativeAttemptLimit = 0;
          let modelAttempts = 0;
          let nativeCallActive = false;
          let correction: { prompt: string; argsHash: string; dispatched: boolean;
            creative?: { first: LLMReasonResult; inTime: () => boolean; kind: "syntax" | "facts" };
            productionShape?: { first: LLMReasonResult; inTime: () => boolean; subject: "角色对象" | "音频参考" } } | undefined;
          agentView._getLLMEngine = function (this: RequirementRecord, ...args: unknown[]) {
            return guard(scope, () => {
              check(scope);
              const value = Reflect.apply(getEngine, this, args);
              if (value === null || value === undefined) return value;
              const engine = requirementRecord(value, "PRD 原始模型引擎"), reason = method(engine, "reasonStructured");
              const ownerEngine = scope.system?.llmEngine;
              const host = ownerEngine instanceof WorkloomLLMEngine ? ownerEngine : undefined;
              const vendorCurrent = scopedCreative || scopedProduction
                ? attestVendorStructuredRedirect(engine, reason, host) : undefined;
              if (vendorCurrent === false) prdFail("PRD_ENGINE_CHANGED", "本次原生 PRD 引擎桥未绑定当前制作会话");
              const nativeEngine = engine instanceof WorkloomLLMEngine && WorkloomLLMEngine.supportsStructuredReviewProof(engine)
                ? engine : vendorCurrent ? host : undefined;
              const creativeEngine = scopedCreative ? nativeEngine : undefined;
              const enginePrototype = Object.getPrototypeOf(engine);
              let methodOwner: object | null = engine;
              while (methodOwner && !Object.getOwnPropertyDescriptor(methodOwner, "reasonStructured")) methodOwner = Object.getPrototypeOf(methodOwner);
              const reasonDescriptor = methodOwner && Object.getOwnPropertyDescriptor(methodOwner, "reasonStructured");
              if (!methodOwner || !reasonDescriptor || reasonDescriptor.value !== reason) prdFail("PRD_VENDOR_UNAVAILABLE", "原始模型方法不是固定的数据属性");
              const checkEngine = () => {
                if (Object.getPrototypeOf(engine) !== enginePrototype || engine.reasonStructured !== reason
                  || !descriptorEqual(Object.getOwnPropertyDescriptor(methodOwner!, "reasonStructured"), reasonDescriptor)
                  || (vendorCurrent && (scope.system?.llmEngine !== host || !vendorCurrent()))) {
                  prdFail("PRD_ENGINE_CHANGED", "本次模型引擎方法或属性身份已经变化");
                }
              };
              const engineView = Object.create(engine) as RequirementRecord;
              let nativePrefix: string | undefined;
              engineView.reasonStructured = async function (prompt: unknown, ...callArgs: unknown[]) {
                const complete = guard(scope, () => {
                  check(scope); checkEngine();
                  if (creativeEngine && (!nativeCallActive || (modelAttempts > 0 && !correction))) {
                    prdFail("PRD_MODEL_UNVERIFIED", "Agent2 没有可证明的可修正原生响应，不允许再次发出请求");
                  }
                  if (scopedProduction && nativeEngine && (!nativeCallActive || (modelAttempts > 0 && !correction))) {
                    prdFail("PRD_MODEL_UNVERIFIED", "Agent3 没有可证明的已完成结构失败，不允许再次发出请求");
                  }
                  if (typeof prompt !== "string") prdFail("PRD_VENDOR_UNAVAILABLE", "实际模型调用 prompt 不是文本");
                  if (!builtPrompt) prdFail("PRD_VENDOR_UNAVAILABLE", "实际模型调用缺少本次亲自构建的 PRD prompt");
                  if (nativePrefix === undefined) {
                    if (!prompt.endsWith(builtPrompt.complete)) prdFail("PRD_VENDOR_UNAVAILABLE", "首次模型 prompt 不属于本次完整构建结果");
                    nativePrefix = prompt.slice(0, prompt.length - builtPrompt.complete.length);
                    return prompt;
                  }
                  if (!prompt.startsWith(nativePrefix)) prdFail("PRD_VENDOR_UNAVAILABLE", "原生模型 prompt 前缀在重试期间变化");
                  if (correction) {
                    if (correction.dispatched || requirementHash(callArgs) !== correction.argsHash) {
                      prdFail("PRD_MODEL_UNVERIFIED", "本次修正次数或原生请求参数已变化");
                    }
                    if (correction.creative) {
                      const { first, inTime, kind } = correction.creative;
                      if (kind === "facts") scope.validateAuthority?.();
                      const route = kind === "syntax" ? nativeChatJsonSyntaxRouteCurrent : nativeChatJsonObjectRouteCurrent;
                      if (!creativeEngine || !inTime() || !route(creativeEngine, first)) {
                        prdFail("PRD_MODEL_UNVERIFIED", "Agent2 修正的原生路径或原时限已变化");
                      }
                    }
                    if (correction.productionShape && (!nativeEngine || !correction.productionShape.inTime()
                      || !nativeChatJsonObjectRouteCurrent(nativeEngine, correction.productionShape.first))) {
                      prdFail("PRD_MODEL_UNVERIFIED", `Agent3 ${correction.productionShape.subject}结构修正的原生路径或原时限已变化`);
                    }
                    correction.dispatched = true;
                    return correction.prompt;
                  }
                  const currentPrompt = prompt.slice(nativePrefix.length);
                  if (currentPrompt === builtPrompt.complete) return prompt;
                  // The pinned native example-removal branch adds this trailer.
                  // Keep it separately while proving which prefix came from our build.
                  const retryTrailer = "\n[输出结构见schema]\n}";
                  const trailer = currentPrompt.endsWith(retryTrailer) ? retryTrailer : "";
                  const surviving = trailer ? currentPrompt.slice(0, -trailer.length) : currentPrompt;
                  // Restore both the effective response schema and complete frozen
                  // authority only at our recorded suffix position. A heading quoted
                  // in the customer's original text is never a truncation boundary.
                  const ownSuffixSurvived = surviving.length >= builtPrompt.original.length
                    && builtPrompt.complete.startsWith(surviving);
                  return (ownSuffixSurvived ? nativePrefix + builtPrompt.original + trailer : prompt) + responseContext;
                });
                const attempt = ++modelAttempts;
                const options = nativeEngine ? requirementRecord(callArgs[1] ?? {}, "PRD 原生模型选项") : undefined;
                const timeoutMs = options?.timeoutMs, wallDeadline = options?.deadlineMs, signal = options?.signal;
                const startedAt = performance.now();
                const nativeDeadline = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? startedAt + timeoutMs : 0;
                const withinNativeTimeout = () => nativeCallActive && performance.now() < nativeDeadline
                  && (typeof wallDeadline !== "number" || Date.now() < wallDeadline)
                  && (!(signal instanceof AbortSignal) || !signal.aborted);
                let result: unknown;
                try { result = await Reflect.apply(reason, engine, [complete, ...callArgs]); }
                catch (error) {
                  // A provider/parse failure may use the native retry budget. Authority,
                  // scope or engine identity failures remain sticky and prevent that retry.
                  guard(scope, () => { check(scope); checkEngine(); });
                  throw error;
                }
                guard(scope, () => { check(scope); checkEngine(); });
                if (creativeEngine) {
                  const response = result as LLMReasonResult;
                  if (correction?.creative && correction.dispatched) {
                    const { first, inTime, kind: correctionKind } = correction.creative;
                    guard(scope, () => {
                      if (correctionKind === "facts") scope.validateAuthority?.();
                      const corrected = correctionKind === "syntax" ? nativeChatJsonSyntaxCorrected : nativeChatJsonObjectCorrected;
                      if (!withinNativeTimeout() || !inTime() || !corrected(first, response)) {
                        prdFail("PRD_MODEL_UNVERIFIED", "Agent2 修正未取得同一路径的新完整响应");
                      }
                      validatePrdModelPayload(response.data, kind, schema, contract, scope.authority.profile);
                      if (scopedCreativeFacts) rejectCreativeVehicleGeometry(response.data);
                    });
                  } else if (!response.success && nativeReasonFailure(response) === "json-syntax") {
                    if (attempt === 1 && modelAttempts === 1 && nativeAttemptLimit >= 2 && withinNativeTimeout()
                      && nativeChatJsonSyntaxRouteCurrent(creativeEngine, response)) {
                      correction = { prompt: complete + prdCreativeJsonCorrection, argsHash: requirementHash(callArgs),
                        dispatched: false, creative: { first: response, inTime: withinNativeTimeout, kind: "syntax" } };
                      // Use the pinned BaseAgent's own PARSE retry slot. Its
                      // shortened draft is replaced by the original complete prompt.
                      throw new Error("Agent2 JSON 结构校验失败，进入一次原生格式修正");
                    }
                    // The vendor logs error strings; V8 can include private draft text.
                    return { success: false, retryable: false, error: "Agent2 原生创意正文未通过 JSON 语法校验" };
                  } else if (scopedCreativeFacts && response.success && hasCreativeVehicleGeometry(response.data)) {
                    guard(scope, () => {
                      scope.validateAuthority?.();
                      if (attempt !== 1 || modelAttempts !== 1 || nativeAttemptLimit < 2 || !withinNativeTimeout()
                        || !nativeChatJsonObjectRouteCurrent(creativeEngine, response)) {
                        prdFail("PRD_CREATIVE_FACT_UNVERIFIED", "Agent2 商品事实修正缺少本次原时限内的完整原生响应");
                      }
                      validatePrdModelPayload(response.data, kind, schema, contract, scope.authority.profile);
                    });
                    correction = { prompt: complete + prdCreativeFactCorrection, argsHash: requirementHash(callArgs),
                      dispatched: false, creative: { first: response, inTime: withinNativeTimeout, kind: "facts" } };
                    throw new Error("Agent2 JSON 内容校验失败，进入一次原生商品事实修正");
                  }
                }
                if (kind === "production") {
                  const response = result as LLMReasonResult;
                  const productionShape = correction?.dispatched && correction.productionShape;
                  if (productionShape) {
                    guard(scope, () => {
                      if (!withinNativeTimeout() || !productionShape.inTime() || !nativeChatJsonObjectCorrected(productionShape.first, response)) {
                        prdFail("PRD_MODEL_UNVERIFIED", `Agent3 ${productionShape.subject}结构修正未取得同一路径的新完整响应`);
                      }
                      validatePrdModelPayload(response.data, kind, schema, contract, scope.authority.profile);
                    });
                    return result;
                  }
                  const completed = nativeEngine && nativeReasonCompleted(response);
                  if (correction?.dispatched && (!completed || !response.success)) {
                    guard(scope, () => prdFail("PRD_MODEL_UNVERIFIED", "Agent3 结构修正缺少已完成的原生模型响应"));
                  }
                  if (completed && response.success && attempt === 1 && modelAttempts === 1 && nativeAttemptLimit >= 2) {
                    try { validatePrdModelPayload(response.data, kind, schema, contract, scope.authority.profile); }
                    catch (error) {
                      const feedback = prdCharacterShapeFeedback(error, effectiveSchema);
                      const strictCompletion = scopedProduction && nativeEngine && withinNativeTimeout()
                        && nativeChatJsonObjectRouteCurrent(nativeEngine, response);
                      if (feedback && (!scopedProduction || strictCompletion)) {
                        correction = { prompt: complete + feedback, argsHash: requirementHash(callArgs), dispatched: false,
                          ...(scopedProduction ? { productionShape: { first: response, inTime: withinNativeTimeout, subject: "角色对象" } } : {}) };
                        // The pinned BaseAgent routes JSON failures through its
                        // existing second attempt and unchanged timeout budget.
                        throw new Error("Agent3 JSON 结构校验失败，进入一次原生结构修正");
                      }
                      const overflow = prdAudioReferencesOverflow(error);
                      if (scopedAudio && overflow && audioBounds?.max === overflow.limit && strictCompletion) {
                        const audioFeedback = `\n\n## 上一次原生制作规格结构校验反馈\n${JSON.stringify(overflow)}\n`
                          + "按同一 schema 和完整原始任务重新生成完整四模块 JSON。音频参考保持在已声明数量内，"
                          + "保留原生声音和已审制作要求；不得引用、截取或补填上次回复。";
                        correction = { prompt: complete + audioFeedback, argsHash: requirementHash(callArgs), dispatched: false,
                          productionShape: { first: response, inTime: withinNativeTimeout, subject: "音频参考" } };
                        throw new Error("Agent3 JSON 结构校验失败，进入一次原生结构修正");
                      }
                      // The ordinary parser retains responsibility for all
                      // other validation failures and their original errors.
                    }
                  }
                }
                return result;
              };
              return engineView;
            });
          };
          agentView._buildPrompt = function (this: RequirementRecord, ...args: unknown[]) {
            return guard(scope, () => {
              check(scope);
              const native = Reflect.apply(build, this, args);
              if (typeof native !== "string") prdFail("PRD_VENDOR_UNAVAILABLE", "原始 PRD prompt 不是文本");
              const hasStory = Boolean(discovery._originalStoryText || discovery.original_story_text);
              const original = kind === "production" ? bindPrdPortraitRule(native)
                : visualSegments ? frozenVisualCreativeRule(native, hasStory, visualSegments.count) : native;
              builtPrompt = { original, complete: original + responseContext };
              return builtPrompt.complete;
            });
          };
          agentView._callLLM = function (this: RequirementRecord, ...args: unknown[]) {
            return awaited(scope, async () => {
              check(scope);
              if (kind === "production" || scopedCreative) {
                const options = requirementRecord(args[3] ?? {}, "PRD 原生调用配置");
                const limit = options.maxRetries ?? this.llmMaxRetries;
                nativeAttemptLimit = typeof limit === "number" && Number.isSafeInteger(limit) ? limit : 0;
              }
              nativeCallActive = true;
              try {
                const result = requirementRecord(await Reflect.apply(call, this, args), "PRD 模型调用回执");
                check(scope);
                if (result.degraded !== false || result.result === null || result.result === undefined) prdFail("PRD_MODEL_UNVERIFIED", "本次 PRD 模型失败或降级，不能使用模板创意");
                return result;
              } finally {
                nativeCallActive = false;
              }
            });
          };
          agentView._parseResult = function (this: RequirementRecord, value: unknown, ...args: unknown[]) {
            return guard(scope, () => {
              check(scope);
              const raw = validatePrdModelPayload(value, kind, schema, contract, scope.authority.profile);
              if (scopedCreativeFacts) rejectCreativeVehicleGeometry(typeof value === "string" ? raw : value);
              const parseInput = typeof value === "string" ? JSON.stringify(raw) : raw;
              const result = Reflect.apply(parse, this, [parseInput, ...args]);
              if (requirementHash(result) !== requirementHash(kind === "creative" ? { creativeCore: raw } : raw)) {
                prdFail("PRD_RESPONSE_CHANGED", "原生 parser 用规则修改了真实模型模块，拒绝把补全文字当作模型创作");
              }
              return result;
            });
          };
          agentView.fallback = function () {
            return guard(scope, () => prdFail("PRD_MODEL_UNVERIFIED", "本次创意和制作规格必须来自真实模型，拒绝模板 fallback"));
          };
          agentView.process = function (this: RequirementRecord, ...args: unknown[]) {
            return awaited(scope, () => {
              check(scope);
              return Reflect.apply(process, this, args);
            });
          };
        } else {
          agentView.process = function (this: RequirementRecord, ...args: unknown[]) {
            return guard(scope, () => { check(scope); return Reflect.apply(process, this, args); });
          };
        }
        view[key] = agentView;
      }
      // Keep the native two real LLM process calls, timeout/retry budget, rule agents and schema pipeline.
      const generated = requirementRecord(await Reflect.apply(generate, view, [discovery]), "PRD 生成结果");
      check(scope);
      if (requirementHash(discovery.sceneStructure) !== sourceHash) prdFail("PRD_G3_CHANGED", "PRD 生成修改了已经批准的源场景");
      const normalized = normalizeMarketingPrdContract(
        generated,
        scope.authority.metadata,
        scope.authority.profile,
        scope.contract,
      );
      const result = bindPrdProvenance(normalized.prd, scope.authority, contract);
      if (!qualityPolicy) prdFail("PRD_QUALITY_INVALID", "本次原生规则调用没有形成质量阈值来源");
      scope.quality.set(result, structuredClone(qualityPolicy));
      scope.generated.add(result);
      return verifyOutput(scope, result, schema);
    });
  };
  const rendered: Method = function (value) {
    const scope = scopedReceiver(this, "generator");
    if (!scope) return Reflect.apply(markdown, this, [value]);
    return guard(scope, () => {
      check(scope);
      if (scope.generator !== this) prdFail("PRD_SCOPE_CONFLICT", "PRD Markdown 使用了另一生成器");
      const result = verifyOutput(scope, value, schema);
      const original = Reflect.apply(markdown, this, [result]);
      if (typeof original !== "string") prdFail("PRD_VENDOR_UNAVAILABLE", "原始 PRD Markdown 不是文本");
      if (original.split("## 9. 受众定位").length !== 2) prdFail("PRD_VENDOR_UNAVAILABLE", "PRD 受众 Markdown 的受控章节发生变化");
      let labeled = original.replace("## 9. 受众定位", `## 9. 客户受众与模型细分推测\n\n`
        + `- **客户 Brief 权威受众原文**：${scope.contract!.ownerAudience ?? "客户未显式指定"}\n`
        + `- **以下年龄、性别与兴趣细分仅为模型推测**：不覆盖客户原文，不构成已核实市场事实，仍待本次 G4 独立评审。\n\n### 模型细分原文`);
      if (scope.contract!.cast.characters.length === 0) {
        const heading = "## 6. 角色系统\n\n无角色";
        const explicit = "## 6. 角色系统\n\n外观锚点与定妆照前置：不适用（cast.mode=none，与出镜角色合同一致）";
        if (labeled.split(heading).length !== 2) prdFail("PRD_VENDOR_UNAVAILABLE", "PRD 无角色 Markdown 的受控章节发生变化");
        labeled = labeled.replace(heading, explicit);
      }
      // This field is inapplicable when props exist; retain the canonical contract and hashes.
      const displayContract = { ...prdContractExecutionView(scope.authority, scope.contract!), scenes: scope.contract!.scenes.map(scene => {
        if (Array.isArray(scene.props) && scene.props.length > 0 && scene.noPropsReason === null) {
          const { noPropsReason: _inapplicableReason, ...displayScene } = scene;
          return displayScene;
        }
        return scene;
      }) };
      const delivery = requirementRecord(result.deliveryStandard, "G4 原生交付计划");
      const quality = scope.quality.get(result)!;
      const characters = requirementRecord(result.characterSystem, "G4 人物计划").characters as RequirementRecord[];
      const scenes = requirementRecord(result.scenePlan, "G4 场景计划").scenes as RequirementRecord[];
      const portraitReferenceSelection = scope.authority.portraitReferenceSelection;
      const selectedPortraitSource = scope.authority.portraitSources?.find(source => source.characterId === portraitReferenceSelection?.characterId);
      const planning = {
        status: "plan-only-not-executed",
        ...(frozenVisualPrdSegments(scope.authority)
          ? { audienceExecutionBoundary: "G3 原始受众推测保留于原件和合同的 modelAudienceHypothesis，供审计。动作、声音、字幕和商品限制只采用本次已审场景、冻结 Brief 与 G1，不能执行受众建议中的额外文本、动作或数字。" } : {}),
        ...(scope.authority.portraitSources?.length ? { verifiedPortraitSourcesAwaitingG5: scope.authority.portraitSources } : {}),
        ...(portraitReferenceSelection && selectedPortraitSource ? {
          portraitReferenceSelection: { ...portraitReferenceSelection,
            originalSha256InOrder: portraitReferenceSelection.angles.map(angle => selectedPortraitSource.originals[angle]!.sha256) },
        } : {}),
        characterPlans: characters.map(character => ({ characterId: character.characterId, name: character.name,
          portraitPath: character.portraitPath, consistencyRequirements: character.consistencyRequirements,
          source: character._workloomCharacterSource, selection: character._workloomCharacterSelection })),
        audioSpecification: result.audioSpecification,
        shotMapping: requirementRecord(result.scenePlan, "G4 原始场景计划").shotMapping,
        sceneVerificationPlans: scenes.map(scene => ({ sceneId: scene.sceneId, duration: scene.duration,
          visualRequirements: scene.visualRequirements, audioRequirements: scene.audioRequirements, dialogue: scene.dialogue })),
        continuityCheckpoints: delivery.continuityCheckpoints,
        revisionPolicy: delivery.revisionPolicy,
        qualityPolicy: { thresholds: quality.thresholds, fallbackTrigger: quality.fallbackTrigger,
          sourcePolicy: "本次原生 Agent4 制作阈值与 Agent5 原验收逐维保留较高要求；统一前原值在私有作用域保留",
          sourceHash: requirementHash({ production: quality.production, nativeAcceptance: quality.nativeAcceptance }) },
      };
      const report = labeled + `\n\n## 宿主本次权威生产与交付要求\n\n\`\`\`json\n${JSON.stringify({ profile: scope.authority.profile, source: result._workloomPrdAuthority, approvedRequirementContract: displayContract }, null, 2)}\n\`\`\`\n\n`
        + `上述来源绑定只说明本次输入一致；G1 不批准本 PRD，G4 与 G5 均须实际审核。空 portraitPath 是 G4 前正常状态，不能当成已完成定妆照。\n`
        + `\n## 本次 G4 执行与核验计划原文\n\n`
        + `以下仅展示本次模型和既有规则模块已经产生的字段；没有补写模型计划，也不证明图片、字幕、听音或成片已经验证。`
        + `qualityPolicy.thresholds 是已经同时写入制作约束与验收的当前执行值，fallbackTrigger 使用同一视觉值；来源摘要绑定本次统一前的原生规则来源。`
        + `角色原始 PNG 来源/复用与待 G5 核验条件见 consistencyRequirements；字幕安全区、持续起止、sidecar 一致性与原生声音原速保留的后续验证方法见原始视觉/声音要求。`
        + (scope.authority.portraitSources?.length ? `verifiedPortraitSourcesAwaitingG5 是宿主已核验的原始来源及既有用途回执。项目复制路径、当前 G5 审核和跨镜一致性结果均待实际执行，不能从这些证据推定通过。` : "")
        + `shotMapping原样展示实际数组；原生场景文字中的箭头仅为Markdown连接展示，不是shotBreakdownHint的原始枚举值。`
        + `缺失计划继续交本次 G4 判断，不能用此说明替代实际计划或批准。\n\n\`\`\`json\n${JSON.stringify(planning, null, 2)}\n\`\`\`\n`;
      if (portraitReferenceSelection) scope.portraitReviewArtifactHash = requirementHash(report);
      return report;
    });
  };
  const reviewed: Method = async function (content, value) {
    const scope = scopedReceiver(this, "system");
    if (!scope) return Reflect.apply(confirmPrd, this, [content, value]);
    return awaited(scope, async () => {
      check(scope);
      if (scope.system !== this || systems.get(this) !== scope) prdFail("PRD_SCOPE_CONFLICT", "G4 不是本次系统的 PRD");
      const result = verifyOutput(scope, value, schema), before = requirementHash(result);
      if (scope.authority.portraitReferenceSelection && (!scope.portraitReviewArtifactHash
        || requirementHash(content) !== scope.portraitReviewArtifactHash)) {
        prdFail("PRD_REVIEW_CHANGED", "G4 审核材料缺少同版本的冻结定妆参考选择");
      }
      verifyPrdPortraitSources(scope.authority.portraitSources);
      scope.g4Decision = "pending";
      const verdict = requirementRecord(await Reflect.apply(confirmPrd, this, [content, value]), "G4 实际确认结果");
      check(scope); verifyOutput(scope, value, schema);
      verifyPrdPortraitSources(scope.authority.portraitSources);
      if (requirementHash(result) !== before || verdict.prd !== value) prdFail("PRD_REVIEW_CHANGED", "G4 审核期间 PRD 实际内容发生变化");
      if (verdict.approved === true) {
        if (typeof content !== "string" || !content.trim()) prdFail("PRD_REVIEW_UNVERIFIED", "G4 批准缺少本次完整审核原文");
        scope.reviewedHash = before;
        scope.reviewedProjectionHash = reviewProjectionHash(result);
        scope.reviewedResult = result;
        scope.reviewedContent = content;
        scope.reviewedVerdict = structuredClone(Object.fromEntries(Object.entries(verdict).filter(([key]) => key !== "prd")));
        if (scope.approvedTheme) {
          scope.reviewedTheme = structuredClone(requirementRecord(scope.approvedTheme(), "本次 G2 已审主题"));
          scope.reviewedThemeHash = requirementHash(scope.reviewedTheme);
        }
        scope.g4Decision = "approved";
      } else scope.g4Decision = "rejected";
      return verdict;
    });
  };
  const patches: Array<[RequirementRecord, string, Method]> = [
    [vendorPrototype, "_confirmRequirementList", confirmed], [vendorPrototype, "_generateMinimalPRD", noMinimal],
    [vendorPrototype, "_confirmPRD", reviewed], [prdPrototype, "generate", generated], [prdPrototype, "generateMarkdown", rendered]
  ];
  if (nativeTruth) patches.push([vendorPrototype, "_runProductTruthCheckGate", checkedTruth]);
  for (const [owner, key, patched] of patches) {
    const original = Object.getOwnPropertyDescriptor(owner, key);
    if (!original || typeof original.value !== "function" || original.writable !== true || original.configurable !== true) {
      prdFail("PRD_VENDOR_UNAVAILABLE", `${key} 不是可恢复的原始自有方法`);
    }
    changes.push({ owner, key, original, patched });
  }
  const installed: Change[] = [];
  try {
    for (const change of changes) {
      Object.defineProperty(change.owner, change.key, { ...change.original, value: change.patched });
      installed.push(change);
    }
  } catch (error) {
    for (const change of installed.reverse()) Object.defineProperty(change.owner, change.key, change.original);
    throw error;
  }
  nativeIdentities.set(vendorPrototype, changes.map(({ owner, key, original: descriptor }) => ({ owner, key, descriptor })));
  active.set(vendorPrototype, { changes, schema, schemaHash });
  let disposed = false;
  return () => {
    if (disposed) return;
    assertPrdAuthorityBridge(vendorPrototype);
    for (const change of [...changes].reverse()) Object.defineProperty(change.owner, change.key, change.original);
    active.delete(vendorPrototype);
    disposed = true;
  };
}

export function installVendorPrdAuthorityBridge(constructor: { prototype: object }, entryPath: string): () => void {
  const lease = acquireVendorRequirementEntry(entryPath);
  try {
    if (lease.exports.HyperrealitySystem !== (constructor as unknown)) prdFail("PRD_BRIDGE_CHANGED", "PRD 桥与受控 vendor 入口 constructor 不一致");
    const require = createRequire(lease.identity.entryPath);
    const directory = path.join(path.dirname(lease.identity.entryPath), "engines/prd-generator");
    const { PRDGenerator } = require(path.join(directory, "prd-generator.js")) as { PRDGenerator: { prototype: RequirementRecord } };
    const { PRDSchema } = require(path.join(directory, "schema/prd-schema-v3.js")) as { PRDSchema: RequirementRecord };
    return installPrdAuthorityBridge(requirementRecord(constructor.prototype, "受控 vendor prototype"), PRDGenerator.prototype, PRDSchema);
  } finally { lease.release(); }
}

interface ProductionDependencies {
  systemPrototype: RequirementRecord;
  productionPrototype: RequirementRecord;
  phase1Prototype: RequirementRecord;
  sceneDesignPrototype?: RequirementRecord;
  refinerPrototype: RequirementRecord;
  costumePrototype: RequirementRecord;
  fieldGuardPrototype: RequirementRecord;
  fusionPrototype: RequirementRecord;
  qualityGatePrototype: RequirementRecord;
  deliveryGuardPrototype: RequirementRecord;
  semanticPrototype: RequirementRecord;
  fieldQualityPrototype?: RequirementRecord;
  ruleRepairPrototype?: RequirementRecord;
  ruleCheckPrototype?: RequirementRecord;
  llmRepairPrototype?: RequirementRecord;
  extractFieldRepairJson?: (content: string) => unknown;
  fieldConsistencyPrototype?: RequirementRecord;
  structuredAgent?: {
    prototype: RequirementRecord;
    limiter: { withLimit<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> };
  };
  standardizeShot: (shot: RequirementRecord) => RequirementRecord;
  validateShot: (shot: RequirementRecord) => RequirementRecord;
  fields: { p0: string[]; p1: string[]; p2: string[]; p3: string[]; common: string[] };
}
const productionOwners = new WeakMap<object, Scope>();
const productionInstalls = new WeakMap<object, { changes: Array<{ owner: RequirementRecord; key: string; original?: PropertyDescriptor; patched: Method }> }>();
const RETIRED_TITLES = ["title", "subtitle", "title_content", "subtitle_content", "title_animation", "title_font_design", "opening_audio_design"];
const RETIRED_TITLE_LABELS = ["【主标题内容】", "【副标题内容】", "【标题动画设计】", "【标题字体设计】", "【开场音频设计】"];

const FROZEN_FUSION_SPEECH_RULE = "禁止可辨识人声，包括对白、独白、口播、旁白、画外音及可辨识的背景话语。按原制作要求保留实际环境声和动作声。";

function bindFusionSpeechRule(prompt: string, native: string, scoped: string): string {
  const pieces = prompt.split(native);
  if (pieces.length !== 2) prdFail("PRD_VENDOR_UNAVAILABLE", "原生提示词声音策略模板边界已经变化");
  return pieces.join(scoped);
}

function fusionSpeechTemplate(value: unknown, boundary: string): [string, string] {
  if (typeof value !== "string") prdFail("PRD_VENDOR_UNAVAILABLE", "原生提示词不是文本");
  // Native creative and source context can contain any user-provided wording.
  // Bind only the suffix after the final pinned template boundary.
  const split = value.lastIndexOf(boundary);
  if (split < 0) prdFail("PRD_VENDOR_UNAVAILABLE", "原生提示词声音策略模板缺少边界");
  return [value.slice(0, split), value.slice(split)];
}

function productionScope(receiver: RequirementRecord, required = true): Scope | undefined {
  const scope = current(), bound = productionOwners.get(receiver) ?? systems.get(receiver);
  if (bound && bound !== scope) {
    const error = bound.fatal?.error ?? new Error("PRD_SCOPE_CONFLICT: 制作对象不能跨运行或在作用域结束后使用");
    bound.fatal ??= { error };
    return fatal(scope ?? bound, error);
  }
  if (!scope) return undefined;
  return guard(scope, () => {
    assertProductionAuthority(scope);
    if (scope.g4Decision !== "approved" || !scope.reviewedHash || !scope.contract) {
      if (required) prdFail("PRD_REVIEW_UNVERIFIED", "制作调用必须消费本次真实 G4 已审版本");
      return scope;
    }
    productionOwners.set(receiver, scope);
    return scope;
  });
}

/** Project only the current G4-reviewed exact selection into its G3 actor scenes. */
export function bindApprovedPrdPortraitSelection(prompts: RequirementRecord[]): Array<{ shotId: string; references: string[] }> | undefined {
  const scope = current(), selection = scope?.authority.portraitReferenceSelection;
  if (!scope || !selection) return undefined;
  return guard(scope, () => {
    assertProductionAuthority(scope);
    if (scope.g4Decision !== "approved" || !scope.contract || !scope.reviewedContent
      || requirementHash(scope.reviewedContent) !== scope.portraitReviewArtifactHash) {
      prdFail("PRD_REVIEW_UNVERIFIED", "定妆参考选择尚未进入本次批准的 G4 审核材料");
    }
    preparePrdPortraitReferenceSelection(selection, scope.authority.portraitSources ?? []);
    verifyPrdPortraitSources(scope.authority.portraitSources);
    const scenes = scope.contract.scenes;
    const shotIds = prompts.map(shot => String(shot.shotId ?? shot.shot_id ?? ""));
    if (shotIds.length !== scenes.length || shotIds.some((id, index) => id !== scenes[index]!.id)) {
      prdFail("PRD_SCENE_UNVERIFIED", "定妆参考绑定无法逐项对应本次已审 G3 场景");
    }
    const references = selection.angles.map(angle => `portrait-set://${selection.characterId}/v${selection.portraitVersion}/${angle}`);
    const placements = prompts.flatMap((shot, index) => scenes[index]!.actions.some(action => action.actorId === selection.characterId)
      ? [{ shot, shotId: shotIds[index]!, fields: requirementRecord(shot.fields, "G6 定妆参考镜头字段") }] : []);
    if (!placements.length) prdFail("PRD_CAST_UNVERIFIED", "已明确选择定妆参考，但本次原生场景没有该人物的实际动作");
    return placements.map(({ shot, shotId, fields }) => {
      shot.portraits = [...references];
      fields.portraits = [...references];
      return { shotId, references: [...references] };
    });
  });
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}
function retiredTitleIssue(value: string): boolean {
  if (value === "Opening shot missing: title" || value === "Opening shot missing: subtitle") return true;
  const missing = /^Opening exclusive fields missing: (.+) \(use OpeningTitleOptimizer to generate\)$/.exec(value)
    ?? /^Opening fields not yet generated \(will be filled by OpeningTitleOptimizer\): (.+)$/.exec(value);
  if (!missing) return false;
  const keys = missing[1]!.split(", ");
  return keys.length > 0 && new Set(keys).size === keys.length && keys.every(key => RETIRED_TITLES.slice(2).includes(key));
}

const FUSION_BLANK_JSON_CORRECTION = "## 本镜头最终 JSON 交付\n完成必要推理后，把完整结果写入最终答复，只输出一个合法 JSON 对象。严格保留上文原始镜头、镜头编号、全部字段、时长、事实与制作约束。按同一结构正确转义字符串中的引号和换行。不要输出 Markdown、解释、占位符或省略号。";
const SCENE_DESIGN_JSON_PRESENTATION = "## 本次场景设计 JSON 自检\n最终答复只输出一个非空的完整 JSON 对象。按原镜号和顺序写满 shots 数组，核对引号、逗号、括号和全部必需字段。";
const SCENE_DESIGN_BLANK_JSON_CORRECTION = "## 本次场景设计最终 JSON 交付\n完成必要推理后，把完整设计写入最终答复，只输出一个合法且非空的 JSON 对象。按原镜号和顺序逐镜返回全部字段，保留原动作、时长、人物、连续性与已审约束。不要输出 Markdown、解释、占位符或省略号。";

function exactFusionCorrection(value: unknown, schema: unknown, shotId: string): boolean {
  const object = (data: unknown) => data !== null && typeof data === "object" && !Array.isArray(data) ? data as RequirementRecord : undefined;
  const output = object(value), schemaShots = object(schema)?.shots;
  const shots = output?.shots;
  if (!output || Object.keys(output).length !== 1 || !Array.isArray(shots) || shots.length !== 1
    || !Array.isArray(schemaShots) || schemaShots.length !== 1) return false;
  const shot = object(shots[0]), template = object(schemaShots[0]);
  const fields = object(shot?.fields), fieldTemplate = object(template?.fields);
  if (!shot || Object.keys(shot).length !== 2 || shot.shotId !== shotId || template?.shotId !== shotId
    || !fields || !fieldTemplate) return false;
  const keys = Object.keys(fieldTemplate);
  return keys.length === 25 && Object.keys(fields).length === keys.length && keys.every(key => {
    if (!Object.hasOwn(fields, key)) return false;
    const text = fields[key];
    if (typeof text === "string") return text.trim().length > 0;
    const beats = key === "timeline" ? object(text)?.beats : undefined;
    return Array.isArray(beats) && beats.length > 0 && beats.every(beat => {
      const step = object(beat);
      return typeof step?.time === "number" && Number.isFinite(step.time)
        && typeof step.description === "string" && step.description.trim().length > 0;
    });
  });
}

/** Fixed vendor dependency seam; all policy comes from the private, approved run scope. */
export function installPrdProductionBridge(deps: ProductionDependencies): () => void {
  const { systemPrototype, productionPrototype, phase1Prototype, refinerPrototype, costumePrototype, fieldGuardPrototype, fusionPrototype,
    qualityGatePrototype, deliveryGuardPrototype, semanticPrototype } = deps;
  const standardizeShot = deps.standardizeShot, validateShot = deps.validateShot;
  if (productionInstalls.has(systemPrototype)) prdFail("PRD_BRIDGE_ACTIVE", "制作权威桥只能由共享引用计数安装");
  const fieldGroups = structuredClone(deps.fields);
  const fields = [...fieldGroups.p0, ...fieldGroups.p1, ...fieldGroups.p2, ...fieldGroups.p3];
  if (fields.length !== 25 || new Set(fields).size !== 25) prdFail("PRD_VENDOR_UNAVAILABLE", "制作字段合同不是原生 25 项");
  const changes: Array<{ owner: RequirementRecord; key: string; original?: PropertyDescriptor; patched: Method }> = [];
  let installed = false;
  const check = (scope: Scope) => guard(scope, () => {
    if (!installed || deps.standardizeShot !== standardizeShot || deps.validateShot !== validateShot
      || requirementHash(deps.fields) !== requirementHash(fieldGroups)
      || changes.some(change => !descriptorEqual(Object.getOwnPropertyDescriptor(change.owner, change.key),
        change.original ? { ...change.original, value: change.patched } : { value: change.patched, writable: true, configurable: true, enumerable: false }))) {
      prdFail("PRD_BRIDGE_CHANGED", "制作权威桥或原生字段合同身份已经变化");
    }
    assertProductionAuthority(scope);
  });
  const add = (owner: RequirementRecord, key: string, wrap: (original: Method) => Method, optional = false) => {
    const original = Object.getOwnPropertyDescriptor(owner, key);
    if ((!original && !optional) || (original && (typeof original.value !== "function" || !original.writable || !original.configurable))) {
      prdFail("PRD_VENDOR_UNAVAILABLE", `${key} 不是可恢复的原始制作方法`);
    }
    const base: Method = original?.value ?? function () { return true; };
    changes.push({ owner, key, original, patched: wrap(base) });
  };
  const frozenCuts = (scope: Scope) => scope.authority.metadata.brief === undefined ? undefined
    : frozenSegmentContract(requirementRecord(scope.authority.metadata.brief, "已审冻结分段 Brief"),
      scope.authority.profile.targetDuration);
  const frozenFieldLimits = { timeline: 300, transition: 50 } as const;
  type FrozenField = keyof typeof frozenFieldLimits;
  const frozenField = (value: unknown): value is FrozenField =>
    typeof value === "string" && Object.hasOwn(frozenFieldLimits, value);
  const frozenFieldScope = (receiver: RequirementRecord, shotValue: unknown): Scope | undefined => {
    const scope = productionScope(receiver, false);
    if (!scope || scope.g4Decision !== "approved" || scope.authority.profile.speechPolicy !== "none"
      || !frozenCuts(scope) || !shotValue || typeof shotValue !== "object" || Array.isArray(shotValue)) return undefined;
    const shot = shotValue as RequirementRecord;
    const id = shot.shotId ?? shot.shot_id;
    if (typeof id !== "string"
      || (Object.hasOwn(shot, "shotId") && Object.hasOwn(shot, "shot_id") && shot.shotId !== shot.shot_id)) return undefined;
    return scope.contract?.scenes.some(scene => scene.id === id && scene.duration === shot.duration) ? scope : undefined;
  };
  const coveredSuit = (value: unknown): value is string => typeof value === "string" && /全覆[^，。；\n]{0,30}赛车服/u.test(value);
  const mentionsWardrobe = (text: string, id: string) => text.match(/[A-Za-z0-9][A-Za-z0-9_-]*/gu)?.includes(id) === true;
  const approvedSuit = (scope: Scope, shot: RequirementRecord) => {
    const id = shot.shotId ?? shot.shot_id;
    const cuts = frozenCuts(scope), contract = scope.contract;
    const scene = contract?.scenes.find(scene => scene.id === id);
    if (!cuts || !contract || !scene || !scope.reviewedResult) return undefined;
    const actors = contract.cast.characters.filter(actor => scene.actions.some(action => action.actorId === actor.id));
    if (actors.length !== 1) return undefined;
    const actor = actors[0]!;
    const garments = Array.isArray(actor.wardrobe) ? actor.wardrobe : [];
    const ownerText = cuts.intervals.flatMap(interval => splitShotAssertions(interval.brief).positive.split("；"))
      .filter(clause => clause.includes("同一套") && coveredSuit(clause));
    const chosen = garments.filter(({ id, detail }) => typeof id === "string" && coveredSuit(detail)
      && ownerText.some(clause => mentionsWardrobe(clause, id)));
    if (chosen.length !== 1 || typeof chosen[0]!.id !== "string") return undefined;
    const wardrobeId = chosen[0]!.id;
    const plan = requirementRecord(scope.reviewedResult.characterSystem, "已审服装人物").characters as RequirementRecord[];
    const item = plan.find(item => item.characterId === actor.id && item.name === actor.name);
    const costume = item?.costume;
    if (!coveredSuit(costume) || !splitShotAssertions(costume).positive.split("；")
      .some(clause => coveredSuit(clause) && mentionsWardrobe(clause, wardrobeId))) return undefined;
    return scene;
  };
  const costumeLayerIssue = (value: unknown): boolean => {
    const issue = requirementRecord(value, "原生服装结构诊断");
    return issue.fieldEn === "costume" && issue.issueType === "incomplete"
      && typeof issue.description === "string" && /^服装字段层次不足：当前覆盖 [012]\/4 项（外套\/内搭\/下装\/鞋履）$/u.test(issue.description);
  };
  if (deps.ruleCheckPrototype) add(deps.ruleCheckPrototype, "_checkStructure", original => function (shot, ...args) {
    const scope = frozenFieldScope(this, shot);
    const current = shot as RequirementRecord;
    if (!scope || !coveredSuit(current.costume) || !approvedSuit(scope, current)) return Reflect.apply(original, this, [shot, ...args]);
    return guard(scope, () => {
      const issues = Reflect.apply(original, this, [shot, ...args]);
      if (!Array.isArray(issues)) prdFail("PRD_VENDOR_UNAVAILABLE", "原生结构检查缺少诊断列表");
      return issues.filter(issue => !costumeLayerIssue(issue));
    });
  });
  const nativeOverflow = (value: unknown, shot: RequirementRecord) => {
    const issue = requirementRecord(value, "原生字段超长诊断"), field = issue.fieldEn;
    if (!frozenField(field) || issue.issueType !== "over_length") return false;
    const text = shot[field];
    return typeof text === "string" && text.length > frozenFieldLimits[field];
  };
  if (deps.ruleCheckPrototype) add(deps.ruleCheckPrototype, "_checkLength", original => function (shot, ...args) {
    const scope = frozenFieldScope(this, shot);
    if (!scope) return Reflect.apply(original, this, [shot, ...args]);
    return guard(scope, () => {
      const issues = Reflect.apply(original, this, [shot, ...args]);
      if (!Array.isArray(issues)) prdFail("PRD_VENDOR_UNAVAILABLE", "原生字段长度检查缺少诊断列表");
      // The assembled native cap still applies at G6. Do not ask the
      // preliminary field repairer to cut these two authored fields in half.
      return issues.filter(issue => !nativeOverflow(issue, shot as RequirementRecord));
    });
  });
  const extractFieldRepairJson = deps.extractFieldRepairJson;
  if (deps.llmRepairPrototype && extractFieldRepairJson) add(deps.llmRepairPrototype, "_repairBatch", original => async function (shot, issues, fields, ...args) {
    const scope = frozenFieldScope(this, shot);
    if (!scope || !Array.isArray(fields) || !fields.some(frozenField)) return Reflect.apply(original, this, [shot, issues, fields, ...args]);
    return awaited(scope, async () => {
      const engine = requirementRecord(this.llm, "原生字段修复模型");
      const reason = method(engine, "reason"), truncate = method(this, "_smartTruncate");
      const engineView = Object.create(engine) as RequirementRecord, receiver = Object.create(this) as RequirementRecord;
      const preservedValues = new Map<string, number>();
      engineView.reason = async (...callArgs: unknown[]) => {
        const reply = await Reflect.apply(reason, engine, callArgs);
        if (!reply || typeof reply !== "object" || Array.isArray(reply)) return reply;
        const envelope = reply as RequirementRecord;
        if (envelope.success !== true || typeof envelope.content !== "string") return reply;
        const parsed = requirementRecord(extractFieldRepairJson(envelope.content), "原生字段修复 JSON 提取");
        if (parsed.ok !== true || !parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) return reply;
        const data = (parsed.data as RequirementRecord).repaired_fields;
        if (!data || typeof data !== "object" || Array.isArray(data)) return reply;
        const entries = Object.entries(data);
        for (const [field, text] of entries) {
          if (frozenField(field) && fields.includes(field) && typeof text === "string" && text.trim()
            && entries.filter(([, candidate]) => candidate === text).length === 1) {
            preservedValues.set(text, frozenFieldLimits[field]);
          }
        }
        return reply;
      };
      receiver.llm = engineView;
      receiver._smartTruncate = (text: unknown, limit: unknown) => {
        const matchedLimit = typeof text === "string" ? preservedValues.get(text) : undefined;
        return matchedLimit !== undefined && matchedLimit === limit ? text : Reflect.apply(truncate, receiver, [text, limit]);
      };
      return Reflect.apply(original, receiver, [shot, issues, fields, ...args]);
    });
  });
  if (deps.ruleRepairPrototype) {
    const ruleRepair = deps.ruleRepairPrototype;
    add(ruleRepair, "repair", original => function (shot, report, ...args) {
      const scope = frozenFieldScope(this, shot);
      if (!scope) return Reflect.apply(original, this, [shot, report, ...args]);
      return guard(scope, () => {
        const native = requirementRecord(report, "原生字段修复诊断");
        if (!Array.isArray(native.issues)) prdFail("PRD_VENDOR_UNAVAILABLE", "原生字段修复缺少诊断列表");
        const issues = native.issues.filter(issue => !nativeOverflow(issue, shot as RequirementRecord));
        return Reflect.apply(original, this, [shot, { ...native, issues }, ...args]);
      });
    });
    add(ruleRepair, "_prdAnchorPhrase", original => function (...args) {
      const scope = productionScope(this);
      if (!scope || scope.authority.metadata.brief === undefined) return Reflect.apply(original, this, args);
      return guard(scope, () => {
        check(scope);
        // The vendor's style prefix quotes the first scene. Frozen shots
        // already carry their own approved source, so skip only this rewrite.
        return frozenCuts(scope) ? "" : Reflect.apply(original, this, args);
      });
    });
    for (const key of ["_generateDefault", "_completeElements"]) {
      add(ruleRepair, key, original => function (field, ...args) {
        if (key === "_completeElements" && frozenField(field) && frozenFieldScope(this, args[3])) return null;
        if (field === "costume") {
          const shot = key === "_completeElements" ? args[3] : args[1];
          const scope = frozenFieldScope(this, shot);
          if (scope && approvedSuit(scope, shot as RequirementRecord) && (key === "_generateDefault"
            || (coveredSuit(args[0]) && costumeLayerIssue(args[1])))) return null;
        }
        const scope = field === "camera_movement" ? productionScope(this) : undefined;
        if (!scope) return Reflect.apply(original, this, [field, ...args]);
        return guard(scope, () => {
          check(scope);
          // Native camera fillers invent speed, cut points and a freeze. Keep
          // the issue open for the native model repair and its recheck.
          return frozenCuts(scope) ? null : Reflect.apply(original, this, [field, ...args]);
        });
      });
    }
  }
  if (deps.fieldQualityPrototype) add(deps.fieldQualityPrototype, "run", original => async function (shotValue, ...args) {
    const scope = productionScope(this);
    if (!scope?.authority.portraitSources?.length) return Reflect.apply(original, this, [shotValue, ...args]);
    return awaited(scope, async () => {
      check(scope);
      const shot = requirementRecord(shotValue, "原始定妆引用镜头");
      const fields = requirementRecord(shot.fields, "原始定妆引用字段");
      const portraits = structuredClone(fields.portraits ?? shot.portraits);
      const result = requirementRecord(await Reflect.apply(original, this, [shotValue, ...args]), "原生字段修复结果");
      const final = requirementRecord(result.finalShot, "修复后镜头");
      const finalFields = requirementRecord(final.fields, "修复后镜头字段");
      // The native field-quality rule overwrites all format errors with a
      // guessed v1 path. Identity selection remains the earlier shot input.
      if (portraits === undefined) {
        delete final.portraits;
        delete finalFields.portraits;
      } else {
        final.portraits = structuredClone(portraits);
        finalFields.portraits = portraits;
      }
      check(scope);
      return result;
    });
  });
  const structuredAgent = deps.structuredAgent;
  // Only the pinned native single-shot entry owns this marker. Fill and
  // semantic refinement share the receiver but cannot inherit another slot.
  const primaryFusion = new AsyncLocalStorage<{ scope: Scope; receiver: RequirementRecord; shotId: string; started: boolean }>();
  const blankCorrectionUsed = new WeakSet<Scope>(); // one blank correction per approved run
  const sceneDesignPrototype = deps.sceneDesignPrototype;
  const sceneDesignValidator = sceneDesignPrototype && Object.getOwnPropertyDescriptor(sceneDesignPrototype, "_validateSchema");
  const primarySceneDesign = new AsyncLocalStorage<{
    scope: Scope; receiver: RequirementRecord; shotIds: string[]; started: boolean;
  }>();
  const sceneDesignBlankCorrectionUsed = new WeakSet<Scope>();
  if (structuredAgent && sceneDesignPrototype) {
    if (typeof sceneDesignValidator?.value !== "function") prdFail("PRD_VENDOR_UNAVAILABLE", "原生场景设计校验器不可用");
    add(sceneDesignPrototype, "process", original => function (shots, ...args) {
      const scope = productionScope(this, false);
      const run = () => Reflect.apply(original, this, [shots, ...args]);
      if (!scope || scope.g4Decision !== "approved" || scope.authority.profile.speechPolicy !== "none"
        || Object.getPrototypeOf(this) !== sceneDesignPrototype || !Array.isArray(shots)) return run();
      return guard(scope, () => {
        check(scope);
        const cuts = frozenCuts(scope), scenes = scope.contract?.scenes;
        if (!cuts || !scenes || scenes.length !== cuts.count || shots.length !== scenes.length
          || !shots.every((shot, i) => shot?.shotId === scenes[i]!.id && shot.duration === scenes[i]!.duration
            && shot.duration === cuts.secondsPerSegment)) return run();
        return primarySceneDesign.run({ scope, receiver: this, shotIds: scenes.map(scene => scene.id), started: false }, run);
      });
    });
  }
  if (structuredAgent) add(fusionPrototype, "_fuseSingleShot", original => function (shotValue, ...args) {
    const scope = productionScope(this, false);
    const run = () => Reflect.apply(original, this, [shotValue, ...args]);
    if (!scope || scope.g4Decision !== "approved" || scope.authority.profile.speechPolicy !== "none"
      || Object.getPrototypeOf(this) !== fusionPrototype) return run();
    return guard(scope, () => {
      check(scope);
      const cuts = frozenCuts(scope);
      if (!cuts) return run();
      const shot = requirementRecord(shotValue, "冻结合同原生融合镜头");
      const approved = scope.contract?.scenes.find(scene => scene.id === shot.shotId);
      if (!approved || shot.duration !== cuts.secondsPerSegment || approved.duration !== shot.duration) return run();
      return primaryFusion.run({ scope, receiver: this, shotId: approved.id, started: false }, run);
    });
  });
  if (structuredAgent) add(structuredAgent.prototype, "_callLLM", original => async function (prompt, schema, fallback, optionsValue = {}) {
    const scope = productionScope(this, false);
    if (!scope || scope.g4Decision !== "approved") {
      return Reflect.apply(original, this, [prompt, schema, fallback, optionsValue]);
    }
    return awaited(scope, async () => {
      check(scope);
      const name = typeof this.name === "string" ? this.name : "ProductionAgent";
      if (!this.enabled) prdFail("PRD_PRODUCTION_MODEL_DISABLED", `${name} 在已审批的正式制作中停用`);
      // The vendor system retains this run's injected engine. Its standalone
      // agents may construct an engine through a process-global redirect.
      const engine = scope.system?.llmEngine;
      if (!(engine instanceof WorkloomLLMEngine) || !WorkloomLLMEngine.supportsStructuredReviewProof(engine)) {
        prdFail("PRD_PRODUCTION_MODEL_UNVERIFIED", "正式制作缺少本次受控宿主模型");
      }
      const systemPrompt = Reflect.apply(method(this, "_getSystemPrompt"), this, []);
      if (typeof prompt !== "string" || typeof systemPrompt !== "string") {
        prdFail("PRD_PRODUCTION_MODEL_UNVERIFIED", `${name} 缺少完整原生提示词`);
      }
      const validate = method(this, "_validateSchema");
      const options = requirementRecord(optionsValue, "制作模型调用配置");
      const sceneCall = primarySceneDesign.getStore();
      const sceneDesign = sceneCall?.scope === scope && sceneCall.receiver === this && !sceneCall.started ? sceneCall : undefined;
      if (sceneDesign) sceneDesign.started = true;
      const schemaDigest = sceneDesign ? requirementHash(schema) : undefined;
      const fullPrompt = `${systemPrompt}\n\n${prompt}${sceneDesign ? "\n\n" + SCENE_DESIGN_JSON_PRESENTATION : ""}`;
      const fusion = primaryFusion.getStore();
      const primary = fusion?.scope === scope && fusion.receiver === this && !fusion.started ? fusion : undefined;
      if (primary) primary.started = true;
      const now = Date.now();
      const configuredTimeout = Number(this.llmTimeout);
      const globalDeadline = typeof this._globalDeadline === "number" ? this._globalDeadline : now + configuredTimeout;
      const deadline = options.shotBudget ? Math.min(globalDeadline, now + Number(options.shotBudget)) : globalDeadline;
      const ceiling = deadline - now;
      const requestedTimeout = Math.min(Number(options.timeoutMs || configuredTimeout), ceiling);
      const callTimeout = options.fastMode && typeof options.fastTimeoutMs === "number"
        ? Math.min(requestedTimeout, Math.max(options.fastTimeoutMs, ceiling * 0.3))
        : requestedTimeout;
      const sceneDeadline = Math.min(deadline, now + callTimeout);
      const maxAttempts = Number(options.maxRetries ?? this.llmMaxRetries);
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
        prdFail("PRD_PRODUCTION_MODEL_UNVERIFIED", `${name} 未获制作调用次数`);
      }
      const remaining = (limit = deadline) => {
        const ms = Math.floor(Math.min(callTimeout, limit - Date.now()));
        if (!Number.isFinite(ms) || ms < 5_000) prdFail("PRD_PRODUCTION_MODEL_DEADLINE", `${name} 制作调用剩余时间不足`);
        return ms;
      };
      const checkEngine = () => {
        check(scope);
        if (scope.system?.llmEngine !== engine || !WorkloomLLMEngine.supportsStructuredReviewProof(engine)) {
          prdFail("PRD_PRODUCTION_MODEL_UNVERIFIED", `${name} 宿主模型身份已变化`);
        }
        if (sceneDesign && (Object.getPrototypeOf(this) !== sceneDesignPrototype || this._validateSchema !== validate
          || !sceneDesignPrototype || !sceneDesignValidator || validate !== sceneDesignValidator.value
          || !descriptorEqual(Object.getOwnPropertyDescriptor(sceneDesignPrototype, "_validateSchema"), sceneDesignValidator)
          || requirementHash(schema) !== schemaDigest)) {
          prdFail("PRD_PRODUCTION_MODEL_UNVERIFIED", "原生场景设计校验器或本次镜头结构已变化");
        }
      };
      const invoke = (text: string, originalBlank?: LLMReasonResult, limit = deadline) => structuredAgent.limiter.withLimit(async () => {
        checkEngine();
        if (originalBlank && !nativeBlankJsonRouteCurrent(engine, originalBlank)) {
          prdFail("PRD_PRODUCTION_MODEL_UNVERIFIED", `${name} 空 JSON 修正的原生模型路径已变化`);
        }
        const timeoutMs = remaining(limit);
        const response = await engine.reasonStructured(text, schema, { timeoutMs, signal: AbortSignal.timeout(timeoutMs) });
        checkEngine();
        return response;
      }, remaining(limit));
      const valid = (value: unknown) => requirementRecord(Reflect.apply(validate, this, [value, schema]), "原生制作响应校验").valid === true;
      const first = await invoke(fullPrompt);
      const completed = nativeReasonCompleted(first);
      const blank = (primary || sceneDesign) && options.critical === true && !first.success && !completed && nativeReasonBlankJson(first);
      const sceneBlank = blank ? sceneDesign : undefined;
      if (!completed && !blank) {
        prdFail("PRD_PRODUCTION_MODEL_UNVERIFIED", `${name} 未取得已完成且有计量的原生模型回复`);
      }
      const strictObject = (answer: LLMReasonResult) => {
        const parsed = typeof answer.content === "string" ? parseStrictSceneJsonObject(answer.content) : undefined;
        return parsed !== undefined && requirementHash(parsed) === requirementHash(answer.data);
      };
      if (first.success && valid(first.data)) {
        if (sceneDesign && !strictObject(first)) prdFail("PRD_PRODUCTION_MODEL_UNVERIFIED", "原生场景设计正文未通过严格 JSON 校验");
        return { result: first.data, degraded: false, degradeReason: null, attempts: 1 };
      }
      const used = sceneBlank ? sceneDesignBlankCorrectionUsed : blankCorrectionUsed;
      if (maxAttempts < 2 || (blank ? used.has(scope) : !first.success && nativeReasonFailure(first) !== "json-syntax")) {
        prdFail("PRD_PRODUCTION_MODEL_UNVERIFIED", `${name} 的原生制作响应未通过校验`);
      }
      if (blank) used.add(scope);
      const correction = first.success ? "原回复缺失或不符合目标字段结构。" : "原回复不是合法 JSON。";
      const instruction = sceneBlank ? SCENE_DESIGN_BLANK_JSON_CORRECTION : blank ? FUSION_BLANK_JSON_CORRECTION
        : `## 完整结构修正\n${correction}重新按上文完整任务和同一目标结构生成一次完整 JSON。保留每个镜头、事实与约束；不要引用原错误内容，不要缩减任务或字段。`;
      const second = await invoke(`${fullPrompt}\n\n${instruction}`, blank ? first : undefined, sceneBlank ? sceneDeadline : deadline);
      if (!nativeReasonCompleted(second) || !second.success || !valid(second.data)
        || (sceneDesign && !sceneBlank && !strictObject(second))
        || (blank && primary && (!nativeBlankJsonCorrected(first, second) || !exactFusionCorrection(second.data, schema, primary.shotId)))) {
        prdFail("PRD_PRODUCTION_MODEL_UNVERIFIED", `${name} 的一次完整结构修正未通过校验`);
      }
      if (sceneBlank) {
        const correctedShots = (second.data as { shots: Array<{ shotId: string }> }).shots;
        if (Date.now() >= sceneDeadline || !nativeBlankJsonObjectCorrected(first, second)
          || correctedShots.some((shot, i) => shot.shotId !== sceneBlank.shotIds[i])) {
          prdFail("PRD_PRODUCTION_MODEL_UNVERIFIED", "场景设计的原生空 JSON 修正未通过本次镜头合同");
        }
      }
      return { result: second.data, degraded: false, degradeReason: null, attempts: 2 };
    });
  });
  const inspect = (shotsValue: unknown, context: unknown, noTitle: boolean, bindLayer2Portraits = false) => {
    if (!Array.isArray(shotsValue) || shotsValue.length === 0) prdFail("PRD_PRODUCTION_INVALID", "制作镜头必须为非空数组");
    const shots = (shotsValue as unknown[]).map(value => {
      const raw = requirementRecord(value, "当前制作镜头"), normalized = standardizeShot(raw);
      // Standardization may omit fields/unknown attributes or lose a textual timeline.
      // Keep genuine source values and additional data; never synthesize content defaults.
      const shot = { ...structuredClone(raw), ...normalized };
      const rawFields = raw.fields && typeof raw.fields === "object" && !Array.isArray(raw.fields) ? raw.fields as RequirementRecord : {};
      for (const key of [...fields, ...fieldGroups.common]) {
        if (!hasValue(shot[key])) {
          const camel = key.replace(/_([a-z])/g, (_, character: string) => character.toUpperCase());
          const candidates = [rawFields[key], rawFields[camel], raw[key], raw[camel]];
          const genuine = candidates.find(hasValue);
          if (genuine !== undefined) shot[key] = structuredClone(genuine);
        }
      }
      if (Object.hasOwn(raw, "fields")) shot.fields = structuredClone(raw.fields);
      if (typeof raw.prompt === "string") shot.prompt = raw.prompt;
      if (typeof raw.sceneType === "string") shot.sceneType = raw.sceneType;
      if (bindLayer2Portraits) {
        const rawId = raw.shotId ?? raw.shot_id;
        if (typeof rawId !== "string" || rawId !== shot.shotId
          || (Object.hasOwn(raw, "shotId") && Object.hasOwn(raw, "shot_id") && raw.shotId !== raw.shot_id)) {
          prdFail("PRD_SCENE_UNVERIFIED", "字段标准化改变了本次冻结镜头的身份，或原始镜号存在冲突");
        }
      }
      shot._context = context;
      return shot;
    });
    // The complete Layer2 shot array is the first strict field check. Apply
    // the approved candidates after vendor normalization, which can duplicate
    // references. G6 still binds the separate prompt array and verifies copies.
    if (bindLayer2Portraits) bindApprovedPrdPortraitSelection(shots);
    const details = shots.map(shot => {
      const native = validateShot(shot);
      const missing = fields.filter(key => !(key === "dialogue" && (shot.dialogueFree === true
        || (Array.isArray(shot.dialogueBlocks) && shot.dialogueBlocks.length > 0))) && !hasValue(shot[key]));
      const explicitDialogue = !missing.includes("dialogue") && !hasValue(shot.dialogue);
      const filter = (values: unknown): string[] => {
        if (!Array.isArray(values) || values.some(value => typeof value !== "string")) prdFail("PRD_VENDOR_UNAVAILABLE", "原生字段校验结果结构已变化");
        return (values as string[]).filter(value => !(noTitle && retiredTitleIssue(value))
          && !(explicitDialogue && value === "P0 Missing: dialogue"));
      };
      const errors = filter(native.errors), warnings = filter(native.warnings);
      // The native final-export summary can include an explicitly inapplicable dialogue.
      // Recompute this exact summary without changing any other native validation result.
      for (let index = errors.length - 1; index >= 0; index--) {
        const match = /^Final-Export strict: \d+ fields empty: (.+)$/.exec(errors[index]!);
        if (match && explicitDialogue) {
          const remaining = match[1]!.split(", ").filter(key => key !== "dialogue");
          if (remaining.length) errors[index] = `Final-Export strict: ${remaining.length} fields empty: ${remaining.join(", ")}`;
          else errors.splice(index, 1);
        }
      }
      if (missing.length) errors.push(`Production 25 fields missing: ${missing.join(", ")}`);
      if (!hasValue(shot.shotId) || !hasValue(shot.sceneType) || !hasValue(shot.prompt)) errors.push("Production common identity/prompt missing");
      const actualPrompt = shot.prompt;
      if (noTitle && typeof actualPrompt === "string" && RETIRED_TITLE_LABELS.some(label => actualPrompt.includes(label))) {
        errors.push("Retired title fields leaked into generation prompt");
      }
      return { ...native, passed: errors.length === 0, errors, warnings, missingSpecFields: missing,
        applicableFields: fields.length, presentFields: fields.length - missing.length,
        ...(noTitle ? { applicability: Object.fromEntries(RETIRED_TITLES.map(key => [key, "not_applicable"])) } : {}) };
    });
    const report = { passed: details.every(detail => detail.passed),
      errors: details.flatMap((detail, index) => detail.errors.map(error => `[${String(shots[index]!.shotId)}] ${error}`)),
      warnings: details.flatMap((detail, index) => detail.warnings.map(warning => `[${String(shots[index]!.shotId)}] ${warning}`)),
      details, summary: { totalShots: shots.length, fixedShots: 0, applicableFieldsPerShot: fields.length } };
    return { shots, report };
  };
  add(systemPrototype, "create", original => async function (...args) {
    const scope = productionScope(this, false);
    if (!scope) return Reflect.apply(original, this, args);
    productionOwners.set(this, scope);
    return awaited(scope, async () => { check(scope); const result = await Reflect.apply(original, this, args); check(scope); return result; });
  });
  add(systemPrototype, "_shouldUseTitleCard", original => function (...args) {
    const scope = productionScope(this);
    if (!scope) return Reflect.apply(original, this, args);
    return guard(scope, () => { check(scope); return scope.authority.profile.titleCard !== false; });
  }, true);
  add(systemPrototype, "_optimizeOpeningTitle", original => async function (...args) {
    const scope = productionScope(this);
    if (!scope) return Reflect.apply(original, this, args);
    return awaited(scope, () => { check(scope); return scope.authority.profile.titleCard === false ? undefined : Reflect.apply(original, this, args); });
  });
  add(phase1Prototype, "_shouldGenerateOpening", original => function (...args) {
    const scope = productionScope(this);
    if (!scope) return Reflect.apply(original, this, args);
    return guard(scope, () => { check(scope); return scope.authority.profile.titleCard === false ? false : Reflect.apply(original, this, args); });
  });
  add(qualityGatePrototype, "run", original => function (promptsValue, prdValue = null, ...args) {
    const scope = productionScope(this);
    if (!scope || scope.authority.profile.titleCard !== false) return Reflect.apply(original, this, [promptsValue, prdValue, ...args]);
    return guard(scope, () => {
      check(scope);
      const result = requirementRecord(Reflect.apply(original, this, [promptsValue, prdValue, ...args]), "原生质量门报告");
      if (!Array.isArray(result.checks)) prdFail("PRD_VENDOR_UNAVAILABLE", "原生质量门缺少逐镜检查");
      const prd = prdValue === null ? {} : requirementRecord(prdValue, "质量门 PRD");
      const delivery = prd.deliveryStandard && typeof prd.deliveryStandard === "object" ? prd.deliveryStandard as RequirementRecord : {};
      const thresholdValue = delivery.acceptanceCriteria || prd.acceptanceCriteria;
      const threshold = thresholdValue ? requirementRecord(thresholdValue, "原生质量门阈值") : undefined;
      const scoreThreshold = threshold ? Math.round((Number(threshold.visual || 0.75) + Number(threshold.narrative || 0.75)) / 2 * 100) : 30;
      const checks = result.checks.map(value => {
        const item = requirementRecord(value, "原生逐镜质量结果");
        // The pinned native gate requires these two title-package properties only
        // for S00. Retire precisely those checks; preserve every content check,
        // length/placeholder result and the original PRD score threshold.
        if (item.shotId !== "S00") return item;
        const passed = ["hasScene", "hasMood", "hasCamera", "hasLighting", "hasAction", "hasTimeline", "hasBackgroundSound", "hasPrompt", "withinLimit"]
          .every(key => item[key] === true) && item.hasPlaceholder === false && Number(item.overallScore) >= scoreThreshold;
        return { ...item, hasAudioLayer: null, hasTitleOverlay: null, passed,
          applicability: { audioLayer: "not_applicable", titleOverlay: "not_applicable" } };
      });
      return { ...result, checks, passed: checks.every(item => item.passed === true), passedCount: checks.filter(item => item.passed === true).length,
        failedFields: checks.filter(item => item.passed !== true).map(item => ({ shotId: item.shotId, overallScore: item.overallScore,
          failed: Object.entries(item).filter(([key, value]) => key.startsWith("has") && value === false).map(([key]) => key) })) };
    });
  });
  add(deliveryGuardPrototype, "verify", original => function (prompt, shot = {}, ...args) {
    const scope = productionScope(this);
    if (!scope) return Reflect.apply(original, this, [prompt, shot, ...args]);
    return guard(scope, () => {
      check(scope);
      const result = requirementRecord(Reflect.apply(original, this, [prompt, shot, ...args]), "原生提示词交付检查");
      if (!Array.isArray(result.issues) || result.issues.some(issue => typeof issue !== "string")) prdFail("PRD_VENDOR_UNAVAILABLE", "交付检查缺少原始错误明细");
      const noTitle = scope.authority.profile.titleCard === false;
      const retired = new Set(noTitle ? RETIRED_TITLE_LABELS.map(label => `缺片头专属字段:${label.slice(1, -1)}`) : []);
      // Keep the native utterance checks unless this whole field is a negative declaration
      // and the structured source does not contain any spoken lines.
      const body = typeof prompt === "string" && typeof this._fieldBody === "function"
        ? Reflect.apply(method(this, "_fieldBody"), this, [prompt.replace(/^\s*\d{1,2}\.\s*(?=【)/gm, ""), "台词"])
        : "";
      const noSpeech = isNoSpeechDeclaration(body) && typeof this._shotExpectsDialogue === "function"
        && Reflect.apply(method(this, "_shotExpectsDialogue"), this, [shot]) === false;
      const issues = (result.issues as string[]).filter(issue => !retired.has(issue)
        && !(noSpeech && (issue === "数据层无台词但出现【台词】字段（疑似虚构）" || issue.startsWith("台词格式不规范:"))));
      if (noTitle && typeof prompt === "string" && RETIRED_TITLE_LABELS.some(label => prompt.includes(label))) {
        issues.push("生成侧重新出现已退休片头标题字段");
      }
      return { ...result, pass: issues.length === 0, issues, ...(noTitle ? { expectedMin: fields.length,
        applicability: Object.fromEntries(RETIRED_TITLES.map(key => [key, "not_applicable"])) } : {}) };
    });
  });
  if (deps.fieldConsistencyPrototype) {
    add(deps.fieldConsistencyPrototype, "_checkDialogueAudio", original => function (fieldsValue, ...args) {
      const scope = productionScope(this);
      if (!scope) return Reflect.apply(original, this, [fieldsValue, ...args]);
      return guard(scope, () => {
        check(scope);
        const shotFields = requirementRecord(fieldsValue, "跨字段台词及音频一致性");
        return isNoSpeechDeclaration(shotFields.dialogue) ? [] : Reflect.apply(original, this, [fieldsValue, ...args]);
      });
    });
    add(fusionPrototype, "_getSystemPrompt", original => function (...args) {
      const scope = productionScope(this);
      if (scope?.authority.profile.speechPolicy !== "none") return Reflect.apply(original, this, args);
      return guard(scope, () => {
        check(scope);
        const prompt = Reflect.apply(original, this, args);
        if (typeof prompt !== "string") prdFail("PRD_VENDOR_UNAVAILABLE", "PromptFusion 系统提示词不是文本");
        const fields = bindFusionSpeechRule(prompt, "\n15. dialogue: 角色台词(纯台词,不要旁白)\n",
          '\n15. dialogue: 固定输出"无台词"。\n');
        return bindFusionSpeechRule(fields, "\n- 台词必须是角色直接对话,不要画外音/旁白\n",
          `\n- ${FROZEN_FUSION_SPEECH_RULE}\n`);
      });
    });
    add(fusionPrototype, "_buildBatchPrompt", original => function (...args) {
      const scope = productionScope(this);
      if (!scope) return Reflect.apply(original, this, args);
      return guard(scope, () => {
        check(scope);
        const { aspectRatio, resolution, frameRate, speechPolicy } = scope.authority.profile;
        if (speechPolicy === "none") assertNoSpokenPromptPackage(args[0], "PromptFusion.batch");
        let prompt = Reflect.apply(original, this, args);
        if (aspectRatio && resolution && frameRate) {
          const native = 'constraint 固定为"16:9画幅，4K分辨率，24fps，MP4格式"(竖屏项目为9:16)';
          if (typeof prompt !== "string" || prompt.split(native).length !== 2) {
            prdFail("PRD_VENDOR_UNAVAILABLE", "PromptFusion 技术规格模板边界已经变化");
          }
          prompt = prompt.replace(native, `constraint 固定为"${aspectRatio}画幅，${resolution}分辨率，${frameRate}fps，MP4格式"（帧率为最终交付要求）`);
        }
        if (speechPolicy !== "none") return prompt;
        const [source, template] = fusionSpeechTemplate(prompt, "\n【字段最低字符数 - 硬性要求");
        const min = bindFusionSpeechRule(template, "\n 其余字段 ≥ 30 字符\n",
          '\n dialogue 固定为"无台词"，该字段不计入字符下限；其余字段 ≥ 30 字符\n');
        const dialogue = bindFusionSpeechRule(min,
          "\n5. dialogue 字段只放角色嘴里的台词（原样保留钉子台词），情绪用副词，触发用物理动作；旁白出现即废稿。\n",
          `\n5. dialogue 固定为"无台词"。已授权的叙事信息通过物理动作、画面或后期画面文字传达。${FROZEN_FUSION_SPEECH_RULE}\n`);
        const example = bindFusionSpeechRule(dialogue, '示例角色站立讲台前,自然手势讲解',
          "示例角色站立讲台前,转身提起道具并示意");
        const fused = source + bindFusionSpeechRule(example, '\n3. 【台词】字段必须独立,角色直接对镜头说话,不要写"画外音""旁白"\n',
          '\n3. 【台词】字段必须独立，值为"无台词"，其余字段同样不得安排说话或口型同步。\n');
        if (!Array.isArray(args[0]) || args[0].length !== 1) return fused;
        const shot = args[0][0] as RequirementRecord;
        const owner = frozenFieldScope(this, shot);
        const suit = owner && approvedSuit(owner, shot);
        if (!suit) return fused;
        const cuts = frozenCuts(scope)!;
        const sceneIndex = scope.contract!.scenes.findIndex(scene => scene.id === suit.id);
        const framedContours = (text: unknown): text is string => typeof text === "string"
          && /胸线/u.test(text) && /臀部/u.test(text) && /轮廓/u.test(text);
        if (!framedContours(cuts.intervals[sceneIndex]?.brief)) return fused;
        const plan = requirementRecord(scope.reviewedResult!.scenePlan, "已审构图计划").scenes as RequirementRecord[];
        const scene = plan.find(scene => scene.sceneId === suit.id);
        const framing = Array.isArray(scene?.visualRequirements) ? scene.visualRequirements.filter(framedContours) : [];
        return framing.length === 1 ? fused + `\n\n## 本镜已审防护造型与构图\n服装以本片已审全覆赛车服为准，不加其它衣层。只在现有 composition 字段写出以下经 G4 批准的构图如何在完整动作中可见：\n${framing[0]}\n` : fused;
      });
    });
    add(fusionPrototype, "_buildFillPrompt", original => function (...args) {
      const scope = productionScope(this);
      if (scope?.authority.profile.speechPolicy !== "none") return Reflect.apply(original, this, args);
      return guard(scope, () => {
        check(scope);
        assertNoSpokenPromptPackage([args[0], { fields: args[2] }], "PromptFusion.fill");
        const [source, template] = fusionSpeechTemplate(Reflect.apply(original, this, args), "\n## 本次只补齐以下字段");
        const fields = Array.isArray(args[1]) && args[1].includes("dialogue")
          ? bindFusionSpeechRule(template, "\n- dialogue:string,台词/旁白原文\n", '\n- dialogue:string,固定为"无台词"\n')
          : template;
        return source + fields + `\n${FROZEN_FUSION_SPEECH_RULE}`;
      });
    });
  }
  add(semanticPrototype, "_buildPrompt", original => function (...args) {
    const scope = productionScope(this);
    if (!scope) return Reflect.apply(original, this, args);
    const { titleCard, speechPolicy } = scope.authority.profile;
    if (titleCard !== false && speechPolicy !== "none") return Reflect.apply(original, this, args);
    return guard(scope, () => {
      check(scope);
      if (speechPolicy === "none") assertNoSpokenPromptPackage([args[1]], "PromptFusion.semantic");
      const value = Reflect.apply(original, this, args);
      if (typeof value !== "string") prdFail("PRD_VENDOR_UNAVAILABLE", "语义精炼输入不是文本");
      const boundary = value.indexOf("\n【待精炼提示词】\n");
      if (boundary < 0) prdFail("PRD_VENDOR_UNAVAILABLE", "语义精炼提示词边界已经变化");
      let header = value.slice(0, boundary);
      if (titleCard === false) header = header.replace("，片头 5 个专属字段保留", "")
        + "\n- 本次私有 titleCard=false：生成侧七个标题项 not_applicable，不生成、不补占位；保留实际 opening 场景身份及其他 25 个内容字段。";
      if (speechPolicy === "none") {
        const nativeDialogue = header.includes("【台词】字段逐字保留，时间戳不动。")
          ? "【台词】字段逐字保留，时间戳不动。" : "【台词】字段不存在则禁止虚构添加。";
        header = bindFusionSpeechRule(header, nativeDialogue,
          `【台词】字段若存在则保留"无台词"原值，缺省时不得虚构。${FROZEN_FUSION_SPEECH_RULE}`);
        header = bindFusionSpeechRule(header, "（如台词引号缺失、半句话）", "（如可见物件描述被截断）");
      }
      return header + value.slice(boundary);
    });
  });
  add(productionPrototype, "produce", original => async function (blueprintValue, ...args) {
    const scope = productionScope(this);
    if (!scope) return Reflect.apply(original, this, [blueprintValue, ...args]);
    return awaited(scope, async () => {
      check(scope);
      const blueprint = requirementRecord(blueprintValue, "实际制作蓝图");
      const config = blueprint.config === undefined ? {} : requirementRecord(blueprint.config, "实际制作配置");
      const profile = scope.authority.profile;
      const marker = { schemaVersion: "workloom.production-authority/v1", hash: requirementHash({ authority: scope.authorityHash,
        g4: scope.reviewedHash, scope: scope.authority.marketing.scope }), scope: structuredClone(scope.authority.marketing.scope),
        profile: structuredClone(profile), g4Hash: scope.reviewedHash };
      const view = { ...blueprint, config: { ...config, ...(profile.aspectRatio ? { aspectRatio: profile.aspectRatio } : {}) }, _workloomProductionAuthority: marker };
      const result = await Reflect.apply(original, this, [view, ...args]);
      check(scope);
      return result;
    });
  });
  // Native phase fingerprints only include scenes, and shot caches ignore enableResume.
  // Authority runs therefore use no native cache IO; existing cache files are preserved.
  for (const [owner, key, value] of [
    [productionPrototype, "_loadLatestCheckpoint", null], [productionPrototype, "_saveCheckpoint", undefined],
    [productionPrototype, "_clearCheckpoints", undefined], [fusionPrototype, "_loadSubCheckpoint", null],
    [fusionPrototype, "_saveSubCheckpoint", undefined], [fusionPrototype, "_clearSubCheckpoint", undefined]
  ] as Array<[RequirementRecord, string, unknown]>) add(owner, key, original => function (...args) {
    const scope = productionScope(this);
    if (!scope) return Reflect.apply(original, this, args);
    return guard(scope, () => { check(scope); return value; });
  });
  add(refinerPrototype, "_normalizeConstraint", original => function (...args) {
    const scope = productionScope(this);
    if (!scope) return Reflect.apply(original, this, args);
    return guard(scope, () => {
      check(scope);
      const profile = scope.authority.profile;
      const native = Reflect.apply(original, this, args);
      const body = args[0];
      // Keep the pinned native creative-constraint branch and its undeclared
      // defaults/baseline resolution. Apply only the customer's explicit keys
      // when that same native branch selects a short technical template.
      if (typeof native !== "string" || typeof body !== "string" || body.length >= 120
        || /时长|一镜到底|台词|唇形|慢动作|蒙太奇|叠化|手持|航拍|斯坦尼康|定场/.test(body)
        || !/画幅|分辨率|帧率|fps|格式|MP4|编码|色域/.test(body)) return native;
      let template = native;
      const replacePart = (pattern: RegExp, value: string) => {
        template = pattern.test(template) ? template.replace(pattern, value) : `${template}，${value}`;
      };
      if (profile.aspectRatio) replacePart(/\d+:\d+画幅/, `${profile.aspectRatio}画幅`);
      if (profile.resolution) {
        const ratio = profile.aspectRatio ?? /\b(\d+:\d+)画幅/.exec(template)?.[1];
        const sizes: Record<string, [string, string]> = { "9:16": ["1080x1920", "2160x3840"], "16:9": ["1920x1080", "3840x2160"],
          "1:1": ["1080x1080", "2160x2160"], "4:3": ["1440x1080", "2880x2160"], "3:4": ["1080x1440", "2160x2880"] };
        const pixels = ratio && sizes[ratio] ? sizes[ratio]![profile.resolution === "1080p" ? 0 : 1] : profile.resolution;
        replacePart(/(?:\d+[x×]\d+|\d+(?:\.\d+)?[KkpP])分辨率/, `${pixels}分辨率`);
      }
      if (profile.frameRate) replacePart(/\d+(?:\.\d+)?fps/, `${profile.frameRate}fps`);
      if (profile.aspectRatio && profile.resolution && profile.frameRate) {
        const resolutionPart = /(?:\d+[x×]\d+|\d+(?:\.\d+)?[KkpP])分辨率/.exec(template)?.[0];
        if (!resolutionPart) prdFail("PRD_VENDOR_UNAVAILABLE", "明确技术规格缺少分辨率模板");
        return `${profile.aspectRatio}画幅，${resolutionPart}，${profile.frameRate}fps，MP4格式`;
      }
      return template;
    });
  });
  add(costumePrototype, "enhance", original => function (shotsValue, charactersValue, ...args) {
    const scope = productionScope(this);
    if (!scope) return Reflect.apply(original, this, [shotsValue, charactersValue, ...args]);
    return guard(scope, () => {
      check(scope);
      if (!Array.isArray(shotsValue) || !Array.isArray(charactersValue)) prdFail("PRD_PRODUCTION_INVALID", "服装消费缺少实际镜头或人物数组");
      const canonical = scope.contract!.cast.characters;
      const anchors = (charactersValue as unknown[]).map(value => {
        const character = requirementRecord(value, "实际服装人物");
        const id = character.id ?? character.character_id;
        const selected = canonical.find(item => item.id === id && item.name === character.name);
        if (!selected || (character.character_id !== undefined && character.character_id !== id)
          || (selected.builtinCharacterSource && requirementHash(character.builtinCharacterSource) !== requirementHash(selected.builtinCharacterSource))) {
          prdFail("PRD_CAST_UNVERIFIED", "服装人物不属于本次已选档案");
        }
        const wardrobeId = selected.activeWardrobeId ?? selected.wardrobeId;
        if (wardrobeId === undefined) return { character: selected, detail: "" };
        const wardrobes = Array.isArray(selected.wardrobe) ? selected.wardrobe.map(value => requirementRecord(value, "权威服装")) : [];
        const matches = wardrobes.filter(item => item.id === wardrobeId);
        if (matches.length !== 1 || typeof matches[0]!.detail !== "string" || !matches[0]!.detail.trim()) prdFail("PRD_WARDROBE_UNVERIFIED", "当前服装 ID 缺少唯一完整档案原文");
        return { character: selected, detail: matches[0]!.detail as string };
      });
      if (this.enabled === false) return shotsValue;
      for (const value of shotsValue as unknown[]) {
        const shot = requirementRecord(value, "实际服装镜头");
        if (typeof shot.prompt !== "string") prdFail("PRD_PRODUCTION_INVALID", "服装增强缺少真实 prompt");
        const actualFields = shot.fields && typeof shot.fields === "object" && !Array.isArray(shot.fields) ? shot.fields as RequirementRecord : {};
        const existing = /【服装】([^【]*)/.exec(shot.prompt)?.[1]?.replace(/[\s|]/g, "");
        // Existing generated costume is reviewed as-is. Do not slice JSON or delete negatives.
        if (hasValue(actualFields.costume) || hasValue(shot.costume) || existing) continue;
        const additions = anchors.filter(anchor => anchor.detail && (shot.prompt as string).includes(String(anchor.character.name)))
          .map(anchor => `${String(anchor.character.name)}：${anchor.detail}`);
        if (additions.length) {
          shot.prompt = `【服装锁定】${additions.join("；")}\n${shot.prompt}`;
          shot.promptCharCount = (shot.prompt as string).length;
        }
      }
      return shotsValue;
    });
  });
  for (const key of ["normalizeAndValidate", "check", "assertOpeningFields"]) add(fieldGuardPrototype, key, original => function (shots = [], context = "unknown", ...args) {
    const scope = productionScope(this);
    if (!scope || scope.authority.profile.titleCard !== false) return Reflect.apply(original, this, [shots, context, ...args]);
    return guard(scope, () => {
      check(scope);
      const bindLayer2Portraits = key === "normalizeAndValidate" && context === "Layer2-Production"
        && scope.authority.profile.speechPolicy === "none"
        && scope.authority.portraitReferenceSelection?.angles.length === 2 && frozenCuts(scope) !== undefined;
      const result = inspect(shots, context, true, bindLayer2Portraits);
      if (key !== "check" && !result.report.passed) {
        const error = new Error(`PRD_PRODUCTION_FIELDS_INVALID: ${result.report.errors.join("; ")}`);
        Object.assign(error, { report: result.report });
        return fatal(scope, error);
      }
      return key === "assertOpeningFields" ? true : key === "check" ? { ...result, passed: result.report.passed } : result;
    });
  });
  add(systemPrototype, "_generatePromptsReport", original => function (promptsValue, ...args) {
    const scope = productionScope(this);
    if (!scope || scope.authority.profile.titleCard !== false) return Reflect.apply(original, this, [promptsValue, ...args]);
    return guard(scope, () => {
      check(scope);
      const { shots, report } = inspect(promptsValue, "G6-Prompt-Review", true);
      const prompts = promptsValue as RequirementRecord[];
      const lines = ["# 提示词审核报告", "", `镜头数：${shots.length}；字段合同：25 = P0 ${fieldGroups.p0.length} + P1 ${fieldGroups.p1.length} + P2 ${fieldGroups.p2.length} + P3 ${fieldGroups.p3.length}。`,
        `本次 titleCard=false；以下生成侧标题项 not_applicable：${RETIRED_TITLES.join("、")}。subtitle 指片头副标题，正式后期字幕仍按 Brief 执行。`,
        "当前提示词全文原样展示，不截断、不扩写情绪、不补标题占位、不把段落标签数量当字段覆盖率。", "", "## 镜头总览", "",
        "| 镜头 | 实际类型 | 时长 | 字符数 | 适用字段 | 校验 |", "|---|---|---:|---:|---:|---|"];
      shots.forEach((shot, index) => lines.push(`| ${String(shot.shotId)} | ${String(shot.sceneType)} | ${String(shot.duration)} | ${String((prompts[index]!.prompt as string)?.length ?? 0)} | ${report.details[index]!.presentFields}/25 | ${report.details[index]!.passed ? "pass" : "fail"} |`));
      lines.push("", "## 完整提示词", "");
      prompts.forEach((prompt, index) => {
        if (typeof prompt.prompt !== "string") prdFail("PRD_PRODUCTION_INVALID", "G6 不能以空文本代替当前提示词");
        const text = prompt.prompt as string;
        const fence = "`".repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map(value => value.length + 1)));
        lines.push(`### ${String(shots[index]!.shotId)}（${String(shots[index]!.sceneType)}，25 字段）`, "", `${fence}text`, text, fence, "");
      });
      lines.push("## 全部校验明细", "", ...report.errors.map(error => `- 错误：${error}`), ...report.warnings.map(warning => `- 警告：${warning}`));
      if (!report.errors.length && !report.warnings.length) lines.push("- 当前结构校验无错误或警告；不代表 G6/G7 已批准。");
      lines.push("", "G6 仍须审核事实用途、完整 Brief、具体动作与颜色连贯、人物和服装、台词与现场声音、字幕要求及技术规格；G7 继续真实执行。完整来源在本次模型调用中提供，本报告不代替真实审核。");
      return lines.join("\n");
    });
  });
  const applied: typeof changes = [];
  try {
    for (const change of changes) {
      Object.defineProperty(change.owner, change.key, change.original ? { ...change.original, value: change.patched }
        : { value: change.patched, writable: true, configurable: true, enumerable: false });
      applied.push(change);
    }
    installed = true;
    productionInstalls.set(systemPrototype, { changes });
  } catch (error) {
    for (const change of applied.reverse()) {
      if (change.original) Object.defineProperty(change.owner, change.key, change.original);
      else delete change.owner[change.key];
    }
    throw error;
  }
  return () => {
    if (!installed) return;
    if (changes.some(change => !descriptorEqual(Object.getOwnPropertyDescriptor(change.owner, change.key),
      change.original ? { ...change.original, value: change.patched } : { value: change.patched, writable: true, configurable: true, enumerable: false }))) {
      prdFail("PRD_BRIDGE_CHANGED", "制作桥卸载前方法身份已经变化");
    }
    for (const change of [...changes].reverse()) {
      if (change.original) Object.defineProperty(change.owner, change.key, change.original);
      else delete change.owner[change.key];
    }
    installed = false;
    productionInstalls.delete(systemPrototype);
  };
}

export function installVendorPrdProductionBridge(constructor: { prototype: object }, entryPath: string): () => void {
  const lease = acquireVendorRequirementEntry(entryPath);
  try {
    if (lease.exports.HyperrealitySystem !== (constructor as unknown)) prdFail("PRD_BRIDGE_CHANGED", "制作桥与受控 vendor constructor 不一致");
    const require = createRequire(lease.identity.entryPath);
    const load = (relative: string, name: string): RequirementRecord => {
      const module = require(path.resolve(path.dirname(lease.identity.entryPath), relative)) as Record<string, { prototype: RequirementRecord }>;
      return requirementRecord(module[name]?.prototype, `${name} prototype`);
    };
    const standardizer = require(path.resolve(path.dirname(lease.identity.entryPath), "engines/field-standardizer.js")) as Pick<ProductionDependencies, "standardizeShot" | "validateShot"> & { CRITICAL_FIELDS: ProductionDependencies["fields"] };
    const { globalLLMLimiter } = require(path.resolve(path.dirname(lease.identity.entryPath), "core/llm-concurrency-limiter.js")) as {
      globalLLMLimiter: NonNullable<ProductionDependencies["structuredAgent"]>["limiter"];
    };
    if (typeof globalLLMLimiter?.withLimit !== "function") prdFail("PRD_VENDOR_UNAVAILABLE", "制作模型并发限制器不可用");
    const { extractJson } = require(path.resolve(path.dirname(lease.identity.entryPath), "engines/field-quality/json-salvage.js")) as {
      extractJson: (content: string) => unknown;
    };
    if (typeof extractJson !== "function") prdFail("PRD_VENDOR_UNAVAILABLE", "原生字段修复 JSON 提取器不可用");
    return installPrdProductionBridge({ systemPrototype: requirementRecord(constructor.prototype, "受控 system prototype"),
      productionPrototype: load("engines/production-engine/production-engine.js", "ProductionEngine"),
      phase1Prototype: load("engines/production-engine/phases/phase-1-scene-design.js", "Phase1SceneDesign"),
      sceneDesignPrototype: load("engines/production-engine/agents/scene-design-agent.js", "SceneDesignAgent"),
      refinerPrototype: load("engines/production-engine/agents/field-content-refiner.js", "FieldContentRefiner"),
      costumePrototype: load("engines/character-system/character-costume-prompter.js", "CharacterCostumePrompter"),
      fieldGuardPrototype: load("engines/field-guard.js", "FieldGuard"),
      fusionPrototype: load("engines/production-engine/agents/prompt-fusion-agent.js", "PromptFusionAgent"),
      qualityGatePrototype: load("engines/production-engine/utils/quality-gate.js", "QualityGate"),
      deliveryGuardPrototype: load("engines/production-engine/agents/prompt-delivery-guard.js", "PromptDeliveryGuard"),
      semanticPrototype: load("engines/production-engine/agents/semantic-refinement-pass.js", "SemanticRefinementPass"),
      fieldQualityPrototype: load("engines/field-quality/field-quality-pipeline.js", "FieldQualityPipeline"),
      ruleRepairPrototype: load("engines/field-quality/field-repair-agent.js", "RuleRepairer"),
      ruleCheckPrototype: load("engines/field-quality/field-check-agent.js", "RuleChecker"),
      llmRepairPrototype: load("engines/field-quality/field-repair-agent.js", "LLMRepairer"), extractFieldRepairJson: extractJson,
      fieldConsistencyPrototype: load("engines/field-consistency-checker.js", "FieldConsistencyChecker"),
      structuredAgent: { prototype: load("engines/production-engine/agents/base-agent.js", "BaseAgent"), limiter: globalLLMLimiter },
      standardizeShot: standardizer.standardizeShot, validateShot: standardizer.validateShot, fields: standardizer.CRITICAL_FIELDS });
  } finally { lease.release(); }
}
