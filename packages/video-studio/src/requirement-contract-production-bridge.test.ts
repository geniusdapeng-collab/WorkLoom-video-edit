import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadModelPolicy, OpenAiCompatibleProvider, resetCircuit } from "@workloom/base/model-router";
import { WorkloomLLMEngine } from "./llm-adapter.js";
import {
  assertRequirementContractBridge, installRequirementContractBridge, installVendorRequirementContractBridge,
  withRequirementContractScope
} from "./requirement-contract-bridge.js";
import { captureRequirementTheme, requirementAuthorityPrompt, type RequirementAuthorityOptions } from "./requirement-authority.js";
import {
  RequirementContractError, requirementHash, requirementRecord, structuredScenePrompt, structuredSceneSchema, validateRequirementSchema,
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
      g1Proof: { gate: "G1_DOSSIER", approved: true, status: "passed", via: "llm", degraded: false, model: "deepseek-flash",
        evidence: [{ path: artifactPath, sha256, scope: "complete-text" }] } } };
  const story = `完整原故事-${marker}\n客户故事最后一行-${marker}`;
  const input = { type: "商业广告", theme: `自主主题-${marker}`, duration_sec: duration, tone: "轻快明朗",
    description: `完整本片描述-${marker}`, visual_style: "自然光艺术参考", _originalStoryText: story };
  const approvedTheme = captureRequirementTheme(authority,
    `完整已批准G2-${marker}\n保留全部主题细则与限定用途-${marker}\n最后一行创作上下文-${marker}`,
    { approved: true, reason: `完整G2原始裁决-${marker}`, advisories: [`保留非阻断建议-${marker}`] });
  if (!approvedTheme) throw new Error("Synthetic approved G2 was not captured");
  const options: RequirementAuthorityOptions = { authority, approvedTheme: () => approvedTheme, validateAuthority: vi.fn(() => undefined) };
  return { metadata, authority, approvedTheme, input, story, options, modules: nativeModules(scene) };
}
function installNativeDiscovery() {
  class Vendor {
    async _convertDiscoveryToRequirementList() { return { keyPoints: [] }; }
    _renderRequirementContract() { return "native contract"; }
  }
  disposers.push(installRequirementContractBridge(Vendor.prototype as unknown as RequirementRecord, RequirementDiscoveryEngine.prototype));
  return new Vendor() as unknown as RequirementRecord;
}
function modelFor(run: ReturnType<typeof privateRun>, scenes: Array<RequirementRecord | Error | string>, risks?: Array<RequirementRecord | Error>) {
  const calls: Array<{ method: string; prompt: string; schema?: unknown; options: unknown }> = [];
  const engine: RequirementRecord = { _extractJsonObject: (value: unknown) => typeof value === "string" ? value : null };
  let sceneAttempt = 0, riskAttempt = 0;
  engine.reasonStructured = vi.fn(async function (this: RequirementRecord, prompt: string, schema: unknown, options: unknown) {
    expect(this).toBe(engine); calls.push({ method: "reasonStructured", prompt, schema, options });
    const intro = prompt.slice(0, 180);
    const isRisk = intro.includes("技术制片人");
    const riskIndex = risks ? Math.min(riskAttempt, risks.length - 1) : -1;
    const riskValue = risks ? risks[riskIndex] : run.modules.risk;
    if (isRisk) riskAttempt++;
    const value = intro.includes("受众分析") ? run.modules.audience : isRisk
      ? riskValue : run.modules.reference;
    if (value instanceof Error) throw value;
    return { success: true, data: structuredClone(value) };
  });
  engine.reason = vi.fn(async function (this: RequirementRecord, prompt: string, options: unknown) {
    expect(this).toBe(engine); calls.push({ method: "reason", prompt, options });
    const value = scenes[Math.min(sceneAttempt++, scenes.length - 1)]!;
    if (value instanceof Error) throw value;
    return { success: true, content: typeof value === "string" ? value : JSON.stringify(value) };
  });
  return { engine, calls };
}
function nativeDiscovery(engine: RequirementRecord) {
  return new RequirementDiscoveryEngine({ llmEngine: engine, timeoutMs: 1000, agentTimeoutMs: 100 });
}
function runDiscovery(run: ReturnType<typeof privateRun>, engine: RequirementRecord, discovery = nativeDiscovery(engine)) {
  return withRequirementContractScope(run.metadata,
    () => Reflect.apply(discovery.discover as NativeMethod, discovery, [run.input]) as Promise<RequirementRecord>, run.options);
}
function withFrozenSegmentBrief(run: ReturnType<typeof privateRun>) {
  const brief = requirementRecord(run.metadata.brief, "test Brief");
  brief.requirements = "参考只写无品牌的摄影、剪辑和声音手法。";
  brief.segmentContract = { count: 3, totalSeconds: 30, secondsPerSegment: 10, hardCuts: true,
    intervals: [{ startSec: 0, endSec: 10, brief: "从高速追击直接开始" },
      { startSec: 10, endSec: 20, brief: "保持位置连贯并在第二段末冲线" },
      { startSec: 20, endSec: 30, brief: "停车停稳后摘盔、登台举杯" }] };
  run.authority.metadata = structuredClone(run.metadata);
  run.modules.reference.filmReferences = [];
  run.modules.reference.adReferences = [];
  return run;
}
function failureText(error: unknown): string {
  return `${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(error && typeof error === "object" ? { ...error } : {})}`;
}
const feedbackHeading = "## 上一次原生场景校验反馈";
const sceneExampleHeading = "本次 JSON 结构示例（占位内容必须替换）：";
const timingHeading = "本次 schema 派生时长边界与可行数量（仅约束，不分配节点）：";
function promptJson(prompt: string, heading: string): RequirementRecord {
  const parts = prompt.split(`${heading}\n`);
  expect(parts).toHaveLength(2);
  return requirementRecord(JSON.parse(parts[1]!.split("\n")[0]!), heading);
}
function schemaFailure(path: string, keyword: "minimum" | "maximum", observed: number, limit: number) {
  return { kind: "schema", path: `SceneArchitect response${path}`, keyword, observed, limit };
}
function expectCompleteSources(prompt: string, run: ReturnType<typeof privateRun>): void {
  const context = requirementAuthorityPrompt(run.authority, run.approvedTheme);
  expect(prompt.endsWith(context)).toBe(true);
  expect(prompt.split(context)).toHaveLength(2);
  expect(prompt.split(run.story)).toHaveLength(2);
  expect(prompt.indexOf(run.story)).toBeLessThan(prompt.indexOf(context));
  expect(prompt).toContain(run.authority.marketing.g1Artifact.content);
  expect(prompt).toContain(JSON.stringify(run.authority.marketing.g1Proof));
  expect(prompt).toContain(run.approvedTheme.contentMd);
  expect(prompt).toContain(JSON.stringify(run.approvedTheme.verdict));
}

describe("actual native scene prompt and strict production response", () => {
  const network = vi.fn(async () => { throw new Error("Unexpected network/model request"); });
  const nativeAudienceRule = "3. contentExpectations 至少包含一条'无需字幕也能看懂的视觉叙事'类全球化要求，和一条'可复述可转发的钉子台词'类传播要求。";
  beforeEach(() => { network.mockClear(); vi.stubGlobal("fetch", network); vi.useFakeTimers(); });
  afterEach(() => {
    expect(network).not.toHaveBeenCalled();
    vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
  });

  it("uses the three frozen hard cuts and technique-only reference schema in the actual native calls", async () => {
    installNativeDiscovery();
    const valid = physicalScene([10, 10, 10]), rejected = physicalScene([4, 6, 9, 5, 6]);
    const run = withFrozenSegmentBrief(privateRun("frozen-segments", 30, valid));
    const model = modelFor(run, [rejected, valid]);
    const result = await runDiscovery(run, model.engine);
    expect(result.sceneStructure).toEqual(valid);
    expect(result.referenceCases).toEqual(run.modules.reference);
    const scenes = model.calls.filter(call => call.method === "reason");
    expect(scenes).toHaveLength(2);
    for (const call of scenes) {
      expect(call.prompt).toContain("从高速追击直接开始");
      expect(call.prompt).toContain("停车停稳后摘盔、登台举杯");
      expect(call.prompt).not.toMatch(/1\.3倍|falling 级的留白场景|一句台词|自行决定开场、零个或多个/u);
      expectCompleteSources(call.prompt, run);
    }
    expect(scenes[1]!.prompt).toContain(feedbackHeading);
    const refs = model.calls.find(call => call.prompt.startsWith("你是一位泡在片库里的剪辑指导"));
    expect(refs).toBeDefined();
    expect(refs!.prompt).not.toMatch(/Apple新春短片|至少一部|影片名称必须带/u);
    expectCompleteSources(refs!.prompt, run);
    expect(requirementRecord(requirementRecord(refs!.schema, "reference schema").properties, "reference properties"))
      .toMatchObject({ filmReferences: { minItems: 0, maxItems: 0 }, adReferences: { minItems: 0, maxItems: 0 } });
  });

  it("guides native silent audience and risk analyses without rewriting their accepted G3 response", async () => {
    installNativeDiscovery();
    const scene = physicalScene([10, 10, 10]);
    const run = withFrozenSegmentBrief(privateRun("silent-observable-expectations", 30, scene));
    run.authority.profile.speechPolicy = "none";
    // Identical source literals supplied by the owner remain part of the evidence.
    run.input.description += `\n客户逐字引用：\n${nativeAudienceRule}\n原始描述结束。`;
    run.modules.audience.contentExpectations.push("留给G3独立审阅的本次模型原话");
    run.modules.risk.mitigationSuggestions.push("模型原样保留的具体镜头风险");
    const before = [run.input, run.authority, run.approvedTheme, run.modules].map(requirementHash);
    const rawScene = JSON.stringify(scene, null, 2);
    const model = modelFor(run, [rawScene]), discovery = nativeDiscovery(model.engine);
    const actual = await withRequirementContractScope(run.metadata, async () => {
      const record = await Reflect.apply(discovery.discover as NativeMethod, discovery, [run.input]) as RequirementRecord;
      const markdown = Reflect.apply(discovery.generateMarkdown as NativeMethod, discovery, [record]) as string;
      return { record, markdown };
    }, run.options);

    expect(model.calls).toHaveLength(4);
    const [audienceCall, sceneCall, riskCall, referenceCall] = model.calls;
    expect(audienceCall!.prompt.split(nativeAudienceRule)).toHaveLength(2); // only the owner's literal
    expect(audienceCall!.prompt).not.toContain("第50秒转发");
    expect(audienceCall!.prompt).toContain("可观察的画面、动作与原生声场");
    expect(audienceCall!.prompt).toContain("不得把未有来源的数字、时点、动作次数或商品名写成本片要求");
    expect(audienceCall!.prompt).not.toContain(rawScene);
    expect(riskCall!.prompt).toContain("商品身份、型号及用途以本次 G1 已接受原文为准");
    expect(riskCall!.prompt).toContain("不得从受众推测新增事实、数字或动作节拍");
    expect(riskCall!.prompt.split(rawScene)).toHaveLength(2);
    expect(riskCall!.options).toEqual({ maxTokens: 4000, temperature: 1, timeoutMs: 100 });
    expect(sceneCall!.prompt).not.toContain("可观察的画面、动作与原生声场");
    expect(referenceCall!.prompt).not.toContain("不得从受众推测新增事实");
    for (const call of model.calls) expectCompleteSources(call.prompt, run);
    expect(actual.record).toMatchObject({ audienceProfile: run.modules.audience, riskAssessment: run.modules.risk, sceneStructure: scene });
    expect(actual.markdown).toContain("留给G3独立审阅的本次模型原话");
    expect(actual.markdown).toContain("模型原样保留的具体镜头风险");
    expect([run.input, run.authority, run.approvedTheme, run.modules].map(requirementHash)).toEqual(before);
  });

  it.each(["frozen without private speech policy", "private speech policy without frozen segments"])(
    "preserves the native audience contract for %s",
    async (kind) => {
      installNativeDiscovery();
      const scene = physicalScene([10, 10, 10]);
      const run = privateRun(kind, 30, scene);
      if (kind === "frozen without private speech policy") withFrozenSegmentBrief(run);
      else run.authority.profile.speechPolicy = "none";
      const model = modelFor(run, [scene]);
      await expect(runDiscovery(run, model.engine)).resolves.toMatchObject({ audienceProfile: run.modules.audience });
      expect(model.calls).toHaveLength(4);
      expect(model.calls[0]!.prompt).toContain("第50秒转发");
      expect(model.calls[0]!.prompt).toContain("可复述可转发的钉子台词");
      expect(model.calls[2]!.prompt).not.toContain("商品身份、型号及用途以本次 G1 已接受原文为准");
    },
  );

  it("fails before the first request if the native audience rule changes even when the owner quotes the old rule", async () => {
    installNativeDiscovery();
    const scene = physicalScene([10, 10, 10]);
    const run = withFrozenSegmentBrief(privateRun("silent-drifted-native-audience", 30, scene));
    run.authority.profile.speechPolicy = "none";
    run.input.description += `\n客户逐字引用：\n${nativeAudienceRule}\n原始描述结束。`;
    const model = modelFor(run, [scene]), discovery = nativeDiscovery(model.engine);
    const audience = requirementRecord(requirementRecord(discovery.agents, "agents").audience, "audience");
    const build = audience._buildPrompt as NativeMethod;
    audience._buildPrompt = function (this: RequirementRecord, input: unknown) {
      const prompt = Reflect.apply(build, this, [input]) as string;
      const at = prompt.lastIndexOf(nativeAudienceRule);
      return prompt.slice(0, at) + "3. 原生静态约束已变化。" + prompt.slice(at + nativeAudienceRule.length);
    };
    await expect(runDiscovery(run, model.engine, discovery)).rejects.toThrow("REQUIREMENT_VENDOR_UNAVAILABLE");
    expect(model.calls).toHaveLength(0);
  });

  it("opts only the protected frozen SceneArchitect into the exact same effective native response schema", async () => {
    vi.stubEnv("WORKLOOM_VIDEO_SCENE_RESPONSE_FORMAT", "json_schema");
    try {
      installNativeDiscovery();
      const valid = physicalScene([10, 10, 10]);
      const frozen = withFrozenSegmentBrief(privateRun("provider-schema-frozen", 30, valid));
      const model = modelFor(frozen, [valid]);
      await expect(runDiscovery(frozen, model.engine)).resolves.toMatchObject({ sceneStructure: valid });
      const scene = model.calls.filter(call => call.method === "reason");
      expect(scene).toHaveLength(1);
      expectCompleteSources(scene[0]!.prompt, frozen);
      const format = requirementRecord(requirementRecord(scene[0]!.options, "native options").responsesJsonSchema, "provider schema");
      expect(format.name).toBe("workloom_scene_architect");
      const schema = requirementRecord(format.schema, "effective schema");
      expect(schema.properties).toMatchObject({ scenes: { minItems: 1, maxItems: 1 },
        opening: { properties: { duration: { minimum: 10, maximum: 10 }, productionContract: { properties: { actions: { minItems: 1 } } } } } });
      expect(() => validateRequirementSchema(valid, schema)).not.toThrow();
      expect(model.calls.filter(call => call.method !== "reason").every(call => !Object.hasOwn(requirementRecord(call.options, "native options"), "responsesJsonSchema"))).toBe(true);
      const standard = privateRun("provider-schema-standard", 30, valid);
      const ordinary = modelFor(standard, [valid]);
      await runDiscovery(standard, ordinary.engine);
      expect(ordinary.calls.every(call => !Object.hasOwn(requirementRecord(call.options, "native options"), "responsesJsonSchema"))).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });

  it("rejects conflicting or discontinuous frozen segments before a model call", async () => {
    installNativeDiscovery();
    const run = withFrozenSegmentBrief(privateRun("conflicting-segments", 30, physicalScene([10, 10, 10])));
    const brief = requirementRecord(run.metadata.brief, "test Brief");
    const segments = requirementRecord(brief.segmentContract, "test segment contract");
    requirementRecord((segments.intervals as unknown[])[1], "middle interval").startSec = 10.01;
    run.authority.metadata = structuredClone(run.metadata);
    const model = modelFor(run, [run.modules.scene]);
    await expect(runDiscovery(run, model.engine)).rejects.toThrow("REQUIREMENT_SCENE_UNVERIFIED");
    expect(model.calls).toHaveLength(0);
  });

  it("makes one scoped correction for the wrong index and never retries an unknown scene outcome", async () => {
    installNativeDiscovery();
    const valid = physicalScene([10, 10, 10]), invalid = structuredClone(valid);
    requirementRecord((invalid.scenes as unknown[])[0], "middle").index = 2;
    const first = withFrozenSegmentBrief(privateRun("frozen-index", 30, valid));
    const repair = modelFor(first, [invalid, valid]);
    await expect(runDiscovery(first, repair.engine)).resolves.toMatchObject({ sceneStructure: valid });
    const corrected = repair.calls.filter(call => call.method === "reason");
    expect(corrected).toHaveLength(2);
    expect(promptJson(corrected[1]!.prompt, feedbackHeading)).toMatchObject({ path: "SceneArchitect response/scenes/0/index", observed: 2, limit: 1 });

    const second = withFrozenSegmentBrief(privateRun("frozen-unknown", 30, valid));
    const unknown = modelFor(second, [new Error("synthetic outcome unknown"), valid]);
    await expect(runDiscovery(second, unknown.engine)).rejects.toThrow("REQUIREMENT_SCENE_UNVERIFIED");
    expect(unknown.calls.filter(call => call.method === "reason")).toHaveLength(1);
  });

  it("rejects a named case hidden inside technique prose before G3 review", async () => {
    installNativeDiscovery();
    const valid = physicalScene([10, 10, 10]), run = withFrozenSegmentBrief(privateRun("frozen-ref-named", 30, valid));
    run.modules.reference.styleReferences = ["《内部示例作品》镜头", "仅用原生环境声"];
    const model = modelFor(run, [valid]);
    await expect(runDiscovery(run, model.engine)).rejects.toThrow("REQUIREMENT_DISCOVERY_UNVERIFIED");
    const refs = model.calls.filter(call => call.prompt.startsWith("你是一位泡在片库里的剪辑指导"));
    expect(refs).toHaveLength(2);
    expect(refs[1]!.prompt).toContain("ReferenceCurator response/styleReferences/0");
    expect(refs[1]!.prompt).not.toContain("内部示例作品");
  });

  it("binds only the current accepted complete SceneArchitect draft to later agents and preserves their G3-visible conflicts", async () => {
    installNativeDiscovery();
    const valid = physicalScene([10, 10, 10]), wrong = physicalScene([4, 6, 9, 5, 6]);
    const acceptedTail = "完整结尾草案：" + "持续保存源文本至末尾。".repeat(220) + "ACCEPTED-SCENE-EXACT-TAIL";
    requirementRecord(valid.ending, "accepted ending").purpose = acceptedTail;
    requirementRecord(wrong.ending, "rejected ending").purpose = "REJECTED-SCENE-MUST-STAY-PRIVATE";
    const raw = JSON.stringify(valid, null, 2);
    const run = withFrozenSegmentBrief(privateRun("current-scene-annex", 30, valid));
    run.modules.risk.mitigationSuggestions = ["刻意保留的冲突：增加一个独立的第四生成片段"];
    run.modules.reference.styleReferences = ["刻意保留的冲突：改用额外补拍插入成片", "保留环境原生声音"];
    const model = modelFor(run, [wrong, raw]), discovery = nativeDiscovery(model.engine);
    const actual = await withRequirementContractScope(run.metadata, async () => {
      const record = await Reflect.apply(discovery.discover as NativeMethod, discovery, [run.input]) as RequirementRecord;
      const g3Markdown = Reflect.apply(discovery.generateMarkdown as NativeMethod, discovery, [record]);
      return { record, g3Markdown };
    }, run.options);
    expect(actual.record.sceneStructure).toEqual(valid);
    expect(actual.record.riskAssessment).toEqual(run.modules.risk);
    expect(actual.record.referenceCases).toEqual(run.modules.reference);
    expect(actual.g3Markdown).toContain(run.modules.risk.mitigationSuggestions[0]);
    expect(actual.g3Markdown).toContain(run.modules.reference.styleReferences[0]);
    expect(model.calls).toHaveLength(5);
    const [audience, initialScene, repairedScene, risk, reference] = model.calls;
    for (const call of [audience!, initialScene!, repairedScene!]) expect(call.prompt).not.toContain(raw);
    expect(risk!.prompt).not.toContain("拆分为2-3个连续特写");
    for (const call of [risk!, reference!]) {
      expect(call.prompt.split(raw)).toHaveLength(2);
      expect(call.prompt).toContain("ACCEPTED-SCENE-EXACT-TAIL");
      expect(call.prompt).not.toContain("REJECTED-SCENE-MUST-STAY-PRIVATE");
      expect(call.prompt).toContain("从高速追击直接开始");
      expect(call.prompt).toContain("不得新增生成段");
      expect(call.prompt).toContain("发型");
      expect(call.prompt).toContain("姿态");
      expect(call.prompt).toContain("按真实风险报告");
      expectCompleteSources(call.prompt, run);
    }
  });

  it("keeps ordinary private discovery on the native prompt without a frozen cross-agent scene annex", async () => {
    installNativeDiscovery();
    const scene = physicalScene([10, 10, 10]), run = privateRun("legacy-no-annex", 30, scene);
    const model = modelFor(run, [scene]);
    await expect(runDiscovery(run, model.engine)).resolves.toMatchObject({ sceneStructure: scene });
    expect(model.calls).toHaveLength(4);
    const risk = model.calls[2]!, reference = model.calls[3]!;
    expect(risk.prompt).toContain("拆分为2-3个连续特写");
    expect(reference.prompt).toContain("Apple新春短片");
    for (const call of [risk, reference]) expect(call.prompt).not.toContain(JSON.stringify(scene));
  });

  it.each([
    { duration: 30, feasibleMiddleCounts: [0, 1, 2, 3, 4, 5] },
    { duration: 30.96, feasibleMiddleCounts: [0, 1, 2, 3, 4, 5] },
    { duration: 45, feasibleMiddleCounts: [1, 2, 3, 4, 5, 6, 7, 8] },
    { duration: 60, feasibleMiddleCounts: [1, 2, 3, 4, 5, 6, 7, 8] }
  ])("corrects the actual $duration s native contradiction without changing identical customer literals or schema", async ({ duration, feasibleMiddleCounts }) => {
    expect(createHash("sha256").update(readFileSync(nativeDiscoveryFile)).digest("hex"))
      .toBe("d372d61aa6c851e8f4c5976ab2bb97604722d101054aabe3fae9b31c835697b6");
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
    expect(String(input.description)).toContain("falling 级的留白场景（3-6秒）");
    const generated = corrected.replace(`主题描述: ${String(input.description)}\n`, "主题描述: [客户原文完整保留]\n");
    expect(generated).not.toContain("falling 级的留白场景（3-6秒）");
    expect(generated).not.toContain(original.countLine);
    expect(generated).not.toContain(original.example);
    expect(promptJson(corrected, timingHeading)).toEqual({ targetDuration: duration,
      targetToleranceSeconds: 5, arithmeticToleranceSeconds: 0.05,
      opening: { minimum: 3, maximum: 15 }, middle: { minimum: 5, maximum: 60 }, ending: { minimum: 3, maximum: 15 },
      middleCount: { minimum: 0, maximum: 8 }, feasibleMiddleCounts });
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
    for (const call of model.calls) expectCompleteSources(call.prompt, run);
    const sceneCall = model.calls.find(call => call.method === "reason")!;
    expect(sceneCall.prompt).toContain(`## 📖 原始故事文本（需求分析的核心依据）\n${run.story}`);
    expect(sceneCall.options).toMatchObject({ maxTokens: 16384, temperature: 0.4, forceJson: true, thinking: { type: "disabled" } });
    expect(sceneCall).not.toHaveProperty("schema");
    expect(requirementHash(run.input)).toBe(before);
    expect(requirementRecord(result.upstreamFields, "source")._originalStoryText).toBe(run.story);
    expect(JSON.stringify(result)).not.toContain(run.authority.marketing.g1Artifact.content);
    expect(JSON.stringify(result)).not.toContain(run.approvedTheme.contentMd);
  });

  it("uses the native second scene attempt to correct a schema minimum with complete unchanged story and G1/G2 authority", async () => {
    installNativeDiscovery();
    const valid = physicalScene([3, 5, 7, 15]), invalid = physicalScene([3, 4, 8, 15]);
    const run = privateRun("native-schema-correction", 30, valid), model = modelFor(run, [invalid, valid]);
    const original = await nativePromptParts(run.input), suffixAt = original.prompt.lastIndexOf(`\n\n${original.countLine}`);
    expect(suffixAt).toBeGreaterThanOrEqual(0);
    run.input.description += `\n客户逐字保留完整原生生成段：${original.prompt.slice(suffixAt)}\n客户原文完整尾注𠮷`;
    const inputBefore = requirementHash(run.input), authorityBefore = requirementHash(run.authority), themeBefore = requirementHash(run.approvedTheme);
    const result = await runDiscovery(run, model.engine), sceneCalls = model.calls.filter(call => call.method === "reason");
    expect(sceneCalls).toHaveLength(2);
    expect(model.calls).toHaveLength(5);
    expect(model.calls.filter(call => call.method === "reasonStructured")).toHaveLength(3);
    expect(sceneCalls[0]!.prompt).not.toContain(feedbackHeading);
    expect(promptJson(sceneCalls[1]!.prompt, feedbackHeading)).toEqual(schemaFailure("/scenes/0/duration", "minimum", 4, 5));
    for (const call of model.calls) expectCompleteSources(call.prompt, run);
    for (const call of model.calls.filter(value => value.method !== "reason")) expect(call.prompt).not.toContain(feedbackHeading);
    for (const call of sceneCalls) {
      expect(call.prompt).toContain(`主题描述: ${run.input.description}\n`);
      expect(call.prompt.split(original.countLine)).toHaveLength(2);
      expect(call.prompt.split(original.example)).toHaveLength(2);
      expect(call.prompt.replace(`主题描述: ${run.input.description}\n`, "")).not.toContain("falling 级的留白场景（3-6秒）");
      expect(call.options).toMatchObject({ maxTokens: 16384, temperature: 0.4, forceJson: true, thinking: { type: "disabled" } });
      expect(call).not.toHaveProperty("schema");
    }
    expect(requirementHash(result.sceneStructure)).toBe(requirementHash(valid));
    expect(requirementHash(run.input)).toBe(inputBefore);
    expect(requirementHash(run.authority)).toBe(authorityBefore);
    expect(requirementHash(run.approvedTheme)).toBe(themeBefore);
    expect(requirementRecord(result.upstreamFields, "source")._originalStoryText).toBe(run.story);
    expect(JSON.stringify(result)).not.toContain(feedbackHeading);
    expect(JSON.stringify(result)).not.toContain(run.authority.marketing.g1Artifact.content);
    expect(JSON.stringify(result)).not.toContain(run.approvedTheme.contentMd);
  });

  it("reports the second actual schema path and observed value after two different invalid native responses", async () => {
    installNativeDiscovery();
    const valid = physicalScene([3, 5, 7, 15]);
    const first = physicalScene([3, 4.123456, 7.876544, 15]), second = physicalScene([2.876543, 5, 7.123457, 15]);
    const run = privateRun("latest-schema-details", 30, valid), model = modelFor(run, [first, second]);
    const failure = await runDiscovery(run, model.engine).then(() => undefined, error => error);
    const details = requirementRecord(failure, "current native failure").details;
    expect(failure).toBeInstanceOf(Error);
    expect(details).toEqual(schemaFailure("/opening/duration", "minimum", 2.876543, 3));
    expect(Object.isFrozen(details)).toBe(true);
    expect(failureText(failure)).not.toContain("4.123456");
    expect(failureText(failure)).not.toContain("/scenes/0/duration");
    const sceneCalls = model.calls.filter(call => call.method === "reason");
    expect(sceneCalls).toHaveLength(2);
    expect(sceneCalls[0]!.prompt).not.toContain(feedbackHeading);
    expect(promptJson(sceneCalls[1]!.prompt, feedbackHeading)).toEqual(schemaFailure("/scenes/0/duration", "minimum", 4.123456, 5));
    expect(model.calls.filter(call => call.method === "reasonStructured")).toHaveLength(1);
    for (const call of model.calls) expectCompleteSources(call.prompt, run);
    for (const privateText of [run.story, run.authority.marketing.g1Artifact.content, run.approvedTheme.contentMd]) {
      expect(failureText(failure)).not.toContain(privateText);
    }
  });

  it.each([
    { node: "opening", index: 0, keyword: "minimum", limit: 3, durations: [3, 5, 3], outside: 2.999999 },
    { node: "opening", index: 0, keyword: "maximum", limit: 15, durations: [15, 5, 3], outside: 15.000001 },
    { node: "scenes/0", index: 1, keyword: "minimum", limit: 5, durations: [3, 5, 3], outside: 4.999999 },
    { node: "scenes/0", index: 1, keyword: "maximum", limit: 60, durations: [3, 60, 3], outside: 60.000001 },
    { node: "ending", index: 2, keyword: "minimum", limit: 3, durations: [3, 5, 3], outside: 2.999999 },
    { node: "ending", index: 2, keyword: "maximum", limit: 15, durations: [3, 5, 15], outside: 15.000001 }
  ] as const)("enforces actual native $node $keyword=$limit without changing a model-authored boundary response", async ({ node, index, keyword, limit, durations, outside }) => {
    installNativeDiscovery();
    const boundaryDurations: number[] = [...durations];
    const valid = physicalScene(boundaryDurations), duration = boundaryDurations.reduce((sum, value) => sum + value, 0);
    const acceptedRun = privateRun(`boundary-${node.replaceAll("/", "-")}-${keyword}`, duration, valid), acceptedModel = modelFor(acceptedRun, [valid]);
    const accepted = await runDiscovery(acceptedRun, acceptedModel.engine);
    expect(requirementHash(accepted.sceneStructure)).toBe(requirementHash(valid));
    expect(acceptedModel.calls.filter(call => call.method === "reason")).toHaveLength(1);
    const invalidDurations: number[] = [...durations]; invalidDurations[index] = outside;
    const invalid = physicalScene(invalidDurations), rejectedRun = privateRun(`outside-${node.replaceAll("/", "-")}-${keyword}`, duration, valid);
    const rejectedModel = modelFor(rejectedRun, [invalid]);
    const failure = await runDiscovery(rejectedRun, rejectedModel.engine).then(() => undefined, error => error);
    const expected = schemaFailure(`/${node}/duration`, keyword, outside, limit);
    expect(failure).toBeInstanceOf(Error);
    expect(requirementRecord(failure, "boundary failure").details).toEqual(expected);
    expect(Object.isFrozen(requirementRecord(failure, "boundary failure").details)).toBe(true);
    const sceneCalls = rejectedModel.calls.filter(call => call.method === "reason");
    expect(sceneCalls).toHaveLength(2);
    expect(sceneCalls[0]!.prompt).not.toContain(feedbackHeading);
    expect(promptJson(sceneCalls[1]!.prompt, feedbackHeading)).toEqual(expected);
  });

  it("keeps five model-authored middle nodes feasible at 30.96 seconds within the target band", async () => {
    installNativeDiscovery();
    const scene = physicalScene([3, 5, 5, 5, 5, 5, 3]), run = privateRun("feasible-tolerance", 30.96, scene), model = modelFor(run, [scene]);
    const result = await runDiscovery(run, model.engine), sceneCalls = model.calls.filter(call => call.method === "reason");
    expect(requirementHash(result.sceneStructure)).toBe(requirementHash(scene));
    expect(sceneCalls).toHaveLength(1);
    expect(sceneCalls[0]!.prompt).not.toContain(feedbackHeading);
    expect(promptJson(sceneCalls[0]!.prompt, timingHeading)).toMatchObject({ targetDuration: 30.96,
      targetToleranceSeconds: 5, arithmeticToleranceSeconds: 0.05,
      feasibleMiddleCounts: [0, 1, 2, 3, 4, 5] });
    expectCompleteSources(sceneCalls[0]!.prompt, run);
  });

  it.each(["count", "declared-total", "target-total", "physical-schema"])("still rejects %s with exactly the original two scene attempts", async kind => {
    installNativeDiscovery();
    const scene = physicalScene([10, 10, 10]), invalid = structuredClone(scene);
    if (kind === "count") invalid.sceneCount = 2;
    if (kind === "declared-total") invalid.totalDuration = 29;
    if (kind === "target-total") { requirementRecord(invalid.ending, "ending").duration = 4; invalid.totalDuration = 24; }
    if (kind === "physical-schema") delete requirementRecord(invalid.opening, "opening").productionContract;
    const run = privateRun(kind, 30, scene), model = modelFor(run, [invalid]);
    await expect(runDiscovery(run, model.engine)).rejects.toThrow("REQUIREMENT_SCENE_UNVERIFIED");
    expect(model.calls.filter(call => call.method === "reason")).toHaveLength(2);
    expect(model.calls.filter(call => call.method === "reasonStructured")).toHaveLength(1); // audience only; no later agent
  });

  it.each([{ delta: 0.049, accepted: true }, { delta: 0.051, accepted: false }])("retains the existing 0.05s tolerance at delta=$delta", async ({ delta, accepted }) => {
    installNativeDiscovery();
    const scene = physicalScene([10, 10, 10 + delta]), run = privateRun(`tolerance-${delta}`, 30, scene), model = modelFor(run, [scene]);
    scene.totalDuration = 30;
    if (accepted) {
      const result = await runDiscovery(run, model.engine);
      expect(requirementHash(result.sceneStructure)).toBe(requirementHash(scene));
    } else await expect(runDiscovery(run, model.engine)).rejects.toThrow("REQUIREMENT_SCENE_UNVERIFIED");
    expect(model.calls.filter(call => call.method === "reason")).toHaveLength(accepted ? 1 : 2);
  });

  it("accepts a model-authored 34-second scene contract for a 30-second target within ±5 seconds", async () => {
    installNativeDiscovery();
    const scene = physicalScene([10, 10, 14]), run = privateRun("target-band-34", 30, scene), model = modelFor(run, [scene]);
    const result = await runDiscovery(run, model.engine), sceneCalls = model.calls.filter(call => call.method === "reason");
    expect(requirementHash(result.sceneStructure)).toBe(requirementHash(scene));
    expect(sceneCalls).toHaveLength(1);
    expect(sceneCalls[0]!.prompt).not.toContain(feedbackHeading);
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

  it.each(["schema", "transport", "parser"])("does not reuse prior numeric metrics after a later %s failure", async kind => {
    installNativeDiscovery();
    const scene = physicalScene([10, 10, 10]), first = structuredClone(scene), second = structuredClone(scene);
    first.sceneCount = 913719;
    delete requirementRecord(second.ending, "ending").productionContract;
    const run = privateRun(`latest-${kind}`, 30, scene);
    const model = modelFor(run, [first, kind === "schema" ? second : kind === "parser" ? "{invalid native JSON" : new Error("synthetic transport failure")]);
    const failure = await runDiscovery(run, model.engine).then(() => undefined, error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failureText(failure)).not.toContain("913719");
    const sceneCalls = model.calls.filter(call => call.method === "reason");
    expect(sceneCalls).toHaveLength(2);
    expect(sceneCalls[0]!.prompt).not.toContain(feedbackHeading);
    expect(promptJson(sceneCalls[1]!.prompt, feedbackHeading)).toEqual({ nodeCount: 3, declaredSceneCount: 913719,
      durationSum: 30, declaredTotalDuration: 30, targetDuration: 30, declaredDurationDelta: 0, targetDurationDelta: 0,
      targetDurationToleranceSeconds: 5 });
    if (kind !== "schema") expect(requirementRecord(failure, "current nonvalidation failure").details).toBeUndefined();
  });

  it.each(["transport", "parser"])("keeps a first %s failure out of native validation feedback on a successful retry", async kind => {
    installNativeDiscovery();
    const scene = physicalScene([10, 10, 10]), run = privateRun(`first-${kind}`, 30, scene);
    const model = modelFor(run, [kind === "parser" ? "{invalid native JSON" : new Error("synthetic first transport failure"), scene]);
    const result = await runDiscovery(run, model.engine), sceneCalls = model.calls.filter(call => call.method === "reason");
    expect(requirementHash(result.sceneStructure)).toBe(requirementHash(scene));
    expect(sceneCalls).toHaveLength(2);
    for (const call of sceneCalls) {
      expect(call.prompt).not.toContain(feedbackHeading);
      expectCompleteSources(call.prompt, run);
    }
  });

  it.each(["valid repair", "malformed repair", "unknown transport"])(
    "keeps native JSON mode and makes only a genuine syntax correction after %s",
    async outcome => {
      installNativeDiscovery();
      const run = privateRun(`native-wire-${outcome}`, 30, physicalScene([10, 10, 10]));
      const sceneBodies: Array<{ raw: string; prompt: string; model: unknown; maxTokens: unknown; format: unknown }> = [];
      const admissions = new Set<string>();
      const malformed = '{"scenes":[{"purpose":"SYNTHETIC_RAW_REJECTED_CONTENT"} {"index":2}]}';
      const engine = new WorkloomLLMEngine({
        baseUrl: "http://127.0.0.1:1", apiKey: "synthetic-local-bearer", model: "deepseek-flash",
        fetchImpl: async (_url, init) => {
          const raw = String(init?.body), body = JSON.parse(raw), prompt: string = body.messages[1].content;
          let content: string;
          if (prompt.startsWith("你是一位电影导演")) {
            sceneBodies.push({ raw, prompt, model: body.model, maxTokens: body.max_tokens, format: body.response_format });
            if (admissions.has(raw)) {
              return Response.json({ error: { code: "BUDGET_DUPLICATE_REQUEST" } }, { status: 409 });
            }
            admissions.add(raw);
            if (outcome === "unknown transport") {
              return Response.json({ error: { code: "BUDGET_OUTCOME_UNKNOWN" } }, { status: 502 });
            }
            content = admissions.size === 1 || outcome === "malformed repair" ? malformed : JSON.stringify(run.modules.scene);
          } else {
            const module = prompt.slice(0, 180).includes("受众分析") ? "audience"
              : prompt.slice(0, 180).includes("技术制片人") ? "risk" : "reference";
            content = JSON.stringify(run.modules[module]);
          }
          return Response.json({ model: "deepseek-flash", choices: [{ finish_reason: "stop", message: { content } }],
            usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } });
        },
      });
      const engineObject = engine as unknown as RequirementRecord;
      const discovery = nativeDiscovery(engineObject);
      requirementRecord(requirementRecord(discovery.agents, "agents").scene, "scene").maxRetries = 2;
      const result = runDiscovery(run, engineObject, discovery);
      if (outcome === "valid repair") {
        await expect(result).resolves.toMatchObject({ sceneStructure: run.modules.scene });
      } else {
        await expect(result).rejects.toThrow("REQUIREMENT_SCENE_UNVERIFIED");
      }
      expect(sceneBodies).toHaveLength(outcome === "unknown transport" ? 3 : 2);
      expect(admissions.size).toBe(outcome === "unknown transport" ? 1 : 2);
      const schemaHeading = "本次实际 SceneArchitect 响应 JSON Schema（完整适用，不是示例成品）：";
      for (const call of sceneBodies) {
        expect(call.model).toBe("deepseek-flash");
        expect(call.maxTokens).toBe(393_216);
        expect(call.format).toEqual({ type: "json_object" });
        expectCompleteSources(call.prompt, run);
        expect(promptJson(call.prompt, schemaHeading)).toEqual(promptJson(sceneBodies[0]!.prompt, schemaHeading));
        expect(call.prompt).not.toContain("SYNTHETIC_RAW_REJECTED_CONTENT");
      }
      expect(sceneBodies[0]!.prompt).not.toContain("上一次原生场景 JSON 语法纠正");
      if (outcome !== "unknown transport") {
        expect(sceneBodies[1]!.prompt).toContain("上一次原生场景 JSON 语法纠正");
      }
    },
  );

  it.each(["transport", "parser"])("clears the first schema diagnostic when the current second attempt fails in %s", async kind => {
    installNativeDiscovery();
    const valid = physicalScene([3, 5, 7, 15]), invalid = physicalScene([3, 4.765431, 7.234569, 15]);
    const run = privateRun(`schema-then-${kind}`, 30, valid);
    const model = modelFor(run, [invalid, kind === "parser" ? "{invalid native JSON" : new Error("synthetic second transport failure")]);
    const failure = await runDiscovery(run, model.engine).then(() => undefined, error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failureText(failure)).toContain("REQUIREMENT_SCENE_UNVERIFIED");
    expect(failureText(failure)).not.toContain("4.765431");
    expect(failureText(failure)).not.toContain("/scenes/0/duration");
    expect(requirementRecord(failure, "latest nonvalidation failure").details).toBeUndefined();
    const sceneCalls = model.calls.filter(call => call.method === "reason");
    expect(sceneCalls).toHaveLength(2);
    expect(sceneCalls[0]!.prompt).not.toContain(feedbackHeading);
    expect(promptJson(sceneCalls[1]!.prompt, feedbackHeading)).toEqual(schemaFailure("/scenes/0/duration", "minimum", 4.765431, 5));
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

  it("isolates overlapping feedback on one model engine and native scene agent, then starts a new run without old feedback", async () => {
    installNativeDiscovery();
    const a = privateRun("overlap-A", 30, physicalScene([15, 15]));
    const b = privateRun("overlap-B", 45, physicalScene([10, 12, 13, 10]));
    const c = privateRun("after-overlap", 30, physicalScene([10, 10, 10]));
    const runs = [a, b, c], before = runs.map(run => ({ input: requirementHash(run.input), authority: requirementHash(run.authority), theme: requirementHash(run.approvedTheme) }));
    const calls: Array<{ method: string; prompt: string }> = [], engine: RequirementRecord = { _extractJsonObject: (value: string) => value };
    const attempts = new Map<ReturnType<typeof privateRun>, number>();
    let releaseFirstAttempts!: () => void, firstAttempts = 0;
    const bothFirstAttempts = new Promise<void>(resolve => { releaseFirstAttempts = resolve; });
    const selected = (prompt: string) => {
      for (const run of runs) if (prompt.includes(run.story)) return run;
      throw new Error("Native request lost its complete original story");
    };
    engine.reasonStructured = vi.fn(async function (this: RequirementRecord, prompt: string) {
      expect(this).toBe(engine); calls.push({ method: "reasonStructured", prompt }); await Promise.resolve();
      const run = selected(prompt), intro = prompt.slice(0, 180);
      return { success: true, data: structuredClone(intro.includes("受众分析") ? run.modules.audience
        : intro.includes("技术制片人") ? run.modules.risk : run.modules.reference) };
    });
    engine.reason = vi.fn(async function (this: RequirementRecord, prompt: string) {
      expect(this).toBe(engine); calls.push({ method: "reason", prompt });
      const run = selected(prompt), attempt = attempts.get(run) ?? 0; attempts.set(run, attempt + 1);
      if (attempt === 0 && run !== c) {
        if (++firstAttempts === 2) releaseFirstAttempts();
        await bothFirstAttempts;
        return { success: true, content: JSON.stringify(run === a
          ? physicalScene([3, 4.111117, 7.888883, 15]) : physicalScene([15, 12, 15.776663, 2.223337])) };
      }
      await Promise.resolve();
      return { success: true, content: JSON.stringify(run.modules.scene) };
    });
    const discoveryA = nativeDiscovery(engine), discoveryB = nativeDiscovery(engine), discoveryC = nativeDiscovery(engine);
    discoveryB.agents = discoveryA.agents; discoveryC.agents = discoveryA.agents;
    const sharedScene = requirementRecord(discoveryA.agents, "shared agents").scene;
    const [first, second] = await Promise.all([runDiscovery(a, engine, discoveryA), runDiscovery(b, engine, discoveryB)]);
    expect(requirementHash(first.sceneStructure)).toBe(requirementHash(a.modules.scene));
    expect(requirementHash(second.sceneStructure)).toBe(requirementHash(b.modules.scene));
    expect(calls).toHaveLength(10);
    const third = await runDiscovery(c, engine, discoveryC);
    expect(requirementHash(third.sceneStructure)).toBe(requirementHash(c.modules.scene));
    expect(calls).toHaveLength(14);
    const sceneCalls = (run: ReturnType<typeof privateRun>) => calls.filter(call => call.method === "reason" && selected(call.prompt) === run);
    const aCalls = sceneCalls(a), bCalls = sceneCalls(b), cCalls = sceneCalls(c);
    expect(aCalls).toHaveLength(2); expect(bCalls).toHaveLength(2); expect(cCalls).toHaveLength(1);
    for (const firstCall of [aCalls[0]!, bCalls[0]!, cCalls[0]!]) expect(firstCall.prompt).not.toContain(feedbackHeading);
    expect(promptJson(aCalls[1]!.prompt, feedbackHeading)).toEqual(schemaFailure("/scenes/0/duration", "minimum", 4.111117, 5));
    expect(promptJson(bCalls[1]!.prompt, feedbackHeading)).toEqual(schemaFailure("/ending/duration", "minimum", 2.223337, 3));
    for (const call of calls) {
      const run = selected(call.prompt);
      expectCompleteSources(call.prompt, run);
      for (const other of runs.filter(value => value !== run)) {
        expect(call.prompt).not.toContain(other.story);
        expect(call.prompt).not.toContain(other.authority.marketing.g1Artifact.content);
        expect(call.prompt).not.toContain(other.approvedTheme.contentMd);
      }
      if (run !== a) expect(call.prompt).not.toContain("4.111117");
      if (run !== b) expect(call.prompt).not.toContain("2.223337");
    }
    for (const discovery of [discoveryA, discoveryB, discoveryC]) {
      expect(discovery.agents).toBe(discoveryA.agents);
      expect(requirementRecord(discovery.agents, "unchanged shared agents").scene).toBe(sharedScene);
    }
    for (const [index, run] of runs.entries()) {
      expect(requirementHash(run.input)).toBe(before[index]!.input);
      expect(requirementHash(run.authority)).toBe(before[index]!.authority);
      expect(requirementHash(run.approvedTheme)).toBe(before[index]!.theme);
    }
  });
});

const riskFeedbackHeading = "## 上一次原生风险校验反馈";
type RiskArray = "technicalRisks" | "businessConstraints" | "mitigationSuggestions";
function riskResponse(run: ReturnType<typeof privateRun>, key: RiskArray, count: number): RequirementRecord {
  const value = structuredClone(run.modules.risk);
  if (key === "technicalRisks") value.technicalRisks = Array.from({ length: count }, (_, index) =>
    ({ risk: `PRIVATE-RESPONSE-RISK-${index}`, level: "high", impact: "PRIVATE-RESPONSE-IMPACT" }));
  else value[key] = Array.from({ length: count }, (_, index) => `PRIVATE-RESPONSE-TEXT-${index}`);
  return value;
}
function riskCalls(calls: ReturnType<typeof modelFor>["calls"]) {
  return calls.filter(call => call.method === "reasonStructured" && call.prompt.slice(0, 180).includes("技术制片人"));
}
function riskFacts(key: RiskArray, keyword: "minItems" | "maxItems", observed: number, limit: number) {
  return { kind: "schema", path: `RiskAssessor response/${key}`, keyword, observed, limit };
}

describe("actual native private RiskAssessor bounded retry feedback", () => {
  const network = vi.fn(async () => { throw new Error("Unexpected network/model request"); });
  beforeEach(() => { network.mockClear(); vi.stubGlobal("fetch", network); vi.useFakeTimers(); });
  afterEach(() => {
    expect(network).not.toHaveBeenCalled();
    vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
  });

  it("keeps the first complete Risk request, original schema, model options and one-call success unchanged", async () => {
    installNativeDiscovery();
    const run = privateRun("risk-first-success", 30, physicalScene([10, 10, 10])), model = modelFor(run, [run.modules.scene]);
    const discovery = nativeDiscovery(model.engine), risk = requirementRecord(requirementRecord(discovery.agents, "agents").risk, "risk");
    const nativeRun = risk.run, before = requirementHash(run.modules.risk);
    expect(risk.maxRetries).toBe(1); expect(risk.timeoutMs).toBe(100);
    const result = await runDiscovery(run, model.engine, discovery), calls = riskCalls(model.calls);
    expect(calls).toHaveLength(1); expect(model.calls).toHaveLength(4);
    expect(requirementHash(result.riskAssessment)).toBe(before);
    expect(calls[0]!.options).toEqual({ maxTokens: 4000, temperature: 1, timeoutMs: 100 });
    const properties = requirementRecord(requirementRecord(calls[0]!.schema, "risk schema").properties, "risk properties");
    for (const [key, maximum] of [["technicalRisks", 5], ["businessConstraints", 4], ["mitigationSuggestions", 4]] as const) {
      expect(properties[key]).toMatchObject({ type: "array", minItems: 1, maxItems: maximum });
    }
    for (const call of model.calls) { expectCompleteSources(call.prompt, run); expect(call.prompt).not.toContain(riskFeedbackHeading); }
    expect(risk.run).toBe(nativeRun); expect(risk.maxRetries).toBe(1); expect(risk.timeoutMs).toBe(100);
  });

  it.each([{ key: "technicalRisks", maximum: 5 }, { key: "businessConstraints", maximum: 4 }, { key: "mitigationSuggestions", maximum: 4 }] as const)
    ("keeps native $key 1..$maximum inclusive and feeds only numeric facts to its existing second call", async ({ key, maximum }) => {
      installNativeDiscovery();
      for (const count of [1, maximum]) {
        const run = privateRun(`risk-${key}-boundary-${count}`, 30, physicalScene([10, 10, 10])), value = riskResponse(run, key, count);
        const model = modelFor(run, [run.modules.scene], [value]), before = requirementHash(value);
        const result = await runDiscovery(run, model.engine);
        expect(requirementHash(result.riskAssessment)).toBe(before); expect(requirementHash(value)).toBe(before);
        expect(riskCalls(model.calls)).toHaveLength(1);
        for (const call of model.calls) expect(call.prompt).not.toContain(riskFeedbackHeading);
      }
      const emptyRun = privateRun(`risk-${key}-outside-0`, 30, physicalScene([10, 10, 10]));
      const empty = riskResponse(emptyRun, key, 0), valid = riskResponse(emptyRun, key, maximum);
      const hashes = [emptyRun.input, emptyRun.authority, emptyRun.approvedTheme, empty, valid].map(requirementHash);
      const emptyModel = modelFor(emptyRun, [emptyRun.modules.scene], [empty, valid]);
      const emptyResult = await runDiscovery(emptyRun, emptyModel.engine), emptyCalls = riskCalls(emptyModel.calls);
      expect(emptyCalls).toHaveLength(2); expect(emptyModel.calls).toHaveLength(5);
      expect(emptyCalls[0]!.prompt).not.toContain(riskFeedbackHeading);
      expect(promptJson(emptyCalls[1]!.prompt, riskFeedbackHeading)).toEqual(riskFacts(key, "minItems", 0, 1));
      expect(requirementHash(emptyResult.riskAssessment)).toBe(requirementHash(valid));
      expect([emptyRun.input, emptyRun.authority, emptyRun.approvedTheme, empty, valid].map(requirementHash)).toEqual(hashes);
      expect(emptyCalls[1]!.schema).toBe(emptyCalls[0]!.schema); expect(emptyCalls[1]!.options).toEqual(emptyCalls[0]!.options);
      for (const call of emptyCalls) expect(call.options).toEqual({ maxTokens: 4000, temperature: 1, timeoutMs: 100 });
      expect(JSON.stringify(emptyResult)).not.toContain(riskFeedbackHeading);

      const overflowRun = privateRun(`risk-${key}-outside-${maximum + 1}`, 30, physicalScene([10, 10, 10]));
      const overflow = riskResponse(overflowRun, key, maximum + 1);
      const overflowModel = modelFor(overflowRun, [overflowRun.modules.scene], [overflow]);
      const overflowResult = await runDiscovery(overflowRun, overflowModel.engine);
      expect(riskCalls(overflowModel.calls)).toHaveLength(1);
      expect(overflowModel.calls).toHaveLength(4);
      const compacted = requirementRecord(overflowResult.riskAssessment, "compacted risk")[key] as unknown[];
      expect(compacted).toHaveLength(maximum);
      if (key === "technicalRisks") {
        expect(compacted.at(-1)).toMatchObject({ risk: `PRIVATE-RESPONSE-RISK-${maximum - 1}` });
      } else {
        expect(String(compacted.at(-1))).toContain(`PRIVATE-RESPONSE-TEXT-${maximum}`);
      }
      for (const call of overflowModel.calls) {
        expectCompleteSources(call.prompt, overflowRun);
        expect(call.prompt).not.toContain(riskFeedbackHeading);
      }
    });

  it("reports the second invalid Risk array through both native fallback catches without preserving the first error", async () => {
    installNativeDiscovery();
    const run = privateRun("risk-two-invalid", 30, physicalScene([10, 10, 10]));
    const first = riskResponse(run, "mitigationSuggestions", 0), second = riskResponse(run, "businessConstraints", 0);
    const model = modelFor(run, [run.modules.scene], [first, second]), failure = await runDiscovery(run, model.engine).catch(error => error);
    expect(failure).toMatchObject({ code: "REQUIREMENT_DISCOVERY_UNVERIFIED", details: riskFacts("businessConstraints", "minItems", 0, 1) });
    expect(Object.isFrozen(requirementRecord(failure, "risk failure").details)).toBe(true);
    expect(failureText(failure)).not.toContain("mitigationSuggestions"); expect(failureText(failure)).not.toContain("PRIVATE-RESPONSE");
    const calls = riskCalls(model.calls);
    expect(calls).toHaveLength(2); expect(model.calls).toHaveLength(4); // Audience, Scene, Risk twice; no Reference.
    expect(promptJson(calls[1]!.prompt, riskFeedbackHeading)).toEqual(riskFacts("mitigationSuggestions", "minItems", 0, 1));
  });

  it("replaces an earlier Risk schema failure with the actual current transport rejection", async () => {
    installNativeDiscovery();
    const run = privateRun("risk-current-transport", 30, physicalScene([10, 10, 10])), current = new Error("synthetic current risk transport failure");
    const model = modelFor(run, [run.modules.scene], [riskResponse(run, "mitigationSuggestions", 0), current]);
    const failure = await runDiscovery(run, model.engine).catch(error => error), calls = riskCalls(model.calls);
    expect(failure).toBe(current); expect(requirementRecord(failure, "current failure").details).toBeUndefined();
    expect(failureText(failure)).not.toContain("mitigationSuggestions"); expect(calls).toHaveLength(2);
    expect(promptJson(calls[1]!.prompt, riskFeedbackHeading)).toEqual(riskFacts("mitigationSuggestions", "minItems", 0, 1));
    expect(model.calls).toHaveLength(4);
  });

  it("preserves a current failure from the real native JSON parser instead of an earlier Risk array error", async () => {
    installNativeDiscovery();
    const run = privateRun("risk-current-native-parser", 30, physicalScene([10, 10, 10]));
    const calls: Array<{ prompt: string; options: unknown }> = []; let attempt = 0;
    const engine: RequirementRecord = { generate: vi.fn(async (prompt: string, options: unknown) => {
      calls.push({ prompt, options });
      const intro = prompt.slice(0, 180), risk = intro.includes("技术制片人");
      if (risk && attempt++ === 1) return { content: "{invalid native Risk JSON}" };
      const value = risk ? riskResponse(run, "mitigationSuggestions", 0) : intro.includes("受众分析") ? run.modules.audience
        : intro.includes("电影导演") ? run.modules.scene : run.modules.reference;
      return { content: JSON.stringify(value) };
    }) };
    const failure = await runDiscovery(run, engine).catch(error => error), riskRequests = calls.filter(call => call.prompt.slice(0, 180).includes("技术制片人"));
    expect(failure).toBeInstanceOf(Error); expect(failureText(failure)).toContain("JSON 解析失败");
    expect(failureText(failure)).not.toContain("mitigationSuggestions");
    expect(requirementRecord(failure, "native parser failure").details).toBeUndefined();
    expect(riskRequests).toHaveLength(2); expect(calls).toHaveLength(4);
    expect(promptJson(riskRequests[1]!.prompt, riskFeedbackHeading)).toEqual(riskFacts("mitigationSuggestions", "minItems", 0, 1));
    for (const call of calls) { expectCompleteSources(call.prompt, run); expect(call.options).toEqual({ maxTokens: 4000, temperature: 1 }); }
  });

  it.each(["transport", "forged-details"])("does not retry a first %s failure or treat it as verified Risk feedback", async kind => {
    installNativeDiscovery();
    const run = privateRun(`risk-first-${kind}`, 30, physicalScene([10, 10, 10]));
    const failure = kind === "transport" ? new Error("synthetic first transport")
      : Object.assign(new RequirementContractError("REQUIREMENT_DISCOVERY_UNVERIFIED", "PRIVATE-UNTRUSTED-MESSAGE"),
        { details: riskFacts("mitigationSuggestions", "maxItems", 99, 4) });
    const model = modelFor(run, [run.modules.scene], [failure, run.modules.risk]);
    await expect(runDiscovery(run, model.engine)).rejects.toBe(failure);
    expect(riskCalls(model.calls)).toHaveLength(1);
    for (const call of model.calls) { expect(call.prompt).not.toContain(riskFeedbackHeading); expect(call.prompt).not.toContain("PRIVATE-UNTRUSTED"); }
  });

  it.each(["authority", "input", "engine"])("keeps %s mutation sticky when the first Risk response would otherwise allow a native retry", async kind => {
    installNativeDiscovery();
    const run = privateRun(`risk-sticky-${kind}`, 30, physicalScene([10, 10, 10]));
    const model = modelFor(run, [run.modules.scene], [riskResponse(run, "mitigationSuggestions", 5), run.modules.risk]);
    const original = model.engine.reasonStructured as NativeMethod;
    model.engine.reasonStructured = async function (this: RequirementRecord, ...args: unknown[]) {
      const result = await Reflect.apply(original, this, args);
      if (String(args[0]).slice(0, 180).includes("技术制片人")) {
        if (kind === "authority") requirementRecord(run.authority.metadata.brief, "brief").description = "changed authority";
        if (kind === "input") run.input.description = "changed discovery input";
        if (kind === "engine") model.engine.reasonStructured = async () => { throw new Error("replacement must not run"); };
      }
      return result;
    };
    const failure = await runDiscovery(run, model.engine).catch(error => error);
    expect(failure).toMatchObject({ code: kind === "authority" ? "REQUIREMENT_AUTHORITY_CHANGED"
      : kind === "input" ? "REQUIREMENT_DISCOVERY_CHANGED" : "REQUIREMENT_ENGINE_CHANGED" });
    expect(riskCalls(model.calls)).toHaveLength(1); expect(model.calls).toHaveLength(3);
    expect(failureText(failure)).not.toContain("mitigationSuggestions");
  });

  it("stops the pending Risk call after its private scope closes and cannot dispatch a retry or Reference", async () => {
    installNativeDiscovery();
    const run = privateRun("risk-closed-scope", 30, physicalScene([10, 10, 10])), model = modelFor(run, [run.modules.scene]);
    let release!: (value: { success: boolean; data: RequirementRecord }) => void, started!: () => void;
    const pending = new Promise<{ success: boolean; data: RequirementRecord }>(resolve => { release = resolve; });
    const firstRisk = new Promise<void>(resolve => { started = resolve; }), original = model.engine.reasonStructured as NativeMethod;
    model.engine.reasonStructured = async function (this: RequirementRecord, ...args: unknown[]) {
      if (String(args[0]).slice(0, 180).includes("技术制片人")) {
        model.calls.push({ method: "reasonStructured", prompt: String(args[0]), schema: args[1], options: args[2] });
        started(); return pending;
      }
      return Reflect.apply(original, this, args);
    };
    const discovery = nativeDiscovery(model.engine); let detached!: Promise<RequirementRecord>;
    await withRequirementContractScope(run.metadata, async () => {
      detached = Reflect.apply(discovery.discover as NativeMethod, discovery, [run.input]) as Promise<RequirementRecord>;
      await firstRisk;
    }, run.options);
    release({ success: true, data: riskResponse(run, "mitigationSuggestions", 5) });
    await expect(detached).rejects.toMatchObject({ code: "REQUIREMENT_SCOPE_CLOSED" });
    expect(riskCalls(model.calls)).toHaveLength(1); expect(model.calls).toHaveLength(3);
  });

  it("isolates Risk feedback across overlapping runs sharing the same engine and native agents, then clears it for the next run", async () => {
    installNativeDiscovery();
    const runs = ["risk-overlap-A", "risk-overlap-B", "risk-overlap-next"].map(marker => privateRun(marker, 30, physicalScene([10, 10, 10])));
    const [a, b, c] = runs as [ReturnType<typeof privateRun>, ReturnType<typeof privateRun>, ReturnType<typeof privateRun>];
    const hashes = runs.map(run => [run.input, run.authority, run.approvedTheme].map(requirementHash));
    const calls: ReturnType<typeof modelFor>["calls"] = [], attempts = new Map<ReturnType<typeof privateRun>, number>();
    const select = (prompt: string) => { const run = runs.find(value => prompt.includes(value.story)); if (!run) throw new Error("Complete current story lost"); return run; };
    let releaseFirst!: () => void, first = 0;
    const bothFirst = new Promise<void>(resolve => { releaseFirst = resolve; });
    const engine: RequirementRecord = { _extractJsonObject: (content: string) => content };
    engine.reason = vi.fn(async function (this: RequirementRecord, prompt: string, options: unknown) {
      expect(this).toBe(engine); calls.push({ method: "reason", prompt, options });
      return { success: true, content: JSON.stringify(select(prompt).modules.scene) };
    });
    engine.reasonStructured = vi.fn(async function (this: RequirementRecord, prompt: string, schema: unknown, options: unknown) {
      expect(this).toBe(engine); calls.push({ method: "reasonStructured", prompt, schema, options });
      const run = select(prompt), intro = prompt.slice(0, 180);
      if (!intro.includes("技术制片人")) return { success: true, data: structuredClone(intro.includes("受众分析") ? run.modules.audience : run.modules.reference) };
      const attempt = attempts.get(run) ?? 0; attempts.set(run, attempt + 1);
      if (run !== c && attempt === 0) {
        if (++first === 2) releaseFirst(); await bothFirst;
        return { success: true, data: riskResponse(run, run === a ? "mitigationSuggestions" : "businessConstraints", 0) };
      }
      return { success: true, data: structuredClone(run.modules.risk) };
    });
    const discoveryA = nativeDiscovery(engine), discoveryB = nativeDiscovery(engine), discoveryC = nativeDiscovery(engine);
    discoveryB.agents = discoveryA.agents; discoveryC.agents = discoveryA.agents;
    const sharedRisk = requirementRecord(discoveryA.agents, "shared agents").risk;
    const results = await Promise.all([runDiscovery(a, engine, discoveryA), runDiscovery(b, engine, discoveryB)]);
    expect(calls).toHaveLength(10); results.push(await runDiscovery(c, engine, discoveryC)); expect(calls).toHaveLength(14);
    const risk = riskCalls(calls), callsFor = (run: ReturnType<typeof privateRun>) => risk.filter(call => select(call.prompt) === run);
    const aCalls = callsFor(a), bCalls = callsFor(b), cCalls = callsFor(c);
    expect(aCalls).toHaveLength(2); expect(bCalls).toHaveLength(2); expect(cCalls).toHaveLength(1);
    for (const call of [aCalls[0]!, bCalls[0]!, cCalls[0]!]) expect(call.prompt).not.toContain(riskFeedbackHeading);
    expect(promptJson(aCalls[1]!.prompt, riskFeedbackHeading)).toEqual(riskFacts("mitigationSuggestions", "minItems", 0, 1));
    expect(promptJson(bCalls[1]!.prompt, riskFeedbackHeading)).toEqual(riskFacts("businessConstraints", "minItems", 0, 1));
    for (const call of calls) {
      const run = select(call.prompt); expectCompleteSources(call.prompt, run); expect(call.prompt).not.toContain("PRIVATE-RESPONSE");
      for (const other of runs.filter(value => value !== run)) {
        expect(call.prompt).not.toContain(other.story); expect(call.prompt).not.toContain(other.authority.marketing.g1Artifact.content);
        expect(call.prompt).not.toContain(other.approvedTheme.contentMd);
      }
      if (!risk.includes(call)) expect(call.prompt).not.toContain(riskFeedbackHeading);
    }
    runs.forEach((run, index) => {
      expect(requirementHash(results[index]!.riskAssessment)).toBe(requirementHash(run.modules.risk));
      expect([run.input, run.authority, run.approvedTheme].map(requirementHash)).toEqual(hashes[index]);
    });
    for (const discovery of [discoveryA, discoveryB, discoveryC]) expect(requirementRecord(discovery.agents, "native agents").risk).toBe(sharedRisk);
  });

  it.each(["legacy-scope", "unscoped"])("preserves the native %s Risk behavior without private authority", async mode => {
    installNativeDiscovery();
    const run = privateRun(`risk-${mode}`, 30, physicalScene([10, 10, 10])), value = riskResponse(run, "mitigationSuggestions", 5);
    const model = modelFor(run, [run.modules.scene], [value]), discovery = nativeDiscovery(model.engine);
    const operation = () => Reflect.apply(discovery.discover as NativeMethod, discovery, [run.input]) as Promise<RequirementRecord>;
    const result = await (mode === "legacy-scope" ? withRequirementContractScope(run.metadata, operation) : operation());
    expect(requirementHash(result.riskAssessment)).toBe(requirementHash(value)); expect(riskCalls(model.calls)).toHaveLength(1);
    for (const call of model.calls) { expect(call.prompt).not.toContain(riskFeedbackHeading); expect(call.prompt).not.toContain("本次宿主需求权威输入"); }
  });
});

describe("frozen SceneArchitect real loopback provider wire", () => {
  beforeEach(() => resetCircuit("preproduction"));
  afterEach(() => resetCircuit("preproduction"));

  it.each(["verified separator", "wrong duration", "missing native echo", "cloned G3 source"] as const)(
    "admits local comma recovery only with the native Responses proof and full frozen checks: %s",
    async outcome => {
      const vendor = installNativeDiscovery();
      vi.stubEnv("WORKLOOM_VIDEO_SCENE_RESPONSE_FORMAT", "json_schema");
      try {
        const scene = physicalScene([10, 10, 10]);
        const run = withFrozenSegmentBrief(privateRun(`native-comma-${outcome}`, 30, scene));
        const first = outcome === "wrong duration" ? physicalScene([10, 10, 11]) : scene;
        const full = `\t${JSON.stringify(first)}\r\n`;
        const offset = full.indexOf(',"scenes":');
        expect(offset).toBeGreaterThan(0);
        const malformed = full.slice(0, offset) + full.slice(offset + 1);
        const scenePrompts: string[] = [], laterPrompts: string[] = [];
        const digest = (text: string) => createHash("sha256").update(text).digest("hex");
        let firstWire: Record<string, string> | undefined;
        const engine = new WorkloomLLMEngine({
          baseUrl: "http://127.0.0.1:1", apiKey: "synthetic-local-key", model: "deepseek-flash", scene: "preproduction",
          fetchImpl: async (url, init) => {
            const wire = String(init?.body);
            const body = JSON.parse(wire);
            if (new URL(String(url)).pathname === "/responses") {
              scenePrompts.push(body.input);
              expect(body).toMatchObject({ model: "deepseek-flash", max_output_tokens: 393_216,
                text: { format: { type: "json_schema", name: "workloom_scene_architect" } } });
              const text = scenePrompts.length === 1 ? malformed : JSON.stringify(scene);
              const response = JSON.stringify({ id: `synthetic-native-scene-${scenePrompts.length}`, object: "response",
                status: "completed", model: "deepseek-flash",
                ...(outcome === "missing native echo" && scenePrompts.length === 1 ? {} : {
                  text: { format: { type: "json_schema", name: "workloom_scene_architect" } },
                }),
                output: [{ type: "message", role: "assistant", status: "completed",
                  content: [{ type: "output_text", text }] }],
                usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
              });
              firstWire ??= { requestSha256: digest(wire), responseSha256: digest(response),
                schemaSha256: digest(JSON.stringify(body.text.format.schema)) };
              return new Response(response, { headers: { "Content-Type": "application/json" } });
            }
            expect(new URL(String(url)).pathname).toBe("/chat/completions");
            const prompt: string = body.messages[1].content;
            const module = prompt.slice(0, 180).includes("受众分析") ? "audience"
              : prompt.slice(0, 180).includes("技术制片人") ? "risk" : "reference";
            if (module !== "audience") laterPrompts.push(prompt);
            return Response.json({ id: `synthetic-${module}`, model: "deepseek-flash",
              choices: [{ finish_reason: "stop", message: { content: JSON.stringify(run.modules[module]) } }],
              usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
            });
          },
        });
        const discovery = new RequirementDiscoveryEngine({
          llmEngine: engine as unknown as RequirementRecord, timeoutMs: 20_000, agentTimeoutMs: 4_000,
        });
        const heading = "## 原生场景单分隔符校正证据";
        const expectsRecovery = outcome === "verified separator" || outcome === "cloned G3 source";
        const result = withRequirementContractScope(run.metadata, async () => {
          const discovered = await Reflect.apply(discovery.discover as NativeMethod, discovery, [run.input]) as RequirementRecord;
          expect(discovered.sceneStructure).toEqual(scene);
          const metadata = structuredClone(run.metadata);
          const list = await Reflect.apply(vendor._convertDiscoveryToRequirementList as NativeMethod,
            vendor, [discovered, run.input, metadata]);
          const render = (source: RequirementRecord) => Reflect.apply(vendor._renderRequirementContract as NativeMethod,
            vendor, [run.story, metadata, list, source]) as string;
          const report = render(discovered);
          if (expectsRecovery) {
            const parts = report.split(`\n${heading}\n`);
            expect(parts).toHaveLength(2);
            expect(firstWire).toBeDefined();
            expect(JSON.parse(parts[1]!.split("\n")[0]!)).toEqual({
              schemaVersion: "workloom.scene-json-single-comma/v1", ...firstWire,
              originalSha256: digest(malformed), repairedSha256: digest(full),
              insertionByteOffset: Buffer.byteLength(malformed.slice(0, offset)), sceneHash: requirementHash(scene),
            });
          } else expect(report).not.toContain(heading);
          if (outcome === "cloned G3 source") render(structuredClone(discovered));
          return discovered;
        }, run.options);
        if (outcome === "cloned G3 source") await expect(result).rejects.toThrow("G3 未绑定本次语法校正场景");
        else await expect(result).resolves.toMatchObject({ sceneStructure: scene });
        expect(laterPrompts).toHaveLength(2);
        if (expectsRecovery) {
          expect(scenePrompts).toHaveLength(1);
          for (const prompt of laterPrompts) {
            expect(prompt).toContain(full);
            expect(prompt).toContain("单分隔符校正后通过严格结构校验");
            expect(prompt).toContain(digest(malformed));
            expect(prompt).toContain(digest(full));
            expect(prompt).not.toContain(malformed);
          }
        } else {
          expect(scenePrompts).toHaveLength(2);
          expect(scenePrompts[1]).toContain("上一次原生场景 JSON 语法纠正");
          for (const prompt of laterPrompts) expect(prompt).not.toContain("单分隔符校正后");
        }
        for (const prompt of scenePrompts) expectCompleteSources(prompt, run);
      } finally { vi.unstubAllEnvs(); }
    },
  );

  it.each(["multi-separator", "third valid", "second unbound", "duplicate second", "third malformed", "third wrong duration"] as const)(
    "binds exact native multi-separator or final format regeneration without accepting malformed drafts: %s", async kind => {
      const vendor = installNativeDiscovery();
      vi.stubEnv("WORKLOOM_VIDEO_SCENE_RESPONSE_FORMAT", "json_schema");
      try {
        const scene = physicalScene([10, 10, 10]);
        const run = withFrozenSegmentBrief(privateRun(`native-bounded-scene-${kind}`, 30, scene));
        const full = `\t${JSON.stringify(scene)}\r\n`;
        const multi = full.replace(',"scenes":', '"scenes":').replace(',"ending":', '"ending":');
        expect(multi).not.toBe(full);
        const invalid1 = '{"PRIVATE_INVALID_ONE" 1}', invalid2 = '{"PRIVATE_INVALID_TWO" 2}';
        const records: Array<{ requestSha256: string; responseSha256: string; schemaSha256: string; rawSha256: string; prompt: string }> = [];
        const downstream: string[] = [];
        const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
        const providerConfig = {
          baseUrl: "http://127.0.0.1:1", apiKey: "synthetic-local-key",
          fetchImpl: async (url, init) => {
            const wire = String(init?.body), body = JSON.parse(wire);
            if (new URL(String(url)).pathname === "/responses") {
              const ordinal = records.length + 1;
              const text = kind === "multi-separator" ? multi : ordinal === 1 ? invalid1 : ordinal === 2 ? invalid2
                : kind === "third malformed" ? '{"MALFORMED_FINAL" false}'
                : kind === "third wrong duration" ? JSON.stringify(physicalScene([10, 10, 11])) : full;
              const response = JSON.stringify({
                id: `synthetic-native-bounded-${kind === "duplicate second" && ordinal === 2 ? 1 : ordinal}`,
                object: "response", status: "completed", model: "deepseek-flash",
                ...(kind === "second unbound" && ordinal === 2 ? {} : {
                  text: { format: { type: "json_schema", name: "workloom_scene_architect" } },
                }),
                output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }],
                usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
              });
              expect(body).toMatchObject({ model: "deepseek-flash", max_output_tokens: 393_216,
                text: { format: { type: "json_schema", name: "workloom_scene_architect" } } });
              records.push({ requestSha256: digest(wire), responseSha256: digest(response),
                schemaSha256: digest(JSON.stringify(body.text.format.schema)), rawSha256: digest(text), prompt: body.input });
              return new Response(response, { headers: { "Content-Type": "application/json" } });
            }
            expect(new URL(String(url)).pathname).toBe("/chat/completions");
            const prompt: string = body.messages[1].content;
            const role = prompt.slice(0, 180).includes("受众分析") ? "audience"
              : prompt.slice(0, 180).includes("技术制片人") ? "risk" : "reference";
            if (role !== "audience") downstream.push(prompt);
            return Response.json({ id: `synthetic-native-bounded-${role}`, model: "deepseek-flash",
              choices: [{ finish_reason: "stop", message: { content: JSON.stringify(run.modules[role]) } }],
              usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } });
          },
        } satisfies ConstructorParameters<typeof OpenAiCompatibleProvider>[1];
        const provider = new OpenAiCompatibleProvider("deepseek-flash", providerConfig);
        const engine = new WorkloomLLMEngine({
          ...providerConfig, model: "deepseek-flash", router: {
            scene: "preproduction", forceModel: "deepseek-flash", providers: new Map([[provider.modelId, provider]]),
            sink: { recordModelTrace: async () => undefined, recordDegradation: async () => undefined, recordCircuitBreak: async () => undefined },
          },
        });
        const discovery = new RequirementDiscoveryEngine({
          llmEngine: engine as unknown as RequirementRecord, timeoutMs: 20_000, agentTimeoutMs: 4_000,
        });
        const accepted = kind === "multi-separator" || kind === "third valid";
        const operation = withRequirementContractScope(run.metadata, async () => {
          const result = await Reflect.apply(discovery.discover as NativeMethod, discovery, [run.input]) as RequirementRecord;
          const metadata = structuredClone(run.metadata);
          const list = await Reflect.apply(vendor._convertDiscoveryToRequirementList as NativeMethod,
            vendor, [result, run.input, metadata]);
          const report = Reflect.apply(vendor._renderRequirementContract as NativeMethod,
            vendor, [run.story, metadata, list, result]) as string;
          const multiMode = kind === "multi-separator";
          const heading = multiMode ? "原生场景多分隔符校正证据" : "原生场景格式重生成证据";
          const proof = promptJson(report, `## ${heading}`);
          const wire = records.at(-1)!;
          expect(proof).toMatchObject({ requestSha256: wire.requestSha256, responseSha256: wire.responseSha256,
            schemaSha256: wire.schemaSha256, sceneHash: requirementHash(scene) });
          if (multiMode) {
            expect(proof).toMatchObject({ schemaVersion: "workloom.scene-json-bounded-commas/v2",
              originalSha256: digest(multi), repairedSha256: digest(full) });
            const offsets = proof.insertionByteOffsets as number[];
            expect(offsets).toHaveLength(2);
            const rebuilt = Buffer.from(full, "utf8").filter((_, index) => !offsets.some((offset, i) => offset + i === index));
            expect(Buffer.from(rebuilt).toString("utf8")).toBe(multi);
          } else {
            expect(proof).toMatchObject({ schemaVersion: "workloom.scene-json-format-reissue/v1", acceptedRawSha256: digest(full),
              previousSyntaxFailures: records.slice(0, 2).map(({ requestSha256, responseSha256, rawSha256 }) =>
                ({ requestSha256, responseSha256, rawSha256 })) });
          }
          return result;
        }, run.options);
        if (accepted) {
          await expect(operation).resolves.toMatchObject({ sceneStructure: scene });
          expect(downstream).toHaveLength(2);
          for (const prompt of downstream) expect(prompt).toContain(full);
        } else {
          await expect(operation).rejects.toMatchObject({ code: "REQUIREMENT_SCENE_UNVERIFIED" });
          expect(downstream).toHaveLength(0);
        }
        const count = kind === "multi-separator" ? 1 : kind === "second unbound" || kind === "duplicate second" ? 2 : 3;
        expect(records).toHaveLength(count);
        expect(new Set(records.map(row => row.schemaSha256)).size).toBe(1);
        for (const { prompt } of records) {
          expectCompleteSources(prompt, run);
          expect(prompt).not.toMatch(/PRIVATE_INVALID_ONE|PRIVATE_INVALID_TWO/);
        }
        if (count === 3) expect(records[2]!.prompt).toContain("两次原生语法失败后的末次格式重生成");
      } finally { vi.unstubAllEnvs(); }
    },
  );

  it.each([
    ["malformed", 2, true], ["twice-malformed", 2, false], ["unattested-malformed", 1, false], ["fenced", 2, true], ["blank", 1, false],
    ["length", 1, false], ["unknown", 1, false], ["wrong-shape", 2, false],
    ["placeholder", 2, false], ["over-legacy-extraction-limit", 1, true],
  ] as const)("keeps %s content inside the pinned completion and schema rules", async (outcome, expectedCalls, accepted) => {
    installNativeDiscovery();
    const scene = physicalScene([10, 10, 10]);
    if (outcome === "over-legacy-extraction-limit") {
      requirementRecord(scene.opening, "opening").purpose = "完整有效内容".repeat(35_000);
    }
    const run = withFrozenSegmentBrief(privateRun(`scene-loopback-${outcome}`, 30, scene));
    const sceneCalls: Array<{ body: RequirementRecord; prompt: string }> = [];
    const providerServer = createServer(async (req, res) => {
      try {
        expect(req.method).toBe("POST");
        expect(req.url).toBe("/chat/completions");
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const prompt: string = body.messages[1].content;
        const selected = prompt.startsWith("你是一位电影导演") ? "scene"
          : prompt.slice(0, 180).includes("受众分析") ? "audience"
          : prompt.slice(0, 180).includes("技术制片人") ? "risk" : "reference";
        let content = JSON.stringify(run.modules[selected]), finishReason = "stop", id: string | undefined = "local-loopback-completion";
        if (selected === "scene") {
          sceneCalls.push({ body, prompt });
          if (outcome === "wrong-shape") content = '{"opening":{}}';
          if (outcome === "twice-malformed") content = '{"REJECTED_NATIVE_RESPONSE": [1 2]}';
          if (outcome === "placeholder") {
            const exampleText = prompt.split(`\n${sceneExampleHeading}\n`)[1]?.split("\n")[0];
            // Copy a real schema-shaped response and exactly one example placeholder.
            const example = exampleText ? JSON.parse(exampleText) : { opening: { purpose: "旧代码中没有拒绝标记的结构示例" } };
            const copied = structuredClone(scene);
            requirementRecord(copied.opening, "opening").purpose = example.opening.purpose;
            content = JSON.stringify(copied);
          }
          if (sceneCalls.length === 1) {
            if (outcome === "unknown") { res.writeHead(502).end('{"error":"synthetic unknown outcome"}'); return; }
            if (outcome === "length") finishReason = "length";
            if (outcome === "blank") content = "   ";
            if (outcome === "malformed" || outcome === "unattested-malformed") content = '{"REJECTED_NATIVE_RESPONSE": [1 2]}';
            if (outcome === "unattested-malformed") id = undefined;
            if (outcome === "fenced") content = `\`\`\`json\n${content}\n\`\`\``;
          }
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id, model: "deepseek-flash",
          choices: [{ finish_reason: finishReason, message: { content } }],
          usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } }));
      } catch (error) {
        res.writeHead(500).end(String(error));
      }
    });
    await new Promise<void>((resolve, reject) => {
      providerServer.once("error", reject);
      providerServer.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = providerServer.address();
      if (!address || typeof address === "string") throw new Error("Loopback provider address missing");
      const baseUrl = `http://127.0.0.1:${address.port}`, apiKey = "synthetic-loopback-key";
      const { policy, issues } = loadModelPolicy(resolve(dirname(fileURLToPath(import.meta.url)), "../../../bundles/ai-video"));
      expect(issues).toEqual([]);
      expect(policy).not.toBeNull();
      const engine = new WorkloomLLMEngine({ baseUrl, apiKey, model: "deepseek-flash", router: {
        scene: "preproduction", forceModel: "deepseek-flash", policy: policy ?? undefined,
        providers: new Map([["deepseek-flash", new OpenAiCompatibleProvider("deepseek-flash", { baseUrl, apiKey })]]),
        sink: { recordModelTrace: async () => undefined, recordDegradation: async () => undefined, recordCircuitBreak: async () => undefined },
      } });
      const engineObject = engine as unknown as RequirementRecord;
      const discovery = new RequirementDiscoveryEngine({ llmEngine: engineObject, timeoutMs: 20_000, agentTimeoutMs: 4_000 });
      requirementRecord(requirementRecord(discovery.agents, "native agents").scene, "scene").maxRetries = 3;
      const result = runDiscovery(run, engineObject, discovery);
      if (accepted) await expect(result).resolves.toMatchObject({ sceneStructure: scene });
      else await expect(result).rejects.toThrow("REQUIREMENT_SCENE_UNVERIFIED");
      expect(sceneCalls).toHaveLength(expectedCalls);
      for (const { body, prompt } of sceneCalls) {
        expect(body).toMatchObject({ model: "deepseek-flash", max_tokens: 393_216,
          response_format: { type: "json_object" }, thinking: { type: "enabled" }, reasoning_effort: "high" });
        expectCompleteSources(prompt, run);
        expect({ ...body, messages: undefined }).toEqual({ ...sceneCalls[0]!.body, messages: undefined });
        expect(prompt).not.toContain("REJECTED_NATIVE_RESPONSE");
        expect(promptJson(prompt, sceneExampleHeading)).toMatchObject({
          opening: { duration: 10 }, scenes: [{ index: 1, duration: 10 }], ending: { duration: 10 }, sceneCount: 3, totalDuration: 30,
        });
      }
      if (outcome === "malformed" || outcome === "twice-malformed" || outcome === "fenced") {
        expect(sceneCalls[1]!.prompt).toContain("上一次原生场景 JSON 语法纠正");
      }
      if (outcome === "wrong-shape" || outcome === "placeholder") expect(sceneCalls[1]!.prompt).toContain(feedbackHeading);
    } finally {
      providerServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => providerServer.close(error => error ? reject(error) : resolve()));
    }
  });
});

describe("actual native non-scene discovery wire recovery", () => {
  beforeEach(() => resetCircuit("video.preproduction.plan"));
  afterEach(() => resetCircuit("video.preproduction.plan"));

  it.each([
    { module: "audience", first: "syntax", second: "valid", feedback: " JSON 语法纠正" },
    { module: "audience", first: "schema", second: "valid", feedback: "结构校验反馈" },
    { module: "reference", first: "schema", second: "valid", feedback: "结构校验反馈" },
    { module: "risk", first: "syntax", second: "valid", feedback: " JSON 语法纠正" },
    { module: "audience", first: "transport", second: "valid", feedback: undefined },
    { module: "risk", first: "transport", second: "valid", feedback: undefined },
    { module: "audience", first: "schema", second: "transport", feedback: "结构校验反馈" },
    { module: "audience", first: "syntax", second: "schema", feedback: " JSON 语法纠正" },
  ] as const)("handles $module $first / $second through the real vendor and host adapter", async ({ module, first, second, feedback }) => {
    installNativeDiscovery();
    const run = privateRun(`discovery-wire-${module}-${first}-${second}`, 30, physicalScene([10, 10, 10]));
    const scopeCalls: Array<{ raw: string; body: RequirementRecord; prompt: string }> = [];
    const admitted = new Set<string>();
    const malformed = '{"SYNTHETIC_REJECTED_BODY": [1 2]}';
    const engine = new WorkloomLLMEngine({
      baseUrl: "http://127.0.0.1:1", apiKey: "synthetic-local-bearer", model: "deepseek-flash",
      fetchImpl: async (_url, init) => {
        const raw = String(init?.body), body = JSON.parse(raw), prompt: string = body.messages[1].content;
        const intro = prompt.slice(0, 180);
        const selected = intro.includes("受众分析") ? "audience" : intro.includes("技术制片人") ? "risk"
          : intro.includes("电影导演") ? "scene" : "reference";
        let content = JSON.stringify(run.modules[selected]);
        if (selected === module) {
          scopeCalls.push({ raw, body, prompt });
          if (admitted.has(raw)) return Response.json({ error: { code: "BUDGET_DUPLICATE_REQUEST" } }, { status: 409 });
          admitted.add(raw);
          const outcome = admitted.size === 1 ? first : second;
          if (outcome === "transport") return Response.json({ error: { code: "BUDGET_OUTCOME_UNKNOWN" } }, { status: 502 });
          if (outcome === "syntax") content = malformed;
          if (outcome === "schema") content = JSON.stringify({ SYNTHETIC_REJECTED_BODY: "PRIVATE-UNDECLARED-RESPONSE-VALUE" });
        }
        return Response.json({ model: "deepseek-flash", choices: [{ finish_reason: "stop", message: { content } }],
          usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } });
      },
    });
    const engineObject = engine as unknown as RequirementRecord;
    const discovery = new RequirementDiscoveryEngine({ llmEngine: engineObject, timeoutMs: 15_000, agentTimeoutMs: 2_000 });
    requirementRecord(requirementRecord(discovery.agents, "agents")[module], module).maxRetries = 3;
    const result = runDiscovery(run, engineObject, discovery);
    if (first !== "transport" && second === "valid") {
      const resultKey = { audience: "audienceProfile", risk: "riskAssessment", reference: "referenceCases" }[module];
      await expect(result).resolves.toMatchObject({ [resultKey]: run.modules[module] });
    } else {
      const failure = await result.catch(error => error);
      expect(failure).toMatchObject({ code: "REQUIREMENT_DISCOVERY_UNVERIFIED" });
      expect(failureText(failure)).not.toContain("SYNTHETIC_REJECTED_BODY");
      if (first === "transport" || second === "transport") expect(failureText(failure)).toContain("未收到可验证");
      if (second === "schema") expect(failureText(failure)).toContain("缺少必需字段");
    }
    expect(scopeCalls).toHaveLength(feedback ? 2 : 1);
    expect(admitted.size).toBe(scopeCalls.length);
    const heading = "\n【硬性输出要求】";
    for (const { body, prompt } of scopeCalls) {
      expect(body).toMatchObject({ model: "deepseek-flash", max_tokens: 393_216, response_format: { type: "json_object" } });
      expect({ ...body, messages: undefined }).toEqual({ ...scopeCalls[0]!.body, messages: undefined });
      expect(prompt.split(heading)[1]).toEqual(scopeCalls[0]!.prompt.split(heading)[1]);
      expectCompleteSources(prompt.split(heading)[0]!.slice(0, -1), run);
      expect(prompt).not.toContain("SYNTHETIC_REJECTED_BODY");
      expect(prompt).not.toContain("PRIVATE-UNDECLARED-RESPONSE-VALUE");
    }
    expect(scopeCalls[0]!.prompt).not.toContain("上一次原生需求");
    if (feedback) {
      expect(scopeCalls[1]!.prompt).toContain(`上一次原生需求${feedback}`);
      if (first === "schema") expect(scopeCalls[1]!.prompt).toContain(module === "audience" ? "/primaryAudience" : "/filmReferences");
    }
  });
});
