import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { circuitSnapshot, resetCircuit, routeSmart, type EventSink, type SmartTask } from "./router.js";
import { DEFAULT_MODEL_POLICY } from "./policy.js";
import type { ChatOptions, ModelProvider } from "./providers.js";

beforeEach(() => resetCircuit());
afterEach(() => resetCircuit());
const now = new Date("2026-10-24T12:00:00+08:00");
function fixture(fail = 0) {
  const calls: Array<{ model: string; options?: ChatOptions }> = [], traces: unknown[] = [], degrades: unknown[] = [], breaks: unknown[] = [];
  const providers = new Map<string, ModelProvider>(["deepseek-v4-pro", "glm-5.2", "minimax-m3"].map(modelId => [modelId, {
    modelId, healthy: async () => true, chat: async (_messages, options) => {
      calls.push({ model: modelId, options });
      if (calls.length <= fail) throw new Error(`failure-${calls.length}`);
      return { text: "metered answer", promptTokens: 1500, completionTokens: 500 };
    },
  }]));
  const sink: EventSink = { recordModelTrace: async t => { traces.push(t); }, recordDegradation: async d => { degrades.push(d); }, recordCircuitBreak: async d => { breaks.push(d); } };
  const task: SmartTask = { action: "options-test", scene: "options-test", forceTier: "L2", messages: [{ role: "user", content: "text" }],
    generation: { temperature: 0, topP: 0.8, maxTokens: 8192, responseFormat: { type: "json_object" }, thinking: { type: "disabled" } } };
  return { calls, traces, degrades, breaks, providers, sink, task };
}
describe("generation forwarding preserves routeSmart controls", () => {
  it("retains all options through fallback while metering only the successful provider", async () => {
    const f = fixture(1), controller = new AbortController();
    f.task.signal = controller.signal; f.task.timeoutMs = 180_000;
    const result = await routeSmart(f.task, f.providers, f.sink, {}, now);
    expect(result).toMatchObject({ kind: "answered", modelTrace: { model_id: "glm-5.2", credits: 2, tier: "L2" } });
    expect(f.calls.map(call => call.options)).toEqual(Array.from({ length: 2 }, () => ({ ...f.task.generation, signal: controller.signal, timeoutMs: 180_000 })));
    expect(f.degrades).toEqual([{ from: "deepseek-v4-pro", to: "glm-5.2", reason: "failure-1", action: "options-test" }]);
    expect(f.traces).toHaveLength(1); expect(f.traces[0]).toMatchObject({ scene: "options-test", bill_to: "tenant", credits: 2 });
    expect(circuitSnapshot("options-test")).toBeUndefined();
  });
  it("keeps scene timeout defaults and prevents generation from overriding cancellation or timeout", async () => {
    const f = fixture(), controller = new AbortController();
    f.task.signal = controller.signal;
    Object.assign(f.task.generation!, { timeoutMs: 1, signal: AbortSignal.abort() });
    expect((await routeSmart(f.task, f.providers, f.sink, {}, now)).kind).toBe("answered");
    expect(f.calls[0]?.options).toMatchObject({ timeoutMs: 60_000, signal: controller.signal });
  });
  it("does not call providers after an existing budget limit", async () => {
    const f = fixture(); f.task.creditsUsedSoFar = 500;
    expect(await routeSmart(f.task, f.providers, f.sink, {}, now)).toMatchObject({ kind: "circuit_broken" });
    expect(f.calls).toHaveLength(0); expect(f.traces).toHaveLength(0);
    expect(f.breaks).toEqual([{ action: "options-test", creditsUsed: 500, limit: 500 }]);
  });
  it("retains already paid output and measured credits when this call crosses the budget", async () => {
    const f = fixture(); f.task.creditsUsedSoFar = 499;
    expect(await routeSmart(f.task, f.providers, f.sink, {}, now)).toMatchObject({ kind: "circuit_broken", text: "metered answer", budgetExceeded: true, modelTrace: { credits: 2 } });
    expect(f.calls).toHaveLength(1); expect(f.traces).toHaveLength(1);
    expect(f.breaks).toEqual([{ action: "options-test", creditsUsed: 501, limit: 500 }]);
  });
  it("keeps the three-failure circuit and avoids a fourth provider call during cooldown", async () => {
    const f = fixture(3);
    expect((await routeSmart(f.task, f.providers, f.sink)).kind).toBe("unavailable");
    expect(f.calls).toHaveLength(3); expect(f.degrades).toHaveLength(3); expect(f.traces).toHaveLength(0);
    expect(circuitSnapshot("options-test")).toMatchObject({ failures: 3 });
    expect((await routeSmart(f.task, f.providers, f.sink)).degraded).toEqual([{ from: "options-test", to: null, reason: "circuit-open" }]);
    expect(f.calls).toHaveLength(3);
  });
  it("retains memory reuse as a zero-call, zero-credit path", async () => {
    const f = fixture(); f.task.memoryLookup = async () => ({ reusable: true, answer: "cached", memoryId: "memory" });
    expect(await routeSmart(f.task, f.providers, f.sink, {}, now)).toMatchObject({ kind: "reused", text: "cached", reusedMemoryId: "memory" });
    expect(f.calls).toHaveLength(0); expect(f.traces[0]).toMatchObject({ credits: 0, reused: true, bill_to: "tenant" });
  });
  it("retains platform cost isolation from the scene policy", async () => {
    const f = fixture();
    const policy = { ...DEFAULT_MODEL_POLICY, scenes: { ...DEFAULT_MODEL_POLICY.scenes, "options-test": { tier: "L2" as const, billTo: "platform" as const } } };
    expect(await routeSmart(f.task, f.providers, f.sink, { policy }, now)).toMatchObject({ billTo: "platform" });
    expect(f.traces[0]).toMatchObject({ bill_to: "platform", scene: "options-test", credits: 2 });
  });
  it("stops an already aborted request before probing or calling any of three healthy providers", async () => {
    const f = fixture(); f.task.signal = AbortSignal.abort();
    expect(await routeSmart(f.task, f.providers, f.sink)).toMatchObject({ kind: "unavailable", degraded: [{ reason: "模型调用已取消（调用方 abort）" }] });
    expect(f.calls).toHaveLength(0); expect(f.traces).toHaveLength(0); expect(f.breaks).toHaveLength(0);
    expect(circuitSnapshot("options-test")).toBeUndefined();
    delete f.task.signal;
    expect((await routeSmart(f.task, f.providers, f.sink)).kind).toBe("answered");
  });
  it("does not fallback or count caller abort as an outage, so the next request remains usable", async () => {
    const f = fixture(), controller = new AbortController(); f.task.signal = controller.signal;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    let calls = 0;
    const providers = new Map<string, ModelProvider>(["deepseek-v4-pro", "glm-5.2", "minimax-m3"].map(modelId => [modelId, {
      modelId, healthy: async () => true, chat: async (_messages, options) => {
        calls++; markStarted();
        return new Promise((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(new Error("caller abort")), { once: true }));
      },
    }]));
    const pending = routeSmart(f.task, providers, f.sink);
    await started; controller.abort();
    expect(await pending).toMatchObject({ kind: "unavailable" });
    expect(calls).toBe(1); expect(f.traces).toHaveLength(0); expect(f.breaks).toHaveLength(0);
    expect(circuitSnapshot("options-test")).toBeUndefined();
    delete f.task.signal;
    expect((await routeSmart(f.task, f.providers, f.sink)).kind).toBe("answered");
  });
});
