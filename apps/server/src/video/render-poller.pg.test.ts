/** Isolated real PG roles and injected supplier I/O; never dispatches a generation request. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { GenProvider } from "@workloom/base/model-router";
import { pollRenderJobs } from "./render-poller.js";
const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);
describe.runIf(RUN_DB)("渲染任务轮询的RLS、租约、终态和入库恢复", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL, max: 2 });
  const gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL, max: 4 });
  const mediaRoot = mkdtempSync(join(tmpdir(), "render-poller-pg-"));
  const previousMedia = process.env.WORKLOOM_MEDIA_DIR;
  beforeAll(() => { process.env.WORKLOOM_MEDIA_DIR = mediaRoot; });
  afterAll(async () => {
    await Promise.all([owner.end(), app.end(), gateway.end()]);
    if (previousMedia === undefined) delete process.env.WORKLOOM_MEDIA_DIR; else process.env.WORKLOOM_MEDIA_DIR = previousMedia;
    rmSync(mediaRoot, { recursive: true, force: true });
  });
  async function fixture(age = "1 minute") {
    const id = `render-${randomUUID()}`; const scope = { tenantId: id, workspaceId: id };
    await owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,'isolated render recovery','community')", [id]);
    await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry) VALUES($1,$1,'isolated render recovery',$1,'general')", [id]);
    await owner.query("INSERT INTO video_projects(id,workspace_id,title,kind,created_by) VALUES($1,$1,'isolated render recovery','narrative','TEST')", [id]);
    await owner.query("INSERT INTO render_scripts(id,workspace_id,project_id,shot_id,script_key,version,md,created_by) VALUES($1,$2,$2,'S1',$1,1,'fixture','TEST')", [id + '-script', id]);
    const jobId = id + '-job';
    await owner.query("INSERT INTO render_jobs(id,workspace_id,project_id,script_id,script_version,task_id,provider,created_at) VALUES($1,$2,$2,$3,1,'issued-task','seedance',now()-$4::interval)", [jobId, id, id + '-script', age]);
    return { scope, jobId };
  }
  const state = async (jobId: string) => (await owner.query("SELECT status,asset_id,result_url FROM render_jobs WHERE id=$1", [jobId])).rows[0];
  const actions = async (jobId: string) => (await owner.query("SELECT payload->'decision'->>'action' AS action FROM biz_events WHERE payload->'object'->>'id'=$1 ORDER BY seq", [jobId])).rows.map(row => row.action);
  function provider(poll: GenProvider["poll"] = vi.fn(async () => ({ status: "running" as const }))) {
    return { providerId: "seedance", kind: "video", healthy: async () => true,
      submit: vi.fn(async () => { throw new Error("NO_NEW_GENERATION_ALLOWED"); }), poll } satisfies GenProvider;
  }
  const options = (p: GenProvider) => ({ pool: new Map([["seedance", p]]), archive: null, ingest: false });
  it("真实app角色提交中的任务推进rendering，关闭终态不再被轮询", async () => {
    const { scope, jobId } = await fixture(); const p = provider();
    expect((await pollRenderJobs(app, gateway, scope, options(p))).running).toBe(1);
    expect((await state(jobId)).status).toBe("rendering");
    await owner.query("UPDATE render_jobs SET status='failed' WHERE id=$1", [jobId]);
    expect((await pollRenderJobs(app, gateway, scope, options(p))).checked).toBe(0);
    expect(p.poll).toHaveBeenCalledTimes(1); expect(p.submit).not.toHaveBeenCalled();
  });
  it("供应商缺位的超龄任务同事务写失败状态和终态事件", async () => {
    const { scope, jobId } = await fixture("48 hours");
    expect((await pollRenderJobs(app, gateway, scope, { pool: new Map(), archive: null })).failed).toBe(1);
    expect((await state(jobId)).status).toBe("failed");
    expect(await actions(jobId)).toEqual(["render.failed"]);
  });
  it("供应商缺位但未超时仅留skip，不虚构终态", async () => {
    const { scope, jobId } = await fixture();
    const report = await pollRenderJobs(app, gateway, scope, { pool: new Map(), archive: null });
    expect(report.details[0]?.status).toBe("skip"); expect((await state(jobId)).status).toBe("submitted"); expect(await actions(jobId)).toEqual([]);
  });
  it("queued/submitted沿既有阈值超时，未超时查询异常仍可回查原任务", async () => {
    const aged = await fixture("48 hours"); const queued = provider(vi.fn(async () => ({ status: "submitted" as const })));
    expect((await pollRenderJobs(app, gateway, aged.scope, options(queued))).failed).toBe(1);
    expect((await state(aged.jobId)).status).toBe("failed");
    const fresh = await fixture(); const lookup = provider(vi.fn(async () => { throw new Error("lookup HTTP503"); }));
    expect((await pollRenderJobs(app, gateway, fresh.scope, options(lookup))).running).toBe(1);
    expect((await state(fresh.jobId)).status).toBe("rendering"); expect(await actions(fresh.jobId)).toEqual([]);
    expect(lookup.submit).not.toHaveBeenCalled();
  });
  it("终态SQL失败回滚后归还gateway连接，重试原任务可以成功", async () => {
    const { scope, jobId } = await fixture(); let releases = 0; let borrowed: pg.PoolClient | undefined;
    const failure = new Error("injected terminal update");
    const failingGateway = { connect: async () => {
      borrowed = await gateway.connect();
      return { query: (sql: string, params?: unknown[]) => { if (sql.includes("UPDATE render_jobs")) throw failure; return borrowed!.query(sql, params); },
        release: (discard?: boolean) => { releases++; borrowed!.release(discard); borrowed = undefined; } };
    } } as unknown as pg.Pool;
    const p = provider(vi.fn(async () => ({ status: "failed" as const, error: "supplier failed" })));
    try {
      await expect(pollRenderJobs(app, failingGateway, scope, options(p))).rejects.toThrow("injected terminal update");
      expect(releases).toBe(1); expect((await state(jobId)).status).toBe("submitted"); expect(await actions(jobId)).toEqual([]);
    } finally { borrowed?.release(true); }
    expect((await pollRenderJobs(app, gateway, scope, options(p))).failed).toBe(1);
    expect(await actions(jobId)).toEqual(["render.failed"]);
  });
  it.each(["lease-ack", "unlock-ack", "rollback"] as const)("%s失败丢弃未知连接，后续同任务不被残留租约阻塞", async point => {
    const { scope, jobId } = await fixture(); const discards: boolean[] = [];
    const broken = { connect: async () => {
      const c = await gateway.connect();
      return { query: async (sql: string, params?: unknown[]) => {
        if (point === "lease-ack" && sql.includes("pg_try_advisory_lock")) { await c.query(sql, params); throw new Error("lease acknowledgement lost"); }
        if (point === "unlock-ack" && sql.includes("pg_advisory_unlock")) { await c.query(sql, params); throw new Error("unlock acknowledgement lost"); }
        if (point === "rollback" && (sql.includes("UPDATE render_jobs") || sql === "ROLLBACK")) throw new Error("injected rollback failure");
        return c.query(sql, params);
      }, release: (discard?: boolean) => { discards.push(discard === true); c.release(discard); } };
    } } as unknown as pg.Pool;
    const p = provider(vi.fn(async () => ({ status: "failed" as const, error: "supplier failed" })));
    await expect(pollRenderJobs(app, broken, scope, options(p))).rejects.toThrow();
    expect(discards).toEqual([true]);
    await pollRenderJobs(app, gateway, scope, options(p));
    expect((await state(jobId)).status).toBe("failed"); expect(await actions(jobId)).toEqual(["render.failed"]);
    expect(p.submit).not.toHaveBeenCalled();
  });
  it("错tenant/邻居workspace不读取或推进任务", async () => {
    const { scope, jobId } = await fixture(); const p = provider();
    expect((await pollRenderJobs(app, gateway, { ...scope, tenantId: "wrong-tenant" }, options(p))).checked).toBe(0);
    expect((await pollRenderJobs(app, gateway, { ...scope, workspaceId: "wrong-workspace" }, options(p))).checked).toBe(0);
    expect((await state(jobId)).status).toBe("submitted"); expect(p.poll).not.toHaveBeenCalled();
  });
  it("并发轮询只拉取一份产物、一次终态事件，后到快照不能覆盖完成", async () => {
    const { scope, jobId } = await fixture(); let unblock!: () => void;
    const held = new Promise<void>(resolve => { unblock = resolve; });
    const poll = vi.fn(async () => { if (poll.mock.calls.length === 1) await held; return { status: "succeeded" as const, uri: "https://fixture.invalid/issued.mp4" }; });
    const p = provider(poll); const fetchImpl = vi.fn(async () => new Response("issued-original-bytes", { headers: { "content-type": "video/mp4" } }));
    const opts = { pool: new Map([["seedance", p]]), archive: null, fetchImpl: fetchImpl as typeof fetch };
    const first = pollRenderJobs(app, gateway, scope, opts);
    try { await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(1)); await pollRenderJobs(app, gateway, scope, opts); }
    finally { unblock(); }
    await first;
    expect(poll).toHaveBeenCalledTimes(1); expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await state(jobId)).status).toBe("done"); expect(await actions(jobId)).toEqual(["render.complete"]);
    expect((await pollRenderJobs(app, gateway, scope, opts)).checked).toBe(0); expect(p.submit).not.toHaveBeenCalled();
  });
  it("重复入库失败保留原done事实和可读失败回执，ingest关闭不触发补录", async () => {
    const { scope, jobId } = await fixture();
    const p = provider(vi.fn(async () => ({ status: "succeeded" as const, uri: "https://fixture.invalid/issued.mp4" })));
    const fetchImpl = vi.fn(async () => new Response("temporary", { status: 503 }));
    const opts = { pool: new Map([["seedance", p]]), archive: null, fetchImpl: fetchImpl as typeof fetch };
    await pollRenderJobs(app, gateway, scope, opts); await pollRenderJobs(app, gateway, scope, opts);
    expect(await state(jobId)).toMatchObject({ status: "done", asset_id: null, result_url: "https://fixture.invalid/issued.mp4" });
    expect(await actions(jobId)).toEqual(["render.complete", "render.ingest.failed"]);
    expect((await pollRenderJobs(app, gateway, scope, { ...opts, ingest: false })).checked).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(p.poll).toHaveBeenCalledTimes(1); expect(p.submit).not.toHaveBeenCalled();
  });
  it("供应商成功后下载503，下轮只重试同一URL入库、不poll或重发生成、无第二条终态", async () => {
    const { scope, jobId } = await fixture();
    const p = provider(vi.fn(async () => ({ status: "succeeded" as const, uri: "https://fixture.invalid/issued.mp4" })));
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockImplementation(async () => new Response("issued-original-bytes", { headers: { "content-type": "video/mp4" } }));
    const opts = { pool: new Map([["seedance", p]]), archive: null, fetchImpl: fetchImpl as typeof fetch };
    const first = await pollRenderJobs(app, gateway, scope, opts);
    expect(first.done).toBe(1); expect(first.details[0]?.ingestError).toMatch(/503/); expect(await state(jobId)).toMatchObject({ status: "done", asset_id: null });
    const second = await pollRenderJobs(app, gateway, scope, opts);
    expect(second.ingested).toBe(1); expect((await state(jobId)).asset_id).toEqual(expect.any(String));
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(p.poll).toHaveBeenCalledTimes(1); expect(p.submit).not.toHaveBeenCalled();
    expect(await actions(jobId)).toEqual(["render.complete", "render.ingest.complete"]);
    expect((await pollRenderJobs(app, gateway, scope, opts)).checked).toBe(0);
  });
});
