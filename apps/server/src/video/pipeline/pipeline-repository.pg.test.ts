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
  evaluateVideoSystemAutoApproval,
  loadVideoPipelinePlan,
  type CompiledVideoPipelinePlan,
} from "@hyperreality/video-pipeline";
import { VideoPipelineRepository } from "./pipeline-repository.js";
import { VideoPipelineReconciler } from "./reconciler.js";
import { PipelineShadowObserver } from "./shadow.js";
import { closeAllPools } from "@workloom/db";
import { makeLedgerWriter, markProjectInterrupted } from "../archive-host.js";
import { readStageBreakpoints, resumeProject, scanStaleRunsOnStartup } from "../archive-resume.js";

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
    process.env.DATABASE_URL = dbUrl(dbName, new URL(adminUrl!).username, decodeURIComponent(new URL(adminUrl!).password));
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
    await closeAllPools();
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

  it("persists a passed system-auto-approval receipt without creating an approval row", async () => {
    await owner.query(`
      INSERT INTO video_projects (id,workspace_id,title,kind,created_by)
      VALUES ('P4','W1','auto approval','marketing','test')
    `);
    const autoPlan = compileVideoPipelineDocument({
      quest: "auto-approval-film",
      name: "auto approval film",
      version: "1",
      steps: [
        { step_key: "source", name: "Source", owner: "worker", outputs: ["dossier"] },
        {
          step_key: "g1", name: "G1", owner: "director", gate: "G1",
          inputs: ["dossier"], outputs: ["dossier"], depends_on: ["source"],
        },
      ],
    }, { knownPipelines: ["auto-approval-film"] });
    const run = await repository.createRun({
      projectId: "P4",
      pipelineKind: "marketing",
      intentContractId: "IC-AUTO",
      intentHash: sha256Json({ intent: "auto approval" }),
      createdBy: "test",
      plan: autoPlan,
      idempotencyKey: "auto-start",
      commandId: "auto-start-command",
      actor: { id: "test", type: "system" },
    });
    const claimed = await repository.claimStage({
      plan: autoPlan,
      runId: run.runId,
      stageKey: "source",
      owner: "worker-auto",
      commandId: "auto-claim",
      idempotencyKey: "auto-claim",
      expectedRunRevision: run.revision,
      expectedStageRevision: 1,
      leaseMs: 30_000,
    });
    const bytes = Buffer.from('{"dossier":"auto"}\n');
    const storageRef = "artifacts/auto-source.json";
    mkdirSync(join(workDir, "archive", "W1", "P4", "artifacts"), { recursive: true });
    writeFileSync(join(workDir, "archive", "W1", "P4", storageRef), bytes);
    const source = artifact("A-AUTO-SOURCE", "dossier", createHash("sha256").update(bytes).digest("hex"), bytes.length, storageRef);
    const committed = await repository.commitArtifact({
      plan: autoPlan,
      runId: run.runId,
      stageKey: "source",
      artifact: source,
      manifestArtifacts: [source],
      commandId: "auto-commit",
      idempotencyKey: "auto-commit",
      expectedRunRevision: claimed.revision,
      expectedStageRevision: 1,
      actor: { id: "worker-auto", type: "worker" },
    });
    const gateReady = await repository.refreshFrontier({
      plan: autoPlan,
      runId: run.runId,
      commandId: "auto-refresh-gate",
      idempotencyKey: "auto-refresh-gate",
      expectedRunRevision: committed.run.revision,
      actor: { id: "test", type: "system" },
    });
    const marker = gateReady.stages.find((stage) => stage.key === "g1")!;
    const artifactManifest = artifactManifestHash([source]);
    const auto = evaluateVideoSystemAutoApproval(true, {
      gateKey: "G1",
      action: "g1.confirm",
      artifactSha256: source.sha256,
      factHash: source.sha256,
      expectedFactHash: source.sha256,
      deterministicChecks: [{
        id: "schema-current",
        category: "deterministic",
        status: "passed",
        detail: "current artifact matches the deterministic schema",
        evidenceRef: source.storageRef,
      }],
      budget: { status: "passed", detail: "budget remains bounded", evidenceRef: "budget:auto" },
      qualification: { status: "passed", detail: "qualification token matches", evidenceRef: "qualification:auto" },
      permission: { status: "passed", detail: "workspace scope matches", evidenceRef: "permission:auto" },
      fence: { status: "passed", level: "review", detail: "review fence can be converted", evidenceRef: "fence:G1" },
      evidenceRefs: [{ id: "source", kind: "file", sha256: source.sha256, ref: source.storageRef }],
    });
    expect(auto.outcome).toBe("passed");
    const gateNode = autoPlan.nodes.find((node) => node.key === "g1");
    if (!gateNode || gateNode.kind !== "gate") throw new Error("compiled G1 gate missing");
    const decision = {
      id: "GD-AUTO-G1",
      runId: run.runId,
      stageRunId: committed.run.stages.find((stage) => stage.key === "source")!.stageRunId,
      gateId: "G1",
      artifactManifestHash: artifactManifest,
      planHash: autoPlan.planHash,
      checkSetVersion: gateNode.checkSetVersion,
      rubricVersion: gateNode.rubricVersion,
      authority: "system_auto_approval" as const,
      status: "passed" as const,
      reviewer: {
        kind: "system_auto_approval" as const,
        id: auto.receipt.evidenceDigest,
        autoApproval: auto.receipt,
      },
      findings: [],
      evidenceRefs: auto.receipt.evidenceRefs,
      supersedesDecisionId: null,
      createdAt: new Date().toISOString(),
    };
    const passed = await repository.recordGateDecision({
      plan: autoPlan,
      runId: run.runId,
      gateStageKey: "g1",
      decision,
      findings: [],
      manifestArtifacts: [source],
      commandId: "auto-gate",
      idempotencyKey: "auto-gate",
      expectedRunRevision: gateReady.revision,
      expectedStageRevision: marker.revision,
      actor: { id: "video-system-auto-approval", type: "system" },
    });
    expect(passed.stages.find((stage) => stage.key === "source")?.verificationStatus).toBe("passed");
    const outbox = await owner.query(
      "SELECT event_kind FROM video_pipeline_outbox WHERE run_id=$1 ORDER BY created_at",
      [run.runId],
    );
    expect(outbox.rows.some((row) => row.event_kind === "system-auto-approval")).toBe(true);
    const approvals = await owner.query("SELECT count(*)::int AS n FROM approvals WHERE workspace_id='W1'");
    expect(approvals.rows[0]?.n).toBe(0);
  }, 60_000);

  async function startIntegrityRun(projectId: string, selectedPlan = plan) {
    await owner.query(
      "INSERT INTO video_projects (id,workspace_id,title,kind,created_by) VALUES ($1,'W1',$1,'marketing','test')",
      [projectId],
    );
    return {
      projectId,
      pipelineKind: "marketing" as const,
      intentContractId: projectId,
      intentHash: sha256Json({ projectId }),
      createdBy: "test",
      plan: selectedPlan,
      idempotencyKey: `${projectId}:start`,
      commandId: `${projectId}:start`,
      actor: { id: "system", type: "system" as const },
    };
  }

  function writeFixtureArtifact(projectId: string, id: string, logicalId = "dossier") {
    const content = "{}\n";
    const storageRef = `artifacts/${id}.json`;
    const projectRoot = join(workDir, "archive", "W1", projectId);
    mkdirSync(join(projectRoot, "artifacts"), { recursive: true });
    writeFileSync(join(projectRoot, storageRef), content);
    return artifact(id, logicalId, createHash("sha256").update(content).digest("hex"), Buffer.byteLength(content), storageRef);
  }

  it("replays the full original response of all mutation commands after later revisions", async () => {
    const start = await startIntegrityRun("P-replay");
    const [created, concurrentReplay] = await Promise.all([repository.createRun(start), repository.createRun(start)]);
    expect(concurrentReplay).toEqual(created);
    const claim = {
      plan, runId: created.runId, stageKey: "source", owner: "replay-worker",
      commandId: "replay-claim", idempotencyKey: "replay-claim",
      expectedRunRevision: created.revision, expectedStageRevision: 1, leaseMs: 30_000,
    };
    const [claimed, claimReplay] = await Promise.all([repository.claimStage(claim), repository.claimStage(claim)]);
    expect(claimReplay).toEqual(claimed);
    const source = writeFixtureArtifact(start.projectId, "A-REPLAY");
    const commit = {
      plan, runId: created.runId, stageKey: "source", artifact: source, manifestArtifacts: [source],
      commandId: "replay-commit", idempotencyKey: "replay-commit",
      expectedRunRevision: claimed.revision, expectedStageRevision: 1,
      actor: { id: claim.owner, type: "worker" as const },
    };
    const committed = await repository.commitArtifact(commit);
    const refresh = {
      plan, runId: created.runId, commandId: "replay-refresh", idempotencyKey: "replay-refresh",
      expectedRunRevision: committed.run.revision, actor: start.actor,
    };
    const refreshed = await repository.refreshFrontier(refresh);
    const stage = committed.run.stages.find((value) => value.key === "source")!;
    const gate = {
      plan, runId: created.runId, gateStageKey: "g1", commandId: "replay-gate", idempotencyKey: "replay-gate",
      expectedRunRevision: refreshed.revision, expectedStageRevision: 1, actor: start.actor,
      findings: [], manifestArtifacts: [source],
      decision: {
        id: "GD-REPLAY", runId: created.runId, stageRunId: stage.stageRunId, gateId: "G1",
        artifactManifestHash: artifactManifestHash([source]), planHash: plan.planHash,
        checkSetVersion: "g1/v1", rubricVersion: "g1/v1", status: "passed" as const,
        reviewer: { kind: "host_rule" as const, id: "test" }, findings: [],
        evidenceRefs: ["fixture:g1"], supersedesDecisionId: null, createdAt: new Date().toISOString(),
      },
    };
    const decided = await repository.recordGateDecision(gate);
    const interrupted = await repository.markInterrupted({
      runId: created.runId, commandId: "replay-interrupt", idempotencyKey: "replay-interrupt",
      expectedRunRevision: decided.revision, actor: start.actor, reason: "fixture", owner: "test",
    });
    expect(await repository.createRun(start)).toEqual(created);
    expect(await repository.claimStage(claim)).toEqual(claimed);
    expect(await repository.commitArtifact(commit)).toEqual(committed);
    expect(await repository.refreshFrontier(refresh)).toEqual(refreshed);
    expect(await repository.recordGateDecision(gate)).toEqual(decided);
    expect(await repository.markInterrupted({
      runId: created.runId, commandId: "replay-interrupt", idempotencyKey: "replay-interrupt",
      expectedRunRevision: decided.revision, actor: start.actor, reason: "fixture", owner: "test",
    })).toEqual(interrupted);
    await expect(repository.claimStage({ ...claim, leaseMs: 42 })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const counts = await owner.query(
      `SELECT (SELECT count(*)::int FROM video_pipeline_commands WHERE run_id=$1) AS commands,
              (SELECT count(*)::int FROM video_pipeline_outbox WHERE run_id=$1) AS events,
              (SELECT count(*)::int FROM video_artifacts WHERE pipeline_run_id=$1) AS artifacts`,
      [created.runId],
    );
    expect(counts.rows[0]).toEqual({ commands: 6, events: 6, artifacts: 1 });

    await owner.query(
      "UPDATE video_pipeline_commands SET response_json=$2::jsonb WHERE id=$1",
      [commit.commandId, JSON.stringify({ runId: created.runId, artifactManifestHash: committed.artifactManifestHash })],
    );
    expect(await repository.commitArtifact(commit)).toEqual({ run: interrupted, artifactManifestHash: committed.artifactManifestHash });
    await owner.query(
      "UPDATE video_pipeline_commands SET response_json=$2::jsonb WHERE id=$1",
      [start.commandId, JSON.stringify({ runId: created.runId })],
    );
    expect(await repository.createRun(start)).toEqual(interrupted);
  });

  it("keeps an already ready stage in the recomputed frontier", async () => {
    const start = await startIntegrityRun("P-frontier");
    const created = await repository.createRun(start);
    const refreshed = await repository.refreshFrontier({
      plan, runId: created.runId, commandId: "ready-refresh", idempotencyKey: "ready-refresh",
      expectedRunRevision: created.revision, actor: start.actor,
    });
    expect(refreshed.stages.find((stage) => stage.key === "source")?.executionStatus).toBe("ready");
    expect(refreshed.currentFrontier).toEqual(["source"]);
    expect(refreshed.nextAction).toBe("run_node");
  });

  it.each(["wrong-owner", "expired-owner"])("rejects a %s artifact writer and rolls back all effects", async (mode) => {
    const start = await startIntegrityRun(`P-${mode}`);
    const created = await repository.createRun(start);
    const claimed = await repository.claimStage({
      plan, runId: created.runId, stageKey: "source", owner: "lease-worker",
      commandId: `${mode}:claim`, idempotencyKey: `${mode}:claim`,
      expectedRunRevision: created.revision, expectedStageRevision: 1, leaseMs: 30_000,
    });
    if (mode === "expired-owner") {
      await owner.query("UPDATE video_pipeline_runs SET lease_expires_at=clock_timestamp() - interval '1 second' WHERE id=$1", [created.runId]);
    }
    const source = writeFixtureArtifact(start.projectId, `A-${mode}`);
    await expect(repository.commitArtifact({
      plan, runId: created.runId, stageKey: "source", artifact: source, manifestArtifacts: [source],
      commandId: `${mode}:commit`, idempotencyKey: `${mode}:commit`,
      expectedRunRevision: claimed.revision, expectedStageRevision: 1,
      actor: { id: mode === "wrong-owner" ? "another-worker" : "lease-worker", type: "worker" },
    })).rejects.toMatchObject({ code: "PIPELINE_LEASE_NOT_OWNED" });
    expect((await repository.getRun(created.runId))?.revision).toBe(claimed.revision);
    expect((await owner.query("SELECT id FROM video_artifacts WHERE id=$1", [source.id])).rowCount).toBe(0);
    expect((await owner.query("SELECT id FROM video_pipeline_commands WHERE id=$1", [`${mode}:commit`])).rowCount).toBe(0);
  });

  it("marks running work interrupted and hands the expired lease to reconciliation", async () => {
    const start = await startIntegrityRun("P-interrupt");
    const created = await repository.createRun(start);
    const claimed = await repository.claimStage({
      plan, runId: created.runId, stageKey: "source", owner: "interrupted-worker",
      commandId: "interrupted-claim", idempotencyKey: "interrupted-claim",
      expectedRunRevision: created.revision, expectedStageRevision: 1, leaseMs: 30_000,
    });
    await owner.query("UPDATE video_pipeline_runs SET lease_expires_at=clock_timestamp() - interval '1 second' WHERE id=$1", [created.runId]);
    expect(await repository.listReconcileCandidates()).toContainEqual(expect.objectContaining({
      runId: created.runId, reason: "expired_running_lease",
    }));
    const interrupted = await repository.markInterrupted({
      runId: created.runId, commandId: "interrupt-running", idempotencyKey: "interrupt-running",
      expectedRunRevision: claimed.revision, actor: start.actor, reason: "fixture expiry", owner: "reconciler",
    });
    expect(interrupted.leaseOwner).toBeNull();
    expect(interrupted.nextAction).toBe("reconcile");
    expect(interrupted.stages.find((stage) => stage.key === "source")).toMatchObject({
      executionStatus: "interrupted", verificationStatus: "unverified", disposition: "reconcile",
    });
  });

  it("preserves a live sibling claim when a gate resolves and fences expired takeover", async () => {
    const parallel = compileVideoPipelineDocument({
      quest: "parallel-film", name: "parallel film", version: "1",
      steps: [
        { step_key: "source", name: "Source", owner: "worker", outputs: ["dossier"] },
        { step_key: "sibling", name: "Sibling", owner: "worker", outputs: ["report"] },
        { step_key: "available", name: "Available", owner: "worker", outputs: ["report"] },
        { step_key: "g1", name: "G1", owner: "director", gate: "G1", inputs: ["dossier"],
          outputs: ["dossier"], depends_on: ["source"] },
      ],
    }, { knownPipelines: ["parallel-film"] });
    const start = await startIntegrityRun("P-parallel", parallel);
    const created = await repository.createRun(start);
    const claim = (stageKey: string, expectedRunRevision: number, owner = "parallel-worker") => repository.claimStage({
      plan: parallel, runId: created.runId, stageKey, owner,
      commandId: `parallel-claim:${stageKey}:${owner}`, idempotencyKey: `parallel-claim:${stageKey}:${owner}`,
      expectedRunRevision, expectedStageRevision: 1, leaseMs: 30_000,
    });
    const claimedSource = await claim("source", created.revision);
    const claimedSibling = await claim("sibling", claimedSource.revision);
    const commit = (stageKey: string, expectedRunRevision: number) => {
      const source = writeFixtureArtifact(start.projectId, `A-parallel-${stageKey}`, stageKey === "source" ? "dossier" : "report");
      return repository.commitArtifact({
        plan: parallel, runId: created.runId, stageKey, artifact: source, manifestArtifacts: [source],
        commandId: `parallel-commit:${stageKey}`, idempotencyKey: `parallel-commit:${stageKey}`,
        expectedRunRevision, expectedStageRevision: 1, actor: { id: "parallel-worker", type: "worker" },
      });
    };
    const committed = await commit("source", claimedSibling.revision);
    const refreshed = await repository.refreshFrontier({
      plan: parallel, runId: created.runId, commandId: "parallel-refresh", idempotencyKey: "parallel-refresh",
      expectedRunRevision: committed.run.revision, actor: start.actor,
    });
    const stage = committed.run.stages.find((value) => value.key === "source")!;
    const decided = await repository.recordGateDecision({
      plan: parallel, runId: created.runId, gateStageKey: "g1", commandId: "parallel-gate", idempotencyKey: "parallel-gate",
      expectedRunRevision: refreshed.revision, expectedStageRevision: 1, actor: start.actor,
      findings: [], manifestArtifacts: [stage.artifact!],
      decision: {
        id: "GD-PARALLEL", runId: created.runId, stageRunId: stage.stageRunId, gateId: "G1",
        artifactManifestHash: committed.artifactManifestHash, planHash: parallel.planHash,
        checkSetVersion: "g1/v1", rubricVersion: "g1/v1", status: "passed",
        reviewer: { kind: "host_rule", id: "test" }, findings: [],
        evidenceRefs: ["fixture:g1"], supersedesDecisionId: null, createdAt: new Date().toISOString(),
      },
    });
    expect(decided.leaseOwner).toBe("parallel-worker");
    await expect(claim("available", decided.revision, "other-worker")).rejects.toMatchObject({ code: "PIPELINE_LEASE_BUSY" });
    const expiredAt = new Date(Date.now() - 1000).toISOString();
    await owner.query("UPDATE video_pipeline_runs SET lease_expires_at=$2 WHERE id=$1", [created.runId, expiredAt]);
    for (const worker of ["parallel-worker", "other-worker"]) {
      await expect(claim("available", decided.revision, worker)).rejects.toMatchObject({ code: "PIPELINE_LEASE_RECONCILE_REQUIRED" });
    }
    await owner.query("UPDATE video_pipeline_runs SET lease_expires_at=clock_timestamp() + interval '30 seconds' WHERE id=$1", [created.runId]);
    const completedSibling = await commit("sibling", decided.revision);
    expect(completedSibling.run.leaseOwner).toBeNull();
    expect((await claim("available", completedSibling.run.revision, "other-worker")).leaseOwner).toBe("other-worker");
    const retry = await startIntegrityRun("P-parallel-reconcile", parallel);
    const retryRun = await repository.createRun(retry);
    let revision = retryRun.revision;
    for (const stageKey of ["source", "sibling"]) {
      revision = (await repository.claimStage({
        plan: parallel, runId: retryRun.runId, stageKey, owner: "reconcile-fixture",
        commandId: `parallel-reconcile:${stageKey}`, idempotencyKey: `parallel-reconcile:${stageKey}`,
        expectedRunRevision: revision, expectedStageRevision: 1, leaseMs: 30_000,
      })).revision;
    }
    await owner.query(
      "UPDATE video_pipeline_runs SET status='waiting',lease_expires_at=$2 WHERE id=$1",
      [retryRun.runId, expiredAt],
    );
    const outcomes = await new VideoPipelineReconciler(repository, "startup-fixture").scan();
    expect(outcomes.filter((item) => item.candidate.runId === retryRun.runId)).toHaveLength(2);
    const reconciled = await repository.getRun(retryRun.runId);
    expect(reconciled?.revision).toBe(revision + 1);
    expect(reconciled?.stages.filter((stage) => stage.executionStatus === "interrupted")).toHaveLength(2);

  });

  it("isolates legacy claim, heartbeat and finish from control rows with identical stage and attempt", async () => {
    const start = await startIntegrityRun("P-ledger-isolation");
    const run = await repository.createRun(start);
    const scope = { tenantId: "T1", workspaceId: "W1" };
    const stageId = "source";
    const controlId = run.stages.find((stage) => stage.key === stageId)!.stageRunId;
    const ledger = makeLedgerWriter(scope);
    expect(await ledger.nextAttempt(start.projectId, stageId)).toBe(1);
    expect(await ledger.claimRun({
      id: "legacy-claim", projectId: start.projectId, stageId,
      inputRefTemplate: "stages/source/attempt-{attempt}.input.json", runId: "legacy-run",
    })).toEqual({ attempt: 1, inputRef: "stages/source/attempt-1.input.json" });
    await ledger.heartbeatRun?.({ projectId: start.projectId, stageId, attempt: 1 });
    await ledger.finishRun({
      projectId: start.projectId, stageId, attempt: 1, status: "done",
      outputRef: "stages/source/attempt-1.output.json", outputSha256: "a".repeat(64),
      durationMs: 1, errorClass: null, errorMsg: null, cost: {},
    });
    const rows = await owner.query(
      `SELECT id,status,execution_status,last_heartbeat_at,output_ref FROM production_stage_runs
        WHERE id IN ($1,'legacy-claim')`,
      [controlId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(Object.fromEntries(rows.rows.map((row) => [row.id, row]))).toEqual({
      [controlId]: { id: controlId, status: "running", execution_status: "ready", last_heartbeat_at: null, output_ref: null },
      "legacy-claim": { id: "legacy-claim", status: "done", execution_status: null, last_heartbeat_at: expect.any(Date),
        output_ref: "stages/source/attempt-1.output.json" },
    });
    expect(await ledger.nextAttempt(start.projectId, stageId)).toBe(2);
    expect(await readStageBreakpoints(scope, start.projectId)).toEqual([]);
  });

  it.each(["mark", "resume", "startup"])("keeps control rows intact during legacy %s", async (operation) => {
    const start = await startIntegrityRun(`P-legacy-${operation}`);
    const run = await repository.createRun(start);
    const scope = { tenantId: "T1", workspaceId: "W1" };
    const controlId = run.stages.find((stage) => stage.key === "source")!.stageRunId;
    const legacyId = `legacy-${operation}`;
    await owner.query(
      `INSERT INTO production_stage_runs (id,workspace_id,project_id,stage_id,attempt,status,run_id,started_at)
        VALUES ($1,'W1',$2,'source',1,'running',$1,clock_timestamp() - interval '3 hours')`,
      [legacyId, start.projectId],
    );
    const readRows = () => owner.query(
      `SELECT id,status,execution_status,finished_at FROM production_stage_runs
        WHERE id IN ($1,$2)`,
      [controlId, legacyId],
    );
    if (operation === "mark") {
      expect(await markProjectInterrupted(scope, start.projectId)).toBe(1);
    } else if (operation === "resume") {
      const result = await resumeProject(scope, {
        projectId: start.projectId, actor: start.actor,
        startRun: () => { throw new Error("fixture must never start a worker"); },
      });
      expect(result).toMatchObject({ kind: "noaction", stage: "source" });
    } else {
      await owner.query("BEGIN");
      try {
        await owner.query("SELECT set_config('app.workspace_id','W1',true),set_config('app.tenant_id','T1',true)");
        await owner.query(
          "UPDATE production_stage_runs SET started_at=clock_timestamp() - interval '3 hours' WHERE id=$1",
          [controlId],
        );
        await owner.query("COMMIT");
      } catch (error) {
        await owner.query("ROLLBACK");
        throw error;
      }
      const report = await scanStaleRunsOnStartup({ ARCHIVE_AUTO_RESUME: "1", ARCHIVE_STALE_RUNNING_MIN: "10" });
      expect(report.interrupted.filter((item) => item.projectId === start.projectId)).toHaveLength(1);
    }
    const { rows } = await readRows();
    expect(rows).toHaveLength(2);
    expect(Object.fromEntries(rows.map((row) => [row.id, row]))).toEqual({
      [controlId]: { id: controlId, status: "running", execution_status: "ready", finished_at: null },
      [legacyId]: { id: legacyId, status: "interrupted", execution_status: null, finished_at: expect.any(Date) },
    });
    expect(await readStageBreakpoints(scope, start.projectId)).toEqual([
      expect.objectContaining({ stageId: "source", status: "interrupted", attempt: 1 }),
    ]);
  });
});
