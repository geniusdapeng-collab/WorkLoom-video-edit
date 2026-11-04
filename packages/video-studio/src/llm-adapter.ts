/**
 * llm-adapter.ts —— WorkLoom model-router ↔ SuperMickey LLMEngine 接口适配
 *
 * vendor 侧所有 LLM 调用点都期望 systems/llm-reasoning-engine.js 的接口：
 *   reason(prompt, opts)          → { success, content?, error?, retryable? }
 *   chat(system, user, temp)      → string（失败抛错）
 *   reasonRaw(prompt, opts)       → { success, content? ... }（不强制 JSON 提取）
 *   reasonStructured(prompt, schema, opts) → { success, data?/content? ... }
 * 本适配器用任意 OpenAI 兼容端点（底座 LLM_* 四环境变量）实现同一接口，
 * 不在 TS 层复制 vendor 的模型名等字面值——模型选择交由调用方/配置注入。
 *
 * v3.0 收口：配置 router 后，全部调用经 routeSmart（preproduction 场景，
 * 真实计量 + model.call 事件留痕 + 降级链），vendor 只读纪律不破。
 */
import {
  canonicalDeepSeekModel,
  circuitSnapshot,
  currentWindow,
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_MODEL_POLICY,
  DEFAULT_SCENE_TIMEOUTS,
  DEEPSEEK_CHAT_PATH,
  DEEPSEEK_FLASH_MODEL_ID,
  DEEPSEEK_RESPONSES_PATH,
  GatewayEventSink,
  isRiskResponsesJsonSchema,
  OpenAiCompatibleProvider,
  resolveScene,
  resolveTextScenePolicy,
  resolveTier,
  nativeRouteBlankJson,
  routeSmart,
  TEXT_PRIMARY_POLICY_VERSION,
  TEXT_PRIMARY_REGISTRY_VERSION,
  type ChatResult,
  type EventSink,
  type ModelPolicy,
  type NativeBlankJsonReceipt,
  type NativeRiskResponseSource,
  type NativeSceneResponseSource,
  type ModelProvider,
  type PlanId,
  type ResponsesJsonSchema,
  type SmartTask,
} from "@workloom/base/model-router";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { productionModelInput } from "./prd-authority-bridge.js";
import { parseStrictSceneJsonObject } from "./scene-json-comma-recovery.js";
import {
  resolveOpenAiCompatibleBaseUrl,
  resolveVideoApiKey,
  resolveVideoModel,
} from "./llm-config.js";

export interface LLMReasonOptions {
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  forceJson?: boolean;
  responseFormat?: { type: string };
  /** Opt in to the canonical non-streaming Responses JSON Schema transport. */
  responsesJsonSchema?: ResponsesJsonSchema;
  thinking?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Optional registered scene. Vendor callers may leave this unset. */
  scene?: string;
}

export interface LLMReasonResult {
  success: boolean;
  content?: string;
  data?: unknown;
  error?: string;
  retryable?: boolean;
  usage?: { promptTokens?: number; completionTokens?: number };
}

// The pinned discovery vendor can return the adapter envelope as if it were
// structured data. Track native failure identity outside the model payload.
const reasonFailures = new WeakMap<object, "json-syntax" | "unavailable">();
const nativeCompletions = new WeakSet<object>();
const nativeBlankJsonFailures = new WeakMap<object, { receipt: NativeBlankJsonReceipt; engine: WorkloomLLMEngine;
  provider: OpenAiCompatibleProvider; routeCurrent: () => boolean }>();
const nativeChatAnswers = new WeakMap<object, ChatResult>();
const nativeStructuredChatRoutes = new WeakMap<object, {
  engine: WorkloomLLMEngine;
  binding: ReviewDispatchBinding;
  receipt: ChatResult;
  schemaOptionsSha256: string;
  current: () => boolean;
}>();
const nativeSceneResponseSources = new WeakMap<object, NativeSceneResponseSource>();
type NativeResponsesRoute = {
  engine: WorkloomLLMEngine;
  binding: ReviewDispatchBinding;
  receipt: ChatResult;
  schemaSha256: string;
  current: () => boolean;
};
const nativeSceneResponseRoutes = new WeakMap<object, NativeResponsesRoute>();
const nativeRiskResponseSources = new WeakMap<object, NativeRiskResponseSource>();
const nativeRiskResponseRoutes = new WeakMap<object, NativeResponsesRoute>();
const checkBlankTransport = OpenAiCompatibleProvider.prototype.matchesNativeBlankJsonTransport;
const checkBlankCorrection = OpenAiCompatibleProvider.prototype.matchesNativeBlankJsonCorrection;
const readSceneResponseSource = OpenAiCompatibleProvider.prototype.readNativeSceneResponseSource;
const readRiskResponseSource = OpenAiCompatibleProvider.prototype.readNativeRiskResponseSource;

export function nativeReasonFailure(value: unknown): "json-syntax" | "unavailable" | undefined {
  return value !== null && typeof value === "object" ? reasonFailures.get(value) : undefined;
}

/** True only after the canonical provider returned a measured, complete response. */
export function nativeReasonCompleted(value: LLMReasonResult): boolean {
  return nativeCompletions.has(value);
}

/** Private transport evidence. Ordinary results and errors never contain this source. */
export function nativeSceneResponseSource(value: unknown): NativeSceneResponseSource | undefined {
  return value !== null && typeof value === "object" ? nativeSceneResponseSources.get(value) : undefined;
}

/** The same native dispatch must still be bound to the live engine, router and transport. */
export function nativeSceneResponseRouteCurrent(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const proof = nativeSceneResponseRoutes.get(value);
  const result = value as LLMReasonResult;
  return !!proof && result.success === !reasonFailures.has(value) && result.content === proof.receipt.text
    && result.usage?.promptTokens === proof.receipt.promptTokens
    && result.usage.completionTokens === proof.receipt.completionTokens && proof.current();
}

/** Pair distinct measured Responses from the same unchanged native route and schema. */
export function sameNativeSceneResponseRoute(left: unknown, right: unknown): boolean {
  if (left === null || typeof left !== "object" || right === null || typeof right !== "object") return false;
  const first = nativeSceneResponseRoutes.get(left), next = nativeSceneResponseRoutes.get(right);
  return sameDistinctResponses(first, next) && nativeSceneResponseRouteCurrent(left) && nativeSceneResponseRouteCurrent(right);
}

function sameDistinctResponses(first: NativeResponsesRoute | undefined, next: NativeResponsesRoute | undefined): boolean {
  return !!first && !!next && first.engine === next.engine
    && first.schemaSha256 === next.schemaSha256 && sameReviewDispatch(first.binding, next.binding)
    && first.receipt.outputCeiling === next.receipt.outputCeiling
    && first.receipt.responseId !== next.receipt.responseId
    && first.receipt.requestHash !== next.receipt.requestHash && first.receipt.responseHash !== next.receipt.responseHash;
}

/** Private raw output provenance from the exact, measured Risk response only. */
export function nativeRiskResponseSource(value: unknown): NativeRiskResponseSource | undefined {
  return value !== null && typeof value === "object" ? nativeRiskResponseSources.get(value) : undefined;
}

/** Recheck the live engine, route controls, provider, schema and measured response. */
export function nativeRiskResponseRouteCurrent(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const proof = nativeRiskResponseRoutes.get(value);
  if (!proof || dataMember(value, "success") !== !reasonFailures.has(value)
    || dataMember(value, "content") !== proof.receipt.text) return false;
  const usage = dataMember(value, "usage");
  return !!usage && typeof usage === "object" && !types.isProxy(usage)
    && dataMember(usage, "promptTokens") === proof.receipt.promptTokens
    && dataMember(usage, "completionTokens") === proof.receipt.completionTokens && proof.current();
}

/** Pair distinct Risk responses with unchanged native route controls, schema and output window. */
export function sameNativeRiskResponseRoute(left: unknown, right: unknown): boolean {
  if (left === null || typeof left !== "object" || right === null || typeof right !== "object") return false;
  return sameDistinctResponses(nativeRiskResponseRoutes.get(left), nativeRiskResponseRoutes.get(right))
    && nativeRiskResponseRouteCurrent(left) && nativeRiskResponseRouteCurrent(right);
}

function nativeChatResultCurrent(value: LLMReasonResult, proof: NonNullable<ReturnType<typeof nativeStructuredChatRoutes.get>>): boolean {
  const content = dataMember(value, "content"), usage = dataMember(value, "usage");
  return typeof content === "string" && !!content.trim() && content === proof.receipt.text
    && !!usage && typeof usage === "object" && !types.isProxy(usage)
    && dataMember(usage, "promptTokens") === proof.receipt.promptTokens
    && dataMember(usage, "completionTokens") === proof.receipt.completionTokens && proof.current();
}

/** A corrective dispatch may only follow this exact, measured syntax failure. */
export function nativeChatJsonSyntaxRouteCurrent(engine: WorkloomLLMEngine, first: LLMReasonResult): boolean {
  const proof = nativeStructuredChatRoutes.get(first);
  return !!proof && proof.engine === engine && dataMember(first, "success") === false && dataMember(first, "retryable") === false
    && nativeReasonFailure(first) === "json-syntax" && nativeChatResultCurrent(first, proof);
}

function sameNativeChatRoute(first: LLMReasonResult, second: LLMReasonResult): boolean {
  const before = nativeStructuredChatRoutes.get(first), after = nativeStructuredChatRoutes.get(second);
  return !!before && !!after && before.engine === after.engine && before.schemaOptionsSha256 === after.schemaOptionsSha256
    && sameReviewDispatch(before.binding, after.binding) && before.receipt.outputCeiling === after.receipt.outputCeiling
    && before.receipt.requestHash !== after.receipt.requestHash && before.receipt.responseHash !== after.receipt.responseHash
    && before.receipt.responseId !== after.receipt.responseId;
}

/** A structured completion proves both the live native route and the exact parsed JSON object. */
export function nativeChatJsonObjectRouteCurrent(engine: WorkloomLLMEngine, result: LLMReasonResult): boolean {
  const proof = nativeStructuredChatRoutes.get(result);
  if (!proof || proof.engine !== engine || dataMember(result, "success") !== true || !nativeChatResultCurrent(result, proof)) return false;
  return exactNativeChatJsonObject(proof.binding.provider, proof.receipt, result);
}

function exactNativeChatJsonObject(provider: OpenAiCompatibleProvider, receipt: ChatResult, result: LLMReasonResult): boolean {
  const data = dataMember(result, "data");
  if (!plainDataTree(data)) return false;
  return checkChatJsonTransport.call(provider, receipt, rawText => {
    const parsed = parseStrictSceneJsonObject(rawText);
    return parsed !== undefined && JSON.stringify(parsed) === JSON.stringify(data);
  });
}

/** The corrective result must be a distinct, strictly parsed completion on the same live route. */
export function nativeChatJsonSyntaxCorrected(first: LLMReasonResult, second: LLMReasonResult): boolean {
  const engine = nativeStructuredChatRoutes.get(first)?.engine;
  return !!engine && sameNativeChatRoute(first, second) && nativeChatJsonSyntaxRouteCurrent(engine, first)
    && nativeChatJsonObjectRouteCurrent(engine, second);
}

/** Structural correction starts and ends with distinct native JSON objects on the same live route. */
export function nativeChatJsonObjectCorrected(first: LLMReasonResult, second: LLMReasonResult): boolean {
  const engine = nativeStructuredChatRoutes.get(first)?.engine;
  return !!engine && sameNativeChatRoute(first, second) && nativeChatJsonObjectRouteCurrent(engine, first)
    && nativeChatJsonObjectRouteCurrent(engine, second);
}

/** A completed empty Chat JSON result remains a failed, non-retryable call. */
export function nativeReasonBlankJson(value: unknown): NativeBlankJsonReceipt | undefined {
  return value !== null && typeof value === "object" ? nativeBlankJsonFailures.get(value)?.receipt : undefined;
}

export function nativeBlankJsonRouteCurrent(engine: WorkloomLLMEngine, first: LLMReasonResult): boolean {
  const proof = nativeBlankJsonFailures.get(first);
  return !!proof && proof.engine === engine && proof.routeCurrent() && checkBlankTransport.call(proof.provider, proof.receipt);
}

export function nativeBlankJsonCorrected(first: LLMReasonResult, second: LLMReasonResult): boolean {
  const proof = nativeBlankJsonFailures.get(first), answer = nativeChatAnswers.get(second);
  return !!proof && !!answer && proof.routeCurrent() && checkBlankCorrection.call(proof.provider, proof.receipt, answer);
}

/** A blank correction can require a distinct exact raw JSON object from the same current Chat route. */
export function nativeBlankJsonObjectCorrected(first: LLMReasonResult, second: LLMReasonResult): boolean {
  const proof = nativeBlankJsonFailures.get(first), answer = nativeChatAnswers.get(second);
  return !!proof && !!answer && dataMember(second, "success") === true && proof.receipt.responseHash !== answer.responseHash
    && nativeBlankJsonCorrected(first, second) && exactNativeChatJsonObject(proof.provider, answer, second);
}

export interface WorkloomLLMEngineConfig {
  /** OpenAI 兼容端点，如 https://api.moonshot.cn/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  fastModel?: string;
  timeoutMs?: number;
  maxTokens?: number;
  /** Default scene for bridged vendor calls. */
  scene?: string;
  fetchImpl?: typeof fetch;
  /**
   * v3.0 收口：注入路由配置后，全部 LLM 调用经 routeSmart
   * （场景 preproduction；opts.model===fastModel 的快速调用强制 L1 轻量档）——
   * 场景表 × 降级链 × 真实计量 × model.call 事件留痕，vendor 目录保持只读。
   */
  router?: {
    providers: Map<string, ModelProvider>;
    sink: EventSink;
    policy?: ModelPolicy;
    plan?: PlanId;
    /** 覆盖默认场景（默认 preproduction） */
    scene?: string;
    /** Deployment-level model pin. It bypasses tier substitution and fallback. */
    forceModel?: string;
    /** @deprecated Thinking is owned by scene policy. */
    nonThinking?: boolean;
  };
}

/** An answered, canonical dispatch can prove the same structured review input in this run. */
export interface StructuredReviewDispatchProof {
  readonly inputSha256: string;
  readonly requestSha256: string;
  readonly responseSha256: string;
  readonly modelId: string;
  readonly policyVersion: string;
  readonly registryVersion: string;
  matchesCurrent(prompt: string, schema: unknown, options: LLMReasonOptions): boolean;
}

type AttachedRouter = NonNullable<WorkloomLLMEngineConfig["router"]>;
interface ReviewDispatchBinding {
  inputSha256: string;
  revision: number;
  router: AttachedRouter;
  providers: AttachedRouter["providers"];
  provider: OpenAiCompatibleProvider;
  sink: EventSink;
  recordModelTrace: EventSink["recordModelTrace"];
  thinkingMode: "enabled" | "disabled";
  thinkingEffort?: "low" | "high" | "max";
}

const captureReviewDispatch = Symbol("captureReviewDispatch");
const structuredChatIdentity = Symbol("structuredChatIdentity");
type InternalReasonOptions = LLMReasonOptions & {
  [captureReviewDispatch]?: (proof: StructuredReviewDispatchProof) => void;
  [structuredChatIdentity]?: () => string | undefined;
};
const nativeProviderChat = OpenAiCompatibleProvider.prototype.chat;
const nativeTransportCheck = OpenAiCompatibleProvider.prototype.matchesCurrentTransport;
const checkChatJsonTransport = OpenAiCompatibleProvider.prototype.matchesNativeCompletedChatJson;
const nativeMapGet = Map.prototype.get;
const digestPattern = /^[a-f0-9]{64}$/;

function transportPath(opts: LLMReasonOptions) {
  return opts.responsesJsonSchema === undefined ? DEEPSEEK_CHAT_PATH : DEEPSEEK_RESPONSES_PATH;
}

/** Only data descriptors are inspected. A proof must not execute configuration code. */
function dataMember(value: object, key: PropertyKey, prototype?: object): unknown {
  const own = Object.getOwnPropertyDescriptor(value, key);
  const descriptor = own ?? (prototype && Object.getOwnPropertyDescriptor(prototype, key));
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function dataDescriptors(value: unknown, prototypes: readonly (object | null)[], omit?: symbol): PropertyDescriptor[] | undefined {
  if (!value || typeof value !== "object" || types.isProxy(value)
    || !prototypes.includes(Object.getPrototypeOf(value))) return undefined;
  const properties = Reflect.ownKeys(value).filter((key) => key !== omit).map((key) => Object.getOwnPropertyDescriptor(value, key)!);
  return properties.every((property) => "value" in property) ? properties : undefined;
}

function plainDataTree(value: unknown, parents = new WeakSet<object>(), depth = 0, omit?: symbol): boolean {
  if (value == null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth >= 32 || parents.has(value)) return false;
  const descriptors = dataDescriptors(value, [Object.prototype, null, Array.prototype], omit);
  if (!descriptors) return false;
  parents.add(value);
  const plain = descriptors.every((descriptor) => plainDataTree(descriptor.value, parents, depth + 1));
  parents.delete(value);
  return plain;
}

function attestableRoute(engine: object) {
  const cfg = dataMember(engine, "cfg") as WorkloomLLMEngineConfig | undefined;
  if (!cfg || !dataDescriptors(cfg, [Object.prototype, null])) return undefined;
  const router = dataMember(cfg, "router") as AttachedRouter | undefined;
  if (!router || !dataDescriptors(router, [Object.prototype, null])) return undefined;
  const providers = dataMember(router, "providers") as AttachedRouter["providers"] | undefined;
  const sink = dataMember(router, "sink") as EventSink | undefined;
  const policy = (dataMember(router, "policy") as ModelPolicy | undefined) ?? DEFAULT_MODEL_POLICY;
  if (!plainDataTree(policy) || !types.isMap(providers) || !dataDescriptors(providers, [Map.prototype])
    || dataMember(providers, "get", Map.prototype) !== nativeMapGet
    || !sink || !dataDescriptors(sink, [Object.prototype, null, GatewayEventSink.prototype])) return undefined;
  const provider = nativeMapGet.call(providers, DEEPSEEK_FLASH_MODEL_ID);
  if (!provider || !dataDescriptors(provider, [OpenAiCompatibleProvider.prototype])
    || dataMember(provider, "chat", OpenAiCompatibleProvider.prototype) !== nativeProviderChat
    || dataMember(provider, "modelId") !== DEEPSEEK_FLASH_MODEL_ID) return undefined;
  const sinkPrototype = Object.getPrototypeOf(sink) ?? undefined;
  const recordModelTrace = dataMember(sink, "recordModelTrace", sinkPrototype);
  if (typeof recordModelTrace !== "function" || types.isProxy(recordModelTrace)) return undefined;
  const model = dataMember(cfg, "model");
  if (typeof model !== "string") return undefined;
  return { router, providers, sink, provider: provider as OpenAiCompatibleProvider, policy, model,
    recordModelTrace: recordModelTrace as EventSink["recordModelTrace"] };
}

function sameReviewDispatch(before: ReviewDispatchBinding, current: ReviewDispatchBinding | undefined): boolean {
  return !!current && before.inputSha256 === current.inputSha256 && before.revision === current.revision
    && before.router === current.router && before.providers === current.providers && before.provider === current.provider
    && before.sink === current.sink && before.recordModelTrace === current.recordModelTrace;
}

function structuredPromptFor(prompt: string, schema: unknown): string {
  const schemaText = JSON.stringify(schema, null, 2);
  // The caller supplies actual IDs and field templates independently of illustrative examples.
  return [
    prompt,
    "",
    "【硬性输出要求】",
    "1. 只输出合法 JSON",
    "2. 不要输出 markdown 代码块",
    "3. 不要输出解释、前言、结尾",
    "4. 所有字段必须存在",
    "5. 输出必须能被 JSON.parse 直接解析",
    "",
    "【目标JSON结构示例】",
    schemaText,
  ].join("\n");
}

export class WorkloomLLMEngine {
  private readonly cfg: Required<Omit<WorkloomLLMEngineConfig, "router">> & { router?: WorkloomLLMEngineConfig["router"] };
  #routerRevision = 0;
  readonly stats = { totalCalls: 0, totalFailures: 0 };

  get model(): string {
    return this.cfg.model;
  }

  get fastModel(): string {
    return this.cfg.fastModel;
  }

  constructor(config: WorkloomLLMEngineConfig) {
    this.cfg = {
      fastModel: config.model,
      timeoutMs: 180_000,
      maxTokens: config.maxTokens ?? 0,
      scene: config.scene ?? "video.preproduction.plan",
      fetchImpl: config.fetchImpl ?? fetch,
      ...config
    };
    this.cfg.model = canonicalDeepSeekModel(this.cfg.model);
  }

  /** v3.0 收口：装配后注入路由配置（宿主侧 seam；vendor 无感） */
  attachRouter(router: NonNullable<WorkloomLLMEngineConfig["router"]>): void {
    this.cfg.router = router;
    this.#routerRevision += 1;
  }

  /** 从底座变量构建；DEEPSEEK_* is accepted for OpenAI-compatible CLI/server deployments. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): WorkloomLLMEngine | null {
    const baseUrl = resolveOpenAiCompatibleBaseUrl(env);
    const apiKey = resolveVideoApiKey(env);
    const model = resolveVideoModel(env);
    if (!baseUrl || !apiKey || !model) return null;
    return new WorkloomLLMEngine({
      baseUrl,
      apiKey,
      model,
    });
  }

  private async callChat(prompt: string, opts: LLMReasonOptions): Promise<LLMReasonResult> {
    const input = productionModelInput(prompt);
    try { return await this.requestChat(input.prompt, opts); }
    finally { input.verify(); }
  }

  private routeTask(prompt: string, opts: LLMReasonOptions, scene: string): SmartTask {
    return {
      action: scene,
      scene,
      plan: this.cfg.router?.plan,
      ...(this.cfg.router?.forceModel
        ? { forceModel: canonicalDeepSeekModel(this.cfg.router.forceModel) }
        : {}),
      timeoutMs: opts.timeoutMs ?? this.cfg.timeoutMs,
      signal: opts.signal,
      // The dispatcher calculates the complete legal output window.
      generation: {
        temperature: opts.temperature,
        topP: opts.topP,
        ...(opts.responsesJsonSchema === undefined ? {} : { responsesJsonSchema: opts.responsesJsonSchema }),
      },
      messages: [
        {
          role: "system",
          content: opts.systemPrompt
            ?? (opts.forceJson
              ? "你是一个严格输出 JSON 的助手。除合法 JSON 外不要输出任何额外文字。"
              : "你是一个可靠的助手。"),
        },
        { role: "user", content: prompt },
      ],
    };
  }

  private describeReviewDispatch(
    task: SmartTask, route: NonNullable<ReturnType<typeof attestableRoute>>, requireModelPin = true,
  ): ReviewDispatchBinding | undefined {
    try {
      const { router, providers, sink, provider, policy, model, recordModelTrace } = route;
      const scene = task.scene;
      // Only the worker's pinned, built-in provider has a verifiable dispatch path here.
      if (!scene || (requireModelPin && task.forceModel !== DEEPSEEK_FLASH_MODEL_ID) || task.signal || circuitSnapshot(scene)) return undefined;
      const plan = task.plan ?? "standard";
      const rule = resolveScene(policy, scene);
      const effectivePolicy = resolveTextScenePolicy(scene, {
        ...(rule.type ? { type: rule.type } : {}),
        ...(rule.thinking ? { thinking: { type: rule.thinking.type, effort: rule.thinking.effort } } : {}),
        ...(rule.responseFormat ? { responseFormat: rule.responseFormat } : {}),
        ...(rule.outputBudget ? { outputBudget: rule.outputBudget } : {}),
        ...(rule.generationReviewGroup ? { generationReviewGroup: rule.generationReviewGroup } : {}),
        ...(rule.sameModelAs ? { sameModelAs: rule.sameModelAs } : {}),
      });
      // Hash the actual model inputs and effective settings only. The provider
      // and sink are compared by identity. The provider attests to its own transport.
      const inputSha256 = createHash("sha256").update(JSON.stringify({
        messages: task.messages,
        generation: task.generation,
        model: canonicalDeepSeekModel(model),
        forceModel: task.forceModel,
        timeoutMs: task.timeoutMs && task.timeoutMs > 0 ? task.timeoutMs : DEFAULT_SCENE_TIMEOUTS[scene] ?? DEFAULT_CALL_TIMEOUT_MS,
        plan,
        tier: resolveTier(policy, scene, plan),
        window: currentWindow(),
        fallback: rule.fallback ?? null,
        billTo: rule.billTo ?? "tenant",
        bundlePolicyVersion: policy.version,
        effectivePolicy,
        policyVersion: TEXT_PRIMARY_POLICY_VERSION,
        registryVersion: TEXT_PRIMARY_REGISTRY_VERSION,
      })).digest("hex");
      return {
        inputSha256, revision: this.#routerRevision, router, providers,
        provider, sink, recordModelTrace,
        thinkingMode: effectivePolicy.thinking.type,
        thinkingEffort: effectivePolicy.thinking.type === "enabled" ? effectivePolicy.thinking.effort : undefined,
      };
    } catch {
      // An unprovable dispatch is still evaluated by the regular model path.
      return undefined;
    }
  }

  private reviewDispatchIsCurrent(
    before: ReviewDispatchBinding, receipt: ChatResult, prompt: string, schema: unknown, opts: LLMReasonOptions,
  ): boolean {
    if (!WorkloomLLMEngine.supportsStructuredReviewProof(this) || !plainDataTree(schema) || !plainDataTree(opts)) return false;
    let structured: string;
    try { structured = structuredPromptFor(prompt, schema); }
    catch { return false; }
    // Recheck the same private G1/G2/G4 authority as a fresh call. A failed
    // authority check propagates through the original technical retry path.
    const input = productionModelInput(structured);
    try {
      const route = attestableRoute(this);
      if (!route) return false;
      canonicalDeepSeekModel(opts.model ?? route.model);
      const scene = opts.scene ?? route.router.scene ?? this.cfg.scene;
      const task = WorkloomLLMEngine.nativeProofMethods.routeTask.call(this, input.prompt, { ...opts, forceJson: true }, scene);
      return sameReviewDispatch(before, WorkloomLLMEngine.nativeProofMethods.describeReviewDispatch.call(this, task, route))
        && nativeTransportCheck.call(before.provider, receipt, transportPath(opts));
    } catch {
      return false;
    } finally { input.verify(); }
  }

  private async requestChat(prompt: string, opts: InternalReasonOptions): Promise<LLMReasonResult> {
    const router = this.cfg.router, revision = this.#routerRevision;
    const activeModel = canonicalDeepSeekModel(opts.model ?? this.cfg.model);
    const scene = opts.scene
      ?? this.cfg.router?.scene
      ?? this.cfg.scene;
    const providers = this.cfg.router?.providers ?? new Map<string, ModelProvider>([[
      activeModel,
      new OpenAiCompatibleProvider(activeModel, {
        baseUrl: this.cfg.baseUrl,
        apiKey: this.cfg.apiKey,
        fetchImpl: this.cfg.fetchImpl,
      }),
    ]]);
    const sink: EventSink = this.cfg.router?.sink ?? {
      recordModelTrace: async () => undefined,
      recordDegradation: async () => undefined,
      recordCircuitBreak: async () => undefined,
    };
    try {
      const task = this.routeTask(prompt, opts, scene);
      const policy = this.cfg.router?.policy;
      const route = opts[captureReviewDispatch] ? attestableRoute(this) : undefined;
      const describe = WorkloomLLMEngine.nativeProofMethods.describeReviewDispatch;
      const binding = route?.providers === providers && route.sink === sink && route.policy === (policy ?? DEFAULT_MODEL_POLICY)
        ? describe.call(this, task, route)
        : undefined;
      // Format correction must change the user prompt, but the live route
      // controls and, for Chat, the system message must stay identical.
      const describeRouteControls = (keepSystem = false) => {
        if (!WorkloomLLMEngine.supportsStructuredReviewProof(this) || this.#routerRevision !== revision) return undefined;
        const current = attestableRoute(this);
        if (!current || current.router !== router || current.providers !== providers || current.sink !== sink
          || current.router.policy !== policy || (opts.scene ?? current.router.scene ?? this.cfg.scene) !== scene) return undefined;
        const controls = WorkloomLLMEngine.nativeProofMethods.routeTask.call(this, "", opts, scene);
        return describe.call(this, { ...controls, messages: keepSystem ? controls.messages.slice(0, -1) : [] }, current, false);
      };
      const sceneRoute = opts.forceJson && opts.responsesJsonSchema?.name === "workloom_scene_architect"
        ? describeRouteControls()
        : undefined;
      const riskRoute = opts.forceJson && isRiskResponsesJsonSchema(opts.responsesJsonSchema)
        ? describeRouteControls(true) : undefined;
      const chatIdentity = opts.forceJson && opts.responsesJsonSchema === undefined ? opts[structuredChatIdentity]?.() : undefined;
      const chatRoute = chatIdentity ? describeRouteControls(true) : undefined;
      const result = await routeSmart(task, providers, sink, { policy });
      if ((result.kind === "answered" || result.kind === "circuit_broken" || result.kind === "reused")
        && result.text) {
        const answer: LLMReasonResult = {
          success: true,
          content: result.text,
          usage: result.providerResult
            ? {
                promptTokens: result.providerResult.promptTokens,
                completionTokens: result.providerResult.completionTokens,
              }
            : undefined,
        };
        const receipt = result.providerResult;
        const nativeProvider = providers.get(DEEPSEEK_FLASH_MODEL_ID);
        if (result.kind === "answered" && !result.degraded?.length && receipt?.modelId === DEEPSEEK_FLASH_MODEL_ID
          && receipt.finishReason === "stop" && receipt.responseId?.trim() && nativeProvider instanceof OpenAiCompatibleProvider
          && nativeTransportCheck.call(nativeProvider, receipt, transportPath(opts))) {
          nativeCompletions.add(answer);
          if (transportPath(opts) === DEEPSEEK_CHAT_PATH) {
            nativeChatAnswers.set(answer, receipt);
            if (chatRoute && chatIdentity && receipt.scene === scene
              && receipt.mode === chatRoute.thinkingMode && receipt.effort === chatRoute.thinkingEffort
              && receipt.policyVersion === TEXT_PRIMARY_POLICY_VERSION && receipt.registryVersion === TEXT_PRIMARY_REGISTRY_VERSION
              && digestPattern.test(receipt.requestHash) && digestPattern.test(receipt.responseHash)) {
              const current = () => chatIdentity === opts[structuredChatIdentity]?.()
                && sameReviewDispatch(chatRoute, describeRouteControls(true))
                && checkChatJsonTransport.call(chatRoute.provider, receipt);
              if (current()) nativeStructuredChatRoutes.set(answer, { engine: this, binding: chatRoute, receipt,
                schemaOptionsSha256: chatIdentity, current });
            }
          } else {
            const source = readSceneResponseSource.call(nativeProvider, receipt);
            if (source) {
              nativeSceneResponseSources.set(answer, source);
              const current = () => Boolean(sceneRoute && sameReviewDispatch(sceneRoute, describeRouteControls())
                && nativeTransportCheck.call(nativeProvider, receipt, DEEPSEEK_RESPONSES_PATH));
              if (sceneRoute && receipt.scene === scene && receipt.mode === sceneRoute.thinkingMode && receipt.effort === sceneRoute.thinkingEffort
                && receipt.policyVersion === TEXT_PRIMARY_POLICY_VERSION && receipt.registryVersion === TEXT_PRIMARY_REGISTRY_VERSION
                && digestPattern.test(source.schemaSha256) && digestPattern.test(receipt.requestHash) && digestPattern.test(receipt.responseHash)
                && current()) {
                nativeSceneResponseRoutes.set(answer, { engine: this, binding: sceneRoute, receipt, schemaSha256: source.schemaSha256, current });
              }
            }
            const risk = readRiskResponseSource.call(nativeProvider, receipt);
            if (risk) {
              nativeRiskResponseSources.set(answer, risk);
              const current = () => Boolean(riskRoute && isRiskResponsesJsonSchema(opts.responsesJsonSchema)
                && sameReviewDispatch(riskRoute, describeRouteControls(true))
                && readRiskResponseSource.call(nativeProvider, receipt) === risk);
              if (riskRoute && receipt.scene === scene && receipt.mode === riskRoute.thinkingMode && receipt.effort === riskRoute.thinkingEffort
                && receipt.policyVersion === TEXT_PRIMARY_POLICY_VERSION && receipt.registryVersion === TEXT_PRIMARY_REGISTRY_VERSION
                && digestPattern.test(risk.schemaSha256) && digestPattern.test(receipt.requestHash) && digestPattern.test(receipt.responseHash)
                && current()) {
                nativeRiskResponseRoutes.set(answer, { engine: this, binding: riskRoute, receipt, schemaSha256: risk.schemaSha256, current });
              }
            }
          }
        }
        const currentRoute = binding ? attestableRoute(this) : undefined;
        if (binding && currentRoute && result.kind === "answered" && !result.degraded?.length && !result.budgetExceeded
          && receipt?.modelId === DEEPSEEK_FLASH_MODEL_ID && receipt.scene === scene && receipt.finishReason === "stop"
          && receipt.mode === binding.thinkingMode && receipt.effort === binding.thinkingEffort
          && receipt.policyVersion === TEXT_PRIMARY_POLICY_VERSION && receipt.registryVersion === TEXT_PRIMARY_REGISTRY_VERSION
          && digestPattern.test(receipt.requestHash) && digestPattern.test(receipt.responseHash)
          && sameReviewDispatch(binding, describe.call(this, task, currentRoute))
          && nativeTransportCheck.call(binding.provider, receipt, transportPath(opts))) {
          opts[captureReviewDispatch]?.(Object.freeze({
            inputSha256: binding.inputSha256, requestSha256: receipt.requestHash, responseSha256: receipt.responseHash,
            modelId: receipt.modelId, policyVersion: receipt.policyVersion, registryVersion: receipt.registryVersion,
            matchesCurrent: (text: string, schema: unknown, options: LLMReasonOptions) =>
              WorkloomLLMEngine.nativeProofMethods.reviewDispatchIsCurrent.call(this, binding, receipt, text, schema, options),
          }));
        }
        return answer;
      }
      const failure: LLMReasonResult = {
        success: false,
        error: result.failure?.reason
          ?? result.degraded?.at(-1)?.reason
          ?? `模型路由不可用（${result.kind}）`,
        retryable: false,
      };
      const blankJson = nativeRouteBlankJson(result);
      if (blankJson) {
        const provider = providers.get(DEEPSEEK_FLASH_MODEL_ID);
        if (provider instanceof OpenAiCompatibleProvider) nativeBlankJsonFailures.set(failure, {
          receipt: blankJson, engine: this, provider,
          routeCurrent: () => !!router && this.cfg.router === router && this.#routerRevision === revision
            && router.providers === providers && Map.prototype.get.call(providers, DEEPSEEK_FLASH_MODEL_ID) === provider
            && router.sink === sink && router.policy === policy && (router.scene ?? this.cfg.scene) === scene,
        });
      }
      return failure;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        retryable: false,
      };
    }
  }

  private static extractJson(text: string): unknown {
    return JSON.parse(text.trim());
  }

  async reason(prompt: string, options: LLMReasonOptions = {}): Promise<LLMReasonResult> {
    this.stats.totalCalls++;
    const result = await this.callChat(prompt, options);
    if (!result.success) this.stats.totalFailures++;
    if (result.success && options.forceJson && result.content) {
      try {
        result.data = WorkloomLLMEngine.extractJson(result.content);
      } catch (err) {
        this.stats.totalFailures++;
        const failure: LLMReasonResult = {
          ...result,
          success: false,
          error: `JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`,
          retryable: false
        };
        reasonFailures.set(failure, "json-syntax");
        if (nativeCompletions.has(result)) nativeCompletions.add(failure);
        const source = nativeSceneResponseSources.get(result);
        if (source) nativeSceneResponseSources.set(failure, source);
        const route = nativeSceneResponseRoutes.get(result);
        if (route) nativeSceneResponseRoutes.set(failure, route);
        const risk = nativeRiskResponseSources.get(result);
        if (risk) nativeRiskResponseSources.set(failure, risk);
        const riskRoute = nativeRiskResponseRoutes.get(result);
        if (riskRoute) nativeRiskResponseRoutes.set(failure, riskRoute);
        const chat = nativeStructuredChatRoutes.get(result);
        if (chat) nativeStructuredChatRoutes.set(failure, chat);
        return failure;
      }
    }
    return result;
  }

  async generate(prompt: string, options: LLMReasonOptions = {}): Promise<LLMReasonResult> {
    return this.reason(prompt, options);
  }

  async reasonRaw(prompt: string, options: LLMReasonOptions = {}): Promise<LLMReasonResult> {
    return this.callChat(prompt, { ...options, forceJson: false });
  }

  async chat(systemPrompt: string, userPrompt: string, temperature = 1): Promise<string> {
    const forceJson = /(?:只输出|严格输出|严格返回|仅返回|结构化).{0,32}(?:JSON|json)|(?:JSON|json).{0,32}(?:只输出|不要解释|不得解释|结构化)/u.test(systemPrompt);
    const result = await this.reason(userPrompt, { systemPrompt, temperature, ...(forceJson ? { forceJson: true } : {}) });
    if (!result.success || !result.content) {
      throw new Error(result.error ?? "LLM chat 调用失败");
    }
    return result.content;
  }

  async reasonStructured(
    prompt: string,
    schema: unknown,
    options: LLMReasonOptions = {}
  ): Promise<LLMReasonResult> {
    let structuredPrompt: string;
    try {
      structuredPrompt = structuredPromptFor(prompt, schema);
    } catch (error) {
      const failure: LLMReasonResult = {
        success: false,
        error: `结构化输出结构不可序列化: ${error instanceof Error ? error.message : String(error)}`,
        retryable: false,
      };
      reasonFailures.set(failure, "unavailable");
      return failure;
    }
    // Proof capture adds an internal callback, not a Chat wire control.
    const identity = () => plainDataTree(options, undefined, 0, captureReviewDispatch)
      && plainDataTree(schema) && options.responsesJsonSchema === undefined
      ? createHash("sha256").update(JSON.stringify([String(JSON.stringify(schema)), options])).digest("hex") : undefined;
    const callOptions: InternalReasonOptions = { ...options, forceJson: true };
    if (callOptions.responsesJsonSchema === undefined) callOptions[structuredChatIdentity] = identity;
    const result = await this.reason(structuredPrompt, callOptions);
    if (!result.success && !reasonFailures.has(result)) reasonFailures.set(result, "unavailable");
    return result;
  }

  private static readonly nativeProofMethods = {
    reason: this.prototype.reason,
    reasonStructured: this.prototype.reasonStructured,
    callChat: this.prototype.callChat,
    requestChat: this.prototype.requestChat,
    routeTask: this.prototype.routeTask,
    describeReviewDispatch: this.prototype.describeReviewDispatch,
    reviewDispatchIsCurrent: this.prototype.reviewDispatchIsCurrent,
    reasonStructuredWithProof: this.prototype.reasonStructuredWithProof,
  };

  static supportsStructuredReviewProof(engine: WorkloomLLMEngine): boolean {
    return #routerRevision in engine && Object.getPrototypeOf(engine) === WorkloomLLMEngine.prototype
      && Object.entries(WorkloomLLMEngine.nativeProofMethods).every(([key, method]) =>
        dataMember(engine, key, WorkloomLLMEngine.prototype) === method);
  }

  /** Same request and result as reasonStructured, with optional dispatch evidence for G6. */
  async reasonStructuredWithProof(prompt: string, schema: unknown, options: LLMReasonOptions): Promise<{
    result: LLMReasonResult;
    proof?: StructuredReviewDispatchProof;
  }> {
    if (!WorkloomLLMEngine.supportsStructuredReviewProof(this) || !plainDataTree(schema) || !plainDataTree(options)) {
      return { result: await this.reasonStructured(prompt, schema, options) };
    }
    let proof: StructuredReviewDispatchProof | undefined;
    const captured: InternalReasonOptions = { ...options, [captureReviewDispatch]: (value) => { proof = value; } };
    const result = await this.reasonStructured(prompt, schema, captured);
    return { result, proof: result.success ? proof : undefined };
  }

  /**
   * vendor 内部助手方法（2026-09-22 真机修复）
   *
   * `engines/requirement-discovery-engine.js:260` 直接调 `llmEngine._extractJsonObject(content)`；
   * 注入的是本适配器时该方法不存在 → `SceneArchitect` 连续两次失败 →
   * 日志出现「❌ 全部失败，使用兜底规则」→ 场景设计整段退化为规则模板（下游再补齐）。
   * 这里补上与 vendor `systems/llm-reasoning-engine.js:106` 同语义的实现（失败返回 null，不抛）。
   */
  _extractJsonObject(text: unknown): string | null {
    /**
     * 与 vendor `systems/llm-reasoning-engine.js#_extractJsonObject` **同语义**：
     * 返回**JSON 文本字符串**（调用方自己 `JSON.parse`），非字符串输入返回 null。
     *
     * 真机教训（VID-1022）：首版实现返回已解析对象，而
     * `requirement-discovery-engine.js:262` 是 `return JSON.parse(extracted)` →
     * `JSON.parse(对象)` 走 `String(对象)` → `"[object Object]" is not valid JSON`，
     * SceneArchitect 仍然全失败。此实现含输入截断与扫描预算，避免大响应冻结事件循环。
     */
    if (!text || typeof text !== "string") return null;
    const MAX_INPUT_LEN = 200_000;
    const input = text.length > MAX_INPUT_LEN ? text.slice(0, MAX_INPUT_LEN) : text;

    const fenced = input.match(/```json\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) {
      const candidate = fenced[1].trim();
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        /* 继续 */
      }
    }
    const whole = input.trim();
    if (whole) {
      try {
        JSON.parse(whole);
        return whole;
      } catch {
        /* 继续 */
      }
    }
    // 单次栈扫描找"顶层完整 JSON"候选（与 vendor 同算法，带 300ms 预算、不阻塞事件循环）
    const stack: Array<"{" | "["> = [];
    let inString = false;
    let escaped = false;
    let start = -1;
    const budgetStart = Date.now();
    let ops = 0;
    for (let i = 0; i < input.length; i += 1) {
      if ((++ops & 0x3fff) === 0 && Date.now() - budgetStart > 300) break;
      const ch = input[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{" || ch === "[") {
        if (stack.length === 0) start = i;
        stack.push(ch);
        continue;
      }
      if (ch === "}" || ch === "]") {
        const open = stack.pop();
        const matches = (open === "{" && ch === "}") || (open === "[" && ch === "]");
        if (!matches) {
          stack.length = 0;
          start = -1;
          continue;
        }
        if (stack.length === 0 && start >= 0) {
          const candidate = input.slice(start, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            start = -1;
          }
        }
      }
    }
    return null;
  }

  /** vendor 调用点清理钩子（无持久连接，空实现保持接口一致） */
  async close(): Promise<void> {
    return undefined;
  }

  /** vendor 调用点统计钩子（返回本适配器的真实统计） */
  getStats(): { totalCalls: number; totalFailures: number; model: string } {
    return { ...this.stats, model: this.cfg.model };
  }
}

type VendorStructuredRedirect = {
  engine: WorkloomLLMEngine;
  descriptor: PropertyDescriptor;
  active: boolean;
  epoch: object;
};
const vendorStructuredRedirects = new WeakMap<object, VendorStructuredRedirect>();
const vendorStructuredMethods = new WeakSet<object>();
const vendorEngineOriginals = new WeakMap<object, Map<string, unknown>>();

/** A recognized vendor dispatch with no current owner proof is false; other engines are unrelated. */
export function attestVendorStructuredRedirect(receiver: object, reason: unknown, expected: unknown): (() => boolean) | false | undefined {
  const knownMethod = typeof reason === "function" && vendorStructuredMethods.has(reason);
  if (types.isProxy(receiver)) return knownMethod ? false : undefined;
  const prototype = Object.getPrototypeOf(receiver);
  const installed = prototype && vendorStructuredRedirects.get(prototype);
  if (!installed) return knownMethod || (prototype && vendorEngineOriginals.has(prototype)) ? false : undefined;
  if (installed.engine !== expected || installed.descriptor.value !== reason) return false;
  const epoch = installed.epoch;
  const current = () => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "reasonStructured");
    return installed.active && installed.epoch === epoch && vendorStructuredRedirects.get(prototype) === installed
      && Object.getPrototypeOf(receiver) === prototype && !Object.hasOwn(receiver, "reasonStructured")
      && descriptor?.value === reason && descriptor?.writable === installed.descriptor.writable
      && descriptor?.enumerable === installed.descriptor.enumerable && descriptor?.configurable === installed.descriptor.configurable
      && WorkloomLLMEngine.supportsStructuredReviewProof(installed.engine);
  };
  return current() ? current : false;
}

/**
 * vendor 自建 LLMEngine 的「原型桥」（2026-09-21 真机修复）
 *
 * 问题：vendor 多条链路（剧本引擎、需求洞察子引擎、提示词/微动作…）会**自己** `new LLMEngine({...})`，
 * 读的是 vendor 自己的旧环境变量与历史模型名。
 * 宿主注入的适配器只在主流水线生效，于是这些环节全部失败：
 *   `[ScriptGenerator] LLM引擎返回失败: API Key 未配置` → 剧本生成重试 3 次 → 预生产 pipeline.failed。
 *
 * 做法：**不改 vendor 目录**（只读纪律），在运行时把 vendor LLMEngine 原型的四个调用点
 * （reason / reasonRaw / reasonStructured / chat）重定向到宿主适配器 —— 这些方法被整体替换，
 * 构造函数里那句 `_noApiKey` 判断自然失效，模型/端点/计量/事件留痕全部走 WorkLoom 模型路由。
 *
 * 每次安装使用独立身份；返回摘除函数，供测试或热重载恢复上次绑定。
 */
export function installVendorEngineBridge(engine: WorkloomLLMEngine): () => void {
  try {
    // 仓库根按**本模块位置**解析（服务进程 cwd 是 apps/server，用 cwd 会找不到 vendor）
    const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
    const vendorRequire = createRequire(resolvePath(repoRoot, "package.json"));
    const enginePath = resolvePath(repoRoot, "vendor/supermickey/systems/llm-reasoning-engine.js");
    if (!existsSync(enginePath)) return () => undefined;
    const mod = vendorRequire(enginePath) as { LLMEngine?: { prototype: Record<string, unknown> } };
    const prototype = mod?.LLMEngine?.prototype;
    if (!prototype) return () => undefined;
    const previous = vendorStructuredRedirects.get(prototype);
    const patched: Array<{ name: string; original: unknown; redirect: (...args: unknown[]) => unknown }> = [];
    const redirect = (name: string, impl: (...args: unknown[]) => unknown) => {
      if (typeof prototype[name] !== "function") return;
      patched.push({ name, original: prototype[name], redirect: impl });
      prototype[name] = impl;
    };
    redirect("reason", (prompt: unknown, options: unknown = {}) =>
      engine.reason(String(prompt ?? ""), options as LLMReasonOptions));
    redirect("reasonRaw", (prompt: unknown, options: unknown = {}) =>
      engine.reasonRaw(String(prompt ?? ""), options as LLMReasonOptions));
    redirect("reasonStructured", (prompt: unknown, schema: unknown, options: unknown = {}) =>
      engine.reasonStructured(String(prompt ?? ""), schema, options as LLMReasonOptions));
    redirect("chat", (systemPrompt: unknown, userPrompt: unknown, temperature: unknown = 1) => {
      const parsedTemperature = Number(temperature);
      return engine.chat(String(systemPrompt ?? ""), String(userPrompt ?? ""), Number.isFinite(parsedTemperature) ? parsedTemperature : 1);
    });
    redirect("generate", (prompt: unknown, options: unknown = {}) =>
      engine.generate(String(prompt ?? ""), options as LLMReasonOptions));
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "reasonStructured");
    const installed = descriptor && patched.some(entry => entry.name === "reasonStructured" && entry.redirect === descriptor.value)
      ? { engine, descriptor, active: true, epoch: {} } : undefined;
    if (installed) {
      if (!vendorEngineOriginals.has(prototype)) {
        vendorEngineOriginals.set(prototype, new Map(patched.map(({ name, original }) => [name, original])));
      }
      vendorStructuredMethods.add(installed.descriptor.value);
      vendorStructuredRedirects.set(prototype, installed);
    }
    return () => {
      if (installed) {
        installed.active = false;
        if (vendorStructuredRedirects.get(prototype) !== installed) return;
        if (previous?.active) {
          previous.epoch = {};
          vendorStructuredRedirects.set(prototype, previous);
        }
        else vendorStructuredRedirects.delete(prototype);
      }
      const restoreOriginals = previous && !previous.active ? vendorEngineOriginals.get(prototype) : undefined;
      for (const { name, original, redirect } of patched) {
        if (prototype[name] === redirect) prototype[name] = restoreOriginals?.get(name) ?? original;
      }
    };
  } catch {
    // vendor 不在（例如只跑单测）时静默：桥接是增强，不是启动前置
    return () => undefined;
  }
}
