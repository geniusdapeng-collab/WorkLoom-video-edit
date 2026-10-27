import { symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { requirementRecord } from "./requirement-contract.js";
import {
  authoritativeDelivery, authoritativeProduct, bindPrdProvenance, normalizePrdProductionProfile,
  preparePrdAuthority, prdAuthorityPrompt, validatePrdModelPayload, validatePrdProduction
} from "./prd-authority.js";
import { PRDSchema, prdFixture } from "./prd-authority.test-support.js";

const fixtures: ReturnType<typeof prdFixture>[] = [];
function fixture(...args: Parameters<typeof prdFixture>) { const value = prdFixture(...args); fixtures.push(value); return value; }
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });

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
