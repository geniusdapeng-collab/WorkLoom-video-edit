import { splitShotAssertions } from "@hyperreality/video-studio";
import type { SemanticQualityCheck } from "./prompt-quality-gate.js";

const CAMERA_START = "APPROVED_RACE_CAMERA_START_MISMATCH";
const SECOND_CLEARANCE = "APPROVED_SECOND_RIVAL_CLEARANCE_MISSING";
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

function reachesFinishFromAlongside(value: unknown): boolean {
  const text = productionText(value);
  const alongside = SECOND_IS_ALONGSIDE.exec(text);
  if (!alongside) return false;
  const after = text.slice(alongside.index + alongside[0].length);
  const finish = CHECKERED_FINISH.exec(after);
  return finish !== null && !CLEAR_SECOND.test(after.slice(0, finish.index));
}

export function isApprovedRaceFinding(check: SemanticQualityCheck): boolean {
  return check.failureCode === CAMERA_START || check.failureCode === SECOND_CLEARANCE;
}

/** Apply only when both whole passes, in this order, are explicitly assigned to the current approved cut. */
export function approvedRaceCameraChecks(input: {
  frozenBrief: unknown; purpose: unknown; visualRequirements: readonly unknown[];
  camera: unknown; action: unknown; timeline: unknown;
}): SemanticQualityCheck[] {
  if (!BOTH_RIVALS.test(productionText(input.frozenBrief)) || !FIRST_THEN_SECOND.test(productionText(input.purpose))
    || !input.visualRequirements.some(value => COMPLETE_BOTH.test(productionText(value)))) return [];

  const findings: SemanticQualityCheck[] = [];
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
