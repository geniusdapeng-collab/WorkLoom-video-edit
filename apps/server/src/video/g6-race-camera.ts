import { splitShotAssertions } from "@hyperreality/video-studio";
import type { SemanticQualityCheck } from "./prompt-quality-gate.js";
import { completeLocalClock, localWindows } from "./g6-motion-obligations.js";

const CAMERA_START = "APPROVED_RACE_CAMERA_START_MISMATCH";
const SECOND_CLEARANCE = "APPROVED_SECOND_RIVAL_CLEARANCE_MISSING";
const OPENING_DEADLINE = "APPROVED_OPENING_FIRST_PASS_AFTER_DEADLINE";
const SECOND_CAMERA_START = "APPROVED_SECOND_PASS_CAMERA_START_MISMATCH";
const BOTH_RIVALS = /两次超车针对两辆不同对手车[^。；]*；每次从车后到完全领先/u;
const FIRST_THEN_SECOND = /先[^；]{0,22}第一辆对手车[^；]{0,46}；(?:再|随即|随后)[^；]{0,24}第二辆对手车/u;
const COMPLETE_BOTH = /两次超车[^；]{0,12}从(?:对手)?(?:车后|后方)(?:到|至)完全领先/u;
const STARTS_ALONGSIDE_SECOND = /(?:^|；)起幅(?:落在|从|以)第二辆对手车(?:车尾|前轮|车头)与[^；]{0,20}车头齐平(?:的)?并排位置/u;
const SECOND_IS_ALONGSIDE = /(?:贴住|贴着|贴近)第二辆对手车|车头与第二辆对手车(?:车尾|前轮|车头)齐平/u;
const CHECKERED_FINISH = /(?:车头|前轮)(?:先于(?:对手|对方)|先)?(?:压过|越过)(?:黑白)?方格(?:纹)?(?:终点)?线/u;
const CLEAR_SECOND = /(?:^|；|随后|之后|才|并)\s*(?:(?:主车|她|主体)的?)?(?:(?:整车|全车|车尾|车身)(?:已|已经|完整|完全)?(?:越过|超越|超过|脱离|领先于)(?:第二辆(?:对手车)?|对方|对手(?:车)?)|(?:整车|全车|车身)完全领先(?:于)?(?:第二辆(?:对手车)?|对方|对手(?:车)?))/u;

function productionText(value: unknown): string {
  if (typeof value !== "string") return "";
  return splitShotAssertions(value).positive.split("；")
    .filter(clause => !/^(?:目的|意图)\s*(?:是|[:：])/u.test(clause.trim())).join("；");
}

const FIRST_RIVAL = /第一辆(?:虚构)?对手车/u;
const SECOND_RIVAL = /第二辆(?:不同的|虚构)?对手车/u;
const WHOLE_FIRST_CLEARANCE = /(?:整车|全车|车尾)(?:(?:已经|已|从侧面|完整|完全)\s*)*(?:完全领先|越过|超越|超过|脱离)/u;
const FIRST_PASS_LIMIT = /前\s*([1-9一二三四五六七八九])\s*秒(?:之?内)?\s*(?:必须|应当|须)?\s*完成\s*(?:对)?第一辆(?:虚构)?对手车(?:的)?从(?:对手)?(?:车后(?:方)?|后方)(?:到|至)完全领先/u;
const SECOND_APPROVED_FROM_REAR = /第二辆(?:不同的|虚构)?对手车[^；。]{0,16}从(?:对手)?(?:车后(?:方)?|后方)(?:到|至)完全领先/u;
const PAIR_ALIGNED_AT_START = /(?:^|；)起幅(?:贴住|紧贴|落在|从|以|对准|拍到|为)(?:同框的)?两车(?:(?:齐平|并排)的(?:车头|前轮)|(?:车头|前轮)(?:齐平|并排))/u;
const SECOND_REAR_AT_START = /(?:^|；)起幅(?:从|位于|落在|保留|对准|看清|记录|交代)(?:仍在|仍处于|主车在)?第二辆(?:不同的|虚构)?(?:对手)?车(?:的)?(?:后方|车后|车尾|尾流)/u;

export function approvedOpeningFirstPassDeadline(purpose: unknown): number | undefined {
  if (typeof purpose !== "string") return undefined;
  const positive = productionText(purpose.normalize("NFKC").replace(/不(?:必|要求|需要)(?=[^。；]{0,12}前.{1,3}秒)/gu, "禁止"));
  const deadline = FIRST_PASS_LIMIT.exec(positive)?.[1];
  return deadline === undefined ? undefined : /^\d$/u.test(deadline) ? Number(deadline) : "一二三四五六七八九".indexOf(deadline) + 1;
}

function firstPassCompletion(timeline: unknown, duration: number) {
  if (typeof timeline !== "string") return undefined;
  const windows = localWindows(timeline);
  if (!completeLocalClock(windows, duration)) return undefined;
  const matches = windows.filter(window => {
    const text = productionText(window.text);
    return FIRST_RIVAL.test(text) && !SECOND_RIVAL.test(text) && WHOLE_FIRST_CLEARANCE.test(text);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function cameraStart(value: unknown, duration: number | undefined): string {
  if (typeof value !== "string") return "";
  const windows = localWindows(value);
  if (windows.length > 0) {
    return duration !== undefined && completeLocalClock(windows, duration) ? productionText(windows[0]!.text) : "";
  }
  return productionText(value);
}

export function approvedRaceRepairDrift(input: {
  findings: readonly SemanticQualityCheck[]; openingDeadline?: number; duration: number; timeline: unknown; camera: unknown;
}): boolean {
  if (input.findings.some(check => check.failureCode === OPENING_DEADLINE)) {
    const completion = firstPassCompletion(input.timeline, input.duration);
    if (!completion || input.openingDeadline === undefined || completion.to > input.openingDeadline) return true;
  }
  if (input.findings.some(check => check.failureCode === SECOND_CAMERA_START)) {
    const start = cameraStart(input.camera, input.duration);
    return PAIR_ALIGNED_AT_START.test(start) || STARTS_ALONGSIDE_SECOND.test(start) || !SECOND_REAR_AT_START.test(start);
  }
  return false;
}

function reachesFinishFromAlongside(value: unknown): boolean {
  const text = productionText(value);
  const alongside = SECOND_IS_ALONGSIDE.exec(text);
  if (!alongside) return false;
  const after = text.slice(alongside.index + alongside[0].length);
  const finish = CHECKERED_FINISH.exec(after);
  return finish !== null && !CLEAR_SECOND.test(after.slice(0, finish.index));
}

export function isApprovedRaceFinding(check: SemanticQualityCheck): boolean {
  return check.failureCode === CAMERA_START || check.failureCode === SECOND_CLEARANCE
    || check.failureCode === OPENING_DEADLINE || check.failureCode === SECOND_CAMERA_START;
}

/** Scope every finding to the actual current approved cut and its named opponent. */
export function approvedRaceCameraChecks(input: {
  shotId?: string; duration?: number; frozenBrief: unknown; purpose: unknown; visualRequirements: readonly unknown[];
  camera: unknown; action: unknown; timeline: unknown;
}): SemanticQualityCheck[] {
  const findings: SemanticQualityCheck[] = [];
  if (input.shotId === "opening" && input.duration !== undefined) {
    const deadline = approvedOpeningFirstPassDeadline(input.purpose);
    const completion = firstPassCompletion(input.timeline, input.duration);
    if (deadline !== undefined && completion && completion.from > deadline) findings.push({
      id: "SQ3_CAMERA_FEASIBLE", pass: false, field: "timeline", failureCode: OPENING_DEADLINE,
      evidence: `本镜已审要求前 ${deadline} 秒完成第一辆整车超越；时间轴明确把整车完全领先安排在 ${completion.from}–${completion.to} 秒。`,
      repair: `在本镜前 ${deadline} 秒内写清对第一辆从后追近、并排、整车完全领先，之后保持该车在后并衔接下一辆。保留完整连续镜内时钟、总时长和切点。`,
    });
  }
  const bothRivals = BOTH_RIVALS.test(productionText(input.frozenBrief));
  const purpose = productionText(input.purpose);
  if (input.shotId === "scene-1" && bothRivals && SECOND_APPROVED_FROM_REAR.test(purpose)) {
    const start = cameraStart(input.camera, input.duration);
    if (PAIR_ALIGNED_AT_START.test(start) || STARTS_ALONGSIDE_SECOND.test(start)) findings.push({
      id: "SQ3_CAMERA_FEASIBLE", pass: false, field: "camera_movement", failureCode: SECOND_CAMERA_START,
      evidence: "本镜当前已审第二辆超车从车后开始；运镜却把同一对手与主车的齐平位置写作起幅。",
      repair: "明确起幅从第二辆对手车后方跟随，随后才见并排、整车越过和冲线，保持本镜总时长、方向和切点。",
    });
  }
  if (!bothRivals || !FIRST_THEN_SECOND.test(purpose)
    || !input.visualRequirements.some(value => COMPLETE_BOTH.test(productionText(value)))) return findings;

  if (STARTS_ALONGSIDE_SECOND.test(productionText(input.camera))) findings.push({
    id: "SQ3_CAMERA_FEASIBLE", pass: false, field: "camera_movement", failureCode: CAMERA_START,
    evidence: "运镜明确从与第二辆对手齐平并排的位置起幅，本镜已审的先从第一辆车后完成第一超车无从在起幅接续。",
    repair: "在本镜原时长与切点内，起幅对准第一辆对手车后方的当前车位，跟随第一、第二次完整超越，和动作及时间轴对齐；保持同方向。",
  });
  for (const [field, id] of [["action", "SQ1_SUBJECT_ACTION"], ["timeline", "SQ2_SCENE_PROPS"]] as const) {
    if (reachesFinishFromAlongside(input[field])) findings.push({
      id, pass: false, field, failureCode: SECOND_CLEARANCE,
      evidence: "本字段从贴住或齐平第二辆直接写到方格线冲线，未呈现整车越过同一辆对手的可见状态。",
      repair: "在原区间依次写清第一辆完整超越后保持在后、同一第二辆从后追近并排后整车越过，再先压终点线后减速；运镜与时间轴使用同一可见顺序。",
    });
  }
  return findings;
}
