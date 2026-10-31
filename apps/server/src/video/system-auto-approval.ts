import type pg from "pg";
import { gatewayAppend } from "@workloom/base/workdata";
import {
  loadPipelineFeatureFlags,
  type AutoApprovalCheck,
  type AutoApprovalDecisionEvidence,
  type EvidenceRef,
} from "@workloom/pipeline-control";
import {
  evaluateVideoSystemAutoApproval,
  VIDEO_SYSTEM_AUTO_APPROVAL_POLICY,
} from "@hyperreality/video-pipeline";

export interface VideoAutoApprovalInput {
  gateKey: string;
  action: string;
  artifactSha256: string;
  factHash: string;
  expectedFactHash: string;
  deterministicChecks: AutoApprovalCheck[];
  budget: AutoApprovalDecisionEvidence;
  qualification: AutoApprovalDecisionEvidence;
  permission: AutoApprovalDecisionEvidence;
  fence: {
    status: AutoApprovalCheck["status"];
    detail: string;
    evidenceRef: string;
    level?: "auto" | "review" | "block";
    triggeredBy?: string[];
  };
  evidenceRefs: EvidenceRef[];
}

/**
 * Evaluates the policy and writes the required exact event. Callers must stop
 * the protected action unless the returned outcome is `passed`.
 */
export async function evaluateAndRecordVideoAutoApproval(
  gateway: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  object: { type: string; id: string },
  input: VideoAutoApprovalInput,
  env: NodeJS.ProcessEnv = process.env,
) {
  const result = evaluateVideoSystemAutoApproval(
    loadPipelineFeatureFlags(env).systemAutoApproval === "enforce",
    input,
  );
  const appended = await gatewayAppend(gateway, {
    ...scope,
    actor: { id: "system", type: "system" },
  }, {
    who: { type: "system", id: "system" },
    context: {
      tenant_id: scope.tenantId,
      workspace_id: scope.workspaceId,
      time: new Date().toISOString(),
      channel: "inapp",
    },
    object,
    decision: {
      action: "system-auto-approval",
      after: {
        gateKey: input.gateKey,
        action: input.action,
        outcome: result.outcome,
        policyId: result.receipt.policyId,
        policyVersion: result.receipt.policyVersion,
        artifactSha256: input.artifactSha256,
        factHash: input.factHash,
        expectedFactHash: input.expectedFactHash,
        evidenceDigest: result.receipt.evidenceDigest,
        checks: result.checks,
        evidenceRefs: result.receipt.evidenceRefs,
      },
      basis: [`${VIDEO_SYSTEM_AUTO_APPROVAL_POLICY.id}@${VIDEO_SYSTEM_AUTO_APPROVAL_POLICY.version}`],
    },
    rule_impact: result.checks.map((check) => ({
      rule_id: check.id,
      version: VIDEO_SYSTEM_AUTO_APPROVAL_POLICY.version,
      result: check.status === "passed" ? "pass" : check.status === "failed" ? "blocked" : "review",
    })),
  });
  return { ...result, eventId: appended.eventId };
}

export function autoApprovalRefusal(result: Awaited<ReturnType<typeof evaluateVideoSystemAutoApproval>>): string | null {
  if (result.outcome === "passed") return null;
  return `${result.outcome}：${result.blockingChecks.map((check) => `${check.id}=${check.detail}`).join("；")}`;
}
