import { createHash } from "node:crypto";

export const PROMPT_CONTRACT_SCHEMA_VERSION = "workloom.video-prompt-contract/v2" as const;
export const PROMPT_CONTRACT_POLICY_VERSION = "workloom.video-prompt-contract-policy/v2" as const;
export const PROMPT_CONTRACT_REQUEST_SCHEMA_VERSION = "workloom.video-prompt-request/v2" as const;
export const SHOT_FIELD_SCHEMA_V2 = "workloom.video-shot-card/v2" as const;
export const SHOT_FIELD_SCHEMA_V1 = "workloom.video-shot-card/v1" as const;

export type ShotFieldSchemaVersion =
  | typeof SHOT_FIELD_SCHEMA_V1
  | typeof SHOT_FIELD_SCHEMA_V2;
export type PromptContractMode = "off" | "shadow" | "enforce";
export type ConsumptionChannel =
  | "prompt"
  | "request"
  | "asset"
  | "downstream"
  | "eligibility";
export type PromptAssetApplicability = "required" | "not_applicable";

export interface PromptFieldDefinition {
  key: string;
  label: string;
  tier: "p0" | "p1" | "p2" | "p3" | "opening";
  channels: ConsumptionChannel[];
  requestKeys: string[];
}

export interface PromptFieldPolicy {
  schemaVersion: ShotFieldSchemaVersion;
  isOpening: boolean;
  fieldCount: number;
  fields: PromptFieldDefinition[];
}

export interface PromptAssetBinding {
  role: string;
  sha256: string;
  bytes: number;
  mediaType: string;
  sourceRef?: string;
}

export interface FieldBinding {
  field: string;
  valueSha256: string;
  channels: ConsumptionChannel[];
  promptSpan?: { label: string; start: number; end: number };
  requestKeys?: string[];
  assets?: PromptAssetBinding[];
  assetApplicability?: PromptAssetApplicability;
  downstreamSpec?: string;
}

export interface PromptModelCapabilities {
  modelId: string;
  provider: string;
  providerModel: string;
  version: string;
  modes: string[];
  durationSec: { min: number; max: number };
  aspectRatios: string[];
  resolutions: string[];
  maxReferenceImages: number;
  maxPromptChars: number;
}

export interface PromptContractRequest {
  schemaVersion: typeof PROMPT_CONTRACT_REQUEST_SCHEMA_VERSION;
  shotId: string;
  modelId: string;
  provider: string;
  providerModel: string;
  inputMode: "text" | "first-frame" | "reference-image";
  parameters: Record<string, unknown>;
  technical: Record<string, unknown>;
}

export interface PromptContract {
  schemaVersion: typeof PROMPT_CONTRACT_SCHEMA_VERSION;
  policyVersion: typeof PROMPT_CONTRACT_POLICY_VERSION;
  shotId: string;
  fieldSchema: ShotFieldSchemaVersion;
  fieldCount: number;
  fieldsSha256: string;
  prompt: string;
  promptSha256: string;
  request: PromptContractRequest;
  requestSha256: string;
  bindings: FieldBinding[];
  modelCapabilities: PromptModelCapabilities;
  createdAt: string;
}

const BASE_FIELD_DEFINITIONS: ReadonlyArray<Omit<PromptFieldDefinition, "channels" | "requestKeys"> & {
  requestKeys?: string[];
  channels?: ConsumptionChannel[];
  asset?: boolean;
  downstream?: boolean;
  eligibility?: boolean;
}> = [
  { key: "director_instruction", label: "导演指令", tier: "p0" },
  { key: "constraint", label: "约束", tier: "p0", requestKeys: ["parameters.duration_sec", "parameters.aspect_ratio", "parameters.resolution", "parameters.fps", "parameters.format"], eligibility: true },
  { key: "baseline", label: "基础", tier: "p0", requestKeys: ["technical.baseline"] },
  { key: "scene", label: "场景", tier: "p0" },
  { key: "lighting", label: "灯光", tier: "p0" },
  { key: "camera_movement", label: "运镜", tier: "p0", requestKeys: ["parameters.camera_fixed"] },
  { key: "character", label: "角色", tier: "p0" },
  { key: "action", label: "动作", tier: "p0" },
  { key: "portraits", label: "定妆照", tier: "p0", asset: true, eligibility: true },
  { key: "dialogue", label: "台词", tier: "p0", requestKeys: ["parameters.generate_audio", "technical.dialogue"] },
  { key: "negative", label: "负面约束", tier: "p0", requestKeys: ["parameters.negative_prompt"], eligibility: true },
  { key: "consistency", label: "角色一致性", tier: "p0", requestKeys: ["technical.consistency"], eligibility: true },
  { key: "composition", label: "构图", tier: "p1" },
  { key: "color_palette", label: "色彩/色调", tier: "p1" },
  { key: "depth_of_field", label: "景深", tier: "p1" },
  { key: "timeline", label: "时间轴", tier: "p1", requestKeys: ["parameters.duration_sec", "technical.timeline"] },
  { key: "mood", label: "情绪", tier: "p1" },
  { key: "bright_constraint", label: "明亮约束", tier: "p1", requestKeys: ["technical.bright_constraint"] },
  { key: "character_constraint", label: "角色约束", tier: "p1", requestKeys: ["technical.character_constraint"], eligibility: true },
  { key: "costume", label: "服装", tier: "p2" },
  { key: "props", label: "道具", tier: "p2" },
  { key: "pacing", label: "节奏", tier: "p2" },
  { key: "audio", label: "音频", tier: "p2", requestKeys: ["parameters.generate_audio", "technical.audio"] },
  { key: "makeup", label: "化妆", tier: "p3" },
  { key: "transition", label: "转场", tier: "p3", downstream: true },
];

export const OPENING_FIELD_DEFINITIONS: ReadonlyArray<Omit<PromptFieldDefinition, "channels" | "requestKeys"> & {
  requestKeys?: string[];
  channels?: ConsumptionChannel[];
  downstream?: boolean;
}> = [
  { key: "title_content", label: "主标题内容", tier: "opening", downstream: true },
  { key: "subtitle_content", label: "副标题内容", tier: "opening", downstream: true },
  { key: "title_animation", label: "标题动画设计", tier: "opening", downstream: true },
  { key: "title_font_design", label: "标题字体设计", tier: "opening", downstream: true },
  { key: "opening_audio_design", label: "开场音频设计", tier: "opening", downstream: true },
];

function definitionWithChannels(
  value: (typeof BASE_FIELD_DEFINITIONS)[number] | (typeof OPENING_FIELD_DEFINITIONS)[number],
): PromptFieldDefinition {
  const channels = new Set<ConsumptionChannel>(["prompt"]);
  for (const channel of value.channels ?? []) channels.add(channel);
  if (value.requestKeys?.length) channels.add("request");
  if ("asset" in value && value.asset) channels.add("asset");
  if ("downstream" in value && value.downstream) channels.add("downstream");
  if ("eligibility" in value && value.eligibility) channels.add("eligibility");
  return {
    key: value.key,
    label: value.label,
    tier: value.tier,
    channels: [...channels],
    requestKeys: [...(value.requestKeys ?? [])],
  };
}

export function promptFieldPolicy(
  schemaVersion: ShotFieldSchemaVersion,
  isOpening: boolean,
): PromptFieldPolicy {
  const opening = schemaVersion === SHOT_FIELD_SCHEMA_V2 && isOpening;
  const definitions = [
    ...BASE_FIELD_DEFINITIONS.map(definitionWithChannels),
    ...(opening ? OPENING_FIELD_DEFINITIONS.map(definitionWithChannels) : []),
  ];
  return {
    schemaVersion,
    isOpening,
    fieldCount: definitions.length,
    fields: definitions,
  };
}

export function promptContractMode(value: string | undefined): PromptContractMode {
  const normalized = value?.trim().toLowerCase() || "off";
  if (normalized === "off" || normalized === "shadow" || normalized === "enforce") return normalized;
  throw new Error(`PROMPT_CONTRACT_MODE_INVALID: ${value}`);
}

export function canonicalJson(value: unknown): string {
  const stable = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(stable);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stable(entry)]));
  };
  return JSON.stringify(stable(value));
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requestValue(request: PromptContractRequest, keyPath: string): unknown {
  let value: unknown = request;
  for (const key of keyPath.split(".")) {
    if (!key || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function promptFieldsHash(bindings: FieldBinding[], schemaVersion: string): string {
  return sha256Json({
    schemaVersion,
    fields: bindings.map((binding) => structuredClone(binding)),
  });
}

export function promptContractManifestHash(contracts: readonly PromptContract[]): string {
  if (contracts.length === 0) throw new Error("PROMPT_CONTRACT_MANIFEST_EMPTY: 没有镜头合同");
  return sha256Json(contracts
    .map((contract) => ({
      shotId: contract.shotId,
      fieldSchema: contract.fieldSchema,
      fieldCount: contract.fieldCount,
      fieldsSha256: contract.fieldsSha256,
      promptSha256: contract.promptSha256,
      requestSha256: contract.requestSha256,
    }))
    .sort((left, right) => left.shotId.localeCompare(right.shotId)));
}

export interface PromptContractValidation {
  valid: boolean;
  errors: Array<{ code: string; field: string | null; detail: string }>;
}

export function validatePromptContract(contract: PromptContract): PromptContractValidation {
  const errors: PromptContractValidation["errors"] = [];
  const add = (code: string, field: string | null, detail: string): void => {
    errors.push({ code, field, detail });
  };
  if (contract.schemaVersion !== PROMPT_CONTRACT_SCHEMA_VERSION) add("HARD_CONTRACT_SCHEMA_INVALID", null, "合同 schemaVersion 非法");
  const policy = promptFieldPolicy(contract.fieldSchema, contract.bindings.some((binding) => binding.field === "title_content"));
  if (contract.fieldCount !== policy.fieldCount) add("HARD_FIELD_COUNT_MISMATCH", null, `字段数 ${contract.fieldCount}，策略要求 ${policy.fieldCount}`);
  const expected = new Map(policy.fields.map((field) => [field.key, field]));
  const seen = new Set<string>();
  for (const binding of contract.bindings) {
    if (seen.has(binding.field)) add("HARD_FIELD_DUPLICATE", binding.field, "字段绑定重复");
    seen.add(binding.field);
    const definition = expected.get(binding.field);
    if (!definition) {
      add("HARD_FIELD_UNKNOWN", binding.field, "字段不在当前字段策略中");
      continue;
    }
    if (!/^[a-f0-9]{64}$/.test(binding.valueSha256)) add("HARD_FIELD_VALUE_HASH_INVALID", binding.field, "字段值摘要非法");
    for (const channel of definition.channels) {
      if (!binding.channels.includes(channel)) add("HARD_FIELD_CHANNEL_MISSING", binding.field, `缺少消费渠道 ${channel}`);
    }
    if (!binding.promptSpan) {
      add("HARD_PROMPT_SPAN_MISSING", binding.field, "缺少提示词定位片段");
    } else {
      const { start, end, label } = binding.promptSpan;
      if (start < 0 || end <= start || end > contract.prompt.length || !contract.prompt.slice(start, end).includes(label)) {
        add("HARD_PROMPT_SPAN_INVALID", binding.field, "提示词定位片段越界或内容不符");
      }
    }
    for (const requestKey of definition.requestKeys) {
      if (!binding.requestKeys?.includes(requestKey) || requestValue(contract.request, requestKey) === undefined) {
        add("HARD_REQUEST_BINDING_MISSING", binding.field, `缺少请求消费 ${requestKey}`);
      }
    }
    if (definition.channels.includes("asset")) {
      if (binding.assetApplicability === "not_applicable") {
        if (binding.assets?.length) add("HARD_ASSET_NOTA_AMBIGUOUS", binding.field, "不适用资产不能同时携带字节");
      } else if (!binding.assets?.length) {
        add("HARD_ASSET_MISSING", binding.field, "资产字段没有实际资产绑定");
      } else {
        for (const asset of binding.assets) {
          if (!/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || !asset.mediaType) {
            add("HARD_ASSET_INVALID", binding.field, "资产缺少摘要、字节数或媒体类型");
          }
        }
      }
    }
    if (definition.channels.includes("downstream") && !binding.downstreamSpec?.trim()) {
      add("HARD_DOWNSTREAM_BINDING_MISSING", binding.field, "下游消费缺少具体契约");
    }
  }
  for (const field of expected.keys()) if (!seen.has(field)) add("HARD_FIELD_UNBOUND", field, "字段没有任何消费绑定");
  if (promptFieldsHash(contract.bindings, contract.fieldSchema) !== contract.fieldsSha256) add("HARD_FIELDS_HASH_MISMATCH", null, "字段绑定摘要不一致");
  if (sha256Text(contract.prompt) !== contract.promptSha256) add("HARD_PROMPT_HASH_MISMATCH", null, "提示词摘要不一致");
  if (sha256Json(contract.request) !== contract.requestSha256) add("HARD_REQUEST_HASH_MISMATCH", null, "请求摘要不一致");
  return { valid: errors.length === 0, errors };
}

export function samePromptContractBinding(left: PromptContract, right: PromptContract): boolean {
  return left.shotId === right.shotId
    && left.fieldSchema === right.fieldSchema
    && left.fieldCount === right.fieldCount
    && left.fieldsSha256 === right.fieldsSha256
    && left.promptSha256 === right.promptSha256
    && left.requestSha256 === right.requestSha256
    && left.prompt === right.prompt
    && canonicalJson(left.request) === canonicalJson(right.request);
}
