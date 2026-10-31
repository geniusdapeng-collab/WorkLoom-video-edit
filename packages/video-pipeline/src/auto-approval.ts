import {
  evaluateSystemAutoApproval,
  type SystemAutoApprovalEvidence,
  type SystemAutoApprovalPolicy,
} from "@workloom/pipeline-control";

export const VIDEO_SYSTEM_AUTO_APPROVAL_POLICY: SystemAutoApprovalPolicy = Object.freeze({
  schemaVersion: "workloom.system-auto-approval-policy/v1",
  id: "video-system-auto-approval",
  version: "2026-10-31.1",
  checkSetVersion: "video-system-auto-approval/checks/v1",
  gates: new Set([
    "G1_DOSSIER",
    "G2_THEME",
    "G3_INSIGHT",
    "G4_PRD",
    "G6_PROMPT",
    "G7_FINAL",
    "G1",
    "G2",
    "G3",
    "G4",
    "g1-dossier",
    "g2-theme",
    "g3-insight",
    "G5",
    "G5_PORTRAIT",
    "g5-portrait-human",
    "G8",
    "G8_RENDER",
    "g8-render-submit",
    "G9",
    "G9a",
    "G9b",
    "g9-publish",
    "g7-preproduction",
    "G10",
    "G10a",
    "G10b",
    "G10c",
    "G10d",
    "G11",
    "G12",
    "G13",
    "G14",
    "G15",
    "G-MAT1",
    "G-DLV1",
  ]),
});

export function evaluateVideoSystemAutoApproval(
  policyEnabled: boolean,
  evidence: SystemAutoApprovalEvidence,
) {
  return evaluateSystemAutoApproval({
    policy: VIDEO_SYSTEM_AUTO_APPROVAL_POLICY,
    policyEnabled,
    evidence,
  });
}
