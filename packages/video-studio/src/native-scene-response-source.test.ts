import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleProvider, resetCircuit, type EventSink } from "@workloom/base/model-router";
import { nativeReasonCompleted, nativeReasonFailure, nativeSceneResponseSource, WorkloomLLMEngine } from "./llm-adapter.js";

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
    expect(receipt).toEqual({
      rawText, requestSha256: sha256(String(transport.mock.calls[0]?.[1]?.body)), responseSha256: sha256(body),
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(nativeSceneResponseSource({ ...result, source: receipt })).toBeUndefined();
    expect(nativeSceneResponseSource(structuredClone(result))).toBeUndefined();
    expect(nativeSceneResponseSource(new Proxy(result, {}))).toBeUndefined();
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
    expect(nativeSceneResponseSource({ success: false, error: "JSON 解析失败", rawText: "{}" })).toBeUndefined();
  });
});
