import { createHash } from "node:crypto";
import { isDeepStrictEqual, types } from "node:util";
import {
  canonicalJson, compilePromptShot, promptFieldPolicy, sha256Json, validatePromptContract,
  PROMPT_CONTRACT_SCHEMA_VERSION, PROMPT_CONTRACT_POLICY_VERSION, PROMPT_CONTRACT_REQUEST_SCHEMA_VERSION,
  SHOT_FIELD_SCHEMA_V1, SHOT_FIELD_SCHEMA_V2, WorkloomLLMEngine, nativeReasonCompleted, nativeChatJsonSyntaxRouteCurrent,
  type PromptCompileOptions, type PromptCompileShot, type PromptContract, type LLMReasonOptions,
} from "@hyperreality/video-studio";
import { g6EventWitnessChecks, g6EventWitnessRepairDrift } from "./g6-event-witness.js";

export const APPROVED_SOURCE_FIELDS_VERSION = "workloom.approved-source-fields/v1" as const;
type JsonRecord = Record<string, unknown>;
const hashPattern = /^[a-f0-9]{64}$/u;
const newFieldSchemaExample = "从完整已审来源新创作本字段的非空文本";
const FINAL_LENGTH_EDITABLE_FIELDS = ["lighting", "composition", "color_palette", "depth_of_field", "mood"] as const;
const MARKETING_FINAL_AUDIO_BGM_CODE = "MARKETING_FINAL_AUDIO_BGM_CONFLICT";
const MARKETING_FINAL_POST_TEXT_CODE = "MARKETING_FINAL_POST_TEXT_CONFLICT";
const MARKETING_FINAL_RESOLUTION_CODE = "MARKETING_FINAL_RESOLUTION_COHERENCE";
const MARKETING_FINAL_FACE_CODE = "MARKETING_FINAL_HELMET_FACE_COHERENCE";
const MARKETING_FINAL_CHARACTER_COUNT_CODE = "MARKETING_FINAL_CHARACTER_COUNT_COHERENCE";
// G6 semantic checks may also use upper-case HARD_* failure codes. Only the
// compiler's exact vocabulary can describe a replayed compiler error.
const PROMPT_COMPILER_ERROR_CODES: ReadonlySet<string> = new Set([
  "HARD_DURATION_INVALID", "HARD_DURATION_UNSUPPORTED", "HARD_ASPECT_UNSUPPORTED",
  "HARD_RESOLUTION_UNSUPPORTED", "HARD_REFERENCE_LIMIT", "HARD_FIRST_FRAME_UNSUPPORTED",
  "HARD_REFERENCE_UNSUPPORTED", "HARD_TEXT_MODE_UNSUPPORTED", "HARD_FPS_INVALID",
  "HARD_TIMELINE_EXCEEDS_DURATION", "HARD_DIALOGUE_WITHOUT_AUDIO",
  "HARD_CONSTRAINT_ASPECT_CONFLICT", "HARD_CONSTRAINT_RESOLUTION_CONFLICT",
  "HARD_CONSTRAINT_FPS_CONFLICT", "HARD_DIALOGUE_AUDIO_CONFLICT",
  "HARD_FIELD_VALUE_MISSING", "HARD_FIELD_VALUE_UNREADABLE", "HARD_ASSET_FIELD_UNKNOWN",
  "HARD_ASSET_MISSING", "HARD_ASSET_NOTA_AMBIGUOUS", "HARD_PROMPT_TOO_LONG",
]);
const hashBytes = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
function fail(code: string): never { throw new Error(`APPROVED_SOURCE_FIELDS_${code}`); }
function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("RECORD_INVALID");
  if (Reflect.ownKeys(value).some(key => typeof key !== "string"
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"))) return fail("RECORD_INVALID");
  return value as JsonRecord;
}
function jsonTree(value: unknown, ancestors = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || types.isProxy(value) || ancestors.has(value) || depth > 64) return false;
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (Object.getPrototypeOf(value) !== Array.prototype || keys.length !== value.length + 1
      || keys.some(key => typeof key !== "string" || (key !== "length"
        && (!/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length))
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"))) return false;
  } else { try { record(value); } catch { return false; } }
  ancestors.add(value);
  const valid = Object.values(value).every(item => jsonTree(item, ancestors, depth + 1));
  ancestors.delete(value);
  return valid;
}
function checkedHash(value: unknown): string {
  return typeof value === "string" && hashPattern.test(value) ? value : fail("HASH_INVALID");
}
/** Whole-body JSON with unique object keys. Never repairs or extracts a partial answer. */
function strictJson(raw: string): JsonRecord {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return fail("JSON_INVALID"); }
  if (Buffer.from(raw, "utf8").toString("utf8") !== raw || !jsonTree(value)) return fail("JSON_INVALID");
  const containers: Array<Set<string> | null> = [];
  const whitespace = /[ \t\r\n]*/y;
  for (let offset = 0; offset < raw.length; offset++) {
    if (raw[offset] === "{") containers.push(new Set());
    else if (raw[offset] === "[") containers.push(null);
    else if (raw[offset] === "}" || raw[offset] === "]") containers.pop();
    else if (raw[offset] === '"') {
      const start = offset++;
      while (raw[offset] !== '"') { if (raw[offset] === "\\") offset++; offset++; }
      const keys = containers.at(-1);
      whitespace.lastIndex = offset + 1;
      whitespace.exec(raw);
      if (keys && raw[whitespace.lastIndex] === ":") {
        const key = JSON.parse(raw.slice(start, offset + 1)) as string;
        if (keys.has(key)) return fail("JSON_DUPLICATE_KEY");
        keys.add(key);
      }
    }
  }
  return record(value);
}
/** Integrity input only. The adopting host must bind its tenant, attempt, permissions and freshness. */
export interface VerifiedFieldArtifact { bytes: Uint8Array; expectedSha256: string }
function artifact(input: VerifiedFieldArtifact): { parsed: JsonRecord; sha256: string } {
  const sha256 = checkedHash(input.expectedSha256);
  if (!(input.bytes instanceof Uint8Array) || hashBytes(input.bytes) !== sha256) return fail("ARTIFACT_HASH_MISMATCH");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
  return { parsed: strictJson(text), sha256 };
}
export interface RecoveredFieldProof {
  field: string;
  valueSha256: string;
  carrier: "archived-field" | "request" | "prompt-text" | "prompt-array" | "prompt-scalar" | "canonical-none";
}
export interface UnboundPromptField {
  field: string;
  sourceState: "canonical-unbound";
  /** There was no canonical field value binding in the source contract. */
  valueSha256: null;
  diagnosisEvidenceSha256: string[];
}
export interface RecoveredPromptShot extends PromptCompileShot {
  shotId: string;
  duration: number;
  sceneId?: string;
  sceneType?: string;
  noPeople?: boolean;
  fields: JsonRecord;
  prompt: string;
  /** Exact UTF-8 contract body, retained so later plans can recheck its byte hash. */
  sourceContractText: string;
  sourceContractSha256: string;
  sourceContract: PromptContract;
  compileOptions: PromptCompileOptions;
  fieldProofs: RecoveredFieldProof[];
  /** Historical omissions, retained after authoring; they never describe recovered old values. */
  unboundFields: UnboundPromptField[];
  missingFieldEvidence: Array<{ text: string; sha256: string }>;
  rawAliasState: "not-retained";
}
export interface RecoverContractFieldsInput {
  contractBytes: Uint8Array;
  expectedSha256: string;
  archivedFields?: JsonRecord;
  sceneMetadata?: { sceneId?: string; sceneType?: string; noPeople?: boolean };
  /** Only the adopting host's original G6 report can establish a canonical omission. */
  missingEvidence?: readonly VerifiedFieldArtifact[];
}
function sourceMissingDiagnoses(evidence: readonly VerifiedFieldArtifact[], shotId: string) {
  const byField = new Map<string, string[]>(), allowedHardErrors = new Set<string>();
  const originals: Array<{ text: string; sha256: string }> = [];
  for (const item of evidence) {
    const { parsed, sha256 } = artifact(item);
    if (parsed.schemaVersion !== "workloom.video-prompt-quality/v2" || !Array.isArray(parsed.findings)) return fail("MISSING_EVIDENCE_INVALID");
    let used = false, hardErrorUsed = false;
    for (const raw of parsed.findings) {
      const finding = record(raw);
      if (finding.shotId === shotId && finding.blocking === true && typeof finding.code === "string"
        && !["HARD_FINAL_PROMPT_TOO_LONG", "HARD_FIELD_UNKNOWN"].includes(finding.code)
        && (PROMPT_COMPILER_ERROR_CODES.has(finding.code)
          || ["deterministic", "local_patch"].includes(String(finding.repairClass)))) {
        allowedHardErrors.add(`${finding.code}:${typeof finding.field === "string" ? finding.field : "stage"}`);
        hardErrorUsed = true;
      }
      if (finding.shotId !== shotId || finding.code !== "HARD_FIELD_VALUE_MISSING" || finding.blocking !== true
        || !["deterministic", "local_patch"].includes(String(finding.repairClass)) || typeof finding.field !== "string") continue;
      const hashes = byField.get(finding.field) ?? [];
      if (!hashes.includes(sha256)) hashes.push(sha256);
      byField.set(finding.field, hashes);
      used = true;
    }
    if ((used || hardErrorUsed) && !originals.some(original => original.sha256 === sha256)) {
      originals.push({ text: Buffer.from(item.bytes).toString("utf8"), sha256 });
    }
  }
  return { byField, allowedHardErrors, originals };
}
function pathValue(value: unknown, path: string): unknown {
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, key)) return undefined;
    value = (value as JsonRecord)[key];
  }
  return value;
}
function reconstructOptions(contract: PromptContract, lastEnd: number): PromptCompileOptions {
  const parameters = contract.request.parameters;
  const tail = contract.prompt.slice(lastEnd);
  const lines = tail ? tail.slice(1).split("\n") : [];
  if ((tail && !tail.startsWith("\n")) || lines.some(line => !line.startsWith("【编译纪律】")
    || !line.slice("【编译纪律】".length).trim())) return fail("PROMPT_TAIL_INVALID");
  if (typeof parameters.aspect_ratio !== "string" || typeof parameters.resolution !== "string"
    || !Number.isSafeInteger(parameters.fps) || parameters.format !== "mp4" || typeof parameters.generate_audio !== "boolean") {
    return fail("DELIVERY_INVALID");
  }
  return {
    schemaVersion: contract.fieldSchema, titleCard: contract.fieldCount === 30, createdAt: contract.createdAt,
    delivery: {
      aspectRatio: parameters.aspect_ratio, resolution: parameters.resolution, fps: parameters.fps as number,
      format: "mp4", generateAudio: parameters.generate_audio, ...(contract.request.inputMode === "first-frame" ? { firstFrame: true } : {}),
    },
    model: structuredClone(contract.modelCapabilities),
    assets: contract.bindings.flatMap(binding => (binding.assets ?? []).map(asset => ({ field: "portraits" as const, ...asset }))),
    downstreamSpec: Object.fromEntries(contract.bindings.flatMap(binding => binding.downstreamSpec ? [[binding.field, binding.downstreamSpec]] : [])),
    requiredClauses: lines.map(line => line.slice("【编译纪律】".length)),
  };
}
/** Recover canonical values only. Historical source aliases and author text are never invented. */
export function recoverContractFields(input: RecoverContractFieldsInput): RecoveredPromptShot {
  const { parsed, sha256 } = artifact({ bytes: input.contractBytes, expectedSha256: input.expectedSha256 });
  if (parsed.schemaVersion !== PROMPT_CONTRACT_SCHEMA_VERSION || parsed.policyVersion !== PROMPT_CONTRACT_POLICY_VERSION
    || ![SHOT_FIELD_SCHEMA_V1, SHOT_FIELD_SCHEMA_V2].includes(parsed.fieldSchema as typeof SHOT_FIELD_SCHEMA_V2)
    || typeof parsed.shotId !== "string" || !parsed.shotId.trim() || typeof parsed.prompt !== "string"
    || typeof parsed.createdAt !== "string" || !Number.isFinite(Date.parse(parsed.createdAt)) || !Array.isArray(parsed.bindings)) {
    return fail("CONTRACT_SCHEMA_INVALID");
  }
  const request = record(parsed.request), parameters = record(request.parameters), model = record(parsed.modelCapabilities);
  record(request.technical);
  const duration = record(model.durationSec);
  const modelKeys = new Set(["modelId", "provider", "providerModel", "version", "modes", "durationSec", "aspectRatios", "resolutions", "maxReferenceImages", "maxPromptChars", "cameraFixedSupported"]);
  const textList = (value: unknown) => Array.isArray(value) && value.length > 0
    && value.every(item => typeof item === "string" && Boolean(item.trim()));
  if (request.schemaVersion !== PROMPT_CONTRACT_REQUEST_SCHEMA_VERSION || request.shotId !== parsed.shotId
    || !["text", "first-frame", "reference-image"].includes(String(request.inputMode))
    || !Number.isSafeInteger(parameters.duration_sec) || Number(parameters.duration_sec) <= 0
    || Object.keys(model).some(key => !modelKeys.has(key))
    || ["modelId", "provider", "providerModel", "version"].some(key => typeof model[key] !== "string" || !(model[key] as string).trim())
    || !textList(model.modes) || !textList(model.aspectRatios) || !textList(model.resolutions)
    || !Number.isSafeInteger(model.maxReferenceImages) || Number(model.maxReferenceImages) < 0
    || !Number.isSafeInteger(model.maxPromptChars) || Number(model.maxPromptChars) <= 0
    || !Number.isSafeInteger(duration.min) || !Number.isSafeInteger(duration.max) || Number(duration.min) <= 0 || Number(duration.max) < Number(duration.min)
    || Object.keys(duration).some(key => !["min", "max"].includes(key))
    || (model.cameraFixedSupported !== undefined && typeof model.cameraFixedSupported !== "boolean")) return fail("CONTRACT_SCHEMA_INVALID");
  const contract = parsed as unknown as PromptContract;
  const policy = promptFieldPolicy(contract.fieldSchema, contract.fieldCount === 30);
  if (contract.fieldCount !== policy.fieldCount || contract.bindings.length > policy.fields.length) return fail("FIELD_COUNT_INVALID");
  const missingDiagnoses = sourceMissingDiagnoses(input.missingEvidence ?? [], contract.shotId);
  const bindingByField = new Map<string, JsonRecord>();
  let previousIndex = -1;
  for (const raw of contract.bindings) {
    const binding = record(raw), index = policy.fields.findIndex(field => field.key === binding.field);
    if (index < 0 || index <= previousIndex || bindingByField.has(String(binding.field))) return fail("FIELD_BINDING_ORDER_INVALID");
    previousIndex = index;
    bindingByField.set(String(binding.field), binding);
  }
  if (input.archivedFields && !jsonTree(input.archivedFields)) return fail("ARCHIVED_FIELDS_INVALID");
  const metadata = input.sceneMetadata ?? {};
  if (!jsonTree(metadata) || Object.keys(metadata).some(key => !["sceneId", "sceneType", "noPeople"].includes(key))
    || [metadata.sceneId, metadata.sceneType].some(value => value !== undefined && (typeof value !== "string" || !value.trim()))
    || (metadata.noPeople !== undefined && typeof metadata.noPeople !== "boolean")) return fail("SCENE_METADATA_INVALID");
  const fields: JsonRecord = {}, fieldProofs: RecoveredFieldProof[] = [], unboundFields: UnboundPromptField[] = [];
  let offset = 0;
  for (const [index, definition] of policy.fields.entries()) {
    const binding = bindingByField.get(definition.key);
    const prefix = `${String(index + 1).padStart(2, "0")}.【${definition.label}】`;
    if (!binding) {
      const evidenceSha256 = missingDiagnoses.byField.get(definition.key);
      if (!evidenceSha256?.length) return fail(`MISSING_EVIDENCE_REQUIRED:${definition.key}`);
      // A new content field cannot repair missing source permissions, images
      // or an additional native request channel. Those need upstream work.
      if (immutableFields.has(definition.key) || ["timeline", "character_constraint"].includes(definition.key)) {
        return fail(`UNBOUND_REQUEST_FIELD_UNSUPPORTED:${definition.key}`);
      }
      const unboundLine = `${prefix}undefined`;
      if (contract.prompt.slice(offset, offset + unboundLine.length) !== unboundLine) return fail("UNBOUND_PROMPT_LINE_INVALID");
      offset += unboundLine.length;
      unboundFields.push({ field: definition.key, sourceState: "canonical-unbound", valueSha256: null,
        diagnosisEvidenceSha256: [...evidenceSha256] });
      if (index < policy.fields.length - 1 && contract.prompt[offset++] !== "\n") return fail("FIELD_SEPARATOR_INVALID");
      continue;
    }
    const span = record(binding.promptSpan);
    if (binding.field !== definition.key || !isDeepStrictEqual(binding.channels, definition.channels)
      || (definition.requestKeys.length && !isDeepStrictEqual(binding.requestKeys, definition.requestKeys))
      || span.label !== `【${definition.label}】` || span.start !== offset || !Number.isSafeInteger(span.end)
      || Number(span.end) <= offset || Number(span.end) > contract.prompt.length
      || !contract.prompt.slice(offset, Number(span.end)).startsWith(prefix)) return fail("FIELD_SPAN_INVALID");
    checkedHash(binding.valueSha256);
    if (binding.assets !== undefined) {
      if (!Array.isArray(binding.assets)) return fail("ASSET_BINDING_INVALID");
      for (const raw of binding.assets) {
        const asset = record(raw);
        if (Object.keys(asset).some(key => !["role", "sha256", "bytes", "mediaType", "sourceRef"].includes(key))
          || typeof asset.role !== "string" || !asset.role.trim() || !Number.isSafeInteger(asset.bytes) || Number(asset.bytes) <= 0
          || typeof asset.mediaType !== "string" || !asset.mediaType.startsWith("image/")
          || (asset.sourceRef !== undefined && (typeof asset.sourceRef !== "string" || !asset.sourceRef.trim()))) return fail("ASSET_BINDING_INVALID");
        checkedHash(asset.sha256);
      }
    }
    const text = contract.prompt.slice(offset + prefix.length, Number(span.end));
    const candidates: Array<{ value: unknown; carrier: RecoveredFieldProof["carrier"] }> = [
      { value: input.archivedFields?.[definition.key], carrier: "archived-field" },
      ...definition.requestKeys.map(key => ({ value: pathValue(request, key), carrier: "request" as const })),
      { value: text, carrier: "prompt-text" },
      { value: text.split("；"), carrier: "prompt-array" },
      ...(text === "是" || text === "否" ? [{ value: text === "是", carrier: "prompt-scalar" as const }] : []),
      ...(text.trim() && Number.isFinite(Number(text)) ? [{ value: Number(text), carrier: "prompt-scalar" as const }] : []),
      ...(definition.key === "portraits" && binding.assetApplicability === "not_applicable"
        ? [{ value: "NONE", carrier: "canonical-none" as const }] : []),
    ];
    const matched = candidates.filter(candidate => candidate.value !== undefined && jsonTree(candidate.value)
      && sha256Json(candidate.value) === binding.valueSha256);
    if (!matched.length || matched.some(candidate => !isDeepStrictEqual(candidate.value, matched[0]!.value))) return fail(`VALUE_UNRECOVERABLE:${definition.key}`);
    fields[definition.key] = structuredClone(matched[0]!.value);
    fieldProofs.push({ field: definition.key, valueSha256: binding.valueSha256 as string, carrier: matched[0]!.carrier });
    offset = Number(span.end);
    if (index < policy.fields.length - 1 && contract.prompt[offset++] !== "\n") return fail("FIELD_SEPARATOR_INVALID");
  }
  const compileOptions = reconstructOptions(contract, offset);
  let recompiled: ReturnType<typeof compilePromptShot>;
  try { recompiled = compilePromptShot({ shotId: contract.shotId, duration: Number(parameters.duration_sec), fields, ...metadata }, compileOptions); }
  catch { return fail("RECOMPILE_FAILED"); }
  const missing = new Set(unboundFields.map(field => field.field));
  const sourceValidation = validatePromptContract(contract);
  const errorKey = (error: { code: string; field: string | null }) => `${error.code}:${error.field ?? "stage"}`;
  const expectedHardErrors = new Set([
    ...unboundFields.map(field => `HARD_FIELD_VALUE_MISSING:${field.field}`),
    ...(unboundFields.length === 0 ? missingDiagnoses.allowedHardErrors : []),
  ]);
  const actualHardErrors = new Set(recompiled.hardErrors.map(errorKey));
  const recompiledValidation = validatePromptContract(recompiled.contract);
  const recompileMatches = actualHardErrors.size === expectedHardErrors.size
    && [...expectedHardErrors].every(error => actualHardErrors.has(error))
    && isDeepStrictEqual(recompiledValidation.errors, sourceValidation.errors)
    && isDeepStrictEqual(recompiled.contract, contract)
    && isDeepStrictEqual(recompiled.fieldValues, fields);
  if (!recompileMatches) return fail("RECOMPILE_MISMATCH");
  return {
    shotId: contract.shotId, duration: Number(parameters.duration_sec), ...structuredClone(metadata), fields,
    prompt: contract.prompt, sourceContractText: Buffer.from(input.contractBytes).toString("utf8"),
    sourceContractSha256: sha256, sourceContract: structuredClone(contract), compileOptions,
    fieldProofs, unboundFields, missingFieldEvidence: missingDiagnoses.originals, rawAliasState: "not-retained",
  };
}

export interface AllowedFieldDiagnosis {
  shotId: string; field: string; kind: "conflict" | "missing" | "truncation";
  code: string; reason: string; evidenceSha256: string;
  origin: "g6-semantic" | "g6-missing" | "host-diagnostic";
  sourceContractSha256: string; valueSha256: string | null;
  sourceBinding: "bound" | "unbound";
}
export interface AllowedFieldPlan {
  schemaVersion: typeof APPROVED_SOURCE_FIELDS_VERSION;
  sourceContextSha256: string;
  sourceShotsSha256: string;
  maxFinalPromptChars?: number;
  deferPortraitAssetBinding?: boolean;
  shots: RecoveredPromptShot[];
  diagnoses: AllowedFieldDiagnosis[];
  fieldsByShot: Record<string, string[]>;
  sha256: string;
}
export interface PlanFieldAuthoringInput {
  shots: readonly RecoveredPromptShot[];
  sourceContextSha256: string;
  maxFinalPromptChars?: number;
  deferPortraitAssetBinding?: boolean;
  /** Complete, hash-verified G6 reports or host field-diagnostic artifacts; never a client field list. */
  diagnosedFindings: readonly VerifiedFieldArtifact[];
  truncationEvidence?: readonly VerifiedFieldArtifact[];
}
const immutableFields = new Set(["portraits", "constraint", "baseline", "dialogue", "negative", "consistency", "bright_constraint", "audio"]);
function allowsDiagnosedField(field: string, code: unknown): boolean {
  return !immutableFields.has(field) || field === "audio" && code === MARKETING_FINAL_AUDIO_BGM_CODE
    || field === "negative" && code === MARKETING_FINAL_POST_TEXT_CODE
    || field === "baseline" && code === MARKETING_FINAL_RESOLUTION_CODE
    || field === "bright_constraint" && code === MARKETING_FINAL_FACE_CODE
    || field === "character_constraint" && code === MARKETING_FINAL_CHARACTER_COUNT_CODE;
}

const MARKETING_FINAL_MUTABLE_FIELDS = new Set([
  "director_instruction", "scene", "lighting", "camera_movement", "character", "action", "composition",
  "color_palette", "depth_of_field", "timeline", "mood", "costume", "props", "pacing", "makeup",
]);
const MARKETING_FINAL_RIVAL_FIELDS = [
  "director_instruction", "scene", "character", "action", "composition", "timeline", "props", "pacing",
] as const;

/**
 * Turn the current shot-level marketing rejection into exact, hash-bound field
 * diagnostics. The review therefore remains the authority; this function only
 * locates fields affected by the categories named in that complete verdict.
 */
export function marketingFinalFactFieldArtifact(input: {
  failureMessage: string;
  shots: readonly RecoveredPromptShot[];
  sourceContextSha256: string;
}): VerifiedFieldArtifact | undefined {
  checkedHash(input.sourceContextSha256);
  if (!input.shots.length || !input.failureMessage.trim()) return undefined;
  const factualPassWithSuggestions = /无未支持或夸大[^。；\n]{0,40}准予通过|准予通过并附整改建议/u.test(input.failureMessage)
    && !/截断|违反[^。；\n]{0,16}纪律|须修复后再渲染|不能批准|不通过/u.test(input.failureMessage);
  if (factualPassWithSuggestions) return undefined;
  const diagnoses: JsonRecord[] = [], seen = new Set<string>();
  const add = (shot: RecoveredPromptShot, field: string, code: string, reason: string) => {
    if (!allowsDiagnosedField(field, code) || !Object.hasOwn(shot.fields, field)) return;
    const key = `${shot.shotId}:${field}:${code}`;
    if (seen.has(key)) return;
    seen.add(key);
    diagnoses.push({ shotId: shot.shotId, field, kind: "conflict", code, reason,
      sourceContractSha256: shot.sourceContractSha256, valueSha256: sha256Json(shot.fields[field]),
      evidenceRefs: [`marketing-final-fact-review:${code}`] });
  };
  const message = input.failureMessage;
  if (/音频\s*BGM|BGM.*编译纪律|音乐.*编译纪律/u.test(message)) {
    for (const shot of input.shots) {
      const audio = shot.fields.audio;
      if (typeof audio === "string" && /BGM|背景音乐|配乐|器乐|音乐|BPM/iu.test(audio)) add(shot, "audio",
        MARKETING_FINAL_AUDIO_BGM_CODE,
        "最终事实审核指出生成镜头音频与“禁止镜头外 BGM”编译纪律冲突。只保留现场发动机、机械、胎噪、风切、礼炮与呼吸等原生声，删除生成层 BGM/配乐描述；BGM 仅由正式后期音轨加入，不在本镜生成请求中宣称。");
    }
  }
  if (/无贴花|涂装/u.test(message)) {
    for (const shot of input.shots) {
      for (const field of MARKETING_FINAL_MUTABLE_FIELDS) {
        const value = shot.fields[field];
        if (typeof value === "string" && /无贴花|无任何贴花/u.test(value)) add(shot, field,
          "MARKETING_FINAL_UNVERIFIED_LIVERY_ABSENCE",
          "来源明确写有同款外观涂装风格，镜头不能断言商品本身“无贴花”。改为“本片不复制来源涂装与可读标识，商品外观仅作权利安全示意”，保留创意画面，但不对官方涂装作事实否定或精确还原主张。");
      }
    }
  }
  if (/截断|truncat/iu.test(message)) {
    for (const shot of input.shots) {
      const scene = shot.fields.scene;
      if (typeof scene === "string" && /^\s*\{\s*"scene_id"\s*:/u.test(scene)) add(shot, "scene",
        "MARKETING_FINAL_SCENE_TRUNCATED",
        "最终事实审核指出场景字段保留被截断的 JSON 片段。把 scene 重写为完整、可读的中文场景描述：删除残缺的对象前缀与半句，保留已审地点、时间、空间、材质、天气、光向和禁止项；不得恢复或编造未保存的旧原文。");
    }
  }
  const rivalConflict = /竞品证据|竞品对比|竞品劣势|未支持[^。；\n]{0,30}竞品|可视化竞品/u.test(message);
  if (!rivalConflict && /缺少来源支持[^。；\n]{0,40}性能|性能暗示|未支持[^。；\n]{0,24}性能/u.test(message)) {
    const performance = /(?:加速|速度差|高转|极速|狂飙|峰值|追近第[一二三四五六七八九十\d]+台|拉开(?:半个|一个|两个|\d+(?:\.\d+)?个)?车身|发动机转速)/u;
    for (const shot of input.shots) {
      add(shot, "director_instruction", "MARKETING_FINAL_PERFORMANCE_DISCLAIMER",
        "在导演指令中明确：赛道竞速、超越与冲线为广告创意演绎，不以画面或文字宣称极速、加速时间、圈速、功率、扭矩、赛道成绩或厂商背书；不得新增来源未支持的性能数字。");
      for (const field of MARKETING_FINAL_MUTABLE_FIELDS) {
        const value = shot.fields[field];
        if (typeof value === "string" && performance.test(value)) add(shot, field,
          "MARKETING_FINAL_UNSUPPORTED_PERFORMANCE_HINT",
          "来源只支持已列客观规格，不支持本片具体的速度、加速或竞速效果。将表述限定为广告创意演绎中的画内位次、动作和剪辑节奏，不构成车辆性能宣称；保留叙事动作，不新增任何数字或成绩。");
      }
    }
  }
  if (rivalConflict) {
    const rivalContext = /(?:对手|对方|前车|并排|超车|超越|拉开[^。；\n]{0,10}车身|位次)/u;
    for (const shot of input.shots) {
      if (!MARKETING_FINAL_RIVAL_FIELDS.some(field => {
        const value = shot.fields[field];
        return typeof value === "string" && rivalContext.test(value);
      })) continue;
      add(shot, "director_instruction", "MARKETING_FINAL_FICTIONAL_RIVAL_CONTEXT",
        "明确本片需要出现的前方车辆均为无品牌、非商品化运动陪体，不对应任何真实竞品或车型；连续超车与位次变化仅为广告创意演绎，不比较或贬低任何竞品，也不主张市场领先、车辆性能或竞品劣势。");
      for (const field of MARKETING_FINAL_RIVAL_FIELDS) {
        const value = shot.fields[field];
        if (typeof value === "string" && rivalContext.test(value)) add(shot, field,
          "MARKETING_FINAL_FICTIONAL_RIVAL_CONTEXT",
          "把画面中的对手车限定为无品牌、非商品化运动陪体，不指认真实竞品或车型；保留用户要求的连续超车动作，但明确其为广告创意演绎，不作竞品性能对比、竞品劣势或市场领先主张。");
      }
    }
  }
  if (/免责烧录|安全字幕|商品名|无任何文字|画面无任何文字|文字.*冲突|字幕.*冲突/u.test(message)) {
    for (const shot of input.shots) {
      const negative = shot.fields.negative;
      if (typeof negative === "string") add(shot, "negative", MARKETING_FINAL_POST_TEXT_CODE,
        "把“画面无任何文字”限定为生成画面本身：no generated caption/text/logo/watermark。明确『创意演绎 · 赛道专用不可上路』与片尾商品名只由正式后期字幕/叠加层烧录，不属于生成帧文字，也不由生成模型输出；保留两条后期必需文字。");
    }
  }
  if (/8K[^。；\n]{0,30}1080p|1080p[^。；\n]{0,30}8K|分辨率[^。；\n]{0,20}冲突/iu.test(message)) {
    for (const shot of input.shots) {
      if (typeof shot.fields.baseline === "string" && /8K/iu.test(shot.fields.baseline)) add(shot, "baseline",
        MARKETING_FINAL_RESOLUTION_CODE,
        "把画质基线中的8K细节改为与当前1080p原生交付一致的高清电影级细节，不改变摄影写实、纹理和颗粒要求，不声明高于交付画布的源分辨率。");
    }
  }
  if (/面部[^。；\n]{0,20}(?:明亮|清晰)[^。；\n]{0,20}(?:不露脸|互斥)|不露脸[^。；\n]{0,20}面部/iu.test(message)) {
    for (const shot of input.shots) {
      if (typeof shot.fields.bright_constraint === "string" && /面部/u.test(shot.fields.bright_constraint)) add(shot, "bright_constraint",
        MARKETING_FINAL_FACE_CODE,
        "本镜角色戴闭合全盔且不露脸时，删除“面部无阴影明亮清晰”的义务；改为头盔轮廓、马尾发尾、车身与赛道主体明亮清晰，暗部保留层次。");
    }
  }
  if (/补光[^。；\n]{0,16}方位|方位[^。；\n]{0,16}冲突|光位[^。；\n]{0,12}冲突/iu.test(message)) {
    for (const shot of input.shots) {
      for (const field of ["lighting", "scene"] as const) {
        const value = shot.fields[field];
        if (typeof value === "string" && /补光|灯|光位/u.test(value)) add(shot, field,
          "MARKETING_FINAL_LIGHT_DIRECTION_COHERENCE",
          "统一为同一套可执行光位：阴天冷白漫射主光来自画面左上方或上方，看台固定冷白补光统一来自右前方；删除同一镜内互相冲突的左/右补光方位。保留色温、光比、柔和度与前后镜连续性。");
      }
    }
  }
  if (/唯一[^。；\n]{0,12}主角|主角[^。；\n]{0,16}对手[^。；\n]{0,12}同框|对手骑手[^。；\n]{0,16}互斥/iu.test(message)) {
    for (const shot of input.shots) {
      if (typeof shot.fields.character_constraint === "string") add(shot, "character_constraint",
        MARKETING_FINAL_CHARACTER_COUNT_CODE,
        "把人数语义改成“唯一命名主角李英子；另有两名无品牌匿名成年全盔运动陪体骑手”，明确陪体不构成第二个命名主角、不是竞品身份，也不允许主角分身或克隆。");
    }
  }
  if (!diagnoses.length) return undefined;
  const bytes = Buffer.from(canonicalJson({ schemaVersion: "workloom.approved-source-field-diagnostics/v1",
    sourceContextSha256: input.sourceContextSha256, diagnoses }));
  return { bytes, expectedSha256: hashBytes(bytes) };
}
function validateRecoveredShot(shot: RecoveredPromptShot): RecoveredPromptShot {
  const recovered = recoverContractFields({ contractBytes: Buffer.from(shot.sourceContractText),
    expectedSha256: shot.sourceContractSha256, archivedFields: shot.fields,
    missingEvidence: shot.missingFieldEvidence.map(item => ({ bytes: Buffer.from(item.text), expectedSha256: item.sha256 })),
    sceneMetadata: { ...(shot.sceneId ? { sceneId: shot.sceneId } : {}), ...(shot.sceneType ? { sceneType: shot.sceneType } : {}),
      ...(shot.noPeople === undefined ? {} : { noPeople: shot.noPeople }) } });
  if (!isDeepStrictEqual(recovered.fields, shot.fields) || shot.prompt !== recovered.prompt || shot.duration !== recovered.duration
    || shot.shotId !== recovered.shotId || shot.rawAliasState !== "not-retained"
    || !isDeepStrictEqual(shot.compileOptions, recovered.compileOptions)
    || !isDeepStrictEqual(shot.sourceContract, recovered.sourceContract)
    || !isDeepStrictEqual(shot.unboundFields, recovered.unboundFields)
    || !isDeepStrictEqual(shot.missingFieldEvidence, recovered.missingFieldEvidence)
    || !Array.isArray(shot.fieldProofs) || shot.fieldProofs.length !== recovered.fieldProofs.length
    || shot.fieldProofs.some((proof, index) => proof.field !== recovered.fieldProofs[index]!.field
      || proof.valueSha256 !== recovered.fieldProofs[index]!.valueSha256
      || !["archived-field", "request", "prompt-text", "prompt-array", "prompt-scalar", "canonical-none"].includes(proof.carrier))) return fail("SHOT_DRIFT");
  return structuredClone(shot);
}
/** Bind each diagnosed write to a complete recovered contract and its current value digest. */
export function planFieldAuthoring(input: PlanFieldAuthoringInput): AllowedFieldPlan {
  checkedHash(input.sourceContextSha256);
  if (input.maxFinalPromptChars !== undefined
    && (!Number.isSafeInteger(input.maxFinalPromptChars) || input.maxFinalPromptChars <= 0)) {
    return fail("PROMPT_LENGTH_LIMIT_INVALID");
  }
  if (!input.shots.length || new Set(input.shots.map(shot => shot.shotId)).size !== input.shots.length) return fail("SHOTS_INVALID");
  const shots = input.shots.map(validateRecoveredShot);
  const byId = new Map(shots.map(shot => [shot.shotId, shot]));
  const diagnoses: AllowedFieldDiagnosis[] = [];
  const add = (entry: JsonRecord, kind: AllowedFieldDiagnosis["kind"], evidenceSha256: string, origin: AllowedFieldDiagnosis["origin"]) => {
    const shot = typeof entry.shotId === "string" ? byId.get(entry.shotId) : undefined;
    const field = typeof entry.field === "string" ? entry.field : undefined;
    const unbound = shot?.unboundFields.find(item => item.field === field);
    if (!shot || !field || (!Object.hasOwn(shot.fields, field) && !unbound)
      || !allowsDiagnosedField(field, entry.code)) return fail("DIAGNOSIS_SCOPE_INVALID");
    if (unbound && (origin !== "g6-missing" || kind !== "missing" || entry.code !== "HARD_FIELD_VALUE_MISSING"
      || !unbound.diagnosisEvidenceSha256.includes(evidenceSha256))) return fail("MISSING_DIAGNOSIS_UNBOUND");
    if (!unbound && origin === "g6-missing") return fail("MISSING_DIAGNOSIS_NOT_ABSENT");
    if (entry.sourceContractSha256 !== undefined && entry.sourceContractSha256 !== shot.sourceContractSha256) return fail("DIAGNOSIS_CONTRACT_DRIFT");
    const valueSha256 = unbound ? null : sha256Json(shot.fields[field]);
    if (entry.valueSha256 !== undefined && entry.valueSha256 !== valueSha256) return fail("DIAGNOSIS_VALUE_DRIFT");
    if (typeof entry.code !== "string" || !entry.code.trim() || typeof entry.reason !== "string" || !entry.reason.trim()) return fail("DIAGNOSIS_INVALID");
    diagnoses.push({ shotId: shot.shotId, field, kind, code: entry.code, reason: entry.reason, evidenceSha256, origin,
      sourceContractSha256: shot.sourceContractSha256, valueSha256, sourceBinding: unbound ? "unbound" : "bound" });
  };
  for (const item of [...input.diagnosedFindings, ...(input.truncationEvidence ?? [])]) {
    const { parsed, sha256 } = artifact(item);
    if (parsed.schemaVersion === "workloom.approved-source-field-diagnostics/v1") {
      if (parsed.sourceContextSha256 !== input.sourceContextSha256 || !Array.isArray(parsed.diagnoses)) return fail("DIAGNOSIS_CONTEXT_DRIFT");
      for (const raw of parsed.diagnoses) {
        const entry = record(raw);
        if (!["conflict", "missing", "truncation"].includes(String(entry.kind))
          || entry.sourceContractSha256 === undefined || entry.valueSha256 === undefined
          || !Array.isArray(entry.evidenceRefs) || !entry.evidenceRefs.length || !entry.evidenceRefs.every(ref => typeof ref === "string" && ref.trim())) return fail("DIAGNOSIS_INVALID");
        add(entry, entry.kind as AllowedFieldDiagnosis["kind"], sha256, "host-diagnostic");
      }
    } else if (parsed.schemaVersion === "workloom.video-prompt-quality/v2" && Array.isArray(parsed.findings)) {
      for (const raw of parsed.findings) {
        const entry = record(raw);
        if (entry.blocking !== true) continue;
        if (entry.code === "HARD_FINAL_PROMPT_TOO_LONG") {
          if (entry.repairClass !== "deterministic" || input.maxFinalPromptChars === undefined) {
            return fail("FINAL_PROMPT_LENGTH_UNBOUND");
          }
          const target = byId.get(String(entry.shotId));
          if (!target) return fail("DIAGNOSIS_SCOPE_INVALID");
          const editable = FINAL_LENGTH_EDITABLE_FIELDS.filter(field =>
            typeof target.fields[field] === "string" && Boolean((target.fields[field] as string).trim()));
          if (!editable.length) return fail("FINAL_PROMPT_EDITABLE_FIELD_MISSING");
          for (const field of editable) {
            add({ ...entry, field, valueSha256: sha256Json(target.fields[field]),
              reason: `${entry.detail}；只缩短 ${field}，保留全部制作语义与请求通道` }, "truncation", sha256, "host-diagnostic");
          }
          continue;
        }
        if (typeof entry.field !== "string") continue;
        if (entry.code === "HARD_FIELD_VALUE_MISSING" && ["deterministic", "local_patch"].includes(String(entry.repairClass))) {
          add({ ...entry, reason: entry.detail }, "missing", sha256, "g6-missing");
        } else if (entry.repairClass === "semantic") add({ ...entry, reason: entry.detail }, "conflict", sha256, "g6-semantic");
      }
    } else return fail("DIAGNOSIS_ARTIFACT_INVALID");
  }
  const fieldsByShot = Object.fromEntries(shots.map(shot => [shot.shotId,
    [...new Set(diagnoses.filter(entry => entry.shotId === shot.shotId).map(entry => entry.field))]]));
  if (shots.some(shot => shot.unboundFields.some(field => !fieldsByShot[shot.shotId]!.includes(field.field)))) return fail("MISSING_DIAGNOSIS_REQUIRED");
  const body = { schemaVersion: APPROVED_SOURCE_FIELDS_VERSION, sourceContextSha256: input.sourceContextSha256,
    ...(input.maxFinalPromptChars === undefined ? {} : { maxFinalPromptChars: input.maxFinalPromptChars }),
    ...(input.deferPortraitAssetBinding ? { deferPortraitAssetBinding: true } : {}),
    sourceShotsSha256: sha256Json(shots), shots, diagnoses, fieldsByShot };
  return { ...body, sha256: sha256Json(body) };
}

export interface FieldAuthoringSourceContext { brief: unknown; gates: Record<"G1" | "G2" | "G3" | "G4", unknown>; [key: string]: unknown }
export interface FieldAuthoringBudgetEvent {
  phase: "before" | "dispatch" | "after"; shotId: string;
  usage?: { promptTokens: number; completionTokens: number } | null;
  success?: boolean;
  /** Issued by this host, never copied from a model response. Present on every after event. */
  dispatchOutcome?: "verified-complete" | "unverified";
  nativeCompleted?: boolean;
}
export interface FieldAuthoringArchiveInput {
  shotId: string;
  kind: "request" | "response" | "correction-request" | "correction-response" | "snapshot";
  bytes: Uint8Array;
  sha256: string;
}
export interface FieldAuthoringArchiveRef { ref: string; sha256: string }
export interface FieldAuthoringCorrectionReceipt {
  reason: "final-prompt-length";
  rejectedRequest: FieldAuthoringArchiveRef;
  rejectedResponse: FieldAuthoringArchiveRef;
  rejectedPromptChars: number;
  rejectedAllowedFieldChars: number;
  rejectedFieldsSha256: string;
  acceptedPromptChars: number;
  acceptedAllowedFieldChars: number;
  acceptedFieldsSha256: string;
  maxFinalPromptChars: number;
  maxAllowedFieldChars: number;
  rejectedUsage: { promptTokens: number; completionTokens: number };
  usage: { promptTokens: number; completionTokens: number };
}
export interface FieldAuthoringReceipt {
  shotId: string; sourceContextSha256: string; sourceContractSha256: string; planSha256: string;
  authoredAt: string;
  changedFields: string[]; beforeFieldsSha256: string; afterFieldsSha256: string;
  newFields: string[];
  request: FieldAuthoringArchiveRef; response: FieldAuthoringArchiveRef; snapshot: FieldAuthoringArchiveRef;
  correction?: FieldAuthoringCorrectionReceipt;
  usage: { promptTokens: number; completionTokens: number };
  dispatch: { inputSha256: string; requestSha256: string; responseSha256: string; modelId: string; policyVersion: string; registryVersion: string };
  mutableRequestTextPaths: string[];
}
export interface FieldAuthoringShot extends RecoveredPromptShot {
  /** Newly authored text and compiler output; neither is a current G6 approval. */
  authoringProof?: FieldAuthoringReceipt;
  currentContract?: PromptContract;
}
export interface FieldAuthoringResult { shots: FieldAuthoringShot[]; receipts: FieldAuthoringReceipt[]; snapshotSha256: string }
export interface AuthorRepairFieldsInput {
  plan: AllowedFieldPlan; sourceContext: FieldAuthoringSourceContext; engine: WorkloomLLMEngine;
  verifyCurrent: () => void | Promise<void>;
  budgetHook: (event: FieldAuthoringBudgetEvent) => void | Promise<void>;
  archive: (item: FieldAuthoringArchiveInput) => Promise<FieldAuthoringArchiveRef>;
}
function nonempty(value: unknown): boolean {
  if (typeof value === "string") return !!value.trim() && !/^(?:null|undefined|TODO|待生成|占位符)$/iu.test(value.trim());
  if (Array.isArray(value)) return value.length > 0 && value.every(nonempty);
  if (value && typeof value === "object") return Object.keys(value).length > 0 && Object.values(value).every(nonempty);
  return typeof value === "number" || typeof value === "boolean";
}
function sameValueShape(before: unknown, after: unknown): boolean {
  if (Array.isArray(before)) {
    if (!Array.isArray(after) || before.length === 0) return false;
    return before.every(value => sameValueShape(before[0], value))
      ? after.every(value => sameValueShape(before[0], value))
      : after.length === before.length && after.every((value, index) => sameValueShape(before[index], value));
  }
  if (before && typeof before === "object") return !!after && typeof after === "object" && !Array.isArray(after)
    && isDeepStrictEqual(Object.keys(before).sort(), Object.keys(after).sort())
    && Object.keys(before).every(key => sameValueShape((before as JsonRecord)[key], (after as JsonRecord)[key]));
  return before !== null && typeof before === typeof after;
}
/**
 * One normal native dispatch per affected shot, plus at most one same-route
 * correction when a schema-valid answer still misses the exact final-prompt
 * budget. This creates text, never a gate approval.
 */
export async function authorRepairFields(input: AuthorRepairFieldsInput): Promise<FieldAuthoringResult> {
  const { sha256: planSha256, ...planBody } = input.plan;
  if (sha256Json(planBody) !== checkedHash(planSha256) || sha256Json(input.plan.shots) !== input.plan.sourceShotsSha256
    || !jsonTree(input.sourceContext) || sha256Json(input.sourceContext) !== input.plan.sourceContextSha256) return fail("AUTHORING_SOURCE_DRIFT");
  if (input.plan.schemaVersion !== APPROVED_SOURCE_FIELDS_VERSION || !input.plan.shots.length
    || new Set(input.plan.shots.map(shot => shot.shotId)).size !== input.plan.shots.length) return fail("AUTHORING_PLAN_INVALID");
  input.plan.shots.forEach(validateRecoveredShot);
  const expectedFields = Object.fromEntries(input.plan.shots.map(shot => [shot.shotId,
    [...new Set(input.plan.diagnoses.filter(entry => entry.shotId === shot.shotId).map(entry => entry.field))]]));
  if (!isDeepStrictEqual(expectedFields, input.plan.fieldsByShot) || input.plan.diagnoses.some(entry => {
    const shot = input.plan.shots.find(shot => shot.shotId === entry.shotId);
    const unbound = shot?.unboundFields.find(field => field.field === entry.field);
    return !shot || (!Object.hasOwn(shot.fields, entry.field) && !unbound) || !allowsDiagnosedField(entry.field, entry.code)
      || entry.sourceContractSha256 !== shot.sourceContractSha256
      || (unbound ? entry.valueSha256 !== null || entry.sourceBinding !== "unbound" || entry.origin !== "g6-missing"
        || entry.kind !== "missing" || entry.code !== "HARD_FIELD_VALUE_MISSING" || !unbound.diagnosisEvidenceSha256.includes(entry.evidenceSha256)
        : entry.valueSha256 !== sha256Json(shot.fields[entry.field]) || entry.sourceBinding !== "bound");
  }) || input.plan.shots.some(shot => shot.unboundFields.some(field => !expectedFields[shot.shotId]!.includes(field.field)))) return fail("AUTHORING_PLAN_INVALID");
  const documentPresent = (value: unknown) => typeof value === "string" ? Boolean(value.trim())
    : value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
  if (!documentPresent(input.sourceContext.brief) || !input.sourceContext.gates
    || ["G1", "G2", "G3", "G4"].some(gate => !documentPresent(input.sourceContext.gates[gate as "G1"]))) return fail("AUTHORING_CONTEXT_INCOMPLETE");
  if (!WorkloomLLMEngine.supportsStructuredReviewProof(input.engine)) return fail("AUTHORING_ENGINE_UNPROVEN");
  const before = sha256Json({ plan: input.plan, sourceContext: input.sourceContext });
  const verify = async () => {
    await input.verifyCurrent();
    if (sha256Json({ plan: input.plan, sourceContext: input.sourceContext }) !== before) return fail("AUTHORING_SOURCE_DRIFT");
  };
  const archive = async (shotId: string, kind: FieldAuthoringArchiveInput["kind"], bytes: Uint8Array) => {
    const sha256 = hashBytes(bytes), receipt = await input.archive({ shotId, kind, bytes, sha256 });
    if (!receipt.ref?.trim() || receipt.sha256 !== sha256) return fail("AUTHORING_ARCHIVE_UNVERIFIED");
    await verify();
    return receipt;
  };
  await verify();
  const shots: FieldAuthoringShot[] = structuredClone(input.plan.shots), receipts: FieldAuthoringReceipt[] = [];
  for (const shot of shots) {
    const allowed = input.plan.fieldsByShot[shot.shotId] ?? [];
    if (!allowed.length) continue;
    if (new Set(allowed).size !== allowed.length || allowed.some(field => (!Object.hasOwn(shot.fields, field)
      && !shot.unboundFields.some(item => item.field === field)) || !allowsDiagnosedField(field,
        input.plan.diagnoses.find(entry => entry.shotId === shot.shotId && entry.field === field)?.code))) return fail("AUTHORING_SCOPE_INVALID");
    const writable = new Set(allowed);
    const diagnoses = input.plan.diagnoses.filter(entry => entry.shotId === shot.shotId);
    const sourceCompileErrors = compilePromptShot(shot, shot.compileOptions).hardErrors;
    const allowedFieldChars = (fields: JsonRecord) => allowed.reduce((sum, field) => {
      const value = fields[field];
      if (typeof value !== "string") return fail("AUTHORING_PROMPT_BUDGET_INVALID");
      return sum + value.length;
    }, 0);
    const charBudgetApplicable = input.plan.maxFinalPromptChars !== undefined
      && allowed.every(field => typeof shot.fields[field] === "string");
    const sourceAllowedFieldChars = charBudgetApplicable
      ? allowedFieldChars(shot.fields) : null;
    const promptOverflowChars = sourceAllowedFieldChars === null ? 0
      : Math.max(0, shot.prompt.length - input.plan.maxFinalPromptChars!);
    // The compiler adds fixed labels and separators but preserves each plain
    // text field's UTF-16 length. Leave a small reserve so the model receives
    // an integer field-value budget that is strictly easier than the final
    // prompt postcondition.
    const maxAllowedFieldChars = sourceAllowedFieldChars === null ? null
      : Math.max(1, sourceAllowedFieldChars + input.plan.maxFinalPromptChars! - shot.prompt.length - 8);
    const promptBudget = maxAllowedFieldChars === null ? null : {
      maxFinalPromptChars: input.plan.maxFinalPromptChars!,
      sourceFinalPromptChars: shot.prompt.length,
      sourceAllowedFieldChars: sourceAllowedFieldChars!,
      maxAllowedFieldChars,
      requiredReductionChars: Math.max(0, promptOverflowChars + 8),
      availableGrowthChars: Math.max(0, input.plan.maxFinalPromptChars! - shot.prompt.length - 8),
    };
    const timelineDiagnosed = writable.has("timeline") && diagnoses.some(entry => entry.field === "timeline"
      && ["g6-semantic", "host-diagnostic"].includes(entry.origin));
    const audioDiagnosed = writable.has("audio") && diagnoses.some(entry => entry.field === "audio"
      && entry.code === MARKETING_FINAL_AUDIO_BGM_CODE);
    const negativeDiagnosed = writable.has("negative") && diagnoses.some(entry => entry.field === "negative"
      && entry.code === MARKETING_FINAL_POST_TEXT_CODE);
    const baselineDiagnosed = writable.has("baseline") && diagnoses.some(entry => entry.field === "baseline"
      && entry.code === MARKETING_FINAL_RESOLUTION_CODE);
    const brightDiagnosed = writable.has("bright_constraint") && diagnoses.some(entry => entry.field === "bright_constraint"
      && entry.code === MARKETING_FINAL_FACE_CODE);
    const characterCountDiagnosed = writable.has("character_constraint") && diagnoses.some(entry => entry.field === "character_constraint"
      && entry.code === MARKETING_FINAL_CHARACTER_COUNT_CODE);
    const witnessInput = (fields: JsonRecord) => ({ approvedProductionPlan: input.sourceContext.approvedProductionPlan,
      shotId: shot.shotId, duration: shot.duration, action: fields.action, timeline: fields.timeline,
      cameraMovement: fields.camera_movement, characterConstraint: fields.character_constraint });
    // Recompute the existing host witness from the verified current G4 and
    // this exact source. A serialized or model-supplied proof grants no path.
    const rivalWitness = writable.has("character_constraint") ? g6EventWitnessChecks(witnessInput(shot.fields))
      .find(check => check.eventWitness?.family === "rival-driver" && diagnoses.some(entry => entry.origin === "g6-semantic"
        && entry.field === "character_constraint" && entry.code === check.failureCode))?.eventWitness : undefined;
    if ((writable.has("timeline") && !timelineDiagnosed)
      || (writable.has("character_constraint") && !rivalWitness && !characterCountDiagnosed)
      || (writable.has("baseline") && !baselineDiagnosed)
      || (writable.has("bright_constraint") && !brightDiagnosed)
      || (writable.has("audio") && !audioDiagnosed)
      || (writable.has("negative") && !negativeDiagnosed)) {
      return fail("AUTHORING_REQUEST_TEXT_UNPROVEN");
    }
    const prompt = [
      "你是当前影片的字段作者。本次是新创作，不得声称恢复未知的历史原文。",
      "完整冻结Brief、G1–G4原件、所有镜头字段和当前角色图绑定都在下方。只有当前镜头allowedFields可以写入；其余字段、身份、事实、顺序、时长、音频纪律和技术规格保持原样。",
      "逐项解决diagnoses。不要截断或摘要只读上下文，不要把缺失内容转移到别的字段，不要增加场景。",
      "若allowedFields包含timeline，输出必须用T00:00–T00:xx等显式区间从头到尾无缝覆盖本镜总时长；不得用孤立时点、缺口、重叠或越界时间替代完整时间轴。",
      "若allowedFields包含camera_movement，只能写一套可执行的速度与方向计划；不得同时写固定m/s和加速/减速阶段，不得追加未定时的收尾定格模板。",
      "若存在hardFinalPromptBudget，allowedFields所有文本值的UTF-16字符数合计不得超过maxAllowedFieldChars；这是提交前硬后置条件，不能只做轻微压缩。",
      "只返回一个完整JSON对象：shotId、fields。fields必须恰好包含本镜所有allowedFields；已有字段保持原类型，每个值均有实际改变。sourceUnboundFields没有已保存的历史值与类型，只能按完整已审来源新写非空文本；不得声称恢复旧值或旧摘要。禁止额外键、Markdown和解释。",
      canonicalJson({ authoringPlanSha256: planSha256, sourceContext: input.sourceContext, allShots: input.plan.shots.map(source => ({
        shotId: source.shotId, duration: source.duration, fields: source.fields, sourceContractSha256: source.sourceContractSha256,
        request: source.sourceContract.request, modelCapabilities: source.sourceContract.modelCapabilities,
        portraitAssets: source.sourceContract.bindings.find(binding => binding.field === "portraits")?.assets ?? [],
        ...(source.sceneId ? { sceneId: source.sceneId } : {}), ...(source.sceneType ? { sceneType: source.sceneType } : {}),
      })), shotId: shot.shotId,
        duration: shot.duration, allowedFields: allowed, writableFields: Object.fromEntries(Object.entries(shot.fields).filter(([key]) => writable.has(key))),
        readOnlyFields: Object.fromEntries(Object.entries(shot.fields).filter(([key]) => !writable.has(key))),
        sourceUnboundFields: shot.unboundFields, diagnoses, ...(promptBudget ? { hardFinalPromptBudget: promptBudget } : {}),
        ...(rivalWitness ? { hostEventWitness: rivalWitness } : {}) }),
    ].join("\n");
    const schema = { shotId: shot.shotId, fields: Object.fromEntries(allowed.map(field => [field,
      Object.hasOwn(shot.fields, field) ? shot.fields[field] : newFieldSchemaExample])) };
    const options: LLMReasonOptions = { scene: "preproduction", temperature: 0 };
    const dispatchCandidate = async (candidatePrompt: string, correction: boolean) => {
      const request = await archive(shot.shotId, correction ? "correction-request" : "request",
        Buffer.from(canonicalJson({ prompt: candidatePrompt, schema, options, planSha256, sourceContextSha256: input.plan.sourceContextSha256 })));
      await input.budgetHook({ phase: "before", shotId: shot.shotId });
      await verify();
      let result: Awaited<ReturnType<WorkloomLLMEngine["reasonStructuredWithProof"]>> | undefined;
      let measured: { promptTokens: number; completionTokens: number } | null = null;
      let invoked = false;
      let handedOff = false;
      let outcome: Promise<void> | undefined;
      const finishOutcome = () => outcome ??= (async () => {
        if (!invoked) return;
        const nativeCompleted = result ? nativeReasonCompleted(result.result) : false;
        let dispatchOutcome: "verified-complete" | "unverified" = "unverified";
        try {
          // The adapter intentionally omits the authoring proof on syntax
          // failure. Its private current-route receipt can still prove that
          // this failed response completed with measured usage. This only
          // classifies the call; the response above remains rejected.
          if (nativeCompleted && measured && result && (result.proof?.matchesCurrent(candidatePrompt, schema, options)
            || nativeChatJsonSyntaxRouteCurrent(input.engine, result.result))) dispatchOutcome = "verified-complete";
        } finally {
          // A native call must reach the durable outcome tracker exactly once,
          // including unknown usage/proof and errors during archival or parsing.
          await input.budgetHook({ phase: "after", shotId: shot.shotId, usage: measured,
            success: result?.result.success === true, dispatchOutcome, nativeCompleted });
        }
      })();
      try {
        invoked = true;
        const pending = input.engine.reasonStructuredWithProof(candidatePrompt, schema, options);
        // The adapter has actually been invoked. Observe both promises even if
        // a journal hook fails, so its failure cannot abandon a paid response.
        const [answer, notice] = await Promise.allSettled([pending,
          Promise.resolve().then(() => input.budgetHook({ phase: "dispatch", shotId: shot.shotId }))]);
        if (answer.status === "rejected") throw answer.reason;
        result = answer.value;
        const usage = result.result.usage;
        measured = usage && Number.isSafeInteger(usage.promptTokens) && Number(usage.promptTokens) > 0
          && Number.isSafeInteger(usage.completionTokens) && Number(usage.completionTokens) > 0
          ? { promptTokens: usage.promptTokens!, completionTokens: usage.completionTokens! } : null;
        const response = await archive(shot.shotId, correction ? "correction-response" : "response",
          Buffer.from(result.result.content ?? canonicalJson({ success: result.result.success, error: result.result.error ?? "NO_CONTENT" })));
        await verify();
        if (notice.status === "rejected") throw notice.reason;
        const proof = result.proof;
        if (!result.result.success || !measured || typeof result.result.content !== "string" || !proof
          || !proof.matchesCurrent(candidatePrompt, schema, options)) return fail("AUTHORING_RESPONSE_UNPROVEN");
        const parsed = strictJson(result.result.content), nextFields = record(parsed.fields);
        if (!isDeepStrictEqual(Object.keys(parsed).sort(), ["fields", "shotId"]) || parsed.shotId !== shot.shotId
          || !isDeepStrictEqual(Object.keys(nextFields).sort(), [...allowed].sort())
          || !isDeepStrictEqual(parsed, result.result.data)) return fail("AUTHORING_RESPONSE_SCOPE_INVALID");
        handedOff = true;
        return { prompt: candidatePrompt, result, proof, measured, request, response, parsed, nextFields, finishOutcome };
      } finally {
        if (!handedOff) await finishOutcome();
      }
    };
    const candidateFields = (nextFields: JsonRecord) => {
      const priorFields = structuredClone(shot.fields), fields = structuredClone(shot.fields), newFields: string[] = [];
      for (const field of allowed) {
        const value = nextFields[field], existed = Object.hasOwn(shot.fields, field);
        if (!nonempty(value) || (existed ? !sameValueShape(shot.fields[field], value) || isDeepStrictEqual(value, shot.fields[field])
          : typeof value !== "string" || value === newFieldSchemaExample)) return fail("AUTHORING_NOOP_OR_TYPE_INVALID");
        if (!existed) newFields.push(field);
        fields[field] = structuredClone(value);
      }
      for (const field of Object.keys(priorFields)) if (!writable.has(field)
        && !isDeepStrictEqual(fields[field], priorFields[field])) return fail("AUTHORING_READONLY_DRIFT");
      return { priorFields, fields, newFields };
    };
    const evaluateCandidate = (fields: JsonRecord) => {
      const authoredAt = new Date().toISOString();
      const compiled = compilePromptShot({ ...shot, fields }, { ...shot.compileOptions, createdAt: authoredAt });
      const remainingHardErrors = compiled.hardErrors.filter(error => !(input.plan.deferPortraitAssetBinding === true
        && error.code === "HARD_ASSET_MISSING" && error.field === "portraits"
        && sourceCompileErrors.some(source => source.code === error.code && source.field === error.field)));
      if (remainingHardErrors.length || !isDeepStrictEqual(compiled.fieldValues, fields)) return fail("AUTHORING_COMPILE_INVALID");
      const authoredFieldChars = charBudgetApplicable ? allowedFieldChars(fields) : null;
      return { authoredAt, compiled, authoredFieldChars,
        tooLong: input.plan.maxFinalPromptChars !== undefined
          && compiled.contract.prompt.length > input.plan.maxFinalPromptChars };
    };
    const first = await dispatchCandidate(prompt, false);
    let finishSelected = first.finishOutcome;
    try {
      let selected = { ...first, candidate: candidateFields(first.nextFields) };
      let evaluation = evaluateCandidate(selected.candidate.fields);
      let correctionReceipt: FieldAuthoringCorrectionReceipt | undefined;
      if (evaluation.tooLong) {
        if (maxAllowedFieldChars === null || promptBudget === null || evaluation.authoredFieldChars === null) {
          return fail("AUTHORING_PROMPT_BUDGET_INVALID");
        }
        await finishSelected();
        const correctionPrompt = [
          prompt,
          "【最终长度纠偏】上一份已验证响应的字段结构与语义均可使用，但完整编译提示词仍超过硬上限，不能提交。"
            + "重新返回同一shotId与同一fields集合；不要改动任何只读字段、来源事实、动作、身份、时长或请求通道。"
            + "必须首先满足allowedFields文本值UTF-16字符数合计上限，再用完整语义压缩替换超预算的表述。",
          canonicalJson({
            authoringCorrection: {
              attempt: 1,
              reason: "final-prompt-length",
              maxFinalPromptChars: promptBudget.maxFinalPromptChars,
              rejectedPromptChars: evaluation.compiled.contract.prompt.length,
              rejectedAllowedFieldChars: evaluation.authoredFieldChars,
              maxAllowedFieldChars,
              excessChars: Math.max(0, evaluation.compiled.contract.prompt.length - promptBudget.maxFinalPromptChars),
              previousFields: selected.candidate.fields,
              previousFieldsSha256: sha256Json(selected.candidate.fields),
            },
          }),
        ].join("\n");
        const corrected = await dispatchCandidate(correctionPrompt, true);
        const correctedCandidate = candidateFields(corrected.nextFields);
        const correctedEvaluation = evaluateCandidate(correctedCandidate.fields);
        if (correctedEvaluation.tooLong) return fail("AUTHORING_PROMPT_STILL_TOO_LONG");
        if (correctedEvaluation.authoredFieldChars === null
          || correctedEvaluation.authoredFieldChars > maxAllowedFieldChars) return fail("AUTHORING_PROMPT_BUDGET_INVALID");
        correctionReceipt = {
          reason: "final-prompt-length",
          rejectedRequest: first.request,
          rejectedResponse: first.response,
          rejectedPromptChars: evaluation.compiled.contract.prompt.length,
          rejectedAllowedFieldChars: evaluation.authoredFieldChars,
          rejectedFieldsSha256: sha256Json(selected.candidate.fields),
          acceptedPromptChars: correctedEvaluation.compiled.contract.prompt.length,
          acceptedAllowedFieldChars: correctedEvaluation.authoredFieldChars,
          acceptedFieldsSha256: sha256Json(correctedCandidate.fields),
          maxFinalPromptChars: promptBudget.maxFinalPromptChars,
          maxAllowedFieldChars,
          rejectedUsage: first.measured,
          usage: corrected.measured,
        };
        selected = { ...corrected, candidate: correctedCandidate };
        evaluation = correctedEvaluation;
        finishSelected = corrected.finishOutcome;
      }
      const { priorFields, fields: nextFields, newFields } = selected.candidate;
      const { authoredAt, compiled } = evaluation;
      shot.fields = nextFields;
    const mutableRequestTextPaths = [...(timelineDiagnosed ? ["technical.timeline"] : []),
      ...(audioDiagnosed ? ["technical.audio"] : []),
      ...(negativeDiagnosed ? ["parameters.negative_prompt"] : []),
      ...(baselineDiagnosed ? ["technical.baseline"] : []),
      ...(brightDiagnosed ? ["technical.bright_constraint"] : []),
      ...(rivalWitness || characterCountDiagnosed ? ["technical.character_constraint"] : [])];
      const immutableRequest = (contract: PromptContract) => {
        const request = structuredClone(contract.request);
        if (timelineDiagnosed) delete request.technical.timeline;
      if (audioDiagnosed) delete request.technical.audio;
      if (negativeDiagnosed) delete request.parameters.negative_prompt;
      if (baselineDiagnosed) delete request.technical.baseline;
      if (brightDiagnosed) delete request.technical.bright_constraint;
      if (rivalWitness || characterCountDiagnosed) delete request.technical.character_constraint;
        return request;
      };
      const sourcePortrait = shot.sourceContract.bindings.find(binding => binding.field === "portraits")!;
      const currentPortrait = compiled.contract.bindings.find(binding => binding.field === "portraits")!;
      if (!isDeepStrictEqual(immutableRequest(shot.sourceContract), immutableRequest(compiled.contract))
        || !isDeepStrictEqual(shot.sourceContract.modelCapabilities, compiled.contract.modelCapabilities)
        || !isDeepStrictEqual(sourcePortrait.assets, currentPortrait.assets)
        || sourcePortrait.assetApplicability !== currentPortrait.assetApplicability
        || sourcePortrait.valueSha256 !== currentPortrait.valueSha256) return fail("AUTHORING_REQUEST_DRIFT");
      if (rivalWitness && g6EventWitnessRepairDrift(witnessInput(shot.fields), [rivalWitness])) return fail("AUTHORING_EVENT_WITNESS_DRIFT");
      shot.prompt = compiled.prompt;
      const { inputSha256, requestSha256, responseSha256, modelId, policyVersion, registryVersion } = selected.proof;
      const dispatch = { inputSha256, requestSha256, responseSha256, modelId, policyVersion, registryVersion };
      const proof = { shotId: shot.shotId, sourceContextSha256: input.plan.sourceContextSha256, sourceContractSha256: shot.sourceContractSha256,
        planSha256, authoredAt, changedFields: [...allowed], newFields, beforeFieldsSha256: sha256Json(priorFields), afterFieldsSha256: sha256Json(shot.fields),
        request: selected.request, response: selected.response, ...(correctionReceipt ? { correction: correctionReceipt } : {}),
        usage: selected.measured, dispatch, mutableRequestTextPaths };
      const snapshot = await archive(shot.shotId, "snapshot", Buffer.from(canonicalJson({ schemaVersion: APPROVED_SOURCE_FIELDS_VERSION,
        shotId: shot.shotId, authoring: proof, fields: shot.fields, prompt: shot.prompt, contract: compiled.contract })));
      await finishSelected();
      if (!selected.proof.matchesCurrent(selected.prompt, schema, options)) return fail("AUTHORING_DISPATCH_DRIFT");
      const receipt = { ...proof, snapshot };
      shot.authoringProof = receipt;
      shot.currentContract = compiled.contract;
      receipts.push(receipt);
    } finally {
      await finishSelected();
    }
    await verify();
  }
  await verify();
  return { shots, receipts, snapshotSha256: sha256Json(shots) };
}
