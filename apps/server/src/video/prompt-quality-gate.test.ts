import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SEMANTIC_QUALITY_CHECK_IDS,
  createLlmSemanticQualityReviewer,
  evaluatePromptPackage,
  compilePromptPackage,
  parseSemanticQualityReview,
  promptQualityAutoChecks,
  promptContractSummary,
  resolvePromptAssets,
  verifyCurrentPromptContracts,
  writePromptQualityEvidence,
  type SemanticQualityReview,
  type SemanticQualityReviewer,
} from "./prompt-quality-gate.js";
import { resolveVideoModel, WorkloomLLMEngine, type PromptCompileOptions } from "@hyperreality/video-studio";
import { OpenAiCompatibleProvider, poolFromEnv, resetCircuit, type ModelTrace } from "@workloom/base/model-router";
import { modelPolicyFor } from "../service/llm.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const fields: Record<string, unknown> = {
  director_instruction: "写实纪录片方向，讲清人物与水面的关系。",
  constraint: "9:16画幅，1080x1920，30fps，MP4格式。",
  baseline: "电影级写实质感。",
  scene: "清晨临水回廊，薄雾贴着水面。",
  lighting: "侧后方晨光与水面反射补光。",
  camera_movement: "固定机位，轻微呼吸感。",
  character: "林夏穿着浅色亚麻衬衫。",
  action: "林夏停在栏杆旁触摸木纹。",
  portraits: "NONE",
  dialogue: "无台词；只保留水声与鸟鸣。",
  negative: "no text, no watermark, no duplicate person",
  consistency: "保持林夏和回廊空间一致。",
  composition: "竖版三分构图，人物位于右侧。",
  color_palette: "冷灰水面与浅木色回廊。",
  depth_of_field: "中景清晰，近处栏杆轻微虚化。",
  timeline: "T00:00至T00:05，T00:04停稳。",
  mood: "安静、克制。",
  bright_constraint: "面部与水面反光清晰。",
  character_constraint: "只出现林夏一个主体。",
  costume: "浅色亚麻衬衫与深色长裤。",
  props: "木质栏杆、薄雾、水面落叶。",
  pacing: "前段慢，后段停稳。",
  audio: "水声、鸟鸣、脚步声。",
  makeup: "自然裸妆。",
  transition: "硬切入镜。",
};

const model: PromptCompileOptions["model"] = {
  modelId: "doubao-seedance-2-5",
  provider: "seedance",
  providerModel: "doubao-seedance-2-5-260628",
  version: "test",
  modes: ["t2v"],
  durationSec: { min: 4, max: 30 },
  aspectRatios: ["9:16"],
  resolutions: ["1080p"],
  maxReferenceImages: 30,
  maxPromptChars: 4000,
};

const compile: PromptCompileOptions = {
  delivery: { aspectRatio: "9:16", resolution: "1080p", fps: 30, format: "mp4", generateAudio: true },
  model,
  assets: [],
};

const source = {
  shotId: "S01",
  sceneType: "content",
  duration: 5,
  fields,
  portraits: fields.portraits,
};

function passReview(): SemanticQualityReview {
  return {
    shotId: "S01",
    checks: SEMANTIC_QUALITY_CHECK_IDS.map((id) => ({
      id,
      pass: true,
      field: id === "SQ3_CAMERA_FEASIBLE" ? "camera_movement" : id === "SQ4_LIGHT_COLOR" ? "lighting" : "scene",
      evidence: id === "SQ3_CAMERA_FEASIBLE" ? "camera_movement：固定机位，轻微呼吸感"
        : id === "SQ4_LIGHT_COLOR" ? "lighting：侧后方晨光与水面反射补光"
          : "scene：清晨临水回廊，薄雾贴着水面",
    })),
  };
}

function failCameraReview() {
  const review = passReview();
  review.checks[2] = {
    ...review.checks[2]!,
    pass: false,
    field: "camera_movement",
    failureCode: "CAMERA_COMPLEXITY_EXCEEDS_DURATION",
    evidence: "camera_movement：固定机位，轻微呼吸感",
    repair: "只修改 camera_movement，保留固定机位",
  };
  return review;
}

function input(reviewer: SemanticQualityReviewer, mode: "shadow" | "enforce" = "enforce") {
  return {
    mode,
    projectId: "P1",
    runId: "R1",
    stageRunId: "SR1",
    revision: 1,
    shots: [{ source, compile }],
    reviewer,
  };
}

function shotAtFinalLength(length: number, shotId = "S01") {
  const original = compilePromptPackage({ shots: [{ source, compile }] })[0]!.contract.prompt.length;
  const color_palette = `${fields.color_palette}🎨${"灰".repeat(length - original - 2)}`;
  const shot = { source: { ...source, shotId, fields: { ...fields, color_palette } }, compile };
  expect(compilePromptPackage({ shots: [shot] })[0]!.contract.prompt.length).toBe(length);
  return shot;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetCircuit("preproduction");
});

it("uses only the ordered explicit selections from a verified native archive binding", () => {
  const workDir = "/synthetic/workspace", charactersDir = `${workDir}/characters/P1`;
  const angles = ["front", "threeQuarter", "closeup", "side"] as const;
  const receipt = (file: string, index: number) => ({
    path: file, realPath: file, sha256: String(index).repeat(64), bytes: 100 + index,
  });
  const sources = angles.map((angle, index) => receipt(`/original/lead-${angle}.png`, index));
  const outputs = angles.map((angle, index) => receipt(`${charactersDir}/lead-archive-v2-${angle}.png`, index));
  const archiveCopies = {
    schemaVersion: "workloom.portrait-reuse-acceptance/v1" as const, projectId: "P1",
    character: { id: "lead", name: "林夏", angles },
    selectionReceipt: { schemaVersion: "workloom.portrait-reuse-selection/v1" as const, rawIntent: "原始二版角色",
      selectedVersion: 2, expectedPortraits: 4 as const, selectedAt: "2026-11-04T00:00:00Z" },
    manifest: { path: "/original/manifest.json", sha256: "a".repeat(64) },
    index: receipt(`${charactersDir}/portrait-index.json`, 8),
    profile: receipt("/original/profile.json", 9),
    sources, outputs,
  };
  const binding = { character: "林夏", mode: "studio", source: "portrait-set://lead",
    portraits: angles.map((angle, index) => ({ angle, outputFile: outputs[index]!.path })) };
  const resolve = (portraits: unknown, suppliedBinding: unknown = binding) => resolvePromptAssets({
    source: { portraits: "/characters/character/portrait_v1.png", fields: { portraits }, portraitBindings: [suppliedBinding] },
    workDir, charactersDir, archiveCopies,
  });
  const closeup = "image://characters/lead/portraits/v2/closeup.png";
  const front = "image://characters/lead-archive-v2-front.png";
  const expected = [2, 0].map(index => ({
    field: "portraits", role: "reference_image", sha256: outputs[index]!.sha256, bytes: outputs[index]!.bytes,
    mediaType: "image/png", sourceRef: `characters/P1/lead-archive-v2-${angles[index]}.png`,
  }));
  expect(resolve(`林夏: ${closeup}, ${front}`)).toEqual(expected);
  expect(resolve([closeup, front])).toEqual(expected);
  expect(resolve([sources[2]!.path, outputs[0]!.path])).toEqual(expected);
  for (const invalid of [
    "portrait-set://lead", "/characters/character/portrait_v1.png", [closeup, closeup],
    [closeup, front + ".evil"], [closeup, "image://characters/lead/v1/front.png"],
    [closeup, "image://characters/other/v2/front.png"], [closeup, "image://characters/../../original/lead-front.png"],
  ]) expect(resolve(invalid)).toEqual([]);
  expect(resolve([closeup, front], { ...binding, character: "其他角色" })).toEqual([]);
  expect(resolve([closeup, front], { ...binding, portraits: binding.portraits.slice(0, 3) })).toEqual([]);
});

const repairedCamera = "固定机位，缓慢推近一个动作";

function workerModelFixture() {
  vi.stubEnv("LLM_PROVIDER", "deepseek");
  vi.stubEnv("LLM_BASE_URL", "http://g6-fixture.invalid/v1");
  vi.stubEnv("LLM_API_KEY", "fixture-only");
  vi.stubEnv("LLM_MODEL", "deepseek-flash");
  vi.stubEnv("LLM_FORCE_MODEL", "deepseek-flash");
  const calls: string[] = [];
  const traces: ModelTrace[] = [];
  const requests: string[] = [];
  const onRepair = vi.fn();
  const onReview = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
    expect(String(url)).toBe("http://g6-fixture.invalid/v1/chat/completions");
    requests.push(String(init?.body));
    const { messages, model } = JSON.parse(requests.at(-1)!);
    const prompt = String(messages.at(-1).content);
    const section = prompt.split("\n\n【硬性输出要求】", 1)[0]!;
    const repairing = section.startsWith("你是字段级定点修复器。");
    const context = JSON.parse(section.slice(repairing ? section.indexOf("镜头：{") + 3 : section.indexOf("\n{\n") + 1));
    const shotId = String(context.shotId);
    calls.push(`${repairing ? "repair" : "review"}:${shotId}`);
    const review = passReview();
    review.shotId = shotId;
    const camera = context.fields?.find((entry: { field: string }) => entry.field === "camera_movement")?.value;
    if (shotId === "S01" && camera === fields.camera_movement) review.checks[2] = failCameraReview().checks[2]!;
    else if (camera === repairedCamera) review.checks[2]!.evidence = repairedCamera;
    const fallback = repairing
      ? { changes: [{ field: "camera_movement", value: repairedCamera, reason: "在时长内完成" }] }
      : review;
    const payload = repairing ? onRepair(context, fallback) ?? fallback : onReview(context, fallback) ?? fallback;
    if (payload instanceof Response) return payload;
    return Response.json({
      id: `g6-fixture-${calls.length}`, model,
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(payload) } }],
      usage: { prompt_tokens: 300, completion_tokens: 100, total_tokens: 400 },
    });
  }));
  const llm = WorkloomLLMEngine.fromEnv()!;
  const router = {
    providers: poolFromEnv(),
    policy: structuredClone(modelPolicyFor("ai-video")!),
    scene: "preproduction",
    forceModel: resolveVideoModel(process.env),
    sink: {
      recordModelTrace: async (trace: ModelTrace) => { traces.push(trace); },
      recordDegradation: async () => undefined,
      recordCircuitBreak: async () => undefined,
    },
  };
  llm.attachRouter(router);
  const reviewer = createLlmSemanticQualityReviewer(llm);
  const evaluation = {
    ...input(reviewer),
    shots: [{ source, compile }, { source: { ...source, shotId: "S02" }, compile }],
    upstreamContext: { pipelineKind: "narrative", intent: "离线测试原文", brief: { duration: 10 } },
  };
  return { calls, traces, requests, llm, router, reviewer, evaluation, onRepair, onReview };
}

describe("G6 同次修复的真实模型路由", () => {
  it("只缩短超长镜头的美术字段，保留另一镜原有运镜修复及未变化镜头证明", async () => {
    const fixture = workerModelFixture();
    const longShot = shotAtFinalLength(3001, "S02");
    const original = compilePromptPackage({ shots: [longShot] })[0]!.contract;
    const evaluation = { ...fixture.evaluation, maxFinalPromptChars: 3000,
      shots: [fixture.evaluation.shots[0]!, longShot, { source: { ...source, shotId: "S03" }, compile }] };
    fixture.onRepair.mockImplementation(context => context.shotId === "S02"
      ? { changes: [{ field: "color_palette", value: longShot.source.fields.color_palette.slice(0, -1), reason: "删掉重复字" }] }
      : undefined);
    const result = await evaluatePromptPackage(evaluation);
    expect(fixture.calls).toEqual(["review:S01", "review:S02", "review:S03", "repair:S02", "repair:S01", "review:S01", "review:S02"]);
    expect(fixture.onRepair).toHaveBeenCalledWith(expect.objectContaining({
      shotId: "S02", finalPromptLength: { actualChars: 3001, maxFinalPromptChars: 3000 },
      allowedFields: [
        { field: "lighting", value: fields.lighting },
        { field: "composition", value: fields.composition },
        { field: "color_palette", value: longShot.source.fields.color_palette },
        { field: "depth_of_field", value: fields.depth_of_field },
        { field: "mood", value: fields.mood },
      ],
      readOnlyFields: expect.arrayContaining(["action", "timeline", "portraits", "costume", "dialogue", "audio"]
        .map(field => ({ field, value: fields[field] }))),
    }), expect.anything());
    expect(fixture.requests[3]).toContain("字段合计至少需缩短 1 字符");
    expect(result.status).toBe("passed");
    expect(result.shotContracts[1]!.contract).toMatchObject({ requestSha256: original.requestSha256 });
    expect(result.shotContracts[1]!.contract.prompt.length).toBe(3000);
    expect(result.semanticReports[1]!.checks).toHaveLength(5);
    expect(result.semanticReports[1]!.proofReuse).toBeUndefined();
    expect(result.semanticReports[2]!.proofReuse).toBeDefined();
    expect(promptQualityAutoChecks(result)).toContainEqual(expect.objectContaining({ id: "prompt-final-native-length", status: "passed" }));
  });

  it("修复运镜时在真实出站请求中附上完整只读动作与时间轴，不授予修改权限", async () => {
    const fixture = workerModelFixture();
    const timeline = "T00:00–T00:02停稳摘盔；T00:02–T00:05踏上台阶、举起奖杯。";
    const action = "摘下头盔后放稳，再走上台阶举杯。";
    const current: Record<string, unknown> = { ...fields, timeline, action };
    fixture.evaluation.shots[0]!.source = { ...source, fields: current };
    const result = await evaluatePromptPackage(fixture.evaluation);
    expect(fixture.calls).toEqual(["review:S01", "review:S02", "repair:S01", "review:S01"]);
    expect(fixture.onRepair).toHaveBeenCalledWith(expect.objectContaining({
      shotId: "S01",
      durationSec: 5,
      allowedFields: [{ field: "camera_movement", value: current.camera_movement }],
      readOnlyFields: expect.arrayContaining([{ field: "action", value: action }, { field: "timeline", value: timeline }]),
    }), expect.anything());
    const sent = fixture.onRepair.mock.calls[0]![0];
    expect(Object.fromEntries(sent.readOnlyFields.map(({ field, value }: { field: string; value: unknown }) =>
      [field, value]))).toEqual(Object.fromEntries(Object.entries(current).filter(([field]) => field !== "camera_movement")));
    expect(result.status).toBe("passed");
    expect(result.shotContracts[0]!.source.fields).toEqual({ ...current, camera_movement: repairedCamera });
    expect(result.g6Eligible).toBe(true);
    expect(result.renderEligible).toBe(false);
  });

  it("复用未变镜头已通过的语义证明，仅重审发生变化的镜头", async () => {
    const fixture = workerModelFixture();
    const result = await evaluatePromptPackage(fixture.evaluation);
    expect(result.status).toBe("passed");
    expect(result.g6Eligible).toBe(true);
    expect(result.renderEligible).toBe(false);
    expect(result.shotContracts.map((item) => item.source.fields)).toEqual([
      { ...fields, camera_movement: repairedCamera }, fields,
    ]);
    expect(fixture.calls).toEqual(["review:S01", "review:S02", "repair:S01", "review:S01"]);
    expect(result.semanticReports[0]!.proofReuse).toBeUndefined();
    expect(result.semanticReports[1]).toMatchObject({
      shotId: "S02", valid: true, technicalRetry: 0,
      proofReuse: {
        sourcePass: 1, sourceTechnicalRetry: 0, modelId: "deepseek-flash", inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        sourceRequestSha256: fixture.traces[1]!.requestHash, sourceResponseSha256: fixture.traces[1]!.responseHash,
        policyVersion: fixture.traces[1]!.policyVersion, registryVersion: fixture.traces[1]!.registryVersion,
      },
    });

    const finalShots = result.shotContracts.map(({ source }) => ({ source, compile }));
    const g6 = promptContractSummary(result.shotContracts.map(({ contract }) => contract));
    expect(verifyCurrentPromptContracts({ shots: finalShots }, g6).valid).toBe(true);
    finalShots[1]!.source = { ...finalShots[1]!.source, fields: { ...fields, lighting: "左前侧冷光" } };
    expect(verifyCurrentPromptContracts({ shots: finalShots }, g6).reasons).toContain("PROMPT_CONTRACT_DRIFT:S02");
  });

  it("复用只减少重复调用，其他请求字节与无复用路径一致", async () => {
    const fixture = workerModelFixture();
    const reused = await evaluatePromptPackage(fixture.evaluation);
    const unregistered = { ...fixture.reviewer, reuse: true };
    const fresh = await evaluatePromptPackage({ ...fixture.evaluation, reviewer: unregistered });
    expect(fixture.calls).toEqual([
      "review:S01", "review:S02", "repair:S01", "review:S01",
      "review:S01", "review:S02", "repair:S01", "review:S01", "review:S02",
    ]);
    expect(fixture.requests.slice(4)).toEqual([...fixture.requests.slice(0, 4), fixture.requests[1]]);
    expect(reused.shotContracts.map(({ contract }) => contract.prompt)).toEqual(fresh.shotContracts.map(({ contract }) => contract.prompt));
    expect(promptContractSummary(reused.shotContracts.map(({ contract }) => contract))).toEqual(
      promptContractSummary(fresh.shotContracts.map(({ contract }) => contract)),
    );
    expect(fresh.semanticReports.every((item) => item.proofReuse === undefined)).toBe(true);
    expect(fresh).toMatchObject({ status: reused.status, g6Eligible: reused.g6Eligible, findings: reused.findings });
  });

  const changesDuringRepair: Array<[string, (fixture: ReturnType<typeof workerModelFixture>) => void]> = [
    ["上游原文", ({ evaluation }) => { evaluation.upstreamContext.intent += "；修复时上游发生变化"; }],
    ["模型能力版本", ({ evaluation }) => {
      evaluation.shots[1]!.compile = { ...compile, model: { ...compile.model, version: "catalog-changed" } };
    }],
    ["路由重新装配", ({ llm, router }) => { llm.attachRouter(router); }],
    ["场景策略内容", ({ router }) => { router.policy.scenes.preproduction!.thinking = { type: "enabled", effort: "max" }; }],
    ["场景策略版本", ({ router }) => { router.policy.version += "-changed"; }],
    ["供应商身份", ({ router }) => {
      router.providers.set("deepseek-flash", new OpenAiCompatibleProvider("deepseek-flash", {
        baseUrl: "http://g6-fixture.invalid/v1", apiKey: "fixture-only",
      }));
    }],
    ["供应商方法", ({ router }) => {
      const provider = router.providers.get("deepseek-flash")!;
      provider.chat = provider.chat.bind(provider);
    }],
    ["评审器方法", ({ reviewer }) => { reviewer.review = reviewer.review.bind(reviewer); }],
    ["适配器方法", ({ llm }) => { llm.reasonStructured = llm.reasonStructured.bind(llm); }],
  ];

  it.each(changesDuringRepair)("修复时%s漂移，旧证明不能命中", async (_name, mutate) => {
    const fixture = workerModelFixture();
    fixture.onRepair.mockImplementationOnce(() => { mutate(fixture); });
    const result = await evaluatePromptPackage(fixture.evaluation);
    expect(result.status).toBe("passed");
    expect(fixture.calls).toEqual(["review:S01", "review:S02", "repair:S01", "review:S01", "review:S02"]);
    expect(result.semanticReports[1]!.proofReuse).toBeUndefined();
  });

  it("修复后的确定性错误在任何语义证明消费前阻断", async () => {
    const fixture = workerModelFixture();
    fixture.onRepair.mockReturnValueOnce({ changes: [{ field: "camera_movement", value: "TODO", reason: "制造缺失字段" }] });
    const result = await evaluatePromptPackage(fixture.evaluation);
    expect(fixture.calls).toEqual(["review:S01", "review:S02", "repair:S01"]);
    expect(result.status).toBe("stalled");
    expect(result.g6Eligible).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ shotId: "S01", code: "HARD_FIELD_VALUE_MISSING" }));
    expect(result.semanticReports).toEqual([]);
  });

  it("变化镜头复验缺一问仍按原预算重试并停止", async () => {
    const fixture = workerModelFixture();
    fixture.onReview.mockImplementation((context: { fields: Array<{ value: string }> }, response: SemanticQualityReview) => {
      if (response.shotId === "S01" && context.fields.some((field) => field.value === repairedCamera)) response.checks.pop();
      return response;
    });
    const result = await evaluatePromptPackage(fixture.evaluation);
    expect(fixture.calls).toEqual(["review:S01", "review:S02", "repair:S01", "review:S01", "review:S01"]);
    expect(result).toMatchObject({ status: "stalled", g6Eligible: false, renderEligible: false });
    expect(result.semanticReports[0]).toMatchObject({ valid: false, technicalRetry: 1 });
    expect(result.semanticReports[1]!.proofReuse?.sourcePass).toBe(1);
  });

  it("首轮无效语义报告不会成为通过证明，也不触发修复", async () => {
    const fixture = workerModelFixture();
    fixture.onReview.mockImplementation((_context: unknown, response: SemanticQualityReview) =>
      response.shotId === "S02" ? { ...response, checks: [] } : response);
    const result = await evaluatePromptPackage(fixture.evaluation);
    expect(fixture.calls).toEqual(["review:S01", "review:S02", "review:S02"]);
    expect(result.status).toBe("stalled");
    expect(result.semanticReports[1]).toMatchObject({ valid: false, technicalRetry: 1 });
    expect(result.semanticReports.every((report) => report.proofReuse === undefined)).toBe(true);
  });

  it("新鲜复验传输故障保留原重试且发生路由故障时不消费证明", async () => {
    const fixture = workerModelFixture();
    fixture.onReview.mockImplementation((context: { fields: Array<{ value: string }> }, response: SemanticQualityReview) =>
      response.shotId === "S01" && context.fields.some((field) => field.value === repairedCamera)
        ? new Response("offline transport failure", { status: 503 }) : response);
    const result = await evaluatePromptPackage(fixture.evaluation);
    expect(fixture.calls).toEqual(["review:S01", "review:S02", "repair:S01", "review:S01", "review:S01", "review:S02"]);
    expect(result).toMatchObject({ status: "stalled", g6Eligible: false });
    expect(result.semanticReports[1]!.proofReuse).toBeUndefined();
  });

  it("同一个 reviewer 的并发 evaluate 各自首轮评审与复用", async () => {
    const fixture = workerModelFixture();
    const results = await Promise.all([
      evaluatePromptPackage(fixture.evaluation),
      evaluatePromptPackage({ ...fixture.evaluation, projectId: "P2", runId: "R2", stageRunId: "SR2" }),
    ]);
    expect(fixture.calls.filter((call) => call === "review:S02")).toHaveLength(2);
    expect(fixture.calls).toHaveLength(8);
    for (const result of results) {
      expect(result.status).toBe("passed");
      expect(result.semanticReports[1]!.proofReuse?.sourcePass).toBe(1);
    }
    const again = await evaluatePromptPackage(fixture.evaluation);
    expect(fixture.calls).toHaveLength(12);
    expect(again.semanticReports[1]!.proofReuse?.sourcePass).toBe(1);
  });

  it.each(["shadow", "enforce"] as const)("%s 无定点修复时每镜只有首轮评审", async (mode) => {
    const fixture = workerModelFixture();
    if (mode === "enforce") {
      fixture.onReview.mockImplementation((_context: unknown, response: SemanticQualityReview) => ({ ...passReview(), shotId: response.shotId }));
    }
    const result = await evaluatePromptPackage({ ...fixture.evaluation, mode });
    expect(fixture.calls).toEqual(["review:S01", "review:S02"]);
    expect(result.status).toBe(mode === "shadow" ? "shadow" : "passed");
    expect(result.semanticReports.every((report) => report.proofReuse === undefined)).toBe(true);
  });
});

describe("prompt semantic quality gate", () => {
  function currentG4(shotId = "S01") {
    return { approvedProductionPlan: { g4ArtifactSha256: "a".repeat(64), requirementContractHash: "b".repeat(64),
      scenes: [{ shotId, sceneId: shotId, approvedScene: { actions: [{ actorId: "lead", description: "走到栏杆旁" }] },
        verificationPlan: { visualRequirements: ["看清走近栏杆"] } }] } };
  }

  function isolatedRedundancyShot() {
    const shaped: Record<string, string> = {
      lighting: "柔和侧光保留面部细节。", composition: "中景保留栏杆与人物的位置关系。", color_palette: "暖灰与浅木色。",
      depth_of_field: "中景清晰。", mood: "安静。", director_instruction: "纪录摄影，观察动作。",
      scene: "清晨临水回廊，薄雾贴着水面。", pacing: "先快后稳。", makeup: "自然裸妆。",
    };
    const sizes = [178, 145, 123, 83, 5, 184, 202, 98, 46];
    const draftFields: Record<string, unknown> = { ...fields, ...Object.fromEntries(Object.entries(shaped).map(([key, value], index) =>
      [key, value.repeat(sizes[index]!).slice(0, sizes[index])])) };
    const draft = { source: { ...source, fields: draftFields }, compile };
    const length = compilePromptPackage({ shots: [draft] })[0]!.contract.prompt.length;
    expect(length).toBeLessThan(3619);
    draftFields.costume = String(draftFields.costume) + "织".repeat(3619 - length);
    expect(compilePromptPackage({ shots: [draft] })[0]!.contract.prompt.length).toBe(3619);
    return { draft, shaped };
  }

  it("reaches independent review and uses one bounded repair when the measured five-field budget alone is impossible", async () => {
    const { draft, shaped } = isolatedRedundancyShot();
    const review = vi.fn(async () => {
      const result = passReview();
      result.checks[3] = { ...result.checks[3]!, evidence: shaped.lighting! };
      return result;
    });
    const repair = vi.fn<NonNullable<SemanticQualityReviewer["repair"]>>(async context => {
      expect([...context.allowedFields].sort()).toEqual(Object.keys(shaped).sort());
      expect(context.finalPromptFieldBudget).toMatchObject({ actualChars: 3619, maxFinalPromptChars: 3000, semanticFields: [] });
      for (const field of ["action", "timeline", "negative", "portraits", "audio", "transition", "costume"]) {
        expect(context.allowedFields).not.toContain(field);
      }
      return { changes: Object.entries(shaped).filter(([field, value]) => value.length < String(draft.source.fields[field]).length)
        .map(([field, value]) => ({ field, value, reason: "精简重复描述" })) };
    });
    const before = compilePromptPackage({ shots: [draft] })[0]!.contract;
    const result = await evaluatePromptPackage({ ...input({ review, repair }), shots: [draft],
      maxFinalPromptChars: 3000, upstreamContext: currentG4() });
    const after = result.shotContracts[0]!.contract;
    expect(result.g6Eligible, JSON.stringify({ findings: result.findings, reports: result.semanticReports,
      repairReason: result.repairAttempt?.reason })).toBe(true);
    expect(after.prompt.length).toBeLessThanOrEqual(3000);
    expect(after.requestSha256).toBe(before.requestSha256);
    expect(review).toHaveBeenCalledTimes(2);
    expect(repair).toHaveBeenCalledTimes(1);
    for (const field of ["action", "timeline", "negative", "portraits", "audio", "transition", "costume"]) {
      expect(after.bindings.find(row => row.field === field)?.valueSha256).toBe(before.bindings.find(row => row.field === field)?.valueSha256);
    }
  });

  it.each(["missing", "wrong-shot", "shadow"] as const)("never opens broader write scope for %s", async boundary => {
    const { draft } = isolatedRedundancyShot();
    const review = vi.fn(async () => passReview()), repair = vi.fn();
    const result = await evaluatePromptPackage({ ...input({ review, repair }, boundary === "shadow" ? "shadow" : "enforce"),
      shots: [draft], maxFinalPromptChars: 3000,
      ...(boundary !== "missing" ? { upstreamContext: currentG4(boundary === "wrong-shot" ? "foreign-shot" : "S01") } : {}) });
    expect(result.g6Eligible).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "HARD_FINAL_PROMPT_TOO_LONG", repairClass: "deterministic" }));
    expect(review).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
  });

  it.each([false, true])("only permits a current G4 diagnosed transition repair that retains the hard cut (drift=%s)", async drift => {
    const shot = { source: { ...source, fields: { ...fields, transition: "硬切入镜，末秒冻结画面。" } }, compile };
    const first = passReview();
    first.checks[4] = { id: "SQ5_PURPOSE", pass: false, field: "transition", evidence: "末秒冻结画面",
      failureCode: "REQUIRED_END_MOTION_MISSING", repair: "保留硬切，末态保留自然动作" };
    const review = vi.fn<SemanticQualityReviewer["review"]>().mockResolvedValueOnce(first).mockResolvedValueOnce(passReview());
    const repair = vi.fn<NonNullable<SemanticQualityReviewer["repair"]>>(async context => {
      expect(context.allowedFields).toEqual(["transition"]);
      return { changes: [{ field: "transition", value: drift ? "叠化入镜，末态保留微动。" : "硬切入镜，末态保留微动。", reason: "去掉冻结" }] };
    });
    const prior = compilePromptPackage({ shots: [shot] })[0]!.contract;
    expect(parseSemanticQualityReview(first, prior, shot.source).errors).toContain("SEMANTIC_REVIEW_FIELD_INVALID:SQ5_PURPOSE");
    const result = await evaluatePromptPackage({ ...input({ review, repair }), shots: [shot], maxFinalPromptChars: 3000,
      upstreamContext: currentG4() });
    expect(result.g6Eligible).toBe(!drift);
    expect(result.shotContracts[0]!.contract.requestSha256).toBe(prior.requestSha256);
    expect(repair).toHaveBeenCalledTimes(1);
    if (drift) expect(result.repairAttempt?.reason).toBe("APPROVED_TRANSITION_REPAIR_DRIFT");
    else expect(result.shotContracts[0]!.contract.prompt).toContain("硬切入镜，末态保留微动。");
  });

  it("G6 and G7 enforce the same inclusive UTF-16 final limit even when an oversized contract summary matches", async () => {
    const review = vi.fn(async () => passReview());
    const exact = shotAtFinalLength(3000);
    const oversized = shotAtFinalLength(3001);
    const maxFinalPromptChars = 3000;
    for (const [shot, valid] of [[exact, true], [oversized, false]] as const) {
      const gateInput = { ...input({ review }), shots: [shot], maxFinalPromptChars };
      const summary = promptContractSummary(compilePromptPackage(gateInput).map(item => item.contract));
      const g6 = await evaluatePromptPackage(gateInput);
      expect(g6.g6Eligible).toBe(valid);
      expect(promptQualityAutoChecks(g6)).toContainEqual(expect.objectContaining({
        id: "prompt-final-native-length", status: valid ? "passed" : "failed",
      }));
      expect(verifyCurrentPromptContracts(gateInput, summary)).toMatchObject({
        valid, reasons: valid ? [] : ["S01:HARD_FINAL_PROMPT_TOO_LONG:stage"],
      });
    }
    expect(review).toHaveBeenCalledTimes(1);
  });

  it.each([
    { field: "action", value: "原地不动", reason: "REPAIR_CHANGE_INVALID:0" },
    { field: "color_palette", value: " ", reason: "FINAL_PROMPT_REPAIR_NOT_SHORTER" },
    { field: "color_palette", value: "短", reason: "SAME_FAILURE_SIGNATURE_REPEATED" },
  ])("stops a failed final-length repair once ($reason)", async ({ field, value, reason }) => {
    const review = vi.fn(async () => passReview());
    const repair = vi.fn(async () => ({ changes: [{ field, value, reason: "定点缩写" }] }));
    const shot = shotAtFinalLength(3001);
    if (reason === "SAME_FAILURE_SIGNATURE_REPEATED") {
      const prior = shot.source.fields.color_palette;
      const next = { ...shot, source: { ...shot.source, fields: { ...shot.source.fields, color_palette: prior + "灰" } } };
      repair.mockResolvedValueOnce({ changes: [{ field, value: prior, reason: "只缩短一字" }] });
      const result = await evaluatePromptPackage({ ...input({ review, repair }), shots: [next], maxFinalPromptChars: 3000 });
      expect(result.repairAttempt?.reason).toBe(reason);
      expect(result.shotContracts[0]!.contract.prompt.length).toBe(3001);
    } else {
      const result = await evaluatePromptPackage({ ...input({ review, repair }), shots: [shot], maxFinalPromptChars: 3000 });
      expect(result.repairAttempt?.reason).toBe(reason);
      expect(result.g6Eligible).toBe(false);
    }
    expect(repair).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("keeps one repair per overflowing shot in the same pass and rechecks all five for both", async () => {
    const review = vi.fn(async context => ({ ...passReview(), shotId: context.contract.shotId }));
    const repair = vi.fn(async context => {
      const value = (context.shot.fields as Record<string, string>).color_palette!.slice(0, -1);
      return { changes: [{ field: "color_palette", value, reason: "去掉重复字" }] };
    });
    const result = await evaluatePromptPackage({ ...input({ review, repair }), maxFinalPromptChars: 3000,
      shots: [shotAtFinalLength(3001), shotAtFinalLength(3001, "S02")] });
    expect(result.g6Eligible).toBe(true);
    expect(result.shotContracts.map(item => item.contract.prompt.length)).toEqual([3000, 3000]);
    expect(result.semanticReports.map(report => report.checks.length)).toEqual([5, 5]);
    expect(repair).toHaveBeenCalledTimes(2);
    expect(review).toHaveBeenCalledTimes(4);
  });

  it("repairs approved actions, timeline and camera in the same capped pass without changing the other request channels", async () => {
    const shot = shotAtFinalLength(3143);
    const action = "林夏先走到栏杆前，再从手边拿起木片并放回。",
      timeline = "T00:00–T00:02走到栏杆；T00:02–T00:05拿起木片并放回。",
      camera = "固定机位，中景完整看清两步动作。";
    const approvedProductionPlan = { scenes: [{ shotId: "S01", sceneId: "opening",
      verificationPlan: { visualRequirements: ["先走到栏杆，再完整表现拿起和放回木片"] } }] };
    const review = vi.fn<SemanticQualityReviewer["review"]>().mockImplementationOnce(async () => {
      const result = failCameraReview();
      result.checks[0] = { id: "SQ1_SUBJECT_ACTION", pass: false, field: "action", evidence: String(fields.action),
        failureCode: "APPROVED_ACTION_MISSING", repair: "实际呈现拿起和放回" };
      result.checks[1] = { id: "SQ2_SCENE_PROPS", pass: false, field: "timeline", evidence: String(fields.timeline),
        failureCode: "APPROVED_PROP_HANDOFF_MISSING", repair: "把道具交接写在既有时间轴" };
      return result;
    }).mockImplementationOnce(async () => {
      const result = passReview();
      result.checks[2] = { ...result.checks[2]!, evidence: camera };
      return result;
    });
    const repair = vi.fn<NonNullable<SemanticQualityReviewer["repair"]>>().mockImplementation(async context => {
      expect(context.allowedFields).toEqual(expect.arrayContaining(["color_palette", "action", "timeline", "camera_movement"]));
      expect(context.allowedFields).not.toContain("audio");
      expect(context.finalPromptFieldBudget).toMatchObject({ actualChars: 3143, maxFinalPromptChars: 3000,
        semanticFields: ["action", "timeline", "camera_movement"] });
      expect(context.finalPromptFieldBudget!.fixedChars + context.finalPromptFieldBudget!.maxEditableValueChars).toBe(3000);
      expect(context.finalPromptFieldBudget!.targetEditableValueChars).toBeLessThan(context.finalPromptFieldBudget!.maxEditableValueChars);
      expect(context.upstreamContext?.approvedProductionPlan).toEqual(approvedProductionPlan);
      return { changes: Object.entries({ color_palette: "冷灰水面、浅木色回廊。", action, timeline, camera_movement: camera })
        .map(([field, value]) => ({ field, value, reason: "在已审动作和总长度内修复" })) };
    });
    const result = await evaluatePromptPackage({ ...input({ review, repair }), shots: [shot], maxFinalPromptChars: 3000,
      upstreamContext: { approvedProductionPlan } });
    expect(result.g6Eligible).toBe(true);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(2);
    const before = compilePromptPackage({ shots: [shot] })[0]!.contract, after = result.shotContracts[0]!.contract;
    expect(after.prompt.length).toBeLessThanOrEqual(3000);
    expect(after.prompt).toContain(action);
    expect(after.request).toEqual({ ...before.request, technical: { ...before.request.technical, timeline } });
  });

  it("sends the approved plan and verifies missing actions as visible events in the native reviewer prompt", async () => {
    const approvedProductionPlan = { scenes: [{ shotId: "S01", sceneId: "actual-scene-1", verificationPlan: { action: "两步原始动作" } }] };
    const reasonStructured = vi.fn(async (prompt: string) => {
      expect(prompt).toContain("actual-scene-1");
      expect(prompt).toContain("只写动作已经完成、跳过关键前后状态、用结果代替过程");
      return { success: true, data: passReview() };
    });
    const reviewer = createLlmSemanticQualityReviewer({ model: "test-model", reasonStructured } as never);
    expect((await evaluatePromptPackage({ ...input(reviewer), upstreamContext: { approvedProductionPlan } })).g6Eligible).toBe(true);
    expect(reasonStructured).toHaveBeenCalledTimes(1);
  });

  it("blocks a malformed cap or compiler hard error before review and length repair", async () => {
    const review = vi.fn(async () => passReview());
    const repair = vi.fn();
    const shot = shotAtFinalLength(3001);
    const gateInput = { ...input({ review, repair }), maxFinalPromptChars: 3000, shots: [
      { ...shot, compile: { ...shot.compile, model: { ...shot.compile.model, maxPromptChars: 2999 } } },
    ] };
    const result = await evaluatePromptPackage(gateInput);
    expect(result.g6Eligible).toBe(false);
    expect(result.findings.map(finding => finding.code)).toContain("HARD_PROMPT_TOO_LONG");
    await expect(evaluatePromptPackage({ ...gateInput, maxFinalPromptChars: Number.NaN })).rejects.toThrow("FINAL_PROMPT_LENGTH_LIMIT_INVALID");
    expect(review).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
  });

  it.each(["S01", "S02"])("the LLM output example for %s satisfies the same identity and pass/failure schema as the parser", async shotId => {
    const reasonStructured = vi.fn(async (_prompt: string, schema: unknown) => {
      const example = schema as SemanticQualityReview;
      const contract = compilePromptPackage({ shots: [{ source: { ...source, shotId }, compile }] })[0]!.contract;
      expect(parseSemanticQualityReview(example, contract).errors).toEqual([]);
      return { success: true, data: { ...passReview(), shotId } };
    });
    const reviewer = createLlmSemanticQualityReviewer({ model: "test-model", reasonStructured } as never);
    expect((await evaluatePromptPackage({ ...input(reviewer), shots: [{ source: { ...source, shotId }, compile }] })).status).toBe("passed");
    expect(reasonStructured).toHaveBeenCalledTimes(1);
  });

  it("accepts only five complete, evidence-bearing binary checks", () => {
    const parsed = parseSemanticQualityReview(passReview(), {
      shotId: "S01",
      fieldSchema: "workloom.video-shot-card/v2",
      fieldCount: 25,
      bindings: Object.keys(fields).map((field) => ({ field, valueSha256: "a".repeat(64), channels: ["prompt" as const] })),
    } as never, source);
    expect(parsed.valid).toBe(true);
    const missing = passReview();
    missing.checks.pop();
    expect(parseSemanticQualityReview(missing, {
      shotId: "S01",
      fieldSchema: "workloom.video-shot-card/v2",
      fieldCount: 25,
      bindings: Object.keys(fields).map((field) => ({ field, valueSha256: "a".repeat(64), channels: ["prompt" as const] })),
    } as never, source).valid).toBe(false);
  });

  it("does not call semantic review when deterministic contract checks fail", async () => {
    const review = vi.fn(async () => passReview());
    const bad = { ...source, fields: { ...fields, scene: "" } };
    const result = await evaluatePromptPackage({
      ...input({ review }),
      shots: [{ source: bad, compile }],
    });
    expect(review).not.toHaveBeenCalled();
    expect(result.status).toBe("rejected");
    expect(result.findings.some((finding) => finding.code === "HARD_FIELD_VALUE_MISSING")).toBe(true);
  });

  it("shadow records the same rejection without becoming a blocking decision", async () => {
    const result = await evaluatePromptPackage({
      ...input({ review: vi.fn(async () => passReview()) }, "shadow"),
      shots: [{ source: { ...source, fields: { ...fields, scene: "" } }, compile }],
    });
    expect(result.status).toBe("shadow");
    expect(result.renderEligible).toBe(false);
    expect(result.decision.status).toBe("rejected");
  });

  it("retries an invalid semantic response once and then stalls without changing fields", async () => {
    const review = vi.fn(async () => ({ shotId: "S01", checks: [] }));
    const result = await evaluatePromptPackage(input({ review }));
    expect(review).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("stalled");
    expect(result.semanticReports[0]?.technicalRetry).toBe(1);
    expect(result.findings[0]?.code).toBe("SEMANTIC_REVIEW_INVALID");
    expect(promptQualityAutoChecks(result).some((check) =>
      check.id === "prompt-quality-stalled" && check.category === "policy" && check.status === "failed")).toBe(true);
  });

  it("allows one exact field repair, then re-runs all five checks and full contract compilation", async () => {
    let repaired = false;
    const reviewer: SemanticQualityReviewer = {
      model: "test-reviewer",
      review: async () => repaired ? passReview() : failCameraReview(),
      repair: async () => {
        repaired = true;
        return { changes: [{ field: "camera_movement", value: "固定机位，缓慢推近一个动作", reason: "在时长内可完成" }] };
      },
    };
    const result = await evaluatePromptPackage(input(reviewer));
    expect(result.status).toBe("passed");
    expect(result.repairAttempt).toMatchObject({ status: "applied", allowedFields: ["camera_movement"] });
    expect(result.shotContracts[0]?.contract.request.parameters.camera_fixed).toBe(true);
    expect(result.g6Eligible).toBe(true);
    expect(result.renderEligible).toBe(false);
    expect(promptQualityAutoChecks(result)).toHaveLength(6);
  });

  it("stalls forbidden changes and unchanged repair output", async () => {
    const forbidden: SemanticQualityReviewer = {
      review: async () => failCameraReview(),
      repair: async () => ({ changes: [{ field: "scene", value: "另一个场景", reason: "扩写" }] }),
    };
    expect((await evaluatePromptPackage(input(forbidden))).status).toBe("stalled");

    const unchanged: SemanticQualityReviewer = {
      review: async () => failCameraReview(),
      repair: async () => ({ changes: [{ field: "camera_movement", value: fields.camera_movement, reason: "没有变化" }] }),
    };
    expect((await evaluatePromptPackage(input(unchanged))).status).toBe("stalled");
  });

  it("authorizes only the fields that failed on the current shot, even when another shot failed a different field", async () => {
    const seen: Array<{ shotId: string; allowedFields: string[] }> = [];
    const reviewer: SemanticQualityReviewer = {
      review: async context => {
        const review = passReview(); review.shotId = context.contract.shotId;
        const current = context.shot.fields as Record<string, unknown>;
        if (context.contract.shotId === "S01" && current.camera_movement === fields.camera_movement) return failCameraReview();
        if (context.contract.shotId === "S02" && current.lighting === fields.lighting) review.checks[3] = {
          id: "SQ4_LIGHT_COLOR", pass: false, field: "lighting", failureCode: "LIGHT_DIRECTION_UNCLEAR",
          evidence: String(fields.lighting), repair: "只明确lighting中的主光方向",
        };
        return review;
      },
      repair: async context => {
        seen.push({ shotId: context.contract.shotId, allowedFields: context.allowedFields });
        return { changes: [{ field: context.contract.shotId === "S01" ? "camera_movement" : "lighting",
          value: context.contract.shotId === "S01" ? "固定机位" : "侧后方晨光", reason: "定点修复" }] };
      },
    };
    const result = await evaluatePromptPackage({ ...input(reviewer), shots: [
      { source, compile }, { source: { ...source, shotId: "S02" }, compile },
    ] });
    expect(result.status).toBe("passed");
    expect(seen).toEqual([{ shotId: "S01", allowedFields: ["camera_movement"] }, { shotId: "S02", allowedFields: ["lighting"] }]);
  });

  it("records contract, semantic and decision evidence with stable file hashes", async () => {
    const result = await evaluatePromptPackage(input({ review: async () => passReview() }));
    const dir = mkdtempSync(path.join(tmpdir(), "prompt-quality-"));
    try {
      const evidence = writePromptQualityEvidence(dir, result);
      for (const file of [
        ...evidence.contracts.map((item) => item.path),
        evidence.semanticReportPath,
        evidence.decisionPath,
      ]) {
        expect(readFileSync(file, "utf8").length).toBeGreaterThan(20);
      }
      expect(evidence.sha256.contracts).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.parse(readFileSync(evidence.decisionPath, "utf8")).gateId).toBe("G6_PROMPT");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("G7 detects field, prompt and request drift from the current G6 contracts", () => {
    const compiled = compilePromptPackage({ shots: [{ source, compile }] });
    const summary = promptContractSummary(compiled.map((item) => item.contract));
    expect(verifyCurrentPromptContracts({ shots: [{ source, compile }] }, summary).valid).toBe(true);
    const changed = {
      ...source,
      fields: { ...fields, timeline: "T00:00至T00:09，T00:09停稳。" },
    };
    const drift = verifyCurrentPromptContracts({ shots: [{ source: changed, compile }] }, summary);
    expect(drift.valid).toBe(false);
    expect(drift.reasons).toContain("PROMPT_CONTRACT_DRIFT:S01");
  });
});
