import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type pg from "pg";
import { getAppPool } from "@workloom/db";
import {
  PipelineControlError,
  artifactManifestHash,
  assertArtifactEnvelope,
  assertSystemAutoApprovalReceipt,
  commandRequestHash,
  parseGateDecision,
  sha256Json,
  type ArtifactEnvelope,
  type ArtifactRef,
  type Disposition,
  type ExecutionStatus,
  type GateDecision,
  type GateFinding,
  type PipelineRunState,
  type StageRuntimeState,
  type VerificationStatus,
} from "@workloom/pipeline-control";
import {
  assertVideoPipelinePlan,
  VIDEO_SYSTEM_AUTO_APPROVAL_POLICY,
  type CompiledNode,
  type CompiledVideoPipelinePlan,
} from "@hyperreality/video-pipeline";
import { archiveWorkDir } from "../archive-host.js";

interface Scope {
  tenantId: string;
  workspaceId: string;
}

interface RunRow extends pg.QueryResultRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  project_id: string;
  pipeline_kind: string;
  intent_contract_id: string;
  intent_hash: string;
  plan_key: string;
  plan_version: string;
  plan_hash: string;
  status: PipelineRunState["status"];
  next_action: PipelineRunState["nextAction"];
  current_frontier: string[];
  revision: string;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface StageRow extends pg.QueryResultRow {
  id: string;
  stage_key: string;
  item_key: string | null;
  revision: number;
  execution_status: ExecutionStatus;
  verification_status: VerificationStatus;
  disposition: Disposition;
  output_manifest_hash: string | null;
  output_artifact_id: string | null;
  gate_decision_id: string | null;
  input_manifest_hash: string;
  artifact_id: string | null;
  artifact_logical_id: string | null;
  artifact_role: string | null;
  artifact_revision: number | null;
  artifact_schema: string | null;
  artifact_storage_ref: string | null;
  artifact_sha256: string | null;
  artifact_bytes: string | number | null;
  artifact_media_type: string | null;
}

export interface PipelineRunView {
  runId: string;
  projectId: string;
  pipelineKind: string;
  planKey: string;
  planVersion: string;
  planHash: string;
  status: PipelineRunState["status"];
  nextAction: PipelineRunState["nextAction"];
  currentFrontier: string[];
  revision: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  stages: StageRuntimeState[];
}

export interface CreatePipelineRunInput {
  projectId: string;
  pipelineKind: "marketing" | "narrative" | "explainer" | "edit" | "whiteboard";
  intentContractId: string;
  intentHash: string;
  createdBy: string;
  plan: CompiledVideoPipelinePlan;
  idempotencyKey: string;
  commandId: string;
  actor: { id: string; type: "human" | "system" | "worker" };
}

export interface CommandEnvelopeInput {
  commandId: string;
  idempotencyKey: string;
  expectedRunRevision: number;
  actor: { id: string; type: "human" | "system" | "worker" };
}

export interface ReconcileCandidate {
  runId: string;
  projectId: string;
  runRevision: number;
  stageRunId: string | null;
  stageKey: string | null;
  reason: "expired_running_lease" | "output_ready_without_decision" | "external_unknown" | "unverified_gate";
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hash(value: unknown): string {
  return sha256Json(value);
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function positiveInt(value: string | number, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new PipelineControlError("PIPELINE_REVISION_INVALID", `${label} 非法`);
  return parsed;
}

function stageKeyOf(node: CompiledNode): string {
  return node.key;
}

function contractHashOf(node: CompiledNode): string {
  return hash(node);
}

function inputManifestHashOf(plan: CompiledVideoPipelinePlan, node: CompiledNode, intentHash: string): string {
  const parents = plan.edges.filter((edge) => edge.to === node.key);
  if (parents.length === 0) return hash({ intentHash });
  return hash(parents.map((edge) => ({ from: edge.from, roles: edge.artifactRoles })));
}

function stageState(row: StageRow): StageRuntimeState {
  return {
    stageRunId: row.id,
    key: row.stage_key,
    itemKey: row.item_key,
    revision: Number(row.revision),
    executionStatus: row.execution_status,
    verificationStatus: row.verification_status,
    disposition: row.disposition,
    artifact: row.artifact_id
      && row.artifact_logical_id
      && row.artifact_role
      && row.artifact_revision !== null
      && row.artifact_schema
      && row.artifact_storage_ref
      && row.artifact_sha256
      && row.artifact_bytes !== null
      && row.artifact_media_type
      ? {
          id: row.artifact_id,
          logicalId: row.artifact_logical_id,
          role: row.artifact_role,
          revision: Number(row.artifact_revision),
          schema: row.artifact_schema,
          storageRef: row.artifact_storage_ref,
          sha256: row.artifact_sha256,
          bytes: Number(row.artifact_bytes),
          mediaType: row.artifact_media_type,
        }
      : null,
    gateDecisionId: row.gate_decision_id,
    staleReason: null,
  };
}

const STAGE_SELECT = `
  SELECT s.id,s.stage_key,s.item_key,s.revision,s.execution_status,s.verification_status,s.disposition,
         s.output_manifest_hash,s.output_artifact_id,s.gate_decision_id,s.input_manifest_hash,
         a.id AS artifact_id,a.logical_id AS artifact_logical_id,a.role AS artifact_role,
         a.revision AS artifact_revision,a.schema_version AS artifact_schema,
         a.storage_ref AS artifact_storage_ref,a.sha256 AS artifact_sha256,
         a.bytes AS artifact_bytes,a.media_type AS artifact_media_type
    FROM production_stage_runs s
    LEFT JOIN video_artifacts a ON a.id=s.output_artifact_id AND a.pipeline_run_id=s.pipeline_run_id
`;

function isSatisfied(stage: StageRuntimeState): boolean {
  return stage.executionStatus === "completed"
    && (stage.verificationStatus === "passed" || stage.verificationStatus === "not_applicable")
    && stage.disposition !== "blocked"
    && stage.disposition !== "repair"
    && stage.disposition !== "reconcile"
    && stage.disposition !== "wait_human";
}

export class VideoPipelineRepository {
  private readonly pool: pg.Pool;

  constructor(
    private readonly scope: Scope,
    pool: pg.Pool = getAppPool(),
  ) {
    this.pool = pool;
  }

  private async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [this.scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [this.scope.tenantId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        discard = true;
        throw new AggregateError([error, rollbackError], "pipeline-repository-rollback-failed");
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }

  private async commandReplay<T>(
    client: pg.PoolClient,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<T | null> {
    const found = await client.query<{
      request_hash: string;
      status: string;
      response_json: T | null;
    }>(
      `SELECT request_hash, status, response_json
         FROM video_pipeline_commands
        WHERE workspace_id=$1 AND idempotency_key=$2`,
      [this.scope.workspaceId, idempotencyKey],
    );
    const row = found.rows[0];
    if (!row) return null;
    if (row.request_hash !== requestHash) {
      throw new PipelineControlError("IDEMPOTENCY_CONFLICT", "相同幂等键已绑定不同请求");
    }
    if (row.status !== "applied" || row.response_json === null) {
      throw new PipelineControlError("COMMAND_OUTCOME_UNKNOWN", "相同命令仍在处理中或缺少已应用回执");
    }
    return row.response_json;
  }

  private async recordCommand(
    client: pg.PoolClient,
    input: {
      id: string;
      runId: string;
      kind: string;
      idempotencyKey: string;
      requestHash: string;
      actor: { id: string; type: "human" | "system" | "worker" };
      expectedRunRevision: number;
      expectedStageRevision?: number;
      response: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO video_pipeline_commands
        (id,tenant_id,workspace_id,run_id,command_kind,idempotency_key,request_hash,actor_id,actor_type,
         expected_run_revision,expected_stage_revision,status,response_json,finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'applied',$12::jsonb,now())`,
      [input.id, this.scope.tenantId, this.scope.workspaceId, input.runId, input.kind,
        input.idempotencyKey, input.requestHash, input.actor.id, input.actor.type,
        input.expectedRunRevision, input.expectedStageRevision ?? null, JSON.stringify(input.response)],
    );
  }

  private async appendOutbox(
    client: pg.PoolClient,
    runId: string,
    eventKind: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const id = `OUT-${hash({ runId, eventKind, payload, at: Date.now(), nonce: Math.random() }).slice(0, 20)}`;
    await client.query(
      `INSERT INTO video_pipeline_outbox (id,tenant_id,workspace_id,run_id,event_kind,payload)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [id, this.scope.tenantId, this.scope.workspaceId, runId, eventKind, JSON.stringify(payload)],
    );
    return id;
  }

  async createRun(input: CreatePipelineRunInput): Promise<PipelineRunView> {
    const plan = assertVideoPipelinePlan(input.plan);
    if (input.plan.planHash.length !== 64 || input.intentHash.length !== 64) {
      throw new PipelineControlError("PIPELINE_HASH_INVALID", "planHash 与 intentHash 必须是 SHA-256");
    }
    const runId = `RUN-${hash({
      workspaceId: this.scope.workspaceId,
      projectId: input.projectId,
      planHash: plan.planHash,
      intentHash: input.intentHash,
    }).slice(0, 24)}`;
    const requestHash = commandRequestHash({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      expectedRunRevision: 1,
      payload: {
        kind: "startPipeline",
        projectId: input.projectId,
        pipelineKind: input.pipelineKind,
        intentContractId: input.intentContractId,
        intentHash: input.intentHash,
        planHash: plan.planHash,
      },
    });
    const response = await this.transaction(async (client) => {
      const replay = await this.commandReplay<PipelineRunView>(client, input.idempotencyKey, requestHash);
      if (replay) return replay;

      const project = await client.query<{ id: string }>(
        `SELECT p.id FROM video_projects p JOIN workspaces w ON w.id=p.workspace_id
          WHERE p.workspace_id=$1 AND p.id=$2 AND w.tenant_id=$3`,
        [this.scope.workspaceId, input.projectId, this.scope.tenantId],
      );
      if (!project.rows[0]) throw new PipelineControlError("PROJECT_NOT_FOUND", "项目不存在或不属于当前作用域");

      const active = await client.query<{ id: string }>(
        `SELECT id FROM video_pipeline_runs
          WHERE workspace_id=$1 AND project_id=$2 AND status IN ('queued','running','waiting','reconciling')`,
        [this.scope.workspaceId, input.projectId],
      );
      if (active.rows[0]) throw new PipelineControlError("PIPELINE_ACTIVE_RUN_EXISTS", `项目已有活动 run ${active.rows[0].id}`);

      const roots = plan.roots;
      await client.query(
        `INSERT INTO video_pipeline_runs
          (id,tenant_id,workspace_id,project_id,pipeline_kind,intent_contract_id,intent_hash,
           plan_key,plan_version,plan_hash,status,next_action,current_frontier,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'running','run_node',$11::jsonb,$12)`,
        [runId, this.scope.tenantId, this.scope.workspaceId, input.projectId, input.pipelineKind,
          input.intentContractId, input.intentHash, plan.key, plan.version, plan.planHash,
          JSON.stringify(roots), input.createdBy],
      );

      for (const node of plan.nodes) {
        const stageRunId = `SR-${hash({ runId, key: node.key }).slice(0, 20)}`;
        const isRoot = roots.includes(node.key);
        await client.query(
          `INSERT INTO production_stage_runs
            (id,workspace_id,project_id,stage_id,attempt,status,run_id,pipeline_run_id,stage_key,item_key,revision,
             contract_version,plan_hash,contract_hash,input_manifest_hash,execution_status,verification_status,disposition)
           VALUES ($1,$2,$3,$4,1,'running',$5,$6,$7,NULL,1,$8,$9,$10,$11,$12,'not_run','continue')`,
          [stageRunId, this.scope.workspaceId, input.projectId, node.key, runId, runId, node.key,
            node.kind === "stage" ? node.contractVersion : `${node.kind}/v1`, plan.planHash,
            contractHashOf(node), inputManifestHashOf(plan, node, input.intentHash),
            isRoot ? "ready" : "pending"],
        );
      }
      await this.appendOutbox(client, runId, "run.started", {
        projectId: input.projectId, planHash: plan.planHash, frontier: roots,
      });
      await this.recordCommand(client, {
        id: input.commandId, runId, kind: "startPipeline", idempotencyKey: input.idempotencyKey,
        requestHash, actor: input.actor, expectedRunRevision: 1,
        response: { runId },
      });
      return (await this.readRunInTransaction(client, runId))!;
    });
    return response;
  }

  private async readRunInTransaction(client: pg.PoolClient, runId: string): Promise<PipelineRunView | null> {
    const run = await client.query<RunRow>(
      `SELECT * FROM video_pipeline_runs WHERE workspace_id=$1 AND id=$2`,
      [this.scope.workspaceId, runId],
    );
    const row = run.rows[0];
    if (!row) return null;
    const stages = await client.query<StageRow>(
      `${STAGE_SELECT}
        WHERE s.workspace_id=$1 AND s.pipeline_run_id=$2
        ORDER BY s.stage_key,s.item_key NULLS FIRST,s.revision`,
      [this.scope.workspaceId, runId],
    );
    return {
      runId: row.id,
      projectId: row.project_id,
      pipelineKind: row.pipeline_kind,
      planKey: row.plan_key,
      planVersion: row.plan_version,
      planHash: row.plan_hash,
      status: row.status,
      nextAction: row.next_action,
      currentFrontier: Array.isArray(row.current_frontier) ? row.current_frontier : [],
      revision: positiveInt(row.revision, "run.revision"),
      leaseOwner: row.lease_owner,
      leaseExpiresAt: iso(row.lease_expires_at),
      stages: stages.rows.map(stageState),
    };
  }

  async getRun(runId: string): Promise<PipelineRunView | null> {
    return this.transaction((client) => this.readRunInTransaction(client, runId));
  }

  async findByIntentContractId(intentContractId: string): Promise<PipelineRunView | null> {
    return this.transaction(async (client) => {
      const rows = await client.query<{ id: string }>(
        `SELECT id FROM video_pipeline_runs
          WHERE workspace_id=$1 AND intent_contract_id=$2
          ORDER BY created_at DESC LIMIT 1`,
        [this.scope.workspaceId, intentContractId],
      );
      const runId = rows.rows[0]?.id;
      return runId ? this.readRunInTransaction(client, runId) : null;
    });
  }

  async listReconcileCandidates(limit = 100): Promise<ReconcileCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new PipelineControlError("PIPELINE_RECONCILE_LIMIT_INVALID", "limit 必须在 1..1000");
    }
    return this.transaction(async (client) => {
      const rows = await client.query<{
        run_id: string;
        project_id: string;
        revision: string;
        stage_run_id: string | null;
        stage_key: string | null;
        reason: ReconcileCandidate["reason"];
      }>(
        `SELECT r.id AS run_id,r.project_id,r.revision,
                s.id AS stage_run_id,s.stage_key,
                CASE
                  WHEN r.status='running'
                   AND (r.lease_expires_at IS NULL OR r.lease_expires_at < now())
                   AND s.execution_status='running' THEN 'expired_running_lease'
                  WHEN s.execution_status='output_ready'
                   AND (s.verification_status='pending' OR s.gate_decision_id IS NULL) THEN 'output_ready_without_decision'
                  WHEN s.disposition='reconcile' THEN 'external_unknown'
                  WHEN s.verification_status='unverified' THEN 'unverified_gate'
                  ELSE NULL
                END AS reason
           FROM video_pipeline_runs r
           LEFT JOIN production_stage_runs s ON s.pipeline_run_id=r.id
          WHERE r.workspace_id=$1
            AND r.status IN ('running','waiting','reconciling','failed')
            AND (
              (r.status='running' AND (r.lease_expires_at IS NULL OR r.lease_expires_at < now()))
              OR s.execution_status='output_ready'
              OR s.disposition='reconcile'
              OR s.verification_status='unverified'
            )
          ORDER BY r.updated_at,s.stage_key
          LIMIT $2`,
        [this.scope.workspaceId, limit],
      );
      return rows.rows
        .filter((row): row is typeof row & { reason: ReconcileCandidate["reason"] } => row.reason !== null)
        .map((row) => ({
          runId: row.run_id,
          projectId: row.project_id,
          runRevision: positiveInt(row.revision, "run.revision"),
          stageRunId: row.stage_run_id,
          stageKey: row.stage_key,
          reason: row.reason,
        }));
    });
  }

  async claimStage(input: {
    plan: CompiledVideoPipelinePlan;
    runId: string;
    stageKey: string;
    itemKey?: string | null;
    owner: string;
    commandId: string;
    idempotencyKey: string;
    expectedRunRevision: number;
    expectedStageRevision: number;
    leaseMs: number;
  }): Promise<PipelineRunView> {
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1) {
      throw new PipelineControlError("PIPELINE_LEASE_INVALID", "leaseMs 必须是正整数");
    }
    const requestHash = commandRequestHash({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      actor: { id: input.owner, type: "worker" },
      expectedRunRevision: input.expectedRunRevision,
      expectedStageRevision: input.expectedStageRevision,
      payload: {
        kind: "claimStage",
        runId: input.runId,
        stageKey: input.stageKey,
        itemKey: input.itemKey ?? null,
        leaseMs: input.leaseMs,
        planHash: input.plan.planHash,
      },
    });
    return this.transaction(async (client) => {
      const replay = await this.commandReplay<PipelineRunView>(client, input.idempotencyKey, requestHash);
      if (replay) return replay;
      const run = await client.query<RunRow>(
        `SELECT * FROM video_pipeline_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [this.scope.workspaceId, input.runId],
      );
      if (!run.rows[0]) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 不存在");
      if (positiveInt(run.rows[0].revision, "run.revision") !== input.expectedRunRevision) {
        throw new PipelineControlError("PIPELINE_REVISION_CONFLICT", "run revision 已变化");
      }
      if (run.rows[0].plan_hash !== input.plan.planHash) {
        throw new PipelineControlError("PIPELINE_PLAN_NOT_CURRENT", "claim 使用的 plan 与 run 不一致");
      }
      if (run.rows[0].lease_owner
        && run.rows[0].lease_owner !== input.owner
        && run.rows[0].lease_expires_at
        && new Date(run.rows[0].lease_expires_at).getTime() > Date.now()) {
        throw new PipelineControlError("PIPELINE_LEASE_BUSY", `项目租约属于 ${run.rows[0].lease_owner}`);
      }
      const node = input.plan.nodes.find((item) => item.key === input.stageKey);
      if (!node) throw new PipelineControlError("PIPELINE_STAGE_UNKNOWN", "stage 不在当前 plan");
      await this.assertDependenciesSatisfied(client, input.runId, node);
      const stage = await client.query<StageRow>(
        `${STAGE_SELECT}
          WHERE s.workspace_id=$1 AND s.pipeline_run_id=$2 AND s.stage_key=$3 AND COALESCE(s.item_key,'')=$4
          ORDER BY s.revision DESC LIMIT 1 FOR UPDATE OF s`,
        [this.scope.workspaceId, input.runId, input.stageKey, input.itemKey ?? ""],
      );
      const row = stage.rows[0];
      if (!row) throw new PipelineControlError("PIPELINE_STAGE_NOT_FOUND", "stage 不存在");
      if (row.revision !== input.expectedStageRevision) throw new PipelineControlError("PIPELINE_STAGE_REVISION_CONFLICT", "stage revision 已变化");
      if (row.execution_status !== "ready") throw new PipelineControlError("PIPELINE_STAGE_NOT_READY", "stage 未 ready");
      const inputs = await this.currentInputArtifacts(
        client,
        input.runId,
        input.stageKey,
        input.plan,
        run.rows[0].intent_hash,
      );
      const leaseExpires = new Date(Date.now() + input.leaseMs);
      await client.query(
        `UPDATE production_stage_runs
            SET execution_status='running',status='running',disposition='continue',worker_version=$4,
                input_manifest_hash=$5,last_heartbeat_at=now()
          WHERE workspace_id=$1 AND pipeline_run_id=$2 AND id=$3`,
        [this.scope.workspaceId, input.runId, row.id, input.owner, inputs.manifestHash],
      );
      await client.query(
        `UPDATE video_pipeline_runs
            SET lease_owner=$3,lease_expires_at=$4,next_action='run_node',revision=revision+1,updated_at=now()
          WHERE workspace_id=$1 AND id=$2`,
        [this.scope.workspaceId, input.runId, input.owner, leaseExpires.toISOString()],
      );
      await this.appendOutbox(client, input.runId, "node.claimed", {
        stageRunId: row.id, stageKey: row.stage_key, owner: input.owner, leaseExpiresAt: leaseExpires.toISOString(),
      });
      await this.recordCommand(client, {
        id: input.commandId, runId: input.runId, kind: "claimStage", idempotencyKey: input.idempotencyKey,
        requestHash, actor: { id: input.owner, type: "worker" }, expectedRunRevision: input.expectedRunRevision,
        expectedStageRevision: input.expectedStageRevision, response: { runId: input.runId, stageRunId: row.id },
      });
      const view = await this.readRunInTransaction(client, input.runId);
      if (!view) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 读取失败");
      return view;
    });
  }

  private artifactRoot(projectId: string): string {
    return path.join(archiveWorkDir(), "archive", this.scope.workspaceId, projectId);
  }

  private verifyArtifact(projectId: string, artifact: ArtifactEnvelope): ArtifactEnvelope {
    const normalized = assertArtifactEnvelope(artifact);
    const root = this.artifactRoot(projectId);
    const full = path.resolve(root, normalized.storageRef);
    if (!full.startsWith(`${path.resolve(root)}${path.sep}`)) throw new PipelineControlError("ARTIFACT_PATH_INVALID", "artifact 路径越出项目档案");
    const entry = lstatSync(full);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new PipelineControlError("ARTIFACT_FILE_INVALID", "artifact 必须是档案根内普通文件，禁止符号链接");
    }
    const realRoot = realpathSync(root);
    const realFile = realpathSync(full);
    if (!realFile.startsWith(`${realRoot}${path.sep}`)) {
      throw new PipelineControlError("ARTIFACT_PATH_INVALID", "artifact 真实路径越出项目档案");
    }
    const bytes = readFileSync(full);
    if (bytes.byteLength !== normalized.bytes) throw new PipelineControlError("ARTIFACT_SIZE_MISMATCH", "artifact bytes 与文件不一致");
    if (sha256(bytes) !== normalized.sha256) throw new PipelineControlError("ARTIFACT_HASH_MISMATCH", "artifact sha256 与文件不一致");
    return normalized;
  }

  private async currentInputArtifacts(
    client: pg.PoolClient,
    runId: string,
    stageKey: string,
    plan: CompiledVideoPipelinePlan,
    intentHash: string,
  ): Promise<{ refs: ArtifactRef[]; manifestHash: string }> {
    const parentKeys = plan.edges.filter((edge) => edge.to === stageKey).map((edge) => edge.from);
    if (parentKeys.length === 0) return { refs: [], manifestHash: hash({ intentHash }) };
    const result = await client.query<{
      id: string;
      logical_id: string;
      role: string;
      revision: number;
      schema_version: string;
      storage_ref: string;
      sha256: string;
      bytes: string;
      media_type: string;
    }>(
      `SELECT DISTINCT ON (s.stage_key)
              a.id,a.logical_id,a.role,a.revision,a.schema_version,a.storage_ref,a.sha256,a.bytes,a.media_type
         FROM production_stage_runs s
         JOIN video_artifacts a ON a.id=s.output_artifact_id
        WHERE s.workspace_id=$1 AND s.pipeline_run_id=$2 AND s.stage_key=ANY($3::text[])
          AND s.execution_status='completed'
          AND s.verification_status IN ('passed','not_applicable')
        ORDER BY s.stage_key,s.revision DESC`,
      [this.scope.workspaceId, runId, parentKeys],
    );
    const refs = result.rows.map((row): ArtifactRef => ({
      id: row.id,
      logicalId: row.logical_id,
      role: row.role,
      revision: Number(row.revision),
      schema: row.schema_version,
      storageRef: row.storage_ref,
      sha256: row.sha256,
      bytes: Number(row.bytes),
      mediaType: row.media_type,
    }));
    return { refs, manifestHash: refs.length > 0 ? artifactManifestHash(refs) : hash({ intentHash }) };
  }

  private async assertDependenciesSatisfied(
    client: pg.PoolClient,
    runId: string,
    node: CompiledNode,
  ): Promise<void> {
    if (node.dependsOn.length === 0) return;
    const result = await client.query<StageRow>(
      `${STAGE_SELECT}
        WHERE s.workspace_id=$1 AND s.pipeline_run_id=$2 AND s.stage_key=ANY($3::text[])
        ORDER BY s.stage_key,s.revision DESC`,
      [this.scope.workspaceId, runId, node.dependsOn],
    );
    const latest = new Map<string, StageRuntimeState>();
    for (const row of result.rows) {
      if (!latest.has(row.stage_key)) latest.set(row.stage_key, stageState(row));
    }
    const blockers = node.dependsOn.filter((dependency) => {
      const state = latest.get(dependency);
      return !state || !isSatisfied(state);
    });
    if (blockers.length > 0) {
      throw new PipelineControlError("PIPELINE_DEPENDENCIES_NOT_READY", `上游未通过：${blockers.join(",")}`);
    }
  }

  async commitArtifact(input: {
    plan: CompiledVideoPipelinePlan;
    runId: string;
    stageKey: string;
    itemKey?: string | null;
    artifact: ArtifactEnvelope;
    manifestArtifacts: ArtifactRef[];
    commandId: string;
    idempotencyKey: string;
    expectedRunRevision: number;
    expectedStageRevision: number;
    actor: { id: string; type: "human" | "system" | "worker" };
  }): Promise<{ run: PipelineRunView; artifactManifestHash: string }> {
    const plan = assertVideoPipelinePlan(input.plan);
    const requestHash = commandRequestHash({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      expectedRunRevision: input.expectedRunRevision,
      expectedStageRevision: input.expectedStageRevision,
      payload: {
        kind: "commitArtifact",
        runId: input.runId,
        stageKey: input.stageKey,
        itemKey: input.itemKey ?? null,
        artifact: input.artifact,
        manifestArtifacts: input.manifestArtifacts,
        planHash: plan.planHash,
      },
    });
    return this.transaction(async (client) => {
      const replay = await this.commandReplay<{ run: PipelineRunView; artifactManifestHash: string }>(
        client, input.idempotencyKey, requestHash,
      );
      if (replay) return replay;
      const run = await client.query<RunRow>(
        `SELECT * FROM video_pipeline_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [this.scope.workspaceId, input.runId],
      );
      const runRow = run.rows[0];
      if (!runRow) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 不存在");
      if (runRow.plan_hash !== plan.planHash) {
        throw new PipelineControlError("PIPELINE_PLAN_NOT_CURRENT", "commit 使用的 plan 与 run 不一致");
      }
      if (positiveInt(runRow.revision, "run.revision") !== input.expectedRunRevision) {
        throw new PipelineControlError("PIPELINE_REVISION_CONFLICT", "run revision 已变化");
      }
      const artifact = this.verifyArtifact(runRow.project_id, input.artifact);
      const manifestHash = artifactManifestHash(input.manifestArtifacts);
      if (!input.manifestArtifacts.some((item) => item.sha256 === artifact.sha256 && item.logicalId === artifact.logicalId)) {
        throw new PipelineControlError("ARTIFACT_MANIFEST_MISSING", "提交产物未包含在 manifest 中");
      }
      const parentRows = await client.query<{
        id: string;
        logical_id: string;
        role: string;
        revision: number;
        schema_version: string;
        storage_ref: string;
        sha256: string;
        bytes: string;
        media_type: string;
      }>(
        `SELECT id,logical_id,role,revision,schema_version,storage_ref,sha256,bytes,media_type
           FROM video_artifacts
          WHERE workspace_id=$1 AND pipeline_run_id=$2 AND id=ANY($3::text[])`,
        [this.scope.workspaceId, input.runId, artifact.parents.map((parent) => parent.artifactId)],
      );
      const parentsById = new Map(parentRows.rows.map((row) => [row.id, row]));
      if (parentRows.rows.length !== new Set(artifact.parents.map((parent) => parent.artifactId)).size) {
        throw new PipelineControlError("ARTIFACT_PARENT_UNKNOWN", "artifact parent 不属于当前 run");
      }
      const parentRefs = artifact.parents.map((parent): ArtifactRef => {
        const row = parentsById.get(parent.artifactId);
        if (!row || row.sha256 !== parent.sha256) {
          throw new PipelineControlError("ARTIFACT_PARENT_MISMATCH", `parent ${parent.artifactId} 摘要不一致`);
        }
        return {
          id: row.id,
          logicalId: row.logical_id,
          role: row.role,
          revision: Number(row.revision),
          schema: row.schema_version,
          storageRef: row.storage_ref,
          sha256: row.sha256,
          bytes: Number(row.bytes),
          mediaType: row.media_type,
        };
      });
      const stage = await client.query<StageRow>(
        `${STAGE_SELECT}
          WHERE s.workspace_id=$1 AND s.pipeline_run_id=$2 AND s.stage_key=$3 AND COALESCE(s.item_key,'')=$4
          ORDER BY s.revision DESC LIMIT 1 FOR UPDATE OF s`,
        [this.scope.workspaceId, input.runId, input.stageKey, input.itemKey ?? ""],
      );
      const stageRow = stage.rows[0];
      if (!stageRow) throw new PipelineControlError("PIPELINE_STAGE_NOT_FOUND", "stage 不存在");
      if (stageRow.revision !== input.expectedStageRevision) throw new PipelineControlError("PIPELINE_STAGE_REVISION_CONFLICT", "stage revision 已变化");
      if (stageRow.execution_status !== "running") throw new PipelineControlError("PIPELINE_STAGE_NOT_RUNNING", "stage 不在运行态");
      const expectedInputManifest = parentRefs.length > 0
        ? artifactManifestHash(parentRefs)
        : hash({ intentHash: runRow.intent_hash });
      if (stageRow.input_manifest_hash !== expectedInputManifest) {
        throw new PipelineControlError("PIPELINE_INPUT_MANIFEST_MISMATCH", "输入 manifest 与 StageRun 冻结值不一致");
      }
      const otherManifestRefs = input.manifestArtifacts.filter((item) => item.id !== artifact.id);
      if (otherManifestRefs.length > 0) {
        const manifestCheck = await client.query<{ id: string; sha256: string }>(
          `SELECT id,sha256 FROM video_artifacts
            WHERE workspace_id=$1 AND pipeline_run_id=$2 AND id=ANY($3::text[])`,
          [this.scope.workspaceId, input.runId, otherManifestRefs.map((item) => item.id)],
        );
        const byId = new Map(manifestCheck.rows.map((row) => [row.id, row.sha256]));
        if (otherManifestRefs.some((item) => byId.get(item.id) !== item.sha256)) {
          throw new PipelineControlError("ARTIFACT_MANIFEST_SCOPE_MISMATCH", "manifest 引用不属于当前 run 或摘要已漂移");
        }
      }
      await client.query(
        `INSERT INTO video_artifacts
          (id,tenant_id,workspace_id,project_id,pipeline_run_id,stage_run_id,logical_id,revision,role,
           schema_version,storage_ref,sha256,bytes,media_type,creator,metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb)`,
        [artifact.id, this.scope.tenantId, this.scope.workspaceId, runRow.project_id, input.runId, stageRow.id,
          artifact.logicalId, artifact.revision, artifact.role, artifact.schema, artifact.storageRef, artifact.sha256,
          artifact.bytes, artifact.mediaType, JSON.stringify(artifact.creator), JSON.stringify(artifact.metadata)],
      );
      for (const parent of artifact.parents) {
        await client.query(
          `INSERT INTO video_artifact_edges
            (tenant_id,workspace_id,pipeline_run_id,parent_artifact_id,parent_sha256,child_artifact_id,child_sha256,input_role)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [this.scope.tenantId, this.scope.workspaceId, input.runId, parent.artifactId, parent.sha256,
            artifact.id, artifact.sha256, parent.role],
        );
      }
      await client.query(
        `UPDATE production_stage_runs
            SET output_ref=$4,output_sha256=$5,output_manifest_hash=$6,output_artifact_id=$7,
                execution_status='output_ready',status='running',verification_status='pending',disposition='continue',
                last_heartbeat_at=now()
          WHERE workspace_id=$1 AND pipeline_run_id=$2 AND id=$3`,
        [this.scope.workspaceId, input.runId, stageRow.id, artifact.storageRef, artifact.sha256, manifestHash, artifact.id],
      );
      const hasDownstreamGate = plan.nodes.some((node) =>
        node.kind === "gate" && node.dependsOn.includes(input.stageKey));
      if (!hasDownstreamGate) {
        await client.query(
          `UPDATE production_stage_runs
              SET execution_status='completed',status='done',verification_status='not_applicable',disposition='continue'
            WHERE workspace_id=$1 AND pipeline_run_id=$2 AND id=$3`,
          [this.scope.workspaceId, input.runId, stageRow.id],
        );
      }
      await client.query(
        `UPDATE video_pipeline_runs
            SET next_action='run_node',revision=revision+1,updated_at=now()
          WHERE workspace_id=$1 AND id=$2`,
        [this.scope.workspaceId, input.runId],
      );
      await this.appendOutbox(client, input.runId, "artifact.committed", {
        stageRunId: stageRow.id, artifactId: artifact.id, artifactSha256: artifact.sha256, artifactManifestHash: manifestHash,
      });
      const response = { runId: input.runId, artifactManifestHash: manifestHash };
      await this.recordCommand(client, {
        id: input.commandId, runId: input.runId, kind: "commitArtifact", idempotencyKey: input.idempotencyKey,
        requestHash, actor: input.actor, expectedRunRevision: input.expectedRunRevision,
        expectedStageRevision: input.expectedStageRevision, response,
      });
      const view = await this.readRunInTransaction(client, input.runId);
      if (!view) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 读取失败");
      return { run: view, artifactManifestHash: manifestHash };
    });
  }

  async recordGateDecision(input: {
    plan: CompiledVideoPipelinePlan;
    runId: string;
    gateStageKey: string;
    decision: GateDecision;
    findings: GateFinding[];
    manifestArtifacts: ArtifactRef[];
    commandId: string;
    idempotencyKey: string;
    expectedRunRevision: number;
    expectedStageRevision: number;
    actor: { id: string; type: "human" | "system" | "worker" };
  }): Promise<PipelineRunView> {
    const plan = assertVideoPipelinePlan(input.plan);
    const decision = parseGateDecision(input.decision);
    const requestHash = commandRequestHash({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      expectedRunRevision: input.expectedRunRevision,
      expectedStageRevision: input.expectedStageRevision,
      payload: {
        kind: "recordGateDecision",
        runId: input.runId,
        gateStageKey: input.gateStageKey,
        decision,
        findings: input.findings,
        manifestArtifacts: input.manifestArtifacts,
        planHash: plan.planHash,
      },
    });
    return this.transaction(async (client) => {
      const replay = await this.commandReplay<PipelineRunView>(client, input.idempotencyKey, requestHash);
      if (replay) return replay;
      const run = await client.query<RunRow>(
        `SELECT * FROM video_pipeline_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [this.scope.workspaceId, input.runId],
      );
      const runRow = run.rows[0];
      if (!runRow) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 不存在");
      if (positiveInt(runRow.revision, "run.revision") !== input.expectedRunRevision) {
        throw new PipelineControlError("PIPELINE_REVISION_CONFLICT", "run revision 已变化");
      }
      if (decision.runId !== input.runId || decision.planHash !== runRow.plan_hash) {
        throw new PipelineControlError("GATE_DECISION_SCOPE_MISMATCH", "GateDecision 未绑定当前 run/plan");
      }
      if (runRow.plan_hash !== plan.planHash) {
        throw new PipelineControlError("PIPELINE_PLAN_NOT_CURRENT", "gate decision 使用的 plan 与 run 不一致");
      }
      const manifestHash = artifactManifestHash(input.manifestArtifacts);
      if (decision.artifactManifestHash !== manifestHash) {
        throw new PipelineControlError("GATE_DECISION_SCOPE_MISMATCH", "GateDecision 未绑定当前 artifact manifest");
      }
      if (sha256Json(decision.findings) !== sha256Json(input.findings)) {
        throw new PipelineControlError("GATE_FINDINGS_MISMATCH", "GateDecision.findings 与持久化 findings 不一致");
      }
      const manifestCheck = await client.query<{ id: string; sha256: string }>(
        `SELECT id,sha256 FROM video_artifacts
          WHERE workspace_id=$1 AND pipeline_run_id=$2 AND id=ANY($3::text[])`,
        [this.scope.workspaceId, input.runId, input.manifestArtifacts.map((item) => item.id)],
      );
      const artifactHashes = new Map(manifestCheck.rows.map((row) => [row.id, row.sha256]));
      if (input.manifestArtifacts.some((artifact) => artifactHashes.get(artifact.id) !== artifact.sha256)) {
        throw new PipelineControlError("GATE_ARTIFACT_STALE", "GateDecision manifest 包含缺失或摘要漂移的 artifact");
      }
      const gateNode = plan.nodes.find((node) => node.key === input.gateStageKey);
      if (!gateNode || gateNode.kind !== "gate") {
        throw new PipelineControlError("PIPELINE_GATE_NODE_UNKNOWN", "gateStageKey 不在当前 plan 或不是 gate");
      }
      if (decision.gateId !== gateNode.gateId
        || decision.checkSetVersion !== gateNode.checkSetVersion
        || decision.rubricVersion !== gateNode.rubricVersion) {
        throw new PipelineControlError("GATE_POLICY_STALE", "GateDecision 与当前 gate policy 不一致");
      }
      const marker = await client.query<StageRow>(
        `${STAGE_SELECT}
          WHERE s.workspace_id=$1 AND s.pipeline_run_id=$2 AND s.stage_key=$3 AND s.item_key IS NULL
          ORDER BY s.revision DESC LIMIT 1 FOR UPDATE OF s`,
        [this.scope.workspaceId, input.runId, input.gateStageKey],
      );
      const markerRow = marker.rows[0];
      if (!markerRow) throw new PipelineControlError("PIPELINE_GATE_STAGE_NOT_FOUND", "gate stage 不存在");
      if (markerRow.revision !== input.expectedStageRevision) throw new PipelineControlError("PIPELINE_STAGE_REVISION_CONFLICT", "gate stage revision 已变化");
      if (markerRow.execution_status !== "ready") {
        throw new PipelineControlError("PIPELINE_GATE_STAGE_NOT_READY", "gate stage 不在 ready");
      }
      const producer = await client.query<StageRow>(
        `${STAGE_SELECT}
          WHERE s.workspace_id=$1 AND s.pipeline_run_id=$2 AND s.id=$3
          FOR UPDATE OF s`,
        [this.scope.workspaceId, input.runId, decision.stageRunId],
      );
      const producerRow = producer.rows[0];
      if (!producerRow) {
        throw new PipelineControlError("GATE_DECISION_SCOPE_MISMATCH", "GateDecision 目标 stage 不存在");
      }
      if (!gateNode.dependsOn.includes(producerRow.stage_key)) {
        throw new PipelineControlError("GATE_DECISION_SCOPE_MISMATCH", "GateDecision 目标 stage 不是当前 gate 的直接输入");
      }
      if (producerRow.execution_status !== "output_ready") {
        throw new PipelineControlError("GATE_TARGET_NOT_OUTPUT_READY", "GateDecision 目标 stage 不是 output_ready");
      }
      if (!input.manifestArtifacts.some((artifact) => artifact.id === producerRow.output_artifact_id
        && artifact.sha256 === producerRow.artifact_sha256)) {
        throw new PipelineControlError("GATE_DECISION_SCOPE_MISMATCH", "GateDecision manifest 不包含目标 stage 当前产物");
      }
      if (decision.authority === "system_auto_approval") {
        if (input.actor.type !== "system" || decision.reviewer.kind !== "system_auto_approval"
          || !decision.reviewer.autoApproval) {
          throw new PipelineControlError("GATE_SYSTEM_ACTOR_REQUIRED", "system auto-approval requires a system actor and exact policy receipt");
        }
        const outcome = decision.status === "passed" ? "passed" : decision.status === "rejected" ? "repair" : "blocked";
        if (!["passed", "rejected", "blocked"].includes(decision.status)) {
          throw new PipelineControlError("GATE_AUTO_STATUS_INVALID", "system auto-approval must be passed, rejected or blocked");
        }
        const receipt = assertSystemAutoApprovalReceipt(decision.reviewer.autoApproval, {
          policyId: VIDEO_SYSTEM_AUTO_APPROVAL_POLICY.id,
          policyVersion: VIDEO_SYSTEM_AUTO_APPROVAL_POLICY.version,
          gateKey: decision.gateId,
          outcome,
        });
        const primaryArtifact = input.manifestArtifacts.find((artifact) => artifact.id === producerRow.output_artifact_id);
        if (!primaryArtifact || receipt.artifactSha256 !== primaryArtifact.sha256) {
          throw new PipelineControlError("GATE_AUTO_ARTIFACT_MISMATCH", "system auto-approval receipt is bound to another artifact");
        }
      } else if (decision.authority === "human_approval" || decision.reviewer.kind === "human_approval") {
        throw new PipelineControlError("VIDEO_HUMAN_REVIEW_DISABLED", "review-capable video gates cannot create or consume human approvals");
      }
      await client.query(
        `INSERT INTO video_gate_decisions
          (id,tenant_id,workspace_id,project_id,pipeline_run_id,stage_run_id,gate_id,artifact_manifest_hash,
           plan_hash,check_set_version,rubric_version,status,reviewer,evidence_refs,supersedes_decision_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16)`,
        [decision.id, this.scope.tenantId, this.scope.workspaceId, runRow.project_id, input.runId,
          producerRow.id, decision.gateId, manifestHash, decision.planHash,
          decision.checkSetVersion, decision.rubricVersion, decision.status,
          JSON.stringify(decision.reviewer), JSON.stringify(decision.evidenceRefs),
          decision.supersedesDecisionId, decision.createdAt],
      );
      for (const finding of input.findings) {
        await client.query(
          `INSERT INTO video_gate_findings
            (id,tenant_id,workspace_id,decision_id,code,severity,target_type,target_id,field_path,expected_value,
             actual_value,evidence_refs,repair_class,blocking)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14)`,
          [`GF-${hash({ decisionId: decision.id, finding }).slice(0, 20)}`, this.scope.tenantId,
            this.scope.workspaceId, decision.id, finding.code, finding.severity, finding.targetType,
            finding.targetId, finding.fieldPath, JSON.stringify(finding.expected ?? null),
            JSON.stringify(finding.actual ?? null), JSON.stringify(finding.evidenceRefs), finding.repairClass, finding.blocking],
        );
      }
      const primaryArtifact = input.manifestArtifacts[0]!;
      const execution = "completed";
      const disposition = decision.status === "passed" || decision.status === "not_applicable"
        ? "continue" : decision.status === "blocked" ? "blocked" : decision.status === "rejected" ? "repair" : "wait_human";
      await client.query(
        `UPDATE production_stage_runs
            SET gate_decision_id=$4,execution_status='completed',verification_status=$5,disposition=$6,
                output_manifest_hash=$7,last_heartbeat_at=now()
          WHERE workspace_id=$1 AND pipeline_run_id=$2 AND id=$3`,
        [this.scope.workspaceId, input.runId, producerRow.id, decision.id, decision.status, disposition, manifestHash],
      );
      await client.query(
        `UPDATE production_stage_runs
            SET output_ref=$4,output_sha256=$5,output_manifest_hash=$6,output_artifact_id=$7,gate_decision_id=$8,
                execution_status=$9,status=$10,verification_status=$11,disposition=$12,last_heartbeat_at=now()
          WHERE workspace_id=$1 AND pipeline_run_id=$2 AND id=$3`,
        [this.scope.workspaceId, input.runId, markerRow.id, primaryArtifact.storageRef, primaryArtifact.sha256,
          manifestHash, primaryArtifact.id, decision.id, execution,
          decision.status === "passed" || decision.status === "not_applicable" ? "done" : "failed",
          decision.status, disposition],
      );
      const nextAction = decision.status === "blocked" ? "manual_fix" : decision.status === "rejected" ? "repair"
        : decision.status === "unverified" ? "reconcile" : "run_node";
      const status = decision.status === "blocked" ? "failed" : decision.status === "rejected" ? "waiting"
        : decision.status === "unverified" ? "reconciling" : "running";
      await client.query(
        `UPDATE video_pipeline_runs
            SET status=$3,next_action=$4,revision=revision+1,lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE workspace_id=$1 AND id=$2`,
        [this.scope.workspaceId, input.runId, status, nextAction],
      );
      await this.appendOutbox(client, input.runId, "gate.decided", {
        stageRunId: markerRow.id, targetStageRunId: producerRow.id, decisionId: decision.id, status: decision.status,
        artifactManifestHash: manifestHash,
      });
      if (decision.authority === "system_auto_approval") {
        await this.appendOutbox(client, input.runId, "system-auto-approval", {
          stageRunId: markerRow.id,
          targetStageRunId: producerRow.id,
          decisionId: decision.id,
          gateKey: decision.gateId,
          reviewer: decision.reviewer,
          evidenceRefs: decision.evidenceRefs,
        });
      }
      await this.recordCommand(client, {
        id: input.commandId, runId: input.runId, kind: "recordGateDecision", idempotencyKey: input.idempotencyKey,
        requestHash, actor: input.actor, expectedRunRevision: input.expectedRunRevision,
        expectedStageRevision: input.expectedStageRevision, response: { runId: input.runId, decisionId: decision.id },
      });
      const view = await this.readRunInTransaction(client, input.runId);
      if (!view) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 读取失败");
      return view;
    });
  }

  async refreshFrontier(input: CommandEnvelopeInput & {
    plan: CompiledVideoPipelinePlan;
    runId: string;
  }): Promise<PipelineRunView> {
    const plan = assertVideoPipelinePlan(input.plan);
    const requestHash = commandRequestHash({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      expectedRunRevision: input.expectedRunRevision,
      payload: { kind: "refreshFrontier", runId: input.runId, planHash: plan.planHash },
    });
    return this.transaction(async (client) => {
      const replay = await this.commandReplay<PipelineRunView>(client, input.idempotencyKey, requestHash);
      if (replay) return replay;
      const run = await client.query<RunRow>(
        `SELECT * FROM video_pipeline_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [this.scope.workspaceId, input.runId],
      );
      const runRow = run.rows[0];
      if (!runRow) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 不存在");
      if (positiveInt(runRow.revision, "run.revision") !== input.expectedRunRevision) {
        throw new PipelineControlError("PIPELINE_REVISION_CONFLICT", "run revision 已变化");
      }
      if (runRow.plan_hash !== plan.planHash) {
        throw new PipelineControlError("PIPELINE_PLAN_NOT_CURRENT", "frontier 使用的 plan 与 run 不一致");
      }
      const stages = await client.query<StageRow>(
        `${STAGE_SELECT}
          WHERE s.workspace_id=$1 AND s.pipeline_run_id=$2
          ORDER BY s.stage_key,s.revision DESC`,
        [this.scope.workspaceId, input.runId],
      );
      const latest = new Map<string, StageRuntimeState>();
      for (const row of stages.rows) {
        if (!latest.has(row.stage_key)) latest.set(row.stage_key, stageState(row));
      }
      const ready: string[] = [];
      const gateDependencyReady = (state: StageRuntimeState | undefined): boolean => Boolean(
        state
        && state.artifact
        && (state.executionStatus === "output_ready"
          || (state.executionStatus === "completed"
            && (state.verificationStatus === "passed" || state.verificationStatus === "not_applicable")))
        && state.disposition !== "blocked"
        && state.disposition !== "reconcile"
        && state.disposition !== "repair"
        && state.disposition !== "wait_human",
      );
      for (const node of plan.nodes) {
        const state = latest.get(node.key);
        if (!state || state.executionStatus !== "pending") continue;
        const dependenciesReady = node.dependsOn.every((dependency) => {
          const dependencyState = latest.get(dependency);
          return node.kind === "gate"
            ? gateDependencyReady(dependencyState)
            : Boolean(dependencyState && isSatisfied(dependencyState));
        });
        if (dependenciesReady) {
          const row = stages.rows.find((item) => item.stage_key === node.key);
          if (!row) continue;
          await client.query(
            `UPDATE production_stage_runs SET execution_status='ready',verification_status='not_run',disposition='continue',status='running'
              WHERE workspace_id=$1 AND pipeline_run_id=$2 AND id=$3`,
            [this.scope.workspaceId, input.runId, row.id],
          );
          const nextState = { ...state, executionStatus: "ready" as const, verificationStatus: "not_run" as const };
          latest.set(node.key, nextState);
          ready.push(node.key);
        }
      }
      const blockers = stages.rows.filter((row) => ["repair","reconcile","wait_human","blocked"].includes(row.disposition));
      const allDone = plan.nodes.every((node) => {
        const state = latest.get(node.key);
        return Boolean(state && isSatisfied(state));
      });
      const nextAction: PipelineRunState["nextAction"] = blockers.some((row) => row.disposition === "repair") ? "repair"
        : blockers.some((row) => row.disposition === "reconcile") ? "reconcile"
          : blockers.some((row) => row.disposition === "wait_human") ? "wait_approval"
            : blockers.length > 0 ? "manual_fix"
              : ready.length > 0 ? "run_node"
                : allDone ? "done" : "wait_resource";
      const status: PipelineRunState["status"] = nextAction === "repair" ? "waiting"
        : nextAction === "reconcile" ? "reconciling"
          : nextAction === "wait_approval" ? "waiting"
            : nextAction === "manual_fix" ? "failed"
              : nextAction === "done" ? "completed" : "running";
      await client.query(
        `UPDATE video_pipeline_runs SET status=$3,next_action=$4,current_frontier=$5::jsonb,revision=revision+1,updated_at=now()
          WHERE workspace_id=$1 AND id=$2`,
        [this.scope.workspaceId, input.runId, status, nextAction, JSON.stringify(ready)],
      );
      await this.appendOutbox(client, input.runId, nextAction === "done" ? "run.completed" : "run.state_changed", {
        command: "refreshFrontier",
        nextAction,
        frontier: ready,
      });
      const response = await this.readRunInTransaction(client, input.runId);
      if (!response) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 读取失败");
      await this.recordCommand(client, {
        id: input.commandId,
        runId: input.runId,
        kind: "refreshFrontier",
        idempotencyKey: input.idempotencyKey,
        requestHash,
        actor: input.actor,
        expectedRunRevision: input.expectedRunRevision,
        response: { runId: input.runId },
      });
      return response;
    });
  }

  async markInterrupted(input: CommandEnvelopeInput & {
    runId: string;
    reason: string;
    owner: string;
  }): Promise<PipelineRunView> {
    const requestHash = commandRequestHash({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      expectedRunRevision: input.expectedRunRevision,
      payload: { kind: "markInterrupted", runId: input.runId, reason: input.reason, owner: input.owner },
    });
    return this.transaction(async (client) => {
      const replay = await this.commandReplay<PipelineRunView>(client, input.idempotencyKey, requestHash);
      if (replay) return replay;
      const run = await client.query<RunRow>(
        `SELECT * FROM video_pipeline_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [this.scope.workspaceId, input.runId],
      );
      const runRow = run.rows[0];
      if (!runRow) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 不存在");
      if (positiveInt(runRow.revision, "run.revision") !== input.expectedRunRevision) {
        throw new PipelineControlError("PIPELINE_REVISION_CONFLICT", "run revision 已变化");
      }
      await client.query(
        `UPDATE production_stage_runs
            SET execution_status='interrupted',verification_status='unverified',disposition='reconcile',
                status='interrupted',error_class='RECONCILE_REQUIRED',error_msg=$4,finished_at=now(),last_heartbeat_at=now()
          WHERE workspace_id=$1 AND pipeline_run_id=$2 AND execution_status='running'`,
        [this.scope.workspaceId, input.runId, input.owner, input.reason.slice(0, 500)],
      );
      await client.query(
        `UPDATE video_pipeline_runs
            SET status='reconciling',next_action='reconcile',lease_owner=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=now()
          WHERE workspace_id=$1 AND id=$2`,
        [this.scope.workspaceId, input.runId],
      );
      await this.appendOutbox(client, input.runId, "node.interrupted", {
        owner: input.owner,
        reason: input.reason,
      });
      const view = await this.readRunInTransaction(client, input.runId);
      if (!view) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 读取失败");
      await this.recordCommand(client, {
        id: input.commandId,
        runId: input.runId,
        kind: "markInterrupted",
        idempotencyKey: input.idempotencyKey,
        requestHash,
        actor: input.actor,
        expectedRunRevision: input.expectedRunRevision,
        response: { runId: input.runId },
      });
      return view;
    });
  }
}
