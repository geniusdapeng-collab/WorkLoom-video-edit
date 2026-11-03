/**
 * Sole OpenAI-compatible text transport.
 *
 * Text calls use one canonical model (`deepseek-flash`). Media generation has
 * a separate registry and is intentionally not handled here.
 */
import { createHash } from "node:crypto";
import { types } from "node:util";
import { maskDeep } from "../workdata/pii.js";
import {
  canonicalDeepSeekModel,
  planDeepSeekWindow,
  DEEPSEEK_FLASH_MODEL_ID,
  DEEPSEEK_FLASH_CONTEXT_TOKENS,
  DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  TEXT_PRIMARY_POLICY_VERSION,
  TEXT_PRIMARY_REGISTRY_VERSION,
  type BudgetMessage,
  type ModelContentPart,
  type ModelMessageContent,
} from "./token-budget.js";
import {
  resolveTextScenePolicy,
  type TextScenePolicy,
  type ThinkingEffort,
} from "./deepseek-policy.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ModelMessageContent;
}

export interface ChatUsageReceipt {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  promptCacheHitTokens: number | null;
  promptCacheMissTokens: number | null;
}

/** Measured stop with a blank final JSON-mode message. This is failure evidence. */
export type NativeBlankJsonReceipt = Readonly<{
  modelId: typeof DEEPSEEK_FLASH_MODEL_ID;
  responseId: string;
  requestHash: string;
  responseHash: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
}>;

/** The original final text of one measured, completed Scene Responses dispatch. */
export type NativeSceneResponseSource = Readonly<{
  rawText: string;
  requestSha256: string;
  responseSha256: string;
  schemaSha256: string;
}>;

export interface ChatResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  modelId: string;
  finishReason: "stop";
  reasoningTokens: number;
  requestHash: string;
  responseHash: string;
  responseId: string | null;
  scene: string;
  mode: "enabled" | "disabled";
  effort?: ThinkingEffort;
  outputCeiling: number;
  inputTokenEstimate: number;
  imageCount: number;
  policyVersion: string;
  registryVersion: string;
  attempts: Array<{ attempt: number; code?: string; httpStatus?: number; unknown?: boolean; retryable?: boolean }>;
}

/** Generation controls only; model selection, credentials and accounting stay centralized. */
export interface ChatGenerationOptions {
  temperature?: number;
  topP?: number;
  /** @deprecated Ignored. Product output caps require an explicit product rule. */
  maxTokens?: number;
  responseFormat?: { type: string };
  responsesJsonSchema?: ResponsesJsonSchema;
  thinking?: Record<string, unknown>;
  reasoningEffort?: ThinkingEffort;
  /** Validated product constraint; absence means the complete legal output window. */
  productOutputCap?: number;
  scene?: string;
}

export interface ResponsesJsonSchema {
  name: string;
  schema: Record<string, unknown>;
}

export interface ChatOptions extends ChatGenerationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
}

export type ModelProviderErrorKind =
  | "cancelled"
  | "timeout"
  | "network"
  | "http"
  | "protocol"
  | "empty"
  | "unknown";

export class ModelProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ModelProviderErrorKind,
    readonly options: {
      retryable?: boolean;
      status?: number;
      unknown?: boolean;
      cause?: unknown;
      receipt?: Partial<ChatResult>;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModelProviderError";
  }

  get retryable(): boolean {
    return this.options.retryable ?? false;
  }

  get unknown(): boolean {
    return this.options.unknown ?? false;
  }
}

export interface ModelProvider {
  readonly modelId: string;
  healthy(): Promise<boolean>;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
}

export function mockCredits(modelId: string, result: ChatResult): number {
  const per1k = modelId.includes("flagship") ? 4 : 1;
  return Math.max(1, Math.ceil((result.promptTokens + result.completionTokens) / 1_000) * per1k);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") return record.text;
      if (record.type === "output_text" && typeof record.text === "string") return record.text;
      return "";
    })
    .join("")
    .trim();
}

function sanitizeContent(content: ModelMessageContent): ModelMessageContent {
  if (typeof content === "string") return maskDeep(content).value;
  return content.map((part): ModelContentPart => {
    if (part.type === "text") return { ...part, text: maskDeep(part.text).value };
    return part;
  });
}

/**
 * Deterministic offline provider. It is allowed only when `LLM_PROVIDER=mock`
 * and is never used as a production fallback.
 */
export class MockProvider implements ModelProvider {
  private calls = 0;

  constructor(
    public readonly modelId: string = DEEPSEEK_FLASH_MODEL_ID,
    private readonly opts: { failFirst?: number; down?: boolean } = {},
  ) {}

  async healthy(): Promise<boolean> {
    return !this.opts.down;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    if (opts.signal?.aborted) throw new ModelProviderError("模型调用已取消", "cancelled");
    this.calls += 1;
    if (this.opts.failFirst && this.calls <= this.opts.failFirst) {
      throw new ModelProviderError(`mock 故障注入（第 ${this.calls} 次）`, "network", {
        retryable: true,
      });
    }
    const last = messages[messages.length - 1];
    const content = typeof last?.content === "string"
      ? last.content
      : Array.isArray(last?.content)
        ? last.content.map((part) => part.type === "text" ? part.text : "").join("")
        : "";
    const masked = maskDeep(content).value;
    const text = `[mock:${this.modelId}] ${masked.slice(0, 40)} → 确定性应答`;
    const requestHash = createHash("sha256").update(JSON.stringify(messages)).digest("hex");
    return {
      text,
      promptTokens: Math.max(1, content.length),
      completionTokens: Math.max(1, text.length),
      modelId: this.modelId,
      finishReason: "stop",
      reasoningTokens: 0,
      requestHash,
      responseHash: createHash("sha256").update(text).digest("hex"),
      responseId: null,
      scene: opts.scene ?? "generic",
      mode: opts.thinking?.type === "enabled" ? "enabled" : "disabled",
      effort: opts.reasoningEffort,
      outputCeiling: DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
      inputTokenEstimate: content.length,
      imageCount: 0,
      policyVersion: TEXT_PRIMARY_POLICY_VERSION,
      registryVersion: TEXT_PRIMARY_REGISTRY_VERSION,
      attempts: [],
    };
  }
}

interface OpenAiResponse {
  id?: string;
  model?: string;
  object?: string;
  error?: unknown;
  choices?: Array<{
    index?: number;
    finish_reason?: string;
    message?: {
      content?: unknown;
      reasoning_content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\/anthropic$/i, "");
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function completionUsage(data: OpenAiResponse, thinkingEnabled: boolean, outputCeiling: number) {
  const promptTokens = data.usage?.prompt_tokens;
  const completionTokens = data.usage?.completion_tokens;
  const totalTokens = data.usage?.total_tokens;
  const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens;
  if (!safeInteger(promptTokens) || !safeInteger(completionTokens)
    || !safeInteger(totalTokens) || totalTokens !== promptTokens + completionTokens) {
    throw new ModelProviderError("模型 usage 缺失或无效", "protocol", { retryable: false });
  }
  if (reasoningTokens !== undefined && (!safeInteger(reasoningTokens) || reasoningTokens > completionTokens)) {
    throw new ModelProviderError("模型 reasoning_tokens 无效", "protocol", { retryable: false });
  }
  if (!thinkingEnabled && reasoningTokens !== undefined && reasoningTokens !== 0) {
    throw new ModelProviderError("非思考场景返回了 reasoning tokens", "protocol", { retryable: false, unknown: true });
  }
  if (completionTokens > outputCeiling || totalTokens > DEEPSEEK_FLASH_CONTEXT_TOKENS) {
    throw new ModelProviderError("模型 usage 超过本次预算", "protocol", { retryable: false, unknown: true });
  }
  return { promptTokens, completionTokens, reasoningTokens: reasoningTokens ?? 0 };
}

function isNativeChatJsonMessage(data: OpenAiResponse): data is OpenAiResponse & { id: string } {
  const choice = data.choices?.[0];
  const message = objectRecord(choice?.message);
  const usage = objectRecord(data.usage);
  if (data.object !== "chat.completion" || data.error != null || typeof data.id !== "string" || !data.id.trim()
    || !Array.isArray(data.choices) || data.choices.length !== 1 || choice?.index !== 0 || choice.finish_reason !== "stop"
    || message?.role !== "assistant" || typeof message.content !== "string"
    || message.refusal != null || message.function_call != null
    || (message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length !== 0))
    || !usage || (usage.completion_tokens_details != null && !objectRecord(usage.completion_tokens_details))) return false;
  const hit = usage.prompt_cache_hit_tokens;
  const miss = usage.prompt_cache_miss_tokens;
  const promptTokens = usage.prompt_tokens;
  if (!safeInteger(promptTokens)) return false;
  if (hit !== undefined && (!safeInteger(hit) || hit > promptTokens)) return false;
  if (miss !== undefined && (!safeInteger(miss) || miss > promptTokens)) return false;
  return !safeInteger(hit) || !safeInteger(miss) || hit + miss === promptTokens;
}

function responsesCompletion(value: unknown, model: string): OpenAiResponse {
  const data = objectRecord(value);
  const invalid = () => new ModelProviderError("模型 Responses 未返回完整的单一结构化应答", "protocol");
  if (!data || data.object !== "response" || data.model !== model || data.status !== "completed"
    || typeof data.id !== "string" || !data.id.trim()
    || data.error != null || data.incomplete_details != null || !Array.isArray(data.output)) throw invalid();
  const first = objectRecord(data.output[0]);
  const hasReasoning = first?.type === "reasoning";
  if (data.output.length !== (hasReasoning ? 2 : 1)
    || (hasReasoning && first?.status !== undefined && first.status !== "completed")) throw invalid();
  const message = hasReasoning ? objectRecord(data.output[1]) : first;
  if (message?.type !== "message" || message.status !== "completed" || message.role !== "assistant"
    || (message.phase !== undefined && message.phase !== "final_answer")
    || !Array.isArray(message.content) || message.content.length !== 1) throw invalid();
  const part = objectRecord(message.content[0]);
  if (part?.type !== "output_text" || typeof part.text !== "string") throw invalid();

  const usage = objectRecord(data.usage);
  const input = usage?.input_tokens;
  const output = usage?.output_tokens;
  const total = usage?.total_tokens;
  const details = objectRecord(usage?.output_tokens_details);
  const reasoning = details?.reasoning_tokens;
  if (!safeInteger(input) || !safeInteger(output) || !safeInteger(total) || total !== input + output
    || (usage?.output_tokens_details != null && !details)
    || (reasoning !== undefined && (!safeInteger(reasoning) || reasoning > output))) throw invalid();

  return {
    id: data.id,
    model,
    choices: [{ finish_reason: "stop", message: { content: part.text } }],
    usage: {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: total,
      completion_tokens_details: { reasoning_tokens: reasoning },
    },
  };
}

function policyForOptions(opts: ChatOptions): TextScenePolicy {
  const responseFormat = opts.responseFormat?.type;
  if (responseFormat !== undefined && responseFormat !== "json_object" && responseFormat !== "text") {
    throw new Error(`MODEL_RESPONSE_FORMAT_INVALID: ${responseFormat}`);
  }
  let thinking: TextScenePolicy["thinking"] | undefined;
  if (opts.thinking) {
    if (opts.thinking.type !== "enabled" && opts.thinking.type !== "disabled") {
      throw new Error(`MODEL_THINKING_POLICY_INVALID: ${String(opts.thinking.type)}`);
    }
    if (opts.thinking.type === "enabled") {
      const effort = opts.reasoningEffort ?? "high";
      if (!["low", "high", "max"].includes(effort)) {
        throw new Error(`MODEL_THINKING_POLICY_INVALID: ${effort}`);
      }
      thinking = { type: "enabled", effort };
    } else {
      thinking = { type: "disabled" };
    }
  }
  return resolveTextScenePolicy(opts.scene ?? "generic", {
    ...(responseFormat ? { responseFormat } : {}),
    ...(thinking ? { thinking } : {}),
  });
}

interface OpenAiTransport {
  fetchImpl: typeof fetch;
  endpoint: string;
  authorization: string | undefined;
}

type OpenAiDispatch = OpenAiTransport & { provider: OpenAiCompatibleProvider };
type BlankJsonDispatch = OpenAiDispatch & Pick<ChatResult, "scene" | "mode" | "effort">;
const openAiTransportReceipts = new WeakMap<ChatResult, OpenAiDispatch & {
  finalJson?: boolean;
  sceneResponse?: NativeSceneResponseSource;
}>();
const nativeBlankJsonErrors = new WeakMap<ModelProviderError, NativeBlankJsonReceipt>();
const nativeBlankJsonDispatches = new WeakMap<NativeBlankJsonReceipt, BlankJsonDispatch>();
export const DEEPSEEK_CHAT_PATH = "/chat/completions";
export const DEEPSEEK_RESPONSES_PATH = "/responses";
const SCENE_RESPONSES_SCHEMA_NAME = "workloom_scene_architect";

function isNativeEndpoint(endpoint: string, path: typeof DEEPSEEK_CHAT_PATH | typeof DEEPSEEK_RESPONSES_PATH): boolean {
  try {
    const url = new URL(endpoint);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.pathname.endsWith(path) && !url.search && !url.hash
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Canonical DeepSeek transport. The complete serialized request is tokenized
 * before dispatch and the output ceiling is the maximum legal remainder.
 */
export class OpenAiCompatibleProvider implements ModelProvider {
  readonly modelId: typeof DEEPSEEK_FLASH_MODEL_ID;
  private readonly baseUrl: string;
  private static readonly nativeAuthHeaders = OpenAiCompatibleProvider.prototype.authHeaders;

  constructor(
    modelId: string,
    private readonly cfg: { baseUrl: string; apiKey?: string; fetchImpl?: typeof fetch },
  ) {
    this.modelId = canonicalDeepSeekModel(modelId);
    this.baseUrl = normalizeBaseUrl(cfg.baseUrl);
    if (!/^https?:\/\//i.test(this.baseUrl)) throw new Error("MODEL_ENDPOINT_INVALID");
  }

  private authHeaders(): Record<string, string> {
    return this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {};
  }

  /** Compare the actual successful attempt with current dispatch without exposing transport credentials. */
  matchesCurrentTransport(
    receipt: ChatResult, path: typeof DEEPSEEK_CHAT_PATH | typeof DEEPSEEK_RESPONSES_PATH = DEEPSEEK_CHAT_PATH,
  ): boolean {
    const dispatched = openAiTransportReceipts.get(receipt);
    return !!dispatched && dispatched.provider === this && !types.isProxy(this) && this.#matchesTransport(dispatched, path);
  }

  /** Reads only a source attached to the exact successful native Responses result. */
  readNativeSceneResponseSource(receipt: ChatResult): NativeSceneResponseSource | undefined {
    const dispatched = openAiTransportReceipts.get(receipt);
    if (dispatched?.provider === this && dispatched.sceneResponse && !types.isProxy(this)
      && this.#matchesTransport(dispatched, DEEPSEEK_RESPONSES_PATH)) return dispatched.sceneResponse;
    return undefined;
  }

  /** Reads proof only from the error thrown by this exact native Chat dispatch. */
  readNativeBlankJson(error: unknown): NativeBlankJsonReceipt | undefined {
    const receipt = error instanceof ModelProviderError ? nativeBlankJsonErrors.get(error) : undefined;
    return receipt && this.#matchesBlankDispatch(nativeBlankJsonDispatches.get(receipt)) ? receipt : undefined;
  }

  matchesNativeBlankJsonTransport(receipt: NativeBlankJsonReceipt): boolean {
    return this.#matchesBlankDispatch(nativeBlankJsonDispatches.get(receipt));
  }

  #matchesBlankDispatch(dispatched: BlankJsonDispatch | undefined): dispatched is BlankJsonDispatch {
    return dispatched?.provider === this && this.modelId === DEEPSEEK_FLASH_MODEL_ID
      && !types.isProxy(this) && this.#matchesTransport(dispatched, DEEPSEEK_CHAT_PATH);
  }

  /** The pair is only used by the bounded blank-repair consumer. */
  matchesNativeBlankJsonCorrection(first: NativeBlankJsonReceipt, second: ChatResult): boolean {
    const before = nativeBlankJsonDispatches.get(first);
    const after = openAiTransportReceipts.get(second);
    return this.#matchesBlankDispatch(before) && after?.provider === this && after.finalJson === true
      && this.#matchesTransport(after, DEEPSEEK_CHAT_PATH) && before.scene === second.scene
      && before.mode === second.mode && before.effort === second.effort
      && first.requestHash !== second.requestHash && first.responseId !== second.responseId;
  }

  #matchesTransport(dispatched: OpenAiTransport, path: typeof DEEPSEEK_CHAT_PATH | typeof DEEPSEEK_RESPONSES_PATH): boolean {
    const authMethod = Object.getOwnPropertyDescriptor(this, "authHeaders")
      ?? Object.getOwnPropertyDescriptor(OpenAiCompatibleProvider.prototype, "authHeaders");
    const cfg = Object.getOwnPropertyDescriptor(this, "cfg")?.value as OpenAiCompatibleProvider["cfg"] | undefined;
    if (authMethod?.value !== OpenAiCompatibleProvider.nativeAuthHeaders
      || !cfg || types.isProxy(cfg) || Object.getPrototypeOf(cfg) !== Object.prototype) return false;
    const fetchImpl = Object.getOwnPropertyDescriptor(cfg, "fetchImpl");
    const apiKey = Object.getOwnPropertyDescriptor(cfg, "apiKey");
    const baseUrl = Object.getOwnPropertyDescriptor(this, "baseUrl")?.value;
    // Accessors and inherited overrides still dispatch normally, but cannot attest to future inputs.
    if ((fetchImpl ? !("value" in fetchImpl) : "fetchImpl" in cfg)
      || (apiKey ? !("value" in apiKey) : "apiKey" in cfg)
      || typeof baseUrl !== "string"
      || (apiKey?.value !== undefined && typeof apiKey.value !== "string")) return false;
    return dispatched.fetchImpl === (fetchImpl?.value ?? fetch)
      && dispatched.endpoint === `${baseUrl}${path}`
      && dispatched.authorization === (apiKey?.value ? `Bearer ${apiKey.value}` : undefined);
  }

  private static async failureDetail(response: Response): Promise<string> {
    const raw = await response.text().catch(() => "");
    let detail = raw.trim();
    try {
      const value = JSON.parse(raw) as { error?: { message?: unknown; code?: unknown } };
      detail = [value.error?.code, value.error?.message]
        .filter(item => typeof item === "string" && item.trim())
        .join(": ");
    } catch {
      /* Non-JSON provider errors retain bounded text. */
    }
    return detail
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "<redacted>")
      .slice(0, 500);
  }

  async healthy(): Promise<boolean> {
    const fetchImpl = this.cfg.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(`${this.baseUrl}/models`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok || response.status === 404;
    } catch {
      return false;
    }
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    if (messages.length === 0) throw new ModelProviderError("模型任务至少需要一条消息", "protocol");
    const masked = messages.map((message) => ({
      ...message,
      content: sanitizeContent(message.content),
    }));
    const policy = policyForOptions(opts);
    const mode = policy.thinking.type;
    const effort = mode === "enabled" ? policy.thinking.effort ?? "high" : undefined;
    const responses = opts.responsesJsonSchema;
    const [system, user] = masked;
    let structuredRequest: { instructions: string; input: string; format: { type: "json_schema" } & ResponsesJsonSchema } | undefined;
    if (responses !== undefined) {
      const name = responses?.name;
      if (mode !== "enabled" || effort !== "high" || policy.responseFormat !== "json_object" || opts.productOutputCap !== undefined
        || masked.length !== 2 || system?.role !== "system" || user?.role !== "user"
        || typeof system.content !== "string" || !system.content.trim()
        || typeof user.content !== "string" || !user.content.trim()
        || typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)
        || !objectRecord(responses.schema)) {
        throw new ModelProviderError("模型 Responses 结构化请求参数无效", "protocol");
      }
      // The planner and HTTP request must use the same schema snapshot.
      const schema = objectRecord(JSON.parse(JSON.stringify(responses.schema)));
      if (!schema) throw new ModelProviderError("模型 Responses 结构化请求参数无效", "protocol");
      structuredRequest = {
        instructions: system.content,
        input: user.content,
        format: { type: "json_schema", name, schema },
      };
    }
    const responseFormat = policy.responseFormat === "json_object" ? { type: "json_object" } : undefined;
    const plan = await planDeepSeekWindow({
      messages: masked as BudgetMessage[],
      responseFormat: structuredRequest?.format ?? responseFormat,
      productOutputCap: opts.productOutputCap,
    });
    const thinkingEnabled = mode === "enabled";
    const topP = thinkingEnabled && opts.topP !== undefined
      ? Math.min(1, Math.max(0.95, opts.topP))
      : opts.topP;
    const requestBody: Record<string, unknown> = structuredRequest ? {
      model: this.modelId,
      input: structuredRequest.input,
      instructions: structuredRequest.instructions,
      reasoning: { effort },
      max_output_tokens: plan.outputCeiling,
      stream: false,
      text: { format: structuredRequest.format },
    } : {
      model: this.modelId,
      messages: masked,
      max_tokens: plan.outputCeiling,
      response_format: responseFormat,
      thinking: thinkingEnabled
        ? { type: "enabled" }
        : { type: "disabled" },
      ...(thinkingEnabled
        ? {
            reasoning_effort: effort,
            ...(topP === undefined ? {} : { top_p: topP }),
          }
        : {
            temperature: opts.temperature ?? policy.temperature ?? 0.2,
            ...(topP === undefined ? {} : { top_p: topP }),
          }),
    };
    const body = JSON.stringify(requestBody);
    const requestHash = createHash("sha256").update(body).digest("hex");
    const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 180_000;
    const maxRetries = !structuredRequest && Number.isSafeInteger(opts.retries) && Number(opts.retries) >= 0
      ? Number(opts.retries)
      : 0;
    const attempts: ChatResult["attempts"] = [];

    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = opts.signal
        ? AbortSignal.any([opts.signal, timeoutSignal])
        : timeoutSignal;
      let response: Response;
      let transport: OpenAiTransport;
      try {
        const fetchImpl = this.cfg.fetchImpl ?? fetch;
        const endpoint = `${this.baseUrl}${structuredRequest ? DEEPSEEK_RESPONSES_PATH : DEEPSEEK_CHAT_PATH}`;
        const headers = this.authHeaders();
        transport = { fetchImpl, endpoint, authorization: headers.authorization };
        response = await fetchImpl(endpoint, {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/json", accept: "application/json", ...headers },
          body,
          signal,
        });
      } catch (error) {
        if (opts.signal?.aborted) {
          throw new ModelProviderError("模型调用已取消（调用方 abort）", "cancelled", {
            retryable: false,
            cause: error,
          });
        }
        if (timeoutSignal.aborted) {
          throw new ModelProviderError(`模型调用超时（>${Math.round(timeoutMs / 1000)}s）`, "timeout", {
            retryable: false,
            unknown: true,
            cause: error,
          });
        }
        throw new ModelProviderError("模型网络结果未知", "network", {
          retryable: false,
          unknown: true,
          cause: error,
        });
      }

      if (!response.ok) {
        const detail = await OpenAiCompatibleProvider.failureDetail(response);
        const retryable = !structuredRequest && response.status === 429;
        const error = new ModelProviderError(
          `模型调用失败：HTTP ${response.status}${detail ? `（${detail}）` : ""}`,
          "http",
          {
            status: response.status,
            retryable,
            unknown: response.status >= 500,
          },
        );
        attempts.push({
          attempt,
          code: error.kind,
          httpStatus: response.status,
          unknown: error.unknown,
          retryable,
        });
        if (retryable && attempt <= maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        Object.assign(error.options, { receipt: { attempts } });
        throw error;
      }

      let rawBody: string;
      try {
        rawBody = await response.text();
      } catch (error) {
        if (opts.signal?.aborted) {
          throw new ModelProviderError("模型调用已取消（调用方 abort）", "cancelled", {
            retryable: false,
            cause: error,
          });
        }
        if (timeoutSignal.aborted) {
          throw new ModelProviderError(`模型调用超时（>${Math.round(timeoutMs / 1000)}s）`, "timeout", {
            retryable: false,
            unknown: true,
            cause: error,
          });
        }
        throw new ModelProviderError("模型响应读取失败", "network", {
          retryable: false,
          unknown: true,
          cause: error,
        });
      }
      const responseHash = createHash("sha256").update(rawBody).digest("hex");
      let decoded: unknown;
      try {
        decoded = JSON.parse(rawBody);
      } catch (error) {
        throw new ModelProviderError("模型响应不是合法 JSON", "protocol", {
          retryable: false,
          cause: error,
        });
      }
      const data = structuredRequest ? responsesCompletion(decoded, this.modelId) : decoded as OpenAiResponse;
      if (data.model !== this.modelId) {
        throw new ModelProviderError(
          `模型响应身份 ${data.model ?? "<missing>"} 与请求 ${this.modelId} 不一致`,
          "protocol",
          { retryable: false },
        );
      }
      if (data.choices?.length !== 1) {
        throw new ModelProviderError("模型响应必须包含唯一 choice", "protocol", { retryable: false });
      }
      const choice = data.choices[0]!;
      if (choice.finish_reason !== "stop") {
        throw new ModelProviderError(
          `模型未完整结束：${choice.finish_reason ?? "missing"}`,
          "protocol",
          { retryable: false },
        );
      }
      if (!thinkingEnabled && String(choice.message?.reasoning_content ?? "").trim()) {
        throw new ModelProviderError("非思考场景返回了 reasoning_content", "protocol", {
          retryable: false,
          unknown: true,
        });
      }
      const text = textFromContent(choice.message?.content);
      if (!text) {
        const error = new ModelProviderError("模型返回 content 为空", "empty", { retryable: false });
        // Preserve the ordinary empty-content error. Only the native nonstream
        // Chat JSON wire may supply evidence of a complete, measured failure.
        if (!structuredRequest && this.modelId === DEEPSEEK_FLASH_MODEL_ID && responseFormat?.type === "json_object" && attempt === 1
          && response.status === 200 && !response.redirected && !signal.aborted
          && isNativeEndpoint(transport.endpoint, DEEPSEEK_CHAT_PATH) && isNativeChatJsonMessage(data)
          && !/[^ ]/u.test(choice.message?.content as string)) {
          try {
            const usage = completionUsage(data, thinkingEnabled, plan.outputCeiling);
            const receipt = Object.freeze({ ...usage, modelId: this.modelId, responseId: data.id, requestHash, responseHash });
            nativeBlankJsonErrors.set(error, receipt);
            nativeBlankJsonDispatches.set(receipt, { ...transport, provider: this, scene: opts.scene ?? "generic", mode, effort });
          } catch (validationError) {
            if (!(validationError instanceof ModelProviderError)) throw validationError;
          }
        }
        throw error;
      }
      const usage = completionUsage(data, thinkingEnabled, plan.outputCeiling);

      const receipt: ChatResult = {
        text,
        ...usage,
        modelId: data.model,
        finishReason: "stop",
        requestHash,
        responseHash,
        responseId: data.id ?? null,
        scene: opts.scene ?? "generic",
        mode,
        effort,
        outputCeiling: plan.outputCeiling,
        inputTokenEstimate: plan.inputTokens,
        imageCount: plan.imageCount,
        policyVersion: TEXT_PRIMARY_POLICY_VERSION,
        registryVersion: TEXT_PRIMARY_REGISTRY_VERSION,
        attempts,
      };
      const completeNativeHttp = attempt === 1 && response.status === 200 && !response.redirected && !signal.aborted;
      const finalJson = !structuredRequest && responseFormat?.type === "json_object" && completeNativeHttp
        && isNativeEndpoint(transport.endpoint, DEEPSEEK_CHAT_PATH) && isNativeChatJsonMessage(data);
      const echoedFormat = objectRecord(objectRecord(objectRecord(decoded)?.text)?.format);
      const rawText = choice.message?.content;
      const sceneResponse = completeNativeHttp && structuredRequest?.format.name === SCENE_RESPONSES_SCHEMA_NAME
        && echoedFormat?.type === "json_schema" && echoedFormat.name === SCENE_RESPONSES_SCHEMA_NAME
        && typeof rawText === "string" && isNativeEndpoint(transport.endpoint, DEEPSEEK_RESPONSES_PATH)
        ? Object.freeze({
            rawText, requestSha256: requestHash, responseSha256: responseHash,
            schemaSha256: createHash("sha256").update(JSON.stringify(structuredRequest.format.schema)).digest("hex"),
          })
        : undefined;
      openAiTransportReceipts.set(receipt, { ...transport, provider: this, finalJson, sceneResponse });
      return receipt;
    }
    throw new ModelProviderError("模型调用重试耗尽", "http", { retryable: false, receipt: { attempts } });
  }
}

export function providerFromEnv(modelId: string = DEEPSEEK_FLASH_MODEL_ID): ModelProvider {
  const provider = (process.env.LLM_PROVIDER ?? "mock").trim().toLowerCase();
  if (provider === "mock") return new MockProvider(canonicalDeepSeekModel(modelId));
  if (provider !== "deepseek") {
    throw new Error(`LLM_PROVIDER=${provider} 不在 text.primary registry 中`);
  }
  const baseUrl = normalizeBaseUrl(
    process.env.LLM_BASE_URL
      ?? process.env.DEEPSEEK_BASE_URL
      ?? "https://api.deepseek.com",
  );
  const apiKey = process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY_MISSING");
  return new OpenAiCompatibleProvider(canonicalDeepSeekModel(modelId), {
    baseUrl,
    apiKey,
  });
}
