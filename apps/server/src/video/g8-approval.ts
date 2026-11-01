import { canonicalRenderJson, renderSha256, type CompiledProviderRequest } from "./gen/compiled-request.js";
import type { AppPool, Scope } from "./gen/db.js";
import type { RenderScriptLike } from "./gen/submit.js";
import type { VideoGenParams } from "./gen/types.js";
import { gatewayAppendOnClient } from "@workloom/base/workdata";

export const G8_APPROVAL_SCHEMA = "workloom.video-g8-approval/v1" as const;

export interface G8ApprovalBinding {
  schemaVersion: typeof G8_APPROVAL_SCHEMA;
  qualificationId: string;
  requestHash: string;
  payloadHash: string;
  modelId: string;
  shotId: string;
  durationSec: number;
  estimatedCny: number;
  allowOverage: boolean;
}

export type G8ApprovalResult =
  | { status: "approved"; approvalId: string; bindingSha256: string }
  | { status: "awaiting_approval"; approvalId: string; bindingSha256: string; expiresAt: string };

export class G8ApprovalError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "G8ApprovalError";
  }
}

export function g8ApprovalBinding(input: {
  qualificationId: string;
  requestHash: string;
  payloadHash: string;
  modelId: string;
  shotId: string;
  durationSec: number;
  estimatedCny: number;
  allowOverage: boolean;
}): G8ApprovalBinding {
  return { schemaVersion: G8_APPROVAL_SCHEMA, ...input };
}

export function g8ApprovalBindingHash(binding: G8ApprovalBinding): string {
  return renderSha256(canonicalRenderJson(binding));
}

/**
 * In enforce mode a real provider submission needs a human approval whose
 * snapshot is bound to the exact qualification and canonical request. The
 * approval is consumed atomically before the provider boundary, so a second
 * request with a different payload cannot reuse it.
 */
export async function requireOrConsumeG8Approval(input: {
  app: AppPool;
  scope: Scope;
  actor: string;
  script: RenderScriptLike;
  modelId: string;
  params: VideoGenParams;
  compiled: CompiledProviderRequest;
  qualificationId: string;
  requestHash: string;
  estimatedCny: number;
  allowOverage: boolean;
  approvalId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<G8ApprovalResult> {
  const binding = g8ApprovalBinding({
    qualificationId: input.qualificationId,
    requestHash: input.requestHash,
    payloadHash: input.compiled.payloadHash,
    modelId: input.modelId,
    shotId: input.script.shot_id,
    durationSec: Number(input.params.durationSec ?? 0),
    estimatedCny: input.estimatedCny,
    allowOverage: input.allowOverage,
  });
  const bindingSha256 = g8ApprovalBindingHash(binding);
  if (input.params.durationSec === undefined || !Number.isFinite(input.params.durationSec) || input.params.durationSec <= 0) {
    throw new G8ApprovalError("G8_BINDING_INVALID", "审批必须绑定有效镜头时长");
  }
  const client = await input.app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [input.scope.tenantId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [input.scope.workspaceId]);
    if (input.approvalId) {
      const found = await client.query<{
        approval_id: string; status: string; snapshot: Record<string, unknown> | null; consumed_at: string | null;
      }>(`SELECT approval_id,status,snapshot,consumed_at FROM approvals
          WHERE approval_id=$1 AND tenant_id=$2 AND workspace_id=$3 FOR UPDATE`,
      [input.approvalId, input.scope.tenantId, input.scope.workspaceId]);
      const row = found.rows[0];
      if (!row) throw new G8ApprovalError("G8_APPROVAL_NOT_FOUND", "审批单不存在或不属于当前租户/工作区");
      if (row.status !== "approved") throw new G8ApprovalError("G8_APPROVAL_NOT_APPROVED", `审批状态为 ${row.status}`);
      if (row.consumed_at) throw new G8ApprovalError("G8_APPROVAL_CONSUMED", "审批单已被消费");
      const snapshot = row.snapshot ?? {};
      const expires = typeof snapshot.expires_at === "string" ? Date.parse(snapshot.expires_at) : NaN;
      if (!Number.isFinite(expires) || expires <= Date.now()) throw new G8ApprovalError("G8_APPROVAL_EXPIRED", "审批单已过期");
      if (snapshot.binding_sha256 !== bindingSha256 || snapshot.action !== "render.submit"
        || snapshot.object_type !== "render_script" || snapshot.object_id !== input.script.id) {
        throw new G8ApprovalError("G8_APPROVAL_PAYLOAD_MISMATCH", "审批单未绑定当前证书、请求和脚本");
      }
      const consumed = await client.query(
        `UPDATE approvals SET consumed_at=now()
          WHERE approval_id=$1 AND tenant_id=$2 AND workspace_id=$3
            AND status='approved' AND consumed_at IS NULL`,
        [row.approval_id, input.scope.tenantId, input.scope.workspaceId],
      );
      if ((consumed.rowCount ?? 0) !== 1) throw new G8ApprovalError("G8_APPROVAL_CONSUMED", "审批单已被并发消费");
      await client.query("COMMIT");
      return { status: "approved", approvalId: row.approval_id, bindingSha256 };
    }

    const existing = await client.query<{ approval_id: string }>(`SELECT approval_id FROM approvals
      WHERE tenant_id=$1 AND workspace_id=$2 AND status='pending'
        AND snapshot->>'binding_sha256'=$3 ORDER BY created_at DESC LIMIT 1`,
    [input.scope.tenantId, input.scope.workspaceId, bindingSha256]);
    const approvalId = existing.rows[0]?.approval_id ?? `apr-${renderSha256(`${input.scope.workspaceId}:${bindingSha256}`).slice(0, 20)}`;
    if (!existing.rows[0]) {
      const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
      const event = await gatewayAppendOnClient(client, {
        ...input.scope,
        actor: { id: input.actor, type: "human" },
      }, {
        who: { type: "human", id: input.actor },
        context: {
          tenant_id: input.scope.tenantId, workspace_id: input.scope.workspaceId,
          time: new Date().toISOString(), channel: "inapp",
        },
        object: { type: "render_script", id: input.script.id },
        decision: {
          action: "render.submit.approval.request",
          after: {
            bindingSha256,
            qualificationId: input.qualificationId,
            requestHash: input.requestHash,
            payloadHash: input.compiled.payloadHash,
            modelId: input.modelId,
            shotId: input.script.shot_id,
            durationSec: input.params.durationSec,
            estimatedCny: input.estimatedCny,
            allowOverage: input.allowOverage,
            expiresAt,
          },
          basis: ["G8 human paid-submission authorization requested by the production boundary"],
        },
        rule_impact: [],
      });
      await client.query(
        `INSERT INTO approvals
          (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot, tier)
         VALUES ($1,$2,$3,$4,'inapp','pending',$5::jsonb,'l4_chairman')
         ON CONFLICT (event_id, channel) DO NOTHING`,
        [approvalId, input.scope.tenantId, input.scope.workspaceId, event.eventId, JSON.stringify({
          title: `G8 付费渲染授权 · ${input.script.shot_id}`,
          action: "render.submit",
          object_type: "render_script",
          object_id: input.script.id,
          params: binding,
          binding_sha256: bindingSha256,
          expires_at: expiresAt,
          high_risk: true,
          irreversible: false,
          gate: "G8",
        })],
      );
      await client.query("COMMIT");
      return { status: "awaiting_approval", approvalId, bindingSha256, expiresAt };
    }
    await client.query("COMMIT");
    return { status: "awaiting_approval", approvalId, bindingSha256, expiresAt: "" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
