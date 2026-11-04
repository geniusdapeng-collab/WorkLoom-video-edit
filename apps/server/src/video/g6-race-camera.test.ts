import { expect, it } from "vitest";
import { approvedRaceCameraChecks } from "./g6-race-camera.js";

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
