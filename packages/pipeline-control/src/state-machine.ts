import { PipelineControlError } from "./artifact.js";
import type { Disposition, ExecutionStatus, PipelineRunState, StageRuntimeState, VerificationStatus } from "./types.js";

export type StageEvent =
  | { type: "dependencies_ready" }
  | { type: "claimed" }
  | { type: "artifact_committed" }
  | { type: "verification_passed" }
  | { type: "verification_rejected" }
  | { type: "verification_unverified" }
  | { type: "verification_not_applicable" }
  | { type: "execution_failed" }
  | { type: "lease_lost" }
  | { type: "external_unknown" }
  | { type: "reconciled_no_effect" }
  | { type: "stale"; reason: string }
  | { type: "cancel" };

function allowedExecution(current: ExecutionStatus, next: ExecutionStatus): boolean {
  const transitions: Record<ExecutionStatus, ExecutionStatus[]> = {
    pending: ["ready", "failed", "interrupted"],
    ready: ["running", "pending", "failed", "interrupted"],
    running: ["output_ready", "failed", "interrupted"],
    output_ready: ["completed", "failed", "interrupted"],
    completed: ["interrupted"],
    failed: ["ready", "interrupted"],
    interrupted: ["ready", "running", "failed"],
  };
  return transitions[current].includes(next);
}

export function transitionStage(stage: StageRuntimeState, event: StageEvent): StageRuntimeState {
  const next = structuredClone(stage);
  switch (event.type) {
    case "dependencies_ready":
      if (stage.executionStatus !== "pending" && stage.executionStatus !== "failed") {
        throw new PipelineControlError("STAGE_TRANSITION_INVALID", `${stage.key} 不能从 ${stage.executionStatus} 进入 ready`);
      }
      next.executionStatus = "ready";
      next.verificationStatus = "not_run";
      next.disposition = "continue";
      next.staleReason = null;
      break;
    case "claimed":
      if (stage.executionStatus !== "ready") throw new PipelineControlError("STAGE_TRANSITION_INVALID", `${stage.key} 未 ready`);
      next.executionStatus = "running";
      break;
    case "artifact_committed":
      if (stage.executionStatus !== "running") throw new PipelineControlError("STAGE_TRANSITION_INVALID", "只有 running stage 可以提交产物");
      next.executionStatus = "output_ready";
      next.verificationStatus = "pending";
      next.disposition = "continue";
      break;
    case "verification_passed":
      if (!stage.artifact || stage.verificationStatus !== "pending") throw new PipelineControlError("STAGE_TRANSITION_INVALID", "门通过必须有 pending artifact");
      next.executionStatus = "completed";
      next.verificationStatus = "passed";
      next.disposition = "continue";
      break;
    case "verification_rejected":
      if (!stage.artifact || stage.verificationStatus !== "pending") throw new PipelineControlError("STAGE_TRANSITION_INVALID", "门拒绝必须有 pending artifact");
      next.executionStatus = "completed";
      next.verificationStatus = "rejected";
      next.disposition = "repair";
      break;
    case "verification_unverified":
      if (!stage.artifact || stage.verificationStatus !== "pending") throw new PipelineControlError("STAGE_TRANSITION_INVALID", "未核实结论必须有 pending artifact");
      next.executionStatus = "completed";
      next.verificationStatus = "unverified";
      next.disposition = "wait_human";
      break;
    case "verification_not_applicable":
      if (!stage.artifact || stage.verificationStatus !== "pending") {
        throw new PipelineControlError("STAGE_TRANSITION_INVALID", "不适用门仍要求 pending artifact");
      }
      next.executionStatus = "completed";
      next.verificationStatus = "not_applicable";
      next.disposition = "continue";
      break;
    case "execution_failed":
      if (stage.executionStatus !== "running") throw new PipelineControlError("STAGE_TRANSITION_INVALID", "只有 running stage 可以执行失败");
      next.executionStatus = "failed";
      next.verificationStatus = "not_run";
      next.disposition = "repair";
      break;
    case "lease_lost":
      if (stage.executionStatus !== "running") throw new PipelineControlError("STAGE_TRANSITION_INVALID", "只有 running stage 可以中断");
      next.executionStatus = "interrupted";
      next.verificationStatus = "not_run";
      next.disposition = "reconcile";
      break;
    case "external_unknown":
      next.executionStatus = "interrupted";
      next.verificationStatus = "unverified";
      next.disposition = "reconcile";
      break;
    case "reconciled_no_effect":
      if (stage.disposition !== "reconcile") throw new PipelineControlError("STAGE_TRANSITION_INVALID", "stage 未处于 reconcile");
      next.executionStatus = "ready";
      next.verificationStatus = "not_run";
      next.disposition = "continue";
      break;
    case "stale":
      if (!stage.artifact) throw new PipelineControlError("STAGE_TRANSITION_INVALID", "无产物 stage 不能被标记 stale");
      next.verificationStatus = "stale";
      next.disposition = "blocked";
      next.gateDecisionId = null;
      next.staleReason = event.reason;
      return next;
    case "cancel":
      next.disposition = "blocked";
      return next;
  }
  if (!allowedExecution(stage.executionStatus, next.executionStatus)) {
    throw new PipelineControlError(
      "STAGE_TRANSITION_INVALID",
      `${stage.key} 不允许从 ${stage.executionStatus} 进入 ${next.executionStatus}`,
    );
  }
  return next;
}

export function stageAllowsDownstream(stage: StageRuntimeState | undefined): boolean {
  return Boolean(
    stage
    && stage.executionStatus === "completed"
    && (stage.verificationStatus === "passed" || stage.verificationStatus === "not_applicable")
    && stage.disposition !== "blocked"
    && stage.disposition !== "reconcile"
    && stage.disposition !== "repair"
    && stage.disposition !== "wait_human",
  );
}

export function nextActionOf(run: PipelineRunState): PipelineRunState["nextAction"] {
  const stages = Object.values(run.stages);
  if (stages.some((stage) => stage.disposition === "reconcile")) return "reconcile";
  if (stages.some((stage) => stage.disposition === "repair")) return "repair";
  if (stages.some((stage) => stage.disposition === "wait_human")) return "wait_approval";
  if (stages.some((stage) => stage.disposition === "blocked")) return "manual_fix";
  if (stages.some((stage) => stage.executionStatus === "ready")) return "run_node";
  if (stages.length > 0 && stages.every((stage) => stage.verificationStatus === "passed" || stage.verificationStatus === "not_applicable")) return "done";
  return "wait_resource";
}
