/** 真实 PG、RLS、发行/消费/供应商适配器与事件；只替换模型网络回包，不花真实额度。 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { authorizeRenderSubmission, loadQualifiedRenderInput, qualifyProductionShot } from "./production-authority.js";
import { renderSha256 } from "./gen/compiled-request.js";
import { submitGenJob } from "./gen/submit.js";
import { projectRunLockKey } from "./archive-host.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);
describe.runIf(RUN_DB)("正式生成资格活库契约", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  // 只有两个连接：并发回归会揭露每个租约再借第二连接造成的池耗尽。
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL, max: 2, connectionTimeoutMillis: 3000 });
  const gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const suffix = randomBytes(6).toString("hex");
  const scope = { tenantId: `t-authority-${suffix}`, workspaceId: `w-authority-${suffix}` };
  const other = { tenantId: `t-authority-other-${suffix}`, workspaceId: `w-authority-other-${suffix}` };
  let dir: string, projectId: string, sourceId: string, seq = 0;
  let env: NodeJS.ProcessEnv, approved = true;
  let calls: Array<{ url: string; body: string }>, providerCalls: number;
  const gates = ["G2_THEME", "G3_INSIGHT", "G4_PRD", "G5_PORTRAIT", "G6_PROMPT", "G7_FINAL"];

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), "authority-pg-")));
    for (const ctx of [scope, other]) {
      await owner.query("INSERT INTO tenants (id,name,plan) VALUES ($1,'正式资格契约','community')", [ctx.tenantId]);
      await owner.query("INSERT INTO workspaces (id,tenant_id,name,slug,industry) VALUES ($1,$2,'正式资格契约',$1,'general')", [ctx.workspaceId, ctx.tenantId]);
    }
  });
  beforeEach(async () => {
    projectId = `P-${suffix}-${++seq}`; sourceId = `SR-${suffix}-${seq}`;
    env = { HR_WORK_DIR: dir, WORKLOOM_RENDER_SIGNING_SECRET: "pg-test-render-signing-secret-more-than-32-bytes",
      VOLCENGINE_ARK_API_KEY: "pg-test-provider", LLM_BASE_URL: "https://judge.example.test", LLM_API_KEY: "pg-test-judge", LLM_MODEL: "test-judge" };
    approved = true; providerCalls = 0; calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: String(init.body) });
      if (String(url).endsWith("/chat/completions")) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ approved, score: approved ? 95 : 30, issues: approved ? [] : ["不合格"], suggestions: [], reason: "测试裁决" }) } }] }));
      providerCalls++;
      return new Response(JSON.stringify({ id: `provider-${suffix}-${seq}` }));
    }));
    await owner.query("INSERT INTO video_projects (id,workspace_id,title,kind,created_by) VALUES ($1,$2,'正式资格契约片','narrative','MEM-T')", [projectId, scope.workspaceId]);
    const root = path.join(dir, "archive", scope.workspaceId, projectId);
    await mkdir(path.join(root, "stages/preproduction"), { recursive: true });
    const proofs = [];
    for (const gate of gates) {
      const file = path.join(dir, "workspaces", scope.workspaceId, "gates", projectId, "attempt-1", `${gate}.md`);
      await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "完整预生产门内容");
      proofs.push(gate === "G5_PORTRAIT" ? { gate, status: "not_applicable", approved: true, basis: "no-characters-or-products" }
        : { gate, status: "passed", approved: true, via: "llm", degraded: false, model: "test-judge", evidence: [{ path: file, sha256: renderSha256("完整预生产门内容"), scope: "complete-text" }] });
    }
    const prompts = JSON.stringify({ stageId: "preproduction", attempt: 1, pipelineKind: "narrative", shots: [
      { shotId: "S1", durationSec: 5, degraded: false, prompt: "固定机位拍摄窗边玻璃杯。", fields: { durationSec: 5 } },
    ] });
    await writeFile(path.join(root, "stages/preproduction/attempt-1.prompts.json"), prompts);
    const output = JSON.stringify({ success: true, degraded: false, promptsRef: "stages/preproduction/attempt-1.prompts.json", promptsSha256: renderSha256(prompts),
      productionEvidence: { schemaVersion: "workloom.preproduction-authority/v1", issuer: "workloom.studio-worker", ...scope, projectId,
        runId: `RUN-${seq}`, attempt: 1, pipelineKind: "narrative", gates: proofs } });
    await writeFile(path.join(root, "stages/preproduction/attempt-1.output.json"), output);
    await owner.query(`INSERT INTO production_stage_runs (id,workspace_id,project_id,stage_id,attempt,status,run_id,output_ref,output_sha256)
      VALUES ($1,$2,$3,'preproduction',1,'done',$4,'stages/preproduction/attempt-1.output.json',$5)`, [sourceId, scope.workspaceId, projectId, `RUN-${seq}`, renderSha256(output)]);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  // 不删除 append-only 资格/五元事件；专属测试作用域留作真实回归证据。
  afterAll(async () => { await Promise.all([owner.end(), app.end(), gateway.end()]); await rm(dir, { recursive: true, force: true }); });

  const issue = (pool = app) => qualifyProductionShot({ app: pool, scope, actor: "MEM-ORIGINAL", projectId, shotId: "S1",
    modelId: "doubao-seedance-2-5", params: { aspectRatio: "16:9" }, mode: "manual", env });
  async function input(token: string, pool = app) {
    return { ...await loadQualifiedRenderInput(app, scope, token, env), app: pool, gateway, scope, actor: "MEM-ORIGINAL",
      qualificationToken: token, fenceLevel: "auto", fenceImpacts: [], env };
  }
  async function scoped<T>(ctx: typeof scope, run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await app.connect();
    try { await client.query("BEGIN"); await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)", [ctx.tenantId, ctx.workspaceId]);
      const result = await run(client); await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  function faultPool(needle: string) {
    let used = false;
    return { connect: async () => { const client = await app.connect(); return {
      query: (sql: string, values?: unknown[]) => { if (!used && sql.includes(needle)) { used = true; throw new Error("injected atomic failure"); } return client.query(sql, values); },
      release: (discard?: boolean) => client.release(discard),
    }; } } as unknown as pg.Pool;
  }

  it("服务签发→加载→真实Ark适配器提交；审核JSON字节等于POST；原子记录完整", async () => {
    const qualification = await issue();
    const result = await submitGenJob(await input(qualification.qualificationToken));
    expect(result).toMatchObject({ mock: false, provider: "seedance", deduped: false, requestHash: qualification.requestHash });
    const stored = await owner.query("SELECT compiled_request FROM production_qualifications WHERE id=$1", [qualification.qualificationId]);
    const sent = calls.find(call => call.url.endsWith("/contents/generations/tasks"));
    expect(sent).toEqual({ url: stored.rows[0].compiled_request.endpoint, body: stored.rows[0].compiled_request.bodyJson });
    const events = await owner.query("SELECT payload->'decision'->>'action' AS action FROM biz_events WHERE workspace_id=$1 ORDER BY seq", [scope.workspaceId]);
    expect(events.rows.map(row => row.action)).toEqual(["render.qualification", "model.call", "render.submit"]);
    expect((await owner.query("SELECT status FROM render_scripts WHERE id=$1", [qualification.scriptId])).rows[0].status).toBe("submitted");
    const repeatQualification = await issue(); expect(repeatQualification).toEqual(qualification);
    expect((await submitGenJob(await input(repeatQualification.qualificationToken))).deduped).toBe(true); expect(providerCalls).toBe(1);
    expect(calls.filter(call => call.url.endsWith("/chat/completions"))).toHaveLength(1);
  });
  it("裸查询/错租户/错工作区看不到资格；应用角色不能注入跨scope资格", async () => {
    const qualification = await issue();
    expect((await app.query("SELECT id FROM production_qualifications WHERE id=$1", [qualification.qualificationId])).rows).toHaveLength(0);
    for (const ctx of [other, { ...scope, tenantId: other.tenantId }, { ...scope, workspaceId: other.workspaceId }]) {
      expect((await scoped(ctx, client => client.query("SELECT id FROM production_qualifications WHERE id=$1", [qualification.qualificationId]))).rows).toHaveLength(0);
      await expect(loadQualifiedRenderInput(app, ctx, qualification.qualificationToken, env)).rejects.toThrow("QUALIFICATION_SCOPE_MISMATCH");
    }
    const copy = (await owner.query("SELECT to_jsonb(q) AS data FROM production_qualifications q WHERE id=$1", [qualification.qualificationId])).rows[0].data;
    copy.id = `PQ-forged-${suffix}-${seq}`; copy.seq = -seq;
    await expect(scoped(other, client => client.query("INSERT INTO production_qualifications SELECT (jsonb_populate_record(NULL::production_qualifications,$1::jsonb)).*", [JSON.stringify(copy)])))
      .rejects.toThrow(/row-level security|source is not current/);
    expect(providerCalls).toBe(0);
  });
  it("owner也不能更新或删除资格；已签发脚本正文不可改，状态投影可以改", async () => {
    const qualification = await issue();
    await expect(owner.query("UPDATE production_qualifications SET status='failed' WHERE id=$1", [qualification.qualificationId])).rejects.toThrow("append-only");
    await expect(owner.query("DELETE FROM production_qualifications WHERE id=$1", [qualification.qualificationId])).rejects.toThrow("append-only");
    await expect(owner.query("UPDATE render_scripts SET md='forged' WHERE id=$1", [qualification.scriptId])).rejects.toThrow("immutable");
    await expect(owner.query("DELETE FROM render_scripts WHERE id=$1", [qualification.scriptId])).rejects.toThrow("immutable");
    await expect(scoped({ ...scope, tenantId: other.tenantId }, client => client.query("UPDATE render_scripts SET md='forged-via-hidden-qualification' WHERE id=$1", [qualification.scriptId]))).rejects.toThrow("immutable");
    expect((await owner.query("UPDATE render_scripts SET status='approved' WHERE id=$1 RETURNING id", [qualification.scriptId])).rowCount).toBe(1);
  });
  it("资格事件失败时脚本、资格与事件同事务全回滚，未留下可使用的半证书", async () => {
    const before = (await owner.query("SELECT count(*)::int AS n FROM biz_events WHERE workspace_id=$1", [scope.workspaceId])).rows[0].n;
    await expect(issue(faultPool("append_event_insert"))).rejects.toThrow("injected atomic failure");
    for (const table of ["render_scripts", "production_qualifications"]) expect((await owner.query(`SELECT id FROM ${table} WHERE project_id=$1`, [projectId])).rows).toHaveLength(0);
    expect((await owner.query("SELECT count(*)::int AS n FROM biz_events WHERE workspace_id=$1", [scope.workspaceId])).rows[0].n).toBe(before);
    expect(providerCalls).toBe(0);
  });
  it("最新拒绝会覆盖旧通过的消费资格；旧记录保留且不发第二份脚本", async () => {
    const qualification = await issue(); approved = false;
    await expect(issue()).rejects.toThrow("PRODUCTION_REVIEW_REJECTED");
    const rows = await owner.query("SELECT status FROM production_qualifications WHERE project_id=$1 ORDER BY seq", [projectId]);
    expect(rows.rows.map(row => row.status)).toEqual(["passed", "failed"]);
    expect((await owner.query("SELECT id FROM render_scripts WHERE project_id=$1", [projectId])).rowCount).toBe(1);
    await expect(loadQualifiedRenderInput(app, scope, qualification.qualificationToken, env)).rejects.toThrow("QUALIFICATION_SUPERSEDED");
    expect(providerCalls).toBe(0);
  });
  it("新attempt即使running也使旧通过失效，直接SQL伪造旧源新资格也拒绝", async () => {
    const qualification = await issue();
    await owner.query("INSERT INTO production_stage_runs (id,workspace_id,project_id,stage_id,attempt,status) VALUES ($1,$2,$3,'preproduction',2,'running')", [`SR-new-${suffix}-${seq}`, scope.workspaceId, projectId]);
    await expect(submitGenJob(await input(qualification.qualificationToken))).rejects.toThrow("PREPRODUCTION_REQUIRED");
    await expect(owner.query(`INSERT INTO production_qualifications SELECT (jsonb_populate_record(NULL::production_qualifications,
      (SELECT to_jsonb(q) FROM production_qualifications q WHERE q.id=$1) || jsonb_build_object('id',$2::text,'seq',nextval('production_qualifications_seq_seq')))).*`, [qualification.qualificationId, `PQ-forged-${suffix}-${seq}`]))
      .rejects.toThrow("source is not current");
    expect(providerCalls).toBe(0);
  });
  it("shared提交lease阻止预生产/发行exclusive lease，不阻止另一提交；释放后可再取得", async () => {
    const qualification = await issue(), request = await input(qualification.qualificationToken);
    const held = await authorizeRenderSubmission(request); const observer = await owner.connect();
    try {
      expect((await observer.query("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [projectRunLockKey(scope, projectId)])).rows[0].ok).toBe(false);
      await expect(issue()).rejects.toThrow("QUALIFICATION_BUSY");
      const second = await authorizeRenderSubmission(request); await second.release();
    } finally { await held.release(); observer.release(); }
    const next = await issue(); expect(next.qualificationId).not.toBe(qualification.qualificationId);
  });
  it("100个同key真实提交在2连接池内不死锁；只有一个供应商调用和一个job", async () => {
    const qualification = await issue(), request = await input(qualification.qualificationToken);
    const results = await Promise.allSettled(Array.from({ length: 100 }, () => submitGenJob(request)));
    const successful = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof submitGenJob>>> => result.status === "fulfilled");
    expect(successful.length).toBeGreaterThan(0); expect(new Set(successful.map(result => result.value.jobId)).size).toBe(1);
    for (const result of results) if (result.status === "rejected") expect(result.reason.code).toMatch(/^SUBMISSION_(IN_PROGRESS|UNVERIFIED)$/);
    expect(providerCalls).toBe(1);
    expect((await owner.query("SELECT id FROM render_jobs WHERE script_id=$1", [qualification.scriptId])).rowCount).toBe(1);
    expect((await owner.query("SELECT dispatch_count,state FROM generation_submissions WHERE script_id=$1", [qualification.scriptId])).rows).toEqual([{ dispatch_count: 1, state: "finalized" }]);
  }, 20_000);
  it("accepted补账跨过expiry/source变更但不能改内容或换key，且不重发", async () => {
    const qualification = await issue(), request = await input(qualification.qualificationToken, faultPool("INSERT INTO render_jobs"));
    await expect(submitGenJob(request)).rejects.toThrow("SUBMISSION_FINALIZATION_PENDING");
    expect((await owner.query("SELECT state FROM generation_submissions WHERE script_id=$1", [qualification.scriptId])).rows[0].state).toBe("accepted");
    await owner.query("UPDATE production_stage_runs SET status='failed' WHERE id=$1", [sourceId]);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60_000);
    const retry = await input(qualification.qualificationToken);
    await expect(submitGenJob({ ...retry, idempotencyKey: "fresh-key" })).rejects.toThrow("QUALIFICATION_IDEMPOTENCY_MISMATCH");
    await expect(submitGenJob({ ...retry, params: { durationSec: 10 } })).rejects.toThrow("QUALIFICATION_REQUEST_MISMATCH");
    expect((await submitGenJob(retry)).deduped).toBe(true); expect(providerCalls).toBe(1);
  });
});
