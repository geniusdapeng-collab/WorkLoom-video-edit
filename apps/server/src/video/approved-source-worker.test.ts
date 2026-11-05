/** Actual host startup, StageRunner, source plan, native adapter, current gates and production-shot readback. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCircuit, type ModelTrace } from "@workloom/base/model-router";
import { WorkloomLLMEngine } from "@hyperreality/video-studio";
import { SEMANTIC_QUALITY_CHECK_IDS } from "./prompt-quality-gate.js";
import { getModel, resolveProviderModel } from "./gen/catalog.js";
import { approvedSourceFixture, fixtureHash } from "./approved-source-plan.test-support.js";
import { prepareApprovedSourcePlan, readPromptRepairPlan, repairApprovedSourcePrompts, verifyApprovedSourceAdoption } from "./approved-source-plan.js";
import { startApprovedSourceRepairRun, getRun } from "./studio-worker.js";
import { listProductionShots } from "./production-authority.js";
import { readPersistedPreproductionRun } from "./archive-resume.js";

const boundary = vi.hoisted(() => ({ connect: vi.fn(), traces: [] as unknown[], events: [] as Record<string, any>[] }));
vi.mock("@workloom/db", () => ({ getAppPool: () => ({ connect: boundary.connect }), getGatewayPool: () => ({ connect: boundary.connect }) }));
vi.mock("@workloom/base/workdata", async importOriginal => ({ ...await importOriginal<typeof import("@workloom/base/workdata")>(),
  gatewayAppend: vi.fn(async (_pool, _scope, event) => { boundary.events.push(event); return { id: "offline-event" }; }),
  gatewayAppendOnClient: vi.fn(async (_client, _scope, event) => { boundary.events.push(event); return { id: "offline-event" }; }) }));
vi.mock("@workloom/base/model-router", async importOriginal => {
  const original = await importOriginal<typeof import("@workloom/base/model-router")>();
  return { ...original, GatewayEventSink: class {
    async recordModelTrace(trace: ModelTrace) { boundary.traces.push(trace); }
    async recordDegradation() { throw new Error("OFFLINE_UNEXPECTED_DEGRADATION"); }
    async recordCircuitBreak() { throw new Error("OFFLINE_UNEXPECTED_QUOTA_BREAK"); }
  } };
});
const scope = { tenantId: "tenant-worker", workspaceId: "ws-worker" }, projectId = "VID-worker";
const createdAt = "2026-11-05T00:00:00.000Z";
type Json = Record<string, any>;
let workDir: string, fixture: Awaited<ReturnType<typeof approvedSourceFixture>>, rows: Json[], held: boolean;
let modelRequests: Json[], failAuthor: boolean, failG6: boolean, failFacts: boolean;
let receiptFault: "none" | "author-no-usage" | "author-no-id" | "author-socket-loss" | "author-route-drift" | "g6-route-drift" | "g6-no-usage" | "g6-no-id"
  | "repair-no-usage" | "facts-no-usage" | "facts-no-id" | "facts-syntax" | "facts-partial-unknown";
let factNativeCalls: number;
let activeEngine: WorkloomLLMEngine | undefined;
const originalFromEnv = WorkloomLLMEngine.fromEnv.bind(WorkloomLLMEngine);
beforeEach(async () => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries({ LLM_PROVIDER: "deepseek", LLM_BASE_URL: "http://offline-worker.invalid/v1", LLM_API_KEY: "offline-only",
    LLM_MODEL: "deepseek-flash", LLM_FORCE_MODEL: "deepseek-flash", ARCHIVE_ENABLED: "1", PROMPT_CONTRACT_V2: "enforce", PIPELINE_SYSTEM_AUTO_APPROVAL: "enforce", VM_PRODUCER_RETRY: "9" })) vi.stubEnv(key, value);
  workDir = await realpath(await mkdtemp(path.join(tmpdir(), "approved-source-worker-")));
  vi.stubEnv("HR_WORK_DIR", workDir);
  const model = getModel("doubao-seedance-2-5")!, providerModel = resolveProviderModel(model);
  fixture = await approvedSourceFixture({ workDir, scope: { ...scope, projectId, runId: "RUN-source", attempt: 4 }, createdAt,
    compileModel: { modelId: model.id, provider: model.provider, providerModel, version: `workloom.media-catalog/v1:${providerModel}`,
      modes: [...model.modes], durationSec: { min: model.limits!.durationSec!.min, max: model.limits!.durationSec!.max }, aspectRatios: model.limits!.aspectRatios!, resolutions: model.limits!.resolutions!,
      maxReferenceImages: model.limits!.maxReferenceImages!, maxPromptChars: model.limits!.maxPromptChars! } });
  vi.stubEnv("HR_PORTRAIT_REUSE_MANIFEST", fixture.portraitManifest.path);
  rows = [{ ...fixture.row, project_id: projectId, workspace_id: scope.workspaceId, kind: "marketing", stage_id: "preproduction" }];
  held = false; modelRequests = []; boundary.events.length = 0; boundary.traces.length = 0; failAuthor = false; failG6 = false; failFacts = false;
  receiptFault = "none"; factNativeCalls = 0;
  activeEngine = undefined;
  vi.spyOn(WorkloomLLMEngine, "fromEnv").mockImplementation(env => {
    const engine = originalFromEnv(env); activeEngine = engine ?? undefined; return engine;
  });
  boundary.connect.mockImplementation(async () => {
    let tenant = "", workspace = "";
    const query = async (sql: string, params: any[] = []) => {
      let found: Json[] = [];
      if (sql.includes("set_config('app.tenant_id'")) tenant = params[0];
      if (sql.includes("set_config('app.workspace_id'")) workspace = params[0];
      if (sql.includes("pg_try_advisory_lock")) { const ok = !held; held ||= ok; found = [{ ok }]; }
      else if (sql.includes("pg_advisory_unlock")) { held = false; found = [{ ok: true }]; }
      else if (sql.includes("SELECT title, kind")) found = tenant === scope.tenantId && workspace === scope.workspaceId ? [{ title: "Offline host repair", kind: "marketing", thread_id: null, created_at: createdAt }] : [];
      else if (sql.includes("INSERT INTO production_stage_runs")) {
        if (tenant !== scope.tenantId || workspace !== scope.workspaceId) throw new Error("OFFLINE_RLS_DENIED");
        const attempt = Math.max(...rows.map(row => row.attempt)) + 1, inputRef = String(params[4]).replace("{attempt}", String(attempt));
        rows.push({ id: params[0], workspace_id: params[1], project_id: params[2], stage_id: params[3], attempt, input_ref: inputRef,
          run_id: params[5], status: "running", error_class: null, output_ref: null, output_sha256: null, kind: "marketing" });
        found = [{ attempt, input_ref: inputRef }];
      } else if (sql.includes("UPDATE production_stage_runs") && sql.includes("SET status=$4")) {
        const row = rows.find(row => row.attempt === params[10] && row.status === "running");
        if (row) { Object.assign(row, { status: params[3], output_ref: params[4], output_sha256: params[5], error_class: params[6], error_msg: params[7] }); found = [{ id: row.id }]; }
      } else if (sql.includes("UPDATE production_stage_runs") && sql.includes("SET last_heartbeat_at=now()")) {
        // The actual StageRunner heartbeat does not change a terminal receipt.
        found = [];
      } else if (sql.includes("FROM production_stage_runs")) {
        found = tenant === scope.tenantId && workspace === scope.workspaceId ? [...rows] : [];
        if (sql.includes("r.run_id=$2")) found = found.filter(row => row.run_id === params[1]).map(row => ({ ...row, started_at: createdAt, finished_at: row.status === "running" ? null : createdAt }));
        else if (sql.includes("SELECT r.*,p.kind")) found = params[2] === projectId ? found.sort((a, b) => b.attempt - a.attempt).slice(0, 1) : [];
        else {
          if (params[0] !== scope.workspaceId || params[1] !== projectId) found = [];
          if (sql.includes("AND attempt=$3")) found = found.filter(row => row.attempt === params[2]);
          if (sql.includes("AND id=$3")) found = found.filter(row => row.id === params[2]);
          if (sql.includes("ORDER BY")) found = found.sort((a, b) => b.attempt - a.attempt).slice(0, 1);
        }
      } else if (sql.includes("FROM biz_events") && sql.includes("video.scene_policy.selected")) {
        const event = boundary.events.filter(event => event.decision.action === "video.scene_policy.selected").at(-1);
        found = event ? [{ after: event.decision.after }] : [];
      } else if (!["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) && !sql.includes("set_config") && !sql.includes("pg_advisory_xact_lock")) throw new Error(`OFFLINE_UNEXPECTED_SQL:${sql.slice(0, 90)}`);
      return { rows: structuredClone(found), rowCount: found.length };
    };
    return { query, release: vi.fn() };
  });
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    expect(String(url)).toBe("http://offline-worker.invalid/v1/chat/completions");
    const request = JSON.parse(String(init?.body)); modelRequests.push(request);
    const prompt = String(request.messages.at(-1).content), section = prompt.split("\n\n【硬性输出要求】", 1)[0]!;
    let payload: unknown, callKind: "author" | "g6" | "repair" | "facts";
    if (section.startsWith("你是当前影片的字段作者。")) {
      callKind = "author";
      if (receiptFault === "author-socket-loss") throw new Error("offline socket lost after native invocation");
      payload = failAuthor ? { shotId: "opening", fields: { duration: 99 } }
        : { shotId: "opening", fields: { timeline: "T00:00至T00:05，合成人物完整观察商品；T00:05至T00:10，合成人物轻轻点头。" } };
    }
    else if (section.startsWith("你是视频提示词语义质量门的唯一评审员。")) {
      callKind = "g6";
      const context = JSON.parse(section.slice(section.indexOf("\n{\n") + 1)), fields = Object.fromEntries(context.fields.map((field: Json) => [field.field, field.value]));
      payload = { shotId: context.shotId, checks: SEMANTIC_QUALITY_CHECK_IDS.map(id => {
        const field = id === "SQ1_SUBJECT_ACTION" ? "action" : id === "SQ2_SCENE_PROPS" ? "scene" : id === "SQ3_CAMERA_FEASIBLE" ? "camera_movement" : id === "SQ4_LIGHT_COLOR" ? "lighting" : "director_instruction";
        return { id, field, pass: !(failG6 && context.shotId === "opening" && id === "SQ3_CAMERA_FEASIBLE"), evidence: fields[field],
          ...(failG6 && context.shotId === "opening" && id === "SQ3_CAMERA_FEASIBLE" ? { failureCode: "OFFLINE_CURRENT_CAMERA_CONFLICT", repair: "当前镜头必须修正" } : {}) };
      }) };
    } else if (section.startsWith("你是字段级定点修复器。")) { callKind = "repair"; payload = { changes: [] }; }
    else {
      callKind = "facts"; factNativeCalls++;
      if (receiptFault === "facts-partial-unknown" && factNativeCalls === 2) throw new Error("offline final fact socket lost");
      payload = receiptFault === "facts-syntax" || receiptFault === "facts-partial-unknown" ? "{"
        : { approved: !failFacts, score: failFacts ? 10 : 96, issues: failFacts ? ["offline unsupported final claim"] : [], suggestions: [], reason: failFacts ? "offline final fact rejection" : "offline complete current final facts" };
    }
    const response: Json = { id: `offline-worker-${modelRequests.length}`, object: "chat.completion", model: request.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: typeof payload === "string" ? payload : JSON.stringify(payload) } }],
      usage: { prompt_tokens: 600, completion_tokens: 100, total_tokens: 700 } };
    if (receiptFault === `${callKind}-no-usage`) delete response.usage;
    if (receiptFault === `${callKind}-no-id`) delete response.id;
    if (receiptFault === `${callKind}-route-drift`) {
      const current = activeEngine as unknown as { cfg: { router: Parameters<WorkloomLLMEngine["attachRouter"]>[0] } };
      activeEngine!.attachRouter(current.cfg.router);
    }
    return Response.json(response);
  }));
}, 30_000);
afterEach(async () => {
  for (const row of rows.filter(row => row.attempt > fixture.scope.attempt)) {
    const entry = getRun(row.run_id, scope.workspaceId);
    if (entry && !entry.finishedAt) {
      entry.aborted = true;
      await vi.waitFor(() => { expect(entry.finishedAt).toEqual(expect.any(String)); }, { timeout: 30_000, interval: 10 });
    }
  }
  resetCircuit("preproduction"); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(workDir, { recursive: true, force: true });
}, 30_000);
async function start() {
  const plan = await prepareApprovedSourcePlan(scope, projectId), request = { projectId, expectedLatestAttempt: plan.source.scope.attempt, planDigest: plan.planDigest };
  const receipt = await repairApprovedSourcePrompts(scope, request, startApprovedSourceRepairRun);
  if (receipt.kind !== "started") throw new Error(JSON.stringify(receipt));
  return { plan, request, receipt };
}
async function finished(runId: string) {
  await vi.waitFor(() => { expect(getRun(runId, scope.workspaceId)?.finishedAt).toEqual(expect.any(String)); }, { timeout: 30_000, interval: 10 });
  return getRun(runId, scope.workspaceId)!;
}
describe("approved-source host worker", { timeout: 30_000 }, () => {
  it("returns only after actual claim/input/adoption and finishes with current G5–G7 plus normal production shots", async () => {
    const { plan, request, receipt } = await start();
    const input = JSON.parse(await readFile(path.join(fixture.store.root, "stages/preproduction/attempt-5.input.json"), "utf8"));
    expect(input.input.approvedSourceRepair.runId).toBe(receipt.runId);
    expect(input.input.approvedSourceRepair.adoptionRef).toBe("stages/preproduction/attempt-5.approved-source-adoption.json");
    expect(rows).toHaveLength(2);
    const entry = await finished(receipt.runId);
    expect(entry).toMatchObject({ status: "finished", projectId, error: null });
    expect(held).toBe(false);
    expect(modelRequests).toHaveLength(5); // one diagnosed field author, two current G6 reviews, two final fact reviews
    expect(boundary.traces).toHaveLength(3); // author and semantic calls retain native accounting; final producer reviews retain their existing receipt path
    const row = rows.at(-1)!, output = JSON.parse(await readFile(path.join(fixture.store.root, row.output_ref), "utf8"));
    expect(row.status).toBe("done");
    expect(output.productionEvidence.gates.map((gate: Json) => gate.gate)).toEqual(["G5_PORTRAIT", "G6_PROMPT", "G7_FINAL"]);
    expect(boundary.events.filter(event => event.decision.action === "system-auto-approval")
      .map(event => event.decision.after.gateEvent.sourceStage)).toEqual(["apps/server:approved-source-repair", "apps/server:approved-source-repair"]);
    expect(output.productionEvidence.approvedSourceRepair.planDigest).toBe(plan.planDigest);
    const sheet = JSON.parse(await readFile(path.join(fixture.store.root, output.cliShotlistRef), "utf8"));
    expect(sheet.metadata.platform).toBe("douyin");
    expect(sheet.metadata.builtinCharacterSelection).toEqual(plan.selection.exportMetadata.builtinCharacterSelection);
    expect(sheet.metadata.characters).toEqual(plan.selection.exportCharacters);
    expect(sheet.characters).toEqual(plan.selection.exportCharacters);
    expect(sheet.metadata.source).toEqual(sheet.source);
    expect(plan.request.metadata).not.toHaveProperty("platform");
    expect(output.productionEvidence.gates.find((gate: Json) => gate.gate === "G6_PROMPT").promptQuality.evidence.contracts[0].contract.createdAt)
      .toBe(output.authoring.receipts[0].authoredAt);
    expect(await readPersistedPreproductionRun(scope, receipt.runId)).toMatchObject({ projectId, status: "finished", resultSummary: { persisted: true, success: true, attempt: 5 } });
    const source = await listProductionShots({ app: { connect: boundary.connect } as never, scope, projectId, workDir });
    expect(source.sourceAttempt).toBe(5);
    expect(source.approvedSourceRepair).toEqual(output.productionEvidence.approvedSourceRepair);
    expect(source.shots).toHaveLength(2);
    expect(source.shots[0]!.fields.timeline).toContain("点头");
    const duplicate = await repairApprovedSourcePrompts(scope, request, startApprovedSourceRepairRun);
    expect(duplicate).toMatchObject({ kind: "started", runId: receipt.runId, deduped: true });
    expect(rows).toHaveLength(2); expect(modelRequests).toHaveLength(5);
    expect(await readFile(path.join(fixture.store.root, fixture.row.input_ref))).toEqual(fixture.sourceInputBytes);
    expect(await readFile(path.join(fixture.store.root, fixture.row.output_ref))).toEqual(fixture.sourceOutputBytes);
  });
  it("keeps a genuine G6 rejection, full current contracts and diagnosis available for the next explicitly requested repair", async () => {
    failG6 = true;
    const { receipt } = await start(), entry = await finished(receipt.runId);
    expect(entry.status).toBe("failed"); expect(entry.error).toContain("OFFLINE_CURRENT_CAMERA_CONFLICT");
    expect(rows).toHaveLength(2); expect(modelRequests).toHaveLength(4);
    const row = rows.at(-1)!, output = JSON.parse(await readFile(path.join(fixture.store.root, row.output_ref), "utf8"));
    expect(output.success).toBe(false); expect(output.marketingFactsRef).toBeUndefined();
    expect(output.productionEvidence.gates.find((gate: Json) => gate.gate === "G6_PROMPT").promptQuality.evidence.contracts).toHaveLength(2);
    const next = await prepareApprovedSourcePlan(scope, projectId);
    expect(next.source.scope.attempt).toBe(5); expect(next.currentDraftSource.scope.attempt).toBe(5);
    expect(next.rootApprovalSource.scope.attempt).toBe(4);
    expect(next.fieldPlan.diagnoses).toContainEqual(expect.objectContaining({ field: "camera_movement", code: "OFFLINE_CURRENT_CAMERA_CONFLICT" }));
  });
  it("does not promote an invalid authored response and retains the last valid draft across subsequent failures", async () => {
    failAuthor = true;
    const { receipt } = await start(), entry = await finished(receipt.runId);
    expect(entry.status).toBe("failed"); expect(entry.error).toContain("AUTHORING_RESPONSE_SCOPE_INVALID");
    expect(modelRequests).toHaveLength(1);
    const row = rows.at(-1)!, output = JSON.parse(await readFile(path.join(fixture.store.root, row.output_ref), "utf8"));
    expect(output.productionEvidence.gates).toEqual([]); expect(output.retainedDraft.sourceAttempt).toBe(4);
    expect(row.error_class).toBe("GATE_REJECTED");
    expect(output.modelCallOutcomes[0]).toMatchObject({ nativeCompleted: true, dispatchOutcome: "verified-complete", usage: { promptTokens: 600, completionTokens: 100 } });
    const next = await prepareApprovedSourcePlan(scope, projectId);
    expect(next.source.scope.attempt).toBe(5); expect(next.currentDraftSource.scope.attempt).toBe(4);
    expect(next.contracts[0]!.fields.timeline).not.toContain("99");
  });
  it("persists current G6 contracts and the original final-facts rejection instead of losing a valid new draft", async () => {
    failFacts = true;
    const { receipt } = await start(), entry = await finished(receipt.runId);
    expect(entry.status).toBe("failed"); expect(entry.error).toContain("offline final fact rejection");
    expect(modelRequests).toHaveLength(4);
    const row = rows.at(-1)!, output = JSON.parse(await readFile(path.join(fixture.store.root, row.output_ref), "utf8"));
    expect(output.productionEvidence.gates.find((gate: Json) => gate.gate === "G6_PROMPT").approved).toBe(true);
    expect(output.marketingFactsRef).toBeUndefined(); expect(output.marketingFinalFactsFailure.message).toContain("offline final fact rejection");
    const next = await prepareApprovedSourcePlan(scope, projectId);
    expect(next.currentDraftSource.scope.attempt).toBe(5); expect(next.rootApprovalSource.scope.attempt).toBe(4);
    expect(next.contracts[0]!.fields.timeline).toContain("点头");
  });
  it("fails the startup barrier on a non-exclusive adoption receipt before any model dispatch", async () => {
    await writeFile(path.join(fixture.store.root, "stages/preproduction/attempt-5.approved-source-adoption.json"), "original-existing-receipt");
    await expect(start()).rejects.toMatchObject({ code: "EEXIST" });
    await vi.waitFor(() => { expect(rows.at(-1)!.status).toBe("failed"); });
    expect(modelRequests).toHaveLength(0); expect(held).toBe(false);
    expect(await readFile(path.join(fixture.store.root, "stages/preproduction/attempt-5.approved-source-adoption.json"), "utf8")).toBe("original-existing-receipt");
  });
  it("rechecks durable adoption and rejects changed root sources during production readback", async () => {
    const { receipt } = await start(); await finished(receipt.runId);
    const row = rows.at(-1)!, output = JSON.parse(await readFile(path.join(fixture.store.root, row.output_ref), "utf8"));
    const binding = output.productionEvidence.approvedSourceRepair;
    await expect(verifyApprovedSourceAdoption({ root: fixture.store.root, scope: { ...scope, projectId, runId: receipt.runId, attempt: 5 }, ref: binding.adoptionRef, sha256: binding.adoptionSha256 })).resolves.toMatchObject({ sourceScope: fixture.scope });
    await writeFile(fixture.sourceTextPath, "changed-original-source");
    await expect(listProductionShots({ app: { connect: boundary.connect } as never, scope, projectId, workDir })).rejects.toThrow();
    expect(modelRequests).toHaveLength(5);
  });
  it.each(["disabled-contract", "fabricated-current-g1"])("does not consume repair output with %s", async boundaryName => {
    const { receipt } = await start(); await finished(receipt.runId);
    if (boundaryName === "fabricated-current-g1") {
      const row = rows.at(-1)!, file = path.join(fixture.store.root, row.output_ref), output = JSON.parse(await readFile(file, "utf8"));
      output.productionEvidence.gates.push(structuredClone(fixture.output.productionEvidence.gates[0]));
      const body = JSON.stringify(output); await writeFile(file, body); row.output_sha256 = fixtureHash(body);
    }
    await expect(listProductionShots({ app: { connect: boundary.connect } as never, scope, projectId, workDir,
      ...(boundaryName === "disabled-contract" ? { env: { ...process.env, PROMPT_CONTRACT_V2: "off" } } : {}) })).rejects.toMatchObject({ code: "PREPRODUCTION_ADOPTION_UNVERIFIED" });
    expect(modelRequests).toHaveLength(5);
  });
  it.each([
    ["author-no-usage", 1], ["author-no-id", 1], ["author-socket-loss", 1], ["author-route-drift", 1],
    ["g6-no-usage", 2], ["g6-no-id", 2], ["g6-route-drift", 2],
    ["repair-no-usage", 4], ["facts-no-usage", 4], ["facts-no-id", 4], ["facts-partial-unknown", 5],
  ] as const)("persists sticky unknown receipt %s and cannot turn a new plan into another native invocation", async (fault, calls) => {
    receiptFault = fault;
    if (fault === "repair-no-usage") failG6 = true;
    const { receipt, request } = await start(), entry = await finished(receipt.runId);
    expect(entry.status).toBe("failed"); expect(entry.error).toContain("RECEIPT_UNVERIFIED");
    expect(modelRequests).toHaveLength(calls);
    const row = rows.at(-1)!, output = JSON.parse(await readFile(path.join(fixture.store.root, row.output_ref), "utf8"));
    expect(row).toMatchObject({ status: "interrupted", error_class: "RECEIPT_UNVERIFIED" });
    expect(output.success).toBe(false);
    const unknown = output.modelCallOutcomes.filter((item: Json) => item.dispatchOutcome === "unverified");
    expect(unknown).toHaveLength(1);
    if (fault.endsWith("no-id") || fault.endsWith("route-drift")) expect(unknown[0].usage).toEqual({ promptTokens: 600, completionTokens: 100 });
    if (fault.endsWith("route-drift")) expect(unknown[0].nativeCompleted).toBe(true);
    if (fault.endsWith("no-usage") || fault === "author-socket-loss") expect(unknown[0].usage).toBeNull();
    if (fault === "facts-partial-unknown") {
      expect(unknown[0]).toMatchObject({ nativeInvocations: 2, usage: { promptTokens: 600, completionTokens: 100 } });
      expect(unknown[0].receipts).toHaveLength(1);
    }
    expect(await readPromptRepairPlan(scope, projectId)).toMatchObject({ kind: "unavailable" });
    expect(await repairApprovedSourcePrompts(scope, request, startApprovedSourceRepairRun))
      .toMatchObject({ kind: "started", runId: receipt.runId, deduped: true });
    expect(rows).toHaveLength(2); expect(modelRequests).toHaveLength(calls);
  });
  it("keeps a proven pre-dispatch archive failure as known failed with no model invocation", async () => {
    const file = path.join(fixture.store.root, "stages/preproduction/attempt-5.authoring/shot-1.request.json");
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "existing immutable request");
    const { receipt } = await start(); await finished(receipt.runId);
    const row = rows.at(-1)!, output = JSON.parse(await readFile(path.join(fixture.store.root, row.output_ref), "utf8"));
    expect(row).toMatchObject({ status: "failed", error_class: "GATE_REJECTED" });
    expect(output.modelCallOutcomes).toEqual([]); expect(modelRequests).toHaveLength(0);
    expect(await readPromptRepairPlan(scope, projectId)).toMatchObject({ kind: "ready", expectedLatestAttempt: 5 });
  });
  it("preserves known measured syntax-failure receipts instead of calling completed reviews unknown", async () => {
    receiptFault = "facts-syntax";
    const { receipt } = await start(); await finished(receipt.runId);
    const row = rows.at(-1)!, output = JSON.parse(await readFile(path.join(fixture.store.root, row.output_ref), "utf8"));
    expect(row).toMatchObject({ status: "failed", error_class: "GATE_REJECTED" });
    expect(modelRequests).toHaveLength(9); // existing producer three parse attempts x support's two attempts, plus author/G6 three
    const facts = output.modelCallOutcomes.filter((item: Json) => item.stage === "marketing-final-facts");
    expect(facts).toHaveLength(2);
    for (const event of facts) expect(event).toMatchObject({ dispatchOutcome: "verified-complete", nativeInvocations: 3,
      usage: { promptTokens: 1800, completionTokens: 300 } });
    expect(await readPromptRepairPlan(scope, projectId)).toMatchObject({ kind: "ready", expectedLatestAttempt: 5 });
  });
});
