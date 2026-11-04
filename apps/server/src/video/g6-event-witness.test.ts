import { afterEach, describe, expect, it } from "vitest";
import { WorkloomLLMEngine, type PromptCompileOptions } from "@hyperreality/video-studio";
import { OpenAiCompatibleProvider, resetCircuit } from "@workloom/base/model-router";
import { modelPolicyFor } from "../service/llm.js";
import {
  compilePromptPackage, createLlmSemanticQualityReviewer, evaluatePromptPackage, SEMANTIC_QUALITY_CHECK_IDS,
} from "./prompt-quality-gate.js";

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

function nativeReviewer(replacements: Record<string, string>, { secondFailure = false } = {}) {
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
      output = { changes: context.allowedFields.map(({ field }: { field: string }) => ({ field,
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
      const native = nativeReviewer({ character_constraint: "命名主角唯一；对手车由匿名全盔成年骑手正常驾驶。" });
      const result = await evaluatePromptPackage({ ...fixture.input, reviewer: native.reviewer });
      expect(native.calls.map(call => call.kind)).toEqual(["review", "repair", "review"]);
      expect(native.calls[1]!.context.allowedFields.map((row: { field: string }) => row.field)).toEqual(["character_constraint"]);
      expect(native.calls[1]!.context.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: "character_constraint", failureCode: "APPROVED_MOVING_RIVAL_DRIVERLESS" }),
      ]));
      expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
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
});
