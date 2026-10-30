import { describe, expect, it } from "vitest";
import { assessBulletTimeEffect, type BulletTimeEffectEvidence } from "./bullet-time-qc.js";
import type { BulletTimeContract } from "./bullet-time.js";

const hash = (char: string) => char.repeat(64);
const contract: BulletTimeContract = {
  schemaVersion: "workloom.video-studio/bullet-time/v1",
  enabled: true,
  mode: "freeze_orbit",
  narrative: { purpose: "choice", whyNotNormalCut: "space reveal", viewerTakeaway: "decision" },
  time: {
    subjectTime: "near_freeze",
    subjectTimeRange: { start: 0.8, end: 3.5 },
    entrySeconds: 0.8,
    exitSeconds: 0.5,
    timeReturn: "smooth",
    motionLayers: { face: "locked", body: "locked", hairTips: "very_slow", fabricHem: "very_slow", background: "locked", ambientParticles: "not_applicable" },
  },
  camera: { movement: "continuous_orbit", direction: "clockwise", startView: "right front", endView: "left profile", approxArcDegrees: 100, height: "chest", speed: "slow_constant", cuts: 0, focusBehavior: "face readable", narrativeReveal: "face to profile" },
  generation: { inputMode: "reference-image", durationSeconds: 5, maxContinuousOrbit: 120, characterReferenceSet: ["front", "side", "threeQuarter", "actionPose"], previsReference: { requested: false, purpose: "camera_and_timing_only" } },
  entryExit: { entryAction: "step entry", exitAction: "step exit", exitMustMatchNextShot: false },
  quality: { mustBePhotoreal: true, mustPreserveIdentity: true, mustPreserveWardrobe: true, mustPreservePropState: true, mustHaveRealParallax: true, mustHaveSubjectNearFreeze: true, mustHaveLayerMicroMotion: true, mustNotContainBgm: true },
  audioPolicy: "diegetic_only",
  fallback: { ifNoContinuousOrbit: "guided_orbit", ifNoModelSupport: "editorial_fake", mustRelabelInUi: true },
};
const evidence = (): BulletTimeEffectEvidence => ({
  contractHash: hash("a"), videoSha256: hash("b"), durationSeconds: 5.02, requestedDurationSeconds: 5,
  cutCount: 0, subjectMotionRatio: 0.08, cameraParallaxScore: 0.4, identityDriftScore: 0.04,
  wardrobeDriftScore: 0.03, nonDiegeticMusicDetected: false, observedLayers: { hairTips: 0.05, fabricHem: 0.04 },
});

describe("bullet-time effect QC", () => {
  it("requires subject low motion, camera parallax, identity and audio evidence", () => {
    const report = assessBulletTimeEffect(contract, hash("a"), evidence());
    expect(report.pass).toBe(true);
    expect(report.artisticQuality).toBe("unverified");
    expect(report.retryRequested).toBe(false);
    expect(report.checks.map((check) => check.id)).toEqual(expect.arrayContaining(["single-shot", "subject-near-freeze", "camera-parallax", "declared-micro-motion"]));
  });

  it.each([
    ["static screenshot", { cameraParallaxScore: 0.01 }],
    ["full-body motion", { subjectMotionRatio: 0.6 }],
    ["wrong identity", { identityDriftScore: 0.4 }],
    ["BGM", { nonDiegeticMusicDetected: true }],
    ["cut", { cutCount: 1 }],
    ["missing micro motion", { observedLayers: {} }],
  ])("fails %s without requesting a paid retry", (_name, patch) => {
    const report = assessBulletTimeEffect(contract, hash("a"), { ...evidence(), ...patch });
    expect(report.pass).toBe(false);
    expect(report.retryRequested).toBe(false);
  });

  it("rejects evidence not bound to the exact contract", () => {
    const report = assessBulletTimeEffect(contract, hash("a"), { ...evidence(), contractHash: hash("c") });
    expect(report.pass).toBe(false);
    expect(report.checks[0]).toMatchObject({ id: "contract-binding", pass: false });
  });
});
