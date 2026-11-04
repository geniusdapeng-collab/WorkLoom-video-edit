import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkloomLLMEngine, type PromptCompileOptions } from "@hyperreality/video-studio";
import { OpenAiCompatibleProvider, resetCircuit } from "@workloom/base/model-router";
import { modelPolicyFor } from "../service/llm.js";
import { compilePromptPackage, createLlmSemanticQualityReviewer, evaluatePromptPackage, SEMANTIC_QUALITY_CHECK_IDS, type SemanticQualityReviewer } from "./prompt-quality-gate.js";

const ownerBrief = "双手抬盔后黑色长发完整落肩；完全下车，再转身登紧邻停车点的领奖台最高一级，自取预置奖杯举杯。";
const oldAction = "停稳后双脚落地，双手抬起全盔，右手把盔夹在腋下；甩头长发落到肩背，她跨下车、转身，两步半登上最高一级，弯腰取起台面上预置的奖杯，双手托底举到胸前高度。";
const start = "T00:00–T00:02 驶入维修区并停稳。T00:02–T00:04 双脚落地，双手抬盔。";
const oldTimeline = `${start}T00:04–T00:06 头盔落到右手，视线低垂。T00:06–T00:07 甩头长发落肩。T00:07–T00:08.5 跨下车、转身、两步半登上最高一级，弯腰取杯；目的：用连续动作代替剪接。T00:08.5–T00:10 双手托底把奖杯举到胸前，站直，末段自然微动。`;
const fixedAction = "停稳双脚落地，双手抬盔并甩头落发，把头盔放稳在相邻矮台，空出双手；她跨下车，转身登上最高一级，取起预置奖杯，双手举杯，末段自然微动。";
const fixedTimeline = `${start}T00:04–T00:05 甩头落发，把头盔放稳在相邻矮台。T00:05–T00:06 完全下车。T00:06–T00:08 转身登上最高一级。T00:08–T00:10 自取预置奖杯、双手举杯，末段自然微动。`;
const attempt38Action = "停稳双脚落地撑车；双手抬起全盔向上脱出，顺势甩头一次，黑色长发从盔内完整落到肩背；完全下车，转身两步登上领奖台最高一级，自己拿起预置奖杯举起，末两秒保持自然呼吸与轻微重心变化。";
const attempt38Timeline = "T00:00–T00:02.5：收油滑入维修区，前轮定点停稳，双脚落地撑车。T00:02.5–T00:04.5：停稳后的绝对静止，视线落向地面。T00:04.5–T00:06.5：双手抬盔上脱，盔离头，顺势甩头一次，黑色长发完整落到肩背。T00:06.5–T00:08.5：完全下车，转身两步登上最高一级，自取预置奖杯举起，动作幅度克制，目的是完成登台；T00:08.5–T00:10：保持自然呼吸与轻微重心变化，原生声场自然减弱。";
const attempt39Action = "双脚落地撑住车身；双手抬起全盔离开头顶，黑色长发完整落到肩背；把盔收在左臂弯，抬右腿跨过车座完全下车，双脚站定后侧身转向领奖台，抬右脚踩上最高一级、左脚跟上，屈膝取起预置奖杯，双手举过肩。";
const attempt39Timeline = "T00:00–T00:02.5 赛车滑入停车点减速停稳，人物双脚落地撑车。T00:02.5–T00:05 双手抬盔离头，黑色长发完整落到肩背。T00:05–T00:08 完全下车，侧身转身两步到领奖台，抬右脚踩最高一级、左脚跟上，屈膝取起预置奖杯。T00:08–T00:10 双手举杯，保持自然微动不冻结。";
const attempt42EndingCamera = "T00:00-00:02.5 稳定器由赛车车头与她的双脚起幅，匀速小幅推近至胸线中景，速度克制不抢动作；T00:02.5-00:05.5 跟住抬盔与甩头的节奏做一次约半步的轻微横移，机位高度不变，让黑发落肩的轨迹完整留在画面内；T00:05.5-00:08 随她转身下车向领奖台方向做平顺的侧向跟随，落到领奖台正面偏侧的中景位置；T00:08-00:10 运镜完全停稳，只在原地保留极小幅度的手持呼吸感，不推不拉，让末段画面自然微动而不冻结。";
const attempt42EndingTimeline = "T00:00-00:02.5 赛车驶入维修区减速停稳，她双脚落地撑住车身，身体重心由车上传回地面，画面从车头边缘推近到腿脚；T00:02.5-00:05 双手抬到盔沿，把全盔从头顶摘下，顺势低头甩发一次，黑色长发整片落到肩背，镜头推至胸线中景；T00:05-00:07.5 单手持盔跨下车，转身正对领奖台，一步一级踏上三级台阶，机位随之轻微横移；T00:07.5-00:09 在最高一级站定，右手拿起预置奖杯抬至胸前，眼睑缓慢闭合半秒再睁开，视线由低位抬起；T00:09-00:10 保持肩背打开的站姿，随呼吸与手臂微动，画面留自然微动不冻结。";
const correctedEndingCamera = "T00:00-00:02.5 低位跟随车头到落地双脚；T00:02.5-00:05 镜头推至胸线中景，跟住抬盔与甩头作轻微横移；T00:05-00:08 侧向跟随完全下车、登上最高一级及取杯起势；T00:08-00:10 运镜收稳，保留自然呼吸微动。";

const compile: PromptCompileOptions = {
  delivery: { aspectRatio: "9:16", resolution: "1080p", fps: 30, format: "mp4", generateAudio: true },
  model: { modelId: "seedance", provider: "seedance", providerModel: "fixture-model", version: "fixture",
    modes: ["r2v"], durationSec: { min: 4, max: 15 }, aspectRatios: ["9:16"], resolutions: ["1080p"],
    maxReferenceImages: 2, maxPromptChars: 4000 },
  assets: ["front", "closeup"].map((angle, index) => ({ field: "portraits", role: "reference_image", sha256: String(index+1).repeat(64),
    bytes: 100, mediaType: "image/png", sourceRef: `characters/project/lead-${angle}.png` })),
};

function scenario({ action = oldAction, timeline = oldTimeline, cameraMovement = "侧前中景机位跟随实际动作。", brief = ownerBrief, shotId = "ending",
  wrongDuration = false, foreign = false, approved = ["维修区停稳双脚落地后双手抬起全盔。", "完全下车，转身登上最高一级，自己拿起预置奖杯举杯。"],
}: { action?: string; timeline?: string; cameraMovement?: string; brief?: string; shotId?: string; wrongDuration?: boolean; foreign?: boolean; approved?: readonly string[] } = {}) {
  const fields = {
    director_instruction: "商业写实，完整呈现维修区领奖动作。", constraint: "9:16画幅，1080x1920，30fps，MP4格式。",
    baseline: "保留真实赛道质感。", scene: "封闭赛道维修区的三级领奖台。", lighting: "维修区柔和侧前光。",
    camera_movement: cameraMovement, character: "全覆护具赛车手李英子。", action,
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

afterEach(() => resetCircuit("preproduction"));

function nativeScenario(timeline: string, { helmet = true, foreign = false, action, revisedTimeline = fixedTimeline,
  cameraRepair = false }: { helmet?: boolean; foreign?: boolean; action?: string; revisedTimeline?: string; cameraRepair?: boolean } = {}) {
  const fixture = scenario({ action: action ?? attempt39Action.replace("踩上最高一级", "迈到台阶最顶层"), timeline, foreign });
  const calls: string[] = [];
  const repairPrompts: string[] = [];
  const repairs: Array<Array<{ field: string }>> = [];
  const model = "deepseek-flash", baseUrl = "http://g6-motion-fixture.invalid/v1", apiKey = "fixture-only";
  const provider = new OpenAiCompatibleProvider(model, { baseUrl, apiKey, fetchImpl: async (url, init) => {
    expect(String(url)).toBe(`${baseUrl}/chat/completions`);
    const { messages } = JSON.parse(String(init?.body));
    const prompt = String(messages.at(-1).content).split("\n\n【硬性输出要求】", 1)[0]!;
    const repairing = prompt.startsWith("你是字段级定点修复器。");
    const context = JSON.parse(prompt.slice(repairing ? prompt.indexOf("镜头：{") + 3 : prompt.indexOf("\n{\n") + 1));
    const shotId = context.shotId as string;
    const seen = calls.includes(`review:${shotId}`);
    calls.push(`${repairing ? "repair" : "review"}:${shotId}`);
    let payload: unknown;
    if (repairing) {
      const fields: Array<{ field: string }> = context.allowedFields;
      repairs.push(fields);
      repairPrompts.push(prompt);
      const replacements = { action: fixedAction, timeline: revisedTimeline, camera_movement: "侧前中景随同已审动作转入领奖台。" };
      payload = { changes: fields.map(({ field }) => ({
        field, value: replacements[field as keyof typeof replacements], reason: "落实本镜已审动作",
      })) };
    } else {
      const rows = new Map<string, string>(context.fields.map(({ field, value }: { field: string; value: string }) => [field, value]));
      const checks = SEMANTIC_QUALITY_CHECK_IDS.map(id => {
        const field = id === "SQ3_CAMERA_FEASIBLE" ? "camera_movement" : id === "SQ4_LIGHT_COLOR" ? "lighting" : "scene";
        return { id, pass: true, field, evidence: rows.get(field)! };
      });
      if (shotId === "ending" && !seen) {
        if (cameraRepair) Object.assign(checks[2]!, { field: "camera_movement", pass: false, failureCode: "CAMERA_PULL_START_WINDOW_MISALIGNED",
          evidence: rows.get("camera_movement"), repair: "对齐时间轴上已审动作窗口" });
        else Object.assign(checks[1]!, { id: "SQ2_SCENE_PROPS", field: "action", pass: false, failureCode: helmet ? "PROP_HANDOFF_UNCLEAR" : "TROPHY_PROP_POSITION",
          evidence: helmet ? "把盔收在左臂弯" : "屈膝取起预置奖杯", repair: helmet ? "明确头盔放置及双手腾出" : "明确奖杯位置" });
      }
      payload = { shotId, checks };
    }
    return Response.json({ id: `g6-motion-${calls.length}`, model, object: "chat.completion",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(payload) } }],
      usage: { prompt_tokens: 300, completion_tokens: 100, total_tokens: 400 } });
  } });
  const engine = new WorkloomLLMEngine({ model, baseUrl, apiKey, router: { providers: new Map([[model, provider]]),
    policy: structuredClone(modelPolicyFor("ai-video")!), scene: "preproduction", forceModel: model,
    sink: { recordModelTrace: async () => undefined, recordDegradation: async () => undefined, recordCircuitBreak: async () => undefined } } });
  const ending = fixture.input.shots[0]!;
  const opening = { ...ending, source: { ...ending.source, shotId: "opening" } };
  return { calls, repairs, repairPrompts, input: { ...fixture.input, shots: [opening, ending], reviewer: createLlmSemanticQualityReviewer(engine) } };
}

describe("G6 approved physical motion", () => {
  function endingCameraScenario(override: Parameters<typeof scenario>[0] = {}) {
    const fixture = scenario({ action: fixedAction, timeline: attempt42EndingTimeline, cameraMovement: attempt42EndingCamera,
      brief: "进入维修区停稳并双脚落地；同一侧前中景双手抬盔、顺势甩头一次，黑色长发完整落到肩背；完全下车，再转身登紧邻停车点的领奖台最高一级，自取预置奖杯举杯。",
      approved: ["驶入维修区后减速停稳，双脚落地撑住车身，双手抬盔从头顶摘下并顺势甩头一次，黑色长发完整落到肩背；随后完全下车，转身走到紧邻停车点的领奖台最高一级，自己拿起预置奖杯举起"],
      ...override });
    fixture.review.mockImplementation(async ({ contract }) => ({
      shotId: contract.shotId,
      checks: SEMANTIC_QUALITY_CHECK_IDS.map(id => ({ id, pass: true,
        field: id === "SQ3_CAMERA_FEASIBLE" ? "constraint" : id === "SQ4_LIGHT_COLOR" ? "lighting" : "scene",
        evidence: id === "SQ3_CAMERA_FEASIBLE" ? "1080x1920" : id === "SQ4_LIGHT_COLOR" ? "维修区柔和侧前光" : "封闭赛道维修区的三级领奖台",
      })),
    }));
    fixture.repair.mockImplementation(async ({ allowedFields }) => ({
      changes: allowedFields.filter(field => field === "camera_movement" || field === "composition").map(field => ({
        field, value: field === "camera_movement" ? correctedEndingCamera : "中景完整保留人物与相邻领奖台。",
        reason: "保留已审动作与构图，只调整同一事件的运镜窗口",
      })),
    }));
    return fixture;
  }

  it("adds both actual #42 ending camera conflicts to the one existing length and description repair", async () => {
    const fixture = endingCameraScenario();
    fixture.input.shots[0]!.source.fields.composition = "保留人物与相邻领奖台，删去这段重复描述。".repeat(110);
    const original = compilePromptPackage(fixture.input)[0]!.contract;
    expect(original.prompt.length).toBeGreaterThan(3000);
    const result = await evaluatePromptPackage(fixture.input);
    expect(fixture.repair).toHaveBeenCalledTimes(1);
    expect(fixture.review).toHaveBeenCalledTimes(2);
    const repair = fixture.repair.mock.calls[0]![0];
    expect(repair.allowedFields.filter(field => field === "camera_movement")).toHaveLength(1);
    expect(repair.allowedFields).toContain("composition");
    expect(repair.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "camera_movement", failureCode: "APPROVED_ENDING_CAMERA_CHEST_BEFORE_ACTION",
        evidence: expect.stringMatching(/0–2\.5.*2\.5–5/u) }),
      expect.objectContaining({ field: "camera_movement", failureCode: "APPROVED_ENDING_CAMERA_HELMET_WINDOW_SPILLS",
        evidence: expect.stringMatching(/2\.5–5\.5.*2\.5–5.*5–7\.5/u) }),
    ]));
    expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
    expect(result.shotContracts[0]!.contract.request).toEqual(original.request);
    expect(result.shotContracts[0]!.contract.prompt).toContain(attempt42EndingTimeline);
  });

  it.each([
    ["shorter matching camera events", { cameraMovement: correctedEndingCamera
      .replace("T00:02.5-00:05 镜头", "T00:02.5-00:03 跟住长发。T00:03-00:04.8 镜头")
      .replace("作轻微横移；T00:05", "作轻微横移；T00:04.8-00:05 轻稳构图；T00:05") }],
    ["different camera events at unequal boundaries", { cameraMovement: attempt42EndingCamera
      .replace("推近至胸线中景", "推近至赛车侧面").replace("跟住抬盔与甩头的节奏", "跟随背景光影") }],
    ["negated early chest push and helmet following", { cameraMovement: attempt42EndingCamera
      .replace("匀速小幅推近至胸线中景", "不要推近至胸线中景").replace("跟住抬盔与甩头", "不跟住抬盔与甩头") }],
    ["unbound G4 shot", { foreign: true }],
    ["different approved interval length", { wrongDuration: true }],
    ["G4 did not approve the ending sequence", { approved: ["停车停稳，仅展示奖杯。"] }],
    ["different shot id", { shotId: "opening" }],
  ] as const)("keeps camera locked when there is no scoped event contradiction for %s", async (_label, overrides) => {
    const fixture = endingCameraScenario(overrides);
    expect((await evaluatePromptPackage(fixture.input)).g6Eligible).toBe(true);
    expect(fixture.repair).not.toHaveBeenCalled();
  });

  it.each([
    ["erased timing", "侧前中景自然跟随演员完整动作。"],
    ["mismatched but complete clock", correctedEndingCamera.replace("T00:02.5-00:05", "T00:02.5-00:05.4")
      .replace("T00:05-00:08", "T00:05.4-00:08")],
  ])("rejects the one ending camera repair with %s", async (_label, value) => {
    const fixture = endingCameraScenario();
    fixture.repair.mockResolvedValueOnce({ changes: [{ field: "camera_movement", value, reason: "尝试调整运镜" }] });
    const result = await evaluatePromptPackage(fixture.input);
    expect(fixture.repair).toHaveBeenCalledTimes(1);
    expect(result.g6Eligible).toBe(false);
    expect(result.repairAttempt?.reason).toBe("APPROVED_ENDING_CAMERA_REPAIR_DRIFT");
  });

  it("accepts an ending repair that tracks helmet removal and hair in separate subwindows", async () => {
    const fixture = endingCameraScenario();
    const value = correctedEndingCamera.replace("T00:02.5-00:05 镜头推至胸线中景，跟住抬盔与甩头作轻微横移",
      "T00:02.5-00:03.5 跟住抬盔，镜头推至胸线中景；T00:03.5-00:05 跟住甩头作轻微横移");
    fixture.repair.mockResolvedValueOnce({ changes: [{ field: "camera_movement", value, reason: "分别跟随同一事件中的两个连续动作" }] });
    const result = await evaluatePromptPackage(fixture.input);
    expect(fixture.repair).toHaveBeenCalledTimes(1);
    expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
  });

  const numericEndingCamera = "单一镜头内分三段运镜：0–3秒以齐胸机位固定侧前中景，轻微跟随车辆滑入并停稳，跟移速度递减到底；"
    + "3–5.5秒以极慢且均匀的速度向右横移，保持人物落在右三分线，配合双手抬盔与一次甩发；"
    + "5.5–9.5秒继续同向缓移并轻微升高到略高于台面的视点，跟住转身登台与举杯；最后0.5秒缓停，保留自然微动，不推不拉、不手持抖动。";
  const numericEndingTimeline = "T00:00-T00:03 赛车驶入维修区停车点减速停稳，左脚先落地、右脚随即撑住车身。"
    + "T00:03-T00:06 双手抬盔越过头顶，头略侧转甩发一次，黑色长发从盔内完整落到肩背。"
    + "T00:06-T00:08 跨下车完全站直，把头盔放稳在车座上、空出双手，转身面向领奖台，抬脚连登三级台阶站上最高一级。"
    + "T00:08-T00:10 弯腰用双手取起预置奖杯，直起上身举到胸线上方，随后保留自然微动，不冻结画面。";
  const alignedNumericCamera = numericEndingCamera.replace("3–5.5秒", "3–6秒").replace("5.5–9.5秒", "6–9.5秒");
  const splitNumericCamera = alignedNumericCamera.replace(/3–6秒[^；]+/u, "3–4秒跟住抬盔；4–5.5秒跟住甩发；5.5–6秒稳住机位")
    .replace("最后0.5秒", "9.5–10秒");

  function numericCameraScenario(cameraMovement = numericEndingCamera) {
    return endingCameraScenario({ cameraMovement, timeline: numericEndingTimeline,
      approved: ["赛车减速停稳，双脚落地撑住车身，双手抬盔离开头顶，顺势侧头甩发一次，黑色长发完整落到肩背，再完全下车转身登上领奖台最高一级，自己拿起预置奖杯举起。"] });
  }

  it.each([
    ["aligned event plus relative tail", alignedNumericCamera],
    ["split helmet and hair plus absolute tail", splitNumericCamera],
  ])("links #44 decimal camera timing to the single existing repair with %s", async (_label, value) => {
    const fixture = numericCameraScenario();
    const original = compilePromptPackage(fixture.input)[0]!.contract;
    fixture.repair.mockResolvedValueOnce({ changes: [{ field: "camera_movement", value,
      reason: "保持抬盔甩发，六秒后才随转身登台" }] });
    const result = await evaluatePromptPackage(fixture.input);
    expect(fixture.repair).toHaveBeenCalledTimes(1);
    expect(fixture.review).toHaveBeenCalledTimes(2);
    expect(fixture.repair.mock.calls[0]![0].allowedFields).toEqual(["camera_movement"]);
    expect(fixture.repair.mock.calls[0]![0].findings).toEqual([
      expect.objectContaining({ field: "camera_movement", failureCode: "APPROVED_ENDING_CAMERA_PODIUM_BEFORE_ACTION",
        evidence: expect.stringMatching(/5\.5–9\.5.*3–6.*6–8/u) }),
    ]);
    expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
    expect(result.renderEligible).toBe(false);
    expect(result.shotContracts[0]!.contract.requestSha256).toBe(original.requestSha256);
    expect(result.shotContracts[0]!.source.fields).toHaveProperty("timeline", numericEndingTimeline);
  });

  it.each([
    ["legal subwindows for the same event", splitNumericCamera],
    ["different events", numericEndingCamera.replace("跟住转身登台与举杯", "保持领奖台和背景光影同框")],
    ["negated next-event follow", numericEndingCamera.replace("跟住转身登台", "不跟住转身登台")],
    ["missing relative tail", numericEndingCamera.replace("最后0.5秒", "最后")],
    ["wrong relative tail length", numericEndingCamera.replace("最后0.5秒", "最后0.4秒")],
    ["gapped camera windows", numericEndingCamera.replace("5.5–9.5秒", "5.6–9.5秒")],
    ["overlapping camera windows", numericEndingCamera.replace("5.5–9.5秒", "5.4–9.5秒")],
    ["a duration inserted within another window", numericEndingCamera.replace("；最后0.5秒缓停", "，末尾再用0.5秒缓停")],
  ])("does not infer the scoped early switch from %s", async (_label, value) => {
    const fixture = numericCameraScenario(value);
    expect((await evaluatePromptPackage(fixture.input)).g6Eligible).toBe(true);
    expect(fixture.repair).not.toHaveBeenCalled();
  });

  it.each([
    ["same early switch", numericEndingCamera],
    ["erased linked next event", alignedNumericCamera.replace("跟住转身登台与举杯", "只保留领奖台背景")],
    ["erased local timing", "机位跟住抬盔甩发，然后跟住转身登台。"],
  ])("rejects the single camera repair with %s", async (_label, value) => {
    const fixture = numericCameraScenario();
    fixture.repair.mockResolvedValueOnce({ changes: [{ field: "camera_movement", value, reason: "尝试调整运镜" }] });
    const result = await evaluatePromptPackage(fixture.input);
    expect(fixture.repair).toHaveBeenCalledTimes(1);
    expect(fixture.review).toHaveBeenCalledTimes(1);
    expect(result.g6Eligible).toBe(false);
    expect(result.repairAttempt?.reason).toBe("APPROVED_ENDING_CAMERA_REPAIR_DRIFT");
  });

  it("recognizes actual #39 same-shot 踩上 and 踩 variants before the sole repair", async () => {
    const fixture = scenario({ action: attempt39Action, timeline: attempt39Timeline });
    const result = await evaluatePromptPackage(fixture.input);
    expect(fixture.repair).toHaveBeenCalledTimes(1);
    expect(fixture.repair.mock.calls[0]![0].allowedFields).toEqual(["action", "timeline"]);
    expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
  });

  it.each([
    ["same native helmet finding, unresolved timeline custody", attempt39Timeline.replace("踩最高一级", "迈到台阶最顶层"), {}, ["action", "timeline"]],
    ["same native helmet finding, unusable timeline clock", fixedTimeline.replace("T00:04–T00:05", "T00:04.5–T00:05"), {}, ["action", "timeline"]],
    ["already clocked and securely placed timeline", fixedTimeline, {}, ["action"]],
    ["different native prop finding", attempt39Timeline.replace("踩最高一级", "迈到台阶最顶层"), { helmet: false }, ["action"]],
    ["unbound G4 scene", attempt39Timeline.replace("踩最高一级", "迈到台阶最顶层"), { foreign: true }, ["action"]],
  ] as const)("uses one existing native field repair for %s", async (_label, timeline, override, allowed) => {
    const fixture = nativeScenario(timeline, override);
    const result = await evaluatePromptPackage(fixture.input);
    expect(fixture.calls).toEqual(["review:opening", "review:ending", "repair:ending", "review:ending"]);
    expect(fixture.repairs.map(fields => fields.map(field => field.field))).toEqual([allowed]);
    expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
    expect(result.semanticReports[0]?.proofReuse).toBeDefined();
  });

  it.each([
    ["a visible settled placement", "头盔放稳在领奖台较低的空阶上，空出双手，", true],
    ["no custody before the cup", "", false],
    ["unresolved placements", "头盔放稳在领奖台较低的空阶上或者夹在右臂，", false],
  ])("asks the native repair for same-field custody and checks %s", async (_label, placement, accepted) => {
    const action = "停稳双脚落地，双手向上把头盔脱出，甩头落发，把头盔抱在身侧；跨下车转身登上最高一级，弯腰拿起预置奖杯举到胸前。";
    const originalTimeline = "T00:00–T00:03 停稳，双脚落地。T00:03–T00:06 双手抬起头盔，甩头落发。"
      + "T00:06–T00:09 抱盔跨下车，转身登上最高一级，拿起预置奖杯举到胸前。T00:09–T00:10 自然微动。";
    const fixture = nativeScenario(originalTimeline, { action, cameraRepair: true,
      revisedTimeline: originalTimeline.replace("，拿起预置奖杯", `，${placement}拿起预置奖杯`) });
    const prior = compilePromptPackage(fixture.input)[1]!.contract;
    const result = await evaluatePromptPackage(fixture.input);
    expect(fixture.calls).toEqual(["review:opening", "review:ending", "repair:ending", ...(accepted ? ["review:ending"] : [])]);
    expect(fixture.repairs.map(rows => rows.map(row => row.field))).toEqual([["camera_movement", "timeline"]]);
    const prompt = fixture.repairPrompts[0]!;
    expect(prompt).toContain('本次必须在每个指定字段内补全头盔交接：["timeline"]');
    expect(prompt).toContain("摘盔之后、取杯之前");
    expect(prompt).toContain("头盔放稳在");
    expect(prompt).toContain("左手提着头盔，右手举起奖杯");
    expect(result.g6Eligible, result.repairAttempt?.reason).toBe(accepted);
    expect(result.renderEligible).toBe(false);
    expect(result.repairAttempt?.reason).toBe(accepted ? undefined : "APPROVED_MOTION_HELMET_REPAIR_DRIFT");
    const current = result.shotContracts[1]!.contract;
    const { timeline: _before, ...beforeTechnical } = prior.request.technical;
    const { timeline: _after, ...afterTechnical } = current.request.technical;
    expect({ ...current.request, technical: afterTechnical }).toEqual({ ...prior.request, technical: beforeTechnical });
    expect(result.shotContracts[1]!.source.fields).toHaveProperty("action", action);
  });

  it("does not issue a host custody directive for a native diagnosis alone on an unbound shot", async () => {
    const fixture = nativeScenario(attempt39Timeline, { foreign: true });
    const result = await evaluatePromptPackage(fixture.input);
    expect(result.g6Eligible).toBe(true);
    expect(fixture.repairs.map(rows => rows.map(row => row.field))).toEqual([["action"]]);
    expect(fixture.repairPrompts[0]).not.toContain("本次必须在每个指定字段内补全头盔交接");
  });

  it("cannot open companion authority with only a custom action review", async () => {
    const fixture = scenario({ action: attempt39Action.replace("踩上最高一级", "迈到台阶最顶层"),
      timeline: attempt39Timeline.replace("踩最高一级", "迈到台阶最顶层") });
    const pass = fixture.review.getMockImplementation()!;
    fixture.review.mockImplementationOnce(async context => {
      const result = await pass(context) as { shotId: string; checks: unknown[] };
      result.checks[1] = { id: "SQ2_SCENE_PROPS", field: "action", pass: false,
        failureCode: "PROP_HANDOFF_UNCLEAR", evidence: "把盔收在左臂弯", repair: "明确头盔放置及双手腾出" };
      return result;
    });
    const result = await evaluatePromptPackage(fixture.input);
    expect(fixture.repair.mock.calls[0]![0].allowedFields).toEqual(["action"]);
    expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
  });

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
