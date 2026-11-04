import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindRequirementContract, requirementCast, requirementRecord, type RequirementContract, type RequirementRecord } from "./requirement-contract.js";
import { preparePrdAuthority } from "./prd-authority.js";
import { installPrdAuthorityBridge, installPrdProductionBridge, withPrdAuthorityScope } from "./prd-authority-bridge.js";
import { PRDGenerator, PRDSchema, prdFixture } from "./prd-authority.test-support.js";
import { compilePromptShot } from "./prompt-compiler.js";
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
function fixture(...args: Parameters<typeof prdFixture>) { const value = prdFixture(...args); fixtures.push(value); return value; }
function invoke(owner: RequirementRecord, key: string, ...args: unknown[]): unknown {
  return Reflect.apply(owner[key] as (...args: unknown[]) => unknown, owner, args);
}
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


beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network in complete-field regression"); }));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  for (const value of fixtures.splice(0)) value.cleanup();
  expect(globalThis.fetch).toHaveBeenCalledTimes(0);
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

type ScopeMode = "frozen-silent" | "unfrozen" | "voice" | "wrong-shot" | "wrong-duration";
function frozenRun(mode: ScopeMode = "frozen-silent") {
  const value = fixture(`COMPLETE-FIELD-${mode}`, [10, 10, 10]);
  if (mode !== "unfrozen") requirementRecord(value.metadata.brief, "brief").segmentContract = {
    count: 3, totalSeconds: 30, secondsPerSegment: 10, hardCuts: true,
    intervals: Array.from({ length: 3 }, (_, index) => ({ startSec: index * 10, endSec: (index + 1) * 10, brief: `冻结段 ${index + 1}` })),
  };
  if (mode === "voice") refreshContract(value);
  else declareDelivery(value, { speechPolicy: "none" });
  const harness = productionHarness(true), run = harness.make(value);
  const shot = { shotId: mode === "wrong-shot" ? "other-shot" : "scene-1", duration: mode === "wrong-duration" ? 9 : 10 };
  return { harness, run, shot };
}
const nativeModule = nativeRequire("../../../vendor/supermickey/hyperreality-system/engines/field-quality/field-check-agent.js") as {
  SPEC_MAP: Record<string, { charMax: number }>;
};
const authoredFields = Object.keys(nativeModule.SPEC_MAP);
const finiteFields = authoredFields.filter(field => nativeModule.SPEC_MAP[field]!.charMax < 9999);
function completeValue(field: string) {
  return `${field}的完整作者正文，` + "主体与动作保持可核验的完整描述。".repeat(30) + `最后一项${field}完整要求。`;
}

describe("complete authored frozen fields at the installed native production seam", () => {
  it.each(finiteFields)("preserves complete native LLM replacement for %s", async field => {
    const { harness, run, shot } = frozenRun();
    const authored = completeValue(field);
    const response = vi.fn(async () => ({ success: true, content: JSON.stringify({ repaired_fields: { [field]: authored } }) }));
    const repairer = Reflect.construct(LLMRepairer, [{ reason: response }, 500]) as RequirementRecord;
    await harness.accepted(run, async () => {
      const result = requirementRecord(await invoke(repairer, "_repairBatch", { ...shot, [field]: "修复前完整作者正文。" },
        [{ fieldEn: field, issueType: "conflict", severity: "major", description: "来源中的当前要求需要修复", suggestion: "完整返回本字段" }],
        [field], new PRD({}), 500, 1, 1), "native repaired fields");
      const repaired = requirementRecord(result.repaired, "repaired shot");
      expect.soft(repaired[field]).toBe(authored);
      expect(response).toHaveBeenCalledTimes(1);
      expect(String((response.mock.calls as unknown as [[string]])[0][0])).toContain(`${field}：≤ ${nativeModule.SPEC_MAP[field]!.charMax} 字符`);
    });
  });

  it("keeps complete dialogue and portrait values alongside the other 23 native fields", async () => {
    expect(authoredFields).toHaveLength(25);
    const { harness, run, shot } = frozenRun();
    const values = { dialogue: "无台词。", portraits: ["image://characters/offline/front.png", "image://characters/offline/side.png"] };
    const repairer = Reflect.construct(LLMRepairer, [{ reason: async () => ({ success: true, content: JSON.stringify({ repaired_fields: values }) }) }, 500]) as RequirementRecord;
    await harness.accepted(run, async () => {
      const result = requirementRecord(await invoke(repairer, "_repairBatch", shot, [], Object.keys(values), new PRD({}), 500, 1, 1), "native arrays");
      const repaired = requirementRecord(result.repaired, "repaired");
      expect(repaired.dialogue).toBe(values.dialogue);
      expect(repaired.portraits).toEqual(values.portraits);
    });
  });

  it("preserves equal repaired values across different budgets and keeps Unicode code points intact", async () => {
    const { harness, run, shot } = frozenRun();
    const authored = "原始皮肤与服装细节🙂".repeat(25) + "最后一项完整可见要求。";
    const values = { costume: authored, makeup: authored };
    const repairer = Reflect.construct(LLMRepairer, [{ reason: async () => ({ success: true,
      content: "```json\n" + JSON.stringify({ repaired_fields: values }) + "\n```" }) }, 500]) as RequirementRecord;
    await harness.accepted(run, async () => {
      const result = requirementRecord(await invoke(repairer, "_repairBatch", { ...shot, costume: "旧服装", makeup: "旧化妆" },
        [], Object.keys(values), new PRD({}), 500, 1, 1), "equal native values");
      const repaired = requirementRecord(result.repaired, "repaired equal text");
      expect(repaired.costume).toBe(authored);
      expect(repaired.makeup).toBe(authored);
    });
  });

  it("retains the native failed model result and leaves the original shot untouched", async () => {
    const { harness, run, shot } = frozenRun();
    const input = { ...shot, costume: completeValue("costume") }, before = structuredClone(input);
    const response = vi.fn(async () => ({ success: false, error: "synthetic model failure" }));
    const repairer = Reflect.construct(LLMRepairer, [{ reason: response }, 500]) as RequirementRecord;
    await harness.accepted(run, async () => {
      expect(await invoke(repairer, "_repairBatch", input, [], ["costume"], new PRD({}), 500, 1, 1))
        .toEqual({ repaired: null, actions: [] });
      expect(input).toEqual(before);
      expect(response).toHaveBeenCalledTimes(1);
    });
  });

  it.each(finiteFields)("retains semantic checks while ignoring preliminary per-field overflow for %s", async field => {
    const { harness, run, shot } = frozenRun();
    const checker = new RuleChecker(), authored = completeValue(field);
    await harness.accepted(run, async () => {
      const checks = invoke(checker, "check", { ...shot, [field]: authored }) as RequirementRecord[];
      expect(checks.filter(issue => issue.fieldEn === field && issue.issueType === "over_length")).toEqual([]);
      expect(checks.some(issue => issue.issueType !== "over_length")).toBe(true);
    });
  });

  it.each(["costume", "makeup", "consistency", "character"])("does not cut %s during native rule completion or PRD anchoring", async field => {
    const { harness, run, shot } = frozenRun(), rule = new RuleRepairer();
    const authored = completeValue(field);
    await harness.accepted(run, async () => {
      const result = requirementRecord(invoke(rule, "repair", { ...shot, [field]: authored, fields: { [field]: authored } },
        { issues: [{ fieldEn: field, issueType: "over_length", description: "字段超长" }] }, new PRD({ characters: [{ name: "合成人物" }] })), "rule preservation");
      const repaired = requirementRecord(result.repaired, "rule shot");
      expect(String(repaired[field])).toContain(authored);
      expect(requirementRecord(repaired.fields, "rule nested")[field]).toBe(repaired[field]);
    });
  });

  it("keeps the entire suffix and unmatched punctuation through native display and field refinement", async () => {
    const { harness, run, shot } = frozenRun();
    const body = "整套护具与全覆赛车服保持原样，不露胸、不露腰、拉链闭合至颈部；" + "抬盔后完整托住原头盔并放于指定位置";
    const bracket = "完整动作与主体约束保持原样，最后的作者注记也必须保留；服装护具与道具落点都依照本镜实际动作表达；[作者完整注记仍在当前字段末尾";
    const fields = { costume: body, makeup: bracket };
    await harness.accepted(run, async () => {
      const refiner = new FieldContentRefiner();
      const refined = requirementRecord(invoke(refiner, "refineFields", fields, { ...shot, fields }), "refined fields");
      expect(String(refined.costume)).toContain(body);
      expect(String(refined.makeup)).toContain(bracket);
      const display = String(invoke(refiner, "refinePrompt", `【服装】${body} | 【化妆】${bracket}`, { ...shot, fields }));
      expect(display).toContain(body);
      expect(display).toContain(bracket);
    });
  });

  it("carries full native assembly into the real aggregate G6 hard limit", async () => {
    const { harness, run, shot } = frozenRun();
    const fields = Object.fromEntries(authoredFields.map(field => [field, completeValue(field)]));
    fields.dialogue = "无台词。"; fields.portraits = "NONE";
    const native = new PromptFusionAgent({ maxPromptLength: 500 });
    await harness.accepted(run, async () => {
      const assembledShot = { ...shot, ...fields, fields: structuredClone(fields), sceneType: "scene" };
      const prompt = String(invoke(native, "_assembleStandardPrompt", assembledShot, assembledShot.fields, "9:16"));
      expect.soft(prompt).toContain("最后一项costume完整要求");
      expect.soft(prompt).toContain("最后一项consistency完整要求");
      expect.soft(prompt.length).toBeGreaterThan(500);
      const compiled = compilePromptShot(assembledShot, {
        model: { modelId: "offline", provider: "offline", providerModel: "offline", version: "offline", modes: ["text"],
          durationSec: { min: 1, max: 10 }, aspectRatios: ["9:16"], resolutions: ["1080p"], maxReferenceImages: 0, maxPromptChars: 500 },
        delivery: { aspectRatio: "9:16", resolution: "1080p", fps: 30, format: "mp4", generateAudio: true },
      });
      expect.soft(compiled.fieldValues.costume).toContain("最后一项costume完整要求");
      expect(compiled.prompt.length).toBeGreaterThan(500);
      expect(compiled.hardErrors.some(error => error.code === "HARD_PROMPT_TOO_LONG")).toBe(true);
    });
  });

  it.each(["unfrozen", "voice", "wrong-shot", "wrong-duration"] as const)("retains native legacy caps and closure outside matching scope (%s)", async mode => {
    const { harness, run, shot } = frozenRun(mode);
    const authored = completeValue("costume"), rule = new RuleRepairer();
    await harness.accepted(run, async () => {
      const result = requirementRecord(invoke(rule, "repair", { ...shot, costume: authored, fields: { costume: authored } },
        { issues: [{ fieldEn: "costume", issueType: "over_length", description: "字段超长" }] }, null), "legacy rule");
      expect(String(requirementRecord(result.repaired, "legacy").costume).length).toBeLessThan(authored.length);
      const refiner = new FieldContentRefiner();
      const body = "完整服装与护具均保留，外层拉链在颈部闭合，全部覆盖；后续尚未闭合";
      const refined = requirementRecord(invoke(refiner, "refineFields", { costume: body }, { ...shot, fields: { costume: body } }), "legacy refinement");
      expect(String(refined.costume)).not.toContain("后续尚未闭合");
      const native = new PromptFusionAgent({ maxPromptLength: 500 });
      const fields = Object.fromEntries(authoredFields.map(field => [field, completeValue(field)]));
      fields.dialogue = "无台词。";
      const display = String(invoke(native, "_assembleStandardPrompt", { ...shot, fields }, fields, "9:16"));
      expect(display).not.toContain("最后一项costume完整要求");
      expect(Object.hasOwn(native, "_truncateStandardPrompt")).toBe(false);
      expect(Object.hasOwn(refiner, "_ensureClosure")).toBe(false);
    });
  });

  it("does not retain single-call closure or display overrides on shared native instances", async () => {
    const { harness, run, shot } = frozenRun();
    const refiner = new FieldContentRefiner(), native = new PromptFusionAgent({ maxPromptLength: 500 });
    const body = "完整服装与护具均保留，外层拉链在颈部闭合，全部覆盖；尾文完整保留";
    await harness.accepted(run, async () => {
      expect(String(requirementRecord(invoke(refiner, "refineFields", { costume: body }, shot), "known").costume)).toBe(body);
      const unknown = { ...shot, shotId: "unbound-shot" };
      expect(String(requirementRecord(invoke(refiner, "refineFields", { costume: body }, unknown), "unknown").costume))
        .not.toContain("尾文完整保留");
      const fields = Object.fromEntries(authoredFields.map(field => [field, completeValue(field)]));
      fields.dialogue = "无台词。";
      expect(String(invoke(native, "_assembleStandardPrompt", { ...shot, fields }, fields, "9:16")))
        .toContain("最后一项costume完整要求");
      expect(String(invoke(native, "_assembleStandardPrompt", { ...unknown, fields }, fields, "9:16")))
        .not.toContain("最后一项costume完整要求");
      expect(Object.hasOwn(native, "_truncateStandardPrompt")).toBe(false);
      expect(Object.hasOwn(refiner, "_ensureClosure")).toBe(false);
    });
    expect(() => invoke(refiner, "refineFields", { costume: body }, shot)).toThrow("PRD_SCOPE_CONFLICT");
    expect(() => invoke(native, "_assembleStandardPrompt", { ...shot, fields: {} }, {}, "9:16")).toThrow("PRD_SCOPE_CONFLICT");
  });

  it("does not preserve a missing current G4 review or an absent private owner scope", async () => {
    const { harness, run, shot } = frozenRun();
    run.system.g4Approved = false;
    await withPrdAuthorityScope(run.value.authority, async () => {
      await harness.generate(run);
      const rule = new RuleRepairer(), authored = completeValue("makeup");
      const result = requirementRecord(invoke(rule, "repair", { ...shot, makeup: authored }, { issues: [{ fieldEn: "makeup", issueType: "over_length" }] }, null), "unapproved");
      expect(String(requirementRecord(result.repaired, "unapproved shot").makeup).length).toBeLessThan(authored.length);
    });
    const refiner = new FieldContentRefiner();
    const body = "完整前句包含实际摄影与服装约束，动作保持自然具体且可核验；最后半句";
    expect(String(invoke(refiner, "refinePrompt", `【服装】${body}`, {}))).not.toContain("最后半句");
  });
});
