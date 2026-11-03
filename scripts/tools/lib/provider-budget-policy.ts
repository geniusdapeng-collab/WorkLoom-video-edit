import { createHash } from "node:crypto";
import {
  planDeepSeekWindow, type BudgetMessage,
} from "../../../packages/base/model-router/token-budget.js";
import { DEEPSEEK_CHAT_PATH, DEEPSEEK_RESPONSES_PATH } from "../../../packages/base/model-router/providers.js";
import {
  EDIT_CANONICAL_CASE_BUDGET, verifyEditCanonicalLlmEnvelope,
} from "../../acceptance/lib/live/edit-canonical-budget.mjs";

export { DEEPSEEK_CHAT_PATH, DEEPSEEK_RESPONSES_PATH };
export const DEEPSEEK_MODEL = EDIT_CANONICAL_CASE_BUDGET.modelId;
export const SEEDREAM_MODEL = "doubao-seedream-5-0-pro-260628";
export const SEEDANCE_MODEL = "doubao-seedance-2-5-260628";

export const TASK_CAPS = Object.freeze({
  llmCalls: 40,
  llmGrossTokens: EDIT_CANONICAL_CASE_BUDGET.maxLlmTokens,
  imageCalls: 8,
  videoCalls: 3,
  minVideoSeconds: 10,
  maxVideoSeconds: 15,
  totalVideoSeconds: 45,
  microCny: 120_000_000,
  windowMs: 45 * 60_000,
});

export const ARK_VIDEO_PATH = "/api/v3/contents/generations/tasks";
export const ARK_IMAGE_PATH = "/api/v3/images/generations";

export type WorkflowBudgetProfile = "workflow" | "workflow-v2";
export type BudgetProfile = "case" | WorkflowBudgetProfile;
export type JsonObject = Record<string, unknown>;
export type ImageProof = { urlHash: string; width: number; height: number };
export type Resolution = "720p" | "1080p";
export type BudgetScope = {
  video: { seconds: number | null; ratio: string | null; resolution: Resolution | null };
  inlineImageSha256: string[];
};
export type Claim =
  | { kind: "llm"; inputTokens: number; maxOutputTokens: number; microCny: number }
  | { kind: "image"; inputImages: number; microCny: number }
  | { kind: "video"; seconds: number; resolution: Resolution; ratio: string; microCny: number };
export type Settlement =
  | { kind: "llm"; inputTokens: number; outputTokens: number; microCny: number }
  | { kind: "image"; image: ImageProof; microCny: number }
  | { kind: "video"; status: "succeeded" | "failed" | "cancelled" | "expired"; microCny: number };

export class BudgetError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    readonly limit?: { profile: "workflow-v2"; resource: "llmCalls"; used: number; cap: number },
  ) {
    super(code);
  }
}

export function check(condition: unknown, code = "BUDGET_UNSUPPORTED_REQUEST", status = 400): asserts condition {
  if (!condition) throw new BudgetError(code, status);
}

export const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export const safeInteger = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min;
export const safeTaskId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
export const safeHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const record = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const within = (value: unknown, min: number, max: number): boolean => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const someText = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
const oneOf = (value: unknown, candidates: string[]): value is string => typeof value === "string" && candidates.includes(value);

function fields(value: unknown, allowed: string[]): asserts value is JsonObject {
  check(record(value) && Object.keys(value).every((key) => allowed.includes(key)));
}

function pictureSize(value: unknown): [number, number] | undefined {
  if (typeof value !== "string" || !/^[1-9]\d{2,3}x[1-9]\d{2,3}$/.test(value)) return;
  const [width, height] = value.split("x").map(Number);
  if (width && height && width <= 4096 && height <= 4096) return [width, height];
}

export function isArkMediaUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash
      && (url.hostname.endsWith(".volces.com") || url.hostname.endsWith(".volcengine.com"));
  } catch {
    return false;
  }
}

function imageData(value: string): string | undefined {
  const header = /^data:image\/(?:png|jpeg|webp);base64,/.exec(value);
  if (!header) return;
  const encoded = value.slice(header[0].length);
  if (encoded.length > 0 && encoded.length <= 40 * 1024 * 1024 && encoded.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return encoded;
}

type FindImage = (hash: string) => ImageProof | undefined;

function imageReference(value: unknown, scope: BudgetScope, known: FindImage): ImageProof | undefined {
  check(typeof value === "string");
  const encoded = imageData(value);
  if (encoded) {
    check(scope.inlineImageSha256.length > 0 && scope.inlineImageSha256.includes(digest(Buffer.from(encoded, "base64"))),
      "BUDGET_UNPROVEN_IMAGE_REFERENCE");
    return;
  }
  const issued = isArkMediaUrl(value) ? known(digest(value)) : undefined;
  check(issued, "BUDGET_UNPROVEN_IMAGE_REFERENCE");
  return issued;
}

// https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
// Peak cache-miss input ¥2/M and output ¥8/M. Estimate all input at the cache-miss rate.
export const llmMicroCny = (input: number, output: number): number => input * 2 + output * 8;

const { microCny: mediaMicroCny, ...caseResourceCaps } = TASK_CAPS;
const nativeInputAtMaxOutput = EDIT_CANONICAL_CASE_BUDGET.maxLlmTokens - EDIT_CANONICAL_CASE_BUDGET.maxLlmOutputTokens;
function workflowTaskCaps(llmCalls: number) {
  return Object.freeze({
    ...caseResourceCaps,
    llmCalls,
    llmGrossTokens: llmCalls * EDIT_CANONICAL_CASE_BUDGET.maxLlmTokens,
    llmEstimatedMaxMicroCny: llmCalls * llmMicroCny(nativeInputAtMaxOutput, EDIT_CANONICAL_CASE_BUDGET.maxLlmOutputTokens),
    mediaMicroCny,
  });
}

export const WORKFLOW_TASK_CAPS = workflowTaskCaps(TASK_CAPS.llmCalls);
export const WORKFLOW_TASK_CAPS_BY_PROFILE = Object.freeze({
  workflow: WORKFLOW_TASK_CAPS,
  "workflow-v2": workflowTaskCaps(64),
});

export function normalizeBudgetProfile(value: unknown = "case"): BudgetProfile {
  check(value === "case" || value === "workflow" || value === "workflow-v2", "BUDGET_PROFILE_INVALID", 503);
  return value;
}

// https://console.volcengine.com/ark/region:cn-beijing/docs/model-pricing
const imageMicroCny = (inputs: number, pixels: number): number => (pixels > 2_610_000 ? 600_000 : 300_000) + Math.max(0, inputs - 1) * 20_000;

const ARK_DIMENSIONS: Record<Resolution, Record<string, readonly [number, number]>> = {
  "720p": { "16:9": [1280, 720], "4:3": [1112, 834], "1:1": [960, 960], "3:4": [834, 1112], "9:16": [720, 1280], "21:9": [1470, 630] },
  "1080p": { "16:9": [1920, 1080], "4:3": [1664, 1248], "1:1": [1440, 1440], "3:4": [1248, 1664], "9:16": [1080, 1920], "21:9": [2206, 946] },
};

export function normalizeBudgetScope(value: unknown = {}): BudgetScope {
  fields(value, ["video", "inlineImageSha256"]);
  const video = value.video ?? {};
  fields(video, ["seconds", "ratio", "resolution"]);
  const seconds = video.seconds ?? null;
  const ratio = video.ratio ?? null;
  const resolution = video.resolution ?? null;
  check(seconds === null || safeInteger(seconds, TASK_CAPS.minVideoSeconds) && seconds <= TASK_CAPS.maxVideoSeconds,
    "BUDGET_SCOPE_INVALID", 503);
  check(ratio === null || typeof ratio === "string" && Object.hasOwn(ARK_DIMENSIONS["1080p"], ratio), "BUDGET_SCOPE_INVALID", 503);
  check(resolution === null || resolution === "720p" || resolution === "1080p", "BUDGET_SCOPE_INVALID", 503);
  const images = value.inlineImageSha256 ?? [];
  check(Array.isArray(images) && images.length <= 128 && images.every(safeHash)
    && new Set(images).size === images.length, "BUDGET_SCOPE_INVALID", 503);
  return { video: { seconds, ratio, resolution }, inlineImageSha256: [...images].sort() };
}

export const videoMicroCny = (resolution: Resolution, providerTokens: number): number => providerTokens * (resolution === "1080p" ? 77 : 70);
function videoEstimate(resolution: Resolution, ratio: string, seconds: number): number {
  const dimensions = Object.hasOwn(ARK_DIMENSIONS[resolution], ratio) ? ARK_DIMENSIONS[resolution][ratio] : undefined;
  check(dimensions);
  // Official no-video-input estimate at 24 fps. Terminal usage is reconciled separately.
  return videoMicroCny(resolution, Math.ceil(seconds * dimensions[0] * dimensions[1] * 24 / 1024));
}

async function llmClaim(body: JsonObject, scope: BudgetScope, known: FindImage): Promise<Claim> {
  fields(body, ["model", "messages", "max_tokens", "response_format", "thinking", "reasoning_effort", "top_p", "temperature", "stream"]);
  check(body.model === DEEPSEEK_MODEL && safeInteger(body.max_tokens, 1)
    && (body.stream === undefined || body.stream === false) && Array.isArray(body.messages) && body.messages.length > 0);
  if (body.response_format !== undefined) {
    fields(body.response_format, ["type"]);
    check(body.response_format.type === "json_object" || body.response_format.type === "text");
  }
  if (body.thinking !== undefined) {
    fields(body.thinking, ["type"]);
    check(body.thinking.type === "enabled" || body.thinking.type === "disabled");
  }
  check(body.reasoning_effort === undefined || oneOf(body.reasoning_effort, ["low", "high", "max"]));
  check(body.top_p === undefined || within(body.top_p, 0, 1));
  check(body.temperature === undefined || within(body.temperature, 0, 2));
  for (const message of body.messages) {
    fields(message, ["role", "content"]);
    check(oneOf(message.role, ["system", "user", "assistant", "tool"]));
    if (typeof message.content === "string") continue;
    check(Array.isArray(message.content) && message.content.length > 0);
    for (const part of message.content) {
      fields(part, ["type", "text", "image_url"]);
      if (part.type === "text") {
        fields(part, ["type", "text"]);
        check(typeof part.text === "string");
      } else {
        fields(part, ["type", "image_url"]);
        check(part.type === "image_url" && message.role === "user");
        fields(part.image_url, ["url", "detail"]);
        check(part.image_url.detail === undefined || oneOf(part.image_url.detail, ["low", "high", "original", "auto"]));
        imageReference(part.image_url.url, scope, known);
      }
    }
  }
  return textClaim(body.model, body.max_tokens, body.messages as BudgetMessage[], body.response_format);
}

async function textClaim(modelId: unknown, maxOutputTokens: number, messages: BudgetMessage[], responseFormat: unknown): Promise<Claim> {
  let plan;
  try {
    plan = await planDeepSeekWindow({ messages, responseFormat });
  } catch {
    throw new BudgetError("BUDGET_UNVERIFIED_LLM_TOKENS", 422);
  }
  try {
    const { inputTokens } = verifyEditCanonicalLlmEnvelope({
      modelId, inputTokens: plan.inputTokens, maxOutputTokens,
    });
    return { kind: "llm", inputTokens, maxOutputTokens, microCny: llmMicroCny(inputTokens, maxOutputTokens) };
  } catch {
    throw new BudgetError("BUDGET_ILLEGAL_LLM_WINDOW", 422);
  }
}

// Validate the bounded JSON Schema dialect actually used by the frozen Scene
// stage. Business content and all native scene semantics are checked by Studio.
function validateSceneSchemaNode(node: unknown, depth: number, remaining: { nodes: number }): void {
  check(record(node) && depth <= 12 && --remaining.nodes >= 0);
  switch (node.type) {
    case "object": {
      fields(node, ["type", "properties", "required", "additionalProperties"]);
      const properties = node.properties;
      check(record(properties) && (node.additionalProperties === undefined || node.additionalProperties === false));
      const keys = Object.keys(properties);
      check(keys.length > 0 && keys.length <= 16 && keys.every((key) => /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key))
        && Array.isArray(node.required) && node.required.length <= keys.length
        && new Set(node.required).size === node.required.length
        && node.required.every((key: unknown) => typeof key === "string" && Object.hasOwn(properties, key)));
      for (const field of Object.values(properties)) validateSceneSchemaNode(field, depth + 1, remaining);
      return;
    }
    case "array":
      fields(node, ["type", "items", "minItems", "maxItems"]);
      check((node.minItems === undefined || safeInteger(node.minItems))
        && (node.maxItems === undefined || safeInteger(node.maxItems) && node.maxItems >= Number(node.minItems ?? 0)));
      validateSceneSchemaNode(node.items, depth + 1, remaining);
      return;
    case "number":
      fields(node, ["type", "minimum", "maximum"]);
      check((node.minimum === undefined || within(node.minimum, 0, 600))
        && (node.maximum === undefined || within(node.maximum, Number(node.minimum ?? 0), 600)));
      return;
    case "string":
      fields(node, ["type", "enum", "minLength", "maxLength"]);
      check((node.minLength === undefined || safeInteger(node.minLength))
        && (node.maxLength === undefined || safeInteger(node.maxLength) && node.maxLength >= Number(node.minLength ?? 0)));
      check(node.enum === undefined || Array.isArray(node.enum) && node.enum.length > 0 && node.enum.length <= 16
        && node.enum.every((item: unknown) => typeof item === "string" && item.length <= 64));
      return;
    default:
      throw new BudgetError("BUDGET_UNSUPPORTED_REQUEST", 400);
  }
}

function fixedSceneNumber(value: unknown, expected: number): boolean {
  return record(value) && value.type === "number" && value.minimum === expected && value.maximum === expected;
}

function checkFrozenSceneScope(schema: unknown, scope: BudgetScope): void {
  check(record(schema) && schema.type === "object" && schema.additionalProperties === false && record(schema.properties));
  const props = schema.properties;
  const names = ["opening", "scenes", "ending", "totalDuration", "sceneCount", "narrativeArc"];
  check(Object.keys(props).length === names.length && names.every((name) => Object.hasOwn(props, name)));
  const required = names.slice(0, -1);
  const declared = schema.required;
  check(Array.isArray(declared) && required.every((name) => declared.includes(name)));
  const middle = props.scenes, seconds = scope.video.seconds;
  check(seconds !== null && record(middle) && middle.type === "array"
    && safeInteger(middle.minItems) && middle.minItems + 2 <= TASK_CAPS.videoCalls && middle.maxItems === middle.minItems);
  const count = middle.minItems + 2;
  check(fixedSceneNumber(props.sceneCount, count) && fixedSceneNumber(props.totalDuration, count * seconds)
    && [props.opening, middle.items, props.ending].every((node) => record(node) && node.type === "object"
      && record(node.properties) && fixedSceneNumber(node.properties.duration, seconds)));
  validateSceneSchemaNode(schema, 0, { nodes: 128 });
}

async function responsesClaim(body: JsonObject, scope: BudgetScope): Promise<Claim> {
  fields(body, ["model", "input", "instructions", "reasoning", "max_output_tokens", "stream", "text"]);
  check(body.model === DEEPSEEK_MODEL && typeof body.input === "string" && body.input.trim()
    && safeInteger(body.max_output_tokens, 1) && body.stream === false);
  const messages: BudgetMessage[] = [];
  if (body.instructions !== undefined) {
    check(typeof body.instructions === "string" && body.instructions.trim());
    messages.push({ role: "system", content: body.instructions });
  }
  messages.push({ role: "user", content: body.input });
  fields(body.reasoning, ["effort"]);
  check(body.reasoning.effort === "high");
  fields(body.text, ["format"]);
  const format = body.text.format;
  fields(format, ["type", "name", "schema"]);
  check(format.type === "json_schema" && format.name === "workloom_scene_architect");
  checkFrozenSceneScope(format.schema, scope);
  return textClaim(body.model, body.max_output_tokens, messages, format);
}

function imageClaim(body: JsonObject, scope: BudgetScope, known: FindImage): Claim {
  fields(body, ["model", "prompt", "size", "response_format", "watermark", "image", "output_format"]);
  check(body.model === SEEDREAM_MODEL && someText(body.prompt) && body.response_format === "url");
  check(body.size === undefined || pictureSize(body.size) || oneOf(body.size, ["1K", "1.5K", "2K"]));
  check(body.watermark === undefined || typeof body.watermark === "boolean");
  check(body.output_format === undefined || oneOf(body.output_format, ["jpeg", "png"]));
  const inputs = body.image === undefined ? [] : Array.isArray(body.image) ? body.image : [body.image];
  check(inputs.length <= 4);
  for (const input of inputs) imageReference(input, scope, known);
  // A single output is guaranteed for this exact SKU with no layer/group fields.
  return { kind: "image", inputImages: inputs.length, microCny: imageMicroCny(inputs.length, 2_610_001) };
}

function videoClaim(body: JsonObject, scope: BudgetScope, known: FindImage): Claim {
  fields(body, ["model", "content", "duration", "ratio", "resolution", "generate_audio", "watermark", "return_last_frame",
    "omni_reference_task_type", "output_format"]);
  check(body.model === SEEDANCE_MODEL && safeInteger(body.duration, TASK_CAPS.minVideoSeconds)
    && body.duration <= TASK_CAPS.maxVideoSeconds && (body.resolution === "720p" || body.resolution === "1080p"));
  check(["generate_audio", "watermark", "return_last_frame"].every((key) => body[key] === undefined || typeof body[key] === "boolean"));
  check(body.output_format === undefined || body.output_format === "mp4");
  check(Array.isArray(body.content) && body.content.length >= 1 && body.content.length <= 5);
  const [prompt, ...images] = body.content as unknown[];
  fields(prompt, ["type", "text"]);
  check(prompt.type === "text" && someText(prompt.text));
  let firstFrame: ImageProof | undefined;
  for (const input of images) {
    fields(input, ["type", "image_url", "role"]);
    check(input.type === "image_url" && (input.role === "reference_image" || input.role === "first_frame"));
    fields(input.image_url, ["url"]);
    const proven = imageReference(input.image_url.url, scope, known);
    if (input.role === "first_frame") {
      check(images.length === 1 && proven, "BUDGET_UNPROVEN_FIRST_FRAME");
      firstFrame = proven;
    }
  }
  let ratio = body.ratio;
  if (firstFrame) {
    check((ratio === undefined || ratio === "adaptive") && body.omni_reference_task_type === undefined);
    const { width, height } = firstFrame;
    ratio = Object.keys(ARK_DIMENSIONS[body.resolution]).find((candidate) => {
      const [x, y] = candidate.split(":").map(Number) as [number, number];
      return width * y === height * x;
    });
  } else {
    check(body.omni_reference_task_type === undefined || images.length > 0 && body.omni_reference_task_type === "reference");
  }
  check(typeof ratio === "string" && Object.hasOwn(ARK_DIMENSIONS[body.resolution], ratio));
  check((scope.video.ratio === null || scope.video.ratio === ratio)
    && (scope.video.resolution === null || scope.video.resolution === body.resolution)
    && (scope.video.seconds === null || scope.video.seconds === body.duration), "BUDGET_VIDEO_SCOPE_MISMATCH");
  return { kind: "video", seconds: body.duration, ratio, resolution: body.resolution,
    microCny: videoEstimate(body.resolution, ratio, body.duration) };
}

export function compileClaim(path: string, body: JsonObject, scope: BudgetScope, known: FindImage): Promise<Claim> | Claim {
  if (path === DEEPSEEK_CHAT_PATH) return llmClaim(body, scope, known);
  if (path === DEEPSEEK_RESPONSES_PATH) return responsesClaim(body, scope);
  if (path === ARK_IMAGE_PATH) return imageClaim(body, scope, known);
  check(path === ARK_VIDEO_PATH);
  return videoClaim(body, scope, known);
}

function textSettlement(input: unknown, output: unknown, total: unknown): Settlement {
  check(safeInteger(input, 1) && safeInteger(output) && output <= EDIT_CANONICAL_CASE_BUDGET.maxLlmOutputTokens
    && safeInteger(total) && total === input + output && total <= EDIT_CANONICAL_CASE_BUDGET.maxLlmTokens,
  "BUDGET_UPSTREAM_USAGE_UNVERIFIED", 502);
  return { kind: "llm", inputTokens: input, outputTokens: output, microCny: llmMicroCny(input, output) };
}

export function responsesSettlement(body: JsonObject): Settlement {
  const usage = body.usage;
  check(body.object === "response" && body.model === DEEPSEEK_MODEL && safeTaskId(body.id)
    && oneOf(body.status, ["completed", "incomplete", "failed"]) && Array.isArray(body.output)
    && body.output.every((item: unknown) => record(item) && oneOf(item.type, ["message", "reasoning"]))
    && record(usage) && !Object.hasOwn(usage, "server_tool_use"), "BUDGET_UPSTREAM_USAGE_UNVERIFIED", 502);
  return textSettlement(usage.input_tokens, usage.output_tokens, usage.total_tokens);
}

export function settlementFor(claim: Claim, body: JsonObject, taskId?: string): Settlement | undefined {
  const usage = record(body.usage) ? body.usage : {};
  if (claim.kind === "llm") {
    check(body.model === DEEPSEEK_MODEL && Array.isArray(body.choices) && body.choices.length === 1,
      "BUDGET_UPSTREAM_USAGE_UNVERIFIED", 502);
    return textSettlement(usage.prompt_tokens, usage.completion_tokens, usage.total_tokens);
  }
  if (claim.kind === "image") {
    const image = Array.isArray(body.data) && body.data.length === 1 ? body.data[0] : undefined;
    const size = record(image) ? pictureSize(image.size) : undefined;
    check(body.model === SEEDREAM_MODEL && record(image) && isArkMediaUrl(image.url) && size
      && usage.generated_images === 1 && usage.input_images === claim.inputImages,
      "BUDGET_UPSTREAM_USAGE_UNVERIFIED", 502);
    return { kind: "image", image: { urlHash: digest(image.url), width: size[0], height: size[1] },
      microCny: imageMicroCny(claim.inputImages, size[0] * size[1]) };
  }
  check(body.id === taskId && body.model === SEEDANCE_MODEL, "BUDGET_UPSTREAM_TASK_UNVERIFIED", 502);
  const status = body.status;
  if (status === "queued" || status === "running" || status === "processing" || status === "submitted") return;
  if (status === "failed" || status === "cancelled" || status === "canceled" || status === "expired") {
    check((usage.completion_tokens === undefined || usage.completion_tokens === 0)
      && (usage.total_tokens === undefined || usage.total_tokens === 0), "BUDGET_UPSTREAM_USAGE_UNVERIFIED", 502);
    return { kind: "video", status: status === "canceled" ? "cancelled" : status, microCny: 0 };
  }
  check(status === "succeeded" && safeInteger(usage.completion_tokens, 1) && safeInteger(usage.total_tokens)
    && usage.total_tokens === usage.completion_tokens && body.duration === claim.seconds
    && body.resolution === claim.resolution && body.ratio === claim.ratio && body.framespersecond === 24
    && record(body.content) && isArkMediaUrl(body.content.video_url),
    "BUDGET_UPSTREAM_USAGE_UNVERIFIED", 502);
  const microCny = videoMicroCny(claim.resolution, usage.completion_tokens);
  check(safeInteger(microCny, 1), "BUDGET_UPSTREAM_USAGE_UNVERIFIED", 502);
  return { kind: "video", status, microCny };
}

export function exceededClaim(claim: Claim, usage: Settlement): boolean {
  return usage.microCny > claim.microCny || claim.kind === "llm" && usage.kind === "llm"
    && (usage.inputTokens + usage.outputTokens > claim.inputTokens + claim.maxOutputTokens
      || usage.outputTokens > claim.maxOutputTokens);
}
