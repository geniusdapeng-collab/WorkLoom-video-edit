import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  AutoApprovalCheck,
  GateDecision,
  GateFinding,
  RepairPlan,
} from "@workloom/pipeline-control";
import {
  canonicalJson,
  compilePromptShot,
  promptFieldPolicy,
  promptContractManifestHash,
  sha256Json,
  splitShotAssertions,
  validatePromptContract,
  WorkloomLLMEngine,
  nativeChatJsonObjectCorrected,
  nativeChatJsonObjectRouteCurrent,
  nativeChatJsonSyntaxCorrected,
  nativeChatJsonSyntaxRouteCurrent,
  nativeReasonFailure,
  type CompiledPromptShot,
  type PromptCompileAsset,
  type PromptCompileOptions,
  type PromptCompileShot,
  type PromptContract,
  type PromptFieldDefinition,
  type LLMReasonOptions,
  type StructuredReviewDispatchProof,
} from "@hyperreality/video-studio";
import { promptSemanticRepairPlaybook } from "@hyperreality/video-pipeline";
import type { readCurrentPortraitArchiveCopies } from "./portrait-reuse-acceptance.js";

export const SEMANTIC_QUALITY_POLICY_VERSION = "workloom.video-prompt-quality/v2" as const;
export const SEMANTIC_QUALITY_CHECK_IDS = [
  "SQ1_SUBJECT_ACTION",
  "SQ2_SCENE_PROPS",
  "SQ3_CAMERA_FEASIBLE",
  "SQ4_LIGHT_COLOR",
  "SQ5_PURPOSE",
] as const;
export type SemanticQualityCheckId = (typeof SEMANTIC_QUALITY_CHECK_IDS)[number];

export const SEMANTIC_QUALITY_QUESTION: Readonly<Record<SemanticQualityCheckId, {
  question: string;
  fields: readonly string[];
}>> = {
  SQ1_SUBJECT_ACTION: {
    question: "主体是谁、在做什么，是否一眼明确？",
    fields: ["character", "action", "scene"],
  },
  SQ2_SCENE_PROPS: {
    question: "场景与道具是否服务内容，而非堆砌？",
    fields: ["scene", "props", "action", "timeline"],
  },
  SQ3_CAMERA_FEASIBLE: {
    question: "镜头和运动是否能在目标时长内完成？",
    fields: ["camera_movement", "timeline", "constraint"],
  },
  SQ4_LIGHT_COLOR: {
    question: "光影、构图和色调是否统一？",
    fields: ["lighting", "color_palette", "composition", "mood"],
  },
  SQ5_PURPOSE: {
    question: "这一镜是否有明确叙事作用或传播价值？",
    fields: ["scene", "action", "director_instruction", "timeline"],
  },
};

export interface SemanticQualityCheck {
  id: SemanticQualityCheckId;
  pass: boolean;
  field?: string;
  failureCode?: string;
  evidence: string;
  repair?: string;
}
export interface SemanticQualityReview {
  shotId: string;
  checks: SemanticQualityCheck[];
}

export interface SemanticReviewContext {
  projectId: string;
  runId: string;
  stageRunId: string;
  shot: Record<string, unknown>;
  contract: PromptContract;
  upstreamContext?: Record<string, unknown>;
  attempt: number;
}

interface FinalPromptLength {
  actualChars: number;
  maxFinalPromptChars: number;
}
interface FinalPromptFieldBudget extends FinalPromptLength {
  fixedChars: number;
  maxEditableValueChars: number;
  targetEditableValueChars: number;
  semanticFields: string[];
  descriptiveFieldBudgets: Array<{ field: string; currentValueChars: number; maxChangedValueChars: number }>;
}

interface SemanticRepairContext extends SemanticReviewContext {
  findings: SemanticQualityCheck[];
  allowedFields: string[];
  finalPromptLength?: FinalPromptLength;
  finalPromptFieldBudget?: FinalPromptFieldBudget;
}

export interface SemanticQualityReviewer {
  review(context: SemanticReviewContext): Promise<unknown>;
  repair?(context: SemanticRepairContext): Promise<unknown>;
  model?: string;
}

interface BuiltinSemanticReviewer {
  engine: WorkloomLLMEngine;
  review: SemanticQualityReviewer["review"];
  repair: SemanticQualityReviewer["repair"];
}

const builtinSemanticReviewers = new WeakMap<SemanticQualityReviewer, BuiltinSemanticReviewer>();

function proofReviewer(reviewer: SemanticQualityReviewer): BuiltinSemanticReviewer | undefined {
  const native = builtinSemanticReviewers.get(reviewer);
  return native && Object.getOwnPropertyDescriptor(reviewer, "review")?.value === native.review
    && Object.getOwnPropertyDescriptor(reviewer, "repair")?.value === native.repair
    && WorkloomLLMEngine.supportsStructuredReviewProof(native.engine) ? native : undefined;
}

interface ReusedSemanticReview {
  sourcePass: 1;
  sourceTechnicalRetry: number;
  inputSha256: string;
  dependenciesSha256: string;
  sourceRequestSha256: string;
  sourceResponseSha256: string;
  modelId: string;
  policyVersion: string;
  registryVersion: string;
}

interface PassedSemanticReviewProof {
  dependenciesSha256: string;
  review: SemanticQualityReview;
  technicalRetry: number;
  technicalFailure?: SemanticReviewCorrection;
  dispatch: StructuredReviewDispatchProof;
}

const SEMANTIC_REVIEW_CORRECTIONS = {
  SEMANTIC_REVIEW_JSON_SYNTAX: "上一答复不是可直接解析的 JSON 对象。请仅重做下方原评审，返回一个完整、可由 JSON.parse 直接解析的 JSON 对象。",
  SEMANTIC_REVIEW_CONTRACT_INVALID: "上一答复未满足评审契约。请仅重做下方原评审，逐项返回五个唯一检查，严格使用当前镜号、允许字段和字段原文证据；按 pass 值决定是否提供 failureCode 与 repair。",
} as const;
type SemanticReviewCorrection = keyof typeof SEMANTIC_REVIEW_CORRECTIONS;

export interface PromptQualityFinding {
  code: string;
  field: string | null;
  shotId: string;
  detail: string;
  blocking: boolean;
  repairClass: "deterministic" | "semantic" | "no_repair";
}

export interface PromptQualityRepairAttempt {
  attempt: 1;
  allowedFields: string[];
  beforeFieldsSha256: string;
  afterFieldsSha256: string;
  beforePromptSha256: string;
  afterPromptSha256: string;
  changes: Array<{ shotId: string; field: string; reason: string }>;
  status: "applied" | "stalled";
  reason?: string;
  lengthDiagnostic?: {
    shotId: string; field: string; kind: "nontext-or-empty" | "not-shorter" | "field-marker";
    beforeChars: number | null; proposedChars: number | null;
  };
}

export type PromptQualityStatus = "passed" | "rejected" | "stalled" | "shadow" | "unverified";

export interface PromptQualityResult {
  schemaVersion: typeof SEMANTIC_QUALITY_POLICY_VERSION;
  mode: "shadow" | "enforce";
  status: PromptQualityStatus;
  checkedAt: string;
  projectId: string;
  runId: string;
  stageRunId: string;
  shotContracts: Array<{
    shotId: string;
    source: Record<string, unknown>;
    contract: CompiledPromptShot["contract"];
    hardErrors: CompiledPromptShot["hardErrors"];
  }>;
  semanticReports: Array<{
    shotId: string;
    checks: SemanticQualityCheck[];
    valid: boolean;
    errors: string[];
    technicalRetry: number;
    technicalFailure?: SemanticReviewCorrection;
    proofReuse?: ReusedSemanticReview;
  }>;
  findings: PromptQualityFinding[];
  maxFinalPromptChars?: number;
  approvedProductionPlanSha256?: string;
  repairPlan?: RepairPlan;
  repairAttempt?: PromptQualityRepairAttempt;
  decision: GateDecision;
  /** G6 contract/quality passed; G7 must still prove currentness before render eligibility. */
  g6Eligible: boolean;
  /** Never true at G6; the G7 eligibility artifact is the sole render eligibility proof. */
  renderEligible: boolean;
}

export interface PromptQualityEvidence {
  schemaVersion: typeof SEMANTIC_QUALITY_POLICY_VERSION;
  mode: PromptQualityResult["mode"];
  status: PromptQualityResult["status"];
  contracts: Array<{ shotId: string; path: string; sha256: string; contract: PromptContract }>;
  semanticReportPath: string;
  decisionPath: string;
  repairPlanPath?: string;
  repairAttemptPath?: string;
  sha256: {
    contracts: string;
    semanticReport: string;
    decision: string;
    repairPlan?: string;
    repairAttempt?: string;
  };
}

export interface ResolvePromptAssetInput {
  source: Record<string, unknown>;
  workDir: string;
  charactersDir: string;
  extraAllowedRoots?: string[];
  maxBytes?: number;
  archiveCopies?: ReturnType<typeof readCurrentPortraitArchiveCopies>;
}

function resolveCurrentArchivePromptAssets(
  input: ResolvePromptAssetInput, archive: NonNullable<ResolvePromptAssetInput["archiveCopies"]>, raw: unknown,
): PromptCompileAsset[] {
  const { character, selectionReceipt, sources, outputs } = archive;
  const bindings = input.source.portraitBindings;
  if (!Array.isArray(bindings) || bindings.length !== 1) return [];
  const binding = bindings[0];
  if (binding?.mode !== "studio" || binding.character !== character.name
    || ![character.id, character.name].some(value => binding.source === `portrait-set://${value}`)
    || !Array.isArray(binding.portraits) || binding.portraits.length !== outputs.length
    || !character.angles.every((angle, index) => binding.portraits.some((portrait: { angle?: unknown; outputFile?: unknown }) =>
      portrait?.angle === angle && portrait.outputFile === outputs[index]?.path))) return [];

  const uriPath = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/");
  const aliases = new Map<string, number>();
  for (const [index, angle] of character.angles.entries()) {
    const original = sources[index]!, copy = outputs[index]!;
    const version = `v${selectionReceipt.selectedVersion}`;
    const nativeRoot = `image://characters/${character.id}`;
    const angleFile = `${angle}${path.extname(original.path)}`;
    for (const reference of [original.path, copy.path, `image://${uriPath(input.workDir, copy.path)}`,
      `image://characters/${uriPath(input.charactersDir, copy.path)}`,
      `${nativeRoot}/${version}/${angleFile}`, `${nativeRoot}/portraits/${version}/${angleFile}`,
      `${nativeRoot}/portraits/${version}/${path.basename(original.path)}`,
      `portrait-set://${character.id}/${version}/${angle}`]) aliases.set(reference, index);
  }

  // Native ShotNormalizer may list the exact references under one actor label.
  // A role-only URI, guessed v1 path, unknown or duplicate angle never picks a file.
  const text = typeof raw === "string" ? raw.trim() : "";
  const labelled = /^([^:：]+)[:：]\s*(.+)$/u.exec(text);
  const explicitList = labelled && [character.id, character.name].includes(labelled[1]!.trim()) ? labelled[2]! : text;
  const values = Array.isArray(raw) ? raw : explicitList.split(/[,，]/u);
  const indices = values.map(value => typeof value === "string" ? aliases.get(value.trim()) : undefined);
  const maxBytes = input.maxBytes ?? 25 * 1024 * 1024;
  if (indices.length === 0 || indices.some(index => index === undefined || outputs[index]!.bytes > maxBytes)
    || new Set(indices).size !== indices.length) return [];
  return indices.map(index => {
    const copy = outputs[index!]!;
    return { field: "portraits", role: "reference_image", sha256: copy.sha256, bytes: copy.bytes,
      mediaType: portraitMediaType(copy.path), sourceRef: uriPath(input.workDir, copy.path) };
  });
}

function portraitMediaType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff", ".gif": "image/gif", ".heic": "image/heic", ".heif": "image/heif" } as Record<string, string>)[ext] ?? "application/octet-stream";
}

export function resolvePromptAssets(input: ResolvePromptAssetInput): PromptCompileAsset[] {
  const field = input.source.fields && typeof input.source.fields === "object" && !Array.isArray(input.source.fields)
    ? (input.source.fields as Record<string, unknown>).portraits : undefined;
  if (input.archiveCopies) return resolveCurrentArchivePromptAssets(input, input.archiveCopies, field ?? input.source.portraits);
  const raw = input.source.portraits ?? field;
  const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const maxBytes = input.maxBytes ?? 25 * 1024 * 1024;
  const roots = [...new Set([input.workDir, input.charactersDir, ...(input.extraAllowedRoots ?? [])]
    .filter((root) => root && existsSync(root))
    .map((root) => realpathSync(root)))];
  const inside = (root: string, file: string): boolean => {
    const rel = path.relative(root, file);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  const candidates = (value: string): string[] => {
    if (value.startsWith("data:")) return [];
    if (value.startsWith("asset://")) return [];
    if (value.startsWith("image://")) {
      const rel = value.slice("image://".length);
      return [path.join(input.workDir, rel), path.join(input.charactersDir, rel),
        ...(input.extraAllowedRoots ?? []).map((root) => path.join(root, rel.replace(/^characters[/\\]/, "")))];
    }
    if (path.isAbsolute(value)) return [value];
    return [path.join(input.workDir, value), path.join(input.charactersDir, value), path.join(input.workDir, "characters", value)];
  };
  const result: PromptCompileAsset[] = [];
  for (const item of values) {
    if (typeof item !== "string" || !item.trim()) continue;
    const value = item.trim();
    if (value.startsWith("data:")) {
      const inline = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
      if (!inline?.[2]) continue;
      const bytes = Buffer.from(inline[2], "base64");
      if (!bytes.length) continue;
      result.push({ field: "portraits", role: "reference_image", sha256: digest(bytes), bytes: bytes.length, mediaType: inline[1]!, sourceRef: "inline-image" });
      continue;
    }
    for (const candidate of candidates(value)) {
      if (!existsSync(candidate)) continue;
      const real = realpathSync(candidate);
      if (!roots.some((root) => inside(root, real))) continue;
      const stat = statSync(real);
      if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) continue;
      const bytes = readFileSync(real);
      if (bytes.length !== stat.size) continue;
      result.push({
        field: "portraits",
        role: "reference_image",
        sha256: digest(bytes),
        bytes: bytes.length,
        mediaType: portraitMediaType(real),
        sourceRef: path.relative(input.workDir, real).split(path.sep).join("/"),
      });
      break;
    }
  }
  return result;
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function stableReport(json: unknown): string {
  return JSON.stringify(json, null, 2);
}

function digest(value: string | Uint8Array): string {
  const hash = createHash("sha256");
  if (typeof value === "string") hash.update(value, "utf8");
  else hash.update(value);
  return hash.digest("hex");
}

function evidenceToken(field: string, definition: PromptFieldDefinition, sourceValue: unknown): string[] {
  const tokens = new Set<string>();
  const text = typeof sourceValue === "string" ? sourceValue : JSON.stringify(sourceValue);
  for (const part of text.split(/[\s，。；、,:：|/]+/u).map((item) => item.trim()).filter(Boolean)) {
    if (part.length >= 2) tokens.add(part);
    if (part.length >= 6) {
      for (let index = 0; index + 4 <= part.length; index += 4) tokens.add(part.slice(index, index + 4));
    }
  }
  return [...tokens];
}

function hasEvidence(value: string, definition: PromptFieldDefinition, fieldValue: unknown): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  return evidenceToken(definition.key, definition, fieldValue)
    .some((token) => token.length >= 2 && normalized.includes(token));
}

function fieldValueFromSource(source: Record<string, unknown>, field: string): unknown {
  const fields = source.fields && typeof source.fields === "object" && !Array.isArray(source.fields)
    ? source.fields as Record<string, unknown>
    : {};
  return fields[field] ?? source[field];
}

/** This plan comes from the worker's current, approved G4 archive readback. */
function hasCurrentG4Shot(upstream: Record<string, unknown> | undefined, shotId: string): boolean {
  const value = upstream?.approvedProductionPlan;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
  if (!hash(plan.g4ArtifactSha256) || !hash(plan.requirementContractHash) || !Array.isArray(plan.scenes)) return false;
  const bound = plan.scenes.filter(item => item && typeof item === "object" && item.shotId === shotId);
  return bound.length === 1 && bound[0].sceneId === shotId && Array.isArray(bound[0].approvedScene?.actions)
    && bound[0].approvedScene.actions.length > 0 && Array.isArray(bound[0].verificationPlan?.visualRequirements);
}

function affirmativeOutlineClauses(text: string): string[] {
  // Keep an enumerated pair inside the same clause, and teach the shared
  // splitter the direct visibility and protective-wear negations used here.
  const directNegation = /(?:不(?:允许|应当|应|宜|会|再|易|可|必)?|未(?:能)?|无法|无从)(?=\s*(?:(?:清楚|清晰|完整|自然|单独|被)\s*)?(?:呈现|展示|展现|显示|看清|看见|可见|入镜|穿戴|佩戴|戴|穿))|(?:看|拍|辨)不(?:清|见|到)|不以|不通过|不借助|不用|不把|不让|而非|并非|不是/gu;
  return splitShotAssertions(text.replaceAll("、", "与").replace(directNegation, "禁止")).positive.split("；");
}

/** A specifically approved, covered silhouette needs affirmative framing evidence for both named areas. */
function missingProtectedOutline(
  upstream: Record<string, unknown> | undefined, shotId: string, source: Record<string, unknown>,
): SemanticQualityCheck | undefined {
  if (!hasCurrentG4Shot(upstream, shotId)) return undefined;
  const plan = upstream!.approvedProductionPlan as { scenes: Array<{
    shotId: string;
    approvedScene: { actions: Array<{ description?: unknown } | null>; props?: unknown };
    verificationPlan: { visualRequirements: unknown[] };
  }> };
  const scene = plan.scenes.find(scene => scene?.shotId === shotId)!;
  const visualRequirements = scene.verificationPlan.visualRequirements
    .filter((value): value is string => typeof value === "string").flatMap(affirmativeOutlineClauses);
  const approvedActions = scene.approvedScene.actions.flatMap(action =>
    typeof action?.description === "string" ? affirmativeOutlineClauses(action.description) : []);
  const chest = /胸(?:线|部|廓)/u, hips = /臀(?:线|部|廓)/u;
  const visible = /呈现|展示|展现|显示|看清|看见|可见(?!度)|入镜/u;
  const visiblePair = (clause: string) => chest.test(clause) && hips.test(clause) && visible.test(clause);
  const actionOutlines = approvedActions.filter(visiblePair);
  if (!actionOutlines.length && !visualRequirements.some(visiblePair)) return undefined;
  const fullCoverSuit = /全覆.{0,12}(?:赛车服|防护服|保护服|连体服|服装)/u;
  const declaredCover = [...visualRequirements, ...approvedActions].some(clause =>
    fullCoverSuit.test(clause) || /全覆护具|全套护具|完整护具|护具完整/u.test(clause));
  // An approved prop can corroborate protection only where the approved
  // action already places both visible outlines inside that protective suit.
  const corroboratedCover = actionOutlines.some(clause =>
    /赛车服(?:包裹|覆盖)(?:下|之下)|赛车服[下内]/u.test(clause))
    && Array.isArray(scene.approvedScene.props) && scene.approvedScene.props.some(prop =>
      typeof prop?.name === "string" && affirmativeOutlineClauses(prop.name).some(clause => fullCoverSuit.test(clause)));
  if (!declaredCover && !corroboratedCover) return undefined;
  const framing = ["composition", "camera_movement", "action"].map(field => fieldValueFromSource(source, field))
    .filter((value): value is string => typeof value === "string").flatMap(affirmativeOutlineClauses)
    .filter(clause => visible.test(clause)).join("；");
  if (chest.test(framing) && hips.test(framing)) return undefined;
  return { id: "SQ4_LIGHT_COLOR", pass: false, field: "composition", failureCode: "APPROVED_PROTECTED_OUTLINE_MISSING",
    evidence: "当前构图、运镜和动作字段没有落实本镜已审的两项全覆防护服下轮廓。",
    repair: "只在本镜构图说明中补齐已审的自然胸线和臀部轮廓，保留完整护具、动作连贯及无孤立局部特写。" };
}

function semanticQuestions(upstream: Record<string, unknown> | undefined, shotId: string) {
  if (!hasCurrentG4Shot(upstream, shotId)) return SEMANTIC_QUALITY_QUESTION;
  return {
    ...SEMANTIC_QUALITY_QUESTION,
    SQ5_PURPOSE: { question: "这一镜是否有明确叙事作用，且转场不违背本镜已审切点和末态动作？",
      fields: [...SEMANTIC_QUALITY_QUESTION.SQ5_PURPOSE.fields, "transition"] },
  };
}

/** Current frozen interval is issued only by the G4 readback for hard-cut segmented production. */
function approvedExecutionChecks(
  upstream: Record<string, unknown> | undefined, contract: PromptContract, source: Record<string, unknown>,
): SemanticQualityCheck[] {
  const shotId = contract.shotId;
  const outline = missingProtectedOutline(upstream, shotId, source);
  const findings = outline ? [outline] : [];
  if (!hasCurrentG4Shot(upstream, shotId)) return findings;
  const plan = upstream!.approvedProductionPlan as { scenes: Array<{
    shotId: string; interval?: { startSec?: unknown; endSec?: unknown };
  }> };
  const interval = plan.scenes.find(scene => scene?.shotId === shotId)?.interval;
  if (!interval || typeof interval.startSec !== "number" || typeof interval.endSec !== "number"
    || !Number.isFinite(interval.startSec) || !Number.isFinite(interval.endSec) || interval.startSec < 0
    || interval.endSec - interval.startSec !== Number(contract.request.parameters.duration_sec)) return findings;

  const transition = fieldValueFromSource(source, "transition");
  const explicit = typeof transition === "string"
    ? [...transition.matchAll(/(?:^|[，；。])\s*硬切\s*(?:[，、,:：]\s*|(?:过渡|持续|耗时|用时|时长)\s*(?:为|[:：])?\s*)(\d+(?:\.\d+)?)\s*(?:秒|帧)/gu)] : [];
  if (explicit.some(([, duration]) => Number(duration) > 0)) {
    findings.push({ id: "SQ5_PURPOSE", field: "transition", pass: false, failureCode: "TRANSITION_DURATION_BREAKS_HARDCUT",
      evidence: "转场字段把已审硬切写成正时长过渡。", repair: "保留已审切点、落幅和相邻位置，写成无过渡时长的直接硬切。" });
  }

  const camera = fieldValueFromSource(source, "camera_movement");
  if (typeof camera === "string" && /(?<!对手)(?<subject>车身|主车|主体|人物|角色)\s*始终\s*(?:在画面)?\s*(?:保持)?居中[^。]{0,240}(?:落幅|收镜|结束)(?:时)?\s*(?:画面(?:中|内|里)的?)?\s*\k<subject>[^。；]{0,15}(?:左侧|右侧)(?:的)?三分线/u.test(camera)) {
    findings.push({ id: "SQ3_CAMERA_FEASIBLE", field: "camera_movement", pass: false, failureCode: "CAMERA_FRAMING_SELF_CONTRADICTION",
      evidence: "同一运镜既要求同一主体始终居中，又明确指定该主体在偏侧三分线结束。",
      repair: "以已审切点和本镜动作、构图为准，写清起幅、运动和落幅；不能同时声明全程居中和偏侧落幅。" });
  }
  return findings;
}

export function parseSemanticQualityReview(
  value: unknown,
  contract: PromptContract,
  source?: Record<string, unknown>,
  upstreamContext?: Record<string, unknown>,
): { valid: boolean; errors: string[]; review?: SemanticQualityReview } {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); }
    catch { return { valid: false, errors: ["SEMANTIC_REVIEW_JSON_INVALID"] }; }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { valid: false, errors: ["SEMANTIC_REVIEW_SCHEMA_INVALID"] };
  }
  const record = parsed as Record<string, unknown>;
  const checks = Array.isArray(record.checks) ? record.checks : null;
  if (!checks) return { valid: false, errors: ["SEMANTIC_REVIEW_CHECKS_MISSING"] };
  const definitions = new Map(contract.bindings.map((binding) => [binding.field, binding]));
  const labels = new Map(promptFieldPolicy(contract.fieldSchema, contract.fieldCount === 30)
    .fields.map((field) => [field.key, field]));
  const questions = semanticQuestions(upstreamContext, contract.shotId);
  const errors: string[] = [];
  if (record.shotId !== undefined && record.shotId !== contract.shotId) errors.push("SEMANTIC_REVIEW_SHOT_MISMATCH");
  const seen = new Set<string>();
  const normalizedChecks: SemanticQualityCheck[] = [];
  for (const [index, raw] of checks.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`SEMANTIC_REVIEW_CHECK_SCHEMA_INVALID:${index}`);
      continue;
    }
    const item = raw as Record<string, unknown>;
    const id = item.id;
    if (typeof id !== "string" || !SEMANTIC_QUALITY_CHECK_IDS.includes(id as SemanticQualityCheckId)) {
      errors.push(`SEMANTIC_REVIEW_CHECK_ID_INVALID:${index}`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`SEMANTIC_REVIEW_CHECK_DUPLICATE:${id}`);
      continue;
    }
    seen.add(id);
    if (typeof item.pass !== "boolean") errors.push(`SEMANTIC_REVIEW_PASS_INVALID:${id}`);
    const evidence = typeof item.evidence === "string" ? item.evidence.trim() : "";
    if (!evidence) errors.push(`SEMANTIC_REVIEW_EVIDENCE_MISSING:${id}`);
    const field = typeof item.field === "string" ? item.field.trim() : undefined;
    const requiredFields = questions[id as SemanticQualityCheckId].fields;
    if (field !== undefined && (!requiredFields.includes(field) || !definitions.has(field))) {
      errors.push(`SEMANTIC_REVIEW_FIELD_INVALID:${id}`);
    }
    if (item.pass === false) {
      if (!field) errors.push(`SEMANTIC_REVIEW_FIELD_MISSING:${id}`);
      if (typeof item.failureCode !== "string" || !item.failureCode.trim()) errors.push(`SEMANTIC_REVIEW_FAILURE_CODE_MISSING:${id}`);
      if (typeof item.repair !== "string" || !item.repair.trim()) errors.push(`SEMANTIC_REVIEW_REPAIR_MISSING:${id}`);
    } else if (item.failureCode !== undefined || item.repair !== undefined) {
      errors.push(`SEMANTIC_REVIEW_PASS_HAS_FAILURE:${id}`);
    }
    if (source) {
      const evidenceFields = field ? [field] : [...requiredFields];
      const evidenceMatches = evidenceFields.some((candidate) => {
        const definition = labels.get(candidate);
        return definition ? hasEvidence(evidence, definition, fieldValueFromSource(source, candidate)) : false;
      });
      if (!evidenceMatches) errors.push(`SEMANTIC_REVIEW_EVIDENCE_MISMATCH:${id}`);
    }
    normalizedChecks.push({
      id: id as SemanticQualityCheckId,
      pass: item.pass === true,
      ...(field ? { field } : {}),
      ...(typeof item.failureCode === "string" ? { failureCode: item.failureCode.trim() } : {}),
      evidence,
      ...(typeof item.repair === "string" ? { repair: item.repair.trim() } : {}),
    });
  }
  for (const id of SEMANTIC_QUALITY_CHECK_IDS) if (!seen.has(id)) errors.push(`SEMANTIC_REVIEW_CHECK_MISSING:${id}`);
  return errors.length > 0
    ? { valid: false, errors }
    : { valid: true, errors: [], review: { shotId: contract.shotId, checks: normalizedChecks } };
}

function semanticSchema(shotId: string): Record<string, unknown> {
  return {
    shotId,
    checks: SEMANTIC_QUALITY_CHECK_IDS.map((id) => ({
      id,
      pass: true,
      field: SEMANTIC_QUALITY_QUESTION[id].fields[0],
      evidence: "摘录与该问题直接相关的字段原文",
    })),
  };
}

function semanticPrompt(
  contract: PromptContract,
  source: Record<string, unknown>,
  upstreamContext?: Record<string, unknown>,
): string {
  const fields = contract.bindings.map((binding) => {
    const value = fieldValueFromSource(source, binding.field);
    return { field: binding.field, value };
  });
  return [
    "你是视频提示词语义质量门的唯一评审员。",
    "只回答下列五个二元问题；每项必须给出非空 evidence，并从本题允许字段中选择 field。",
    "失败项还必须给出稳定的 failureCode 和一条只针对该字段的 repair；不得修改字段，只输出评审 JSON。",
    "pass=true 时必须省略 failureCode 和 repair；pass=false 时才增加这两个字段，例如 failureCode=CAMERA_COMPLEXITY_EXCEEDS_DURATION、repair=只修改 camera_movement。",
    "不得用分数代替二元结果；不得臆造证据；证据必须直接摘录或可定位到给定字段值。",
    "当前影片类型由 director_instruction、scene、action、character 与上游上下文共同决定；营销片看卖点/钩子/承诺/CTA，叙事片看冲突/情绪/揭示/转折/必要空间建立。",
    ...(upstreamContext?.approvedProductionPlan ? [
      "approvedProductionPlan 含当前 G4 批准并按镜号绑定的场景与核验计划。依据镜号核对本镜，不替其他镜头认领动作。客户冻结 Brief、现有镜号、顺序和时长仍有效。",
      "SQ1 必须核对本镜每个必做动作在画面中可见。只写动作已经完成、跳过关键前后状态、用结果代替过程或把动作移到另一镜，都判失败。缺动作指向 action；身份或姿态不符指向 character。",
      "SQ2 必须检查时间轴是否逐项呈现本镜的动作和道具交接，按要求顺序发生。与 action 缺项或冲突时指向 timeline。SQ3 运镜各时间窗和镜位须对齐同一实际动作与时间轴。",
      "SQ4 核对构图是否实际能看到 G4 明确要求的部位、护具、动作或可见细节；不能用无关特写、遮挡或通用形容词代替。SQ5 关键目的与相邻镜头交接必须有本镜的字段证据。",
      ...(hasCurrentG4Shot(upstreamContext, contract.shotId) ? [
        "SQ2 角色占用双手的道具必须实际放稳、交接或有明确可行的后续动作，不能从仍握住道具直接跳到双手使用另一道具。",
        "已审规格要求连续多个关键动作时，逐个核对每次的起点、过程、完整完成和前一动作应保留的连续状态，不能用只写部分动作或成功结果代替。",
        "SQ4 必须为本镜已审明确要求的每一项可见细节单独找镜头内证据。仅证明光线、奖杯或脸部清楚，不能替代护具内的自然轮廓或规定的完整动作。",
        "SQ5 仅当本镜转场文字确有冲突时可指向 transition。按实际已审切点和末态复核：自然微动不能改成冻结或定格；稳定机位、自然微动和冻结画面是不同的制作行为。",
      ] : []),
      "用本镜真实字段片段作证据；缺项时摘录跳过该动作、只呈现完成状态或明确遮挡的原文，不得用 G4 文字冒充本镜证据。",
    ] : []),
    JSON.stringify({ shotId: contract.shotId, fieldSchema: contract.fieldSchema, fields, upstreamContext: upstreamContext ?? null,
      questions: semanticQuestions(upstreamContext, contract.shotId) }, null, 2),
  ].join("\n");
}

function repairSchema(context: SemanticRepairContext): Record<string, unknown> {
  if (context.finalPromptFieldBudget) {
    const semantic = context.finalPromptFieldBudget.semanticFields;
    const descriptive = context.finalPromptLength ? context.allowedFields.find(field => !semantic.includes(field)) : undefined;
    return { changes: [
      ...semantic.map(field => ({ field, value: "按本镜审核证据修复并保留原有义务", reason: "修复此字段的已诊断语义问题" })),
      ...(descriptive ? [{ field: descriptive, value: "保留原意的简洁表述", reason: "缩短完整提示词" }] : []),
    ] };
  }
  if (context.allowedFields.includes("transition")) return {
    changes: [{ field: "transition", value: "保留原硬切与已审自然末态的完整描述", reason: "修复已诊断的转场与末态冲突" }],
  };
  return {
    changes: [{ field: "camera_movement", value: "只包含在目标时长内可完成的一个主动作", reason: "修复 SQ3" }],
  };
}

function repairPrompt(
  contract: PromptContract,
  source: Record<string, unknown>,
  findings: SemanticQualityCheck[],
  allowedFields: string[],
  upstreamContext?: Record<string, unknown>,
  finalPromptLength?: FinalPromptLength,
  finalPromptFieldBudget?: FinalPromptFieldBudget,
): string {
  const fields = contract.bindings.map(({ field }) => ({ field, value: fieldValueFromSource(source, field) }));
  const writable = new Set(allowedFields);
  return [
    "你是字段级定点修复器。只允许修改 allowedFields 中列出的字段。",
    "readOnlyFields 是同一镜头当前已编译的完整只读约束；不是待修字段。修复运镜或构图时，逐段对齐现有时间轴、动作和道具交接；固定机位和镜内切换须明确区分，不能把一个动作延长到下一动作的已定区间。",
    "不得修改事实、授权、时长、画幅、模型能力、gate threshold 或任何其它字段。",
    ...(finalPromptLength ? [
      `本镜完整编译提示词实测 ${finalPromptLength.actualChars} 字符，最终上限 ${finalPromptLength.maxFinalPromptChars} 字符（UTF-16 计数）；字段合计至少需缩短 ${finalPromptLength.actualChars - finalPromptLength.maxFinalPromptChars} 字符。`,
      "没有语义缺陷的可写描述字段只精简同义重复，保留原有光向、色彩、构图、景深、情绪、可见环境、导演目的、节奏变化和妆容特征。不得截断、清空或把内容移到其他字段。",
    ] : []),
    ...(allowedFields.includes("transition") ? ["仅按独立评审指向的具体矛盾修复转场文字，保留原硬切、切点、原生末态与自然动作；不得增加过渡、延长时长或冻结画面。"] : []),
    ...(finalPromptFieldBudget ? [
      `实际编译中固定部分已占 ${finalPromptFieldBudget.fixedChars} 字；所有可写字段修复后的值总长（含未改可写字段）最多 ${finalPromptFieldBudget.maxEditableValueChars} 字，建议不超过 ${finalPromptFieldBudget.targetEditableValueChars} 字。请在本次响应内核算全部可写字段的总长，留出安全余量。`,
      `必须同时解决正式评审指出的语义缺陷。仅以下字段可按对应 findings 补齐或调整制作语义：${JSON.stringify(finalPromptFieldBudget.semanticFields)}；其余可写字段只能缩写。保持演员身份、资产、服装、声场、技术规格和每镜总时长；不得省略已审动作或增加段落。`,
      ...(finalPromptLength ? ["descriptiveFieldBudgets 给出每个纯描述字段的现长及改写后单字段上限（UTF-16）。不要返回没变的字段；可保持短字段原样，只提交足够达到合计预算的真实缩写。不得返回空值、占位内容或与原值等长的替换。"] : []),
      ...(finalPromptFieldBudget.semanticFields.includes("timeline")
        ? ["时间轴也在诊断范围时，按本镜已审动作和现有时长重排镜内时点，运镜、动作、道具交接与时间轴必须互相对应，不得改变镜头切点。"] : []),
    ] : []),
    "只输出 JSON：changes[]，每项必须有 field、value、reason；至少产生一个变化。",
    `镜头：${JSON.stringify({ shotId: contract.shotId, durationSec: contract.request.parameters.duration_sec,
      allowedFields: fields.filter(({ field }) => writable.has(field)),
      readOnlyFields: fields.filter(({ field }) => !writable.has(field)),
      findings, ...(finalPromptLength ? { finalPromptLength } : {}), ...(finalPromptFieldBudget ? { finalPromptFieldBudget } : {}),
      upstreamContext: upstreamContext ?? null }, null, 2)}`,
  ].join("\n");
}

function semanticReviewRequest(context: SemanticReviewContext) {
  const options: LLMReasonOptions = { scene: "preproduction", maxTokens: 2200, temperature: 0 };
  return [semanticPrompt(context.contract, context.shot, context.upstreamContext), semanticSchema(context.contract.shotId), options] as const;
}

function correctedSemanticReviewRequest(request: ReturnType<typeof semanticReviewRequest>, failure: SemanticReviewCorrection) {
  const [prompt, schema, options] = request;
  return [`【G6 评审响应技术纠正】\n${SEMANTIC_REVIEW_CORRECTIONS[failure]}\n\n${prompt}`, schema, options] as const;
}

export function createLlmSemanticQualityReviewer(llm: WorkloomLLMEngine): SemanticQualityReviewer {
  const reviewer: SemanticQualityReviewer = {
    model: llm.model,
    async review(context) {
      const result = await llm.reasonStructured(...semanticReviewRequest(context));
      if (!result.success) throw new Error(result.error ?? "SEMANTIC_REVIEW_TRANSPORT_FAILED");
      return result.data ?? result.content;
    },
    async repair(context) {
      const result = await llm.reasonStructured(
        repairPrompt(context.contract, context.shot, context.findings, context.allowedFields, context.upstreamContext,
          context.finalPromptLength, context.finalPromptFieldBudget),
        repairSchema(context),
        { scene: "preproduction", maxTokens: 1200, temperature: 0 },
      );
      if (!result.success) throw new Error(result.error ?? "SEMANTIC_REPAIR_TRANSPORT_FAILED");
      return result.data ?? result.content;
    },
  };
  builtinSemanticReviewers.set(reviewer, { engine: llm, review: reviewer.review, repair: reviewer.repair });
  return reviewer;
}

function semanticFinding(
  source: Record<string, unknown>,
  contract: PromptContract,
  check: SemanticQualityCheck,
): PromptQualityFinding {
  return {
    code: check.failureCode ?? `SEMANTIC_${check.id}`,
    field: check.field ?? null,
    shotId: contract.shotId,
    detail: check.evidence,
    blocking: true,
    repairClass: "semantic",
  };
}

function hardFinding(error: { code: string; field: string | null; detail: string }, shotId: string): PromptQualityFinding {
  return {
    code: error.code,
    field: error.field,
    shotId,
    detail: error.detail,
    blocking: true,
    repairClass: error.code.startsWith("HARD_") ? "deterministic" : "no_repair",
  };
}

const FINAL_PROMPT_LENGTH_CODE = "HARD_FINAL_PROMPT_TOO_LONG";
const FINAL_LENGTH_EDITABLE_FIELDS = new Set(["lighting", "composition", "color_palette", "depth_of_field", "mood"]);
const FINAL_LENGTH_G4_DESCRIPTION_FIELDS = new Set(["director_instruction", "scene", "pacing", "makeup"]);
const FINAL_COMBINED_SEMANTIC_FIELDS = new Set([
  ...FINAL_LENGTH_EDITABLE_FIELDS, "director_instruction", "scene", "character", "action", "props", "timeline", "camera_movement",
]);

function promptFieldBudget(contract: PromptContract, source: Record<string, unknown>, fields: string[],
  semanticFields: string[], limit: number | undefined): FinalPromptFieldBudget | undefined {
  if (limit === undefined) return undefined;
  const emittedValueLengths = fields.map(field => {
    const span = contract.bindings.find(binding => binding.field === field)?.promptSpan;
    const value = fieldValueFromSource(source, field);
    if (!span || typeof value !== "string" || !contract.prompt.slice(span.start, span.end).endsWith(value.trim())) return undefined;
    return value.trim().length;
  });
  if (emittedValueLengths.some(length => length === undefined)) return undefined;
  const fixedChars = contract.prompt.length - emittedValueLengths.reduce<number>((total, length) => total + (length ?? 0), 0);
  const maxEditableValueChars = limit - fixedChars;
  // The smaller target is advice; the exact compiled native cap remains the only hard limit.
  const headroom = Math.min(96, Math.floor(Math.max(0, maxEditableValueChars - fields.length) * 0.12));
  return { actualChars: contract.prompt.length, maxFinalPromptChars: limit, fixedChars, maxEditableValueChars,
    targetEditableValueChars: maxEditableValueChars - headroom, semanticFields,
    descriptiveFieldBudgets: fields.flatMap((field, index) => {
      if (semanticFields.includes(field)) return [];
      const currentValueChars = emittedValueLengths[index]!;
      return [{ field, currentValueChars, maxChangedValueChars: currentValueChars - 1 }];
    }) };
}

function repairRequestHash(contract: PromptContract, allowReviewedTimeline: boolean): string {
  if (!allowReviewedTimeline) return contract.requestSha256;
  // A diagnosed timeline edit may change the timeline string in the native technical map.
  // Duration, provider and all other request channels still have to match exactly.
  const { timeline: _approvedTimelineEdit, ...technical } = contract.request.technical;
  return sha256Json({ ...contract.request, technical });
}

function checkedFinalPromptLimit(value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("FINAL_PROMPT_LENGTH_LIMIT_INVALID");
  }
  return value;
}

function finalPromptOverflow(contract: PromptContract, limit: number | undefined): FinalPromptLength | undefined {
  if (limit !== undefined && contract.prompt.length > limit) {
    return { actualChars: contract.prompt.length, maxFinalPromptChars: limit };
  }
}

function finalLengthEditableFields(contract: PromptContract, source: Record<string, unknown>, length: FinalPromptLength,
  upstream?: Record<string, unknown>): string[] {
  const candidates = contract.bindings.flatMap(binding => {
    const span = binding.promptSpan;
    if (!span || binding.channels.length !== 1 || binding.channels[0] !== "prompt") return [];
    const value = fieldValueFromSource(source, binding.field);
    return typeof value === "string" && value.trim().length > 1 && contract.prompt.slice(span.start, span.end).endsWith(value.trim())
      ? [{ field: binding.field, removableChars: value.trim().length - 1 }] : [];
  });
  const excess = length.actualChars - length.maxFinalPromptChars;
  const capacity = (items: typeof candidates) => items.reduce((total, candidate) => total + candidate.removableChars, 0);
  const primary = candidates.filter(item => FINAL_LENGTH_EDITABLE_FIELDS.has(item.field));
  if (capacity(primary) >= excess) return primary.map(item => item.field);
  if (!hasCurrentG4Shot(upstream, contract.shotId)) return [];
  const extended = candidates.filter(item => FINAL_LENGTH_EDITABLE_FIELDS.has(item.field) || FINAL_LENGTH_G4_DESCRIPTION_FIELDS.has(item.field));
  return capacity(extended) >= excess ? extended.map(item => item.field) : [];
}

function asGateFinding(finding: PromptQualityFinding): GateFinding {
  return {
    code: finding.code,
    severity: "P0",
    targetType: finding.field ? "field" : "stage",
    targetId: finding.field ? finding.shotId : null,
    fieldPath: finding.field,
    expected: finding.code === FINAL_PROMPT_LENGTH_CODE ? "complete compiled prompt within final native limit"
      : finding.repairClass === "semantic" ? "pass for fixed semantic quality question" : "deterministic prompt contract",
    actual: finding.detail,
    evidenceRefs: [`prompt-quality/${finding.shotId}`],
    repairClass: finding.repairClass,
    blocking: finding.blocking,
  };
}

function makeDecision(input: {
  projectId: string;
  runId: string;
  stageRunId: string;
  contracts: PromptContract[];
  findings: PromptQualityFinding[];
  reviewer: SemanticQualityReviewer | null;
  status: PromptQualityStatus;
  maxFinalPromptChars?: number;
  approvedProductionPlanSha256?: string;
}): GateDecision {
  const blocking = input.findings.filter((finding) => finding.blocking);
  const status = blocking.length > 0 ? "rejected" : input.status === "passed" ? "passed" : "unverified";
  return {
    id: `PQ-${digest(`${input.projectId}:${input.runId}:${input.stageRunId}:${status}`).slice(0, 16)}`,
    runId: input.runId,
    stageRunId: input.stageRunId,
    gateId: "G6_PROMPT",
    artifactManifestHash: promptContractManifestHash(input.contracts),
    planHash: sha256Json({
      policy: SEMANTIC_QUALITY_POLICY_VERSION,
      schema: [...new Set(input.contracts.map((contract) => contract.fieldSchema))].sort(),
      ...(input.maxFinalPromptChars !== undefined ? { maxFinalPromptChars: input.maxFinalPromptChars } : {}),
      ...(input.approvedProductionPlanSha256 ? { approvedProductionPlanSha256: input.approvedProductionPlanSha256 } : {}),
    }),
    checkSetVersion: SEMANTIC_QUALITY_POLICY_VERSION,
    rubricVersion: SEMANTIC_QUALITY_POLICY_VERSION,
    authority: input.reviewer ? "llm_review" : "deterministic",
    status,
    reviewer: {
      kind: input.reviewer ? "llm_review" : "host_rule",
      id: input.reviewer?.model ?? "semantic-quality-reviewer",
      ...(input.reviewer?.model ? { model: input.reviewer.model } : {}),
    },
    findings: blocking.map(asGateFinding),
    evidenceRefs: input.contracts.map((contract) => `sha256:${contract.promptSha256}`),
    supersedesDecisionId: null,
    createdAt: new Date().toISOString(),
  };
}

function validateRepairChanges(value: unknown, allowedFields: string[]): Array<{ field: string; value: unknown; reason: string }> {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); }
    catch { throw new Error("REPAIR_JSON_INVALID"); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("REPAIR_SCHEMA_INVALID");
  const changes = (parsed as { changes?: unknown }).changes;
  if (!Array.isArray(changes) || changes.length === 0) throw new Error("REPAIR_CHANGES_MISSING");
  const result: Array<{ field: string; value: unknown; reason: string }> = [];
  for (const [index, raw] of changes.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`REPAIR_CHANGE_SCHEMA_INVALID:${index}`);
    const item = raw as Record<string, unknown>;
    if (typeof item.field !== "string" || !allowedFields.includes(item.field)
      || typeof item.reason !== "string" || !item.reason.trim() || item.value === undefined) {
      throw new Error(`REPAIR_CHANGE_INVALID:${index}`);
    }
    result.push({ field: item.field, value: item.value, reason: item.reason.trim() });
  }
  return result;
}

function patchSource(source: Record<string, unknown>, changes: Array<{ field: string; value: unknown }>): Record<string, unknown> {
  const next = structuredClone(source);
  const fields = next.fields && typeof next.fields === "object" && !Array.isArray(next.fields)
    ? next.fields as Record<string, unknown>
    : {};
  next.fields = fields;
  for (const change of changes) fields[change.field] = change.value;
  return next;
}

export interface EvaluatePromptQualityInput {
  mode: "shadow" | "enforce";
  projectId: string;
  runId: string;
  stageRunId: string;
  revision: number;
  shots: Array<{ source: Record<string, unknown>; compile: PromptCompileOptions }>;
  reviewer?: SemanticQualityReviewer | null;
  upstreamContext?: Record<string, unknown>;
  maxWallMs?: number;
  maxFinalPromptChars?: number;
}

export interface PromptContractSummary {
  shotId: string;
  fieldSchema: string;
  fieldCount: number;
  fieldsSha256: string;
  promptSha256: string;
  requestSha256: string;
}

export function promptContractSummary(contracts: readonly PromptContract[]): PromptContractSummary[] {
  return contracts.map((contract) => ({
    shotId: contract.shotId,
    fieldSchema: contract.fieldSchema,
    fieldCount: contract.fieldCount,
    fieldsSha256: contract.fieldsSha256,
    promptSha256: contract.promptSha256,
    requestSha256: contract.requestSha256,
  })).sort((left, right) => left.shotId.localeCompare(right.shotId));
}

export function compilePromptPackage(input: Pick<EvaluatePromptQualityInput, "shots">): CompiledPromptShot[] {
  return input.shots.map(({ source, compile }) => {
    const shot = source as unknown as PromptCompileShot;
    const normalized = { ...source, shotId: String(source.shotId ?? source.shot_id ?? "") };
    return compilePromptShot(normalized as unknown as PromptCompileShot, compile);
  });
}

export function verifyCurrentPromptContracts(
  input: Pick<EvaluatePromptQualityInput, "shots" | "maxFinalPromptChars">,
  expected: readonly PromptContractSummary[],
): { valid: boolean; reasons: string[]; contracts: PromptContract[] } {
  const limit = checkedFinalPromptLimit(input.maxFinalPromptChars);
  const compiled = compilePromptPackage(input);
  const reasons = compiled.flatMap((item) => [
    ...item.hardErrors.map(error => `${item.contract.shotId}:${error.code}:${error.field ?? "stage"}`),
    ...(finalPromptOverflow(item.contract, limit) ? [`${item.contract.shotId}:${FINAL_PROMPT_LENGTH_CODE}:stage`] : []),
  ]);
  const current = promptContractSummary(compiled.map((item) => item.contract));
  const expectedById = new Map(expected.map((item) => [item.shotId, item]));
  if (current.length !== expected.length) reasons.push("SHOT_COUNT_MISMATCH");
  for (const contract of current) {
    const prior = expectedById.get(contract.shotId);
    if (!prior) {
      reasons.push(`G6_CONTRACT_MISSING:${contract.shotId}`);
      continue;
    }
    if (canonicalJson(prior) !== canonicalJson(contract)) reasons.push(`PROMPT_CONTRACT_DRIFT:${contract.shotId}`);
  }
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)], contracts: compiled.map((item) => item.contract) };
}

interface TechnicalReviewResult {
  review?: SemanticQualityReview;
  errors: string[];
  retries: number;
  technicalFailure?: SemanticReviewCorrection;
  dispatchProof?: StructuredReviewDispatchProof;
  proofReuse?: ReusedSemanticReview;
}

async function reviewWithTechnicalRetry(
  reviewer: SemanticQualityReviewer,
  context: SemanticReviewContext,
  captureProof: boolean,
  prior?: PassedSemanticReviewProof,
): Promise<TechnicalReviewResult> {
  const native = proofReviewer(reviewer);
  if (native) return reviewNativeWithCorrection(native.engine, context, captureProof, prior);
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const current = { ...context, attempt: attempt + 1 };
      const value = await reviewer.review(current);
      const parsed = parseSemanticQualityReview(value, current.contract, current.shot, current.upstreamContext);
      if (parsed.valid && parsed.review) return { review: parsed.review, errors: [], retries: attempt };
      lastError = parsed.errors.join(",");
    } catch (error) {
      lastError = errorText(error);
    }
  }
  return { errors: [lastError || "SEMANTIC_REVIEW_INVALID"], retries: 1, review: undefined };
}

async function reviewNativeWithCorrection(
  engine: WorkloomLLMEngine, context: SemanticReviewContext, captureProof: boolean, prior?: PassedSemanticReviewProof,
): Promise<TechnicalReviewResult> {
  const parse = (value: unknown) => parseSemanticQualityReview(value, context.contract, context.shot, context.upstreamContext);
  const dispatch = async (value: ReturnType<typeof semanticReviewRequest>): ReturnType<WorkloomLLMEngine["reasonStructuredWithProof"]> =>
    captureProof ? engine.reasonStructuredWithProof(...value) : { result: await engine.reasonStructured(...value) };
  let failure: SemanticReviewCorrection | undefined;
  let errors: string[] = [];
  let retries = 0;
  try {
    const request = semanticReviewRequest(context);
    if (prior?.dispatch.matchesCurrent(...(prior.technicalFailure ? correctedSemanticReviewRequest(request, prior.technicalFailure) : request))) {
      const parsed = parse(prior.review);
      if (parsed.valid && parsed.review?.checks.every((check) => check.pass)) {
        const { inputSha256, requestSha256, responseSha256, modelId, policyVersion, registryVersion } = prior.dispatch;
        return {
          review: parsed.review, errors: [], retries, technicalFailure: prior.technicalFailure,
          proofReuse: { sourcePass: 1, sourceTechnicalRetry: prior.technicalRetry, inputSha256, dependenciesSha256: prior.dependenciesSha256,
            sourceRequestSha256: requestSha256, sourceResponseSha256: responseSha256, modelId, policyVersion, registryVersion },
        };
      }
    }
    const { result: first, proof } = await dispatch(request);
    const parsed = first.success ? parse(first.data ?? first.content) : undefined;
    if (parsed?.valid && parsed.review) return { review: parsed.review, errors: [], retries, dispatchProof: proof };
    failure = parsed ? "SEMANTIC_REVIEW_CONTRACT_INVALID" : nativeReasonFailure(first) === "json-syntax" ? "SEMANTIC_REVIEW_JSON_SYNTAX" : undefined;
    errors = parsed?.errors ?? [failure ?? "SEMANTIC_REVIEW_NATIVE_UNAVAILABLE"];
    if (!failure || !(parsed ? nativeChatJsonObjectRouteCurrent(engine, first) : nativeChatJsonSyntaxRouteCurrent(engine, first))) {
      return { errors, retries, technicalFailure: failure };
    }
    retries = 1;
    const { result: next, proof: correctedProof } = await dispatch(correctedSemanticReviewRequest(request, failure));
    if (!next.success) {
      const nextError = nativeReasonFailure(next) === "json-syntax" ? "SEMANTIC_REVIEW_CORRECTION_INVALID" : "SEMANTIC_REVIEW_CORRECTION_UNAVAILABLE";
      return { errors: [...errors, nextError], retries, technicalFailure: failure };
    }
    if (!(parsed ? nativeChatJsonObjectCorrected(first, next) : nativeChatJsonSyntaxCorrected(first, next))) {
      return { errors: [...errors, "SEMANTIC_REVIEW_CORRECTION_UNPROVEN"], retries, technicalFailure: failure };
    }
    const corrected = parse(next.data);
    if (!corrected.valid || !corrected.review || (next.data as { shotId?: unknown }).shotId !== context.contract.shotId) {
      return { errors: [...errors, "SEMANTIC_REVIEW_CORRECTION_INVALID"], retries, technicalFailure: failure };
    }
    return { review: corrected.review, errors: [], retries, technicalFailure: failure, dispatchProof: correctedProof };
  } catch {
    return { errors: [...errors, retries ? "SEMANTIC_REVIEW_CORRECTION_UNAVAILABLE" : "SEMANTIC_REVIEW_NATIVE_UNAVAILABLE"], retries, technicalFailure: failure };
  }
}

function reviewDependencies(input: EvaluatePromptQualityInput, contract: PromptContract): string {
  const model = contract.modelCapabilities;
  return sha256Json({
    scope: [input.projectId, input.runId, input.stageRunId, input.revision, input.mode],
    semanticPolicy: SEMANTIC_QUALITY_POLICY_VERSION,
    contractSchema: contract.schemaVersion,
    contractPolicy: contract.policyVersion,
    contractManifest: promptContractManifestHash([contract]),
    ...(input.maxFinalPromptChars !== undefined ? { maxFinalPromptChars: input.maxFinalPromptChars } : {}),
    model: {
      modelId: model.modelId, provider: model.provider, providerModel: model.providerModel, version: model.version,
      modes: model.modes, durationSec: [model.durationSec.min, model.durationSec.max], aspectRatios: model.aspectRatios,
      resolutions: model.resolutions, maxReferenceImages: model.maxReferenceImages, maxPromptChars: model.maxPromptChars,
    },
  });
}

async function evaluateCompiledShots(
  input: EvaluatePromptQualityInput,
  reviewer: SemanticQualityReviewer | null,
  sources: Array<{ source: Record<string, unknown>; compile: PromptCompileOptions; expectedRequestSha256?: string; allowReviewedTimeline?: boolean }>,
  proofPass?: { phase: "capture" | "reuse"; byShot: Map<string, PassedSemanticReviewProof> },
  allowLengthRepair = false,
): Promise<{
  compiled: Array<{ shotId: string; source: Record<string, unknown>; compiled: CompiledPromptShot }>;
  reports: PromptQualityResult["semanticReports"];
  findings: PromptQualityFinding[];
}> {
  const compiled = sources.map(({ source, compile, expectedRequestSha256, allowReviewedTimeline }) => {
    const shot = source as unknown as PromptCompileShot;
    const result = compilePromptShot(shot, compile);
    const normalizedFields = source.fields && typeof source.fields === "object" && !Array.isArray(source.fields)
      ? { ...(source.fields as Record<string, unknown>), ...result.fieldValues }
      : { ...result.fieldValues };
    return {
      shotId: String(shot.shotId ?? ""),
      source: { ...source, fields: normalizedFields },
      compiled: result,
      expectedRequestSha256,
      allowReviewedTimeline,
    };
  });
  const reports: PromptQualityResult["semanticReports"] = [];
  const findings: PromptQualityFinding[] = [];
  for (const item of compiled) {
    for (const error of item.compiled.hardErrors) findings.push(hardFinding(error, item.shotId));
    if (item.expectedRequestSha256 !== undefined
      && repairRequestHash(item.compiled.contract, item.allowReviewedTimeline === true) !== item.expectedRequestSha256) {
      findings.push(hardFinding({ code: "FINAL_PROMPT_REPAIR_REQUEST_DRIFT", field: null, detail: "缩短提示词时请求参数发生变化" }, item.shotId));
    }
  }
  const structureValid = findings.length === 0;
  for (const item of compiled) {
    const length = finalPromptOverflow(item.compiled.contract, input.maxFinalPromptChars);
    if (!length) continue;
    const repairable = allowLengthRepair && structureValid && reviewer?.repair
      && finalLengthEditableFields(item.compiled.contract, item.source, length, input.upstreamContext).length > 0;
    findings.push({ code: FINAL_PROMPT_LENGTH_CODE, field: null, shotId: item.shotId, blocking: true,
      detail: `完整提示词 ${length.actualChars} 字符超过最终原生上限 ${length.maxFinalPromptChars}（UTF-16）`,
      repairClass: repairable ? "semantic" : "deterministic" });
  }
  if (findings.some(finding => finding.repairClass !== "semantic")) return { compiled, reports, findings };
  if (!reviewer) {
    for (const item of compiled) {
      reports.push({ shotId: item.shotId, checks: [], valid: false, errors: ["SEMANTIC_REVIEWER_UNAVAILABLE"], technicalRetry: 0 });
      findings.push({ code: "SEMANTIC_REVIEWER_UNAVAILABLE", field: null, shotId: item.shotId, detail: "无可用语义评审器", blocking: true, repairClass: "no_repair" });
    }
    return { compiled, reports, findings };
  }
  // Proofs are one-per-shot. Keep the existing evaluator for ambiguous shot identities.
  const proofs = proofPass && compiled.every((item) => item.shotId)
    && new Set(compiled.map((item) => item.shotId)).size === compiled.length ? proofPass : undefined;
  for (const item of compiled) {
    const context: SemanticReviewContext = {
      projectId: input.projectId,
      runId: input.runId,
      stageRunId: input.stageRunId,
      shot: item.source,
      contract: item.compiled.contract,
      upstreamContext: input.upstreamContext,
      attempt: 1,
    };
    const dependencies = proofs ? reviewDependencies(input, context.contract) : undefined;
    const prior = proofs?.phase === "reuse" ? proofs.byShot.get(item.shotId) : undefined;
    const reviewed = await reviewWithTechnicalRetry(reviewer, context, proofs?.phase === "capture",
      prior && prior.dependenciesSha256 === dependencies ? prior : undefined);
    if (proofs?.phase === "capture" && dependencies && reviewed.dispatchProof && reviewed.review?.checks.every((check) => check.pass)) {
      proofs.byShot.set(item.shotId, { dependenciesSha256: dependencies, review: structuredClone(reviewed.review),
        technicalRetry: reviewed.retries, technicalFailure: reviewed.technicalFailure, dispatch: reviewed.dispatchProof });
    }
    reports.push({
      shotId: item.shotId,
      checks: reviewed.review?.checks ?? [],
      valid: Boolean(reviewed.review),
      errors: reviewed.errors,
      technicalRetry: reviewed.retries,
      ...(reviewed.technicalFailure ? { technicalFailure: reviewed.technicalFailure } : {}),
      ...(reviewed.proofReuse ? { proofReuse: reviewed.proofReuse } : {}),
    });
    if (!reviewed.review) {
      findings.push({
        code: "SEMANTIC_REVIEW_INVALID",
        field: null,
        shotId: item.shotId,
        detail: reviewed.errors.join(","),
        blocking: true,
        repairClass: "no_repair",
      });
      continue;
    }
    for (const check of reviewed.review.checks) {
      if (check.pass) continue;
      findings.push(semanticFinding(item.source, item.compiled.contract, check));
    }
    const explicit = approvedExecutionChecks(input.upstreamContext, item.compiled.contract, item.source);
    for (const check of explicit) if (!findings.some(finding => finding.shotId === item.shotId
      && finding.code === check.failureCode && finding.field === check.field)) {
      findings.push(semanticFinding(item.source, item.compiled.contract, check));
    }
  }
  return { compiled, reports, findings };
}

export async function evaluatePromptPackage(value: EvaluatePromptQualityInput): Promise<PromptQualityResult> {
  const input = { ...value, maxFinalPromptChars: checkedFinalPromptLimit(value.maxFinalPromptChars) };
  const approvedProductionPlanSha256 = input.upstreamContext?.approvedProductionPlan !== undefined
    ? sha256Json(input.upstreamContext.approvedProductionPlan) : undefined;
  const reviewer = input.reviewer ?? null;
  const proofs = input.mode === "enforce" && input.shots.length > 1 && reviewer && proofReviewer(reviewer)
    ? new Map<string, PassedSemanticReviewProof>() : undefined;
  const first = await evaluateCompiledShots(input, reviewer, input.shots, proofs && { phase: "capture", byShot: proofs },
    input.mode === "enforce");
  const hardOrReviewFindings = first.findings.filter((finding) => finding.repairClass !== "semantic");
  const semanticFindings = first.findings.filter((finding) => finding.repairClass === "semantic");
  const firstContracts = first.compiled.map((item) => item.compiled.contract);
  const reviewInvalid = first.findings.some((finding) => finding.code.startsWith("SEMANTIC_REVIEW_"));
  const firstStatus: PromptQualityStatus = input.mode === "shadow"
    ? "shadow"
    : reviewInvalid ? "stalled"
    : hardOrReviewFindings.length > 0 || semanticFindings.length > 0 ? "rejected" : "passed";
  let finalStatus: PromptQualityStatus = firstStatus;
  let repairPlan: RepairPlan | undefined;
  let repairAttempt: PromptQualityRepairAttempt | undefined;
  let finalCompiled = first.compiled;
  let finalReports = first.reports;
  let finalFindings = first.findings;

  if (input.mode === "enforce" && hardOrReviewFindings.length === 0 && semanticFindings.length > 0) {
    const repairs = [...new Set(semanticFindings.map(finding => finding.shotId))].map(shotId => {
      const firstShot = first.compiled.find(item => item.shotId === shotId)!;
      const finalPromptLength = finalPromptOverflow(firstShot.compiled.contract, input.maxFinalPromptChars);
      const diagnosed = [...new Set(semanticFindings.filter(finding => finding.shotId === shotId)
        .flatMap(finding => finding.field ? [finding.field] : []))];
      const semanticFields = finalPromptLength ? diagnosed.filter(field => FINAL_COMBINED_SEMANTIC_FIELDS.has(field)
        || (field === "transition" && hasCurrentG4Shot(input.upstreamContext, shotId))) : diagnosed;
      const fields = finalPromptLength ? [...new Set([
        ...finalLengthEditableFields(firstShot.compiled.contract, firstShot.source, finalPromptLength, input.upstreamContext), ...semanticFields,
      ])] : diagnosed;
      const fieldBudget = promptFieldBudget(firstShot.compiled.contract, firstShot.source, fields, semanticFields, input.maxFinalPromptChars);
      return { firstShot, fields, semanticFields, finalPromptLength, fieldBudget, allDiagnosesWritable: semanticFields.length === diagnosed.length };
    });
    const allowedFields = [...new Set(repairs.flatMap(repair => repair.fields))];
    if (!reviewer?.repair || repairs.some(repair => repair.fields.length === 0 || !repair.allDiagnosesWritable
      || (repair.finalPromptLength && (!repair.fieldBudget || repair.fieldBudget.maxEditableValueChars < repair.fields.length)))) {
      finalStatus = "stalled";
    } else {
      const decision = makeDecision({
        projectId: input.projectId, runId: input.runId, stageRunId: input.stageRunId,
        contracts: firstContracts, findings: semanticFindings, reviewer, status: "rejected", maxFinalPromptChars: input.maxFinalPromptChars,
        approvedProductionPlanSha256,
      });
      const playbook = promptSemanticRepairPlaybook(allowedFields);
      const findingSignature = sha256Json(semanticFindings.map((finding) => ({
        code: finding.code, field: finding.field, shotId: finding.shotId,
      })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
      repairPlan = {
        id: `RP-${digest(`${input.stageRunId}:${findingSignature}`).slice(0, 16)}`,
        runId: input.runId,
        rootDecisionId: decision.id,
        targetStageRunId: input.stageRunId,
        targetRevision: input.revision,
        playbookId: playbook.id,
        playbookVersion: playbook.version,
        planHash: sha256Json({ findingSignature, allowedFields, playbook,
          ...(input.maxFinalPromptChars !== undefined ? { maxFinalPromptChars: input.maxFinalPromptChars } : {}),
          ...(approvedProductionPlanSha256 ? { approvedProductionPlanSha256 } : {}) }),
        findings: semanticFindings.map(asGateFinding),
        allowedChanges: playbook.allowedChanges,
        forbiddenChanges: playbook.forbiddenChanges,
        invalidationClosure: ["prompt-package", "g6-prompt-confirm"],
        budgetEnvelope: {
          maxAttempts: 1,
          maxWallMs: input.maxWallMs ?? 120_000,
          maxModelTokens: 2_000,
          maxCny: 0,
        },
        requiresApproval: false,
        status: "running",
      };
      let lengthDiagnostic: PromptQualityRepairAttempt["lengthDiagnostic"];
      try {
        const patchedSources = new Map<string, Parameters<typeof evaluateCompiledShots>[2][number]>(
          input.shots.map(item => [String(item.source.shotId), item]));
        const compileById = new Map(input.shots.map((item) => [String((item.source as Record<string, unknown>).shotId), item.compile]));
        const changes: Array<{ shotId: string; field: string; value: unknown; reason: string }> = [];
        for (const { firstShot, fields: shotAllowedFields, finalPromptLength, fieldBudget, semanticFields } of repairs) {
          const shotId = firstShot.shotId;
          const actualFindings = finalReports.find((report) => report.shotId === shotId)?.checks.filter((check) => !check.pass) ?? [];
          const scopedFindings = approvedExecutionChecks(input.upstreamContext, firstShot.compiled.contract, firstShot.source)
            .filter(check => !actualFindings.some(actual => actual.field === check.field && actual.failureCode === check.failureCode));
          const changesRaw = await reviewer.repair({
            projectId: input.projectId, runId: input.runId, stageRunId: input.stageRunId,
            shot: finalPromptLength ? structuredClone(firstShot.source) : firstShot.source,
            contract: finalPromptLength ? structuredClone(firstShot.compiled.contract) : firstShot.compiled.contract,
            attempt: 1,
            upstreamContext: input.upstreamContext,
            findings: [...actualFindings, ...scopedFindings],
            allowedFields: [...shotAllowedFields],
            ...(finalPromptLength ? { finalPromptLength: { ...finalPromptLength } } : {}),
            ...(fieldBudget ? { finalPromptFieldBudget: structuredClone(fieldBudget) } : {}),
          });
          const parsedChanges = validateRepairChanges(changesRaw, shotAllowedFields);
          if (new Set(parsedChanges.map((change) => change.field)).size !== parsedChanges.length) throw new Error("REPAIR_CHANGE_DUPLICATE");
          let shotChanges = parsedChanges;
          const reviewedTransition = shotChanges.find(change => change.field === "transition");
          if (reviewedTransition) {
            const prior = fieldValueFromSource(firstShot.source, "transition");
            if (!semanticFields.includes("transition") || !hasCurrentG4Shot(input.upstreamContext, shotId)
              || typeof reviewedTransition.value !== "string" || !reviewedTransition.value.trim()
              || (typeof prior === "string" && prior.includes("硬切") && !reviewedTransition.value.includes("硬切"))) {
              throw new Error("APPROVED_TRANSITION_REPAIR_DRIFT");
            }
          }
          if (finalPromptLength) {
            shotChanges = parsedChanges.filter(change => {
              const prior = fieldValueFromSource(firstShot.source, change.field);
              const proposed = change.value;
              const beforeChars = typeof prior === "string" ? prior.trim().length : null;
              const proposedChars = typeof proposed === "string" ? proposed.trim().length : null;
              if (typeof prior !== "string" || typeof proposed !== "string"
                || beforeChars === null || proposedChars === null || proposedChars === 0) {
                lengthDiagnostic = { shotId, field: change.field, kind: "nontext-or-empty", beforeChars, proposedChars };
                throw new Error("FINAL_PROMPT_REPAIR_NOT_SHORTER");
              }
              if (!semanticFields.includes(change.field)) {
                // An exact no-op preserves the source field and its digest.
                if (proposed.trim() === prior.trim()) return false;
                if (proposedChars >= beforeChars) {
                  lengthDiagnostic = { shotId, field: change.field, kind: "not-shorter", beforeChars, proposedChars };
                  throw new Error("FINAL_PROMPT_REPAIR_NOT_SHORTER");
                }
              }
              if (/【[^】]+】/u.test(proposed)) {
                lengthDiagnostic = { shotId, field: change.field, kind: "field-marker", beforeChars, proposedChars };
                throw new Error("FINAL_PROMPT_REPAIR_FIELD_MARKER");
              }
              return true;
            });
            if (shotChanges.length === 0) throw new Error("REPAIR_CHANGES_MISSING");
            proofs?.delete(shotId);
          }
          const patched = patchSource(firstShot.source, shotChanges);
          const allowReviewedTimeline = semanticFields.includes("timeline") && shotChanges.some(change => change.field === "timeline");
          patchedSources.set(shotId, { source: patched, compile: compileById.get(shotId)!,
            ...(finalPromptLength || reviewedTransition ? { expectedRequestSha256: repairRequestHash(firstShot.compiled.contract, allowReviewedTimeline),
              allowReviewedTimeline } : {}) });
          changes.push(...shotChanges.map((change) => ({ shotId, ...change })));
        }
        if (changes.length === 0) throw new Error("REPAIR_CHANGES_MISSING");
        const second = await evaluateCompiledShots(input, reviewer, [...patchedSources.values()],
          proofs && { phase: "reuse", byShot: proofs });
        const beforeFields = sha256Json(firstContracts.map((contract) => ({ shotId: contract.shotId, sha256: contract.fieldsSha256 })));
        const afterContracts = second.compiled.map((item) => item.compiled.contract);
        const afterFields = sha256Json(afterContracts.map((contract) => ({ shotId: contract.shotId, sha256: contract.fieldsSha256 })));
        const beforePrompt = sha256Json(firstContracts.map((contract) => ({ shotId: contract.shotId, sha256: contract.promptSha256 })));
        const afterPrompt = sha256Json(afterContracts.map((contract) => ({ shotId: contract.shotId, sha256: contract.promptSha256 })));
        const unchanged = beforeFields === afterFields || beforePrompt === afterPrompt;
        if (unchanged) {
          finalStatus = "stalled";
          repairPlan = { ...repairPlan, status: "stalled" };
          repairAttempt = {
            attempt: 1, allowedFields, beforeFieldsSha256: beforeFields,
            afterFieldsSha256: afterFields, beforePromptSha256: beforePrompt,
            afterPromptSha256: afterPrompt,
            changes: changes.map((change) => ({ shotId: change.shotId, field: change.field, reason: change.reason })),
            status: "stalled", reason: "REPAIR_HASH_UNCHANGED",
          };
        } else {
          finalCompiled = second.compiled;
          finalReports = second.reports;
          finalFindings = second.findings;
          finalStatus = second.findings.length === 0 ? "passed" : "stalled";
          const repeated = second.findings.some((finding) => semanticFindings.some((prior) =>
            prior.shotId === finding.shotId && prior.field === finding.field && prior.code === finding.code));
          repairAttempt = {
            attempt: 1, allowedFields, beforeFieldsSha256: beforeFields,
            afterFieldsSha256: afterFields, beforePromptSha256: beforePrompt,
            afterPromptSha256: afterPrompt,
            changes: changes.map((change) => ({ shotId: change.shotId, field: change.field, reason: change.reason })),
            status: finalStatus === "passed" ? "applied" : "stalled",
            ...(finalStatus === "passed" ? {}
              : { reason: repeated ? "SAME_FAILURE_SIGNATURE_REPEATED" : "FULL_REVALIDATION_FAILED" }),
          };
          if (finalStatus === "passed") repairPlan = { ...repairPlan, status: "applied" };
          else repairPlan = { ...repairPlan, status: "stalled" };
        }
      } catch (error) {
        finalStatus = "stalled";
        if (repairPlan) repairPlan = { ...repairPlan, status: "stalled" };
        repairAttempt = {
          attempt: 1,
          allowedFields,
          beforeFieldsSha256: firstContracts.find((contract) => contract.shotId === semanticFindings[0]!.shotId)?.fieldsSha256 ?? "",
          afterFieldsSha256: "",
          beforePromptSha256: firstContracts.find((contract) => contract.shotId === semanticFindings[0]!.shotId)?.promptSha256 ?? "",
          afterPromptSha256: "",
          changes: [],
          status: "stalled",
          reason: errorText(error),
          ...(lengthDiagnostic ? { lengthDiagnostic } : {}),
        };
      }
    }
  }

  const finalContracts = finalCompiled.map((item) => item.compiled.contract);
  const decision = makeDecision({
    projectId: input.projectId,
    runId: input.runId,
    stageRunId: input.stageRunId,
    contracts: finalContracts,
    findings: finalFindings,
    reviewer,
    status: finalStatus,
    maxFinalPromptChars: input.maxFinalPromptChars,
    approvedProductionPlanSha256,
  });
  return {
    schemaVersion: SEMANTIC_QUALITY_POLICY_VERSION,
    mode: input.mode,
    status: finalStatus,
    checkedAt: new Date().toISOString(),
    projectId: input.projectId,
    runId: input.runId,
    stageRunId: input.stageRunId,
    shotContracts: finalCompiled.map((item) => ({
      shotId: item.shotId,
      source: item.source,
      contract: item.compiled.contract,
      hardErrors: item.compiled.hardErrors,
    })),
    semanticReports: finalReports,
    findings: finalFindings,
    ...(input.maxFinalPromptChars !== undefined ? { maxFinalPromptChars: input.maxFinalPromptChars } : {}),
    ...(approvedProductionPlanSha256 ? { approvedProductionPlanSha256 } : {}),
    ...(repairPlan ? { repairPlan } : {}),
    ...(repairAttempt ? { repairAttempt } : {}),
    decision,
    g6Eligible: input.mode === "enforce" && finalStatus === "passed"
      && finalContracts.every((contract) => validatePromptContract(contract).valid)
      && finalReports.every((report) => report.valid
        && SEMANTIC_QUALITY_CHECK_IDS.every((id) => report.checks.find((check) => check.id === id)?.pass === true)),
    renderEligible: false,
  };
}

function safeShotFileName(shotId: string): string {
  return shotId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "shot";
}

export function writePromptQualityEvidence(directory: string, result: PromptQualityResult): PromptQualityEvidence {
  mkdirSync(directory, { recursive: true });
  const write = (name: string, value: unknown): { path: string; sha256: string } => {
    const file = path.join(directory, name);
    const body = stableReport(value);
    writeFileSync(file, body, "utf8");
    return { path: file, sha256: digest(body) };
  };
  const contracts = result.shotContracts.map((item) => {
    const file = write(`prompt-contract-${safeShotFileName(item.shotId)}.json`, item.contract);
    return { shotId: item.shotId, ...file, contract: item.contract };
  });
  const semantic = write("semantic-quality-report.json", {
    schemaVersion: SEMANTIC_QUALITY_POLICY_VERSION,
    checkedAt: result.checkedAt,
    reports: result.semanticReports,
    findings: result.findings,
    ...(result.maxFinalPromptChars !== undefined ? { maxFinalPromptChars: result.maxFinalPromptChars } : {}),
    ...(result.approvedProductionPlanSha256 ? { approvedProductionPlanSha256: result.approvedProductionPlanSha256 } : {}),
    repairAttempt: result.repairAttempt ?? null,
  });
  const decision = write("prompt-quality-decision.json", result.decision);
  const repairPlan = result.repairPlan ? write("prompt-semantic-repair-plan.json", result.repairPlan) : undefined;
  const repairAttempt = result.repairAttempt ? write("prompt-semantic-repair-attempt.json", result.repairAttempt) : undefined;
  return {
    schemaVersion: SEMANTIC_QUALITY_POLICY_VERSION,
    mode: result.mode,
    status: result.status,
    contracts,
    semanticReportPath: semantic.path,
    decisionPath: decision.path,
    ...(repairPlan ? { repairPlanPath: repairPlan.path } : {}),
    ...(repairAttempt ? { repairAttemptPath: repairAttempt.path } : {}),
    sha256: {
      contracts: sha256Json(contracts.map((item) => ({ shotId: item.shotId, sha256: item.sha256 }))),
      semanticReport: semantic.sha256,
      decision: decision.sha256,
      ...(repairPlan ? { repairPlan: repairPlan.sha256 } : {}),
      ...(repairAttempt ? { repairAttempt: repairAttempt.sha256 } : {}),
    },
  };
}

export function promptQualityAutoChecks(result: PromptQualityResult): AutoApprovalCheck[] {
  const limit = result.maxFinalPromptChars;
  return [
    ...(limit !== undefined ? [{
      id: "prompt-final-native-length",
      category: "deterministic" as const,
      status: result.shotContracts.every(item => item.contract.prompt.length <= limit) ? "passed" as const : "failed" as const,
      detail: `完整提示词字符数（上限 ${limit}，UTF-16）：${result.shotContracts.map(item => `${item.shotId}=${item.contract.prompt.length}`).join("、")}`,
      evidenceRef: "prompt-quality/decision",
    }] : []),
    ...(result.status === "stalled" ? [{
      id: "prompt-quality-stalled",
      category: "policy" as const,
      status: "failed" as const,
      detail: "一次字段级修复已用尽或复验仍失败，禁止自动重试和付费提交",
      evidenceRef: "prompt-quality/decision",
      repairClass: "no_repair" as const,
    }] : []),
    {
      id: "prompt-contract-fields",
      category: "deterministic",
      status: result.shotContracts.every((item) => item.hardErrors.length === 0) ? "passed" : "failed",
      detail: result.shotContracts.flatMap((item) => item.hardErrors.map((error) => `${item.shotId}:${error.code}`)).join(";")
        || "25/30 字段及消费矩阵完整",
      evidenceRef: "prompt-quality/decision",
      ...(result.shotContracts.some((item) => item.hardErrors.length > 0) ? { repairClass: "local_patch" as const } : {}),
    },
    ...SEMANTIC_QUALITY_CHECK_IDS.map((id) => {
      const invalid = result.semanticReports.some((report) => !report.valid || report.checks.find((check) => check.id === id)?.pass !== true);
      return {
        id: `prompt-${id.toLowerCase()}`,
        category: "semantic" as const,
        status: invalid ? "failed" as const : "passed" as const,
        detail: result.semanticReports.map((report) => `${report.shotId}:${report.checks.find((check) => check.id === id)?.evidence ?? "未返回"}`).join(" | "),
        evidenceRef: "prompt-quality/semantic-quality-report",
        ...(invalid ? { repairClass: "semantic" as const } : {}),
      };
    }),
  ];
}
