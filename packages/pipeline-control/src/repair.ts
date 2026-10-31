import { sha256Json } from "./canonical.js";
import { PipelineControlError } from "./artifact.js";
import type { BudgetEnvelope, GateDecision, RepairPlan } from "./types.js";

export interface RepairPlaybook {
  id: string;
  version: string;
  allowedChanges: string[];
  forbiddenChanges: string[];
  maxAttempts: number;
  requiresApproval: boolean;
}

export interface RepairCandidate {
  playbook: RepairPlaybook;
  targetStageRunId: string;
  targetRevision: number;
  invalidationClosure: string[];
  budgetEnvelope: BudgetEnvelope;
  previousFindingSignature?: string;
  previousFailedAttempts?: number;
}

export function findingSignature(decision: GateDecision): string {
  return sha256Json(
    decision.findings
      .filter((finding) => finding.blocking)
      .map(({ code, targetType, targetId, fieldPath, repairClass }) => ({
        code, targetType, targetId, fieldPath, repairClass,
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  );
}

export function buildRepairPlan(
  id: string,
  decision: GateDecision,
  candidate: RepairCandidate,
  now = new Date().toISOString(),
): RepairPlan {
  if (decision.status !== "rejected") throw new PipelineControlError("REPAIR_DECISION_INVALID", "只有 rejected decision 可以生成修复计划");
  if (candidate.targetStageRunId !== decision.stageRunId) {
    throw new PipelineControlError("REPAIR_TARGET_INVALID", "修复目标必须与被拒绝 decision 的 stage 一致");
  }
  const findings = decision.findings.filter((finding) => finding.blocking);
  if (findings.length === 0) throw new PipelineControlError("REPAIR_FINDINGS_MISSING", "没有结构化 blocking finding，禁止自动修复");
  if (!Number.isSafeInteger(candidate.playbook.maxAttempts) || candidate.playbook.maxAttempts < 1) {
    throw new PipelineControlError("REPAIR_PLAYBOOK_INVALID", "playbook.maxAttempts 必须是正整数");
  }
  if (!Number.isSafeInteger(candidate.budgetEnvelope.maxAttempts) || candidate.budgetEnvelope.maxAttempts < 1
    || candidate.budgetEnvelope.maxAttempts > candidate.playbook.maxAttempts) {
    throw new PipelineControlError("REPAIR_BUDGET_INVALID", "修复预算 attempts 必须落在 playbook 范围内");
  }
  if (candidate.playbook.allowedChanges.length === 0) throw new PipelineControlError("REPAIR_PLAYBOOK_INVALID", "playbook 未声明允许修改面");
  const overlap = candidate.playbook.allowedChanges.filter((path) => candidate.playbook.forbiddenChanges.includes(path));
  if (overlap.length > 0) throw new PipelineControlError("REPAIR_PLAYBOOK_INVALID", `允许字段与禁止字段冲突：${overlap.join(",")}`);
  const signature = findingSignature(decision);
  const repeated = candidate.previousFindingSignature === signature
    && (candidate.previousFailedAttempts ?? 0) >= candidate.playbook.maxAttempts;
  const payload = {
    runId: decision.runId,
    rootDecisionId: decision.id,
    targetStageRunId: candidate.targetStageRunId,
    targetRevision: candidate.targetRevision,
    playbookId: candidate.playbook.id,
    playbookVersion: candidate.playbook.version,
    findings,
    allowedChanges: candidate.playbook.allowedChanges,
    forbiddenChanges: candidate.playbook.forbiddenChanges,
    invalidationClosure: candidate.invalidationClosure,
    budgetEnvelope: candidate.budgetEnvelope,
    requiresApproval: candidate.playbook.requiresApproval,
  };
  return {
    id,
    ...payload,
    planHash: sha256Json(payload),
    status: repeated ? "stalled" : "proposed",
  };
}

export function transitionRepair(
  plan: RepairPlan,
  next: RepairPlan["status"],
): RepairPlan {
  const allowed: Record<RepairPlan["status"], RepairPlan["status"][]> = {
    proposed: ["approved", "rejected", "stalled"],
    approved: ["running", "rejected", "stalled"],
    running: ["applied", "rejected", "stalled"],
    applied: [],
    rejected: [],
    stalled: ["approved", "rejected"],
  };
  if (!allowed[plan.status].includes(next)) {
    throw new PipelineControlError("REPAIR_TRANSITION_INVALID", `RepairPlan 不能从 ${plan.status} 进入 ${next}`);
  }
  return { ...structuredClone(plan), status: next };
}
