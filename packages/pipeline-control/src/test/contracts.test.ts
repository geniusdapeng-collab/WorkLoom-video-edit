import { describe, expect, it } from "vitest";
import {
  parseArtifactEnvelope,
  parseGateDecision,
  parsePipelineCommand,
  parsePipelineOutboxItem,
  parsePipelineRunState,
} from "../schema.js";

const artifact = {
  schemaVersion: "workloom.video-artifact/v1",
  id: "A1",
  logicalId: "prd",
  role: "prd",
  revision: 1,
  schema: "workloom.video.prd/v1",
  storageRef: "artifacts/prd.json",
  sha256: "a".repeat(64),
  bytes: 12,
  mediaType: "application/json",
  creator: { kind: "model", id: "prd", version: "1" },
  parents: [],
  metadata: {},
};

const stage = {
  stageRunId: "SR-1",
  key: "g4",
  itemKey: null,
  revision: 1,
  executionStatus: "completed",
  verificationStatus: "passed",
  disposition: "continue",
  artifact,
  gateDecisionId: "GD-1",
  staleReason: null,
};

describe("runtime contracts", () => {
  it("accepts a complete run and rejects an output_ready stage without an artifact", () => {
    expect(parsePipelineRunState({
      runId: "R1", projectId: "P1", planHash: "b".repeat(64), status: "running",
      nextAction: "run_node", stages: { g4: stage },
    }).stages.g4?.key).toBe("g4");
    expect(() => parsePipelineRunState({
      runId: "R1", projectId: "P1", planHash: "b".repeat(64), status: "running",
      nextAction: "run_node", stages: {
        g4: { ...stage, executionStatus: "output_ready", verificationStatus: "pending", gateDecisionId: null, artifact: null },
      },
    })).toThrow(/canonical artifact/);
  });

  it("rejects blocking findings on a passed gate decision", () => {
    expect(() => parseGateDecision({
      id: "GD-1",
      runId: "R1",
      stageRunId: "SR-1",
      gateId: "G4",
      artifactManifestHash: "c".repeat(64),
      planHash: "b".repeat(64),
      checkSetVersion: "g4/v1",
      rubricVersion: "g4/v1",
      status: "passed",
      reviewer: { kind: "host_rule", id: "host" },
      findings: [{
        code: "X", severity: "P0", targetType: "field", targetId: null, fieldPath: "$.x",
        expected: true, actual: false, evidenceRefs: [], repairClass: "no_repair", blocking: true,
      }],
      evidenceRefs: [],
      supersedesDecisionId: null,
      createdAt: "2026-10-30T00:00:00.000Z",
    })).toThrow(/blocking finding/);
  });

  it("validates command and outbox envelopes", () => {
    expect(parsePipelineCommand({
      commandId: "C1", idempotencyKey: "I1", actor: { id: "worker", type: "worker" },
      expectedRunRevision: 1, payload: { stageKey: "g4" },
    }).payload.stageKey).toBe("g4");
    expect(parsePipelineOutboxItem({
      id: "O1", tenantId: "T1", workspaceId: "W1", runId: "R1", eventKind: "run.started",
      payload: {}, publishedAt: null, attempts: 0, lastError: null, createdAt: "2026-10-30T00:00:00.000Z",
    }).eventKind).toBe("run.started");
  });

  it("keeps the artifact schema strict", () => {
    expect(parseArtifactEnvelope(artifact).id).toBe("A1");
    expect(() => parseArtifactEnvelope({ ...artifact, unexpected: true })).toThrow();
  });
});
