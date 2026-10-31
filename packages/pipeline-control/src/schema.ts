import { z } from "zod";
import {
  DISPOSITIONS,
  EXECUTION_STATUSES,
  VERIFICATION_STATUSES,
  type ArtifactEnvelope,
  type GateDecision,
  type PipelineCommand,
  type PipelineOutboxItem,
  type PipelineRunState,
  type RepairPlan,
  type StageRuntimeState,
} from "./types.js";

const nonEmpty = z.string().trim().min(1);
const id = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const jsonObject = z.record(z.string(), z.unknown());

export const artifactRefSchema = z.object({
  id,
  logicalId: id,
  role: nonEmpty,
  revision: z.number().int().positive(),
  schema: nonEmpty,
  storageRef: nonEmpty,
  sha256,
  bytes: z.number().int().nonnegative(),
  mediaType: nonEmpty,
});

export const artifactCreatorSchema = z.object({
  kind: z.enum(["model", "deterministic", "human", "provider"]),
  id: nonEmpty,
  version: nonEmpty,
}).strict();

export const artifactParentSchema = z.object({
  artifactId: nonEmpty,
  sha256,
  role: nonEmpty,
}).strict();

export const artifactEnvelopeSchema = artifactRefSchema.extend({
  schemaVersion: z.literal("workloom.video-artifact/v1"),
  creator: artifactCreatorSchema,
  parents: z.array(artifactParentSchema),
  metadata: jsonObject,
}).strict().superRefine((value, context) => {
  const keys = value.parents.map((parent) => `${parent.artifactId}:${parent.role}`);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", path: ["parents"], message: "artifact parents 不能重复" });
  }
  if (value.parents.some((parent) => parent.artifactId === value.id)) {
    context.addIssue({ code: "custom", path: ["parents"], message: "artifact 不能以自身为父" });
  }
});

export const gateFindingSchema = z.object({
  code: nonEmpty,
  severity: z.enum(["P0", "P1", "P2", "advisory"]),
  targetType: z.enum(["run", "stage", "field", "item", "artifact"]),
  targetId: z.string().nullable(),
  fieldPath: z.string().nullable(),
  expected: z.unknown(),
  actual: z.unknown(),
  evidenceRefs: z.array(nonEmpty),
  repairClass: z.enum(["schema", "deterministic", "semantic", "human_input", "no_repair"]),
  blocking: z.boolean(),
}).strict();

export const reviewerReceiptSchema = z.object({
  kind: z.enum(["host_rule", "llm_review", "human_approval", "system_auto_approval", "external_receipt"]),
  id: nonEmpty,
  model: nonEmpty.optional(),
  approvalId: nonEmpty.optional(),
  receiptRef: nonEmpty.optional(),
  autoApproval: jsonObject.optional(),
}).strict();

export const gateDecisionSchema = z.object({
  id,
  runId: nonEmpty,
  stageRunId: nonEmpty,
  gateId: nonEmpty,
  artifactManifestHash: sha256,
  planHash: sha256,
  checkSetVersion: nonEmpty,
  rubricVersion: nonEmpty,
  authority: z.enum(["deterministic", "llm_review", "human_approval", "system_auto_approval", "external_receipt"]).optional(),
  status: z.enum(["passed", "rejected", "unverified", "not_applicable", "blocked"]),
  reviewer: reviewerReceiptSchema,
  findings: z.array(gateFindingSchema),
  evidenceRefs: z.array(z.union([
    nonEmpty,
    z.object({
      id: nonEmpty,
      kind: z.enum(["file", "event", "approval", "provider_receipt", "rule"]),
      sha256: sha256.nullable(),
      ref: nonEmpty,
    }).strict(),
  ])),
  supersedesDecisionId: nonEmpty.nullable(),
  createdAt: z.iso.datetime(),
}).strict().superRefine((value, context) => {
  if (value.status !== "rejected" && value.findings.some((finding) => finding.blocking)) {
    context.addIssue({ code: "custom", path: ["findings"], message: "非 rejected decision 不得包含 blocking finding" });
  }
  if (value.status === "rejected" && !value.findings.some((finding) => finding.blocking)) {
    context.addIssue({ code: "custom", path: ["findings"], message: "rejected decision 必须包含 blocking finding" });
  }
});

export const stageRuntimeStateSchema = z.object({
  stageRunId: nonEmpty,
  key: nonEmpty,
  itemKey: nonEmpty.nullable(),
  revision: z.number().int().positive(),
  executionStatus: z.enum(EXECUTION_STATUSES),
  verificationStatus: z.enum(VERIFICATION_STATUSES),
  disposition: z.enum(DISPOSITIONS),
  artifact: artifactRefSchema.nullable(),
  gateDecisionId: nonEmpty.nullable(),
  staleReason: nonEmpty.nullable(),
}).strict().superRefine((value, context) => {
  if (value.executionStatus === "output_ready" && !value.artifact) {
    context.addIssue({ code: "custom", path: ["artifact"], message: "output_ready 必须有 canonical artifact" });
  }
  if (value.executionStatus === "completed" && !value.artifact) {
    context.addIssue({ code: "custom", path: ["artifact"], message: "completed stage 必须有 artifact" });
  }
  if (value.verificationStatus === "rejected" && !value.gateDecisionId) {
    context.addIssue({ code: "custom", path: ["gateDecisionId"], message: "rejected 必须绑定 GateDecision" });
  }
  if (value.verificationStatus === "passed" && !value.gateDecisionId) {
    context.addIssue({ code: "custom", path: ["gateDecisionId"], message: "passed 必须绑定 GateDecision" });
  }
});

export const budgetEnvelopeSchema = z.object({
  maxAttempts: z.number().int().nonnegative(),
  maxWallMs: z.number().int().nonnegative(),
  maxModelTokens: z.number().int().nonnegative(),
  maxCny: z.number().nonnegative(),
}).strict();

export const repairPlanSchema = z.object({
  id,
  runId: nonEmpty,
  rootDecisionId: nonEmpty,
  targetStageRunId: nonEmpty,
  targetRevision: z.number().int().positive(),
  playbookId: nonEmpty,
  playbookVersion: nonEmpty,
  planHash: sha256,
  findings: z.array(gateFindingSchema).min(1),
  allowedChanges: z.array(nonEmpty).min(1),
  forbiddenChanges: z.array(nonEmpty),
  invalidationClosure: z.array(nonEmpty),
  budgetEnvelope: budgetEnvelopeSchema,
  requiresApproval: z.boolean(),
  status: z.enum(["proposed", "approved", "running", "applied", "rejected", "stalled"]),
}).strict().superRefine((value, context) => {
  if (value.findings.some((finding) => !finding.blocking)) {
    context.addIssue({ code: "custom", path: ["findings"], message: "RepairPlan 只能包含 blocking finding" });
  }
  const overlap = value.allowedChanges.filter((path) => value.forbiddenChanges.includes(path));
  if (overlap.length > 0) {
    context.addIssue({ code: "custom", path: ["forbiddenChanges"], message: "允许修改面与禁止修改面冲突" });
  }
});

export const pipelineRunStateSchema = z.object({
  runId: nonEmpty,
  projectId: nonEmpty,
  planHash: sha256,
  status: z.enum(["queued", "running", "waiting", "reconciling", "completed", "failed", "cancelled"]),
  nextAction: z.enum(["run_node", "wait_approval", "repair", "reconcile", "wait_resource", "manual_fix", "done"]),
  stages: z.record(z.string(), stageRuntimeStateSchema),
}).strict();

export const pipelineCommandSchema = z.object({
  commandId: nonEmpty,
  idempotencyKey: nonEmpty,
  actor: z.object({
    id: nonEmpty,
    type: z.enum(["human", "system", "worker"]),
  }).strict(),
  expectedRunRevision: z.number().int().positive(),
  expectedStageRevision: z.number().int().positive().optional(),
  payload: jsonObject,
}).strict();

export const pipelineEventSchema = z.object({
  schemaVersion: z.literal("workloom.video-pipeline-event/v1"),
  eventId: nonEmpty,
  runId: nonEmpty,
  projectId: nonEmpty,
  nodeKey: nonEmpty,
  revision: z.number().int().positive().nullable(),
  kind: z.enum([
    "run.started", "node.claimed", "artifact.committed", "gate.decided", "repair.requested",
    "operation.reserved", "operation.dispatched", "operation.accepted", "operation.failed",
    "operation.unknown", "node.interrupted", "run.state_changed", "run.completed",
  ]),
  actor: z.object({
    id: nonEmpty,
    type: z.enum(["human", "system", "worker"]),
  }).strict(),
  at: z.iso.datetime(),
  inputHashes: z.array(sha256),
  outputHash: sha256.nullable(),
  decisionId: nonEmpty.nullable(),
  operationId: nonEmpty.nullable(),
  attempt: z.number().int().positive(),
  cost: z.record(z.string(), z.number().nullable()),
  metadata: jsonObject,
}).strict();

export const pipelineOutboxItemSchema = z.object({
  id: nonEmpty,
  tenantId: nonEmpty,
  workspaceId: nonEmpty,
  runId: nonEmpty,
  eventKind: pipelineEventSchema.shape.kind,
  payload: jsonObject,
  publishedAt: z.iso.datetime().nullable(),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  createdAt: z.iso.datetime(),
}).strict();

export function parseArtifactEnvelope(value: unknown): ArtifactEnvelope {
  return artifactEnvelopeSchema.parse(value);
}

export function parseStageRuntimeState(value: unknown): StageRuntimeState {
  return stageRuntimeStateSchema.parse(value);
}

export function parseGateDecision(value: unknown): GateDecision {
  return gateDecisionSchema.parse(value);
}

export function parseRepairPlan(value: unknown): RepairPlan {
  return repairPlanSchema.parse(value);
}

export function parsePipelineRunState(value: unknown): PipelineRunState {
  return pipelineRunStateSchema.parse(value);
}

export function parsePipelineCommand(value: unknown): PipelineCommand {
  return pipelineCommandSchema.parse(value) as PipelineCommand;
}

export function parsePipelineOutboxItem(value: unknown): PipelineOutboxItem {
  return pipelineOutboxItemSchema.parse(value);
}
