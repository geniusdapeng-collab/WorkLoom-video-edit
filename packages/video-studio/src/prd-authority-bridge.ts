import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import {
  requirementHash, requirementRecord, verifiedRequirementContract,
  type RequirementContract, type RequirementRecord
} from "./requirement-contract.js";
import {
  authoritativeDelivery, authoritativeProduct, bindPrdProvenance, effectivePrdModelSchema, prdAuthorityPrompt, prdFail,
  validatePrdDelivery, validatePrdModelPayload, validatePrdProduction, type PrdAuthority
} from "./prd-authority.js";
import { normalizeMarketingPrdContract } from "./marketing-prd-contract.js";
import { acquireVendorRequirementEntry } from "./vendor-requirement-entry.js";

type Method = (this: RequirementRecord, ...args: unknown[]) => unknown;
const QUALITY_KEYS = ["visual", "audio", "narrative", "consistency"] as const;
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
  const addition = `\n\n## 本次宿主已审制作权威输入 ${scope.reviewedHash}\n`
    + `以下是当前运行的完整来源，不是新的创作稿或批准。客户完整 Brief 与 G1 的用途限定优先于通用模板、艺术参考和已审 PRD 中的创作句子。`
    + `G4 批准不把 PRD 新增的修辞、设计目的、未知颜色或部件推测升级为 G1 已接受事实。`
    + `后续剧本、场景、摄影、色彩、音频、融合、精炼、检查与修复都须按相同层级理解；本次模型自主生成内容，不能用规则补造缺失字段。\n`
    + prdAuthorityPrompt(scope.authority, scope.contract!)
    + (scope.reviewedThemeHash ? `\n本次真实 G2 已审完整主题与原始裁决（SHA256 ${scope.reviewedThemeHash}）：\n${JSON.stringify(scope.reviewedTheme)}\n` : "")
    + `\n本次真实 G4 完整审核原文（SHA256 ${createHash("sha256").update(scope.reviewedContent!).digest("hex")}）：\n${scope.reviewedContent}\n`
    + `本次 G4 原始返回裁决（建议保持非阻断层级，不驱动额外调用）：\n${JSON.stringify(scope.reviewedVerdict)}\n`
    + `本次 G4 绑定的完整 PRD 对象（人物 portraitPath 可在后续合法填入；其他创作内容不得继承未经重审的修改）：\n${JSON.stringify(scope.reviewedResult)}\n`
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
  return `\n\n## 本次 G4 制作执行计划（由本次模型填写现有字段）\n`
    + `角色的 consistencyRequirements 除脸型、发型、服装外，还须写出 G5 前定妆照执行计划：逐角色绑定本次 characterId、档案 profilePath/profileSha256、registrySha256、已选服装与已知版本；`
    + `明确先从这些来源解析并复用该版本原始 front/closeup PNG，不把构图稿或新猜测人脸当原始参考。输入没有具体 PNG 路径或字节摘要时如实写“G5 前待解析和核验”，不得编造文件、摘要、授权或已批准状态。`
    + `写明 G5 前核验人物/版本/服装、原始 PNG 字节、来源与用途授权；不一致或缺件则保留未核实并停止依赖它的生成。其他必需角度按原有 G5 流程核验，只有本次实际图片和原有审核才能支持完成。`
    + `portraitPath 此时留空；不得新增 needsPortrait/portraitPlan 等 schema 未声明键，不得宣称 G5 或跨镜一致性已经通过。明确无人时不添加人物任务。\n`
    + `在 audioSpecification.soundDesign 和各场景既有 visualRequirements/audioRequirements 中写出本次字幕与声音的后续执行、验证方法，不新增模块。`
    + `本次明确字幕口径为 ${profile.subtitleMode ?? "客户未显式指定，沿用已有任务"}；如要求持续警示字幕，明确文字来源、覆盖起止、平台安全区、字号/对比度和遮挡检查方法；`
    + `要求烧录或 sidecar 时说明如何与同一台词、总时长和时间线核对；both 时按明确口径核对烧录与旁挂共有的台词及时间线，台词侧车与完整组合ASS分别说明，不能要求dialogue-only侧车包含持续文字。没有请求的字幕不得额外添加。`
    + `本次 nativeAudio=${profile.nativeAudio === undefined ? "未显式指定" : String(profile.nativeAudio)}；明确保留原生声音时，写出原始片段/音轨来源与时长核对、原速拼接、不加速口播、不静默换声或补 TTS 的后续验证计划；`
    + `枚举 voicePolicy、具体对白和音乐/环境音安排须彼此一致。所有这些是待执行计划，当前没有成片、听音或字幕通过证据。\n`
    + `本次明确的独立交付声明（未出现的键没有新增客户承诺）：${JSON.stringify(declarations)}。`
    + `若明确要求standalone封面，在既有visualRequirements中规划PNG/JPEG独立图、目标画幅/分辨率、来源绑定和文件核验；不要把独立交付推断成开启片头封面。`
    + `若明确要求dialogue-and-composite-ass，在既有字段内区分SRT/VTT台词侧车（dialogue-only）与完整组合ASS（complete-composition），说明ASS包含台词及本次请求的持续文字、覆盖实际视频0秒至末帧，`
    + `并规划文字、区间、字体样式及compositionSha256的核对；both时烧录和ASS使用同一组合。没有明确请求的持续文字、封面或其他文字层不得新增。`
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

function verifyOutput(scope: Scope, value: unknown, schema: RequirementRecord): RequirementRecord {
  return guard(scope, () => {
    const result = requirementRecord(value, "PRD 当前结果");
    if (!scope.contract || !scope.generated.has(result)) prdFail("PRD_RESULT_UNBOUND", "PRD 不属于本次真实生成调用");
    validatePrdProduction(result, scope.contract, scope.authority.profile);
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
      || requirementHash(marker.profile) !== requirementHash(profile)
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
      const promptContext = prdAuthorityPrompt(scope.authority, contract)
        + (scope.truth ? `\n\n本次规则事实边界（仅作内部限制，不是创意任务；完整原件不变）：\n${JSON.stringify(scope.truth.constraints)}\n` : "");
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
              return authoritativeProduct(Reflect.apply(process, this, args), scope.authority.profile);
            });
          };
        } else if (number === 4) {
          agentView.process = function (this: RequirementRecord, ...args: unknown[]) {
            return guard(scope, () => {
              check(scope);
              const result = requirementRecord(Reflect.apply(process, this, args), "原生 Agent4 结果");
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
              const result = authoritativeDelivery(Reflect.apply(process, this, args), scope.authority.profile);
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
          const effectiveSchema = effectivePrdModelSchema(kind, schema, contract);
          const schemaHeading = `\n\n## 本次宿主 PRD ${kind} 响应 JSON Schema（${requirementHash(effectiveSchema)}）\n`;
          const responseContext = schemaHeading
            + `本次实际模型响应必须符合以下完整 JSON Schema；它与宿主严格校验使用同一份有效结构，补充前述通用示例。`
            + (kind === "creative" ? `只输出创意核心的裸 JSON 对象，不要包裹 creativeCore。\n` : `只输出以下四个制作模块组成的 JSON 对象。\n`)
            + `\`\`\`json\n${JSON.stringify(effectiveSchema)}\n\`\`\`\n` + promptContext
            + (number === 3 ? productionPlanningPrompt(scope) : "");
          let builtPrompt: { original: string; complete: string } | undefined;
          agentView._getLLMEngine = function (this: RequirementRecord, ...args: unknown[]) {
            return guard(scope, () => {
              check(scope);
              const value = Reflect.apply(getEngine, this, args);
              if (value === null || value === undefined) return value;
              const engine = requirementRecord(value, "PRD 原始模型引擎"), reason = method(engine, "reasonStructured");
              const enginePrototype = Object.getPrototypeOf(engine);
              let methodOwner: object | null = engine;
              while (methodOwner && !Object.getOwnPropertyDescriptor(methodOwner, "reasonStructured")) methodOwner = Object.getPrototypeOf(methodOwner);
              const reasonDescriptor = methodOwner && Object.getOwnPropertyDescriptor(methodOwner, "reasonStructured");
              if (!methodOwner || !reasonDescriptor || reasonDescriptor.value !== reason) prdFail("PRD_VENDOR_UNAVAILABLE", "原始模型方法不是固定的数据属性");
              const checkEngine = () => {
                if (Object.getPrototypeOf(engine) !== enginePrototype || engine.reasonStructured !== reason
                  || !descriptorEqual(Object.getOwnPropertyDescriptor(methodOwner!, "reasonStructured"), reasonDescriptor)) {
                  prdFail("PRD_ENGINE_CHANGED", "本次模型引擎方法或属性身份已经变化");
                }
              };
              const engineView = Object.create(engine) as RequirementRecord;
              let nativePrefix: string | undefined;
              engineView.reasonStructured = async function (prompt: unknown, ...callArgs: unknown[]) {
                const complete = guard(scope, () => {
                  check(scope); checkEngine();
                  if (typeof prompt !== "string") prdFail("PRD_VENDOR_UNAVAILABLE", "实际模型调用 prompt 不是文本");
                  if (!builtPrompt) prdFail("PRD_VENDOR_UNAVAILABLE", "实际模型调用缺少本次亲自构建的 PRD prompt");
                  if (nativePrefix === undefined) {
                    if (!prompt.endsWith(builtPrompt.complete)) prdFail("PRD_VENDOR_UNAVAILABLE", "首次模型 prompt 不属于本次完整构建结果");
                    nativePrefix = prompt.slice(0, prompt.length - builtPrompt.complete.length);
                    return prompt;
                  }
                  if (!prompt.startsWith(nativePrefix)) prdFail("PRD_VENDOR_UNAVAILABLE", "原生模型 prompt 前缀在重试期间变化");
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
                let result: unknown;
                try { result = await Reflect.apply(reason, engine, [complete, ...callArgs]); }
                catch (error) {
                  // A provider/parse failure may use the native retry budget. Authority,
                  // scope or engine identity failures remain sticky and prevent that retry.
                  guard(scope, () => { check(scope); checkEngine(); });
                  throw error;
                }
                guard(scope, () => { check(scope); checkEngine(); });
                return result;
              };
              return engineView;
            });
          };
          agentView._buildPrompt = function (this: RequirementRecord, ...args: unknown[]) {
            return guard(scope, () => {
              check(scope);
              const original = Reflect.apply(build, this, args);
              if (typeof original !== "string") prdFail("PRD_VENDOR_UNAVAILABLE", "原始 PRD prompt 不是文本");
              builtPrompt = { original, complete: original + responseContext };
              return builtPrompt.complete;
            });
          };
          agentView._callLLM = function (this: RequirementRecord, ...args: unknown[]) {
            return awaited(scope, async () => {
              check(scope);
              const result = requirementRecord(await Reflect.apply(call, this, args), "PRD 模型调用回执");
              check(scope);
              if (result.degraded !== false || result.result === null || result.result === undefined) prdFail("PRD_MODEL_UNVERIFIED", "本次 PRD 模型失败或降级，不能使用模板创意");
              return result;
            });
          };
          agentView._parseResult = function (this: RequirementRecord, value: unknown, ...args: unknown[]) {
            return guard(scope, () => {
              check(scope);
              const raw = validatePrdModelPayload(value, kind, schema, contract, scope.authority.profile);
              const result = Reflect.apply(parse, this, [value, ...args]);
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
      const labeled = original.replace("## 9. 受众定位", `## 9. 客户受众与模型细分推测\n\n`
        + `- **客户 Brief 权威受众原文**：${scope.contract!.ownerAudience ?? "客户未显式指定"}\n`
        + `- **以下年龄、性别与兴趣细分仅为模型推测**：不覆盖客户原文，不构成已核实市场事实，仍待本次 G4 独立评审。\n\n### 模型细分原文`);
      // This field is inapplicable when props exist; retain the canonical contract and hashes.
      const displayContract = { ...scope.contract!, scenes: scope.contract!.scenes.map(scene => {
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
      const planning = {
        status: "plan-only-not-executed",
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
      return labeled + `\n\n## 宿主本次权威生产与交付要求\n\n\`\`\`json\n${JSON.stringify({ profile: scope.authority.profile, source: result._workloomPrdAuthority, approvedRequirementContract: displayContract }, null, 2)}\n\`\`\`\n\n`
        + `上述来源绑定只说明本次输入一致；G1 不批准本 PRD，G4 与 G5 均须实际审核。空 portraitPath 是 G4 前正常状态，不能当成已完成定妆照。\n`
        + `\n## 本次 G4 执行与核验计划原文\n\n`
        + `以下仅展示本次模型和既有规则模块已经产生的字段；没有补写模型计划，也不证明图片、字幕、听音或成片已经验证。`
        + `qualityPolicy.thresholds 是已经同时写入制作约束与验收的当前执行值，fallbackTrigger 使用同一视觉值；来源摘要绑定本次统一前的原生规则来源。`
        + `角色原始 PNG 来源/复用与待 G5 核验条件见 consistencyRequirements；字幕安全区、持续起止、sidecar 一致性与原生声音原速保留的后续验证方法见原始视觉/声音要求。`
        + `shotMapping原样展示实际数组；原生场景文字中的箭头仅为Markdown连接展示，不是shotBreakdownHint的原始枚举值。`
        + `缺失计划继续交本次 G4 判断，不能用此说明替代实际计划或批准。\n\n\`\`\`json\n${JSON.stringify(planning, null, 2)}\n\`\`\`\n`;
    });
  };
  const reviewed: Method = async function (content, value) {
    const scope = scopedReceiver(this, "system");
    if (!scope) return Reflect.apply(confirmPrd, this, [content, value]);
    return awaited(scope, async () => {
      check(scope);
      if (scope.system !== this || systems.get(this) !== scope) prdFail("PRD_SCOPE_CONFLICT", "G4 不是本次系统的 PRD");
      const result = verifyOutput(scope, value, schema), before = requirementHash(result);
      scope.g4Decision = "pending";
      const verdict = requirementRecord(await Reflect.apply(confirmPrd, this, [content, value]), "G4 实际确认结果");
      check(scope); verifyOutput(scope, value, schema);
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
  refinerPrototype: RequirementRecord;
  costumePrototype: RequirementRecord;
  fieldGuardPrototype: RequirementRecord;
  fusionPrototype: RequirementRecord;
  qualityGatePrototype: RequirementRecord;
  deliveryGuardPrototype: RequirementRecord;
  semanticPrototype: RequirementRecord;
  standardizeShot: (shot: RequirementRecord) => RequirementRecord;
  validateShot: (shot: RequirementRecord) => RequirementRecord;
  fields: { p0: string[]; p1: string[]; p2: string[]; p3: string[]; common: string[] };
}
const productionOwners = new WeakMap<object, Scope>();
const productionInstalls = new WeakMap<object, { changes: Array<{ owner: RequirementRecord; key: string; original?: PropertyDescriptor; patched: Method }> }>();
const RETIRED_TITLES = ["title", "subtitle", "title_content", "subtitle_content", "title_animation", "title_font_design", "opening_audio_design"];
const RETIRED_TITLE_LABELS = ["【主标题内容】", "【副标题内容】", "【标题动画设计】", "【标题字体设计】", "【开场音频设计】"];

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
  const inspect = (shotsValue: unknown, context: unknown, noTitle: boolean) => {
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
      shot._context = context;
      return shot;
    });
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
    if (!scope || scope.authority.profile.titleCard !== false) return Reflect.apply(original, this, [prompt, shot, ...args]);
    return guard(scope, () => {
      check(scope);
      const result = requirementRecord(Reflect.apply(original, this, [prompt, shot, ...args]), "原生提示词交付检查");
      if (!Array.isArray(result.issues) || result.issues.some(issue => typeof issue !== "string")) prdFail("PRD_VENDOR_UNAVAILABLE", "交付检查缺少原始错误明细");
      const retired = new Set(RETIRED_TITLE_LABELS.map(label => `缺片头专属字段:${label.slice(1, -1)}`));
      const issues = (result.issues as string[]).filter(issue => !retired.has(issue));
      if (typeof prompt === "string" && RETIRED_TITLE_LABELS.some(label => prompt.includes(label))) issues.push("生成侧重新出现已退休片头标题字段");
      return { ...result, pass: issues.length === 0, issues, expectedMin: fields.length,
        applicability: Object.fromEntries(RETIRED_TITLES.map(key => [key, "not_applicable"])) };
    });
  });
  add(semanticPrototype, "_buildPrompt", original => function (...args) {
    const scope = productionScope(this);
    if (!scope || scope.authority.profile.titleCard !== false) return Reflect.apply(original, this, args);
    return guard(scope, () => {
      check(scope);
      const value = Reflect.apply(original, this, args);
      if (typeof value !== "string") prdFail("PRD_VENDOR_UNAVAILABLE", "语义精炼输入不是文本");
      const boundary = value.indexOf("\n【待精炼提示词】\n");
      if (boundary < 0) prdFail("PRD_VENDOR_UNAVAILABLE", "语义精炼提示词边界已经变化");
      const header = value.slice(0, boundary).replace("，片头 5 个专属字段保留", "");
      return header + `\n- 本次私有 titleCard=false：生成侧七个标题项 not_applicable，不生成、不补占位；保留实际 opening 场景身份及其他 25 个内容字段。`
        + value.slice(boundary);
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
      const result = inspect(shots, context, true);
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
    return installPrdProductionBridge({ systemPrototype: requirementRecord(constructor.prototype, "受控 system prototype"),
      productionPrototype: load("engines/production-engine/production-engine.js", "ProductionEngine"),
      phase1Prototype: load("engines/production-engine/phases/phase-1-scene-design.js", "Phase1SceneDesign"),
      refinerPrototype: load("engines/production-engine/agents/field-content-refiner.js", "FieldContentRefiner"),
      costumePrototype: load("engines/character-system/character-costume-prompter.js", "CharacterCostumePrompter"),
      fieldGuardPrototype: load("engines/field-guard.js", "FieldGuard"),
      fusionPrototype: load("engines/production-engine/agents/prompt-fusion-agent.js", "PromptFusionAgent"),
      qualityGatePrototype: load("engines/production-engine/utils/quality-gate.js", "QualityGate"),
      deliveryGuardPrototype: load("engines/production-engine/agents/prompt-delivery-guard.js", "PromptDeliveryGuard"),
      semanticPrototype: load("engines/production-engine/agents/semantic-refinement-pass.js", "SemanticRefinementPass"),
      standardizeShot: standardizer.standardizeShot, validateShot: standardizer.validateShot, fields: standardizer.CRITICAL_FIELDS });
  } finally { lease.release(); }
}
