/** Synthetic durable source files for offline unit and real-PG repair boundary tests. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ArchiveStore, canonicalJson, compilePromptShot, normalizePrdProductionProfile, promptFieldPolicy,
  SHOT_FIELD_SCHEMA_V2, sha256Json, type PromptCompileOptions,
} from "@hyperreality/video-studio";
import { evaluateVideoSystemAutoApproval } from "@hyperreality/video-pipeline";
import { validateStageFacts } from "./marketing-facts.js";
import { supportReviewFacts, type MarketingScope } from "./marketing-authority.js";
import { createPreproductionResumeSnapshot } from "./archive-resume.js";
import type { SourceSnapshot } from "./marketing-source-fetcher.js";
import { resolveScenePolicyForIntent } from "./scene-policy-routing.js";

export const fixtureHash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
type Json = Record<string, unknown>;
export async function approvedSourceFixture(input: {
  workDir: string; scope: MarketingScope; createdAt: string; collectedAt?: string;
  compileModel?: PromptCompileOptions["model"];
  compileDelivery?: PromptCompileOptions["delivery"];
  /** Only for missing-field boundary tests: persist the real partial compiler contract. */
  omitField?: string;
  /** Only for source-selection boundary negatives. */
  castState?: "missing" | "profile-mismatch";
  platformState?: "missing" | "conflict";
}) {
  const { workDir, scope, createdAt } = input;
  const collectedAt = input.collectedAt ?? new Date().toISOString();
  const store = new ArchiveStore(workDir, scope.workspaceId, scope.projectId, "marketing");
  await store.ensure({ kind: "marketing", title: "Offline synthetic approved source", createdAt });
  const runDir = path.join(workDir, "workspaces", scope.workspaceId), gateDir = path.join(runDir, "gates", scope.projectId, `attempt-${scope.attempt}`);
  await mkdir(gateDir, { recursive: true });
  const put = async (file: string, value: string | Buffer) => {
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value);
    return { path: file, realPath: file, sha256: fixtureHash(value), bytes: Buffer.byteLength(value) };
  };
  const putJson = (file: string, value: unknown) => put(file, canonicalJson(value));
  const actorId = "fixture-person", actorName = "合成人物";
  const authorization = { status: "synthetic-no-real-person" };
  const profile = await putJson(path.join(workDir, "fixtures", "profile.json"), { id: actorId, name: actorName, kind: "generated", authorization });
  const angles = ["front", "threeQuarter", "closeup", "side"] as const;
  const sourceFiles: Record<string, Awaited<ReturnType<typeof put>>> = {};
  // A real tiny PNG in a test fixture; it is never published or passed to a provider.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6d8AAAAASUVORK5CYII=", "base64");
  for (const angle of angles) sourceFiles[angle] = await put(path.join(workDir, "fixtures", `${angle}.png`), png);
  const selection = { schemaVersion: "workloom.portrait-reuse-selection/v1", rawIntent: "本次明确选择已存合成人物第二版四角度", selectedVersion: 2, expectedPortraits: 4, selectedAt: collectedAt };
  const character = { id: actorId, name: actorName, aliases: ["主角"], version: 2, authorization, profile, files: sourceFiles };
  const portraitManifest = await putJson(path.join(workDir, "fixtures", "portrait-manifest.json"), {
    schemaVersion: "workloom.portrait-reuse-manifest/v1", approvedSelection: selection, characters: [character],
  });
  const manifestRef = { path: portraitManifest.path, sha256: portraitManifest.sha256 };
  const outputs: Record<string, Awaited<ReturnType<typeof put>>> = {}, receipts: Record<string, Json> = {}, files: Record<string, string> = {};
  for (const angle of angles) {
    const output = await put(path.join(runDir, "characters", scope.projectId, actorId, `${angle}.png`), png);
    outputs[angle] = output; files[angle] = output.path;
    receipts[angle] = { schemaVersion: "workloom.portrait-reuse/v1", projectId: scope.projectId, kind: "character", id: actorId, angle,
      archiveId: actorId, archiveName: actorName, version: 2, generationCount: 0, copiedAt: collectedAt,
      manifest: manifestRef, selectionReceipt: selection, profile, source: sourceFiles[angle], output };
  }
  await putJson(path.join(runDir, "characters", scope.projectId, "portrait-index.json"), {
    schemaVersion: "workloom.portrait-index/v1", projectId: scope.projectId, products: {},
    characters: { [actorId]: { kind: "character", id: actorId, name: actorName, portraitVersion: 2, pinnedVersion: 2,
      files, reuseReceipts: receipts, artifacts: outputs } },
  });
  const prefix = `stages/preproduction/attempt-${scope.attempt}.marketing`, sourceText = "合成商品的合成规格为九档，仅供封闭拍摄场地演示。";
  const finalUrl = "https://synthetic-source.example.com/product", textSha256 = fixtureHash(sourceText), sourceId = `SRC-${fixtureHash(`${finalUrl}\n${textSha256}`).slice(0, 24)}`;
  const sourcePage: SourceSnapshot = { sourceId, requestedUrl: finalUrl, finalUrl, redirectChain: [], fetchedAt: collectedAt,
    contentType: "text/plain", rawSha256: textSha256, textSha256, bytes: Buffer.byteLength(sourceText), text: sourceText, assetUrls: [] };
  const rawRef = `${prefix}-sources/${sourceId}.raw`, textRef = `${prefix}-sources/${sourceId}.txt`;
  await put(path.join(store.root, rawRef), sourceText); await put(path.join(store.root, textRef), sourceText);
  const a1 = validateStageFacts("A1", { payload: { identity: { name: "合成商品", specs: { 合成规格: "九档" } }, images: [] },
    citations: ["/identity/name", "/identity/specs/合成规格"].map(pointer => ({ pointer, sourceId, quote: sourceText })) }, [sourcePage]);
  const a2 = validateStageFacts("A2", { payload: { reviews: [] }, citations: [], noEvidenceReason: "没有真实用户评价，不创作用户主张" }, []);
  const a3 = validateStageFacts("A3", { payload: { competitors: [] }, citations: [], noEvidenceReason: "没有竞品来源，不创作比较主张" }, []);
  const productQuery = { name: "合成商品" };
  const supportFile = await putJson(path.join(store.root, `${prefix}-A1.review.json`), { scope, productQuery,
    facts: supportReviewFacts("A1", a1), sources: [sourcePage] });
  const passed = (file: string, hash: string, gate?: string) => ({ approved: true, status: "passed", via: "llm", degraded: false,
    model: "offline-synthetic-reviewed-model", score: 96, issues: [], suggestions: [], reason: "offline fixture",
    evidence: [{ path: file, sha256: hash, scope: "complete-text" }], ...(gate ? { gate } : {}) });
  const discovery = { queries: [], candidates: 1, fetched: 1, omittedCandidates: 0, failures: [] };
  const { text: _text, ...sourceSnapshot } = sourcePage;
  const rawByAgent = { A1: a1.payload, A2: a2.payload, A3: a3.payload }, dossier = { product_id: "synthetic-product", identity: a1.payload.identity };
  const facts = { schemaVersion: "workloom.marketing-facts/v1", issuer: "workloom.marketing-authority", scope, collectedAt,
    policyVersion: "source-claims/v1", productQuery, sources: [{ ...sourceSnapshot, rawRef, textRef }],
    stages: [{ stage: "A1", facts: a1, sourceIds: [sourceId], discovery,
      review: { ref: `${prefix}-A1.review.json`, sha256: supportFile.sha256, verdict: passed(supportFile.path, supportFile.sha256) } },
    { stage: "A2", facts: a2, sourceIds: [], discovery }, { stage: "A3", facts: a3, sourceIds: [], discovery }],
    rawByAgent, rawSha256: sha256Json(rawByAgent), dossier, cards: {}, dossierSha256: sha256Json(dossier),
    restrictions: ["不得虚构用户评价或竞品事实"], outputReviews: [] };
  const brief = { product: "合成商品", duration: 20, aspectRatio: "9:16", platform: "douyin", description: "第一段完整观察，第二段完整点头。",
    productionRequirements: { resolution: "1080p", frameRate: 30, subtitleMode: "none", nativeAudio: true, openWithCover: false,
      titleCard: false, durationToleranceFrames: 1, speechPolicy: "none" },
    segmentContract: { count: 2, totalSeconds: 20, secondsPerSegment: 10, hardCuts: true,
      intervals: [{ startSec: 0, endSec: 10, brief: "主角完整观察合成商品" }, { startSec: 10, endSec: 20, brief: "主角轻轻点头" }] } };
  if (input.platformState === "missing") delete (brief as { platform?: string }).platform;
  const metadata = { brief, characterId: actorId, dataMining: { name: "合成商品" },
    ...(input.platformState === "conflict" ? { platform: "youtube" } : {}) };
  const request = { intent: "制作完整合成营销片，保留全部条件与最后一行。", rawIntent: "只使用第二版合成人物，分两段拍摄。", isMarketing: true, metadata };
  const g1File = await putJson(path.join(gateDir, "G1_DOSSIER.md"), { facts, requestedIntent: request.intent, requestedMetadata: metadata });
  const g2File = await put(path.join(gateDir, "G2_THEME.md"), "完整已审合成主题、受众与创作目标。".repeat(15));
  const g3File = await put(path.join(gateDir, "G3_INSIGHT.md"), "完整已审合成场景、人物、动作与素材限制。".repeat(15));
  const scenes = ["opening", "ending"].map(id => ({ id, duration: 10, purpose: "合成人物完整观察商品并轻轻点头",
    keyElements: ["合成商品", actorName], props: [{ name: "合成商品" }], actions: [{ actorId, description: "合成人物观察商品并轻轻点头" }] }));
  const registrySha256 = fixtureHash("offline-synthetic-character-registry");
  const castSelection = { schemaVersion: "workloom.video-character-selection/v1", mode: "builtin", reason: "offline explicit archived actor",
    registryPath: path.join(workDir, "fixtures", "registry.json"), registrySha256, characters: [{ id: actorId, name: actorName, ordinal: 1,
      source: "builtin", profilePath: profile.path, profileSha256: input.castState === "profile-mismatch" ? "f".repeat(64) : profile.sha256 }] };
  const castCharacter = { id: actorId, name: actorName, role: "protagonist", kind: "generated", authorization,
    builtinCharacterSource: { profilePath: profile.path, profileSha256: castSelection.characters[0]!.profileSha256, registrySha256 } };
  const castBody = { mode: "builtin", selection: castSelection, characters: [castCharacter] };
  const requirementBody = { schemaVersion: "workloom.requirement-contract/v1", status: "ready-for-g3", scenes,
    ...(input.castState === "missing" ? {} : { cast: { ...castBody, hash: sha256Json(castBody) } }) };
  const contract = { ...requirementBody, hash: sha256Json(requirementBody) }, profileRequirements = normalizePrdProductionProfile(metadata);
  const sourceAuthority = { source: { schemaVersion: "workloom.prd-authority/v1", status: "ready-for-g4", scope,
    g1: { path: g1File.path, sha256: g1File.sha256 }, profile: profileRequirements, requirementContractHash: contract.hash },
    profile: profileRequirements, approvedRequirementContract: contract };
  const planning = { status: "plan-only-not-executed", sceneVerificationPlans: scenes.map(scene => ({ sceneId: scene.id,
    duration: 10, visualRequirements: ["合成人物与商品完整可见"], audioRequirements: ["只保留现场动作声"], dialogue: "" })) };
  const g4File = await put(path.join(gateDir, "G4_PRD.md"), "完整已审 PRD。\n\n## 宿主本次权威生产与交付要求\n\n```json\n"
    + canonicalJson(sourceAuthority) + "\n```\n\n## 本次 G4 执行与核验计划原文\n\n```json\n" + canonicalJson(planning) + "\n```\n");
  const gateFiles = [g1File, g2File, g3File, g4File], gateNames = ["G1_DOSSIER", "G2_THEME", "G3_INSIGHT", "G4_PRD"];
  const gates: Json[] = gateFiles.map((file, index) => {
    const key = gateNames[index]!, gate = passed(file.path, file.sha256, key);
    const check = { status: "passed" as const, detail: "offline current evidence", evidenceRef: file.path };
    const auto = evaluateVideoSystemAutoApproval(true, { gateKey: key, action: key, artifactSha256: file.sha256,
      factHash: file.sha256, expectedFactHash: file.sha256,
      deterministicChecks: [{ id: "offline-current", category: "deterministic", ...check }],
      budget: { status: "not_applicable", detail: "offline no dispatch", evidenceRef: "offline" },
      qualification: check, permission: check, fence: { ...check, level: "review" },
      evidenceRefs: [{ id: key, kind: "file", ref: file.path, sha256: file.sha256 }] });
    return { ...gate, autoApproval: auto.receipt };
  });
  const assets: PromptCompileOptions["assets"] = ["front", "closeup"].map(angle => ({ field: "portraits", role: "reference_image",
    sha256: outputs[angle]!.sha256, bytes: outputs[angle]!.bytes, mediaType: "image/png", sourceRef: path.relative(runDir, outputs[angle]!.path) }));
  const options: PromptCompileOptions = { schemaVersion: SHOT_FIELD_SCHEMA_V2, titleCard: false, createdAt: collectedAt,
    delivery: input.compileDelivery ?? { aspectRatio: "9:16", resolution: "1080p", fps: 30, format: "mp4", generateAudio: true },
    model: input.compileModel ?? { modelId: "fixture-video", provider: "fixture", providerModel: "fixture-video", version: "fixture/v1", modes: ["t2v", "i2v", "r2v"],
      durationSec: { min: 1, max: 20 }, aspectRatios: ["9:16"], resolutions: ["1080p"], maxReferenceImages: 4, maxPromptChars: 100_000 }, assets };
  const qualityDir = path.join(gateDir, "prompt-quality"), contractFiles: Array<{ shotId: string; path: string; sha256: string; contract: unknown }> = [];
  for (const scene of scenes) {
    const fields = Object.fromEntries(promptFieldPolicy(SHOT_FIELD_SCHEMA_V2, false).fields.map(field => [field.key, `完整${field.label}文本，与已审合成场景一致。`]));
    Object.assign(fields, { portraits: [`portrait-set://${actorId}/v2/front`, `portrait-set://${actorId}/v2/closeup`], dialogue: "无台词。",
      action: "合成人物先观察商品，再轻轻点头。", timeline: "T00:00至T00:10，合成人物只观察商品。",
      constraint: `${options.delivery.aspectRatio}画幅，${options.delivery.resolution}分辨率，${options.delivery.fps}fps，MP4格式` });
    if (input.omitField && scene.id === "opening") delete fields[input.omitField];
    const compiled = compilePromptShot({ shotId: scene.id, duration: 10, fields }, options);
    if (compiled.hardErrors.some(error => error.code !== "HARD_FIELD_VALUE_MISSING" || error.field !== input.omitField)) throw new Error(JSON.stringify(compiled.hardErrors));
    const saved = await putJson(path.join(qualityDir, `prompt-contract-${scene.id}.json`), compiled.contract);
    contractFiles.push({ shotId: scene.id, path: saved.path, sha256: saved.sha256, contract: compiled.contract });
  }
  const report = await putJson(path.join(qualityDir, "semantic-quality-report.json"), { schemaVersion: "workloom.video-prompt-quality/v2",
    findings: input.omitField ? [{ shotId: "opening", field: input.omitField, blocking: true, repairClass: "deterministic", code: "HARD_FIELD_VALUE_MISSING", detail: "原始完整编译器报告此字段缺失，没有原值摘要" }]
      : [{ shotId: "opening", field: "timeline", blocking: true, repairClass: "semantic", code: "TIMELINE_MISSING_ACTION_ONSET", detail: "时间轴缺少已审点头动作" }] });
  const quality = { schemaVersion: "workloom.video-prompt-quality/v2", mode: "enforce", status: "blocked", contracts: contractFiles,
    semanticReportPath: report.path, sha256: { semanticReport: report.sha256 } };
  gates.push({ gate: "G6_PROMPT", approved: false, status: "blocked", via: "llm", degraded: false, model: "offline-synthetic-reviewed-model",
    evidence: [...contractFiles.map(file => ({ path: file.path, sha256: file.sha256, scope: "complete-text" })),
      { path: report.path, sha256: report.sha256, scope: "complete-text" }], promptQuality: { evidence: quality } });
  const inputRef = `stages/preproduction/attempt-${scope.attempt}.input.json`, outputRef = `stages/preproduction/attempt-${scope.attempt}.output.json`;
  await store.writeJsonAtomic(inputRef, { stageId: "preproduction", attempt: scope.attempt, input: { pipelineKind: "marketing", isMarketing: true,
    scenePolicy: resolveScenePolicyForIntent(request.rawIntent, request.metadata).decision,
    resumeSnapshot: createPreproductionResumeSnapshot({ scope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId, projectId: scope.projectId, runId: scope.runId },
      projectCreatedAt: createdAt, request }) }, startedAt: collectedAt });
  const output = { success: false, degraded: false, productionEvidence: { schemaVersion: "workloom.preproduction-authority/v1", issuer: "workloom.studio-worker",
    ...scope, pipelineKind: "marketing", gates }, stages: ["offline-fixture"], failureMessage: "G6 blocked in offline fixture" };
  const outputReceipt = await store.writeJsonAtomic(outputRef, output);
  const row = { id: `SR-${scope.runId}`, attempt: scope.attempt, run_id: scope.runId, input_ref: inputRef, output_ref: outputRef,
    output_sha256: outputReceipt.sha256, status: "failed", error_class: "GATE_REJECTED" };
  return { store, row, scope, request, output, gateFiles, gateDir, runDir, contractFiles, report, portraitManifest, options, sourcePage,
    sourceTextPath: path.join(store.root, textRef), createdAt, collectedAt,
    sourceInputBytes: await readFile(path.join(store.root, inputRef)), sourceOutputBytes: await readFile(path.join(store.root, outputRef)) };
}
