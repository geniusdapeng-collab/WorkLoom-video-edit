import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindRequirementContract, renderRequirementContract, requirementCast, requirementHash, requirementRecord,
  requirementScenes, structuredScenePrompt, structuredSceneSchema, verifiedRequirementContract, type RequirementRecord
} from "./requirement-contract.js";
import { assertRequirementContractBridge, installRequirementContractBridge, withRequirementContractScope } from "./requirement-contract-bridge.js";
import { installSharedBridge, installVendorDiscoveryFixBridge, listSharedBridges } from "./vendor-compat.js";

const require = createRequire(import.meta.url);
// This module has no imports, env/file reads or model initialization. Only its real
// discovery/agent code is exercised; every LLM method below is an inert local fixture.
const { RequirementDiscoveryEngine } = require(resolve(dirname(fileURLToPath(import.meta.url)),
  "../../../vendor/supermickey/hyperreality-system/engines/requirement-discovery-engine.js")) as {
  RequirementDiscoveryEngine: { new(options?: RequirementRecord): RequirementRecord; prototype: RequirementRecord };
};
const disposers: Array<() => void> = [];
const nativeDiscovery = Object.fromEntries(["discover", "_fastMode", "generateMarkdown"].map(key => [key, RequirementDiscoveryEngine.prototype[key]]));
const network = vi.fn(async () => { throw new Error("unexpected network"); });
let installedDiscoveryDefaults = false;
beforeEach(() => { installedDiscoveryDefaults = false; network.mockClear(); vi.stubGlobal("fetch", network); vi.useFakeTimers(); });
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  for (const key of Object.keys(nativeDiscovery)) expect(RequirementDiscoveryEngine.prototype[key]).toBe(nativeDiscovery[key]);
  expect(network).not.toHaveBeenCalled();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

function metadata(id = "young-rider-01", name = "李英子"): RequirementRecord {
  const profile = "a".repeat(64), registry = "b".repeat(64), profilePath = `/fixtures/${id}/profile.json`;
  return {
    brief: { product: "820RR-RC赛道版", audience: "对赛道设计感兴趣的年轻成年观众", duration: 30, aspectRatio: "9:16", platform: "douyin" },
    characters: [{ id, character_id: id, name, role: "protagonist", kind: "generated", subjectType: "synthetic-digital-human",
      identity: { age: "20岁成年原创虚构人物" }, persona: { interests: ["摄影", "运动"], avoid: ["幼态化语气"], dailyDetails: ["包里常备水"],
        rules: ["定妆照没有头盔不代表可不戴头盔驾驶"] }, description: "完整人物档案，用于语气和行为，不是道具清单。",
      builtinCharacterSource: { profilePath, profileSha256: profile, registrySha256: registry } }],
    builtinCharacterSelection: { schemaVersion: "workloom.video-character-selection/v1", mode: "builtin", registrySha256: registry,
      characters: [{ id, name, source: "builtin", profilePath, profileSha256: profile }] }
  };
}
function nobody(): RequirementRecord {
  return { characters: [], hasPerson: false, noCharacters: true,
    builtinCharacterSelection: { schemaVersion: "workloom.video-character-selection/v1", mode: "none", characters: [] } };
}
function structure(id = "young-rider-01"): RequirementRecord {
  const node = (purpose: string): RequirementRecord => ({ duration: 10, purpose, keyElements: ["商品车辆的涂装线条", "围场护栏"],
    productionContract: { props: [{ name: "820RR-RC赛道版", description: "停放于封闭围场的商品展示车辆" }],
      actions: [{ actorId: id, description: "在静态车辆旁指向车身的涂装线条" }] } });
  return { opening: node("开场保留完整的可拍行为和观察目的。"), scenes: [{ ...node("主体观察车辆涂装线条，清楚表达好奇的问题。"), index: 1, emotionalBeat: "rising" }],
    ending: node("结尾向镜头邀请观众讨论最想了解的设计问题。"), totalDuration: 30, sceneCount: 3, narrativeArc: "linear" };
}
function discovery(id = "young-rider-01"): RequirementRecord {
  return { sceneStructure: structure(id), audienceProfile: { primaryAudience: { ageRange: "25-30", gender: "male", interestTags: ["设计", "摩托车"], consumptionLevel: "medium" },
    emotionTriggers: ["观察细节", "自然分享"], contentExpectations: ["完整可见动作", "清楚说明"], secondaryAudience: [], painPoints: [] },
    riskAssessment: { technicalRisks: [{ risk: "手部细节失真", level: "high", impact: "失真影响观察" }], businessConstraints: ["不得编造商品参数"], mitigationSuggestions: ["使用真实商品资料核对画面"] },
    referenceCases: { filmReferences: [{ title: "《示例影片》", relevance: "medium", keyTakeaway: "静态局部观察" }], adReferences: [], styleReferences: ["自然光", "稳定镜头"] } };
}
const upstream = { type: "商业广告", theme: "设计细节", duration_sec: 30, tone: "轻快明朗", description: "在封闭围场观察车辆。",
  target_audience: "模型提出的窄化人群", visual_style: "稳定镜头", _originalStoryText: "完整原始故事。" };
function original(): RequirementRecord {
  return { genre: "自定义商品观察", genreConfidence: 0.93, productionProfile: { profileId: "real-resolver-result", duration_target: 30 },
    targetDuration: 30, durationRange: [24, 36], aspectRatio: "9:16", platform: "抖音", creativeIntensity: 0.6,
    keyPoints: ["已有不可丢失要求"], characters: [], contentConstraints: ["保持商品真实外观"] };
}
function bind(meta = metadata(), d = discovery(), value: unknown = original()): RequirementRecord {
  const audience = requirementRecord(meta.brief, "brief").audience as string;
  return bindRequirementContract(value, d, upstream, meta, requirementCast(meta).hash, audience);
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

async function nativeSceneFixture(duration: number, description = "客户完整的场景描述与艺术参考。") {
  const engine = new RequirementDiscoveryEngine({ timeoutMs: 1000, agentTimeoutMs: 100 });
  const agents = requirementRecord(engine.agents, "agents"), input = { ...upstream, duration_sec: duration, description };
  const scene = requirementRecord(agents.scene, "scene");
  const prompt = Reflect.apply(scene._buildPrompt as (...args: unknown[]) => unknown, scene, [input]) as string;
  let nativeSchema: RequirementRecord | undefined;
  for (const [name, value] of Object.entries(agents)) {
    const agent = requirementRecord(value, name);
    agent.run = (_input: unknown, schema: unknown) => {
      if (name === "scene") { nativeSchema = structuredClone(requirementRecord(schema, "native schema")); return structure(); }
      const d = discovery();
      return name === "audience" ? d.audienceProfile : name === "risk" ? d.riskAssessment : d.referenceCases;
    };
  }
  await (engine.discover as (value: unknown) => Promise<unknown>)(input);
  if (!nativeSchema) throw new Error("actual native discovery did not provide its schema");
  return { prompt, input, nativeSchema };
}

describe("actual vendor scene prompt correction", () => {
  it.each([30, 45, 60])("replaces only generated contradictions for %ss with the exact effective schema", async duration => {
    const native = await nativeSceneFixture(duration);
    const example = native.prompt.match(/^\{"opening":.+\}$/m)![0];
    const value = JSON.parse(example), nodes = [value.opening, ...value.scenes, value.ending];
    expect(value.sceneCount === nodes.length && value.totalDuration === nodes.reduce((sum: number, node: { duration: number }) => sum + node.duration, 0)).toBe(false);
    const originalSchema = structuredClone(native.nativeSchema), schema = structuredSceneSchema(native.nativeSchema);
    const corrected = structuredScenePrompt(native.prompt, native.input, schema);
    expect(native.nativeSchema).toEqual(originalSchema);
    expect(corrected).not.toContain(example);
    expect(corrected).not.toContain(`请设计 ${Math.min(Math.max(Math.ceil(duration / 15), 2), 8)} 个场景（含开场和结尾）`);
    expect(corrected).toContain("场景数量与逐节点时长由本次模型根据叙事自行决定");
    expect(corrected).toContain("sceneCount 必须等于 2 + scenes.length");
    expect(corrected).toContain(`目标 ${duration} 秒（现有数值容差 0.05 秒）`);
    const encoded = corrected.split("本次实际 SceneArchitect 响应 JSON Schema（完整适用，不是示例成品）：\n")[1]!.split("\n")[0]!;
    expect(JSON.parse(encoded)).toEqual(schema);
    for (const phrase of ["【电影语法参考】关注：产品质感光", "【结构心法——三幕呼吸法】", "高潮(climax)之后", "climax 场景时长必须≥任一其他场景的1.3倍"]) expect(corrected).toContain(phrase);
  });

  it("preserves customer description containing the exact generated lines and full native suffix", async () => {
    const first = await nativeSceneFixture(30);
    const marker = "请设计 2 个场景（含开场和结尾），总时长约 30 秒。";
    const suffix = first.prompt.slice(first.prompt.lastIndexOf(marker));
    const description = `客户原文开始\n${suffix}\n客户原文结束，保留全部艺术表达。`;
    const native = await nativeSceneFixture(30, description), schema = structuredSceneSchema(native.nativeSchema);
    const corrected = structuredScenePrompt(native.prompt, native.input, schema);
    expect(corrected).toContain(description);
    expect(corrected.split(marker)).toHaveLength(2); // Customer literal only; generated advice removed.
    const prefix = native.prompt.slice(0, native.prompt.lastIndexOf(marker));
    expect(corrected.startsWith(prefix)).toBe(true);
    expect(corrected.endsWith("重点不突出等于没有重点。")).toBe(true);
  });

  it("rejects generated suffix drift and unserializable schema without touching customer content", async () => {
    const native = await nativeSceneFixture(30), schema = structuredSceneSchema(native.nativeSchema);
    expect(() => structuredScenePrompt(native.prompt + "changed", native.input, schema)).toThrow("REQUIREMENT_VENDOR_UNAVAILABLE");
    expect(() => structuredScenePrompt(native.prompt.replace("总时长约 30 秒。", "总时长约 31 秒。"), native.input, schema)).toThrow("REQUIREMENT_VENDOR_UNAVAILABLE");
    expect(() => structuredScenePrompt(null, native.input, schema)).toThrow("REQUIREMENT_VENDOR_UNAVAILABLE");
    const cyclic: RequirementRecord = {}; cyclic.self = cyclic;
    expect(() => structuredScenePrompt(native.prompt, native.input, cyclic)).toThrow("REQUIREMENT_SCHEMA_UNSUPPORTED");
  });
});

describe("host requirement contract data", () => {
  it("keeps the resolver result, owner audience and complete selected character while binding one real structure", () => {
    const meta = metadata(), d = discovery(), source = original();
    const sourceCopy = structuredClone(source);
    const result = bind(meta, d, source);
    expect(source).toEqual(sourceCopy);
    for (const key of ["genre", "genreConfidence", "productionProfile", "targetDuration", "durationRange", "aspectRatio", "creativeIntensity", "contentConstraints"]) expect(result[key]).toEqual(source[key]);
    expect(result.characters).toEqual(meta.characters);
    expect(result.targetAudience).toBe(requirementRecord(meta.brief, "brief").audience);
    expect(result.inferredAudienceProfile).toEqual(d.audienceProfile);
    const contract = verifiedRequirementContract(result, meta, d);
    expect(contract.status).toBe("ready-for-g3");
    expect(contract.cast.characters).toHaveLength(1);
    expect(contract.props).toHaveLength(3);
    expect(contract.actions).toHaveLength(3);
    expect(meta._workloomRequirementContract).toBe(result._workloomRequirementContract);
    expect((result.keyPoints as unknown[])[0]).toBe("已有不可丢失要求");
  });

  it("retains long scene text and persona as complete source data without lexical persona props", () => {
    const meta = metadata(), d = discovery();
    const longPurpose = "完整场景目的，观察实际可见的设计细节并保留动作连续性。".repeat(30);
    requirementRecord(requirementRecord(d.sceneStructure, "structure").opening, "opening").purpose = longPurpose;
    const result = bind(meta, d), contract = verifiedRequirementContract(result, meta, d);
    const markdown = renderRequirementContract(contract, meta);
    expect(markdown).toContain(longPurpose);
    expect(markdown).toContain("包里常备水");
    expect(markdown).toContain("定妆照没有头盔不代表可不戴头盔驾驶");
    expect(contract.props.map(prop => prop.name)).toEqual(["820RR-RC赛道版", "820RR-RC赛道版", "820RR-RC赛道版"]);
    expect(contract.props.some(prop => /摄影|朝气|幼态化|可不戴|常备水/.test(prop.name))).toBe(false);
    expect(markdown).toContain("模型受众细分仅为推测");
    expect(markdown).not.toContain("无真人角色");
  });

  it("permits an explicitly selected empty cast with real product/scene actions", () => {
    const meta = nobody(), d = discovery("$product");
    const result = bindRequirementContract(original(), d, upstream, meta, requirementCast(meta).hash, null);
    const contract = verifiedRequirementContract(result, meta, d);
    expect(contract.cast.mode).toBe("none");
    expect(contract.cast.characters).toEqual([]);
    expect(renderRequirementContract(contract, meta)).toContain("角色（0）");
  });

  it("permits a genuinely empty prop list only with an explicit scene reason", () => {
    const meta = nobody(), d = discovery("$scene"), s = requirementRecord(d.sceneStructure, "structure");
    for (const node of [s.opening, ...(s.scenes as unknown[]), s.ending]) {
      const physical = requirementRecord(requirementRecord(node, "node").productionContract, "physical");
      physical.props = []; physical.noPropsReason = "本场只展示环境光线与云影变化，没有独立可见道具。";
    }
    const result = bindRequirementContract(original(), d, upstream, meta, requirementCast(meta).hash, null);
    expect(verifiedRequirementContract(result, meta, d).props).toEqual([]);
    requirementRecord(meta, "meta").brief = { product: "有明确商品的片子" };
    expect(() => bindRequirementContract(original(), d, upstream, meta, requirementCast(meta).hash, null)).toThrow("REQUIREMENT_SCENE_UNVERIFIED");
  });

  it.each(["missing-selection", "wrong-schema", "wrong-id", "wrong-name", "duplicate", "profile", "registry", "none-conflict", "mode"])("rejects %s casting instead of inventing no-person", kind => {
    const meta = metadata(), selection = requirementRecord(meta.builtinCharacterSelection, "selection");
    const selected = (selection.characters as RequirementRecord[])[0]!, character = (meta.characters as RequirementRecord[])[0]!;
    if (kind === "missing-selection") delete meta.builtinCharacterSelection;
    if (kind === "wrong-schema") selection.schemaVersion = "forged";
    if (kind === "wrong-id") selected.id = "someone-else";
    if (kind === "wrong-name") selected.name = "另一个名字";
    if (kind === "duplicate") { (meta.characters as unknown[]).push(structuredClone(character)); (selection.characters as unknown[]).push(structuredClone(selected)); }
    if (kind === "profile") selected.profileSha256 = "c".repeat(64);
    if (kind === "registry") selection.registrySha256 = "c".repeat(64);
    if (kind === "none-conflict") selection.mode = "none";
    if (kind === "mode") selection.mode = "custom";
    expect(() => requirementCast(meta)).toThrow(/REQUIREMENT_(?:CAST|CONTRACT)_/);
  });

  it.each(["missing-contract", "props-type", "empty-actions", "unknown-actor", "generic-verb", "missing-elements", "duration-type", "duration-sum", "scene-count", "no-prop-reason", "props-with-reason", "props-with-null-reason", "props-with-empty-reason", "actor-unused"])("rejects %s physical structure", kind => {
    const d = discovery(), s = requirementRecord(d.sceneStructure, "structure"), opening = requirementRecord(s.opening, "opening");
    const physical = requirementRecord(opening.productionContract, "physical");
    if (kind === "missing-contract") delete opening.productionContract;
    if (kind === "props-type") physical.props = "头盔";
    if (kind === "empty-actions") physical.actions = [];
    if (kind === "unknown-actor") (physical.actions as RequirementRecord[])[0]!.actorId = "another-person";
    if (kind === "generic-verb") (physical.actions as RequirementRecord[])[0]!.description = "起身";
    if (kind === "missing-elements") opening.keyElements = [];
    if (kind === "duration-type") opening.duration = "10";
    if (kind === "duration-sum") opening.duration = 9;
    if (kind === "scene-count") s.sceneCount = 2;
    if (kind === "no-prop-reason") physical.props = [];
    if (kind === "props-with-reason") physical.noPropsReason = "与实际非空道具矛盾的无道具理由";
    if (kind === "props-with-null-reason") physical.noPropsReason = null;
    if (kind === "props-with-empty-reason") physical.noPropsReason = "";
    if (kind === "actor-unused") for (const node of [s.opening, ...(s.scenes as unknown[]), s.ending]) {
      const actions = requirementRecord(requirementRecord(node, "node").productionContract, "p").actions as RequirementRecord[];
      for (const action of actions) action.actorId = "$product";
    }
    expect(() => requirementScenes(s, requirementCast(metadata()), 30)).toThrow(/REQUIREMENT_/);
  });

  it("rejects a pending conversion and an authority changed during discovery", () => {
    expect(() => bind(metadata(), discovery(), Promise.resolve(original()))).toThrow("REQUIREMENT_CONTRACT_INVALID");
    const meta = metadata(), before = requirementCast(meta).hash;
    (meta.characters as RequirementRecord[])[0]!.description = "人物被改写";
    expect(() => bindRequirementContract(original(), discovery(), upstream, meta, before, "原受众")).toThrow("REQUIREMENT_CAST_CHANGED");
    const stable = metadata();
    expect(() => bindRequirementContract(original(), discovery(), upstream, stable, requirementCast(stable).hash, "另一受众")).toThrow("REQUIREMENT_AUDIENCE_CHANGED");
  });

  it.each(["count", "declared-duration", "target-duration"])("reports bounded numeric %s diagnostics without scene prose", kind => {
    const s = structure(), target = kind === "target-duration" ? 45 : 30;
    requirementRecord(s.opening, "opening").purpose = "PRIVATE-PROSE-NEVER-LOG";
    if (kind === "count") s.sceneCount = 2;
    if (kind === "declared-duration") s.totalDuration = 29;
    let failure: Error & { details?: RequirementRecord };
    try { requirementScenes(s, requirementCast(metadata()), target); throw new Error("expected failure"); }
    catch (error) { failure = error as typeof failure; }
    expect(failure.message).toContain("场景节点数或总时长与真实结构不一致；numeric");
    expect(failure.details).toEqual({ nodeCount: 3, declaredSceneCount: kind === "count" ? 2 : 3, durationSum: 30,
      declaredTotalDuration: kind === "declared-duration" ? 29 : 30, targetDuration: target,
      declaredDurationDelta: kind === "declared-duration" ? 1 : 0, targetDurationDelta: kind === "target-duration" ? -15 : 0 });
    expect(Object.isFrozen(failure.details)).toBe(true);
    expect(failure.message.length).toBeLessThan(600);
    expect(failure.message).not.toContain("PRIVATE-PROSE");
  });

  it("retains the original 0.05-second arithmetic tolerance", () => {
    const valid = structure(), invalid = structure();
    requirementRecord(valid.opening, "opening").duration = 9.951;
    requirementRecord(invalid.opening, "opening").duration = 9.949;
    expect(requirementScenes(valid, requirementCast(metadata()), 30)).toHaveLength(3);
    expect(() => requirementScenes(invalid, requirementCast(metadata()), 30)).toThrow("REQUIREMENT_SCENE_UNVERIFIED");
  });

  it.each(["scene", "cast", "list-cast", "contract", "audience", "metadata-contract"])("rejects %s changes before G3", kind => {
    const meta = metadata(), d = discovery(), result = bind(meta, d);
    if (kind === "scene") requirementRecord(requirementRecord(d.sceneStructure, "s").opening, "opening").purpose = "场景已被替换";
    if (kind === "cast") (meta.characters as RequirementRecord[])[0]!.description = "换档案";
    if (kind === "list-cast") result.characters = [];
    if (kind === "contract") requirementRecord(result._workloomRequirementContract, "c").status = "passed";
    if (kind === "audience") requirementRecord(meta.brief, "brief").audience = "只要25岁男性";
    if (kind === "metadata-contract") meta._workloomRequirementContract = { forged: true };
    expect(() => verifiedRequirementContract(result, meta, d)).toThrow(/REQUIREMENT_/);
  });

  it("hashes equivalent JSON deterministically and rejects missing, cyclic or non-JSON authority", () => {
    expect(requirementHash({ b: [1, 2], a: "x" })).toBe(requirementHash({ a: "x", b: [1, 2] }));
    expect(() => requirementHash(undefined)).toThrow("REQUIREMENT_CONTRACT_INVALID");
    const cyclic: RequirementRecord = {}; cyclic.self = cyclic;
    expect(() => requirementHash(cyclic)).toThrow("REQUIREMENT_CONTRACT_INVALID");
    expect(() => requirementHash({ fn() {} })).toThrow("REQUIREMENT_CONTRACT_INVALID");
  });

  it.each(["scene", "prop", "action", "cast-selection"])("rejects rehashed %s derivations that no longer match their unchanged authority", kind => {
    const meta = metadata(), d = discovery(), result = bind(meta, d);
    const contract = requirementRecord(result._workloomRequirementContract, "contract");
    if (kind === "scene") (contract.scenes as RequirementRecord[])[0]!.purpose = "重算摘要也不能替换真实场景目的";
    if (kind === "prop") (contract.props as RequirementRecord[])[0]!.description = "未经真实场景响应支持的新商品部件";
    if (kind === "action") (contract.actions as RequirementRecord[])[0]!.description = "未经真实场景响应支持的新动作过程";
    if (kind === "cast-selection") requirementRecord(requirementRecord(contract.cast, "cast").selection, "selection").mode = "custom";
    const { hash: _old, ...payload } = contract; contract.hash = requirementHash(payload);
    expect(() => verifiedRequirementContract(result, meta, d)).toThrow("REQUIREMENT_CONTRACT_CHANGED");
  });
});

function fakeModel(scene: RequirementRecord) {
  const prompts: string[] = [];
  const fake = {
    reasonStructured: vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      const value = prompt.includes("受众分析") ? discovery().audienceProfile
        : prompt.includes("技术制片人") ? discovery().riskAssessment : discovery().referenceCases;
      return { success: true, data: structuredClone(value) };
    }),
    reason: vi.fn(async (prompt: string) => { prompts.push(prompt); return { success: true, content: JSON.stringify(scene) }; }),
    _extractJsonObject: (content: string) => content
  };
  return { fake, prompts };
}
function vendorClass() {
  return class Vendor {
    profile = original();
    resolver: () => Promise<RequirementRecord> = async () => this.profile;
    async _convertDiscoveryToRequirementList(_discovery: unknown, _upstream: unknown): Promise<RequirementRecord> { return this.resolver(); }
    _renderRequirementContract() { return "native contract"; }
  };
}
function install(Vendor: ReturnType<typeof vendorClass>, shared = false) {
  if (!installedDiscoveryDefaults) {
    disposers.push(installVendorDiscoveryFixBridge());
    installedDiscoveryDefaults = true;
  }
  const factory = () => installRequirementContractBridge(Vendor.prototype as unknown as RequirementRecord, RequirementDiscoveryEngine.prototype);
  const dispose = shared ? installSharedBridge("test-requirement-contract", factory) : factory();
  disposers.push(dispose);
  return dispose;
}
async function callConvert(vendor: object, d: unknown, meta: RequirementRecord): Promise<RequirementRecord> {
  const fn = requirementRecord(vendor, "vendor")._convertDiscoveryToRequirementList as (...args: unknown[]) => Promise<RequirementRecord>;
  return fn.call(vendor, d, upstream, meta);
}

describe("real discovery code with isolated fake LLM", () => {
  it.each([null, "被替换的受众"])("rejects rehashed owner audience %s against the frozen run authority", async replacement => {
    const Vendor = vendorClass(); install(Vendor);
    const vendor = new Vendor(), meta = metadata(), d = discovery();
    await withRequirementContractScope(meta, async () => {
      const list = await callConvert(vendor, d, meta);
      const contract = requirementRecord(list._workloomRequirementContract, "contract");
      contract.ownerAudience = replacement;
      if (replacement !== null) requirementRecord(meta.brief, "brief").audience = replacement;
      const { hash: _old, ...payload } = contract; contract.hash = requirementHash(payload);
      const render = requirementRecord(vendor, "vendor")._renderRequirementContract as (...args: unknown[]) => unknown;
      expect(() => render.call(vendor, {}, meta, list, d)).toThrow("REQUIREMENT_AUDIENCE_CHANGED");
    });
  });
  it("uses the same real four-agent workflow, extending the existing SceneArchitect response schema and prompt", async () => {
    const Vendor = vendorClass(); install(Vendor);
    const meta = metadata(), model = fakeModel(structure()), engine = new RequirementDiscoveryEngine({ llmEngine: model.fake, timeoutMs: 1000, agentTimeoutMs: 100 });
    let receivedSchema: unknown;
    const scene = requirementRecord(requirementRecord(engine.agents, "agents").scene, "scene");
    const run = scene.run as (...args: unknown[]) => unknown;
    scene.run = function (this: RequirementRecord, input: unknown, schema: unknown) { receivedSchema = schema; return Reflect.apply(run, this, [input, schema]); };
    await withRequirementContractScope(meta, async () => {
      const d = await (engine.discover as (value: unknown) => Promise<RequirementRecord>)(upstream);
      expect(model.fake.reasonStructured).toHaveBeenCalledTimes(3);
      expect(model.fake.reason).toHaveBeenCalledTimes(1);
      expect(model.prompts.find(prompt => prompt.includes("productionContract"))).toContain("young-rider-01");
      const structuredPrompt = model.prompts.find(prompt => prompt.includes("productionContract"))!;
      expect(structuredPrompt).toContain("有 props 时必须完全省略 noPropsReason，不能填空串或 null");
      const withProps = JSON.parse(structuredPrompt.match(/有可见道具时：(\{[^\n]+\})\n/)![1]!);
      const withoutProps = JSON.parse(structuredPrompt.match(/确实无可见道具时：(\{[^\n]+\})。有 props/)![1]!);
      expect(withProps.props.length).toBeGreaterThan(0); expect(withProps).not.toHaveProperty("noPropsReason");
      expect(withoutProps.props).toEqual([]); expect(withoutProps.noPropsReason.length).toBeGreaterThanOrEqual(8);
      expect(JSON.stringify(receivedSchema)).toContain("productionContract");
      expect(d.audienceProfileStatus).toBe("model-hypothesis");
      const result = await callConvert(new Vendor(), d, meta);
      expect(result.productionProfile).toEqual(original().productionProfile);
      const markdown = (engine.generateMarkdown as (value: unknown) => string)(d);
      expect(markdown).toContain("客户 Brief 权威受众原文");
      expect(markdown).toContain("模型细分推测");
      expect(markdown).toContain("完整原始故事。");
      expect(markdown).toContain("25-30");
    });
  });

  it("never accepts a real agent's rule fallback when model structure is missing", async () => {
    const Vendor = vendorClass(); install(Vendor);
    const bad = structure(); delete requirementRecord(bad.opening, "opening").productionContract;
    const model = fakeModel(bad), engine = new RequirementDiscoveryEngine({ llmEngine: model.fake, timeoutMs: 1000, agentTimeoutMs: 100 });
    await expect(withRequirementContractScope(metadata(), () => (engine.discover as (value: unknown) => Promise<unknown>)(upstream)))
      .rejects.toThrow("REQUIREMENT_SCENE_UNVERIFIED");
    expect(model.fake.reason).toHaveBeenCalledTimes(2); // The existing BaseDiscoveryAgent retry, no new extraction call.
    await expect(withRequirementContractScope(metadata(), () => (engine._fastMode as (value: unknown) => unknown)(upstream)))
      .rejects.toThrow("REQUIREMENT_DISCOVERY_UNVERIFIED");
  });

  it("propagates model failure after the existing retry without fabricating props/actions", async () => {
    const Vendor = vendorClass(); install(Vendor);
    const model = fakeModel(structure()); model.fake.reason.mockRejectedValue(new Error("fixture provider unavailable"));
    const engine = new RequirementDiscoveryEngine({ llmEngine: model.fake, timeoutMs: 1000, agentTimeoutMs: 100 });
    await expect(withRequirementContractScope(metadata(), () => (engine.discover as (value: unknown) => Promise<unknown>)(upstream)))
      .rejects.toThrow("REQUIREMENT_SCENE_UNVERIFIED");
    expect(model.fake.reason).toHaveBeenCalledTimes(2);
  });

  it("preserves the latest native attempt's numeric failure through both vendor fallback catches", async () => {
    const Vendor = vendorClass(); install(Vendor);
    const first = structure(), second = structure(); first.sceneCount = 2;
    requirementRecord(second.opening, "opening").duration = 9;
    const model = fakeModel(first);
    model.fake.reason.mockResolvedValueOnce({ success: true, content: JSON.stringify(first) })
      .mockResolvedValueOnce({ success: true, content: JSON.stringify(second) });
    const engine = new RequirementDiscoveryEngine({ llmEngine: model.fake, timeoutMs: 1000, agentTimeoutMs: 100 });
    await expect(withRequirementContractScope(metadata(), () => (engine.discover as (value: unknown) => Promise<unknown>)(upstream)))
      .rejects.toMatchObject({ code: "REQUIREMENT_SCENE_UNVERIFIED", details: { nodeCount: 3, declaredSceneCount: 3, durationSum: 29, targetDuration: 30 } });
    expect(model.fake.reason).toHaveBeenCalledTimes(2);
  });

  it("does not reuse an earlier numeric failure after a later transport failure", async () => {
    const Vendor = vendorClass(); install(Vendor);
    const first = structure(); first.sceneCount = 2;
    const model = fakeModel(first);
    model.fake.reason.mockResolvedValueOnce({ success: true, content: JSON.stringify(first) })
      .mockRejectedValueOnce(new Error("fixture current transport failure"));
    const engine = new RequirementDiscoveryEngine({ llmEngine: model.fake, timeoutMs: 1000, agentTimeoutMs: 100 });
    await expect(withRequirementContractScope(metadata(), () => (engine.discover as (value: unknown) => Promise<unknown>)(upstream)))
      .rejects.toMatchObject({ code: "REQUIREMENT_SCENE_UNVERIFIED", message: expect.not.stringContaining("numeric") });
    expect(model.fake.reason).toHaveBeenCalledTimes(2);
  });

  it.each(["missing-index", "missing-beat", "invalid-beat", "too-short-opening", "too-many-elements", "unknown-field"])("strictly rejects %s in the real SceneArchitect response", async kind => {
    const Vendor = vendorClass(); install(Vendor);
    const scene = structure(), middle = (scene.scenes as RequirementRecord[])[0]!;
    if (kind === "missing-index") delete middle.index;
    if (kind === "missing-beat") delete middle.emotionalBeat;
    if (kind === "invalid-beat") middle.emotionalBeat = "made-up";
    if (kind === "too-short-opening") requirementRecord(scene.opening, "opening").duration = 1;
    if (kind === "too-many-elements") middle.keyElements = ["车辆", "头盔", "护栏", "车灯"];
    if (kind === "unknown-field") scene.approved = true;
    const model = fakeModel(scene), engine = new RequirementDiscoveryEngine({ llmEngine: model.fake, timeoutMs: 1000, agentTimeoutMs: 100 });
    await expect(withRequirementContractScope(metadata(), () => (engine.discover as (value: unknown) => Promise<unknown>)(upstream)))
      .rejects.toThrow("REQUIREMENT_SCENE_UNVERIFIED");
    expect(model.fake.reason).toHaveBeenCalledTimes(2);
  });

  it("waits for original profile resolution before returning any downstream contract object", async () => {
    const Vendor = vendorClass(); install(Vendor);
    const vendor = new Vendor(), ready = deferred<RequirementRecord>(), meta = metadata();
    vendor.resolver = vi.fn(() => ready.promise);
    let finished = false;
    const running = withRequirementContractScope(meta, async () => {
      const result = await callConvert(vendor, discovery(), meta); finished = true; return result;
    });
    await Promise.resolve(); expect(finished).toBe(false);
    ready.resolve(original());
    const result = await running;
    expect(result.genre).toBe("自定义商品观察");
    expect(result.productionProfile).toEqual(original().productionProfile);
    expect(result.characters).toEqual(meta.characters);
    expect(vendor.resolver).toHaveBeenCalledTimes(1);
  });

  it("preserves a real resolver rejection and does not create a fallback contract", async () => {
    const Vendor = vendorClass(); install(Vendor);
    const vendor = new Vendor(), failure = new Error("fixture profile resolver failed"), meta = metadata();
    vendor.resolver = vi.fn(async () => { throw failure; });
    await expect(withRequirementContractScope(meta, () => callConvert(vendor, discovery(), meta))).rejects.toBe(failure);
    expect(meta._workloomRequirementContract).toBeUndefined();
    expect(vendor.resolver).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid cast before calling the original profile resolver", async () => {
    const Vendor = vendorClass(); install(Vendor);
    const vendor = new Vendor(), meta = metadata(); vendor.resolver = vi.fn(async () => original());
    delete meta.builtinCharacterSelection;
    await expect(withRequirementContractScope(meta, () => callConvert(vendor, discovery(), meta))).rejects.toThrow(/REQUIREMENT_/);
    expect(vendor.resolver).not.toHaveBeenCalled();
  });

  it("keeps overlapping projects and nested scopes separate, then rejects detached late calls", async () => {
    const Vendor = vendorClass(); install(Vendor);
    const vendor = new Vendor(), holds = [deferred<void>(), deferred<void>()];
    const run = (index: number, id: string) => {
      const meta = metadata(id, id);
      return withRequirementContractScope(meta, async () => { await holds[index]!.promise; return callConvert(vendor, discovery(id), meta); });
    };
    const a = run(0, "actor-A"), b = run(1, "actor-B");
    holds[1]!.resolve(); expect((await b).characters).toEqual(metadata("actor-B", "actor-B").characters);
    holds[0]!.resolve(); expect((await a).characters).toEqual(metadata("actor-A", "actor-A").characters);
    const outside = await callConvert(vendor, discovery(), metadata()); expect(outside).toBe(vendor.profile);
    const late = deferred<void>(); let detached!: Promise<unknown>;
    vendor.resolver = vi.fn(async () => vendor.profile);
    await withRequirementContractScope(metadata(), () => { detached = late.promise.then(() => callConvert(vendor, discovery(), metadata())); });
    late.resolve(); await expect(detached).rejects.toThrow("REQUIREMENT_SCOPE_CLOSED");
    expect(vendor.resolver).not.toHaveBeenCalled();
  });

  it("restores the outer authority after a nested scope fails", async () => {
    const Vendor = vendorClass(); install(Vendor);
    const vendor = new Vendor(), outer = metadata("outer", "外层人物"), inner = metadata("inner", "内层人物");
    await withRequirementContractScope(outer, async () => {
      expect((await callConvert(vendor, discovery("outer"), outer)).characters).toEqual(outer.characters);
      await expect(withRequirementContractScope(inner, async () => {
        expect((await callConvert(vendor, discovery("inner"), inner)).characters).toEqual(inner.characters);
        throw new Error("inner failed");
      })).rejects.toThrow("inner failed");
      expect((await callConvert(vendor, discovery("outer"), outer)).characters).toEqual(outer.characters);
    });
  });

  it("does not start SceneArchitect or any later agent after a detached run closes", async () => {
    const Vendor = vendorClass(); install(Vendor);
    const model = fakeModel(structure()), audienceResponse = deferred<{ success: boolean; data: unknown }>();
    model.fake.reasonStructured.mockImplementationOnce(() => audienceResponse.promise);
    const engine = new RequirementDiscoveryEngine({ llmEngine: model.fake, timeoutMs: 1000, agentTimeoutMs: 100 });
    let detached!: Promise<unknown>;
    await withRequirementContractScope(metadata(), () => { detached = (engine.discover as (input: unknown) => Promise<unknown>)(upstream); });
    audienceResponse.resolve({ success: true, data: discovery().audienceProfile });
    await expect(detached).rejects.toThrow("REQUIREMENT_SCOPE_CLOSED");
    expect(model.fake.reasonStructured).toHaveBeenCalledTimes(1);
    expect(model.fake.reason).not.toHaveBeenCalled();
  });

  it("preserves native behavior without a Studio scope and restores every method after final shared holder", async () => {
    const Vendor = vendorClass(), native = Vendor.prototype._convertDiscoveryToRequirementList;
    const releaseA = install(Vendor, true), releaseB = install(Vendor, true);
    const patched = Vendor.prototype._convertDiscoveryToRequirementList;
    releaseA(); releaseA(); expect(Vendor.prototype._convertDiscoveryToRequirementList).toBe(patched);
    expect(listSharedBridges().find(row => row.key === "test-requirement-contract")?.refs).toBe(1);
    const vendor = new Vendor(); expect(await callConvert(vendor, discovery(), metadata())).toBe(vendor.profile);
    expect(vendor._renderRequirementContract()).toBe("native contract");
    releaseB(); expect(Vendor.prototype._convertDiscoveryToRequirementList).toBe(native);
    expect(listSharedBridges().find(row => row.key === "test-requirement-contract")).toBeUndefined();
  });

  it("detects prototype tampering and refuses to silently restore an unowned replacement", () => {
    const Vendor = vendorClass(), release = install(Vendor), prototype = Vendor.prototype as unknown as RequirementRecord;
    const patched = prototype._renderRequirementContract, replacement = () => "tampered";
    prototype._renderRequirementContract = replacement;
    expect(() => assertRequirementContractBridge(prototype)).toThrow("REQUIREMENT_BRIDGE_CHANGED");
    expect(() => release()).toThrow("REQUIREMENT_BRIDGE_CHANGED");
    expect(prototype._renderRequirementContract).toBe(replacement);
    prototype._renderRequirementContract = patched;
    release(); release();
  });

  it("detects descriptor-only tampering and restores every original descriptor exactly", () => {
    const Vendor = vendorClass(), prototype = Vendor.prototype as unknown as RequirementRecord;
    const targets: Array<[RequirementRecord, string]> = [[prototype, "_convertDiscoveryToRequirementList"], [prototype, "_renderRequirementContract"],
      ...["discover", "_fastMode", "generateMarkdown"].map((key): [RequirementRecord, string] => [RequirementDiscoveryEngine.prototype, key])];
    const before = targets.map(([owner, key]) => Object.getOwnPropertyDescriptor(owner, key));
    const release = install(Vendor), patched = Object.getOwnPropertyDescriptor(prototype, "_renderRequirementContract")!;
    Object.defineProperty(prototype, "_renderRequirementContract", { ...patched, enumerable: !patched.enumerable });
    expect(() => assertRequirementContractBridge(prototype)).toThrow("REQUIREMENT_BRIDGE_CHANGED");
    expect(() => release()).toThrow("REQUIREMENT_BRIDGE_CHANGED");
    Object.defineProperty(prototype, "_renderRequirementContract", patched);
    release();
    for (const [index, [owner, key]] of targets.entries()) expect(Object.getOwnPropertyDescriptor(owner, key)).toEqual(before[index]);
  });

  it("rejects unknown source interfaces and does not leave a partial installed bridge", () => {
    const Vendor = vendorClass(), prototype = Vendor.prototype as unknown as RequirementRecord;
    const before = prototype._convertDiscoveryToRequirementList;
    expect(() => installRequirementContractBridge(prototype, { discover() {} })).toThrow("REQUIREMENT_VENDOR_UNAVAILABLE");
    expect(prototype._convertDiscoveryToRequirementList).toBe(before);
  });
});
