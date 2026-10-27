import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { compileFunction } from "node:vm";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureRequirementTheme, qualifyRequirementThemeInput, requirementAuthorityPrompt, scopedRequirementEngine,
  type RequirementApprovedTheme, type RequirementAuthorityOptions
} from "./requirement-authority.js";
import { installRequirementContractBridge, withRequirementContractScope } from "./requirement-contract-bridge.js";
import { requirementHash, requirementRecord, type RequirementRecord } from "./requirement-contract.js";
import { preparePrdAuthority } from "./prd-authority.js";
import { prdFixture } from "./prd-authority.test-support.js";
import { WorkloomLLMEngine } from "./llm-adapter.js";

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const vendor = path.join(repo, "vendor/supermickey/hyperreality-system");
type Constructor = { new(options?: RequirementRecord): RequirementRecord; prototype: RequirementRecord };
const { RequirementDiscoveryEngine } = require(path.join(vendor, "engines/requirement-discovery-engine.js")) as {
  RequirementDiscoveryEngine: Constructor;
};
const { DynamicTypeResolver } = require(path.join(vendor, "skills/creative-theme-generator/dynamic-type-resolver.js")) as {
  DynamicTypeResolver: Constructor;
};
const themeSource = readFileSync(path.join(vendor, "skills/creative-theme-generator/index.js"), "utf8");
const themeModule = { exports: {} as { CreativeThemeGenerator?: Constructor } };
// Execute the exact pinned generator body. Its two constructor dependencies are
// inert: no EventBus writes and no mkdir/read of the vendor's application cache.
compileFunction(themeSource, ["exports", "require", "module", "__filename", "__dirname"])(
  themeModule.exports, (specifier: string) => {
    if (specifier === "../../infrastructure/event-bus") return { EventBus: class { emit() {} } };
    if (specifier === "./dynamic-type-resolver") return { DynamicTypeResolver: class extends DynamicTypeResolver {
      constructor(options: RequirementRecord) { super({ ...options, cacheEnabled: false }); }
    } };
    throw new Error(`Unexpected pinned theme dependency: ${specifier}`);
  }, themeModule, path.join(vendor, "skills/creative-theme-generator/index.js"), path.join(vendor, "skills/creative-theme-generator")
);
const CreativeThemeGenerator = themeModule.exports.CreativeThemeGenerator!;
const indexSource = readFileSync(path.join(vendor, "index.js"), "utf8");
const buildAnchor = "\n  _buildThemeInput(intent, metadata = {}) {";
const buildStart = indexSource.indexOf(buildAnchor), buildEnd = indexSource.indexOf("\n  /**", buildStart);
if (buildStart < 0 || buildEnd <= buildStart || indexSource.indexOf(buildAnchor, buildStart + 1) >= 0) {
  throw new Error("Pinned theme-input source boundary changed");
}
const nativeBuild = compileFunction(`return ({${indexSource.slice(buildStart, buildEnd)}})._buildThemeInput;`)() as
  (intent: string, metadata: RequirementRecord) => string;

const owned: ReturnType<typeof prdFixture>[] = [];
const disposers: Array<() => void> = [];
const network = vi.fn(async () => { throw new Error("Unexpected network/model request"); });
beforeEach(() => { vi.stubGlobal("fetch", network); network.mockClear(); vi.useFakeTimers(); });
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  for (const f of owned.splice(0)) f.cleanup();
  expect(network).not.toHaveBeenCalled();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

function fixture(name = "P1") {
  const f = prdFixture(name); owned.push(f);
  const brief = requirementRecord(f.metadata.brief, "brief");
  brief.description = `${brief.description}\n本片不把性能数字作屏幕卖点，不采用SBK同款背书；完整尾注-${name}-𠮷。`;
  const raw = JSON.parse(f.content);
  raw.facts.stages[0].facts.claims.push({ id: "source-retained", text: "SBK同款原始来源主张；330毫米", source: "合成媒体 2026-09-19" });
  raw.facts.stages.push({ stage: "A2", status: "no_evidence", facts: { reviews: [] } }, { stage: "A3", status: "no_evidence", facts: { competitors: [] } });
  f.content = JSON.stringify(raw);
  writeFileSync(f.file, f.content);
  f.marketing.g1Artifact = { path: f.file, content: f.content, sha256: digest(f.content) };
  f.marketing.g1Proof.evidence = [{ path: f.file, sha256: digest(f.content), scope: "complete-text" }];
  f.authority = preparePrdAuthority({ metadata: f.metadata, marketing: f.marketing, workDir: f.workDir, projectId: name });
  const frozen = requirementHash(f.authority);
  let theme: RequirementApprovedTheme | undefined;
  const options: RequirementAuthorityOptions = { authority: f.authority,
    approvedTheme: () => theme && structuredClone(theme),
    validateAuthority: vi.fn(() => {
      const checked = preparePrdAuthority({ metadata: f.authority.metadata, marketing: f.marketing, workDir: f.workDir, projectId: name });
      if (requirementHash(checked) !== frozen) throw new Error("current private authority changed");
    }) };
  const source = requirementRecord(f.discovery.sceneStructure, "scene");
  source.narrativeArc = "linear";
  for (const [index, item] of (source.scenes as RequirementRecord[]).entries()) { item.index = index + 1; item.emotionalBeat = "rising"; }
  const upstream = { type: "商业广告", theme: `当前主题-${name}`, duration_sec: 30, tone: "轻快明朗", visual_style: "自然光的艺术参考",
    target_audience: "模型推测人群", special_notes: "外观需按本次证据核对", description: "在封闭场地观察商品的设计细节。",
    _originalStoryText: `完整原始故事-${name}\n${brief.description}\n原故事最后一行-${name}` };
  return { ...f, options, upstream, approve: (content = `完整已批G2-${name}`) => {
    theme = captureRequirementTheme(f.authority, content, { approved: true, reason: "真实通过", advisories: [`非阻断修改建议-${name}`] });
    return theme!;
  } };
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function VendorClass() {
  return class Vendor {
    async _convertDiscoveryToRequirementList() { return { keyPoints: ["既有原文"] }; }
    _renderRequirementContract() { return "原始合同"; }
    _buildThemeInput(intent: string, metadata: RequirementRecord) { return nativeBuild(intent, metadata); }
  };
}
function install() {
  const Vendor = VendorClass();
  const dispose = installRequirementContractBridge(Vendor.prototype as unknown as RequirementRecord,
    RequirementDiscoveryEngine.prototype, CreativeThemeGenerator.prototype);
  disposers.push(dispose);
  return { Vendor, dispose };
}
function payloads(scene: unknown) {
  return { audienceProfile: { primaryAudience: { ageRange: "18-24", gender: "all", interestTags: ["设计", "赛道"], consumptionLevel: "medium" },
    emotionTriggers: ["发现具体细节", "保留真实疑问"], contentExpectations: ["设计观察", "明确场地用途"], secondaryAudience: [], painPoints: [] },
  sceneStructure: scene,
  riskAssessment: { technicalRisks: [{ risk: "手部细节", level: "high", impact: "可能失真" }], businessConstraints: ["不虚构商品事实"], mitigationSuggestions: ["按已核资料核对"] },
  referenceCases: { filmReferences: [{ title: "《极速车王》", relevance: "high", keyTakeaway: "只作光线艺术参考" },
    { title: "《帕特森》", relevance: "medium", keyTakeaway: "只作节奏艺术参考" }],
    adReferences: [{ brand: "合成视觉案例", relevance: "low", keyTakeaway: "仅作构图参考，不主张合作" }], styleReferences: ["自然光", "稳定镜头"] } };
}
function response(prompt: string, data: ReturnType<typeof payloads>) {
  const intro = prompt.slice(0, 180);
  return intro.includes("受众分析") ? data.audienceProfile : intro.includes("设计场景结构") ? data.sceneStructure
    : intro.includes("技术制片人") ? data.riskAssessment : data.referenceCases;
}
function fakeEngine(mode: "structured" | "generate" | "chat", data: ReturnType<typeof payloads>) {
  const calls: Array<{ method: string; prompt: string; args: unknown[]; receiver: unknown }> = [];
  const engine: RequirementRecord = { _extractJsonObject: (text: string) => text };
  const record = (name: string, promptIndex = 0) => vi.fn(async function (this: unknown, ...args: unknown[]) {
    const prompt = args[promptIndex] as string;
    calls.push({ method: name, prompt, args, receiver: this });
    const value = structuredClone(response(prompt, data));
    return name === "reasonStructured" ? { success: true, data: value } : { success: true, content: JSON.stringify(value) };
  });
  if (mode === "structured") { engine.reason = record("reason"); engine.reasonStructured = record("reasonStructured"); }
  else engine[mode] = record(mode, mode === "chat" ? 1 : 0);
  return { engine, calls };
}
function discover(engine: RequirementRecord, input: unknown): Promise<RequirementRecord> {
  return (engine.discover as (value: unknown) => Promise<RequirementRecord>)(input);
}

describe("current requirement authority and original transport", () => {
  it("pins the exact native source bodies used by the offline fixtures", () => {
    for (const [relative, hash] of [
      ["index.js", "489171f35ce7cf5fc2cc4387e07380337ea1a574df638533f2b90ed6bd1f86fd"],
      ["engines/requirement-discovery-engine.js", "d658bd5033ff671061b0e31414d4578838496a22b19d204674abc34c7c7a5fdb"],
      ["skills/creative-theme-generator/index.js", "7221bdbc2b2858c8bffb8b4eec640eb78c835c39668d247bb9177e2a1ef31f1e"],
      ["skills/creative-theme-generator/dynamic-type-resolver.js", "65bf2ea16a8871c65c21bea0621af92b98ff5f924b753be4dc96223561c61368"]
    ]) expect(digest(readFileSync(path.join(vendor, relative!), "utf8"))).toBe(hash);
  });

  it("changes only the exact appended source label, preserving identical text inside intent, product and facts", () => {
    const label = "差异化空位（竞品没讲的）：";
    const intent = `客户原文：${label}是本片讨论的话题\n[营销 Brief 与商品情报]\n${label}不能动`;
    const facts = [`${label}来源主张SBK同款`, `先保留330毫米\n${label}仍属同一个来源值`];
    const metadata = { brief: { product: `产品名${label}原文`, category: "测试", audience: "成年人", goal: "traffic", platform: "douyin" },
      _dataDossier: { cards: { theme_card: { differentiation_space: facts } } } };
    const original = nativeBuild(intent, metadata), result = qualifyRequirementThemeInput(original, intent, metadata);
    expect(result.startsWith(intent + "\n[营销 Brief 与商品情报]\n")).toBe(true);
    expect(result).toContain(`商品：产品名${label}原文`);
    for (const fact of facts) expect(result).toContain(fact);
    expect(result.split(label).length).toBe(original.split(label).length - 1);
    expect(result).toContain("来源事实与创意候选（按本次 G1 证据状态与用途限制使用，不预设竞品结论）：" + facts.join("、"));
    expect(() => qualifyRequirementThemeInput(original + "!", "wrong intent", metadata)).toThrow("REQUIREMENT_VENDOR_UNAVAILABLE");
    expect(qualifyRequirementThemeInput(intent, intent, {})).toBe(intent);
  });

  it("preserves complete long Brief/G1 and G2 advisory text without turning suggestions into a new gate", () => {
    const f = fixture(), verdict = { approved: true, reason: "通过", suggestions: [] as string[], advisories: ["完整建议".repeat(4000) + "尾注"] };
    const captured = captureRequirementTheme(f.authority, "完整主题\n" + "来源细节".repeat(2000), verdict)!;
    verdict.advisories[0] = "外部改写";
    const prompt = requirementAuthorityPrompt(f.authority, captured);
    expect(prompt).toContain(captured.verdict.advisories![0]);
    expect(prompt).toContain(f.authority.marketing.g1Artifact.content);
    expect(prompt).toContain("完整尾注-P1-𠮷");
    expect(prompt).toContain("advisories 是非阻断建议");
    expect(prompt).toContain("不把艺术参考本身列为新硬禁");
    expect(captureRequirementTheme(f.authority, "被拒主题", { approved: false, advisories: ["意见"] })).toBeUndefined();
    captured.scope.runId = "other";
    expect(() => requirementAuthorityPrompt(f.authority, captured)).toThrow("REQUIREMENT_THEME_CHANGED");
  });

  it.each(["structured", "generate", "chat"] as const)("passes the full story and authority last, once, through all four native agents via %s", async mode => {
    install(); const f = fixture(mode); const approved = f.approve();
    const expected = payloads(f.discovery.sceneStructure), model = fakeEngine(mode, expected);
    const engine = new RequirementDiscoveryEngine({ llmEngine: model.engine, timeoutMs: 1000, agentTimeoutMs: 100 });
    const before = structuredClone(f.upstream);
    let markdown = "";
    const result = await withRequirementContractScope(f.metadata, async () => {
      const value = await discover(engine, f.upstream);
      markdown = (engine.generateMarkdown as (input: unknown) => string)(value);
      return value;
    }, f.options);
    expect(model.calls).toHaveLength(4);
    expect(model.calls.map(call => call.method)).toEqual(mode === "structured" ? ["reasonStructured", "reason", "reasonStructured", "reasonStructured"] : Array(4).fill(mode));
    const context = requirementAuthorityPrompt(f.authority, approved);
    for (const call of model.calls) {
      expect(call.receiver).toBe(model.engine);
      expect(call.prompt.endsWith(context)).toBe(true);
      expect(call.prompt.split(f.authority.marketing.g1Artifact.content)).toHaveLength(2);
      expect(call.prompt).toContain(f.upstream._originalStoryText);
      expect(call.prompt.indexOf(f.upstream._originalStoryText)).toBeLessThan(call.prompt.indexOf(context));
      expect(call.prompt).toContain("非阻断修改建议-");
      if (mode === "chat") { expect(call.args[0]).toBe("你是一位资深视频业务分析师。只输出严格格式的JSON。"); expect(call.args[2]).toBe(1); }
      else expect(call.args.at(-1)).toMatchObject({ maxTokens: 4000, temperature: 1 });
    }
    for (const key of ["audienceProfile", "sceneStructure", "riskAssessment", "referenceCases"] as const) {
      expect(requirementHash(result[key])).toBe(requirementHash(expected[key]));
    }
    expect(f.upstream).toEqual(before);
    expect(result.upstreamFields).not.toHaveProperty("qualifiedG1");
    expect(requirementRecord(result.upstreamFields, "rendered source")._originalStoryText).toBe(f.upstream._originalStoryText);
    expect(markdown).toContain(f.upstream._originalStoryText);
    expect(markdown).not.toContain(f.authority.marketing.g1Artifact.content);
    expect(markdown).not.toContain("本次宿主需求权威输入");
  });

  it("retains the actual adapter's structured-to-reason delegation and the native agent retry budget", async () => {
    install(); const f = fixture(), expected = payloads(f.discovery.sceneStructure);
    const engine = new WorkloomLLMEngine({ baseUrl: "https://example.invalid", apiKey: "test-only", model: "fixture" });
    const prompts: string[] = [];
    const provider = vi.fn(async (prompt: string, options: RequirementRecord) => {
      prompts.push(prompt);
      if (prompts.length === 1) return { success: true, content: "not json" };
      if (prompt.slice(0, 180).includes("受众分析")) expect(options.forceJson).toBe(true);
      return { success: true, content: JSON.stringify(response(prompt, expected)) };
    });
    (engine as unknown as RequirementRecord).callChat = provider;
    const discovery = new RequirementDiscoveryEngine({ llmEngine: engine, timeoutMs: 1000, agentTimeoutMs: 100 });
    const result = await withRequirementContractScope(f.metadata, () => discover(discovery, f.upstream), f.options);
    expect(result.sceneStructure).toEqual(expected.sceneStructure);
    expect(provider).toHaveBeenCalledTimes(5); // original AudienceProfiler retry only
    expect(engine.stats.totalCalls).toBe(5);
    for (const prompt of prompts) expect(prompt.split(f.authority.marketing.g1Artifact.content)).toHaveLength(2);
  });

  it.each(["audienceProfile", "riskAssessment", "referenceCases"] as const)("rejects missing %s model fields instead of rule-filling them", async key => {
    install(); const f = fixture(), data = payloads(f.discovery.sceneStructure);
    if (key === "audienceProfile") delete (data.audienceProfile.primaryAudience as RequirementRecord).consumptionLevel;
    if (key === "riskAssessment") data.riskAssessment.businessConstraints = [];
    if (key === "referenceCases") data.referenceCases.adReferences = [];
    const model = fakeEngine("structured", data);
    const engine = new RequirementDiscoveryEngine({ llmEngine: model.engine, timeoutMs: 1000, agentTimeoutMs: 100 });
    await expect(withRequirementContractScope(f.metadata, () => discover(engine, f.upstream), f.options)).rejects.toThrow("REQUIREMENT_DISCOVERY_UNVERIFIED");
    expect(model.calls).toHaveLength(key === "audienceProfile" ? 2 : key === "riskAssessment" ? 4 : 5);
  });

  it("restores the full current block and story on a shortened native retry, preserving the original receiver/options/result", async () => {
    const f = fixture(), options = { maxTokens: 4000, temperature: 1 }, result = { success: true, data: { original: true } };
    const native = vi.fn(async function (this: unknown, prompt: string, schema: unknown, actualOptions: unknown) {
      expect(this).toBe(engine); expect(schema).toBe(schemaValue); expect(actualOptions).toBe(options); return result;
    });
    const engine = { reasonStructured: native }, schemaValue = { type: "object" };
    let current = requirementAuthorityPrompt(f.authority);
    const view = scopedRequirementEngine(engine, operation => operation(), () => current, () => f.upstream._originalStoryText);
    const call = view.reasonStructured as (prompt: string, schema: unknown, options: unknown) => Promise<unknown>;
    expect(await call.call(view, "base", schemaValue, options)).toBe(result);
    const first = native.mock.calls[0]![0];
    current = requirementAuthorityPrompt(f.authority, f.approve("新的已批主题"));
    expect(await call.call(view, first + "\n原生重试补充JSON提示", schemaValue, options)).toBe(result);
    expect(await call.call(view, first.slice(0, 24), schemaValue, options)).toBe(result);
    for (const [prompt] of native.mock.calls.slice(1)) {
      expect(prompt.endsWith(current)).toBe(true);
      expect(prompt.split(f.authority.marketing.g1Artifact.content)).toHaveLength(2);
      expect(prompt).toContain(f.upstream._originalStoryText);
    }
  });
});

describe("native theme generation has the same private authority without story pollution", () => {
  const themeFields = { type: "商业广告", theme: "可见设计", duration_sec: 30, tone: "轻快明朗", description: "人物观察商品的可见外形并向朋友分享具体疑问。",
    visual_style: "参考《极速车王》自然光", dialogue_requirement: "自然短句", special_notes: "外观需核对", target_audience: "成年观众", creative_style: 0.6, difficulty: "中" };
  it.each(["generate", "reason", "chat"] as const)("uses original %s extraction and its one JSON retry with authority exactly once", async mode => {
    const { Vendor } = install(); const f = fixture(mode); const calls: Array<{ prompt: string; options: unknown }> = [];
    const model: RequirementRecord = {};
    model[mode] = vi.fn(async function (this: unknown, ...args: unknown[]) {
      expect(this).toBe(model);
      const prompt = args[mode === "chat" ? 1 : 0] as string;
      calls.push({ prompt, options: args[mode === "chat" ? 2 : 1] });
      const text = calls.length === 1 ? "not json" : JSON.stringify(themeFields);
      return mode === "chat" ? text : { success: true, content: text };
    });
    const generator = new CreativeThemeGenerator({ llmEngine: model });
    const metadata = { ...f.metadata, _dataDossier: { cards: { theme_card: { differentiation_space: ["SBK同款来源原文", "330毫米来源原文"] } } } };
    let input = "", result!: RequirementRecord;
    await withRequirementContractScope(f.metadata, async () => {
      input = new Vendor()._buildThemeInput("请制作一条介绍商品设计的短片，人物只作静态观察。", metadata);
      result = await (generator.generate as (value: string) => Promise<RequirementRecord>)(input);
    }, f.options);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.prompt).toContain("来源事实与创意候选");
      expect(call.prompt.split(f.authority.marketing.g1Artifact.content)).toHaveLength(2);
      expect(call.prompt.endsWith(requirementAuthorityPrompt(f.authority))).toBe(true);
    }
    if (mode !== "chat") { expect(calls[0]!.options).toMatchObject({ maxTokens: 2000, temperature: 0.3 }); expect(calls[1]!.options).toMatchObject({ maxTokens: 2000, temperature: 0.2, forceJson: true }); }
    expect(result._originalStoryText).toBe(input);
    expect(String(result._originalStoryText)).not.toContain(f.authority.marketing.g1Artifact.content);
    expect(generator).not.toHaveProperty("_lastInput");
    expect(generator.typeResolver).toMatchObject({ cacheEnabled: false }); // inert constructor, unchanged by run
    expect(metadata).not.toHaveProperty("qualifiedG1");
  });

  it.each(["reasonStructured", "generate", "chat"] as const)("isolates an unbound dynamic cache and uses the original one-dispatch %s miss path", async mode => {
    install(); const f = fixture(); const calls: string[] = [];
    const config = { typeName: "自定义合成类型", themes: ["本片主题"], descriptionTemplate: "本片人物观察本片商品", visualFeatures: ["自然光"],
      toneOptions: ["轻快明朗"], dialoguePattern: "本片短句", specialNotes: "本片未知外观需核对", targetAudience: "本片成年观众", filmReferences: ["艺术参考"] };
    const model = { [mode]: vi.fn(async (...args: unknown[]) => {
      calls.push(args[mode === "chat" ? 1 : 0] as string);
      return mode === "reasonStructured" ? { success: true, data: config } : { success: true, content: JSON.stringify(config) };
    }) };
    const generator = new CreativeThemeGenerator({ llmEngine: model });
    const resolver = requirementRecord(generator.typeResolver, "resolver");
    resolver.cacheEnabled = true;
    const cache = vi.fn(() => ({ ...config, themes: ["旧任务主题"] }));
    const save = vi.fn(); resolver._loadFromCache = cache; resolver._saveToCache = save;
    const input = JSON.stringify({ type: "自定义合成类型", theme: "本片明确主题", description: "本片完整描述" });
    const result = await withRequirementContractScope(f.metadata, () => (generator.generate as (value: string) => Promise<RequirementRecord>)(input), f.options);
    expect(calls).toHaveLength(1); expect(cache).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    expect(calls[0]).toContain(f.authority.marketing.g1Artifact.content);
    expect(JSON.stringify(result)).not.toContain("旧任务主题");
    expect(resolver.cacheEnabled).toBe(true);
  });

  it("keeps native unscoped cache behavior and does not add an extraction/provider call for static complete input", async () => {
    install(); const model = { generate: vi.fn(async () => { throw new Error("not expected"); }) };
    const generator = new CreativeThemeGenerator({ llmEngine: model });
    const resolver = requirementRecord(generator.typeResolver, "resolver"); resolver.cacheEnabled = true;
    const cached = { typeName: "自定义类型", themes: ["旧缓存候选"], descriptionTemplate: "原始缓存配置" };
    resolver._loadFromCache = vi.fn(() => cached);
    await (generator.generate as (input: string) => Promise<unknown>)(JSON.stringify({ ...themeFields, type: "自定义类型" }));
    expect(resolver._loadFromCache).toHaveBeenCalledTimes(1);
    const f = fixture(); const complete = JSON.stringify(themeFields);
    await withRequirementContractScope(f.metadata, () => (new CreativeThemeGenerator({ llmEngine: model }).generate as (input: string) => Promise<unknown>)(complete), f.options);
    expect(model.generate).not.toHaveBeenCalled();
  });

  it("keeps extraction and dynamic fallback failures fatal after vendor catches, without another provider call", async () => {
    install(); const f = fixture(); const provider = vi.fn(async () => { throw new Error("fixture unavailable"); });
    const generator = new CreativeThemeGenerator({ llmEngine: { generate: provider } });
    await expect(withRequirementContractScope(f.metadata, async () => {
      try { await (generator.generate as (input: string) => Promise<unknown>)("请制作一条商品介绍短片"); } catch { /* vendor-like swallow */ }
      return { success: false };
    }, f.options)).rejects.toThrow("fixture unavailable");
    expect(provider).toHaveBeenCalledTimes(1);
    const g = fixture("dynamic-fail"), dynamic = vi.fn(async () => ({ success: false, error: "fixture failure" }));
    const generator2 = new CreativeThemeGenerator({ llmEngine: { reasonStructured: dynamic } });
    await expect(withRequirementContractScope(g.metadata, () => (generator2.generate as (input: string) => Promise<unknown>)(JSON.stringify({ type: "未知合成类型", theme: "明确主题" })), g.options))
      .rejects.toThrow("REQUIREMENT_THEME_UNVERIFIED");
    expect(dynamic).toHaveBeenCalledTimes(1);
  });
});

describe("authority lifecycle, mutation and closed failures", () => {
  it.each(["private-memory", "physical-g1", "engine-descriptor", "upstream"])("stops before a later paid call after %s changes, even when the caller swallows errors", async kind => {
    install(); const f = fixture(), data = payloads(f.discovery.sceneStructure), model = fakeEngine("structured", data);
    const first = model.engine.reasonStructured as (...args: unknown[]) => Promise<unknown>;
    const originalDescriptor = Object.getOwnPropertyDescriptor(model.engine, "reasonStructured")!;
    model.engine.reasonStructured = async function (this: RequirementRecord, ...args: unknown[]) {
      const result = await Reflect.apply(first, this, args);
      if (kind === "private-memory") f.authority.marketing.g1Proof.model = "changed";
      if (kind === "physical-g1") writeFileSync(f.file, f.content + " ");
      if (kind === "engine-descriptor") Object.defineProperty(model.engine, "reason", { ...Object.getOwnPropertyDescriptor(model.engine, "reason"), enumerable: false });
      if (kind === "upstream") f.upstream.description = "输入被改写";
      return result;
    };
    const engine = new RequirementDiscoveryEngine({ llmEngine: model.engine, timeoutMs: 1000, agentTimeoutMs: 100 });
    await expect(withRequirementContractScope(f.metadata, async () => {
      try { await discover(engine, f.upstream); } catch { /* emulate vendor swallowing */ }
      return { success: false };
    }, f.options)).rejects.toThrow();
    expect(model.calls).toHaveLength(1);
    Object.defineProperty(model.engine, "reasonStructured", originalDescriptor);
  });

  it("rejects forged G2 scope/content before entering a provider", async () => {
    install(); const f = fixture(), approved = f.approve(), model = fakeEngine("structured", payloads(f.discovery.sceneStructure));
    const engine = new RequirementDiscoveryEngine({ llmEngine: model.engine, timeoutMs: 1000, agentTimeoutMs: 100 });
    approved.contentMd += "changed";
    f.options.approvedTheme = () => approved;
    await expect(withRequirementContractScope(f.metadata, () => discover(engine, f.upstream), f.options)).rejects.toThrow("REQUIREMENT_THEME_CHANGED");
    expect(model.calls).toHaveLength(0);
  });

  it("does not start SceneArchitect or retry an agent after a detached scope closes", async () => {
    install(); const f = fixture(), model = fakeEngine("structured", payloads(f.discovery.sceneStructure));
    let resolve!: (value: unknown) => void;
    const response = new Promise(done => { resolve = done; });
    model.engine.reasonStructured = vi.fn(() => response);
    const engine = new RequirementDiscoveryEngine({ llmEngine: model.engine, timeoutMs: 1000, agentTimeoutMs: 100 });
    let pending!: Promise<unknown>;
    await withRequirementContractScope(f.metadata, () => { pending = discover(engine, f.upstream); }, f.options);
    const failure = expect(pending).rejects.toThrow("REQUIREMENT_SCOPE_CLOSED");
    resolve({ success: true, data: payloads(f.discovery.sceneStructure).audienceProfile });
    await failure;
    expect(model.engine.reasonStructured).toHaveBeenCalledTimes(1);
    expect(model.engine.reason).not.toHaveBeenCalled();
  });

  it("keeps overlapping private runs separate on one original model engine", async () => {
    install(); const a = fixture("A"), b = fixture("B"), seen: string[] = [];
    const model: RequirementRecord = { _extractJsonObject: (text: string) => text };
    model.reasonStructured = vi.fn(async (prompt: string) => { seen.push(prompt); await Promise.resolve();
      return { success: true, data: response(prompt, payloads(prompt.includes(a.upstream._originalStoryText) ? a.discovery.sceneStructure : b.discovery.sceneStructure)) }; });
    model.reason = vi.fn(async (prompt: string) => { seen.push(prompt); return { success: true, content: JSON.stringify(a.discovery.sceneStructure) }; });
    const run = (f: ReturnType<typeof fixture>) => withRequirementContractScope(f.metadata, () => discover(
      new RequirementDiscoveryEngine({ llmEngine: model, timeoutMs: 1000, agentTimeoutMs: 100 }), f.upstream), f.options);
    await Promise.all([run(a), run(b)]);
    expect(seen).toHaveLength(8);
    for (const prompt of seen) {
      const own = prompt.includes(a.upstream._originalStoryText) ? a : b, other = own === a ? b : a;
      expect(prompt).toContain(own.authority.marketing.g1Artifact.content);
      expect(prompt).not.toContain(other.authority.marketing.g1Artifact.content);
    }
  });
});
