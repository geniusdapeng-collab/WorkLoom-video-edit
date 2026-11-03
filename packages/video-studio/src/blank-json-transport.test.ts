import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MODEL_POLICY, ModelProviderError, OpenAiCompatibleProvider, resetCircuit, routeSmart, type EventSink,
} from "@workloom/base/model-router";
import * as adapterApi from "./llm-adapter.js";

const model = "deepseek-flash";
const baseUrl = "https://blank-json-fixture.invalid/v1";
const scene = "blank-json-transport-fixture";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const blank = (content: unknown = "   ") => ({
  id: "blank-json-fixture-response", object: "chat.completion", model,
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
  usage: { prompt_tokens: 132765, completion_tokens: 4779, total_tokens: 137544,
    completion_tokens_details: { reasoning_tokens: 4740 } },
});

function setup(value: unknown, format: "json_object" | "text" = "json_object", origin = baseUrl) {
  const serialized = JSON.stringify(value);
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(serialized));
  const transport = { baseUrl: origin, apiKey: "test-only", fetchImpl };
  const provider = new OpenAiCompatibleProvider(model, transport);
  const providers = new Map([[model, provider]]);
  const policy = structuredClone(DEFAULT_MODEL_POLICY);
  policy.scenes[scene] = { tier: "L2", responseFormat: format, thinking: { type: "enabled", effort: "high" } };
  const sink: EventSink = { recordModelTrace: vi.fn(async () => undefined), recordDegradation: vi.fn(async () => undefined),
    recordCircuitBreak: vi.fn(async () => undefined) };
  const adapter = new adapterApi.WorkloomLLMEngine({
    baseUrl: origin, model, apiKey: "test-only", router: { providers, sink, policy, forceModel: model },
  });
  return { adapter, fetchImpl, provider, providers, policy, sink, serialized, transport };
}

const proof = (result: unknown) => {
  const read = (adapterApi as unknown as { nativeReasonBlankJson?: (value: unknown) => unknown }).nativeReasonBlankJson;
  return read?.(result);
};
const structured = (adapter: adapterApi.WorkloomLLMEngine) => adapter.reasonStructured(
  "按既定字段给出一个完整 JSON", { required: ["shots"] }, { scene },
);

beforeEach(() => resetCircuit(scene));

describe("native completed blank JSON is an exact failure receipt", () => {
  it.each(["", "    "])("attests raw ASCII blank %j through one native Chat POST without a success", async content => {
    const sample = setup(blank(content));
    const result = await structured(sample.adapter);
    expect(result).toEqual({ success: false, error: "模型返回 content 为空", retryable: false });
    expect(adapterApi.nativeReasonCompleted(result)).toBe(false);
    expect(adapterApi.nativeReasonFailure(result)).toBe("unavailable");
    expect(sample.fetchImpl).toHaveBeenCalledTimes(1);
    const [endpoint, init] = sample.fetchImpl.mock.calls[0]!;
    expect(endpoint).toBe(`${baseUrl}/chat/completions`);
    const wire = JSON.parse(String(init?.body));
    expect(wire).toMatchObject({ model, response_format: { type: "json_object" } });
    expect(wire.stream ?? false).toBe(false);
    const receipt = proof(result);
    expect(receipt).toEqual({ modelId: model, responseId: "blank-json-fixture-response",
      requestHash: hash(String(init?.body)), responseHash: hash(sample.serialized),
      promptTokens: 132765, completionTokens: 4779, reasoningTokens: 4740 });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(proof({ ...result, receipt })).toBeUndefined();
    expect(sample.sink.recordModelTrace).not.toHaveBeenCalled();
    expect(sample.sink.recordDegradation).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["null content", blank(null)],
    ["non-ASCII whitespace", blank("　")],
    ["tab", blank("\t")],
    ["newline", blank(" \n")],
    ["array content", blank([{ type: "text", text: "" }])],
    ["wrong model", { ...blank(), model: "different" }],
    ["missing id", { ...blank(), id: " " }],
    ["chunk instead of chat completion", { ...blank(), object: "chat.completion.chunk" }],
    ["extra choice", { ...blank(), choices: [...blank().choices, ...blank().choices] }],
    ["wrong finish", { ...blank(), choices: [{ ...blank().choices[0], finish_reason: "length" }] }],
    ["wrong role", { ...blank(), choices: [{ ...blank().choices[0], message: { role: "tool", content: " " } }] }],
    ["refusal", { ...blank(), choices: [{ ...blank().choices[0], message: { ...blank().choices[0]!.message, refusal: "refused" } }] }],
    ["tool call", { ...blank(), choices: [{ ...blank().choices[0], message: { ...blank().choices[0]!.message, tool_calls: [{ id: "foreign" }] } }] }],
    ["missing usage", { ...blank(), usage: undefined }],
    ["wrong token sum", { ...blank(), usage: { ...blank().usage, total_tokens: 1 } }],
    ["wrong reasoning details", { ...blank(), usage: { ...blank().usage, completion_tokens_details: "wrong" } }],
    ["wrong reasoning count", { ...blank(), usage: { ...blank().usage, completion_tokens_details: { reasoning_tokens: 9999 } } }],
  ])("withholds proof for %s", async (_label, payload) => {
    const sample = setup(payload);
    const result = await structured(sample.adapter);
    expect(result.success).toBe(false);
    expect(proof(result)).toBeUndefined();
    expect(sample.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps blank text-mode and native Responses JSON Schema failures unclassified", async () => {
    const text = setup(blank(), "text");
    expect(proof(await structured(text.adapter))).toBeUndefined();
    const textWire = JSON.parse(String(text.fetchImpl.mock.calls[0]![1]?.body));
    expect(textWire.response_format).toBeUndefined();
    const responses = setup({
      id: "fixture-responses-blank", object: "response", model, status: "completed",
      output: [{ type: "message", role: "assistant", phase: "final_answer", status: "completed",
        content: [{ type: "output_text", text: "  " }] }],
      usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
    });
    const result = await responses.adapter.reasonStructured("严格给出 JSON", { expected: "data" }, {
      scene, responsesJsonSchema: { name: "blank_fixture", schema: { type: "object" } },
    });
    expect(result.success).toBe(false);
    expect(proof(result)).toBeUndefined();
    expect(responses.fetchImpl.mock.calls[0]![0]).toBe(`${baseUrl}/responses`);
  });

  it("keeps forged errors and unknown provider state unclassified", async () => {
    const sample = setup(blank());
    const fake = new ModelProviderError("模型返回 content 为空", "empty", { retryable: false,
      receipt: { requestHash: "a".repeat(64), responseHash: "b".repeat(64), responseId: "fixture-fake",
        modelId: model, promptTokens: 132765, completionTokens: 4779, finishReason: "stop" } });
    vi.spyOn(sample.provider, "chat").mockRejectedValueOnce(fake);
    const result = await structured(sample.adapter);
    expect(proof(result)).toBeUndefined();
    expect(sample.fetchImpl).not.toHaveBeenCalled();
    sample.fetchImpl.mockRejectedValueOnce(new TypeError("fixture lost response"));
    expect(proof(await structured(sample.adapter))).toBeUndefined();
    expect(sample.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not mistake a query string suffix for the exact Chat path", async () => {
    const sample = setup(blank(), "json_object", `${baseUrl}/wrong?target=`);
    expect(proof(await structured(sample.adapter))).toBeUndefined();
    const [target] = sample.fetchImpl.mock.calls[0]!;
    expect(new URL(String(target)).pathname).toBe("/v1/wrong");
  });

  it("requires the exact current provider transport after receipt readback", async () => {
    const sample = setup(blank());
    sample.fetchImpl.mockImplementationOnce(async () => {
      sample.transport.apiKey = "changed-fixture-auth";
      return new Response(sample.serialized);
    });
    const result = await structured(sample.adapter);
    expect(result).toEqual({ success: false, error: "模型返回 content 为空", retryable: false });
    expect(proof(result)).toBeUndefined();
    expect(sample.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retains public unavailable routing and the existing failed-circuit behavior", async () => {
    const sample = setup(blank());
    const result = await routeSmart({ action: scene, scene, forceModel: model, messages: [{ role: "user", content: "JSON" }] },
      sample.providers, sample.sink, { policy: sample.policy });
    expect(result).toMatchObject({ kind: "unavailable", failure: { kind: "empty", retryable: false } });
    expect(result).not.toHaveProperty("providerResult");
    expect(sample.fetchImpl).toHaveBeenCalledTimes(1);
  });
});
