import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { isRiskResponsesJsonSchema, OpenAiCompatibleProvider, resetCircuit, riskResponsesJsonSchema, type EventSink } from "@workloom/base/model-router";
import { nativeReasonCompleted, nativeReasonFailure, nativeRiskResponseRouteCurrent, nativeRiskResponseSource,
  nativeSceneResponseRouteCurrent, nativeSceneResponseSource, sameNativeRiskResponseRoute, sameNativeSceneResponseRoute,
  WorkloomLLMEngine } from "./llm-adapter.js";

const schema = {
  type: "object",
  properties: { sceneCount: { type: "integer" } },
  required: ["sceneCount"],
  additionalProperties: false,
};
const sceneName = "workloom_scene_architect";
const options = { responsesJsonSchema: { name: sceneName, schema } };
const baseUrl = "https://provider.invalid/v1";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function responsesWire(text: string, changes: Record<string, unknown> = {}) {
  return JSON.stringify({
    object: "response", model: "deepseek-flash", id: "response-1", status: "completed",
    text: { format: { type: "json_schema", name: sceneName } },
    output: [{
      type: "message", role: "assistant", status: "completed", phase: "final_answer",
      content: [{ type: "output_text", text }],
    }],
    usage: { input_tokens: 90, output_tokens: 40, total_tokens: 130, output_tokens_details: { reasoning_tokens: 30 } },
    ...changes,
  });
}

function engineFor(body: string, status = 200, recordModelTrace: EventSink["recordModelTrace"] = async () => undefined) {
  const transport = vi.fn<typeof fetch>(async () => new Response(body, { status }));
  const cfg = { baseUrl, apiKey: "fixture-key", fetchImpl: transport };
  const provider = new OpenAiCompatibleProvider("deepseek-flash", cfg);
  const sink: EventSink = { recordModelTrace, recordDegradation: async () => undefined, recordCircuitBreak: async () => undefined };
  const engine = new WorkloomLLMEngine({
    ...cfg, model: "deepseek-flash",
    router: { providers: new Map([[provider.modelId, provider]]), sink },
  });
  return { engine, transport, cfg };
}

describe("native Scene Responses text evidence", () => {
  it.each([
    ["valid", ' \r\n{"sceneCount":3}\t ', true],
    ["malformed", ' \r\n{"sceneCount":3 "extra":true}\t ', false],
  ])("retains exact %s text and the wire digests on the original adapter result only", async (_kind, rawText, success) => {
    const body = responsesWire(rawText);
    const { engine, transport } = engineFor(body);
    const result = await engine.reasonStructured("场景", schema, options);
    expect(result).toMatchObject({ success, content: rawText.trim(), usage: { promptTokens: 90, completionTokens: 40 } });
    expect(nativeReasonCompleted(result)).toBe(true);
    if (!success) expect(nativeReasonFailure(result)).toBe("json-syntax");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0]).toBe(`${baseUrl}/responses`);
    const receipt = nativeSceneResponseSource(result);
    expect(nativeSceneResponseRouteCurrent(result)).toBe(true);
    expect(receipt).toEqual({
      rawText, requestSha256: sha256(String(transport.mock.calls[0]?.[1]?.body)), responseSha256: sha256(body),
      schemaSha256: sha256(JSON.stringify(JSON.parse(String(transport.mock.calls[0]?.[1]?.body)).text.format.schema)),
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(nativeSceneResponseSource({ ...result, source: receipt })).toBeUndefined();
    expect(nativeSceneResponseSource(structuredClone(result))).toBeUndefined();
    expect(nativeSceneResponseSource(new Proxy(result, {}))).toBeUndefined();
    expect(nativeSceneResponseRouteCurrent({ ...result })).toBe(false);
    expect(Object.keys(result).filter(key => key === "rawText" || key.endsWith("Sha256"))).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(JSON.stringify(rawText));
  });

  it.each([
    ["wrong request name", { responsesJsonSchema: { name: "different_schema", schema } }, {}, 200, true],
    ["missing response echo", options, { text: undefined }, 200, true],
    ["mismatched response echo", options, { text: { format: { type: "json_schema", name: "different_schema" } } }, 200, true],
    ["incomplete response", options, { status: "incomplete" }, 200, false],
    ["unmeasured response", options, { usage: { input_tokens: 90, output_tokens: 40, total_tokens: 129 } }, 200, false],
    ["noncanonical HTTP status", options, {}, 201, true],
  ])("does not attest a %s", async (_kind, request, changes, status, success) => {
    try {
      const { engine, transport } = engineFor(responsesWire('{"sceneCount":3}', changes), status);
      const result = await engine.reasonStructured("场景", schema, request);
      expect(result.success).toBe(success);
      expect(nativeSceneResponseSource(result)).toBeUndefined();
      expect(nativeSceneResponseRouteCurrent(result)).toBe(false);
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      resetCircuit("video.preproduction.plan");
    }
  });

  it("rejects proof from a Chat completion and from transport changed after dispatch", async () => {
    const chatBody = JSON.stringify({
      object: "chat.completion", id: "chat-1", model: "deepseek-flash",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"sceneCount":3}' } }],
      usage: { prompt_tokens: 90, completion_tokens: 40, total_tokens: 130 },
    });
    const chat = engineFor(chatBody);
    const result = await chat.engine.reasonStructured("场景", schema);
    expect(nativeReasonCompleted(result)).toBe(true);
    expect(nativeSceneResponseSource(result)).toBeUndefined();
    expect(chat.transport.mock.calls[0]?.[0]).toBe(`${baseUrl}/chat/completions`);

    const changed = engineFor(responsesWire('{"sceneCount":3}'), 200, async () => { changed.cfg.apiKey = "changed-key"; });
    const changedResult = await changed.engine.reasonStructured("场景", schema, options);
    expect(changedResult.success).toBe(true);
    expect(nativeReasonCompleted(changedResult)).toBe(false);
    expect(nativeSceneResponseSource(changedResult)).toBeUndefined();
    expect(nativeSceneResponseRouteCurrent(changedResult)).toBe(false);
    expect(nativeSceneResponseSource({ success: false, error: "JSON 解析失败", rawText: "{}" })).toBeUndefined();
  });

  it("pairs two distinct malformed native results and a third fresh, valid result on the exact route", async () => {
    const { engine, transport } = engineFor(responsesWire('{"sceneCount":3 "extra":true}'));
    transport.mockResolvedValueOnce(new Response(responsesWire('{"sceneCount":3 "extra":true}', { id: "scene-first" })))
      .mockResolvedValueOnce(new Response(responsesWire('{"sceneCount":3 "extra":false}', { id: "scene-second" })))
      .mockResolvedValueOnce(new Response(responsesWire('{"sceneCount":3}', { id: "scene-third" })));
    const first = await engine.reason("完整原始输入", { ...options, forceJson: true });
    const second = await engine.reason("完整原始输入＋第一次纠正", { ...options, forceJson: true });
    const third = await engine.reason("完整原始输入＋格式再生成", { ...options, forceJson: true });
    expect([first.success, second.success, third.success]).toEqual([false, false, true]);
    expect([nativeReasonFailure(first), nativeReasonFailure(second)]).toEqual(["json-syntax", "json-syntax"]);
    expect(sameNativeSceneResponseRoute(first, second)).toBe(true);
    expect(sameNativeSceneResponseRoute(first, third)).toBe(true);
    expect(sameNativeSceneResponseRoute(second, third)).toBe(true);
    expect(sameNativeSceneResponseRoute(first, first)).toBe(false);
    expect(transport).toHaveBeenCalledTimes(3);
    third.content = "{}";
    expect(nativeSceneResponseRouteCurrent(third)).toBe(false);
    expect(sameNativeSceneResponseRoute(first, third)).toBe(false);
  });

  it.each(["response-id", "request", "schema", "engine"] as const)("rejects pair with shared identity or changed route (%s)", async (variant) => {
    const { engine, transport } = engineFor(responsesWire('{"sceneCount":3}', { id: "scene-first" }));
    const first = await engine.reason("完整原始输入", { ...options, forceJson: true });
    const secondWire = responsesWire('{"sceneCount":4}', { id: variant === "response-id" ? "scene-first" : "scene-second" });
    transport.mockResolvedValueOnce(new Response(secondWire));
    const selectedEngine = variant === "engine" ? engineFor(secondWire).engine : engine;
    const nextSchema = variant === "schema" ? { ...schema, title: "different schema" } : schema;
    const second = await selectedEngine.reason(variant === "request" ? "完整原始输入" : "完整原始输入＋纠正", {
      ...options, responsesJsonSchema: { name: sceneName, schema: nextSchema }, forceJson: true,
    });
    expect(nativeSceneResponseRouteCurrent(first)).toBe(true);
    expect(nativeSceneResponseRouteCurrent(second)).toBe(true);
    expect(sameNativeSceneResponseRoute(first, second)).toBe(false);
  });

  it("invalidates only the new route proof when a previously measured transport or router changes", async () => {
    const { engine, cfg } = engineFor(responsesWire('{"sceneCount":3}'));
    const first = await engine.reasonStructured("场景", schema, options);
    expect(nativeSceneResponseRouteCurrent(first)).toBe(true);
    cfg.apiKey = "changed-after-response";
    expect(nativeSceneResponseRouteCurrent(first)).toBe(false);
    expect(nativeSceneResponseSource(first)?.rawText).toBe('{"sceneCount":3}');
    const second = await engine.reasonStructured("另一场景", schema, options);
    expect(nativeSceneResponseRouteCurrent(second)).toBe(true);
    const provider = new OpenAiCompatibleProvider("deepseek-flash", cfg);
    const sink: EventSink = { recordModelTrace: async () => undefined, recordDegradation: async () => undefined,
      recordCircuitBreak: async () => undefined };
    engine.attachRouter({ providers: new Map([[provider.modelId, provider]]), sink });
    expect(nativeSceneResponseRouteCurrent(second)).toBe(false);
    expect(nativeSceneResponseSource(second)).toBeDefined();
  });
});

const riskOptions = { responsesJsonSchema: riskResponsesJsonSchema };
const riskText = '{"technicalRisks":[{"risk":"入弯交叉","level":"high","impact":"超越顺序不清"}],"businessConstraints":["保持三个硬切"],"mitigationSuggestions":["在同镜保留对手位置"]}';
const riskFormat = { type: "json_schema", ...riskResponsesJsonSchema };
const riskWire = (raw: string, changes: Record<string, unknown> = {}) => responsesWire(raw, {
  text: { format: riskFormat }, reasoning: { effort: "high" }, max_output_tokens: 393216, ...changes,
});

describe("native Risk Responses text evidence", () => {
  it("pins only the exact closed native Risk schema and inspects no getters", () => {
    expect(isRiskResponsesJsonSchema({ schema: structuredClone(riskResponsesJsonSchema.schema), name: riskResponsesJsonSchema.name })).toBe(true);
    expect(isRiskResponsesJsonSchema({ ...riskResponsesJsonSchema, extra: true })).toBe(false);
    expect(isRiskResponsesJsonSchema({ ...riskResponsesJsonSchema, schema: { ...riskResponsesJsonSchema.schema, additionalProperties: true } })).toBe(false);
    expect(isRiskResponsesJsonSchema(new Proxy(riskResponsesJsonSchema, {}))).toBe(false);
    const get = vi.fn(() => riskResponsesJsonSchema.schema);
    expect(isRiskResponsesJsonSchema({ name: riskResponsesJsonSchema.name, get schema() { return get(); } })).toBe(false);
    expect(get).not.toHaveBeenCalled();
    expect(() => (riskResponsesJsonSchema.schema.required as string[]).push("unsafe")).toThrow();
  });

  it("records exact measured raw text, schema and request/response bytes, separate from Scene provenance", async () => {
    const raw = ` \n${riskText}\t `;
    const body = riskWire(raw);
    const { engine, transport } = engineFor(body);
    const result = await engine.reasonStructured("完整当前场景与冻结要求", riskResponsesJsonSchema.schema, riskOptions);
    expect(result).toMatchObject({ success: true, content: riskText, data: JSON.parse(riskText) });
    const [endpoint, init] = transport.mock.calls[0]!;
    expect(endpoint).toBe(`${baseUrl}/responses`);
    expect(JSON.parse(String(init!.body))).toMatchObject({ model: "deepseek-flash", reasoning: { effort: "high" }, max_output_tokens: 393216,
      stream: false, text: { format: riskFormat } });
    expect(nativeRiskResponseSource(result)).toEqual({ rawText: raw, requestSha256: sha256(String(init!.body)), responseSha256: sha256(body),
      schemaSha256: sha256(JSON.stringify(riskResponsesJsonSchema.schema)) });
    expect(nativeRiskResponseRouteCurrent(result)).toBe(true);
    expect(nativeRiskResponseSource({ ...result })).toBeUndefined();
    expect(nativeSceneResponseSource(result)).toBeUndefined();
    expect(nativeSceneResponseRouteCurrent(result)).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["unstructured echo", { text: { format: { type: "json_object" } } }],
    ["name-only echo", { text: { format: { type: "json_schema", name: riskResponsesJsonSchema.name } } }],
    ["changed schema echo", { text: { format: { ...riskFormat, schema: { type: "object" } } } }],
    ["changed effort echo", { reasoning: { effort: "low" } }],
    ["changed ceiling echo", { max_output_tokens: 1024 }],
    ["incomplete", { status: "incomplete" }],
    ["unmeasured", { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 4 } }],
  ])("does not attest %s", async (_label, change) => {
    try {
      const { engine, transport } = engineFor(riskWire(riskText, change));
      const result = await engine.reasonStructured("风险", riskResponsesJsonSchema.schema, riskOptions);
      expect(nativeRiskResponseSource(result)).toBeUndefined();
      expect(nativeRiskResponseRouteCurrent(result)).toBe(false);
      expect(transport).toHaveBeenCalledTimes(1);
    } finally { resetCircuit("video.preproduction.plan"); }
  });

  it("rejects a loosened Risk request before transport", async () => {
    try {
      const { engine, transport } = engineFor(riskWire(riskText));
      const result = await engine.reasonStructured("风险", riskResponsesJsonSchema.schema, {
        responsesJsonSchema: { ...riskResponsesJsonSchema, schema: { ...riskResponsesJsonSchema.schema, additionalProperties: true } },
      });
      expect(result.success).toBe(false);
      expect(nativeRiskResponseSource(result)).toBeUndefined();
      expect(transport).not.toHaveBeenCalled();
    } finally { resetCircuit("video.preproduction.plan"); }
  });

  it.each(["distinct", "response-id", "request", "system", "engine"] as const)("pairs only fresh measured results on one unchanged Risk route (%s)", async variant => {
    const firstBody = riskWire('{"technicalRisks":', { id: "risk-original" });
    const secondBody = riskWire(riskText, { id: variant === "response-id" ? "risk-original" : "risk-correction" });
    const { engine, transport, cfg } = engineFor(firstBody);
    transport.mockResolvedValueOnce(new Response(firstBody)).mockResolvedValueOnce(new Response(secondBody));
    const first = await engine.reasonStructured("完整原始风险输入", riskResponsesJsonSchema.schema, riskOptions);
    const selected = variant === "engine" ? engineFor(secondBody).engine : engine;
    const second = await selected.reasonStructured(variant === "request" ? "完整原始风险输入" : "完整原始风险输入＋一次纠正", riskResponsesJsonSchema.schema,
      variant === "system" ? { ...riskOptions, systemPrompt: "变更的系统指令" } : riskOptions);
    expect(first.success).toBe(false);
    expect(nativeReasonFailure(first)).toBe("json-syntax");
    expect(nativeRiskResponseSource(first)?.rawText).toBe('{"technicalRisks":');
    expect(nativeRiskResponseRouteCurrent(first)).toBe(true);
    expect(nativeRiskResponseRouteCurrent(second)).toBe(true);
    expect(sameNativeRiskResponseRoute(first, second)).toBe(variant === "distinct");
    expect(sameNativeSceneResponseRoute(first, second)).toBe(false);
    cfg.apiKey = "changed-after-response";
    expect(nativeRiskResponseRouteCurrent(first)).toBe(false);
  });
});
