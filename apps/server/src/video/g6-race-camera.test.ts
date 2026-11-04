import { expect, it, vi } from "vitest";
import { approvedRaceCameraChecks } from "./g6-race-camera.js";
import { compilePromptPackage, evaluatePromptPackage, SEMANTIC_QUALITY_CHECK_IDS, type SemanticQualityReviewer } from "./prompt-quality-gate.js";
import type { PromptCompileOptions } from "@hyperreality/video-studio";

const frozenBrief = "两次超车针对两辆不同对手车，每次从车后到完全领先，第一辆已超车继续在后。两次可集中或跨切。";
const purpose = "先把第一辆对手车压到身后并让它继续留在后视方向，再在最后一弯内侧贴着第二辆对手车完成第二次超车，随后冲线。";
const visualRequirements = ["两次超车均完整看清从对手后方到完全领先，已被超越车辆保持在后"];
const badCamera = "长焦保持同向。起幅落在第二辆对手车车尾与主角车头齐平的并排位置，落幅车身回正。";
const goodCamera = "起幅从第一辆对手车后轮开始，随主车同向跟拍；第二辆对手留在远景。";
const first = "先从第一辆对手车后方追近并排，整车越过第一辆对手车，第一辆保持在后。";
const second = "在最后一弯内侧贴住第二辆对手车，车头越过其中段形成并排。";
const clearance = "随后主车车尾完全越过第二辆对手车前轮。";
const finish = "车头先于对方越过黑白方格线，之后收油减速。";

it("diagnoses the explicit wrong start and missing second clearance independently in their own fields", () => {
  const findings = approvedRaceCameraChecks({ frozenBrief, purpose, visualRequirements, camera: badCamera,
    action: first + second + finish,
    timeline: `T00:00–T00:04：${first} T00:04–T00:07：${second} T00:07–T00:10：${finish}` });
  expect(findings.map(({ field, failureCode }) => [field, failureCode])).toEqual([
    ["camera_movement", "APPROVED_RACE_CAMERA_START_MISMATCH"],
    ["action", "APPROVED_SECOND_RIVAL_CLEARANCE_MISSING"],
    ["timeline", "APPROVED_SECOND_RIVAL_CLEARANCE_MISSING"],
  ]);
});

it("keeps the companion field read-only when it already shows the second rider clear", () => {
  const findings = approvedRaceCameraChecks({ frozenBrief, purpose, visualRequirements, camera: goodCamera,
    action: first + second + clearance + finish,
    timeline: `T00:00–T00:04：${first} T00:04–T00:07：${second} T00:07–T00:10：${finish}` });
  expect(findings.map(({ field }) => field)).toEqual(["timeline"]);
});

it("permits camera windows that differ from action windows when the same ordered beats are shown", () => {
  expect(approvedRaceCameraChecks({ frozenBrief, purpose, visualRequirements,
    camera: `T00:00–T00:03：${goodCamera} T00:03–T00:10：同方向继续侧跟至过线。`,
    action: first + second + clearance + finish,
    timeline: `T00:00–T00:04：${first} T00:04–T00:07：${second} T00:07–T00:08：${clearance} T00:08–T00:10：${finish}`,
  })).toEqual([]);
});

it("does not let the first rider's whole clearance or a planning note substitute for the second rider's clearance", () => {
  const findings = approvedRaceCameraChecks({ frozenBrief, purpose, visualRequirements, camera: goodCamera,
    action: second + "主车车尾完全越过第一辆对手车前轮。" + finish,
    timeline: second + "目的是让主车车尾完全越过第二辆对手车前轮。" + finish });
  expect(findings.map(({ field }) => field)).toEqual(["action", "timeline"]);
});

it.each([
  { frozenBrief: "两车同向冲线。", action: second + finish },
  { purpose: "第二辆对手车在本镜完成超越后冲线。", action: second + finish },
  { visualRequirements: ["记录两辆对手冲线的顺序。"], action: second + finish },
  { camera: goodCamera, action: finish },
])("leaves unrelated scope and an ordinary front-wheel finish alone", override => {
  expect(approvedRaceCameraChecks({ frozenBrief, purpose, visualRequirements, camera: badCamera,
    timeline: finish, ...override })).toEqual([]);
});

const openingPurpose = "第一帧已在虚构封闭赛道高速追击，前三秒内完成第一辆对手车从车后到完全领先的超车。";
const openingBrief = "第一帧直接高速追击。前两段共同完成两次清楚超车再冲线，不预设每段各几次。";
const openingTimeline = "T00:00–T00:02 从车尾右后侧贴上。T00:02–T00:04 车头推到前车后轮齐平。"
  + "T00:04–T00:07 车身沿边线继续送出，画面进入两车并排。T00:07–T00:09 整车从侧面完全领先，被超掉的第一辆对手车被甩到画面后方。"
  + "T00:09–T00:10 落幅保留前方第二辆车。";
const correctedOpeningTimeline = "T00:00–T00:03 主车从第一辆对手车后方追近并排，整车从侧面完全领先，被超掉的第一辆对手车继续留在后方。"
  + "T00:03–T00:10 同向追向第二辆车。";
const openingShape = { shotId: "opening", duration: 10, frozenBrief: openingBrief, purpose: openingPurpose,
  visualRequirements: ["第一辆对手车从车后到完全领先的并排瞬间在段内完成，车位与前进方向不跳变。"],
  camera: "起幅从第一辆对手车后方跟拍。", action: "整车越过第一辆对手车。", timeline: openingTimeline };

const middlePurpose = "李英子在弯心内侧对第二辆对手车完成从车后到完全领先的超车，随即先于对手压过方格旗对应的终点线，再收油减速。";
const actualMiddleCamera = "缓慢推近，速度均匀偏慢，起幅贴住两车齐平的车头并保留半个车身环境，随着倾倒角度加大持续向车头接触点推进。";
const middleTimeline = "T00:00–T00:02：起幅贴住两车齐平的车头。T00:02–T00:05：车头一点点探出。"
  + "T00:05–T00:08：车头拉开半个车身，前轮先压过黑白方格纹。T00:08–T00:10：轻收油门。";
const revisedMiddleTimeline = "T00:00–T00:02：从第二辆对手车后方起幅。T00:02–T00:05：由并排推进到完全领先。"
  + "T00:05–T00:08：主车车尾越过第二辆对手车前轮，前轮先压过方格线。T00:08–T00:10：轻收油门，第一辆对手车继续留在后方。";
const middleShape = { ...openingShape, shotId: "scene-1", purpose: middlePurpose, frozenBrief,
  visualRequirements: ["弯心内侧轮对轮近景，两车车头几乎齐平后拉开差距，方格纹路面涂装作为压线唯一参照。"],
  camera: actualMiddleCamera, action: "贴住第二辆对手车的侧面，车头拉开半个车身。", timeline: middleTimeline };
const revisedMiddleCamera = "保持同向，起幅从第二辆对手车后方跟随，随后才拍两车齐平的过程。";

it("recognizes first whole clearance at 7–9 against the current approved opening maximum of three seconds", () => {
  expect(approvedRaceCameraChecks(openingShape)).toEqual([
    expect.objectContaining({ field: "timeline", failureCode: "APPROVED_OPENING_FIRST_PASS_AFTER_DEADLINE",
      evidence: expect.stringMatching(/3.*7–9/u) }),
  ]);
});

it.each([
  ["no authorized deadline", { purpose: openingPurpose.replace("前三秒内", "") }],
  ["only a hook deadline", { purpose: "前三秒内抓眼。完成第一辆对手车从车后到完全领先的超车。" }],
  ["negated opening deadline", { purpose: "不要求在前三秒内完成第一辆对手车从车后到完全领先的超车。" }],
  ["different approved deadline", { purpose: openingPurpose.replace("前三秒内", "前9秒内") }],
  ["different shot", { shotId: "ending" }],
  ["qualifying same-action subwindow", { timeline: correctedOpeningTimeline }],
  ["partial or unlabeled completion", { timeline: openingTimeline.replace("整车从侧面完全领先", "车头从侧面先过") }],
  ["no affirmative first-rival event", { timeline: openingTimeline.replace("整车从侧面完全领先", "不得整车从侧面完全领先") }],
  ["malformed local clock", { timeline: openingTimeline.replace("T00:04–T00:07", "T00:05–T00:07") }],
  ["second rival only", { timeline: openingTimeline.replace("第一辆对手车", "第二辆对手车") }],
])("does not invent or transfer an opening deadline with %s", (_label, change) => {
  expect(approvedRaceCameraChecks({ ...openingShape, ...change })).toEqual([]);
});

it("recognizes the middle start mismatch from the approved plan before and after a timeline-only repair", () => {
  for (const timeline of [middleTimeline, revisedMiddleTimeline]) {
    expect(approvedRaceCameraChecks({ ...middleShape, timeline })).toEqual([
      expect.objectContaining({ field: "camera_movement", failureCode: "APPROVED_SECOND_PASS_CAMERA_START_MISMATCH" }),
    ]);
  }
});

it.each([
  { camera: revisedMiddleCamera },
  { camera: "起幅不要贴住两车齐平的车头，保留后方车位。" },
  { camera: "T00:00–T00:02 后方机位保留前车距离。T00:02–T00:06 起幅贴住两车齐平的车头。T00:06–T00:10 同向跟随。" },
  { camera: "T00:00–T00:03 起幅贴住两车齐平的车头。T00:04–T00:10 同向跟随。" },
  { purpose: "两辆虚构车保持并排，记录冲线。" },
  { frozenBrief: "两车同向冲线。" },
])("keeps the middle camera read-only for an unrelated or later event", override => {
  expect(approvedRaceCameraChecks({ ...middleShape, ...override })).toEqual([]);
});

const compile: PromptCompileOptions = {
  delivery: { aspectRatio: "9:16", resolution: "1080p", fps: 30, format: "mp4", generateAudio: true },
  model: { modelId: "fixture", provider: "seedance", providerModel: "fixture", version: "fixture",
    modes: ["r2v"], durationSec: { min: 4, max: 15 }, aspectRatios: ["9:16"], resolutions: ["1080p"],
    maxReferenceImages: 2, maxPromptChars: 4000 },
  assets: [{ field: "portraits", role: "reference_image", sha256: "a".repeat(64), bytes: 1, mediaType: "image/png", sourceRef: "portrait.png" }],
};

function packageFixture(shape: typeof openingShape, { foreign = false, reviseTimeline = true }: { foreign?: boolean; reviseTimeline?: boolean } = {}) {
  const { shotId, duration, frozenBrief: brief, purpose, visualRequirements, camera, action, timeline } = shape;
  const fields = { director_instruction: "商业广告，封闭赛道。", constraint: "9:16画幅，1080x1920，30fps，MP4格式。",
    baseline: "保持写实。", scene: "虚构封闭赛道弯道。", lighting: "冷白侧光。", camera_movement: camera,
    character: "穿全覆赛车服的赛车手。", action, portraits: "image://portrait.png", dialogue: "无台词。",
    negative: "无文字和商标。", consistency: "同一角色同一全覆服装。", composition: "两车同框。",
    color_palette: "冷白赛道。", depth_of_field: "两车车位清晰。", timeline, mood: "冷酷克制。",
    bright_constraint: "全盔轮廓清楚。", character_constraint: "同一赛车手。", costume: "全覆防护服。",
    props: "两辆虚构对手车。", pacing: "动作连贯。", audio: "原生轮胎声。", makeup: "自然妆面。", transition: "零秒硬切。",
  };
  const startSec = shotId === "opening" ? 0 : 10;
  const upstreamContext = { approvedProductionPlan: { g4ArtifactSha256: "b".repeat(64), requirementContractHash: "c".repeat(64),
    scenes: [{ shotId, sceneId: foreign ? "foreign" : shotId, interval: { startSec, endSec: startSec + duration, brief },
      approvedScene: { purpose, actions: [{ actorId: "lead", description: purpose }] }, verificationPlan: { visualRequirements } }] } };
  const review = vi.fn<SemanticQualityReviewer["review"]>(async ({ shot }) => {
    const current = shot.fields as typeof fields;
    return { shotId, checks: SEMANTIC_QUALITY_CHECK_IDS.map(id => {
      const field = id === "SQ3_CAMERA_FEASIBLE" ? "camera_movement" : id === "SQ4_LIGHT_COLOR" ? "lighting" : "scene";
      if (reviseTimeline && shotId === "scene-1" && id === "SQ2_SCENE_PROPS" && current.timeline === timeline) {
        return { id, pass: false, field: "timeline", evidence: timeline, failureCode: "TIMELINE_STARTS_LEVEL", repair: "从第二辆后方起幅。" };
      }
      return { id, pass: true, field, evidence: current[field] };
    }) };
  });
  const repair = vi.fn<NonNullable<SemanticQualityReviewer["repair"]>>();
  return { review, repair, input: { projectId: "P", runId: "R", stageRunId: "S", mode: "enforce" as const,
    revision: 1, maxFinalPromptChars: 3000, upstreamContext, reviewer: { review, repair },
    shots: [{ source: { shotId, duration, fields, portraits: fields.portraits }, compile }] } };
}

it.each([openingShape, middleShape])("uses a single current-shot repair and retains immutable request channels for $shotId", async shape => {
  const fixture = packageFixture(shape.shotId === "scene-1" ? { ...shape,
    action: "从第二辆对手车后方追近并排，主车车尾完整越过第二辆对手车前轮，前轮先压过黑白方格线，之后收油减速，第一辆对手车继续留在后方。",
  } : shape);
  const original = compilePromptPackage(fixture.input)[0]!.contract;
  const changes = [{ field: "timeline", value: shape.shotId === "opening" ? correctedOpeningTimeline : revisedMiddleTimeline, reason: "按已审时序修复" }];
  if (shape.shotId === "scene-1") changes.push({ field: "camera_movement", value: revisedMiddleCamera, reason: "起幅位于同一对手后方" });
  fixture.repair.mockResolvedValue({ changes });
  const result = await evaluatePromptPackage(fixture.input);
  expect(fixture.repair).toHaveBeenCalledTimes(1);
  expect(fixture.repair.mock.calls[0]![0].allowedFields).toEqual(changes.map(row => row.field));
  expect(fixture.review).toHaveBeenCalledTimes(2);
  expect(result.g6Eligible, result.repairAttempt?.reason).toBe(true);
  expect(result.renderEligible).toBe(false);
  const current = result.shotContracts[0]!.contract;
  expect(current.request).toEqual({ ...original.request, technical: { ...original.request.technical, timeline: changes[0]!.value } });
});

it.each([
  [openingShape, "timeline", "T00:00–T00:10 侧跟两辆虚构对手，保持方向。"],
  [openingShape, "timeline", "T00:00–T00:04 整车从侧面完全领先，被超掉的第一辆对手车在后。T00:04–T00:10 继续追击。"],
  [middleShape, "camera_movement", "长焦保持同向缓慢推近。"],
  [middleShape, "camera_movement", actualMiddleCamera],
] as const)("rejects a repair that drops the scoped positive proof on $shotId", async (shape, field, value) => {
  const fixture = packageFixture(shape, { reviseTimeline: false });
  fixture.repair.mockResolvedValue({ changes: [{ field, value, reason: "尝试修复" }] });
  const result = await evaluatePromptPackage(fixture.input);
  expect(fixture.repair).toHaveBeenCalledTimes(1);
  expect(fixture.review).toHaveBeenCalledTimes(1);
  expect(result.g6Eligible).toBe(false);
  expect(result.repairAttempt?.reason).toBe("APPROVED_RACE_REPAIR_DRIFT");
});

it("does not add a repair field from a foreign G4 scene", async () => {
  const fixture = packageFixture(openingShape, { foreign: true });
  expect((await evaluatePromptPackage(fixture.input)).g6Eligible).toBe(true);
  expect(fixture.repair).not.toHaveBeenCalled();
});

const middleFinish = "黑白方格纹进入画面下方，前轮先压过涂装，推进几乎不松。";
const halfNose = "车头拉开半个车身。";
const partialMiddleAction = "李英子起初仍在第二辆对手车正后方，压住车尾贴住其尾流，随后从车侧探出、贴住对手车身完成侧向超越；她继续在弯心内侧压低上身贴住油箱，双膝夹紧车体，护膝擦过路缘，前轮咬住弯心内侧白线边缘，手腕稳住油门、车身扶正抢先出弯，车头拉开半个车身，直冲黑白方格纹并让前轮先压过涂装，最后轻收油门，车身由倾倒回正、速度自然收住。";
const partialMiddleTimeline = "T00:00–T00:02：从第二辆对手车后方起幅，先交代车后车位差；李英子贴住其尾流，镜头缓慢推近。"
  + "T00:02–T00:05：她从车侧探出，倾倒角度压到极限，双膝夹紧油箱，前轮咬住弯心内侧白线边缘，由并排推进到完全领先。"
  + `T00:05–T00:08：车身扶正抢先出弯，${halfNose}${middleFinish}T00:08–T00:10：轻收油门，落幅保持向右前方滑行。`;
const secondGapShape = { ...middleShape, camera: revisedMiddleCamera, action: partialMiddleAction, timeline: partialMiddleTimeline };
const secondClearance = "随后主车车尾完整越过第二辆对手车前轮。";
const fixedGapAction = partialMiddleAction.replace("车头拉开半个车身，", secondClearance + halfNose) + "第一辆对手车继续留在后方。";
const fixedGapTimeline = partialMiddleTimeline.replace(halfNose, secondClearance + halfNose) + "第一辆对手车继续留在后方。";

it("scopes the actual #46 partial second clearance to the two independently proved fields", () => {
  expect(approvedRaceCameraChecks(secondGapShape).map(({ field, failureCode }) => [field, failureCode])).toEqual([
    ["action", "APPROVED_SECOND_PASS_FINISH_BEFORE_WHOLE_CLEARANCE"],
    ["timeline", "APPROVED_SECOND_PASS_FINISH_BEFORE_WHOLE_CLEARANCE"],
  ]);
});

it("allows a later partial nose gap when the whole second clearance was already visible", () => {
  expect(approvedRaceCameraChecks({ ...secondGapShape, action: fixedGapAction, timeline: fixedGapTimeline })).toEqual([]);
});

it.each([
  partialMiddleAction.replace("第二辆对手车", "第一辆对手车"),
  partialMiddleAction.replace("车头拉开半个车身", "两车均持续前进"),
  partialMiddleAction.replace("黑白方格纹并让前轮先压过涂装", "直道远处"),
])("leaves a different rival, ordinary crossing, or generic nose gap alone", action => {
  expect(approvedRaceCameraChecks({ ...secondGapShape, action, timeline: fixedGapTimeline })).toEqual([]);
});

it.each([
  secondClearance.replace("第二辆", "第一辆"),
  secondClearance.replace("完整越过", "未完整越过"),
  "目的是让主车车尾完整越过第二辆对手车前轮。",
])("does not borrow non-executed or different-rival clearance", prefix => {
  const action = partialMiddleAction.replace("车头拉开半个车身，", prefix + halfNose);
  expect(approvedRaceCameraChecks({ ...secondGapShape, action, timeline: fixedGapTimeline })).toEqual([
    expect.objectContaining({ field: "action", failureCode: "APPROVED_SECOND_PASS_FINISH_BEFORE_WHOLE_CLEARANCE" }),
  ]);
});

it("uses the existing repair for both diagnosed fields and rejects an erased finish before review", async () => {
  for (const reject of [false, true]) {
    const fixture = packageFixture(secondGapShape, { reviseTimeline: false });
    fixture.repair.mockResolvedValue({ changes: [
      { field: "action", value: reject ? "同向驶入下一段。" : fixedGapAction, reason: "写明第二辆整车超越" },
      { field: "timeline", value: fixedGapTimeline, reason: "同场同一对手，整车越过后再压线" },
    ] });
    const result = await evaluatePromptPackage(fixture.input);
    expect(fixture.repair).toHaveBeenCalledTimes(1);
    expect(fixture.repair.mock.calls[0]![0].allowedFields).toEqual(["action", "timeline"]);
    expect(fixture.review).toHaveBeenCalledTimes(reject ? 1 : 2);
    expect(result.g6Eligible).toBe(!reject);
    expect(result.renderEligible).toBe(false);
    if (reject) expect(result.repairAttempt?.reason).toBe("APPROVED_RACE_REPAIR_DRIFT");
  }
});

it("keeps an earlier first-rival pronoun out of the later second clearance", () => {
  const action = "先追近第一辆对手车，主车车尾完整越过该对手车。" + partialMiddleAction;
  expect(approvedRaceCameraChecks({ ...secondGapShape, action, timeline: fixedGapTimeline })).toEqual([
    expect.objectContaining({ field: "action", failureCode: "APPROVED_SECOND_PASS_FINISH_BEFORE_WHOLE_CLEARANCE" }),
  ]);
});
