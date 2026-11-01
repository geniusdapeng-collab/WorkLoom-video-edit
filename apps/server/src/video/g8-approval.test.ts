import { describe, expect, it, vi } from "vitest";
import {
  g8ApprovalBinding,
  g8ApprovalBindingHash,
  requireOrConsumeG8Approval,
  type G8ApprovalBinding,
} from "./g8-approval.js";

const binding: G8ApprovalBinding = g8ApprovalBinding({
  qualificationId: "PQ-1",
  requestHash: "a".repeat(64),
  payloadHash: "b".repeat(64),
  modelId: "doubao-seedance-2-5",
  shotId: "S01",
  durationSec: 5,
  estimatedCny: 7.2,
  allowOverage: false,
});

const compiled = {
  schemaVersion: "workloom.provider-request/v1" as const,
  provider: "seedance",
  providerModel: "doubao-seedance-2-5-260628",
  endpoint: "https://ark.example.test/contents/generations/tasks",
  method: "POST" as const,
  body: {},
  bodyJson: "{}",
  payloadHash: binding.payloadHash,
};

const script = {
  id: "RS-1", project_id: "P1", shot_id: "S01", script_key: "qualified:PQ-1",
  version: 1, status: "draft", md: "prompt", fields: {},
};

function poolFor(status = "approved", snapshot: Record<string, unknown> | null = {
  action: "render.submit",
  object_type: "render_script",
  object_id: script.id,
  binding_sha256: g8ApprovalBindingHash(binding),
  expires_at: new Date(Date.now() + 60_000).toISOString(),
}) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (sql.includes("FROM approvals") && sql.includes("FOR UPDATE")) return {
      rows: [{ approval_id: "APR-1", status, snapshot, consumed_at: null }],
    };
    if (sql.startsWith("UPDATE approvals")) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return {
    queries,
    app: { connect: async () => ({ query, release: vi.fn() }) } as never,
  };
}

describe("G8 human paid authorization", () => {
  it("binds all paid-request identity to one stable digest", () => {
    expect(g8ApprovalBindingHash(binding)).toMatch(/^[a-f0-9]{64}$/);
    expect(g8ApprovalBindingHash({ ...binding, requestHash: "c".repeat(64) })).not.toBe(g8ApprovalBindingHash(binding));
  });

  it("consumes an approved ticket once and rejects a mismatched snapshot", async () => {
    const fixture = poolFor();
    const result = await requireOrConsumeG8Approval({
      app: fixture.app,
      scope: { tenantId: "T1", workspaceId: "W1" },
      actor: "MEM-1",
      script,
      modelId: "doubao-seedance-2-5",
      params: { durationSec: 5 },
      compiled,
      qualificationId: "PQ-1",
      requestHash: binding.requestHash,
      estimatedCny: 7.2,
      allowOverage: false,
      approvalId: "APR-1",
    });
    expect(result.status).toBe("approved");
    expect(fixture.queries.some((entry) => entry.sql.startsWith("UPDATE approvals"))).toBe(true);

    const mismatch = poolFor("approved", {
      action: "render.submit",
      object_type: "render_script",
      object_id: script.id,
      binding_sha256: "d".repeat(64),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    await expect(requireOrConsumeG8Approval({
      app: mismatch.app,
      scope: { tenantId: "T1", workspaceId: "W1" },
      actor: "MEM-1",
      script,
      modelId: "doubao-seedance-2-5",
      params: { durationSec: 5 },
      compiled,
      qualificationId: "PQ-1",
      requestHash: binding.requestHash,
      estimatedCny: 7.2,
      allowOverage: false,
      approvalId: "APR-1",
    })).rejects.toThrow("G8_APPROVAL_PAYLOAD_MISMATCH");
  });
});
