/** Public tRPC -> actual PG/StageRunner/files -> native loopback HTTP -> current gates/facts -> normal readback. */
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeAllPools } from "@workloom/db";
import { resetCircuit } from "@workloom/base/model-router";
import { approvedSourceFixture } from "./approved-source-plan.test-support.js";
import { makeLedgerWriter } from "./archive-host.js";
import { getModel, resolveProviderModel } from "./gen/catalog.js";
import { SEMANTIC_QUALITY_CHECK_IDS } from "./prompt-quality-gate.js";
import { videoRouter } from "./router.js";
import { getRun } from "./studio-worker.js";
import type { TrpcContext } from "../trpc/context.js";

type Json = Record<string, any>;
const runDb = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);
describe.runIf(runDb)("approved-source public API real-PG/native HTTP integration", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const scope = { tenantId: `tenant-api-repair-${suffix}`, workspaceId: `ws-api-repair-${suffix}` };
  const projectId = `VID-API-${suffix}`, memberId = `member-api-${suffix}`;
  let fixture: Awaited<ReturnType<typeof approvedSourceFixture>>, directory: string, server: Server;
  const physicalRequests: Array<{ path: string; body: Json }> = [];
  const serverErrors: string[] = [];
  const directories: string[] = [];
  let unknownUsage = false;
  const identity = { kind: "member", tenantId: scope.tenantId, workspaceId: scope.workspaceId, memberId,
    memberNo: "MEM-API-OWNER", name: "Offline API owner", role: "owner", plan: "pro" } as NonNullable<TrpcContext["identity"]>;
  const context: TrpcContext = { identity, session: identity, partnerIdentity: null, headers: new Headers() };
  const caller = () => videoRouter.createCaller(context);
  beforeAll(async () => {
    await owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Offline public API repair','pro')", [scope.tenantId]);
    await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry) VALUES($1,$2,'Offline API repair',$3,'general')",
      [scope.workspaceId, scope.tenantId, `api-repair-${suffix}`]);
    await owner.query("INSERT INTO members(id,workspace_id,member_no,name,role) VALUES($1,$2,$3,'Offline API owner','owner')",
      [memberId, scope.workspaceId, identity.memberNo]);
    const inserted = await owner.query<{ created_at: Date }>(
      "INSERT INTO video_projects(id,workspace_id,title,kind,created_by) VALUES($1,$2,'Offline public API source','marketing',$3) RETURNING created_at",
      [projectId, scope.workspaceId, identity.memberNo]);
    const createdAt = inserted.rows[0]!.created_at.toISOString();
    directory = await realpath(await mkdtemp(path.join(tmpdir(), "approved-source-api-pg-")));
    directories.push(directory);
    vi.stubEnv("HR_WORK_DIR", directory);
    const model = getModel("doubao-seedance-2-5")!, providerModel = resolveProviderModel(model);
    fixture = await approvedSourceFixture({ workDir: directory, scope: { ...scope, projectId, runId: `RUN-API-SOURCE-${suffix}`, attempt: 1 }, createdAt,
      compileModel: { modelId: model.id, provider: model.provider, providerModel, version: `workloom.media-catalog/v1:${providerModel}`,
        modes: [...model.modes], durationSec: { min: model.limits!.durationSec!.min, max: model.limits!.durationSec!.max },
        aspectRatios: model.limits!.aspectRatios!, resolutions: model.limits!.resolutions!,
        maxReferenceImages: model.limits!.maxReferenceImages!, maxPromptChars: model.limits!.maxPromptChars! } });
    vi.stubEnv("HR_PORTRAIT_REUSE_MANIFEST", fixture.portraitManifest.path);
    const ledger = makeLedgerWriter(scope);
    const source = await ledger.claimRun({ id: fixture.row.id, projectId, stageId: "preproduction",
      inputRefTemplate: "stages/preproduction/attempt-{attempt}.input.json", runId: fixture.scope.runId });
    expect(source.attempt).toBe(1);
    await ledger.finishRun({ projectId, stageId: "preproduction", attempt: 1, status: "failed", outputRef: fixture.row.output_ref,
      outputSha256: fixture.row.output_sha256, errorClass: "GATE_REJECTED", errorMsg: "synthetic initial G6 rejection", durationMs: 1 });
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        try {
          if (req.method !== "POST" || req.url !== "/v1/chat/completions") throw new Error(`unexpected offline endpoint ${req.method} ${req.url}`);
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          physicalRequests.push({ path: req.url, body });
          const prompt = String(body.messages.at(-1).content), section = prompt.split("\n\n【硬性输出要求】", 1)[0]!;
          let payload: unknown;
          if (section.startsWith("你是当前影片的字段作者。")) payload = { shotId: "opening", fields: {
            timeline: "T00:00至T00:05，合成人物完整观察商品；T00:05至T00:10，合成人物轻轻点头。" } };
          else if (section.startsWith("你是视频提示词语义质量门的唯一评审员。")) {
            const evidence = JSON.parse(section.slice(section.indexOf("\n{\n") + 1));
            const fields = Object.fromEntries(evidence.fields.map((field: Json) => [field.field, field.value]));
            payload = { shotId: evidence.shotId, checks: SEMANTIC_QUALITY_CHECK_IDS.map(id => {
              const field = id === "SQ1_SUBJECT_ACTION" ? "action" : id === "SQ2_SCENE_PROPS" ? "scene"
                : id === "SQ3_CAMERA_FEASIBLE" ? "camera_movement" : id === "SQ4_LIGHT_COLOR" ? "lighting" : "director_instruction";
              return { id, field, pass: true, evidence: fields[field] };
            }) };
          } else if (section.startsWith("你是字段级定点修复器。")) throw new Error("unexpected second authoring in positive fixture");
          else payload = { approved: true, score: 96, issues: [], suggestions: [], reason: "offline full current final facts" };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: `loopback-repair-${physicalRequests.length}`, object: "chat.completion", created: 1, model: body.model,
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(payload) } }],
            ...(unknownUsage ? {} : { usage: { prompt_tokens: 600, completion_tokens: 100, total_tokens: 700 } }) }));
        } catch (error) {
          serverErrors.push(error instanceof Error ? error.message : String(error));
          res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: serverErrors.at(-1) }));
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    for (const [key, value] of Object.entries({ LLM_PROVIDER: "deepseek", LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, LLM_API_KEY: "offline-loopback-only",
      LLM_MODEL: "deepseek-flash", LLM_FORCE_MODEL: "deepseek-flash", ARCHIVE_ENABLED: "1", PROMPT_CONTRACT_V2: "enforce",
      PIPELINE_SYSTEM_AUTO_APPROVAL: "enforce", ARCHIVE_AUTO_RESUME: "0", PIPELINE_CONTROL_PLANE: "off", VM_PRODUCER_RETRY: "9" })) vi.stubEnv(key, value);
  });
  afterAll(async () => {
    resetCircuit("preproduction");
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    vi.unstubAllEnvs();
    await owner.end(); await closeAllPools();
    for (const temporary of directories) await rm(temporary, { recursive: true, force: true });
  });

  it("completes the one explicit operation through public API, real durable receipts and native HTTP, then dedupes the same plan", async () => {
    const dto = await caller().studio.promptRepairPlan({ projectId });
    expect(dto).toMatchObject({ kind: "ready", retainedShotCount: 2, expectedLatestAttempt: 1 });
    expect(physicalRequests).toHaveLength(0);
    if (dto.kind !== "ready") throw new Error(JSON.stringify(dto));
    const request = { projectId, expectedLatestAttempt: dto.expectedLatestAttempt, planDigest: dto.planDigest };
    await expect(caller().studio.repairPrompts({ ...request, fields: { timeline: "caller forged" } } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await owner.query("UPDATE members SET role='readonly' WHERE id=$1", [memberId]);
    await expect(caller().studio.repairPrompts(request)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(physicalRequests).toHaveLength(0);
    await owner.query("UPDATE members SET role='owner' WHERE id=$1", [memberId]);
    const started = await caller().studio.repairPrompts(request);
    expect(started.kind).toBe("started");
    if (started.kind !== "started") throw new Error(JSON.stringify(started));
    const duplicateDuringRun = await caller().studio.repairPrompts(request);
    expect(duplicateDuringRun).toMatchObject({ kind: "started", runId: started.runId, deduped: true });
    await vi.waitFor(() => { expect(getRun(started.runId, scope.workspaceId)).toMatchObject({ finishedAt: expect.any(String) }); }, { timeout: 20_000, interval: 20 });
    const status = await caller().studio.status({ runId: started.runId });
    expect(status).toMatchObject({ status: "finished", projectId, error: null });
    expect(serverErrors).toEqual([]);
    expect(physicalRequests).toHaveLength(5);
    expect(physicalRequests.every(entry => entry.path === "/v1/chat/completions" && entry.body.model === "deepseek-flash")).toBe(true);
    const records = await owner.query<{ attempt: number; status: string; run_id: string; output_ref: string }>(
      "SELECT attempt,status,run_id,output_ref FROM production_stage_runs WHERE workspace_id=$1 AND project_id=$2 ORDER BY attempt", [scope.workspaceId, projectId]);
    expect(records.rows.map(row => [row.attempt, row.status])).toEqual([[1, "failed"], [2, "done"]]);
    expect(records.rows[1]!.run_id).toBe(started.runId);
    const output = JSON.parse(await readFile(path.join(fixture.store.root, records.rows[1]!.output_ref), "utf8"));
    expect(output.productionEvidence.gates.map((gate: Json) => gate.gate)).toEqual(["G5_PORTRAIT", "G6_PROMPT", "G7_FINAL"]);
    expect(output.marketingFactsRef).toBe("stages/preproduction/attempt-2.marketing-facts.json");
    const facts = JSON.parse(await readFile(path.join(fixture.store.root, output.marketingFactsRef), "utf8"));
    expect(facts.collectedAt).toBe(fixture.collectedAt); expect(facts.scope.attempt).toBe(2);
    expect(facts.approvedSourceAdoption).toEqual({ ref: output.productionEvidence.approvedSourceRepair.adoptionRef, sha256: output.productionEvidence.approvedSourceRepair.adoptionSha256 });
    const production = await caller().production.shots({ projectId });
    expect(production.sourceAttempt).toBe(2); expect(production.shots).toHaveLength(2);
    expect(production.shots[0]!.fields.timeline).toContain("点头");
    const archive = await caller().studio.archive({ projectId });
    const archiveReceipt = archive.stages.find(stage => stage.stageId === "preproduction" && stage.attempt === 2)!;
    const cliModule = new URL("../../../../scripts/tools/lib/codex-video-film.mjs", import.meta.url).href;
    const { verifyStudioHandoff } = await import(cliModule);
    const handoff = verifyStudioHandoff({ archive, production, studio: { projectId, runId: started.runId, pipeline: "marketing" },
      studioRoot: directory, requestedDuration: 20, archiveReceipt });
    expect(handoff.shotDurations).toEqual([10, 10]);
    expect(handoff.source.approvedSourceRepair).toEqual(production.approvedSourceRepair);
    expect(handoff.source.attempt).toBe(2);
    expect(await caller().studio.repairPrompts(request)).toMatchObject({ kind: "started", runId: started.runId, deduped: true });
    expect(physicalRequests).toHaveLength(5);
    const modelEvents = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action'='model.call'", [scope.workspaceId]);
    expect(modelEvents.rows[0]!.n).toBe(3);
    const paidMedia = await owner.query<{ n: number }>("SELECT count(*)::int AS n FROM render_jobs WHERE workspace_id=$1", [scope.workspaceId]);
    expect(paidMedia.rows[0]!.n).toBe(0);
    expect(await readFile(path.join(fixture.store.root, fixture.row.input_ref))).toEqual(fixture.sourceInputBytes);
    expect(await readFile(path.join(fixture.store.root, fixture.row.output_ref))).toEqual(fixture.sourceOutputBytes);
  });

  it("persists an unknown native usage outcome and prevents a fresh explicit repair from bypassing reconciliation", async () => {
    const unknownProjectId = `${projectId}-unknown`;
    const inserted = await owner.query<{ created_at: Date }>(
      "INSERT INTO video_projects(id,workspace_id,title,kind,created_by) VALUES($1,$2,'Offline unknown usage source','marketing',$3) RETURNING created_at",
      [unknownProjectId, scope.workspaceId, identity.memberNo]);
    const createdAt = inserted.rows[0]!.created_at.toISOString();
    const unknownDirectory = await realpath(await mkdtemp(path.join(tmpdir(), "approved-source-api-unknown-pg-")));
    directories.push(unknownDirectory); vi.stubEnv("HR_WORK_DIR", unknownDirectory);
    const unknownFixture = await approvedSourceFixture({ workDir: unknownDirectory,
      scope: { ...scope, projectId: unknownProjectId, runId: `RUN-API-UNKNOWN-SOURCE-${suffix}`, attempt: 1 }, createdAt,
      compileModel: fixture.options.model });
    vi.stubEnv("HR_PORTRAIT_REUSE_MANIFEST", unknownFixture.portraitManifest.path);
    const ledger = makeLedgerWriter(scope);
    await ledger.claimRun({ id: unknownFixture.row.id, projectId: unknownProjectId, stageId: "preproduction",
      inputRefTemplate: "stages/preproduction/attempt-{attempt}.input.json", runId: unknownFixture.scope.runId });
    await ledger.finishRun({ projectId: unknownProjectId, stageId: "preproduction", attempt: 1, status: "failed", outputRef: unknownFixture.row.output_ref,
      outputSha256: unknownFixture.row.output_sha256, errorClass: "GATE_REJECTED", errorMsg: "synthetic initial rejection", durationMs: 1 });
    const dto = await caller().studio.promptRepairPlan({ projectId: unknownProjectId });
    expect(dto.kind).toBe("ready"); if (dto.kind !== "ready") throw new Error(JSON.stringify(dto));
    const request = { projectId: unknownProjectId, expectedLatestAttempt: 1, planDigest: dto.planDigest };
    const before = physicalRequests.length; unknownUsage = true;
    const started = await caller().studio.repairPrompts(request);
    expect(started.kind).toBe("started"); if (started.kind !== "started") throw new Error(JSON.stringify(started));
    await vi.waitFor(() => { expect(getRun(started.runId, scope.workspaceId)).toMatchObject({ finishedAt: expect.any(String) }); }, { timeout: 20_000, interval: 20 });
    const records = await owner.query<{ attempt: number; status: string; error_class: string; error_msg: string }>(
      "SELECT attempt,status,error_class,error_msg FROM production_stage_runs WHERE workspace_id=$1 AND project_id=$2 ORDER BY attempt",
      [scope.workspaceId, unknownProjectId]);
    expect(records.rows).toHaveLength(2);
    expect(records.rows[1]).toMatchObject({ attempt: 2, status: "interrupted", error_class: "RECEIPT_UNVERIFIED" });
    expect(records.rows[1]!.error_msg).toMatch(/UNVERIFIED|UNKNOWN|usage|计量|回执/iu);
    expect(physicalRequests.length - before).toBe(1);
    expect(await caller().studio.promptRepairPlan({ projectId: unknownProjectId })).toMatchObject({ kind: "unavailable", code: "SOURCE_NOT_FAILED" });
    expect(await caller().studio.repairPrompts(request)).toMatchObject({ kind: "started", runId: started.runId, deduped: true });
    expect(await caller().studio.repairPrompts({ ...request, expectedLatestAttempt: 2 })).toMatchObject({ kind: "stale" });
    expect(physicalRequests.length - before).toBe(1);
    const count = await owner.query<{ n: number }>("SELECT count(*)::int AS n FROM production_stage_runs WHERE workspace_id=$1 AND project_id=$2", [scope.workspaceId, unknownProjectId]);
    expect(count.rows[0]?.n).toBe(2);
    expect(serverErrors).toEqual([]);
  });
});
