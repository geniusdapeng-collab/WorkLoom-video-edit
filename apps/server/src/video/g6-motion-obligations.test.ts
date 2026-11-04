import { describe, expect, it, vi } from "vitest";
import type { PromptCompileOptions } from "@hyperreality/video-studio";
import { compilePromptPackage, evaluatePromptPackage, SEMANTIC_QUALITY_CHECK_IDS, type SemanticQualityReviewer } from "./prompt-quality-gate.js";

const ownerBrief = "双手抬盔后黑色长发完整落肩；完全下车，再转身登紧邻停车点的领奖台最高一级，自取预置奖杯举杯。";
const oldAction = "停稳后双脚落地，双手抬起全盔，右手把盔夹在腋下；甩头长发落到肩背，她跨下车、转身，两步半登上最高一级，弯腰取起台面上预置的奖杯，双手托底举到胸前高度。";
const start = "T00:00–T00:02 驶入维修区并停稳。T00:02–T00:04 双脚落地，双手抬盔。";
const oldTimeline = `${start}T00:04–T00:06 头盔落到右手，视线低垂。T00:06–T00:07 甩头长发落肩。T00:07–T00:08.5 跨下车、转身、两步半登上最高一级，弯腰取杯；目的：用连续动作代替剪接。T00:08.5–T00:10 双手托底把奖杯举到胸前，站直，末段自然微动。`;
const fixedAction = "停稳双脚落地，双手抬盔并甩头落发，把头盔放稳在相邻矮台，空出双手；她跨下车，转身登上最高一级，取起预置奖杯，双手举杯，末段自然微动。";
const fixedTimeline = `${start}T00:04–T00:05 甩头落发，把头盔放稳在相邻矮台。T00:05–T00:06 完全下车。T00:06–T00:08 转身登上最高一级。T00:08–T00:10 自取预置奖杯、双手举杯，末段自然微动。`;
const attempt38Action = "停稳双脚落地撑车；双手抬起全盔向上脱出，顺势甩头一次，黑色长发从盔内完整落到肩背；完全下车，转身两步登上领奖台最高一级，自己拿起预置奖杯举起，末两秒保持自然呼吸与轻微重心变化。";
const attempt38Timeline = "T00:00–T00:02.5：收油滑入维修区，前轮定点停稳，双脚落地撑车。T00:02.5–T00:04.5：停稳后的绝对静止，视线落向地面。T00:04.5–T00:06.5：双手抬盔上脱，盔离头，顺势甩头一次，黑色长发完整落到肩背。T00:06.5–T00:08.5：完全下车，转身两步登上最高一级，自取预置奖杯举起，动作幅度克制，目的是完成登台；T00:08.5–T00:10：保持自然呼吸与轻微重心变化，原生声场自然减弱。";

const compile: PromptCompileOptions = {
  delivery: { aspectRatio: "9:16", resolution: "1080p", fps: 30, format: "mp4", generateAudio: true },
  model: { modelId: "seedance", provider: "seedance", providerModel: "fixture-model", version: "fixture",
    modes: ["r2v"], durationSec: { min: 4, max: 15 }, aspectRatios: ["9:16"], resolutions: ["1080p"],
    maxReferenceImages: 2, maxPromptChars: 4000 },
  assets: ["front", "closeup"].map((angle, index) => ({ field: "portraits", role: "reference_image", sha256: String(index+1).repeat(64),
    bytes: 100, mediaType: "image/png", sourceRef: `characters/project/lead-${angle}.png` })),
};

function scenario({ action = oldAction, timeline = oldTimeline, brief = ownerBrief, shotId = "ending",
  wrongDuration = false, foreign = false, approved = ["维修区停稳双脚落地后双手抬起全盔。", "完全下车，转身登上最高一级，自己拿起预置奖杯举杯。"],
}: { action?: string; timeline?: string; brief?: string; shotId?: string; wrongDuration?: boolean; foreign?: boolean; approved?: readonly string[] } = {}) {
  const fields = {
    director_instruction: "商业写实，完整呈现维修区领奖动作。", constraint: "9:16画幅，1080x1920，30fps，MP4格式。",
    baseline: "保留真实赛道质感。", scene: "封闭赛道维修区的三级领奖台。", lighting: "维修区柔和侧前光。",
    camera_movement: "侧前中景机位跟随实际动作。", character: "全覆护具赛车手李英子。", action,
    portraits: "李英子：image://characters/project/lead-front.png, image://characters/project/lead-closeup.png", dialogue: "无台词。",
    negative: "禁止画面文字和水印。", consistency: "全片保持同一套护具。", composition: "中景同时保留人物与领奖台。",
    color_palette: "赛道灰色与白色路缘。", depth_of_field: "中景主体与台阶清晰。", timeline, mood: "镇定自信。",
    bright_constraint: "光线照亮奖杯。", character_constraint: "只保留同一位赛车手。", costume: "全覆赛车服及完整护具。",
    props: "全盔、车和预置奖杯。", pacing: "先停车再连贯登台。", audio: "原生风声与脚步声。", makeup: "自然妆面。",
    transition: "零秒硬切进场。",
  };
  const review = vi.fn<SemanticQualityReviewer["review"]>(async ({ contract }) => ({ shotId: contract.shotId,
    checks: SEMANTIC_QUALITY_CHECK_IDS.map((id) => ({ id, pass: true,
      field: id === "SQ3_CAMERA_FEASIBLE" ? "camera_movement" : id === "SQ4_LIGHT_COLOR" ? "lighting" : "scene",
      evidence: id === "SQ3_CAMERA_FEASIBLE" ? fields.camera_movement : id === "SQ4_LIGHT_COLOR" ? fields.lighting : fields.scene,
    })) }));
  const repair = vi.fn<NonNullable<SemanticQualityReviewer["repair"]>>(async ({ allowedFields }) => ({ changes: allowedFields.map(field => ({
    field, value: field === "action" ? fixedAction : fixedTimeline, reason: "按当前已审动作重新分配段内时点和道具交接",
  })) }));
  const upstreamContext = { approvedProductionPlan: { g4ArtifactSha256: "a".repeat(64), requirementContractHash: "b".repeat(64),
    scenes: [{ shotId: foreign ? "another-shot" : shotId, sceneId: shotId, interval: { startSec: 20, endSec: wrongDuration ? 29 : 30, brief },
      approvedScene: { actions: approved.map(description => ({ actorId: "lead", description })) },
      verificationPlan: { visualRequirements: ["中景保留实际动作。"] } }] } };
  return { review, repair, input: { mode: "enforce" as const, projectId: "P", runId: "R", stageRunId: "SR", revision: 1,
    shots: [{ source: { shotId, duration: 10, fields, portraits: fields.portraits }, compile }], reviewer: { review, repair }, upstreamContext,
    maxFinalPromptChars: 3000 } };
}

describe("G6 approved physical motion", () => {
  it("authorizes the actual #38 timing and missing helmet cue together on the first action-only model diagnosis", async () => {
    const fixture = scenario({ action: attempt38Action, timeline: attempt38Timeline });
    const pass = fixture.review.getMockImplementation()!;
    fixture.review.mockImplementationOnce(async context => {
      const result = await pass(context) as { shotId: string; checks: unknown[] };
      result.checks[1] = { id: "SQ2_SCENE_PROPS", field: "action", pass: false,
        failureCode: "PROP_HANDOFF_UNCLEAR", evidence: "双手抬起全盔向上脱出", repair: "写清取杯前的头盔安置" };
      return result;
    });
    const result = await evaluatePromptPackage(fixture.input);
    expect(fixture.repair).toHaveBeenCalledTimes(1);
    expect(fixture.review).toHaveBeenCalledTimes(2);
    expect(new Set(fixture.repair.mock.calls[0]![0].allowedFields)).toEqual(new Set(["action", "timeline"]));
    expect(fixture.repair.mock.calls[0]![0].findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "timeline", failureCode: "TIMELINE_PROP_HANDOFF_MISSING" }),
      expect.objectContaining({ field: "timeline", failureCode: "TIMELINE_ACTION_DENSITY_EXCEEDS_DURATION" }),
    ]));
    expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
  });

  it("requires missing helmet custody on the timeline even when the action already safely places the helmet", async () => {
    const fixture = scenario({ action: attempt38Action.replace("完全下车", "将全盔放稳在车座上，再完全下车"), timeline: attempt38Timeline });
    const result = await evaluatePromptPackage(fixture.input);
    expect(fixture.repair).toHaveBeenCalledTimes(1);
    expect(fixture.repair.mock.calls[0]![0].allowedFields).toEqual(["timeline"]);
    expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
  });

  it("finds both #37 physical failures before spending the sole field repair", async () => {
    const fixture = scenario();
    const original = compilePromptPackage(fixture.input)[0]!.contract;
    const result = await evaluatePromptPackage(fixture.input);
    expect(fixture.repair).toHaveBeenCalledTimes(1);
    expect(fixture.review).toHaveBeenCalledTimes(2);
    expect(new Set(fixture.repair.mock.calls[0]![0].allowedFields)).toEqual(new Set(["action", "timeline"]));
    expect(fixture.repair.mock.calls[0]![0].findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "timeline", failureCode: "TIMELINE_ACTION_DENSITY_EXCEEDS_DURATION" }),
      expect.objectContaining({ field: "action", failureCode: "HELMET_HANDOFF_CONFLICTS_WITH_TROPHY" }),
    ]));
    expect(result).toMatchObject({ status: "passed", g6Eligible: true, renderEligible: false });
    const current = result.shotContracts[0]!.contract;
    const { timeline: _before, ...beforeTechnical } = original.request.technical;
    const { timeline: _after, ...afterTechnical } = current.request.technical;
    expect({ ...current.request, technical: afterTechnical }).toEqual({ ...original.request, technical: beforeTechnical });
  });

  it.each([
    ["two-second boundary with released helmet", { action: fixedAction, timeline: fixedTimeline.replace("T00:05–T00:06 完全下车。T00:06–T00:08 转身登上最高一级。T00:08–T00:10 自取预置奖杯、双手举杯，末段自然微动。", "T00:05–T00:07 跨下车、转身登上最高一级，弯腰取杯。T00:07–T00:10 双手举杯，末段自然微动。") }],
    ["stable elbow support with explicitly freed hands", { action: fixedAction.replace("把头盔放稳在相邻矮台，空出双手", "头盔夹稳在左臂弯内，腾出双手"), timeline: fixedTimeline }],
    ["helmet removal by both hands is not continued holding", { action: fixedAction.replace("双手抬盔并甩头落发，把头盔放稳在相邻矮台，空出双手", "双手托着全盔向上摘，甩头落发"),
      timeline: fixedTimeline }],
    ["negated apparent motions", { action: fixedAction, timeline: `${start}T00:04–T00:06 甩头落发。T00:06–T00:07 不安排跨下车、转身、两步登上最高一级、弯腰取杯。T00:07–T00:10 连续保留已审动作与原声。` }],
    ["not current G4 shot", { foreign: true }],
    ["interval mismatch", { wrongDuration: true }],
    ["frozen owner did not approve the sequence", { brief: "停稳后远看领奖台，不下车、不取奖杯。" }],
    ["G4 does not approve the owner action", { approved: ["双手抬盔。", "不要下车、转身登上最高一级、取起奖杯。"] }],
    ["G4 explicitly forbids taking the trophy", { approved: ["双手抬盔。", "完全下车并转身登上最高一级，但不取预置奖杯。"] }],
  ] as const)("does not request this scoped repair for %s", async (_label, override) => {
    const fixture = scenario(override);
    const result = await evaluatePromptPackage(fixture.input);
    expect(result.g6Eligible).toBe(true);
    expect(fixture.repair).not.toHaveBeenCalled();
  });

  it("does not let the one repair erase the timed approved action chain", async () => {
    const fixture = scenario();
    fixture.repair.mockResolvedValueOnce({ changes: [{ field: "action", value: fixedAction, reason: "补交接" },
      { field: "timeline", value: "T00:00–T00:10 侧前中景保留自然微动。", reason: "非法删除完整时序" }] });
    const result = await evaluatePromptPackage(fixture.input);
    expect(result.g6Eligible).toBe(false);
    expect(result.repairAttempt?.reason).toBe("APPROVED_MOTION_TIMELINE_REPAIR_DRIFT");
    expect(fixture.repair).toHaveBeenCalledTimes(1);
  });

  it("requires a real handoff rather than deleting evidence of holding the helmet", async () => {
    const fixture = scenario();
    fixture.repair.mockResolvedValueOnce({ changes: [
      { field: "action", value: fixedAction.replace("，把头盔放稳在相邻矮台，空出双手", ""), reason: "省略交接" },
      { field: "timeline", value: fixedTimeline.replace("，把头盔放稳在相邻矮台", ""), reason: "省略交接" },
    ] });
    const result = await evaluatePromptPackage(fixture.input);
    expect(result.g6Eligible).toBe(false);
    expect(result.repairAttempt?.reason).toBe("APPROVED_MOTION_HELMET_REPAIR_DRIFT");
  });

  it("accepts the already approved one-handed trophy action with the helmet held by the other hand", async () => {
    const fixture = scenario();
    fixture.repair.mockResolvedValueOnce({ changes: [
      { field: "action", value: fixedAction.replace("，把头盔放稳在相邻矮台，空出双手", "")
        .replace("双手举杯", "左手提着头盔，右手举起奖杯"), reason: "保持实拍手位" },
      { field: "timeline", value: fixedTimeline.replace("，把头盔放稳在相邻矮台", "")
        .replace("双手举杯", "左手提着头盔，右手举起奖杯"), reason: "同步同一时段的手位" },
    ] });
    const result = await evaluatePromptPackage(fixture.input);
    expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
  });

  it("accepts the opposite elbow supporting the helmet before the other hand takes and raises the trophy", async () => {
    const fixture = scenario();
    const leftElbow = "左手把盔夹在肘侧，她跨下车，转身登上最高一级，右手取起预置奖杯举到胸前，末段自然微动。";
    fixture.repair.mockResolvedValueOnce({ changes: [
      { field: "action", value: "停稳双脚落地，双手托起全盔向上抬并拔出，甩头落发；" + leftElbow, reason: "左肘稳盔，右手举杯" },
      { field: "timeline", value: `${start}T00:04–T00:05 甩头落发。T00:05–T00:08 左手把盔夹在肘侧，完全下车，转身登上最高一级。T00:08–T00:10 右手取起预置奖杯举到胸前。`, reason: "同步左肘和右手动作" },
    ] });
    const result = await evaluatePromptPackage(fixture.input);
    expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
  });

  it("does not let a released helmet in the action erase explicitly held helmet in the timeline", async () => {
    const timeline = oldTimeline.replace("T00:06–T00:07", "T00:06–T00:06.5")
      .replace("T00:07–T00:08.5", "T00:06.5–T00:09").replace("T00:08.5–T00:10", "T00:09–T00:10");
    const fixture = scenario({ action: fixedAction, timeline });
    const result = await evaluatePromptPackage(fixture.input);
    expect(fixture.repair.mock.calls[0]![0].allowedFields).toEqual(["timeline"]);
    expect(fixture.repair.mock.calls[0]![0].findings).toEqual([
      expect.objectContaining({ field: "timeline", failureCode: "HELMET_HANDOFF_CONFLICTS_WITH_TROPHY" }),
    ]);
    expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
  });

  it("rejects unresolved alternative placements in the repaired physical handoff", async () => {
    const fixture = scenario();
    fixture.repair.mockResolvedValueOnce({ changes: [
      { field: "action", value: fixedAction.replace("放稳在相邻矮台", "放稳在相邻矮台或者夹在右臂"), reason: "尚未确定的交接" },
      { field: "timeline", value: fixedTimeline, reason: "明确时间轴中的交接" },
    ] });
    const result = await evaluatePromptPackage(fixture.input);
    expect(result.g6Eligible).toBe(false);
    expect(result.repairAttempt?.reason).toBe("APPROVED_MOTION_HELMET_REPAIR_DRIFT");
  });
});
