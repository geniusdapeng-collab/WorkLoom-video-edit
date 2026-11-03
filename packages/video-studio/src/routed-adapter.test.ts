/**
 * v3.0 vendor 引擎收口测试：WorkloomLLMEngine 注入 router 后——
 * 全部调用经 routeSmart（preproduction 场景 + 真实计量留痕 + fastModel 强制 L1 + 失败可重试语义）
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MODEL_POLICY, MockProvider, OpenAiCompatibleProvider, planDeepSeekWindow, resetCircuit, routeSmart,
  type ChatMessage, type ChatOptions, type ModelProvider,
} from "@workloom/base/model-router";
import { nativeReasonCompleted, nativeReasonFailure, WorkloomLLMEngine } from "./llm-adapter.js";
import { installPrdAuthorityBridge, withPrdAuthorityScope } from "./prd-authority-bridge.js";
import { preparePrdAuthority } from "./prd-authority.js";
import { requirementRecord, type RequirementRecord } from "./requirement-contract.js";
import { PRDGenerator, PRDSchema, prdFixture } from "./prd-authority.test-support.js";

afterEach(() => vi.restoreAllMocks());

function memSink() {
  const traces: any[] = [];
  const degrades: any[] = [];
  return {
    traces,
    degrades,
    sink: {
      recordModelTrace: async (t: unknown) => { traces.push(t); },
      recordDegradation: async (d: unknown) => { degrades.push(d); },
      recordCircuitBreak: async () => undefined,
    },
  };
}

const engine = (sink: any, providers?: Map<string, MockProvider>) =>
  new WorkloomLLMEngine({
    baseUrl: "http://unused.local/v1",
    apiKey: "sk-test",
    model: "deepseek-flash",
    fastModel: "deepseek-flash",
    router: {
      providers: providers ?? new Map([
        ["deepseek-flash", new MockProvider("deepseek-flash")],
      ]),
      sink,
      scene: "video.preproduction.plan",
    },
  });

describe("vendor 引擎收口 routeSmart（preproduction 场景）", () => {
  it("reason() 经路由应答并写 model.call 计量（场景留痕）", async () => {
    const { sink, traces } = memSink();
    const r = await engine(sink).reason("写一条 15 秒种草短视频大纲");
    expect(r.success).toBe(true);
    expect(r.content).toContain("mock:");
    expect(traces.length).toBe(1);
    expect(traces[0]).toMatchObject({ scene: "video.preproduction.plan", bill_to: "tenant" });
  });

  it("fast and main calls both resolve to the same canonical model", async () => {
    const { sink, traces } = memSink();
    const e = engine(sink);
    await e.reason("主力调用");
    await e.reason("快速调用", { model: "deepseek-flash" });
    expect(traces.map((trace) => trace.model_id)).toEqual(["deepseek-flash", "deepseek-flash"]);
  });

  it("主模型故障只做同模型失败关闭，不切换其他厂商", async () => {
    const { sink, degrades } = memSink();
    const providers = new Map([
      ["deepseek-flash", new MockProvider("deepseek-flash", { failFirst: 99 })],
    ]);
    const r = await engine(sink, providers).reason("x");
    expect(r.success).toBe(false);
    expect(degrades.length).toBe(1);
    expect(degrades[0]).toMatchObject({ from: "deepseek-flash", to: null });
  });

  it("全链不可用 → success:false + retryable（vendor 熔断纪律接管，不静默）", async () => {
    const { sink } = memSink();
    const providers = new Map([
      ["deepseek-flash", new MockProvider("deepseek-flash", { failFirst: 99 })],
    ]);
    const r = await engine(sink, providers).reason("x");
    expect(r.success).toBe(false);
    expect(r.retryable).toBe(false);
  });

  it("reasonStructured 的 JSON 提取在路由路径上保持兼容", async () => {
    const { sink } = memSink();
    // Mock 应答非 JSON → extractJson 抛错 → success:false retryable（与旧路径同语义）
    const r = await engine(sink).reasonStructured("x", {});
    expect(r.success).toBe(false);
    expect(r.retryable).toBe(false);
  });
});

const STRUCTURE_MARKER = "【目标JSON结构示例】\n";

function structuredEngine(reply: string | ((messages: ChatMessage[]) => string)) {
  const requests: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];
  const { sink, traces } = memSink();
  const provider: ModelProvider = {
    modelId: "deepseek-flash",
    healthy: async () => true,
    chat: async (messages, options = {}) => {
      requests.push({ messages, options });
      const text = typeof reply === "function" ? reply(messages) : reply;
      return {
        text,
        promptTokens: 73,
        completionTokens: 29,
        modelId: "deepseek-flash",
        finishReason: "stop",
        reasoningTokens: 0,
        requestHash: "a".repeat(64),
        responseHash: "b".repeat(64),
        responseId: "fixture",
        scene: options.scene ?? "generic",
        mode: "enabled",
        effort: "high",
        outputCeiling: 393216,
        inputTokenEstimate: 73,
        imageCount: 0,
        policyVersion: "2026-10-30.1",
        registryVersion: "2026-10-30.1",
        attempts: [],
      };
    },
  };
  const adapter = new WorkloomLLMEngine({
    baseUrl: "http://unused.local/v1", apiKey: "test-only", model: "deepseek-flash",
    router: { providers: new Map([[provider.modelId, provider]]), sink, scene: "video.preproduction.plan" },
  });
  return { adapter, requests, traces };
}

function messageText(message: ChatMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.map((part) => part.type === "text" ? part.text : "").join("");
}

function schemaFromMessages(messages: ChatMessage[]) {
  const text = messageText(messages.at(-1)!);
  const marker = text.lastIndexOf(STRUCTURE_MARKER);
  expect(marker).toBeGreaterThanOrEqual(0);
  return JSON.parse(text.slice(marker + STRUCTURE_MARKER.length));
}

describe("结构化调用保留调用方真实输出合同", () => {
  it("路由请求携带原提示及完整嵌套模板，且不改写 schema 或返回数据", async () => {
    const schema = Object.freeze({
      required: Object.freeze(["shots"]),
      shots: Object.freeze([Object.freeze({
        shotId: "SC-05", fields: Object.freeze({ scene: "", dialogue: "", timeline: { beats: [] } }),
      })]),
    });
    const payload = { shots: [{ shotId: "SC-05", fields: { scene: "本次真实返回", dialogue: "" } }] };
    const raw = JSON.stringify(payload);
    const { adapter, requests, traces } = structuredEngine(raw);
    const result = await adapter.reasonStructured("原提示：保留\n每一行与标点。", schema);
    expect(requests).toHaveLength(1);
    expect(messageText(requests[0]!.messages.at(-1)!)).toMatch(/^原提示：保留\n每一行与标点。\n/);
    expect(schemaFromMessages(requests[0]!.messages)).toEqual(schema);
    expect(requests[0]!.options.responseFormat).toEqual({ type: "json_object" });
    expect(result).toMatchObject({ success: true, content: raw, data: payload });
    expect(result.data).toEqual(payload);
    expect(traces).toHaveLength(1);
  });

  it("保持调用方采样、预算、system prompt、thinking 与取消信号，不增加调用", async () => {
    const { adapter, requests } = structuredEngine('{"ok":true}');
    const controller = new AbortController();
    await adapter.reasonStructured("原文", { ok: true }, {
      systemPrompt: "调用方 system", temperature: 0.37, topP: 0.83, maxTokens: 12288,
      thinking: { type: "disabled" }, signal: controller.signal,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.messages[0]).toEqual({ role: "system", content: "调用方 system" });
    expect(requests[0]!.options).toMatchObject({
      topP: 0.83, thinking: { type: "enabled", effort: "high" }, responseFormat: { type: "json_object" },
    });
    expect(requests[0]!.options.maxTokens).toBeUndefined();
    expect(requests[0]!.options.temperature).toBeUndefined();
    expect(requests[0]!.options.signal?.aborted).toBe(false);
    controller.abort();
    expect(requests[0]!.options.signal?.aborted).toBe(true);
  });

  it("直连路径传递相同完整结构及实际 model，保留原始 content/usage", async () => {
    const calls: Array<Record<string, any>> = [];
    const raw = '{"shots":[{"shotId":"镜-02","fields":{"scene":"光线"}}]}';
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        id: "fixture",
        model: "deepseek-flash",
        choices: [{ finish_reason: "stop", message: { content: raw } }],
        usage: {
          prompt_tokens: 7,
          completion_tokens: 5,
          total_tokens: 12,
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      }), { status: 200 });
    });
    const adapter = new WorkloomLLMEngine({ baseUrl: "http://unused.local/v1", apiKey: "test-only", model: "deepseek-flash" });
    const schema = { shots: [{ shotId: "镜-02", fields: { scene: "", quote: '空值与"引号"\n换行' } }] };
    const result = await adapter.reasonStructured("原始需求", schema, { maxTokens: 4096, temperature: 0.4 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: "deepseek-flash", thinking: { type: "enabled" },
      reasoning_effort: "high", response_format: { type: "json_object" } });
    expect(schemaFromMessages(calls[0]!.messages)).toEqual(schema);
    expect(result).toMatchObject({ success: true, content: raw,
      usage: { promptTokens: 7, completionTokens: 5 } });
  });

  it("未提供结构的旧调用仍保持原接口兼容，不补造字段", async () => {
    const { adapter, requests } = structuredEngine('{"unchanged":true}');
    const result = await adapter.reasonStructured("旧调用", undefined);
    expect(result.data).toEqual({ unchanged: true });
    expect(requests).toHaveLength(1);
    expect(messageText(requests[0]!.messages.at(-1)!)).toMatch(/^旧调用\n/);
  });

  it("不可序列化的结构明确失败且不提交模型请求", async () => {
    const { adapter, requests } = structuredEngine('{"unused":true}');
    const schema: Record<string, unknown> = {};
    schema.self = schema;
    const result = await adapter.reasonStructured("原文", schema);
    expect(result).toMatchObject({ success: false, retryable: false });
    expect(result.error).toContain("结构化输出结构不可序列化");
    expect(requests).toHaveLength(0);
  });

  it("JSON 解析失败沿用失败结果，既不填字段也不额外重试", async () => {
    const { adapter, requests } = structuredEngine("不是 JSON");
    const result = await adapter.reasonStructured("原文", { shots: [] });
    expect(result).toMatchObject({ success: false, retryable: false });
    expect(result.data).toBeUndefined();
    expect(result.error).toContain("JSON 解析失败");
    expect(requests).toHaveLength(1);
  });

  it("HTTP 失败保持原错误与可重试标记，不产生替代响应", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("rate limited", { status: 429 }));
    const adapter = new WorkloomLLMEngine({ baseUrl: "http://unused.local/v1", apiKey: "test-only", model: "deepseek-flash" });
    const result = await adapter.reasonStructured("原文", { shots: [] });
    expect(result.success).toBe(false);
    expect(result.error).toContain("HTTP 429");
    expect(result.retryable).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("返回镜号或字段不符时保留实际响应，交由原消费者判定", async () => {
    const payload = { shots: [{ shotId: "SC01", fields: {} }] };
    const { adapter, requests } = structuredEngine(JSON.stringify(payload));
    const result = await adapter.reasonStructured("原文", { shots: [{ shotId: "SC-05", fields: { scene: "" } }] });
    expect(result.data).toEqual(payload);
    expect(requests).toHaveLength(1);
  });
});

const sceneResponsesSchema = {
  type: "object",
  properties: { sceneCount: { type: "integer" } },
  required: ["sceneCount"],
  additionalProperties: false,
};
const sceneResponsesOptions = {
  responsesJsonSchema: { name: "workloom_scene_architect", schema: sceneResponsesSchema },
  systemPrompt: "完整导演指令",
};

function responsesFixture(text: string) {
  return {
    object: "response", id: "native-scene-receipt", model: "deepseek-flash", status: "completed",
    output: [
      { type: "reasoning", summary: [] },
      {
        type: "message", role: "assistant", phase: "final_answer", status: "completed",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: { input_tokens: 120, output_tokens: 80, total_tokens: 200, output_tokens_details: { reasoning_tokens: 54 } },
  };
}

describe("显式选择 Responses JSON Schema 的原生路由", () => {
  it("仅发送一次完整原生结构化请求，保留同一法定窗口、结束态、哈希和用量", async () => {
    const url = "https://provider.invalid/v1";
    const prompt = "原文与换行\n".repeat(2000);
    const resultBody = JSON.stringify(responsesFixture('{"sceneCount":3}'));
    const transport = vi.fn<typeof fetch>(async () => new Response(resultBody));
    const provider = new OpenAiCompatibleProvider("deepseek-flash", { baseUrl: url, apiKey: "test-only", fetchImpl: transport });
    const { sink, traces } = memSink();
    const adapter = new WorkloomLLMEngine({
      baseUrl: url, apiKey: "test-only", model: "deepseek-flash",
      router: { providers: new Map([[provider.modelId, provider]]), sink },
    });
    const result = await adapter.reasonStructured(prompt, sceneResponsesSchema, sceneResponsesOptions);
    expect(result).toMatchObject({
      success: true, content: '{"sceneCount":3}', data: { sceneCount: 3 },
      usage: { promptTokens: 120, completionTokens: 80 },
    });
    expect(nativeReasonCompleted(result)).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
    const [endpoint, init] = transport.mock.calls[0]!;
    expect(endpoint).toBe(`${url}/responses`);
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { authorization: "Bearer test-only" } });
    const wire = JSON.parse(String(init?.body));
    const input = wire.input as string;
    expect(input.startsWith(prompt)).toBe(true);
    expect(input.endsWith(JSON.stringify(sceneResponsesSchema, null, 2))).toBe(true);
    const format = { type: "json_schema", ...sceneResponsesOptions.responsesJsonSchema };
    const plan = await planDeepSeekWindow({
      messages: [{ role: "system", content: sceneResponsesOptions.systemPrompt }, { role: "user", content: input }],
      responseFormat: format,
    });
    expect(wire).toEqual({
      model: "deepseek-flash", input, instructions: sceneResponsesOptions.systemPrompt,
      reasoning: { effort: "high" }, max_output_tokens: plan.outputCeiling, stream: false, text: { format },
    });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      requestHash: createHash("sha256").update(String(init?.body)).digest("hex"),
      responseHash: createHash("sha256").update(resultBody).digest("hex"),
      reasoningTokens: 54,
    });
  });

  it("拒绝替换为 Mock 或自定义提供商", async () => {
    const { adapter, requests, traces } = structuredEngine('{"sceneCount":3}');
    try {
      const result = await adapter.reasonStructured("场景", sceneResponsesSchema, sceneResponsesOptions);
      expect(result).toMatchObject({ success: false, retryable: false });
      expect(result.error).toContain("需要原生 DeepSeek 传输");
      expect(requests).toHaveLength(0);
      expect(traces).toHaveLength(0);
    } finally {
      resetCircuit("video.preproduction.plan");
    }
  });

  it("accepts a single documented completed assistant text part when phase is omitted", async () => {
    const fixture = responsesFixture('{"sceneCount":3}');
    const output = [{ type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: '{"sceneCount":3}' }] }];
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ...fixture, output }));
    const provider = new OpenAiCompatibleProvider("deepseek-flash", { baseUrl: "https://provider.invalid", fetchImpl });
    await expect(provider.chat([{ role: "system", content: "system" }, { role: "user", content: "user" }], {
      scene: "video.preproduction.plan", responsesJsonSchema: sceneResponsesOptions.responsesJsonSchema,
    })).resolves.toMatchObject({ text: '{"sceneCount":3}', finishReason: "stop" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("仅完整测量的外层响应允许识别内层 JSON 语法错误", async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json(responsesFixture('{"sceneCount":')));
    const adapter = new WorkloomLLMEngine({
      baseUrl: "https://provider.invalid", apiKey: "test-only", model: "deepseek-flash", fetchImpl: transport,
    });
    const result = await adapter.reasonStructured("场景", sceneResponsesSchema, sceneResponsesOptions);
    expect(result).toMatchObject({ success: false, retryable: false });
    expect(nativeReasonFailure(result)).toBe("json-syntax");
    expect(nativeReasonCompleted(result)).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["incomplete", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }],
    ["mismatched model", { model: "some-other-model" }],
    ["no receipt id", { id: "" }],
    ["duplicate output", { output: responsesFixture("{}").output.concat(responsesFixture("{}").output) }],
    ["intermediate text", { output: [{ type: "message", role: "assistant", status: "completed", phase: "commentary",
      content: [{ type: "output_text", text: "{}" }] }] }],
    ["tool output", { output: [{ type: "function_call" }] }],
    ["refusal", {
      output: [{ type: "message", status: "completed", role: "assistant", phase: "final_answer",
        content: [{ type: "refusal", refusal: "declined" }] }],
    }],
    ["blank output", responsesFixture("  ")],
    ["bad usage", { usage: { input_tokens: 120, output_tokens: 80, total_tokens: 199 } }],
    ["oversized usage", { usage: { input_tokens: 120, output_tokens: 393217, total_tokens: 393337 } }],
  ])("rejects %s after one dispatch", async (_label, override) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ...responsesFixture("{}"), ...override }));
    const provider = new OpenAiCompatibleProvider("deepseek-flash", { baseUrl: "https://provider.invalid", fetchImpl });
    await expect(provider.chat([{ role: "system", content: "system" }, { role: "user", content: "user" }], {
      scene: "video.preproduction.plan", responsesJsonSchema: sceneResponsesOptions.responsesJsonSchema, retries: 3,
    })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry a rejected Responses wire", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("refused", { status: 429 }));
    const provider = new OpenAiCompatibleProvider("deepseek-flash", { baseUrl: "https://provider.invalid", fetchImpl });
    await expect(provider.chat([{ role: "system", content: "system" }, { role: "user", content: "user" }], {
      scene: "video.preproduction.plan", responsesJsonSchema: sceneResponsesOptions.responsesJsonSchema, retries: 3,
    })).rejects.toMatchObject({ retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

function pinnedReviewTransport(usage = { prompt_tokens: 300, completion_tokens: 100, total_tokens: 400 }) {
  const requests: string[] = [];
  const { sink } = memSink();
  const endpoint = "http://review-proof.invalid/v1";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toBe(`${endpoint}/chat/completions`);
    requests.push(String(init?.body));
    return Response.json({
      model: "deepseek-flash", choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }], usage,
    });
  });
  const adapter = new WorkloomLLMEngine({ baseUrl: endpoint, apiKey: "fixture-only", model: "deepseek-flash" });
  const providerConfig: { baseUrl: string; apiKey?: string; fetchImpl?: typeof fetch } = {
    baseUrl: endpoint, apiKey: "fixture-only",
  };
  const provider = new OpenAiCompatibleProvider("deepseek-flash", providerConfig);
  const router = {
    providers: new Map([[provider.modelId, provider]]),
    policy: structuredClone(DEFAULT_MODEL_POLICY),
    forceModel: provider.modelId,
    sink,
  };
  adapter.attachRouter(router);
  return { adapter, router, sink, requests, providerConfig };
}

describe("G6 结构化评审的实际派发证据", () => {
  it.each(["router-policy", "scene-rule", "sink-method", "router-proxy"] as const)(
    "%s 动态配置只按原调度读取，实际请求不变且无证明", async (kind) => {
      const scene = "G6-proof-dynamic-policy";
      const prompt = "检查动态配置";
      const schema = { ok: true };
      const options = { scene };
      const setup = () => {
        const { adapter, router, requests } = pinnedReviewTransport();
        router.policy.scenes[scene] = { tier: "L2", responseFormat: "json_object" };
        let reads = 0;
        if (kind === "router-policy") {
          const first = router.policy;
          const second = structuredClone(first);
          second.scenes[scene] = { tier: "L2", responseFormat: "text" };
          Object.defineProperty(router, "policy", { get: () => ++reads === 2 ? second : first });
        } else if (kind === "scene-rule") {
          Object.defineProperty(router.policy.scenes[scene], "responseFormat", {
            get: () => ++reads === 2 ? "text" : "json_object",
          });
        } else if (kind === "sink-method") {
          const record = router.sink.recordModelTrace;
          Object.defineProperty(router.sink, "recordModelTrace", { get: () => { ++reads; return record; } });
        } else {
          adapter.attachRouter(new Proxy(router, {
            get(target, key, receiver) { ++reads; return Reflect.get(target, key, receiver); },
          }));
        }
        return { adapter, requests, reads: () => reads };
      };
      const ordinary = setup();
      expect((await ordinary.adapter.reasonStructured(prompt, schema, options)).success).toBe(true);
      const optedIn = setup();
      const actual = await optedIn.adapter.reasonStructuredWithProof(prompt, schema, options);
      expect(actual.result.success).toBe(true);
      expect(optedIn.requests).toEqual(ordinary.requests);
      expect(optedIn.reads()).toBe(ordinary.reads());
      expect(actual.proof).toBeUndefined();
    },
  );

  it("提供方实例不变但有效传输或授权变更后，旧证明失效", async () => {
    const { adapter, requests, providerConfig } = pinnedReviewTransport();
    const originalFetch = globalThis.fetch;
    const explicitTransport = vi.fn<typeof fetch>((url, init) => originalFetch(url, init));
    providerConfig.fetchImpl = explicitTransport;
    const prompt = "检查镜头";
    const schema = { ok: true };
    const options = { scene: "G6-proof-transport" };
    const { proof } = await adapter.reasonStructuredWithProof(prompt, schema, options);
    expect(proof?.matchesCurrent(prompt, schema, options)).toBe(true);

    const replacement = vi.fn<typeof fetch>((url, init) => originalFetch(url, init));
    providerConfig.fetchImpl = replacement;
    expect(proof?.matchesCurrent(prompt, schema, options)).toBe(false);
    const fresh = await adapter.reasonStructuredWithProof(prompt, schema, options);
    expect(fresh.result).toMatchObject({ success: true, data: { ok: true } });
    expect(fresh.proof?.matchesCurrent(prompt, schema, options)).toBe(true);
    expect(replacement).toHaveBeenCalledTimes(1);

    providerConfig.apiKey = "rotated-fixture-only";
    expect(fresh.proof?.matchesCurrent(prompt, schema, options)).toBe(false);
    expect(requests).toHaveLength(2);
    expect(explicitTransport).toHaveBeenCalledTimes(1);
  });

  it("有副作用的动态传输配置保持原调度，不能提供可复用证明", async () => {
    const { adapter, requests, providerConfig } = pinnedReviewTransport();
    const originalFetch = globalThis.fetch;
    const readTransport = vi.fn(() => originalFetch);
    Object.defineProperty(providerConfig, "fetchImpl", { get: readTransport });
    const result = await adapter.reasonStructuredWithProof("检查镜头", { ok: true }, { scene: "G6-proof-transport-getter" });
    expect(result.result).toMatchObject({ success: true, data: { ok: true } });
    expect(result.proof).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(readTransport).toHaveBeenCalledTimes(1);
  });

  it("当前性比较包含完整 G4 权威追加，命中前复查原件字节", async () => {
    const { adapter, requests } = pinnedReviewTransport();
    const source = prdFixture("G6-PROOF-AUTHORITY");
    class System {
      constructor(readonly prdGenerator: RequirementRecord) {}
      async _confirmRequirementList(_markdown: string, list: unknown) { return { approved: true, requirementList: list }; }
      _generateMinimalPRD() { throw new Error("fixture cannot fall back to minimal PRD"); }
      async _confirmPRD(_markdown: string, prd: unknown) { return { approved: true, prd }; }
    }
    const dispose = installPrdAuthorityBridge(System.prototype as unknown as RequirementRecord, PRDGenerator.prototype, PRDSchema);
    const generator = new PRDGenerator();
    for (const [key, payload] of [["agent2", source.creative], ["agent3", source.production]] as const) {
      const agent = requirementRecord(generator[key], key);
      agent._llmEngineLoaded = true;
      agent._llmEngine = { reasonStructured: async () => ({ success: true, data: structuredClone(payload) }) };
    }
    const system = new System(generator);
    const options = { scene: "G6-proof-authority", maxTokens: 2200, temperature: 0 };
    const prompt = "检查真实上游原文";
    const schema = { ok: true };
    const verifyAuthority = () => preparePrdAuthority({
      metadata: source.metadata, marketing: source.marketing, workDir: source.workDir, projectId: source.scope.projectId,
    });
    try {
      await expect(withPrdAuthorityScope(source.authority, async () => {
        await system._confirmRequirementList("G3 fixture", source.list);
        const prd = await (generator.generate as (value: unknown) => Promise<RequirementRecord>).call(generator, source.discovery);
        const markdown = (generator.generateMarkdown as (value: unknown) => string).call(generator, prd);
        await system._confirmPRD(markdown, prd);

        const { result, proof } = await adapter.reasonStructuredWithProof(prompt, schema, options);
        expect(result).toMatchObject({ success: true, data: { ok: true } });
        const actual = JSON.parse(requests[0]!).messages.at(-1).content;
        expect(actual).toContain(JSON.stringify(schema, null, 2));
        expect(actual).toContain(source.content);
        expect(actual).toContain(markdown);
        expect(proof?.matchesCurrent(prompt, schema, options)).toBe(true);

        // G5 may legitimately fill portraitPath. G4 still verifies, while the actual
        // model appendix changes. A proof bound only to the raw G6 prompt would hit.
        const characters = requirementRecord(prd.characterSystem, "characters").characters as RequirementRecord[];
        characters[0]!.portraitPath = "portrait-current.png";
        expect(proof?.matchesCurrent(prompt, schema, options)).toBe(false);
        characters[0]!.portraitPath = "";
        expect(proof?.matchesCurrent(prompt, schema, options)).toBe(true);

        writeFileSync(source.file, "G1 source bytes changed during repair");
        expect(() => proof?.matchesCurrent(prompt, schema, options)).toThrow("PRD_G1_CHANGED");
      }, verifyAuthority)).rejects.toThrow("PRD_G1_CHANGED");
      expect(requests).toHaveLength(1);
    } finally {
      dispose();
      source.cleanup();
    }
  });

  it("打开的路由熔断使现有证明失效，原请求返回现有不可用状态", async () => {
    const { adapter, sink, requests } = pinnedReviewTransport();
    const scene = "G6-proof-circuit";
    try {
      const { proof } = await adapter.reasonStructuredWithProof("检查", { ok: true }, { scene });
      expect(proof?.matchesCurrent("检查", { ok: true }, { scene })).toBe(true);
      const failing = new MockProvider("deepseek-flash", { failFirst: 3 });
      const providers = new Map([[failing.modelId, failing]]);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect((await routeSmart({ action: scene, scene, messages: [{ role: "user", content: "模拟故障" }] }, providers, sink)).kind).toBe("unavailable");
      }
      expect(proof?.matchesCurrent("检查", { ok: true }, { scene })).toBe(false);
      const after = await adapter.reasonStructuredWithProof("检查", { ok: true }, { scene });
      expect(after.result).toMatchObject({ success: false, error: "模型场景熔断冷却中" });
      expect(after.proof).toBeUndefined();
      expect(requests).toHaveLength(1);
    } finally { resetCircuit(scene); }
  });

  it("超过路由积分上限的有效文本保留原结果，不能成为可复用证明", async () => {
    const { adapter, router, requests } = pinnedReviewTransport({ prompt_tokens: 900_000, completion_tokens: 100, total_tokens: 900_100 });
    const scene = "G6-proof-budget";
    router.policy.scenes[scene] = { tier: "L3", noDowngrade: true };
    const result = await adapter.reasonStructuredWithProof("检查", { ok: true }, { scene });
    expect(requests).toHaveLength(1);
    expect(result.result).toMatchObject({ success: true, data: { ok: true } });
    expect(result.proof).toBeUndefined();
  });
});

const vendorRequire = createRequire(import.meta.url);
const { PromptFusionAgent } = vendorRequire("../../../vendor/supermickey/hyperreality-system/engines/production-engine/agents/prompt-fusion-agent.js");
const FUSION_FIELD_NAMES = [
  "director_instruction", "constraint", "baseline", "scene", "lighting", "composition", "color_palette",
  "depth_of_field", "camera_movement", "character", "costume", "makeup", "action", "props", "portraits",
  "dialogue", "timeline", "mood", "pacing", "transition", "audio", "negative", "bright_constraint",
  "character_constraint", "consistency",
];

function fusionFields() {
  return Object.fromEntries(FUSION_FIELD_NAMES.map(name => [name,
    `离线结构接口用例的${name}字段。稳定构图与自然光线，人物保持原地，完整保留空间关系。`.repeat(16),
  ]));
}

async function fuseThroughAdapter(reply: string | ((messages: ChatMessage[]) => string)) {
  const capture = structuredEngine(reply);
  const agent = new PromptFusionAgent({ semanticRefinement: false, llmMaxRetries: 1, llmTimeout: 300000 });
  agent._llmEngine = capture.adapter;
  agent._llmEngineLoaded = true;
  const shot = { shotId: "SC-05", sceneType: "dialogue", duration: 6, scene: "安静庭院中的完整人物中景", characters: ["offline-character"] };
  const result = await agent._fuseSingleShot(shot, "9:16", [{ id: "offline-character", name: "离线测试人物" }], { scenes: [shot] }, 300000);
  return { ...capture, result };
}

describe("真实 PromptFusion 消费宿主结构化接口", () => {
  it("实际 SC-05 与全部 25 个字段模板抵达 provider，一次真实消费返回非降级结果", async () => {
    const { requests, result } = await fuseThroughAdapter(messages => {
      const schema = schemaFromMessages(messages);
      expect(schema.required).toEqual(["shots"]);
      expect(schema.requiredArrays).toEqual(["shots"]);
      expect(schema.rejectEmptyArray).toBe(true);
      expect(schema.shots).toHaveLength(1);
      expect(schema.shots[0].shotId).toBe("SC-05");
      expect(Object.keys(schema.shots[0].fields)).toEqual(FUSION_FIELD_NAMES);
      expect(Object.values(schema.shots[0].fields).every(value => value === "")).toBe(true);
      return JSON.stringify({ shots: [{ shotId: "SC-05", fields: fusionFields() }] });
    });
    expect(requests).toHaveLength(1);
    expect(result.shotId).toBe("SC-05");
    expect(result.degraded).toBe(false);
    expect(result.degradeReason).toBeNull();
    expect(result.fields.scene).toContain("离线结构接口用例");
    expect(requests[0]!.options.maxTokens).toBeUndefined();
  });

  it.each([
    ["模板示例镜号", "SC01"],
    ["缺失镜号", undefined],
  ])("%s 的非空模型结果仍降级，不改写镜号过关", async (_label, returnedId) => {
    const fields = fusionFields();
    const payload = { shots: [{ ...(returnedId === undefined ? {} : { shotId: returnedId }), fields }] };
    const { result, requests } = await fuseThroughAdapter(JSON.stringify(payload));
    expect(requests).toHaveLength(1);
    expect(result.degraded).toBe(true);
    expect(result.shotId).toBe("SC-05");
    expect(result.fields?.scene).not.toContain("离线结构接口用例");
  });
});
