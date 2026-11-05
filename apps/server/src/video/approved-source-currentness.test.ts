/** Native semantic reviewer/one repair and real adapter receipts, with only HTTP completion bodies replaced. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkloomLLMEngine, promptFieldPolicy, SHOT_FIELD_SCHEMA_V2, type PromptCompileOptions } from "@hyperreality/video-studio";
import { DEFAULT_MODEL_POLICY, OpenAiCompatibleProvider, resetCircuit } from "@workloom/base/model-router";
import { createLlmSemanticQualityReviewer, evaluatePromptPackage, SEMANTIC_QUALITY_CHECK_IDS } from "./prompt-quality-gate.js";

const fields: Record<string, string> = Object.fromEntries(promptFieldPolicy(SHOT_FIELD_SCHEMA_V2, false).fields.map(field => [field.key, `完整${field.label}字段原文，保留合成人物与场景。`]));
Object.assign(fields, { portraits: "NONE", constraint: "9:16画幅，1080p分辨率，30fps，MP4格式", dialogue: "无台词。", timeline: "T00:00至T00:10，合成人物完整观察。" });
const compile: PromptCompileOptions = { delivery: { aspectRatio: "9:16", resolution: "1080p", fps: 30, format: "mp4", generateAudio: true }, assets: [],
  model: { modelId: "fixture-video", provider: "fixture", providerModel: "fixture", version: "fixture/v1", modes: ["t2v"],
    durationSec: { min: 1, max: 20 }, aspectRatios: ["9:16"], resolutions: ["1080p"], maxReferenceImages: 4, maxPromptChars: 10_000 } };
function review(fail = false, repaired = false) {
  return { shotId: "opening", checks: SEMANTIC_QUALITY_CHECK_IDS.map(id => {
    const field = id === "SQ1_SUBJECT_ACTION" ? "action" : id === "SQ2_SCENE_PROPS" ? "scene" : id === "SQ3_CAMERA_FEASIBLE" ? "camera_movement" : id === "SQ4_LIGHT_COLOR" ? "lighting" : "director_instruction";
    return { id, field, pass: !(fail && id === "SQ3_CAMERA_FEASIBLE"),
      evidence: repaired && id === "SQ3_CAMERA_FEASIBLE" ? "固定机位完整看清合成人物观察商品。" : fields[field],
      ...(fail && id === "SQ3_CAMERA_FEASIBLE" ? { failureCode: "FIXTURE_CAMERA_CONFLICT", repair: "只修复运镜，完整落实原动作。" } : {}) };
  }) };
}
function fixture(responses: unknown[], invalidAt?: { boundary: "before" | "after"; dispatch: number }) {
  const requests: unknown[] = [], traces: unknown[] = [];
  let verifierCalls = 0;
  const verify = vi.fn(async () => {
    verifierCalls++;
    const next = requests.length + 1;
    if (invalidAt && ((invalidAt.boundary === "before" && next === invalidAt.dispatch && verifierCalls % 2 === 1)
      || (invalidAt.boundary === "after" && requests.length === invalidAt.dispatch && verifierCalls % 2 === 0))) throw new Error("SOURCE_OR_TTL_CHANGED");
  });
  const fetchImpl: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const data = responses[requests.length - 1];
    if (data === undefined) throw new Error("OFFLINE_UNEXPECTED_MODEL_CALL");
    return Response.json({ id: `offline-currentness-${requests.length}`, object: "chat.completion", model: "deepseek-flash",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: typeof data === "string" ? data : JSON.stringify(data) } }],
      usage: { prompt_tokens: 600, completion_tokens: 100, total_tokens: 700 } });
  };
  const config = { baseUrl: "http://offline-currentness.invalid/v1", apiKey: "offline-only", fetchImpl };
  const engine = new WorkloomLLMEngine({ ...config, model: "deepseek-flash" });
  const provider = new OpenAiCompatibleProvider("deepseek-flash", config);
  engine.attachRouter({ providers: new Map([[provider.modelId, provider]]), forceModel: provider.modelId, policy: structuredClone(DEFAULT_MODEL_POLICY),
    sink: { recordModelTrace: async trace => { traces.push(trace); }, recordDegradation: async () => undefined, recordCircuitBreak: async () => undefined } });
  const run = () => evaluatePromptPackage({ mode: "enforce", projectId: "P1", runId: "RUN-target", stageRunId: "RUN-target:g6", revision: 2,
    shots: [{ source: { shotId: "opening", duration: 10, fields: structuredClone(fields) }, compile }],
    reviewer: createLlmSemanticQualityReviewer(engine, verify) });
  return { run, requests, verify, traces };
}
afterEach(() => { resetCircuit("preproduction"); vi.restoreAllMocks(); });
describe("approved source checks at every native semantic dispatch", () => {
  it("retains the original one-review success path and measured route receipt", async () => {
    const f = fixture([review()]), result = await f.run();
    expect(result.g6Eligible).toBe(true);
    expect(f.requests).toHaveLength(1);
    expect(f.verify).toHaveBeenCalledTimes(2);
    expect(f.traces).toHaveLength(1);
  });
  it.each(["before", "after"] as const)("blocks changed source %s the first review", async boundary => {
    const f = fixture([review()], { boundary, dispatch: 1 }), result = await f.run();
    expect(result.g6Eligible).toBe(false);
    expect(f.requests).toHaveLength(boundary === "before" ? 0 : 1);
    expect(f.traces).toHaveLength(f.requests.length);
  });
  it.each(["before", "after"] as const)("rechecks source %s the existing native JSON correction and never adds another attempt", async boundary => {
    const f = fixture(["{", review()], { boundary, dispatch: 2 }), result = await f.run();
    expect(result.g6Eligible).toBe(false);
    expect(f.requests).toHaveLength(boundary === "before" ? 1 : 2);
    expect(f.traces).toHaveLength(f.requests.length);
    expect(result.repairAttempt).toBeUndefined();
  });
  it("keeps the native technical correction at two calls when source remains current", async () => {
    const f = fixture(["{", review()]), result = await f.run();
    expect(result.g6Eligible).toBe(true);
    expect(f.requests).toHaveLength(2);
    expect(f.verify).toHaveBeenCalledTimes(4);
  });
  it.each(["before", "after"] as const)("rechecks source %s the sole native semantic field repair", async boundary => {
    const f = fixture([review(true), { changes: [{ field: "camera_movement", value: "固定机位完整看清合成人物观察商品。", reason: "落实原动作" }] }, review(false, true)], { boundary, dispatch: 2 });
    const result = await f.run();
    expect(result.g6Eligible).toBe(false);
    expect(f.requests).toHaveLength(boundary === "before" ? 1 : 2);
    expect(f.traces).toHaveLength(f.requests.length);
    expect(result.repairAttempt?.status).toBe("stalled");
    expect(result.repairAttempt?.reason).toBe("SOURCE_OR_TTL_CHANGED");
  });
  it.each(["before", "after"] as const)("rechecks source %s the complete post-repair review", async boundary => {
    const f = fixture([review(true), { changes: [{ field: "camera_movement", value: "固定机位完整看清合成人物观察商品。", reason: "落实原动作" }] }, review(false, true)], { boundary, dispatch: 3 });
    const result = await f.run();
    expect(result.g6Eligible).toBe(false);
    expect(f.requests).toHaveLength(boundary === "before" ? 2 : 3);
    expect(f.traces).toHaveLength(f.requests.length);
  });
  it("retains exactly one semantic repair plus full rereview when source remains current", async () => {
    const f = fixture([review(true), { changes: [{ field: "camera_movement", value: "固定机位完整看清合成人物观察商品。", reason: "落实原动作" }] }, review(false, true)]), result = await f.run();
    expect(result.g6Eligible).toBe(true);
    expect(f.requests).toHaveLength(3);
    expect(f.verify).toHaveBeenCalledTimes(6);
    expect(result.repairAttempt?.attempt).toBe(1);
  });
});
