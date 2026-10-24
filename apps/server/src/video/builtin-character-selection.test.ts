import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyBuiltinCharacters, appendBuiltinCharacterGuidance, resolveBuiltinCharacters } from "./builtin-character-selection.js";
import { builtinCatalogFixture } from "./builtin-character-selection.test-support.js";

let dir: string, fixture: ReturnType<typeof builtinCatalogFixture>;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "builtin-character-selection-")); fixture = builtinCatalogFixture(dir); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const resolve = (intent: string, metadata?: Record<string, unknown>) => resolveBuiltinCharacters(intent, metadata, { bundleRoot: fixture.bundleRoot });
describe("video服务实际消费受控默认角色", () => {
  it.each([undefined, {}, { characters: [] }, { character: "  " }, { character: null }])("空选择%j读取registry.defaultModel", metadata => {
    const result = resolve("制作一条30秒短片", metadata);
    expect(result.characters).toMatchObject([{ id: "young-rider-01", character_id: "young-rider-01", name: "李英子", ordinal: 1, role: "protagonist" }]);
    expect(result.decision.characters[0]).toMatchObject({ source: "builtin", profileSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
  it.each(["使用1号模特拍短片", "一号模特出镜", "1号", "用英子拍短片", "李英子出镜"])('原文"%s"选择当前1号', intent => expect(resolve(intent).builtinIds).toEqual(["young-rider-01"]));
  it.each([{ character: { ordinal: 1 } }, { character: 1 }, { character: "1" }, { character: "default" }, { modelCharacter: "默认模特" }, { characterId: "young-rider-01" }, { brief: { characterName: "英子" } }])("显式选择%j使用同一个受控档案", metadata => expect(resolve("拍短片", metadata).builtinIds).toEqual(["young-rider-01"]));
  it.each([[{ character: { ordinal: 2, name: "陈卓" } }, "chen-zhuo", 2], [{ characters: [{ id: "chen-zhuo", name: "陈卓" }] }, "chen-zhuo", 2], [{ character: "3号模特" }, "lin-yu-an", 3], [{ characterName: "林予安" }, "lin-yu-an", 3]] as const)("显式2/3号%j不会被默认角色替换", (metadata, id, ordinal) => {
    expect(resolve("明确选用现有模特拍短片", structuredClone(metadata)).characters).toMatchObject([{ id, ordinal }]);
  });
  it("人物履历、语气与行为进入metadata和真实pipeline正文，而不冒充商品事实", () => {
    const selected = resolve("英子出镜");
    const metadata = applyBuiltinCharacters({ modelId: "doubao-seedance-2-5", brief: { product: "本次车型" } }, selected);
    expect(metadata.characters).toMatchObject([{ persona: { interests: ["极限运动"] }, biography: fixture.profiles[0]!.biography,
      speakingStyle: fixture.profiles[0]!.speakingStyle, behavioralRules: fixture.profiles[0]!.behavioralRules }]);
    expect(metadata.modelId).toBe("doubao-seedance-2-5");
    const intent = appendBuiltinCharacterGuidance("原始需求", selected);
    expect(intent).toContain("大学在读"); expect(intent).toContain("极限运动"); expect(intent).toContain("不是现实赛事履历");
    expect(intent).toContain("不得当成真人履历、品牌实测、产品性能证据或赛事成绩");
    expect(intent).toContain(selected.decision.characters[0]!.profileSha256);
  });
  it("当前人物库嵌套persona的说话习惯与连续性行为原样进入角色合同", () => {
    const profile = fixture.profiles[0]! as unknown as Record<string, unknown>;
    const speakingStyle = { relationship: "像同学聊天", avoid: ["冒充真实品牌测评"] };
    const behavioralRules = ["20岁成年在读大学生", "运动场景先检查装备"];
    delete profile.speakingStyle; delete profile.behavioralRules;
    profile.persona = { ...(profile.persona as Record<string, unknown>), speakingStyle, continuityRules: behavioralRules };
    fixture.save();
    const selected = resolve("英子出镜");
    expect(selected.characters[0]).toMatchObject({ speakingStyle, behavioralRules, persona: { speakingStyle, continuityRules: behavioralRules } });
    expect(appendBuiltinCharacterGuidance("原始需求", selected)).toContain("运动场景先检查装备");
  });
  it("明确w1按当前档案验证并传入实际角色合同，完整已有档案仍可再次解析", () => {
    const result = resolve("英子讲述", { characters: [{ id: "young-rider-01", wardrobeId: "w1" }] });
    expect(result.characters[0]).toMatchObject({ activeWardrobeId: "w1", wardrobeId: "w1", wardrobe: fixture.profiles[0]!.wardrobe });
    expect(resolve("英子讲述", applyBuiltinCharacters({}, result)).characters).toEqual(result.characters);
  });
  it.each([{ wardrobeId: "missing-wardrobe" }, { wardrobeId: "w1", activeWardrobeId: "missing-wardrobe" },
    { wardrobeId: 1 }, { wardrobe: { id: "w1", name: "红裙" } }])("显式服装%j不符时失败，不用w1静默补位", wardrobe => {
    expect(() => resolve("英子讲述", { character: { id: "young-rider-01", ...wardrobe } })).toThrow("服装");
  });
  it.each([{ character: { id: "young-rider-01", name: "陈卓" } }, { characterOrdinal: 1, characterName: "陈卓" }, { character: "unknown-id" }, { characterOrdinal: 99 }, { characterOrdinal: "bad" }, { character: true }])("非法或冲突选择%j失败，不回退默认", metadata => expect(() => resolve("拍短片", metadata)).toThrow());
  it("原文与metadata身份冲突失败，否定旧人物的原文不会误当作选用旧人物", () => {
    expect(() => resolve("1号模特出镜", { characterName: "陈卓" })).toThrow("冲突");
    expect(resolve("不要陈卓，用1号模特").builtinIds).toEqual(["young-rider-01"]);
  });
  it.each(["陈卓在山顶看风景", "陈卓走过山间，穿插风景空镜", "用2号拍一条风景短片"])("明确人名或编号在%s中不被风景启发式覆盖", intent => {
    expect(resolve(intent).builtinIds).toEqual(["chen-zhuo"]);
  });
  it.each(["纯产品镜头，不要人物", "全片无人，只拍机车", "赛道空镜", "no people, product-only"])("明确无人%j不注入默认人物", intent => {
    const result = resolve(intent);
    expect(result.mode).toBe("none"); expect(applyBuiltinCharacters({}, result)).toMatchObject({ characters: [], hasPerson: false, noCharacters: true });
  });
  it("无人元数据/原文与具体人选硬冲突；无人机并非无人指令", () => {
    expect(() => resolve("纯产品镜头", { character: "英子" })).toThrow("冲突");
    expect(() => resolve("陈卓出镜，纯产品片")).toThrow("冲突");
    expect(() => resolve("短片", { subject: { hasPerson: false }, characterOrdinal: 1 })).toThrow("冲突");
    expect(resolve("无人机跟拍模特").mode).toBe("builtin");
  });
  it("完整自定义剧情角色保持原路径，不悄悄加内置人物；未知仅ID仍拒绝", () => {
    const custom = { id: "original-story-hero", name: "小岚", description: "原创剧情里的成年女主，短发、绿色风衣，语气克制。", persona: { tone: "克制" } };
    const result = resolve("原创剧情人物出镜", { characters: [custom], character: { id: custom.id } });
    expect(result.mode).toBe("custom"); expect(result.builtinIds).toEqual([]); expect(result.characters).toMatchObject([custom]);
    expect(() => resolve("原创剧情", { characters: [{ id: custom.id, name: custom.name }] })).toThrow("未找到");
  });
  it("完整多人名单逐人解析，主角单独字段必须属于名单", () => {
    const result = resolve("陈卓与林予安同框", { characters: [{ id: "chen-zhuo" }, { id: "lin-yu-an" }], characterId: "chen-zhuo" });
    expect(result.builtinIds).toEqual(["chen-zhuo", "lin-yu-an"]);
    expect(() => resolve("双人片", { characters: [{ id: "chen-zhuo" }, { id: "lin-yu-an" }], characterOrdinal: 1 })).toThrow("冲突");
    expect(resolve("双人片", { characters: [{ id: "chen-zhuo" }, { id: "lin-yu-an" }], characterId: "lin-yu-an" }).characters[0]).toMatchObject({ id: "lin-yu-an", role: "protagonist" });
    expect(() => resolve("双人片", { characters: [{ id: "chen-zhuo" }, { id: "lin-yu-an" }], characterId: "chen-zhuo", brief: { characterId: "lin-yu-an" } })).toThrow("不同人物");
  });
  it.each(["missing-profile", "profile-mismatch", "duplicate-ordinal", "ambiguous-alias", "tampered-profile", "symlink-profile", "missing-active-wardrobe"])("目录问题%s在任何供应商之前失败关闭", kind => {
    if (kind === "missing-profile") rmSync(fixture.profilePaths[0]!);
    if (kind === "profile-mismatch") { fixture.profiles[0]!.id = "wrong-id"; fixture.save(); }
    if (kind === "duplicate-ordinal") { fixture.registry.models[1]!.ordinal = 1; fixture.save(); }
    if (kind === "ambiguous-alias") { fixture.registry.models[1]!.aliases.push("英子"); fixture.save(); }
    if (kind === "tampered-profile") writeFileSync(fixture.profilePaths[0]!, "tampered");
    if (kind === "symlink-profile") { const original = readFileSync(fixture.profilePaths[0]!); const outside = path.join(dir, "outside.json"); writeFileSync(outside, original); rmSync(fixture.profilePaths[0]!); symlinkSync(outside, fixture.profilePaths[0]!); }
    if (kind === "missing-active-wardrobe") { fixture.profiles[0]!.activeWardrobeId = "missing-wardrobe"; fixture.save(); }
    expect(() => resolve("制作短片")).toThrow("内置角色目录不可核实");
  });
});
