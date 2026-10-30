import { describe, expect, it } from "vitest";
import { assessFilmFirstPass, assessShotFirstPass, FIRST_PASS_POLICY_VERSION } from "./first-pass.js";

const bulletTime = {
  schemaVersion: "workloom.video-studio/bullet-time/v1",
  enabled: true,
  mode: "freeze_orbit",
  narrative: { purpose: "decision", whyNotNormalCut: "space reveal", viewerTakeaway: "she decides" },
  time: {
    subjectTime: "near_freeze", subjectTimeRange: { start: 0.7, end: 3.5 }, entrySeconds: 0.7, exitSeconds: 0.5, timeReturn: "smooth",
    motionLayers: { face: "locked", body: "locked", hairTips: "very_slow", fabricHem: "very_slow", background: "locked", ambientParticles: "not_applicable" },
  },
  camera: { movement: "continuous_orbit", direction: "clockwise", startView: "right front", endView: "left profile", approxArcDegrees: 100, height: "chest", speed: "slow_constant", cuts: 0, focusBehavior: "face sharp", narrativeReveal: "face to profile" },
  generation: { inputMode: "reference-image", durationSeconds: 5, maxContinuousOrbit: 120, characterReferenceSet: ["actionPose", "front", "threeQuarter", "side"], previsReference: { requested: false, purpose: "camera_and_timing_only" } },
  entryExit: { entryAction: "right foot lands", exitAction: "continue forward", exitMustMatchNextShot: false },
  quality: { mustBePhotoreal: true, mustPreserveIdentity: true, mustPreserveWardrobe: true, mustPreservePropState: true, mustHaveRealParallax: true, mustHaveSubjectNearFreeze: true, mustHaveLayerMicroMotion: true, mustNotContainBgm: true },
  audioPolicy: "diegetic_only",
  fallback: { ifNoContinuousOrbit: "guided_orbit", ifNoModelSupport: "editorial_fake", mustRelabelInUi: true },
};

describe("一次过就绪度（花钱前判定）", () => {
  it("画面里让模型'别写字'的镜头判高风险，并给出移出画面的建议", () => {
    const r = assessShotFirstPass({ shotId: "S1", sceneDescription: "机器触控面亮着界面", props: "身份证放到感应区", negative: "无文字水印" });
    expect(r.blockers.map((b) => b.id)).toEqual(expect.arrayContaining(["text-in-frame:screen", "text-in-frame:document"]));
    expect(r.suggestions.join()).toContain("移出取景");
  });
  it("已把风险物移出画面/虚化 → 不算阻塞", () => {
    const r = assessShotFirstPass({ shotId: "S2", sceneDescription: "只拍机身背面与取卡口，画面内不出现屏幕" , props: "房卡", negative: "无多余手指" });
    expect(r.blockers).toEqual([]);
  });
  it("秒级'定住'与推镜并存 → 高风险（模型做不到）", () => {
    const r = assessShotFirstPass({ shotId: "S3", timeline: "T00:02.5–T00:06 完全定住", camera_movement: "缓推后定住" });
    expect(r.blockers.map((b) => b.id)).toContain("timing-lock-vs-motion");
  });
  it("合法 bulletTime 区分主体时间与摄影机时间，不误判为普通定格冲突", () => {
    const r = assessShotFirstPass({ shotId: "BT", duration: 5, timeline: "0.7-3.5秒主体近冻结", camera_movement: "摄影机持续环绕", bulletTime });
    expect(r.blockers).toEqual([]);
    expect(r.findings.map((finding) => finding.id)).toContain("bullet-time-temporal-exception");
  });
  it("标签存在但合同不完整仍 fail-closed", () => {
    const r = assessShotFirstPass({ shotId: "BT", duration: 5, timeline: "主体定住", camera_movement: "环绕", bulletTime: { enabled: true, mode: "freeze_orbit" } });
    expect(r.blockers.map((blocker) => blocker.id)).toContain("bullet-time-contract-invalid");
  });
  it("客户的造型意图（面料/配饰）与同镜多诉求只作提示，不再当风险打分", () => {
    const r = assessShotFirstPass({ shotId: "S4", costume: "黑色粗花呢套装配珍珠耳饰及膝裙", composition: "广角全景，人物中近景占比并保持视觉主导，机身清晰可辨" });
    const ids = r.findings.map((f) => f.id);
    expect(ids).toContain("costume-design-intent");
    expect(ids).toContain("competing-subjects");
    expect(r.findings.filter((f) => f.level !== "low")).toEqual([]);   // 不进分数
    expect(r.blockers).toEqual([]);
    expect(r.ready).toBe(true);                                        // 不因创作意图被拦
  });
  it("整片：给 canary 渲染顺序（风险高的先渲），policy 版本可追溯", () => {
    const film = assessFilmFirstPass([
      { shotId: "S1", camera_movement: "固定机位", timeline: "T00:00–T00:05 稳定", composition: "中景" },
      { shotId: "S2", sceneDescription: "屏幕界面清晰可见", timeline: "T00:02 定住", camera_movement: "缓推" }
    ], { fps: 24 });
    expect(film.policy).toBe(FIRST_PASS_POLICY_VERSION);
    expect(film.ready).toBe(false);
    expect(film.renderOrder[0]).toBe("S2");
  });
});
