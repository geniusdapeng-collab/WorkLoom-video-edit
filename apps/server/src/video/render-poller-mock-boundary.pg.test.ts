/** A missing real credential must never turn an issued real task into a simulated success. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { MockGenProvider, type GenProvider } from "@workloom/base/model-router";
import { pollRenderJobs } from "./render-poller.js";
const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);
describe.runIf(RUN_DB)("真实与模拟轮询的凭据边界", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  beforeEach(() => {
    for (const name of ["VOLCENGINE_ARK_API_KEY", "HF_API_KEY_ID", "HF_API_KEY_SECRET", "MUAPI_API_KEY", "KLING_API_KEY", "JIMENG_API_KEY", "WHITEBOARD_ENABLED", "TALKCRAFT_ENABLED"]) vi.stubEnv(name, "");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("EXTERNAL_NETWORK_FORBIDDEN"); }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  afterAll(async () => { await Promise.all([owner.end(), app.end(), gateway.end()]); });
  async function fixture(mock: boolean) {
    const id = `mock-boundary-${randomUUID()}`; const scope = { tenantId: id, workspaceId: id };
    await owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,'mock boundary','community')", [id]);
    await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry) VALUES($1,$1,'mock boundary',$1,'general')", [id]);
    await owner.query("INSERT INTO video_projects(id,workspace_id,title,kind,created_by) VALUES($1,$1,'mock boundary','narrative','TEST')", [id]);
    await owner.query("INSERT INTO render_scripts(id,workspace_id,project_id,shot_id,script_key,version,md,created_by) VALUES($1,$2,$2,'S1',$1,1,'fixture','TEST')", [id + '-script', id]);
    const jobId = id + '-job';
    await owner.query("INSERT INTO render_jobs(id,workspace_id,project_id,script_id,script_version,task_id,provider,mock) VALUES($1,$2,$2,$3,1,$4,'seedance',$5)", [jobId, id, id + '-script', mock ? 'mock-explicit-fixture' : 'real-issued-fixture', mock]);
    return { scope, jobId };
  }
  const state = async (id: string) => (await owner.query("SELECT status,result_url,mock FROM render_jobs WHERE id=$1", [id])).rows[0];
  const events = async (id: string) => (await owner.query("SELECT payload FROM biz_events WHERE payload->'object'->>'id'=$1 ORDER BY seq", [id])).rows.map(row => row.payload);
  it.each([false, true])("无key真实任务不能由Mock池完成（显式注入Mock=%s），原任务不触网不重发", async injected => {
    const { scope, jobId } = await fixture(false);
    const report = await pollRenderJobs(app, gateway, scope, { ingest: false, archive: null,
      ...(injected ? { pool: new Map([["seedance", new MockGenProvider("seedance")]]) } : {}) });
    expect(report.done).toBe(0); expect(report.details[0]?.status).toBe("skip");
    expect(await state(jobId)).toEqual({ status: "submitted", result_url: null, mock: false });
    expect(await events(jobId)).toEqual([]); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("显式mock任务仍走模拟池，终态明确mock且receipt.synced=false", async () => {
    const { scope, jobId } = await fixture(true);
    expect((await pollRenderJobs(app, gateway, scope, { ingest: false, archive: null })).done).toBe(1);
    const rows = await events(jobId); expect(rows).toHaveLength(1);
    expect(rows[0].decision.after.mock).toBe(true); expect(rows[0].receipt).toMatchObject({ synced: false, mode: "simulated" });
    expect((await state(jobId)).result_url).toMatch(/^mock:\/\//); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("mock=false的真实任务即使taskId有mock前缀仍交真实适配器，回执不被改成模拟", async () => {
    const { scope, jobId } = await fixture(false); await owner.query("UPDATE render_jobs SET task_id='mock-real-issued-task' WHERE id=$1", [jobId]);
    const provider = { providerId: "seedance", kind: "video", healthy: async () => true,
      poll: vi.fn(async () => ({ status: "succeeded" as const, uri: "https://fixture.invalid/issued.mp4" })), submit: vi.fn() } satisfies GenProvider;
    expect((await pollRenderJobs(app, gateway, scope, { pool: new Map([["seedance", provider]]), ingest: false, archive: null })).done).toBe(1);
    expect(provider.poll).toHaveBeenCalledExactlyOnceWith("mock-real-issued-task"); expect(provider.submit).not.toHaveBeenCalled();
    expect((await events(jobId))[0]).toMatchObject({ decision: { after: { mock: false } }, receipt: { synced: true } });
    expect((await state(jobId)).result_url).toBe("https://fixture.invalid/issued.mp4");
  });
  it("显式mock=true无需供应商task前缀猜测，也不会查询真实供应商", async () => {
    const { scope, jobId } = await fixture(true); await owner.query("UPDATE render_jobs SET task_id='explicit-simulated-task' WHERE id=$1", [jobId]);
    expect((await pollRenderJobs(app, gateway, scope, { ingest: false, archive: null })).done).toBe(1);
    expect((await events(jobId))[0]).toMatchObject({ decision: { after: { mock: true } }, receipt: { synced: false, mode: "simulated" } });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("模拟任务完成后不进入真实入库重试，默认ingest不会下载模拟URL", async () => {
    const { scope, jobId } = await fixture(true);
    const result = await pollRenderJobs(app, gateway, scope, { archive: null });
    expect(result.done).toBe(1); expect(result.ingested).toBe(0); expect(result.details[0]?.ingestError).toBeUndefined();
    expect((await pollRenderJobs(app, gateway, scope, { archive: null })).checked).toBe(0);
    expect((await events(jobId))[0].receipt).toMatchObject({ synced: false, mode: "simulated" }); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("真实适配器明确成功的原URL照常接纳，只poll原任务、无submit", async () => {
    const { scope, jobId } = await fixture(false);
    const provider = { providerId: "seedance", kind: "video", healthy: async () => true,
      poll: vi.fn(async () => ({ status: "succeeded" as const, uri: "https://fixture.invalid/issued.mp4" })),
      submit: vi.fn(async () => { throw new Error("NO_NEW_GENERATION_ALLOWED"); }) } satisfies GenProvider;
    const report = await pollRenderJobs(app, gateway, scope, { pool: new Map([["seedance", provider]]), ingest: false, archive: null });
    expect(report.done).toBe(1); expect(await state(jobId)).toEqual({ status: "done", result_url: "https://fixture.invalid/issued.mp4", mock: false });
    expect((await events(jobId))[0].receipt.synced).toBe(true);
    expect(provider.poll).toHaveBeenCalledExactlyOnceWith("real-issued-fixture"); expect(provider.submit).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
