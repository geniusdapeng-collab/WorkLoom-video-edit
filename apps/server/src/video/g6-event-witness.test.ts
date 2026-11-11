import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { WorkloomLLMEngine, type PromptCompileOptions } from "@hyperreality/video-studio";
import { OpenAiCompatibleProvider, resetCircuit } from "@workloom/base/model-router";
import { modelPolicyFor } from "../service/llm.js";
import {
  compilePromptPackage, createLlmSemanticQualityReviewer, evaluatePromptPackage, SEMANTIC_QUALITY_CHECK_IDS,
} from "./prompt-quality-gate.js";
import { g6EventWitnessChecks, g6EventWitnessRepairDrift } from "./g6-event-witness.js";

const compile: PromptCompileOptions = {
  titleCard: false,
  delivery: { aspectRatio: "9:16", resolution: "1080p", fps: 30, format: "mp4", generateAudio: true },
  model: { modelId: "offline-event-fixture", provider: "seedance", providerModel: "offline-event-fixture", version: "fixture",
    modes: ["r2v"], durationSec: { min: 1, max: 20 }, aspectRatios: ["9:16"], resolutions: ["1080p"],
    maxReferenceImages: 2, maxPromptChars: 8000 },
  assets: ["front", "closeup"].map((angle, index) => ({ field: "portraits", role: "reference_image",
    sha256: String(index + 1).repeat(64), bytes: 100, mediaType: "image/png", sourceRef: `fixture/${angle}.png` })),
};

const firstAction = "主车从第一辆对手车后方追近，两车同向并排，主车车尾完整越过第一辆对手车前轮，第一辆对手车继续在后。";
const firstTimeline = "T00:00–T00:03 主车从第一辆对手车后方追近；T00:03–T00:06 两车同向并排；"
  + "T00:06–T00:08 主车车尾完整越过第一辆对手车前轮，第一辆对手车继续在后。";
const firstPurpose = "从第一辆对手车后方贴身追近，本段末完成对第一辆对手车的完全超越。";
const secondPurpose = "主车从第二辆对手车后方贴身追近，内线连超，先于对手压过方格终点线，随后收油减速。";
const distinctBrief = "两次超车分别针对两辆不同的对手车。每次完整看清从车后到完全领先，第一辆已超车继续在后。第二次超车后先压过终点线再收油减速。";
const secondAction = "主车从第二辆对手车右后方贴身追近，与同一第二辆对手车同向并排，"
  + "主车车尾完整越过第二辆对手车前轮，前轮先压过方格终点线，随后收油减速，第一辆对手车保持在后。";
const secondTimeline = "T00:00–T00:02 主车从第二辆对手车右后方贴身追近；T00:02–T00:04 与第二辆对手车同向并排；"
  + "T00:04–T00:06 主车车尾完整越过第二辆对手车前轮，前轮先压过方格终点线；T00:06–T00:08 收油减速，第一辆对手车保持在后。";

function scenario({ shotId = "chase-alpha", duration = 8, action = firstAction, timeline = firstTimeline,
  camera = "同向侧跟，两车位置在同一画面可见。", purpose = firstPurpose,
  visual = ["记录第一辆对手车从车后到整车完全领先。"], current = true,
  characterConstraint = "唯一命名主角；匿名成年对手骑手全盔遮面。",
}: {
  shotId?: string; duration?: number; action?: string; timeline?: string; camera?: string; purpose?: string;
  visual?: string[]; current?: boolean; characterConstraint?: string;
} = {}) {
  const fields: Record<string, string> = {
    director_instruction: "封闭赛道同向竞速。", constraint: `9:16画幅，1080p分辨率，30fps，MP4格式，${duration}秒。`,
    baseline: "保留写实赛道。", scene: "虚构封闭赛道。", lighting: "统一冷白侧光。", camera_movement: camera,
    character: "唯一命名成年主角，完整全覆护具。", action, portraits: "fixture/front.png, fixture/closeup.png",
    dialogue: "无台词。", negative: "禁止文字和商标。", consistency: "同一成年主角与护具。",
    composition: "侧向中全景同框。", color_palette: "冷白赛道。", depth_of_field: "车辆与位置清晰。", timeline,
    mood: "专注克制。", bright_constraint: "护具可见。", character_constraint: characterConstraint,
    costume: "全覆护具。", props: "同向行驶的主车与对手摩托车。", pacing: "连续动作。", audio: "原生引擎与轮胎声。",
    makeup: "自然妆面。", transition: "零秒硬切，保持同向和原车位。",
  };
  const otherId = shotId === "chase-beta" ? "chase-alpha" : "chase-beta";
  const currentScene = { shotId, sceneId: shotId, interval: { startSec: 0, endSec: duration, brief: "前后两段共同完成清楚超车再冲线，保留相对车位。" },
    approvedScene: { purpose, actions: [{ actorId: "lead-example", description: purpose }], props: [{ name: "赛道摩托车" }] },
    verificationPlan: { visualRequirements: visual } };
  const otherScene = { shotId: otherId, sceneId: otherId, interval: { startSec: duration, endSec: duration * 2, brief: distinctBrief },
    approvedScene: { purpose: otherId === "chase-beta" ? secondPurpose : firstPurpose,
      actions: [{ actorId: "lead-example", description: otherId === "chase-beta" ? secondPurpose : firstPurpose }] },
    verificationPlan: { visualRequirements: [distinctBrief] } };
  const plan = { g4ArtifactSha256: "a".repeat(64), requirementContractHash: "b".repeat(64), scenes: [currentScene, otherScene] };
  return {
    fields, plan,
    input: { projectId: "EVENT-P", runId: "EVENT-R", stageRunId: "EVENT-S", revision: 1, mode: "enforce" as const,
      maxFinalPromptChars: 3000, shots: [{ source: { shotId, duration, fields }, compile }],
      upstreamContext: current ? { approvedProductionPlan: plan } : {} },
  };
}

function nativeReviewer(replacements: Record<string, string>, { secondFailure = false, onRepair = () => undefined }: {
  secondFailure?: boolean; onRepair?: () => void;
} = {}) {
  const calls: Array<{ kind: string; context: Record<string, any> }> = [];
  const model = "deepseek-flash", baseUrl = "http://g6-event-fixture.invalid/v1", apiKey = "offline-fixture";
  const provider = new OpenAiCompatibleProvider(model, { baseUrl, apiKey, fetchImpl: async (url, init) => {
    expect(String(url)).toBe(`${baseUrl}/chat/completions`);
    const request = JSON.parse(String(init?.body));
    const prompt = String(request.messages.at(-1).content).split("\n\n【硬性输出要求】", 1)[0]!;
    const repairing = prompt.startsWith("你是字段级定点修复器。");
    const context = JSON.parse(prompt.slice(repairing ? prompt.indexOf("镜头：{") + 3 : prompt.indexOf("\n{\n") + 1));
    const reviewedBefore = calls.some(call => call.kind === "review");
    calls.push({ kind: repairing ? "repair" : "review", context });
    let output: unknown;
    if (repairing) {
      onRepair();
      output = { changes: context.allowedFields.filter(({ field }: { field: string }) => Object.hasOwn(replacements, field)).map(({ field }: { field: string }) => ({ field,
        value: replacements[field], reason: "落实同版已审事件和原有时钟。" })) };
    } else {
      const fields = Object.fromEntries(context.fields.map(({ field, value }: { field: string; value: string }) => [field, value]));
      const names = ["action", "props", "camera_movement", "lighting", "scene"];
      output = { shotId: context.shotId, checks: SEMANTIC_QUALITY_CHECK_IDS.map((id, index) => ({ id, pass: true,
        field: names[index], evidence: fields[names[index]!]!,
        ...(secondFailure && reviewedBefore && index === 3 ? { pass: false, failureCode: "FIXTURE_NEW_FULL_REVIEW_FAILURE",
          repair: "修正当前完整复验发现的光照问题。" } : {}),
      })) };
    }
    return Response.json({ id: `offline-event-${calls.length}`, model, object: "chat.completion",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 300, completion_tokens: 100, total_tokens: 400 } });
  } });
  const engine = new WorkloomLLMEngine({ model, baseUrl, apiKey, router: { providers: new Map([[model, provider]]),
    policy: structuredClone(modelPolicyFor("ai-video")!), scene: "preproduction", forceModel: model,
    sink: { recordModelTrace: async () => undefined, recordDegradation: async () => undefined, recordCircuitBreak: async () => undefined } } });
  return { calls, reviewer: createLlmSemanticQualityReviewer(engine) };
}

afterEach(() => resetCircuit("preproduction"));

describe("current G4 finite event witnesses through the native G6 entry", () => {
  const onsetAction = "主车手右手拧动油门，双脚前掌踏住脚踏、脚跟夹紧车身；前车尾流逼近时收左肩，把头压到风挡下沿；" + firstAction;
  const onsetTimeline = "T00:00–T00:03 主车手右手旋开油门，双脚前掌压住脚踏，脚跟夹住车身，收左肩，把头压至风挡下沿，主车从第一辆对手车后方追近；"
    + "T00:03–T00:06 两车同向并排；T00:06–T00:08 主车车尾完整越过第一辆对手车前轮，第一辆对手车继续在后。";

  it("licenses missing same-version action onsets before the sole repair even when all native binary answers pass", async () => {
    const fixture = scenario({ action: onsetAction });
    const native = nativeReviewer({ timeline: onsetTimeline });
    const original = compilePromptPackage(fixture.input)[0]!.contract;
    const result = await evaluatePromptPackage({ ...fixture.input, reviewer: native.reviewer });
    expect(native.calls.map(call => call.kind)).toEqual(["review", "repair", "review"]);
    expect(native.calls[0]!.context.questions.SQ2_SCENE_PROPS.question).toContain("显式连续区间");
    expect(native.calls[0]!.context.questions.SQ4_LIGHT_COLOR.question).toContain("不等于所有护具必须同框");
    expect(native.calls[0]!.context.questions.SQ5_PURPOSE.question).toContain("不得把自然微动改写成冻结或定格");
    const repair = native.calls.find(call => call.kind === "repair")!.context;
    expect(repair.allowedFields.map((row: { field: string }) => row.field)).toEqual(["timeline"]);
    expect(repair.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "timeline", failureCode: "APPROVED_ACTION_EVENT_ONSET_MISSING" }),
    ]));
    expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
    expect(result.renderEligible).toBe(false);
    expect(result.shotContracts[0]!.source.fields).toMatchObject({ action: onsetAction, timeline: onsetTimeline });
    expect(result.shotContracts[0]!.contract.request).toEqual({ ...original.request,
      technical: { ...original.request.technical, timeline: onsetTimeline } });
  });

  it("binds the second whole clearance to the complete frozen plan despite different purpose wording and offscreen shortcuts", async () => {
    const fixture = scenario({ shotId: "chase-beta", purpose: secondPurpose, visual: [distinctBrief],
      action: "主车从第二辆对手车右后方贴身追近，从内线抽头让对手退到右侧画外，前轮先压过方格终点线，随后收油减速。",
      timeline: "T00:00–T00:02 主车从第二辆对手车右后方贴身追近；T00:02–T00:04 内线抽头，把第二辆对手车让到画面右侧边缘；"
        + "T00:04–T00:06 前轮先压过方格终点线；T00:06–T00:08 收油减速，两辆对手车留在后方。" });
    const native = nativeReviewer({ action: secondAction, timeline: secondTimeline });
    const result = await evaluatePromptPackage({ ...fixture.input, reviewer: native.reviewer });
    expect(native.calls.map(call => call.kind)).toEqual(["review", "repair", "review"]);
    expect(native.calls[1]!.context.allowedFields.map((row: { field: string }) => row.field)).toEqual(["action", "timeline"]);
    expect(native.calls[1]!.context.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "action", failureCode: "APPROVED_RIVAL_EVENT_CHAIN_MISSING" }),
      expect.objectContaining({ field: "timeline", failureCode: "APPROVED_RIVAL_EVENT_CHAIN_MISSING" }),
    ]));
    expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
  });

  it("blocks a repair that borrows the first rival clearance for the second before another semantic call", async () => {
    const fixture = scenario({ shotId: "chase-beta", purpose: secondPurpose, visual: [distinctBrief],
      action: secondAction.replace("主车车尾完整越过第二辆对手车前轮", "对手退到画面右侧边缘"),
      timeline: secondTimeline.replace("主车车尾完整越过第二辆对手车前轮", "对手退到画面右侧边缘") });
    const native = nativeReviewer({ action: secondAction.replace("越过第二辆", "越过第一辆"), timeline: secondTimeline });
    const result = await evaluatePromptPackage({ ...fixture.input, reviewer: native.reviewer });
    expect(result.g6Eligible).toBe(false);
    expect(result.repairAttempt?.reason).toBe("APPROVED_EVENT_WITNESS_REPAIR_DRIFT");
    expect(native.calls.map(call => call.kind)).toEqual(["review", "repair"]);
  });

  it("preserves the initial required action event when an action repair attempts to erase its source", async () => {
    const fixture = scenario({ action: onsetAction.replace("主车车尾完整越过第一辆对手车前轮", "主车车头越过对手车头") });
    const native = nativeReviewer({ action: firstAction, timeline: firstTimeline });
    const result = await evaluatePromptPackage({ ...fixture.input, reviewer: native.reviewer });
    expect(result.g6Eligible).toBe(false);
    expect(result.repairAttempt?.reason).toBe("APPROVED_EVENT_WITNESS_REPAIR_DRIFT");
    expect(native.calls.map(call => call.kind)).toEqual(["review", "repair"]);
  });

  it("retains already synchronized action onsets when a different action defect is repaired", async () => {
    const fixture = scenario({ action: onsetAction.replace("主车车尾完整越过第一辆对手车前轮", "主车车头越过对手车头"),
      timeline: onsetTimeline });
    const native = nativeReviewer({ action: firstAction });
    const result = await evaluatePromptPackage({ ...fixture.input, reviewer: native.reviewer });
    expect(native.calls[1]!.context.allowedFields.map((row: { field: string }) => row.field)).toEqual(["action"]);
    expect(result.g6Eligible).toBe(false);
    expect(result.repairAttempt?.reason).toBe("APPROVED_EVENT_WITNESS_REPAIR_DRIFT");
    expect(native.calls.map(call => call.kind)).toEqual(["review", "repair"]);
  });

  it("keeps a newly found full-review failure closed after the only repair", async () => {
    const fixture = scenario({ action: onsetAction });
    const native = nativeReviewer({ timeline: onsetTimeline }, { secondFailure: true });
    const result = await evaluatePromptPackage({ ...fixture.input, reviewer: native.reviewer });
    expect(native.calls.map(call => call.kind)).toEqual(["review", "repair", "review"]);
    expect(result.g6Eligible).toBe(false);
    expect(result.repairAttempt?.reason).toBe("FULL_REVALIDATION_FAILED");
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "FIXTURE_NEW_FULL_REVIEW_FAILURE" })]));
  });

  it.each(["对手摩托车均为无人驾驶空车。", "对手车无驾驶员。", "移动对手车是无人空车。"])(
    "diagnoses the affirmative driverless rival field %s", async characterConstraint => {
      const fixture = scenario({ characterConstraint });
      const before = compilePromptPackage(fixture.input)[0]!.contract;
      const native = nativeReviewer({ character_constraint: "命名主角唯一；对手车由匿名全盔成年骑手正常驾驶。" });
      const result = await evaluatePromptPackage({ ...fixture.input, reviewer: native.reviewer });
      expect(native.calls.map(call => call.kind)).toEqual(["review", "repair", "review"]);
      expect(native.calls[1]!.context.allowedFields.map((row: { field: string }) => row.field)).toEqual(["character_constraint"]);
      expect(native.calls[1]!.context.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: "character_constraint", failureCode: "APPROVED_MOVING_RIVAL_DRIVERLESS" }),
      ]));
      expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
      expect(result.shotContracts[0]!.contract.request).toEqual({ ...before.request, technical: {
        ...before.request.technical, character_constraint: "命名主角唯一；对手车由匿名全盔成年骑手正常驾驶。",
      } });
    });

  it.each(["对手车不得无人驾驶。", "对手车不可无人；由匿名成年全盔骑手驾驶。", "对手车并非无人空车。", "禁止对手车无驾驶员。"])(
    "accepts a prohibition of driverless rivals %s", async characterConstraint => {
      const fixture = scenario({ characterConstraint });
      const native = nativeReviewer({});
      const result = await evaluatePromptPackage({ ...fixture.input, reviewer: native.reviewer });
      expect(result.g6Eligible, JSON.stringify(result.findings)).toBe(true);
      expect(native.calls.map(call => call.kind)).toEqual(["review"]);
    });

  it("retains the existing path without a current G4 or for an unrecognized event domain", async () => {
    for (const fixture of [scenario({ current: false, action: onsetAction }), scenario({ purpose: "静物咖啡光影。",
      action: "咖啡表面涟漪渐散。", timeline: "T00:00–T00:08 杯面反光。", visual: ["记录静物杯面。"] })]) {
      const native = nativeReviewer({});
      const result = await evaluatePromptPackage({ ...fixture.input, reviewer: native.reviewer });
      expect(result.g6Eligible, JSON.stringify(result.findings)).toBe(true);
      expect(native.calls.map(call => call.kind)).toEqual(["review"]);
    }
  });

  it("keeps every other native request channel immutable during the approved character constraint edit", async () => {
    const fixture = scenario({ characterConstraint: "对手车为无人空车。" });
    const source = fixture.input.shots[0]!;
    source.compile = { ...source.compile, delivery: { ...source.compile.delivery } };
    const native = nativeReviewer({ character_constraint: "对手车由匿名成年全盔骑手驾驶。" }, {
      onRepair: () => { source.compile.delivery.generateAudio = false; },
    });
    const result = await evaluatePromptPackage({ ...fixture.input, reviewer: native.reviewer });
    expect(result.g6Eligible).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "FINAL_PROMPT_REPAIR_REQUEST_DRIFT" })]));
    expect(native.calls.map(call => call.kind)).toEqual(["review", "repair"]);
  });

  it("combines the diagnosed native character constraint with the existing single length repair", async () => {
    const fixture = scenario({ characterConstraint: "对手车为无人空车。" });
    const originalComposition = fixture.fields.composition!;
    fixture.fields.composition = originalComposition.repeat(340);
    const before = compilePromptPackage(fixture.input)[0]!.contract;
    expect(before.prompt.length).toBeGreaterThan(3000);
    const character = "唯一命名主角，正常匿名成年全盔骑手驾驶对手摩托车。";
    const native = nativeReviewer({ composition: originalComposition, character_constraint: character });
    const result = await evaluatePromptPackage({ ...fixture.input, reviewer: native.reviewer });
    expect(native.calls.map(call => call.kind)).toEqual(["review", "repair", "review"]);
    expect(native.calls[1]!.context.finalPromptFieldBudget.semanticFields).toEqual(["character_constraint"]);
    expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
    expect(result.shotContracts[0]!.contract.prompt.length).toBeLessThanOrEqual(3000);
    expect(result.shotContracts[0]!.contract.request).toEqual({ ...before.request,
      technical: { ...before.request.technical, character_constraint: character } });
  });

  it.each([false, true])("replays the original retained rival obligation before the full native re-review (drift=%s)", async drift => {
    const fixture = scenario({ shotId: "chase-beta", purpose: secondPurpose, visual: [distinctBrief],
      action: secondAction.replace("，第一辆对手车保持在后", ""), timeline: secondTimeline });
    const action = drift ? secondAction + "第一辆对手车又来到主车前方。" : secondAction;
    const native = nativeReviewer({ action });
    const result = await evaluatePromptPackage({ ...fixture.input, reviewer: native.reviewer });
    expect(native.calls.map(call => call.kind)).toEqual(drift ? ["review", "repair"] : ["review", "repair", "review"]);
    expect(native.calls[1]!.context.allowedFields.map((row: { field: string }) => row.field)).toEqual(["action"]);
    expect(result.g6Eligible).toBe(!drift);
    const proof = result.repairAttempt?.eventWitnesses?.find(proof => proof.family === "rival-chain");
    expect(proof).toMatchObject({ retainedRivals: [1], rivals: [expect.objectContaining({ ordinal: 2 })] });
    if (drift) expect(result.repairAttempt?.reason).toBe("APPROVED_EVENT_WITNESS_REPAIR_DRIFT");
  });

  it.each([
    ["unknown rider", "王某骑手先从旁边驶过；车尾完整越过第二辆对手车前轮"],
    ["unknown named actor", "王某先从旁边驶过；车尾完整越过第二辆对手车前轮"],
    ["other vehicle", "另一辆摩托车先从旁边驶过；车尾完整越过第二辆对手车前轮"],
  ])("does not inherit the lead through a new %s before the sole native repair", async (_label, replacement) => {
    const fixture = scenario({ shotId: "chase-beta", purpose: secondPurpose, visual: [distinctBrief], timeline: secondTimeline,
      action: secondAction.replace("主车车尾完整越过第二辆对手车前轮", replacement) });
    const native = nativeReviewer({ action: secondAction });
    const result = await evaluatePromptPackage({ ...fixture.input, reviewer: native.reviewer });
    expect(native.calls.map(call => call.kind)).toEqual(["review", "repair", "review"]);
    expect(native.calls[1]!.context.allowedFields.map((row: { field: string }) => row.field)).toEqual(["action"]);
    expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
  });

  it.each([
    secondAction.replace("前轮先压过方格终点线", "第二辆对手车的前轮先压过方格终点线"),
    secondAction.replace("前轮先压过方格终点线", "主车扶正后第二辆对手车的前轮先压过方格终点线"),
    secondAction.replace("随后收油减速", "第二辆对手车随后收油减速"),
  ])("does not borrow a rival finish or deceleration as the lead's native event", async action => {
    const fixture = scenario({ shotId: "chase-beta", purpose: secondPurpose, visual: [distinctBrief], action, timeline: secondTimeline });
    const native = nativeReviewer({ action: secondAction });
    const result = await evaluatePromptPackage({ ...fixture.input, reviewer: native.reviewer });
    expect(native.calls.map(call => call.kind)).toEqual(["review", "repair", "review"]);
    expect(native.calls[1]!.context.allowedFields.map((row: { field: string }) => row.field)).toEqual(["action"]);
    expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
  });

  it("keeps a previously passed rival behind without requesting a second pass", async () => {
    const purpose = "第一辆对手车在主车后方，主车从第二辆对手车后方贴身追近并超越，先压过方格终点线，随后减速。";
    const fixture = scenario({ shotId: "chase-beta", purpose, visual: [distinctBrief], action: secondAction, timeline: secondTimeline });
    const native = nativeReviewer({});
    const result = await evaluatePromptPackage({ ...fixture.input, reviewer: native.reviewer });
    expect(result.g6Eligible, JSON.stringify(result.findings)).toBe(true);
    expect(native.calls.map(call => call.kind)).toEqual(["review"]);
  });

  it("does not turn a retained rival at the start of typed actor prose into a lead label", async () => {
    const purpose = "第一辆对手车在主车后方，主车从第二辆对手车后方贴身追近并超越，先压过方格终点线，随后减速。";
    const fixture = scenario({ shotId: "chase-beta", purpose, visual: [distinctBrief], timeline: secondTimeline,
      action: secondAction.replace("前轮先压过方格终点线", "第一辆对手车的前轮先压过方格终点线") });
    const native = nativeReviewer({ action: secondAction });
    const result = await evaluatePromptPackage({ ...fixture.input, reviewer: native.reviewer });
    expect(native.calls.map(call => call.kind)).toEqual(["review", "repair", "review"]);
    expect(native.calls[1]!.context.allowedFields.map((row: { field: string }) => row.field)).toEqual(["action"]);
    expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
  });

  it("uses an explicit current frozen interval when all derived scene prose is weak", async () => {
    const fixture = scenario({ shotId: "chase-beta", purpose: "承接原有方向与姿态。", visual: ["保持同一视角与主体。"],
      action: secondAction.replace("主车车尾完整越过第二辆对手车前轮", "主车车头越过第二辆对手车车头"), timeline: secondTimeline });
    fixture.plan.scenes[0]!.interval.brief = "主车在本段从第二辆对手车后方追近，完整超越该车后压过方格终点线再收油减速。" + distinctBrief;
    fixture.plan.scenes[0]!.approvedScene.actions[0]!.description = "保持原有车辆姿态。";
    const native = nativeReviewer({ action: secondAction });
    const result = await evaluatePromptPackage({ ...fixture.input, reviewer: native.reviewer });
    expect(native.calls.map(call => call.kind)).toEqual(["review", "repair", "review"]);
    expect(native.calls[1]!.context.allowedFields.map((row: { field: string }) => row.field)).toEqual(["action"]);
    expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
  });

  it.each(["王某骑手右手拧动油门；", "另一辆摩托车的骑手先驶过；右手拧动油门；", "主车稳住车身后王某骑手右手拧动油门；"])(
    "does not borrow an explicit unknown actor's onset from the timeline (%s)", async otherOnset => {
      const fixture = scenario({ action: "主车右手拧动油门；" + firstAction,
        timeline: firstTimeline.replace("T00:00–T00:03 ", "T00:00–T00:03 " + otherOnset) });
      const native = nativeReviewer({ timeline: firstTimeline.replace("T00:00–T00:03 ", "T00:00–T00:03 主车右手拧动油门；") });
      const result = await evaluatePromptPackage({ ...fixture.input, reviewer: native.reviewer });
      expect(native.calls.map(call => call.kind)).toEqual(["review", "repair", "review"]);
      expect(native.calls[1]!.context.allowedFields.map((row: { field: string }) => row.field)).toEqual(["timeline"]);
      expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
    });

  it("uses the nearest explicit lead after an unknown actor without adding a repair", async () => {
    const fixture = scenario({ action: "主车右手拧动油门；" + firstAction,
      timeline: firstTimeline.replace("T00:00–T00:03 ", "T00:00–T00:03 王某骑手先从旁边驶过后主车右手拧动油门；") });
    const native = nativeReviewer({});
    const result = await evaluatePromptPackage({ ...fixture.input, reviewer: native.reviewer });
    expect(result.g6Eligible, JSON.stringify(result.findings)).toBe(true);
    expect(native.calls.map(call => call.kind)).toEqual(["review"]);
  });
});

function witnessInput(fixture: ReturnType<typeof scenario>) {
  const source = fixture.input.shots[0]!.source;
  return { approvedProductionPlan: fixture.input.upstreamContext.approvedProductionPlan,
    shotId: source.shotId, duration: source.duration, action: fixture.fields.action, timeline: fixture.fields.timeline,
    cameraMovement: fixture.fields.camera_movement, characterConstraint: fixture.fields.character_constraint };
}

function chainFindings(fixture: ReturnType<typeof scenario>) {
  return g6EventWitnessChecks(witnessInput(fixture)).filter(check => check.failureCode === "APPROVED_RIVAL_EVENT_CHAIN_MISSING");
}

describe("finite event identity, polarity and original source locations", () => {
  it.each([
    ["车头结束", "主车车头越过第二辆对手车车头"],
    ["同一对手出画", "第二辆对手车退到画面外"],
    ["裸成功标签", "完成第二次超车"],
    ["不同对手", "主车车尾完整越过第一辆对手车前轮"],
    ["否定整车过程", "主车车尾尚未完整越过第二辆对手车前轮"],
    ["否定主语", "不是主车车尾完整越过第二辆对手车前轮"],
    ["反向超越", "第二辆对手车车尾完整越过主车前轮"],
    ["禁止被动完成", "第二辆对手车不被主车整车越过"],
    ["未定分支", "主车车尾完整越过第二辆对手车前轮或者保持并排"],
    ["目的说明", "目的是让主车车尾完整越过第二辆对手车前轮"],
  ])("requires the same rival's affirmative whole clearance with %s", (_label, replacement) => {
    const fixture = scenario({ shotId: "chase-beta", purpose: secondPurpose, visual: [distinctBrief],
      action: secondAction.replace("主车车尾完整越过第二辆对手车前轮", replacement) });
    expect(chainFindings(fixture).map(check => check.field)).toContain("action");
  });

  it.each([
    "对手骑手的车尾完整越过第二辆对手车前轮",
    "陌生骑手的车尾完整越过第二辆对手车前轮",
    "王某的车尾完整越过第二辆对手车前轮",
    "对手骑手从旁边驶过；车尾完整越过第二辆对手车前轮",
  ])("keeps an explicit different or unknown subject out of the lead clearance proof", clearance => {
    const fixture = scenario({ shotId: "chase-beta", purpose: secondPurpose, visual: [distinctBrief],
      action: secondAction.replace("主车车尾完整越过第二辆对手车前轮", clearance), timeline: secondTimeline });
    expect(chainFindings(fixture).map(check => check.field)).toEqual(["action"]);
  });

  it.each(["车手甲", "再明"])("keeps an approved lead label as the same actor without fixing a person's name (%s)", name => {
    const fixture = scenario({ action: firstAction.replace("主车车尾", `${name}的车尾`) });
    fixture.plan.scenes[0]!.approvedScene.actions[0]!.description = `${name}从第一辆对手车后方追近并完成完整超越。`;
    expect(chainFindings(fixture)).toEqual([]);
  });

  it("restores a typed lead name after an explicit different rider within the same clause", () => {
    const fixture = scenario({ action: firstAction.replace("主车车尾", "陌生骑手先驶过后车手甲的车尾") });
    fixture.plan.scenes[0]!.approvedScene.actions[0]!.description = "车手甲从第一辆对手车后方追近并完成完整超越。";
    expect(chainFindings(fixture)).toEqual([]);
  });

  it("does not borrow a differently sized anonymous group for a specifically retained rival", () => {
    const fixture = scenario({ action: firstAction.replace("第一辆对手车继续在后", "两辆对手车继续在后") });
    expect(chainFindings(fixture).map(check => check.field)).toEqual(["action"]);
  });

  it.each([
    ["current passed rival", firstAction.replace("，第一辆对手车继续在后", ""), firstTimeline, firstPurpose, ["记录第一辆对手车的完整超越。"]],
    ["previous rival during the next pass", secondAction.replace("，第一辆对手车保持在后", ""), secondTimeline, secondPurpose, [distinctBrief]],
    ["passed rival returns ahead", secondAction + "第一辆对手车又来到主车前方。", secondTimeline, secondPurpose, [distinctBrief]],
  ] as const)("retains the frozen remains-behind obligation for %s", (_label, action, timeline, purpose, visual) => {
    const fixture = scenario({ purpose, visual: [...visual], action, timeline });
    const checks = chainFindings(fixture);
    expect(checks.map(check => check.field)).toEqual(["action"]);
    expect(checks[0]!.evidence).toMatch(/remain|后/u);
  });

  it.each([
    "整车已经完全超越第二辆对手车",
    "主车全车完整越过第二辆对手车",
    "主车车尾完整越过该对手车前轮",
  ])("normalizes a whole-vehicle state with %s", replacement => {
    const fixture = scenario({ shotId: "chase-beta", purpose: secondPurpose, visual: [distinctBrief],
      action: secondAction.replace("主车车尾完整越过第二辆对手车前轮", replacement), timeline: secondTimeline });
    expect(chainFindings(fixture)).toEqual([]);
  });

  it.each([
    ["车头推到与对手车头平齐", false],
    ["车头推到与对手车头齐平", false],
    ["车头未与对手车头平齐", true],
    ["车头还没与对手车头齐平", true],
    ["两车不再并排", true],
  ] as const)("normalizes the same alongside state and its explicit negation with %s", (alongside, missing) => {
    const fixture = scenario({ action: firstAction.replace("两车同向并排", alongside) });
    expect(chainFindings(fixture).some(check => check.field === "action")).toBe(missing);
  });

  it("binds sequential identities inside an unpunctuated two-rival field", () => {
    const action = "主车从第一辆对手车后方追近并排主车车尾完整越过第一辆对手车前轮第一辆对手车继续在后再从第二辆对手车后方追近并排主车车尾完整越过第二辆对手车前轮然后前轮压过方格终点线随后收油减速";
    const fixture = scenario({ purpose: "先追近第一辆对手车并排完成整车超越再追近第二辆对手车并排完成整车超越后压过方格终点线再收油减速。",
      visual: [distinctBrief], action, timeline: "T00:00–T00:08 " + action });
    expect(chainFindings(fixture)).toEqual([]);
    fixture.fields.action = action.replace("越过第二辆", "越过第一辆");
    expect(chainFindings(fixture).map(check => check.field)).toEqual(["action"]);
  });

  it("takes a weakened purpose's obligation from its current visual plan and complete frozen source", () => {
    const fixture = scenario({ shotId: "chase-beta", purpose: "承接竞速与同一行驶方向。",
      visual: ["本镜从第二辆对手车后方追近，完整超越同一第二辆对手车后先压过终点线再收油减速。"],
      action: secondAction.replace("主车车尾完整越过第二辆对手车前轮", "对手车退到画面外"), timeline: secondTimeline });
    fixture.plan.scenes[0]!.approvedScene.actions[0]!.description = "保持原有竞速姿态。";
    expect(chainFindings(fixture).map(check => check.field)).toEqual(["action"]);
  });

  it("uses the approved ordinal, actor and duration without fixing them to a particular scene or rival count", () => {
    const action = firstAction.replaceAll("第一辆", "第三辆");
    const fixture = scenario({ shotId: "arbitrary-cut-z", duration: 12, purpose: firstPurpose.replaceAll("第一辆", "第三辆"),
      action, timeline: firstTimeline.replaceAll("第一辆", "第三辆").replace("T00:06–T00:08", "T00:06–T00:12"),
      visual: ["本镜记录第三辆对手车从后方到完整超越。"] });
    fixture.plan.scenes[0]!.approvedScene.actions[0]!.actorId = "different-lead";
    expect(chainFindings(fixture)).toEqual([]);
    fixture.fields.action = action.replace("越过第三辆", "越过第二辆");
    const check = chainFindings(fixture)[0]!;
    expect(check.eventWitness).toMatchObject({ shotId: "arbitrary-cut-z", actorId: "different-lead", duration: 12,
      rivals: [expect.objectContaining({ ordinal: 3 })] });
  });

  it.each([
    secondAction.replace("主车车尾完整越过第二辆对手车前轮，前轮先压过方格终点线", "前轮先压过方格终点线，主车车尾完整越过第二辆对手车前轮"),
    secondAction.replace("前轮先压过方格终点线，随后收油减速", "收油减速之后前轮先压过方格终点线"),
    secondAction.replace("前轮先压过方格终点线", "前轮先压过普通彩色涂装"),
  ])("requires whole clearance, the physical stripe, then final deceleration in that order", action => {
    const fixture = scenario({ shotId: "chase-beta", purpose: secondPurpose, visual: [distinctBrief], action, timeline: secondTimeline });
    expect(chainFindings(fixture).map(check => check.field)).toEqual(["action"]);
  });

  it.each([
    ["left control", "右手拧动油门", "左手拧动油门"],
    ["one foot", "双脚前掌踏住脚踏", "右脚前掌踏住脚踏"],
    ["wrong shoulder", "收左肩", "收右肩"],
    ["missing head movement", "把头压到风挡下沿", "凝视弯心"],
  ])("does not borrow a different action onset with %s", (_label, required, actual) => {
    const fixture = scenario({ action: required + "；" + firstAction,
      timeline: firstTimeline.replace("T00:00–T00:03 ", "T00:00–T00:03 " + actual + "；") });
    expect(g6EventWitnessChecks(witnessInput(fixture))).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "timeline", failureCode: "APPROVED_ACTION_EVENT_ONSET_MISSING" }),
    ]));
  });

  it("keeps a different actor's onset and an unsupported event domain with the existing semantic path", () => {
    const fixture = scenario({ action: "对手右手拧动油门；主角的心情由忐忑转为坚定；" + firstAction });
    expect(g6EventWitnessChecks(witnessInput(fixture))).toEqual([]);
  });

  it.each([
    "T00:00–T00:03 右手拧开油门；T00:04–T00:08 同向并排并整车越过第一辆对手车。",
    "T00:00–T00:09 右手拧开油门。",
    "",
  ])("requires a complete same-duration local timeline before accepting an onset repair", timeline => {
    const fixture = scenario({ action: "右手拧动油门；" + firstAction, timeline });
    const checks = g6EventWitnessChecks(witnessInput(fixture));
    expect(checks).toEqual(expect.arrayContaining([expect.objectContaining({ failureCode: "APPROVED_ACTION_EVENT_ONSET_MISSING" })]));
    expect(checks.find(check => check.failureCode === "APPROVED_ACTION_EVENT_ONSET_MISSING")!.repair).toContain("无缝覆盖本镜总时长");
    expect(g6EventWitnessRepairDrift(witnessInput(fixture), checks.flatMap(check => check.eventWitness ? [check.eventWitness] : []))).toBe(true);
  });

  it("preserves exact UTF-16 source spans for a repeated affirmative action after a prohibition", () => {
    const action = "🏁 禁止右手拧动油门但右手拧动油门；" + firstAction;
    const fixture = scenario({ action });
    const check = g6EventWitnessChecks(witnessInput(fixture)).find(row => row.failureCode === "APPROVED_ACTION_EVENT_ONSET_MISSING")!;
    expect(check.eventWitness?.family).toBe("action-onsets");
    if (check.eventWitness?.family !== "action-onsets") throw new Error("missing native event proof");
    const source = check.eventWitness.required[0]!.source;
    expect(source.start).toBe(action.lastIndexOf("右手拧动油门"));
    expect(action.slice(source.start, source.end)).toBe("右手拧动油门");
    expect(source.fieldSha256).toBe(createHash("sha256").update(action).digest("hex"));
    expect(source.fragmentSha256).toBe(createHash("sha256").update("右手拧动油门").digest("hex"));
  });

  it.each([
    ["禁止对手车无人驾驶空车。", false],
    ["对手车不允许无驾驶员。", false],
    ["禁止对手车无人驾驶且对手车无人驾驶。", true],
    ["不加命名主角且对手车无人驾驶。", true],
  ] as const)("keeps driverless noun polarity and repeated source locations for %s", (characterConstraint, blocked) => {
    const fixture = scenario({ characterConstraint });
    const check = g6EventWitnessChecks(witnessInput(fixture)).find(row => row.failureCode === "APPROVED_MOVING_RIVAL_DRIVERLESS");
    expect(Boolean(check)).toBe(blocked);
    if (blocked) {
      expect(check!.eventWitness!.sources.filter(source => source.field === "character_constraint").map(source => source.start))
        .toContain(characterConstraint.lastIndexOf("无人驾驶"));
    }
  });

  it("does not replace an actually approved driverless racing concept with anonymous human riders", () => {
    const fixture = scenario({ characterConstraint: "对手车均为无人驾驶空车。" });
    fixture.plan.scenes[0]!.approvedScene.purpose += "对手摩托车为无人驾驶。";
    expect(g6EventWitnessChecks(witnessInput(fixture)).some(check => check.failureCode === "APPROVED_MOVING_RIVAL_DRIVERLESS")).toBe(false);
  });

  it("binds retained original requirements to the same current approved plan and actor", () => {
    const fixture = scenario({ action: "右手拧动油门；" + firstAction });
    const checks = g6EventWitnessChecks(witnessInput(fixture));
    const proofs = checks.flatMap(check => check.eventWitness ? [check.eventWitness] : []);
    fixture.fields.timeline = firstTimeline.replace("T00:00–T00:03 ", "T00:00–T00:03 右手拧开油门；");
    expect(g6EventWitnessRepairDrift(witnessInput(fixture), proofs)).toBe(false);
    fixture.plan.scenes[0]!.approvedScene.actions[0]!.actorId = "foreign-actor";
    expect(g6EventWitnessRepairDrift(witnessInput(fixture), proofs)).toBe(true);
  });
});

describe("same-event camera windows", () => {
  const action = "停稳双脚落地；双手抬起全盔并甩头一次；完全下车，登上领奖台，自取奖杯。";
  const timeline = "T00:00–T00:02 停稳双脚落地；T00:02–T00:04 双手抬起全盔并甩头一次；"
    + "T00:04–T00:06 完全下车，登上领奖台；T00:06–T00:08 自取奖杯并自然微动。";
  const correctCamera = "T00:00–T00:02 固定侧前中景；T00:02–T00:04 同侧前中景完整覆盖抬盔、脱盔与甩头；"
    + "T00:04–T00:08 随完全下车登台轻摇后停稳，容纳后续取奖杯与微动。";
  function cameraScenario(camera: string) {
    const fixture = scenario({ shotId: "ceremony-different-id", purpose: action, action, timeline, camera,
      visual: ["在同一场景依次记录所有领奖动作。"] });
    fixture.input.shots[0]!.compile = { ...compile, model: { ...compile.model, cameraFixedSupported: false } };
    return fixture;
  }

  it("allows one bounded camera view to follow an event then hold for the next without inventing a cut", () => {
    expect(g6EventWitnessChecks(witnessInput(cameraScenario(correctCamera)))).toEqual([]);
  });

  it("keeps a detailed inherited body-part action as the lead's event", () => {
    const fixture = cameraScenario(correctCamera);
    fixture.fields.timeline = timeline.replace("双手抬起全盔", "双手托住全盔下缘向上抬起全盔");
    expect(g6EventWitnessChecks(witnessInput(fixture))).toEqual([]);
  });

  it("binds the camera timeline to the nearest explicit lead after an unknown actor", () => {
    const fixture = cameraScenario(correctCamera);
    fixture.fields.timeline = timeline.replace("双手抬起全盔", "王某骑手先走过后主车双手抬起全盔");
    expect(g6EventWitnessChecks(witnessInput(fixture))).toEqual([]);
  });

  it.each([
    correctCamera.replace("T00:02–T00:04", "T00:03–T00:04").replace("T00:00–T00:02", "T00:00–T00:03"),
    "T00:00–T00:02 跟随完全下车登台；T00:02–T00:04 同侧前中景覆盖抬盔甩头；T00:04–T00:08 固定机位。",
    "T00:00–T00:02 固定机位；T00:02–T00:03 完整覆盖抬盔甩头；T00:03–T00:08 跟随完全下车登台。",
  ])("diagnoses a bounded event window that starts late, omits the end or follows a future event", camera => {
    const fixture = cameraScenario(camera);
    const checks = g6EventWitnessChecks(witnessInput(fixture));
    expect(checks).toEqual([expect.objectContaining({ field: "camera_movement", failureCode: "APPROVED_CAMERA_EVENT_WINDOW_MISMATCH" })]);
    const proofs = checks.flatMap(check => check.eventWitness ? [check.eventWitness] : []);
    fixture.fields.camera_movement = "T00:00–T00:08 固定机位。";
    expect(g6EventWitnessRepairDrift(witnessInput(fixture), proofs)).toBe(true);
    fixture.fields.camera_movement = correctCamera;
    expect(g6EventWitnessRepairDrift(witnessInput(fixture), proofs)).toBe(false);
  });

  it("repairs a camera event window through the actual routed native path once", async () => {
    const fixture = cameraScenario("T00:00–T00:02 跟随完全下车登台；T00:02–T00:04 同侧前中景覆盖抬盔甩头；T00:04–T00:08 固定机位。");
    const native = nativeReviewer({ camera_movement: correctCamera });
    const before = compilePromptPackage(fixture.input)[0]!.contract;
    const result = await evaluatePromptPackage({ ...fixture.input, reviewer: native.reviewer });
    expect(native.calls.map(call => call.kind)).toEqual(["review", "repair", "review"]);
    expect(native.calls[1]!.context.allowedFields.map((row: { field: string }) => row.field)).toEqual(["camera_movement"]);
    expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
    expect(result.shotContracts[0]!.contract.request).toEqual(before.request);
    expect(result.repairAttempt?.eventWitnesses?.every(proof => proof.sources.length > 0)).toBe(true);
  });

  it.each(["王某骑手双手抬起全盔并甩头一次", "主车停稳后王某骑手双手抬起全盔并甩头一次"])(
    "does not use an explicit unknown actor's ceremony as the lead's camera timeline witness (%s)", otherActorEvent => {
    const fixture = cameraScenario(correctCamera);
    fixture.fields.timeline = timeline.replace("双手抬起全盔并甩头一次", otherActorEvent);
    expect(g6EventWitnessChecks(witnessInput(fixture))).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "camera_movement", failureCode: "APPROVED_CAMERA_EVENT_WINDOW_MISMATCH" }),
    ]));
    });

  it("binds the racing camera's finish instant to the same actual timeline without treating the approach as a finish", () => {
    const fixture = scenario({ shotId: "finish-scope", purpose: secondPurpose, visual: [distinctBrief],
      action: secondAction, timeline: secondTimeline.replace("贴身追近；", "贴身追近，建立冲线前的贴身位势；"),
      camera: "T00:00–T00:04 同向侧跟；T00:04–T00:07 冲线瞬间急推并切前轮压线特写；T00:07–T00:08 后拉。" });
    const check = g6EventWitnessChecks(witnessInput(fixture)).find(row => row.failureCode === "APPROVED_CAMERA_EVENT_WINDOW_MISMATCH");
    // The approved timeline puts the stripe in 4–6, so this exact camera start is compatible.
    expect(check).toBeUndefined();
    fixture.fields.camera_movement = "T00:00–T00:02 同向侧跟；T00:02–T00:05 冲线瞬间急推并切前轮压线特写；T00:05–T00:08 后拉。";
    const diagnosed = g6EventWitnessChecks(witnessInput(fixture)).find(row => row.failureCode === "APPROVED_CAMERA_EVENT_WINDOW_MISMATCH")!;
    expect(diagnosed?.field).toBe("camera_movement");
    const proof = diagnosed.eventWitness!;
    fixture.fields.camera_movement = "T00:00–T00:08 侧跟至前轮压线。";
    expect(g6EventWitnessRepairDrift(witnessInput(fixture), [proof])).toBe(true);
    fixture.fields.camera_movement = "T00:00–T00:04 同向侧跟；T00:04–T00:06 冲线瞬间切前轮压线特写；T00:06–T00:08 后拉。";
    expect(g6EventWitnessRepairDrift(witnessInput(fixture), [proof])).toBe(false);
  });
});
