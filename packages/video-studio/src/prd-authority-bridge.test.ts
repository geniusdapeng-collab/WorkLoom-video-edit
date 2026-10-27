import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requirementHash, requirementRecord, type RequirementRecord } from "./requirement-contract.js";
import { preparePrdAuthority } from "./prd-authority.js";
import { assertPrdAuthorityBridge, installPrdAuthorityBridge, withPrdAuthorityScope } from "./prd-authority-bridge.js";
import { PRDGenerator, PRDSchema, prdFixture } from "./prd-authority.test-support.js";

const fixtures: ReturnType<typeof prdFixture>[] = [];
const disposers: Array<() => void> = [];
function fixture(name = "P1") { const value = prdFixture(name); fixtures.push(value); return value; }
function invoke(owner: RequirementRecord, key: string, ...args: unknown[]): unknown {
  return Reflect.apply(owner[key] as (...args: unknown[]) => unknown, owner, args);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected external network in PRD fixture"); }));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  for (const value of fixtures.splice(0)) value.cleanup();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function harness() {
  class System {
    prdGenerator: RequirementRecord;
    g3Approved = true;
    g4Approved = true;
    suggestions: string[] = [];
    minimalCalls = 0;
    constructor(generator: RequirementRecord) { this.prdGenerator = generator; }
    async _confirmRequirementList(_markdown: unknown, list: unknown) { return { approved: this.g3Approved, requirementList: list }; }
    _generateMinimalPRD() { this.minimalCalls++; return { productPositioning: { aspectRatio: "16:9" } }; }
    async _confirmPRD(_markdown: unknown, prd: unknown) { return { approved: this.g4Approved, prd, suggestions: this.suggestions }; }
  }
  const prototype = System.prototype as unknown as RequirementRecord;
  const before = Object.fromEntries(["_confirmRequirementList", "_generateMinimalPRD", "_confirmPRD"].map(key => [key, Object.getOwnPropertyDescriptor(prototype, key)]));
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
      expect(call.prompt).toContain(value.content);
      expect(call.prompt).toContain(JSON.stringify(value.metadata.brief));
      expect(call.prompt).toContain(JSON.stringify(value.contract));
      expect(call.options).toMatchObject({ maxRetries: 1, thinking: { type: "disabled" } });
    }
    expect(requirementRecord(run.generator.agent2, "agent2")).not.toHaveProperty("_lastDiscoveryResult");
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
  it("native BaseAgent parse retry keeps the complete authority at every actual engine call", async () => {
    const value = fixture(), h = harness(), run = h.make(value);
    const engine = run.engines[0]!, original = engine.reasonStructured as (...args: unknown[]) => unknown;
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
      expect(String(args[0])).toContain(value.content);
      expect(String(args[0])).toContain(JSON.stringify(value.contract));
      expect(args[2]).toMatchObject({ maxRetries: 1, thinking: { type: "disabled" } });
    }
  });
});

describe("PRD failures remain fatal through native catches", () => {
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
    const values = [fixture("A"), fixture("B")], h = harness(), runs = values.map(value => h.make(value));
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
      expect(call.prompt).toContain(run.value.marketing.g1Artifact.sha256);
      expect(call.prompt).not.toContain(values[index === 0 ? 1 : 0]!.marketing.g1Artifact.sha256);
    }
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
