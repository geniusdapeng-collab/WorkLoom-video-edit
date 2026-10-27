import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertRequirementContractBridge, installRequirementContractBridge, installVendorRequirementContractBridge,
  withRequirementContractScope
} from "./requirement-contract-bridge.js";
import { requirementAuthorityPrompt, type RequirementAuthorityOptions } from "./requirement-authority.js";
import {
  requirementHash, requirementRecord, structuredScenePrompt, structuredSceneSchema, validateRequirementSchema,
  type RequirementRecord
} from "./requirement-contract.js";
import type { PrdAuthority } from "./prd-authority.js";

const loader = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock("./vendor-requirement-entry.js", () => ({ acquireVendorRequirementEntry: loader.acquire }));
const directories: string[] = [];
const disposers: Array<() => void> = [];
beforeEach(() => { loader.acquire.mockReset(); });
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wl-contract-production-seam-")); directories.push(root);
  const entry = join(root, "index.js");
  mkdirSync(join(root, "engines"));
  writeFileSync(join(root, "engines/requirement-discovery-engine.js"), `
class RequirementDiscoveryEngine {
  discover() { return { original: true }; }
  _fastMode() { return { originalFallback: true }; }
  generateMarkdown() { return "### 2.1 目标受众画像\\n**主要受众**"; }
}
module.exports = { RequirementDiscoveryEngine };
`);
  mkdirSync(join(root, "skills/creative-theme-generator"), { recursive: true });
  writeFileSync(join(root, "skills/creative-theme-generator/index.js"), `
class CreativeThemeGenerator { generate() { return { originalTheme: true }; } }
module.exports = { CreativeThemeGenerator };
`);
  class Vendor {
    async _convertDiscoveryToRequirementList() { return { original: true }; }
    _renderRequirementContract() { return "original contract"; }
    _buildThemeInput() { return "original input"; }
  }
  const release = vi.fn();
  loader.acquire.mockReturnValue({ exports: { HyperrealitySystem: Vendor }, identity: { entryPath: entry }, release });
  return { entry, Vendor, release };
}

describe("production contract bridge uses the controlled cache authority", () => {
  it("acquires the pinned entry, verifies its constructor and releases only its extra loader holder", () => {
    const f = fixture(), original = f.Vendor.prototype._renderRequirementContract;
    const dispose = installVendorRequirementContractBridge(f.Vendor, f.entry); disposers.push(dispose);
    expect(loader.acquire).toHaveBeenCalledExactlyOnceWith(f.entry);
    expect(f.release).toHaveBeenCalledTimes(1);
    assertRequirementContractBridge(f.Vendor.prototype);
    expect(f.Vendor.prototype._renderRequirementContract).not.toBe(original);
    dispose(); dispose();
    expect(f.Vendor.prototype._renderRequirementContract).toBe(original);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("rejects a different constructor and does not patch it or reload a raw entry", () => {
    const f = fixture();
    class Other extends f.Vendor {}
    const native = Other.prototype._renderRequirementContract;
    expect(() => installVendorRequirementContractBridge(Other, f.entry)).toThrow("REQUIREMENT_BRIDGE_CHANGED");
    expect(Other.prototype._renderRequirementContract).toBe(native);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it.each(["CACHE_CONFLICT", "SOURCE_MISMATCH", "LOAD_FAILED"])("propagates controlled %s without fallback require", code => {
    const f = fixture(), failure = new Error(`VENDOR_REQUIREMENT_ENTRY_${code}`);
    loader.acquire.mockImplementation(() => { throw failure; });
    expect(() => installVendorRequirementContractBridge(f.Vendor, f.entry)).toThrow(failure);
    expect(f.release).not.toHaveBeenCalled();
  });

  it("releases its extra holder on a real dependency load error without changing vendor methods", () => {
    const f = fixture(), native = f.Vendor.prototype._renderRequirementContract;
    rmSync(join(f.entry, "..", "engines/requirement-discovery-engine.js"));
    expect(() => installVendorRequirementContractBridge(f.Vendor, f.entry)).toThrow(/Cannot find module/);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.Vendor.prototype._renderRequirementContract).toBe(native);
  });

  it("does not partially patch methods when the pinned theme dependency is missing", () => {
    const f = fixture(), native = Object.getOwnPropertyDescriptor(f.Vendor.prototype, "_buildThemeInput");
    rmSync(join(f.entry, "..", "skills/creative-theme-generator/index.js"));
    expect(() => installVendorRequirementContractBridge(f.Vendor, f.entry)).toThrow(/Cannot find module/);
    expect(Object.getOwnPropertyDescriptor(f.Vendor.prototype, "_buildThemeInput")).toEqual(native);
    expect(f.release).toHaveBeenCalledTimes(1);
  });
});

type NativeMethod = (this: RequirementRecord, ...args: unknown[]) => unknown;
const require = createRequire(import.meta.url);
const nativeDiscoveryFile = resolve(dirname(fileURLToPath(import.meta.url)),
  "../../../vendor/supermickey/hyperreality-system/engines/requirement-discovery-engine.js");
// The pinned module only declares schemas/classes. Its real agents below use inert local engines.
const { RequirementDiscoveryEngine } = require(nativeDiscoveryFile) as {
  RequirementDiscoveryEngine: { new(options?: RequirementRecord): RequirementRecord; prototype: RequirementRecord };
};
const nativeDiscover = RequirementDiscoveryEngine.prototype.discover as NativeMethod;

function physicalScene(durations: number[]): RequirementRecord {
  const node = (duration: number, index: number) => ({
    duration, purpose: `模型自行创作的完整场景目的${index}，观察合成商品并保留连续可拍动作。`, keyElements: ["合成商品", "封闭场地"],
    productionContract: { props: [{ name: "合成商品", description: "本场实际可见的合成展示商品" }],
      actions: [{ actorId: "$product", description: "合成商品沿着封闭展示台缓慢旋转" }] }
  });
  return { opening: node(durations[0]!, 0),
    scenes: durations.slice(1, -1).map((duration, index) => ({ ...node(duration, index + 1), index: index + 1, emotionalBeat: "rising" })),
    ending: node(durations.at(-1)!, durations.length - 1),
    totalDuration: durations.reduce((sum, duration) => sum + duration, 0), sceneCount: durations.length, narrativeArc: "linear" };
}
function nativeModules(scene: RequirementRecord) {
  return {
    audience: { primaryAudience: { ageRange: "18-24", gender: "all", interestTags: ["设计", "运动"], consumptionLevel: "medium" },
      emotionTriggers: ["观察具体细节", "保留真实疑问"], contentExpectations: ["完整可见动作", "明确场地用途"], secondaryAudience: [], painPoints: [] },
    scene,
    risk: { technicalRisks: [{ risk: "合成商品细节", level: "high", impact: "细节失真影响观察" }],
      businessConstraints: ["不虚构商品参数"], mitigationSuggestions: ["按完整来源核对外观"] },
    reference: { filmReferences: [{ title: "《合成参考一》", relevance: "high", keyTakeaway: "仅作构图艺术参考" },
      { title: "《合成参考二》", relevance: "medium", keyTakeaway: "仅作节奏艺术参考" }],
    adReferences: [{ brand: "合成视觉案例", relevance: "low", keyTakeaway: "仅作光线参考，不主张合作" }], styleReferences: ["自然光", "稳定镜头"] }
  };
}
async function nativePromptParts(input: RequirementRecord) {
  const engine = new RequirementDiscoveryEngine(), agents = requirementRecord(engine.agents, "native agents");
  const scene = requirementRecord(agents.scene, "native scene"), build = scene._buildPrompt as NativeMethod;
  const prompt = Reflect.apply(build, scene, [input]) as string;
  const modules = nativeModules(physicalScene([10, 10, 10]));
  let schema: RequirementRecord | undefined;
  for (const [name, value] of Object.entries(agents)) {
    requirementRecord(value, name).run = async (_input: unknown, nativeSchema: unknown) => {
      if (name === "scene") schema = structuredClone(requirementRecord(nativeSchema, "native schema"));
      return structuredClone(modules[name as keyof typeof modules]);
    };
  }
  // Capture the real closed-over SceneStructureSchema through its actual discover call.
  await Reflect.apply(nativeDiscover, engine, [input]);
  if (!schema) throw new Error("Actual native discovery did not pass its scene schema");
  const example = prompt.match(/输出 JSON 格式（[^\n]+\n([^\n]+)/)?.[1];
  const countLine = prompt.match(/\n(请设计 \d+ 个场景（含开场和结尾），[^\n]+)/)?.[1];
  if (!example || !countLine) throw new Error("Pinned native scene instruction boundaries changed");
  return { prompt, schema, example, countLine };
}
function privateRun(marker: string, duration: number, scene: RequirementRecord) {
  const metadata: RequirementRecord = { brief: { product: "合成商品", audience: `本次受众-${marker}`, duration, description: `完整客户要求-${marker}` },
    characters: [], hasPerson: false, noCharacters: true,
    builtinCharacterSelection: { schemaVersion: "workloom.video-character-selection/v1", mode: "none", characters: [] } };
  const scope = { tenantId: "test-tenant", workspaceId: "test-workspace", projectId: marker, runId: `run-${marker}`, attempt: 1 };
  const content = JSON.stringify({ facts: { schemaVersion: "workloom.marketing-facts/v1", issuer: "workloom.marketing-authority", scope,
    restrictions: ["不虚构商品事实"], stages: [{ stage: "A1", facts: { claims: [{ text: `完整私有G1-${marker}` }] } }] } });
  const sha256 = createHash("sha256").update(content).digest("hex"), artifactPath = `/synthetic/${marker}/G1_DOSSIER.md`;
  const authority: PrdAuthority = { metadata: structuredClone(metadata), profile: { targetDuration: duration },
    marketing: { schemaVersion: "workloom.prd-marketing-authority/v1", scope,
      g1Artifact: { path: artifactPath, sha256, content },
      g1Proof: { gate: "G1_DOSSIER", approved: true, status: "passed", via: "llm", degraded: false, model: "synthetic-review",
        evidence: [{ path: artifactPath, sha256, scope: "complete-text" }] } } };
  const story = `完整原故事-${marker}\n客户故事最后一行-${marker}`;
  const input = { type: "商业广告", theme: `自主主题-${marker}`, duration_sec: duration, tone: "轻快明朗",
    description: `完整本片描述-${marker}`, visual_style: "自然光艺术参考", _originalStoryText: story };
  const options: RequirementAuthorityOptions = { authority, approvedTheme: () => undefined, validateAuthority: vi.fn(() => undefined) };
  return { metadata, authority, input, story, options, modules: nativeModules(scene) };
}
function installNativeDiscovery() {
  class Vendor {
    async _convertDiscoveryToRequirementList() { return { keyPoints: [] }; }
    _renderRequirementContract() { return "native contract"; }
  }
  disposers.push(installRequirementContractBridge(Vendor.prototype as unknown as RequirementRecord, RequirementDiscoveryEngine.prototype));
}
function modelFor(run: ReturnType<typeof privateRun>, scenes: Array<RequirementRecord | Error>) {
  const calls: Array<{ method: string; prompt: string; schema?: unknown; options: unknown }> = [];
  const engine: RequirementRecord = { _extractJsonObject: (value: unknown) => typeof value === "string" ? value : null };
  let sceneAttempt = 0;
  engine.reasonStructured = vi.fn(async function (this: RequirementRecord, prompt: string, schema: unknown, options: unknown) {
    expect(this).toBe(engine); calls.push({ method: "reasonStructured", prompt, schema, options });
    const intro = prompt.slice(0, 180);
    const value = intro.includes("受众分析") ? run.modules.audience : intro.includes("技术制片人") ? run.modules.risk : run.modules.reference;
    return { success: true, data: structuredClone(value) };
  });
  engine.reason = vi.fn(async function (this: RequirementRecord, prompt: string, options: unknown) {
    expect(this).toBe(engine); calls.push({ method: "reason", prompt, options });
    const value = scenes[Math.min(sceneAttempt++, scenes.length - 1)]!;
    if (value instanceof Error) throw value;
    return { success: true, content: JSON.stringify(value) };
  });
  return { engine, calls };
}
function runDiscovery(run: ReturnType<typeof privateRun>, engine: RequirementRecord) {
  const discovery = new RequirementDiscoveryEngine({ llmEngine: engine, timeoutMs: 1000, agentTimeoutMs: 100 });
  return withRequirementContractScope(run.metadata,
    () => Reflect.apply(discovery.discover as NativeMethod, discovery, [run.input]) as Promise<RequirementRecord>, run.options);
}
function failureText(error: unknown): string {
  return `${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(error && typeof error === "object" ? { ...error } : {})}`;
}

describe("actual native scene prompt and strict production response", () => {
  const network = vi.fn(async () => { throw new Error("Unexpected network/model request"); });
  beforeEach(() => { network.mockClear(); vi.stubGlobal("fetch", network); vi.useFakeTimers(); });
  afterEach(() => {
    expect(network).not.toHaveBeenCalled();
    vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
  });

  it.each([30, 45, 60])("corrects the actual %ss native contradiction without changing identical customer literals or schema", async duration => {
    expect(createHash("sha256").update(readFileSync(nativeDiscoveryFile)).digest("hex"))
      .toBe("d658bd5033ff671061b0e31414d4578838496a22b19d204674abc34c7c7a5fdb");
    const input: RequirementRecord = { type: "商业广告", theme: "自主创作", duration_sec: duration, description: "最初的客户描述" };
    const original = await nativePromptParts(input), sample = JSON.parse(original.example) as RequirementRecord;
    const nodes = [sample.opening, ...(sample.scenes as unknown[]), sample.ending].map(value => requirementRecord(value, "sample node"));
    expect(sample.sceneCount === nodes.length && sample.totalDuration === nodes.reduce((sum, node) => sum + Number(node.duration), 0)).toBe(false);
    const generatedSuffixAt = original.prompt.lastIndexOf(`\n\n${original.countLine}`);
    expect(generatedSuffixAt).toBeGreaterThanOrEqual(0);
    input.description = `客户逐字引用完整生成段，不能修改：\n${original.prompt.slice(generatedSuffixAt)}\n客户原文尾注𠮷`;
    const actual = await nativePromptParts(input), effective = structuredSceneSchema(actual.schema);
    const inputHash = requirementHash(input), nativeHash = requirementHash(actual.schema), effectiveHash = requirementHash(effective);
    const corrected = structuredScenePrompt(actual.prompt, input, effective);
    expect(corrected).toContain(`主题描述: ${String(input.description)}\n`);
    expect(corrected.split(original.countLine)).toHaveLength(2); // only the customer's literal remains
    expect(corrected.split(original.example)).toHaveLength(2);
    expect(requirementHash(input)).toBe(inputHash);
    expect(requirementHash(actual.schema)).toBe(nativeHash);
    expect(requirementHash(effective)).toBe(effectiveHash);
    expect(() => structuredScenePrompt(actual.prompt + "\nforeign suffix", input, effective)).toThrow("REQUIREMENT_VENDOR_UNAVAILABLE");
    expect(() => structuredScenePrompt(actual.prompt, { ...input, duration_sec: duration + 1 }, effective)).toThrow("REQUIREMENT_VENDOR_UNAVAILABLE");
    for (const key of ["opening", "ending"] as const) {
      const node = requirementRecord(requirementRecord(effective.properties, "properties")[key], key);
      expect(requirementRecord(node.properties, "node properties").duration).toEqual({ type: "number", minimum: 3, maximum: 15 });
      expect(node.required).toEqual(["duration", "purpose", "keyElements", "productionContract"]);
    }
  });

  it.each([{ durations: [15, 15] }, { durations: [6, 6, 6, 6, 6] }, { durations: [10, 12, 13, 10] }])("keeps the model's own node count/durations $durations and the real story/authority transport", async ({ durations }) => {
    installNativeDiscovery();
    const duration = durations.reduce((sum, value) => sum + value, 0), scene = physicalScene(durations);
    const run = privateRun(`count-${durations.length}`, duration, scene), model = modelFor(run, [scene]);
    const before = requirementHash(run.input), result = await runDiscovery(run, model.engine);
    expect(requirementHash(result.sceneStructure)).toBe(requirementHash(scene));
    expect(model.calls.filter(call => call.method === "reason")).toHaveLength(1);
    expect(model.calls).toHaveLength(4);
    const context = requirementAuthorityPrompt(run.authority);
    for (const call of model.calls) {
      expect(call.prompt.endsWith(context)).toBe(true);
      expect(call.prompt.split(context)).toHaveLength(2);
      expect(call.prompt.split(run.story)).toHaveLength(2);
      expect(call.prompt.indexOf(run.story)).toBeLessThan(call.prompt.indexOf(context));
    }
    const sceneCall = model.calls.find(call => call.method === "reason")!;
    expect(sceneCall.prompt).toContain(`## 📖 原始故事文本（需求分析的核心依据）\n${run.story}`);
    expect(sceneCall.options).toMatchObject({ maxTokens: 4000, temperature: 1, forceJson: false });
    expect(sceneCall).not.toHaveProperty("schema");
    expect(requirementHash(run.input)).toBe(before);
    expect(requirementRecord(result.upstreamFields, "source")._originalStoryText).toBe(run.story);
    expect(JSON.stringify(result)).not.toContain(run.authority.marketing.g1Artifact.content);
  });

  it.each(["count", "declared-total", "target-total", "physical-schema"])("still rejects %s with exactly the original two scene attempts", async kind => {
    installNativeDiscovery();
    const scene = physicalScene([10, 10, 10]), invalid = structuredClone(scene);
    if (kind === "count") invalid.sceneCount = 2;
    if (kind === "declared-total") invalid.totalDuration = 29;
    if (kind === "target-total") { requirementRecord(invalid.ending, "ending").duration = 9; invalid.totalDuration = 29; }
    if (kind === "physical-schema") delete requirementRecord(invalid.opening, "opening").productionContract;
    const run = privateRun(kind, 30, scene), model = modelFor(run, [invalid]);
    await expect(runDiscovery(run, model.engine)).rejects.toThrow("REQUIREMENT_SCENE_UNVERIFIED");
    expect(model.calls.filter(call => call.method === "reason")).toHaveLength(2);
    expect(model.calls.filter(call => call.method === "reasonStructured")).toHaveLength(1); // audience only; no later agent
  });

  it.each([{ delta: 0.049, accepted: true }, { delta: 0.051, accepted: false }])("retains the existing 0.05s tolerance at delta=$delta", async ({ delta, accepted }) => {
    installNativeDiscovery();
    const scene = physicalScene([10, 10, 10 + delta]), run = privateRun(`tolerance-${delta}`, 30, scene), model = modelFor(run, [scene]);
    if (accepted) {
      const result = await runDiscovery(run, model.engine);
      expect(requirementHash(result.sceneStructure)).toBe(requirementHash(scene));
    } else await expect(runDiscovery(run, model.engine)).rejects.toThrow("REQUIREMENT_SCENE_UNVERIFIED");
    expect(model.calls.filter(call => call.method === "reason")).toHaveLength(accepted ? 1 : 2);
  });

  it("reports the latest native arithmetic failure rather than the first attempt's metrics", async () => {
    installNativeDiscovery();
    const scene = physicalScene([10, 10, 10]), first = structuredClone(scene), second = structuredClone(scene);
    first.sceneCount = 913719;
    second.totalDuration = 27;
    const run = privateRun("latest-metrics", 30, scene), model = modelFor(run, [first, second]);
    const failure = await runDiscovery(run, model.engine).then(() => undefined, error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failureText(failure)).toContain("REQUIREMENT_SCENE_UNVERIFIED");
    expect(failureText(failure)).toContain("27");
    expect(failureText(failure)).not.toContain("913719");
    expect(model.calls.filter(call => call.method === "reason")).toHaveLength(2);
  });

  it.each(["schema", "transport"])("does not reuse prior numeric metrics after a later %s failure", async kind => {
    installNativeDiscovery();
    const scene = physicalScene([10, 10, 10]), first = structuredClone(scene), second = structuredClone(scene);
    first.sceneCount = 913719;
    delete requirementRecord(second.ending, "ending").productionContract;
    const run = privateRun(`latest-${kind}`, 30, scene);
    const model = modelFor(run, [first, kind === "schema" ? second : new Error("synthetic transport failure")]);
    const failure = await runDiscovery(run, model.engine).then(() => undefined, error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failureText(failure)).not.toContain("913719");
    expect(model.calls.filter(call => call.method === "reason")).toHaveLength(2);
  });

  it("retains the same strict effective schema used to validate the real response", async () => {
    const input: RequirementRecord = { type: "商业广告", theme: "严格场景", duration_sec: 30, description: "完整本片描述" };
    const parts = await nativePromptParts(input), effective = structuredSceneSchema(parts.schema), valid = physicalScene([10, 10, 10]);
    expect(() => validateRequirementSchema(valid, effective)).not.toThrow();
    const missing = structuredClone(valid); delete requirementRecord((missing.scenes as unknown[])[0], "middle").index;
    expect(() => validateRequirementSchema(missing, effective)).toThrow("REQUIREMENT_SCENE_UNVERIFIED");
    const invalid = structuredClone(valid); requirementRecord(invalid.opening, "opening").duration = 2;
    expect(() => validateRequirementSchema(invalid, effective)).toThrow("REQUIREMENT_SCENE_UNVERIFIED");
    const noContract = structuredClone(valid); delete requirementRecord(noContract.ending, "ending").productionContract;
    expect(() => validateRequirementSchema(noContract, effective)).toThrow("REQUIREMENT_SCENE_UNVERIFIED");
  });

  it("keeps overlapping native scene prompts, target durations and complete authorities isolated", async () => {
    installNativeDiscovery();
    const a = privateRun("overlap-A", 30, physicalScene([15, 15]));
    const b = privateRun("overlap-B", 45, physicalScene([10, 12, 13, 10]));
    const calls: string[] = [], engine: RequirementRecord = { _extractJsonObject: (value: string) => value };
    const selected = (prompt: string) => {
      if (prompt.includes(a.story)) return a;
      if (prompt.includes(b.story)) return b;
      throw new Error("Native request lost its complete original story");
    };
    engine.reasonStructured = vi.fn(async function (this: RequirementRecord, prompt: string) {
      expect(this).toBe(engine); calls.push(prompt); await Promise.resolve();
      const run = selected(prompt), intro = prompt.slice(0, 180);
      return { success: true, data: structuredClone(intro.includes("受众分析") ? run.modules.audience
        : intro.includes("技术制片人") ? run.modules.risk : run.modules.reference) };
    });
    engine.reason = vi.fn(async function (this: RequirementRecord, prompt: string) {
      expect(this).toBe(engine); calls.push(prompt); await Promise.resolve();
      return { success: true, content: JSON.stringify(selected(prompt).modules.scene) };
    });
    const [first, second] = await Promise.all([runDiscovery(a, engine), runDiscovery(b, engine)]);
    expect(requirementHash(first.sceneStructure)).toBe(requirementHash(a.modules.scene));
    expect(requirementHash(second.sceneStructure)).toBe(requirementHash(b.modules.scene));
    expect(calls).toHaveLength(8);
    for (const prompt of calls) {
      const run = selected(prompt), other = run === a ? b : a, context = requirementAuthorityPrompt(run.authority);
      expect(prompt.endsWith(context)).toBe(true);
      expect(prompt.split(context)).toHaveLength(2);
      expect(prompt).not.toContain(other.authority.marketing.g1Artifact.content);
    }
  });
});
