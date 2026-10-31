import { sha256Json } from "./canonical.js";
import { PipelineControlError } from "./artifact.js";
import type { EvidenceRef, GateAuthority, GateStatus } from "./types.js";

export const SYSTEM_AUTO_APPROVAL_SCHEMA = "workloom.system-auto-approval/v1" as const;

export type AutoApprovalCategory =
  | "policy"
  | "deterministic"
  | "fact_hash"
  | "budget"
  | "qualification"
  | "permission"
  | "fence";

export type AutoApprovalCheckStatus = "passed" | "failed" | "not_applicable";

export interface AutoApprovalCheck {
  id: string;
  category: AutoApprovalCategory;
  status: AutoApprovalCheckStatus;
  detail: string;
  evidenceRef: string | null;
  repairClass?:
    | "deterministic"
    | "local_patch"
    | "item_regenerate"
    | "stage_regenerate"
    | "reconcile"
    | "no_repair";
}

export interface AutoApprovalDecisionEvidence {
  status: AutoApprovalCheckStatus;
  detail: string;
  evidenceRef: string;
}

export interface SystemAutoApprovalEvidence {
  gateKey: string;
  action: string;
  artifactSha256: string;
  factHash: string;
  expectedFactHash: string;
  deterministicChecks: AutoApprovalCheck[];
  budget: AutoApprovalDecisionEvidence;
  qualification: AutoApprovalDecisionEvidence;
  permission: AutoApprovalDecisionEvidence;
  fence: AutoApprovalDecisionEvidence & {
    level?: "auto" | "review" | "block";
    triggeredBy?: string[];
  };
  evidenceRefs: EvidenceRef[];
}

export interface SystemAutoApprovalPolicy {
  schemaVersion: "workloom.system-auto-approval-policy/v1";
  id: string;
  version: string;
  checkSetVersion: string;
  gates: ReadonlySet<string>;
}

export interface SystemAutoApprovalReceipt {
  schemaVersion: typeof SYSTEM_AUTO_APPROVAL_SCHEMA;
  authority: Extract<GateAuthority, "system_auto_approval">;
  policyId: string;
  policyVersion: string;
  gateKey: string;
  action: string;
  outcome: "passed" | "repair" | "blocked";
  artifactSha256: string;
  factHash: string;
  expectedFactHash: string;
  evidenceDigest: string;
  checks: AutoApprovalCheck[];
  evidenceRefs: EvidenceRef[];
}

export interface SystemAutoApprovalResult {
  outcome: "passed" | "repair" | "blocked";
  gateStatus: Extract<GateStatus, "passed" | "rejected" | "blocked">;
  checks: AutoApprovalCheck[];
  blockingChecks: AutoApprovalCheck[];
  receipt: SystemAutoApprovalReceipt;
}

function pipelineFailure(code: string, message: string): never {
  throw new PipelineControlError(code, message);
}

function assertSha256(value: string, code: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) pipelineFailure(code, "expected a lowercase SHA-256 digest");
}

function evidenceCheck(
  id: string,
  category: Exclude<AutoApprovalCategory, "fence" | "fact_hash">,
  value: AutoApprovalDecisionEvidence,
  repairClass?: AutoApprovalCheck["repairClass"],
): AutoApprovalCheck {
  if (!value.detail.trim() || !value.evidenceRef.trim()) {
    pipelineFailure("AUTO_APPROVAL_EVIDENCE_INVALID", `${category} evidence requires detail and a reference`);
  }
  return {
    id,
    category,
    status: value.status,
    detail: value.detail,
    evidenceRef: value.evidenceRef,
    ...(repairClass ? { repairClass } : {}),
  };
}

/**
 * Applies one versioned policy to a complete evidence bundle. A review-level
 * fence remains a policy decision input, while an explicit block can never be
 * converted into a pass. Missing or malformed evidence fails closed.
 */
export function evaluateSystemAutoApproval(input: {
  policy: SystemAutoApprovalPolicy;
  policyEnabled: boolean;
  evidence: SystemAutoApprovalEvidence;
}): SystemAutoApprovalResult {
  const { policy, evidence } = input;
  if (policy.schemaVersion !== "workloom.system-auto-approval-policy/v1" || !policy.id.trim() || !policy.version.trim()) {
    pipelineFailure("AUTO_APPROVAL_POLICY_INVALID", "auto-approval policy is not versioned");
  }
  assertSha256(evidence.artifactSha256, "AUTO_APPROVAL_ARTIFACT_INVALID");
  assertSha256(evidence.factHash, "AUTO_APPROVAL_FACT_HASH_INVALID");
  assertSha256(evidence.expectedFactHash, "AUTO_APPROVAL_FACT_HASH_INVALID");
  if (!evidence.gateKey.trim() || !evidence.action.trim() || !evidence.fence.evidenceRef.trim()) {
    pipelineFailure("AUTO_APPROVAL_EVIDENCE_INVALID", "gate, action and fence evidence are required");
  }
  if (evidence.deterministicChecks.length === 0) {
    pipelineFailure("AUTO_APPROVAL_DETERMINISTIC_REQUIRED", "at least one deterministic check is required");
  }

  const checks: AutoApprovalCheck[] = [
    {
      id: "auto-approval-policy-supported",
      category: "policy",
      status: policy.gates.has(evidence.gateKey) ? "passed" : "failed",
      detail: policy.gates.has(evidence.gateKey)
        ? `${policy.id}@${policy.version} covers ${evidence.gateKey}`
        : `${policy.id}@${policy.version} does not cover ${evidence.gateKey}`,
      evidenceRef: `${policy.id}@${policy.version}`,
      repairClass: "no_repair",
    },
    {
      id: "auto-approval-kill-switch",
      category: "policy",
      status: input.policyEnabled ? "passed" : "failed",
      detail: input.policyEnabled ? "global auto-approval policy is enabled" : "global kill switch is off; no action may proceed",
      evidenceRef: "env:PIPELINE_SYSTEM_AUTO_APPROVAL",
      repairClass: "no_repair",
    },
    ...evidence.deterministicChecks,
    {
      id: "auto-approval-fact-hash",
      category: "fact_hash",
      status: evidence.factHash === evidence.expectedFactHash ? "passed" : "failed",
      detail: evidence.factHash === evidence.expectedFactHash
        ? "current fact hash equals the policy-bound hash"
        : "current fact hash differs from the policy-bound hash",
      evidenceRef: `sha256:${evidence.expectedFactHash}`,
      repairClass: "no_repair",
    },
    evidenceCheck("auto-approval-budget", "budget", evidence.budget),
    evidenceCheck("auto-approval-qualification", "qualification", evidence.qualification),
    evidenceCheck("auto-approval-permission", "permission", evidence.permission),
    {
      id: "auto-approval-fence",
      category: "fence",
      status: evidence.fence.level === "block" ? "failed"
        : evidence.fence.status === "failed" ? "failed"
          : evidence.fence.status,
      detail: evidence.fence.level === "block"
        ? `fence block: ${evidence.fence.detail}`
        : evidence.fence.detail,
      evidenceRef: evidence.fence.evidenceRef,
      repairClass: "no_repair",
    },
  ];

  const blockingChecks = checks.filter((check) => check.status === "failed");
  const outcome = blockingChecks.length === 0
    ? "passed" as const
    : blockingChecks.some((check) =>
      ["policy", "fact_hash", "budget", "qualification", "permission", "fence"].includes(check.category))
      ? "blocked" as const
      : "repair" as const;
  const receiptBase = {
    schemaVersion: SYSTEM_AUTO_APPROVAL_SCHEMA,
    authority: "system_auto_approval" as const,
    policyId: policy.id,
    policyVersion: policy.version,
    gateKey: evidence.gateKey,
    action: evidence.action,
    outcome,
    artifactSha256: evidence.artifactSha256,
    factHash: evidence.factHash,
    expectedFactHash: evidence.expectedFactHash,
    checks,
    evidenceRefs: evidence.evidenceRefs,
  };
  return {
    outcome,
    gateStatus: outcome === "passed" ? "passed" : outcome === "repair" ? "rejected" : "blocked",
    checks,
    blockingChecks,
    receipt: { ...receiptBase, evidenceDigest: sha256Json(receiptBase) },
  };
}

export function assertSystemAutoApprovalReceipt(
  value: unknown,
  context: { policyId: string; policyVersion: string; gateKey: string; outcome: SystemAutoApprovalResult["outcome"] },
): SystemAutoApprovalReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    pipelineFailure("AUTO_APPROVAL_RECEIPT_INVALID", "system auto-approval receipt is required");
  }
  const receipt = value as SystemAutoApprovalReceipt;
  if (receipt.schemaVersion !== SYSTEM_AUTO_APPROVAL_SCHEMA
    || receipt.authority !== "system_auto_approval"
    || receipt.policyId !== context.policyId
    || receipt.policyVersion !== context.policyVersion
    || receipt.gateKey !== context.gateKey
    || receipt.outcome !== context.outcome
    || !Array.isArray(receipt.checks)
    || receipt.checks.length === 0
    || !Array.isArray(receipt.evidenceRefs)) {
    pipelineFailure("AUTO_APPROVAL_RECEIPT_INVALID", "system auto-approval receipt does not match the active policy");
  }
  assertSha256(receipt.artifactSha256, "AUTO_APPROVAL_RECEIPT_INVALID");
  assertSha256(receipt.factHash, "AUTO_APPROVAL_RECEIPT_INVALID");
  assertSha256(receipt.expectedFactHash, "AUTO_APPROVAL_RECEIPT_INVALID");
  assertSha256(receipt.evidenceDigest, "AUTO_APPROVAL_RECEIPT_INVALID");
  const { evidenceDigest, ...base } = receipt;
  if (sha256Json(base) !== evidenceDigest) {
    pipelineFailure("AUTO_APPROVAL_RECEIPT_INVALID", "system auto-approval evidence digest does not verify");
  }
  if (receipt.outcome === "passed" && receipt.checks.some((check) => check.status === "failed")) {
    pipelineFailure("AUTO_APPROVAL_RECEIPT_INVALID", "a passed receipt cannot contain failed checks");
  }
  return structuredClone(receipt);
}
