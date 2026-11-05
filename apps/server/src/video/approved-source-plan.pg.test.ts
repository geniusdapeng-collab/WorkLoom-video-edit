/** Real PostgreSQL lease/claim/idempotency checks; source files and model-free work are synthetic. */
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StageRunner } from "@hyperreality/video-studio";
import { approvedSourceFixture } from "./approved-source-plan.test-support.js";
import { makeLedgerWriter, type ProjectLease } from "./archive-host.js";
import { createPreproductionResumeSnapshot, readPersistedPreproductionRun } from "./archive-resume.js";
import {
  adoptApprovedSourcePlan, prepareApprovedSourcePlan, readPromptRepairPlan, repairApprovedSourcePrompts,
  APPROVED_SOURCE_REPAIR_INPUT_SCHEMA, type VerifiedApprovedSourcePlan,
} from "./approved-source-plan.js";
import type { MarketingScope } from "./marketing-authority.js";

const runDb = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);
describe.runIf(runDb)("approved-source plan real-PG claim and replay", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const scope = { tenantId: `tenant-repair-${suffix}`, workspaceId: `ws-repair-${suffix}` };
  let fixture: Awaited<ReturnType<typeof approvedSourceFixture>>, workDir: string, projectId: string, createdAt: string;
  let testNumber = 0;
  beforeAll(async () => {
    await owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Offline prompt repair PG','community')", [scope.tenantId]);
    await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry) VALUES($1,$2,'Offline prompt repair',$3,'general')",
      [scope.workspaceId, scope.tenantId, `repair-${suffix}`]);
  });
  beforeEach(async () => {
    projectId = `VID-REPAIR-${suffix}-${++testNumber}`;
    const inserted = await owner.query<{ created_at: Date }>(
      "INSERT INTO video_projects(id,workspace_id,title,kind,created_by) VALUES($1,$2,'Offline approved source','marketing','fixture') RETURNING created_at",
      [projectId, scope.workspaceId]);
    createdAt = inserted.rows[0]!.created_at.toISOString();
    workDir = await realpath(await mkdtemp(path.join(tmpdir(), "source-plan-pg-")));
    vi.stubEnv("HR_WORK_DIR", workDir);
    fixture = await approvedSourceFixture({ workDir, scope: { ...scope, projectId, runId: `RUN-SOURCE-${testNumber}`, attempt: 1 }, createdAt });
    vi.stubEnv("HR_PORTRAIT_REUSE_MANIFEST", fixture.portraitManifest.path);
    const ledger = makeLedgerWriter(scope);
    const claim = await ledger.claimRun({ id: fixture.row.id, projectId, stageId: "preproduction",
      inputRefTemplate: "stages/preproduction/attempt-{attempt}.input.json", runId: fixture.scope.runId });
    expect(claim.attempt).toBe(1);
    await ledger.finishRun({ projectId, stageId: "preproduction", attempt: claim.attempt, status: "failed",
      outputRef: fixture.row.output_ref, outputSha256: fixture.row.output_sha256, errorClass: "GATE_REJECTED", errorMsg: "offline G6 source rejection", durationMs: 1 });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("PG claim tests cannot dispatch models"); }));
  });
  afterEach(async () => {
    vi.unstubAllEnvs(); vi.unstubAllGlobals();
    await owner.query("DELETE FROM production_stage_runs WHERE workspace_id=$1 AND project_id=$2", [scope.workspaceId, projectId]);
    await owner.query("DELETE FROM video_projects WHERE workspace_id=$1 AND id=$2", [scope.workspaceId, projectId]);
    await rm(workDir, { recursive: true, force: true });
  });
  afterAll(async () => {
    await owner.query("DELETE FROM workspaces WHERE id=$1", [scope.workspaceId]);
    await owner.query("DELETE FROM tenants WHERE id=$1", [scope.tenantId]);
    await owner.end();
  });

  function launcher() {
    let calls = 0, complete: () => void = () => undefined, task: Promise<unknown> | undefined;
    const wait = new Promise<void>(resolve => { complete = resolve; });
    const launch = async (_scope: typeof scope, { plan, lease }: { plan: VerifiedApprovedSourcePlan; lease: ProjectLease }) => {
      calls++;
      const runId = `RUN-PG-REPAIR-${testNumber}`;
      let began: (value: { runId: string; attempt: number }) => void;
      let failed: (reason: unknown) => void;
      const startup = new Promise<{ runId: string; attempt: number }>((resolve, reject) => { began = resolve; failed = reject; });
      const runner = new StageRunner(fixture.store, makeLedgerWriter(scope), runId);
      task = runner.run("preproduction", ctx => ({ pipelineKind: "marketing", isMarketing: true, scenePolicy: plan.selection.scenePolicy,
        approvedSourceRepair: { schemaVersion: APPROVED_SOURCE_REPAIR_INPUT_SCHEMA, planDigest: plan.planDigest,
          sourceAttempt: plan.source.scope.attempt, sourceRunId: plan.source.scope.runId, sourceStageRunId: plan.source.stageRunId,
          runId, adoptionRef: `stages/preproduction/attempt-${ctx.attempt}.approved-source-adoption.json` },
        resumeSnapshot: createPreproductionResumeSnapshot({ scope: { ...scope, projectId, runId }, projectCreatedAt: createdAt, request: plan.request }),
      }), async ctx => {
        const target: MarketingScope = { ...scope, projectId, runId, attempt: ctx.attempt };
        const adoption = await adoptApprovedSourcePlan(plan, { scope: target });
        began({ runId, attempt: ctx.attempt });
        await wait;
        await plan.verifyCurrent(lease);
        return { output: { success: false, productionEvidence: { schemaVersion: "workloom.preproduction-authority/v1", issuer: "workloom.studio-worker",
          ...target, pipelineKind: "marketing", gates: [], approvedSourceRepair: { adoptionRef: adoption.ref, adoptionSha256: adoption.sha256, planDigest: plan.planDigest } },
          retainedDraft: { sourceStageRunId: plan.currentDraftSource.stageRunId, sourceRunId: plan.currentDraftSource.scope.runId,
            sourceAttempt: plan.currentDraftSource.scope.attempt, outputRef: plan.currentDraftSource.outputRef,
            outputSha256: plan.currentDraftSource.outputSha256, planDigest: plan.planDigest } },
        outcome: { status: "failed", errorClass: "GATE_REJECTED", errorMsg: "offline retained draft test" } };
      }).catch(error => { failed(error); throw error; }).finally(() => lease.release());
      return startup;
    };
    return { launch, calls: () => calls, finish: async () => { complete(); await task; } };
  }

  it("allows one real project lease/atomic stage claim under concurrent same-plan submissions and replays the saved run", async () => {
    const plan = await prepareApprovedSourcePlan(scope, projectId), request = { projectId, expectedLatestAttempt: 1, planDigest: plan.planDigest };
    const worker = launcher();
    const results = await Promise.all([repairApprovedSourcePrompts(scope, request, worker.launch), repairApprovedSourcePrompts(scope, request, worker.launch)]);
    expect(results.some(result => result.kind === "started")).toBe(true);
    expect(results.every(result => result.kind === "started" || result.kind === "busy")).toBe(true);
    expect(worker.calls()).toBe(1);
    const stages = await owner.query<{ attempt: number; run_id: string }>(
      "SELECT attempt,run_id FROM production_stage_runs WHERE workspace_id=$1 AND project_id=$2 ORDER BY attempt", [scope.workspaceId, projectId]);
    expect(stages.rows.map(row => row.attempt)).toEqual([1, 2]);
    const replayWhileRunning = await repairApprovedSourcePrompts(scope, request, worker.launch);
    expect(replayWhileRunning).toMatchObject({ kind: "started", runId: `RUN-PG-REPAIR-${testNumber}`, deduped: true });
    await worker.finish();
    expect(await repairApprovedSourcePrompts(scope, request, worker.launch)).toEqual(replayWhileRunning);
    expect(worker.calls()).toBe(1);
    expect(await readPersistedPreproductionRun(scope, `RUN-PG-REPAIR-${testNumber}`)).toMatchObject({ projectId, status: "failed", resultSummary: { persisted: true, attempt: 2 } });
    expect(await readPersistedPreproductionRun({ ...scope, tenantId: "foreign-tenant" }, `RUN-PG-REPAIR-${testNumber}`)).toBeNull();
    expect(await readFile(path.join(fixture.store.root, fixture.row.input_ref))).toEqual(fixture.sourceInputBytes);
    expect(await readFile(path.join(fixture.store.root, fixture.row.output_ref))).toEqual(fixture.sourceOutputBytes);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps source scope private under real app-pool RLS and rejects stale plan data before any claim", async () => {
    const dto = await readPromptRepairPlan({ ...scope, tenantId: "foreign-tenant" }, projectId);
    expect(dto.kind).toBe("unavailable");
    const worker = launcher();
    expect(await repairApprovedSourcePrompts(scope, { projectId, expectedLatestAttempt: 1, planDigest: "a".repeat(64) }, worker.launch)).toMatchObject({ kind: "stale" });
    expect(worker.calls()).toBe(0);
    const count = await owner.query<{ n: number }>("SELECT count(*)::int AS n FROM production_stage_runs WHERE workspace_id=$1 AND project_id=$2", [scope.workspaceId, projectId]);
    expect(count.rows[0]?.n).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
