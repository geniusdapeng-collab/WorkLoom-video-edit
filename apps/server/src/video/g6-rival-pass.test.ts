import { describe, expect, it } from "vitest";
import { approvedSecondPassEndsHalfway } from "./g6-rival-pass.js";

const frozenBrief = "两次超车针对两辆不同对手车，每次从车后到完全领先。两次可集中或跨切。";
const purpose = "对第二辆不同对手车完成第二次清楚超越：从车后到完全领先，然后先于对手压过终点线。";
const visualRequirements = ["第二辆对手车在最后一弯被贴身抢线，从后方到完全领先全过程可见；第一辆已超越车保持在后。"];
const behind = "她从第二辆对手车后方追近，第一辆对手车继续留在后方。";
const alongside = "第二辆对手车在左侧并行，车身由并排向前推进半个车身，车头先出。";
const clear = "随后主车车尾完全越过第二辆对手车前轮。";
const finish = "前轮先于对手压过黑白格纹终点线，再收油减速。";

describe("current G4 second-rival completion", () => {
  it.each([
    ["already alongside then half a bike to the finish", alongside + finish, true],
    ["starts behind but clears only half a bike", behind + alongside + finish, true],
    ["entire bike later clears but behind start was skipped", alongside + clear + finish, true],
    ["complete pass after the half-bike intermediate stage", behind + alongside + clear + finish, false],
    ["completion in a later timed window", `T00:00–T00:02：${behind} T00:02–T00:05：${alongside} T00:05–T00:07：${clear} T00:07–T00:10：${finish}`, false],
    ["timeline names the second rival in the previous window", `T00:00–T00:03：第二辆对手车在左侧并行。 T00:03–T00:06：车身由并排向前推进半个车身。 T00:06–T00:10：${finish}`, true],
    ["another rival's clearance cannot satisfy the second", behind + alongside + "随后主车车尾完全越过第一辆对手车前轮。" + finish, true],
    ["ordinary front-wheel finish", finish, false],
    ["half-bike movement without crossing the line", alongside + "格纹终点线进入画面下缘。", false],
    ["half-bike movement on a different named rival", "第二辆对手车离开画面。第一辆对手车和主车由并排向前推进半个车身。" + finish, false],
    ["camera purpose cannot establish clearance", behind + alongside + "目的是让主车车尾完全越过第二辆对手车前轮。" + finish, true],
    ["opponent in protagonist's place cannot establish clearance", behind + alongside + "第一辆对手车的车尾完全越过第二辆对手车前轮。" + finish, true],
  ] as const)("%s", (_name, fieldValue, expected) => {
    expect(approvedSecondPassEndsHalfway({ frozenBrief, purpose, visualRequirements, fieldValue })).toBe(expected);
  });

  it.each([
    { frozenBrief: "普通赛道冲线。" },
    { purpose: "第一辆对手车从车后到完全领先后先压过终点线。" },
    { visualRequirements: ["第二辆对手车在弯中从后方到完全领先全过程可见。"] },
    { visualRequirements: ["第一辆对手车从后方到完全领先，第一辆已超越车保持在后。"] },
  ])("does not turn an unbound half-bike description into a finding", override => {
    expect(approvedSecondPassEndsHalfway({ frozenBrief, purpose, visualRequirements, fieldValue: alongside + finish, ...override })).toBe(false);
  });
});
