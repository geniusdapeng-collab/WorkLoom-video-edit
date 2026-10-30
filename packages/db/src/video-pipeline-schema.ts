/**
 * Drizzle type source for the additive video pipeline control-plane tables.
 * Canonical DDL remains packages/db/migrations/0054-0058.
 */
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { tenants, workspaces } from "./schema.js";

export const videoPipelineRuns = pgTable(
  "video_pipeline_runs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    projectId: text("project_id").notNull(),
    pipelineKind: text("pipeline_kind").notNull(),
    intentContractId: text("intent_contract_id").notNull(),
    intentHash: text("intent_hash").notNull(),
    planKey: text("plan_key").notNull(),
    planVersion: text("plan_version").notNull(),
    planHash: text("plan_hash").notNull(),
    status: text("status").notNull().default("queued"),
    nextAction: text("next_action").notNull().default("run_node"),
    currentFrontier: jsonb("current_frontier").notNull().default([]),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_video_pipeline_runs_project").on(t.workspaceId, t.projectId, t.createdAt),
    index("idx_video_pipeline_runs_lease").on(t.leaseExpiresAt),
  ],
);

export const videoPipelineCommands = pgTable(
  "video_pipeline_commands",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    runId: text("run_id").notNull().references(() => videoPipelineRuns.id),
    commandKind: text("command_kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    actorId: text("actor_id").notNull(),
    actorType: text("actor_type").notNull(),
    expectedRunRevision: bigint("expected_run_revision", { mode: "number" }).notNull(),
    expectedStageRevision: bigint("expected_stage_revision", { mode: "number" }),
    status: text("status").notNull().default("queued"),
    responseJson: jsonb("response_json"),
    errorJson: jsonb("error_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [unique("video_pipeline_commands_idempotency").on(t.workspaceId, t.idempotencyKey)],
);

export const videoPipelineOutbox = pgTable(
  "video_pipeline_outbox",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    runId: text("run_id").notNull().references(() => videoPipelineRuns.id),
    eventKind: text("event_kind").notNull(),
    payload: jsonb("payload").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_video_pipeline_outbox_pending").on(t.createdAt)],
);

export const videoArtifacts = pgTable(
  "video_artifacts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    projectId: text("project_id").notNull(),
    pipelineRunId: text("pipeline_run_id").notNull().references(() => videoPipelineRuns.id),
    stageRunId: text("stage_run_id").notNull(),
    logicalId: text("logical_id").notNull(),
    revision: integer("revision").notNull(),
    role: text("role").notNull(),
    schemaVersion: text("schema_version").notNull(),
    storageRef: text("storage_ref").notNull(),
    sha256: text("sha256").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    mediaType: text("media_type").notNull(),
    creator: jsonb("creator").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("video_artifacts_logical_revision_uq").on(t.pipelineRunId, t.logicalId, t.revision),
    unique("video_artifacts_id_sha_uq").on(t.id, t.sha256),
  ],
);

export const videoArtifactEdges = pgTable(
  "video_artifact_edges",
  {
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    pipelineRunId: text("pipeline_run_id").notNull().references(() => videoPipelineRuns.id),
    parentArtifactId: text("parent_artifact_id").notNull(),
    parentSha256: text("parent_sha256").notNull(),
    childArtifactId: text("child_artifact_id").notNull(),
    childSha256: text("child_sha256").notNull(),
    inputRole: text("input_role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.parentArtifactId, t.childArtifactId, t.inputRole] })],
);

export const videoGateDecisions = pgTable(
  "video_gate_decisions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    projectId: text("project_id").notNull(),
    pipelineRunId: text("pipeline_run_id").notNull().references(() => videoPipelineRuns.id),
    stageRunId: text("stage_run_id").notNull(),
    gateId: text("gate_id").notNull(),
    artifactManifestHash: text("artifact_manifest_hash").notNull(),
    planHash: text("plan_hash").notNull(),
    checkSetVersion: text("check_set_version").notNull(),
    rubricVersion: text("rubric_version").notNull(),
    status: text("status").notNull(),
    reviewer: jsonb("reviewer").notNull(),
    evidenceRefs: jsonb("evidence_refs").notNull().default([]),
    supersedesDecisionId: text("supersedes_decision_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("video_gate_decisions_manifest_uq").on(
      t.stageRunId, t.gateId, t.artifactManifestHash, t.checkSetVersion, t.rubricVersion,
    ),
  ],
);

export const videoGateFindings = pgTable(
  "video_gate_findings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    decisionId: text("decision_id").notNull().references(() => videoGateDecisions.id),
    code: text("code").notNull(),
    severity: text("severity").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    fieldPath: text("field_path"),
    expectedValue: jsonb("expected_value"),
    actualValue: jsonb("actual_value"),
    evidenceRefs: jsonb("evidence_refs").notNull().default([]),
    repairClass: text("repair_class").notNull(),
    blocking: boolean("blocking").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("video_gate_findings_code_uq").on(t.decisionId, t.code, t.targetType, t.targetId, t.fieldPath)],
);

export const videoRepairPlans = pgTable(
  "video_repair_plans",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    pipelineRunId: text("pipeline_run_id").notNull().references(() => videoPipelineRuns.id),
    rootDecisionId: text("root_decision_id").notNull().references(() => videoGateDecisions.id),
    targetStageRunId: text("target_stage_run_id").notNull(),
    targetRevision: integer("target_revision").notNull(),
    playbookId: text("playbook_id").notNull(),
    playbookVersion: text("playbook_version").notNull(),
    planHash: text("plan_hash").notNull(),
    allowedChanges: jsonb("allowed_changes").notNull(),
    forbiddenChanges: jsonb("forbidden_changes").notNull(),
    invalidationClosure: jsonb("invalidation_closure").notNull(),
    budgetEnvelope: jsonb("budget_envelope").notNull(),
    requiresApproval: boolean("requires_approval").notNull(),
    status: text("status").notNull().default("proposed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const videoRepairAttempts = pgTable(
  "video_repair_attempts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    repairPlanId: text("repair_plan_id").notNull().references(() => videoRepairPlans.id),
    attempt: integer("attempt").notNull(),
    inputManifestHash: text("input_manifest_hash").notNull(),
    outputArtifactId: text("output_artifact_id").references(() => videoArtifacts.id),
    status: text("status").notNull(),
    errorClass: text("error_class"),
    findings: jsonb("findings").notNull().default([]),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [unique("video_repair_attempts_attempt_uq").on(t.repairPlanId, t.attempt)],
);

export const videoDeliveryRevisionJobs = pgTable(
  "video_delivery_revision_jobs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    projectId: text("project_id").notNull(),
    pipelineRunId: text("pipeline_run_id").references(() => videoPipelineRuns.id),
    stageRunId: text("stage_run_id"),
    packageDir: text("package_dir").notNull(),
    expectedVersion: integer("expected_version").notNull(),
    expectedProjectSha256: text("expected_project_sha256").notNull(),
    patchHash: text("patch_hash").notNull(),
    patch: jsonb("patch").notNull(),
    status: text("status").notNull().default("queued"),
    version: integer("version"),
    outDir: text("out_dir"),
    logPath: text("log_path").notNull(),
    exitCode: integer("exit_code"),
    errorClass: text("error_class"),
    errorMsg: text("error_msg"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [unique("video_delivery_revision_idempotency").on(t.workspaceId, t.idempotencyKey)],
);
