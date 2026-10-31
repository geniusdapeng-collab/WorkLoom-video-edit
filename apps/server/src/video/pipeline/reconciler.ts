import { createHash } from "node:crypto";
import { getAppPool, getOwnerPool } from "@workloom/db";
import {
  VideoPipelineRepository,
  ReconcileCandidate,
} from "./pipeline-repository.js";

export interface ReconcileOutcome {
  candidate: ReconcileCandidate;
  action: "marked_interrupted" | "verify_gate_required" | "reconcile_external" | "wait_human";
}

function stableKey(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

export class VideoPipelineReconciler {
  constructor(
    private readonly repository: VideoPipelineRepository,
    private readonly owner: string,
  ) {}

  async scan(limit = 100): Promise<ReconcileOutcome[]> {
    const candidates = await this.repository.listReconcileCandidates(limit);
    const outcomes: ReconcileOutcome[] = [];
    for (const candidate of candidates) {
      if (candidate.reason !== "expired_running_lease") {
        outcomes.push({
          candidate,
          action: candidate.reason === "output_ready_without_decision"
            ? "verify_gate_required"
            : candidate.reason === "external_unknown"
              ? "reconcile_external"
              : "wait_human",
        });
        continue;
      }
      const key = stableKey({
        runId: candidate.runId,
        revision: candidate.runRevision,
        stageRunId: candidate.stageRunId,
        reason: candidate.reason,
      });
      await this.repository.markInterrupted({
        runId: candidate.runId,
        reason: "startup reconciler: running stage lease expired",
        owner: this.owner,
        commandId: `reconcile-${key}`,
        idempotencyKey: `reconcile:${key}`,
        expectedRunRevision: candidate.runRevision,
        actor: { id: this.owner, type: "system" },
      });
      outcomes.push({ candidate, action: "marked_interrupted" });
    }
    return outcomes;
  }
}

export async function scanVideoPipelinesOnStartup(owner = "video-pipeline-startup"): Promise<ReconcileOutcome[]> {
  const workspaces = await getOwnerPool().query<{ tenant_id: string; id: string }>(
    "SELECT tenant_id,id FROM workspaces ORDER BY id",
  );
  const outcomes: ReconcileOutcome[] = [];
  for (const workspace of workspaces.rows) {
    try {
      const repository = new VideoPipelineRepository(
        { tenantId: workspace.tenant_id, workspaceId: workspace.id },
        getAppPool(),
      );
      outcomes.push(...await new VideoPipelineReconciler(repository, owner).scan());
    } catch (error) {
      console.warn(
        `[pipeline-reconciler] workspace ${workspace.id} scan failed: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return outcomes;
}
