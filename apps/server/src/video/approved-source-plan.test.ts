import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compilePromptShot } from "@hyperreality/video-studio";
import { createPreproductionResumeSnapshot, readPersistedPreproductionRun } from "./archive-resume.js";
import { approvedSourceFixture, fixtureHash } from "./approved-source-plan.test-support.js";
import {
  adoptApprovedSourcePlan, assertVerifiedApprovedSourcePlan, prepareApprovedSourcePlan, publicPromptRepairPlan,
  readPromptRepairPlan, repairApprovedSourcePrompts, verifyApprovedSourceAdoption,
  APPROVED_SOURCE_REPAIR_INPUT_SCHEMA, type VerifiedApprovedSourcePlan,
} from "./approved-source-plan.js";
import type { MarketingScope } from "./marketing-authority.js";
import type { ProjectLease } from "./archive-host.js";

const db = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("@workloom/db", () => ({ getAppPool: () => ({ connect: db.connect }) }));
type Row = Awaited<ReturnType<typeof approvedSourceFixture>>["row"];
const scope = { tenantId: "tenant-source-plan", workspaceId: "ws-source-plan" }, projectId = "VID-source-plan";
const createdAt = "2026-11-05T00:00:00.000Z";
let workDir: string, fixture: Awaited<ReturnType<typeof approvedSourceFixture>>, rows: Row[], held: boolean;
let projectExists: boolean;
beforeEach(async () => {
  vi.restoreAllMocks();
  workDir = await realpath(await mkdtemp(path.join(tmpdir(), "approved-source-plan-")));
  vi.stubEnv("HR_WORK_DIR", workDir);
  fixture = await approvedSourceFixture({ workDir, scope: { ...scope, projectId, runId: "RUN-source", attempt: 4 }, createdAt });
  vi.stubEnv("HR_PORTRAIT_REUSE_MANIFEST", fixture.portraitManifest.path);
  rows = [fixture.row]; held = false; projectExists = true;
  db.connect.mockImplementation(async () => {
    let currentTenant = "", currentWorkspace = "";
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("set_config('app.tenant_id'")) currentTenant = String(params[0]);
      if (sql.includes("set_config('app.workspace_id'")) currentWorkspace = String(params[0]);
      if (sql.includes("pg_try_advisory_lock")) {
        if (held) return { rows: [{ ok: false }], rowCount: 1 };
        held = true; return { rows: [{ ok: true }], rowCount: 1 };
      }
      if (sql.includes("pg_advisory_unlock")) { held = false; return { rows: [{ ok: true }], rowCount: 1 }; }
      const permitted = currentTenant === scope.tenantId && currentWorkspace === scope.workspaceId;
      if (sql.includes("SELECT title, kind")) return { rows: permitted && projectExists ? [{ title: "Synthetic fixture", kind: "marketing", thread_id: null, created_at: createdAt }] : [], rowCount: permitted ? 1 : 0 };
      if (sql.includes("FROM production_stage_runs")) {
        let found = permitted ? rows.filter(row => params[0] === scope.workspaceId && params[1] === projectId) : [];
        if (sql.includes("AND attempt=$3")) found = found.filter(row => row.attempt === params[2]);
        if (sql.includes("AND id=$3")) found = found.filter(row => row.id === params[2]);
        if (sql.includes("r.run_id=$2")) found = permitted ? rows.filter(row => row.run_id === params[1]).map(row => ({ ...row,
          project_id: projectId, error_msg: row.status === "failed" ? "Synthetic G6 rejection" : null,
          started_at: createdAt, finished_at: row.status === "running" ? null : createdAt })) : [];
        if (sql.includes("ORDER BY")) found = [...found].sort((a, b) => b.attempt - a.attempt).slice(0, 1);
        return { rows: structuredClone(found), rowCount: found.length };
      }
      return { rows: [], rowCount: 0 };
    });
    return { query, release: vi.fn() };
  });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("A read-only source plan must not call a provider"); }));
});
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(workDir, { recursive: true, force: true }); });

async function launchFixture(_scope: typeof scope, input: { plan: VerifiedApprovedSourcePlan; lease: ProjectLease }, fail = true) {
  const plan = input.plan, attempt = Math.max(...rows.map(row => row.attempt)) + 1, runId = `RUN-repair-${attempt}`;
  const target: MarketingScope = { ...scope, projectId, runId, attempt };
  const inputRef = `stages/preproduction/attempt-${attempt}.input.json`, outputRef = `stages/preproduction/attempt-${attempt}.output.json`;
  rows.push({ id: `SR-${runId}`, attempt, run_id: runId, input_ref: inputRef, output_ref: null as unknown as string,
    output_sha256: null as unknown as string, status: "running", error_class: null as unknown as string });
  await fixture.store.writeJsonAtomic(inputRef, { stageId: "preproduction", attempt,
    input: { pipelineKind: "marketing", isMarketing: true, scenePolicy: plan.selection.scenePolicy,
      approvedSourceRepair: { schemaVersion: APPROVED_SOURCE_REPAIR_INPUT_SCHEMA, planDigest: plan.planDigest,
        sourceAttempt: plan.source.scope.attempt, sourceRunId: plan.source.scope.runId, sourceStageRunId: plan.source.stageRunId,
        runId, adoptionRef: `stages/preproduction/attempt-${attempt}.approved-source-adoption.json` },
      resumeSnapshot: createPreproductionResumeSnapshot({ scope: { ...scope, projectId, runId }, projectCreatedAt: createdAt, request: plan.request }) } });
  const adoption = await adoptApprovedSourcePlan(plan, { scope: target });
  if (fail) {
    const result = { success: false, degraded: false,
      productionEvidence: { schemaVersion: "workloom.preproduction-authority/v1", issuer: "workloom.studio-worker", ...target,
        pipelineKind: "marketing", gates: [], approvedSourceRepair: { adoptionRef: adoption.ref, adoptionSha256: adoption.sha256, planDigest: plan.planDigest } },
      retainedDraft: { sourceStageRunId: plan.currentDraftSource.stageRunId, sourceRunId: plan.currentDraftSource.scope.runId,
        sourceAttempt: plan.currentDraftSource.scope.attempt, outputRef: plan.currentDraftSource.outputRef,
        outputSha256: plan.currentDraftSource.outputSha256, planDigest: plan.planDigest } };
    const receipt = await fixture.store.writeJsonAtomic(outputRef, result);
    Object.assign(rows.at(-1)!, { status: "failed", output_ref: outputRef, output_sha256: receipt.sha256, error_class: "GATE_REJECTED" });
  }
  await input.lease.release();
  return { runId, attempt, adoption, target };
}

async function retainReviewedFailedDraft(original: VerifiedApprovedSourcePlan) {
  let started: Awaited<ReturnType<typeof launchFixture>> | undefined;
  await repairApprovedSourcePrompts(scope, { projectId, expectedLatestAttempt: original.source.scope.attempt, planDigest: original.planDigest }, async (...args) => {
    started = await launchFixture(...args, false); return started;
  });
  const target = started!.target, root = path.join(fixture.runDir, "gates", projectId, `attempt-${target.attempt}`, "prompt-quality");
  await mkdir(root, { recursive: true });
  const contracts = [];
  for (const shot of original.contracts) {
    const fields = { ...shot.fields, timeline: "T00:00至T00:05观察商品，T00:05至T00:10轻轻点头，完整保留最新草稿动作。" };
    const compiled = compilePromptShot({ shotId: shot.shotId, duration: shot.duration, fields }, shot.compileOptions);
    expect(compiled.hardErrors).toEqual([]);
    const file = path.join(root, `prompt-contract-${shot.shotId}.json`), bytes = JSON.stringify(compiled.contract);
    await writeFile(file, bytes);
    contracts.push({ shotId: shot.shotId, path: file, sha256: fixtureHash(bytes), contract: compiled.contract });
  }
  const reportPath = path.join(root, "semantic-quality-report.json"), report = JSON.stringify({ schemaVersion: "workloom.video-prompt-quality/v2",
    findings: [{ shotId: "ending", field: "composition", blocking: true, repairClass: "semantic", code: "LATEST_DRAFT_COMPOSITION_CONFLICT", detail: "最新草稿构图需要修正" }] });
  await writeFile(reportPath, report);
  const quality = { schemaVersion: "workloom.video-prompt-quality/v2", mode: "enforce", contracts, semanticReportPath: reportPath, sha256: { semanticReport: fixtureHash(report) } };
  const output = { success: false, degraded: false, productionEvidence: { schemaVersion: "workloom.preproduction-authority/v1", issuer: "workloom.studio-worker", ...target,
    pipelineKind: "marketing", approvedSourceRepair: { adoptionRef: started!.adoption.ref, adoptionSha256: started!.adoption.sha256, planDigest: original.planDigest },
    gates: [{ gate: "G6_PROMPT", approved: false, promptQuality: { evidence: quality }, evidence: [
      ...contracts.map(item => ({ path: item.path, sha256: item.sha256, scope: "complete-text" })),
      { path: reportPath, sha256: fixtureHash(report), scope: "complete-text" } ] }] } };
  const saved = await fixture.store.writeJsonAtomic(`stages/preproduction/attempt-${target.attempt}.output.json`, output);
  Object.assign(rows.at(-1)!, { status: "failed", output_ref: `stages/preproduction/attempt-${target.attempt}.output.json`, output_sha256: saved.sha256, error_class: "GATE_REJECTED" });
}

describe("verified approved-source planning", () => {
  it("reads the complete current originals and canonically restores two shots without any provider or source write", async () => {
    const dto = await readPromptRepairPlan(scope, projectId);
    expect(dto).toMatchObject({ kind: "ready", expectedLatestAttempt: 4, sourceRunId: "RUN-source", retainedShotCount: 2,
      retainedGates: ["G1", "G2", "G3", "G4"], sourceCollectedAt: fixture.collectedAt,
      sourceExpiresAt: new Date(Date.parse(fixture.collectedAt) + 24 * 3600_000).toISOString(),
      authoringFields: [{ shotId: "opening", field: "timeline", reason: "时间轴缺少已审点头动作" }] });
    const plan = await prepareApprovedSourcePlan(scope, projectId);
    expect(plan.contracts.map(shot => shot.shotId)).toEqual(["opening", "ending"]);
    expect(plan.rootApprovalSource).toEqual(plan.source);
    expect(plan.currentDraftSource).toEqual(plan.source);
    expect(plan.sourceFacts.bundle.scope).toEqual(fixture.scope);
    expect(plan.sourceContext.gates.G4).toContain("本次 G4 执行与核验计划原文");
    expect(plan.request.metadata).not.toHaveProperty("platform");
    expect(plan.request.metadata).not.toHaveProperty("builtinCharacterSelection");
    expect(plan.selection.exportMetadata).toMatchObject({ platform: "douyin", builtinCharacterSelection: { mode: "builtin" } });
    expect(plan.selection.exportMetadata.characters).toEqual(plan.selection.exportCharacters);
    expect(plan.selection.exportCharacters).toEqual((plan.g4.approvedRequirementContract.cast as { characters: unknown }).characters);
    expect(plan.planDigest).toBe((dto as { planDigest: string }).planDigest);
    expect(await readFile(path.join(fixture.store.root, fixture.row.input_ref))).toEqual(fixture.sourceInputBytes);
    expect(await readFile(path.join(fixture.store.root, fixture.row.output_ref))).toEqual(fixture.sourceOutputBytes);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["missing", "profile-mismatch"] as const)("does not invent an export cast when the approved cast is %s", async castState => {
    fixture = await approvedSourceFixture({ workDir, scope: fixture.scope, createdAt, castState }); rows = [fixture.row];
    expect(await readPromptRepairPlan(scope, projectId)).toMatchObject({ kind: "unavailable",
      code: castState === "missing" ? "SOURCE_CAST_UNAVAILABLE" : "SOURCE_CAST_PORTRAIT_MISMATCH" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["missing", "conflict"] as const)("does not select a default export platform for a %s explicit platform", async platformState => {
    fixture = await approvedSourceFixture({ workDir, scope: fixture.scope, createdAt, platformState }); rows = [fixture.row];
    expect(await readPromptRepairPlan(scope, projectId)).toMatchObject({ kind: "unavailable", code: "SOURCE_PLATFORM_UNAVAILABLE" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not accept a caller-created capability or modified in-memory metadata", async () => {
    expect(() => assertVerifiedApprovedSourcePlan({} as VerifiedApprovedSourcePlan)).toThrow("宿主读取和核验");
    const plan = await prepareApprovedSourcePlan(scope, projectId);
    expect(Reflect.set(plan, "verifyCurrent", async () => undefined)).toBe(false);
    plan.request.metadata.product = "different product";
    await expect(plan.verifyCurrent()).rejects.toMatchObject({ code: "PLAN_CHANGED" });
  });
  it("can explicitly plan new authoring for a truly absent action binding using the exact original compiler finding", async () => {
    fixture = await approvedSourceFixture({ workDir, scope: fixture.scope, createdAt, omitField: "action" }); rows = [fixture.row];
    const plan = await prepareApprovedSourcePlan(scope, projectId);
    expect(plan.contracts[0]!.sourceContract.bindings).toHaveLength(24);
    expect(plan.contracts[0]!.fields).not.toHaveProperty("action");
    expect(plan.contracts[0]!.fieldProofs.some(proof => proof.field === "action")).toBe(false);
    expect(plan.contracts[0]!.unboundFields).toEqual([expect.objectContaining({ field: "action", sourceState: "canonical-unbound", valueSha256: null })]);
    expect(publicPromptRepairPlan(plan).authoringFields).toEqual([{ shotId: "opening", field: "action", reason: "原始完整编译器报告此字段缺失，没有原值摘要" }]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["constraint", "negative"])("does not author a structurally missing immutable request field: %s", async omitField => {
    fixture = await approvedSourceFixture({ workDir, scope: fixture.scope, createdAt, omitField }); rows = [fixture.row];
    expect(await readPromptRepairPlan(scope, projectId)).toMatchObject({ kind: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects a rehashed source-input mutation that was never reviewed by the original G1", async () => {
    const envelope = JSON.parse(fixture.sourceInputBytes.toString("utf8"));
    const snapshot = envelope.input.resumeSnapshot;
    snapshot.request.metadata.unreviewedInstruction = "replace the approved story";
    envelope.input.resumeSnapshot = createPreproductionResumeSnapshot({ scope: snapshot.scope,
      projectCreatedAt: snapshot.projectCreatedAt, request: snapshot.request });
    await fixture.store.writeJsonAtomic(fixture.row.input_ref, envelope);
    expect(await readPromptRepairPlan(scope, projectId)).toMatchObject({ kind: "unavailable", code: "SOURCE_REQUEST_G1_MISMATCH" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["resolution", "fps", "generateAudio"] as const)("rejects an immutable %s conflict against the approved G4 before dispatch", async key => {
    fixture = await approvedSourceFixture({ workDir, scope: fixture.scope, createdAt,
      compileModel: { ...fixture.options.model, resolutions: ["1080p", "720p"] },
      compileDelivery: { ...fixture.options.delivery, [key]: key === "resolution" ? "720p" : key === "fps" ? 60 : false } }); rows = [fixture.row];
    expect(await readPromptRepairPlan(scope, projectId)).toMatchObject({ kind: "unavailable", code: "SOURCE_IMMUTABLE_DELIVERY_CONFLICT" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["tenant", "workspace", "project"])("does not expose or launch a source across %s", async kind => {
    const other = { ...scope, ...(kind === "tenant" ? { tenantId: "another" } : kind === "workspace" ? { workspaceId: "another" } : {}) };
    if (kind === "project") projectExists = false;
    expect(await readPromptRepairPlan(other, kind === "project" ? "other-project" : projectId)).toMatchObject({ kind: "unavailable" });
    const launch = vi.fn(launchFixture);
    expect(await repairApprovedSourcePrompts(other, { projectId, expectedLatestAttempt: 4, planDigest: "a".repeat(64) }, launch)).toMatchObject({ kind: "stale" });
    expect(launch).not.toHaveBeenCalled();
  });
  it.each(["running", "done", "interrupted", "unknown-receipt"])("cannot plan an unsafe %s latest attempt", async kind => {
    if (kind === "unknown-receipt") rows[0]!.error_class = "RECEIPT_UNVERIFIED";
    else rows[0]!.status = kind;
    expect(await readPromptRepairPlan(scope, projectId)).toMatchObject({ kind: "unavailable", code: "SOURCE_NOT_FAILED" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["input", "output", "G1", "G4", "source-text", "contract", "portrait"])("rechecks exact %s bytes immediately before work", async kind => {
    const plan = await prepareApprovedSourcePlan(scope, projectId);
    const file = kind === "input" ? path.join(fixture.store.root, fixture.row.input_ref)
      : kind === "output" ? path.join(fixture.store.root, fixture.row.output_ref)
      : kind === "G1" ? fixture.gateFiles[0]!.path : kind === "G4" ? fixture.gateFiles[3]!.path
        : kind === "source-text" ? fixture.sourceTextPath : kind === "contract" ? fixture.contractFiles[0]!.path
          : path.join(fixture.runDir, "characters", projectId, "fixture-person", "front.png");
    await writeFile(file, "tampered");
    await expect(plan.verifyCurrent()).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("retains the original collection clock and rejects it once the actual source TTL expires", async () => {
    const plan = await prepareApprovedSourcePlan(scope, projectId), now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 25 * 3600_000);
    await expect(plan.verifyCurrent()).rejects.toThrow("MARKETING_FACTS_EXPIRED");
    expect((await readPromptRepairPlan(scope, projectId)).kind).toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects symlinked original gate bytes even when their digest matches", async () => {
    const original = fixture.gateFiles[3]!.path, replacement = path.join(workDir, "same-bytes-outside-gate.md");
    await writeFile(replacement, await readFile(original)); await unlink(original); await symlink(replacement, original);
    expect(await readPromptRepairPlan(scope, projectId)).toMatchObject({ kind: "unavailable", code: "SOURCE_PATH_INVALID" });
  });
});

describe("one durable repair operation per plan", () => {
  it("reconnects a lost response to the same run after failure without a second claim or model call", async () => {
    const plan = await prepareApprovedSourcePlan(scope, projectId), request = { projectId, expectedLatestAttempt: 4, planDigest: plan.planDigest };
    const launch = vi.fn(launchFixture);
    const first = await repairApprovedSourcePrompts(scope, request, launch);
    expect(first).toMatchObject({ kind: "started", runId: "RUN-repair-5", sourceAttempt: 4 });
    const second = await repairApprovedSourcePrompts(scope, request, launch);
    expect(second).toEqual({ kind: "started", runId: "RUN-repair-5", sourceAttempt: 4, deduped: true });
    expect(launch).toHaveBeenCalledTimes(1); expect(rows).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("returns busy for a competing lease and stale for changed plan bytes without launching", async () => {
    const plan = await prepareApprovedSourcePlan(scope, projectId), launch = vi.fn(launchFixture);
    held = true;
    expect(await repairApprovedSourcePrompts(scope, { projectId, expectedLatestAttempt: 4, planDigest: plan.planDigest }, launch)).toMatchObject({ kind: "busy" });
    held = false;
    expect(await repairApprovedSourcePrompts(scope, { projectId, expectedLatestAttempt: 4, planDigest: "a".repeat(64) }, launch)).toMatchObject({ kind: "stale" });
    expect(launch).not.toHaveBeenCalled(); expect(held).toBe(false);
  });
  it("never reclaims an already recognized operation when its adoption receipt is missing", async () => {
    const plan = await prepareApprovedSourcePlan(scope, projectId), request = { projectId, expectedLatestAttempt: 4, planDigest: plan.planDigest };
    const launch = vi.fn(launchFixture); await repairApprovedSourcePrompts(scope, request, launch);
    await unlink(path.join(fixture.store.root, "stages/preproduction/attempt-5.approved-source-adoption.json"));
    expect(await repairApprovedSourcePrompts(scope, request, launch)).toMatchObject({ kind: "stale" });
    expect(launch).toHaveBeenCalledTimes(1); expect(rows).toHaveLength(2);
  });
  it("returns a reconciliation state for malformed persisted adoption bytes without claiming again", async () => {
    const plan = await prepareApprovedSourcePlan(scope, projectId), request = { projectId, expectedLatestAttempt: 4, planDigest: plan.planDigest };
    const launch = vi.fn(launchFixture); await repairApprovedSourcePrompts(scope, request, launch);
    await writeFile(path.join(fixture.store.root, "stages/preproduction/attempt-5.approved-source-adoption.json"), "not-json");
    expect(await repairApprovedSourcePrompts(scope, request, launch)).toMatchObject({ kind: "stale", message: expect.stringContaining("无法核实") });
    expect(launch).toHaveBeenCalledTimes(1); expect(rows).toHaveLength(2); expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps the same historical approval root across two failed authors and uses the last valid canonical draft", async () => {
    const firstPlan = await prepareApprovedSourcePlan(scope, projectId), first = await repairApprovedSourcePrompts(scope,
      { projectId, expectedLatestAttempt: 4, planDigest: firstPlan.planDigest }, launchFixture);
    expect(first.kind).toBe("started");
    const nextPlan = await prepareApprovedSourcePlan(scope, projectId);
    expect(nextPlan.source.scope.attempt).toBe(5); expect(nextPlan.currentDraftSource.scope.attempt).toBe(4);
    expect(nextPlan.rootApprovalSource.scope.attempt).toBe(4);
    expect(publicPromptRepairPlan(nextPlan).sourceCollectedAt).toBe(fixture.collectedAt);
    expect(await repairApprovedSourcePrompts(scope, { projectId, expectedLatestAttempt: 5, planDigest: nextPlan.planDigest }, launchFixture)).toMatchObject({ kind: "started", runId: "RUN-repair-6" });
    const thirdPlan = await prepareApprovedSourcePlan(scope, projectId);
    expect(thirdPlan.source.scope.attempt).toBe(6); expect(thirdPlan.currentDraftSource.scope.attempt).toBe(4);
    expect(thirdPlan.rootApprovalSource.scope).toEqual(fixture.scope);
    expect(thirdPlan.approvedGates.G4_PRD.artifact.ref).toBe(fixture.gateFiles[3]!.path);
    expect(thirdPlan.sourceFacts.bundle.scope).toEqual(fixture.scope);
    expect(thirdPlan.sourceFacts.bundle.collectedAt).toBe(fixture.collectedAt);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses the newest genuinely reviewed failed G6 draft on the next repair while preserving the original approval root", async () => {
    const original = await prepareApprovedSourcePlan(scope, projectId);
    await retainReviewedFailedDraft(original);
    const next = await prepareApprovedSourcePlan(scope, projectId);
    expect(next.source.scope.attempt).toBe(5); expect(next.currentDraftSource.scope.attempt).toBe(5);
    expect(next.rootApprovalSource.scope).toEqual(fixture.scope);
    expect(next.contracts.every(shot => String(shot.fields.timeline).includes("最新草稿动作"))).toBe(true);
    expect(next.fieldPlan.diagnoses).toMatchObject([{ shotId: "ending", field: "composition", code: "LATEST_DRAFT_COMPOSITION_CONFLICT" }]);
    expect(next.approvedGates.G4_PRD.artifact.ref).toBe(fixture.gateFiles[3]!.path);
    expect(next.sourceFacts.bundle.collectedAt).toBe(fixture.collectedAt);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([[4, "approval root"], [5, "current canonical draft"], [6, "previous failed source"], [7, "latest failed source"]] as const)(
    "does not use an unverified external receipt from attempt %i (%s) anywhere in repair lineage", async (unsafeAttempt, _role) => {
      await retainReviewedFailedDraft(await prepareApprovedSourcePlan(scope, projectId));
      for (const attempt of [5, 6]) {
        const plan = await prepareApprovedSourcePlan(scope, projectId);
        expect(plan.source.scope.attempt).toBe(attempt);
        await repairApprovedSourcePrompts(scope, { projectId, expectedLatestAttempt: attempt, planDigest: plan.planDigest }, launchFixture);
      }
      const before = await prepareApprovedSourcePlan(scope, projectId);
      expect([before.rootApprovalSource.scope.attempt, before.currentDraftSource.scope.attempt, before.source.scope.attempt]).toEqual([4, 5, 7]);
      rows.find(row => row.attempt === unsafeAttempt)!.error_class = "RECEIPT_UNVERIFIED";
      expect(await readPromptRepairPlan(scope, projectId)).toMatchObject({ kind: "unavailable" });
      const launch = vi.fn(launchFixture);
      expect(await repairApprovedSourcePrompts(scope, { projectId, expectedLatestAttempt: 7, planDigest: before.planDigest }, launch)).toMatchObject({ kind: "stale" });
      expect(launch).not.toHaveBeenCalled(); expect(rows).toHaveLength(4); expect(fetch).not.toHaveBeenCalled();
    }, 15_000,
  );
  it("rehydrates and verifies a durable adoption without the original in-memory capability", async () => {
    const plan = await prepareApprovedSourcePlan(scope, projectId);
    let launchResult: Awaited<ReturnType<typeof launchFixture>> | undefined;
    await repairApprovedSourcePrompts(scope, { projectId, expectedLatestAttempt: 4, planDigest: plan.planDigest }, async (...args) => {
      launchResult = await launchFixture(...args); return launchResult;
    });
    const actual = launchResult!;
    const restored = await verifyApprovedSourceAdoption({ scope: actual.target, root: fixture.store.root,
      ref: actual.adoption.ref, sha256: actual.adoption.sha256 });
    expect(restored.plan).not.toBe(plan);
    expect(restored.plan.planDigest).toBe(plan.planDigest);
    expect(restored.sourceScope).toEqual(fixture.scope);
    expect(restored.manifest).toEqual(actual.adoption.manifest);
    expect(restored.sourceFacts.bundle.collectedAt).toBe(fixture.collectedAt);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("makes run status visible from the scoped durable stage after a process registry reset", async () => {
    const plan = await prepareApprovedSourcePlan(scope, projectId);
    await repairApprovedSourcePrompts(scope, { projectId, expectedLatestAttempt: 4, planDigest: plan.planDigest }, launchFixture);
    expect(await readPersistedPreproductionRun(scope, "RUN-repair-5")).toMatchObject({ projectId, status: "failed", error: "Synthetic G6 rejection", resultSummary: { persisted: true, success: false, attempt: 5 } });
    expect(await readPersistedPreproductionRun({ ...scope, tenantId: "other" }, "RUN-repair-5")).toBeNull();
  });
});
