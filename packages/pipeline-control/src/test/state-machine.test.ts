import { describe, expect, it } from "vitest";
import { nextActionOf, transitionStage } from "../state-machine.js";
import type { PipelineRunState, StageRuntimeState } from "../types.js";

const artifact = {
  id: "A1",
  logicalId: "theme",
  role: "theme",
  revision: 1,
  schema: "workloom.theme/v1",
  storageRef: "artifacts/theme.json",
  sha256: "a".repeat(64),
  bytes: 12,
  mediaType: "application/json",
};

function stage(overrides: Partial<StageRuntimeState> = {}): StageRuntimeState {
  return {
    stageRunId: "SR1",
    key: "theme",
    itemKey: null,
    revision: 1,
    executionStatus: "ready",
    verificationStatus: "not_run",
    disposition: "continue",
    artifact: null,
    gateDecisionId: null,
    staleReason: null,
    ...overrides,
  };
}

describe("pipeline state machine", () => {
  it("keeps artifact output distinct from gate approval", () => {
    let s = transitionStage(stage(), { type: "claimed" });
    s = { ...s, artifact };
    s = transitionStage(s, { type: "artifact_committed" });
    expect(s.executionStatus).toBe("output_ready");
    expect(s.verificationStatus).toBe("pending");
    s = transitionStage(s, { type: "verification_rejected" });
    expect(s.executionStatus).toBe("completed");
    expect(s.verificationStatus).toBe("rejected");
    expect(s.disposition).toBe("repair");
  });

  it("routes unknown external state to reconciliation", () => {
    const s = transitionStage(stage({ executionStatus: "running" }), { type: "external_unknown" });
    expect(s.executionStatus).toBe("interrupted");
    expect(s.verificationStatus).toBe("unverified");
    expect(s.disposition).toBe("reconcile");
  });

  it("does not allow direct rejected to passed transition", () => {
    expect(() => transitionStage(stage({
      executionStatus: "completed",
      verificationStatus: "rejected",
      artifact,
    }), { type: "verification_passed" })).toThrow();
  });

  it("computes a deterministic next action", () => {
    const run: PipelineRunState = {
      runId: "RUN1",
      projectId: "P1",
      planHash: "b".repeat(64),
      status: "waiting",
      nextAction: "wait_resource",
      stages: { theme: stage({ executionStatus: "completed", verificationStatus: "unverified", disposition: "reconcile", artifact }) },
    };
    expect(nextActionOf(run)).toBe("reconcile");
  });

  it("routes a produced but unverified artifact to human handling", () => {
    const run: PipelineRunState = {
      runId: "RUN1",
      projectId: "P1",
      planHash: "b".repeat(64),
      status: "waiting",
      nextAction: "wait_resource",
      stages: { theme: stage({ executionStatus: "completed", verificationStatus: "unverified", disposition: "wait_human", artifact }) },
    };
    expect(nextActionOf(run)).toBe("wait_approval");
  });
});
