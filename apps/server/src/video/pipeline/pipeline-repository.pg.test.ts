import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifactManifestHash, sha256Json, type ArtifactEnvelope, type ArtifactRef } from "@workloom/pipeline-control";
import {
  compileVideoPipelineDocument,
  loadVideoPipelinePlan,
  type CompiledVideoPipelinePlan,
} from "@hyperreality/video-pipeline";
import { VideoPipelineRepository } from "./pipeline-repository.js";
import { PipelineShadowObserver } from "./shadow.js";

const adminUrl = process.env.WORKLOOM_TEST_ADMIN_URL;
const root = resolve(import.meta.dirname, "../../../../..");
const dbName = `workloom_pipeline_${process.pid}_${Date.now()}`;
const appPassword = process.env.WORKLOOM_TEST_APP_PASSWORD;
const gatewayPassword = process.env.WORKLOOM_TEST_GATEWAY_PASSWORD;
const dbUrl = (name: string, user: string, password: string) => {
  if (!adminUrl) throw new Error("WORKLOOM_TEST_ADMIN_URL missing");
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  url.username = user;
  url.password = password;
  return url.toString();
};

function artifact(
  id: string,
  logicalId: string,
  sha256: string,
  bytes: number,
  storageRef: string,
  parents: ArtifactEnvelope["parents"] = [],
): ArtifactEnvelope {
  return {
    schemaVersion: "workloom.video-artifact/v1",
    id,
    logicalId,
    role: logicalId,
    revision: 1,
    schema: `workloom.video.${logicalId}/v1`,
    storageRef,
    sha256,
    bytes,
    mediaType: "application/json",
    creator: { kind: "deterministic", id: "pg-test", version: "1" },
    parents,
    metadata: {},
  };
}

describe.skipIf(!adminUrl || !appPassword || !gatewayPassword)("video pipeline repository with PostgreSQL", () => {
  let admin: pg.Client;
  let owner: pg.Client;
  let appPool: pg.Pool;
  let workDir: string;
  let repository: VideoPipelineRepository;
  let plan: CompiledVideoPipelinePlan;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    execFileSync(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
      cwd: root,
      env: {
        ...process.env,
        DATABASE_URL: dbUrl(dbName, new URL(adminUrl!).username, decodeURIComponent(new URL(adminUrl!).password)),
        APP_DB_PASSWORD: appPassword!,
        GATEWAY_DB_PASSWORD: gatewayPassword!,
      },
      stdio: "pipe",
      maxBuffer: 20 * 1024 * 1024,
    });
    owner = new pg.Client({ connectionString: dbUrl(
      dbName,
      new URL(adminUrl!).username,
      decodeURIComponent(new URL(adminUrl!).password),
    ) });
    await owner.connect();
    await owner.query(`
      INSERT INTO tenants (id,name) VALUES ('T1','test');
      INSERT INTO workspaces (id,tenant_id,name,slug) VALUES ('W1','T1','test','test-pipeline');
      INSERT INTO video_projects (id,workspace_id,title,kind,created_by)
      VALUES ('P1','W1','test project','marketing','test');
    `);
    workDir = mkdtempSync(join(tmpdir(), "wl-pipeline-pg-"));
    process.env.HR_WORK_DIR = workDir;
    process.env.DATABASE_APP_URL = dbUrl(dbName, "workloom_app", appPassword!);
    process.env.DATABASE_GATEWAY_URL = dbUrl(dbName, "workloom_gateway", gatewayPassword!);
    appPool = new pg.Pool({ connectionString: dbUrl(dbName, "workloom_app", appPassword!), max: 4 });
    repository = new VideoPipelineRepository({ tenantId: "T1", workspaceId: "W1" }, appPool);
    plan = compileVideoPipelineDocument({
      quest: "test-film",
      name: "test-film",
      version: "1",
      steps: [
        { step_key: "source", name: "Source", owner: "worker", outputs: ["dossier"] },
        {
          step_key: "g1", name: "G1", owner: "director", gate: "G1", inputs: ["dossier"],
          outputs: ["dossier"], depends_on: ["source"],
        },
        {
          step_key: "prd", name: "PRD", owner: "writer", inputs: ["dossier"],
          outputs: ["prd"], depends_on: ["g1"],
        },
        {
          step_key: "g4", name: "G4", owner: "director", gate: "G4", inputs: ["prd"],
          outputs: ["prd"], depends_on: ["prd"],
        },
      ],
    }, { knownPipelines: ["test-film"] });
  }, 30_000);

  afterAll(async () => {
    await appPool?.end().catch(() => undefined);
    await owner?.end().catch(() => undefined);
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("runs a source -> G1 -> PRD -> rejected G4 loop without regenerating approved upstream", async () => {
    const intentHash = sha256Json({ intent: "test" });
    const created = await repository.createRun({
      projectId: "P1",
      pipelineKind: "marketing",
      intentContractId: "IC1",
      intentHash,
      createdBy: "test",
      plan,
      idempotencyKey: "start-1",
      commandId: "command-start-1",
      actor: { id: "test", type: "system" },
    });
    expect(created.currentFrontier).toEqual(["source"]);

    const replayed = await repository.createRun({
      projectId: "P1",
      pipelineKind: "marketing",
      intentContractId: "IC1",
      intentHash,
      createdBy: "test",
      plan,
      idempotencyKey: "start-1",
      commandId: "command-start-replay",
      actor: { id: "test", type: "system" },
    });
    expect(replayed.runId).toBe(created.runId);

    const claimedSource = await repository.claimStage({
      plan,
      runId: created.runId,
      stageKey: "source",
      owner: "worker-1",
      commandId: "claim-source",
      idempotencyKey: "claim-source",
      expectedRunRevision: created.revision,
      expectedStageRevision: 1,
      leaseMs: 30_000,
    });
    const sourceArtifactRoot = join(workDir, "archive", "W1", "P1", "artifacts");
    mkdirSync(sourceArtifactRoot, { recursive: true });
    const sourceBytes = Buffer.from('{"dossier":"verified"}\n');
    const sourceStorage = "artifacts/source.json";
    writeFileSync(join(workDir, "archive", "W1", "P1", sourceStorage), sourceBytes);
    const sourceArtifact = artifact(
      "A-SOURCE",
      "dossier",
      createHash("sha256").update(sourceBytes).digest("hex"),
      sourceBytes.length,
      sourceStorage,
    );
    const committedSource = await repository.commitArtifact({
      plan,
      runId: created.runId,
      stageKey: "source",
      artifact: sourceArtifact,
      manifestArtifacts: [sourceArtifact],
      commandId: "commit-source",
      idempotencyKey: "commit-source",
      expectedRunRevision: claimedSource.revision,
      expectedStageRevision: 1,
      actor: { id: "worker-1", type: "worker" },
    });
    const sourceStage = committedSource.run.stages.find((stage) => stage.key === "source")!;
    expect(sourceStage.executionStatus).toBe("output_ready");
    expect(sourceStage.verificationStatus).toBe("pending");

    const g1Ready = await repository.refreshFrontier({
      plan,
      runId: created.runId,
      commandId: "refresh-g1",
      idempotencyKey: "refresh-g1",
      expectedRunRevision: committedSource.run.revision,
      actor: { id: "test", type: "system" },
    });
    const g1Marker = g1Ready.stages.find((stage) => stage.key === "g1")!;
    const g1Decision = {
      id: "GD-G1",
      runId: created.runId,
      stageRunId: sourceStage.stageRunId,
      gateId: "G1",
      artifactManifestHash: artifactManifestHash([sourceArtifact]),
      planHash: plan.planHash,
      checkSetVersion: "g1/v1",
      rubricVersion: "g1/v1",
      status: "passed" as const,
      reviewer: { kind: "host_rule" as const, id: "test" },
      findings: [],
      evidenceRefs: ["evidence:g1"],
      supersedesDecisionId: null,
      createdAt: new Date().toISOString(),
    };
    const g1Passed = await repository.recordGateDecision({
      plan,
      runId: created.runId,
      gateStageKey: "g1",
      decision: g1Decision,
      findings: [],
      manifestArtifacts: [sourceArtifact],
      commandId: "gate-g1",
      idempotencyKey: "gate-g1",
      expectedRunRevision: g1Ready.revision,
      expectedStageRevision: g1Marker.revision,
      actor: { id: "test", type: "system" },
    });
    expect(g1Passed.stages.find((stage) => stage.key === "source")?.verificationStatus).toBe("passed");

    const prdReady = await repository.refreshFrontier({
      plan,
      runId: created.runId,
      commandId: "refresh-prd",
      idempotencyKey: "refresh-prd",
      expectedRunRevision: g1Passed.revision,
      actor: { id: "test", type: "system" },
    });
    const prdStageReady = prdReady.stages.find((stage) => stage.key === "prd")!;
    const claimedPrd = await repository.claimStage({
      plan,
      runId: created.runId,
      stageKey: "prd",
      owner: "worker-2",
      commandId: "claim-prd",
      idempotencyKey: "claim-prd",
      expectedRunRevision: prdReady.revision,
      expectedStageRevision: prdStageReady.revision,
      leaseMs: 30_000,
    });
    const prdBytes = Buffer.from('{"prd":1}\n');
    const prdStorage = "artifacts/prd-v1.json";
    writeFileSync(join(workDir, "archive", "W1", "P1", prdStorage), prdBytes);
    const prdArtifact = artifact(
      "A-PRD-1",
      "prd",
      createHash("sha256").update(prdBytes).digest("hex"),
      prdBytes.length,
      prdStorage,
      [{ artifactId: sourceArtifact.id, sha256: sourceArtifact.sha256, role: "dossier" }],
    );
    const prdCommitted = await repository.commitArtifact({
      plan,
      runId: created.runId,
      stageKey: "prd",
      artifact: prdArtifact,
      manifestArtifacts: [sourceArtifact, prdArtifact],
      commandId: "commit-prd",
      idempotencyKey: "commit-prd",
      expectedRunRevision: claimedPrd.revision,
      expectedStageRevision: prdStageReady.revision,
      actor: { id: "worker-2", type: "worker" },
    });
    const g4Ready = await repository.refreshFrontier({
      plan,
      runId: created.runId,
      commandId: "refresh-g4",
      idempotencyKey: "refresh-g4",
      expectedRunRevision: prdCommitted.run.revision,
      actor: { id: "test", type: "system" },
    });
    const g4Marker = g4Ready.stages.find((stage) => stage.key === "g4")!;
    const prdStage = prdCommitted.run.stages.find((stage) => stage.key === "prd")!;
    const rejected = await repository.recordGateDecision({
      plan,
      runId: created.runId,
      gateStageKey: "g4",
      decision: {
        id: "GD-G4-REJECTED",
        runId: created.runId,
        stageRunId: prdStage.stageRunId,
        gateId: "G4",
        artifactManifestHash: artifactManifestHash([prdArtifact]),
        planHash: plan.planHash,
        checkSetVersion: "g4/v1",
        rubricVersion: "g4/v1",
        status: "rejected",
        reviewer: { kind: "llm_review", id: "reviewer" },
        findings: [{
          code: "G4_DURATION_CONFLICT",
          severity: "P1",
          targetType: "field",
          targetId: "prd.delivery.durationSeconds",
          fieldPath: "$.delivery.durationSeconds",
          expected: 30,
          actual: 31,
          evidenceRefs: ["evidence:g4"],
          repairClass: "deterministic",
          blocking: true,
        }],
        evidenceRefs: ["evidence:g4"],
        supersedesDecisionId: null,
        createdAt: new Date().toISOString(),
      },
      findings: [{
        code: "G4_DURATION_CONFLICT",
        severity: "P1",
        targetType: "field",
        targetId: "prd.delivery.durationSeconds",
        fieldPath: "$.delivery.durationSeconds",
        expected: 30,
        actual: 31,
        evidenceRefs: ["evidence:g4"],
        repairClass: "deterministic",
        blocking: true,
      }],
      manifestArtifacts: [prdArtifact],
      commandId: "gate-g4-rejected",
      idempotencyKey: "gate-g4-rejected",
      expectedRunRevision: g4Ready.revision,
      expectedStageRevision: g4Marker.revision,
      actor: { id: "reviewer", type: "system" },
    });
    expect(rejected.nextAction).toBe("repair");
    expect(rejected.stages.find((stage) => stage.key === "source")?.artifact?.sha256).toBe(sourceArtifact.sha256);
    expect(rejected.stages.find((stage) => stage.key === "g1")?.verificationStatus).toBe("passed");

    await expect(owner.query("UPDATE video_artifacts SET role='rewritten' WHERE id='A-PRD-1'"))
      .rejects.toThrow(/append-only/);
    await expect(owner.query("UPDATE video_gate_decisions SET status='passed' WHERE id='GD-G4-REJECTED'"))
      .rejects.toThrow(/append-only/);

    await owner.query(`
      INSERT INTO video_repair_plans
        (id,tenant_id,workspace_id,pipeline_run_id,root_decision_id,target_stage_run_id,target_revision,
         playbook_id,playbook_version,plan_hash,allowed_changes,forbidden_changes,invalidation_closure,
         budget_envelope,requires_approval,status)
      VALUES
        ('RP-G4','T1','W1',$1,'GD-G4-REJECTED',$2,1,'repair-prd-delivery-fields','1',$3,
         '["$.delivery"]'::jsonb,'["$.facts"]'::jsonb,'["g4"]'::jsonb,
         '{"maxAttempts":2,"maxWallMs":1000,"maxModelTokens":100,"maxCny":0}'::jsonb,false,'proposed')
    `, [created.runId, prdStage.stageRunId, "d".repeat(64)]);
    await owner.query(`
      INSERT INTO video_repair_attempts
        (id,tenant_id,workspace_id,repair_plan_id,attempt,input_manifest_hash,status)
      VALUES ('RA-1','T1','W1','RP-G4',1,$1,'running')
    `, [artifactManifestHash([prdArtifact])]);
    await owner.query(`
      UPDATE video_repair_attempts
         SET status='rejected',findings='[{"code":"G4_DURATION_CONFLICT"}]'::jsonb,finished_at=now()
       WHERE id='RA-1'
    `);
    await expect(owner.query("UPDATE video_repair_attempts SET findings='[]'::jsonb WHERE id='RA-1'"))
      .rejects.toThrow(/terminal receipt is immutable/);

    await owner.query(`
      INSERT INTO tenants (id,name) VALUES ('T2','other');
      INSERT INTO workspaces (id,tenant_id,name,slug) VALUES ('W2','T2','other','test-pipeline-other');
      INSERT INTO video_projects (id,workspace_id,title,kind,created_by)
      VALUES ('P2','W2','other project','marketing','test');
    `);
    await expect(repository.createRun({
      projectId: "P2",
      pipelineKind: "marketing",
      intentContractId: "IC2",
      intentHash: sha256Json({ intent: "other" }),
      createdBy: "test",
      plan,
      idempotencyKey: "cross-scope-start",
      commandId: "cross-scope-start",
      actor: { id: "test", type: "system" },
    })).rejects.toThrow(/项目不存在或不属于当前作用域/);

    await owner.query(`
      INSERT INTO video_projects (id,workspace_id,title,kind,created_by)
      VALUES ('P3','W1','shadow project','marketing','test')
    `);
    const observedPlan = loadVideoPipelinePlan(
      resolve(root, "bundles/ai-video/pipelines/marketing-film.yml"),
      "marketing-film",
    );
    const observer = new PipelineShadowObserver({ tenantId: "T1", workspaceId: "W1" }, "P3", "LEGACY-RUN-1");
    observer.observeGate("G1_DOSSIER");
    observer.observeGate("G2_THEME");
    observer.observeGate("G3_INSIGHT");
    observer.observeGate("G4_PRD");
    const shadowRunId = await observer.finalize({
      success: true,
      pipelineKind: "marketing",
      intent: "shadow test",
      observedGates: [{ gate: "G1_DOSSIER", approved: true }, { gate: "G4_PRD", approved: true }],
      expectedPlan: observedPlan,
    });
    const shadow = await owner.query<{ status: string; next_action: string }>(
      `SELECT status,next_action FROM video_pipeline_runs WHERE id=$1 AND project_id='P3'`,
      [shadowRunId],
    );
    expect(shadow.rows[0]).toEqual({ status: "completed", next_action: "done" });
  }, 60_000);
});
