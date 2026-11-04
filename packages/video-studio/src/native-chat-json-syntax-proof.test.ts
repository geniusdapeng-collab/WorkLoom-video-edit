import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleProvider, resetCircuit, type EventSink } from "@workloom/base/model-router";
import { nativeChatJsonSyntaxCorrected, nativeChatJsonSyntaxRouteCurrent, nativeReasonCompleted, nativeReasonFailure,
  WorkloomLLMEngine } from "./llm-adapter.js";

const scene = "video.preproduction.plan";
const schema = { coreTheme: "核心主题" };
const malformed = ' \r\n{"coreTheme":"领跑" "endingType":"闭合式"}\t ';
const completed = ' \r\n{"coreTheme":"领跑"}\t ';

function wire(content: unknown, id = "fixture-one", patch: Record<string, unknown> = {}) {
  return JSON.stringify({
    id, object: "chat.completion", model: "deepseek-flash",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    usage: { prompt_tokens: 50, completion_tokens: 40, total_tokens: 90,
      completion_tokens_details: { reasoning_tokens: 30 } },
    ...patch,
  });
}

function engineFor(...bodies: Response[]) {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const body of bodies) fetchImpl.mockResolvedValueOnce(body);
  const transport = { baseUrl: "https://provider.invalid", apiKey: "fixture-key", fetchImpl };
  const provider = new OpenAiCompatibleProvider("deepseek-flash", transport);
  const sink: EventSink = { recordModelTrace: async () => undefined, recordDegradation: async () => undefined,
    recordCircuitBreak: async () => undefined };
  const router = { providers: new Map([[provider.modelId, provider]]), sink, scene, forceModel: "deepseek-flash" };
  const engine = new WorkloomLLMEngine({ ...transport, model: "deepseek-flash", router });
  return { engine, fetchImpl, router, transport };
}

afterEach(() => resetCircuit(scene));

describe("native structured Chat syntax reissue evidence", () => {
  it("binds exact native structured requests, content, usage and distinct measured identities", async () => {
    const { engine, fetchImpl, transport } = engineFor(new Response(wire(malformed)),
      new Response(wire(completed, "fixture-two")));
    const first = await engine.reasonStructured("完整原始创意", schema);
    const second = await engine.reasonStructured("完整原始创意与结构修正", schema);
    expect(nativeReasonFailure(first)).toBe("json-syntax");
    expect(first).toMatchObject({ success: false, retryable: false, content: malformed.trim(),
      usage: { promptTokens: 50, completionTokens: 40 } });
    expect(nativeReasonCompleted(first)).toBe(true);
    expect(second).toMatchObject({ success: true, content: completed.trim(), data: { coreTheme: "领跑" } });
    expect(nativeChatJsonSyntaxRouteCurrent(engine, first)).toBe(true);
    expect(nativeChatJsonSyntaxCorrected(first, second)).toBe(true);
    expect(nativeChatJsonSyntaxCorrected({ ...first }, second)).toBe(false);
    expect(nativeChatJsonSyntaxCorrected(first, { ...second })).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [url, request] of fetchImpl.mock.calls) {
      expect(url).toBe("https://provider.invalid/chat/completions");
      expect(JSON.parse(String(request?.body))).toMatchObject({
        model: "deepseek-flash", thinking: { type: "enabled" }, reasoning_effort: "high", max_tokens: 393216,
        response_format: { type: "json_object" },
      });
    }
    (second.data as typeof schema).coreTheme = "漂移";
    expect(nativeChatJsonSyntaxCorrected(first, second)).toBe(false);
    (second.data as typeof schema).coreTheme = "领跑";
    const accessor = vi.fn(() => first.content);
    Object.defineProperty(first.usage, "completionTokens", { configurable: true, get: accessor });
    expect(nativeChatJsonSyntaxRouteCurrent(engine, first)).toBe(false);
    expect(accessor).not.toHaveBeenCalled();
    Object.defineProperty(first.usage, "completionTokens", { configurable: true, value: 40 });
    expect(nativeChatJsonSyntaxCorrected(first, second)).toBe(true);
    transport.apiKey = "rotated-fixture-key";
    expect(nativeChatJsonSyntaxRouteCurrent(engine, first)).toBe(false);
    expect(nativeChatJsonSyntaxCorrected(first, second)).toBe(false);
  });

  it.each(["response-id", "request-hash", "engine", "schema", "options", "system-message"])(
    "rejects a candidate with mismatched or reused identity (%s)", async variant => {
      const after = wire(completed, variant === "response-id" ? "fixture-one" : "fixture-two");
      const { engine } = engineFor(new Response(wire(malformed)), new Response(after));
      const first = await engine.reasonStructured("完整输入", schema);
      const selected = variant === "engine" ? engineFor(new Response(after)).engine : engine;
      const next = await selected.reasonStructured(variant === "request-hash" ? "完整输入" : "完整输入与修正",
        variant === "schema" ? { ...schema, other: "新字段" } : schema,
        variant === "options" ? { timeoutMs: 150000 } : variant === "system-message" ? { systemPrompt: "其他系统消息" } : {});
      expect(nativeChatJsonSyntaxRouteCurrent(engine, first)).toBe(true);
      expect(next.success).toBe(true);
      expect(nativeChatJsonSyntaxCorrected(first, next)).toBe(false);
    },
  );

  it.each([
    ["duplicate decoded key", '{"coreTheme":"领跑","\\u0063oreTheme":"漂移"}'],
    ["non-JSON raw padding", '\u00A0{"coreTheme":"领跑"}'],
    ["non-object JSON", '["领跑"]'],
    ["another syntax failure", malformed],
  ])("rejects %s in the correction's original Chat bytes", async (_label, raw) => {
    const { engine } = engineFor(new Response(wire(malformed)), new Response(wire(raw, "fixture-two")));
    const first = await engine.reasonStructured("完整原始创意", schema);
    const second = await engine.reasonStructured("完整原始创意与结构修正", schema);
    expect(nativeChatJsonSyntaxRouteCurrent(engine, first)).toBe(true);
    expect(nativeChatJsonSyntaxCorrected(first, second)).toBe(false);
  });

  it.each([
    ["blank", wire(" ")],
    ["bad usage", wire(malformed, "fixture-one", { usage: { prompt_tokens: 50, completion_tokens: 40, total_tokens: 89 } })],
    ["refusal", wire(malformed, "fixture-one", { choices: [{ index: 0, finish_reason: "stop",
      message: { role: "assistant", content: malformed, refusal: "拒绝" } }] })],
    ["length", wire(malformed, "fixture-one", { choices: [{ index: 0, finish_reason: "length",
      message: { role: "assistant", content: malformed } }] })],
    ["missing response id", wire(malformed, "")],
  ])("does not authorize a correction for an unattested first result (%s)", async (_label, body) => {
    const { engine } = engineFor(new Response(body));
    const result = await engine.reasonStructured("完整原始创意", schema);
    expect(nativeChatJsonSyntaxRouteCurrent(engine, result)).toBe(false);
  });

  it("does not accept a non-200, a raw caller or changed options as structured evidence", async () => {
    const { engine, router } = engineFor(new Response(wire(malformed), { status: 201 }), new Response(wire(malformed, "raw")),
      new Response(wire(malformed, "structured")), new Response(wire(malformed, "another")));
    const noncanonical = await engine.reasonStructured("结构化输入", schema);
    const raw = await engine.reason("普通输入", { forceJson: true });
    const opts = { timeoutMs: 123456 };
    const structured = await engine.reasonStructured("结构化输入", schema, opts);
    expect(nativeChatJsonSyntaxRouteCurrent(engine, noncanonical)).toBe(false);
    expect(nativeChatJsonSyntaxRouteCurrent(engine, raw)).toBe(false);
    expect(nativeChatJsonSyntaxRouteCurrent(engine, structured)).toBe(true);
    opts.timeoutMs += 1;
    expect(nativeChatJsonSyntaxRouteCurrent(engine, structured)).toBe(false);
    const other = await engine.reasonStructured("另一结构化输入", schema);
    expect(nativeChatJsonSyntaxRouteCurrent(engine, other)).toBe(true);
    engine.attachRouter(router);
    expect(nativeChatJsonSyntaxRouteCurrent(engine, other)).toBe(false);
  });
});
