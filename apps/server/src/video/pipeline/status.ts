import type { PipelineRunView } from "./pipeline-repository.js";

export interface PipelineBlocker {
  nodeKey: string;
  kind: "gate" | "approval" | "repair" | "unknown_operation" | "budget" | "manual";
  reason: string;
  decisionId?: string;
}

export interface PipelineStatus {
  runId: string;
  projectId: string;
  status: PipelineRunView["status"];
  nextAction: PipelineRunView["nextAction"];
  revision: number;
  frontier: string[];
  blocker: PipelineBlocker | null;
  stages: PipelineRunView["stages"];
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  legacy: false;
}

export function projectPipelineStatus(run: PipelineRunView): PipelineStatus {
  const blocked = run.stages.find((stage) =>
    stage.disposition === "wait_human"
    || stage.disposition === "repair"
    || stage.disposition === "reconcile"
    || stage.disposition === "blocked");
  const blocker: PipelineBlocker | null = blocked
    ? {
        nodeKey: blocked.key,
        kind: blocked.disposition === "wait_human" ? "approval"
          : blocked.disposition === "repair" ? "repair"
            : blocked.disposition === "reconcile" ? "unknown_operation" : "manual",
        reason: blocked.staleReason
          ?? `stage ${blocked.key} disposition=${blocked.disposition} verification=${blocked.verificationStatus}`,
        ...(blocked.gateDecisionId ? { decisionId: blocked.gateDecisionId } : {}),
      }
    : null;
  return {
    runId: run.runId,
    projectId: run.projectId,
    status: run.status,
    nextAction: run.nextAction,
    revision: run.revision,
    frontier: run.currentFrontier,
    blocker,
    stages: run.stages,
    leaseOwner: run.leaseOwner,
    leaseExpiresAt: run.leaseExpiresAt,
    legacy: false,
  };
}
