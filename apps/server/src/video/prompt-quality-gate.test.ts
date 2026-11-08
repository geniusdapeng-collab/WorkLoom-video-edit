import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SEMANTIC_QUALITY_CHECK_IDS,
  createLlmSemanticQualityReviewer,
  evaluatePromptPackage,
  compilePromptPackage,
  parseSemanticQualityReview,
  promptQualityAutoChecks,
  promptQualityRunProjection,
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

function failLightingReview() {
  const review = passReview();
  review.checks[3] = {
    ...review.checks[3]!,
    pass: false,
    field: "lighting",
    failureCode: "LIGHT_DIRECTION_UNCLEAR",
    evidence: "lighting：侧后方晨光与水面反射补光",
    repair: "只修改 lighting，明确主光方向",
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

function workerModelFixture({ rejectDuplicates = false } = {}) {
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
    const request = String(init?.body);
    const duplicate = requests.includes(request);
    requests.push(request);
    const { messages, model } = JSON.parse(requests.at(-1)!);
    const prompt = String(messages.at(-1).content);
    const section = prompt.split("\n\n【硬性输出要求】", 1)[0]!;
    const repairing = section.startsWith("你是字段级定点修复器。");
    const context = JSON.parse(section.slice(repairing ? section.indexOf("镜头：{") + 3 : section.indexOf("\n{\n") + 1));
    const shotId = String(context.shotId);
    calls.push(`${repairing ? "repair" : "review"}:${shotId}`);
    if (rejectDuplicates && duplicate) return new Response("duplicate provider request denied", { status: 409 });
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
      id: `g6-fixture-${calls.length}`, model, object: "chat.completion",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: typeof payload === "string" ? payload : JSON.stringify(payload) } }],
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
  it("isolates a failed repair to its own shot while another failed shot is repaired", async () => {
    const repairedLighting = "左前方柔和主光，右侧水面反射补光。";
    const review = vi.fn<SemanticQualityReviewer["review"]>(async ({ contract, shot }) => {
      const current = shot.fields as Record<string, unknown>;
      const row = contract.shotId === "S01" && current.camera_movement === fields.camera_movement
        ? failCameraReview() : contract.shotId === "S02" && current.lighting === fields.lighting
          ? failLightingReview() : passReview();
      row.checks[3]!.evidence = `lighting：${String(current.lighting)}`;
      row.shotId = contract.shotId;
      return row;
    });
    const repair = vi.fn<NonNullable<SemanticQualityReviewer["repair"]>>(async context => {
      if (context.contract.shotId === "S01") throw new Error("REPAIR_PROVIDER_UNAVAILABLE");
      return { changes: [{ field: "lighting", value: repairedLighting, reason: "明确主光方向" }] };
    });
    const result = await evaluatePromptPackage({ ...input({ review, repair }), shots: [
      { source, compile },
      { source: { ...source, shotId: "S02" }, compile },
    ] });
    expect(review.mock.calls.map(([context]) => context.contract.shotId)).toEqual(["S01", "S02", "S02"]);
    expect(repair.mock.calls.map(([context]) => context.contract.shotId)).toEqual(["S01", "S02"]);
    expect(result).toMatchObject({ status: "stalled", g6Eligible: false, renderEligible: false });
    expect(result.findings).toEqual([
      expect.objectContaining({ shotId: "S01", code: "CAMERA_COMPLEXITY_EXCEEDS_DURATION" }),
    ]);
    expect(result.shotContracts.find(item => item.shotId === "S01")?.source.fields)
      .toEqual({ ...fields });
    expect(result.shotContracts.find(item => item.shotId === "S02")?.source.fields)
      .toEqual({ ...fields, lighting: repairedLighting });
    expect(result.repairAttempt).toMatchObject({
      status: "stalled",
      reason: "REPAIR_PROVIDER_UNAVAILABLE",
      changes: [{ shotId: "S02", field: "lighting", reason: "明确主光方向" }],
    });
    expect(result.shotOutcomes).toEqual([
      expect.objectContaining({
        shotId: "S01", status: "quarantined", technicalRetry: 0, contentRepairAttempts: 1,
        findingCodes: ["CAMERA_COMPLEXITY_EXCEEDS_DURATION"],
      }),
      expect.objectContaining({
        shotId: "S02", status: "repaired", technicalRetry: 0, contentRepairAttempts: 1,
        findingCodes: [],
      }),
    ]);
  });

  it("reviews a structurally valid shot even when another shot has a hard contract error", async () => {
    const repairedLighting = "正前方柔和主光。";
    const bad = { ...source, fields: { ...fields, scene: "" } };
    const review = vi.fn<SemanticQualityReviewer["review"]>(async ({ contract, shot }) => {
      const current = shot.fields as Record<string, unknown>;
      const row = current.lighting === fields.lighting ? failLightingReview() : passReview();
      row.checks[3]!.evidence = `lighting：${String(current.lighting)}`;
      row.shotId = contract.shotId;
      return row;
    });
    const repair = vi.fn<NonNullable<SemanticQualityReviewer["repair"]>>(async () => ({
      changes: [{ field: "lighting", value: repairedLighting, reason: "明确主光方向" }],
    }));
    const result = await evaluatePromptPackage({ ...input({ review, repair }), shots: [
      { source: bad, compile },
      { source: { ...source, shotId: "S02" }, compile },
    ] });
    expect(review.mock.calls.map(([context]) => context.contract.shotId)).toEqual(["S02", "S02"]);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("stalled");
    expect(result.findings).toEqual([
      expect.objectContaining({ shotId: "S01", code: "HARD_FIELD_VALUE_MISSING" }),
    ]);
    expect(result.shotOutcomes).toEqual([
      expect.objectContaining({
        shotId: "S01", status: "needs_upstream", contentRepairAttempts: 0,
        findingCodes: ["HARD_FIELD_VALUE_MISSING"],
      }),
      expect.objectContaining({
        shotId: "S02", status: "repaired", contentRepairAttempts: 1, findingCodes: [],
      }),
    ]);
  });

  it("builds the repair response example from the diagnosed writable field", async () => {
    const calls: Array<{ prompt: string; schema: unknown }> = [];
    const engine = {
      model: "fixture-model",
      reasonStructured: vi.fn(async (prompt: string, schema: unknown) => {
        calls.push({ prompt, schema });
        return { success: true, data: { changes: [{ field: "lighting", value: "正前方柔和主光。", reason: "明确主光方向" }] } };
      }),
    };
    const reviewer = createLlmSemanticQualityReviewer(engine as never);
    const contract = compilePromptPackage({ shots: [{ source, compile }] })[0]!.contract;
    await reviewer.repair!({
      projectId: "P1", runId: "R1", stageRunId: "SR1", shot: source, contract, attempt: 1,
      findings: failLightingReview().checks.filter(check => !check.pass),
      allowedFields: ["lighting"],
    });
    expect(calls[0]!.prompt).toContain("只允许修改 allowedFields");
    expect(calls[0]!.schema).toMatchObject({
      changes: [{ field: "lighting", reason: "只修改 lighting，明确主光方向" }],
    });
    expect(JSON.stringify(calls[0]!.schema)).not.toContain("camera_movement");
  });

  it.each([
    ["JSON 语法", '{"fixture_private_previous_payload":', "SEMANTIC_REVIEW_JSON_SYNTAX"],
    ["评审契约", { shotId: "S02", checks: [] }, "SEMANTIC_REVIEW_CONTRACT_INVALID"],
  ])("首轮%s失败仅作一次有区别的技术纠正，并复用未变镜头的通过证明", async (_label, malformed, failure) => {
    const fixture = workerModelFixture({ rejectDuplicates: true });
    let first = true;
    fixture.onReview.mockImplementation((_context: unknown, review: SemanticQualityReview) => {
      if (review.shotId === "S02" && first) { first = false; return malformed; }
      return review;
    });
    const result = await evaluatePromptPackage(fixture.evaluation);
    expect(fixture.calls).toEqual(["review:S01", "review:S02", "review:S02", "repair:S01", "review:S01"]);
    expect(result).toMatchObject({ status: "passed", g6Eligible: true, renderEligible: false });
    expect(result.semanticReports[1]).toMatchObject({ valid: true, technicalFailure: failure,
      proofReuse: { sourceTechnicalRetry: 1, sourceRequestSha256: fixture.traces[2]!.requestHash } });
    expect(result.shotOutcomes[1]).toMatchObject({
      shotId: "S02", status: "accepted", technicalRetry: 1, contentRepairAttempts: 0,
    });
    const initial = JSON.parse(fixture.requests[1]!);
    const corrected = JSON.parse(fixture.requests[2]!);
    expect(corrected.messages.at(-1).content).toMatch(/^【G6 评审响应技术纠正】\n/u);
    expect(corrected.messages.at(-1).content.endsWith(initial.messages.at(-1).content)).toBe(true);
    expect(corrected.messages.at(-1).content).not.toContain("fixture_private_previous_payload");
    expect(JSON.stringify(result.semanticReports)).not.toContain("fixture_private_previous_payload");
    const messages = corrected.messages.map((message: { role: string; content: string }, i: number) =>
      i === corrected.messages.length - 1 ? { ...message, content: initial.messages.at(-1).content } : message);
    expect({ ...corrected, messages }).toEqual(initial);
  });

  it.each([
    ["传输失败", () => new Response("offline", { status: 503 })],
    ["原样重复被拒绝", () => new Response("duplicate", { status: 409 })],
    ["完整空白", () => "   "],
    ["缺少真实身份的语法错误", () => Response.json({
      model: "deepseek-flash", choices: [{ finish_reason: "stop", message: { content: "{" } }],
      usage: { prompt_tokens: 300, completion_tokens: 100, total_tokens: 400 },
    })],
    ["无计量的评审契约错误", () => Response.json({
      id: "g6-unmeasured", model: "deepseek-flash", object: "chat.completion",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"shotId":"S01","checks":[]}' } }],
    })],
    ["有重复键的评审契约错误", () => '{"shotId":"S01","checks":[],"checks":[]}'],
  ])("首答%s不获得技术纠正资格", async (_label, makeResponse) => {
    const fixture = workerModelFixture({ rejectDuplicates: true });
    fixture.onReview.mockImplementation(makeResponse);
    const result = await evaluatePromptPackage(input(fixture.reviewer));
    expect(fixture.calls).toEqual(["review:S01"]);
    expect(result).toMatchObject({ status: "stalled", g6Eligible: false, renderEligible: false });
    expect(result.semanticReports[0]).toMatchObject({ valid: false, technicalRetry: 0 });
  });

  it.each([
    ["纠正再收到坏语法", () => '{"prior_private_payload":', "SEMANTIC_REVIEW_CORRECTION_INVALID"],
    ["纠正缺少当前镜号", () => ({ checks: passReview().checks }), "SEMANTIC_REVIEW_CORRECTION_INVALID"],
    ["纠正后路由漂移", ({ llm, router }: ReturnType<typeof workerModelFixture>) => {
      llm.attachRouter(router);
      return passReview();
    }, "SEMANTIC_REVIEW_CORRECTION_UNPROVEN"],
    ["纠正重放了原响应身份", () => Response.json({
      id: "g6-fixture-1", model: "deepseek-flash", object: "chat.completion",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(passReview()) } }],
      usage: { prompt_tokens: 300, completion_tokens: 100, total_tokens: 400 },
    }), "SEMANTIC_REVIEW_CORRECTION_UNPROVEN"],
  ])("%s即停止，并保留安全的首次失败", async (_label, makeResponse, error) => {
    const fixture = workerModelFixture({ rejectDuplicates: true });
    fixture.onReview.mockReturnValueOnce('{"first_private_payload":');
    fixture.onReview.mockImplementationOnce(() => makeResponse(fixture));
    const result = await evaluatePromptPackage(input(fixture.reviewer));
    expect(fixture.calls).toEqual(["review:S01", "review:S01"]);
    expect(result).toMatchObject({ status: "stalled", g6Eligible: false, renderEligible: false });
    expect(result.semanticReports[0]).toMatchObject({ valid: false, technicalRetry: 1, technicalFailure: "SEMANTIC_REVIEW_JSON_SYNTAX",
      errors: ["SEMANTIC_REVIEW_JSON_SYNTAX", error] });
    expect(JSON.stringify(result.semanticReports)).not.toContain("private_payload");
  });


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
    expect(result.semanticReports.map(report => report.shotId)).toEqual(["S02"]);
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

  it("首轮无效语义报告只隔离该镜，不阻止其他可修镜头收敛", async () => {
    const fixture = workerModelFixture();
    fixture.onReview.mockImplementation((_context: unknown, response: SemanticQualityReview) =>
      response.shotId === "S02" ? { ...response, checks: [] } : response);
    const result = await evaluatePromptPackage(fixture.evaluation);
    expect(fixture.calls).toEqual(["review:S01", "review:S02", "review:S02", "repair:S01", "review:S01"]);
    expect(result.status).toBe("stalled");
    expect(result.semanticReports[1]).toMatchObject({ valid: false, technicalRetry: 1 });
    expect(result.semanticReports.every((report) => report.proofReuse === undefined)).toBe(true);
    expect(result.shotOutcomes).toEqual([
      expect.objectContaining({ shotId: "S01", status: "repaired" }),
      expect.objectContaining({ shotId: "S02", status: "blocked" }),
    ]);
  });

  it("新鲜复验传输故障不作技术纠正，路由故障后不消费旧证明", async () => {
    const fixture = workerModelFixture();
    fixture.onReview.mockImplementation((context: { fields: Array<{ value: string }> }, response: SemanticQualityReview) =>
      response.shotId === "S01" && context.fields.some((field) => field.value === repairedCamera)
        ? new Response("offline transport failure", { status: 503 }) : response);
    const result = await evaluatePromptPackage(fixture.evaluation);
    expect(fixture.calls).toEqual(["review:S01", "review:S02", "repair:S01", "review:S01", "review:S02"]);
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
  it("continues a separate camera repair after omitting an unchanged description from a 3104-character opening", async () => {
    const opening = shotAtFinalLength(3104, "opening");
    const openingFields: Record<string, unknown> = opening.source.fields;
    const originalLighting = String(openingFields.lighting);
    const originalMood = String(openingFields.mood);
    openingFields.lighting = originalLighting + "侧光细节".repeat(35);
    opening.source.fields.color_palette = String(opening.source.fields.color_palette).slice(0, -140);
    expect(compilePromptPackage({ shots: [opening] })[0]!.contract.prompt.length).toBe(3104);
    const ending = { source: { ...source, shotId: "ending", fields: { ...fields } }, compile };
    const camera = "固定机位，保留轻微呼吸感与原有落幅。";
    const review = vi.fn<SemanticQualityReviewer["review"]>(async ({ contract, shot }) => {
      const row = contract.shotId === "ending" && (shot.fields as Record<string, unknown>).camera_movement !== camera
        ? failCameraReview() : passReview();
      return { ...row, shotId: contract.shotId };
    });
    const repair = vi.fn<NonNullable<SemanticQualityReviewer["repair"]>>(async ({ contract }) => ({
      changes: contract.shotId === "opening" ? [
        { field: "mood", value: originalMood, reason: "沿用未改情绪" },
        { field: "lighting", value: originalLighting, reason: "删除重复光线描写" },
      ] : [{ field: "camera_movement", value: camera, reason: "按现有时间轴调整运镜" }],
    }));
    const before = compilePromptPackage({ shots: [opening, ending] }).map(item => item.contract);
    const result = await evaluatePromptPackage({ ...input({ review, repair }), shots: [opening, ending], maxFinalPromptChars: 3000 });
    expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
    expect(repair.mock.calls.map(([context]) => context.contract.shotId)).toEqual(["opening", "ending"]);
    expect(repair.mock.calls[0]![0].finalPromptFieldBudget?.descriptiveFieldBudgets).toContainEqual({
      field: "lighting", currentValueChars: originalLighting.length + 140, maxChangedValueChars: originalLighting.length + 139,
    });
    expect(result.repairAttempt?.changes.map(({ shotId, field }) => [shotId, field])).toEqual([
      ["opening", "lighting"], ["ending", "camera_movement"],
    ]);
    expect(result.shotContracts.map(item => item.contract.requestSha256)).toEqual(before.map(contract => contract.requestSha256));
    expect(result.shotContracts[0]!.contract.prompt.length).toBeLessThanOrEqual(3000);
    expect(review).toHaveBeenCalledTimes(4);
  });

  function currentG4(shotId = "S01") {
    return { approvedProductionPlan: { g4ArtifactSha256: "a".repeat(64), requirementContractHash: "b".repeat(64),
      scenes: [{ shotId, sceneId: shotId, approvedScene: { actions: [{ actorId: "lead", description: "走到栏杆旁" }] },
        verificationPlan: { visualRequirements: ["看清走近栏杆"] } }] } };
  }

  it("repairs the two-pass shot's camera, action, and timeline together with the original request parameters", async () => {
    const checked = currentG4();
    const row = checked.approvedProductionPlan.scenes[0]!;
    const upstreamContext = { approvedProductionPlan: { ...checked.approvedProductionPlan, scenes: [{ ...row,
      interval: { startSec: 10, endSec: 20, brief: "两次超车针对两辆不同对手车，每次从车后到完全领先。" },
      approvedScene: { ...row.approvedScene, purpose: "先把第一辆对手车留在后方，再贴着第二辆对手车完成超车。" },
      verificationPlan: { visualRequirements: ["两次超车均完整看清从对手后方到完全领先。"] },
    }] } };
    const first = "先从第一辆对手车后方追近并排，整车越过第一辆对手车，第一辆对手车继续留在后方。";
    const second = "随后贴住第二辆对手车，车头越过其中段形成并排。";
    const secondFromRear = "随后从第二辆对手车后方追近，与同一第二辆对手车同向并排。";
    const clear = "主车车尾完全越过第二辆对手车前轮。";
    const finish = "前轮先压过黑白方格线，随后减速。";
    const shot = { source: { ...source, duration: 10, fields: { ...fields,
      camera_movement: "长焦保持同向。起幅落在第二辆对手车车尾与主角车头齐平的并排位置。",
      action: first + second + finish, timeline: `T00:00–T00:05：${first} T00:05–T00:10：${second}${finish}`,
    } }, compile };
    const revised = {
      camera_movement: "长焦同向侧跟，起幅从第一辆对手车后轮开始，随后跟住第二辆完整超越，再落到冲线。",
      action: first + secondFromRear + clear + finish,
      timeline: `T00:00–T00:04：${first} T00:04–T00:07：${secondFromRear}${clear} T00:07–T00:10：${finish}`,
    };
    const repair = vi.fn<NonNullable<SemanticQualityReviewer["repair"]>>(async context => {
      expect([...context.allowedFields].sort()).toEqual(["action", "camera_movement", "timeline"]);
      expect(context.findings).toContainEqual(expect.objectContaining({
        field: "camera_movement", failureCode: "APPROVED_RACE_CAMERA_START_MISMATCH",
      }));
      return { changes: Object.entries(revised).map(([field, value]) => ({ field, value, reason: "让起幅和两次完整超越一致" })) };
    });
    const before = compilePromptPackage({ shots: [shot] })[0]!.contract;
    const review: SemanticQualityReviewer["review"] = async ({ shot: current }) => {
      const checks = passReview();
      checks.checks[2]!.evidence = String((current.fields as Record<string, unknown>).camera_movement);
      return checks;
    };
    const result = await evaluatePromptPackage({ ...input({ review, repair }), shots: [shot], upstreamContext });
    expect(result.g6Eligible, JSON.stringify({ findings: result.findings, reports: result.semanticReports,
      reason: result.repairAttempt?.reason })).toBe(true);
    expect(repair).toHaveBeenCalledTimes(1);
    const after = result.shotContracts[0]!.contract;
    expect(after.request).toEqual({ ...before.request, technical: { ...before.request.technical, timeline: revised.timeline } });
    expect(after.bindings.find(binding => binding.field === "portraits")).toMatchObject({
      valueSha256: before.bindings.find(binding => binding.field === "portraits")!.valueSha256,
    });
  });

  it.each(["complete", "front-only", "shoulder-only", "unrelated"] as const)("separates a whole overtake from a front-wheel claim (%s)", async mode => {
    const checked = currentG4();
    const row = checked.approvedProductionPlan.scenes[0]!;
    const upstreamContext = { approvedProductionPlan: { ...checked.approvedProductionPlan, scenes: [{ ...row,
      interval: { startSec: 0, endSec: 5, brief: mode === "unrelated" ? "在栏杆旁观察" : "从对手车后到完全领先，完成第二次完整超越" },
      approvedScene: { ...row.approvedScene, purpose: mode === "unrelated" ? "观察木纹" : "追近对手，完成完整超越" },
    }] } };
    const front = "前轮先越过对手的车头形成完全领先；随后前轮先于对手压过终点线。";
    const shoulder = "李英子肩线越过对手车前轮，完成从车后到完全领先的第一次超车，对手车退至画面左后。";
    const whole = "前轮开始超过对手车头，随后整车完整越过对手并保持领先；前轮先压过终点线。";
    const shot = { source: { ...source, fields: { ...fields, action: mode === "complete" ? whole : mode === "shoulder-only" ? shoulder : front,
      timeline: mode === "complete" ? `T00:00–T00:05：${whole}` : mode === "shoulder-only" ? `T00:00–T00:05：${shoulder}`
        : "T00:00–T00:05：前轮先越过对手车头，完成从车后到完全领先的第二次超越。" } }, compile };
    const repair = vi.fn<NonNullable<SemanticQualityReviewer["repair"]>>(async context => {
      expect(new Set(context.allowedFields)).toEqual(new Set(["action", "timeline"]));
      expect(context.findings.every(check => check.failureCode === "APPROVED_FULL_PASS_NOT_VISIBLE")).toBe(true);
      return { changes: [{ field: "action", value: whole, reason: "补足整车动作" },
        { field: "timeline", value: `T00:00–T00:05：${whole}`, reason: "补足整车动作区间" }] };
    });
    const initial = compilePromptPackage({ shots: [shot] })[0]!.contract;
    const result = await evaluatePromptPackage({ ...input({ review: async () => passReview(), repair }), shots: [shot], upstreamContext, maxFinalPromptChars: 3000 });
    expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
    expect(repair).toHaveBeenCalledTimes(mode === "front-only" || mode === "shoulder-only" ? 1 : 0);
    expect(result.shotContracts[0]!.contract.request.parameters).toEqual(initial.request.parameters);
  });

  it.each(["nose-reset", "nose-claimed-complete", "nose-ordinal", "same-window-clearance", "finish", "foreign", "unapproved", "wrong-duration"] as const)(
    "keeps clearance local to the same rival in the approved cut (%s)", async mode => {
      const checked = currentG4();
      const row = checked.approvedProductionPlan.scenes[0]!;
      const purpose = mode === "unapproved" ? "观察赛道" : "从两辆对手车后追至完全领先";
      const brief = mode === "unapproved" ? "保持赛道车位。" : "两次超车针对两辆不同对手车，每次从车后到完全领先。";
      const upstreamContext = { approvedProductionPlan: { ...checked.approvedProductionPlan, scenes: [{ ...row,
        sceneId: mode === "foreign" ? "other" : row.sceneId,
        interval: { startSec: 10, endSec: mode === "wrong-duration" ? 19 : 20, brief },
        approvedScene: { ...row.approvedScene, purpose },
      }] } };
      const first = "第一辆对手车被整车越过，主车拉开一个车身。";
      const second = mode === "nose-ordinal" ? "追到第二辆后方，对方封内线，改外线并排，" : "追到第二辆对手车后方，从外线并排，";
      const clear = "随后主车车尾完全越过第二辆对手车前轮。";
      const finish = "主车前轮先压过终点线，再收油减速。";
      const nose = mode === "nose-claimed-complete" ? "前轮先越过对手车头，完成第二次超越。" : "车头完全越过对手前轮后回正。";
      const cleanAction = first + second + "车头先超过对手前轮。" + clear + finish;
      const cleanTimeline = "T00:00–T00:04：" + first + "T00:04–T00:08：" + second + "车头先超过对手前轮。" + clear + "T00:08–T00:10：" + finish;
      const localClear = mode === "same-window-clearance" ? clear : "";
      const action = mode === "finish" ? finish : first + second + nose + localClear + finish;
      const timeline = mode === "finish" ? "T00:00–T00:10：" + finish
        : "T00:00–T00:04：" + first + "T00:04–T00:08：" + second + nose + localClear + "T00:08–T00:10：" + finish;
      const shot = { source: { ...source, duration: 10, fields: { ...fields, action, timeline } }, compile };
      const repair = vi.fn<NonNullable<SemanticQualityReviewer["repair"]>>(async context => {
        expect([...context.allowedFields].sort()).toEqual(["action", "timeline"]);
        expect(context.findings.map(({ failureCode }) => failureCode)).toEqual(["APPROVED_FULL_PASS_NOT_VISIBLE", "APPROVED_FULL_PASS_NOT_VISIBLE"]);
        return { changes: [{ field: "action", value: cleanAction, reason: "写清第二辆的完整超越" },
          { field: "timeline", value: cleanTimeline, reason: "保留现有区间" }] };
      });
      const before = compilePromptPackage({ shots: [shot] })[0]!.contract;
      const result = await evaluatePromptPackage({ ...input({ review: async () => passReview(), repair }), shots: [shot], upstreamContext });
      expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
      expect(repair).toHaveBeenCalledTimes(mode.startsWith("nose-") ? 1 : 0);
      expect(result.shotContracts[0]!.contract.request.parameters).toEqual(before.request.parameters);
    });

  it.each([true, false])("combines covered framing only across one actor in the same approved cut (%s)", async singleActor => {
    const checked = currentG4();
    const row = checked.approvedProductionPlan.scenes[0]!;
    const upstreamContext = { approvedProductionPlan: { ...checked.approvedProductionPlan, scenes: [{ ...row,
      interval: { startSec: 0, endSec: 5, brief: "同一套合身全覆 w2 赛车服与完整护具" },
      approvedScene: { actions: [{ actorId: "lead", description: "胸线与肩背轮廓在合身赛车服下自然呈现" },
        { actorId: singleActor ? "$scene" : "other", description: "背景与主体保持清晰" }] },
      verificationPlan: { visualRequirements: ["站姿自然呈现合身赛车服下的肩背与上翘臀部轮廓，不用裸露或孤立局部替代动作"] },
    }] } };
    const repair = vi.fn<NonNullable<SemanticQualityReviewer["repair"]>>(async context => {
      expect(context.allowedFields).toEqual(["composition"]);
      return { changes: [{ field: "composition", value: "中景自然呈现全覆防护赛车服下的胸线和臀部轮廓。", reason: "保留两项已审轮廓" }] };
    });
    const result = await evaluatePromptPackage({ ...input({ review: async () => passReview(), repair }), upstreamContext, maxFinalPromptChars: 3000 });
    expect(result.g6Eligible).toBe(true);
    expect(repair).toHaveBeenCalledTimes(singleActor ? 1 : 0);
  });

  it.each(["both", "entry-positive", "entry-beat", "entry-zero", "consistent", "foreign", "wrong-duration"] as const)(
    "binds explicit camera framing and hard-cut duration conflicts to the current frozen shot (%s)", async mode => {
      const checked = currentG4(mode === "foreign" ? "another-shot" : "S01");
      const upstream = { approvedProductionPlan: { ...checked.approvedProductionPlan, scenes: checked.approvedProductionPlan.scenes.map(row => ({
        ...row, interval: { startSec: 0, endSec: mode === "wrong-duration" ? 6 : 5 },
      })) } };
      const camera = "长焦贴地跟拍，车身始终居中而背景高速掠过，落幅时车身完整留在右侧三分线上。";
      const transition = "硬切，0.2秒，由本镜落幅直接切入下一镜。";
      const fixedCamera = "长焦贴地跟拍，落幅时车身完整留在右侧三分线上。";
      const fixedTransition = "硬切后保留0.2秒原生环境底声，直接切入下一镜。";
      const entry = "硬切进入，0.2 秒，自上镜落幅直接切到本镜停车点。";
      const consistent = ["consistent", "entry-beat", "entry-zero"].includes(mode);
      const shot = { source: { ...source, fields: { ...fields,
        camera_movement: consistent ? camera.replace("落幅时车身", "落幅时对手车身") : camera,
        transition: mode === "entry-positive" ? entry : mode === "entry-beat" ? "硬切进入，0.2秒后引擎原声加强。"
          : mode === "entry-zero" ? "硬切转场，时长0秒，切点保持车位连续。" : mode === "consistent" ? fixedTransition : transition,
      } }, compile };
      const review = vi.fn<SemanticQualityReviewer["review"]>(async ({ shot: current }) => {
        const actual = (current.fields as Record<string, string>).camera_movement;
        const row = passReview();
        row.checks[2] = { ...row.checks[2]!, evidence: `camera_movement：${actual}` };
        return row;
      });
      const repair = vi.fn<NonNullable<SemanticQualityReviewer["repair"]>>(async context => {
        expect(new Set(context.allowedFields)).toEqual(new Set(["camera_movement", "transition"]));
        expect(context.findings.map(finding => finding.failureCode).sort()).toEqual([
          "CAMERA_FRAMING_SELF_CONTRADICTION", "TRANSITION_DURATION_BREAKS_HARDCUT",
        ]);
        return { changes: [
          { field: "camera_movement", value: fixedCamera, reason: "保留实际落幅" },
          { field: "transition", value: fixedTransition, reason: "去掉错误过渡时长" },
        ] };
      });
      const initial = compilePromptPackage({ shots: [shot] })[0]!.contract;
      const result = await evaluatePromptPackage({ ...input({ review, repair }), shots: [shot], upstreamContext: upstream, maxFinalPromptChars: 3000 });
      expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
      const needsRepair = mode === "both" || mode === "entry-positive";
      expect(repair).toHaveBeenCalledTimes(needsRepair ? 1 : 0);
      expect(review).toHaveBeenCalledTimes(needsRepair ? 2 : 1);
      expect(result.shotContracts[0]!.contract.requestSha256).toBe(initial.requestSha256);
    });

  it.each([true, false])("binds an explicitly approved covered silhouette to this shot only (%s)", async current => {
    const upstream = currentG4(current ? "S01" : "unrelated");
    upstream.approvedProductionPlan.scenes[0]!.verificationPlan.visualRequirements = [
      "完整护具不变，以中景呈现自然胸线与臀部轮廓，不作孤立局部特写。",
    ];
    const review = vi.fn(async () => passReview());
    const repair = vi.fn<NonNullable<SemanticQualityReviewer["repair"]>>(async context => {
      expect(context.allowedFields).toEqual(["composition"]);
      expect(context.findings).toContainEqual(expect.objectContaining({ field: "composition", failureCode: "APPROVED_PROTECTED_OUTLINE_MISSING" }));
      return { changes: [{ field: "composition", value: "侧前中景呈现全覆护具下自然胸线和臀部轮廓。", reason: "落实已审构图" }] };
    });
    const result = await evaluatePromptPackage({ ...input({ review, repair }), upstreamContext: upstream, maxFinalPromptChars: 3000 });
    expect(result.g6Eligible).toBe(true);
    expect(repair).toHaveBeenCalledTimes(current ? 1 : 0);
    expect(review).toHaveBeenCalledTimes(current ? 2 : 1);
    expect(result.shotContracts[0]!.contract.prompt.includes("全覆护具下自然胸线和臀部轮廓")).toBe(current);
  });

  it.each([
    "全套护具；不呈现胸线和臀部轮廓。",
    "全套护具；不得呈现胸部、臀部轮廓。",
    "全套护具；胸线和臀部轮廓不可见。",
    "全套护具；不允许清楚呈现胸部、臀部轮廓。",
    "全套护具；不以特写呈现胸线与臀部轮廓。",
    "不戴完整护具；中景呈现自然胸线和臀部轮廓。",
  ])("does not derive a protected outline requirement from negated approval text: %s", async text => {
    const upstream = currentG4();
    upstream.approvedProductionPlan.scenes[0]!.verificationPlan.visualRequirements = [text];
    const repair = vi.fn<NonNullable<SemanticQualityReviewer["repair"]>>(async () => ({ changes: [] }));
    const result = await evaluatePromptPackage({ ...input({ review: async () => passReview(), repair }), upstreamContext: upstream });
    expect(result.g6Eligible).toBe(true);
    expect(repair).not.toHaveBeenCalled();
  });

  it.each([
    ["侧前中景清楚呈现全覆护具下自然胸线和臀部轮廓，禁止孤立局部特写。", false],
    ["侧前中景清楚呈现全覆护具下的胸线、臀部轮廓，不以特写替代动作。", false],
    ["侧前中景；全套护具，胸线和臀部轮廓看不清。", true],
    ["全套护具；不呈现胸部、臀部轮廓。", true],
    ["侧前中景呈现全覆护具下的胸线；臀部轮廓不可见。", true],
  ] as const)("requires affirmative visibility in actual framing: %s", async (composition, needsRepair) => {
    const upstream = currentG4();
    upstream.approvedProductionPlan.scenes[0]!.verificationPlan.visualRequirements = [
      "全程完整护具；侧前中景与转身动作自然呈现合身赛车服包裹下的丰满胸线与上翘臀部轮廓，不作孤立局部特写。",
    ];
    const repair = vi.fn<NonNullable<SemanticQualityReviewer["repair"]>>(async () => ({
      changes: [{ field: "composition", value: "侧前中景完整护具下的胸线和臀部轮廓自然可见。", reason: "落实已审构图" }],
    }));
    const result = await evaluatePromptPackage({ ...input({ review: async () => passReview(), repair }),
      upstreamContext: upstream, shots: [{ source: { ...source, fields: { ...fields, composition } }, compile }] });
    expect(result.g6Eligible).toBe(true);
    expect(repair).toHaveBeenCalledTimes(needsRepair ? 1 : 0);
    if (needsRepair) {
      expect(repair.mock.calls[0]![0].findings).toContainEqual(expect.objectContaining({
        field: "composition", failureCode: "APPROVED_PROTECTED_OUTLINE_MISSING",
      }));
    }
  });

  it.each([
    ["转身登台带出成年角色自然的丰满胸线与上翘臀部，服装始终为合身全覆赛车服，不以裸露或孤立局部替代", false],
    ["转身登台不自然带出成年角色的丰满胸线与上翘臀部，服装始终为合身全覆赛车服", true],
    ["禁止转身登台带出胸线与臀部轮廓；服装始终为合身全覆赛车服", true],
    ["转身登台带出胸线；另提及臀部轮廓，服装始终为合身全覆赛车服", true],
    ["转身登台带出成年角色自然的丰满胸线与上翘臀部，服装未穿全覆赛车服", true],
    ["转身登台带出双手抬盔；仅列出胸线与臀部，服装始终为合身全覆赛车服", true],
  ] as const)("binds outline revealed by the actual covered podium motion: %s", async (composition, needsRepair) => {
    const upstream = currentG4();
    upstream.approvedProductionPlan.scenes[0]!.verificationPlan.visualRequirements = [
      "侧前中景与转身、登台动作清楚呈现成年角色自然的丰满胸线与上翘臀部轮廓，始终穿着合身全覆赛车服，不以裸露或孤立局部替代动作",
    ];
    const shot = { source: { ...source, fields: { ...fields, composition } }, compile };
    const original = compilePromptPackage({ shots: [shot] })[0]!.contract;
    const review = vi.fn(async () => passReview());
    const repair = vi.fn<NonNullable<SemanticQualityReviewer["repair"]>>(async context => {
      expect(context.allowedFields).toEqual(["composition"]);
      expect(context.findings).toContainEqual(expect.objectContaining({ failureCode: "APPROVED_PROTECTED_OUTLINE_MISSING" }));
      return { changes: [{ field: "composition", value: "侧前中景自然呈现全覆赛车服下的胸线与臀部轮廓。", reason: "落实已审轮廓" }] };
    });
    const result = await evaluatePromptPackage({ ...input({ review, repair }), upstreamContext: upstream, shots: [shot] });
    expect(result.g6Eligible).toBe(true);
    expect(repair).toHaveBeenCalledTimes(needsRepair ? 1 : 0);
    expect(review).toHaveBeenCalledTimes(needsRepair ? 2 : 1);
    expect(result.shotContracts[0]!.contract.request.parameters).toEqual(original.request.parameters);
    if (!needsRepair) {
      const accepted = result.shotContracts[0]!.contract;
      expect([accepted.promptSha256, accepted.fieldsSha256, accepted.requestSha256])
        .toEqual([original.promptSha256, original.fieldsSha256, original.requestSha256]);
    }
  });

  it.each([
    { mode: "current action and cover", shotId: "S01", action: "佩戴完整护具；侧前中景自然呈现赛车服内的胸线与臀部轮廓。", visual: "合身赛车服保留力量感。", expected: true },
    { mode: "current action and visual cover", shotId: "S01", action: "侧前中景自然呈现合身赛车服包裹下的胸线与臀部轮廓。", visual: "穿戴全套护具，人物动作清楚。", expected: true },
    { mode: "current wrapped action and approved full-cover prop", shotId: "S01",
      action: "完全下车，转身登上紧邻停车点的虚构领奖台最高一级，自己拿起预置奖杯并举杯，侧前中景与转身动作自然呈现合身赛车服包裹下的丰满胸线与上翘臀部轮廓；全程不脱手套、不做慢动作、不增加长距离行走。",
      visual: "侧前中景与转身自然呈现合身赛车服下的身材与力量感，不用裸露或孤立局部替代动作。",
      prop: "合身纯色全覆赛车服", expected: true },
    { mode: "generic prop does not authorize covered visibility", shotId: "S01", action: "侧前中景呈现赛车服包裹下的胸线与臀部轮廓。", visual: "人物动作清楚。", prop: "合身赛车服", expected: false },
    { mode: "full-cover prop without an explicitly wrapped action", shotId: "S01", action: "侧前中景呈现胸线与臀部轮廓。", visual: "人物动作清楚。", prop: "合身纯色全覆赛车服", expected: false },
    { mode: "full-cover prop without explicit outline action", shotId: "S01", action: "侧前中景呈现合身赛车服的力量感。", visual: "人物动作清楚。", prop: "合身纯色全覆赛车服", expected: false },
    { mode: "no explicit full cover", shotId: "S01", action: "侧前中景自然呈现胸线与臀部轮廓。", visual: "人物动作清楚。", expected: false },
    { mode: "negated current action", shotId: "S01", action: "佩戴完整护具；不呈现胸线与臀部轮廓。", visual: "人物动作清楚。", expected: false },
    { mode: "different approved shot", shotId: "S02", action: "佩戴完整护具；侧前中景呈现自然胸线与臀部轮廓。", visual: "人物动作清楚。", expected: false },
  ])("uses the bound approved scene action as visibility authority: $mode", async ({ shotId, action, visual, prop, expected }) => {
    const upstream = currentG4(shotId);
    const bound = upstream.approvedProductionPlan.scenes[0]!;
    bound.approvedScene.actions[0]!.description = action;
    bound.verificationPlan.visualRequirements = [visual];
    if (prop) Object.assign(bound.approvedScene, { props: [{ name: prop }] });
    const repair = vi.fn<NonNullable<SemanticQualityReviewer["repair"]>>(async () => ({
      changes: [{ field: "composition", value: "侧前中景自然呈现完整护具下的胸线与臀部轮廓。", reason: "落实本镜已审动作" }],
    }));
    const result = await evaluatePromptPackage({ ...input({ review: async () => passReview(), repair }), upstreamContext: upstream });
    expect(result.g6Eligible).toBe(true);
    expect(repair).toHaveBeenCalledTimes(expected ? 1 : 0);
  });

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
    { field: "mood", value: "安静而克制，增加一层与原先不同的张力。", reason: "FINAL_PROMPT_REPAIR_NOT_SHORTER" },
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
    expect(promptQualityRunProjection(result)).toMatchObject({
      schemaVersion: "workloom.video-prompt-quality/v2",
      status: "passed",
      g6Eligible: true,
      renderEligible: false,
      shotOutcomes: [{ shotId: "S01", status: "repaired", nextAction: "continue" }],
      repairAttempt: { status: "applied", changes: [{ shotId: "S01", field: "camera_movement" }] },
    });
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
