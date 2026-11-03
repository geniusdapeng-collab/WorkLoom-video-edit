/** Currentness is compared within the same legacy stage identity. No model/network calls. */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
describe.runIf(RUN_DB)("legacy资格的阶段身份", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  afterAll(async () => owner.end());
  it.each([[null, true], ["renderPoll", true], ["preproduction", false]] as const)("较新%s不跨阶段误杀，预生产新attempt必须作废旧资格", async (newerStage, accepted) => {
    const c = await owner.connect(); const id = `qualification-currentness-${randomUUID()}`; const h = "a".repeat(64);
    try {
      await c.query("BEGIN");
      await c.query("INSERT INTO tenants(id,name,plan) VALUES($1,'qualification currentness','community')", [id]);
      await c.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry) VALUES($1,$1,'qualification currentness',$1,'general')", [id]);
      await c.query("INSERT INTO video_projects(id,workspace_id,title,kind,created_by) VALUES($1,$1,'qualification currentness','narrative','TEST')", [id]);
      await c.query("INSERT INTO production_stage_runs(id,workspace_id,project_id,stage_id,attempt,status,output_sha256) VALUES($1,$2,$2,'preproduction',1,'done',$3)", [id + '-source', id, h]);
      if (newerStage) await c.query("INSERT INTO production_stage_runs(id,workspace_id,project_id,stage_id,attempt,status) VALUES($1,$2,$2,$3,2,'done')", [id + '-newer', id, newerStage]);
      const insert = c.query(`INSERT INTO production_qualifications
        (id,tenant_id,workspace_id,project_id,shot_id,source_stage_run_id,source_attempt,source_output_sha256,prompts_sha256,model_id,provider,provider_model,request_hash,payload_hash,compiled_request,params,mode,status,producer_verdict,issuer,key_id,issued_at,expires_at,created_by)
        VALUES($1,$2,$2,$2,'S1',$3,1,$4,$4,'fixture-model','seedance','fixture-model',$4,$4,'{}','{}','manual','unverified','{}','workloom.production-authority','fixture',now(),now()+interval '30 minutes','TEST')`, [id + '-q', id, id + '-source', h]);
      if (accepted) await expect(insert).resolves.toHaveProperty("rowCount", 1);
      else await expect(insert).rejects.toThrow("source is not current");
    } finally { await c.query("ROLLBACK"); c.release(); }
  });
});
