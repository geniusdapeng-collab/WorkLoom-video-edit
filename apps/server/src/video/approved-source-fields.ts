import { createHash } from "node:crypto";
import { isDeepStrictEqual, types } from "node:util";
import {
  canonicalJson, compilePromptShot, promptFieldPolicy, sha256Json, validatePromptContract,
  PROMPT_CONTRACT_SCHEMA_VERSION, PROMPT_CONTRACT_POLICY_VERSION, PROMPT_CONTRACT_REQUEST_SCHEMA_VERSION,
  SHOT_FIELD_SCHEMA_V1, SHOT_FIELD_SCHEMA_V2, WorkloomLLMEngine,
  type PromptCompileOptions, type PromptCompileShot, type PromptContract, type LLMReasonOptions,
} from "@hyperreality/video-studio";
import { g6EventWitnessChecks, g6EventWitnessRepairDrift } from "./g6-event-witness.js";

export const APPROVED_SOURCE_FIELDS_VERSION = "workloom.approved-source-fields/v1" as const;
type JsonRecord = Record<string, unknown>;
const hashPattern = /^[a-f0-9]{64}$/u;
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
  rawAliasState: "not-retained";
}
export interface RecoverContractFieldsInput {
  contractBytes: Uint8Array;
  expectedSha256: string;
  archivedFields?: JsonRecord;
  sceneMetadata?: { sceneId?: string; sceneType?: string; noPeople?: boolean };
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
  if (contract.fieldCount !== policy.fieldCount || contract.bindings.length !== policy.fields.length) return fail("FIELD_COUNT_INVALID");
  if (input.archivedFields && !jsonTree(input.archivedFields)) return fail("ARCHIVED_FIELDS_INVALID");
  const metadata = input.sceneMetadata ?? {};
  if (!jsonTree(metadata) || Object.keys(metadata).some(key => !["sceneId", "sceneType", "noPeople"].includes(key))
    || [metadata.sceneId, metadata.sceneType].some(value => value !== undefined && (typeof value !== "string" || !value.trim()))
    || (metadata.noPeople !== undefined && typeof metadata.noPeople !== "boolean")) return fail("SCENE_METADATA_INVALID");
  const fields: JsonRecord = {}, fieldProofs: RecoveredFieldProof[] = [];
  let offset = 0;
  for (const [index, definition] of policy.fields.entries()) {
    const binding = record(contract.bindings[index]);
    const span = record(binding.promptSpan);
    const prefix = `${String(index + 1).padStart(2, "0")}.【${definition.label}】`;
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
  if (recompiled.hardErrors.length || !validatePromptContract(contract).valid || !isDeepStrictEqual(recompiled.contract, contract)
    || !isDeepStrictEqual(recompiled.fieldValues, fields)) return fail("RECOMPILE_MISMATCH");
  return {
    shotId: contract.shotId, duration: Number(parameters.duration_sec), ...structuredClone(metadata), fields,
    prompt: contract.prompt, sourceContractText: Buffer.from(input.contractBytes).toString("utf8"),
    sourceContractSha256: sha256, sourceContract: structuredClone(contract), compileOptions,
    fieldProofs, rawAliasState: "not-retained",
  };
}

export interface AllowedFieldDiagnosis {
  shotId: string; field: string; kind: "conflict" | "missing" | "truncation";
  code: string; reason: string; evidenceSha256: string;
  origin: "g6-semantic" | "host-diagnostic";
  sourceContractSha256: string; valueSha256: string;
}
export interface AllowedFieldPlan {
  schemaVersion: typeof APPROVED_SOURCE_FIELDS_VERSION;
  sourceContextSha256: string;
  sourceShotsSha256: string;
  shots: RecoveredPromptShot[];
  diagnoses: AllowedFieldDiagnosis[];
  fieldsByShot: Record<string, string[]>;
  sha256: string;
}
export interface PlanFieldAuthoringInput {
  shots: readonly RecoveredPromptShot[];
  sourceContextSha256: string;
  /** Complete, hash-verified G6 reports or host field-diagnostic artifacts; never a client field list. */
  diagnosedFindings: readonly VerifiedFieldArtifact[];
  truncationEvidence?: readonly VerifiedFieldArtifact[];
}
const immutableFields = new Set(["portraits", "constraint", "baseline", "dialogue", "negative", "consistency", "bright_constraint", "audio"]);
function validateRecoveredShot(shot: RecoveredPromptShot): RecoveredPromptShot {
  const recovered = recoverContractFields({ contractBytes: Buffer.from(shot.sourceContractText),
    expectedSha256: shot.sourceContractSha256, archivedFields: shot.fields,
    sceneMetadata: { ...(shot.sceneId ? { sceneId: shot.sceneId } : {}), ...(shot.sceneType ? { sceneType: shot.sceneType } : {}),
      ...(shot.noPeople === undefined ? {} : { noPeople: shot.noPeople }) } });
  if (!isDeepStrictEqual(recovered.fields, shot.fields) || shot.prompt !== recovered.prompt || shot.duration !== recovered.duration
    || shot.shotId !== recovered.shotId || shot.rawAliasState !== "not-retained"
    || !isDeepStrictEqual(shot.compileOptions, recovered.compileOptions)
    || !isDeepStrictEqual(shot.sourceContract, recovered.sourceContract)
    || !Array.isArray(shot.fieldProofs) || shot.fieldProofs.length !== recovered.fieldProofs.length
    || shot.fieldProofs.some((proof, index) => proof.field !== recovered.fieldProofs[index]!.field
      || proof.valueSha256 !== recovered.fieldProofs[index]!.valueSha256
      || !["archived-field", "request", "prompt-text", "prompt-array", "prompt-scalar", "canonical-none"].includes(proof.carrier))) return fail("SHOT_DRIFT");
  return structuredClone(shot);
}
/** Bind each diagnosed write to a complete recovered contract and its current value digest. */
export function planFieldAuthoring(input: PlanFieldAuthoringInput): AllowedFieldPlan {
  checkedHash(input.sourceContextSha256);
  if (!input.shots.length || new Set(input.shots.map(shot => shot.shotId)).size !== input.shots.length) return fail("SHOTS_INVALID");
  const shots = input.shots.map(validateRecoveredShot);
  const byId = new Map(shots.map(shot => [shot.shotId, shot]));
  const diagnoses: AllowedFieldDiagnosis[] = [];
  const add = (entry: JsonRecord, kind: AllowedFieldDiagnosis["kind"], evidenceSha256: string, origin: AllowedFieldDiagnosis["origin"]) => {
    const shot = typeof entry.shotId === "string" ? byId.get(entry.shotId) : undefined;
    const field = typeof entry.field === "string" ? entry.field : undefined;
    if (!shot || !field || !Object.hasOwn(shot.fields, field) || immutableFields.has(field)) return fail("DIAGNOSIS_SCOPE_INVALID");
    if (entry.sourceContractSha256 !== undefined && entry.sourceContractSha256 !== shot.sourceContractSha256) return fail("DIAGNOSIS_CONTRACT_DRIFT");
    if (entry.valueSha256 !== undefined && entry.valueSha256 !== sha256Json(shot.fields[field])) return fail("DIAGNOSIS_VALUE_DRIFT");
    if (typeof entry.code !== "string" || !entry.code.trim() || typeof entry.reason !== "string" || !entry.reason.trim()) return fail("DIAGNOSIS_INVALID");
    diagnoses.push({ shotId: shot.shotId, field, kind, code: entry.code, reason: entry.reason, evidenceSha256, origin,
      sourceContractSha256: shot.sourceContractSha256, valueSha256: sha256Json(shot.fields[field]) });
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
        if (entry.blocking !== true || entry.repairClass !== "semantic" || typeof entry.field !== "string") continue;
        add({ ...entry, reason: entry.detail }, "conflict", sha256, "g6-semantic");
      }
    } else return fail("DIAGNOSIS_ARTIFACT_INVALID");
  }
  const fieldsByShot = Object.fromEntries(shots.map(shot => [shot.shotId,
    [...new Set(diagnoses.filter(entry => entry.shotId === shot.shotId).map(entry => entry.field))]]));
  const body = { schemaVersion: APPROVED_SOURCE_FIELDS_VERSION, sourceContextSha256: input.sourceContextSha256,
    sourceShotsSha256: sha256Json(shots), shots, diagnoses, fieldsByShot };
  return { ...body, sha256: sha256Json(body) };
}

export interface FieldAuthoringSourceContext { brief: unknown; gates: Record<"G1" | "G2" | "G3" | "G4", unknown>; [key: string]: unknown }
export interface FieldAuthoringBudgetEvent {
  phase: "before" | "after"; shotId: string;
  usage?: { promptTokens: number; completionTokens: number } | null;
  success?: boolean;
}
export interface FieldAuthoringArchiveInput { shotId: string; kind: "request" | "response" | "snapshot"; bytes: Uint8Array; sha256: string }
export interface FieldAuthoringArchiveRef { ref: string; sha256: string }
export interface FieldAuthoringReceipt {
  shotId: string; sourceContextSha256: string; sourceContractSha256: string; planSha256: string;
  authoredAt: string;
  changedFields: string[]; beforeFieldsSha256: string; afterFieldsSha256: string;
  request: FieldAuthoringArchiveRef; response: FieldAuthoringArchiveRef; snapshot: FieldAuthoringArchiveRef;
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
/** One normal native dispatch per affected shot. This creates text, never a gate approval. */
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
    return !shot || !Object.hasOwn(shot.fields, entry.field) || immutableFields.has(entry.field)
      || entry.sourceContractSha256 !== shot.sourceContractSha256 || entry.valueSha256 !== sha256Json(shot.fields[entry.field]);
  })) return fail("AUTHORING_PLAN_INVALID");
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
    if (new Set(allowed).size !== allowed.length || allowed.some(field => !Object.hasOwn(shot.fields, field) || immutableFields.has(field))) return fail("AUTHORING_SCOPE_INVALID");
    const writable = new Set(allowed);
    const diagnoses = input.plan.diagnoses.filter(entry => entry.shotId === shot.shotId);
    const timelineDiagnosed = writable.has("timeline") && diagnoses.some(entry => entry.field === "timeline" && entry.origin === "g6-semantic");
    const witnessInput = (fields: JsonRecord) => ({ approvedProductionPlan: input.sourceContext.approvedProductionPlan,
      shotId: shot.shotId, duration: shot.duration, action: fields.action, timeline: fields.timeline,
      cameraMovement: fields.camera_movement, characterConstraint: fields.character_constraint });
    // Recompute the existing host witness from the verified current G4 and
    // this exact source. A serialized or model-supplied proof grants no path.
    const rivalWitness = writable.has("character_constraint") ? g6EventWitnessChecks(witnessInput(shot.fields))
      .find(check => check.eventWitness?.family === "rival-driver" && diagnoses.some(entry => entry.origin === "g6-semantic"
        && entry.field === "character_constraint" && entry.code === check.failureCode))?.eventWitness : undefined;
    if ((writable.has("timeline") && !timelineDiagnosed) || (writable.has("character_constraint") && !rivalWitness)) {
      return fail("AUTHORING_REQUEST_TEXT_UNPROVEN");
    }
    const prompt = [
      "你是当前影片的字段作者。本次是新创作，不得声称恢复未知的历史原文。",
      "完整冻结Brief、G1–G4原件、所有镜头字段和当前角色图绑定都在下方。只有当前镜头allowedFields可以写入；其余字段、身份、事实、顺序、时长、音频纪律和技术规格保持原样。",
      "逐项解决diagnoses。不要截断或摘要只读上下文，不要把缺失内容转移到别的字段，不要增加场景。",
      "只返回一个完整JSON对象：shotId、fields。fields必须恰好包含本镜所有allowedFields，值保持原类型，每个值均有实际改变；禁止额外键、Markdown和解释。",
      canonicalJson({ sourceContext: input.sourceContext, allShots: input.plan.shots.map(source => ({
        shotId: source.shotId, duration: source.duration, fields: source.fields, sourceContractSha256: source.sourceContractSha256,
        request: source.sourceContract.request, modelCapabilities: source.sourceContract.modelCapabilities,
        portraitAssets: source.sourceContract.bindings.find(binding => binding.field === "portraits")?.assets ?? [],
        ...(source.sceneId ? { sceneId: source.sceneId } : {}), ...(source.sceneType ? { sceneType: source.sceneType } : {}),
      })), shotId: shot.shotId,
        duration: shot.duration, allowedFields: allowed, writableFields: Object.fromEntries(Object.entries(shot.fields).filter(([key]) => writable.has(key))),
        readOnlyFields: Object.fromEntries(Object.entries(shot.fields).filter(([key]) => !writable.has(key))),
        diagnoses, ...(rivalWitness ? { hostEventWitness: rivalWitness } : {}) }),
    ].join("\n");
    const schema = { shotId: shot.shotId, fields: Object.fromEntries(allowed.map(field => [field, shot.fields[field]])) };
    const options: LLMReasonOptions = { scene: "preproduction", temperature: 0 };
    const request = await archive(shot.shotId, "request", Buffer.from(canonicalJson({ prompt, schema, options, planSha256, sourceContextSha256: input.plan.sourceContextSha256 })));
    await input.budgetHook({ phase: "before", shotId: shot.shotId });
    await verify();
    let result: Awaited<ReturnType<WorkloomLLMEngine["reasonStructuredWithProof"]>>;
    try { result = await input.engine.reasonStructuredWithProof(prompt, schema, options); }
    catch (error) {
      await input.budgetHook({ phase: "after", shotId: shot.shotId, usage: null, success: false });
      await verify();
      throw error;
    }
    const usage = result.result.usage;
    const measured = usage && Number.isSafeInteger(usage.promptTokens) && Number(usage.promptTokens) > 0
      && Number.isSafeInteger(usage.completionTokens) && Number(usage.completionTokens) > 0
      ? { promptTokens: usage.promptTokens!, completionTokens: usage.completionTokens! } : null;
    let response: FieldAuthoringArchiveRef;
    // A completed provider call must reach accounting even when the artifact
    // store or source readback fails. An archive failure still fails the run.
    try {
      response = await archive(shot.shotId, "response", Buffer.from(result.result.content ?? canonicalJson({ success: result.result.success, error: result.result.error ?? "NO_CONTENT" })));
    } finally {
      await input.budgetHook({ phase: "after", shotId: shot.shotId, usage: measured, success: result.result.success });
    }
    await verify();
    if (!result.result.success || !measured || typeof result.result.content !== "string" || !result.proof
      || !result.proof.matchesCurrent(prompt, schema, options)) return fail("AUTHORING_RESPONSE_UNPROVEN");
    const parsed = strictJson(result.result.content), nextFields = record(parsed.fields);
    if (!isDeepStrictEqual(Object.keys(parsed).sort(), ["fields", "shotId"]) || parsed.shotId !== shot.shotId
      || !isDeepStrictEqual(Object.keys(nextFields).sort(), [...allowed].sort())
      || !isDeepStrictEqual(parsed, result.result.data)) return fail("AUTHORING_RESPONSE_SCOPE_INVALID");
    const priorFields = structuredClone(shot.fields);
    for (const field of allowed) {
      const value = nextFields[field];
      if (!nonempty(value) || !sameValueShape(shot.fields[field], value) || isDeepStrictEqual(value, shot.fields[field])) return fail("AUTHORING_NOOP_OR_TYPE_INVALID");
      shot.fields[field] = structuredClone(value);
    }
    for (const field of Object.keys(priorFields)) if (!writable.has(field)
      && !isDeepStrictEqual(shot.fields[field], priorFields[field])) return fail("AUTHORING_READONLY_DRIFT");
    const authoredAt = new Date().toISOString();
    const compiled = compilePromptShot(shot, { ...shot.compileOptions, createdAt: authoredAt });
    if (compiled.hardErrors.length || !isDeepStrictEqual(compiled.fieldValues, shot.fields)) return fail("AUTHORING_COMPILE_INVALID");
    const mutableRequestTextPaths = [...(timelineDiagnosed ? ["technical.timeline"] : []),
      ...(rivalWitness ? ["technical.character_constraint"] : [])];
    const immutableRequest = (contract: PromptContract) => {
      const request = structuredClone(contract.request);
      if (timelineDiagnosed) delete request.technical.timeline;
      if (rivalWitness) delete request.technical.character_constraint;
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
    const { inputSha256, requestSha256, responseSha256, modelId, policyVersion, registryVersion } = result.proof;
    const dispatch = { inputSha256, requestSha256, responseSha256, modelId, policyVersion, registryVersion };
    const proof = { shotId: shot.shotId, sourceContextSha256: input.plan.sourceContextSha256, sourceContractSha256: shot.sourceContractSha256,
      planSha256, authoredAt, changedFields: [...allowed], beforeFieldsSha256: sha256Json(priorFields), afterFieldsSha256: sha256Json(shot.fields),
      request, response, usage: measured, dispatch, mutableRequestTextPaths };
    const snapshot = await archive(shot.shotId, "snapshot", Buffer.from(canonicalJson({ schemaVersion: APPROVED_SOURCE_FIELDS_VERSION,
      shotId: shot.shotId, authoring: proof, fields: shot.fields, prompt: shot.prompt, contract: compiled.contract })));
    if (!result.proof.matchesCurrent(prompt, schema, options)) return fail("AUTHORING_DISPATCH_DRIFT");
    const receipt = { ...proof, snapshot };
    shot.authoringProof = receipt;
    shot.currentContract = compiled.contract;
    receipts.push(receipt);
  }
  await verify();
  return { shots, receipts, snapshotSha256: sha256Json(shots) };
}
