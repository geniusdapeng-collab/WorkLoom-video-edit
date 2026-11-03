/** Missing artifact receipts remain queryable; bounded polling must rotate work fairly. */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { GenProvider } from "@workloom/base/model-router";
import { ArkVideoProvider } from "./gen/providers.js";
import { pollRenderJobs } from "./render-poller.js";
const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);
describe.runIf(RUN_DB)("产物回执缺失和有限轮询调度", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const media = mkdtempSync(join(tmpdir(), "render-receipt-scheduling-"));
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  afterAll(async () => { await Promise.all([owner.end(), app.end(), gateway.end()]); rmSync(media, { recursive: true, force: true }); });
  async function fixture() {
    const id = `receipt-schedule-${randomUUID()}`; const scope = { tenantId: id, workspaceId: id };
    await owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,'receipt scheduling','community')", [id]);
    await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry) VALUES($1,$1,'receipt scheduling',$1,'general')", [id]);
    await owner.query("INSERT INTO video_projects(id,workspace_id,title,kind,created_by) VALUES($1,$1,'receipt scheduling','narrative','TEST')", [id]);
    const add = async (task: string, age = "1 minute", status = "submitted", provider = "seedance") => {
      const scriptId = id + '-' + task + '-script', jobId = id + '-' + task + '-job';
      await owner.query("INSERT INTO render_scripts(id,workspace_id,project_id,shot_id,script_key,version,md,created_by) VALUES($1,$2,$2,$3,$1,1,'fixture','TEST')", [scriptId, id, task]);
      await owner.query("INSERT INTO render_jobs(id,workspace_id,project_id,script_id,script_version,task_id,provider,status,created_at,updated_at) VALUES($1,$2,$2,$3,1,$4,$5,$6,now()-$7::interval,now()-$7::interval)", [jobId, id, scriptId, task, provider, status, age]);
      return jobId;
    };
    return { scope, add };
  }
  it.each([undefined, "", "  ", "not-an-artifact-url", "mock://gen/not-real.mp4", "file:///fixture-local-must-not-be-opened-by-ark.mp4"])("真实Ark succeeded缺有效URL(%j)时不完成，第二拍仍查原task并接受原片", async uri => {
    vi.stubEnv("WORKLOOM_MEDIA_DIR", media); const { scope, add } = await fixture(); const jobId = await add('issued-ark-task'); let lookups = 0, downloads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === "https://fixture.invalid/issued.mp4") { downloads++; return new Response("issued-original-media", { headers: { "content-type": "video/mp4" } }); }
      expect(String(url)).toBe("https://fixture.invalid/api/v3/contents/generations/tasks/issued-ark-task"); expect(init?.method).toBe("GET"); lookups++;
      return new Response(JSON.stringify({ status: "succeeded", content: { video_url: lookups === 1 ? uri : "https://fixture.invalid/issued.mp4" } }));
    }));
    const provider = new ArkVideoProvider({ apiKey: "fixture", baseUrl: "https://fixture.invalid/api/v3" }); const submit = vi.spyOn(provider, "submit");
    const opts = { pool: new Map([["seedance", provider]]), archive: null };
    const first = await pollRenderJobs(app, gateway, scope, opts);
    expect(first.done).toBe(0); expect(first.running).toBe(1); expect(downloads).toBe(0);
    expect((await owner.query("SELECT status FROM render_jobs WHERE id=$1", [jobId])).rows[0].status).toBe("rendering");
    expect((await owner.query("SELECT id FROM video_assets WHERE workspace_id=$1", [scope.workspaceId])).rowCount).toBe(0);
    const second = await pollRenderJobs(app, gateway, scope, opts); expect(second.done).toBe(1); expect(second.ingested).toBe(1);
    expect(lookups).toBe(2); expect(downloads).toBe(1); expect(submit).not.toHaveBeenCalled();
    const events = await owner.query("SELECT payload->'decision'->>'action' AS action FROM biz_events WHERE payload->'object'->>'id'=$1", [jobId]); expect(events.rows).toEqual([{ action: "render.complete" }]);
  });
  it("本机白板provider的原file产物仍可正常入库，无下载网络请求", async () => {
    vi.stubEnv("WORKLOOM_MEDIA_DIR", media); const { scope, add } = await fixture(); await add('local-task', '1 minute', 'submitted', 'whiteboard-local');
    const file = join(media, 'fixture-original.mp4'); writeFileSync(file, 'issued-local-fixture');
    const p = { providerId: 'whiteboard-local', kind: 'video', healthy: async () => true,
      submit: vi.fn(), poll: vi.fn(async () => ({ status: 'succeeded' as const, uri: new URL(`file://${file}`).href })) } satisfies GenProvider;
    const fetchImpl = vi.fn(async () => { throw new Error('NO_EXTERNAL_FETCH_ALLOWED'); });
    const report = await pollRenderJobs(app, gateway, scope, { pool: new Map([['whiteboard-local', p]]), archive: null, fetchImpl });
    expect(report.done).toBe(1); expect(report.ingested).toBe(1); expect(fetchImpl).not.toHaveBeenCalled(); expect(p.submit).not.toHaveBeenCalled();
  });
  it("limit1在持续rendering和新任务之间轮转，不把一个老任务重复选满每一拍", async () => {
    const { scope, add } = await fixture(); await add('older-task', '3 hours', 'rendering'); await add('newer-task', '2 hours'); const seen: string[] = [];
    const provider = { providerId: 'seedance', kind: 'video', healthy: async () => true, submit: vi.fn(), poll: vi.fn(async task => { seen.push(task); return { status: 'running' as const }; }) } satisfies GenProvider;
    for (let round = 0; round < 4; round++) await pollRenderJobs(app, gateway, scope, { pool: new Map([['seedance', provider]]), limit: 1, ingest: false, archive: null });
    expect(seen).toEqual(['older-task', 'newer-task', 'older-task', 'newer-task']); expect(provider.submit).not.toHaveBeenCalled();
  });
  it("有限轮询同样轮到完成后的成本回执，运行任务不能永久压住补账", async () => {
    const { scope, add } = await fixture(); const completed = await add('completed-task', '3 hours', 'done'); await add('open-task', '2 hours');
    await owner.query("UPDATE render_jobs SET asset_id='existing-asset',actual_cny=2.5 WHERE id=$1", [completed]);
    const provider = { providerId: 'seedance', kind: 'video', healthy: async () => true, submit: vi.fn(), poll: vi.fn(async () => ({ status: 'running' as const })) } satisfies GenProvider;
    const opts = { pool: new Map([['seedance', provider]]), limit: 1, ingest: false, archive: null };
    await pollRenderJobs(app, gateway, scope, opts);
    expect((await owner.query("SELECT id FROM budget_ledger WHERE idempotency_key=$1", ['render:' + completed])).rowCount).toBe(1); expect(provider.poll).not.toHaveBeenCalled();
    await pollRenderJobs(app, gateway, scope, opts); expect(provider.poll).toHaveBeenCalledExactlyOnceWith('open-task');
  });
  it("无凭据skip也推进调度游标，不阻塞另一个供应商的新任务", async () => {
    const { scope, add } = await fixture(); await add('unconfigured-task', '3 hours', 'submitted', 'jimeng'); await add('configured-task', '2 hours');
    const provider = { providerId: 'seedance', kind: 'video', healthy: async () => true, submit: vi.fn(), poll: vi.fn(async () => ({ status: 'running' as const })) } satisfies GenProvider;
    const opts = { pool: new Map([['seedance', provider]]), limit: 1, ingest: false, archive: null };
    await pollRenderJobs(app, gateway, scope, opts); await pollRenderJobs(app, gateway, scope, opts);
    expect(provider.poll).toHaveBeenCalledExactlyOnceWith('configured-task'); expect(provider.submit).not.toHaveBeenCalled();
  });
});
