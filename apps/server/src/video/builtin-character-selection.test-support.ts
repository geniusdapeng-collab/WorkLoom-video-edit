import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalBundleArtifactPayload, parseBundleManifest } from "../../../../packages/industry-contract/dist/index.js";

/** A small genuinely sealed candidate bundle: no loader mocks and no image/provider calls. */
export function builtinCatalogFixture(root: string) {
  const bundleRoot = path.join(root, "character-selection-bundles"), bundleDir = path.join(bundleRoot, "ai-video");
  const charactersDir = path.join(bundleDir, "library/characters"); mkdirSync(charactersDir, { recursive: true });
  const registry = { schemaVersion: "workloom.character-registry/v1", defaultModel: "young-rider-01", models: [
    { id: "young-rider-01", name: "李英子", ordinal: 1, aliases: ["英子", "1号模特", "一号模特"], archive: "bundles/ai-video/library/characters/model-01-young-rider" },
    { id: "chen-zhuo", name: "陈卓", ordinal: 2, aliases: ["卓卓"], archive: "bundles/ai-video/library/characters/model-01-chen-zhuo" },
    { id: "lin-yu-an", name: "林予安", ordinal: 3, aliases: ["予安"], archive: "bundles/ai-video/library/characters/model-02-lin-yu-an" },
  ] };
  const profiles = registry.models.map(model => ({ schemaVersion: "workloom.character-profile/v1", id: model.id, name: model.name,
    ordinal: model.ordinal, kind: model.id === "chen-zhuo" ? "authorized-real" : "generated",
    identity: { age: model.ordinal === 1 ? "约20岁成年大学生" : "成年女性", gender: "female" },
    appearance: { face: "鹅蛋脸", hair: model.ordinal === 1 ? "黑色高马尾" : "肩长深发" },
    wardrobe: [{ id: "w1", name: model.ordinal === 1 ? "机车夹克与长裤" : "原人物服装" }], activeWardrobeId: "w1",
    persona: { tone: "朝气、自信、友善", interests: ["极限运动"] }, biography: ["虚构的大学在读人物，热爱极限运动；不是现实赛事履历。"],
    speakingStyle: { pace: "清楚自然", vocabulary: "大学生日常表达" }, behavioralRules: ["讲风险边界，不虚构品牌实测或赛事成绩"],
    authorization: { status: model.id === "chen-zhuo" ? "real-authorized" : "synthetic-no-real-person" },
    portraitSets: [{ version: 1, dir: "portraits/v1", angles: ["front", "threeQuarter", "closeup", "side"], active: true }] }));
  const registryPath = path.join(charactersDir, "registry.json");
  const profilePaths = registry.models.map(model => path.join(bundleDir, model.archive.replace(/^bundles\/ai-video\//, ""), "profile.json"));
  const assetPaths = ["library/characters/registry.json", ...registry.models.map(model => `${model.archive.replace(/^bundles\/ai-video\//, "")}/profile.json`)];
  const template = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../../bundles/ai-video/bundle.json"), "utf8"));
  const save = () => {
    writeFileSync(registryPath, JSON.stringify(registry));
    profiles.forEach((profile, index) => { mkdirSync(path.dirname(profilePaths[index]!), { recursive: true }); writeFileSync(profilePaths[index]!, JSON.stringify(profile)); });
    const manifest = structuredClone(template);
    manifest.workloom.status = "candidate"; manifest.workloom.provides = { library: assetPaths };
    const assets = Object.fromEntries(assetPaths.map(asset => [asset, createHash("sha256").update(readFileSync(path.join(bundleDir, asset))).digest("hex")]));
    manifest.integrity = { algorithm: "sha256", digest: "0".repeat(64), assets };
    const normalized = parseBundleManifest(manifest);
    normalized.integrity!.digest = createHash("sha256").update(canonicalBundleArtifactPayload(normalized)).digest("hex");
    writeFileSync(path.join(bundleDir, "bundle.json"), JSON.stringify(normalized));
  };
  save();
  return { bundleRoot, bundleDir, registry, registryPath, profiles, profilePaths, save };
}
