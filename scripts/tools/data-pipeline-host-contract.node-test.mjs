import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { appliedApprovalFeedback, gateDeterministicChecks } from "../../apps/server/src/video/gate-policy.ts";
import { customerRestrictionLines, normalizeMarketingDossierPresentation } from "../../apps/server/src/video/marketing-dossier-normalization.ts";
import { narrativeThemeInputForRoute } from "../../packages/video-studio/src/requirement-contract-bridge.ts";
import { normalizeDiscoveryTiming, productPropsPolicySatisfied, projectDeclaredFields } from "../../packages/video-studio/src/requirement-contract.ts";
import { normalizeNarrativePrdContract } from "../../packages/video-studio/src/narrative-prd-contract.ts";
import { normalizeCreativeThemeContract } from "../../packages/video-studio/src/creative-theme-contract.ts";
import { normalizeMarketingPrdContract } from "../../packages/video-studio/src/marketing-prd-contract.ts";
import { configureRequirementRetryPolicy } from "../../packages/video-studio/src/requirement-retry-policy.ts";
import {
  loadBookingSourceFixture,
  retryableMarketingSourceError,
  sourceDocument,
  SOURCE_MAX_TEXT_CHARS,
} from "../../apps/server/src/video/marketing-source-fetcher.ts";
import { requiresMarketingSupportReview, supportReviewFacts } from "../../apps/server/src/video/marketing-authority.ts";
import { filterUnsafeMarketingExtraction } from "../../apps/server/src/video/marketing-facts.ts";

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

test("approved gate suggestions never request an unreviewed artifact rewrite", () => {
  assert.deepEqual(appliedApprovalFeedback(true, ["建议再次优化"]), []);
  assert.deepEqual(appliedApprovalFeedback(false, ["修改字段 A", 7]), ["修改字段 A"]);
});

test("marketing PRD strips external references and binds no-person delivery limits", () => {
  const normalized = normalizeMarketingPrdContract({
    creativeCore: { creativeHook: "手指停住，秩序出现", keyMessages: ["落点 scene-3"], twistPoint: "第22秒" },
    visualSpecification: { cameraLanguage: "手部近景", visualReferences: ["《2001太空漫游》"] },
    audioSpecification: { musicStyle: "无旋律配乐", soundDesign: "低频", voicePolicy: "字幕+音乐" },
    scenePlan: { scenes: [
      { sceneId: "opening", visualRequirements: ["九个空心方块"] },
      { sceneId: "ending", visualRequirements: ["手部对齐"] },
    ], shotMapping: [] },
    productionConstraints: { technicalConstraints: ["HOME-HERO-001 调用（license_risk=h"], businessConstraints: ["设备轮廓语义锚点"], forbiddenElements: ["人物"], qualityThresholds: {} },
    audienceProfile: { emotionTriggers: ["第12秒手指感到力度"] },
    referenceCases: { filmReferences: ["《社交网络》"], adReferences: ["Apple"], styleReferences: ["大卫·芬奇"] },
    deliveryStandard: { deliverables: [{ item: "video_master", spec: "MP4/H.265, 4K", priority: "required" }], acceptanceCriteria: {} },
  }, {
    customerOriginalIntent: "全片无人，仅使用抽象界面",
    builtinCharacterSelection: { mode: "none" },
  }, {
    resolution: "4K", aspectRatio: "9:16", targetDuration: 30, durationToleranceFrames: 1,
  }, { scenes: [{ id: "opening" }, { id: "ending" }] });
  assert.doesNotMatch(normalized.prd.creativeCore.creativeHook, /手指/);
  assert.doesNotMatch(normalized.prd.referenceCases.filmReferences.join(" "), /《|Apple|导演/);
  assert.match(normalized.prd.scenePlan.scenes[0].visualRequirements[0], /若干/);
  assert.equal(normalized.prd.audioSpecification.voicePolicy, "无对白");
  assert.match(normalized.prd.deliveryStandard.deliverables[0].spec, /2160x3840/);
  assert.match(normalized.prd.deliveryStandard.deliverables[0].spec, /-14 LUFS/);
});

test("product scenes may use a fully reasoned no-prop visual system", () => {
  const noProps = [
    { props: [], noPropsReason: "只展示抽象代码块与屏幕光影，没有独立可见物理道具" },
    { props: [], noPropsReason: "只展示界面连线与几何图形，没有独立可见物理道具" },
  ];
  assert.equal(productPropsPolicySatisfied("Home Assistant", noProps), true);
  assert.equal(productPropsPolicySatisfied("Home Assistant", [{ props: [], noPropsReason: null }]), false);
  assert.equal(productPropsPolicySatisfied("Home Assistant", [{ props: [{ name: "设备" }], noPropsReason: null }]), true);
});

test("scene and risk discovery receive three controlled attempts at the extended timeout", () => {
  const engine = {
    agentTimeoutMs: 180_000,
    agents: {
      scene: { maxRetries: 1, timeoutMs: 180_000 },
      risk: { maxRetries: 1, timeoutMs: 180_000 },
    },
  };
  const configured = configureRequirementRetryPolicy(engine);
  assert.deepEqual(configured.policy, { sceneTimeoutMs: 240_000, maxRetries: 2, stageBudgetMs: 420_000 });
  assert.equal(engine.agents.scene.timeoutMs, 240_000);
  assert.equal(engine.agents.scene.maxRetries, 2);
  assert.equal(engine.agents.risk.maxRetries, 2);
});

test("discovery timing reconciles the tolerated residual and removes out-of-range audience seconds", () => {
  const structure = {
    opening: { duration: 4 },
    scenes: [{ duration: 5 }, { duration: 6 }, { duration: 8 }, { duration: 5 }],
    ending: { duration: 3 },
    totalDuration: 31,
    sceneCount: 6,
  };
  const audience = { emotionTriggers: ["第50秒愿意转发", "第12秒感到精密"] };
  const normalized = normalizeDiscoveryTiming(30, structure, audience);
  assert.equal(normalized.normalizedDuration, 30);
  assert.equal(structure.totalDuration, 30);
  assert.equal(structure.opening.duration + structure.scenes.reduce((sum, scene) => sum + scene.duration, 0) + structure.ending.duration, 30);
  assert.deepEqual(audience.emotionTriggers, ["已审场景节点愿意转发", "已审场景节点感到精密"]);
});

test("discovery timing strips unsupported competitor claims from audience hypotheses", () => {
  const structure = { opening: { duration: 10 }, scenes: [{ duration: 10 }], ending: { duration: 10 }, totalDuration: 30, sceneCount: 3 };
  const audience = {
    emotionTriggers: ["第一次看到有人把出处钉在画面上", "开发者第一反应是可信"],
    contentExpectations: ["它没在吹，只是陈述原文"],
  };
  const normalized = normalizeDiscoveryTiming(30, structure, audience, [
    "没有可核实竞品证据：禁止对比、竞品弱点或市场领先主张",
  ]);
  assert.ok(normalized.changes.includes("unsupported-audience-market-claims-removed"));
  assert.doesNotMatch(audience.emotionTriggers[0], /第一次看到|满屏|没在吹/);
  assert.doesNotMatch(audience.contentExpectations[0], /没在吹/);
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

test("RiskAssessor string overflow is compacted without dropping its content", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["technicalRisks", "businessConstraints", "mitigationSuggestions"],
    properties: {
      technicalRisks: { type: "array", maxItems: 5, items: { type: "object", additionalProperties: false, properties: { risk: { type: "string" } } } },
      businessConstraints: { type: "array", maxItems: 4, items: { type: "string" } },
      mitigationSuggestions: { type: "array", maxItems: 4, items: { type: "string" } },
    },
  };
  const projected = projectDeclaredFields({
    technicalRisks: [{ risk: "R1" }],
    businessConstraints: ["零背景", "无字幕", "无虚构", "无人", "禁高风险素材"],
    mitigationSuggestions: ["替换参考图"],
  }, schema);
  assert.deepEqual(projected.businessConstraints, ["零背景", "无字幕", "无虚构", "无人；禁高风险素材"]);
  assert.equal(projected.businessConstraints.join("；").includes("禁高风险素材"), true);
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

test("marketing source retry classifies transient transport separately from policy failures", () => {
  assert.equal(retryableMarketingSourceError(new Error("The operation was aborted due to timeout")), true);
  assert.equal(retryableMarketingSourceError(new Error("SOURCE_HTTP_FAILED：来源HTTP 503")), true);
  assert.equal(retryableMarketingSourceError(new Error("SOURCE_TEXT_TOO_LARGE：完整正文超过上限")), false);
  assert.equal(retryableMarketingSourceError(new Error("SOURCE_URL_PRIVATE：来源解析到非公网地址")), false);
});

test("booked GitHub source binds official URLs and both raw/text digests", () => {
  const rawText = "Repository: acme/widget\n\n# Widget\nOfficial fact.   \n\n\n";
  const normalized = sourceDocument(rawText, "text/plain", "https://github.com/acme/widget").text;
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const fixture = {
    schemaVersion: "workloom.booking-source/v1",
    requestedUrl: "https://github.com/acme/widget",
    finalUrl: "https://github.com/acme/widget",
    contentType: "text/plain",
    text: rawText,
    fetchedAt: new Date().toISOString(),
    rawSha256: digest(Buffer.from(rawText)),
    textSha256: digest(normalized),
    bytes: Buffer.byteLength(rawText),
    repository: "acme/widget",
    defaultBranch: "main",
    repositoryApiUrl: "https://api.github.com/repos/acme/widget",
    readmeApiUrl: "https://api.github.com/repos/acme/widget/readme",
    readmeSha: "a".repeat(40),
  };
  const loaded = loadBookingSourceFixture(fixture, "https://github.com/acme/widget");
  assert.equal(loaded.snapshot.text, normalized);
  assert.equal(loaded.snapshot.rawSha256, fixture.rawSha256);
  assert.equal(loaded.snapshot.textSha256, fixture.textSha256);
  assert.throws(() => loadBookingSourceFixture({ ...fixture, text: `${rawText}changed` }, fixture.requestedUrl), /SOURCE_FIXTURE_CHANGED/);
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

test("empty marketing evidence stations do not request an impossible semantic review", () => {
  assert.equal(requiresMarketingSupportReview({ claims: [] }), false);
  assert.equal(requiresMarketingSupportReview({ claims: [{ pointer: "/identity/name" }] }), true);
});

test("absolute marketing claims stay in raw response but are excluded from deliverable facts", () => {
  const filtered = filterUnsafeMarketingExtraction("A1", {
    payload: { identity: { name: "Home Assistant", official_selling_points: [
      { point: "Open source", source_url: "https://github.com/home-assistant/core" },
      { point: "Perfect to run anywhere", source_url: "https://github.com/home-assistant/core" },
    ] }, images: [] },
    citations: [
      { pointer: "/identity/name", sourceId: "SRC-1", quote: "Home Assistant" },
      { pointer: "/identity/official_selling_points/0/point", sourceId: "SRC-1", quote: "Open source" },
      { pointer: "/identity/official_selling_points/1/point", sourceId: "SRC-1", quote: "Perfect" },
    ],
  });
  assert.deepEqual(filtered.value.payload.identity.official_selling_points.map((item) => item.point), ["Open source"]);
  assert.deepEqual(filtered.value.citations.map((item) => item.pointer), [
    "/identity/name",
    "/identity/official_selling_points/0/point",
  ]);
  assert.deepEqual(filtered.exclusions, [{
    pointer: "/identity/official_selling_points/1/point",
    value: "Perfect to run anywhere",
    reason: "absolute-marketing-claim",
  }]);
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
      visual_assets: { images: [{ id: "IMG-1", license_risk: "high" }], needs_more_reference: false },
      provenance: [{ evidence_id: "EV-1", claim_ref: "identity.official_selling_points:本地控制与隐私优先" }],
      differentiation: { our_opening: ["把官方卖点当竞品空白"] },
      gaps: ["[A2_MINE] 未挖到吐槽点（警惕样本偏倚：全是好评通常不真实）"],
    },
    {
      brief_card: { sellingPoints: [], evidence_note: "卖点来自 0 条官方主张" },
      router_material: { product_kind: "physical" },
      portrait_manifest: { needs_more_reference: true, handoff_note: "只核对型号一致性" },
      prd_card: {},
      insight_card: {},
    },
    { name: "Home Assistant", category: "开源家庭自动化平台" },
    {
      hasCompetitorEvidence: false,
      sellingPointClaims: [{
        pointer: "/identity/official_selling_points/0/point",
        claimId: "CL-1",
        sourceId: "SRC-1",
      }],
    },
  );
  assert.deepEqual(result.cards.brief_card.sellingPoints, ["本地控制与隐私优先"]);
  assert.match(result.cards.brief_card.evidence_note, /1 条来源绑定官方主张/);
  assert.equal(result.cards.router_material.product_kind, "digital");
  assert.equal(result.cards.portrait_manifest.needs_more_reference, true);
  assert.match(result.cards.portrait_manifest.handoff_note, /未取得明确商用授权前禁止传播/);
  assert.ok(result.cards.prd_card.compliance_redlines.length > 0);
  assert.deepEqual(result.cards.prd_card.selling_point_evidence, [{
    point: "本地控制与隐私优先",
    claimId: "CL-1",
    evidenceId: "EV-1",
    sourceId: "SRC-1",
    sourceUrl: null,
  }]);
  assert.equal(result.dossier.visual_assets.needs_more_reference, true);
  assert.deepEqual(result.dossier.differentiation.our_opening, []);
  assert.equal(result.dossier.gaps.join(" ").includes("全是好评"), false);
  assert.ok(result.dossier.gaps.some((gap) => gap.includes("受众")));
});

test("dossier normalization removes phantom source images and propagates customer redlines", () => {
  const restrictions = customerRestrictionLines("不展示未核实硬件或可运行效果，不声称用户评价、销量或竞品优势。");
  const result = normalizeMarketingDossierPresentation(
    { identity: { name: "Acme", official_selling_points: [] }, visual_assets: null, gaps: [] },
    { portrait_manifest: { handoff_note: "预填参考图，核对型号", reference_images: [{}] }, prd_card: {}, theme_card: {} },
    { name: "Acme", category: "软件平台" },
    { customerRestrictions: restrictions },
  );
  assert.deepEqual(result.dossier.restrictions, restrictions);
  assert.deepEqual(result.dossier.visual_assets, { images: [], needs_more_reference: true });
  assert.deepEqual(result.cards.portrait_manifest.reference_images, []);
  assert.equal(result.cards.portrait_manifest.hero_image_id, null);
  assert.match(result.cards.portrait_manifest.handoff_note, /不得生成或声称已有定妆照/);
  assert.deepEqual(result.cards.prd_card.compliance_redlines, restrictions);
  assert.deepEqual(result.cards.theme_card.avoid_pits, restrictions);
});
