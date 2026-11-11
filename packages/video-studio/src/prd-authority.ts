import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  frozenSegmentContract, requirementHash, requirementRecord, validateRequirementSchema,
  type RequirementContract, type RequirementRecord
} from "./requirement-contract.js";
import { TARGET_DURATION_TOLERANCE_SECONDS } from "./duration-contract.js";
import { MARKETING_REFERENCE_BOUNDARY } from "./marketing-prd-contract.js";
import type { PrdPortraitReferenceSelection, PrdPortraitSource } from "./prd-portrait-source.js";

export interface PrdMarketingScope {
  tenantId: string;
  workspaceId: string;
  projectId: string;
  runId: string;
  attempt: number;
}

/** Only the service's accepted-current-G1 closure may supply this value. */
export interface PrdMarketingAuthority {
  schemaVersion: "workloom.prd-marketing-authority/v1";
  scope: PrdMarketingScope;
  g1Artifact: { path: string; sha256: string; content: string };
  g1Proof: {
    gate: "G1_DOSSIER";
    approved: true;
    status: "passed";
    via: "llm";
    degraded: false;
    model: string;
    evidence: ReadonlyArray<{ path: string; sha256: string; scope: "complete-text"; [key: string]: unknown }>;
    [key: string]: unknown;
  };
}

export interface PrdProductionProfile {
  targetDuration?: number;
  aspectRatio?: "16:9" | "9:16" | "1:1" | "4:3";
  targetPlatform?: string;
  /** Delivery declaration only; provider/native capability remains a separate preflight. */
  resolution?: "1080p" | "4K";
  frameRate?: 24 | 25 | 30 | 60;
  subtitleMode?: "both" | "burned" | "sidecar" | "none";
  nativeAudio?: boolean;
  /** No authored dialogue, voice-over or narration. Does not mute original ambient or action sound. */
  speechPolicy?: "none";
  openWithCover?: boolean;
  /** Complete-video cover intro duration; 0 disables the intro. */
  coverIntroSeconds?: number;
  titleCard?: boolean;
  durationToleranceFrames?: number;
  /** Separate-file obligation only; it does not enable an opening cover. */
  coverDelivery?: "standalone" | "none";
  sidecarPolicy?: "dialogue-only" | "dialogue-and-composite-ass";
  persistentSubtitleText?: string;
  /** Exact local post overlay, separate from the persistent line and from an opening title card. */
  postTailOverlayText?: string;
  postTailOverlaySeconds?: number;
}

export interface PrdAuthority {
  metadata: RequirementRecord;
  marketing: PrdMarketingAuthority;
  profile: PrdProductionProfile;
  portraitSources?: PrdPortraitSource[];
  portraitReferenceSelection?: PrdPortraitReferenceSelection;
}

export class PrdAuthorityError extends Error {
  readonly status = "unverified";
  /** Authority failures must not consume a provider retry or open a different model path. */
  readonly retryable = false;
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "PrdAuthorityError";
  }
}

export function prdFail(code: string, message: string): never {
  throw new PrdAuthorityError(code, message);
}

const SCOPE_KEYS = ["tenantId", "workspaceId", "projectId", "runId", "attempt"] as const;
function sameScope(value: unknown, expected: PrdMarketingScope): boolean {
  const item = requirementRecord(value, "PRD 事实作用域");
  return Object.keys(item).length === SCOPE_KEYS.length && SCOPE_KEYS.every(key => item[key] === expected[key]);
}
function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) prdFail("PRD_AUTHORITY_INVALID", `${label} 缺少完整文本`);
  return value;
}
function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) prdFail("PRD_RESPONSE_UNVERIFIED", `${label} 必须显式为数组`);
  return value;
}

/** Shared explicit duration rule; omission has no customer authority or inferred default. */
export function normalizeExplicitBriefDuration(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if ((typeof value !== "number" && (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)))
    || !Number.isFinite(Number(value)) || Number(value) < 5 || Number(value) > 180) {
    prdFail("PRD_PROFILE_INVALID", "Brief 明确时长非法");
  }
  return Number(value);
}

/** No inferred defaults: these are explicit client requirements, separate from vendor productionProfile. */
export function normalizePrdProductionProfile(metadata: RequirementRecord): PrdProductionProfile {
  const brief = metadata.brief === undefined ? {} : requirementRecord(metadata.brief, "PRD 客户 Brief");
  const explicit = Object.hasOwn(brief, "productionRequirements");
  const production = explicit ? requirementRecord(brief.productionRequirements, "Brief.productionRequirements") : undefined;
  const required = ["resolution", "frameRate", "subtitleMode", "nativeAudio", "openWithCover", "titleCard", "durationToleranceFrames"];
  const keys = [...required, "coverDelivery", "sidecarPolicy", "persistentSubtitleText", "coverIntroSeconds", "speechPolicy",
    "postTailOverlayText", "postTailOverlaySeconds"];
  if (production && (Object.keys(production).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(production, key)))) {
    prdFail("PRD_PROFILE_INVALID", "productionRequirements 必须完整且不能包含未定义字段");
  }
  const platforms: Record<string, string> = {
    douyin: "抖音", wechat: "视频号", bilibili: "B站", xiaohongshu: "小红书",
    youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram",
    "抖音": "抖音", "视频号": "视频号", "B站": "B站", "小红书": "小红书",
    YouTube: "YouTube", TikTok: "TikTok", Instagram: "Instagram", "通用": "通用"
  };
  const profile: PrdProductionProfile = {};
  const duration = normalizeExplicitBriefDuration(brief.duration);
  if (duration !== undefined) profile.targetDuration = duration;
  const aspect = brief.aspectRatio ?? brief.aspect_ratio;
  if (aspect !== undefined) {
    if (typeof aspect !== "string" || !(explicit ? ["16:9", "9:16", "1:1"] : ["16:9", "9:16", "1:1", "4:3"]).includes(aspect)
      || (brief.aspectRatio !== undefined && brief.aspect_ratio !== undefined && brief.aspectRatio !== brief.aspect_ratio)) {
      prdFail("PRD_PROFILE_INVALID", "Brief 画幅冲突或不在本次 PRD/正式交付共同支持范围");
    }
    profile.aspectRatio = aspect as PrdProductionProfile["aspectRatio"];
  }
  if (brief.platform !== undefined) {
    if (typeof brief.platform !== "string" || !Object.hasOwn(platforms, brief.platform)) prdFail("PRD_PROFILE_INVALID", "Brief 明确平台非法");
    profile.targetPlatform = platforms[brief.platform]!;
  }
  if (!production) return profile;
  if (!["1080p", "4K"].includes(String(production.resolution))
    || ![24, 25, 30, 60].includes(production.frameRate as number)
    || !["both", "burned", "sidecar", "none"].includes(String(production.subtitleMode))
    || ["nativeAudio", "openWithCover", "titleCard"].some(key => typeof production[key] !== "boolean")
    || !Number.isSafeInteger(production.durationToleranceFrames)
    || Number(production.durationToleranceFrames) < 0 || Number(production.durationToleranceFrames) > 1) {
    prdFail("PRD_PROFILE_INVALID", "时长、画幅、平台、分辨率、帧率或明确交付要求非法");
  }
  if ((Object.hasOwn(production, "coverDelivery") && !["standalone", "none"].includes(production.coverDelivery as string))
    || (Object.hasOwn(production, "sidecarPolicy") && !["dialogue-only", "dialogue-and-composite-ass"].includes(production.sidecarPolicy as string))) {
    prdFail("PRD_PROFILE_INVALID", "独立封面或字幕旁挂口径非法");
  }
  if (Object.hasOwn(production, "coverIntroSeconds")
    && (typeof production.coverIntroSeconds !== "number" || !Number.isFinite(production.coverIntroSeconds)
      || production.coverIntroSeconds < 0 || production.coverIntroSeconds > 5)) {
    prdFail("PRD_PROFILE_INVALID", "封面片头时长必须为 0–5 秒的有限数");
  }
  if (Object.hasOwn(production, "speechPolicy") && production.speechPolicy !== "none") {
    prdFail("PRD_PROFILE_INVALID", "明确的人声口径只接受 none；它不关闭原生环境或动作声音");
  }
  const normalized = { ...profile, ...production } as PrdProductionProfile;
  if (Object.hasOwn(production, "persistentSubtitleText")) {
    const value = production.persistentSubtitleText;
    if (typeof value !== "string") prdFail("PRD_PROFILE_INVALID", "持续字幕必须是完整单行文本");
    const text = value.trim(), characters = Array.from(text);
    // Match the formal subtitle connector's text boundary without loading its media dependencies.
    if (!text || characters.length > 120 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
      || characters.some(character => character.length === 1 && character.charCodeAt(0) >= 0xd800 && character.charCodeAt(0) <= 0xdfff)) {
      prdFail("PRD_PROFILE_INVALID", "持续字幕须为1至120个Unicode字符，不能含换行、控制字符或无效Unicode");
    }
    normalized.persistentSubtitleText = text;
    if (normalized.subtitleMode === "none" || normalized.titleCard !== false
      || (["both", "sidecar"].includes(normalized.subtitleMode!) && normalized.sidecarPolicy !== "dialogue-and-composite-ass")) {
      prdFail("PRD_PROFILE_INVALID", "持续字幕与字幕关闭、标题卡或缺少完整组合ASS的旁挂口径冲突；封面片头可独立存在");
    }
  }
  if (normalized.sidecarPolicy !== undefined && !["both", "sidecar"].includes(normalized.subtitleMode!)) {
    prdFail("PRD_PROFILE_INVALID", "字幕旁挂口径仅适用于both或sidecar交付");
  }
  if (Object.hasOwn(production, "postTailOverlayText") || Object.hasOwn(production, "postTailOverlaySeconds")) {
    const text = production.postTailOverlayText, seconds = production.postTailOverlaySeconds;
    const centisecondAligned = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) <= 1e-9;
    if (typeof text !== "string" || !text || text.trim() !== text || text === normalized.persistentSubtitleText
      || Array.from(text).length > 120 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029\uD800-\uDFFF]/u.test(text)
      || typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 1.5 || seconds > 3
      || !centisecondAligned(seconds) || duration === undefined || !centisecondAligned(duration)
      || normalized.persistentSubtitleText === undefined || normalized.subtitleMode !== "both"
      || normalized.sidecarPolicy !== "dialogue-and-composite-ass" || normalized.speechPolicy !== "none"
      || normalized.openWithCover !== false || (normalized.coverIntroSeconds ?? 0) !== 0) {
      prdFail("PRD_PROFILE_INVALID", "片尾后期层须同时明确原样单行文字和 1.5–3 秒百分秒精度时长，使用无片头、无对白的持续文字烧录与完整组合ASS口径");
    }
  }
  return normalized;
}

/** Recheck exact current bytes, including the full nested support review; never reduce this to summary cards. */
export function preparePrdAuthority(input: {
  metadata: RequirementRecord; marketing: PrdMarketingAuthority; workDir: string; projectId: string;
}): PrdAuthority {
  const authority = structuredClone(input.marketing);
  const scope = requirementRecord(authority?.scope, "PRD 宿主营销作用域") as unknown as PrdMarketingScope;
  if (authority.schemaVersion !== "workloom.prd-marketing-authority/v1" || scope.projectId !== input.projectId
    || !Number.isSafeInteger(scope.attempt) || scope.attempt < 1
    || Object.keys(scope).length !== SCOPE_KEYS.length
    || [scope.tenantId, scope.workspaceId, scope.projectId, scope.runId].some(value =>
      typeof value !== "string" || !value || value === "." || value === ".." || /[/\\\0]/.test(value))) {
    prdFail("PRD_G1_UNVERIFIED", "缺少本次宿主五域 G1 作用域");
  }
  const artifact = requirementRecord(authority.g1Artifact, "G1 原件");
  const expectedPath = path.join(path.resolve(input.workDir), "gates", input.projectId, `attempt-${scope.attempt}`, "G1_DOSSIER.md");
  const proof = requirementRecord(authority.g1Proof, "G1 原始通过凭据");
  const evidence = list(proof.evidence, "G1 完整原件凭据").filter(value => requirementRecord(value, "G1 evidence").path === expectedPath);
  if (artifact.path !== expectedPath || typeof artifact.content !== "string" || !artifact.content
    || !/^[a-f0-9]{64}$/.test(String(artifact.sha256))
    || proof.gate !== "G1_DOSSIER" || proof.approved !== true || proof.status !== "passed" || proof.via !== "llm"
    || proof.degraded !== false || typeof proof.model !== "string" || !proof.model.trim()
    || evidence.length !== 1 || requirementRecord(evidence[0], "G1 原件凭据").sha256 !== artifact.sha256
    || requirementRecord(evidence[0], "G1 原件凭据").scope !== "complete-text") {
    prdFail("PRD_G1_UNVERIFIED", "G1 缺少本次真实非降级完整通过证明");
  }
  try {
    const root = path.resolve(input.workDir);
    if (realpathSync(root) !== root || realpathSync(expectedPath) !== expectedPath) prdFail("PRD_G1_CHANGED", "G1 路径经过符号链接");
    const stat = statSync(expectedPath), bytes = readFileSync(expectedPath);
    if (!stat.isFile() || !bytes.length || bytes.length > 2 * 1024 * 1024 || bytes.length !== stat.size
      || !bytes.equals(Buffer.from(artifact.content))
      || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
      || realpathSync(expectedPath) !== expectedPath) prdFail("PRD_G1_CHANGED", "G1 原始字节与宿主通过凭据不一致");
    const facts = requirementRecord(requirementRecord(JSON.parse(artifact.content), "G1 JSON").facts, "G1 facts");
    if (facts.schemaVersion !== "workloom.marketing-facts/v1" || facts.issuer !== "workloom.marketing-authority" || !sameScope(facts.scope, scope)) {
      prdFail("PRD_G1_UNVERIFIED", "G1 原件不是本次五域的宿主营销事实");
    }
  } catch (error) {
    if (error instanceof PrdAuthorityError) throw error;
    prdFail("PRD_G1_CHANGED", `G1 原件无法完整复核：${error instanceof Error ? error.message : String(error)}`);
  }
  const metadata = structuredClone(input.metadata);
  return { metadata, marketing: authority, profile: normalizePrdProductionProfile(metadata) };
}

export function frozenVisualPrdSegments(authority: PrdAuthority) {
  return authority.profile.speechPolicy === "none"
    ? frozenSegmentContract(requirementRecord(authority.metadata.brief, "本次无对白 Brief"), authority.profile.targetDuration)
    : undefined;
}

/** Original G3 contracts stay intact. Unapproved audience copy is not execution input. */
export function prdContractExecutionView(authority: PrdAuthority, contract: RequirementContract): RequirementContract | RequirementRecord {
  if (!frozenVisualPrdSegments(authority)) return contract;
  const { modelAudienceHypothesis, ...execution } = contract;
  return { ...execution, originalModelAudienceHypothesisSha256: requirementHash(modelAudienceHypothesis ?? null) };
}

function postTailOverlayPlan(profile: PrdProductionProfile): string {
  if (profile.postTailOverlayText === undefined || profile.postTailOverlaySeconds === undefined || profile.targetDuration === undefined) return "";
  const end = profile.targetDuration, start = Math.round((end - profile.postTailOverlaySeconds) * 100) / 100;
  return `片尾独立后期层 ${JSON.stringify(profile.postTailOverlayText)}（${start}–${end}秒，含起点不含终点）`;
}

/** Both existing real LLM agents receive the same execution authority; this grants no new approval. */
export function prdAuthorityPrompt(authority: PrdAuthority, contract: RequirementContract): string {
  const execution = prdContractExecutionView(authority, contract);
  const tail = postTailOverlayPlan(authority.profile);
  return `\n\n## 本次宿主 PRD 权威输入（补充前述通用模板，冲突时以本节为准）\n`
    + `完整客户 Brief：\n${JSON.stringify(authority.metadata.brief)}\n`
    + `当前已核验商品营销路线的交付类型是商业广告；本次获批类型细分可继续描述创作风格。${MARKETING_REFERENCE_BOUNDARY}\n`
    + `在 visualReferences 和 audioReferences 中填写本片可执行的摄影或声音手法，不能照抄示例片名、导演或品牌。\n`
    + `客户明确提供的生产/交付要求（缺省字段没有客户权威，不得伪称客户已指定；分辨率为交付档声明，不替代模型原生能力与提交前验证）：\n${JSON.stringify(authority.profile)}\n`
    + (authority.profile.speechPolicy === "none"
      ? "本次明确禁止创作或生成台词、旁白、口播、独白及可辨词句；保留已要求的原生环境和动作声。无对白不表示静音，后期文字仍按本次交付合同执行。\n"
      : "")
    + (tail ? `唯一两层后期文字：全片持续层 ${JSON.stringify(authority.profile.persistentSubtitleText)}（0秒至实际末帧）和${tail}。全片标识在片尾继续显示；片尾层只在指定区间本地独立叠加，不能提前到其他镜头、替换全片标识、放入生成画面或作为片头标题卡。不要新增对白轨、双语轨或其他文字。字幕及音频字段只描述这两层的执行与核验；两层组合需分别核对安全区、对比度及同屏不遮挡；正式交付项由原生交付规则登记，不是当前模型或已完成凭据。\n` : "")
    + `本次 G3 已审的完整场景、道具、动作和宿主选角合同${execution === contract ? "" : "（受众推测仍在原始审核材料，不是制作指令）"}：\n${JSON.stringify(execution)}\n`
    + `客户受众原文是权威口径；模型年龄/性别细分仅为推测。只使用合同内人物，characterId 必须等于所选 id，姓名一致。`
    + `人物档案是人物表达依据，不能当成商品事实；保留其人物档案/版本来源锚点。portraitPath 可以留空，G5 后续独立核验，不能提前声称出图或一致性已通过。\n`
    + (authority.portraitSources?.length ? `以下是已按本次原文、人物和既有所有者用途证据核对的源图；它们仍待本次 G5 执行复制与审核，不能填入项目 portraitPath：\n${JSON.stringify(authority.portraitSources)}\n` : "")
    + `制作规格 scenePlan.scenes 按合同节点顺序一一对应，sceneId 必须逐项等于合同 scenes[].id，duration 必须逐项等于该节点 duration。`
    + `不得合并、拆分、漏掉开场或结尾；总时长必须位于 ${authority.profile.targetDuration ?? contract.scenes.reduce((sum, scene) => sum + scene.duration, 0)}s 的 ±${TARGET_DURATION_TOLERANCE_SECONDS}s 内，且各节点时长必须继承已审 G3 合同。`
    + `shotMapping.estimatedShots=1 时 shotBreakdownHint 必须恰好一个主景别；动作、景别、转场和时间轴须由同一主运镜在该生成片段内完成。`
    + `完整保留场景原目的、角色行为、可见道具与创作原文；叙事语言由本次模型创作。\n`
    + `下面是本次宿主真实非降级 G1 通过的完整原件，仅授权其中已接受 claims 及其限定用途，不批准本次 PRD。`
    + `必须遵守原件明确 restrictions。完整阅读嵌套 A1/A2/A3 support review 的 issues 和 suggestions，回应其中的事实不确定性、来源/报道日期/用途限定。`
    + `保持原始层级：非阻断的创意建议仍为建议，不能升级为 G1 硬条件或新审批，G1 通过也不批准这些新创作。`
    + `媒体报道只能归因给该媒体和日期，没有直接厂家引语不能改称厂家官方确认；未知外观、使用场地限定、赛事型号与零售型号边界不得扩写。`
    + `不确定时不使用该主张，不能把“通过G1”解释为每个创作句子已获批准。\n`
    + `G1 完整原始裁决（包括所有意见和建议）：\n${JSON.stringify(authority.marketing.g1Proof)}\n`
    + `G1 原件 ${authority.marketing.g1Artifact.path} / SHA256 ${authority.marketing.g1Artifact.sha256}：\n${authority.marketing.g1Artifact.content}\n`;
}

export function authoritativeProduct(value: unknown, profile: PrdProductionProfile): RequirementRecord {
  const result = structuredClone(requirementRecord(value, "ProductDefinition 原始输出"));
  const positioning = { ...requirementRecord(result.productPositioning, "产品定位") };
  for (const key of ["targetDuration", "aspectRatio", "targetPlatform", "resolution", "frameRate"] as const) {
    if (profile[key] !== undefined) positioning[key] = profile[key];
  }
  result.productPositioning = positioning;
  return result;
}

function usesNativeFilmPostTail(profile: PrdProductionProfile, authority?: PrdAuthority): boolean {
  if (!authority || authority.profile !== profile || profile.postTailOverlayText === undefined
    || profile.postTailOverlaySeconds === undefined || !frozenVisualPrdSegments(authority)) return false;
  const brief = requirementRecord(authority.metadata.brief, "本次后期编码 Brief");
  const codec = /\b(?:h[.\s_-]?26[45]|hevc|avc|av1|vp[89]|prores|(?:lib)?x26[45])\b/iu;
  return !["videoCodec", "video_codec", "codec"].some(key => Object.hasOwn(brief, key))
    && ![authority.metadata.customerOriginalIntent, brief.description, brief.requirements]
      .some(value => typeof value === "string" && codec.test(value));
}

export function authoritativeDelivery(value: unknown, profile: PrdProductionProfile, authority?: PrdAuthority): RequirementRecord {
  const result = structuredClone(requirementRecord(value, "DeliveryStandard 原始输出"));
  const standard = requirementRecord(result.deliveryStandard, "交付标准");
  const output = requirementRecord(standard.outputFormat, "交付输出格式");
  const deliverables = list(standard.deliverables, "原始交付物").map(value => ({ ...requirementRecord(value, "交付项") }));
  const masters = deliverables.filter(item => item.item === "video_master");
  if (masters.length !== 1) prdFail("PRD_DELIVERY_INVALID", "原始交付标准必须恰好包含一个视频母版");
  // Agent5's generic commercial template declares HEVC. The native Film
  // compose, disclosure burn and tail sticker path for this delivery uses AVC.
  if (output.container === "MP4" && output.videoCodec === "H.265" && output.audioCodec === "AAC"
    && masters[0]!.spec === "MP4/H.265, 4K" && usesNativeFilmPostTail(profile, authority)) {
    output.videoCodec = "H.264";
  }
  const declared = Object.entries(profile).map(([key, value]) => `${key}=${String(value)}`).join("; ");
  if (profile.resolution) {
    masters[0]!.spec = `${nonempty(output.container, "容器")}/${nonempty(output.videoCodec, "视频编码")}, ${profile.resolution}; ${declared}; delivery declaration, native capability verified separately`;
  } else if (declared) masters[0]!.spec = `${nonempty(masters[0]!.spec, "原始视频交付规格")}; ${declared}`;
  deliverables.push(...declaredDeliveryItems(profile));
  standard.deliverables = deliverables;
  standard.outputFormat = { ...output, ...profile };
  return result;
}

function hasDeliveryPlan(profile: PrdProductionProfile): boolean {
  return ["coverDelivery", "sidecarPolicy", "persistentSubtitleText", "coverIntroSeconds", "postTailOverlayText"]
    .some(key => Object.hasOwn(profile, key));
}

/** These are rule-owned obligations, never a model plan or a completed media receipt. */
function declaredDeliveryItems(profile: PrdProductionProfile): RequirementRecord[] {
  const declared = Object.hasOwn(profile, "sidecarPolicy") || Object.hasOwn(profile, "persistentSubtitleText");
  const items: RequirementRecord[] = [];
  const persistent = profile.persistentSubtitleText === undefined ? ""
    : `全片持续文字${JSON.stringify(profile.persistentSubtitleText)}（实际视频流0秒至末帧，ASS百分秒终点向上取整且最多超出0.01秒）`;
  const persistentOnly = profile.speechPolicy === "none" && persistent !== "" && profile.sidecarPolicy === "dialogue-and-composite-ass";
  const tail = postTailOverlayPlan(profile);
  const layered = `${persistent}与${tail}`;
  const parity = "最终烧录与完整组合ASS核对同一两层的文字、区间、字体、样式、位置和compositionSha256；测量平台安全区、对比度及两层同屏不遮挡";
  if (profile.subtitleMode && ["both", "burned"].includes(profile.subtitleMode)) items.push({ item: "subtitle_burned",
    spec: tail ? `先按原生流程将${persistent}烧录到原生母版，保留其来源和核验；再在本地后期独立叠加${tail}得到最终成片，原生母版和原声不改写。${parity}。无对白或双语字幕；此为待执行交付要求`
      : persistentOnly ? `将${persistent}烧录进本次视频母版；不新增台词字幕。按完整组合ASS同一文字、区间、样式与compositionSha256核验；此为待执行交付要求`
      : !declared ? "字幕烧录进本次视频母版"
      : `将本次台词字幕${persistent ? `及${persistent}` : ""}烧录进本次视频母版；按当前台词、实际总时长、时间线与字体样式核验${profile.sidecarPolicy === "dialogue-and-composite-ass" ? "，并与完整组合ASS使用同一文字、区间、样式与compositionSha256" : ""}；此为待执行交付要求`,
    priority: "required" });
  if (profile.subtitleMode && ["both", "sidecar"].includes(profile.subtitleMode)) items.push({ item: "subtitle_sidecar",
    spec: tail ? `保留原生母版的持续文字ASS和片尾层ASS来源；最终另交付包含${layered}的完整组合ASS（complete-composition）。${parity}。对白SRT/VTT不适用，不生成空对白或双语轨；此为待执行交付要求`
      : persistentOnly ? `交付含${persistent}的完整组合ASS（complete-composition）；零台词时对白SRT/VTT（dialogue-only）不适用，不创建空台词文件。按实际视频、区间与字体样式核验${profile.subtitleMode === "both" ? "，并核对烧录版与ASS的compositionSha256" : ""}；此为待执行交付要求`
      : !declared ? "交付与视频时间线一致的独立字幕文件"
      : profile.sidecarPolicy === "dialogue-and-composite-ass"
        ? `交付仅含台词的SRT/VTT（dialogue-only）与完整组合ASS（complete-composition）；ASS包含本次台词${persistent ? `及${persistent}` : "及本次明确请求的文字层"}，按当前视频、台词、时间线与字体样式核验${profile.subtitleMode === "both" ? "并核对烧录版同一文字、区间、样式与compositionSha256" : ""}；SRT/VTT不能单独证明持续文字交付；此为待执行交付要求`
        : "交付与本次视频台词和时间线一致的SRT/VTT独立字幕文件（dialogue-only）；不将台词侧车当成完整文字组合ASS或持续文字完成凭据；此为待执行交付要求",
    priority: "required" });
  if (tail) items.push({ item: "post_tail_overlay", priority: "required",
    spec: `原生后期母版之后仅在本地叠加${tail}，与${persistent}同时保留，不授权生成画面画字，不另增片段或标题卡。${parity}，并核对成片长度与原声音轨不变；此为待执行交付要求` });
  if (profile.coverDelivery === "standalone") items.push({ item: "cover", priority: "required",
    spec: `PNG或JPEG独立封面图；按本次${profile.aspectRatio ?? "已审"}画幅与${profile.resolution ?? "已审交付"}分辨率交付，来源与当前影片绑定；是否用于片头另依openWithCover声明，本项不启用片头封面；此为待执行交付要求` });
  return items;
}

/** Validate only the rule-owned delivery projection; the native full PRD schema has other legacy seams. */
export function effectivePrdDeliverySchema(schemaValue: RequirementRecord, profile: PrdProductionProfile): RequirementRecord {
  const native = requirementRecord(requirementRecord(requirementRecord(schemaValue.properties, "PRD schema.properties").deliveryStandard,
    "deliveryStandard schema").properties, "deliveryStandard properties");
  const deliverables = structuredClone(requirementRecord(native.deliverables, "deliverables schema"));
  const item = requirementRecord(requirementRecord(requirementRecord(deliverables.items, "deliverable item schema").properties,
    "deliverable item properties").item, "deliverable item enum");
  if (!Array.isArray(item.enum) || item.enum.some(value => typeof value !== "string")
    || !Number.isSafeInteger(deliverables.maxItems) || Number(deliverables.maxItems) < 1) {
    prdFail("PRD_VENDOR_UNAVAILABLE", "原生交付项目枚举或数量边界已变化");
  }
  const additions = declaredDeliveryItems(profile);
  item.enum = [...new Set([...item.enum, ...additions.map(value => value.item)])];
  deliverables.maxItems = Number(deliverables.maxItems) + additions.length;
  const outputFormat = structuredClone(requirementRecord(native.outputFormat, "outputFormat schema"));
  const outputProperties = requirementRecord(outputFormat.properties, "outputFormat properties");
  for (const [key, value] of Object.entries(profile)) outputProperties[key] = { type: typeof value, enum: [value] };
  outputFormat.required = [...new Set([...list(outputFormat.required, "原生输出格式必需字段"), ...Object.keys(profile)])];
  return { type: "object", required: ["deliverables", "outputFormat"],
    properties: { deliverables, outputFormat }, additionalProperties: false };
}

/** Keep the declared rule output intact through native copies, rendering and the actual G4 boundary. */
export function validatePrdDelivery(value: unknown, profile: PrdProductionProfile, schemaValue: RequirementRecord): void {
  if (!hasDeliveryPlan(profile)) return;
  const standard = requirementRecord(requirementRecord(value, "PRD 交付结果").deliveryStandard, "PRD 交付标准");
  validateRequirementSchema({ deliverables: standard.deliverables, outputFormat: standard.outputFormat },
    effectivePrdDeliverySchema(schemaValue, profile), "PRD rule delivery projection");
  const items = list(standard.deliverables, "PRD 交付项目").map(value => requirementRecord(value, "PRD 交付项目"));
  const expected = declaredDeliveryItems(profile);
  if (items.filter(item => item.item === "video_master").length !== 1
    || ["cover", "subtitle_burned", "subtitle_sidecar", "post_tail_overlay"].some(key => {
      const actual = items.filter(item => item.item === key), declared = expected.filter(item => item.item === key);
      return actual.length !== declared.length || actual.some((item, index) => requirementHash(item) !== requirementHash(declared[index]));
    })) prdFail("PRD_DELIVERY_INVALID", "本次独立封面、字幕旁挂或烧录交付要求缺失、重复或被改写");
}

/** The actual response shape, shared by the model prompt and strict host validation. */
export function effectivePrdModelSchema(kind: "creative" | "production", schemaValue: RequirementRecord, contract: RequirementContract): RequirementRecord {
  const properties = requirementRecord(schemaValue.properties, "PRD schema.properties");
  // The native creative agent returns the bare core, then wraps it in its parser.
  if (kind === "creative") return structuredClone(requirementRecord(properties.creativeCore, "creativeCore schema"));
  const modules = ["visualSpecification", "audioSpecification", "characterSystem", "scenePlan"];
  const schema: RequirementRecord = { type: "object", required: modules, properties: Object.fromEntries(modules.map(key => [key, structuredClone(properties[key])])), additionalProperties: false };
  const sceneProperties = requirementRecord(requirementRecord(requirementRecord(schema.properties, "production properties").scenePlan, "scenePlan schema").properties, "scenePlan properties");
  const sceneArray = requirementRecord(sceneProperties.scenes, "scenes schema");
  sceneArray.minItems = contract.scenes.length;
  sceneArray.maxItems = contract.scenes.length;
  const sceneFields = requirementRecord(requirementRecord(sceneArray.items, "scene item schema").properties, "scene item properties");
  delete requirementRecord(sceneFields.purpose, "scene purpose schema").maxLength;
  const characterSchema = requirementRecord(requirementRecord(requirementRecord(schema.properties, "production properties").characterSystem, "characterSystem schema").properties, "character properties");
  const characters = requirementRecord(characterSchema.characters, "characters schema");
  characters.minItems = contract.cast.characters.length;
  characters.maxItems = contract.cast.characters.length;
  return schema;
}

function compactStringArray(value: unknown[], maxLength: number): string[] {
  return value.map((item) => {
    if (typeof item !== "string") return item as unknown as string;
    const normalized = item.replace(/\s+/gu, " ").trim();
    const characters = Array.from(normalized);
    if (characters.length <= maxLength) return normalized;
    let candidate = characters.slice(0, Math.max(1, maxLength - 1)).join("");
    const boundary = Math.max(
      candidate.lastIndexOf("。"),
      candidate.lastIndexOf("；"),
      candidate.lastIndexOf("."),
      candidate.lastIndexOf("!"),
      candidate.lastIndexOf("?"),
    );
    if (boundary >= Math.floor(maxLength * 0.5)) candidate = candidate.slice(0, boundary + 1);
    return `${candidate.replace(/[\s,，;；:：]+$/u, "")}…`;
  });
}

function compactNamedStringArray(record: RequirementRecord, key: string, maxItems: number): void {
  const value = record[key];
  if (!Array.isArray(value) || value.length <= maxItems || !value.every((entry) => typeof entry === "string")) return;
  if (maxItems <= 0) {
    record[key] = [];
    return;
  }
  const head = value.slice(0, Math.max(0, maxItems - 1)) as string[];
  const tail = value.slice(Math.max(0, maxItems - 1)) as string[];
  record[key] = [...head, `补充要求：${tail.join("；")}`];
}

/**
 * Compact only free-text execution lists whose excess cardinality is a schema
 * presentation issue. References, deliverables and cast arrays remain hard
 * failures because their cardinality carries semantic/authority meaning.
 */
function compactProductionExecutionArrays(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const production = value as RequirementRecord;
  const scenePlan = production.scenePlan && typeof production.scenePlan === "object" && !Array.isArray(production.scenePlan)
    ? production.scenePlan as RequirementRecord
    : null;
  if (Array.isArray(scenePlan?.scenes)) {
    for (const scene of scenePlan.scenes) {
      if (!scene || typeof scene !== "object" || Array.isArray(scene)) continue;
      compactNamedStringArray(scene as RequirementRecord, "keyProps", 5);
      compactNamedStringArray(scene as RequirementRecord, "visualRequirements", 5);
      compactNamedStringArray(scene as RequirementRecord, "audioRequirements", 5);
    }
  }
  const constraints = production.productionConstraints && typeof production.productionConstraints === "object" && !Array.isArray(production.productionConstraints)
    ? production.productionConstraints as RequirementRecord
    : null;
  if (constraints) {
    compactNamedStringArray(constraints, "technicalConstraints", 5);
    compactNamedStringArray(constraints, "businessConstraints", 3);
    compactNamedStringArray(constraints, "forbiddenElements", 5);
  }
}

/**
 * Agent3 occasionally decorates a valid cast object with undeclared metadata.
 * The effective schema is authoritative and downstream cannot consume those
 * keys. Remove a small bounded set, while retaining every declared field and
 * failing closed on a wholesale shape rewrite.
 */
export function projectUndeclaredPrdCharacterFields(value: RequirementRecord, effectiveSchema: RequirementRecord): string[] {
  const properties = requirementRecord(effectiveSchema.properties, "生产规格 schema 字段");
  const characterSystem = requirementRecord(requirementRecord(properties.characterSystem, "characterSystem schema").properties,
    "characterSystem schema 字段");
  const characterSchema = requirementRecord(requirementRecord(characterSystem.characters, "characters schema").items,
    "character item schema");
  const allowed = new Set(Object.keys(requirementRecord(characterSchema.properties, "character item schema 字段")));
  const characterSystemValue = requirementRecord(value.characterSystem, "PRD characterSystem");
  if (!Array.isArray(characterSystemValue.characters)) prdFail("PRD_CHARACTER_SHAPE_INVALID", "characterSystem.characters 必须是数组");
  const removed: string[] = [];
  for (const [index, raw] of characterSystemValue.characters.entries()) {
    const character = requirementRecord(raw, `characterSystem.characters/${index}`);
    const extras = Object.keys(character).filter(key => !allowed.has(key));
    if (extras.length > 8) {
      prdFail("PRD_CHARACTER_SHAPE_INVALID", `characterSystem.characters/${index} 有过多未声明字段`);
    }
    for (const key of extras) {
      delete character[key];
      removed.push(`/characterSystem/characters/${index}/${key}`);
    }
  }
  return removed;
}

/**
 * Agent3 can also decorate visualSpecification with a few undeclared keys.
 * The effective schema remains authoritative, so remove only a bounded number
 * of top-level extras and retain every declared nested field unchanged.
 */
export function projectUndeclaredPrdVisualFields(value: RequirementRecord, effectiveSchema: RequirementRecord): string[] {
  const properties = requirementRecord(effectiveSchema.properties, "生产规格 schema 字段");
  const visualSchema = requirementRecord(properties.visualSpecification, "visualSpecification schema");
  const allowed = new Set(Object.keys(requirementRecord(visualSchema.properties, "visualSpecification schema 字段")));
  const visual = requirementRecord(value.visualSpecification, "PRD visualSpecification");
  const extras = Object.keys(visual).filter(key => !allowed.has(key));
  if (extras.length > 8) prdFail("PRD_VISUAL_SHAPE_INVALID", "visualSpecification 有过多未声明字段");
  for (const key of extras) delete visual[key];
  return extras.map(key => `/visualSpecification/${key}`);
}

/** Validate the actual model payload before vendor parsers can manufacture missing modules. */
export function validatePrdModelPayload(value: unknown, kind: "creative" | "production", schemaValue: RequirementRecord, contract: RequirementContract, profile: PrdProductionProfile): RequirementRecord {
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    const clean = parsed.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    try { parsed = JSON.parse(clean); }
    catch { prdFail("PRD_RESPONSE_UNVERIFIED", "本次模型响应不是完整 JSON"); }
  }
  const result = structuredClone(requirementRecord(parsed, "PRD 模型真实响应"));
  const effective = effectivePrdModelSchema(kind, schemaValue, contract);
  if (kind === "creative") {
    const properties = requirementRecord(effective.properties, "creativeCore properties");
    const keyMessagesSchema = requirementRecord(requirementRecord(properties.keyMessages, "keyMessages schema").items, "keyMessages item schema");
    const maxLength = Number(keyMessagesSchema.maxLength);
    if (Array.isArray(result.keyMessages) && Number.isSafeInteger(maxLength) && maxLength > 0) {
      result.keyMessages = compactStringArray(result.keyMessages, maxLength);
    }
  } else {
    compactProductionExecutionArrays(result);
    projectUndeclaredPrdCharacterFields(result, effective);
    projectUndeclaredPrdVisualFields(result, effective);
  }
  // Retain the existing creative validation path and acceptance semantics.
  const schema = kind === "creative"
    ? { type: "object", required: ["creativeCore"], properties: { creativeCore: effective }, additionalProperties: false }
    : effective;
  validateRequirementSchema(kind === "creative" ? { creativeCore: result } : result, schema, `PRD ${kind} response`);
  if (kind === "production") validatePrdProduction(result, contract, profile);
  return result;
}

/** No scene-duration projection or creative repair is allowed here. */
export function validatePrdProduction(value: unknown, contract: RequirementContract, profile: PrdProductionProfile): void {
  const result = requirementRecord(value, "PRD 制作规格");
  const scenes = list(requirementRecord(result.scenePlan, "PRD scenePlan").scenes, "PRD scenes").map(value => requirementRecord(value, "PRD scene"));
  const sceneTolerance = profile.durationToleranceFrames !== undefined && profile.frameRate !== undefined
    ? profile.durationToleranceFrames / profile.frameRate
    : 0;
  if (scenes.length !== contract.scenes.length || scenes.some((scene, index) => {
    const original = contract.scenes[index]!;
    return scene.sceneId !== original.id || scene.sequence !== index + 1 || typeof scene.duration !== "number"
      || !Number.isSafeInteger(scene.duration) || scene.duration <= 0
      || Math.abs(scene.duration - original.duration) > sceneTolerance + 1e-9;
  }) || (profile.targetDuration !== undefined && !(
    Math.abs(scenes.reduce((total, scene) => total + Number(scene.duration), 0) - profile.targetDuration)
      <= Math.max(sceneTolerance, TARGET_DURATION_TOLERANCE_SECONDS) + 1e-9
  ))) {
    prdFail("PRD_SCENE_DURATION_CONFLICT", "模型场景节点、顺序或时长未继承本次已审 G3，拒绝改写为凑齐目标");
  }
  const characters = list(requirementRecord(result.characterSystem, "PRD characterSystem").characters, "PRD characters").map(value => requirementRecord(value, "PRD character"));
  if (characters.length !== contract.cast.characters.length || new Set(characters.map(character => character.characterId)).size !== characters.length
    || contract.cast.characters.some(selected => !characters.some(character => character.characterId === selected.id && character.name === selected.name))) {
    prdFail("PRD_CAST_CONFLICT", "PRD 模型人物不属于本次宿主选角合同");
  }
  const mapping = list(requirementRecord(result.scenePlan, "PRD scenePlan").shotMapping, "PRD shotMapping").map(value => requirementRecord(value, "shotMapping item"));
  if (mapping.length !== scenes.length || mapping.some((item, index) => item.sceneId !== scenes[index]?.sceneId)) {
    prdFail("PRD_SCENE_UNVERIFIED", "PRD shotMapping 未逐项绑定真实场景");
  }
}

/** Carry source/version anchors as provenance; their existence never constitutes G5 approval. */
export function bindPrdProvenance(value: unknown, authority: PrdAuthority, contract: RequirementContract): RequirementRecord {
  const result = structuredClone(requirementRecord(value, "PRD 最终结果"));
  validatePrdProduction(result, contract, authority.profile);
  const system = requirementRecord(result.characterSystem, "PRD characterSystem");
  system.characters = list(system.characters, "PRD characters").map(value => {
    const character = requirementRecord(value, "PRD character");
    const selected = contract.cast.characters.find(item => item.id === character.characterId)!;
    return { ...character, _workloomCharacterSource: structuredClone(selected),
      _workloomCharacterSelection: structuredClone(contract.cast.selection) };
  });
  const scenePlan = requirementRecord(result.scenePlan, "PRD scenePlan");
  scenePlan.scenes = list(scenePlan.scenes, "PRD scenes").map((value, index) => ({
    ...requirementRecord(value, "PRD scene"), _workloomRequirementScene: structuredClone(contract.scenes[index])
  }));
  result._workloomRequirementContract = structuredClone(contract);
  const audienceProfile = requirementRecord(result.audienceProfile, "PRD 受众模型输出");
  audienceProfile._workloomAudienceAuthority = {
    schemaVersion: "workloom.prd-audience-authority/v1", customerOriginal: contract.ownerAudience,
    modelStatus: "model-hypothesis", boundary: "模型年龄、性别和兴趣细分不覆盖客户原文，不构成已核实市场事实，仍由本次G4独立评审"
  };
  result._workloomPrdAuthority = {
    schemaVersion: "workloom.prd-authority/v1", status: "ready-for-g4", profile: structuredClone(authority.profile),
    scope: structuredClone(authority.marketing.scope), g1: { path: authority.marketing.g1Artifact.path, sha256: authority.marketing.g1Artifact.sha256 },
    requirementContractHash: contract.hash, castHash: contract.cast.hash,
    scenePlanHash: requirementHash(result.scenePlan), characterSystemHash: requirementHash(result.characterSystem)
  };
  return result;
}
