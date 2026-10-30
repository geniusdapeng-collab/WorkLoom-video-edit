/** Deterministic effect QC for a rendered bullet-time shot. It never renders or retries. */
import type { BulletTimeContract } from "./bullet-time.js";

export interface BulletTimeEffectEvidence {
  contractHash: string;
  videoSha256: string;
  durationSeconds: number;
  requestedDurationSeconds: number;
  cutCount: number;
  subjectMotionRatio: number;
  cameraParallaxScore: number;
  identityDriftScore: number;
  wardrobeDriftScore: number;
  nonDiegeticMusicDetected: boolean;
  observedLayers?: Partial<Record<"hairTips" | "fabricHem" | "ambientParticles" | "props", number>>;
}

export interface BulletTimeQcCheck {
  id: string;
  pass: boolean;
  detail: string;
}

export interface BulletTimeQcReport {
  schemaVersion: "workloom.video-studio/bullet-time-qc/v1";
  contractHash: string;
  videoSha256: string;
  pass: boolean;
  checks: BulletTimeQcCheck[];
  artisticQuality: "unverified";
  retryRequested: false;
}

const unit = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 1;

export function assessBulletTimeEffect(
  contract: BulletTimeContract,
  contractHash: string,
  evidence: BulletTimeEffectEvidence,
): BulletTimeQcReport {
  const checks: BulletTimeQcCheck[] = [];
  const add = (id: string, pass: boolean, detail: string): void => { checks.push({ id, pass, detail }); };
  add("contract-binding", evidence.contractHash === contractHash && /^[a-f0-9]{64}$/.test(contractHash), "QC evidence is bound to the exact bullet-time contract");
  add("video-binding", /^[a-f0-9]{64}$/.test(evidence.videoSha256), "QC evidence is bound to the current video bytes");
  add("duration", Number.isFinite(evidence.durationSeconds)
    && Math.abs(evidence.durationSeconds - evidence.requestedDurationSeconds) <= Math.max(0.5, evidence.requestedDurationSeconds * 0.1),
  `actual ${evidence.durationSeconds}s vs requested ${evidence.requestedDurationSeconds}s`);
  add("single-shot", evidence.cutCount === contract.camera.cuts, `observed cuts ${evidence.cutCount}`);
  add("subject-near-freeze", unit(evidence.subjectMotionRatio) && evidence.subjectMotionRatio <= 0.22,
    `subject motion ratio ${evidence.subjectMotionRatio}; maximum 0.22`);
  add("camera-parallax", unit(evidence.cameraParallaxScore) && evidence.cameraParallaxScore >= 0.18,
    `camera parallax score ${evidence.cameraParallaxScore}; minimum 0.18`);
  add("identity-stable", unit(evidence.identityDriftScore) && evidence.identityDriftScore <= (contract.quality.mustPreserveIdentity ? 0.12 : 1),
    `identity drift ${evidence.identityDriftScore}`);
  add("wardrobe-stable", unit(evidence.wardrobeDriftScore) && evidence.wardrobeDriftScore <= (contract.quality.mustPreserveWardrobe ? 0.12 : 1),
    `wardrobe drift ${evidence.wardrobeDriftScore}`);
  add("audio-policy", contract.audioPolicy !== "diegetic_only" || !evidence.nonDiegeticMusicDetected,
    evidence.nonDiegeticMusicDetected ? "non-diegetic music detected in generation" : "no non-diegetic music detected");
  if (contract.quality.mustHaveLayerMicroMotion) {
    const measured = Object.values(evidence.observedLayers ?? {}).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    add("declared-micro-motion", measured.length > 0 && measured.some((value) => value > 0),
      measured.length > 0 ? `measured layer motion ${measured.join(",")}` : "no declared secondary motion layer was measured");
  }
  return {
    schemaVersion: "workloom.video-studio/bullet-time-qc/v1",
    contractHash,
    videoSha256: evidence.videoSha256,
    pass: checks.every((item) => item.pass),
    checks,
    artisticQuality: "unverified",
    retryRequested: false,
  };
}
