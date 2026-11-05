/** Explicit host repair run: retain verified sources, author diagnosed fields, then run current gates. */
import path from "node:path";
import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { getGatewayPool } from "@workloom/db";
import { GatewayEventSink, poolFromEnv } from "@workloom/base/model-router";
import { gatewayAppend } from "@workloom/base/workdata";
import { newId } from "@workloom/shared";
import {
  ArchiveStore, StageRunner, WorkloomLLMEngine, auditScenePolicy, fieldSpec, resolveVideoModel, sha256Json,
  type GateKey, type ScenePolicyException, type ScenePolicyShot,
} from "@hyperreality/video-studio";
import { evaluateVideoSystemAutoApproval, VIDEO_SYSTEM_AUTO_APPROVAL_POLICY } from "@hyperreality/video-pipeline";
import { loadPipelineFeatureFlags, type AutoApprovalCheck } from "@workloom/pipeline-control";
import { modelPolicyFor } from "../service/llm.js";
import { archiveWorkDir, makeLedgerWriter, readProjectMeta, serializeProjectArchive, type ProjectLease } from "./archive-host.js";
import { createPreproductionResumeSnapshot } from "./archive-resume.js";
import {
  APPROVED_SOURCE_REPAIR_INPUT_SCHEMA, adoptApprovedSourcePlan, assertVerifiedApprovedSourcePlan,
  type ApprovedSourceScope, type VerifiedApprovedSourcePlan,
} from "./approved-source-plan.js";
import { authorRepairFields, type FieldAuthoringArchiveInput, type FieldAuthoringShot } from "./approved-source-fields.js";
import { finalizeMarketingFacts, prepareAdoptedMarketingFacts } from "./marketing-authority.js";
import { canonicalRenderJson, renderSha256 } from "./gen/compiled-request.js";
import { getModel, resolveProviderModel } from "./gen/catalog.js";
import { systemAutoApprovalEnabled, writeGateArtifact } from "./gate-policy.js";
import { buildServerGateRecord, withGateLedger } from "./gate-ledger-bridge.js";
import { acceptPortraitArchiveReuse, portraitReuseEvidence, readCurrentPortraitArchiveCopies } from "./portrait-reuse-acceptance.js";
import { resolveScenePolicyForIntent } from "./scene-policy-routing.js";
import {
  createLlmSemanticQualityReviewer, evaluatePromptPackage, promptContractSummary, promptQualityAutoChecks,
  verifyCurrentPromptContracts, writePromptQualityEvidence,
} from "./prompt-quality-gate.js";
import type { RunEntry } from "./studio-worker.js";

type Json = Record<string, unknown>;
const actor = { id: "video-studio", type: "system" as const };
function fail(detail: string): never { throw new Error(`APPROVED_SOURCE_REPAIR_${detail}`); }

/** The caller owns the lease until this promise returns a persisted input + adoption receipt. */
export async function startApprovedSourceRepairWorker(
  scope: ApprovedSourceScope,
  input: { plan: VerifiedApprovedSourcePlan; lease: ProjectLease },
  register: (entry: RunEntry) => void,
): Promise<{ runId: string; attempt: number }> {
  const { plan, lease } = input;
  assertVerifiedApprovedSourcePlan(plan);
  const projectId = plan.source.scope.projectId;
  if (scope.tenantId !== plan.source.scope.tenantId || scope.workspaceId !== plan.source.scope.workspaceId
    || lease.projectId !== projectId) fail("SCOPE_MISMATCH");
  await plan.verifyLatest(lease);
  if ((process.env.ARCHIVE_ENABLED ?? "1") === "0" || loadPipelineFeatureFlags(process.env).promptContract !== "enforce") {
    fail("ENFORCEMENT_REQUIRED");
  }
  // Reuse the installed model route and its existing accounting/quota policy. No repair-specific cap or alternate model.
  const llm = WorkloomLLMEngine.fromEnv();
  if (!llm) fail("LLM_MISSING");
  llm.attachRouter({ providers: poolFromEnv(), sink: new GatewayEventSink(getGatewayPool(), scope, actor),
    policy: modelPolicyFor("ai-video"), scene: "preproduction", forceModel: resolveVideoModel(process.env) || undefined });
  const selectedPolicy = resolveScenePolicyForIntent(plan.request.rawIntent, plan.request.metadata);
  if (canonicalRenderJson(selectedPolicy.decision) !== canonicalRenderJson(plan.selection.scenePolicy)) fail("SCENE_POLICY_CHANGED");
  const assertModel = () => {
    for (const shot of plan.contracts) {
      const expected = shot.sourceContract.modelCapabilities, model = getModel(expected.modelId);
      if (!model || model.kind !== "video" || model.availability !== "wired"
        || model.provider !== expected.provider || resolveProviderModel(model, process.env) !== expected.providerModel
        || canonicalRenderJson(model.modes) !== canonicalRenderJson(expected.modes)
        || canonicalRenderJson({ min: model.limits?.durationSec?.min ?? 1, max: model.limits?.durationSec?.max ?? 120 }) !== canonicalRenderJson(expected.durationSec)
        || canonicalRenderJson(model.limits?.aspectRatios) !== canonicalRenderJson(expected.aspectRatios)
        || canonicalRenderJson(model.limits?.resolutions) !== canonicalRenderJson(expected.resolutions)
        || model.limits?.maxReferenceImages !== expected.maxReferenceImages || model.limits?.maxPromptChars !== expected.maxPromptChars) {
        fail("MODEL_CAPABILITIES_CHANGED");
      }
    }
  };
  assertModel();
  const startedAt = Date.now(), deadlineMs = Number(process.env.VM_TOTAL_DEADLINE_MS ?? 3_600_000);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) fail("DEADLINE_INVALID");
  const archive = new ArchiveStore(path.resolve(archiveWorkDir()), scope.workspaceId, projectId, "marketing", {}, serializeProjectArchive(scope, projectId));
  if (archive.root !== plan.archiveRoot) fail("ARCHIVE_CHANGED");
  const entry: RunEntry = { runId: newId("RUN"), projectId, workspaceId: scope.workspaceId, status: "running",
    currentGate: null, pendingApprovalId: null, startedAt: new Date().toISOString(), finishedAt: null,
    error: null, resultSummary: null, aborted: false };
  register(entry);
  const runner = new StageRunner(archive, makeLedgerWriter(scope), entry.runId);
  let resolveStarted!: (value: { runId: string; attempt: number }) => void;
  let rejectStarted!: (error: unknown) => void;
  const startup = new Promise<{ runId: string; attempt: number }>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
  let transferred = false;
  let receiptUnverified = false;
  const modelCallOutcomes: Json[] = [];
  const verifyCurrent = async () => {
    if (entry.aborted) fail("ABORTED");
    if (Date.now() - startedAt >= deadlineMs) fail("DEADLINE_EXPIRED");
    assertModel();
    await plan.verifyCurrent(lease);
    await runner.currentContext()?.heartbeat({ mode: plan.mode, gate: entry.currentGate, runId: entry.runId });
  };
  const verifyDispatch = async () => {
    if (receiptUnverified) fail("RECEIPT_UNVERIFIED: 模型调用的计量、原生回执或终态未核实，须先对账，不能重新派发");
    await verifyCurrent();
  };
  const append = async (action: string, after: Json) => {
    await archive.appendJsonl("events.jsonl", { kind: action, runId: entry.runId, ...after });
    await gatewayAppend(getGatewayPool(), { ...scope, actor }, {
      who: actor, context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: "video_project", id: projectId }, decision: { action, after: { runId: entry.runId, ...after } }, rule_impact: [],
    });
  };
  void (async () => {
    const project = await readProjectMeta(scope, projectId);
    if (!project || project.kind !== "marketing" || project.createdAt !== plan.source.projectCreatedAt) fail("PROJECT_CHANGED");
    await archive.ensure({ kind: project.kind, title: project.title, createdAt: project.createdAt });
    await runner.run("preproduction", ctx => ({ intent: plan.request.intent, isMarketing: true, pipelineKind: "marketing",
      scenePolicy: plan.selection.scenePolicy,
      resumeSnapshot: createPreproductionResumeSnapshot({ scope: { ...scope, projectId, runId: entry.runId },
        projectCreatedAt: project.createdAt, request: plan.request }),
      approvedSourceRepair: { schemaVersion: APPROVED_SOURCE_REPAIR_INPUT_SCHEMA, planDigest: plan.planDigest,
        sourceAttempt: plan.source.scope.attempt, sourceRunId: plan.source.scope.runId, sourceStageRunId: plan.source.stageRunId,
        runId: entry.runId, adoptionRef: `stages/preproduction/attempt-${ctx.attempt}.approved-source-adoption.json` },
    }), async ctx => {
      const targetScope = { ...scope, projectId, runId: entry.runId, attempt: ctx.attempt };
      const adoption = await adoptApprovedSourcePlan(plan, { scope: targetScope });
      await verifyCurrent();
      // StageRunner has durably written this exact attempt's input before entering the function.
      transferred = true;
      resolveStarted({ runId: entry.runId, attempt: ctx.attempt });
      await append("run.started", { mode: plan.mode, attempt: ctx.attempt, sourceAttempt: plan.source.scope.attempt });
      await append("video.scene_policy.selected", { ...selectedPolicy.decision });
      const evidence: Json[] = [];
      const save = async (ref: string, value: unknown) => {
        const receipt = await ctx.writeArtifact(ref, value);
        if (!receipt || receipt.truncated) fail("ARTIFACT_INCOMPLETE");
        return { ref, sha256: receipt.sha256 };
      };
      const archiveAuthoring = async (item: FieldAuthoringArchiveInput) => {
        const index = plan.contracts.findIndex(shot => shot.shotId === item.shotId);
        if (index < 0 || renderSha256(Buffer.from(item.bytes)) !== item.sha256) fail("AUTHORING_ARCHIVE_UNBOUND");
        const ref = `stages/preproduction/attempt-${ctx.attempt}.authoring/shot-${index + 1}.${item.kind}.json`;
        const file = path.join(archive.root, ref), directory = path.dirname(file);
        await mkdir(directory, { recursive: true });
        if (await realpath(archive.root) !== archive.root || await realpath(directory) !== directory) fail("AUTHORING_PATH_INVALID");
        const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(item.bytes); await handle.sync(); } finally { await handle.close(); }
        return { ref, sha256: item.sha256 };
      };
      let authored: Awaited<ReturnType<typeof authorRepairFields>>;
      try {
        authored = await authorRepairFields({ plan: plan.fieldPlan, sourceContext: plan.sourceContext, engine: llm, verifyCurrent: verifyDispatch,
          budgetHook: async event => {
            if (event.phase === "dispatch") modelCallOutcomes.push({ stage: "field-authoring", shotId: event.shotId,
              nativeInvocationStarted: true, dispatchOutcome: "pending", nativeCompleted: false, usage: null });
            if (event.phase === "after") {
              let call = [...modelCallOutcomes].reverse().find(item => item.stage === "field-authoring" && item.shotId === event.shotId && item.dispatchOutcome === "pending");
              if (!call) { call = { stage: "field-authoring", shotId: event.shotId, nativeInvocationStarted: true }; modelCallOutcomes.push(call); }
              Object.assign(call, { dispatchOutcome: event.dispatchOutcome ?? "unverified", nativeCompleted: event.nativeCompleted === true,
                usage: event.usage ?? null, success: event.success === true });
              receiptUnverified ||= call.dispatchOutcome !== "verified-complete";
            }
            await ctx.log("info", "approved-source-field-authoring", { ...event, policy: "existing-preproduction-model-route" });
          },
          archive: archiveAuthoring });
      } catch (error) {
        receiptUnverified ||= modelCallOutcomes.some(item => item.dispatchOutcome !== "verified-complete");
        const detail = error instanceof Error ? error.message : String(error), draft = plan.currentDraftSource;
        const message = receiptUnverified ? `RECEIPT_UNVERIFIED: ${detail}；模型原生计量或完成回执待核实，不能重新派发` : detail;
        entry.error = message;
        // A rejected answer is archived by the author, but never promoted to a current field draft.
        return { output: { success: false, degraded: false, mode: plan.mode, failureMessage: message,
          productionEvidence: { schemaVersion: "workloom.preproduction-authority/v1", issuer: "workloom.studio-worker", ...targetScope,
            pipelineKind: "marketing", gates: [], approvedSourceRepair: { mode: plan.mode, planDigest: plan.planDigest,
              adoptionRef: adoption.ref, adoptionSha256: adoption.sha256 } },
          retainedDraft: { sourceStageRunId: draft.stageRunId, sourceRunId: draft.scope.runId, sourceAttempt: draft.scope.attempt,
            outputRef: draft.outputRef, outputSha256: draft.outputSha256, planDigest: plan.planDigest },
          modelCallOutcomes, stages: ["approved-source-field-authoring"], authoring: { status: receiptUnverified ? "unverified" : "failed",
            callOutcomes: modelCallOutcomes, artifactDirectory: `stages/preproduction/attempt-${ctx.attempt}.authoring` } },
          outcome: { status: receiptUnverified ? "interrupted" as const : "failed" as const,
            errorClass: receiptUnverified ? "RECEIPT_UNVERIFIED" : "GATE_REJECTED", errorMsg: message } };
      }
      await verifyCurrent();
      await save(`stages/preproduction/attempt-${ctx.attempt}.authored-fields.json`, { schemaVersion: "workloom.approved-source-authored-fields/v1",
        sourceAdoption: { ref: adoption.ref, sha256: adoption.sha256 }, ...authored });
      const copies = readCurrentPortraitArchiveCopies({ workDir: plan.workDir, projectId,
        manifest: { path: plan.portraits.manifestPath, sha256: plan.portraits.manifestSha256 } });
      entry.currentGate = "G5_PORTRAIT";
      // This host operation rechecks the four existing copies; it dispatches no portrait generation.
      const portraitProof = acceptPortraitArchiveReuse({ workDir: plan.workDir, projectId,
        manifest: { path: plan.portraits.manifestPath, sha256: plan.portraits.manifestSha256 },
        stage: { status: "completed", characters: 1, products: 0, completedPortraits: copies.outputs.length, pendingPortraits: 0,
          reusedPortraits: copies.outputs.length, generatedPortraits: 0 } });
      evidence.push({ gate: "G5_PORTRAIT", approved: true, status: "passed", via: "archive-reuse-acceptance", degraded: false,
        model: null, evidence: portraitReuseEvidence(portraitProof), archiveReuse: portraitProof, operation: "verify-retained-project-copies" });
      await append("video.portrait.reuse.accepted", { attempt: ctx.attempt, sourceAdoption: adoption.ref, proof: evidence.at(-1)! });
      await verifyCurrent();
      entry.currentGate = "G6_PROMPT";
      const compiledAt = new Date().toISOString();
      const shots = authored.shots.map(shot => ({ source: sourceShot(shot), compile: { ...structuredClone(shot.compileOptions),
        createdAt: shot.currentContract?.createdAt ?? compiledAt } }));
      const quality = await evaluatePromptPackage({ mode: "enforce", projectId, runId: entry.runId, stageRunId: `${entry.runId}:g6`,
        revision: ctx.attempt, shots, reviewer: createLlmSemanticQualityReviewer(llm, verifyDispatch, async outcome => {
          modelCallOutcomes.push({ stage: "prompt-quality", nativeInvocationStarted: true, ...outcome });
          receiptUnverified ||= outcome.dispatchOutcome === "unverified";
          await ctx.log("info", "approved-source-semantic-dispatch", { ...outcome });
        }),
        maxFinalPromptChars: fieldSpec().lengths.hardMax,
        upstreamContext: { pipelineKind: "marketing", intent: plan.request.intent, brief: plan.request.metadata.brief ?? null,
          approvedProductionPlan: plan.g4.approvedProductionPlan } });
      await verifyCurrent();
      const qualityFiles = writePromptQualityEvidence(path.join(plan.workDir, "gates", projectId, `attempt-${ctx.attempt}`, "prompt-quality"), quality);
      const qualityEvidence = [
        ...qualityFiles.contracts.map(item => ({ path: item.path, sha256: item.sha256, scope: "complete-text" })),
        { path: qualityFiles.semanticReportPath, sha256: qualityFiles.sha256.semanticReport, scope: "complete-text" },
        { path: qualityFiles.decisionPath, sha256: qualityFiles.sha256.decision, scope: "complete-text" },
        ...(qualityFiles.repairPlanPath ? [{ path: qualityFiles.repairPlanPath, sha256: qualityFiles.sha256.repairPlan!, scope: "complete-text" }] : []),
        ...(qualityFiles.repairAttemptPath ? [{ path: qualityFiles.repairAttemptPath, sha256: qualityFiles.sha256.repairAttempt!, scope: "complete-text" }] : []),
      ];
      const summary = promptContractSummary(quality.shotContracts.map(item => item.contract));
      const g6 = await decideGate("G6_PROMPT", quality.status === "passed" && quality.g6Eligible && !receiptUnverified,
        { decisionId: quality.decision.id, promptContract: summary, promptQuality: { schemaVersion: quality.schemaVersion,
          mode: quality.mode, status: quality.status, checkedAt: quality.checkedAt, decisionId: quality.decision.id,
          g6Eligible: quality.g6Eligible, renderEligible: quality.renderEligible,
          approvedProductionPlanSha256: quality.approvedProductionPlanSha256 ?? null, evidence: qualityFiles } },
        qualityEvidence, promptQualityAutoChecks(quality), "llm", quality.decision.reviewer.model ?? llm.model);
      const finalShots = quality.shotContracts.map(item => ({ ...structuredClone(item.source), shotId: item.shotId,
        duration: item.contract.request.parameters.duration_sec, prompt: item.contract.prompt, fields: structuredClone(item.source.fields) }));
      const promptPack = { schemaVersion: "workloom.preproduction-prompt-pack/v1", stageId: "preproduction", attempt: ctx.attempt,
        pipelineKind: "marketing", mode: plan.mode, shotCount: finalShots.length, fieldsTrimmed: false,
        scenePolicy: selectedPolicy.decision, totalPromptChars: finalShots.reduce((sum, shot) => sum + shot.prompt.length, 0),
        shots: finalShots.map(shot => ({ ...shot, durationSec: shot.duration, degraded: false })) };
      // Preserve actual current contracts and diagnostics even when G6 blocks the new draft.
      const prompts = await save(`stages/preproduction/attempt-${ctx.attempt}.prompts.json`, promptPack);
      let eligible = false;
      if (g6.approved === true) {
        entry.currentGate = "G7_FINAL";
        await verifyCurrent();
        const current = verifyCurrentPromptContracts({ shots: quality.shotContracts.map((item, index) => ({ source: finalShots[index]!,
          compile: shots[index]!.compile })), maxFinalPromptChars: fieldSpec().lengths.hardMax }, summary);
        const assignedDrift = current.contracts.filter((contract, index) => finalShots[index]?.prompt !== contract.prompt)
          .map(contract => `FINAL_ASSIGNED_PROMPT_DRIFT:${contract.shotId}`);
        eligible = current.valid && assignedDrift.length === 0 && quality.approvedProductionPlanSha256 === sha256Json(plan.g4.approvedProductionPlan);
        const eligibility = { schemaVersion: "workloom.video-render-eligibility/v2", projectId, runId: entry.runId, attempt: ctx.attempt,
          g6DecisionId: quality.decision.id, approvedProductionPlanSha256: sha256Json(plan.g4.approvedProductionPlan),
          promptContracts: summary, current: eligible, eligible, reasons: [...current.reasons, ...assignedDrift] };
        const eligibilityArtifact = writeGateArtifact(plan.workDir, path.join(projectId, `attempt-${ctx.attempt}`), "render-eligibility", canonicalRenderJson(eligibility));
        const g7 = await decideGate("G7_FINAL", eligible, { promptContract: summary,
          renderEligibility: { eligible, reasons: eligibility.reasons, path: eligibilityArtifact.path, sha256: renderSha256(canonicalRenderJson(eligibility)) } },
        [{ path: eligibilityArtifact.path, sha256: renderSha256(canonicalRenderJson(eligibility)), scope: "complete-text" }],
        [{ id: "g6-contract-current", category: "deterministic", status: eligible ? "passed" : "failed", detail: eligibility.reasons.join(",") || "current G6 contracts and approved source remain unchanged", evidenceRef: eligibilityArtifact.path }], "deterministic", null);
        eligible = eligible && g7.approved === true;
      }
      await verifyCurrent();
      const hostSource = { kind: plan.mode, issuer: "workloom.studio-worker", ...targetScope, adoption: { ref: adoption.ref, sha256: adoption.sha256 } };
      const exportedMetadata = structuredClone(plan.selection.exportMetadata);
      const shotlist = { schemaVersion: "workloom.preproduction-cli-handoff/v1", projectId, title: project.title,
        source: hostSource,
        metadata: { ...exportedMetadata,
          ...(exportedMetadata.source !== undefined ? { inputSource: structuredClone(exportedMetadata.source) } : {}), source: hostSource },
        characters: structuredClone(plan.selection.exportCharacters), draft: true,
        retainedApprovedSource: { ref: adoption.ref, sha256: adoption.sha256 }, scenePolicySelection: selectedPolicy.decision,
        ...(selectedPolicy.policy ? { scenePolicy: { id: selectedPolicy.policy.id, version: selectedPolicy.policy.version,
          sourceSha256: selectedPolicy.policy.sourceSha256, exceptions: (plan.request.metadata.scenePolicy as { exceptions?: ScenePolicyException[] } | undefined)?.exceptions ?? [] } } : {}),
        shots: finalShots, durationSeconds: finalShots.reduce((sum, shot) => sum + Number(shot.duration), 0) };
      const sheet = await save(`stages/preproduction/attempt-${ctx.attempt}.shotlist.json`, shotlist);
      let sceneEvidence: Json = {};
      if (selectedPolicy.policy) {
        const report = auditScenePolicy({ title: plan.request.rawIntent, scenePolicy: shotlist.scenePolicy,
          shots: finalShots as ScenePolicyShot[] }, selectedPolicy.policy);
        report.policy.selection = selectedPolicy.decision.reason;
        const receipt = await save(`stages/preproduction/attempt-${ctx.attempt}.scene-policy-report.json`, report);
        sceneEvidence = { scenePolicyReportRef: receipt.ref, scenePolicyReportSha256: receipt.sha256, scenePolicyPassed: report.passed,
          shotlistRef: sheet.ref, shotlistSha256: sheet.sha256 };
        eligible = eligible && report.passed;
      }
      const marketing = await prepareAdoptedMarketingFacts({ root: archive.root, scope: targetScope, adoption });
      let facts: Awaited<ReturnType<typeof finalizeMarketingFacts>> | undefined, factFailure: string | undefined;
      if (eligible) {
        try { facts = await finalizeMarketingFacts(marketing, promptPack.shots.map(shot => ({ shotId: shot.shotId,
          prompt: shot.prompt, fields: shot.fields })), process.env, verifyDispatch, async outcome => {
          modelCallOutcomes.push({ stage: "marketing-final-facts", ...outcome });
          receiptUnverified ||= outcome.dispatchOutcome === "unverified";
          await ctx.log("info", "approved-source-final-facts-dispatch", { ...outcome });
        }); }
        catch (error) {
          receiptUnverified ||= (error as { code?: string })?.code === "RECEIPT_UNVERIFIED";
          factFailure = error instanceof Error ? error.message : String(error);
        }
      }
      await verifyCurrent();
      const success = eligible && Boolean(facts) && !receiptUnverified, failure = success ? null : receiptUnverified
        ? `RECEIPT_UNVERIFIED: ${factFailure ?? "模型调用的计量、原生完成回执或终态未核实"}；须先对账，不能重新派发`
        : factFailure
        ?? (quality.findings.map(finding => `${finding.shotId}/${finding.code}: ${finding.detail}`).join("；") || "当前G5/G6/G7或片型硬闸未通过");
      entry.error = failure;
      return { output: { success, degraded: false, mode: plan.mode, ...(failure ? { failureMessage: failure } : {}),
        productionEvidence: { schemaVersion: "workloom.preproduction-authority/v1", issuer: "workloom.studio-worker", ...targetScope,
          pipelineKind: "marketing", gates: evidence, approvedSourceRepair: { mode: plan.mode, planDigest: plan.planDigest,
            adoptionRef: adoption.ref, adoptionSha256: adoption.sha256 } },
        promptsRef: prompts.ref, promptsSha256: prompts.sha256, promptShotCount: promptPack.shotCount,
        cliShotlistRef: sheet.ref, cliShotlistSha256: sheet.sha256, ...sceneEvidence,
        ...(facts ? { marketingFactsRef: facts.ref, marketingFactsSha256: facts.sha256 } : {}),
        ...(factFailure ? { marketingFinalFactsFailure: { stage: "marketing-final-fact-review", message: factFailure } } : {}),
        modelCallOutcomes, authoring: { snapshotSha256: authored.snapshotSha256, receipts: authored.receipts }, stages: ["approved-source-field-authoring", "portrait-reuse-verification", "prompt-quality", ...(g6.approved ? ["final-currentness"] : [])] },
        ...(success ? {} : { outcome: { status: receiptUnverified ? "interrupted" as const : "failed" as const,
          errorClass: receiptUnverified ? "RECEIPT_UNVERIFIED" : "GATE_REJECTED", errorMsg: failure } }) };

      async function decideGate(gate: GateKey, passed: boolean, extra: Json, files: Json[], checks: AutoApprovalCheck[], via: string, model: string | null): Promise<Json> {
        await verifyCurrent();
        const content = canonicalRenderJson({ mode: plan.mode, sourceAdoption: { ref: adoption.ref, sha256: adoption.sha256 }, ...targetScope, ...extra });
        const artifact = writeGateArtifact(plan.workDir, path.join(projectId, `attempt-${ctx.attempt}`), gate, content), contentHash = renderSha256(content);
        const auto = evaluateVideoSystemAutoApproval(systemAutoApprovalEnabled(), { gateKey: gate, action: `video.${gate.toLowerCase()}.confirm`,
          artifactSha256: contentHash, factHash: contentHash, expectedFactHash: contentHash,
          deterministicChecks: [...checks, { id: "approved-source-current", category: "deterministic", status: "passed", detail: "original approvals, facts TTL, fields and images reread under current project lease", evidenceRef: adoption.ref },
            { id: "current-gate-verdict", category: "deterministic", status: passed ? "passed" : "failed", detail: passed ? "current gate passed" : "current gate blocked", evidenceRef: artifact.path }],
          budget: { status: "not_applicable", detail: "this gate decision dispatches no media request; actual text calls use the existing native route", evidenceRef: artifact.path },
          qualification: { status: "passed", detail: "exact complete artifact", evidenceRef: artifact.path },
          permission: { status: "passed", detail: "current authorized project scope", evidenceRef: `${scope.tenantId}/${scope.workspaceId}` },
          fence: { status: "passed", level: "review", detail: "review gate follows every mandatory check", evidenceRef: VIDEO_SYSTEM_AUTO_APPROVAL_POLICY.version, triggeredBy: [gate] },
          evidenceRefs: [{ id: `gate:${gate}`, kind: "file", sha256: contentHash, ref: path.relative(plan.workDir, artifact.path) }] });
        const approved = passed && auto.outcome === "passed";
        const proof = { gate, approved, status: approved ? "passed" : "failed", via, model, degraded: false,
          evidence: [{ path: artifact.path, sha256: contentHash, scope: "complete-text" }, ...files], autoApproval: auto.receipt, ...extra };
        evidence.push(proof);
        await append("system-auto-approval", withGateLedger({ ...proof, attempt: ctx.attempt }, buildServerGateRecord({ gate,
          vendorType: plan.mode, sourceStage: "apps/server:approved-source-repair", projectId, runId: entry.runId,
          approved, verdict: { approved, via, degraded: false, model } })));
        await verifyCurrent();
        return proof;
      }
    });
    entry.status = entry.error ? "failed" : "finished";
    entry.currentGate = null;
    entry.resultSummary = { success: entry.status === "finished", mode: plan.mode, sourceAttempt: plan.source.scope.attempt };
  })().catch(error => {
    entry.status = "failed";
    entry.error = error instanceof Error ? error.message : String(error);
    entry.resultSummary = { success: false, mode: plan.mode, sourceAttempt: plan.source.scope.attempt };
    rejectStarted(error);
    console.error(`[approved-source-repair] ${projectId}/${entry.runId}: ${entry.error}`);
  }).finally(async () => {
    if (transferred) {
      try { await lease.release(); }
      catch (error) { entry.status = "failed"; entry.error = [entry.error, `运行租约释放失败：${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join("；"); }
    }
    entry.finishedAt = new Date().toISOString();
  });
  return startup;
}

function sourceShot(shot: FieldAuthoringShot): Json {
  return { shotId: shot.shotId, duration: shot.duration, fields: structuredClone(shot.fields), prompt: shot.prompt,
    ...(shot.sceneId ? { sceneId: shot.sceneId } : {}), ...(shot.sceneType ? { sceneType: shot.sceneType } : {}),
    ...(shot.noPeople === undefined ? {} : { noPeople: shot.noPeople }),
    sourceContractSha256: shot.sourceContractSha256, ...(shot.authoringProof ? { authoringProof: structuredClone(shot.authoringProof) } : {}) };
}
