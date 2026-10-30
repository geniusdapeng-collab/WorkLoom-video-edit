import { describe, expect, it } from "vitest";
import { descendantsOf, invalidateDescendants } from "../invalidation.js";
import type { PipelineRunState } from "../types.js";

const artifact = (logicalId: string) => ({
  id: `A-${logicalId}`,
  logicalId,
  role: logicalId,
  revision: 1,
  schema: "test/v1",
  storageRef: `artifacts/${logicalId}.json`,
  sha256: "a".repeat(64),
  bytes: 1,
  mediaType: "application/json",
});

describe("invalidation closure", () => {
  it("walks the full descendant graph", () => {
    expect(descendantsOf([
      { from: "g3", to: "prd" },
      { from: "prd", to: "g4" },
      { from: "g4", to: "script" },
      { from: "theme", to: "g3" },
    ], "g3")).toEqual(["g4", "prd", "script"]);
  });

  it("marks only nodes with prior artifacts stale", () => {
    const run: PipelineRunState = {
      runId: "R", projectId: "P", planHash: "b".repeat(64), status: "running",
      nextAction: "run_node", stages: {
        g3: { stageRunId: "1", key: "g3", itemKey: null, revision: 1, executionStatus: "completed",
          verificationStatus: "passed", disposition: "continue", artifact: artifact("g3"), gateDecisionId: "D1", staleReason: null },
        prd: { stageRunId: "2", key: "prd", itemKey: null, revision: 1, executionStatus: "completed",
          verificationStatus: "passed", disposition: "continue", artifact: artifact("prd"), gateDecisionId: "D2", staleReason: null },
        g4: { stageRunId: "3", key: "g4", itemKey: null, revision: 1, executionStatus: "pending",
          verificationStatus: "not_run", disposition: "continue", artifact: null, gateDecisionId: null, staleReason: null },
      },
    };
    expect(invalidateDescendants(run, [{ from: "g3", to: "prd" }, { from: "prd", to: "g4" }], "g3", "upstream changed")).toEqual(["prd"]);
    expect(run.stages.prd!.verificationStatus).toBe("stale");
  });
});
