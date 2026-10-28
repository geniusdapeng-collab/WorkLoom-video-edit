import { symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { requirementRecord, validateRequirementSchema, type RequirementRecord } from "./requirement-contract.js";
import {
  authoritativeDelivery, authoritativeProduct, bindPrdProvenance, effectivePrdDeliverySchema, effectivePrdModelSchema, normalizeExplicitBriefDuration, normalizePrdProductionProfile,
  preparePrdAuthority, PrdAuthorityError, prdAuthorityPrompt, validatePrdDelivery, validatePrdModelPayload, validatePrdProduction
} from "./prd-authority.js";
import { PRDSchema, prdFixture } from "./prd-authority.test-support.js";

const fixtures: ReturnType<typeof prdFixture>[] = [];
function fixture(...args: Parameters<typeof prdFixture>) { const value = prdFixture(...args); fixtures.push(value); return value; }
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });

describe("shared explicit Brief duration", () => {
  it("leaves omission without a customer-authoritative default", () => {
    expect(normalizeExplicitBriefDuration(undefined)).toBeUndefined();
    expect(normalizePrdProductionProfile({ brief: {} })).toEqual({});
  });
  it.each([5, "5", 35, "35", "035", 30.5, "30.5", 180, "180.0"])("preserves the existing accepted value %j without rounding", value => {
    expect(normalizeExplicitBriefDuration(value)).toBe(Number(value));
    expect(normalizePrdProductionProfile({ brief: { duration: value } })).toEqual({ targetDuration: Number(value) });
  });
  it.each([null, false, true, [], {}, 0, -1, 4.999, 180.001, NaN, Infinity, -Infinity,
    "", " 35", "35 ", "35s", "3.5e1", "0x23", "35."].map(value => [value]))("rejects the same malformed explicit value %j", value => {
    expect(() => normalizeExplicitBriefDuration(value)).toThrow(PrdAuthorityError);
    expect(() => normalizeExplicitBriefDuration(value)).toThrow("PRD_PROFILE_INVALID: Brief 明确时长非法");
    expect(() => normalizePrdProductionProfile({ brief: { duration: value } })).toThrow("PRD_PROFILE_INVALID");
  });
  it("rejects objects without invoking a caller-controlled numeric conversion", () => {
    let converted = false;
    const value = { valueOf() { converted = true; throw new Error("must not run"); } };
    expect(() => normalizeExplicitBriefDuration(value)).toThrow(PrdAuthorityError);
    expect(converted).toBe(false);
  });
});

describe("PRD explicit production requirements", () => {
  it("normalizes the explicit platform without replacing the full client brief", () => {
    const value = fixture(), before = structuredClone(value.metadata);
    expect(normalizePrdProductionProfile(value.metadata)).toEqual({ targetDuration: 30, aspectRatio: "9:16", targetPlatform: "抖音",
      resolution: "1080p", frameRate: 30, subtitleMode: "both", nativeAudio: true, openWithCover: false, titleCard: false, durationToleranceFrames: 1 });
    expect(value.metadata).toEqual(before);
  });
  it("legacy briefs without the new object enforce only fields the client actually provided", () => {
    expect(normalizePrdProductionProfile({ brief: { product: "legacy product" } })).toEqual({});
    expect(normalizePrdProductionProfile({ brief: { duration: "30", aspectRatio: "9:16", platform: "douyin" } }))
      .toEqual({ targetDuration: 30, aspectRatio: "9:16", targetPlatform: "抖音" });
    const old = { productPositioning: { targetDuration: 52, aspectRatio: "16:9", targetPlatform: "通用", resolution: "4K", frameRate: 24 } };
    expect(authoritativeProduct(old, {})).toEqual(old);
    expect(authoritativeProduct(old, { aspectRatio: "9:16" })).toEqual({ productPositioning: { ...old.productPositioning, aspectRatio: "9:16" } });
  });
  it.each([
    { resolution: "8K" }, { resolution: "2K" }, { resolution: "720p" }, { frameRate: 29.97 }, { nativeAudio: "true" },
    { subtitleMode: "optional" }, { durationToleranceFrames: 2 }, { durationToleranceFrames: -1 }, { openWithCover: null }, { extra: true }
  ])("rejects malformed present requirements %j", patch => {
    const value = fixture(), brief = requirementRecord(value.metadata.brief, "brief");
    brief.productionRequirements = { ...requirementRecord(brief.productionRequirements, "requirements"), ...patch };
    expect(() => normalizePrdProductionProfile(value.metadata)).toThrow();
  });
  it.each([undefined, null, {}, { resolution: "1080p" }])("rejects a present incomplete object %j", productionRequirements => {
    expect(() => normalizePrdProductionProfile({ brief: { productionRequirements } })).toThrow();
  });
  it.each([{ duration: 0 }, { duration: 181 }, { duration: "30sec" }, { aspectRatio: "4:5" }, { platform: "constructor" }])("rejects incompatible explicit brief values %j", patch => {
    const value = fixture(); Object.assign(requirementRecord(value.metadata.brief, "brief"), patch);
    expect(() => normalizePrdProductionProfile(value.metadata)).toThrow();
  });
  it("does not promote the old PRD 4:3 declaration into a new formal CLI capability", () => {
    expect(normalizePrdProductionProfile({ brief: { aspectRatio: "4:3" } })).toEqual({ aspectRatio: "4:3" });
    const value = fixture(); requirementRecord(value.metadata.brief, "brief").aspectRatio = "4:3";
    expect(() => normalizePrdProductionProfile(value.metadata)).toThrow("PRD_PROFILE_INVALID");
  });
});

describe("PRD explicit separate cover and subtitle composition declarations", () => {
  const required = ["resolution", "frameRate", "subtitleMode", "nativeAudio", "openWithCover", "titleCard", "durationToleranceFrames"];
  function metadata(patch: RequirementRecord = {}) {
    const value = fixture(), brief = requirementRecord(value.metadata.brief, "brief");
    Object.assign(requirementRecord(brief.productionRequirements, "production requirements"), patch);
    return value.metadata;
  }
  it.each([
    { coverDelivery: "standalone" }, { coverDelivery: "none" },
    { sidecarPolicy: "dialogue-only" }, { sidecarPolicy: "dialogue-and-composite-ass" },
    { subtitleMode: "burned", persistentSubtitleText: "完整持续警示🙂" },
    { coverDelivery: "standalone", sidecarPolicy: "dialogue-and-composite-ass", persistentSubtitleText: "完整持续警示🙂" },
  ])("accepts each atomic declaration without inventing omitted declarations %j", patch => {
    const input = metadata(patch), before = structuredClone(input), profile = normalizePrdProductionProfile(input);
    expect(profile).toMatchObject(patch);
    for (const key of ["coverDelivery", "sidecarPolicy", "persistentSubtitleText"]) {
      if (!Object.hasOwn(patch, key)) expect(profile).not.toHaveProperty(key);
    }
    expect(input).toEqual(before);
  });
  it.each(required)("still requires the original %s when optional atoms are present", key => {
    const input = metadata({ coverDelivery: "none" });
    delete requirementRecord(requirementRecord(input.brief, "brief").productionRequirements, "production requirements")[key];
    expect(() => normalizePrdProductionProfile(input)).toThrow("PRD_PROFILE_INVALID");
  });
  it.each([
    { coverDelivery: undefined }, { coverDelivery: null }, { coverDelivery: true }, { coverDelivery: [] },
    { coverDelivery: "" }, { coverDelivery: "standalone " }, { coverDelivery: "cover" },
    { sidecarPolicy: undefined }, { sidecarPolicy: null }, { sidecarPolicy: false }, { sidecarPolicy: {} },
    { sidecarPolicy: "" }, { sidecarPolicy: "dialogue-only " }, { sidecarPolicy: "all" },
    { persistentSubtitleText: undefined }, { persistentSubtitleText: null }, { persistentSubtitleText: 1 },
    { persistentSubtitleText: [] }, { persistentSubtitleText: {} }, { persistentSubtitleText: "" }, { persistentSubtitleText: "   " },
    { unrelatedDeliveryField: true },
  ])("rejects a malformed present atom or unknown key %j", patch => {
    const input = metadata(patch), before = structuredClone(input);
    expect(() => normalizePrdProductionProfile(input)).toThrow(); expect(input).toEqual(before);
  });
  it("trims only the edges and counts Unicode code points without shortening the actual message", () => {
    const text = "警".repeat(119) + "🙂", input = metadata({ subtitleMode: "burned", persistentSubtitleText: `  ${text}  ` });
    const before = structuredClone(input), profile = normalizePrdProductionProfile(input);
    expect(profile.persistentSubtitleText).toBe(text); expect(Array.from(profile.persistentSubtitleText!)).toHaveLength(120);
    expect(normalizePrdProductionProfile(metadata({ subtitleMode: "burned", persistentSubtitleText: "甲  乙🙂" })).persistentSubtitleText).toBe("甲  乙🙂");
    expect(input).toEqual(before);
  });
  it.each([
    "警".repeat(120) + "🙂", "正文\n第二行", "正文\r", "正文\t", "正文\u0000", "正文\u007f", "正文\u0085", "正文\u2028", "正文\u2029",
    "\ud800", "\udc00", "正文\ud800结尾",
  ])("rejects overlong, multiline, control or invalid Unicode text %j before any media work", persistentSubtitleText => {
    expect(() => normalizePrdProductionProfile(metadata({ subtitleMode: "burned", persistentSubtitleText }))).toThrow("PRD_PROFILE_INVALID");
  });
  it("does not invoke a caller-controlled text conversion", () => {
    let converted = false;
    const persistentSubtitleText = { toString() { converted = true; throw new Error("must not convert"); } };
    expect(() => normalizePrdProductionProfile(metadata({ subtitleMode: "burned", persistentSubtitleText }))).toThrow();
    expect(converted).toBe(false);
  });
  it.each([
    { subtitleMode: "burned", sidecarPolicy: "dialogue-only" }, { subtitleMode: "none", sidecarPolicy: "dialogue-and-composite-ass" },
    { subtitleMode: "none", persistentSubtitleText: "完整持续警示" },
    { subtitleMode: "burned", persistentSubtitleText: "完整持续警示", titleCard: true },
    { subtitleMode: "burned", persistentSubtitleText: "完整持续警示", openWithCover: true },
    { subtitleMode: "both", persistentSubtitleText: "完整持续警示" },
    { subtitleMode: "sidecar", persistentSubtitleText: "完整持续警示" },
    { subtitleMode: "both", persistentSubtitleText: "完整持续警示", sidecarPolicy: "dialogue-only" },
    { subtitleMode: "sidecar", persistentSubtitleText: "完整持续警示", sidecarPolicy: "dialogue-only" },
  ])("fails closed on an explicitly contradictory combination %j", patch => {
    expect(() => normalizePrdProductionProfile(metadata(patch))).toThrow("PRD_PROFILE_INVALID");
  });
  it.each(["standalone", "none"])("keeps %s separate-cover delivery independent from embedding in the opening", coverDelivery => {
    expect(normalizePrdProductionProfile(metadata({ coverDelivery, openWithCover: true, titleCard: true })))
      .toMatchObject({ coverDelivery, openWithCover: true, titleCard: true });
  });
});

describe("PRD rule-owned delivery projection and legacy byte compatibility", () => {
  function standard() {
    return { deliveryStandard: {
      deliverables: [{ item: "video_master", spec: "MP4/H.265, 4K", priority: "required" }, { item: "audio_stems", spec: "原始可选分轨", priority: "optional" }],
      outputFormat: { container: "MP4", videoCodec: "H.265", audioCodec: "AAC" },
      acceptanceCriteria: { visual: 0.85, audio: 0.80, narrative: 0.90, consistency: 0.80 },
      revisionPolicy: { maxRevisions: 1, revisionScope: ["visual", "audio", "narrative"] },
      fallbackPlan: { trigger: "原始触发不改", action: "原始动作不改", expectedOutput: "原始预期不改" }, continuityCheckpoints: []
    } };
  }
  function declared(patch: RequirementRecord) {
    const value = fixture(); Object.assign(requirementRecord(requirementRecord(value.metadata.brief, "brief").productionRequirements, "requirements"), patch);
    return normalizePrdProductionProfile(value.metadata);
  }
  function deliveryParts(schema: RequirementRecord) {
    const properties = requirementRecord(schema.properties, "projection properties"), deliverables = requirementRecord(properties.deliverables, "deliverables schema");
    const item = requirementRecord(requirementRecord(requirementRecord(deliverables.items, "deliverable item").properties, "item fields").item, "item enum");
    return { properties, deliverables, item, output: requirementRecord(properties.outputFormat, "output schema") };
  }
  it("keeps the exact former normalized profile and delivery bytes when the three new keys are omitted", () => {
    const value = fixture(), profile = normalizePrdProductionProfile(value.metadata), original = standard(), before = structuredClone(original);
    const expectedProfile = { targetDuration: 30, aspectRatio: "9:16", targetPlatform: "抖音", resolution: "1080p", frameRate: 30,
      subtitleMode: "both", nativeAudio: true, openWithCover: false, titleCard: false, durationToleranceFrames: 1 };
    const expected = standard();
    expected.deliveryStandard.deliverables[0]!.spec = "MP4/H.265, 1080p; targetDuration=30; aspectRatio=9:16; targetPlatform=抖音; resolution=1080p; frameRate=30; subtitleMode=both; nativeAudio=true; openWithCover=false; titleCard=false; durationToleranceFrames=1; delivery declaration, native capability verified separately";
    expected.deliveryStandard.deliverables.push({ item: "subtitle_burned", spec: "字幕烧录进本次视频母版", priority: "required" },
      { item: "subtitle_sidecar", spec: "交付与视频时间线一致的独立字幕文件", priority: "required" });
    Object.assign(expected.deliveryStandard.outputFormat, expectedProfile);
    expect(JSON.stringify(profile)).toBe(JSON.stringify(expectedProfile));
    expect(JSON.stringify(authoritativeDelivery(original, profile))).toBe(JSON.stringify(expected)); expect(original).toEqual(before);
    expect(() => validatePrdDelivery({ legacy: "not a new projection" }, profile, PRDSchema)).not.toThrow();
  });
  it("enumerates a required independent cover and distinguishes dialogue sidecars from the full persistent ASS composition", () => {
    const text = "仅限封闭场地展示🙂", profile = declared({ coverDelivery: "standalone", sidecarPolicy: "dialogue-and-composite-ass", persistentSubtitleText: text });
    const original = standard(), before = structuredClone(original), final = authoritativeDelivery(original, profile), delivery = requirementRecord(final.deliveryStandard, "delivery");
    const items = delivery.deliverables as RequirementRecord[];
    expect(items.filter(item => item.item === "cover")).toEqual([expect.objectContaining({ priority: "required", spec: expect.stringMatching(/PNG(?:或|\/)JPEG/) })]);
    expect(items.filter(item => item.item === "subtitle_burned")).toHaveLength(1); expect(items.filter(item => item.item === "subtitle_sidecar")).toHaveLength(1);
    const burned = String(items.find(item => item.item === "subtitle_burned")!.spec), sidecar = String(items.find(item => item.item === "subtitle_sidecar")!.spec);
    expect(burned).toContain(text); expect(sidecar).toContain(text);
    for (const token of ["SRT", "VTT", "ASS"]) expect(sidecar).toContain(token);
    expect(sidecar).toContain("complete-composition"); expect(delivery.outputFormat).toMatchObject(profile);
    for (const key of ["acceptanceCriteria", "revisionPolicy", "fallbackPlan", "continuityCheckpoints"]) expect(delivery[key]).toEqual(before.deliveryStandard[key as keyof typeof before.deliveryStandard]);
    expect(original).toEqual(before); expect(() => validatePrdDelivery(final, profile, PRDSchema)).not.toThrow();
  });
  it.each(["standalone", "none"])("a cover-only %s declaration preserves the exact former subtitle specs without inventing a sidecar or persistent policy", coverDelivery => {
    const profile = declared({ coverDelivery }), result = authoritativeDelivery(standard(), profile), delivery = requirementRecord(result.deliveryStandard, "delivery");
    const items = delivery.deliverables as RequirementRecord[];
    expect(items.filter(item => item.item === "subtitle_burned" || item.item === "subtitle_sidecar")).toEqual([
      { item: "subtitle_burned", spec: "字幕烧录进本次视频母版", priority: "required" },
      { item: "subtitle_sidecar", spec: "交付与视频时间线一致的独立字幕文件", priority: "required" },
    ]);
    for (const key of ["sidecarPolicy", "persistentSubtitleText"]) {
      expect(profile).not.toHaveProperty(key); expect(delivery.outputFormat).not.toHaveProperty(key);
    }
    expect(items.filter(item => item.item === "cover")).toHaveLength(coverDelivery === "standalone" ? 1 : 0);
    expect(() => validatePrdDelivery(result, profile, PRDSchema)).not.toThrow();
  });
  it.each([
    { patch: { coverDelivery: "none" }, added: 2, admitted: ["subtitle_burned", "subtitle_sidecar"], excluded: ["cover"] },
    { patch: { coverDelivery: "standalone", subtitleMode: "none" }, added: 1, admitted: ["cover"], excluded: ["subtitle_burned", "subtitle_sidecar"] },
    { patch: { coverDelivery: "standalone", sidecarPolicy: "dialogue-only" }, added: 3, admitted: ["cover", "subtitle_burned", "subtitle_sidecar"], excluded: [] },
  ])("extends only the current declaration's narrow item/output schema $patch", ({ patch, added, admitted, excluded }) => {
    const profile = declared(patch), nativeBefore = structuredClone(PRDSchema), nativeHash = JSON.stringify(PRDSchema);
    const nativeDelivery = requirementRecord(requirementRecord(PRDSchema.properties, "native properties").deliveryStandard, "native delivery");
    const nativeParts = deliveryParts(nativeDelivery), schema = effectivePrdDeliverySchema(PRDSchema, profile), parts = deliveryParts(schema);
    expect(schema).toMatchObject({ type: "object", required: ["deliverables", "outputFormat"], additionalProperties: false });
    expect(Object.keys(parts.properties).sort()).toEqual(["deliverables", "outputFormat"]);
    expect(nativeParts.item.enum).toEqual(["video_master", "character_portraits", "script_document", "shot_list", "audio_stems", "prompt_log"]);
    expect(parts.deliverables.maxItems).toBe(Number(nativeParts.deliverables.maxItems) + added);
    for (const item of admitted) expect(parts.item.enum).toContain(item);
    for (const item of excluded) expect(parts.item.enum).not.toContain(item);
    expect(parts.output).toMatchObject({ additionalProperties: false });
    const result = authoritativeDelivery(standard(), profile), delivery = requirementRecord(result.deliveryStandard, "delivery");
    expect(() => validateRequirementSchema({ deliverables: delivery.deliverables, outputFormat: delivery.outputFormat }, schema, "delivery projection")).not.toThrow();
    expect(PRDSchema).toEqual(nativeBefore); expect(JSON.stringify(PRDSchema)).toBe(nativeHash);
    requirementRecord(parts.properties.outputFormat, "cloned output").unrelated = true;
    expect(PRDSchema).toEqual(nativeBefore);
  });
  it.each(["missing-cover", "duplicate-cover", "changed-cover-spec", "missing-burned", "changed-sidecar-spec", "unknown-item", "item-extra", "output-extra", "output-value"])("rejects a changed %s projection instead of repairing it", mode => {
    const profile = declared({ coverDelivery: "standalone", sidecarPolicy: "dialogue-and-composite-ass", persistentSubtitleText: "完整持续警示" });
    const result = authoritativeDelivery(standard(), profile), delivery = requirementRecord(result.deliveryStandard, "delivery"), items = delivery.deliverables as RequirementRecord[];
    if (mode === "missing-cover") delivery.deliverables = items.filter(item => item.item !== "cover");
    if (mode === "duplicate-cover") items.push(structuredClone(items.find(item => item.item === "cover")!));
    if (mode === "changed-cover-spec") items.find(item => item.item === "cover")!.spec = "只有视频，没有独立封面";
    if (mode === "missing-burned") delivery.deliverables = items.filter(item => item.item !== "subtitle_burned");
    if (mode === "changed-sidecar-spec") items.find(item => item.item === "subtitle_sidecar")!.spec = "只有台词SRT，不含持续全文";
    if (mode === "unknown-item") items.push({ item: "invented_media", spec: "不能发明", priority: "required" });
    if (mode === "item-extra") items[0]!.alreadyRendered = true;
    if (mode === "output-extra") requirementRecord(delivery.outputFormat, "output").alreadyVerified = true;
    if (mode === "output-value") requirementRecord(delivery.outputFormat, "output").persistentSubtitleText = "被替换的警示";
    const before = structuredClone(result);
    expect(() => validatePrdDelivery(result, profile, PRDSchema)).toThrow(); expect(result).toEqual(before);
  });
  it("rejects an independent cover that was explicitly disabled", () => {
    const profile = declared({ coverDelivery: "none" }), result = authoritativeDelivery(standard(), profile), delivery = requirementRecord(result.deliveryStandard, "delivery");
    expect((delivery.deliverables as RequirementRecord[]).some(item => item.item === "cover")).toBe(false);
    (delivery.deliverables as RequirementRecord[]).push({ item: "cover", spec: "PNG/JPEG", priority: "required" });
    expect(() => validatePrdDelivery(result, profile, PRDSchema)).toThrow();
  });
});

describe("PRD private accepted current G1", () => {
  it("preserves every original nested review, issue, suggestion and complete byte identity", () => {
    const value = fixture();
    expect(value.authority.marketing.g1Artifact.content).toBe(value.content);
    expect(value.authority.marketing.g1Proof.suggestions).toEqual(["限定媒体归因"]);
    const prompt = prdAuthorityPrompt(value.authority, value.contract);
    for (const text of [value.content, JSON.stringify(value.metadata.brief), "仅支持媒体报道归因", "原始年轻消费者", "非阻断的创意建议仍为建议", "完整原始意见"]) expect(prompt).toContain(text);
    value.marketing.g1Proof.model = "caller-mutated";
    expect(value.authority.marketing.g1Proof.model).toBe("synthetic-reviewed-model");
  });
  it.each(["wrong-project", "old-attempt", "old-run", "degraded", "missing-evidence", "partial-evidence", "wrong-hash", "wrong-file", "file-changed"])("rejects %s", kind => {
    const value = fixture(), proof = structuredClone(value.marketing);
    if (kind === "wrong-project") proof.scope.projectId = "other";
    if (kind === "old-attempt") proof.scope.attempt++;
    if (kind === "old-run") proof.scope.runId = "RUN-other";
    if (kind === "degraded") (proof.g1Proof as Record<string, unknown>).degraded = true;
    if (kind === "missing-evidence") proof.g1Proof.evidence = [];
    if (kind === "partial-evidence") proof.g1Proof.evidence = [{ ...proof.g1Proof.evidence[0]!, scope: "partial" as "complete-text" }];
    if (kind === "wrong-hash") proof.g1Artifact.sha256 = "0".repeat(64);
    if (kind === "wrong-file") proof.g1Artifact.path += ".other";
    if (kind === "file-changed") writeFileSync(value.file, value.content + " ");
    expect(() => preparePrdAuthority({ metadata: value.metadata, marketing: proof, workDir: value.workDir, projectId: "P1" })).toThrow();
  });
  it("rejects a G1 symlink even when its target has the expected bytes", () => {
    const value = fixture(), target = value.file + ".actual";
    writeFileSync(target, value.content); unlinkSync(value.file); symlinkSync(target, value.file);
    expect(() => preparePrdAuthority({ metadata: value.metadata, marketing: value.marketing, workDir: value.workDir, projectId: "P1" })).toThrow("PRD_G1_CHANGED");
  });
});

describe("PRD real model response and provenance", () => {
  it("derives the bare creative shape and exact four production modules without mutating native constraints", () => {
    const value = fixture(), before = structuredClone(PRDSchema), contractBefore = structuredClone(value.contract);
    const creative = effectivePrdModelSchema("creative", PRDSchema, value.contract);
    expect(creative).toEqual(requirementRecord(PRDSchema.properties, "native properties").creativeCore);
    expect(creative).not.toHaveProperty("properties.creativeCore");
    const modules = ["visualSpecification", "audioSpecification", "characterSystem", "scenePlan"];
    const properties = requirementRecord(PRDSchema.properties, "native properties");
    const expected: RequirementRecord = { type: "object", required: modules,
      properties: Object.fromEntries(modules.map(key => [key, structuredClone(properties[key])])), additionalProperties: false };
    const expectedProperties = requirementRecord(expected.properties, "expected properties");
    const scenes = requirementRecord(requirementRecord(expectedProperties.scenePlan, "scene schema").properties, "scene properties").scenes as RequirementRecord;
    scenes.minItems = value.contract.scenes.length; scenes.maxItems = value.contract.scenes.length;
    delete (requirementRecord(requirementRecord(scenes.items, "scene item").properties, "scene fields").purpose as RequirementRecord).maxLength;
    const characters = requirementRecord(requirementRecord(expectedProperties.characterSystem, "cast schema").properties, "cast properties").characters as RequirementRecord;
    characters.minItems = value.contract.cast.characters.length; characters.maxItems = value.contract.cast.characters.length;
    const production = effectivePrdModelSchema("production", PRDSchema, value.contract);
    expect(production).toEqual(expected);
    expect(PRDSchema).toEqual(before); expect(value.contract).toEqual(contractBefore);
    requirementRecord(creative.properties, "creative properties").coreTheme = {};
    requirementRecord(production.properties, "production properties").visualSpecification = {};
    expect(PRDSchema).toEqual(before);
  });
  it.each([0, 6, 10])("exposes exactly the current %s selected people and ten scenes to the model schema", count => {
    const value = fixture(`SCHEMA-${count}`, [3, ...Array(8).fill(5), 3], count);
    const properties = requirementRecord(effectivePrdModelSchema("production", PRDSchema, value.contract).properties, "properties");
    const characters = requirementRecord(requirementRecord(properties.characterSystem, "cast").properties, "cast properties").characters;
    const scenes = requirementRecord(requirementRecord(properties.scenePlan, "plan").properties, "plan properties").scenes as RequirementRecord;
    expect(characters).toMatchObject({ minItems: count, maxItems: count });
    expect(scenes).toMatchObject({ minItems: 10, maxItems: 10 });
    expect(requirementRecord(requirementRecord(scenes.items, "item").properties, "fields").purpose).toEqual({ type: "string", minLength: 10 });
  });
  it.each([1, 5])("accepts the original visual reference boundary of %s items", count => {
    const value = fixture(); value.production.visualSpecification.visualReferences = Array(count).fill("合成构图参考");
    expect(() => validatePrdModelPayload(value.production, "production", PRDSchema, value.contract, value.authority.profile)).not.toThrow();
  });
  it.each([
    { label: "empty", references: [] }, { label: "six", references: Array(6).fill("合成构图参考") },
    { label: "missing", references: undefined }, { label: "not-array", references: "合成构图参考" }, { label: "wrong-item-type", references: [42] }
  ])("rejects illegal visualReferences $label without filling a reference", ({ references }) => {
    const value = fixture(), visual = value.production.visualSpecification as unknown as RequirementRecord;
    if (references === undefined) delete visual.visualReferences; else visual.visualReferences = references;
    const before = structuredClone(value.production);
    expect(() => validatePrdModelPayload(value.production, "production", PRDSchema, value.contract, value.authority.profile))
      .toThrow(references === undefined ? "visualSpecification 缺少必需字段" : "visualReferences");
    expect(value.production).toEqual(before);
  });
  it("accepts genuine payload structure and keeps full model creative sentences untouched", () => {
    const value = fixture();
    expect(validatePrdModelPayload(JSON.stringify(value.creative), "creative", PRDSchema, value.contract, value.authority.profile)).toEqual(value.creative);
    expect(validatePrdModelPayload(value.production, "production", PRDSchema, value.contract, value.authority.profile)).toEqual(value.production);
    const before = structuredClone(value.production), bound = bindPrdProvenance({ ...value.production, audienceProfile: { primaryAudience: { ageRange: "25-30", gender: "male" } } }, value.authority, value.contract);
    expect(value.production).toEqual(before);
    expect(requirementRecord(bound.characterSystem, "characters").characters).toEqual([expect.objectContaining({
      ...value.production.characterSystem.characters[0], _workloomCharacterSource: expect.objectContaining({ portraitVersion: 2 })
    })]);
    expect(requirementRecord(bound.scenePlan, "scenes").scenes).toEqual(value.production.scenePlan.scenes.map((scene, index) => ({ ...scene, _workloomRequirementScene: value.contract.scenes[index] })));
  });
  it.each(["missing-scene", "wrong-id", "wrong-order", "over-duration", "wrong-character", "invented-character", "wrong-mapping", "missing-module", "bad-enum"])("rejects %s without writing a repaired creative result", kind => {
    const value = fixture(), model = structuredClone(value.production);
    if (kind === "missing-scene") model.scenePlan.scenes.pop();
    if (kind === "wrong-id") model.scenePlan.scenes[0]!.sceneId = "unbound";
    if (kind === "wrong-order") model.scenePlan.scenes.reverse();
    if (kind === "over-duration") model.scenePlan.scenes[0]!.duration += 8;
    if (kind === "wrong-character") model.characterSystem.characters[0]!.characterId = "not-selected";
    if (kind === "invented-character") model.characterSystem.characters.push({ ...model.characterSystem.characters[0]! });
    if (kind === "wrong-mapping") model.scenePlan.shotMapping[0]!.sceneId = "other";
    if (kind === "missing-module") delete (model as Record<string, unknown>).audioSpecification;
    if (kind === "bad-enum") model.visualSpecification.primaryStyle = "unknown";
    const before = structuredClone(model);
    expect(() => validatePrdModelPayload(model, "production", PRDSchema, value.contract, value.authority.profile)).toThrow();
    expect(model).toEqual(before);
  });
  it("allows exactly one explicitly requested frame of deviation and rejects two", () => {
    const value = fixture(), model = structuredClone(value.production);
    model.scenePlan.scenes[0]!.duration += 1 / 30;
    expect(() => validatePrdProduction(model, value.contract, value.authority.profile)).not.toThrow();
    model.scenePlan.scenes[0]!.duration += 1 / 30;
    expect(() => validatePrdProduction(model, value.contract, value.authority.profile)).toThrow("PRD_SCENE_DURATION_CONFLICT");
  });
  it("preserves ten approved nodes and a long purpose without the obsolete PRD 8-node/200-character ceilings", () => {
    const value = fixture("P10", [3, ...Array(8).fill(5), 3]);
    value.production.scenePlan.scenes[0]!.purpose = "完整目的和动作不截断".repeat(60);
    expect(() => validatePrdModelPayload(value.production, "production", PRDSchema, value.contract, value.authority.profile)).not.toThrow();
  });
  it.each([0, 6, 10])("accepts exactly the actual host selection of %s people, without the old five-person cap", count => {
    const value = fixture("CAST", [8, 14, 8], count);
    expect(value.production.characterSystem.characters).toHaveLength(count);
    expect(() => validatePrdModelPayload(value.production, "production", PRDSchema, value.contract, value.authority.profile)).not.toThrow();
  });
  it("overrides only declared rule fields and delivers both subtitle forms", () => {
    const value = fixture(), original = { deliveryStandard: { deliverables: [{ item: "video_master", spec: "MP4/H.265, 4K", priority: "required" }],
      outputFormat: { container: "MP4", videoCodec: "H.265", audioCodec: "AAC" }, acceptanceCriteria: { visual: 0.75 } } };
    const final = authoritativeDelivery(original, value.authority.profile), standard = requirementRecord(final.deliveryStandard, "standard");
    expect(requirementRecord(standard.outputFormat, "output")).toMatchObject({ ...value.authority.profile, videoCodec: "H.265", audioCodec: "AAC" });
    expect(standard.acceptanceCriteria).toEqual({ visual: 0.75 });
    expect(standard.deliverables).toEqual([expect.objectContaining({ item: "video_master", spec: expect.stringContaining("1080p") }),
      expect.objectContaining({ item: "subtitle_burned", priority: "required" }), expect.objectContaining({ item: "subtitle_sidecar", priority: "required" })]);
    expect(original.deliveryStandard.deliverables[0]!.spec).toContain("4K");
  });
});
