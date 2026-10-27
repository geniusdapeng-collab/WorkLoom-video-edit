import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { bindRequirementContract, requirementCast, type RequirementRecord, type RequirementContract } from "./requirement-contract.js";
import { preparePrdAuthority, type PrdMarketingAuthority } from "./prd-authority.js";

const require = createRequire(import.meta.url);
export const { PRDSchema } = require("../../../vendor/supermickey/hyperreality-system/engines/prd-generator/schema/prd-schema-v3.js") as { PRDSchema: RequirementRecord };
export const { PRDGenerator } = require("../../../vendor/supermickey/hyperreality-system/engines/prd-generator/prd-generator.js") as {
  PRDGenerator: { new (): RequirementRecord; prototype: RequirementRecord };
};
export function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

/** Synthetic files and fake model payloads only; no application DATA, credentials or network. */
export function prdFixture(name = "P1", durations = [8, 14, 8], characterCount = 1) {
  const workDir = mkdtempSync(path.join(realpathSync(os.tmpdir()), "wl-prd-authority-test-"));
  const scope = { tenantId: "tenant-test", workspaceId: "workspace-test", projectId: name, runId: `RUN-${name}`, attempt: 2 };
  const file = path.join(workDir, "gates", name, "attempt-2", "G1_DOSSIER.md");
  mkdirSync(path.dirname(file), { recursive: true });
  const raw = { facts: { schemaVersion: "workloom.marketing-facts/v1", issuer: "workloom.marketing-authority", scope,
    restrictions: ["不得虚构客户评价", "不得虚构竞品事实"],
    stages: [{ stage: "A1", facts: { claims: [{ id: "claim-1", text: "据测试媒体2026年报道的合成规格", source: "synthetic source" }] },
      supportReview: { status: "passed", score: 88, issues: ["仅支持媒体报道归因"], suggestions: ["注明报道日期与封闭场地用途；未知外观不得臆测"] } }] } };
  const content = JSON.stringify(raw);
  writeFileSync(file, content);
  const marketing: PrdMarketingAuthority = {
    schemaVersion: "workloom.prd-marketing-authority/v1", scope,
    g1Artifact: { path: file, sha256: digest(content), content },
    g1Proof: { gate: "G1_DOSSIER", approved: true, status: "passed", via: "llm", degraded: false, model: "synthetic-reviewed-model",
      evidence: [{ path: file, sha256: digest(content), scope: "complete-text" }], issues: ["保留完整原始意见"], suggestions: ["限定媒体归因"] }
  };
  const profileSha256 = "a".repeat(64), registrySha256 = "b".repeat(64);
  const metadata: RequirementRecord = {
    brief: { product: "合成商品", audience: "原始年轻消费者", description: `完整创作原文-${name}-${"完整目的".repeat(80)}`,
      duration: durations.reduce((a, b) => a + b, 0), aspectRatio: "9:16", platform: "douyin",
      productionRequirements: { resolution: "1080p", frameRate: 30, subtitleMode: "both", nativeAudio: true, openWithCover: false, titleCard: false, durationToleranceFrames: 1 } },
    characters: [{ id: "builtin-person", character_id: "builtin-person", name: "合成人物", role: "主角", personality: "人物语气完整保留", portraitVersion: 2,
      builtinCharacterSource: { profilePath: "/synthetic/profile.json", profileSha256, registrySha256 } }],
    builtinCharacterSelection: { schemaVersion: "workloom.video-character-selection/v1", mode: "builtin", registrySha256,
      characters: [{ id: "builtin-person", name: "合成人物", source: "builtin", profilePath: "/synthetic/profile.json", profileSha256, selectedVersion: 2 }] },
    hasPerson: true, noCharacters: false
  };
  const originalCharacter = (metadata.characters as RequirementRecord[])[0]!;
  const selection = metadata.builtinCharacterSelection as RequirementRecord;
  const originalChoice = (selection.characters as RequirementRecord[])[0]!;
  metadata.characters = Array.from({ length: characterCount }, (_, index) => ({ ...structuredClone(originalCharacter),
    id: characterCount === 1 ? "builtin-person" : `builtin-person-${index + 1}`,
    character_id: characterCount === 1 ? "builtin-person" : `builtin-person-${index + 1}`,
    name: characterCount === 1 ? "合成人物" : `合成人物${index + 1}` }));
  selection.characters = (metadata.characters as RequirementRecord[]).map(character => ({ ...structuredClone(originalChoice), id: character.id, name: character.name }));
  selection.mode = characterCount ? "builtin" : "none";
  metadata.hasPerson = characterCount > 0; metadata.noCharacters = characterCount === 0;
  const node = (duration: number, index: number) => ({ duration, purpose: `完整场景目的${index}：人物观察合成商品并完成可见动作`, keyElements: ["合成商品", "合成人物"],
    productionContract: { props: [{ name: "合成商品", description: "封闭拍摄场地中实际可见的合成商品" }],
      actions: characterCount ? (metadata.characters as RequirementRecord[]).map(character => ({ actorId: character.id, description: "合成人物沿着商品边缘观察并轻轻点头" }))
        : [{ actorId: "$scene", description: "封闭场地中商品边缘的光线逐渐变化" }] } });
  const nodes = durations.map(node);
  const upstream = { type: "商业广告", theme: `合成主题-${name}`, duration_sec: durations.reduce((a, b) => a + b, 0), target_audience: "未映射受众", description: "合成创意" };
  const discovery: RequirementRecord = { upstreamFields: upstream,
    sceneStructure: { sceneCount: durations.length, totalDuration: upstream.duration_sec, narrativeArc: "setup→climax→resolution", opening: nodes[0], scenes: nodes.slice(1, -1), ending: nodes.at(-1) },
    audienceProfile: { primaryAudience: { ageRange: "25-30", gender: "male", interestTags: [] } }, referenceCases: { filmReferences: [], styleReferences: [] } };
  const list = bindRequirementContract({ keyPoints: [] }, discovery, upstream, structuredClone(metadata), requirementCast(metadata).hash, "原始年轻消费者");
  const contract = list._workloomRequirementContract as RequirementContract;
  const creative = { coreTheme: "具体合成物象之间形成可验证的叙事张力", creativeHook: "第一帧人物观察商品，观众因此想知道下一步动作", emotionalArc: "setup→climax→resolution",
    keyMessages: ["P0: 只有这次合成故事能够表达的信息"], twistPoint: "", endingType: "闭合式" };
  const production = {
    visualSpecification: { primaryStyle: "广告级商业", colorPalette: { dominant: "冷灰", accent: "暖色", mood: "自然" }, lightingDirection: "自然侧光照亮封闭拍摄场地的商品",
      cameraLanguage: "稳定中景跟随合成人物观察商品的动作", visualReferences: ["合成构图参考"], textureQuality: "写实", specialVisualEffects: [] },
    audioSpecification: { musicStyle: "保持安静的现场声音，不额外添加音乐", soundDesign: "保留封闭场地环境音和人物动作声音", voicePolicy: "环境音为主", audioMood: "自然克制的现场声音氛围", audioReferences: [] },
    characterSystem: { characters: contract.cast.characters.map(character => ({ characterId: String(character.id), name: String(character.name), role: "主角", ageRange: "青年", appearance: "沿用本次已选人物的完整外貌档案", personality: "沿用人物克制直接的表达方式",
      costume: "沿用当前拍摄服装保持一致", portraitPath: "", consistencyRequirements: "保持人物外貌服装与本次已选版本一致" })) },
    scenePlan: { scenes: contract.scenes.map((scene, index) => ({ sceneId: scene.id, sequence: index + 1, purpose: scene.purpose, duration: scene.duration,
      emotionalBeat: index === 0 ? "setup" : index === contract.scenes.length - 1 ? "resolution" : "climax", setting: "封闭拍摄场地", timeOfDay: "下午", keyProps: ["合成商品"], visualRequirements: ["保留真实物理结构"], audioRequirements: ["保留现场声音"], dialogue: "" })),
      shotMapping: contract.scenes.map(scene => ({ sceneId: scene.id, estimatedShots: 1, shotBreakdownHint: ["medium"] })) }
  };
  return { workDir, file, scope, content, marketing, metadata, discovery, list, contract, creative, production,
    authority: preparePrdAuthority({ metadata, marketing, workDir, projectId: name }),
    cleanup: () => rmSync(workDir, { recursive: true, force: true }) };
}
