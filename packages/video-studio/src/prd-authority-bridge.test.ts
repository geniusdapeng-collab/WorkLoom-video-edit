import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleProvider, resetCircuit, type ChatMessage, type ChatOptions, type ModelProvider } from "@workloom/base/model-router";
import { bindRequirementContract, requirementCast, requirementHash, requirementRecord, type RequirementContract, type RequirementRecord } from "./requirement-contract.js";
import { effectivePrdModelSchema, prdAuthorityPrompt, prdContractExecutionView, preparePrdAuthority } from "./prd-authority.js";
import { assertPrdAuthorityBridge, bindApprovedPrdPortraitSelection, installPrdAuthorityBridge, installPrdProductionBridge, productionModelInput, withPrdAuthorityScope } from "./prd-authority-bridge.js";
import { WorkloomLLMEngine } from "./llm-adapter.js";
import { readPortraitArtifact } from "./character-archive.js";
import { preparePrdPortraitReferenceSelection, type PrdPortraitSource } from "./prd-portrait-source.js";
import { digest, PRDGenerator, PRDSchema, prdFixture } from "./prd-authority.test-support.js";

const fixtures: ReturnType<typeof prdFixture>[] = [];
const disposers: Array<() => void> = [];
type NativeConstructor = { new (options?: RequirementRecord): RequirementRecord; prototype: RequirementRecord };
const nativeRequire = createRequire(import.meta.url);
const nativeStandardizer = nativeRequire("../../../vendor/supermickey/hyperreality-system/engines/field-standardizer.js") as Pick<Parameters<typeof installPrdProductionBridge>[0], "standardizeShot" | "validateShot"> & {
  CRITICAL_FIELDS: Parameters<typeof installPrdProductionBridge>[0]["fields"];
};
const { FieldContentRefiner } = nativeRequire("../../../vendor/supermickey/hyperreality-system/engines/production-engine/agents/field-content-refiner.js") as { FieldContentRefiner: NativeConstructor };
const { CharacterCostumePrompter } = nativeRequire("../../../vendor/supermickey/hyperreality-system/engines/character-system/character-costume-prompter.js") as { CharacterCostumePrompter: NativeConstructor };
const { FieldGuard } = nativeRequire("../../../vendor/supermickey/hyperreality-system/engines/field-guard.js") as { FieldGuard: NativeConstructor };
const { QualityGate } = nativeRequire("../../../vendor/supermickey/hyperreality-system/engines/production-engine/utils/quality-gate.js") as { QualityGate: NativeConstructor };
const { BaseAgent } = nativeRequire("../../../vendor/supermickey/hyperreality-system/engines/production-engine/agents/base-agent.js") as { BaseAgent: NativeConstructor };
const { globalLLMLimiter } = nativeRequire("../../../vendor/supermickey/hyperreality-system/core/llm-concurrency-limiter.js") as {
  globalLLMLimiter: NonNullable<Parameters<typeof installPrdProductionBridge>[0]["structuredAgent"]>["limiter"];
};
const { PromptFusionAgent } = nativeRequire("../../../vendor/supermickey/hyperreality-system/engines/production-engine/agents/prompt-fusion-agent.js") as { PromptFusionAgent: NativeConstructor };
const { FieldConsistencyChecker } = nativeRequire("../../../vendor/supermickey/hyperreality-system/engines/field-consistency-checker.js") as { FieldConsistencyChecker: NativeConstructor };
const { PromptDeliveryGuard } = nativeRequire("../../../vendor/supermickey/hyperreality-system/engines/production-engine/agents/prompt-delivery-guard.js") as { PromptDeliveryGuard: NativeConstructor };
const { SemanticRefinementPass } = nativeRequire("../../../vendor/supermickey/hyperreality-system/engines/production-engine/agents/semantic-refinement-pass.js") as { SemanticRefinementPass: NativeConstructor };
const { FieldQualityPipeline } = nativeRequire("../../../vendor/supermickey/hyperreality-system/engines/field-quality/field-quality-pipeline.js") as { FieldQualityPipeline: NativeConstructor };
const { RuleRepairer, LLMRepairer, PRD, FieldRepairAgent } = nativeRequire("../../../vendor/supermickey/hyperreality-system/engines/field-quality/field-repair-agent.js") as {
  RuleRepairer: NativeConstructor; LLMRepairer: NativeConstructor; PRD: NativeConstructor; FieldRepairAgent: NativeConstructor;
};
const { extractJson: extractFieldRepairJson } = nativeRequire("../../../vendor/supermickey/hyperreality-system/engines/field-quality/json-salvage.js") as {
  extractJson: (content: string) => unknown;
};
const { IssueType, RuleChecker } = nativeRequire("../../../vendor/supermickey/hyperreality-system/engines/field-quality/field-check-agent.js") as {
  IssueType: Record<string, string>; RuleChecker: NativeConstructor;
};
const nativeConstraint = FieldContentRefiner.prototype._normalizeConstraint as (this: RequirementRecord, ...args: unknown[]) => unknown;
const nativeQuality = QualityGate.prototype.run as (this: RequirementRecord, ...args: unknown[]) => unknown;
const nativeDelivery = PromptDeliveryGuard.prototype.verify as (this: RequirementRecord, ...args: unknown[]) => unknown;
const nativeSemantic = SemanticRefinementPass.prototype._buildPrompt as (this: RequirementRecord, ...args: unknown[]) => unknown;
let expectedFetchCalls = 0;
function fixture(...args: Parameters<typeof prdFixture>) { const value = prdFixture(...args); fixtures.push(value); return value; }
function invoke(owner: RequirementRecord, key: string, ...args: unknown[]): unknown {
  return Reflect.apply(owner[key] as (...args: unknown[]) => unknown, owner, args);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function schemaFromPrompt(prompt: string, kind: "creative" | "production"): RequirementRecord {
  // The exact heading can also be quoted in the customer's original text, now
  // repeated verbatim at the planning tail. Only a complete owned schema block
  // counts; a quotation must neither hide it nor manufacture a second block.
  const encoded = prompt.split(`\n\n## 本次宿主 PRD ${kind} 响应 JSON Schema（`).slice(1)
    .flatMap(piece => {
      const match = piece.match(/^[a-f0-9]{64}）\n本次实际模型响应必须符合[^\n]*\n```json\n([^\n]+)\n```\n/);
      return match ? [match[1]!] : [];
    });
  expect(encoded).toHaveLength(1);
  return JSON.parse(encoded[0]!) as RequirementRecord;
}
function authorityFromMarkdown(markdown: string): RequirementRecord {
  const pieces = markdown.split("\n\n## 宿主本次权威生产与交付要求\n\n```json\n");
  expect(pieces).toHaveLength(2);
  return JSON.parse(pieces[1]!.split("\n```\n")[0]!) as RequirementRecord;
}
function planningFromMarkdown(markdown: string): RequirementRecord {
  const pieces = markdown.split("\n## 本次 G4 执行与核验计划原文\n\n");
  expect(pieces).toHaveLength(2);
  return JSON.parse(pieces[1]!.split("```json\n")[1]!.split("\n```\n")[0]!) as RequirementRecord;
}
function actualG4Checks(value: ReturnType<typeof prdFixture>, markdown: string): Array<{ id: string; pass: boolean }> {
  // Run the real server policy through its existing tsx loader without making
  // that server source a member of this package's TypeScript rootDir.
  const repo = fileURLToPath(new URL("../../../", import.meta.url)), script = `${value.workDir}/actual-g4-check.mts`;
  writeFileSync(script, `
import { gateDeterministicChecks } from ${JSON.stringify(repo + "apps/server/src/video/gate-policy.ts")};
console.log("RESULT " + JSON.stringify(gateDeterministicChecks("G4_PRD", ${JSON.stringify(markdown)})));
`, "utf8");
  const stdout = execFileSync(process.execPath, [`${repo}node_modules/tsx/dist/cli.mjs`, script], { cwd: repo, timeout: 20000, encoding: "utf8" });
  return JSON.parse(stdout.split("\n").find(line => line.startsWith("RESULT "))!.slice(7)) as Array<{ id: string; pass: boolean }>;
}
function expectCompletePrompt(prompt: string, kind: "creative" | "production", value: ReturnType<typeof prdFixture>) {
  const expected = effectivePrdModelSchema(kind, PRDSchema, value.contract);
  expect(schemaFromPrompt(prompt, kind)).toEqual(expected);
  expect(prompt.split(JSON.stringify(expected))).toHaveLength(2);
  expect(prompt.split(prdAuthorityPrompt(value.authority, value.contract))).toHaveLength(2);
  expect(prompt).toContain(JSON.stringify(value.metadata.brief));
  expect(prompt.includes(JSON.stringify(prdContractExecutionView(value.authority, value.contract)))).toBe(true);
  expect(prompt).toContain(value.content);
}
function lengthenAuthority(value: ReturnType<typeof prdFixture>) {
  requirementRecord(value.metadata.brief, "brief").description = "完整客户长文本及特殊字符\\\"{}[]".repeat(400);
  const opening = requirementRecord(requirementRecord(value.discovery.sceneStructure, "structure").opening, "opening");
  opening.purpose = "完整G3长目的和可见动作不可截断".repeat(80);
  value.production.scenePlan.scenes[0]!.purpose = String(opening.purpose);
  value.list = bindRequirementContract({ keyPoints: [] }, value.discovery, requirementRecord(value.discovery.upstreamFields, "upstream"),
    structuredClone(value.metadata), requirementCast(value.metadata).hash, "原始年轻消费者");
  value.contract = value.list._workloomRequirementContract as RequirementContract;
  const g1 = JSON.parse(value.content) as RequirementRecord;
  requirementRecord(g1.facts, "facts").completeReviewNotes = "完整G1原件意见与建议及日期用途限定".repeat(3000);
  value.content = JSON.stringify(g1); writeFileSync(value.file, value.content);
  value.marketing.g1Artifact = { path: value.file, content: value.content, sha256: digest(value.content) };
  value.marketing.g1Proof.evidence = [{ path: value.file, sha256: digest(value.content), scope: "complete-text" }];
  value.authority = preparePrdAuthority({ metadata: value.metadata, marketing: value.marketing, workDir: value.workDir, projectId: value.scope.projectId });
}

beforeEach(() => {
  expectedFetchCalls = 0;
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected external network in PRD fixture"); }));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  for (const value of fixtures.splice(0)) value.cleanup();
  expect(globalThis.fetch).toHaveBeenCalledTimes(expectedFetchCalls);
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function productionAdapter(reply = '{"shotId":"UNCHANGED","fields":{"scene":"模型原始文本"}}') {
  const requests: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];
  const provider: ModelProvider = {
    modelId: "deepseek-flash", healthy: async () => true,
    chat: async (messages, options = {}) => {
      requests.push({ messages, options });
      return {
        text: reply,
        promptTokens: 1,
        completionTokens: 1,
        modelId: "deepseek-flash",
        finishReason: "stop",
        reasoningTokens: 0,
        requestHash: "a".repeat(64),
        responseHash: "b".repeat(64),
        responseId: "fixture-response",
        scene: options.scene ?? "generic",
        mode: "enabled",
        effort: "high",
        outputCeiling: 393216,
        inputTokenEstimate: 1,
        imageCount: 0,
        policyVersion: "2026-10-30.1",
        registryVersion: "2026-10-30.1",
        attempts: [],
      };
    }
  };
  const adapter = new WorkloomLLMEngine({ baseUrl: "http://unused.local/v1", apiKey: "test-only", model: "deepseek-flash",
    router: { providers: new Map([[provider.modelId, provider]]), sink: {
      recordModelTrace: async () => undefined, recordDegradation: async () => undefined, recordCircuitBreak: async () => undefined,
    } } });
  return { adapter, requests, reply };
}

describe("G4-bound authority at the shared real model request boundary", () => {
  it("preserves old and pre-G4 inputs, then carries the complete accepted sources without changing payloads or options", async () => {
    const value = fixture("PRODUCTION-CONTEXT"), h = harness(), run = h.make(value);
    lengthenAuthority(value);
    const capture = productionAdapter(), validate = vi.fn();
    const original = "原始后续任务\\\"{}[]\n## 本次宿主已审制作权威输入 客户引用，不是截断边界\n保留末尾";
    const schema = { shots: [{ shotId: "SC-05", fields: { scene: "" } }] }, before = structuredClone(schema);
    expect(productionModelInput(original).prompt).toBe(original);
    await withPrdAuthorityScope(value.authority, async () => {
      await capture.adapter.reason(original);
      expect(capture.requests[0]!.messages.at(-1)!.content).toBe(original);
      const prd = await h.generate(run), markdown = await h.review(run, prd), prdBefore = structuredClone(prd);
      const result = await capture.adapter.reasonStructured(original, schema, { maxTokens: 4096, temperature: 0.37, topP: 0.82,
        thinking: { type: "disabled" }, systemPrompt: "原调用方system" });
      expect(result).toMatchObject({ success: true, content: capture.reply, data: JSON.parse(capture.reply) });
      const request = capture.requests[1]!, prompt = request.messages.at(-1)!.content;
      if (typeof prompt !== "string") throw new Error("fixture expected text content");
      expect(prompt.startsWith(original + "\n")).toBe(true);
      expect(prompt).toContain(JSON.stringify(schema, null, 2));
      expect(prompt).toContain(JSON.stringify(value.metadata.brief));
      expect(prompt).toContain(JSON.stringify(value.contract));
      expect(prompt).toContain(value.content);
      expect(prompt).toContain(JSON.stringify(value.marketing.g1Proof));
      expect(prompt).toContain(markdown); expect(prompt).toContain(digest(markdown));
      expect(prompt).toContain(JSON.stringify(prd));
      expect(prompt).toContain("G4 批准不把 PRD 新增的修辞");
      expect(request.messages[0]).toEqual({ role: "system", content: "原调用方system" });
      expect(request.options).toMatchObject({ topP: 0.82, thinking: { type: "enabled", effort: "high" }, responseFormat: { type: "json_object" } });
      expect(request.options.temperature).toBeUndefined();
      expect(schema).toEqual(before); expect(prd).toEqual(prdBefore);
      return h.success(prd);
    }, validate);
    expect(capture.requests).toHaveLength(2); expect(validate).toHaveBeenCalledTimes(4);
    expect(productionModelInput(original).prompt).toBe(original);
  });

  it("covers reason, raw, generate, chat and structured paths including vendor-created engines with exactly their original requests", async () => {
    // Use the same tsx CommonJS loading path as the production server. Vite's
    // ESM test loader cannot load the legacy systems/*.js constructor directly.
    const value = fixture("PRODUCTION-PATHS"), script = `${value.workDir}/vendor-context-probe.mts`;
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    writeFileSync(script, `
import { createRequire } from "node:module";
import { createHook } from "node:async_hooks";
import { WorkloomLLMEngine, installVendorEngineBridge } from ${JSON.stringify(fileURLToPath(new URL("./llm-adapter.ts", import.meta.url)))};
import { installPrdAuthorityBridge, withPrdAuthorityScope } from ${JSON.stringify(fileURLToPath(new URL("./prd-authority-bridge.ts", import.meta.url)))};
import { prdFixture, PRDGenerator, PRDSchema } from ${JSON.stringify(fileURLToPath(new URL("./prd-authority.test-support.ts", import.meta.url)))};
const fixture = prdFixture("NATIVE-MODEL-CONTEXT");
const timers = new Set();
const timerHook = createHook({ init(_id, type, _parent, resource) { if (type === "Timeout") timers.add(resource); } });
let restorePrd = () => undefined, restoreEngine = () => undefined, receipt, clearedTimers = 0;
timerHook.enable();
try {
class System {
 constructor(generator) { this.prdGenerator = generator; }
 async _confirmRequirementList(_text, list) { return { approved: true, requirementList: list }; }
 _generateMinimalPRD() { throw new Error("unexpected fallback"); }
 async _confirmPRD(_text, prd) { return { approved: true, prd }; }
}
const generator = new PRDGenerator();
for (const [key, payload] of [["agent2", fixture.creative], ["agent3", fixture.production]]) {
 generator[key]._llmEngineLoaded = true;
 generator[key]._llmEngine = { reasonStructured: async () => ({ success: true, data: structuredClone(payload) }) };
}
const system = new System(generator), requests = [], raw = '{"unchanged":true}';
const provider = { modelId: "deepseek-flash", healthy: async () => true,
 chat: async (messages, options = {}) => { requests.push({ messages, options }); return {
   text: raw, promptTokens: 1, completionTokens: 1, modelId: "deepseek-flash",
   finishReason: "stop", reasoningTokens: 0, requestHash: "a".repeat(64), responseHash: "b".repeat(64),
   responseId: "fixture", scene: options.scene ?? "generic", mode: "enabled", effort: "high",
   outputCeiling: 393216, inputTokenEstimate: 1, imageCount: 0,
   policyVersion: "2026-10-30.1", registryVersion: "2026-10-30.1", attempts: []
 }; } };
const adapter = new WorkloomLLMEngine({ baseUrl: "http://unused.local/v1", apiKey: "test-only", model: "deepseek-flash",
 router: { providers: new Map([[provider.modelId, provider]]), sink: { recordModelTrace: async () => undefined,
 recordDegradation: async () => undefined, recordCircuitBreak: async () => undefined } } });
restorePrd = installPrdAuthorityBridge(System.prototype, PRDGenerator.prototype, PRDSchema);
const { LLMEngine } = createRequire(${JSON.stringify(repo + "package.json")})(${JSON.stringify(repo + "vendor/supermickey/systems/llm-reasoning-engine.js")});
restoreEngine = installVendorEngineBridge(adapter);
 // The real prototype bridge supplies all calls; no constructor configuration,
 // credentials, provider initialization or background service is needed here.
 const native = Object.create(LLMEngine.prototype);
 const results = await withPrdAuthorityScope(fixture.authority, async () => {
  await system._confirmRequirementList("G3", fixture.list);
  const prd = await generator.generate(fixture.discovery);
  await system._confirmPRD(generator.generateMarkdown(prd), prd);
  const results = [await native.reason("原生reason"), await native.reasonRaw("原生raw"), await native.generate("原生generate")];
  const chat = await native.chat("原生system", "原生chat", 0.41);
  const structured = await native.reasonStructured("原生structured", { actual: "structure" }, { maxTokens: 1234 });
  return { results, chat, structured };
 });
 const labels = ["原生reason", "原生raw", "原生generate", "原生chat", "原生structured"];
 receipt = { count: requests.length, inputs: requests.map((request, index) => ({
  prefix: request.messages.at(-1).content.startsWith(labels[index]), complete: request.messages.at(-1).content.includes(fixture.content),
  options: request.options, system: request.messages[0] })), results, raw };
} finally {
 try { restoreEngine(); } finally {
  try { restorePrd(); } finally {
   timerHook.disable();
   // Native PRDGenerator._runWithTimeout leaves Promise.race timers alive after
   // success. Observe real handles throughout the test and clear them only now.
   for (const timer of timers) { clearTimeout(timer); clearedTimers += 1; }
   fixture.cleanup();
  }
 }
}
console.log("RESULT " + JSON.stringify({ ...receipt, cleanup: { clearedTimers, hookDisabled: true } }));
`, "utf8");
    const stdout = execFileSync(process.execPath, [`${repo}node_modules/tsx/dist/cli.mjs`, script], { cwd: repo, timeout: 20000, encoding: "utf8" });
    const result = JSON.parse(stdout.split("\n").find(line => line.startsWith("RESULT "))!.slice(7));
    expect(result.count).toBe(5);
    expect(result.inputs.every((input: RequirementRecord) => input.prefix === true && input.complete === true)).toBe(true);
    expect(result.inputs[3]).toMatchObject({ system: { role: "system", content: "原生system" }, options: { thinking: { type: "enabled", effort: "high" } } });
    expect(result.inputs[4].options.maxTokens).toBeUndefined();
    expect(result.results).toMatchObject({ results: [{ success: true, content: result.raw }, { success: true, content: result.raw }, { success: true, content: result.raw }],
      chat: result.raw, structured: { success: true, content: result.raw, data: { unchanged: true } } });
    expect(result.cleanup).toMatchObject({ hookDisabled: true, clearedTimers: expect.any(Number) });
    expect(result.cleanup.clearedTimers).toBeGreaterThanOrEqual(2);
  });

  it("uses bounded native PRD recovery through the actual vendor constructor and worker redirect", () => {
    const value = fixture("PRODUCTION-VENDOR-NATIVE"), script = `${value.workDir}/vendor-native-recovery.mts`;
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    const source = (name: string) => JSON.stringify(repo + "packages/video-studio/src/" + name + ".ts");
    writeFileSync(script, `
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { createRequire } from "node:module";
import { WorkloomLLMEngine, installVendorEngineBridge } from ${source("llm-adapter")};
import { installPrdAuthorityBridge, withPrdAuthorityScope } from ${source("prd-authority-bridge")};
import { frozenVisualPrdSegments, preparePrdAuthority } from ${source("prd-authority")};
import { bindRequirementContract, requirementCast } from ${source("requirement-contract")};
import { prdFixture, PRDGenerator, PRDSchema } from ${source("prd-authority.test-support")};
import { OpenAiCompatibleProvider, resetCircuit } from ${JSON.stringify(repo + "packages/base/model-router/index.ts")};

const { LLMEngine } = createRequire(${JSON.stringify(repo + "package.json")})(${JSON.stringify(repo + "vendor/supermickey/systems/llm-reasoning-engine.js")});
const cases = ["normal", "character", "audio", "creative", "repeat-invalid", "duplicate-key", "same-id",
  "unmeasured", "unmeasured-correction", "nonfrozen", "forged", "shadow", "proxy", "stale", "detached",
  "uninstalled", "foreign", "late", "late-correction", "unknown",
  "facts-corrected", "facts-clean", "facts-repeat", "facts-no-policy", "facts-unmeasured", "facts-duplicate",
  "facts-same-id", "facts-bad-shape", "facts-then-syntax", "facts-after-syntax", "facts-unknown", "facts-late-first", "facts-late-second",
  "facts-key-message", "facts-authority-drift"];
globalThis.fetch = () => { throw new Error("Unexpected external network"); };
const outcomes = [];
for (const mode of cases) {
  resetCircuit("preproduction");
  const value = prdFixture("VENDOR-NATIVE-" + mode, [10, 10, 10]);
  const factCase = mode.startsWith("facts-");
  if (factCase && mode !== "facts-no-policy") {
    value.metadata.brief.requirements = "保留完整客户原文。商品事实仅限本次 G1 核实的身份与用途。比赛、车辆和获胜均为虚构演绎。";
  }
  const invalidCreative = { ...value.creative,
    coreTheme: "以两次超越收束冲线，另声称22度前倾角与24.6度转向。SYNTHETIC_REJECTED_VALUE" };
  const cleanCreative = { ...value.creative, coreTheme: "30秒里以机位22度前倾角跟住两次超越，机位沿车架侧后转向45度；不使用实车前倾角24.6度做卖点。" };
  if (mode === "facts-bad-shape") invalidCreative.unknownFixtureKey = true;
  if (mode === "facts-key-message") {
    invalidCreative.coreTheme = cleanCreative.coreTheme;
    invalidCreative.keyMessages = ["P0：" + "保留动作".repeat(90) + "，商品转向角为20度。SYNTHETIC_REJECTED_VALUE"];
  }
  if (mode !== "nonfrozen") {
    value.metadata.brief.productionRequirements.speechPolicy = "none";
    value.metadata.brief.segmentContract = { count: 3, totalSeconds: 30, secondsPerSegment: 10, hardCuts: true,
      intervals: [0, 10, 20].map(startSec => ({ startSec, endSec: startSec + 10, brief: "冻结原文 " + startSec })) };
    value.list = bindRequirementContract({ keyPoints: [] }, value.discovery, value.discovery.upstreamFields,
      structuredClone(value.metadata), requirementCast(value.metadata).hash, "原始年轻消费者");
    value.authority = preparePrdAuthority({ metadata: value.metadata, marketing: value.marketing, workDir: value.workDir, projectId: value.scope.projectId });
    assert.equal(frozenVisualPrdSegments(value.authority)?.count, 3);
  }
  const invalid = structuredClone(value.production);
  if (mode === "audio") invalid.audioSpecification.audioReferences = ["声音一", "声音二", "声音三", "声音四"];
  else invalid.characterSystem.characters[0].consistencyRequirements_note = "SYNTHETIC_REJECTED_VALUE";
  const generator = new PRDGenerator();
  assert.equal(generator.agent2._llmEngine, null);
  assert.equal(generator.agent3._llmEngine, null);
  assert.equal(generator.agent3._llmEngineLoaded, false);
  const calls = { creative: [], production: [] }, baseUrl = "https://vendor-native-fixture.invalid/v1";
  const provider = new OpenAiCompatibleProvider("deepseek-flash", { baseUrl, apiKey: "test-only", fetchImpl: async (url, init) => {
    assert.equal(String(url), baseUrl + "/chat/completions");
    const { messages, ...controls } = JSON.parse(String(init.body));
    const prompt = messages.find(message => message.role === "user").content;
    const kind = prompt.includes("## 本次宿主 PRD creative 响应 JSON Schema") ? "creative" : "production";
    calls[kind].push({ prompt, nonUser: messages.filter(message => message.role !== "user"), controls });
    const count = calls[kind].length;
    assert(count <= 2);
    if (mode === "unknown" && kind === "production") return new Response("fixture HTTP 502", { status: 502 });
    if (mode === "facts-unknown" && kind === "creative") return new Response("fixture HTTP 502", { status: 502 });
    const firstInvalid = !factCase && !["normal", "creative", "unknown"].includes(mode);
    const payload = kind === "creative" ? (factCase
      ? mode === "facts-clean" || (count === 2 && !["facts-repeat", "facts-after-syntax"].includes(mode)) ? cleanCreative : invalidCreative
      : value.creative)
      : (count === 1 && firstInvalid) || mode === "repeat-invalid" ? invalid : value.production;
    let content = JSON.stringify(payload);
    if (mode === "facts-repeat" && kind === "creative" && count === 2) {
      content = JSON.stringify({ ...value.creative, coreTheme: "把实车优势归于２４．６度转向之间的机械几何。" });
    }
    if (mode === "creative" && kind === "creative" && count === 1) content = '{"coreTheme":"SYNTHETIC_REJECTED_VALUE"';
    if (kind === "creative" && ((mode === "facts-then-syntax" && count === 2) || (mode === "facts-after-syntax" && count === 1))) {
      content = '{"coreTheme":"SYNTHETIC_REJECTED_VALUE"';
    }
    if (mode === "facts-duplicate" && kind === "creative") content = '{"coreTheme":"duplicate",' + content.slice(1);
    if (mode === "duplicate-key" && kind === "production") content = '{"visualSpecification":null,' + content.slice(1);
    const id = kind + "-" + ((mode === "same-id" && kind === "production") || (mode === "facts-same-id" && kind === "creative") ? 1 : count);
    const unmeasured = (kind === "production" && (mode === "unmeasured" || (mode === "unmeasured-correction" && count === 2)))
      || (mode === "facts-unmeasured" && kind === "creative");
    return Response.json({ ...(unmeasured ? {} : { id }),
      object: "chat.completion", model: "deepseek-flash",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
      usage: { prompt_tokens: 51237, completion_tokens: 4876, total_tokens: 56113,
        completion_tokens_details: { reasoning_tokens: 4500 } } });
  } });
  const disposers = [];
  let authorityDrift = false;
  const start = performance.now.bind(performance);
  const router = { scene: "preproduction", providers: new Map([[provider.modelId, provider]]), sink: {
    recordModelTrace: async () => {
      const count = calls.production.length;
      if (mode === "stale" && count === 1) {
        const current = Object.getOwnPropertyDescriptor(LLMEngine.prototype, "reasonStructured");
        installVendorEngineBridge(adapter)();
        assert.deepEqual(Object.getOwnPropertyDescriptor(LLMEngine.prototype, "reasonStructured"), current);
      }
      if ((mode === "late" && count === 1) || (mode === "late-correction" && count === 2)) {
        Object.defineProperty(performance, "now", { configurable: true, value: () => start() + 200000 });
      }
      if ((mode === "facts-late-first" && calls.creative.length === 1) || (mode === "facts-late-second" && calls.creative.length === 2)) {
        Object.defineProperty(performance, "now", { configurable: true, value: () => start() + 200000 });
      }
      if (mode === "facts-authority-drift" && calls.creative.length === 1) authorityDrift = true;
    },
    recordDegradation: async () => undefined, recordCircuitBreak: async () => undefined,
  } };
  const makeAdapter = () => new WorkloomLLMEngine({ baseUrl, apiKey: "test-only", model: "deepseek-flash", router });
  const adapter = makeAdapter();
  class System {
    prdGenerator = generator;
    llmEngine = adapter;
    async _confirmRequirementList(_markdown, list) { return { approved: true, requirementList: list }; }
    _generateMinimalPRD() { throw new Error("Unexpected fallback"); }
    async _confirmPRD(_markdown, prd) { return { approved: true, prd }; }
  }
  const timers = new Set();
  const timerHook = createHook({ init(_id, type, _parent, resource) { if (type === "Timeout") timers.add(resource); } });
  timerHook.enable();
  let result, failure;
  try {
    disposers.push(installPrdAuthorityBridge(System.prototype, PRDGenerator.prototype, PRDSchema));
    const original = LLMEngine.prototype.reasonStructured;
    const uninstall = installVendorEngineBridge(adapter);
    disposers.push(uninstall);
    if (mode === "detached") {
      const obsolete = LLMEngine.prototype.reasonStructured;
      const uninstallNext = installVendorEngineBridge(makeAdapter());
      uninstall();
      uninstallNext();
      assert.equal(LLMEngine.prototype.reasonStructured, original);
      disposers.push(installVendorEngineBridge(adapter));
      generator.agent3._llmEngineLoaded = true;
      generator.agent3._llmEngine = { reasonStructured: obsolete };
    }
    if (["forged", "shadow", "proxy"].includes(mode)) {
      generator.agent3._llmEngineLoaded = true;
      const receiver = mode === "proxy" ? new Proxy(new LLMEngine(), {}) : mode === "shadow" ? new LLMEngine() : {};
      if (mode !== "proxy") receiver.reasonStructured = LLMEngine.prototype.reasonStructured;
      generator.agent3._llmEngine = receiver;
    }
    if (mode === "foreign") {
      const getEngine = generator.agent3._getLLMEngine;
      generator.agent3._getLLMEngine = function () {
        disposers.push(installVendorEngineBridge(makeAdapter()));
        return getEngine.call(this);
      };
    }
    if (mode === "uninstalled") {
      const getEngine = generator.agent3._getLLMEngine;
      generator.agent3._getLLMEngine = function () {
        uninstall();
        assert.equal(LLMEngine.prototype.reasonStructured, original);
        return getEngine.call(this);
      };
    }
    const system = new System();
    result = await withPrdAuthorityScope(value.authority, async () => {
      await system._confirmRequirementList("G3 fixture", value.list);
      const prd = await generator.generate(value.discovery);
      await system._confirmPRD(generator.generateMarkdown(prd), prd);
      return { success: true, stages: { prdGeneration: { data: prd } } };
    }, () => { if (authorityDrift) throw new Error("fixture original G1 changed"); });
  } catch (error) { failure = error.message; }
  finally {
    for (const dispose of disposers.reverse()) dispose();
    if (["late", "late-correction", "facts-late-first", "facts-late-second"].includes(mode)) delete performance.now;
    timerHook.disable();
    for (const timer of timers) clearTimeout(timer);
    value.cleanup();
  }
  const accepted = ["normal", "character", "audio", "creative", "facts-corrected", "facts-clean", "facts-no-policy", "facts-key-message"].includes(mode);
  assert.equal(Boolean(result), accepted, mode + ": " + failure);
  const repeatedCreative = ["creative", "facts-corrected", "facts-repeat", "facts-same-id", "facts-then-syntax", "facts-after-syntax", "facts-late-second", "facts-key-message"].includes(mode);
  assert.equal(calls.creative.length, repeatedCreative ? 2 : 1, mode);
  const shouldRepeat = ["character", "audio", "repeat-invalid", "same-id", "unmeasured-correction", "late-correction"].includes(mode);
  const unsafeReceiver = ["forged", "shadow", "proxy", "detached", "uninstalled", "foreign"].includes(mode);
  assert.equal(calls.production.length, unsafeReceiver || (factCase && !accepted) ? 0 : shouldRepeat ? 2 : 1, mode);
  if (factCase && mode !== "facts-no-policy") {
    assert(calls.creative[0].prompt.includes("## 本次创意商品事实边界"), mode);
    assert(calls.creative[0].prompt.includes(value.metadata.brief.requirements), mode);
    assert(calls.creative[0].prompt.includes(value.content), mode);
  }
  if (["facts-clean", "facts-corrected", "facts-key-message"].includes(mode)) {
    assert.deepEqual(result.stages.prdGeneration.data.creativeCore, cleanCreative, mode);
    assert(calls.production[0].prompt.includes(cleanCreative.coreTheme), mode);
    assert(!calls.production[0].prompt.includes("SYNTHETIC_REJECTED_VALUE"), mode);
  }
  if (mode === "facts-no-policy") {
    assert.equal(result.stages.prdGeneration.data.creativeCore.coreTheme, invalidCreative.coreTheme);
    assert(!calls.creative[0].prompt.includes("## 本次创意商品事实边界"));
  }
  if (mode === "facts-authority-drift") assert.match(failure, /fixture original G1 changed/);
  if (unsafeReceiver || mode === "stale") assert.match(failure, /PRD_ENGINE_CHANGED/, mode);
  for (const [kind, requests] of Object.entries(calls)) {
    const [first, next] = requests;
    if (!next) continue;
    const heading = kind === "creative"
      ? (factCase && mode !== "facts-after-syntax" ? "\\n\\n## 本次原生创意核心商品事实修正\\n" : "\\n\\n## 本次原生创意核心 JSON 格式修正\\n")
      : "\\n\\n## 上一次原生制作规格结构校验反馈\\n";
    const start = next.prompt.lastIndexOf(heading);
    const end = next.prompt.lastIndexOf("\\n\\n【硬性输出要求】");
    assert(start > 0 && end > start, mode);
    assert.equal(next.prompt.slice(0, start) + next.prompt.slice(end), first.prompt, mode);
    assert.deepEqual(next.controls, first.controls, mode);
    assert.deepEqual(next.nonUser, first.nonUser, mode);
    assert(!next.prompt.includes("SYNTHETIC_REJECTED_VALUE") && !next.prompt.includes("consistencyRequirements_note"), mode);
    assert.equal(first.controls.max_tokens, 393216, mode);
    assert.equal(first.controls.reasoning_effort, "high", mode);
  }
  outcomes.push({ mode, accepted, creative: calls.creative.length, production: calls.production.length });
}
console.log("RESULT " + JSON.stringify(outcomes));
`, "utf8");
    const stdout = execFileSync(process.execPath, [`${repo}node_modules/tsx/dist/cli.mjs`, script], {
      cwd: repo, timeout: 40_000, encoding: "utf8", maxBuffer: 2 * 1024 * 1024,
    });
    const outcomes = JSON.parse(stdout.split("\n").find(line => line.startsWith("RESULT "))!.slice(7));
    expect(outcomes).toHaveLength(35);
    expect(outcomes.filter((row: RequirementRecord) => row.accepted).map((row: RequirementRecord) => row.mode))
      .toEqual(["normal", "character", "audio", "creative", "facts-corrected", "facts-clean", "facts-no-policy", "facts-key-message"]);
  }, 45_000);

  it("the direct HTTP path carries the same private context and returns the exact raw response", async () => {
    const value = fixture("PRODUCTION-DIRECT"), h = harness(), run = h.make(value), bodies: RequirementRecord[] = [];
    const raw = '{"unchanged":"原始返回"}'; expectedFetchCalls = 1;
    vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as RequirementRecord);
      return new Response(JSON.stringify({
        id: "fixture-direct",
        model: "deepseek-flash",
        choices: [{ finish_reason: "stop", message: { content: raw } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      }), { status: 200 });
    });
    const adapter = new WorkloomLLMEngine({ baseUrl: "http://unused.local/v1", apiKey: "test-only", model: "deepseek-flash" });
    await withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run); await h.review(run, prd);
      expect(await adapter.reasonStructured("直连原始需求", { unchanged: "" }, { maxTokens: 4321 })).toMatchObject({ content: raw, data: JSON.parse(raw) });
      return h.success(prd);
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: "deepseek-flash" });
    const prompt = (bodies[0]!.messages as ChatMessage[]).at(-1)!.content;
    if (typeof prompt !== "string") throw new Error("fixture expected text content");
    expect(prompt.startsWith("直连原始需求")).toBe(true); expect(prompt).toContain(value.content);
  });

  it("interleaved runs sharing one host adapter never borrow the other run's accepted source", async () => {
    const values = [fixture("MODEL-A"), fixture("MODEL-B")], h = harness(), runs = values.map(value => h.make(value));
    const capture = productionAdapter(), ready = [deferred<void>(), deferred<void>()], release = [deferred<void>(), deferred<void>()];
    const pending = runs.map((run, index) => withPrdAuthorityScope(run.value.authority, async () => {
      const prd = await h.generate(run); await h.review(run, prd); ready[index]!.resolve(); await release[index]!.promise;
      await capture.adapter.reason(`模型作业-${index}`); return h.success(prd);
    }));
    await Promise.all(ready.map(item => item.promise));
    release[1]!.resolve(); await pending[1]; release[0]!.resolve(); await pending[0];
    expect(capture.requests).toHaveLength(2);
    for (const [position, index] of [1, 0].entries()) {
      const prompt = capture.requests[position]!.messages.at(-1)!.content;
      expect(prompt).toContain(values[index]!.content);
      expect(prompt).not.toContain(values[index === 0 ? 1 : 0]!.marketing.g1Artifact.sha256);
    }
  });

  it.each(["source", "reviewed-prd", "g1-file"])("rejects changed %s before another provider request even if native code catches it", async kind => {
    const value = fixture("MODEL-TAMPER"), h = harness(), run = h.make(value), capture = productionAdapter();
    const validate = () => { preparePrdAuthority({ metadata: value.metadata, marketing: value.marketing, workDir: value.workDir, projectId: value.scope.projectId }); };
    await expect(withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run); await h.review(run, prd);
      if (kind === "source") requirementRecord(value.authority.metadata.brief, "brief").description = "changed private source";
      if (kind === "reviewed-prd") requirementRecord(prd.creativeCore, "creative").coreTheme = "unreviewed creative change";
      if (kind === "g1-file") writeFileSync(value.file, value.content + "\n");
      try { await capture.adapter.reason("不能提交"); } catch { /* simulate the native consumer catching an authority error */ }
      return { success: false };
    }, validate)).rejects.toThrow();
    expect(capture.requests).toHaveLength(0);
  });

  it("revalidates the accepted bytes after an in-flight request and retains a sticky failure", async () => {
    const value = fixture("MODEL-IN-FLIGHT"), h = harness(), run = h.make(value), capture = productionAdapter();
    let checks = 0;
    const validate = () => { if (++checks === 2) throw new Error("actual G1 changed during model request"); };
    await expect(withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run); await h.review(run, prd);
      try { await capture.adapter.reason("已发出的本次请求"); } catch { /* native catch cannot make the authority valid */ }
      return { success: false };
    }, validate)).rejects.toThrow("actual G1 changed");
    expect(capture.requests).toHaveLength(1);
  });

  it("an inherited asynchronous callback after scope closure fails without a provider request", async () => {
    const value = fixture("MODEL-LATE"), h = harness(), run = h.make(value), capture = productionAdapter();
    const release = deferred<void>(); let late: Promise<unknown> | undefined;
    await withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run); await h.review(run, prd);
      late = release.promise.then(() => capture.adapter.reason("迟到请求"));
      return h.success(prd);
    });
    const rejected = expect(late!).rejects.toThrow("PRD_SCOPE_CLOSED"); release.resolve(); await rejected;
    expect(capture.requests).toHaveLength(0);
  });

  it("G5 portrait paths remain a legal lifecycle update", async () => {
    const value = fixture("MODEL-G5"), h = harness(), run = h.make(value), capture = productionAdapter();
    await withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run); await h.review(run, prd);
      (requirementRecord(prd.characterSystem, "characters").characters as RequirementRecord[])[0]!.portraitPath = "/synthetic/current-g5.png";
      await capture.adapter.reason("合法定妆照生命周期");
      expect(capture.requests[0]!.messages.at(-1)!.content).toContain("/synthetic/current-g5.png");
      return h.success(prd);
    });
    expect(capture.requests).toHaveLength(1);
  });

  it("a rejected G4 never supplies an approved production context", async () => {
    const value = fixture("MODEL-G4-REJECTED"), h = harness(), run = h.make(value);
    await withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run); run.system.g4Approved = false; await h.review(run, prd);
      expect(productionModelInput("拒绝后的原始请求").prompt).toBe("拒绝后的原始请求");
      return { success: false };
    });
  });
});

function harness() {
  class System {
    prdGenerator: RequirementRecord;
    g3Approved = true;
    g4Approved = true;
    suggestions: string[] = [];
    minimalCalls = 0;
    truthCalls = 0;
    truthVerdict = { blocking: false, degraded: false };
    truthStage: RequirementRecord = { pass: true, blocking: false, degraded: false, conflicts: [], issues: [], factRedLines: [] };
    constructor(generator: RequirementRecord) { this.prdGenerator = generator; }
    async _confirmRequirementList(_markdown: unknown, list: unknown) { return { approved: this.g3Approved, requirementList: list }; }
    _generateMinimalPRD() { this.minimalCalls++; return { productPositioning: { aspectRatio: "16:9" } }; }
    async _confirmPRD(_markdown: unknown, prd: unknown) { return { approved: this.g4Approved, prd, suggestions: this.suggestions }; }
    _runProductTruthCheckGate(metadata: RequirementRecord, result: RequirementRecord) {
      this.truthCalls++;
      const stages = result.stages === undefined ? {} : requirementRecord(result.stages, "stages");
      result.stages = stages; stages.truthCheck = structuredClone(this.truthStage);
      if (Array.isArray(this.truthStage.factRedLines)) metadata._factRedLines = structuredClone(this.truthStage.factRedLines);
      return this.truthVerdict;
    }
  }
  const prototype = System.prototype as unknown as RequirementRecord;
  const before = Object.fromEntries(["_confirmRequirementList", "_generateMinimalPRD", "_confirmPRD", "_runProductTruthCheckGate"].map(key => [key, Object.getOwnPropertyDescriptor(prototype, key)]));
  const nativeGenerator = Object.getOwnPropertyDescriptor(PRDGenerator.prototype, "generate")!;
  const dispose = installPrdAuthorityBridge(prototype, PRDGenerator.prototype, PRDSchema);
  disposers.push(dispose);
  const make = (value: ReturnType<typeof prdFixture>) => {
    const generator = new PRDGenerator(), calls: Array<{ agent: string; prompt: string; schema: unknown; options: unknown; correctReceiver: boolean }> = [];
    const engines: RequirementRecord[] = [];
    for (const [key, payload] of [["agent2", value.creative], ["agent3", value.production]] as const) {
      const engine: RequirementRecord = {
        reasonStructured: vi.fn(async function (this: RequirementRecord, prompt: string, schema: unknown, options: unknown) {
          calls.push({ agent: key, prompt, schema, options, correctReceiver: this === engine });
          return { success: true, data: structuredClone(payload) };
        })
      };
      const agent = requirementRecord(generator[key], key);
      agent._llmEngineLoaded = true; agent._llmEngine = engine;
      engines.push(engine);
    }
    const system = new System(generator) as unknown as RequirementRecord;
    return { value, generator, system, calls, engines };
  };
  async function generate(run: ReturnType<typeof make>) {
    await invoke(run.system, "_confirmRequirementList", "# real synthetic G3 review", run.value.list);
    return await invoke(run.generator, "generate", run.value.discovery) as RequirementRecord;
  }
  async function review(run: ReturnType<typeof make>, result: RequirementRecord) {
    const markdown = invoke(run.generator, "generateMarkdown", result) as string;
    await invoke(run.system, "_confirmPRD", markdown, result);
    return markdown;
  }
  const success = (prd: RequirementRecord) => ({ success: true, stages: { prdGeneration: { data: prd } } });
  return { prototype, make, generate, review, success, dispose, before, nativeGenerator };
}

function refreshContract(value: ReturnType<typeof prdFixture>) {
  value.list = bindRequirementContract({ keyPoints: [] }, value.discovery, requirementRecord(value.discovery.upstreamFields, "upstream"),
    structuredClone(value.metadata), requirementCast(value.metadata).hash, "原始年轻消费者");
  value.contract = value.list._workloomRequirementContract as RequirementContract;
  value.authority = preparePrdAuthority({ metadata: value.metadata, marketing: value.marketing, workDir: value.workDir, projectId: value.scope.projectId });
}

function declareDelivery(value: ReturnType<typeof prdFixture>, patch: RequirementRecord) {
  Object.assign(requirementRecord(requirementRecord(value.metadata.brief, "brief").productionRequirements, "production requirements"), patch);
  refreshContract(value);
}

function planningCastFromPrompt(prompt: string): RequirementRecord {
  const pieces = prompt.split("\n### 本次已知人物来源锚点（原G3选角来源，不是G5完成凭据）\n");
  expect(pieces).toHaveLength(2);
  return JSON.parse(pieces[1]!.split("\n")[0]!) as RequirementRecord;
}

function productionShot(shotId = "SC-01"): RequirementRecord {
  const fields = Object.fromEntries([
    ...nativeStandardizer.CRITICAL_FIELDS.p0, ...nativeStandardizer.CRITICAL_FIELDS.p1,
    ...nativeStandardizer.CRITICAL_FIELDS.p2, ...nativeStandardizer.CRITICAL_FIELDS.p3,
  ].map(key => [key, `完整本镜${key}真实内容`])) as RequirementRecord;
  Object.assign(fields, {
    scene: "封闭拍摄场地的轮胎墙旁，午后自然光照亮人物与商品，地面纹理真实清晰",
    camera_movement: "固定机位缓慢推近商品与人物，起幅中景落幅近景，速度均匀平缓",
    lighting: "真实窗光从右前方照入，色温5600K柔光，左侧反光板补光使阴影保持细节",
    mood: "人物神情克制平静，注意力集中在眼前商品的外观轮廓与空间关系",
    action: "人物沿着商品边缘向前走近半步，双手保持自然放松并轻轻点头",
    timeline: "T00:00-00:05 人物走近商品，镜头缓慢推近，随后人物停步并看向镜头",
    negative: "no text, no watermark, no extra limbs；禁止头盔与墨镜，保留明确负面原文",
    costume: "黑色夹克搭配白色上衣、深灰全长裤与黑色短靴",
    dialogue: "只聊外观设计，也欢迎评论封闭场地的使用问题。",
    portraits: "image://characters/synthetic/front.png",
    audio: "只保留环境风声、脚步声与人物现场说话，不添加背景音乐",
  });
  return { ...fields, fields, shotId, sceneType: "opening", duration: 5,
    prompt: "01.【场景】封闭场地中人物走近商品，镜头保留真实物理空间与前三秒视觉钩子。\n02.【负面约束】no text, no watermark；禁止头盔与墨镜。",
    backgroundSoundString: "环境风声与人物皮靴脚步声，保留真实现场声音", extraSource: { untouched: ["原始附加资料"] }, _workloomFusion: { status: "passed", sourceHash: "original-fusion-source" } };
}

function deliveryPrompt() {
  const labels = ["语言约束", "导演意图", "基础", "约束", "场景", "灯光设计", "明亮约束", "构图", "色彩/色调", "景深", "运镜", "角色", "服装", "化妆", "动作", "道具", "定妆照", "时间轴", "情绪", "节奏", "转场", "音频", "负面约束", "角色约束", "角色一致性"];
  return labels.map((label, index) => `${String(index + 1).padStart(2, "0")}.【${label}】${label === "情绪" ? "人物眼睛缓慢眨动，指尖轻触商品，呼吸平稳。" : "封闭场地中人物观察商品并保留实际材料与自然光线，动作和空间关系清楚。"}${"完整本镜真实细节，保持本次原始摄影与人物动作。".repeat(2)}`).join("\n");
}

function productionHarness(nativeFusion = false, nativeModel = false) {
  const h = harness();
  const calls: Array<{ key: string; receiver: RequirementRecord; args: unknown[] }> = [];
  const record = (key: string, operation: (this: RequirementRecord, ...args: unknown[]) => unknown) => function (this: RequirementRecord, ...args: unknown[]) {
    calls.push({ key, receiver: this, args });
    return Reflect.apply(operation, this, args);
  };
  const define = (owner: RequirementRecord, key: string, operation: (this: RequirementRecord, ...args: unknown[]) => unknown) => {
    Object.defineProperty(owner, key, { value: record(key, operation), configurable: true, writable: true });
  };
  define(h.prototype, "create", function (operation) { return Reflect.apply(operation as (...args: unknown[]) => unknown, this, []); });
  define(h.prototype, "_optimizeOpeningTitle", function () { return { originalTitlePackage: true }; });
  define(h.prototype, "_generatePromptsReport", function (prompts) { return `legacy-report:${JSON.stringify(prompts)}`; });
  const productionPrototype: RequirementRecord = {}, phase1Prototype: RequirementRecord = {};
  const fusionPrototype = nativeFusion ? PromptFusionAgent.prototype : {};
  if (!nativeFusion) for (const key of ["_loadSubCheckpoint", "_saveSubCheckpoint", "_clearSubCheckpoint"]) {
    define(fusionPrototype, key, function (...args) { return { nativeCache: key, args }; });
  }
  define(productionPrototype, "produce", function (blueprint, ...args) {
    return typeof this.nextProduce === "function" ? Reflect.apply(this.nextProduce as (...args: unknown[]) => unknown, this, [blueprint, ...args])
      : this.nativeResult ?? { nativeProduction: true };
  });
  define(phase1Prototype, "_shouldGenerateOpening", function () { return true; });
  for (const [owner, key] of [
    [productionPrototype, "_loadLatestCheckpoint"], [productionPrototype, "_saveCheckpoint"], [productionPrototype, "_clearCheckpoints"],
  ] as Array<[RequirementRecord, string]>) define(owner, key, function (...args) { return { nativeCache: key, args }; });
  const deps = { systemPrototype: h.prototype, productionPrototype, phase1Prototype, fusionPrototype,
    refinerPrototype: FieldContentRefiner.prototype, costumePrototype: CharacterCostumePrompter.prototype,
    fieldGuardPrototype: FieldGuard.prototype, qualityGatePrototype: QualityGate.prototype,
    deliveryGuardPrototype: PromptDeliveryGuard.prototype, semanticPrototype: SemanticRefinementPass.prototype,
    fieldQualityPrototype: FieldQualityPipeline.prototype, ruleRepairPrototype: RuleRepairer.prototype,
    ruleCheckPrototype: RuleChecker.prototype, llmRepairPrototype: LLMRepairer.prototype, extractFieldRepairJson,
    ...(nativeFusion ? { fieldConsistencyPrototype: FieldConsistencyChecker.prototype } : {}),
    ...(nativeModel ? { structuredAgent: { prototype: BaseAgent.prototype, limiter: globalLLMLimiter } } : {}),
    standardizeShot: nativeStandardizer.standardizeShot, validateShot: nativeStandardizer.validateShot, fields: nativeStandardizer.CRITICAL_FIELDS };
  const originals = Object.fromEntries(Object.entries(deps).filter(([key]) => key.endsWith("Prototype"))
    .map(([key, prototype]) => [key, Object.getOwnPropertyDescriptors(prototype)]));
  const dispose = installPrdProductionBridge(deps);
  disposers.push(dispose);
  const make = (value: ReturnType<typeof prdFixture>) => ({ ...h.make(value),
    engine: Object.create(productionPrototype) as RequirementRecord,
    phase1: Object.create(phase1Prototype) as RequirementRecord,
    fusion: Object.create(fusionPrototype) as RequirementRecord,
    refiner: new FieldContentRefiner({ constraintTemplate: "16:9画幅，8K分辨率，24fps，MP4格式" }),
    costume: new CharacterCostumePrompter(), fieldGuard: new FieldGuard(), qualityGate: new QualityGate(),
    deliveryGuard: new PromptDeliveryGuard(),
  });
  const accepted = (run: ReturnType<typeof make>, operation: (prd: RequirementRecord, markdown: string) => unknown | Promise<unknown>,
    options: { validate?: () => void; theme?: () => unknown } = {}) => withPrdAuthorityScope(run.value.authority, () =>
    invoke(run.system, "create", async () => {
      const prd = await h.generate(run), markdown = await h.review(run, prd);
      await operation(prd, markdown);
      return h.success(prd);
    }), options.validate, options.theme);
  return { ...h, make, accepted, deps, originals, calls, disposeProduction: dispose };
}

describe("PRD native generator, two native agent processes and real schema", () => {
  it("uses both original LLM paths, carries complete sources and creates authoritative visible delivery", async () => {
    const value = fixture(), h = harness(), run = h.make(value);
    const result = await withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run), markdown = await h.review(run, prd);
      expect(markdown).toContain("1080p"); expect(markdown).toContain("frameRate");
      expect(markdown).toContain(value.contract.scenes[0]!.purpose);
      expect(markdown).toContain("subtitle_sidecar"); expect(markdown).toContain("subtitle_burned");
      expect(markdown).toContain("## 9. 客户受众与模型细分推测");
      expect(markdown).toContain("**客户 Brief 权威受众原文**：原始年轻消费者");
      expect(markdown).toContain("以下年龄、性别与兴趣细分仅为模型推测");
      expect(requirementRecord(prd.audienceProfile, "audience")).toMatchObject({
        primaryAudience: { ageRange: "25-30", gender: "male" },
        _workloomAudienceAuthority: { customerOriginal: "原始年轻消费者", modelStatus: "model-hypothesis" }
      });
      expect(prd.creativeCore).toEqual(value.creative);
      expect(prd.productPositioning).toMatchObject({ targetDuration: 30, aspectRatio: "9:16", targetPlatform: "抖音", resolution: "1080p", frameRate: 30 });
      expect(requirementRecord(prd.characterSystem, "characters").characters).toEqual([expect.objectContaining({ portraitPath: "", _workloomCharacterSource: expect.objectContaining({ portraitVersion: 2 }) })]);
      return h.success(prd);
    });
    expect(result.success).toBe(true);
    expect(run.calls.map(call => call.agent)).toEqual(["agent2", "agent3"]);
    for (const call of run.calls) {
      expect(call.correctReceiver).toBe(true);
      expectCompletePrompt(call.prompt, call.agent === "agent2" ? "creative" : "production", value);
      expect(call.schema).toEqual({ required: call.agent === "agent2"
        ? ["coreTheme", "creativeHook", "emotionalArc", "keyMessages", "endingType"] : ["visualSpecification", "audioSpecification"] });
      expect(call.options).toEqual({ maxTokens: 12288, timeoutMs: call.agent === "agent2" ? 120000 : 180000,
        maxRetries: 1, deadlineMs: null, thinking: { type: "disabled" } });
    }
    expect(requirementRecord(run.generator.agent2, "agent2")).not.toHaveProperty("_lastDiscoveryResult");
  });
  it("carries the exact frozen Film codec through the native Agent5 result and reviewed G4 markdown", async () => {
    const value = fixture("NATIVE-AGENT5-FILM-CODEC", [10, 10, 10]), h = harness();
    requirementRecord(value.metadata.brief, "brief").segmentContract = {
      count: 3, totalSeconds: 30, secondsPerSegment: 10, hardCuts: true,
      intervals: [0, 10, 20].map(startSec => ({ startSec, endSec: startSec + 10, brief: `冻结分段 ${startSec}` })),
    };
    declareDelivery(value, { speechPolicy: "none", coverDelivery: "standalone", coverIntroSeconds: 0,
      sidecarPolicy: "dialogue-and-composite-ass", persistentSubtitleText: "AI剧情演绎｜封闭赛道",
      postTailOverlayText: "车型 820RR-RC", postTailOverlaySeconds: 2 });
    const run = h.make(value);
    await withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run);
      const delivery = requirementRecord(prd.deliveryStandard, "Agent5 交付");
      expect(delivery.outputFormat).toMatchObject({ videoCodec: "H.264", audioCodec: "AAC", container: "MP4", resolution: "1080p" });
      expect(delivery.deliverables).toEqual(expect.arrayContaining([
        expect.objectContaining({ item: "video_master", spec: expect.stringMatching(/^MP4\/H\.264, 1080p; /) }),
      ]));
      const markdown = await h.review(run, prd);
      expect(markdown).toContain("视频编码：H.264");
      expect(markdown).toContain("**video_master**：MP4/H.264, 1080p;");
      expect(markdown).not.toContain("H.265");
      return h.success(prd);
    });
    expect(run.calls.map(call => call.agent)).toEqual(["agent2", "agent3"]);
  });
  it("renders a 35s six-scene contract without inapplicable noPropsReason nulls while preserving every canonical field and hash", async () => {
    const value = fixture("DISPLAY-35", [4, 6, 7, 8, 5, 5]);
    (value.metadata.characters as RequirementRecord[])[0]!.nullableCharacterNote = null;
    requirementRecord(value.discovery.audienceProfile, "audience").nullableAudienceNote = null;
    value.list = bindRequirementContract({ keyPoints: [] }, value.discovery, requirementRecord(value.discovery.upstreamFields, "upstream"),
      structuredClone(value.metadata), requirementCast(value.metadata).hash, "原始年轻消费者");
    value.contract = value.list._workloomRequirementContract as RequirementContract;
    value.authority = preparePrdAuthority({ metadata: value.metadata, marketing: value.marketing, workDir: value.workDir, projectId: value.scope.projectId });
    const h = harness(), run = h.make(value), contractBefore = structuredClone(value.contract);
    const contractHashBefore = requirementHash(value.contract), listHashBefore = requirementHash(value.list);
    await withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run), prdBefore = structuredClone(prd), prdHashBefore = requirementHash(prd);
      const markerBefore = structuredClone(prd._workloomPrdAuthority), markdown = await h.review(run, prd);
      const display = authorityFromMarkdown(markdown), displayedContract = requirementRecord(display.approvedRequirementContract, "display contract");
      const displayedScenes = displayedContract.scenes as RequirementRecord[];
      expect(markdown).not.toMatch(/"noPropsReason"\s*:\s*null/);
      expect(display.profile).toEqual(value.authority.profile); expect(display.source).toEqual(markerBefore);
      expect(displayedScenes.map(scene => scene.duration)).toEqual([4, 6, 7, 8, 5, 5]);
      expect(displayedScenes.reduce((total, scene) => total + Number(scene.duration), 0)).toBe(35);
      for (const [index, scene] of displayedScenes.entries()) {
        expect(scene).not.toHaveProperty("noPropsReason");
        expect({ ...scene, noPropsReason: null }).toEqual(contractBefore.scenes[index]);
      }
      expect({ ...displayedContract, scenes: contractBefore.scenes }).toEqual(contractBefore);
      expect((requirementRecord(displayedContract.cast, "display cast").characters as RequirementRecord[])[0]).toHaveProperty("nullableCharacterNote", null);
      expect(requirementRecord(displayedContract.modelAudienceHypothesis, "display hypothesis")).toHaveProperty("nullableAudienceNote", null);
      expect(markdown).toContain('"nullableCharacterNote": null'); expect(markdown).toContain('"nullableAudienceNote": null');
      expect(invoke(run.generator, "generateMarkdown", prd)).toBe(markdown);
      expect(prd).toEqual(prdBefore); expect(requirementHash(prd)).toBe(prdHashBefore);
      expect(prd._workloomPrdAuthority).toEqual(markerBefore);
      expect(prd._workloomRequirementContract).toEqual(contractBefore);
      expect(value.contract).toEqual(contractBefore); expect(requirementHash(value.contract)).toBe(contractHashBefore);
      expect(requirementHash(value.list)).toBe(listHashBefore);
      return h.success(prd);
    });
    expect(run.calls.map(call => call.agent)).toEqual(["agent2", "agent3"]);
    for (const call of run.calls) expectCompletePrompt(call.prompt, call.agent === "agent2" ? "creative" : "production", value);
  });
  it("keeps a real no-props reason and unrelated top-level nulls visible without changing the original contract", async () => {
    const value = fixture("DISPLAY-NO-PROPS", [4, 6, 7, 8, 5, 5]);
    const opening = requirementRecord(requirementRecord(value.discovery.sceneStructure, "structure").opening, "opening");
    const physical = requirementRecord(opening.productionContract, "production contract");
    const reason = "本场仅展示环境光影变化，无独立可见道具；null 字样为原文说明";
    physical.props = []; physical.noPropsReason = reason;
    value.production.scenePlan.scenes[0]!.keyProps = [];
    delete requirementRecord(value.metadata.brief, "brief").audience;
    value.list = bindRequirementContract({ keyPoints: [] }, value.discovery, requirementRecord(value.discovery.upstreamFields, "upstream"),
      structuredClone(value.metadata), requirementCast(value.metadata).hash, null);
    value.contract = value.list._workloomRequirementContract as RequirementContract;
    value.authority = preparePrdAuthority({ metadata: value.metadata, marketing: value.marketing, workDir: value.workDir, projectId: value.scope.projectId });
    const h = harness(), run = h.make(value), contractBefore = structuredClone(value.contract), hashBefore = requirementHash(value.contract);
    await withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run), before = structuredClone(prd), markdown = await h.review(run, prd);
      const display = authorityFromMarkdown(markdown), contract = requirementRecord(display.approvedRequirementContract, "display contract");
      const scenes = contract.scenes as RequirementRecord[];
      expect(scenes[0]).toEqual(contractBefore.scenes[0]); expect(scenes[0]).toHaveProperty("noPropsReason", reason);
      expect(scenes[0]!.props).toEqual([]); expect(markdown).toContain(reason);
      expect(contract).toHaveProperty("ownerAudience", null); expect(markdown).toContain('"ownerAudience": null');
      expect(scenes.slice(1).every(scene => !Object.hasOwn(scene, "noPropsReason"))).toBe(true);
      expect(prd).toEqual(before); expect(value.contract).toEqual(contractBefore);
      expect(requirementHash(value.contract)).toBe(hashBefore);
      return h.success(prd);
    });
    expect(run.calls.map(call => call.agent)).toEqual(["agent2", "agent3"]);
  });
  it("a legacy brief omitting productionRequirements keeps vendor undeclared resolution/fps defaults", async () => {
    const value = fixture(), h = harness(), run = h.make(value);
    delete requirementRecord(value.metadata.brief, "brief").productionRequirements;
    const authority = preparePrdAuthority({ metadata: value.metadata, marketing: value.marketing, workDir: value.workDir, projectId: "P1" });
    await withPrdAuthorityScope(authority, async () => {
      const prd = await h.generate(run); await h.review(run, prd);
      expect(prd.productPositioning).toMatchObject({ resolution: "4K", frameRate: 30, aspectRatio: "9:16", targetPlatform: "抖音" });
      expect(requirementRecord(prd.deliveryStandard, "delivery").outputFormat).not.toHaveProperty("nativeAudio");
      return h.success(prd);
    });
  });
  it.each([
    { key: "agent2", shrink: "partial-authority" }, { key: "agent3", shrink: "partial-authority" },
    { key: "agent2", shrink: "suffix-removed" }, { key: "agent3", shrink: "suffix-removed" },
    { key: "agent2", shrink: "host-example" }, { key: "agent3", shrink: "host-example" }
  ])("native $key parse shrink ($shrink) restores the complete schema and long authority exactly once", async ({ key, shrink }) => {
    const value = fixture(), h = harness(), run = h.make(value);
    lengthenAuthority(value);
    if (shrink === "suffix-removed") value.discovery._originalStoryText = "完整原始故事【目标JSON结构示例】原生缩短时会移除此后的示例部分";
    if (shrink === "host-example") {
      requirementRecord(value.metadata.brief, "brief").description += "【目标JSON结构示例】客户保留的原始引用";
      value.authority = preparePrdAuthority({ metadata: value.metadata, marketing: value.marketing, workDir: value.workDir, projectId: value.scope.projectId });
    }
    const agent = requirementRecord(run.generator[key], key), nativeBuild = agent._buildPrompt as (...args: unknown[]) => unknown;
    const built: string[] = [];
    agent._buildPrompt = function (this: RequirementRecord, ...args: unknown[]) {
      const prompt = Reflect.apply(nativeBuild, this, args) as string;
      built.push(prompt); return prompt;
    };
    const engine = run.engines[key === "agent2" ? 0 : 1]!, original = engine.reasonStructured as (...args: unknown[]) => unknown;
    let attempts = 0;
    engine.reasonStructured = vi.fn(async function (this: RequirementRecord, ...args: unknown[]) {
      if (++attempts === 1) throw new Error("synthetic JSON parse failure");
      return Reflect.apply(original, this, args);
    });
    const running = withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run); await h.review(run, prd); return h.success(prd);
    });
    const settled = expect(running).resolves.toMatchObject({ success: true });
    await vi.advanceTimersByTimeAsync(500);
    await settled;
    expect(attempts).toBe(2);
    const actual = (engine.reasonStructured as ReturnType<typeof vi.fn>).mock.calls;
    expect(actual).toHaveLength(2);
    for (const args of actual) {
      expectCompletePrompt(String(args[0]), key === "agent2" ? "creative" : "production", value);
    }
    expect(built).toHaveLength(1);
    const first = String(actual[0]![0]), second = String(actual[1]![0]);
    if (shrink === "partial-authority") {
      // Native truncation kept the complete schema and only part of G1.
      expect(second).toBe(first);
    } else {
      // The native example-removal branch removed the whole host suffix.
      expect(second).not.toBe(first); expect(second).toContain("[输出结构见schema]");
    }
    expect(actual[0]![1]).toBe(actual[1]![1]); expect(actual[0]![2]).toEqual(actual[1]![2]);
    expect(run.calls.map(call => call.agent)).toEqual(["agent2", "agent3"]);
    expect((run.engines[key === "agent2" ? 1 : 0]!.reasonStructured as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
  it.each(["agent2", "agent3"])("native %s preserves a customer quotation of the exact host heading and following text, including parse retry", async key => {
    const value = fixture(); lengthenAuthority(value);
    const kind = key === "agent2" ? "creative" : "production";
    const heading = `\n\n## 本次宿主 PRD ${kind} 响应 JSON Schema（${requirementHash(effectivePrdModelSchema(kind, PRDSchema, value.contract))}）\n`;
    const quotation = `客户引用开始${heading}客户引用之后的SENTINEL和完整原文必须保留`;
    value.discovery._originalStoryText = quotation;
    requirementRecord(value.metadata.brief, "brief").description += quotation;
    value.authority = preparePrdAuthority({ metadata: value.metadata, marketing: value.marketing, workDir: value.workDir, projectId: value.scope.projectId });
    const h = harness(), run = h.make(value), agent = requirementRecord(run.generator[key], key);
    const originalPrompt = invoke(agent, "_buildPrompt", value.discovery, { creativeCore: value.creative }) as string;
    const expectedPrompt = kind === "creative" ? originalPrompt : originalPrompt.replace(
      "9. 角色 portraitPath 留空字符串（系统后续填充），但需标注是否需要生成定妆照",
      "9. 角色 portraitPath 保持空字符串。按本次封闭角色 schema 输出，定妆照由后续正式阶段核验。",
    );
    const nativePrefix = `${String(invoke(agent, "_getSystemPrompt"))}\n\n${expectedPrompt}`;
    const engine = run.engines[key === "agent2" ? 0 : 1]!, reason = engine.reasonStructured as (...args: unknown[]) => unknown;
    let attempts = 0;
    engine.reasonStructured = vi.fn(async function (this: RequirementRecord, ...args: unknown[]) {
      if (++attempts === 1) throw new Error("synthetic JSON parse failure");
      return Reflect.apply(reason, this, args);
    });
    const running = withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run); await h.review(run, prd); return h.success(prd);
    });
    const settled = expect(running).resolves.toMatchObject({ success: true });
    await vi.advanceTimersByTimeAsync(500); await settled;
    const calls = (engine.reasonStructured as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const prompt = String(call[0]); expect(prompt.startsWith(nativePrefix)).toBe(true); expect(prompt).toContain(quotation);
      const ownSuffix = prompt.slice(nativePrefix.length);
      expect(ownSuffix.startsWith(heading)).toBe(true); expectCompletePrompt(ownSuffix, kind, value);
    }
    expect(calls[0]![0]).toBe(calls[1]![0]); expect(calls[0]![1]).toBe(calls[1]![1]); expect(calls[0]![2]).toEqual(calls[1]![2]);
    expect(run.calls.map(call => call.agent)).toEqual(["agent2", "agent3"]);
  });
});

describe("explicit delivery plans through the real native PRD generator", () => {
  it("carries exact execution text and separate deliverables without filling a model's omitted plan or changing either call contract", async () => {
    const value = fixture("DELIVERY-DECLARED"), text = "仅限封闭场地展示🙂";
    const description = "  原文开始\n持续警示：仅限封闭场地展示🙂；字号=短边4.5%，左右边距8%，墨迹范围12%至40%。\n保留引号\"与\\反斜线、{}[]及末尾空格  ";
    requirementRecord(value.metadata.brief, "brief").description = description;
    declareDelivery(value, { coverDelivery: "standalone", sidecarPolicy: "dialogue-and-composite-ass", persistentSubtitleText: text });
    const productionBefore = structuredClone(value.production), creativeBefore = structuredClone(value.creative), nativeSchemaBefore = structuredClone(PRDSchema);
    const h = harness(), run = h.make(value);
    await withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run), markdown = await h.review(run, prd), delivery = requirementRecord(prd.deliveryStandard, "delivery");
      const items = delivery.deliverables as RequirementRecord[];
      expect(items.filter(item => item.item === "cover")).toEqual([expect.objectContaining({ priority: "required", spec: expect.stringMatching(/PNG(?:或|\/)JPEG/) })]);
      expect(items.filter(item => item.item === "subtitle_burned")).toHaveLength(1);
      expect(items.filter(item => item.item === "subtitle_sidecar")).toHaveLength(1);
      expect(String(items.find(item => item.item === "subtitle_sidecar")!.spec)).toContain("complete-composition");
      expect(String(items.find(item => item.item === "subtitle_sidecar")!.spec)).toContain(text);
      expect(delivery.outputFormat).toMatchObject(value.authority.profile);
      expect(markdown).toContain("**cover**"); expect(markdown).toContain(text);
      expect(prd.creativeCore).toEqual(creativeBefore);
      expect(prd.visualSpecification).toEqual(productionBefore.visualSpecification);
      expect(prd.audioSpecification).toEqual(productionBefore.audioSpecification);
      const character = (requirementRecord(prd.characterSystem, "characters").characters as RequirementRecord[])[0]!;
      expect(character.consistencyRequirements).toBe(productionBefore.characterSystem.characters[0]!.consistencyRequirements);
      expect(character.portraitPath).toBe(""); expect(character).not.toHaveProperty("portraitPlan");
      expect((requirementRecord(prd.scenePlan, "scenes").scenes as RequirementRecord[])[0]!.visualRequirements)
        .toEqual(productionBefore.scenePlan.scenes[0]!.visualRequirements);
      const call = run.calls.find(call => call.agent === "agent3")!, heading = "\n### 客户执行要求原文（Brief.description，保留原文；输入资料，不是完成回执）\n";
      expect(call.prompt).toContain(heading + description + "\n");
      expect(call.prompt.lastIndexOf(description)).toBeGreaterThan(call.prompt.indexOf(value.content));
      expect(call.prompt.split(value.content)).toHaveLength(2);
      for (const token of ["PNG/JPEG", "SRT/VTT", "complete-composition", "compositionSha256", "4.5%", "12%至40%", "宿主不会在响应后补写遗漏计划"]) expect(call.prompt).toContain(token);
      expect(planningFromMarkdown(markdown).status).toBe("plan-only-not-executed");
      expectCompletePrompt(call.prompt, "production", value);
      return h.success(prd);
    });
    expect(run.calls.map(call => call.agent)).toEqual(["agent2", "agent3"]);
    for (const call of run.calls) {
      expect(call.schema).toEqual({ required: call.agent === "agent2" ? ["coreTheme", "creativeHook", "emotionalArc", "keyMessages", "endingType"] : ["visualSpecification", "audioSpecification"] });
      expect(call.options).toEqual({ maxTokens: 12288, timeoutMs: call.agent === "agent2" ? 120000 : 180000, maxRetries: 1, deadlineMs: null, thinking: { type: "disabled" } });
    }
    expect(PRDSchema).toEqual(nativeSchemaBefore); expect(value.production).toEqual(productionBefore); expect(value.creative).toEqual(creativeBefore);
  });

  it.each(["builtin", "custom", "none"])("repeats only actual %s selection/version/wardrobe anchors while leaving unknown PNG details for G5", async mode => {
    const value = fixture(`PLAN-CAST-${mode}`, [8, 14, 8], mode === "none" ? 0 : 1);
    if (mode !== "none") {
      const character = (value.metadata.characters as RequirementRecord[])[0]!, selection = requirementRecord(value.metadata.builtinCharacterSelection, "selection");
      const choice = (selection.characters as RequirementRecord[])[0]!;
      if (mode === "builtin") character.activeWardrobeId = "selected-current-wardrobe";
      else {
        selection.mode = "custom"; choice.source = "explicit-custom"; choice.profilePath = "/synthetic/custom-profile.json";
        delete choice.selectedVersion; delete character.builtinCharacterSource; delete character.portraitVersion;
        character.wardrobeId = "explicit-custom-wardrobe";
      }
    }
    refreshContract(value);
    const h = harness(), run = h.make(value), before = structuredClone(value.contract);
    await withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run), markdown = await h.review(run, prd), call = run.calls.find(call => call.agent === "agent3")!;
      const expectedCharacters = mode === "none" ? [] : [{ id: "builtin-person", name: "合成人物", ...(mode === "builtin"
        ? { portraitVersion: 2, activeWardrobeId: "selected-current-wardrobe" } : { wardrobeId: "explicit-custom-wardrobe" }) }];
      expect(planningCastFromPrompt(call.prompt)).toEqual({ selection: value.contract.cast.selection, characters: expectedCharacters });
      expect(call.prompt).toContain("已经给出的档案来源不得写成“待解析”");
      expect(call.prompt).toContain("“待解析和核验”仅适用于输入确实未提供的原始PNG路径");
      expect(call.prompt).toContain("不能提前批准");
      if (mode === "none") {
        expect(markdown).toContain("外观锚点与定妆照前置：不适用（cast.mode=none，与出镜角色合同一致）");
      }
      const characters = requirementRecord(prd.characterSystem, "characters").characters as RequirementRecord[];
      expect(characters.map(character => character.portraitPath)).toEqual(Array(mode === "none" ? 0 : 1).fill(""));
      expect(characters.map(character => character.consistencyRequirements)).toEqual(value.production.characterSystem.characters.map(character => character.consistencyRequirements));
      expect(planningFromMarkdown(markdown).characterPlans).toHaveLength(expectedCharacters.length);
      expect(value.contract).toEqual(before); return h.success(prd);
    });
    expect(run.calls.map(call => call.agent)).toEqual(["agent2", "agent3"]);
  });

  it.each([true, false])("displays the exact raw shotMapping enum array and retains the original G4 approved=%s decision", async approved => {
    const value = fixture(`PLAN-MAPPING-${approved}`);
    declareDelivery(value, { coverDelivery: "none", sidecarPolicy: "dialogue-only" });
    Object.assign(value.production.scenePlan.shotMapping[0]!, { estimatedShots: 2, shotBreakdownHint: ["wide", "close-up"] });
    Object.assign(value.production.scenePlan.shotMapping[1]!, { estimatedShots: 6, shotBreakdownHint: ["POV", "tracking", "static"] });
    Object.assign(value.production.scenePlan.shotMapping[2]!, { estimatedShots: 1, shotBreakdownHint: [] });
    const before = structuredClone(value.production), raw = structuredClone(value.production.scenePlan.shotMapping), h = harness(), run = h.make(value);
    run.system.g4Approved = approved;
    const operation = await withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run), prdBefore = structuredClone(prd), markdown = invoke(run.generator, "generateMarkdown", prd) as string;
      expect(planningFromMarkdown(markdown).shotMapping).toEqual(raw);
      expect(JSON.stringify(planningFromMarkdown(markdown).shotMapping)).toBe(JSON.stringify(raw));
      expect(markdown).toContain('"shotBreakdownHint": ['); expect(markdown).toContain('"close-up"');
      expect(prd).toEqual(prdBefore); expect(requirementRecord(prd.scenePlan, "scenePlan").shotMapping).toEqual(raw);
      const verdict = requirementRecord(await invoke(run.system, "_confirmPRD", markdown, prd), "G4 verdict");
      expect(verdict).toMatchObject({ approved, prd, suggestions: [] });
      return approved ? h.success(prd) : { success: false, confirmations: { G4_PRD: verdict } };
    });
    expect(operation.success).toBe(approved); expect(value.production).toEqual(before); expect(run.calls).toHaveLength(2);
  });

  it.each(["native-copy", "render", "g4"])("refuses changed rule-owned delivery at the %s boundary without model repair", async boundary => {
    const value = fixture(`PLAN-DELIVERY-TAMPER-${boundary}`); declareDelivery(value, { coverDelivery: "standalone" });
    const h = harness(), run = h.make(value);
    const change = (prd: RequirementRecord) => ((requirementRecord(prd.deliveryStandard, "delivery").deliverables as RequirementRecord[])
      .find(item => item.item === "cover")!.spec = "未审核的另一份封面要求");
    if (boundary === "native-copy") {
      const validate = run.generator._validateAndFill as (...args: unknown[]) => RequirementRecord;
      run.generator._validateAndFill = function (this: RequirementRecord, ...args: unknown[]) { const result = Reflect.apply(validate, this, args); change(result); return result; };
    }
    await expect(withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run);
      if (boundary === "native-copy") return h.success(prd);
      const markdown = invoke(run.generator, "generateMarkdown", prd) as string;
      change(prd);
      return boundary === "render" ? invoke(run.generator, "generateMarkdown", prd) : invoke(run.system, "_confirmPRD", markdown, prd);
    })).rejects.toThrow("PRD_DELIVERY_INVALID");
    expect(run.calls.map(call => call.agent)).toEqual(["agent2", "agent3"]); expect(run.system.minimalCalls).toBe(0);
  });

  it.each(["bad-hint", "zero-estimate", "missing-hints", "wrong-scene"])("retains strict rejection of a raw %s shotMapping without generating a replacement", async kind => {
    const value = fixture(`PLAN-RAW-MAPPING-${kind}`); declareDelivery(value, { coverDelivery: "none" });
    const mapping = value.production.scenePlan.shotMapping as RequirementRecord[];
    if (kind === "bad-hint") mapping[0]!.shotBreakdownHint = ["wide→close-up"];
    if (kind === "zero-estimate") mapping[0]!.estimatedShots = 0;
    if (kind === "missing-hints") delete mapping[0]!.shotBreakdownHint;
    if (kind === "wrong-scene") mapping[0]!.sceneId = "other-scene";
    const before = structuredClone(value.production), h = harness(), run = h.make(value);
    await expect(withPrdAuthorityScope(value.authority, () => h.generate(run))).rejects.toThrow();
    expect(value.production).toEqual(before); expect(run.calls.map(call => call.agent)).toEqual(["agent2", "agent3"]); expect(run.system.minimalCalls).toBe(0);
  });

  it("keeps interleaved runs' delivery declarations, original descriptions and raw rendered mappings isolated", async () => {
    const values = [fixture("PLAN-INTERLEAVED-A"), fixture("PLAN-INTERLEAVED-B")], h = harness();
    for (const [index, value] of values.entries()) {
      requirementRecord(value.metadata.brief, "brief").description = `完整执行原文ONLY-RUN-${index} 保留空格  `;
      declareDelivery(value, index === 0 ? { coverDelivery: "standalone", sidecarPolicy: "dialogue-and-composite-ass", persistentSubtitleText: "ONLY-A持续警示" }
        : { coverDelivery: "none", subtitleMode: "sidecar", sidecarPolicy: "dialogue-only" });
      Object.assign(value.production.scenePlan.shotMapping[0]!, { estimatedShots: index + 2, shotBreakdownHint: index === 0 ? ["close-up", "tracking"] : ["POV", "static"] });
    }
    const runs = values.map(value => h.make(value)), ready = [deferred<void>(), deferred<void>()], release = [deferred<void>(), deferred<void>()];
    const displayed: Array<{ index: number; profile: unknown; mapping: unknown }> = [];
    const pending = runs.map((run, index) => withPrdAuthorityScope(run.value.authority, async () => {
      await invoke(run.system, "_confirmRequirementList", "G3", run.value.list); ready[index]!.resolve(); await release[index]!.promise;
      const prd = await invoke(run.generator, "generate", run.value.discovery) as RequirementRecord, markdown = await h.review(run, prd);
      displayed.push({ index, profile: authorityFromMarkdown(markdown).profile, mapping: planningFromMarkdown(markdown).shotMapping });
      return h.success(prd);
    }));
    await Promise.all(ready.map(item => item.promise)); release[1]!.resolve(); await pending[1]; release[0]!.resolve(); await pending[0];
    expect(displayed.map(item => item.index)).toEqual([1, 0]);
    for (const [position, index] of [1, 0].entries()) {
      const value = values[index]!, other = values[index === 0 ? 1 : 0]!, call = runs[index]!.calls.find(call => call.agent === "agent3")!;
      expect(displayed[position]).toEqual({ index, profile: value.authority.profile, mapping: value.production.scenePlan.shotMapping });
      expect(call.prompt).toContain(String(requirementRecord(value.metadata.brief, "brief").description));
      expect(call.prompt).not.toContain(String(requirementRecord(other.metadata.brief, "brief").description));
      expect(call.prompt).not.toContain(other.marketing.g1Artifact.sha256); expect(runs[index]!.calls).toHaveLength(2);
    }
  });
});

describe("G4 executable plans and one native quality policy", () => {
  it.each([8, 28])("checks an explicit local tail layer schedule starting at %i s against the typed contract", async start => {
    const value = fixture(`POST-TAIL-CLOCK-${start}`, [10, 10, 10]);
    const tail = "封闭赛道车型示例";
    declareDelivery(value, { speechPolicy: "none", subtitleMode: "both", sidecarPolicy: "dialogue-and-composite-ass",
      persistentSubtitleText: "剧情演绎", postTailOverlayText: tail, postTailOverlaySeconds: 2, openWithCover: false, titleCard: false });
    const shotClock = `20–30 秒进入维修区停稳、摘盔后下车；最后仅在本地后期核对“${tail}”的净区`;
    const localClock = `${start}–30 秒在原生画面上由本地后期独立层叠加唯一产品名“${tail}”，只在 28 秒（含）至 30 秒（不含）显示`;
    value.production.scenePlan.scenes[2]!.visualRequirements = [shotClock, localClock];
    const h = harness(), run = h.make(value);
    const checked = withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run), markdown = await h.review(run, prd);
      expect(markdown).toContain(shotClock);
      expect(markdown).toContain(localClock);
      expect(markdown).toContain("28–30秒");
      return h.success(prd);
    });
    if (start === 28) await expect(checked).resolves.toMatchObject({ success: true });
    else await expect(checked).rejects.toMatchObject({ code: "PRD_DELIVERY_INVALID" });
    expect(value.production.scenePlan.scenes[2]!.visualRequirements).toEqual([shotClock, localClock]);
  });

  it("preserves a compound marketing genre and approved G3 evidence without adopting unrequested named references", async () => {
    const value = fixture("COMMERCIAL-PRD-REFERENCES");
    const upstream = requirementRecord(value.discovery.upstreamFields, "上游主题");
    upstream.type = "商业广告｜赛道竞速种草短片";
    value.discovery.referenceCases = { filmReferences: [{ title: "《极速风流》" }, { title: "《寿司之神》" }],
      adReferences: [{ brand: "Apple" }, { brand: "保时捷" }],
      styleReferences: ["低机位侧向横移", "参考《极速风流》的车内镜头"] };
    value.metadata.customerOriginalIntent = "给赛道产品做广告，电影参考选《寿司之神》。预览要支持 Apple 手机，不要参考《极速风流》。";
    value.authority = preparePrdAuthority({ metadata: value.metadata, marketing: value.marketing, workDir: value.workDir, projectId: value.scope.projectId });
    const evidence = structuredClone(value.discovery.referenceCases), h = harness(), run = h.make(value);
    await withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run), markdown = await h.review(run, prd);
      expect(prd.productPositioning).toMatchObject({ productType: "商业广告", genre: upstream.type });
      expect(prd.referenceCases).toEqual({ filmReferences: ["《寿司之神》"], adReferences: [], styleReferences: ["低机位侧向横移"] });
      expect(markdown).not.toMatch(/剧情短片|极速风流|Apple|保时捷/);
      for (const { prompt } of run.calls) {
        expect(prompt).toContain("具体的镜头、构图、光线、节奏或声音手法");
        expect(prompt.split("参考影片:")[1]?.split("\n")[0]).not.toMatch(/极速风流|Apple|保时捷/);
      }
      return h.success(prd);
    });
    expect(value.discovery.referenceCases).toEqual(evidence);
  });

  it("keeps actual model visual and audio references visible to an independent G4 rejection", async () => {
    const value = fixture("UNAPPROVED-NAMED-DRAFT");
    value.discovery.referenceCases = { filmReferences: [{ title: "《极速风流》" }], adReferences: [{ brand: "Apple" }], styleReferences: ["贴地横移"] };
    value.production.visualSpecification.visualReferences = ["模仿《极速风流》的镜头"];
    requirementRecord(value.production.audioSpecification, "音频草案").audioReferences = ["按《爆裂鼓手》的节奏做声音"];
    const h = harness(), run = h.make(value);
    run.system.g4Approved = false;
    await withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run);
      const markdown = invoke(run.generator, "generateMarkdown", prd) as string;
      expect(markdown).toContain("模仿《极速风流》的镜头");
      expect(markdown).toContain("按《爆裂鼓手》的节奏做声音");
      expect(prd.referenceCases).toMatchObject({ filmReferences: ["客户未指定命名影片，采用本次视觉规格中的摄影手法"], adReferences: [] });
      const decision = requirementRecord(await invoke(run.system, "_confirmPRD", markdown, prd), "G4 独立裁决");
      expect(decision.approved).toBe(false);
      return { success: false };
    });
    expect(run.calls).toHaveLength(2);
  });

  it.each([
    { difficulty: "easy", thresholds: { visual: 0.75, audio: 0.70, narrative: 0.75, consistency: 0.70 } },
    { difficulty: "medium", thresholds: { visual: 0.80, audio: 0.75, narrative: 0.85, consistency: 0.75 } },
    { difficulty: "hard", thresholds: { visual: 0.85, audio: 0.80, narrative: 0.90, consistency: 0.80 } },
    { difficulty: "extreme", thresholds: { visual: 0.90, audio: 0.85, narrative: 0.95, consistency: 0.85 } },
  ])("uses actual $difficulty Agent4 thresholds for production, acceptance and fallback without extra model calls", async ({ difficulty, thresholds }) => {
    const value = fixture(`QUALITY-POLICY-${difficulty}`), h = harness();
    requirementRecord(value.discovery.upstreamFields, "upstream").difficulty = difficulty;
    const run = h.make(value), before = structuredClone(value.production);
    await withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run), markdown = await h.review(run, prd);
      expect(requirementRecord(prd.productionConstraints, "constraints").qualityThresholds).toEqual(thresholds);
      const delivery = requirementRecord(prd.deliveryStandard, "delivery");
      expect(delivery.acceptanceCriteria).toEqual(thresholds);
      expect(delivery.fallbackPlan).toEqual({ trigger: `视觉质量低于 ${thresholds.visual} 或连续 2 次迭代无改善`,
        action: "降低视觉复杂度，使用 simpler prompt，减少特效需求", expectedOutput: "降低视觉震撼度但保证品牌信息传达" });
      expect(delivery.revisionPolicy).toEqual({ maxRevisions: 1, revisionScope: ["visual", "audio", "narrative"] });
      expect(markdown).toContain(`视觉质量：${thresholds.visual}`);
      expect(markdown).toContain(`叙事质量：${thresholds.narrative}`);
      expect(planningFromMarkdown(markdown).continuityCheckpoints).toEqual(delivery.continuityCheckpoints);
      const displayQuality = requirementRecord(planningFromMarkdown(markdown).qualityPolicy, "display quality");
      expect(displayQuality.thresholds).toEqual(thresholds); expect(displayQuality.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(displayQuality).not.toHaveProperty("production"); expect(displayQuality).not.toHaveProperty("nativeAcceptance");
      expect(markdown).toContain('"status": "plan-only-not-executed"');
      expect(prd.audioSpecification).toEqual(before.audioSpecification);
      expect(prd.visualSpecification).toEqual(before.visualSpecification);
      expect(value.production).toEqual(before);
      return h.success(prd);
    });
    expect(run.calls.map(call => call.agent)).toEqual(["agent2", "agent3"]);
    expect(Object.hasOwn(requirementRecord(run.generator.agent5, "original Agent5"), "_buildAcceptanceCriteria")).toBe(false);
  });

  it("keeps a stricter original Agent5 dimension without increasing its rule-call budget", async () => {
    const value = fixture("QUALITY-POLICY-STRICTER"), h = harness(), run = h.make(value);
    const agent = requirementRecord(run.generator.agent5, "Agent5");
    agent._buildAcceptanceCriteria = vi.fn(() => ({ visual: 0.93, audio: 0.90, narrative: 0.78, consistency: 0.91 }));
    agent._buildFallbackPlan = vi.fn(() => ({ trigger: "视觉质量低于 0.93 或连续 3 次迭代无改善", action: "原生动作完整保留", expectedOutput: "原生预期完整保留" }));
    await withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run), expected = { visual: 0.93, audio: 0.90, narrative: 0.85, consistency: 0.91 };
      expect(requirementRecord(prd.productionConstraints, "constraints").qualityThresholds).toEqual(expected);
      expect(requirementRecord(prd.deliveryStandard, "delivery").acceptanceCriteria).toEqual(expected);
      expect(requirementRecord(prd.deliveryStandard, "delivery").fallbackPlan).toEqual({
        trigger: "视觉质量低于 0.93 或连续 3 次迭代无改善", action: "原生动作完整保留", expectedOutput: "原生预期完整保留" });
      await h.review(run, prd); return h.success(prd);
    });
    expect(agent._buildAcceptanceCriteria).toHaveBeenCalledTimes(1); expect(agent._buildFallbackPlan).toHaveBeenCalledTimes(1);
    expect(run.calls).toHaveLength(2);
  });

  it.each([
    { tier: "premium", thresholds: { visual: 0.85, audio: 0.80, narrative: 0.85, consistency: 0.80 }, iterations: 3 },
    { tier: "film", thresholds: { visual: 0.92, audio: 0.88, narrative: 0.92, consistency: 0.90 }, iterations: 3 },
  ])("the real Agent5 $tier budget path retains its higher thresholds, trigger and revision policy", async ({ tier, thresholds, iterations }) => {
    const value = fixture(`QUALITY-NATIVE-${tier}`), h = harness(), run = h.make(value);
    const agent = requirementRecord(run.generator.agent5, "Agent5"), process = agent.process as (...args: unknown[]) => unknown;
    const actual = vi.fn(function (this: RequirementRecord, ...args: unknown[]) {
      // Exercise the actual native Agent5 implementation with its existing fifth
      // argument; the pinned top-level generator currently omits that argument.
      return Reflect.apply(process, this, [...args.slice(0, 4), { qualityTier: tier }]);
    });
    agent.process = actual;
    await withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run), delivery = requirementRecord(prd.deliveryStandard, "delivery");
      expect(requirementRecord(prd.productionConstraints, "constraints").qualityThresholds).toEqual(thresholds);
      expect(delivery.acceptanceCriteria).toEqual(thresholds);
      expect(requirementRecord(delivery.fallbackPlan, "fallback").trigger).toBe(`视觉质量低于 ${thresholds.visual} 或连续 ${iterations} 次迭代无改善`);
      expect(requirementRecord(delivery.revisionPolicy, "revision").maxRevisions).toBe(tier === "film" ? 3 : 2);
      await h.review(run, prd); return h.success(prd);
    });
    expect(actual).toHaveBeenCalledTimes(1); expect(run.calls).toHaveLength(2);
  });

  it("native text-field quality between the old75 and current83 fails against the actual canonical PRD", async () => {
    const value = fixture("QUALITY-ACTUAL-CONSUMER"), h = harness(), run = h.make(value), quality = new QualityGate();
    const shot = { shotId: "S10", scene: "封闭场地人物在整车旁观察轮廓保持真实空间关系", mood: "情绪平静自然",
      camera_movement: "固定机位缓慢推进镜头主体人物与商品完整清楚", lighting: "清楚自然照明", action: "人物缓慢点头",
      timeline: "T00:00-00:05测试", prompt: "完整当前镜头保持自然物理空间与人物商品关系，摄影语言和动作细节清楚。".repeat(3), backgroundSoundString: "清楚的自然环境声音" };
    await withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run);
      const old = requirementRecord(Reflect.apply(nativeQuality, quality, [[shot], { deliveryStandard: { acceptanceCriteria: { visual: 0.75, narrative: 0.75 } } }]), "old native quality");
      const current = requirementRecord(Reflect.apply(nativeQuality, quality, [[shot], prd]), "canonical native quality");
      const score = Number((current.checks as RequirementRecord[])[0]!.overallScore);
      expect(score).toBeGreaterThanOrEqual(75); expect(score).toBeLessThan(83);
      expect(old.passed).toBe(true); expect(current.passed).toBe(false);
      await h.review(run, prd); return h.success(prd);
    });
  });

  it.each(["production", "acceptance", "fallback"])("refuses pre-G4 %s quality drift without a repair call", async target => {
    const value = fixture(`QUALITY-DRIFT-${target}`), h = harness(), run = h.make(value);
    await expect(withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run), constraints = requirementRecord(prd.productionConstraints, "constraints"), delivery = requirementRecord(prd.deliveryStandard, "delivery");
      if (target === "production") requirementRecord(constraints.qualityThresholds, "thresholds").visual = 0.70;
      if (target === "acceptance") requirementRecord(delivery.acceptanceCriteria, "acceptance").narrative = 0.70;
      if (target === "fallback") requirementRecord(delivery.fallbackPlan, "fallback").trigger = "降低要求继续";
      return h.review(run, prd);
    })).rejects.toThrow("PRD_QUALITY_CHANGED");
    expect(run.calls).toHaveLength(2);
  });

  it.each(["missing", "NaN", "out-of-range", "extra-key", "changed-fallback"])("rejects %s rule contract drift without a silent default", async mode => {
    const value = fixture(`QUALITY-BAD-${mode}`), h = harness(), run = h.make(value), agent = requirementRecord(run.generator.agent5, "Agent5");
    if (mode === "changed-fallback") agent._buildFallbackPlan = () => ({ trigger: "视觉质量低于 0.99 或连续 2 次迭代无改善", action: "原生动作", expectedOutput: "原生预期" });
    else {
      const thresholds: RequirementRecord = { visual: 0.75, audio: 0.70, narrative: 0.75, consistency: 0.70 };
      if (mode === "missing") delete thresholds.audio;
      if (mode === "NaN") thresholds.visual = Number.NaN;
      if (mode === "out-of-range") thresholds.narrative = 1.1;
      if (mode === "extra-key") thresholds.unrecognized = 0.8;
      agent._buildAcceptanceCriteria = () => thresholds;
    }
    await expect(withPrdAuthorityScope(value.authority, () => h.generate(run)))
      .rejects.toThrow(mode === "changed-fallback" ? "PRD_VENDOR_UNAVAILABLE" : "PRD_QUALITY_INVALID");
    expect(run.calls).toHaveLength(2); expect(run.system.minimalCalls).toBe(0);
  });

  it("asks the real Agent3 to author PNG and delivery verification plans in allowed fields, then displays its exact response", async () => {
    const value = fixture("EXECUTABLE-G4"), plan = "本次人物 builtin-person，profile /synthetic/profile.json 摘要" + "a".repeat(64)
      + "；服装沿用当前版本。G5 前从档案解析原始 front/closeup PNG 并复用，具体路径和字节 G5 前待解析和核验；核对人物版本、服装、来源和用途，不符则停止，当前没有 G5 通过。";
    const audio = "原生声音按原始片段音轨与时长核对，原速拼接，不加速口播、不换声、不补 TTS；后期对照原源实际听音与时间线，当前未执行。";
    const subtitle = "持续警示文案来自本次 Brief，0秒至片尾连续显示；选择平台上下安全区并实画检查字号、对比度和遮挡；烧录与sidecar逐条同文同时间核对，当前未执行。";
    value.production.characterSystem.characters[0]!.consistencyRequirements = plan;
    value.production.audioSpecification.soundDesign = audio;
    value.production.scenePlan.scenes[0]!.visualRequirements = [subtitle];
    const before = structuredClone(value.production), h = harness(), run = h.make(value);
    await withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run), markdown = await h.review(run, prd), call = run.calls.find(call => call.agent === "agent3")!;
      expect(call.prompt).toContain("由本次模型填写现有字段"); expect(call.prompt).toContain("原始 front/closeup PNG");
      expect(call.prompt).toContain("G5 前待解析和核验"); expect(call.prompt).toContain("安全区"); expect(call.prompt).toContain("覆盖起止");
      expect(call.prompt).toContain("sidecar"); expect(call.prompt).toContain("不加速口播");
      expect(schemaFromPrompt(call.prompt, "production")).toEqual(effectivePrdModelSchema("production", PRDSchema, value.contract));
      expect((requirementRecord(prd.characterSystem, "characters").characters as RequirementRecord[])[0]).toMatchObject({ consistencyRequirements: plan, portraitPath: "" });
      expect(prd.audioSpecification).toEqual(before.audioSpecification);
      expect((requirementRecord(prd.scenePlan, "scenePlan").scenes as RequirementRecord[])[0]!.visualRequirements).toEqual([subtitle]);
      expect(markdown).toContain(plan); expect(markdown).toContain(audio); expect(markdown).toContain(subtitle);
      expect(markdown).toContain("没有补写模型计划"); expect(markdown).toContain("不证明图片、字幕、听音或成片已经验证");
      expect(value.production).toEqual(before); return h.success(prd);
    });
    expect(run.calls.map(call => call.agent)).toEqual(["agent2", "agent3"]);
    expect(run.calls[0]!.prompt).not.toContain("## 本次 G4 制作执行计划");
  });

  it("does not add plans to the response when the real model omits their substance, leaving the G4 reviewer to decide", async () => {
    const value = fixture("NO-INVENTED-PLAN"), h = harness(), run = h.make(value), before = structuredClone(value.production);
    await withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run); run.system.g4Approved = false;
      const markdown = await h.review(run, prd);
      expect((requirementRecord(prd.characterSystem, "characters").characters as RequirementRecord[])[0]!.consistencyRequirements)
        .toBe(before.characterSystem.characters[0]!.consistencyRequirements);
      expect(prd.audioSpecification).toEqual(before.audioSpecification);
      expect(markdown).toContain("缺失计划继续交本次 G4 判断");
      return { success: false };
    });
    expect(run.calls).toHaveLength(2);
  });

  it("still rejects a model's undeclared portraitPlan instead of weakening the strict production schema", async () => {
    const value = fixture("NO-NEW-PORTRAIT-KEY"), h = harness();
    (value.production.characterSystem.characters[0] as RequirementRecord).portraitPlan = "不能新增字段";
    const run = h.make(value);
    await expect(withPrdAuthorityScope(value.authority, () => h.generate(run))).rejects.toThrow("包含未声明字段");
    expect(run.calls).toHaveLength(2);
  });

  it.each([1, 0])("the real G4 deterministic gate accepts the complete rendered plan for %i selected characters without placeholder leakage", async count => {
    const value = fixture(`PLAN-REAL-G4-${count}`, [8, 14, 8], count), h = harness(), run = h.make(value);
    await withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run), before = structuredClone(prd), markdown = await h.review(run, prd);
      const checks = actualG4Checks(value, markdown);
      expect(checks.map(check => check.id)).toEqual(["content-present", "no-placeholder", "min-length"]);
      expect(checks.every(check => check.pass === true)).toBe(true);
      expect(planningFromMarkdown(markdown).characterPlans).toHaveLength(count);
      expect(prd).toEqual(before); return h.success(prd);
    });
    expect(run.calls).toHaveLength(2);
  });

  it("does not hide unrelated nullable source data from the real G4 no-placeholder check", async () => {
    const value = fixture("PLAN-NULL-IS-VISIBLE"), character = (value.metadata.characters as RequirementRecord[])[0]!;
    character.unverifiedSourceNote = null; refreshContract(value);
    const h = harness(), run = h.make(value);
    await withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run), markdown = invoke(run.generator, "generateMarkdown", prd) as string;
      expect(markdown).toContain('"unverifiedSourceNote": null');
      expect(actualG4Checks(value, markdown).find(check => check.id === "no-placeholder")?.pass).toBe(false);
      expect((planningFromMarkdown(markdown).characterPlans as RequirementRecord[])[0]!.source).toHaveProperty("unverifiedSourceNote", null);
      return { success: false };
    });
    expect(run.calls).toHaveLength(2);
  });
});

function truthFixture(name: string, durations?: number[]) {
  const value = fixture(name, durations), original = JSON.parse(value.content) as RequirementRecord, facts = requirementRecord(original.facts, "facts");
  const sourceHash = "c".repeat(64), fact = "仅限封闭场地";
  facts.sources = [{ sourceId: "source-media", textSha256: sourceHash, finalUrl: "https://media.example.test/report" }];
  facts.restrictions = ["不得虚构用户口碑或竞品主张"];
  requirementRecord((facts.stages as RequirementRecord[])[0]!.facts, "A1 facts").claims = [{ claimId: "claim-prerequisite", status: "source-bound", value: fact, sourceId: "source-media", textSha256: sourceHash }];
  value.content = JSON.stringify(original); writeFileSync(value.file, value.content);
  value.marketing.g1Artifact = { path: value.file, content: value.content, sha256: digest(value.content) };
  value.marketing.g1Proof.evidence = [{ path: value.file, sha256: digest(value.content), scope: "complete-text" }];
  value.authority = preparePrdAuthority({ metadata: value.metadata, marketing: value.marketing, workDir: value.workDir, projectId: value.scope.projectId });
  return { value, fact, sourceHash, raw: [`使用前提：${fact}（信源：未标注）——镜头叙事不得与此前提矛盾`,
    "宣称上限：不得超出官方口径——排量：9999cc；部件：未指定硬件", "禁用宣称：禁止虚构用户口碑"] };
}

describe("native truth-check preserves verdicts and scopes internal fact use to accepted G1 sources", () => {
  it.each([true, false])("uses only execution sources for a frozen no-speech PRD (%s) and preserves original G3", async frozen => {
    const { value, raw } = truthFixture(`VISUAL-EXECUTION-${frozen}`, [10, 10, 10]), h = harness();
    const audienceCopy = "UNAPPROVED-AUDIENCE-0.5S：一条另加的台词或字幕";
    const riskCopy = "UNBOUND-320RR：未核验型号不能作为执行限制";
    const referenceCopy = "G3参考备选：首段末帧主角车头刚越过第一辆对手车后轮";
    const authoredSegments = ["第一段原始动作与声音", "第二段原始动作与声音", "第三段原始动作与声音"];
    Object.assign(requirementRecord(value.discovery.audienceProfile, "audience"), {
      emotionTriggers: [audienceCopy, "另一项模型推测"], contentExpectations: [audienceCopy],
    });
    value.discovery.riskAssessment = { technicalRisks: [], businessConstraints: [riskCopy] };
    value.discovery.referenceCases = { filmReferences: [], adReferences: [], styleReferences: [referenceCopy] };
    value.discovery._originalStoryText = "用户原创动作：主角在封闭场地观察商品。";
    const unboundNotes = "UNBOUND-G2-NOTES：双语字幕轨，三个场景之间三次硬切";
    Object.assign(requirementRecord(value.discovery.upstreamFields, "upstream"), { special_notes: unboundNotes, tone: "冷酷精密" });
    if (frozen) requirementRecord(value.metadata.brief, "brief").segmentContract = {
      count: 3, totalSeconds: 30, secondsPerSegment: 10, hardCuts: true,
      intervals: authoredSegments.map((brief, index) => ({ startSec: index * 10, endSec: (index + 1) * 10, brief })),
    };
    declareDelivery(value, { speechPolicy: "none", sidecarPolicy: "dialogue-and-composite-ass", persistentSubtitleText: "仅限封闭场地" });
    const nativeBefore = structuredClone(value.discovery), contractBefore = structuredClone(value.contract), run = h.make(value);
    run.system.truthStage = { pass: true, blocking: false, degraded: false, conflicts: [], issues: [], factRedLines: raw };
    await withPrdAuthorityScope(value.authority, async () => {
      invoke(run.system, "_runProductTruthCheckGate", structuredClone(value.metadata), {});
      const prd = await h.generate(run), markdown = await h.review(run, prd);
      const constraints = requirementRecord(prd.productionConstraints, "constraints");
      const audience = requirementRecord(prd.audienceProfile, "audience");
      const execution = productionModelInput("独立模型工位的真实输入");
      const creativePrompt = run.calls[0]!.prompt;
      const items = requirementRecord(prd.deliveryStandard, "delivery").deliverables as RequirementRecord[];
      expect(items.find(item => item.item === "subtitle_sidecar")?.spec).toMatch(/完整组合ASS.+SRT\/VTT.+不适用/);
      expect(items.find(item => item.item === "subtitle_burned")?.spec).toContain("不新增台词字幕");
      expect(creativePrompt).toContain(String(value.discovery._originalStoryText));
      expect(prd._workloomRequirementContract).toEqual(contractBefore);
      expect(value.discovery).toEqual(nativeBefore);
      expect(value.contract).toEqual(contractBefore);
      if (frozen) {
        expect(audience.contentExpectations).toEqual(authoredSegments);
        expect(audience.emotionTriggers).toEqual(value.contract.scenes.map(scene => scene.purpose));
        expect(constraints.businessConstraints).toEqual(expect.arrayContaining([expect.stringContaining("claim-prerequisite")]));
        expect(constraints.businessConstraints).not.toContain(riskCopy);
        expect(creativePrompt).toContain("与本次 3 个已审节点对应");
        expect(creativePrompt).toContain("setup→climax→resolution");
        expect(creativePrompt).toContain("段内升温写在对应节点的执行描述");
        const productionPrompt = run.calls[1]!.prompt;
        expect(productionPrompt).toContain("scenePlan.scenes[].emotionalBeat");
        expect(productionPrompt).toContain("visualSpecification.colorPalette.mood");
        expect(productionPrompt).toContain("本次 G2 已审调性：冷酷精密");
        expect(productionPrompt).toContain("shotMapping.estimatedShots 每场写 1");
        expect(productionPrompt).toContain("只在声明的结尾区间");
        expect(constraints.technicalConstraints).toEqual(expect.arrayContaining([expect.stringContaining("3 个连续生成片段，每段 10 秒，共 30 秒，相邻片段之间恰好 2 处硬切")]));
        expect(markdown).toContain("不增加双语轨");
        expect(creativePrompt).not.toContain("P0 必须能用一句钉子台词");
        for (const prompt of [...run.calls.map(call => call.prompt), execution.prompt, markdown]) {
          expect(prompt).not.toContain(audienceCopy);
          expect(prompt).not.toContain(riskCopy);
          expect(prompt).not.toContain(unboundNotes);
          expect(prompt).not.toContain(referenceCopy);
        }
        expect(productionPrompt).toContain("未采纳的 G3 风格建议只留在原始审核材料");
        expect(requirementRecord(prd.referenceCases, "参考案例").styleReferences).toEqual(["具体手法见本次视觉与声音规格"]);
        for (const prompt of [...run.calls.map(call => call.prompt), execution.prompt]) expect(prompt).toContain(value.content);
        const display = requirementRecord(authorityFromMarkdown(markdown).approvedRequirementContract, "display");
        expect(display).not.toHaveProperty("modelAudienceHypothesis");
        expect(display.originalModelAudienceHypothesisSha256).toBe(requirementHash(contractBefore.modelAudienceHypothesis));
      } else {
        expect(creativePrompt).toContain("P0 必须能用一句钉子台词");
        expect(creativePrompt).toContain(audienceCopy);
        expect(markdown).toContain(riskCopy);
        expect(markdown).toContain(unboundNotes);
        expect(markdown).toContain(referenceCopy);
        expect(run.calls[1]!.prompt).toContain(referenceCopy);
      }
      return h.success(prd);
    });
    expect(run.calls.map(call => call.agent)).toEqual(["agent2", "agent3"]);
  });

  it("changes the actual inherited constraints before generation while retaining complete original G1 and diagnostic redlines", async () => {
    const input = truthFixture("TRUTH-REAL-PAYLOAD"), { value, raw } = input, h = harness(), run = h.make(value);
    const metadata = structuredClone(value.metadata), result: RequirementRecord = {}, stage = { pass: false, blocking: false, degraded: false,
      notes: 2, conflicts: [], issues: ["原生缺维度意见完整保留"], factRedLines: raw };
    run.system.truthStage = stage;
    const verdict = run.system.truthVerdict;
    await withPrdAuthorityScope(value.authority, async () => {
      expect(invoke(run.system, "_runProductTruthCheckGate", metadata, result)).toBe(verdict);
      const actual = requirementRecord(requirementRecord(result.stages, "stages").truthCheck, "truth");
      const { factRedLines, _workloomNativeFactRedLines, ...unchanged } = actual;
      const { factRedLines: _raw, ...original } = stage;
      expect(unchanged).toEqual(original); expect(_workloomNativeFactRedLines).toEqual(raw);
      expect(metadata._workloomNativeFactRedLines).toEqual(raw); expect(metadata._factRedLines).toEqual(factRedLines);
      const lines = factRedLines as string[], active = JSON.stringify(lines);
      expect(active).toContain(value.marketing.g1Artifact.sha256); expect(active).toContain("claim-prerequisite");
      expect(active).toContain("source-media"); expect(active).toContain("https://media.example.test/report"); expect(active).toContain(input.sourceHash);
      expect(active).toContain("不得虚构用户口碑或竞品主张"); expect(active).toContain("客户 Brief 禁用的参数、部件、背书或比较");
      expect(active).not.toContain("9999cc"); expect(active).not.toContain("未指定硬件"); expect(active).not.toContain("不得超出官方口径");
      const prd = await h.generate(run);
      // This is the pinned caller's existing inheritance operation, now using
      // the changed real metadata payload rather than a display substitution.
      (requirementRecord(prd.productionConstraints, "constraints").businessConstraints as string[]).push(...lines);
      const markdown = await h.review(run, prd);
      expect(JSON.stringify(prd.productionConstraints)).toContain("claim-prerequisite");
      expect(JSON.stringify(prd.productionConstraints)).not.toContain("9999cc");
      expect(markdown).toContain("source-media"); expect(value.content).toBe(value.marketing.g1Artifact.content);
      for (const call of run.calls) { expect(call.prompt).toContain(value.content); expect(call.prompt).toContain(JSON.stringify(lines)); }
      return h.success(prd);
    });
    expect(run.system.truthCalls).toBe(1); expect(run.calls).toHaveLength(2); expect(raw).toEqual(stage.factRedLines);
  });

  it.each(["missing-source", "source-hash-mismatch", "duplicate-source", "duplicate-claim"])("keeps %s attribution explicitly unverified without manufacturing official provenance", async mode => {
    const { value, raw } = truthFixture(`TRUTH-${mode}`), original = JSON.parse(value.content) as RequirementRecord, facts = requirementRecord(original.facts, "facts");
    const sources = facts.sources as RequirementRecord[], claims = requirementRecord((facts.stages as RequirementRecord[])[0]!.facts, "facts").claims as RequirementRecord[];
    if (mode === "missing-source") facts.sources = [];
    if (mode === "source-hash-mismatch") sources[0]!.textSha256 = "f".repeat(64);
    if (mode === "duplicate-source") sources.push(structuredClone(sources[0]!));
    if (mode === "duplicate-claim") claims.push(structuredClone(claims[0]!));
    value.content = JSON.stringify(original); writeFileSync(value.file, value.content);
    value.marketing.g1Artifact = { path: value.file, content: value.content, sha256: digest(value.content) };
    value.marketing.g1Proof.evidence = [{ path: value.file, sha256: digest(value.content), scope: "complete-text" }];
    value.authority = preparePrdAuthority({ metadata: value.metadata, marketing: value.marketing, workDir: value.workDir, projectId: value.scope.projectId });
    const h = harness(), run = h.make(value), metadata = structuredClone(value.metadata), result = {};
    run.system.truthStage = { pass: false, blocking: false, degraded: false, conflicts: [], issues: [], factRedLines: raw };
    await withPrdAuthorityScope(value.authority, () => invoke(run.system, "_runProductTruthCheckGate", metadata, result));
    const lines = JSON.stringify(metadata._factRedLines);
    expect(lines).toContain("没有唯一的本次 G1 claim/source 绑定，来源未核实");
    expect(lines).not.toContain("原始来源 https://media"); expect(lines).not.toContain("不得超出官方口径");
    expect(metadata._workloomNativeFactRedLines).toEqual(raw); expect(run.calls).toHaveLength(0);
  });

  it.each(["blocked", "degraded", "bridge-error"])("preserves the original native %s decision and diagnostics without another model call", async mode => {
    const { value, raw } = truthFixture(`TRUTH-DECISION-${mode}`), h = harness(), run = h.make(value), metadata = structuredClone(value.metadata), result: RequirementRecord = {};
    const verdict = { blocking: mode === "blocked", degraded: mode !== "blocked" };
    const common = { pass: mode === "blocked" ? false : null, blocking: verdict.blocking, degraded: verdict.degraded,
      conflicts: mode === "blocked" ? [{ type: "原始创意冲突", banned: "真实禁用内容" }] : [], issues: ["原生意见"], error: mode === "bridge-error" ? "原生桥错误" : "" };
    run.system.truthVerdict = verdict;
    run.system.truthStage = mode === "bridge-error" ? common : { ...common, factRedLines: raw };
    await withPrdAuthorityScope(value.authority, () => {
      expect(invoke(run.system, "_runProductTruthCheckGate", metadata, result)).toBe(verdict);
      expect(requirementRecord(result.stages, "stages").truthCheck).toMatchObject(common);
      if (mode === "bridge-error") expect(requirementRecord(result.stages, "stages").truthCheck).toEqual(common);
      return { success: false };
    });
    expect(run.calls).toHaveLength(0); expect(run.system.truthCalls).toBe(1);
  });

  it("unbound truth-check returns byte-equivalent native data and restores its exact original descriptor", async () => {
    const { value, raw } = truthFixture("TRUTH-LEGACY"), h = harness(), run = h.make(value), metadata = structuredClone(value.metadata), result: RequirementRecord = {};
    run.system.truthStage = { pass: false, degraded: false, conflicts: [{ keep: "original" }], factRedLines: raw };
    await withPrdAuthorityScope(undefined, () => {
      expect(invoke(run.system, "_runProductTruthCheckGate", metadata, result)).toBe(run.system.truthVerdict);
    });
    expect(metadata._factRedLines).toEqual(raw); expect(metadata).not.toHaveProperty("_workloomNativeFactRedLines");
    expect(requirementRecord(result.stages, "stages").truthCheck).toEqual(run.system.truthStage);
    h.dispose(); expect(Object.getOwnPropertyDescriptor(h.prototype, "_runProductTruthCheckGate")).toEqual(h.before._runProductTruthCheckGate);
  });

  it("a bound truth receiver cannot run again after its private scope closes", async () => {
    const { value, raw } = truthFixture("TRUTH-CLOSED"), h = harness(), run = h.make(value);
    run.system.truthStage = { pass: true, conflicts: [], factRedLines: raw };
    await withPrdAuthorityScope(value.authority, () => invoke(run.system, "_runProductTruthCheckGate", structuredClone(value.metadata), {}));
    expect(() => invoke(run.system, "_runProductTruthCheckGate", structuredClone(value.metadata), {})).toThrow("PRD_SCOPE_CONFLICT");
    expect(run.system.truthCalls).toBe(1);
  });
});

describe("PRD failures remain fatal through native catches", () => {
  it.each([
    "corrected", "normal", "same-id", "twice-malformed", "blank-first", "unmeasured-first",
    "invalid-correction-schema", "duplicate-key-correction", "transport-error", "nonfrozen",
  ] as const)("uses only one fully bound native Agent2 correction: %s", async mode => {
    vi.useRealTimers();
    const value = fixture(`PRD-CREATIVE-SYNTAX-${mode}`, [10, 10, 10]);
    lengthenAuthority(value);
    const intervals = ["第一段完整输入", "第二段完整输入", "第三段完整输入"];
    if (mode !== "nonfrozen") requirementRecord(value.metadata.brief, "brief").segmentContract = {
      count: 3, totalSeconds: 30, secondsPerSegment: 10, hardCuts: true,
      intervals: intervals.map((brief, index) => ({ startSec: index * 10, endSec: (index + 1) * 10, brief })),
    };
    declareDelivery(value, { speechPolicy: "none" });
    value.discovery._originalStoryText = "完整原始动作、首尾切点和声音要求，不能用截取的草案替代。";
    const h = harness(), run = h.make(value);
    const baseUrl = "https://prd-creative-recovery.invalid/v1";
    const requests: Array<{ url: string; messages: ChatMessage[]; options: RequirementRecord }> = [];
    const invalid = '{"private":"PRIVATE_PREVIOUS_CREATIVE_DRAFT" "missingComma":1}';
    const creative = JSON.stringify(value.creative);
    const fetchImpl: typeof fetch = async (url, init) => {
      const { messages, ...options } = JSON.parse(String(init?.body));
      requests.push({ url: String(url), messages, options });
      const ordinal = requests.length;
      if (mode === "transport-error") return new Response("fixture upstream unavailable", { status: 503 });
      const text = ordinal === 1 ? mode === "normal" ? creative : mode === "blank-first" ? " " : invalid
        : mode === "twice-malformed" ? '{"broken" false}'
          : mode === "invalid-correction-schema" ? '{"coreTheme":"only"}'
            : mode === "duplicate-key-correction" ? '{"\\u0063oreTheme":"hidden duplicate",' + creative.slice(1) : creative;
      return Response.json({
        ...(mode === "unmeasured-first" && ordinal === 1 ? {} : { id: `native-creative-${mode === "same-id" ? 1 : ordinal}` }),
        object: "chat.completion", model: "deepseek-flash",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }],
        usage: { prompt_tokens: 300, completion_tokens: 100, total_tokens: 400, completion_tokens_details: { reasoning_tokens: 1 } },
      });
    };
    const provider = new OpenAiCompatibleProvider("deepseek-flash", { baseUrl, apiKey: "fixture-only", fetchImpl });
    requirementRecord(run.generator.agent2, "agent2")._llmEngine = new WorkloomLLMEngine({
      baseUrl, apiKey: "fixture-only", model: "deepseek-flash", scene: "preproduction",
      router: { providers: new Map([[provider.modelId, provider]]), sink: {
        recordModelTrace: async () => undefined, recordDegradation: async () => undefined, recordCircuitBreak: async () => undefined,
      } },
    });
    const accepted = mode === "corrected" || mode === "normal";
    const operation = withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run);
      await h.review(run, prd);
      return h.success(prd);
    });
    if (accepted) await expect(operation).resolves.toMatchObject({ success: true });
    else await expect(operation).rejects.toThrow();
    const expectedCalls = ["normal", "blank-first", "unmeasured-first", "transport-error", "nonfrozen"].includes(mode) ? 1 : 2;
    expect(requests).toHaveLength(expectedCalls);
    const first = requests[0]!;
    const firstText = first.messages.find(message => message.role === "user")!.content as string;
    expectCompletePrompt(firstText, "creative", value);
    expect(first.url).toBe(`${baseUrl}/chat/completions`);
    expect(first.options).toMatchObject({ model: "deepseek-flash", max_tokens: 393_216, response_format: { type: "json_object" } });
    if (requests.length === 2) {
      const next = requests[1]!;
      const corrected = next.messages.find(message => message.role === "user")!.content as string;
      const adapterSuffix = firstText.slice(firstText.lastIndexOf("\n\n【硬性输出要求】"));
      const [base, correction] = corrected.split("\n\n## 本次原生创意核心 JSON 格式修正\n");
      expect(digest(base + adapterSuffix)).toBe(digest(firstText));
      expect(correction).toContain("同一实际 schema");
      expect(corrected.endsWith(adapterSuffix)).toBe(true);
      expectCompletePrompt(corrected, "creative", value);
      expect(corrected).not.toContain("PRIVATE_PREVIOUS_CREATIVE_DRAFT");
      expect(next.messages.filter(message => message.role !== "user")).toEqual(first.messages.filter(message => message.role !== "user"));
      expect(next.options).toEqual(first.options);
      expect(next.url).toBe(first.url);
    }
    expect(run.calls.map(call => call.agent)).toEqual(accepted ? ["agent3"] : []);
    expect(run.system.minimalCalls).toBe(0);
  });

  it.each(["corrected", "still-invalid", "unmeasured-retry"])("uses one native complete Agent3 retry for a closed character shape, %s", async mode => {
    vi.useRealTimers();
    const value = fixture(`PRD-CHAR-RETRY-${mode}`), h = harness(), run = h.make(value);
    lengthenAuthority(value);
    value.discovery._originalStoryText = "冻结故事原文【目标JSON结构示例】后续内容不可截断";
    const first = structuredClone(value.production);
    Object.assign(first.characterSystem.characters[0]!, { privateUnexpectedKey: "PRIVATE_PREVIOUS_MODEL_OUTPUT" });
    const corrected = structuredClone(value.production);
    corrected.visualSpecification.lightingDirection = "同一原始拍摄要求下以硬侧光照亮赛道外侧与人物动作";
    const baseUrl = "https://prd-shape.invalid/v1";
    const requests: Array<{ url: string; messages: ChatMessage[]; options: RequirementRecord }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const { messages, ...options } = JSON.parse(String(init?.body));
      requests.push({ url: String(url), messages, options });
      return Response.json({
        ...(mode === "unmeasured-retry" && requests.length > 1 ? {} : { id: `native-prd-${requests.length}` }),
        model: "deepseek-flash",
        choices: [{ finish_reason: "stop", message: {
          content: JSON.stringify(requests.length === 1 || mode === "still-invalid" ? first : corrected),
        } }],
        usage: { prompt_tokens: 300, completion_tokens: 100, total_tokens: 400, completion_tokens_details: { reasoning_tokens: 1 } },
      });
    };
    const provider = new OpenAiCompatibleProvider("deepseek-flash", { baseUrl, apiKey: "test-only", fetchImpl });
    const adapter = new WorkloomLLMEngine({ baseUrl, apiKey: "test-only", model: "deepseek-flash",
      router: { providers: new Map([[provider.modelId, provider]]), sink: {
        recordModelTrace: async () => undefined, recordDegradation: async () => undefined, recordCircuitBreak: async () => undefined,
      } } });
    const agent = requirementRecord(run.generator.agent3, "agent3");
    agent._llmEngine = adapter;
    const attempt = withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run);
      await h.review(run, prd);
      return h.success(prd);
    }).then(result => ({ result, error: "" }), (error: Error) => ({ result: null, error: error.message }));
    const { result, error } = await attempt;
    expect(requests).toHaveLength(2);
    const original = requests[0]!, retry = requests[1]!;
    expect(retry.url).toBe(original.url);
    expect(retry.url).toBe(`${baseUrl}/chat/completions`);
    const firstPrompt = original.messages.find(message => message.role === "user")!.content as string;
    const secondPrompt = retry.messages.find(message => message.role === "user")!.content as string;
    const heading = "\n\n## 上一次原生制作规格结构校验反馈\n";
    expect(firstPrompt).not.toContain("但需标注是否需要生成定妆照");
    expect(firstPrompt).toContain("冻结故事原文【目标JSON结构示例】后续内容不可截断");
    expectCompletePrompt(firstPrompt, "production", value);
    expectCompletePrompt(secondPrompt, "production", value);
    const [unchanged, feedback] = secondPrompt.split(heading);
    const adapterSuffix = firstPrompt.slice(firstPrompt.lastIndexOf("\n\n【硬性输出要求】"));
    expect(unchanged + adapterSuffix).toBe(firstPrompt);
    expect(secondPrompt.endsWith(adapterSuffix)).toBe(true);
    expect(feedback).toContain('"/characterSystem/characters/0"');
    expect(feedback).toContain('"additionalProperties"');
    const itemSchema = effectivePrdModelSchema("production", PRDSchema, value.contract) as {
      properties: { characterSystem: { properties: { characters: { items: { properties: RequirementRecord } } } } };
    };
    expect(feedback).toContain(JSON.stringify(Object.keys(itemSchema.properties.characterSystem.properties.characters.items.properties)));
    expect(secondPrompt).not.toMatch(/privateUnexpectedKey|PRIVATE_PREVIOUS_MODEL_OUTPUT/);
    expect(retry.options).toEqual(original.options);
    if (mode === "still-invalid") {
      expect(error).toContain("/characterSystem/characters/0 包含未声明字段");
      expect(result).toBeNull();
    } else if (mode === "unmeasured-retry") {
      expect(error).toContain("Agent3 结构修正缺少已完成的原生模型响应");
      expect(result).toBeNull();
    } else {
      expect(error).toBe("");
      expect(result?.stages.prdGeneration.data).toMatchObject({ visualSpecification: corrected.visualSpecification });
    }
    expect(run.system.minimalCalls).toBe(0);
    expect(first.characterSystem.characters[0]).toHaveProperty("privateUnexpectedKey");
  });

  it.each([
    "corrected", "at-limit", "still-invalid", "unmeasured-first", "same-response-id", "wrong-item-type",
    "late-first", "late-before-retry", "late-retry", "nonfrozen", "transport-error", "duplicate-first",
  ] as const)(
    "bounds Agent3 audio references and admits one measured native structural retry only when warranted: %s", async mode => {
      vi.useRealTimers();
      const value = fixture(`PRD-AUDIO-REFERENCES-${mode}`, [10, 10, 10]);
      if (mode !== "nonfrozen") requirementRecord(value.metadata.brief, "brief").segmentContract = {
        count: 3, totalSeconds: 30, secondsPerSegment: 10, hardCuts: true,
        intervals: [0, 1, 2].map(index => ({ startSec: index * 10, endSec: (index + 1) * 10, brief: "原生声音与连续动作" })),
      };
      declareDelivery(value, { speechPolicy: "none", nativeAudio: true });
      value.discovery._originalStoryText = "完整原始制作要求【目标JSON结构示例】后续动作和原生声音不可截断";
      const h = harness(), run = h.make(value);
      const first = structuredClone(value.production), corrected = structuredClone(value.production);
      const firstAudio = requirementRecord(first.audioSpecification, "first audio"),
        correctedAudio = requirementRecord(corrected.audioSpecification, "corrected audio");
      const actualSchema = effectivePrdModelSchema("production", PRDSchema, value.contract) as {
        properties: { audioSpecification: { properties: { audioReferences: { maxItems: number } } } };
      };
      const { maxItems } = actualSchema.properties.audioSpecification.properties.audioReferences;
      firstAudio.audioReferences = mode === "wrong-item-type" ? [42]
        : Array.from({ length: maxItems + (mode === "at-limit" ? 0 : 1) }, (_, index) => `PRIVATE_PREVIOUS_AUDIO_REFERENCE_${index}`);
      correctedAudio.audioReferences = ["原速保留轮胎擦地和换挡声", "看台环境声从冲线到维修区自然收敛"];
      const before = structuredClone(firstAudio.audioReferences);
      const baseUrl = "https://prd-audio-shape.invalid/v1";
      const requests: Array<{ url: string; messages: ChatMessage[]; options: RequirementRecord }> = [];
      let elapsed = 0;
      const fetchImpl: typeof fetch = async (url, init) => {
        const { messages, ...options } = JSON.parse(String(init?.body));
        requests.push({ url: String(url), messages, options });
        const ordinal = requests.length;
        if (mode === "transport-error") return new Response("fixture upstream unavailable", { status: 503 });
        if ((mode === "late-first" && ordinal === 1) || (mode === "late-retry" && ordinal === 2)) elapsed = 180_001;
        if (mode === "late-before-retry" && ordinal === 1) setTimeout(() => { elapsed = 180_001; }, 0);
        const content = JSON.stringify(ordinal === 1 || mode === "still-invalid" ? first : corrected);
        return Response.json({
          ...(mode === "unmeasured-first" && ordinal === 1 ? {}
            : { id: `native-prd-audio-${mode === "same-response-id" ? 1 : ordinal}` }),
          object: "chat.completion", model: "deepseek-flash",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant",
            content: mode === "duplicate-first" ? '{"\\u0061udioSpecification":{},' + content.slice(1) : content } }],
          usage: { prompt_tokens: 300, completion_tokens: 100, total_tokens: 400, completion_tokens_details: { reasoning_tokens: 1 } },
        });
      };
      const provider = new OpenAiCompatibleProvider("deepseek-flash", { baseUrl, apiKey: "test-only", fetchImpl });
      requirementRecord(run.generator.agent3, "agent3")._llmEngine = new WorkloomLLMEngine({
        baseUrl, apiKey: "test-only", model: "deepseek-flash", scene: "preproduction",
        router: { providers: new Map([[provider.modelId, provider]]), sink: {
          recordModelTrace: async () => undefined, recordDegradation: async () => undefined, recordCircuitBreak: async () => undefined,
        } },
      });
      const currentTime = performance.now.bind(performance);
      const clock = vi.spyOn(performance, "now").mockImplementation(() => currentTime() + elapsed);
      const { result, error } = await withPrdAuthorityScope(value.authority, async () => {
        const prd = await h.generate(run);
        await h.review(run, prd);
        return h.success(prd);
      }).then(result => ({ result, error: "" }), (error: Error) => ({ result: null, error: error.message }))
        .finally(() => clock.mockRestore());
      expect(requests).toHaveLength(["corrected", "still-invalid", "same-response-id", "late-retry"].includes(mode) ? 2 : 1);
      const original = requests[0]!;
      const firstPrompt = original.messages.find(message => message.role === "user")!.content as string;
      expectCompletePrompt(firstPrompt, "production", value);
      expect(firstPrompt).toContain(`audioSpecification.audioReferences 必须是 0–${maxItems} 项`);
      expect(firstPrompt).toContain("占位配乐");
      expect(firstPrompt).toContain("可辨识人声");
      expect(original.options).toMatchObject({ model: "deepseek-flash", max_tokens: 393_216, response_format: { type: "json_object" } });
      if (requests.length === 2) {
        const retry = requests[1]!;
        expect(retry.url).toBe(original.url);
        expect(retry.options).toEqual(original.options);
        expect(retry.messages.filter(message => message.role !== "user")).toEqual(original.messages.filter(message => message.role !== "user"));
        const secondPrompt = retry.messages.find(message => message.role === "user")!.content as string;
        const [unchanged, feedback] = secondPrompt.split("\n\n## 上一次原生制作规格结构校验反馈\n");
        const adapterSuffix = firstPrompt.slice(firstPrompt.lastIndexOf("\n\n【硬性输出要求】"));
        expect(unchanged + adapterSuffix).toBe(firstPrompt);
        expect(secondPrompt.endsWith(adapterSuffix)).toBe(true);
        expect(feedback).toContain(JSON.stringify({ path: "/audioSpecification/audioReferences", keyword: "maxItems",
          observed: maxItems + 1, limit: maxItems }));
        expect(secondPrompt).not.toContain("PRIVATE_PREVIOUS_AUDIO_REFERENCE_");
        expectCompletePrompt(secondPrompt, "production", value);
      }
      if (mode === "corrected" || mode === "at-limit") {
        expect(error).toBe("");
        expect(result?.stages.prdGeneration.data).toMatchObject({ audioSpecification: mode === "corrected"
          ? corrected.audioSpecification : first.audioSpecification });
      } else {
        expect(result).toBeNull();
        const diagnostic = mode === "transport-error" ? "PRD_MODEL_UNVERIFIED"
          : mode === "late-before-retry" ? "Agent3 音频参考结构修正的原生路径或原时限已变化"
          : ["same-response-id", "late-retry"].includes(mode)
          ? "Agent3 音频参考结构修正未取得同一路径的新完整响应" : "/audioSpecification/audioReferences";
        expect(error).toContain(diagnostic);
      }
      expect(run.system.minimalCalls).toBe(0);
      expect(firstAudio.audioReferences).toEqual(before);
    },
  );

  it("refuses an unmeasured character shape failure without spending a structural retry", async () => {
    const value = fixture("PRD-CHAR-UNATTESTED"), h = harness();
    Object.assign(value.production.characterSystem.characters[0]!, { needsPortrait: true });
    const run = h.make(value);
    await expect(withPrdAuthorityScope(value.authority, () => h.generate(run))).rejects.toThrow("/characterSystem/characters/0 包含未声明字段");
    expect(run.calls.map(call => call.agent)).toEqual(["agent2", "agent3"]);
    expect(run.system.minimalCalls).toBe(0);
  });

  it.each([
    { label: "empty", references: [] }, { label: "six", references: Array(6).fill("合成构图参考") },
    { label: "missing", references: undefined }, { label: "not-array", references: "合成构图参考" }, { label: "wrong-item-type", references: [42] }
  ])("native production rejects invalid visualReferences $label without extra calls or repair", async ({ references }) => {
    const value = fixture(), h = harness(), visual = value.production.visualSpecification as unknown as RequirementRecord;
    if (references === undefined) delete visual.visualReferences; else visual.visualReferences = references;
    const before = structuredClone(value.production), run = h.make(value);
    await expect(withPrdAuthorityScope(value.authority, () => h.generate(run)))
      .rejects.toThrow(references === undefined ? "visualSpecification 缺少必需字段" : "visualReferences");
    expect(value.production).toEqual(before); expect(run.calls.map(call => call.agent)).toEqual(["agent2", "agent3"]);
    for (const call of run.calls) expectCompletePrompt(call.prompt, call.agent === "agent2" ? "creative" : "production", value);
    expect(run.system.minimalCalls).toBe(0);
  });
  it.each(["no-g3", "g3-rejected", "source-scene-changed", "cast-changed"])("rejects %s before a model call", async kind => {
    const value = fixture(), h = harness(), run = h.make(value);
    await expect(withPrdAuthorityScope(value.authority, async () => {
      if (kind === "g3-rejected") run.system.g3Approved = false;
      if (kind === "cast-changed") (requirementRecord(value.list._workloomRequirementContract, "contract").cast as RequirementRecord).hash = "0".repeat(64);
      if (kind !== "no-g3") await invoke(run.system, "_confirmRequirementList", "G3", value.list);
      if (kind === "source-scene-changed") requirementRecord(requirementRecord(value.discovery.sceneStructure, "structure").opening, "opening").purpose = "a different source purpose";
      return invoke(run.generator, "generate", value.discovery);
    })).rejects.toThrow();
    expect(run.calls).toHaveLength(0);
  });
  it("a 38s model response for a 30s contract cannot be scaled, templated, or swallowed as success", async () => {
    const value = fixture(), h = harness(); value.production.scenePlan.scenes[0]!.duration += 8;
    const run = h.make(value), before = structuredClone(value.production);
    await expect(withPrdAuthorityScope(value.authority, async () => {
      try { await h.generate(run); } catch {
        try { invoke(run.system, "_generateMinimalPRD", value.discovery); } catch { /* simulate vendor outer swallow */ }
      }
      return { success: false, stages: {} };
    })).rejects.toThrow("PRD_SCENE_DURATION_CONFLICT");
    expect(value.production).toEqual(before);
    expect(run.system.minimalCalls).toBe(0);
  });
  it("missing real creative fields cannot be manufactured by the native parser", async () => {
    const value = fixture(), h = harness(); delete (value.creative as Record<string, unknown>).twistPoint;
    const run = h.make(value);
    await expect(withPrdAuthorityScope(value.authority, () => h.generate(run))).rejects.toThrow();
    expect(run.calls.map(call => call.agent)).toEqual(["agent2"]);
  });
  it("an explicit degraded receipt is rejected even if it contains a plausible payload", async () => {
    const value = fixture(), h = harness(), run = h.make(value);
    requirementRecord(run.generator.agent2, "agent2")._callLLM = async () => ({ result: value.creative, degraded: true });
    await expect(withPrdAuthorityScope(value.authority, () => h.generate(run))).rejects.toThrow("PRD_MODEL_UNVERIFIED");
    expect(run.calls).toHaveLength(0);
  });
  it("native parser default text cannot replace a model's empty consistency requirement", async () => {
    const value = fixture(), h = harness(); value.production.characterSystem.characters[0]!.consistencyRequirements = "";
    const run = h.make(value);
    await expect(withPrdAuthorityScope(value.authority, () => h.generate(run))).rejects.toThrow("PRD_RESPONSE_CHANGED");
    expect(run.calls).toHaveLength(2);
  });
  it("a successful operation without real G4 cannot be announced as success", async () => {
    const value = fixture(), h = harness(), run = h.make(value);
    await expect(withPrdAuthorityScope(value.authority, async () => h.success(await h.generate(run)))).rejects.toThrow("PRD_REVIEW_UNVERIFIED");
  });
  it("mutating the caller's old accepted list cannot change the private approved snapshot", async () => {
    const value = fixture(), h = harness(), run = h.make(value);
    await expect(withPrdAuthorityScope(value.authority, async () => {
      await invoke(run.system, "_confirmRequirementList", "G3", value.list);
      requirementRecord(requirementRecord(value.list._workloomRequirementContract, "contract").cast, "cast").hash = "0".repeat(64);
      const prd = await invoke(run.generator, "generate", value.discovery) as RequirementRecord;
      await h.review(run, prd); return h.success(prd);
    })).resolves.toMatchObject({ success: true });
    expect(run.calls).toHaveLength(2);
  });
  it("G4 feedback never silently regenerates an unreviewed replacement", async () => {
    const value = fixture(), h = harness(), run = h.make(value);
    await expect(withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run); await h.review(run, prd);
      return invoke(run.generator, "generate", value.discovery);
    })).rejects.toThrow("PRD_UNREVIEWED_REGENERATION");
    expect(run.calls).toHaveLength(2);
  });
  it.each(["creativeCore", "audioSpecification", "visualSpecification", "productionConstraints", "deliveryStandard"])("rejects post-G4 %s edits before success", async field => {
    const value = fixture(), h = harness(), run = h.make(value);
    await expect(withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run); await h.review(run, prd);
      requirementRecord(prd[field], field).unreviewedChange = "cannot inherit approval";
      return h.success(prd);
    })).rejects.toThrow("PRD_REVIEW_UNVERIFIED");
  });
  it("G5 may fill a direct portraitPath without changing the G4 creation contract", async () => {
    const value = fixture(), h = harness(), run = h.make(value);
    await expect(withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run); await h.review(run, prd);
      (requirementRecord(prd.characterSystem, "characters").characters as RequirementRecord[])[0]!.portraitPath = "/synthetic/later-g5.png";
      return h.success(prd);
    })).resolves.toMatchObject({ success: true });
  });
});

describe("PRD private scope, receiver identity and strict restoration", () => {
  it("interleaved runs retain their own complete brief/G1/G3 and close independently", async () => {
    const values = [fixture("A", [3, 7, 7, 3], 6), fixture("B", [3, 3], 0)], h = harness(), runs = values.map(value => h.make(value));
    const ready = [deferred<void>(), deferred<void>()], release = [deferred<void>(), deferred<void>()];
    const running = runs.map((run, index) => withPrdAuthorityScope(run.value.authority, async () => {
      await invoke(run.system, "_confirmRequirementList", "G3", run.value.list); ready[index]!.resolve(); await release[index]!.promise;
      const prd = await invoke(run.generator, "generate", run.value.discovery) as RequirementRecord;
      await h.review(run, prd); return h.success(prd);
    }));
    await Promise.all(ready.map(value => value.promise));
    release[1]!.resolve(); await expect(running[1]).resolves.toMatchObject({ success: true });
    release[0]!.resolve(); await expect(running[0]).resolves.toMatchObject({ success: true });
    for (const [index, run] of runs.entries()) for (const call of run.calls) {
      expectCompletePrompt(call.prompt, call.agent === "agent2" ? "creative" : "production", run.value);
      expect(call.prompt).toContain(run.value.marketing.g1Artifact.sha256);
      expect(call.prompt).not.toContain(values[index === 0 ? 1 : 0]!.marketing.g1Artifact.sha256);
    }
  });
  it("interleaved runs sharing one native engine retain independent schemas and never mutate that engine", async () => {
    const values = [fixture("SHARED-A", [3, 24, 3], 1), fixture("SHARED-B", [3, 7, 7, 3], 6)], h = harness();
    const runs = values.map(value => h.make(value)), ready = [deferred<void>(), deferred<void>()], release = [deferred<void>(), deferred<void>()];
    const calls: Array<{ index: number; kind: "creative" | "production"; prompt: string; schema: unknown; options: unknown }> = [];
    const shared: RequirementRecord = {
      reasonStructured: vi.fn(async function (this: RequirementRecord, prompt: string, schema: RequirementRecord, options: unknown) {
        expect(this).toBe(shared);
        const index = values.findIndex(value => prompt.includes(value.marketing.g1Artifact.sha256));
        expect(index).toBeGreaterThanOrEqual(0);
        const value = values[index]!, kind = (schema.required as string[]).includes("coreTheme") ? "creative" : "production";
        expectCompletePrompt(prompt, kind, value);
        calls.push({ index, kind, prompt, schema, options });
        if (kind === "creative") { ready[index]!.resolve(); await release[index]!.promise; }
        return { success: true, data: structuredClone(kind === "creative" ? value.creative : value.production) };
      })
    };
    const before = Object.getOwnPropertyDescriptors(shared);
    for (const run of runs) for (const key of ["agent2", "agent3"]) requirementRecord(run.generator[key], key)._llmEngine = shared;
    const running = runs.map(run => withPrdAuthorityScope(run.value.authority, async () => {
      const prd = await h.generate(run); await h.review(run, prd); return h.success(prd);
    }));
    await Promise.all(ready.map(value => value.promise));
    release[1]!.resolve(); await expect(running[1]).resolves.toMatchObject({ success: true });
    release[0]!.resolve(); await expect(running[0]).resolves.toMatchObject({ success: true });
    expect(calls.map(call => [call.index, call.kind])).toEqual([[0, "creative"], [1, "creative"], [1, "production"], [0, "production"]]);
    for (const call of calls) expect(call.prompt).not.toContain(values[call.index === 0 ? 1 : 0]!.marketing.g1Artifact.sha256);
    expect(Object.getOwnPropertyDescriptors(shared)).toEqual(before);
    for (const run of runs) for (const key of ["agent2", "agent3"]) expect(requirementRecord(run.generator[key], key)._llmEngine).toBe(shared);
  });
  it("regeneration before G4 reuses only its own schema, without accumulating prompt sections", async () => {
    const value = fixture("REPEAT", [3, ...Array(8).fill(5), 3], 10), h = harness(), run = h.make(value);
    await withPrdAuthorityScope(value.authority, async () => {
      await h.generate(run);
      const prd = await invoke(run.generator, "generate", value.discovery) as RequirementRecord;
      await h.review(run, prd); return h.success(prd);
    });
    expect(run.calls.map(call => call.agent)).toEqual(["agent2", "agent3", "agent2", "agent3"]);
    for (const call of run.calls) expectCompletePrompt(call.prompt, call.agent === "agent2" ? "creative" : "production", value);
    expect(run.calls[0]!.prompt).toBe(run.calls[2]!.prompt); expect(run.calls[1]!.prompt).toBe(run.calls[3]!.prompt);
  });
  it("an unbound native generator preserves exact prompts, schemas, options and native results apart from each native UUID", async () => {
    const value = fixture(), h = harness(), patched = h.make(value);
    const result = await withPrdAuthorityScope(undefined, () => h.generate(patched));
    h.dispose();
    const native = h.make(value), baseline = await h.generate(native);
    expect(patched.calls).toEqual(native.calls);
    const normalize = (prd: RequirementRecord) => {
      const copy = structuredClone(prd), project = requirementRecord(copy.projectDefinition, "project");
      expect(project.projectId).toMatch(/^[a-f0-9]{8}-[a-f0-9-]{27}$/);
      project.projectId = "per-invocation-native-UUID"; return copy;
    };
    expect(normalize(result)).toEqual(normalize(baseline));
    expect(patched.calls).toHaveLength(2);
    for (const call of patched.calls) expect(call.prompt).not.toContain("## 本次宿主 PRD");
  });
  it.each(["generate", "generateMarkdown", "_confirmRequirementList", "_confirmPRD", "_generateMinimalPRD"])("bound %s refuses a missing or shadowed ALS scope", async key => {
    const value = fixture(), h = harness(), run = h.make(value);
    await withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run); await h.review(run, prd); return h.success(prd);
    });
    const owner = key.startsWith("_") ? run.system : run.generator;
    await expect(Promise.resolve().then(() => withPrdAuthorityScope(undefined, () => invoke(owner, key, value.discovery, value.list)))).rejects.toThrow("PRD_SCOPE_CONFLICT");
    expect(run.calls).toHaveLength(2);
  });
  it.each(["g1", "schemaVersion", "status", "scene-source", "character-source", "audience-source"])("detects changed %s provenance before G4", async kind => {
    const value = fixture(), h = harness(), run = h.make(value);
    await expect(withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run), marker = requirementRecord(prd._workloomPrdAuthority, "marker");
      if (kind === "g1") requirementRecord(marker.g1, "G1").sha256 = "0".repeat(64);
      if (kind === "schemaVersion") marker.schemaVersion = "forged";
      if (kind === "status") marker.status = "passed";
      if (kind === "audience-source") requirementRecord(requirementRecord(prd.audienceProfile, "audience")._workloomAudienceAuthority, "audience source").modelStatus = "verified-fact";
      if (kind === "scene-source") {
        const plan = requirementRecord(prd.scenePlan, "plan"), scenes = plan.scenes as RequirementRecord[];
        requirementRecord(scenes[0]!._workloomRequirementScene, "source").purpose = "forged"; marker.scenePlanHash = requirementHash(plan);
      }
      if (kind === "character-source") {
        const system = requirementRecord(prd.characterSystem, "characters"), characters = system.characters as RequirementRecord[];
        requirementRecord(characters[0]!._workloomCharacterSource, "source").portraitVersion = 3; marker.characterSystemHash = requirementHash(system);
      }
      return h.review(run, prd);
    })).rejects.toThrow("PRD_AUTHORITY_CHANGED");
  });
  it("unbound narrative receivers retain original behavior and disposer restores exact descriptors", async () => {
    const value = fixture(), h = harness(), run = h.make(value);
    expect(invoke(run.system, "_generateMinimalPRD")).toEqual({ productPositioning: { aspectRatio: "16:9" } });
    expect(run.system.minimalCalls).toBe(1);
    h.dispose(); h.dispose();
    for (const [key, descriptor] of Object.entries(h.before)) expect(Object.getOwnPropertyDescriptor(h.prototype, key)).toEqual(descriptor);
    expect(Object.getOwnPropertyDescriptor(PRDGenerator.prototype, "generate")).toEqual(h.nativeGenerator);
  });
  it("bridge descriptor tamper is detected and cannot be silently restored over a foreign writer", () => {
    const h = harness(), descriptor = Object.getOwnPropertyDescriptor(h.prototype, "_generateMinimalPRD")!;
    Object.defineProperty(h.prototype, "_generateMinimalPRD", { ...descriptor, enumerable: !descriptor.enumerable });
    expect(() => assertPrdAuthorityBridge(h.prototype)).toThrow("PRD_BRIDGE_CHANGED");
    expect(() => h.dispose()).toThrow("PRD_BRIDGE_CHANGED");
    Object.defineProperty(h.prototype, "_generateMinimalPRD", descriptor);
  });
  it("invalid schema is rejected before any prototype installation can remain behind", () => {
    class LocalSystem {
      _confirmRequirementList() { return {}; }
      _generateMinimalPRD() { return {}; }
      _confirmPRD() { return {}; }
    }
    const prototype = LocalSystem.prototype as unknown as RequirementRecord;
    const before = Object.getOwnPropertyDescriptors(prototype), native = Object.getOwnPropertyDescriptors(PRDGenerator.prototype);
    const schema: RequirementRecord = { properties: PRDSchema.properties }; schema.cycle = schema;
    expect(() => installPrdAuthorityBridge(prototype, PRDGenerator.prototype, schema)).toThrow();
    expect(Object.getOwnPropertyDescriptors(prototype)).toEqual(before);
    expect(Object.getOwnPropertyDescriptors(PRDGenerator.prototype)).toEqual(native);
  });
  it("changing the actual engine method descriptor during a call fails before a second model call", async () => {
    const value = fixture(), h = harness(), run = h.make(value), engine = run.engines[0]!;
    const original = engine.reasonStructured as (...args: unknown[]) => unknown;
    engine.reasonStructured = async function (this: RequirementRecord, ...args: unknown[]) {
      const result = await Reflect.apply(original, this, args);
      Object.defineProperty(engine, "reasonStructured", { ...Object.getOwnPropertyDescriptor(engine, "reasonStructured"), writable: false });
      return result;
    };
    await expect(withPrdAuthorityScope(value.authority, () => h.generate(run))).rejects.toThrow("PRD_ENGINE_CHANGED");
    expect(run.calls).toHaveLength(1);
  });
  it.each(["engine", "agent-process", "agent-call"])("cached %s wrappers reject late calls after the producing operation closes", async target => {
    const value = fixture(), h = harness(), run = h.make(value);
    let late: (() => unknown) | undefined;
    const agent = requirementRecord(run.generator.agent2, "agent2"), original = agent._callLLM as (...args: unknown[]) => unknown;
    agent._callLLM = function (this: RequirementRecord, ...args: unknown[]) {
      const engine = invoke(this, "_getLLMEngine") as RequirementRecord;
      late = target === "engine" ? () => invoke(engine, "reasonStructured", "late prompt", {}, {})
        : target === "agent-process" ? () => invoke(this, "process", value.discovery)
          : () => invoke(this, "_callLLM", "late prompt", {}, null, {});
      return Reflect.apply(original, this, args);
    };
    await withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run); await h.review(run, prd); return h.success(prd);
    });
    await expect(Promise.resolve().then(() => late!())).rejects.toThrow("PRD_SCOPE_CLOSED");
    expect(run.calls).toHaveLength(2);
  });
});

describe("bounded blank JSON correction at the actual frozen PromptFusion entry", () => {
  const scene = "preproduction";
  const templateHeading = "\n\n【硬性输出要求】";
  const correctionHeading = "\n\n## 本镜头最终 JSON 交付\n";
  const providerReply = (content: string, id = "fixture-response") => ({
    id, object: "chat.completion", model: "deepseek-flash",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    usage: { prompt_tokens: 132765, completion_tokens: 4779, total_tokens: 137544,
      completion_tokens_details: { reasoning_tokens: 4740 } },
  });
  function fusionOutput(id: string) {
    const { fields } = productionShot(id);
    const output = Object.fromEntries(Object.entries(fields as RequirementRecord)
      .map(([key, value]) => [key, key === "dialogue" ? "无台词" : String(value).repeat(9)])) as RequirementRecord;
    output.audio = "保留封闭场地风声、轮胎声与动作声，跟随每个画面内可见事件变化。".repeat(8);
    output.timeline = "T00:00–T00:03 交代环境和行动起点；T00:03–T00:07 观察物件并继续移动；T00:07–T00:10 收稳并保持原方向。".repeat(5);
    return { shots: [{ shotId: id, fields: output }] };
  }
  function fusionRun(label: string, replies: Array<unknown>, options: { frozen?: boolean; maxRetries?: number; afterFirst?: (adapter: WorkloomLLMEngine) => void } = {}) {
    resetCircuit(scene);
    const value = fixture(`FUSION-BLANK-${label}`, [10, 10, 10]);
    if (options.frozen !== false) {
      requirementRecord(value.metadata.brief, "frozen fixture Brief").segmentContract = {
        count: 3, totalSeconds: 30, secondsPerSegment: 10, hardCuts: true,
        intervals: Array.from({ length: 3 }, (_, i) => ({ startSec: i * 10, endSec: (i + 1) * 10, brief: `冻结动作原文 ${i + 1}` })),
      };
    }
    declareDelivery(value, { speechPolicy: "none" });
    const h = productionHarness(true, true), run = h.make(value);
    const fusion = new PromptFusionAgent({ llmMaxRetries: options.maxRetries ?? 2, llmTimeout: 30_000, semanticRefinement: false });
    const baseUrl = "https://native-fusion-fixture.invalid/v1";
    const requests: Array<{ url: string; body: RequirementRecord }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) as RequirementRecord });
      const reply = replies[requests.length - 1];
      if (requests.length === 1) options.afterFirst?.(adapter);
      if (reply instanceof Error) throw reply;
      if (!reply) throw new Error("unexpected third native fixture request");
      return Response.json(reply);
    };
    const provider = new OpenAiCompatibleProvider("deepseek-flash", { baseUrl, apiKey: "test-only", fetchImpl });
    const adapter = new WorkloomLLMEngine({ baseUrl, apiKey: "test-only", model: "deepseek-flash",
      router: { scene, providers: new Map([[provider.modelId, provider]]), sink: {
        recordModelTrace: async () => undefined, recordDegradation: async () => undefined, recordCircuitBreak: async () => undefined,
      } } });
    run.system.llmEngine = adapter;
    const shot = (index: number) => ({ shotId: value.contract.scenes[index]!.id,
      sceneType: index === 0 ? "opening" : "body", duration: 10, scene: `原生镜头原文 ${index + 1}，完整保留现场声音与可见动作`,
      dialogue: "无台词", dialogueBlocks: [], dialogueText: "" });
    const execute = (index = 0) => invoke(fusion, "_fuseSingleShot", shot(index), "9:16", [], { config: { aspectRatio: "9:16" } }, 20_000);
    const accepted = (operation: () => unknown | Promise<unknown>) => h.accepted(run, operation);
    return { value, fusion, requests, execute, accepted, baseUrl };
  }
  const prompt = (wire: RequirementRecord) => (wire.messages as ChatMessage[]).find(message => message.role === "user")!.content as string;

  it("repeats the complete native shot, approved evidence and exact schema once on the same high/window Chat route", async () => {
    const h = fusionRun("CORRECTED", [providerReply("    "), providerReply(JSON.stringify(fusionOutput("opening")), "fixture-corrected")]);
    await h.accepted(async () => {
      const output = await h.execute();
      expect(output).toMatchObject({ shotId: "opening", duration: 10, degraded: false });
    });
    expect(h.requests).toHaveLength(2);
    const [first, second] = h.requests;
    expect(first!.url).toBe(h.baseUrl + "/chat/completions");
    expect(second!.url).toBe(first!.url);
    const { messages: firstMessages, ...firstOptions } = first!.body;
    const { messages: secondMessages, ...secondOptions } = second!.body;
    const nonUser = (messages: unknown) => (messages as ChatMessage[]).filter(message => message.role !== "user");
    expect(nonUser(secondMessages)).toEqual(nonUser(firstMessages));
    expect(secondOptions).toEqual(firstOptions);
    expect(firstOptions).toMatchObject({ model: "deepseek-flash", max_tokens: 393216,
      response_format: { type: "json_object" }, thinking: { type: "enabled" }, reasoning_effort: "high" });
    const firstPrompt = prompt(first!.body), corrected = prompt(second!.body);
    const originalSuffix = firstPrompt.slice(firstPrompt.indexOf(templateHeading));
    const instructionStart = corrected.indexOf(correctionHeading);
    const instructionEnd = corrected.indexOf(templateHeading);
    expect(corrected.slice(0, instructionStart) + corrected.slice(instructionEnd)).toBe(firstPrompt);
    expect(corrected.slice(instructionStart, instructionEnd)).toContain("完成必要推理后，把完整结果写入最终答复");
    expect(corrected.endsWith(originalSuffix)).toBe(true);
    expect(firstPrompt).toContain("原生镜头原文 1");
    expect(firstPrompt).toContain(h.value.content);
    expect(firstPrompt).toContain("冻结动作原文 3");
  });

  it.each(["wrong-shot", "missing-field", "extra-field", "another-blank", "unmeasured", "refusal", "same-response"] as const)(
    "keeps the correction fatal when the second exact native response is %s", async kind => {
      const output = fusionOutput(kind === "wrong-shot" ? "scene-1" : "opening");
      if (kind === "missing-field") delete output.shots[0]!.fields.lighting;
      if (kind === "extra-field") output.shots[0]!.fields.foreign = "foreign field";
      const second = providerReply(kind === "another-blank" ? " " : JSON.stringify(output),
        kind === "same-response" ? "fixture-response" : "fixture-bad-second");
      if (kind === "refusal") Object.assign(second.choices[0]!.message, { refusal: "fixture refusal accompanying JSON" });
      const h = fusionRun(kind, [providerReply(" "), kind === "unmeasured" ? { ...second, usage: undefined } : second]);
      await expect(h.accepted(async () => {
        try { await h.execute(); } catch { /* the authority must remember the native failure */ }
      })).rejects.toThrow("PRD_PRODUCTION_MODEL_UNVERIFIED");
      expect(h.requests).toHaveLength(2);
    });

  it.each(["unmeasured", "no-finish", "refusal", "unknown", "not-frozen", "no-slot", "deadline", "direct", "other-agent", "route-replaced"] as const)(
    "does not dispatch a correction for a first response with %s", async kind => {
      const blank = providerReply("   ");
      if (kind === "no-finish") delete (blank.choices[0] as Partial<typeof blank.choices[number]>).finish_reason;
      if (kind === "refusal") Object.assign(blank.choices[0]!.message, { refusal: "fixture refusal" });
      const h = fusionRun(kind, [kind === "unknown" ? new TypeError("fixture lost original response")
        : kind === "unmeasured" ? { ...blank, usage: undefined } : blank], {
        frozen: kind !== "not-frozen", maxRetries: kind === "no-slot" ? 1 : 2,
        ...(kind === "deadline" ? { afterFirst: () => vi.setSystemTime(Date.now() + 18_000) } : {}),
        ...(kind === "route-replaced" ? { afterFirst: (adapter: WorkloomLLMEngine) => adapter.attachRouter({
          providers: new Map(), sink: { recordModelTrace: async () => undefined, recordDegradation: async () => undefined,
            recordCircuitBreak: async () => undefined },
        }) } : {}),
      });
      await expect(h.accepted(() => {
        if (kind === "direct" || kind === "other-agent") {
          const receiver = kind === "direct" ? h.fusion : new BaseAgent({ name: "PromptFusionAgent" });
          return invoke(receiver, "_callLLM", "仿制关键调用", { required: ["shots"] }, null, { critical: true });
        }
        return h.execute();
      })).rejects.toThrow(/PRD_PRODUCTION_MODEL_(?:UNVERIFIED|DEADLINE)/);
      expect(h.requests).toHaveLength(1);
    });

  it.each(["native-fill", "second-after-syntax"] as const)("leaves blank JSON fatal in %s after the initial primary call", async mode => {
    const original = fusionOutput("opening");
    if (mode === "native-fill") delete original.shots[0]!.fields.lighting;
    const h = fusionRun(mode, [providerReply(mode === "native-fill" ? JSON.stringify(original) : '{"shots":[}'),
      providerReply("  ", "fixture-nonprimary-blank")]);
    await expect(h.accepted(async () => {
      try { await h.execute(); } catch { /* a native catch cannot clear this failure */ }
    })).rejects.toThrow("PRD_PRODUCTION_MODEL_UNVERIFIED");
    expect(h.requests).toHaveLength(2);
    expect(prompt(h.requests[1]!.body)).not.toContain(correctionHeading);
    expect(prompt(h.requests[1]!.body)).toContain(mode === "native-fill" ? "本次只补齐以下字段" : "完整结构修正");
  });

  it("consumes the single blank allowance across the current approved run", async () => {
    const h = fusionRun("ONCE-PER-RUN", [providerReply(" "), providerReply(JSON.stringify(fusionOutput("opening")), "fixture-corrected"),
      providerReply(" ", "fixture-later-blank")]);
    await expect(h.accepted(async () => {
      expect(await h.execute()).toMatchObject({ shotId: "opening", degraded: false });
      await h.execute(1);
    })).rejects.toThrow("PRD_PRODUCTION_MODEL_UNVERIFIED");
    expect(h.requests).toHaveLength(3);
    expect(prompt(h.requests[2]!.body)).not.toContain(correctionHeading);
  });
});

describe("approved production authority at native technical and title seams", () => {
  it.each(["approved", "no-owner-selection", "no-g4-selection", "wrong-duration", "wrong-shot"])(
    "preserves an explicitly selected one-piece wardrobe and reviewed framing at the native seams: %s", async mode => {
      const value = fixture(`FROZEN-WARDROBE-${mode}`, [10, 10, 10]), h = productionHarness(true);
      const wardrobe = "哑光纯色全覆保护真皮赛车服，护肩、护肘、护膝、护背、手套和高帮赛车靴完整，拉链到颈部，贴合身体但不露胸、不露腰、不穿短裤";
      const framing = "侧前中景、转身与登台动作呈现全覆赛车服下的自然胸线与上翘臀部轮廓，不作孤立局部特写";
      const actor = (value.metadata.characters as RequirementRecord[])[0]!;
      Object.assign(actor, { activeWardrobeId: "w1", wardrobeId: "w1", wardrobe: [
        { id: "w1", name: "历史外套", detail: "普通外套与白色内搭" },
        { id: "w2", name: "全覆保护赛道赛车服", detail: wardrobe },
      ] });
      const brief = requirementRecord(value.metadata.brief, "test frozen Brief");
      brief.segmentContract = { count: 3, totalSeconds: 30, secondsPerSegment: 10, hardCuts: true,
        intervals: [{ startSec: 0, endSec: 10, brief: "追击" }, { startSec: 10, endSec: 20, brief: "超越冲线" },
          { startSec: 20, endSec: 30, brief: (mode === "no-owner-selection" ? "登台" : "全段同一套合身全覆 w2 赛车服") + "。" + framing }] };
      value.production.characterSystem.characters[0]!.costume = mode === "no-g4-selection" ? wardrobe : `本片唯一造型（w2 全覆保护赛道赛车服）：${wardrobe}。历史 w1 不进入本片。`;
      value.production.scenePlan.scenes[2]!.visualRequirements = [framing];
      declareDelivery(value, { speechPolicy: "none" });
      const run = h.make(value);
      const shot = { shotId: mode === "wrong-shot" ? "unbound" : "ending", duration: mode === "wrong-duration" ? 9 : 10,
        sceneType: "ending", scene: "正式场景", character: "合成人物", costume: wardrobe, dialogue: "无台词",
        timeline: "单一没有分段的测试时间轴", fields: { costume: wardrobe, dialogue: "无台词" } };
      const rule = new RuleRepairer(), checker = new RuleChecker();
      const before = invoke(checker, "_checkStructure", shot) as RequirementRecord[];
      const legacy = before.find(issue => issue.fieldEn === "costume")!;
      expect(legacy.description).toContain("服装字段层次不足");
      await h.accepted(run, () => {
        const checked = invoke(checker, "_checkStructure", shot) as RequirementRecord[];
        const output = requirementRecord(invoke(rule, "repair", shot, { issues: [legacy] }, new PRD({})), "costume rule result");
        const repaired = requirementRecord(output.repaired, "repaired costume");
        expect(checked.some(issue => issue.fieldEn === "timeline")).toBe(true);
        expect(checked.some(issue => issue.fieldEn === "costume")).toBe(mode !== "approved");
        if (mode === "approved") expect(repaired.costume).toBe(wardrobe);
        else expect(repaired.costume).toContain("外套：合身外套");
        const prompt = invoke(run.fusion, "_buildBatchPrompt", [shot], "9:16", [], { config: { aspectRatio: "9:16" } });
        if (mode === "approved") {
          expect(prompt).toContain(`本镜已审防护造型与构图`);
          expect(prompt).toContain(framing);
          expect(prompt).toContain("只在现有 composition");
          const previous = { ...shot, shotId: "scene-1", sceneType: "body" };
          expect(invoke(run.fusion, "_buildBatchPrompt", [previous], "9:16", [], { config: { aspectRatio: "9:16" } })).not.toContain(framing);
          expect(invoke(rule, "_generateDefault", "costume", new PRD({}), { ...shot, costume: "" })).toBeNull();
        } else {
          expect(prompt).not.toContain("本镜已审防护造型与构图");
        }
      });
      expect(shot.costume).toBe(wardrobe);
    },
  );

  it.each([true, false])("keeps native per-shot scene and director prose only for a verified frozen contract (%s)", async frozen => {
    const value = fixture(`DIRECTOR-RULE-${frozen}`, [10, 10, 10]), h = productionHarness();
    if (frozen) {
      const brief = requirementRecord(value.metadata.brief, "test frozen Brief");
      brief.segmentContract = { count: 3, totalSeconds: 30, secondsPerSegment: 10, hardCuts: true,
        intervals: [{ startSec: 0, endSec: 10, brief: "第一段原始动作" },
          { startSec: 10, endSec: 20, brief: "第二段原始动作" },
          { startSec: 20, endSec: 30, brief: "第三段原始动作" }] };
      refreshContract(value);
    }
    const nativeSceneIds = ["opening", "scene-1", "ending"];
    const fromBlueprint = (PRD as unknown as { fromBlueprint(value: RequirementRecord): RequirementRecord }).fromBlueprint;
    const prd = Reflect.apply(fromBlueprint, PRD, [{ characters: [{ name: "合成人物" }],
      scenes: nativeSceneIds.map((scene_id, index) => ({ scene_id, scene_name: `原生场景${index}`, visual: `完整的实际镜头${index}` })) }]);
    expect((prd.scenes as string[])[0]).toContain('{"scene_id":"opening","scene_name"');
    const run = h.make(value), rule = new RuleRepairer();
    await h.accepted(run, () => {
      for (const shotId of nativeSceneIds) {
        const shot = { shotId, scene: `当前镜头 ${shotId} 已生成的完整物理环境与动作。`,
          director_instruction: `当前镜头 ${shotId} 已生成的完整导演意图和逐镜动作安排。`,
          character: "清楚保持姿态与视线方向", consistency: "同一人物与环境关系" };
        const result = requirementRecord(invoke(rule, "repair", shot, { issues: [] }, prd), "native field repair");
        const repaired = requirementRecord(result.repaired, "repaired native shot");
        if (frozen) {
          expect(repaired.scene).toBe(shot.scene);
          expect(repaired.director_instruction).toBe(shot.director_instruction);
        } else {
          expect(repaired.scene).toMatch(/^\{"scene_id":"opening","scene_n/u);
          expect(repaired.director_instruction).toMatch(/^\{"scene_id":"opening","scene_n/u);
        }
        expect(repaired.character).toContain("角色锚定：合成人物");
        expect(repaired.consistency).toContain("角色锚定：合成人物");
      }
    });
  });

  it.each([
    { frozen: true, hasCamera: true },
    { frozen: true, hasCamera: false },
    { frozen: false, hasCamera: true },
    { frozen: false, hasCamera: false },
  ])("keeps native camera diagnostics and avoids ungrounded timing only in frozen shots ($frozen, authored $hasCamera)", async ({ frozen, hasCamera }) => {
    const value = fixture(`CAMERA-RULE-${frozen}-${hasCamera}`, [10, 10, 10]), h = productionHarness();
    if (frozen) {
      const brief = requirementRecord(value.metadata.brief, "test frozen Brief");
      brief.segmentContract = { count: 3, totalSeconds: 30, secondsPerSegment: 10, hardCuts: true,
        intervals: [{ startSec: 0, endSec: 10, brief: "第一段原始动作" },
          { startSec: 10, endSec: 20, brief: "第二段原始动作" },
          { startSec: 20, endSec: 30, brief: "第三段原始动作" }] };
      refreshContract(value);
    }
    const camera = hasCamera ? "低位长焦跟拍与车身同步，镜头只随车身自然减速并保持同轴，不加停格或推近。" : "";
    const timeline = "T00:00–T00:03 跟住车身；T00:03–T00:08 两次位置反转后冲线；T00:08–T00:10 随车回稳。";
    const shot = {
      shotId: "scene-1", duration: 10, camera_movement: camera, cameraMovement: camera, timeline,
      fields: { camera_movement: camera, timeline },
    };
    const check = invoke(new RuleChecker(), "check", shot) as RequirementRecord[];
    const cameraIssue = check.find(issue => issue.fieldEn === "camera_movement" && issue.issueType === (hasCamera ? IssueType.INCOMPLETE : IssueType.MISSING));
    expect(cameraIssue).toBeDefined();
    const otherIssue = { fieldEn: "negative", issueType: IssueType.INCOMPLETE, severity: "major", description: "负面约束缺少 no text" };
    const input = { ...shot, negative: "不出现车牌", fields: { ...shot.fields, negative: "不出现车牌" } };
    const run = h.make(value);
    await h.accepted(run, async () => {
      // Use the native rule application and the native recheck before the
      // language-model layer. The fixture records that handoff with zero I/O.
      const repairer = Object.create(FieldRepairAgent.prototype) as RequirementRecord;
      repairer.ruleRepairer = new RuleRepairer();
      repairer.prd = new PRD({});
      const handoff = vi.fn(async (repaired: RequirementRecord, report: RequirementRecord) => {
        if (frozen) {
          expect(repaired.camera_movement).toBe(camera);
          expect((report.issues as RequirementRecord[]).some(issue => issue.fieldEn === "camera_movement"
            && issue.issueType === cameraIssue!.issueType)).toBe(true);
        }
        return { repaired, actions: [] };
      });
      repairer.llmRepairer = { llm: {}, repair: handoff };
      const result = requirementRecord(await invoke(repairer, "repair", input, { shotId: shot.shotId, issues: [cameraIssue, otherIssue] }, shot.shotId), "native repair result");
      const repaired = requirementRecord(result.repaired, "native repaired shot");
      const fields = requirementRecord(repaired.fields, "native repaired fields");
      const actions = requirementRecord(result.log, "native repair log").actions as RequirementRecord[];
      expect(repaired.timeline).toBe(timeline);
      expect(fields.timeline).toBe(timeline);
      expect(repaired.duration).toBe(10);
      expect(repaired.negative).toBe("no text, no watermark, 不出现车牌");
      expect(actions.some(action => action.fieldEn === "camera_movement")).toBe(!frozen);
      if (frozen) {
        expect(handoff).toHaveBeenCalledTimes(1);
        expect([repaired.camera_movement, repaired.cameraMovement, fields.camera_movement]).toEqual([camera, camera, camera]);
      } else {
        expect(repaired.camera_movement).toContain("0.5m/s");
        expect(repaired.camera_movement).toContain("收尾");
      }
    });
  });

  it.each(["frozen-silent", "frozen-fence", "unfrozen-silent", "frozen-voice", "wrong-shot", "wrong-duration"])(
    "keeps complete authored and native-repaired timing and transition text only for the approved shot (%s)", async mode => {
      const value = fixture(`FIELD-TEXT-${mode}`, [10, 10, 10]), h = productionHarness();
      if (mode !== "unfrozen-silent") requirementRecord(value.metadata.brief, "brief").segmentContract = {
        count: 3, totalSeconds: 30, secondsPerSegment: 10, hardCuts: true,
        intervals: Array.from({ length: 3 }, (_, i) => ({ startSec: i * 10, endSec: (i + 1) * 10, brief: `冻结段 ${i + 1}` })),
      };
      if (mode === "frozen-voice") refreshContract(value);
      else declareDelivery(value, { speechPolicy: "none" });
      const run = h.make(value);
      const authored = {
        timeline: "totalDuration: 10, beats: time: 0, label: 动作开始, description: ".repeat(10)
          + "最后时间节点：已完全超过对手车头再率先过线，随后才收油减速。",
        transition: "与上一镜同一前进方向，保持硬切，".repeat(5) + "最后两秒保留呼吸和姿态微动，画面不冻结。",
      };
      const shot = { ...authored, fields: { ...authored }, duration: mode === "wrong-duration" ? 9 : 10,
        shotId: mode === "wrong-shot" ? "foreign-shot" : "scene-1" };
      const checker = new RuleChecker(), rule = new RuleRepairer();
      const legacyIssues = (invoke(checker, "check", shot) as RequirementRecord[]).filter(issue =>
        issue.fieldEn === "timeline" || issue.fieldEn === "transition");
      const repaired = { timeline: `${authored.timeline}保留最后完整动作。`, transition: `${authored.transition}落幅全身完整。`,
        mood: "逐渐释然，最后呼吸自然。".repeat(8) };
      const body = JSON.stringify({ repaired_fields: repaired });
      const response = vi.fn(async () => ({ success: true, content: mode === "frozen-fence" ? "```json\n" + body + "\n```" : body }));
      const llm = Reflect.construct(LLMRepairer, [{ reason: response }, 500]) as RequirementRecord, prd = new PRD({});
      const preserved = mode === "frozen-silent" || mode === "frozen-fence";
      const overflow = (issue: RequirementRecord) => issue.issueType === IssueType.OVER_LENGTH
        && String(issue.description).includes("字段超长");
      await h.accepted(run, async () => {
        const checks = invoke(checker, "check", shot) as RequirementRecord[];
        expect.soft(checks.filter(issue => overflow(issue) && Object.hasOwn(authored, String(issue.fieldEn))).length).toBe(preserved ? 0 : 2);
        expect(checks.some(issue => issue.fieldEn === "timeline" && issue.issueType === IssueType.INCOMPLETE)).toBe(true);
        const result = requirementRecord(invoke(rule, "repair", shot, { issues: legacyIssues }, prd), "native rule repair");
        const afterRule = requirementRecord(result.repaired, "after native rule");
        for (const key of ["timeline", "transition"] as const) {
          if (preserved) expect.soft(afterRule[key], `native rule ${key}`).toBe(authored[key]);
          else expect(String(afterRule[key]).length).toBeLessThan(authored[key].length);
        }
        const semanticIssues = ["timeline", "transition", "mood"].map(fieldEn => ({
          fieldEn, severity: "major", issueType: IssueType.CONFLICT, description: "检查发现动作或落幅相互矛盾", suggestion: "按完整来源修复",
        }));
        const modeled = requirementRecord(await invoke(llm, "repair", shot, { issues: semanticIssues }, prd), "native LLM repair");
        const afterModel = requirementRecord(modeled.repaired, "after native LLM");
        for (const key of ["timeline", "transition"] as const) {
          if (preserved) expect.soft(afterModel[key], `native model ${key}`).toBe(repaired[key]);
          else expect(String(afterModel[key]).length).toBeLessThan(repaired[key].length);
        }
        expect(String(afterModel.mood).length).toBeLessThan(repaired.mood.length);
        expect(response).toHaveBeenCalledTimes(1);
        const [[prompt]] = response.mock.calls as unknown as [[string]];
        expect(prompt).toContain("timeline：≤ 300 字符");
        expect(prompt).toContain("transition：≤ 50 字符");
      });
      expect(shot.fields).toEqual(authored);
    },
  );

  function syntheticPortraitSource(value: ReturnType<typeof prdFixture>): PrdPortraitSource {
    const provenance = value.authority.marketing.g1Artifact;
    const file = { path: provenance.path, sha256: provenance.sha256 };
    const originals = Object.fromEntries(["front", "threeQuarter", "closeup", "side"].map((angle, index) => {
      const location = path.join(value.workDir, `source-${angle}.png`);
      writeFileSync(location, Buffer.alloc(1024 + index, index));
      return [angle, readPortraitArtifact(location)];
    }));
    return {
      status: "source-verified-awaiting-current-g5", characterId: "builtin-person", name: "合成人物", role: "protagonist",
      portraitVersion: 2, manifest: file, archiveProfile: { ...file, realPath: file.path, bytes: Buffer.byteLength(provenance.content) },
      catalogProfile: file, originals, ownerAuthorization: { basis: "explicit-owner-authorization",
        decisionOwnerRole: "product-owner", receipt: file, ledger: file },
    };
  }

  it.each([true, false])("keeps exact archive refs through the real native v1 rewrite only in the archive scope (%s)", async useArchive => {
    const value = fixture(`PORTRAIT-RULE-${useArchive}`), h = productionHarness();
    if (useArchive) value.authority.portraitSources = [syntheticPortraitSource(value)];
    const run = h.make(value);
    const quality = Object.create(FieldQualityPipeline.prototype) as RequirementRecord;
    quality.maxRounds = 2;
    const problem = { passed: false, summary: () => "synthetic native portrait format", issues: [
      { fieldEn: "portraits", issueType: IssueType.FORMAT_ERROR, severity: "major", description: "原生格式诊断" },
    ] };
    quality.checker = { check: vi.fn().mockResolvedValueOnce(problem).mockResolvedValueOnce({
      passed: true, summary: () => "synthetic second check", issues: [],
    }) };
    const rule = new RuleRepairer(), prd = new PRD({ characters: [{ name: "测试人物" }] });
    quality.repairer = { repair: async (input: RequirementRecord, report: RequirementRecord) => {
      const repaired = requirementRecord(invoke(rule, "repair", input, report, prd), "real rule result");
      expect(requirementRecord(repaired.repaired, "real legacy field").portraits).toBe("/characters/character/portrait_v1.png");
      return { repaired: repaired.repaired, log: { actions: repaired.actions } };
    } };
    const refs = ["image://characters/synthetic/v2/closeup.png", "image://characters/synthetic/v2/front.png"];
    const shot = productionShot();
    shot.portraits = refs;
    requirementRecord(shot.fields, "actual shot fields").portraits = refs;
    const snapshot = structuredClone(shot);
    await h.accepted(run, async () => {
      const native = requirementRecord(await invoke(quality, "run", shot, "S01"), "native field quality result");
      const final = requirementRecord(native.finalShot, "final shot");
      const expected = useArchive ? refs : "/characters/character/portrait_v1.png";
      expect(final.portraits).toEqual(expected);
      expect(requirementRecord(final.fields, "final fields").portraits).toEqual(expected);
      expect(shot).toEqual(snapshot);
    });
  });

  it.each([true, false])("requires matching owner originals and a current G4 artifact before placing ordered explicit reference angles (%s)", async frozen => {
    const value = fixture(`PORTRAIT-PLACEMENT-${frozen}`, frozen ? [10, 10, 10] : undefined);
    const h = productionHarness(), portrait = syntheticPortraitSource(value);
    if (frozen) {
      requirementRecord(value.metadata.brief, "brief").segmentContract = {
        count: 3, totalSeconds: 30, secondsPerSegment: 10, hardCuts: true,
        intervals: Array.from({ length: 3 }, (_, i) => ({ startSec: i * 10, endSec: (i + 1) * 10, brief: `冻结段 ${i + 1}` })),
      };
      declareDelivery(value, { speechPolicy: "none" });
    }
    const declaration = { characterId: "builtin-person", portraitVersion: 2, angles: ["closeup", "front"] };
    for (const invalid of [{ ...declaration, characterId: "other" }, { ...declaration, portraitVersion: 1 },
      { ...declaration, angles: ["closeup", "closeup"] }, { ...declaration, angles: ["guess"] }]) {
      expect(() => preparePrdPortraitReferenceSelection(invalid, [portrait])).toThrow("PRD_PORTRAIT_SOURCE_UNVERIFIED");
    }
    expect(() => preparePrdPortraitReferenceSelection(declaration, [])).toThrow("PRD_PORTRAIT_SOURCE_UNVERIFIED");
    value.authority.portraitSources = [portrait];
    value.authority.portraitReferenceSelection = preparePrdPortraitReferenceSelection(declaration, [portrait]);
    const run = h.make(value);
    const shots = value.contract.scenes.map(scene => productionShot(scene.id));
    const references = ["portrait-set://builtin-person/v2/closeup", "portrait-set://builtin-person/v2/front"];
    await h.accepted(run, async (prd, report) => {
      expect(run.calls[1]!.prompt).toContain("每个含该人物的 G3 场景只提交选定的 2 张，按 closeup → front 顺序使用");
      if (frozen) {
        const constraints = requirementRecord(prd.productionConstraints, "production constraints");
        expect(constraints.technicalConstraints).toEqual(expect.arrayContaining([expect.stringContaining(
          "人物档案 V2 原图共 4 张待 G5 核验；每个含该人物的生成片段只按 closeup → front 顺序引用其中 2 张",
        )]));
      }
      const exact = JSON.parse(report.split("## 本次 G4 执行与核验计划原文")[1]!.split("\n```json\n")[1]!.split("\n```")[0]!);
      expect(exact.portraitReferenceSelection).toEqual({ ...declaration,
        originalSha256InOrder: [portrait.originals.closeup!.sha256, portrait.originals.front!.sha256] });
      expect(bindApprovedPrdPortraitSelection(shots)).toEqual(shots.map(shot => ({ shotId: shot.shotId, references })));
      for (const shot of shots) {
        expect(shot.portraits).toEqual(references);
        expect(requirementRecord(shot.fields, "actual selected fields").portraits).toEqual(references);
      }
    });
    expect(bindApprovedPrdPortraitSelection(shots)).toBeUndefined();
    const mismatched = h.make(value);
    await expect(withPrdAuthorityScope(value.authority, () => invoke(mismatched.system, "create", async () => {
      const prd = await h.generate(mismatched);
      const report = invoke(mismatched.generator, "generateMarkdown", prd) as string;
      await invoke(mismatched.system, "_confirmPRD", report + "\nchanged", prd);
      return h.success(prd);
    }))).rejects.toThrow("PRD_REVIEW_CHANGED");
  });

  it.each(["valid", "reordered", "alias-conflict", "non-string-id", "stale-original", "unknown-cast",
    "actor-absent", "non-frozen", "frozen-with-speech"])(
    "runs native Layer2 before G6 with exact owner portrait candidates (%s)", async mode => {
      const value = fixture(`LAYER2-PORTRAIT-${mode}`, [10, 10, 10]), h = productionHarness();
      if (mode !== "non-frozen") {
        requirementRecord(value.metadata.brief, "brief").segmentContract = {
          count: 3, totalSeconds: 30, secondsPerSegment: 10, hardCuts: true,
          intervals: Array.from({ length: 3 }, (_, i) => ({ startSec: i * 10, endSec: (i + 1) * 10, brief: `冻结段 ${i + 1}` })),
        };
        if (mode === "frozen-with-speech") refreshContract(value);
        else declareDelivery(value, { speechPolicy: "none" });
      }
      if (mode === "actor-absent") {
        const sceneStructure = requirementRecord(value.discovery.sceneStructure, "source scene structure");
        const opening = requirementRecord(sceneStructure.opening, "source opening");
        requirementRecord(opening.productionContract, "source opening contract").actions = [
          { actorId: "$scene", description: "开场只出现空场地，不出现任何人物" },
        ];
        refreshContract(value);
      }
      const portrait = syntheticPortraitSource(value);
      if (mode === "unknown-cast") portrait.characterId = "outside-reviewed-cast";
      const declaration = { characterId: portrait.characterId, portraitVersion: 2, angles: ["front", "closeup"] };
      value.authority.portraitSources = [portrait];
      value.authority.portraitReferenceSelection = preparePrdPortraitReferenceSelection(declaration, [portrait]);
      const run = h.make(value);
      const shots: RequirementRecord[] = value.contract.scenes.map(scene => ({ ...productionShot(scene.id), duration: 10,
        sceneType: scene.id === "opening" ? "opening" : "body",
        ...(scene.id === "opening" ? {} : { referenceImages: ["/characters/legacy/portrait_v1.png"] }) }));
      delete shots[0]!.portraits;
      delete requirementRecord(shots[0]!.fields, "opening fields").portraits;
      if (mode === "reordered") [shots[1], shots[2]] = [shots[2]!, shots[1]!];
      if (mode === "alias-conflict") shots[0]!.shot_id = "ending";
      if (mode === "non-string-id") shots[0]!.shotId = 0;
      const input = structuredClone(shots);
      const execute = () => h.accepted(run, () => {
        if (mode === "stale-original") writeFileSync(portrait.originals.front!.path, Buffer.alloc(1024, 9));
        // Native entry calls the strict FieldGuard here before the later G6 bind.
        const normalized = requirementRecord(invoke(run.fieldGuard, "normalizeAndValidate", shots, "Layer2-Production"), "layer 2");
        expect(requirementRecord(normalized.report, "layer 2 report")).toMatchObject({ passed: true, errors: [] });
        const references = ["portrait-set://builtin-person/v2/front", "portrait-set://builtin-person/v2/closeup"];
        for (const shot of normalized.shots as RequirementRecord[]) {
          expect(shot.portraits).toEqual(references);
          expect(requirementRecord(shot.fields, "layer 2 fields").portraits).toEqual(references);
          expect(shot).toHaveProperty("degraded", false);
        }
        expect(shots).toEqual(input);
        // The separate native G6 prompt array still requires the normal later binding.
        expect(bindApprovedPrdPortraitSelection(shots)).toEqual(shots.map(shot => ({ shotId: shot.shotId, references })));
      });
      if (mode === "valid") await execute();
      else {
        const error = {
          reordered: "PRD_SCENE_UNVERIFIED",
          "alias-conflict": "PRD_SCENE_UNVERIFIED",
          "non-string-id": "PRD_SCENE_UNVERIFIED",
          "stale-original": "PRD_PORTRAIT_SOURCE_UNVERIFIED",
          "unknown-cast": "PRD_CAST_UNVERIFIED",
          "actor-absent": "Production 25 fields missing: portraits",
          "non-frozen": "Production 25 fields missing: portraits",
          "frozen-with-speech": "Production 25 fields missing: portraits",
        }[mode];
        await expect(execute()).rejects.toThrow(error);
        expect(shots).toEqual(input);
      }
    },
  );

  it("passes a private complete authority identity to native produce without changing the caller blueprint, arguments, result or receiver", async () => {
    const value = fixture("PRODUCE-INPUT"), h = productionHarness(), run = h.make(value);
    const scenes = [{ id: "real-opening", action: "真实首镜动作" }], config = { aspectRatio: "16:9", unknown: { keep: true } };
    const blueprint = { scenes, config, metadata: { intact: "原始资料" }, _workloomProductionAuthority: { forged: true } }, before = structuredClone(blueprint);
    const argument = { llmTimeout: 1234, llmMaxRetries: 2 }, nativeResult = { untouched: "原消费者返回" };
    run.engine.nativeResult = nativeResult;
    await h.accepted(run, async prd => {
      const result = await invoke(run.engine, "produce", blueprint, argument);
      expect(result).toBe(nativeResult);
      const call = h.calls.find(call => call.key === "produce")!, input = call.args[0] as RequirementRecord;
      expect(call.receiver).toBe(run.engine); expect(call.args[1]).toBe(argument);
      expect(input).not.toBe(blueprint); expect(input.scenes).toBe(scenes);
      expect(input.config).not.toBe(config); expect(input.config).toEqual({ ...config, aspectRatio: "9:16" });
      expect(input.metadata).toBe(blueprint.metadata);
      const marker = requirementRecord(input._workloomProductionAuthority, "private production marker");
      expect(marker).toMatchObject({ schemaVersion: "workloom.production-authority/v1", scope: value.scope, profile: value.authority.profile, g4Hash: requirementHash(prd) });
      expect(marker.hash).toBe(requirementHash({ authority: requirementHash(value.authority), g4: requirementHash(prd), scope: value.scope }));
      expect(marker).not.toHaveProperty("forged");
      expect(blueprint).toEqual(before);
    });
    expect(h.calls.filter(call => call.key === "create")).toEqual([expect.objectContaining({ receiver: run.system })]);
    expect(run.calls).toHaveLength(2);
  });

  it.each(["pending", "rejected"])("refuses a %s G4 before native production or its cache can run", async decision => {
    const value = fixture(`PRODUCE-${decision}`), h = productionHarness(), run = h.make(value);
    await expect(withPrdAuthorityScope(value.authority, () => invoke(run.system, "create", async () => {
      const prd = await h.generate(run);
      if (decision === "rejected") { run.system.g4Approved = false; await h.review(run, prd); }
      try { await invoke(run.engine, "produce", { config: {}, scenes: [] }); } catch { /* original consumer cannot swallow the private failure */ }
      return { success: false };
    }))).rejects.toThrow("PRD_REVIEW_UNVERIFIED");
    expect(h.calls.filter(call => call.key !== "create")).toEqual([]);
  });

  it("skips the optional title package and optimizer while keeping the physical opening shot and ordinary field validation", async () => {
    const value = fixture("NO-TITLE"), h = productionHarness(), run = h.make(value), shot = productionShot();
    const before = structuredClone(shot);
    await h.accepted(run, async () => {
      expect(invoke(run.phase1, "_shouldGenerateOpening", { scenes: [shot] })).toBe(false);
      expect(invoke(run.system, "_shouldUseTitleCard")).toBe(false);
      expect(await invoke(run.system, "_optimizeOpeningTitle", { shots: [shot] }, {}, {})).toBeUndefined();
      const result = requirementRecord(invoke(run.fieldGuard, "normalizeAndValidate", [shot], "Final-Export"), "validated");
      expect(requirementRecord(result.report, "report")).toMatchObject({ passed: true, errors: [], summary: { fixedShots: 0, applicableFieldsPerShot: 25 } });
      const normalized = (result.shots as RequirementRecord[])[0]!;
      expect(normalized).toMatchObject({ shotId: shot.shotId, sceneType: "opening", duration: 5, prompt: shot.prompt,
        extraSource: shot.extraSource, _workloomFusion: shot._workloomFusion, fields: shot.fields });
      const detail = (requirementRecord(result.report, "report").details as RequirementRecord[])[0]!;
      expect(detail).toMatchObject({ presentFields: 25, applicableFields: 25, missingSpecFields: [], applicability: { title: "not_applicable", opening_audio_design: "not_applicable" } });
      expect(invoke(run.fieldGuard, "assertOpeningFields", [shot])).toBe(true);
      expect(shot).toEqual(before);
    });
    expect(h.calls.some(call => ["_shouldGenerateOpening", "_optimizeOpeningTitle"].includes(call.key))).toBe(false);
  });

  it.each([
    { aspect: "9:16", resolution: "1080p", fps: 30, pixels: "1080x1920" },
    { aspect: "16:9", resolution: "4K", fps: 25, pixels: "3840x2160" },
    { aspect: "1:1", resolution: "1080p", fps: 60, pixels: "1080x1080" },
  ])("uses explicit native technical template $aspect/$resolution/$fps without mutating shared settings or creative constraints", async ({ aspect, resolution, fps, pixels }) => {
    const value = fixture(`TECH-${fps}`), h = productionHarness();
    requirementRecord(value.metadata.brief, "brief").aspectRatio = aspect;
    Object.assign(requirementRecord(requirementRecord(value.metadata.brief, "brief").productionRequirements, "profile"), { resolution, frameRate: fps });
    refreshContract(value);
    const run = h.make(value); run.refiner._shotConstraintTemplate = "平台错误画像，4K分辨率，24fps";
    const before = { template: run.refiner.constraintTemplate, shotTemplate: run.refiner._shotConstraintTemplate, injected: run.refiner._templateInjected };
    await h.accepted(run, () => {
      expect(invoke(run.refiner, "_normalizeConstraint", "16:9画幅，8K分辨率，24fps，MP4格式", "8K基础"))
        .toBe(`${aspect}画幅，${pixels}分辨率，${fps}fps，MP4格式`);
      const creative = "时长5秒，一镜到底，演员唇形同步且摄影机保持固定机位";
      expect(invoke(run.refiner, "_normalizeConstraint", creative, "原始基础"))
        .toBe(Reflect.apply(nativeConstraint, run.refiner, [creative, "原始基础"]));
      expect({ template: run.refiner.constraintTemplate, shotTemplate: run.refiner._shotConstraintTemplate, injected: run.refiner._templateInjected }).toEqual(before);
    });
  });

  it("does not invent undeclared resolution/fps for a legacy client profile", async () => {
    const value = fixture("TECH-LEGACY"), h = productionHarness();
    delete requirementRecord(value.metadata.brief, "brief").productionRequirements; refreshContract(value);
    const run = h.make(value), body = "16:9画幅，8K分辨率，24fps，MP4格式";
    const expected = Reflect.apply(nativeConstraint, run.refiner, [body, "8K基础"]);
    await h.accepted(run, () => {
      expect(invoke(run.refiner, "_normalizeConstraint", body, "8K基础")).toBe(String(expected).replace("16:9画幅", "9:16画幅"));
      expect(invoke(run.phase1, "_shouldGenerateOpening", {})).toBe(true);
      expect(invoke(run.system, "_shouldUseTitleCard")).toBe(true);
    });
  });

  it.each(["resolution-and-fps", "no-technical-keys"])("honors only explicit %s technical keys while preserving native branches and undeclared defaults", async mode => {
    const value = fixture(`TECH-PARTIAL-${mode}`), h = productionHarness(), brief = requirementRecord(value.metadata.brief, "brief");
    delete brief.aspectRatio;
    if (mode === "no-technical-keys") delete brief.productionRequirements;
    refreshContract(value);
    const run = h.make(value), body = "16:9画幅，8K分辨率，24fps，MP4格式";
    const native = Reflect.apply(nativeConstraint, run.refiner, [body, "8K基础"]);
    const long = "16:9画幅，4K分辨率，24fps，MP4格式，" + "完整技术正文必须保留，不得被模板替换。".repeat(15);
    await h.accepted(run, () => {
      const output = invoke(run.refiner, "_normalizeConstraint", body, "8K基础");
      expect(output).toBe(mode === "resolution-and-fps" ? "16:9画幅，1920x1080分辨率，30fps，MP4格式" : native);
      for (const text of [long, "时长5秒，一镜到底，16:9画幅，4K分辨率，24fps，唇形同步", "保留非技术创作正文原样"]) {
        expect(invoke(run.refiner, "_normalizeConstraint", text, "8K基础")).toBe(Reflect.apply(nativeConstraint, run.refiner, [text, "8K基础"]));
      }
    });
  });

  it("avoids every native stage and shot-cache IO path for an approved authority run", async () => {
    const value = fixture("CACHE-NO-IO"), h = productionHarness(), run = h.make(value), old = { savedAt: "historical", unchanged: true };
    await h.accepted(run, () => {
      expect(invoke(run.engine, "_loadLatestCheckpoint", old)).toBeNull();
      expect(invoke(run.fusion, "_loadSubCheckpoint", {}, "old-hash")).toBeNull();
      for (const [owner, key] of [[run.engine, "_saveCheckpoint"], [run.engine, "_clearCheckpoints"], [run.fusion, "_saveSubCheckpoint"], [run.fusion, "_clearSubCheckpoint"]] as Array<[RequirementRecord, string]>) {
        expect(invoke(owner, key, old)).toBeUndefined();
      }
      expect(old).toEqual({ savedAt: "historical", unchanged: true });
    });
    expect(h.calls.filter(call => /Checkpoint/.test(call.key))).toHaveLength(0);
  });

  it("legacy receivers retain exact cache arguments, title work, native reports and field repair", async () => {
    const value = fixture("PRODUCTION-LEGACY"), h = productionHarness(), run = h.make(value), argument = { preserve: "same object" };
    run.system.metadata = { titleCard: false, _workloomProductionAuthority: { approved: true } };
    expect(invoke(run.system, "_shouldUseTitleCard")).toBe(true);
    expect(invoke(run.phase1, "_shouldGenerateOpening", argument)).toBe(true);
    expect(await invoke(run.system, "_optimizeOpeningTitle", argument)).toEqual({ originalTitlePackage: true });
    const result = await invoke(run.engine, "produce", argument, argument);
    expect(result).toEqual({ nativeProduction: true });
    expect(h.calls.find(call => call.key === "produce")!.args).toEqual([argument, argument]);
    expect(h.calls.find(call => call.key === "produce")!.args[0]).toBe(argument);
    expect(invoke(run.engine, "_loadLatestCheckpoint", argument)).toEqual({ nativeCache: "_loadLatestCheckpoint", args: [argument] });
    expect(invoke(run.fusion, "_clearSubCheckpoint", argument)).toEqual({ nativeCache: "_clearSubCheckpoint", args: [argument] });
    const prompts = [productionShot()];
    expect(invoke(run.system, "_generatePromptsReport", prompts)).toBe(`legacy-report:${JSON.stringify(prompts)}`);
    const repaired = requirementRecord(invoke(run.fieldGuard, "normalizeAndValidate", [{ shotId: "S10", prompt: "原始缺字段" }], "Legacy"), "legacy repaired");
    expect((repaired.shots as RequirementRecord[])[0]).toMatchObject({ degraded: true });
  });

  it("injects only the selected typed wardrobe's complete detail and preserves forbidden-word negatives and generated costume", async () => {
    const value = fixture("WARDROBE-TYPED"), h = productionHarness();
    const character = (value.metadata.characters as RequirementRecord[])[0]!;
    const detail = "黑色短夹克\n白色内搭、深灰全长裤和黑色短靴；禁止头盔、墨镜、面具，保留完整原件。";
    Object.assign(character, { activeWardrobeId: "current", description: '{"wardrobe":"错误JSON夹克不应切片"}',
      wardrobe: [{ id: "old", detail: "旧服装不可用" }, { id: "current", detail }] });
    refreshContract(value);
    const run = h.make(value), actual = structuredClone(value.contract.cast.characters);
    const original = "【角色】合成人物看向商品\n【负面约束】no text，禁止头盔与墨镜，禁止面具。";
    const shots = [{ prompt: original }, { prompt: original, fields: { costume: "模型已给出的白衬衫与黑裤" } },
      { prompt: original + "\n【服装】模型实际服装保持全文，不做规则修正。" }, { prompt: "【角色】另一个人物，没有本次姓名" }];
    const before = structuredClone(shots), charactersBefore = structuredClone(actual);
    await h.accepted(run, () => {
      expect(invoke(run.costume, "enhance", shots, actual)).toBe(shots);
      expect(shots[0]!.prompt).toBe(`【服装锁定】合成人物：${detail}\n${original}`);
      expect(shots[0]).toHaveProperty("promptCharCount", shots[0]!.prompt.length);
      expect(shots.slice(1)).toEqual(before.slice(1)); expect(actual).toEqual(charactersBefore);
      expect(shots[0]!.prompt).not.toContain("错误JSON"); expect(shots[0]!.prompt).not.toContain("旧服装");
    });
  });

  it.each(["wrong-id", "wrong-name", "wrong-source", "duplicate-wardrobe", "missing-wardrobe", "empty-detail"])("rejects %s wardrobe or cast instead of repairing model text", async kind => {
    const value = fixture(`WARDROBE-${kind}`), h = productionHarness();
    const character = (value.metadata.characters as RequirementRecord[])[0]!;
    Object.assign(character, { activeWardrobeId: "current", wardrobe: [{ id: "current", detail: "完整选定黑色夹克" }] });
    if (kind === "duplicate-wardrobe") (character.wardrobe as unknown[]).push({ id: "current", detail: "重复档案" });
    if (kind === "missing-wardrobe") character.wardrobe = [];
    if (kind === "empty-detail") (character.wardrobe as RequirementRecord[])[0]!.detail = "  ";
    refreshContract(value);
    const run = h.make(value), actual = structuredClone(value.contract.cast.characters) as RequirementRecord[];
    if (kind === "wrong-id") actual[0]!.id = "foreign";
    if (kind === "wrong-name") actual[0]!.name = "foreign";
    if (kind === "wrong-source") requirementRecord(actual[0]!.builtinCharacterSource, "source").profileSha256 = "f".repeat(64);
    const shots = [{ prompt: "合成人物看向商品，禁止头盔与墨镜" }], before = structuredClone(shots);
    await expect(h.accepted(run, () => {
      try { invoke(run.costume, "enhance", shots, actual); } catch { /* native caller catches; outer authority must still fail */ }
    })).rejects.toThrow(kind.startsWith("wrong-") ? "PRD_CAST_UNVERIFIED" : "PRD_WARDROBE_UNVERIFIED");
    expect(shots).toEqual(before);
  });

  it.each([...nativeStandardizer.CRITICAL_FIELDS.p0, ...nativeStandardizer.CRITICAL_FIELDS.p1,
    ...nativeStandardizer.CRITICAL_FIELDS.p2, ...nativeStandardizer.CRITICAL_FIELDS.p3])("requires real %s content across all 25 fields without local defaults", async key => {
    const value = fixture(`MISSING-${key}`), h = productionHarness(), run = h.make(value), shot = productionShot();
    delete shot[key]; delete requirementRecord(shot.fields, "fields")[key];
    const before = structuredClone(shot);
    await expect(h.accepted(run, () => {
      const result = requirementRecord(invoke(run.fieldGuard, "check", [shot], "Final-Export"), "check");
      expect(result.passed).toBe(false);
      const detail = (requirementRecord(result.report, "report").details as RequirementRecord[])[0]!;
      expect(detail.missingSpecFields).toContain(key); expect(detail.presentFields).toBe(24);
      try { invoke(run.fieldGuard, "normalizeAndValidate", [shot], "Final-Export"); } catch { /* must remain sticky */ }
    })).rejects.toThrow(`Production 25 fields missing: ${key}`);
    expect(shot).toEqual(before); expect(shot).not.toHaveProperty("degraded");
  });

  it.each(["dialogue-free", "structured-blocks"])("accepts explicit %s dialogue applicability without synthesizing a line", async mode => {
    const value = fixture(`DIALOGUE-${mode}`), h = productionHarness(), run = h.make(value), shot = productionShot();
    delete shot.dialogue; delete requirementRecord(shot.fields, "fields").dialogue;
    if (mode === "dialogue-free") shot.dialogueFree = true;
    else shot.dialogueBlocks = [{ speaker: "合成人物", line: "只看外观。", emotion: "calmly", trigger: "看向商品", manner: "自然轻声", type: "on-screen" }];
    const before = structuredClone(shot);
    await h.accepted(run, () => {
      const result = requirementRecord(invoke(run.fieldGuard, "normalizeAndValidate", [shot], "Final-Export"), "validated");
      expect(requirementRecord(result.report, "report")).toMatchObject({ passed: true, errors: [] });
      const normalized = (result.shots as RequirementRecord[])[0]!;
      expect(normalized.dialogue).toEqual([]); expect(normalized).toMatchObject(mode === "dialogue-free" ? { dialogueFree: true } : { dialogueBlocks: shot.dialogueBlocks });
      expect(shot).toEqual(before);
    });
  });

  it.each(["negative", "scene", "title-leak", "empty-shots", "missing-id"])("keeps %s defects visible and fatal at strict validation", async kind => {
    const value = fixture(`BAD-${kind}`), h = productionHarness(), run = h.make(value), shot = productionShot();
    if (kind === "negative") { shot.negative = "no watermark only"; requirementRecord(shot.fields, "fields").negative = shot.negative; }
    if (kind === "scene") { shot.scene = "全息数据空间中的抽象场景"; requirementRecord(shot.fields, "fields").scene = shot.scene; }
    if (kind === "title-leak") shot.prompt += "\n【主标题内容】不能在生成侧重新出现";
    if (kind === "missing-id") shot.shotId = "";
    const shots = kind === "empty-shots" ? [] : [shot], before = structuredClone(shots);
    await expect(h.accepted(run, () => {
      try { invoke(run.fieldGuard, "assertOpeningFields", shots); } catch { /* cannot turn a defect into a successful authority scope */ }
    })).rejects.toThrow(kind === "empty-shots" ? "PRD_PRODUCTION_INVALID" : "PRD_PRODUCTION_FIELDS_INVALID");
    expect(shots).toEqual(before);
  });

  it("renders every G6 prompt byte and long fence safely, counts actual fields and retains defects for the real reviewer", async () => {
    const value = fixture("G6-COMPLETE"), h = productionHarness(), run = h.make(value), shot = productionShot();
    shot.prompt = `${shot.prompt}\n${"【情绪】只有重复标签不会增加字段覆盖率。".repeat(700)}\n\`\`\`\`\`\`用户原始围栏\n真正尾部SENTINEL`;
    delete shot.makeup; delete requirementRecord(shot.fields, "fields").makeup;
    const before = structuredClone(shot);
    await h.accepted(run, () => {
      const report = invoke(run.system, "_generatePromptsReport", [shot]) as string;
      expect(report).toContain(`\`\`\`\`\`\`\`text\n${String(shot.prompt)}\n\`\`\`\`\`\`\``);
      expect(report).toContain("24/25 | fail"); expect(report).toContain("Production 25 fields missing: makeup");
      expect(report).toContain("exceeds 12000 char limit"); expect(report).toContain("G6 仍须审核事实用途");
      expect(report).toContain("subtitle 指片头副标题，正式后期字幕仍按 Brief 执行");
      expect(report).not.toContain("待生成"); expect(report).not.toContain("请补充"); expect(shot).toEqual(before);
    });
    expect(h.calls.some(call => call.key === "_generatePromptsReport")).toBe(false);
  });

  it("retires precisely the two native S00 title quality predicates while retaining scores, booleans and prompt content", async () => {
    const value = fixture("QUALITY-TITLE"), h = productionHarness(), run = h.make(value), shot = productionShot("S00"), before = structuredClone(shot);
    const original = requirementRecord(Reflect.apply(nativeQuality, run.qualityGate, [[shot], null]), "native quality");
    expect(original.passed).toBe(false);
    await h.accepted(run, () => {
      const result = requirementRecord(invoke(run.qualityGate, "run", [shot]), "quality"), detail = (result.checks as RequirementRecord[])[0]!;
      expect(result).toMatchObject({ passed: true, passedCount: 1 });
      expect(detail).toEqual({ ...(original.checks as RequirementRecord[])[0], passed: true, hasAudioLayer: null, hasTitleOverlay: null,
        applicability: { audioLayer: "not_applicable", titleOverlay: "not_applicable" } });
      expect(shot).toEqual(before);
    });
  });

  it.each(["scene", "short-prompt", "placeholder", "length", "score"])("native quality gate still fails %s after title retirement", async kind => {
    const value = fixture(`QUALITY-${kind}`), h = productionHarness(), run = h.make(value), shot = productionShot("S00");
    if (kind === "scene") shot.scene = "";
    if (kind === "short-prompt") shot.prompt = "过短";
    if (kind === "placeholder") shot.prompt += "[角色名]";
    if (kind === "length") shot.promptCharCount = 3001;
    const threshold = kind === "score" ? { acceptanceCriteria: { visual: 1.2, narrative: 1.2 } } : null;
    const before = structuredClone(shot);
    await h.accepted(run, () => {
      const result = requirementRecord(invoke(run.qualityGate, "run", [shot], threshold), "quality");
      expect(result.passed).toBe(false); expect(result.passedCount).toBe(0); expect(result.failedFields).toHaveLength(1);
      const detail = (result.checks as RequirementRecord[])[0]!;
      if (kind === "scene") expect(detail.hasScene).toBe(false);
      if (kind === "short-prompt") expect(detail.hasPrompt).toBe(false);
      if (kind === "placeholder") expect(detail.hasPlaceholder).toBe(true);
      if (kind === "length") expect(detail.withinLimit).toBe(false);
      if (kind === "score") expect(Number(detail.overallScore)).toBeLessThan(120);
      expect(shot).toEqual(before);
    });
  });

  it("real delivery guard removes only five missing title issues, preserving the original shot and all native measurements", async () => {
    const value = fixture("DELIVERY-TITLE"), h = productionHarness(), run = h.make(value), prompt = deliveryPrompt(), shot = { shotId: "S00", sceneType: "opening", duration: 5 };
    const native = requirementRecord(Reflect.apply(nativeDelivery, run.deliveryGuard, [prompt, shot]), "native delivery"), before = structuredClone(shot);
    expect(native.issues).toHaveLength(5);
    await h.accepted(run, () => {
      const result = requirementRecord(invoke(run.deliveryGuard, "verify", prompt, shot), "delivery");
      expect(result).toMatchObject({ pass: true, issues: [], expectedMin: 25, fieldCount: native.fieldCount, charCount: native.charCount });
      expect(Object.keys(requirementRecord(result.applicability, "applicability"))).toHaveLength(7); expect(shot).toEqual(before);
    });
  });

  it.each(["missing-field", "too-short", "too-long", "emotion", "invented-dialogue", "retired-label"])("real delivery guard retains %s defects", async kind => {
    const value = fixture(`DELIVERY-${kind}`), h = productionHarness(), run = h.make(value), shot = { shotId: "S00", sceneType: "opening", duration: 5 };
    let prompt = deliveryPrompt();
    if (kind === "missing-field") prompt = prompt.replace("【导演意图】", "【其他说明】");
    if (kind === "too-short") prompt = "【情绪】人物眼睛眨动";
    if (kind === "too-long") prompt += "原始内容".repeat(1000);
    if (kind === "emotion") prompt = prompt.replace(/【情绪】[^\n]+/, "【情绪】紧张");
    if (kind === "invented-dialogue") prompt += '\n【台词】[0s-3s] 合成人物，平静地说:"看看外观。"';
    if (kind === "retired-label") prompt += "\n【开场音频设计】违规标题包";
    const native = requirementRecord(Reflect.apply(nativeDelivery, run.deliveryGuard, [prompt, shot]), "native delivery");
    await h.accepted(run, () => {
      const result = requirementRecord(invoke(run.deliveryGuard, "verify", prompt, shot), "delivery");
      const expected = (native.issues as string[]).filter(issue => !issue.startsWith("缺片头专属字段:"));
      if (kind === "retired-label") expected.push("生成侧重新出现已退休片头标题字段");
      expect(result.pass).toBe(false); expect(result.issues).toEqual(expected);
    });
  });

  it("aligns native fusion, field completion and semantic prompt templates with verified silent production", async () => {
    const value = fixture("FUSION-SILENT");
    declareDelivery(value, { speechPolicy: "none" });
    const h = productionHarness(true), run = h.make(value);
    const originalScene = "后轮卷起尘土，保留引擎与轮胎声；创作原文要求不要写旁白";
    const shot = { shotId: "S01", sceneType: "opening", duration: 10, scene: originalScene,
      dialogue: "", dialogueText: "", dialogueBlocks: [] };
    const semantic = Object.create(SemanticRefinementPass.prototype) as RequirementRecord;
    const base = deliveryPrompt() + "\n【台词】无台词";
    const baseline = invoke(Object.create(PromptFusionAgent.prototype) as RequirementRecord, "_getSystemPrompt");
    expect(baseline).toContain("台词必须是角色直接对话");
    await h.accepted(run, () => {
      const system = invoke(run.fusion, "_getSystemPrompt") as string;
      const batch = invoke(run.fusion, "_buildBatchPrompt", [shot], "9:16", [], {}) as string;
      const fill = invoke(run.fusion, "_buildFillPrompt", shot, ["dialogue", "audio"], {}, "9:16", []) as string;
      const refinement = invoke(semantic, "_buildPrompt", base, shot) as string;
      for (const prompt of [system, batch, fill, refinement]) {
        expect(prompt).toContain("禁止可辨识人声");
        expect(prompt).not.toMatch(/台词必须是角色直接对话|只放角色嘴里的台词|角色直接对镜头说话|台词\/旁白原文|如台词引号缺失、半句话/);
      }
      expect(batch).toContain(originalScene);
      expect(batch).toContain('constraint 固定为"9:16画幅，1080p分辨率，30fps，MP4格式"');
      expect(refinement).toContain("titleCard=false");
      expect(refinement.endsWith(base)).toBe(true);
    });
  });

  it.each(["batch", "semantic"])("rejects positive native speech aliases before %s dispatch", async stage => {
    const value = fixture(`FUSION-SILENT-${stage}`);
    declareDelivery(value, { speechPolicy: "none" });
    const h = productionHarness(true), run = h.make(value);
    const shot = { shotId: "S01", duration: 10, scene: "弯道", dialogue: "无台词", dialogueBlocks: [],
      fields: { dialogueText: "车手说：我赢了。" } };
    const semantic = Object.create(SemanticRefinementPass.prototype) as RequirementRecord;
    await expect(h.accepted(run, () => stage === "batch"
      ? invoke(run.fusion, "_buildBatchPrompt", [shot], "9:16", [], {})
      : invoke(semantic, "_buildPrompt", deliveryPrompt(), shot)
    )).rejects.toThrow("PRD_SPEECH_CONFLICT");
  });

  it("real semantic refine consumes the revised instruction, preserves its actual input and applies the original output through the real guard", async () => {
    const value = fixture("SEMANTIC-TITLE"), h = productionHarness(), run = h.make(value), prompt = deliveryPrompt(), shot = { shotId: "S00", sceneType: "opening", duration: 5 };
    const actions = [{ type: "水分压缩", field: "场景", description: "删除重复短句" }], output = prompt.replace("封闭场地", "拍摄场地");
    const call = vi.fn(async () => ({ result: { prompt: output, actions } }));
    const semantic = new SemanticRefinementPass({ callLLM: call, guard: run.deliveryGuard, maxTokens: 4321, timeoutMs: 7890 });
    const native = Reflect.apply(nativeSemantic, semantic, [prompt, shot]) as string;
    await h.accepted(run, async () => {
      const result = requirementRecord(await invoke(semantic, "refine", prompt, shot), "semantic result");
      expect(result).toMatchObject({ prompt: output, actions, applied: true, fallbackReason: null, guard: { pass: true } });
      expect(call).toHaveBeenCalledTimes(1);
      const request = (call.mock.calls as unknown[][])[0]!, actual = String(request[0]);
      expect(actual).not.toContain("，片头 5 个专属字段保留"); expect(actual).toContain("titleCard=false");
      expect(actual.slice(actual.indexOf("\n【待精炼提示词】\n"))).toBe(native.slice(native.indexOf("\n【待精炼提示词】\n")));
      expect(request[3]).toEqual({ maxTokens: 4321, timeoutMs: 7890, maxRetries: 2 });
      expect(request[1]).toMatchObject({ required: ["prompt", "actions"] }); expect(typeof request[2]).toBe("function");
    });
  });

  it("real semantic refinement keeps the native failed-guard and provider-error fallbacks without pretending they were applied", async () => {
    const value = fixture("SEMANTIC-ERROR"), h = productionHarness(), run = h.make(value), prompt = deliveryPrompt(), shot = { shotId: "S00", sceneType: "opening", duration: 5 };
    await h.accepted(run, async () => {
      const rejected = new SemanticRefinementPass({ guard: run.deliveryGuard, callLLM: async () => ({ result: { prompt: "短文本", actions: [] } }) });
      expect(await invoke(rejected, "refine", prompt, shot)).toMatchObject({ prompt, applied: false, fallbackReason: expect.stringContaining("守卫拦截"), guard: { pass: false } });
      const failed = new SemanticRefinementPass({ guard: run.deliveryGuard, callLLM: async () => { throw new Error("original provider error"); } });
      expect(await invoke(failed, "refine", prompt, shot)).toMatchObject({ prompt, applied: false, fallbackReason: "LLM调用异常:original provider error", guard: null });
    });
  });

  it("unbound real quality, delivery and semantic consumers retain byte-exact native behavior", () => {
    const h = productionHarness(), run = h.make(fixture("NATIVE-CONSUMER-LEGACY")), shot = productionShot("S00"), prompt = deliveryPrompt();
    const semantic = new SemanticRefinementPass({ callLLM: async () => { throw new Error("not called"); } });
    expect(invoke(run.qualityGate, "run", [shot])).toEqual(Reflect.apply(nativeQuality, run.qualityGate, [[shot]]));
    expect(invoke(run.deliveryGuard, "verify", prompt, shot)).toEqual(Reflect.apply(nativeDelivery, run.deliveryGuard, [prompt, shot]));
    expect(invoke(semantic, "_buildPrompt", prompt, shot)).toBe(Reflect.apply(nativeSemantic, semantic, [prompt, shot]));
  });

  it("carries the full G2 theme and its original verdict only after actual G4 approval", async () => {
    const value = fixture("THEME-COMPLETE"), h = productionHarness(), run = h.make(value), capture = productionAdapter();
    const theme = { theme: "完整真实主题与艺术参考".repeat(1600), decision: { approved: true, issues: ["原始G2意见"], suggestions: ["只支持创意表达，不提高商品事实等级"] } };
    const getTheme = vi.fn(() => theme), before = structuredClone(theme);
    await withPrdAuthorityScope(value.authority, async () => {
      expect(productionModelInput("G4之前").prompt).toBe("G4之前"); expect(getTheme).not.toHaveBeenCalled();
      const prd = await h.generate(run); await h.review(run, prd);
      await capture.adapter.reason("本次真实后续制作任务");
      const prompt = capture.requests[0]!.messages.at(-1)!.content;
      expect(prompt).toContain(JSON.stringify(theme)); expect(prompt).toContain(requirementHash(theme));
      expect(prompt).toContain("原始裁决"); expect(prompt).toContain(value.content); expect(theme).toEqual(before);
      return h.success(prd);
    }, undefined, getTheme);
    expect(capture.requests).toHaveLength(1);
  });

  it.each(["before-request", "in-flight"])("rejects a changed approved G2 %s and keeps failure sticky through a native catch", async phase => {
    const value = fixture(`THEME-${phase}`), h = productionHarness(), run = h.make(value), capture = productionAdapter();
    const theme = { original: "本次完整G2主题", verdict: { approved: true } };
    if (phase === "in-flight") {
      const provider = capture.adapter;
      // Retain the real adapter request path while changing the authoritative
      // object during the existing provider await, without another paid call.
      const original = provider.reason;
      provider.reason = async function (...args) {
        const result = original.apply(this, args); theme.original = "请求期间未重新审核的主题"; return result;
      };
    }
    await expect(h.accepted(run, async () => {
      if (phase === "before-request") theme.original = "未重新审核的主题";
      try { await capture.adapter.reason("不能继承旧G2"); } catch { /* caller catches; authority remains failed */ }
    }, { theme: () => theme })).rejects.toThrow("PRD_REVIEW_UNVERIFIED");
    expect(capture.requests).toHaveLength(phase === "before-request" ? 0 : 1);
  });

  it("interleaved production scopes keep independent profiles, approved hashes and exact technical templates", async () => {
    const h = productionHarness(), values = [fixture("PRODUCTION-A"), fixture("PRODUCTION-B")];
    requirementRecord(values[1]!.metadata.brief, "brief").aspectRatio = "16:9";
    Object.assign(requirementRecord(requirementRecord(values[1]!.metadata.brief, "brief").productionRequirements, "profile"), { resolution: "4K", frameRate: 60 });
    refreshContract(values[1]!);
    const runs = values.map(value => h.make(value)), ready = [deferred<void>(), deferred<void>()], release = [deferred<void>(), deferred<void>()];
    const seen: Array<{ index: number; prdHash: string; template: unknown }> = [];
    const pending = runs.map((run, index) => h.accepted(run, async prd => {
      ready[index]!.resolve(); await release[index]!.promise;
      await invoke(run.engine, "produce", { config: {}, scenes: [{ id: index }] });
      seen.push({ index, prdHash: requirementHash(prd), template: invoke(run.refiner, "_normalizeConstraint", "16:9画幅，8K分辨率，24fps，MP4格式", "基础") });
    }));
    await Promise.all(ready.map(item => item.promise)); release[1]!.resolve(); await pending[1]; release[0]!.resolve(); await pending[0];
    expect(seen.map(item => item.index)).toEqual([1, 0]);
    expect(seen.map(item => item.template)).toEqual(["16:9画幅，3840x2160分辨率，60fps，MP4格式", "9:16画幅，1080x1920分辨率，30fps，MP4格式"]);
    const produces = h.calls.filter(call => call.key === "produce");
    for (const [position, index] of [1, 0].entries()) {
      const marker = requirementRecord((produces[position]!.args[0] as RequirementRecord)._workloomProductionAuthority, "marker");
      expect(marker).toMatchObject({ scope: values[index]!.scope, profile: values[index]!.authority.profile, g4Hash: seen[position]!.prdHash });
      expect(produces[position]!.receiver).toBe(runs[index]!.engine);
    }
    expect(produces[0]!.args[0]).not.toEqual(produces[1]!.args[0]);
  });

  it("rejects a receiver borrowed from another still-active production scope and marks both operations fatal", async () => {
    const h = productionHarness(), a = h.make(fixture("CROSS-PRODUCTION-A")), b = h.make(fixture("CROSS-PRODUCTION-B"));
    const ready = deferred<void>(), release = deferred<void>();
    const runningA = h.accepted(a, async () => {
      invoke(a.phase1, "_shouldGenerateOpening", {}); ready.resolve(); await release.promise;
    });
    const assertionA = expect(runningA).rejects.toThrow("PRD_SCOPE_CONFLICT");
    await ready.promise;
    await expect(h.accepted(b, () => {
      try { invoke(a.phase1, "_shouldGenerateOpening", {}); } catch { /* even a swallowed cross-run access is fatal */ }
    })).rejects.toThrow("PRD_SCOPE_CONFLICT");
    release.resolve(); await assertionA;
  });

  it("bound production objects reject calls after scope closure and inherited late callbacks cannot touch cache IO", async () => {
    const h = productionHarness(), run = h.make(fixture("CLOSED-PRODUCTION")), release = deferred<void>();
    let late: Promise<unknown> | undefined;
    await h.accepted(run, () => {
      invoke(run.engine, "_loadLatestCheckpoint"); invoke(run.phase1, "_shouldGenerateOpening", {});
      late = release.promise.then(() => invoke(run.fusion, "_saveSubCheckpoint", "late"));
    });
    expect(() => invoke(run.engine, "_loadLatestCheckpoint")).toThrow("PRD_SCOPE_CONFLICT");
    expect(() => invoke(run.phase1, "_shouldGenerateOpening", {})).toThrow("PRD_SCOPE_CONFLICT");
    // The first out-of-scope access already made this scope fatal. Later
    // inherited work must retain that original conflict instead of replacing it.
    const assertion = expect(late!).rejects.toThrow("PRD_SCOPE_CONFLICT"); release.resolve(); await assertion;
    expect(h.calls.some(call => /Checkpoint/.test(call.key))).toBe(false);
  });

  it("an otherwise successful scope rejects its first inherited late production callback before native cache work", async () => {
    const h = productionHarness(), run = h.make(fixture("LATE-PRODUCTION")), release = deferred<void>();
    let late: Promise<unknown> | undefined;
    await h.accepted(run, () => { late = release.promise.then(() => invoke(run.fusion, "_saveSubCheckpoint", "late")); });
    const assertion = expect(late!).rejects.toThrow("PRD_SCOPE_CLOSED"); release.resolve(); await assertion;
    expect(h.calls.some(call => /Checkpoint/.test(call.key))).toBe(false);
  });

  it.each(["method", "standardizer", "validator", "fields"])("rejects changed production %s identity without hiding the error during cleanup", async kind => {
    const h = productionHarness(), run = h.make(fixture(`TAMPER-${kind}`));
    const descriptor = Object.getOwnPropertyDescriptor(h.deps.fieldGuardPrototype, "check")!;
    const originalStandardizer = h.deps.standardizeShot, originalValidator = h.deps.validateShot, originalFields = h.deps.fields;
    await expect(h.accepted(run, () => {
      try {
        if (kind === "method") Object.defineProperty(h.deps.fieldGuardPrototype, "check", { ...descriptor, enumerable: !descriptor.enumerable });
        if (kind === "standardizer") h.deps.standardizeShot = shot => shot;
        if (kind === "validator") h.deps.validateShot = () => ({ passed: true, errors: [], warnings: [] });
        if (kind === "fields") { h.deps.fields = structuredClone(originalFields); h.deps.fields.p2[0] = "foreign-field"; }
        try { invoke(run.fieldGuard, "check", [productionShot()]); } catch { /* restoration must not erase this fatal error */ }
        if (kind === "method") expect(() => h.disposeProduction()).toThrow("PRD_BRIDGE_CHANGED");
      } finally {
        Object.defineProperty(h.deps.fieldGuardPrototype, "check", descriptor);
        h.deps.standardizeShot = originalStandardizer; h.deps.validateShot = originalValidator; h.deps.fields = originalFields;
      }
    })).rejects.toThrow("PRD_BRIDGE_CHANGED");
  });

  it("restores every real production prototype descriptor exactly and deletes the optional title hook", () => {
    const h = productionHarness();
    expect(Object.hasOwn(h.prototype, "_shouldUseTitleCard")).toBe(true);
    expect(() => installPrdProductionBridge(h.deps)).toThrow("PRD_BRIDGE_ACTIVE");
    h.disposeProduction(); h.disposeProduction();
    for (const [key, descriptors] of Object.entries(h.originals)) {
      expect(Object.getOwnPropertyDescriptors(h.deps[key as keyof typeof h.deps])).toEqual(descriptors);
    }
    expect(Object.hasOwn(h.prototype, "_shouldUseTitleCard")).toBe(false);
  });

  it("invalid native production dependencies fail before any prototype is changed", () => {
    const h = productionHarness(); h.disposeProduction();
    const before = Object.fromEntries(Object.entries(h.deps).filter(([key]) => key.endsWith("Prototype"))
      .map(([key, value]) => [key, Object.getOwnPropertyDescriptors(value)]));
    const broken = { ...h.deps, fields: { ...h.deps.fields, p3: [] } };
    expect(() => installPrdProductionBridge(broken)).toThrow("PRD_VENDOR_UNAVAILABLE");
    for (const [key, descriptors] of Object.entries(before)) expect(Object.getOwnPropertyDescriptors(h.deps[key as keyof typeof h.deps])).toEqual(descriptors);
    const missing = { ...h.deps, deliveryGuardPrototype: {} };
    expect(() => installPrdProductionBridge(missing)).toThrow("PRD_VENDOR_UNAVAILABLE");
    for (const [key, descriptors] of Object.entries(before)) expect(Object.getOwnPropertyDescriptors(h.deps[key as keyof typeof h.deps])).toEqual(descriptors);
  });

  it("the real tsx/CJS production installer wires every native consumer and restores all prototypes without a vendor system constructor or services", () => {
    const value = fixture("NATIVE-PRODUCTION-INSTALL"), script = `${value.workDir}/native-production-install.mts`;
    const repo = fileURLToPath(new URL("../../../", import.meta.url)), source = (name: string) => JSON.stringify(fileURLToPath(new URL(name, import.meta.url)));
    writeFileSync(script, `
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { createRequire } from "node:module";
import { acquireVendorRequirementEntry } from ${source("./vendor-requirement-entry.ts")};
import { installPrdAuthorityBridge, installVendorPrdProductionBridge, withPrdAuthorityScope } from ${source("./prd-authority-bridge.ts")};
import { prdFixture, PRDGenerator, PRDSchema } from ${source("./prd-authority.test-support.ts")};
const fixture = prdFixture("REAL-CJS-PRODUCTION"), timers = new Set();
const hook = createHook({ init(_id, type, _parent, resource) { if (type === "Timeout") timers.add(resource); } });
let lease, restoreAuthority = () => undefined, restoreProduction = () => undefined, receipt, clearedTimers = 0;
hook.enable();
try {
 const entry = ${JSON.stringify(repo + "vendor/supermickey/hyperreality-system/index.js")};
 lease = acquireVendorRequirementEntry(entry);
 const { HyperrealitySystem } = lease.exports;
 const require = createRequire(entry);
 const load = (file, name) => require(${JSON.stringify(repo + "vendor/supermickey/hyperreality-system/")} + file)[name];
 const ProductionEngine = load("engines/production-engine/production-engine.js", "ProductionEngine");
 const Phase1SceneDesign = load("engines/production-engine/phases/phase-1-scene-design.js", "Phase1SceneDesign");
 const PromptFusionAgent = load("engines/production-engine/agents/prompt-fusion-agent.js", "PromptFusionAgent");
 const FieldConsistencyChecker = load("engines/field-consistency-checker.js", "FieldConsistencyChecker");
 const FieldContentRefiner = load("engines/production-engine/agents/field-content-refiner.js", "FieldContentRefiner");
 const CharacterCostumePrompter = load("engines/character-system/character-costume-prompter.js", "CharacterCostumePrompter");
 const FieldGuard = load("engines/field-guard.js", "FieldGuard");
 const QualityGate = load("engines/production-engine/utils/quality-gate.js", "QualityGate");
 const PromptDeliveryGuard = load("engines/production-engine/agents/prompt-delivery-guard.js", "PromptDeliveryGuard");
 const SemanticRefinementPass = load("engines/production-engine/agents/semantic-refinement-pass.js", "SemanticRefinementPass");
 const prototypes = [HyperrealitySystem, ProductionEngine, Phase1SceneDesign, PromptFusionAgent, FieldContentRefiner, FieldConsistencyChecker, CharacterCostumePrompter, FieldGuard, QualityGate, PromptDeliveryGuard, SemanticRefinementPass].map(value => value.prototype);
 const before = prototypes.map(value => Object.getOwnPropertyDescriptors(value));
 class AuthoritySystem {
  constructor(generator) { this.prdGenerator = generator; }
  async _confirmRequirementList(_markdown, list) { return { approved: true, requirementList: list }; }
  _generateMinimalPRD() { throw new Error("unexpected fallback"); }
  async _confirmPRD(_markdown, prd) { return { approved: true, prd }; }
  _runProductTruthCheckGate(metadata, result) { return Reflect.apply(HyperrealitySystem.prototype._runProductTruthCheckGate, this, [metadata, result]); }
 }
 const generator = new PRDGenerator();
 for (const [key, payload] of [["agent2", fixture.creative], ["agent3", fixture.production]]) {
  generator[key]._llmEngineLoaded = true;
  generator[key]._llmEngine = { reasonStructured: async () => ({ success: true, data: structuredClone(payload) }) };
 }
 const approved = new AuthoritySystem(generator);
 restoreAuthority = installPrdAuthorityBridge(AuthoritySystem.prototype, PRDGenerator.prototype, PRDSchema);
 restoreProduction = installVendorPrdProductionBridge(HyperrealitySystem, entry);
 const truthMetadata = structuredClone(fixture.metadata);
 const truthResult = { stages: { dataMining: { data: { dossier: { identity: { specs: { syntheticParameter: "9999cc" },
  official_selling_points: [{ point: "赛道专用车辆，不具备道路行驶资质" }] } } } } } };
 const baselineMetadata = structuredClone(truthMetadata), baselineTruth = structuredClone(truthResult);
 const baselineVerdict = Reflect.apply(HyperrealitySystem.prototype._runProductTruthCheckGate, approved, [baselineMetadata, baselineTruth]);
 const system = Object.create(HyperrealitySystem.prototype), engine = Object.create(ProductionEngine.prototype);
 const phase1 = Object.create(Phase1SceneDesign.prototype), fusion = Object.create(PromptFusionAgent.prototype);
 const refiner = new FieldContentRefiner(), fieldGuard = new FieldGuard(), quality = new QualityGate(), delivery = new PromptDeliveryGuard();
 const consistency = new FieldConsistencyChecker({ logLevel: "silent" });
 const shot = ${JSON.stringify(productionShot("S00"))}, prompt = ${JSON.stringify(deliveryPrompt())};
 const semantic = new SemanticRefinementPass({ guard: delivery, callLLM: async () => ({ result: { prompt, actions: [] } }) });
 let consumerChecks = 0;
 const check = (actual, expected) => { assert.equal(actual, expected); consumerChecks += 1; };
 receipt = await withPrdAuthorityScope(fixture.authority, async () => {
  const truthVerdict = approved._runProductTruthCheckGate(truthMetadata, truthResult);
  assert.deepEqual(truthVerdict, baselineVerdict);
  const { factRedLines, _workloomNativeFactRedLines, timing, ...truthUnchanged } = truthResult.stages.truthCheck;
  const { factRedLines: nativeRedLines, timing: nativeTiming, ...baselineUnchanged } = baselineTruth.stages.truthCheck;
  assert.deepEqual(truthUnchanged, baselineUnchanged);
  assert.deepEqual(_workloomNativeFactRedLines, nativeRedLines);
  assert.deepEqual(truthMetadata._workloomNativeFactRedLines, nativeRedLines);
  assert.deepEqual(truthMetadata._factRedLines, factRedLines);
  assert.ok(JSON.stringify(nativeRedLines).includes("9999cc"));
  assert.ok(!JSON.stringify(factRedLines).includes("9999cc"));
  assert.ok(JSON.stringify(factRedLines).includes("来源未核实"));
  await approved._confirmRequirementList("G3", fixture.list);
  const prd = await generator.generate(fixture.discovery);
  await approved._confirmPRD(generator.generateMarkdown(prd), prd);
  check(system._shouldUseTitleCard(), false);
  check(phase1._shouldGenerateOpening({}), false);
  check(await system._optimizeOpeningTitle([shot]), undefined);
  check(engine._loadLatestCheckpoint(), null);
  check(engine._saveCheckpoint("must not write"), undefined);
  check(fusion._loadSubCheckpoint({}), null);
  check(fusion._clearSubCheckpoint(), undefined);
  const audio = "入弯转速抬高，只保留引擎声、换挡声和轮胎摩擦声。";
  check(consistency._checkDialogueAudio({ dialogue: "无（本镜无对白、无口播、无旁白）。", audio }).length, 0);
  check(consistency._checkDialogueAudio({ dialogue: "无台词。她说：我赢了。", audio }).length, 1);
  check(consistency._checkDialogueAudio({ dialogue: "无台词,本镜英子不开口，全片无对白、无口播、无旁白，只保留原生机械与环境声。", audio }).length, 0);
  check(consistency._checkDialogueAudio({ dialogue: "无台词（全片无对白、无口播、无旁白）。", audio }).length, 0);
  const fusionPrompt = fusion._buildBatchPrompt([], "9:16", [], {});
  check(fusionPrompt.includes('constraint 固定为"9:16画幅，1080p分辨率，30fps，MP4格式"'), true);
  check(fusionPrompt.includes('constraint 固定为"16:9画幅，4K分辨率，24fps，MP4格式"'), false);
  const negativeNote = delivery.verify(prompt + " | 【台词】无（本镜无对白、无口播、无旁白）。", { shotId: "S00", sceneType: "opening", duration: 5 });
  check(negativeNote.issues.some(issue => issue.includes("台词")), false);
  const falseNegative = delivery.verify(prompt + " | 【台词】无台词。她说：我赢了。", { shotId: "S00", sceneType: "opening", duration: 5 });
  check(falseNegative.issues.some(issue => issue.includes("台词")), true);
  check(refiner._normalizeConstraint("16:9画幅，4K分辨率，24fps，MP4格式"), "9:16画幅，1080x1920分辨率，30fps，MP4格式");
  check(fieldGuard.normalizeAndValidate([shot], "Final-Export").report.passed, true);
  check(quality.run([shot]).passed, true);
  check(delivery.verify(prompt, { shotId: "S00", sceneType: "opening", duration: 5 }).pass, true);
  check((await semantic.refine(prompt, { shotId: "S00", sceneType: "opening", duration: 5 })).applied, true);
  check(system._generatePromptsReport([shot]).includes(shot.prompt), true);
  return { success: true, stages: { prdGeneration: { data: prd } }, consumerChecks, nativeTruthVerified: true };
 });
 restoreProduction(); restoreProduction = () => undefined;
 for (let index = 0; index < prototypes.length; index++) assert.deepEqual(Object.getOwnPropertyDescriptors(prototypes[index]), before[index]);
 receipt = { success: receipt.success, consumerChecks: receipt.consumerChecks, nativeTruthVerified: receipt.nativeTruthVerified, restoredPrototypes: prototypes.length };
} finally {
 try { restoreProduction(); } finally {
  try { restoreAuthority(); } finally {
   try { if (lease) lease.release(); } finally {
    hook.disable(); for (const timer of timers) { clearTimeout(timer); clearedTimers += 1; }
    fixture.cleanup();
   }
  }
 }
}
console.log("RESULT " + JSON.stringify({ ...receipt, clearedTimers }));
`, "utf8");
    const stdout = execFileSync(process.execPath, [`${repo}node_modules/tsx/dist/cli.mjs`, script], { cwd: repo, timeout: 20000, encoding: "utf8" });
    const result = JSON.parse(stdout.split("\n").find(line => line.startsWith("RESULT "))!.slice(7));
    expect(result).toMatchObject({ success: true, consumerChecks: 21, nativeTruthVerified: true, restoredPrototypes: 11 });
    expect(result.clearedTimers).toBeGreaterThanOrEqual(2);
  });
});
