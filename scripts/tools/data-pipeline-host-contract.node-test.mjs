import assert from "node:assert/strict";
import test from "node:test";
import { gateDeterministicChecks } from "../../apps/server/src/video/gate-policy.ts";
import { normalizeMarketingDossierPresentation } from "../../apps/server/src/video/marketing-dossier-normalization.ts";
import { narrativeThemeInputForRoute } from "../../packages/video-studio/src/requirement-contract-bridge.ts";
import { projectDeclaredFields } from "../../packages/video-studio/src/requirement-contract.ts";
import { normalizeNarrativePrdContract } from "../../packages/video-studio/src/narrative-prd-contract.ts";
import { normalizeCreativeThemeContract } from "../../packages/video-studio/src/creative-theme-contract.ts";
import { sourceDocument, SOURCE_MAX_TEXT_CHARS } from "../../apps/server/src/video/marketing-source-fetcher.ts";
import { supportReviewFacts } from "../../apps/server/src/video/marketing-authority.ts";

test("narrative route bypasses vendor marketing copy while marketing keeps it", () => {
  assert.equal(narrativeThemeInputForRoute("城市空镜", {
    brief: { platform: "抖音" },
    pipelineRoute: { kind: "narrative" },
  }), "城市空镜");
  assert.equal(narrativeThemeInputForRoute("商品介绍", {
    brief: { product: "商品" },
    pipelineRoute: { kind: "marketing" },
  }), undefined);
});

test("G3 permits protocol null but still blocks real placeholder leakage", () => {
  const valid = ("合同\n```json\n" + JSON.stringify({ noPropsReason: "本场只有环境", optional: null }) + "\n```\n").repeat(4);
  assert.equal(gateDeterministicChecks("G3_INSIGHT", valid)
    .find((check) => check.id === "no-placeholder").pass, true);
  assert.equal(gateDeterministicChecks("G3_INSIGHT", `${valid}\nundefined [object Object]`)
    .some((check) => check.hard && !check.pass), true);
});

test("G4 permits null in parseable contract JSON while keeping prose closed", () => {
  const contract = ("# PRD\n```json\n" + JSON.stringify({ cast: { registryPath: null }, ownerAudience: null }) + "\n```\n").repeat(8);
  assert.equal(gateDeterministicChecks("G4_PRD", contract)
    .find((check) => check.id === "no-placeholder").pass, true);
  assert.equal(gateDeterministicChecks("G4_PRD", `${contract}\n字段值为 null`)
    .some((check) => check.hard && !check.pass), true);
});

test("strict RiskAssessor projection removes only undeclared top-level fields", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["technicalRisks", "businessConstraints", "mitigationSuggestions"],
    properties: {
      technicalRisks: { type: "array" },
      businessConstraints: { type: "array" },
      mitigationSuggestions: { type: "array" },
    },
  };
  assert.deepEqual(projectDeclaredFields({
    technicalRisks: ["风险"],
    businessConstraints: ["限制"],
    mitigationSuggestions: ["建议"],
    extra: "model chatter",
  }, schema), {
    technicalRisks: ["风险"],
    businessConstraints: ["限制"],
    mitigationSuggestions: ["建议"],
  });
});

test("narrative PRD cannot invent a second cast member or conflicting delivery thresholds", () => {
  const metadata = {
    pipelineRoute: { kind: "narrative" },
    customerOriginalIntent: "全片无人的城市空镜",
    brief: { duration: 30, aspectRatio: "9:16", platform: "抖音" },
    builtinCharacterSelection: { schemaVersion: "workloom.video-character-selection/v1", mode: "none", characters: [] },
    characters: [],
  };
  const result = normalizeNarrativePrdContract({
    productPositioning: {},
    characterSystem: { characters: [{ name: "擅自新增演员" }] },
    creativeCore: { keyMessages: ["字幕字号必须4%"] },
    scenePlan: { scenes: [], shotMapping: [] },
    visualSpecification: { cameraLanguage: "20秒内不超过4镜" },
    productionConstraints: { qualityThresholds: { visual: 0.8, audio: 0.75, narrative: 0.85, consistency: 0.75 } },
    deliveryStandard: { acceptanceCriteria: { visual: 0.7, audio: 0.7, narrative: 0.7, consistency: 0.7 } },
  }, metadata);
  assert.equal(result.applied, true);
  assert.deepEqual(result.prd.characterSystem.characters, []);
  assert.equal(result.prd.visualSpecification.cameraLanguage.includes("不超过4镜"), false);
  assert.deepEqual(result.prd.deliveryStandard.acceptanceCriteria, result.prd.productionConstraints.qualityThresholds);
  assert.equal(result.prd.creativeCore.keyMessages.join(" ").includes("字幕"), false);
});

test("creative theme strips people and unrequested film titles under the host contract", () => {
  const intent = "全片无人，仅使用抽象界面和示意图，给 Home Assistant 做一条面向开发者的介绍片";
  const result = normalizeCreativeThemeContract({
    _originalStoryText: intent,
    tasks: [{
      theme: "代码把家留在本地",
      tone: "冷酷精密、暗藏温度",
      description: "屏幕前的开发者转身完成配置。",
      protagonist: "开发者",
      shots: [{ shot: "人物转身" }],
      dialogue_requirement: "开发者口播",
      character_consistency: "保持造型",
      visual_style: "参考《Her》的界面柔光；屏幕自发光为主光。",
      special_notes: "只用官方仓库事实。",
      target_audience: "目标消费者/品牌受众",
    }],
  }, {
    pipelineRoute: { kind: "marketing" },
    customerOriginalIntent: intent,
    builtinCharacterSelection: { mode: "none" },
    brief: { product: "Home Assistant", duration: 30, aspectRatio: "9:16", platform: "抖音" },
    _dataDossier: { identity: { official_selling_points: [{ point: "local control and privacy first" }] } },
  });
  const task = result.result.tasks[0];
  assert.equal(task.protagonist, null);
  assert.deepEqual(task.shots, []);
  assert.doesNotMatch(task.description, /开发者|转身|屏幕前/);
  assert.equal(task.target_audience, "开发者（客户原文明确）");
  assert.equal(task.tone, "冷酷精密");
  assert.match(task.theme, /官方自述：local control and privacy first/);
  assert.doesNotMatch(task.description, /守住/);
  assert.equal(task.duration_sec, 30);
  assert.equal(Object.hasOwn(task, "brief_duration_source"), false);
  assert.doesNotMatch(task.visual_style, /《/);
  assert.match(task.special_notes, /local control and privacy first/);
});

test("bounded source text accepts publishable pages above the former 24k limit without truncation", () => {
  const text = "可核实正文\n".repeat(8_000);
  const parsed = sourceDocument(text, "text/plain", "https://source.example.com/").text;
  assert.equal(text.startsWith(parsed), true);
  assert.ok(parsed.length > 24_000);
  assert.ok(parsed.length <= SOURCE_MAX_TEXT_CHARS);
});

test("image angle claims are not sent as textual facts to support review", () => {
  const reviewed = supportReviewFacts("A1", {
    stage: "A1",
    status: "source_bound",
    payload: { identity: { name: "Twenty" }, images: [{ url: "https://source.example.com/logo.svg", page_url: "https://source.example.com/", angle: "品牌 Logo" }] },
    claims: [
      { claimId: "CL-text", stage: "A1", pointer: "/identity/name", value: "Twenty", sourceId: "SRC-1",
        textSha256: "a".repeat(64), quote: "Twenty", quoteStart: 0, quoteEnd: 6, status: "source-bound" },
      { claimId: "CL-image", stage: "A1", pointer: "/images/0/angle", value: "品牌 Logo", sourceId: "SRC-1",
        textSha256: "a".repeat(64), quote: "Twenty", quoteStart: 0, quoteEnd: 6, status: "source-bound" },
    ],
  });
  assert.deepEqual(reviewed.payload.images, []);
  assert.deepEqual(reviewed.claims.map((claim) => claim.pointer), ["/identity/name"]);
});

test("marketing dossier cards never claim zero official evidence when source-bound claims exist", () => {
  const result = normalizeMarketingDossierPresentation(
    {
      product_id: "P1",
      identity: {
        name: "Home Assistant",
        category: "开源家庭自动化平台",
        official_selling_points: [{ point: "本地控制与隐私优先", source_url: "https://github.com/home-assistant/core" }],
      },
      visual_assets: { images: [{ license_risk: "high" }] },
      gaps: [],
    },
    {
      brief_card: { sellingPoints: [], evidence_note: "卖点来自 0 条官方主张" },
      router_material: { product_kind: "physical" },
      portrait_manifest: {},
      prd_card: {},
      insight_card: {},
    },
    { name: "Home Assistant", category: "开源家庭自动化平台" },
  );
  assert.deepEqual(result.cards.brief_card.sellingPoints, ["本地控制与隐私优先"]);
  assert.match(result.cards.brief_card.evidence_note, /1 条来源绑定官方主张/);
  assert.equal(result.cards.router_material.product_kind, "digital");
  assert.equal(result.cards.portrait_manifest.needs_more_reference, true);
  assert.ok(result.cards.prd_card.compliance_redlines.length > 0);
  assert.ok(result.dossier.gaps.some((gap) => gap.includes("受众")));
});
