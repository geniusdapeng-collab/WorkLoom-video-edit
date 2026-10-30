/**
 * Bullet-time shot contract.
 *
 * This module deliberately separates subject time from camera time. A frozen
 * subject with a moving camera is valid only when an explicit, source-bound
 * bulletTime contract declares both layers, a single continuous shot, entry
 * and exit action, a bounded orbit and an audio policy.
 */
import { createHash } from "node:crypto";

export const BULLET_TIME_SCHEMA_VERSION = "workloom.video-studio/bullet-time/v1" as const;
export const BULLET_TIME_POLICY_VERSION = "workloom.video-studio/bullet-time-policy/v1" as const;
export const BULLET_TIME_META_KEY = "_bulletTimeCompilation" as const;
export const BULLET_TIME_PROMPT_MAX_CHARS = 3000;
export const BULLET_TIME_PROMPT_MIN_CHARS = 1200;

export type BulletTimeInputMode = "text" | "first-frame" | "reference-image" | "reference-video";
export type BulletTimeSubjectTime = "freeze" | "near_freeze";
export type BulletTimeMode = "freeze_orbit";

export interface BulletTimeMotionLayers {
  face: string;
  body: string;
  hairTips: string;
  fabricHem: string;
  background: string;
  ambientParticles: string;
  props?: string;
}

export interface BulletTimeContract {
  schemaVersion: typeof BULLET_TIME_SCHEMA_VERSION;
  enabled: true;
  mode: BulletTimeMode;
  narrative: {
    purpose: string;
    whyNotNormalCut: string;
    viewerTakeaway: string;
  };
  time: {
    subjectTime: BulletTimeSubjectTime;
    subjectTimeRange: { start: number; end: number };
    entrySeconds: number;
    exitSeconds: number;
    timeReturn: "smooth" | "cut";
    motionLayers: BulletTimeMotionLayers;
  };
  camera: {
    movement: "continuous_orbit";
    direction: "clockwise" | "counterclockwise";
    startView: string;
    endView: string;
    approxArcDegrees: number;
    height: string;
    speed: "slow_constant" | "slow_variable";
    cuts: 0;
    focusBehavior: string;
    narrativeReveal: string;
  };
  generation: {
    inputMode: BulletTimeInputMode;
    durationSeconds: number;
    maxContinuousOrbit: number;
    characterReferenceSet: string[];
    previsReference?: {
      requested: boolean;
      purpose: "camera_and_timing_only";
    };
  };
  entryExit: {
    entryAction: string;
    exitAction: string;
    exitMustMatchNextShot: boolean;
  };
  quality: {
    mustBePhotoreal: boolean;
    mustPreserveIdentity: boolean;
    mustPreserveWardrobe: boolean;
    mustPreservePropState: boolean;
    mustHaveRealParallax: boolean;
    mustHaveSubjectNearFreeze: boolean;
    mustHaveLayerMicroMotion: boolean;
    mustNotContainBgm: boolean;
  };
  audioPolicy: "diegetic_only" | "scene_music_allowed" | "specified_separately";
  fallback: {
    ifNoContinuousOrbit: "guided_orbit" | "segmented_orbit";
    ifNoModelSupport: "editorial_fake" | "block";
    mustRelabelInUi: true;
  };
}

export interface BulletTimeCapabilities {
  durationSeconds: { min: number; max: number };
  maxReferenceImages: number;
  supportedInputModes: BulletTimeInputMode[];
  supportsReferenceVideo: boolean;
}

/** Conservative first-pass capability set. The model catalog may widen the limits. */
export const CONSERVATIVE_BULLET_TIME_CAPABILITIES: BulletTimeCapabilities = {
  durationSeconds: { min: 4, max: 30 },
  maxReferenceImages: 4,
  supportedInputModes: ["text", "first-frame", "reference-image"],
  supportsReferenceVideo: false,
};

export interface BulletTimeIssue {
  code: string;
  path: string;
  detail: string;
}

export interface BulletTimeValidation {
  enabled: boolean;
  valid: boolean;
  policy: typeof BULLET_TIME_POLICY_VERSION;
  contract: BulletTimeContract | null;
  contractHash: string | null;
  issues: BulletTimeIssue[];
}

export interface BulletTimeMotionInspection extends BulletTimeValidation {
  subjectFrozen: boolean;
  cameraMoving: boolean;
  motionException: boolean;
}

export interface BulletTimeReferencePlan {
  applicable: boolean;
  valid: boolean;
  inputMode: BulletTimeInputMode | null;
  angles: string[];
  maxImages: number;
  issues: BulletTimeIssue[];
}

export interface BulletTimePromptCheck {
  id: string;
  pass: boolean;
  detail: string;
}

export interface BulletTimePromptAudit {
  applicable: boolean;
  pass: boolean;
  contractHash: string | null;
  checks: BulletTimePromptCheck[];
  issues: string[];
}

type Card = Record<string, unknown>;
const sha256 = (value: unknown): string => createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
const plain = (value: unknown): value is Card => Boolean(value && typeof value === "object" && !Array.isArray(value));
const nonempty = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim()) && !/[\u0000-\u001f\u007f]/.test(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!plain(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function contractCandidate(card: Card): unknown {
  if (card.bulletTime !== undefined) return card.bulletTime;
  const fields = plain(card.fields) ? card.fields : {};
  return fields.bulletTime;
}

function validCapabilities(value: BulletTimeCapabilities): boolean {
  return Number.isInteger(value.durationSeconds.min)
    && Number.isInteger(value.durationSeconds.max)
    && value.durationSeconds.min >= 1
    && value.durationSeconds.max >= value.durationSeconds.min
    && Number.isInteger(value.maxReferenceImages)
    && value.maxReferenceImages >= 1
    && Array.isArray(value.supportedInputModes)
    && value.supportedInputModes.length > 0
    && typeof value.supportsReferenceVideo === "boolean";
}

/**
 * Validate only declared facts. Missing or contradictory information never
 * receives a default that could turn a normal lock-off shot into bullet time.
 */
export function validateBulletTimeContract(
  value: unknown,
  options: { shot?: Card; capabilities?: BulletTimeCapabilities } = {},
): BulletTimeValidation {
  const issues: BulletTimeIssue[] = [];
  const add = (code: string, path: string, detail: string): void => { issues.push({ code, path, detail }); };
  if (value === undefined || value === null) {
    return { enabled: false, valid: false, policy: BULLET_TIME_POLICY_VERSION, contract: null, contractHash: null, issues };
  }
  if (!plain(value)) {
    add("BULLET_TIME_OBJECT_REQUIRED", "bulletTime", "bulletTime must be an object");
    return { enabled: true, valid: false, policy: BULLET_TIME_POLICY_VERSION, contract: null, contractHash: null, issues };
  }
  if (value.enabled === false) {
    return { enabled: false, valid: true, policy: BULLET_TIME_POLICY_VERSION, contract: null, contractHash: null, issues };
  }
  if (value.enabled !== true) add("BULLET_TIME_ENABLED_REQUIRED", "bulletTime.enabled", "enabled must be explicit true or false");
  if (value.schemaVersion !== BULLET_TIME_SCHEMA_VERSION) add("BULLET_TIME_SCHEMA_UNSUPPORTED", "bulletTime.schemaVersion", `expected ${BULLET_TIME_SCHEMA_VERSION}`);
  if (value.mode !== "freeze_orbit") add("BULLET_TIME_MODE_UNSUPPORTED", "bulletTime.mode", "mode must be freeze_orbit");

  const narrative = plain(value.narrative) ? value.narrative : {};
  for (const key of ["purpose", "whyNotNormalCut", "viewerTakeaway"] as const) {
    if (!nonempty(narrative[key])) add("BULLET_TIME_NARRATIVE_MISSING", `bulletTime.narrative.${key}`, `${key} is required`);
  }

  const time = plain(value.time) ? value.time : {};
  const subjectTime = time.subjectTime;
  if (subjectTime !== "freeze" && subjectTime !== "near_freeze") {
    add("BULLET_TIME_SUBJECT_TIME_UNSUPPORTED", "bulletTime.time.subjectTime", "subjectTime must be freeze or near_freeze");
  }
  const range = plain(time.subjectTimeRange) ? time.subjectTimeRange : {};
  const rangeStart = finite(range.start) ? range.start : NaN;
  const rangeEnd = finite(range.end) ? range.end : NaN;
  if (!(rangeStart >= 0 && rangeEnd > rangeStart)) {
    add("BULLET_TIME_RANGE_INVALID", "bulletTime.time.subjectTimeRange", "subjectTimeRange requires 0 <= start < end");
  }
  if (!(finite(time.entrySeconds) && time.entrySeconds > 0)) add("BULLET_TIME_ENTRY_SECONDS_INVALID", "bulletTime.time.entrySeconds", "entrySeconds must be positive");
  if (!(finite(time.exitSeconds) && time.exitSeconds > 0)) add("BULLET_TIME_EXIT_SECONDS_INVALID", "bulletTime.time.exitSeconds", "exitSeconds must be positive");
  if (time.timeReturn !== "smooth" && time.timeReturn !== "cut") add("BULLET_TIME_RETURN_INVALID", "bulletTime.time.timeReturn", "timeReturn must be smooth or cut");
  const layers = plain(time.motionLayers) ? time.motionLayers : {};
  for (const key of ["face", "body", "hairTips", "fabricHem", "background", "ambientParticles"] as const) {
    if (!nonempty(layers[key])) add("BULLET_TIME_MOTION_LAYER_MISSING", `bulletTime.time.motionLayers.${key}`, `${key} must declare its time layer`);
  }
  if ((subjectTime === "freeze" || subjectTime === "near_freeze") && (layers.face !== "locked" || layers.body !== "locked")) {
    add("BULLET_TIME_FROZEN_BODY_CONTRADICTION", "bulletTime.time.motionLayers", "frozen/near-frozen subject requires face and body locked");
  }
  if (layers.props !== undefined && !nonempty(layers.props)) add("BULLET_TIME_PROP_LAYER_INVALID", "bulletTime.time.motionLayers.props", "props must be a nonempty layer when declared");

  const camera = plain(value.camera) ? value.camera : {};
  if (camera.movement !== "continuous_orbit") add("BULLET_TIME_CAMERA_MOVEMENT_INVALID", "bulletTime.camera.movement", "movement must be continuous_orbit");
  if (camera.direction !== "clockwise" && camera.direction !== "counterclockwise") add("BULLET_TIME_CAMERA_DIRECTION_INVALID", "bulletTime.camera.direction", "direction must be clockwise or counterclockwise");
  for (const key of ["startView", "endView", "height", "focusBehavior", "narrativeReveal"] as const) {
    if (!nonempty(camera[key])) add("BULLET_TIME_CAMERA_DETAIL_MISSING", `bulletTime.camera.${key}`, `${key} is required`);
  }
  if (!(finite(camera.approxArcDegrees) && camera.approxArcDegrees > 0 && camera.approxArcDegrees <= 180)) {
    add("BULLET_TIME_ARC_INVALID", "bulletTime.camera.approxArcDegrees", "one-pass orbit must be greater than 0 and no more than 180 degrees");
  }
  if (camera.speed !== "slow_constant" && camera.speed !== "slow_variable") add("BULLET_TIME_CAMERA_SPEED_INVALID", "bulletTime.camera.speed", "speed must be slow_constant or slow_variable");
  if (camera.cuts !== 0) add("BULLET_TIME_CUTS_REQUIRED_ZERO", "bulletTime.camera.cuts", "continuous bullet-time shot must declare zero cuts");

  const capabilities = options.capabilities ?? CONSERVATIVE_BULLET_TIME_CAPABILITIES;
  if (!validCapabilities(capabilities)) add("BULLET_TIME_CAPABILITIES_INVALID", "capabilities", "model capability contract is invalid");
  const generation = plain(value.generation) ? value.generation : {};
  const inputMode = generation.inputMode as BulletTimeInputMode;
  if (!["text", "first-frame", "reference-image", "reference-video"].includes(inputMode)) {
    add("BULLET_TIME_INPUT_MODE_INVALID", "bulletTime.generation.inputMode", "inputMode is unsupported");
  } else if (!capabilities.supportedInputModes.includes(inputMode)) {
    add("BULLET_TIME_INPUT_MODE_UNAVAILABLE", "bulletTime.generation.inputMode", `${inputMode} is not supported by the selected model`);
  }
  const duration = generation.durationSeconds;
  if (!Number.isInteger(duration) || Number(duration) < capabilities.durationSeconds.min || Number(duration) > capabilities.durationSeconds.max) {
    add("BULLET_TIME_DURATION_UNSUPPORTED", "bulletTime.generation.durationSeconds", `duration must be an integer ${capabilities.durationSeconds.min}-${capabilities.durationSeconds.max}`);
  }
  if (Number.isFinite(rangeStart) && Number.isFinite(rangeEnd) && Number.isFinite(duration)
    && rangeEnd > Number(duration)) add("BULLET_TIME_RANGE_EXCEEDS_DURATION", "bulletTime.time.subjectTimeRange.end", "freeze range exceeds generation duration");
  if (finite(time.entrySeconds) && finite(time.exitSeconds) && finite(duration)
    && time.entrySeconds + time.exitSeconds >= Number(duration)) add("BULLET_TIME_NO_FREEZE_WINDOW", "bulletTime.time", "entry and exit consume the full generation duration");
  if (!(finite(generation.maxContinuousOrbit) && generation.maxContinuousOrbit > 0 && generation.maxContinuousOrbit <= 180)) {
    add("BULLET_TIME_MAX_ORBIT_INVALID", "bulletTime.generation.maxContinuousOrbit", "maxContinuousOrbit must be 1-180 degrees");
  } else if (finite(camera.approxArcDegrees) && camera.approxArcDegrees > generation.maxContinuousOrbit) {
    add("BULLET_TIME_ORBIT_EXCEEDS_DECLARED_LIMIT", "bulletTime.camera.approxArcDegrees", "requested arc exceeds maxContinuousOrbit");
  }
  const refs = generation.characterReferenceSet;
  if (!Array.isArray(refs) || refs.some((item) => !/^[A-Za-z][A-Za-z0-9-]*$/.test(String(item)))) {
    add("BULLET_TIME_REFERENCE_SET_INVALID", "bulletTime.generation.characterReferenceSet", "reference set must contain angle labels");
  } else {
    if (new Set(refs).size !== refs.length) add("BULLET_TIME_REFERENCE_DUPLICATE", "bulletTime.generation.characterReferenceSet", "reference angles must be unique");
    if (refs.length > capabilities.maxReferenceImages) add("BULLET_TIME_REFERENCE_LIMIT", "bulletTime.generation.characterReferenceSet", `reference set exceeds model limit ${capabilities.maxReferenceImages}`);
    if (inputMode === "reference-image" && refs.length === 0) add("BULLET_TIME_REFERENCE_EMPTY", "bulletTime.generation.characterReferenceSet", "reference-image mode requires at least one source image");
    if (inputMode === "text" && refs.length > 0) add("BULLET_TIME_REFERENCE_MODE_MISMATCH", "bulletTime.generation.characterReferenceSet", "text mode must not silently ignore reference images");
  }
  const previs = generation.previsReference;
  if (previs !== undefined) {
    if (!plain(previs) || typeof previs.requested !== "boolean" || previs.purpose !== "camera_and_timing_only") {
      add("BULLET_TIME_PREVIS_INVALID", "bulletTime.generation.previsReference", "previsReference requires requested and camera_and_timing_only purpose");
    } else if (previs.requested && (!capabilities.supportsReferenceVideo || inputMode !== "reference-video")) {
      add("BULLET_TIME_PREVIS_UNAVAILABLE", "bulletTime.generation.previsReference", "reference video requested without a compatible input capability");
    }
  }

  const entryExit = plain(value.entryExit) ? value.entryExit : {};
  if (!nonempty(entryExit.entryAction)) add("BULLET_TIME_ENTRY_ACTION_MISSING", "bulletTime.entryExit.entryAction", "entryAction is required");
  if (!nonempty(entryExit.exitAction)) add("BULLET_TIME_EXIT_ACTION_MISSING", "bulletTime.entryExit.exitAction", "exitAction is required");
  if (typeof entryExit.exitMustMatchNextShot !== "boolean") add("BULLET_TIME_EXIT_MATCH_INVALID", "bulletTime.entryExit.exitMustMatchNextShot", "exitMustMatchNextShot must be explicit");

  const quality = plain(value.quality) ? value.quality : {};
  for (const key of ["mustBePhotoreal", "mustPreserveIdentity", "mustPreserveWardrobe", "mustPreservePropState", "mustHaveRealParallax", "mustHaveSubjectNearFreeze", "mustHaveLayerMicroMotion", "mustNotContainBgm"] as const) {
    if (typeof quality[key] !== "boolean") add("BULLET_TIME_QUALITY_FLAG_INVALID", `bulletTime.quality.${key}`, `${key} must be explicit boolean`);
  }
  if (quality.mustHaveLayerMicroMotion === true) {
    const secondaryMotion = [layers.hairTips, layers.fabricHem, layers.ambientParticles, layers.props].some((layer) => layer && layer !== "locked" && layer !== "not_applicable");
    if (!secondaryMotion) add("BULLET_TIME_LAYER_MOTION_MISSING", "bulletTime.time.motionLayers", "quality requires at least one declared secondary motion layer");
  }
  if (!["diegetic_only", "scene_music_allowed", "specified_separately"].includes(String(value.audioPolicy))) {
    add("BULLET_TIME_AUDIO_POLICY_INVALID", "bulletTime.audioPolicy", "audioPolicy is required");
  }
  if (quality.mustNotContainBgm === true && value.audioPolicy !== "diegetic_only") {
    add("BULLET_TIME_AUDIO_CONTRADICTION", "bulletTime.audioPolicy", "mustNotContainBgm requires diegetic_only audio");
  }

  const fallback = plain(value.fallback) ? value.fallback : {};
  if (fallback.ifNoContinuousOrbit !== "guided_orbit" && fallback.ifNoContinuousOrbit !== "segmented_orbit") {
    add("BULLET_TIME_FALLBACK_INVALID", "bulletTime.fallback.ifNoContinuousOrbit", "fallback must stay within guided_orbit or segmented_orbit");
  }
  if (fallback.ifNoModelSupport !== "editorial_fake" && fallback.ifNoModelSupport !== "block") {
    add("BULLET_TIME_FALLBACK_INVALID", "bulletTime.fallback.ifNoModelSupport", "fallback must relabel editorial_fake or block");
  }
  if (fallback.mustRelabelInUi !== true) add("BULLET_TIME_FALLBACK_LABEL_REQUIRED", "bulletTime.fallback.mustRelabelInUi", "degraded effects must be relabelled in UI");

  const valid = issues.length === 0;
  const frozen = valid ? JSON.parse(JSON.stringify(value)) as BulletTimeContract : null;
  return {
    enabled: true,
    valid,
    policy: BULLET_TIME_POLICY_VERSION,
    contract: frozen,
    contractHash: frozen ? sha256(frozen) : null,
    issues,
  };
}

export function inspectBulletTimeMotion(card: Card, capabilities?: BulletTimeCapabilities): BulletTimeMotionInspection {
  const validation = validateBulletTimeContract(contractCandidate(card), { shot: card, capabilities });
  const subjectFrozen = validation.contract?.time.subjectTime === "freeze" || validation.contract?.time.subjectTime === "near_freeze";
  const cameraMoving = validation.contract?.camera.movement === "continuous_orbit" && validation.contract.camera.cuts === 0;
  return {
    ...validation,
    subjectFrozen,
    cameraMoving,
    motionException: validation.valid && subjectFrozen && cameraMoving,
  };
}

export function bulletTimeReferencePlan(card: Card, capabilities?: BulletTimeCapabilities): BulletTimeReferencePlan {
  const validation = validateBulletTimeContract(contractCandidate(card), { shot: card, capabilities });
  const maxImages = (capabilities ?? CONSERVATIVE_BULLET_TIME_CAPABILITIES).maxReferenceImages;
  if (!validation.enabled) return { applicable: false, valid: true, inputMode: null, angles: [], maxImages, issues: [] };
  return {
    applicable: true,
    valid: validation.valid,
    inputMode: validation.contract?.generation.inputMode ?? null,
    angles: validation.contract?.generation.characterReferenceSet.slice(0, maxImages) ?? [],
    maxImages,
    issues: validation.issues,
  };
}

function cleanContribution(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function appendClause(existing: unknown, clause: string): string {
  const current = cleanContribution(existing);
  return current ? `${current}；${clause}` : clause;
}

function stripOwnedContributions(card: Card): { card: Card; error?: string } {
  const meta = plain(card[BULLET_TIME_META_KEY]) ? card[BULLET_TIME_META_KEY] as Card : null;
  if (!meta) return { card: { ...card } };
  const fields = plain(meta.fields) ? meta.fields : {};
  const next = { ...card };
  for (const [field, raw] of Object.entries(fields)) {
    const contribution = cleanContribution(raw);
    if (!contribution) return { card: { ...card }, error: "BULLET_TIME_OWNED_CONTRIBUTION_INVALID" };
    const current = typeof next[field] === "string" ? next[field] as string : "";
    if (!current.includes(contribution)) return { card: { ...card }, error: `BULLET_TIME_OWNED_CONTRIBUTION_CHANGED:${field}` };
    next[field] = current.replace(contribution, "").replace(/[；\s]+$/u, "").trim();
  }
  delete next[BULLET_TIME_META_KEY];
  return { card: next };
}

function ownedContributionsIntact(card: Card, meta: Card): boolean {
  const fields = plain(meta.fields) ? meta.fields : {};
  return Object.entries(fields).every(([field, raw]) => {
    const contribution = cleanContribution(raw);
    return Boolean(contribution) && typeof card[field] === "string" && String(card[field]).includes(contribution);
  });
}

function orbitLanguage(degrees: number): string {
  if (degrees <= 45) return "约八分之一圈";
  if (degrees <= 90) return "约四分之一圈";
  if (degrees <= 120) return "约三分之一圈";
  return "接近半圈";
}

function motionLayerClause(layers: BulletTimeMotionLayers): string {
  const label = (value: string): string => value === "very_slow" ? "极慢" : value === "not_applicable" ? "不适用" : value === "locked" ? "锁定" : value;
  return [
    `面部${label(layers.face)}`,
    `身体${label(layers.body)}`,
    `发梢${label(layers.hairTips)}`,
    `衣摆${label(layers.fabricHem)}`,
    `背景${label(layers.background)}`,
    `粒子${label(layers.ambientParticles)}`,
    ...(layers.props ? [`道具${label(layers.props)}`] : []),
  ].join("；");
}

/**
 * Compile the portable contract into existing 25-field content. No parallel
 * vendor field is added and repeated compilation is byte-stable.
 */
export function compileBulletTimeShot(
  card: Card,
  options: { capabilities?: BulletTimeCapabilities } = {},
): { card: Card; validation: BulletTimeValidation; changed: boolean; error: string | null } {
  const initial = validateBulletTimeContract(contractCandidate(card), { shot: card, capabilities: options.capabilities });
  if (!initial.enabled) return { card: { ...card }, validation: initial, changed: false, error: null };
  if (!initial.valid || !initial.contract || !initial.contractHash) {
    return { card: { ...card }, validation: initial, changed: false, error: initial.issues[0]?.code ?? "BULLET_TIME_CONTRACT_INVALID" };
  }
  const existing = plain(card[BULLET_TIME_META_KEY]) ? card[BULLET_TIME_META_KEY] as Card : null;
  if (existing?.contractHash === initial.contractHash) {
    if (!ownedContributionsIntact(card, existing)) {
      return { card: { ...card }, validation: initial, changed: false, error: "BULLET_TIME_OWNED_CONTRIBUTION_CHANGED" };
    }
    return { card: { ...card }, validation: initial, changed: false, error: null };
  }
  const stripped = stripOwnedContributions(card);
  if (stripped.error) return { card: { ...card }, validation: initial, changed: false, error: stripped.error };

  const contract = initial.contract;
  const short = initial.contractHash.slice(0, 12);
  const marker = `【子弹时间 ${short}】`;
  const entry = Number(contract.time.entrySeconds);
  const end = Number(contract.time.subjectTimeRange.end);
  const duration = Number(contract.generation.durationSeconds);
  const exitEnd = Math.min(duration, end + Number(contract.time.exitSeconds));
  const contributions: Record<string, string> = {
    director_instruction: `${marker}${contract.narrative.purpose}；观众感受：${contract.narrative.viewerTakeaway}。`,
    constraint: `${marker}单镜连续生成，无切点，无镜头重置；主体时间与摄影机时间分层。`,
    composition: `${marker}起幅${contract.camera.startView}，落幅${contract.camera.endView}，保留真实空间视差。`,
    camera_movement: `${marker}一个单镜连续镜头，无切点；摄影机从${contract.camera.startView}向${contract.camera.endView}${contract.camera.direction === "clockwise" ? "顺时针" : "逆时针"}缓慢环绕，${orbitLanguage(contract.camera.approxArcDegrees)}，${contract.camera.height}，${contract.camera.speed === "slow_constant" ? "匀速" : "连续缓变"}；保持${contract.camera.focusBehavior}。`,
    action: `${marker}主体时间${contract.time.subjectTime === "freeze" ? "冻结" : "近冻结"}：${motionLayerClause(contract.time.motionLayers)}。`,
    timeline: `${marker}0至${entry.toFixed(2)}秒入场；${contract.time.subjectTimeRange.start.toFixed(2)}至${end.toFixed(2)}秒主体${contract.time.subjectTime === "freeze" ? "冻结" : "近冻结"}并持续环绕；${end.toFixed(2)}至${exitEnd.toFixed(2)}秒平滑恢复并完成出口动作。`,
    pacing: `${marker}主体正常、压慢、${contract.time.subjectTime === "freeze" ? "冻结" : "近冻结"}、恢复；摄影机全程不停。`,
    transition: `${marker}入口动作：${contract.entryExit.entryAction}；出口动作：${contract.entryExit.exitAction}。`,
    audio: `${marker}${contract.audioPolicy === "diegetic_only" ? "只保留画内动作声、布料、脚步与空气声；不添加镜头外音乐、BGM或配乐。" : "按独立音频合同执行。"} `,
    negative: `${marker}无切点，无重置，无跳位，无二维假环绕，无人物自转替代环绕，无静帧冒充，无换脸，无换装，无肢体增生，无背景漂移，无镜头外BGM。`,
    character_constraint: `${marker}冻结窗口锁定主体、身份和道具接触关系，禁止分身。`,
    consistency: `${marker}保持同一身份、服装、发型、光源、轴向和道具状态；不得改成主体主动转向。`,
    portraits: contract.generation.inputMode === "reference-image"
      ? `${marker}参考图顺序：${contract.generation.characterReferenceSet.join("、")}；只锁身份、造型和材质，不提供场景或运镜。`
      : `${marker}输入模式：${contract.generation.inputMode}；不得伪造未提交素材。`,
  };
  const result = { ...stripped.card };
  for (const [field, contribution] of Object.entries(contributions)) result[field] = appendClause(result[field], contribution);
  result[BULLET_TIME_META_KEY] = {
    schemaVersion: "workloom.video-studio/bullet-time-compilation/v1",
    policy: BULLET_TIME_POLICY_VERSION,
    contractHash: initial.contractHash,
    sourceHash: sha256(stripped.card),
    fields: contributions,
  };
  return { card: result, validation: initial, changed: true, error: null };
}

function positivePromptText(prompt: string): string {
  return prompt.split(/[；。\n]/).filter((clause) => clause.trim() && !/(不得|禁止|不要|无|没有|不是|避免)/.test(clause)).join("；");
}

/** Final byte-level prompt guard after all field compilation and prompt appendices. */
export function validateBulletTimePrompt(
  prompt: string,
  card: Card,
  options: { capabilities?: BulletTimeCapabilities; minChars?: number; maxChars?: number } = {},
): BulletTimePromptAudit {
  const validation = validateBulletTimeContract(contractCandidate(card), { shot: card, capabilities: options.capabilities });
  if (!validation.enabled) return { applicable: false, pass: true, contractHash: null, checks: [], issues: [] };
  const checks: BulletTimePromptCheck[] = [];
  const check = (id: string, pass: boolean, detail: string): void => { checks.push({ id, pass, detail }); };
  const expectedHash = validation.contractHash;
  const short = expectedHash?.slice(0, 12) ?? "";
  const minChars = options.minChars ?? BULLET_TIME_PROMPT_MIN_CHARS;
  const maxChars = options.maxChars ?? BULLET_TIME_PROMPT_MAX_CHARS;
  const positive = positivePromptText(prompt);
  check("contract-valid", validation.valid, validation.valid ? `contract ${expectedHash}` : validation.issues.map((issue) => `${issue.code}:${issue.detail}`).join("；"));
  check("contract-marker", Boolean(short) && prompt.includes(`【子弹时间 ${short}】`), "final prompt retains the exact compiled contract marker");
  check("single-shot", /单镜连续|单个连续镜头|一镜到底/.test(prompt) && /无切点/.test(prompt), "single continuous shot and zero cuts are explicit");
  check("subject-time", /主体时间(?:冻结|近冻结)|主体近冻结/.test(prompt), "subject time is explicitly frozen or near-frozen");
  check("camera-time", /摄影机.{0,24}(?:环绕|运动)|连续.{0,8}环绕/.test(prompt), "camera continues to move through the freeze window");
  check("entry-exit", /入口动作/.test(prompt) && /出口动作/.test(prompt), "entry and exit actions are present");
  check("real-parallax", /真实.{0,10}视差|空间视差/.test(prompt), "real parallax is required");
  check("no-fake-orbit", !/二维平移式真环绕|人物旋转替代摄影机运动|静帧冒充子弹时间/.test(positive), "prompt does not positively request a fake orbit");
  check("audio-policy", validation.contract?.audioPolicy !== "diegetic_only" || (/diegetic|画内|no background music|不添加镜头外音乐|无镜头外BGM/i.test(prompt)), "diegetic-only policy and generation-time BGM ban are present");
  check("no-hard-params", !/f\/\d|ISO\s*\d+|快门\s*\d+\/|shutter\s*\d+/i.test(prompt), "technical lens parameters stay outside the video prompt");
  check("length", prompt.length >= minChars && prompt.length <= maxChars, `${prompt.length} chars within ${minChars}-${maxChars}`);
  const issues = checks.filter((item) => !item.pass).map((item) => `${item.id}: ${item.detail}`);
  return { applicable: true, pass: issues.length === 0, contractHash: expectedHash, checks, issues };
}

const ANGLE_LABELS: Record<string, string> = {
  actionPose: "动作与全身比例",
  front: "正面身份与正面服装",
  threeQuarter: "四分之三脸、肩部与服装侧面",
  closeup: "头肩近景与面部身份",
  side: "侧面轮廓、发型与裤靴结构",
  back: "背面服装与发型结构",
  emotionCloseup: "情绪近景",
  handDetail: "手部细节",
};

export function bulletTimeReferenceClause(angles: readonly string[]): string {
  if (angles.length === 0) return "";
  const descriptions = angles.map((angle, index) => `图${index + 1}是${ANGLE_LABELS[angle] ?? angle}锚点`).join("；");
  return `【人物参考】${descriptions}。这些图共同锚定同一主体，不是多个主体，也不提供最终场景或摄影机运动；预生产构图稿不作为视频首帧提交。`;
}
