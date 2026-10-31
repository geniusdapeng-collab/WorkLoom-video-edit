export const EXECUTION_STATUSES = [
  "pending",
  "ready",
  "running",
  "output_ready",
  "completed",
  "failed",
  "interrupted",
] as const;

export const VERIFICATION_STATUSES = [
  "not_run",
  "pending",
  "passed",
  "rejected",
  "unverified",
  "not_applicable",
  "stale",
] as const;

export const DISPOSITIONS = [
  "continue",
  "repair",
  "reconcile",
  "wait_human",
  "blocked",
  "done",
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
export type Disposition = (typeof DISPOSITIONS)[number];

export interface ArtifactRef {
  id: string;
  logicalId: string;
  role: string;
  revision: number;
  schema: string;
  storageRef: string;
  sha256: string;
  bytes: number;
  mediaType: string;
}

export interface ArtifactCreator {
  kind: "model" | "deterministic" | "human" | "provider";
  id: string;
  version: string;
}

export interface ArtifactParent {
  artifactId: string;
  sha256: string;
  role: string;
}

export interface ArtifactEnvelope extends ArtifactRef {
  schemaVersion: "workloom.video-artifact/v1";
  creator: ArtifactCreator;
  parents: ArtifactParent[];
  metadata: Record<string, unknown>;
}

export interface ArtifactEdge {
  runId: string;
  parentArtifactId: string;
  parentSha256: string;
  childArtifactId: string;
  childSha256: string;
  inputRole: string;
}

export type GateAuthority =
  | "deterministic"
  | "llm_review"
  | "human_approval"
  | "system_auto_approval"
  | "external_receipt";
export type GateStatus = "passed" | "rejected" | "unverified" | "not_applicable" | "blocked";
export type GateSeverity = "P0" | "P1" | "P2" | "advisory";
export type RepairClass =
  | "schema"
  | "deterministic"
  | "semantic"
  | "human_input"
  | "no_repair";

export interface GateFinding {
  code: string;
  severity: GateSeverity;
  targetType: "run" | "stage" | "field" | "item" | "artifact";
  targetId: string | null;
  fieldPath: string | null;
  expected: unknown;
  actual: unknown;
  evidenceRefs: string[];
  repairClass: RepairClass;
  blocking: boolean;
}

export interface ReviewerReceipt {
  kind: "host_rule" | "llm_review" | "human_approval" | "system_auto_approval" | "external_receipt";
  id: string;
  model?: string;
  approvalId?: string;
  receiptRef?: string;
  autoApproval?: unknown;
}

export interface EvidenceRef {
  id: string;
  kind: "file" | "event" | "approval" | "provider_receipt" | "rule";
  sha256: string | null;
  ref: string;
}

export interface GateDecision {
  id: string;
  runId: string;
  stageRunId: string;
  gateId: string;
  artifactManifestHash: string;
  planHash: string;
  checkSetVersion: string;
  rubricVersion: string;
  authority?: GateAuthority;
  status: GateStatus;
  reviewer: ReviewerReceipt;
  findings: GateFinding[];
  evidenceRefs: Array<string | EvidenceRef>;
  supersedesDecisionId: string | null;
  createdAt: string;
}

export interface StageRuntimeState {
  stageRunId: string;
  key: string;
  itemKey: string | null;
  revision: number;
  executionStatus: ExecutionStatus;
  verificationStatus: VerificationStatus;
  disposition: Disposition;
  artifact: ArtifactRef | null;
  gateDecisionId: string | null;
  staleReason: string | null;
}

export interface BudgetEnvelope {
  maxAttempts: number;
  maxWallMs: number;
  maxModelTokens: number;
  maxCny: number;
}

export interface RepairPlan {
  id: string;
  runId: string;
  rootDecisionId: string;
  targetStageRunId: string;
  targetRevision: number;
  playbookId: string;
  playbookVersion: string;
  planHash: string;
  findings: GateFinding[];
  allowedChanges: string[];
  forbiddenChanges: string[];
  invalidationClosure: string[];
  budgetEnvelope: BudgetEnvelope;
  requiresApproval: boolean;
  status: "proposed" | "approved" | "running" | "applied" | "rejected" | "stalled";
}

export interface PipelineRunState {
  runId: string;
  projectId: string;
  planHash: string;
  status: "queued" | "running" | "waiting" | "reconciling" | "completed" | "failed" | "cancelled";
  nextAction:
    | "run_node"
    | "wait_approval"
    | "repair"
    | "reconcile"
    | "wait_resource"
    | "manual_fix"
    | "done";
  stages: Record<string, StageRuntimeState>;
}

export interface PipelineCommand<T = Record<string, unknown>> {
  commandId: string;
  idempotencyKey: string;
  actor: {
    id: string;
    type: "human" | "system" | "worker";
  };
  expectedRunRevision: number;
  expectedStageRevision?: number;
  payload: T;
}

export interface PipelineEvent {
  schemaVersion: "workloom.video-pipeline-event/v1";
  eventId: string;
  runId: string;
  projectId: string;
  nodeKey: string;
  revision: number | null;
  kind:
    | "run.started"
    | "node.claimed"
    | "artifact.committed"
    | "gate.decided"
    | "repair.requested"
    | "operation.reserved"
    | "operation.dispatched"
    | "operation.accepted"
    | "operation.failed"
    | "operation.unknown"
    | "node.interrupted"
    | "run.state_changed"
    | "run.completed";
  actor: {
    id: string;
    type: "human" | "system" | "worker";
  };
  at: string;
  inputHashes: string[];
  outputHash: string | null;
  decisionId: string | null;
  operationId: string | null;
  attempt: number;
  cost: Record<string, number | null>;
  metadata: Record<string, unknown>;
}

export interface PipelineOutboxItem {
  id: string;
  tenantId: string;
  workspaceId: string;
  runId: string;
  eventKind: PipelineEvent["kind"];
  payload: Record<string, unknown>;
  publishedAt: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}
