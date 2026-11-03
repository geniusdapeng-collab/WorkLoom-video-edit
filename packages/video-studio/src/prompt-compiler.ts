import {
  PROMPT_CONTRACT_SCHEMA_VERSION,
  PROMPT_CONTRACT_POLICY_VERSION,
  PROMPT_CONTRACT_REQUEST_SCHEMA_VERSION,
  SHOT_FIELD_SCHEMA_V1,
  SHOT_FIELD_SCHEMA_V2,
  promptFieldPolicy,
  promptFieldsHash,
  sha256Json,
  sha256Text,
  validatePromptContract,
  type FieldBinding,
  type PromptAssetBinding,
  type PromptContract,
  type PromptContractRequest,
  type PromptFieldDefinition,
  type PromptModelCapabilities,
  type ShotFieldSchemaVersion,
} from "./prompt-contract.js";
import { isNoSpeechDeclaration, noSpeechClause } from "./dialogue-contract.js";
import { FROZEN_NO_SPEECH_AUDIO_DISCIPLINE } from "./frozen-speech-policy.js";
import { AUDIO_DISCIPLINE_CLAUSE } from "./shot-spec.js";

export interface PromptCompileAsset extends PromptAssetBinding {
  field: "portraits";
}

export interface PromptCompileShot {
  shotId: string;
  sceneType?: string;
  duration: number;
  fields: Record<string, unknown>;
  prompt?: string;
  portraits?: unknown;
  [key: string]: unknown;
}

export interface PromptCompileDelivery {
  aspectRatio: string;
  resolution: string;
  fps: number;
  format: "mp4";
  generateAudio: boolean;
  firstFrame?: boolean;
}

export interface PromptCompileOptions {
  schemaVersion?: ShotFieldSchemaVersion;
  assets?: PromptCompileAsset[];
  /** Explicit production profile. An opening action does not imply a title card. */
  titleCard?: boolean;
  /** G6 only. Replace the pinned vendor's technical template using the frozen delivery. */
  applyFrozenDelivery?: boolean;
  delivery: PromptCompileDelivery;
  model: PromptModelCapabilities;
  requiredClauses?: string[];
  downstreamSpec?: Partial<Record<string, string>>;
  createdAt?: string;
  allowAuxiliaryFieldKeys?: string[];
}

export interface CompiledPromptShot {
  contract: PromptContract;
  prompt: string;
  request: PromptContractRequest;
  /** Canonical field values after no-person/NORMALIZATION rules; keeps asset N/A explicit. */
  fieldValues: Record<string, unknown>;
  hardErrors: Array<{ code: string; field: string | null; detail: string }>;
}

const DEFAULT_AUXILIARY_KEYS = new Set([
  "durationSec",
  "duration_sec",
  "production",
  "dialogueBlocks",
  "promptCharCount",
  "fusionText",
]);

const FROZEN_SOUND_ANNOTATION_PREFIX = "【音频纪律】只保留与画面对应的真实环境声和动作音效；";
const COMPILED_FROZEN_SOUND_ANNOTATION = "【音频纪律】仅留原生环境与动作声；禁止可辨识人声及镜外配乐。";

function safeRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readable(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return value.map((item) => readable(item, depth + 1)).filter(Boolean).join("；");
  if (!safeRecord(value) || depth > 4) return "";
  if (typeof value.string === "string" && value.string.trim()) return value.string.trim();
  return Object.entries(value)
    .filter(([key]) => !key.startsWith("_"))
    .map(([, item]) => readable(item, depth + 1))
    .filter(Boolean)
    .join("；");
}

function placeholder(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "number") return !Number.isFinite(value);
  if (typeof value === "string") {
    const text = value.trim();
    return !text || /^(?:undefined|null|nan|\[object object\])$/i.test(text)
      || /\[object Object\]/.test(text) || /待片头优化器生成|待生成|占位符|TODO/i.test(text);
  }
  if (Array.isArray(value)) return value.length === 0 || value.some(placeholder);
  if (safeRecord(value)) return Object.keys(value).length === 0 || Object.values(value).some(placeholder);
  return false;
}

function fieldValue(shot: PromptCompileShot, key: string): unknown {
  const direct = shot.fields?.[key];
  if (direct !== undefined && !placeholder(direct)) return direct;
  if (key === "dialogue" && Array.isArray(shot.dialogueBlocks) && shot.dialogueBlocks.length > 0) return shot.dialogueBlocks;
  if (key === "portraits" && shot.portraits !== undefined) return shot.portraits;
  return shot[key];
}

function resolvePath(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (!key || !safeRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cursor = target;
  for (const [index, key] of keys.entries()) {
    if (!key) throw new Error(`PROMPT_REQUEST_KEY_INVALID: ${path}`);
    if (index === keys.length - 1) cursor[key] = value;
    else {
      if (!safeRecord(cursor[key])) cursor[key] = {};
      cursor = cursor[key] as Record<string, unknown>;
    }
  }
}

function isNotApplicablePortrait(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  const text = readable(value).trim().toUpperCase();
  return ["NONE", "N/A", "NA", "NOT_APPLICABLE", "不适用", "无", "全片无人", "无角色"].includes(text);
}

function inputMode(delivery: PromptCompileDelivery, assets: PromptCompileAsset[]): PromptContractRequest["inputMode"] {
  if (delivery.firstFrame && assets.length > 0) {
    throw new Error("PROMPT_INPUT_MODE_CONFLICT: 首帧和参考图模式不能混用");
  }
  if (delivery.firstFrame) return "first-frame";
  return assets.length > 0 ? "reference-image" : "text";
}

function validateModelCapabilities(shot: PromptCompileShot, options: PromptCompileOptions, assets: PromptCompileAsset[]): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(shot.duration) || shot.duration <= 0) errors.push("HARD_DURATION_INVALID");
  if (shot.duration < options.model.durationSec.min || shot.duration > options.model.durationSec.max) {
    errors.push(`HARD_DURATION_UNSUPPORTED:${options.model.durationSec.min}-${options.model.durationSec.max}`);
  }
  if (!options.model.aspectRatios.includes(options.delivery.aspectRatio)) errors.push("HARD_ASPECT_UNSUPPORTED");
  if (!options.model.resolutions.includes(options.delivery.resolution)) errors.push("HARD_RESOLUTION_UNSUPPORTED");
  if (assets.length > options.model.maxReferenceImages) errors.push("HARD_REFERENCE_LIMIT");
  if (options.delivery.firstFrame && !options.model.modes.some((mode) => mode === "i2v" || mode === "first-frame")) {
    errors.push("HARD_FIRST_FRAME_UNSUPPORTED");
  }
  if (assets.length > 0 && !options.model.modes.some((mode) => mode === "r2v" || mode === "reference-image")) {
    errors.push("HARD_REFERENCE_UNSUPPORTED");
  }
  if (assets.length === 0 && !options.delivery.firstFrame
    && !options.model.modes.some((mode) => mode === "t2v" || mode === "text")) {
    errors.push("HARD_TEXT_MODE_UNSUPPORTED");
  }
  if (!Number.isInteger(options.delivery.fps) || options.delivery.fps < 1 || options.delivery.fps > 120) errors.push("HARD_FPS_INVALID");
  return errors;
}

function timelineBounds(text: string): number[] {
  const values: number[] = [];
  for (const match of text.matchAll(/(?:T)?(\d{1,2}):(\d{2}(?:\.\d+)?)/g)) {
    values.push(Number(match[1]) * 60 + Number(match[2]));
  }
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(?:s|秒)/gi)) values.push(Number(match[1]));
  return values.filter(Number.isFinite);
}

function validateCrossFields(shot: PromptCompileShot, fields: Map<string, string>, options: PromptCompileOptions): string[] {
  const errors: string[] = [];
  const timeline = fields.get("timeline") || "";
  const bounds = timelineBounds(timeline);
  if (bounds.some((value) => value > shot.duration + 0.001)) errors.push("HARD_TIMELINE_EXCEEDS_DURATION");
  if (fields.has("dialogue") && !options.delivery.generateAudio) {
    const dialogue = fields.get("dialogue") || "";
    if (dialogue && !/(无台词|无人声|不适用|NONE|无对白)/i.test(dialogue)) errors.push("HARD_DIALOGUE_WITHOUT_AUDIO");
  }
  const constraint = fields.get("constraint") || "";
  const aspect = /(\d+:\d+)/.exec(constraint)?.[1];
  if (aspect && aspect !== options.delivery.aspectRatio) errors.push("HARD_CONSTRAINT_ASPECT_CONFLICT");
  const resolution = /(\d+)\s*[x×]\s*(\d+)/i.exec(constraint);
  const requestedPixels = /^\d+x\d+$/i.test(options.delivery.resolution)
    ? options.delivery.resolution.toLowerCase().replace("×", "x")
    : null;
  const declaredPixels = resolution ? `${resolution[1]}x${resolution[2]}` : null;
  if (requestedPixels && declaredPixels && requestedPixels !== declaredPixels) errors.push("HARD_CONSTRAINT_RESOLUTION_CONFLICT");
  const fps = /(\d{1,3})\s*fps/i.exec(constraint)?.[1];
  if (fps && Number(fps) !== options.delivery.fps) errors.push("HARD_CONSTRAINT_FPS_CONFLICT");
  return errors;
}

function buildPromptText(
  fields: Map<string, string>,
  definitions: PromptFieldDefinition[],
  requiredClauses: string[],
): { prompt: string; spans: Map<string, { label: string; start: number; end: number }> } {
  const lines: string[] = [];
  const spans = new Map<string, { label: string; start: number; end: number }>();
  let offset = 0;
  definitions.forEach((definition, index) => {
    const label = `【${definition.label}】`;
    const line = `${String(index + 1).padStart(2, "0")}.${label}${fields.get(definition.key)}`;
    spans.set(definition.key, { label, start: offset, end: offset + line.length });
    lines.push(line);
    offset += line.length + 1;
  });
  for (const clause of requiredClauses.map((value) => value.trim()).filter(Boolean)) {
    if (lines.some((line) => line.includes(clause))) continue;
    lines.push(`【编译纪律】${clause}`);
  }
  return { prompt: lines.join("\n"), spans };
}

export function compilePromptShot(
  shot: PromptCompileShot,
  options: PromptCompileOptions,
): CompiledPromptShot {
  const schemaVersion = options.schemaVersion ?? SHOT_FIELD_SCHEMA_V2;
  if (schemaVersion !== SHOT_FIELD_SCHEMA_V1 && schemaVersion !== SHOT_FIELD_SCHEMA_V2) {
    throw new Error(`PROMPT_FIELD_SCHEMA_INVALID: ${schemaVersion}`);
  }
  const isOpening = shot.sceneType === "opening" || /^S?C?00(?:$|[-_])/i.test(shot.shotId);
  const policy = promptFieldPolicy(schemaVersion, isOpening && options.titleCard !== false);
  const hardErrors: CompiledPromptShot["hardErrors"] = [];
  const add = (code: string, field: string | null, detail: string): void => {
    hardErrors.push({ code, field, detail });
  };
  const auxiliary = new Set([...DEFAULT_AUXILIARY_KEYS, ...(options.allowAuxiliaryFieldKeys ?? [])]);
  for (const key of Object.keys(shot.fields ?? {})) {
    if (!policy.fields.some((field) => field.key === key) && !auxiliary.has(key) && !key.startsWith("_raw")) {
      add("HARD_FIELD_UNKNOWN", key, "镜头字段不在当前 schema 中");
    }
  }
  const fieldValues = new Map<string, unknown>();
  const fieldText = new Map<string, string>();
  const explicitNoPeople = shot.noPeople === true
    || /全片无人|无人物|无角色|no\s+(?:people|person|characters?)|product[- ]only/i.test(
      `${readable(shot.character)} ${readable((shot.fields as Record<string, unknown> | undefined)?.character)}`,
    );
  const noSpeech = isNoSpeechDeclaration(fieldValue(shot, "dialogue"));
  for (const definition of policy.fields) {
    let value = fieldValue(shot, definition.key);
    if (definition.key === "constraint" && options.applyFrozenDelivery && typeof value === "string"
      && /^\s*\d+:\d+画幅[，,]\s*(?:4K|8K)分辨率[，,]\s*24fps[，,]\s*MP4格式[。.]?\s*$/iu.test(value)) {
      const { aspectRatio, resolution, fps } = options.delivery;
      value = `${aspectRatio}画幅，${resolution}分辨率，${fps}fps，MP4格式`;
    }
    if (definition.key === "audio" && noSpeech && typeof value === "string") {
      // This is a host policy annotation, not authored sound. The pinned parser can copy
      // the generic annotation into the audio field, including an incomplete final phrase.
      const annotationAt = value.indexOf("【音频纪律】");
      if (annotationAt >= 0) {
        const annotation = value.slice(annotationAt).trimEnd();
        const authoredSound = value.slice(0, annotationAt).replace(/[；;|\s]+$/u, "");
        if (AUDIO_DISCIPLINE_CLAUSE.startsWith(annotation)) {
          value = authoredSound;
        } else if (annotation.startsWith(FROZEN_SOUND_ANNOTATION_PREFIX)
          && FROZEN_NO_SPEECH_AUDIO_DISCIPLINE.startsWith(annotation)) {
          // Keep the complete meaning in the bound audio field, even if the native
          // field parser retained only a prefix. Other author text is untouched.
          value = authoredSound ? `${authoredSound}；${COMPILED_FROZEN_SOUND_ANNOTATION}` : COMPILED_FROZEN_SOUND_ANNOTATION;
        }
      }
      if (typeof value === "string" && /^人声对话清晰可辨[，,]/u.test(value)) {
        add("HARD_DIALOGUE_AUDIO_CONFLICT", "audio", "无台词镜头的音频字段要求清晰人声对话");
      }
    }
    if (definition.key === "portraits" && explicitNoPeople
      && (value === undefined || (Array.isArray(value) && value.length === 0) || isNotApplicablePortrait(value))) {
      fieldValues.set("portraits", "NONE");
      fieldText.set("portraits", "NONE（本镜明确无人物，不绑定参考图）");
      continue;
    }
    if (placeholder(value)) {
      add("HARD_FIELD_VALUE_MISSING", definition.key, "字段缺失、为空或包含占位符");
      continue;
    }
    const text = readable(value);
    if (!text) {
      add("HARD_FIELD_VALUE_UNREADABLE", definition.key, "字段无法形成可读文本");
      continue;
    }
    fieldValues.set(definition.key, value);
    fieldText.set(definition.key, text);
  }
  const assets = (options.assets ?? []).filter((asset) => asset.field === "portraits");
  for (const asset of options.assets ?? []) {
    if (asset.field !== "portraits") add("HARD_ASSET_FIELD_UNKNOWN", asset.field, "资产只能绑定已声明资产字段");
  }
  for (const error of validateModelCapabilities(shot, options, assets)) add(error.split(":")[0]!, null, error);
  for (const error of validateCrossFields(shot, fieldText, options)) add(error.split(":")[0]!, null, error);

  const portraits = fieldValues.get("portraits");
  const portraitsNotApplicable = portraits !== undefined && isNotApplicablePortrait(portraits);
  if (!portraitsNotApplicable && fieldValues.has("portraits") && assets.length === 0) {
    add("HARD_ASSET_MISSING", "portraits", "定妆照字段没有实际资产字节");
  }
  if (portraitsNotApplicable && assets.length > 0) add("HARD_ASSET_NOTA_AMBIGUOUS", "portraits", "显式不适用却绑定了资产");

  const request: PromptContractRequest = {
    schemaVersion: PROMPT_CONTRACT_REQUEST_SCHEMA_VERSION,
    shotId: shot.shotId,
    modelId: options.model.modelId,
    provider: options.model.provider,
    providerModel: options.model.providerModel,
    inputMode: inputMode(options.delivery, assets),
    parameters: {
      duration_sec: shot.duration,
      aspect_ratio: options.delivery.aspectRatio,
      resolution: options.delivery.resolution,
      fps: options.delivery.fps,
      format: options.delivery.format,
      generate_audio: options.delivery.generateAudio,
      // An unsupported global switch cannot express stable viewpoints inside a shot.
      // The complete authored camera direction still enters the bound prompt.
      camera_fixed: options.model.cameraFixedSupported !== false
        && /固定机位|固定镜头|static camera|fixed camera/i.test(fieldText.get("camera_movement") ?? ""),
      ...(fieldText.has("negative") ? { negative_prompt: fieldText.get("negative") } : {}),
    },
    technical: {},
  };
  for (const definition of policy.fields) {
    if (!fieldValues.has(definition.key)) continue;
    for (const path of definition.requestKeys) {
      if (resolvePath(request, path) === undefined) setPath(request as unknown as Record<string, unknown>, path, fieldValues.get(definition.key));
    }
  }
  const requiredClauses = [
    ...(options.requiredClauses ?? []),
    ...(noSpeech ? [noSpeechClause()] : []),
    "所有字段来自同一版镜头卡；禁止静默删除、截断或改写字段值。",
  ];
  const { prompt, spans } = buildPromptText(fieldText, policy.fields, requiredClauses);
  if (prompt.length > options.model.maxPromptChars) {
    add("HARD_PROMPT_TOO_LONG", null, `提示词 ${prompt.length} 字符超过模型上限 ${options.model.maxPromptChars}`);
  }
  const bindings: FieldBinding[] = policy.fields.flatMap((definition): FieldBinding[] => {
    if (!fieldValues.has(definition.key)) return [];
    const binding: FieldBinding = {
      field: definition.key,
      valueSha256: sha256Json(fieldValues.get(definition.key)),
      channels: [...definition.channels],
      promptSpan: spans.get(definition.key),
      ...(definition.requestKeys.length ? { requestKeys: [...definition.requestKeys] } : {}),
      ...(definition.channels.includes("downstream")
        ? { downstreamSpec: options.downstreamSpec?.[definition.key] ?? `workloom.video.delivery/v1#${definition.key}` }
        : {}),
    };
    if (definition.key === "portraits") {
      binding.assetApplicability = portraitsNotApplicable ? "not_applicable" : "required";
      binding.assets = portraitsNotApplicable ? [] : assets.map(({ field: _field, ...asset }) => ({ ...asset }));
    }
    return [binding];
  });
  const fieldsSha256 = promptFieldsHash(bindings, policy.schemaVersion);
  const contract: PromptContract = {
    schemaVersion: PROMPT_CONTRACT_SCHEMA_VERSION,
    policyVersion: PROMPT_CONTRACT_POLICY_VERSION,
    shotId: shot.shotId,
    fieldSchema: policy.schemaVersion,
    fieldCount: policy.fieldCount,
    fieldsSha256,
    prompt,
    promptSha256: sha256Text(prompt),
    request,
    requestSha256: sha256Json(request),
    bindings,
    modelCapabilities: structuredClone(options.model),
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
  if (hardErrors.length === 0) {
    const validation = validatePromptContract(contract);
    for (const error of validation.errors) add(error.code, error.field, error.detail);
  }
  return {
    contract,
    prompt,
    request,
    fieldValues: Object.fromEntries(fieldValues),
    hardErrors,
  };
}
