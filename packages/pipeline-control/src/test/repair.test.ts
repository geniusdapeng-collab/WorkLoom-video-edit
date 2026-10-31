import { describe, expect, it } from "vitest";
import { buildRepairPlan, findingSignature, transitionRepair } from "../repair.js";
import type { GateDecision } from "../types.js";

const decision: GateDecision = {
  id: "D1",
  runId: "R1",
  stageRunId: "S1",
  gateId: "G4",
  artifactManifestHash: "a".repeat(64),
  planHash: "b".repeat(64),
  checkSetVersion: "g4/v1",
  rubricVersion: "g4/v1",
  status: "rejected",
  reviewer: { kind: "llm_review", id: "reviewer" },
  findings: [{
    code: "G4_DURATION_CONFLICT",
    severity: "P0",
    targetType: "field",
    targetId: "prd.delivery.duration",
    fieldPath: "$.delivery.durationSeconds",
    expected: 30,
    actual: 31,
    evidenceRefs: ["evidence:1"],
    repairClass: "deterministic",
    blocking: true,
  }],
  evidenceRefs: ["evidence:1"],
  supersedesDecisionId: null,
  createdAt: "2026-10-30T00:00:00.000Z",
};

const playbook = {
  id: "repair-duration",
  version: "1",
  allowedChanges: ["$.delivery.durationSeconds"],
  forbiddenChanges: ["$.facts", "$.theme"],
  maxAttempts: 2,
  requiresApproval: false,
};

describe("repair plan", () => {
  it("binds the exact decision and target revision", () => {
    const plan = buildRepairPlan("RP1", decision, {
      playbook,
      targetStageRunId: "S1",
      targetRevision: 1,
      invalidationClosure: ["script"],
      budgetEnvelope: { maxAttempts: 2, maxWallMs: 1000, maxModelTokens: 100, maxCny: 0 },
    });
    expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.targetRevision).toBe(1);
    expect(plan.status).toBe("proposed");
  });

  it("stalls a repeated identical failure after max attempts", () => {
    const plan = buildRepairPlan("RP2", decision, {
      playbook,
      targetStageRunId: "S1",
      targetRevision: 1,
      invalidationClosure: ["script"],
      budgetEnvelope: { maxAttempts: 2, maxWallMs: 1000, maxModelTokens: 100, maxCny: 0 },
      previousFindingSignature: findingSignature(decision),
      previousFailedAttempts: 2,
    });
    expect(plan.status).toBe("stalled");
    expect(transitionRepair(plan, "approved").status).toBe("approved");
  });

  it("rejects playbooks that both allow and forbid a field", () => {
    expect(() => buildRepairPlan("RP3", decision, {
      playbook: { ...playbook, forbiddenChanges: ["$.delivery.durationSeconds"] },
      targetStageRunId: "S1",
      targetRevision: 1,
      invalidationClosure: [],
      budgetEnvelope: { maxAttempts: 2, maxWallMs: 1000, maxModelTokens: 100, maxCny: 0 },
    })).toThrow(/冲突/);
  });

  it("rejects a repair target outside the rejected decision stage", () => {
    expect(() => buildRepairPlan("RP4", decision, {
      playbook,
      targetStageRunId: "S2",
      targetRevision: 1,
      invalidationClosure: [],
      budgetEnvelope: { maxAttempts: 1, maxWallMs: 1000, maxModelTokens: 100, maxCny: 0 },
    })).toThrow(/修复目标/);
  });
});
