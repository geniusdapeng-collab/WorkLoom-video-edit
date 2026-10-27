import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatOptions, ModelProvider } from "@workloom/base/model-router";
import { bindRequirementContract, requirementCast, requirementHash, requirementRecord, type RequirementContract, type RequirementRecord } from "./requirement-contract.js";
import { effectivePrdModelSchema, prdAuthorityPrompt, preparePrdAuthority } from "./prd-authority.js";
import { assertPrdAuthorityBridge, installPrdAuthorityBridge, installPrdProductionBridge, productionModelInput, withPrdAuthorityScope } from "./prd-authority-bridge.js";
import { WorkloomLLMEngine } from "./llm-adapter.js";
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
const { PromptDeliveryGuard } = nativeRequire("../../../vendor/supermickey/hyperreality-system/engines/production-engine/agents/prompt-delivery-guard.js") as { PromptDeliveryGuard: NativeConstructor };
const { SemanticRefinementPass } = nativeRequire("../../../vendor/supermickey/hyperreality-system/engines/production-engine/agents/semantic-refinement-pass.js") as { SemanticRefinementPass: NativeConstructor };
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
  const pieces = prompt.split(`\n\n## 本次宿主 PRD ${kind} 响应 JSON Schema（`);
  expect(pieces).toHaveLength(2);
  const encoded = pieces[1]!.match(/\n```json\n([^\n]+)\n```\n/);
  expect(encoded).not.toBeNull();
  return JSON.parse(encoded![1]!) as RequirementRecord;
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
  expect(prompt).toContain(JSON.stringify(value.contract));
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
    modelId: "deepseek-v4-pro", healthy: async () => true,
    chat: async (messages, options = {}) => {
      requests.push({ messages, options });
      return { text: reply, promptTokens: 1, completionTokens: 1 };
    }
  };
  const adapter = new WorkloomLLMEngine({ baseUrl: "http://unused.local/v1", apiKey: "test-only", model: "stub-main",
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
      expect(request.options).toMatchObject({ maxTokens: 4096, temperature: 0.37, topP: 0.82, thinking: { type: "disabled" }, responseFormat: { type: "json_object" } });
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
const provider = { modelId: "deepseek-v4-pro", healthy: async () => true,
 chat: async (messages, options = {}) => { requests.push({ messages, options }); return { text: raw, promptTokens: 1, completionTokens: 1 }; } };
const adapter = new WorkloomLLMEngine({ baseUrl: "http://unused.local/v1", apiKey: "test-only", model: "stub-main",
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
    expect(result.inputs[3]).toMatchObject({ system: { role: "system", content: "原生system" }, options: { temperature: 0.41 } });
    expect(result.inputs[4].options.maxTokens).toBe(1234);
    expect(result.results).toMatchObject({ results: [{ success: true, content: result.raw }, { success: true, content: result.raw }, { success: true, content: result.raw }],
      chat: result.raw, structured: { success: true, content: result.raw, data: { unchanged: true } } });
    expect(result.cleanup).toMatchObject({ hookDisabled: true, clearedTimers: expect.any(Number) });
    expect(result.cleanup.clearedTimers).toBeGreaterThanOrEqual(2);
  });

  it("the direct HTTP path carries the same private context and returns the exact raw response", async () => {
    const value = fixture("PRODUCTION-DIRECT"), h = harness(), run = h.make(value), bodies: RequirementRecord[] = [];
    const raw = '{"unchanged":"原始返回"}'; expectedFetchCalls = 1;
    vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as RequirementRecord);
      return new Response(JSON.stringify({ choices: [{ message: { content: raw } }] }), { status: 200 });
    });
    const adapter = new WorkloomLLMEngine({ baseUrl: "http://unused.local/v1", apiKey: "test-only", model: "original-model" });
    await withPrdAuthorityScope(value.authority, async () => {
      const prd = await h.generate(run); await h.review(run, prd);
      expect(await adapter.reasonStructured("直连原始需求", { unchanged: "" }, { maxTokens: 4321 })).toMatchObject({ content: raw, data: JSON.parse(raw) });
      return h.success(prd);
    });
    expect(bodies).toHaveLength(1); expect(bodies[0]).toMatchObject({ model: "original-model", max_tokens: 4321 });
    const prompt = (bodies[0]!.messages as ChatMessage[]).at(-1)!.content;
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

function productionHarness() {
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
  const productionPrototype: RequirementRecord = {}, phase1Prototype: RequirementRecord = {}, fusionPrototype: RequirementRecord = {};
  define(productionPrototype, "produce", function (blueprint, ...args) {
    return typeof this.nextProduce === "function" ? Reflect.apply(this.nextProduce as (...args: unknown[]) => unknown, this, [blueprint, ...args])
      : this.nativeResult ?? { nativeProduction: true };
  });
  define(phase1Prototype, "_shouldGenerateOpening", function () { return true; });
  for (const [owner, key] of [
    [productionPrototype, "_loadLatestCheckpoint"], [productionPrototype, "_saveCheckpoint"], [productionPrototype, "_clearCheckpoints"],
    [fusionPrototype, "_loadSubCheckpoint"], [fusionPrototype, "_saveSubCheckpoint"], [fusionPrototype, "_clearSubCheckpoint"],
  ] as Array<[RequirementRecord, string]>) define(owner, key, function (...args) { return { nativeCache: key, args }; });
  const deps = { systemPrototype: h.prototype, productionPrototype, phase1Prototype, fusionPrototype,
    refinerPrototype: FieldContentRefiner.prototype, costumePrototype: CharacterCostumePrompter.prototype,
    fieldGuardPrototype: FieldGuard.prototype, qualityGatePrototype: QualityGate.prototype,
    deliveryGuardPrototype: PromptDeliveryGuard.prototype, semanticPrototype: SemanticRefinementPass.prototype,
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
    const nativePrefix = `${String(invoke(agent, "_getSystemPrompt"))}\n\n${originalPrompt}`;
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

describe("G4 executable plans and one native quality policy", () => {
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

function truthFixture(name: string) {
  const value = fixture(name), original = JSON.parse(value.content) as RequirementRecord, facts = requirementRecord(original.facts, "facts");
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

describe("approved production authority at native technical and title seams", () => {
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
 const FieldContentRefiner = load("engines/production-engine/agents/field-content-refiner.js", "FieldContentRefiner");
 const CharacterCostumePrompter = load("engines/character-system/character-costume-prompter.js", "CharacterCostumePrompter");
 const FieldGuard = load("engines/field-guard.js", "FieldGuard");
 const QualityGate = load("engines/production-engine/utils/quality-gate.js", "QualityGate");
 const PromptDeliveryGuard = load("engines/production-engine/agents/prompt-delivery-guard.js", "PromptDeliveryGuard");
 const SemanticRefinementPass = load("engines/production-engine/agents/semantic-refinement-pass.js", "SemanticRefinementPass");
 const prototypes = [HyperrealitySystem, ProductionEngine, Phase1SceneDesign, PromptFusionAgent, FieldContentRefiner, CharacterCostumePrompter, FieldGuard, QualityGate, PromptDeliveryGuard, SemanticRefinementPass].map(value => value.prototype);
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
    expect(result).toMatchObject({ success: true, consumerChecks: 13, nativeTruthVerified: true, restoredPrototypes: 10 });
    expect(result.clearedTimers).toBeGreaterThanOrEqual(2);
  });
});
