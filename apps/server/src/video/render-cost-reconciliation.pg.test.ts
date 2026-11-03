/** Recover accounting for the already issued job; never re-price or re-dispatch its supplier task. */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { gatewayAppend } from "@workloom/base/workdata";
import type { GenProvider } from "@workloom/base/model-router";
import { getModel } from "./gen/catalog.js";
import { pollRenderJobs } from "./render-poller.js";
const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);
describe.runIf(RUN_DB)("已成功任务的成本回执补账", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const media = mkdtempSync(join(tmpdir(), "render-cost-reconcile-"));
  const model = getModel("hf-seedance-2-0-t2v")!;
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await Promise.all([owner.end(), app.end(), gateway.end()]); rmSync(media, { recursive: true, force: true }); });
  async function fixture() {
    const id = `cost-reconcile-${randomUUID()}`; const scope = { tenantId: id, workspaceId: id }; const jobId = id + '-job';
    await owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,'cost reconcile','community')", [id]);
    await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry) VALUES($1,$1,'cost reconcile',$1,'general')", [id]);
    await owner.query("INSERT INTO video_projects(id,workspace_id,title,kind,created_by) VALUES($1,$1,'cost reconcile','narrative','TEST')", [id]);
    await owner.query("INSERT INTO render_scripts(id,workspace_id,project_id,shot_id,script_key,version,md,created_by) VALUES($1,$2,$2,'S1',$1,1,'fixture','TEST')", [id + '-script', id]);
    await owner.query("INSERT INTO render_jobs(id,workspace_id,project_id,script_id,script_version,task_id,provider,provider_model) VALUES($1,$2,$2,$3,1,'issued-hf-task','higgsfield',$4)", [jobId, id, id + '-script', model.providerModel]);
    await gatewayAppend(gateway, { ...scope, actor: { id: "MEM-T", type: "human" } }, {
      who: { id: "MEM-T", type: "human" }, context: { tenant_id: id, workspace_id: id, time: new Date().toISOString() }, object: { type: "render_script", id: id + '-script' },
      decision: { action: "render.submit", after: { jobId, provider: "higgsfield" } }, rule_impact: [],
    });
    return { scope, jobId };
  }
  const costs = async (jobId: string) => (await owner.query("SELECT amount,meta FROM budget_ledger WHERE idempotency_key=$1", ['render:' + jobId])).rows;
  const job = async (jobId: string) => (await owner.query("SELECT status,asset_id,actual_usd,actual_cny,actual_seconds FROM render_jobs WHERE id=$1", [jobId])).rows[0];
  it("成本临时写失败后，已入库done任务可补原金额且不再下载、poll或submit", async () => {
    vi.stubEnv("WORKLOOM_MEDIA_DIR", media); vi.stubEnv("VIDEO_USD_CNY_RATE", "7.2");
    const { scope, jobId } = await fixture(); let failOnce = true;
    const faultApp = { connect: async () => { const c = await app.connect(); return {
      query: (sql: string, params?: unknown[]) => { if (failOnce && sql.includes("INSERT INTO budget_ledger")) { failOnce = false; throw new Error("temporary cost write failure"); } return c.query(sql, params); },
      release: (discard?: boolean) => c.release(discard),
    }; } } as unknown as pg.Pool;
    const provider = { providerId: "higgsfield", kind: "video", healthy: async () => true,
      poll: vi.fn(async () => ({ status: "succeeded" as const, uri: "https://fixture.invalid/issued.mp4", actualUnits: 5 })),
      submit: vi.fn(async () => { throw new Error("NO_NEW_GENERATION_ALLOWED"); }) } satisfies GenProvider;
    const fetchImpl = vi.fn(async () => new Response("issued-original-bytes", { headers: { "content-type": "video/mp4" } }));
    const opts = { pool: new Map([["higgsfield", provider]]), archive: null, fetchImpl: fetchImpl as typeof fetch };
    const first = await pollRenderJobs(faultApp, gateway, scope, opts); const original = await job(jobId);
    expect(first.done).toBe(1); expect(first.ingested).toBe(1); expect(first.details[0]?.costError).toContain("temporary cost write failure");
    expect(original.asset_id).toEqual(expect.any(String)); expect(Number(original.actual_cny)).toBeGreaterThan(0); expect(await costs(jobId)).toHaveLength(0);
    vi.stubEnv("VIDEO_USD_CNY_RATE", "99");
    vi.stubEnv("WORKLOOM_MEDIA_CATALOG", join(media, "unavailable-current-catalog.json"));
    const second = await pollRenderJobs(app, gateway, scope, opts);
    expect(second.checked).toBe(1); expect(second.details[0]?.costError).toBeUndefined();
    const ledger = await costs(jobId); expect(ledger).toHaveLength(1); expect(Number(ledger[0].amount)).toBe(Number(original.actual_cny)); expect(ledger[0].meta.usd).toBe(Number(original.actual_usd));
    expect(await job(jobId)).toEqual(original); expect(provider.poll).toHaveBeenCalledTimes(1); expect(provider.submit).not.toHaveBeenCalled(); expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await pollRenderJobs(app, gateway, scope, opts)).checked).toBe(0);
    const terminal = await owner.query("SELECT count(*)::int AS n FROM biz_events WHERE payload->'object'->>'id'=$1 AND payload->'decision'->>'action'='render.complete'", [jobId]); expect(terminal.rows[0].n).toBe(1);
  });
  it("仅补账不依赖产物URL或入库开关，并发补原job只落一份账", async () => {
    const { scope, jobId } = await fixture();
    await owner.query("UPDATE render_jobs SET status='done',asset_id='existing-asset',actual_usd=0.1,actual_cny=1.25,actual_seconds=5 WHERE id=$1", [jobId]);
    const provider = { providerId: "higgsfield", kind: "video", healthy: async () => true,
      poll: vi.fn(async () => { throw new Error("NO_REPOLL_ALLOWED"); }), submit: vi.fn(async () => { throw new Error("NO_NEW_GENERATION_ALLOWED"); }) } satisfies GenProvider;
    const opts = { pool: new Map([["higgsfield", provider]]), archive: null, ingest: false };
    await Promise.all([pollRenderJobs(app, gateway, scope, opts), pollRenderJobs(app, gateway, scope, opts)]);
    const ledger = await costs(jobId); expect(ledger).toHaveLength(1); expect(Number(ledger[0].amount)).toBe(1.25); expect(provider.poll).not.toHaveBeenCalled(); expect(provider.submit).not.toHaveBeenCalled();
    expect((await pollRenderJobs(app, gateway, scope, opts)).checked).toBe(0);
  });
});
