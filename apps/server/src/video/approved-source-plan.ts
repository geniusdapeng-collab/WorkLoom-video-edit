/** Explicit, source-bound prompt repair. Historical approvals remain historical. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  ArchiveStore, canonicalJson, platformIdOf, sha256Json, type PrdMarketingAuthority,
} from "@hyperreality/video-studio";
import { assertSystemAutoApprovalReceipt } from "@workloom/pipeline-control";
import { VIDEO_SYSTEM_AUTO_APPROVAL_POLICY } from "@hyperreality/video-pipeline";
import {
  acquireProjectLease, archiveWorkDir, readProjectMeta, scopedRows, type ProjectLease,
} from "./archive-host.js";
import { verifiedResumeRequest, type PreproductionResumeRequest } from "./archive-resume.js";
import {
  MARKETING_FACTS_TTL_MS, assertMarketingFactsFresh, restoreApprovedMarketingFactsSource,
  type MarketingFactsBundle, type MarketingScope, type PreparedMarketingFacts,
} from "./marketing-authority.js";
import { loadPortraitReuseManifest, readCurrentPortraitArchiveCopies } from "./portrait-reuse-acceptance.js";
import { readApprovedProductionPlan } from "./approved-production-plan.js";
import {
  planFieldAuthoring, recoverContractFields,
  type AllowedFieldPlan, type RecoveredPromptShot, type VerifiedFieldArtifact,
} from "./approved-source-fields.js";

type Json = Record<string, unknown>;
export interface ApprovedSourceScope { tenantId: string; workspaceId: string }
export const APPROVED_SOURCE_REPAIR_MODE = "approved-source-prompt-repair" as const;
export const APPROVED_SOURCE_REPAIR_INPUT_SCHEMA = "workloom.approved-source-repair-input/v1" as const;
export const APPROVED_SOURCE_ADOPTION_SCHEMA = "workloom.approved-source-adoption/v1" as const;
const hashPattern = /^[a-f0-9]{64}$/u;
const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const gateKeys = ["G1_DOSSIER", "G2_THEME", "G3_INSIGHT", "G4_PRD"] as const;
type SourceGate = typeof gateKeys[number];

export class ApprovedSourcePlanError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ApprovedSourcePlanError"; }
}
function fail(code: string, detail: string): never { throw new ApprovedSourcePlanError(code, detail); }
function record(value: unknown, code = "SOURCE_INVALID"): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json
    : fail(code, "修复来源缺少完整对象，不能继续。");
}
function component(value: unknown): string {
  if (typeof value !== "string" || !value || value.trim() !== value || value === "." || value === ".."
    || /[/\\\0]/u.test(value)) return fail("SCOPE_INVALID", "项目或工作区标识无效。");
  return value;
}
function checkedHash(value: unknown): string {
  return typeof value === "string" && hashPattern.test(value) ? value : fail("SOURCE_HASH_INVALID", "修复来源没有有效摘要。");
}
function parsed(bytes: Uint8Array): Json {
  try { return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
  catch (error) {
    if (error instanceof ApprovedSourcePlanError) throw error;
    return fail("SOURCE_JSON_INVALID", "修复来源不是完整可解析的 JSON。");
  }
}
function inside(root: string, file: string): boolean { return file.startsWith(`${root}${path.sep}`); }

/** Read a real, bounded, nonsymlink file and bind the exact bytes, never a summary. */
async function readBound(root: string, file: string, expected?: string, maximum = 32_000_000): Promise<Buffer> {
  const base = path.resolve(root), canonical = path.resolve(file);
  if (!inside(base, canonical) || path.isAbsolute(file) && canonical !== file
    || await realpath(base) !== base || await realpath(canonical) !== canonical) {
    return fail("SOURCE_PATH_INVALID", "修复证据越界或经过符号链接。");
  }
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > maximum) return fail("SOURCE_FILE_INVALID", "修复证据为空、非文件或超过完整读取上限。");
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size || expected !== undefined && sha256(bytes) !== checkedHash(expected)) {
      return fail("SOURCE_CHANGED", "修复来源原始字节已变化，请重新检查。");
    }
    return bytes;
  } finally { await handle.close(); }
}

export interface ApprovedSourceIdentity {
  scope: MarketingScope;
  projectCreatedAt: string | null;
  stageRunId: string;
  status: string;
  inputRef: string;
  inputSha256: string;
  outputRef: string;
  outputSha256: string;
}
export interface ApprovedSourceGate {
  artifact: { ref: string; sha256: string; content: string };
  proof: Json;
}
export interface VerifiedApprovedSourcePlan {
  readonly mode: typeof APPROVED_SOURCE_REPAIR_MODE;
  readonly planDigest: string;
  /** Immutable approval root; it can be older than the latest failed draft. */
  readonly rootApprovalSource: ApprovedSourceIdentity;
  /** Last valid canonical draft; an invalid author response never replaces it. */
  readonly currentDraftSource: ApprovedSourceIdentity;
  readonly source: ApprovedSourceIdentity;
  readonly request: PreproductionResumeRequest & { isMarketing: true };
  readonly approvedGates: Record<SourceGate, ApprovedSourceGate>;
  readonly sourceFacts: { bundle: MarketingFactsBundle; g1ContentSha256: string };
  readonly g4: {
    content: string; sourceAuthority: Json; approvedRequirementContract: Json; planning: Json;
    approvedProductionPlan: ReturnType<typeof readApprovedProductionPlan>;
  };
  readonly contracts: RecoveredPromptShot[];
  readonly fieldPlan: AllowedFieldPlan;
  readonly sourceContext: {
    brief: unknown; gates: { G1: string; G2: string; G3: string; G4: string };
    approvedProductionPlan: ReturnType<typeof readApprovedProductionPlan>;
  };
  readonly portraits: { manifestPath: string; manifestSha256: string };
  readonly selection: {
    scenePolicy: unknown; platform: unknown; characters: unknown; approvedSelection: unknown;
    /** New export projection from verified G4 selections; the original request remains byte-bound. */
    exportMetadata: Json; exportCharacters: Json[];
  };
  readonly archiveRoot: string;
  readonly workDir: string;
  readonly sourceExpiresAt: string;
  /** Every model/review/qualification boundary calls this; it never refreshes old source times. */
  verifyCurrent(lease?: ProjectLease): Promise<void>;
  /** Only the launcher may turn the source into a newly claimed attempt. */
  verifyLatest(lease: ProjectLease): Promise<void>;
}
interface PlanState {
  scope: ApprovedSourceScope;
  immutableSha256: string;
  files: Array<{ path: string; root: string; sha256: string; maximum?: number }>;
  target?: MarketingScope;
}
const verifiedPlans = new WeakMap<VerifiedApprovedSourcePlan, PlanState>();
export function assertVerifiedApprovedSourcePlan(plan: VerifiedApprovedSourcePlan): void {
  if (!verifiedPlans.has(plan)) return fail("PLAN_UNVERIFIED", "修复计划必须由当前宿主读取和核验，不能由调用方构造。");
}
function immutableBody(plan: VerifiedApprovedSourcePlan): Json {
  const { verifyCurrent: _current, verifyLatest: _latest, planDigest: _digest, ...body } = plan;
  return body;
}

export interface PromptRepairReady {
  kind: "ready";
  mode: typeof APPROVED_SOURCE_REPAIR_MODE;
  projectId: string;
  expectedLatestAttempt: number;
  sourceRunId: string;
  planDigest: string;
  sourceCollectedAt: string;
  sourceExpiresAt: string;
  retainedGates: ["G1", "G2", "G3", "G4"];
  retainedShotCount: number;
  authoringFields: Array<{ shotId: string; field: string; reason: string }>;
  warnings: string[];
}
export interface PromptRepairUnavailable { kind: "unavailable"; projectId: string; code: string; message: string }
export type PromptRepairPlanDto = PromptRepairReady | PromptRepairUnavailable;
export interface PromptRepairRequest { projectId: string; expectedLatestAttempt: number; planDigest: string }
export type PromptRepairLaunch =
  | { kind: "started"; runId: string; sourceAttempt: number; deduped?: true }
  | { kind: "busy" | "stale"; message: string };

interface SourceRow {
  id: string; attempt: number; run_id: string | null; input_ref: string | null;
  output_ref: string | null; output_sha256: string | null; status: string; error_class: string | null;
}
const sourceSelect = `SELECT id,attempt,run_id,input_ref,output_ref,output_sha256,status,error_class
  FROM production_stage_runs
 WHERE workspace_id=$1 AND project_id=$2 AND stage_id='preproduction' AND pipeline_run_id IS NULL
   AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id=production_stage_runs.workspace_id
     AND w.tenant_id=current_setting('app.tenant_id',true))`;
const latestSelect = `${sourceSelect} ORDER BY attempt DESC LIMIT 1`;
async function rowsFor(scope: ApprovedSourceScope, projectId: string, lease?: ProjectLease): Promise<SourceRow[]> {
  return lease
    ? lease.withScopedTransaction(async client => (await client.query<SourceRow>(latestSelect, [scope.workspaceId, projectId])).rows)
    : scopedRows<SourceRow>(scope, latestSelect, [scope.workspaceId, projectId]);
}
function sourceRowMatches(row: SourceRow | undefined, source: ApprovedSourceIdentity): boolean {
  return Boolean(row && row.id === source.stageRunId && Number(row.attempt) === source.scope.attempt
    && row.run_id === source.scope.runId && row.status === source.status && row.error_class !== "RECEIPT_UNVERIFIED"
    && row.input_ref === source.inputRef && row.output_ref === source.outputRef && row.output_sha256 === source.outputSha256);
}

function annex(markdown: string, title: string): Json {
  const sections = markdown.split(`\n## ${title}\n\n`);
  if (sections.length !== 2) return fail("SOURCE_G4_INVALID", "原 G4 缺少唯一完整的生产要求与执行计划附件。");
  const fenced = /```json\n([\s\S]*?)\n```(?:\n|$)/u.exec(sections[1]!.split("\n## ", 1)[0]!);
  if (!fenced) return fail("SOURCE_G4_INVALID", "原 G4 附件缺少完整 JSON。");
  return parsed(Buffer.from(fenced[1]!));
}

function sourceScope(value: unknown, scope: MarketingScope): void {
  const item = record(value);
  if (Object.keys(item).length !== 5 || !["tenantId", "workspaceId", "projectId", "runId", "attempt"].every(key => item[key] === scope[key as keyof MarketingScope])) {
    return fail("SOURCE_SCOPE_MISMATCH", "修复来源不属于同一租户、工作区、项目、运行与尝试。");
  }
}

function identityFor(row: SourceRow, scope: MarketingScope, createdAt: string, inputBytes: Uint8Array, outputBytes: Uint8Array): ApprovedSourceIdentity {
  return { scope: { ...scope }, projectCreatedAt: createdAt, stageRunId: row.id, status: row.status,
    inputRef: row.input_ref!, inputSha256: sha256(inputBytes), outputRef: row.output_ref!, outputSha256: sha256(outputBytes) };
}

/** Build an in-memory host capability from the current failed attempt, without any model call or write. */
export async function prepareApprovedSourcePlan(scope: ApprovedSourceScope, projectId: string): Promise<VerifiedApprovedSourcePlan> {
  return loadApprovedSourcePlan(scope, projectId);
}

/** Durable adoption is the only branch allowed to load a historical source below the latest target. */
async function loadApprovedSourcePlan(
  scope: ApprovedSourceScope, projectId: string, adopted?: { sourceAttempt: number; target: MarketingScope },
): Promise<VerifiedApprovedSourcePlan> {
  component(scope.tenantId); component(scope.workspaceId); component(projectId);
  const project = await readProjectMeta(scope, projectId);
  if (!project || project.kind !== "marketing" || !project.createdAt) return fail("SOURCE_PROJECT_UNAVAILABLE", "当前项目没有可复用的营销预生产来源。");
  const [row] = adopted
    ? await scopedRows<SourceRow>(scope, `${sourceSelect} AND attempt=$3`, [scope.workspaceId, projectId, adopted.sourceAttempt])
    : await rowsFor(scope, projectId);
  if (adopted) {
    sourceScope(adopted.target, { ...scope, projectId, runId: adopted.target.runId, attempt: adopted.sourceAttempt + 1 });
    const [target] = await rowsFor(scope, projectId);
    if (!target || target.attempt !== adopted.target.attempt || target.run_id !== adopted.target.runId) return fail("ADOPTION_SUPERSEDED", "来源交接目标不再是当前最新预生产尝试。");
  }
  if (!row || row.status !== "failed" || row.error_class === "RECEIPT_UNVERIFIED"
    || !row.run_id || !Number.isSafeInteger(Number(row.attempt)) || Number(row.attempt) < 1) {
    return fail("SOURCE_NOT_FAILED", "仅能从有明确失败回执的最新预生产尝试修复；运行中或外部结果待核实不能重跑。");
  }
  const attempt = Number(row.attempt), sourceMarketingScope = { ...scope, projectId, runId: row.run_id, attempt };
  const stem = `stages/preproduction/attempt-${attempt}`;
  if (row.input_ref !== `${stem}.input.json` || row.output_ref !== `${stem}.output.json`) return fail("SOURCE_REF_INVALID", "失败尝试的输入或输出索引不完整。");
  const workDir = path.resolve(archiveWorkDir()), runWorkDir = path.join(workDir, "workspaces", scope.workspaceId);
  const archive = new ArchiveStore(workDir, scope.workspaceId, projectId, "marketing");
  const manifest = await archive.readManifest();
  if (!manifest || manifest.pipelineKind !== "marketing" || manifest.projectIdentity?.createdAt !== project.createdAt
    || manifest.projectIdentity.kind !== "marketing") return fail("SOURCE_PROJECT_CHANGED", "档案与当前项目建档身份不一致。");
  const files: PlanState["files"] = [];
  const read = async (root: string, file: string, expected?: string, maximum?: number): Promise<Buffer> => {
    const bytes = await readBound(root, file, expected, maximum);
    files.push({ root, path: file, sha256: sha256(bytes), ...(maximum ? { maximum } : {}) });
    return bytes;
  };
  const readArchivedIdentity = async (value: unknown, beforeAttempt: number) => {
    const declared = record(value), identityScope = record(declared.scope);
    const sourceAttempt = Number(identityScope.attempt), sourceRunId = component(identityScope.runId);
    sourceScope(identityScope, { ...scope, projectId, runId: sourceRunId, attempt: sourceAttempt });
    if (!Number.isSafeInteger(sourceAttempt) || sourceAttempt < 1 || sourceAttempt >= beforeAttempt) return fail("SOURCE_DRAFT_LINEAGE_INVALID", "保留草稿必须来自更早的实际尝试。");
    const [actualRow] = await scopedRows<SourceRow>(scope, `${sourceSelect} AND attempt=$3`, [scope.workspaceId, projectId, sourceAttempt]);
    const inputRef = `stages/preproduction/attempt-${sourceAttempt}.input.json`, outputRef = `stages/preproduction/attempt-${sourceAttempt}.output.json`;
    if (!actualRow || actualRow.status !== "failed" || actualRow.error_class === "RECEIPT_UNVERIFIED"
      || actualRow.input_ref !== inputRef || actualRow.output_ref !== outputRef) return fail("SOURCE_DRAFT_LINEAGE_CHANGED", "保留草稿没有完整真实失败回执。");
    const retainedInput = await read(archive.root, path.join(archive.root, inputRef), checkedHash(declared.inputSha256));
    const retainedOutput = await read(archive.root, path.join(archive.root, outputRef), checkedHash(actualRow.output_sha256));
    const actual = identityFor(actualRow, { ...scope, projectId, runId: sourceRunId, attempt: sourceAttempt }, project.createdAt!, retainedInput, retainedOutput);
    if (!isDeepStrictEqual(declared, actual) || !sourceRowMatches(actualRow, actual)) return fail("SOURCE_DRAFT_LINEAGE_CHANGED", "保留草稿的完整身份或字节摘要已变化。");
    return { identity: actual, output: parsed(retainedOutput) };
  };
  const inputBytes = await read(archive.root, path.join(archive.root, row.input_ref));
  const outputBytes = await read(archive.root, path.join(archive.root, row.output_ref), checkedHash(row.output_sha256));
  const envelope = parsed(inputBytes), output = parsed(outputBytes);
  const input = record(envelope.input);
  const request = verifiedResumeRequest(envelope, {
    scope: { ...scope, projectId, runId: row.run_id }, attempt, createdAt: project.createdAt, isMarketing: true,
  });
  if (!request || request.isMarketing !== true || input.pipelineKind !== "marketing" || output.success !== false || output.degraded === true) {
    return fail("SOURCE_INPUT_UNVERIFIED", "失败尝试没有完整、同项目身份的原始请求或真实失败产物。");
  }
  const source = identityFor(row, sourceMarketingScope, project.createdAt, inputBytes, outputBytes);
  const evidence = record(output.productionEvidence);
  if (evidence.schemaVersion !== "workloom.preproduction-authority/v1" || evidence.issuer !== "workloom.studio-worker"
    || evidence.pipelineKind !== "marketing") return fail("SOURCE_AUTHORITY_INVALID", "失败尝试没有宿主生产来源证明。");
  sourceScope(Object.fromEntries(["tenantId", "workspaceId", "projectId", "runId", "attempt"].map(key => [key, evidence[key]])), sourceMarketingScope);
  if (!Array.isArray(evidence.gates)) return fail("SOURCE_GATES_INVALID", "失败尝试缺少原门评审证明。");
  const gates = evidence.gates.map(value => record(value));
  const gateRoot = path.join(runWorkDir, "gates", projectId, `attempt-${attempt}`);
  let rootApprovalSource = source, rootRequest = request, rootEvidence = evidence;
  let previousAdoption: Json | undefined;
  const adoptedRepair = evidence.approvedSourceRepair;
  if (adoptedRepair !== undefined) {
    const repair = record(adoptedRepair), sourceInputRepair = record(input.approvedSourceRepair);
    const adoptionRef = `stages/preproduction/attempt-${attempt}.approved-source-adoption.json`;
    if (repair.adoptionRef !== adoptionRef || sourceInputRepair.adoptionRef !== adoptionRef
      || sourceInputRepair.schemaVersion !== APPROVED_SOURCE_REPAIR_INPUT_SCHEMA
      || sourceInputRepair.runId !== row.run_id || sourceInputRepair.planDigest !== repair.planDigest) {
      return fail("SOURCE_ADOPTION_UNBOUND", "最新失败草稿的历史来源交接未绑定本次输入与输出。");
    }
    previousAdoption = parsed(await read(archive.root, path.join(archive.root, adoptionRef), checkedHash(repair.adoptionSha256)));
    sourceScope(previousAdoption.target, sourceMarketingScope);
    if (previousAdoption.schemaVersion !== APPROVED_SOURCE_ADOPTION_SCHEMA || previousAdoption.mode !== APPROVED_SOURCE_REPAIR_MODE
      || previousAdoption.planDigest !== repair.planDigest) return fail("SOURCE_ADOPTION_INVALID", "最新失败草稿的历史来源交接摘要无效。");
    const rootIdentity = record(previousAdoption.rootApprovalSource), rootScope = record(rootIdentity.scope);
    const rootAttempt = Number(rootScope.attempt), rootRunId = component(rootScope.runId);
    sourceScope(rootScope, { ...scope, projectId, runId: rootRunId, attempt: rootAttempt });
    if (!Number.isSafeInteger(rootAttempt) || rootAttempt < 1 || rootAttempt >= attempt) return fail("SOURCE_ADOPTION_ORDER_INVALID", "历史批准根必须早于最新失败草稿。");
    const [rootRow] = await scopedRows<SourceRow>(scope, `${sourceSelect} AND attempt=$3`, [scope.workspaceId, projectId, rootAttempt]);
    if (!rootRow || rootRow.status !== "failed" || rootRow.error_class === "RECEIPT_UNVERIFIED"
      || rootRow.input_ref !== `stages/preproduction/attempt-${rootAttempt}.input.json`
      || rootRow.output_ref !== `stages/preproduction/attempt-${rootAttempt}.output.json`) return fail("SOURCE_APPROVAL_ROOT_UNVERIFIED", "历史批准根缺少真实失败执行回执。");
    const rootInputBytes = await read(archive.root, path.join(archive.root, rootRow.input_ref), checkedHash(rootIdentity.inputSha256));
    const rootOutputBytes = await read(archive.root, path.join(archive.root, rootRow.output_ref), checkedHash(rootRow.output_sha256));
    rootApprovalSource = identityFor(rootRow, { ...scope, projectId, runId: rootRunId, attempt: rootAttempt }, project.createdAt, rootInputBytes, rootOutputBytes);
    if (!isDeepStrictEqual(rootIdentity, rootApprovalSource) || !sourceRowMatches(rootRow, rootApprovalSource)) return fail("SOURCE_APPROVAL_ROOT_CHANGED", "历史批准根的行、五域或输入输出字节已变化。");
    const rootEnvelope = parsed(rootInputBytes), rootOutput = parsed(rootOutputBytes);
    const verifiedRootRequest = verifiedResumeRequest(rootEnvelope, { scope: { ...scope, projectId, runId: rootRunId },
      attempt: rootAttempt, createdAt: project.createdAt, isMarketing: true });
    rootEvidence = record(rootOutput.productionEvidence);
    sourceScope(Object.fromEntries(["tenantId", "workspaceId", "projectId", "runId", "attempt"].map(key => [key, rootEvidence[key]])), rootApprovalSource.scope);
    if (!verifiedRootRequest || rootOutput.success !== false || rootOutput.degraded === true
      || rootEvidence.schemaVersion !== "workloom.preproduction-authority/v1" || rootEvidence.issuer !== "workloom.studio-worker"
      || rootEvidence.pipelineKind !== "marketing" || record(rootEnvelope.input).pipelineKind !== "marketing"
      || rootEvidence.approvedSourceRepair !== undefined
      || !isDeepStrictEqual(verifiedRootRequest, request)) return fail("SOURCE_ROOT_REQUEST_CHANGED", "递续修复必须保持同一原始完整请求，不能把新需求混入旧批准根。");
    rootRequest = verifiedRootRequest;
    const draft = record(previousAdoption.source), draftScope = record(draft.scope);
    const priorAttempt = Number(draftScope.attempt);
    sourceScope(draftScope, { ...scope, projectId, runId: component(draftScope.runId), attempt: priorAttempt });
    if (!Number.isSafeInteger(priorAttempt) || priorAttempt < rootAttempt || priorAttempt >= attempt || draft.projectCreatedAt !== project.createdAt
      || sourceInputRepair.sourceAttempt !== priorAttempt || sourceInputRepair.sourceRunId !== draftScope.runId
      || sourceInputRepair.sourceStageRunId !== draft.stageRunId) {
      return fail("SOURCE_DRAFT_LINEAGE_INVALID", "递续修复的批准根、前次草稿与当前尝试顺序不符。");
    }
    const [priorRow] = await scopedRows<SourceRow>(scope, `${sourceSelect} AND attempt=$3`, [scope.workspaceId, projectId, priorAttempt]);
    if (!sourceRowMatches(priorRow, draft as unknown as ApprovedSourceIdentity)) return fail("SOURCE_DRAFT_LINEAGE_CHANGED", "前次草稿回执已变化。");
    const priorInput = String(draft.inputRef), priorOutput = String(draft.outputRef);
    if (priorInput !== `stages/preproduction/attempt-${priorAttempt}.input.json` || priorOutput !== `stages/preproduction/attempt-${priorAttempt}.output.json`) return fail("SOURCE_DRAFT_LINEAGE_INVALID", "前次草稿档案路径无效。");
    await read(archive.root, path.join(archive.root, priorInput), checkedHash(draft.inputSha256));
    await read(archive.root, path.join(archive.root, priorOutput), checkedHash(draft.outputSha256));
  }
  if (!Array.isArray(rootEvidence.gates)) return fail("SOURCE_GATES_INVALID", "历史批准根缺少原 G1–G4 评审证明。");
  const rootGates = rootEvidence.gates.map(value => record(value));
  const approvalGateRoot = path.join(runWorkDir, "gates", projectId, `attempt-${rootApprovalSource.scope.attempt}`);
  const approvedGates = {} as Record<SourceGate, ApprovedSourceGate>;
  for (const key of gateKeys) {
    const matches = rootGates.filter(gate => gate.gate === key), proof = matches[0];
    if (matches.length !== 1 || !proof || proof.approved !== true || proof.status !== "passed"
      || proof.via !== "llm" || proof.degraded !== false || typeof proof.model !== "string" || !proof.model.trim()
      || !Array.isArray(proof.evidence)) return fail("SOURCE_GATES_UNVERIFIED", "原 G1–G4 缺少真实完整模型通过证明。");
    const file = path.join(approvalGateRoot, `${key}.md`);
    const entries = proof.evidence.map(value => record(value));
    const own = entries.filter(item => item.path === file);
    if (own.length !== 1 || own[0]?.scope !== "complete-text") return fail("SOURCE_GATE_UNBOUND", "原评审没有绑定本门完整原件。");
    const bytes = await read(approvalGateRoot, file, checkedHash(own[0]!.sha256), 2 * 1024 * 1024);
    const auto = assertSystemAutoApprovalReceipt(proof.autoApproval, { policyId: VIDEO_SYSTEM_AUTO_APPROVAL_POLICY.id,
      policyVersion: VIDEO_SYSTEM_AUTO_APPROVAL_POLICY.version, gateKey: key, outcome: "passed" });
    if (auto.artifactSha256 !== sha256(bytes) || auto.factHash !== sha256(bytes) || auto.expectedFactHash !== sha256(bytes)) {
      return fail("SOURCE_GATE_POLICY_UNBOUND", "原门的系统策略证明与完整原件摘要不一致。");
    }
    for (const item of entries) {
      if (item.scope !== "complete-text" || typeof item.path !== "string") return fail("SOURCE_GATE_UNBOUND", "原评审附件身份不完整。");
      await read(approvalGateRoot, item.path, checkedHash(item.sha256), 2 * 1024 * 1024);
    }
    approvedGates[key] = { artifact: { ref: file, sha256: sha256(bytes), content: bytes.toString("utf8") }, proof: structuredClone(proof) };
  }
  if (previousAdoption && !isDeepStrictEqual(previousAdoption.retainedGates, retainedGateReferences(approvedGates))) return fail("SOURCE_RETAINED_GATES_CHANGED", "递续修复中保留的历史批准原件与真实批准根不一致。");
  const g1 = approvedGates.G1_DOSSIER;
  const g1Body = parsed(Buffer.from(g1.artifact.content));
  if (g1Body.requestedIntent !== rootRequest.intent || !isDeepStrictEqual(g1Body.requestedMetadata, rootRequest.metadata)) {
    return fail("SOURCE_REQUEST_G1_MISMATCH", "原始请求与真实 G1 已审完整请求不一致，不能把自述摘要当作历史输入。");
  }
  const prepared = await restoreApprovedMarketingFactsSource({ root: archive.root, scope: rootApprovalSource.scope,
    g1Content: g1.artifact.content, g1ContentSha256: g1.artifact.sha256, proof: g1.proof, g1ArtifactPath: g1.artifact.ref });
  const g4Content = approvedGates.G4_PRD.artifact.content;
  const authority = annex(g4Content, "宿主本次权威生产与交付要求"), planning = annex(g4Content, "本次 G4 执行与核验计划原文");
  const frozenProfile = record(authority.profile);
  const approvedRequirementContract = record(authority.approvedRequirementContract);
  if (!Array.isArray(approvedRequirementContract.scenes) || !approvedRequirementContract.scenes.length) return fail("SOURCE_SCENES_MISSING", "原 G4 没有完整已审镜头合同。");
  const scenes = approvedRequirementContract.scenes.map(value => record(value));
  let currentDraftSource = source, draftGates = gates;
  if (output.retainedDraft !== undefined) {
    if (!previousAdoption) return fail("SOURCE_RETAINED_DRAFT_UNBOUND", "仅受控修复失败可保留上一份有效草稿。");
    const retained = record(output.retainedDraft), declaredDraft = record(previousAdoption.currentDraftSource);
    const retainedScope = record(declaredDraft.scope);
    if (retained.planDigest !== previousAdoption.planDigest || retained.sourceStageRunId !== declaredDraft.stageRunId
      || retained.sourceRunId !== retainedScope.runId || retained.sourceAttempt !== retainedScope.attempt
      || retained.outputRef !== declaredDraft.outputRef || retained.outputSha256 !== declaredDraft.outputSha256
      || gates.some(gate => gate.gate === "G6_PROMPT")) return fail("SOURCE_RETAINED_DRAFT_UNBOUND", "失败响应不能替换或冒充一份已核验的新 G6 草稿。");
    const lastDraft = await readArchivedIdentity(declaredDraft, attempt);
    currentDraftSource = lastDraft.identity;
    const retainedEvidence = record(lastDraft.output.productionEvidence);
    sourceScope(Object.fromEntries(["tenantId", "workspaceId", "projectId", "runId", "attempt"].map(key => [key, retainedEvidence[key]])), currentDraftSource.scope);
    if (lastDraft.output.success !== false || retainedEvidence.schemaVersion !== "workloom.preproduction-authority/v1"
      || retainedEvidence.issuer !== "workloom.studio-worker" || retainedEvidence.pipelineKind !== "marketing"
      || !Array.isArray(retainedEvidence.gates)) return fail("SOURCE_RETAINED_DRAFT_INVALID", "上一有效草稿缺少真实完整 G6 来源。");
    draftGates = retainedEvidence.gates.map(value => record(value));
  }
  if (currentDraftSource.scope.attempt < rootApprovalSource.scope.attempt) return fail("SOURCE_DRAFT_LINEAGE_INVALID", "有效草稿不能早于历史批准根。");
  const g6Matches = draftGates.filter(gate => gate.gate === "G6_PROMPT"), g6 = g6Matches[0];
  if (g6Matches.length !== 1 || !g6 || !Array.isArray(g6.evidence)) return fail("SOURCE_PROMPTS_MISSING", "失败尝试没有完整 G6 字段合同与诊断产物。");
  const quality = record(record(g6.promptQuality).evidence);
  if (quality.schemaVersion !== "workloom.video-prompt-quality/v2" || quality.mode !== "enforce"
    || !Array.isArray(quality.contracts) || quality.contracts.length !== scenes.length) return fail("SOURCE_PROMPTS_INVALID", "失败尝试没有受控的完整字段合同集合。");
  const g6Evidence = g6.evidence.map(value => record(value));
  const qualityRoot = path.join(runWorkDir, "gates", projectId, `attempt-${currentDraftSource.scope.attempt}`, "prompt-quality");
  const reportPath = quality.semanticReportPath, reportHash = record(quality.sha256).semanticReport;
  if (typeof reportPath !== "string" || g6Evidence.filter(item => item.path === reportPath && item.sha256 === reportHash && item.scope === "complete-text").length !== 1) {
    return fail("SOURCE_DIAGNOSIS_UNBOUND", "原 G6 诊断没有完整原件摘要证明。");
  }
  const reportBytes = await read(qualityRoot, reportPath, checkedHash(reportHash));
  const reportArtifact: VerifiedFieldArtifact = { bytes: reportBytes, expectedSha256: sha256(reportBytes) };
  const contracts: RecoveredPromptShot[] = [];
  for (const scene of scenes) {
    const matches = quality.contracts.map(value => record(value)).filter(item => item.shotId === scene.id);
    const entry = matches[0];
    if (matches.length !== 1 || !entry || typeof entry.path !== "string") return fail("SOURCE_PROMPT_ORDER_INVALID", "G4 场景与完整 G6 合同无法逐一对应。");
    const entryHash = checkedHash(entry.sha256);
    if (g6Evidence.filter(item => item.path === entry.path && item.sha256 === entryHash && item.scope === "complete-text").length !== 1) {
      return fail("SOURCE_PROMPT_UNBOUND", "字段合同没有原 G6 完整字节摘要证明。");
    }
    const bytes = await read(qualityRoot, entry.path, entryHash);
    const shot = recoverContractFields({ contractBytes: bytes, expectedSha256: entryHash,
      missingEvidence: [reportArtifact],
      sceneMetadata: { sceneId: String(scene.id), ...(typeof scene.sceneType === "string" ? { sceneType: scene.sceneType } : {}) } });
    if (shot.shotId !== scene.id || shot.duration !== scene.duration || !isDeepStrictEqual(parsed(bytes), entry.contract)) {
      return fail("SOURCE_PROMPT_SCENE_MISMATCH", "完整字段合同与原 G4 场景或已归档合同对象不一致。");
    }
    for (const [profileKey, parameterKey] of [["aspectRatio", "aspect_ratio"], ["resolution", "resolution"],
      ["frameRate", "fps"], ["nativeAudio", "generate_audio"]] as const) {
      if (frozenProfile[profileKey] !== undefined && !isDeepStrictEqual(shot.sourceContract.request.parameters[parameterKey], frozenProfile[profileKey])) {
        return fail("SOURCE_IMMUTABLE_DELIVERY_CONFLICT", "原草稿的画幅、分辨率、帧率或原声请求与已审要求冲突，字段修复不能改写这些不可变请求。");
      }
    }
    if (typeof request.metadata.modelId === "string" && request.metadata.modelId !== shot.sourceContract.modelCapabilities.modelId) {
      return fail("SOURCE_IMMUTABLE_MODEL_CONFLICT", "原草稿的模型与原始明确选择不一致，不能通过字段修复替换模型。");
    }
    contracts.push(shot);
  }
  if (new Set(contracts.map(shot => shot.shotId)).size !== contracts.length) return fail("SOURCE_PROMPT_DUPLICATE", "原镜头合同重复。");
  const marketingAuthority: PrdMarketingAuthority = { schemaVersion: "workloom.prd-marketing-authority/v1", scope: rootApprovalSource.scope,
    g1Artifact: { path: g1.artifact.ref, sha256: g1.artifact.sha256, content: g1.artifact.content },
    g1Proof: g1.proof as unknown as PrdMarketingAuthority["g1Proof"] };
  const approvedProductionPlan = readApprovedProductionPlan({ workDir: runWorkDir, metadata: rootRequest.metadata,
    marketing: marketingAuthority, proof: approvedGates.G4_PRD.proof, shots: contracts.map(shot => ({ shotId: shot.shotId, duration: shot.duration })) });
  const sourceContext = { brief: request.metadata.brief ?? null, gates: { G1: g1.artifact.content,
    G2: approvedGates.G2_THEME.artifact.content, G3: approvedGates.G3_INSIGHT.artifact.content, G4: g4Content }, approvedProductionPlan };
  const fieldPlan = planFieldAuthoring({ shots: contracts, sourceContextSha256: sha256Json(sourceContext),
    diagnosedFindings: [reportArtifact], truncationEvidence: [] });
  const manifestSetting = process.env.HR_PORTRAIT_REUSE_MANIFEST?.trim();
  if (!manifestSetting) return fail("SOURCE_PORTRAITS_UNAVAILABLE", "当前宿主没有受控的既有角色图片选择，不能重新生成或猜测图片来源。");
  const portraits = loadPortraitReuseManifest(path.resolve(repoRoot, manifestSetting));
  const portraitBinding = { manifestPath: portraits.manifestPath, manifestSha256: portraits.manifestSha256 };
  const approvedCast = record(approvedRequirementContract.cast, "SOURCE_CAST_UNAVAILABLE");
  const castSelection = record(approvedCast.selection, "SOURCE_CAST_UNAVAILABLE");
  if (!["builtin", "custom", "mixed"].includes(String(approvedCast.mode))
    || castSelection.schemaVersion !== "workloom.video-character-selection/v1" || castSelection.mode !== approvedCast.mode
    || !Array.isArray(approvedCast.characters) || !Array.isArray(castSelection.characters)
    || approvedCast.characters.length !== portraits.characters.length || castSelection.characters.length !== approvedCast.characters.length
    || approvedCast.hash !== sha256Json({ mode: approvedCast.mode, selection: castSelection, characters: approvedCast.characters })) {
    return fail("SOURCE_CAST_UNAVAILABLE", "原 G4 没有完整且摘要一致的宿主人物选择与人物档案，不能重新选人。");
  }
  const selectedCastCharacters = castSelection.characters;
  const exportCharacters = approvedCast.characters.map((value, index) => {
    const character = record(value, "SOURCE_CAST_UNAVAILABLE"), choice = record(selectedCastCharacters[index], "SOURCE_CAST_UNAVAILABLE");
    const portrait = portraits.characters[index]!;
    if (character.id !== portrait.id || character.name !== portrait.name || choice.id !== character.id || choice.name !== character.name
      || choice.profileSha256 !== portrait.profile.sha256
      || choice.profilePath !== null && choice.profilePath !== portrait.profile.path
      || !["builtin", "explicit-custom"].includes(String(choice.source))) {
      return fail("SOURCE_CAST_PORTRAIT_MISMATCH", "原 G4 人物选择、档案摘要与当前受控角色图片不是同一份来源。");
    }
    return structuredClone(character);
  });
  // Old failed G6 attempts have no formal shotlist. Reuse their reviewed cast and explicit platform,
  // rather than inventing a past handoff or selecting a new default from current prose.
  const explicitPlatforms = [rootRequest.metadata.platform, frozenProfile.targetPlatform]
    .filter(value => value !== undefined);
  const platformIds = explicitPlatforms.map(value => typeof value === "string" ? platformIdOf(value) : null);
  if (!platformIds.length || platformIds.some(id => id === null || id !== platformIds[0])) {
    return fail("SOURCE_PLATFORM_UNAVAILABLE", "原请求与 G4 缺少一致的明确目标平台，未猜测默认平台或启动修复。");
  }
  const exportMetadata: Json = { ...structuredClone(rootRequest.metadata), platform: platformIds[0],
    characters: structuredClone(exportCharacters), builtinCharacterSelection: structuredClone(castSelection) };
  const copies = readCurrentPortraitArchiveCopies({ workDir: runWorkDir, projectId,
    manifest: { path: portraits.manifestPath, sha256: portraits.manifestSha256 } });
  for (const asset of contracts.flatMap(shot => shot.sourceContract.bindings.flatMap(binding => binding.assets ?? []))) {
    if (!asset.sourceRef) return fail("SOURCE_PORTRAIT_UNBOUND", "原字段合同缺少图片字节来源。");
    const file = path.resolve(runWorkDir, asset.sourceRef);
    const matching = copies.outputs.filter(output => output.path === file && output.sha256 === asset.sha256 && output.bytes === asset.bytes);
    if (matching.length !== 1) return fail("SOURCE_PORTRAIT_CHANGED", "原镜头绑定的图片与当前受控角色图片不一致。");
    await read(runWorkDir, file, asset.sha256);
  }
  const body = {
    mode: APPROVED_SOURCE_REPAIR_MODE, source, rootApprovalSource, currentDraftSource, request: { ...structuredClone(request), isMarketing: true as const },
    approvedGates, sourceFacts: { bundle: prepared.bundle, g1ContentSha256: g1.artifact.sha256 },
    g4: { content: g4Content, sourceAuthority: authority, approvedRequirementContract, planning, approvedProductionPlan },
    contracts, fieldPlan, sourceContext, portraits: portraitBinding,
    selection: { scenePolicy: structuredClone(input.scenePolicy ?? null), platform: structuredClone(request.metadata.platformSelection ?? null),
      characters: structuredClone(portraits.characters), approvedSelection: structuredClone(portraits.approvedSelection),
      exportMetadata, exportCharacters },
    archiveRoot: archive.root, workDir: runWorkDir,
    sourceExpiresAt: new Date(Date.parse(prepared.bundle.collectedAt) + MARKETING_FACTS_TTL_MS).toISOString(),
  };
  let plan: VerifiedApprovedSourcePlan;
  const verifyCurrent = async (lease?: ProjectLease): Promise<void> => {
    assertVerifiedApprovedSourcePlan(plan);
    const state = verifiedPlans.get(plan)!;
    if (sha256Json(immutableBody(plan)) !== state.immutableSha256 || plan.planDigest !== state.immutableSha256) return fail("PLAN_CHANGED", "修复计划内容已变化。");
    assertMarketingFactsFresh(plan.sourceFacts.bundle.collectedAt);
    const currentProject = await readProjectMeta(scope, projectId);
    if (!currentProject || currentProject.kind !== project.kind || currentProject.createdAt !== project.createdAt) return fail("SOURCE_PROJECT_CHANGED", "原项目身份已变化。");
    for (const identity of [source, rootApprovalSource, currentDraftSource]) {
      const sourceRows = lease
        ? await lease.withScopedTransaction(async client => (await client.query<SourceRow>(`${sourceSelect} AND id=$3`, [scope.workspaceId, projectId, identity.stageRunId])).rows)
        : await scopedRows<SourceRow>(scope, `${sourceSelect} AND id=$3`, [scope.workspaceId, projectId, identity.stageRunId]);
      if (!sourceRowMatches(sourceRows[0], identity)) return fail("SOURCE_ROW_CHANGED", "原失败草稿或历史批准根回执已变化。");
    }
    for (const file of state.files) await readBound(file.root, file.path, file.sha256, file.maximum);
    await restoreApprovedMarketingFactsSource({ root: archive.root, scope: rootApprovalSource.scope,
      g1Content: g1.artifact.content, g1ContentSha256: g1.artifact.sha256, proof: g1.proof, g1ArtifactPath: g1.artifact.ref });
    const currentPortraits = loadPortraitReuseManifest(portraitBinding.manifestPath, portraitBinding.manifestSha256);
    const currentCopies = readCurrentPortraitArchiveCopies({ workDir: runWorkDir, projectId,
      manifest: { path: currentPortraits.manifestPath, sha256: currentPortraits.manifestSha256 } });
    if (!isDeepStrictEqual(currentCopies, copies)) return fail("SOURCE_PORTRAIT_CHANGED", "受控角色图片或来源已变化。");
    const [latest] = await rowsFor(scope, projectId, lease);
    if (!sourceRowMatches(latest, source) && !(state.target && latest?.attempt === state.target.attempt && latest.run_id === state.target.runId)) {
      return fail("SOURCE_SUPERSEDED", "已有其他预生产尝试，本次修复不能继续。");
    }
  };
  plan = { ...body, planDigest: sha256Json(body), verifyCurrent,
    verifyLatest: async (lease: ProjectLease): Promise<void> => {
      if (lease.projectId !== projectId) return fail("SOURCE_LEASE_MISMATCH", "运行租约不属于本项目。");
      await verifyCurrent(lease);
      const [latest] = await rowsFor(scope, projectId, lease);
      if (!sourceRowMatches(latest, source)) return fail("SOURCE_SUPERSEDED", "原失败尝试已不是当前最新来源。");
    } };
  verifiedPlans.set(plan, { scope: { ...scope }, immutableSha256: plan.planDigest, files,
    ...(adopted ? { target: { ...adopted.target } } : {}) });
  Object.freeze(plan);
  await plan.verifyCurrent();
  return plan;
}

export function publicPromptRepairPlan(plan: VerifiedApprovedSourcePlan): PromptRepairReady {
  assertVerifiedApprovedSourcePlan(plan);
  return { kind: "ready", mode: plan.mode, projectId: plan.source.scope.projectId,
    expectedLatestAttempt: plan.source.scope.attempt, sourceRunId: plan.source.scope.runId, planDigest: plan.planDigest,
    sourceCollectedAt: plan.sourceFacts.bundle.collectedAt, sourceExpiresAt: plan.sourceExpiresAt,
    retainedGates: ["G1", "G2", "G3", "G4"], retainedShotCount: plan.contracts.length,
    authoringFields: plan.fieldPlan.diagnoses.map(item => ({ shotId: item.shotId, field: item.field, reason: item.reason })),
    warnings: ["执行修复会调用当前已配置的 AI；原来源有效期保持不变。", "修复后重新运行 G5、G6、G7 和最终事实审核；生成视频需要单独操作。"] };
}
export async function readPromptRepairPlan(scope: ApprovedSourceScope, projectId: string): Promise<PromptRepairPlanDto> {
  try { return publicPromptRepairPlan(await prepareApprovedSourcePlan(scope, projectId)); }
  catch (error) {
    if (error instanceof ApprovedSourcePlanError) return { kind: "unavailable", projectId, code: error.code, message: error.message };
    // Missing files and rejected source helpers are source unavailability; no fallback starts work.
    return { kind: "unavailable", projectId, code: "SOURCE_UNVERIFIED", message: "原始证据、有效期或图片无法核验，未启动修复。请查看制片档案。" };
  }
}

function retainedGateReferences(gates: VerifiedApprovedSourcePlan["approvedGates"]): Json {
  return Object.fromEntries(gateKeys.map(key => [key, { artifact: gates[key].artifact.ref,
    sha256: gates[key].artifact.sha256, proof: structuredClone(gates[key].proof) }]));
}
function adoptionManifest(plan: VerifiedApprovedSourcePlan, target: MarketingScope): Json {
  return { schemaVersion: APPROVED_SOURCE_ADOPTION_SCHEMA, mode: plan.mode, planDigest: plan.planDigest,
    source: structuredClone(plan.source), currentDraftSource: structuredClone(plan.currentDraftSource),
    rootApprovalSource: structuredClone(plan.rootApprovalSource), target: { ...target },
    retainedGates: retainedGateReferences(plan.approvedGates),
    sourceCollectedAt: plan.sourceFacts.bundle.collectedAt, sourceExpiresAt: plan.sourceExpiresAt,
    fieldPlanSha256: plan.fieldPlan.sha256, sourceContractSha256: plan.contracts.map(shot => ({ shotId: shot.shotId, sha256: shot.sourceContractSha256 })),
    portraits: structuredClone(plan.portraits),
    boundary: "Historical G1–G4 sources retained; target G5/G6/G7 and final fact reviews remain unperformed.",
  };
}

export async function adoptApprovedSourcePlan(plan: VerifiedApprovedSourcePlan, input: { scope: MarketingScope }): Promise<{
  ref: string; sha256: string; manifest: Json;
}> {
  assertVerifiedApprovedSourcePlan(plan);
  const state = verifiedPlans.get(plan)!, target = input.scope, source = plan.source.scope;
  sourceScope(target, { ...source, runId: target.runId, attempt: source.attempt + 1 });
  component(target.runId);
  if (target.runId === source.runId || state.target) return fail("ADOPTION_TARGET_INVALID", "修复只能认领一次新的目标运行。");
  // The caller has just claimed this target under the same project lease.
  const [latest] = await rowsFor(state.scope, source.projectId);
  if (!latest || latest.attempt !== target.attempt || latest.run_id !== target.runId || latest.status !== "running") return fail("ADOPTION_CLAIM_UNVERIFIED", "修复目标没有真实原子认领回执。");
  state.target = { ...target };
  await plan.verifyCurrent();
  const ref = `stages/preproduction/attempt-${target.attempt}.approved-source-adoption.json`;
  const manifest = adoptionManifest(plan, target);
  const body = canonicalJson(manifest), file = path.join(plan.archiveRoot, ref), directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  if (await realpath(plan.archiveRoot) !== path.resolve(plan.archiveRoot) || await realpath(directory) !== directory) return fail("ADOPTION_PATH_INVALID", "修复来源交接目录不能重定向。");
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(body); await handle.sync(); }
  finally { await handle.close(); }
  return { ref, sha256: sha256(body), manifest };
}

/** Rebuild the source capability from durable evidence after process restart, then revalidate every original. */
export async function verifyApprovedSourceAdoption(input: {
  scope: MarketingScope; ref: string; sha256: string; root: string; lease?: ProjectLease;
}): Promise<{
  manifest: Json; sourceFacts: PreparedMarketingFacts; sourceGates: VerifiedApprovedSourcePlan["approvedGates"];
  sourceScope: MarketingScope; plan: VerifiedApprovedSourcePlan;
}> {
  const target = input.scope;
  component(target.tenantId); component(target.workspaceId); component(target.projectId); component(target.runId);
  if (!Number.isSafeInteger(target.attempt) || target.attempt <= 1) return fail("ADOPTION_TARGET_INVALID", "来源交接目标尝试编号无效。");
  const root = path.resolve(archiveWorkDir(), "archive", target.workspaceId, target.projectId);
  const expectedRef = `stages/preproduction/attempt-${target.attempt}.approved-source-adoption.json`;
  if (input.root !== root || input.ref !== expectedRef || input.lease && input.lease.projectId !== target.projectId) return fail("ADOPTION_SCOPE_INVALID", "来源交接路径不属于当前目标作用域。");
  const bytes = await readBound(root, path.join(root, input.ref), checkedHash(input.sha256));
  const manifest = parsed(bytes), source = record(manifest.source), scope = record(source.scope);
  sourceScope(manifest.target, target);
  const sourceAttempt = Number(scope.attempt);
  if (!Number.isSafeInteger(sourceAttempt) || sourceAttempt < 1 || sourceAttempt >= target.attempt) return fail("ADOPTION_SOURCE_INVALID", "来源交接没有有效的当前失败尝试身份。");
  const sourceRunId = component(scope.runId);
  sourceScope(scope, { tenantId: target.tenantId, workspaceId: target.workspaceId, projectId: target.projectId,
    runId: sourceRunId, attempt: sourceAttempt });
  if (manifest.schemaVersion !== APPROVED_SOURCE_ADOPTION_SCHEMA || manifest.mode !== APPROVED_SOURCE_REPAIR_MODE
    || sourceRunId === target.runId) return fail("ADOPTION_INVALID", "来源交接不是可核验的新运行与历史来源关系。");
  const plan = await loadApprovedSourcePlan({ tenantId: target.tenantId, workspaceId: target.workspaceId }, target.projectId,
    { sourceAttempt, target });
  if (!isDeepStrictEqual(manifest, adoptionManifest(plan, target)) || canonicalJson(manifest) !== bytes.toString("utf8")) return fail("ADOPTION_CHANGED", "来源交接与完整历史原件、计划摘要或目标不一致。");
  const g1 = plan.approvedGates.G1_DOSSIER;
  const sourceFacts = await restoreApprovedMarketingFactsSource({ root, scope: plan.rootApprovalSource.scope,
    g1Content: g1.artifact.content, g1ContentSha256: g1.artifact.sha256, proof: g1.proof, g1ArtifactPath: g1.artifact.ref });
  await plan.verifyCurrent(input.lease);
  return { manifest, sourceFacts, sourceGates: plan.approvedGates, sourceScope: { ...plan.rootApprovalSource.scope }, plan };
}

/** The durable target input is the dedupe index; an unknown receipt never authorizes another claim. */
async function previousRepair(scope: ApprovedSourceScope, request: PromptRepairRequest): Promise<PromptRepairLaunch | null> {
  const targetAttempt = request.expectedLatestAttempt + 1;
  const [row] = await scopedRows<SourceRow>(scope, `${sourceSelect} AND attempt=$3`, [scope.workspaceId, request.projectId, targetAttempt]);
  if (!row) return null;
  const store = new ArchiveStore(archiveWorkDir(), scope.workspaceId, request.projectId, "marketing");
  const ref = `stages/preproduction/attempt-${targetAttempt}.input.json`;
  if (row.input_ref !== ref || !row.run_id) return { kind: "stale", message: "来源后已有其他执行或待核实回执，未重复启动。" };
  const bytes = await store.readBytes(ref);
  if (!bytes) return { kind: "stale", message: "已有认领回执的输入尚待核实，未重复启动。" };
  const envelope = parsed(bytes), input = record(envelope.input);
  if (!input.approvedSourceRepair || typeof input.approvedSourceRepair !== "object" || Array.isArray(input.approvedSourceRepair)) {
    return { kind: "stale", message: "来源后已有不同执行，未重复启动。" };
  }
  const repair = record(input.approvedSourceRepair);
  if (repair.schemaVersion !== APPROVED_SOURCE_REPAIR_INPUT_SCHEMA || repair.planDigest !== request.planDigest
    || repair.sourceAttempt !== request.expectedLatestAttempt || repair.runId !== row.run_id
    || envelope.attempt !== targetAttempt || envelope.stageId !== "preproduction") return { kind: "stale", message: "来源后已有不同的修复执行，未重复启动。" };
  const adoptionRef = `stages/preproduction/attempt-${targetAttempt}.approved-source-adoption.json`;
  const adoptionBytes = await store.readBytes(adoptionRef);
  if (repair.adoptionRef !== adoptionRef || !adoptionBytes) return { kind: "stale", message: "同一修复已认领，来源交接回执尚待核实；未重新执行。" };
  const adoption = parsed(adoptionBytes), target = record(adoption.target), source = record(adoption.source), originalScope = record(source.scope);
  sourceScope(target, { ...scope, projectId: request.projectId, runId: row.run_id, attempt: targetAttempt });
  sourceScope(originalScope, { ...scope, projectId: request.projectId, runId: String(repair.sourceRunId), attempt: request.expectedLatestAttempt });
  if (adoption.schemaVersion !== APPROVED_SOURCE_ADOPTION_SCHEMA || adoption.mode !== APPROVED_SOURCE_REPAIR_MODE
    || adoption.planDigest !== request.planDigest || source.stageRunId !== repair.sourceStageRunId) return { kind: "stale", message: "同一修复的交接摘要不一致，未重复执行。" };
  return { kind: "started", runId: row.run_id, sourceAttempt: request.expectedLatestAttempt, deduped: true };
}

async function previousRepairOrStale(scope: ApprovedSourceScope, request: PromptRepairRequest): Promise<PromptRepairLaunch | null> {
  try { return await previousRepair(scope, request); }
  catch (error) {
    if (error instanceof ApprovedSourcePlanError || error instanceof Error && error.name === "ArchiveBoundaryError") {
      return { kind: "stale", message: "已有修复的输入或来源交接回执无法核实，未新建执行；请先核对制片档案。" };
    }
    throw error;
  }
}

export async function repairApprovedSourcePrompts(
  scope: ApprovedSourceScope,
  request: PromptRepairRequest,
  launch: (scope: ApprovedSourceScope, input: { plan: VerifiedApprovedSourcePlan; lease: ProjectLease }) => Promise<{ runId: string; attempt: number }>,
): Promise<PromptRepairLaunch> {
  component(scope.tenantId); component(scope.workspaceId); component(request.projectId);
  checkedHash(request.planDigest);
  if (!Number.isSafeInteger(request.expectedLatestAttempt) || request.expectedLatestAttempt < 1) return fail("SOURCE_ATTEMPT_INVALID", "修复来源尝试编号无效。");
  const project = await readProjectMeta(scope, request.projectId);
  if (!project || project.kind !== "marketing") return { kind: "stale", message: "当前项目没有可核验的修复来源。" };
  const prior = await previousRepairOrStale(scope, request);
  if (prior) return prior;
  const lease = await acquireProjectLease(scope, request.projectId);
  if (!lease) {
    const concurrent = await previousRepairOrStale(scope, request);
    return concurrent ?? { kind: "busy", message: "项目已有执行者，请等待当前执行结果；未新建修复。" };
  }
  let transferred = false;
  try {
    const concurrent = await previousRepairOrStale(scope, request);
    if (concurrent) return concurrent;
    const plan = await prepareApprovedSourcePlan(scope, request.projectId);
    if (plan.source.scope.attempt !== request.expectedLatestAttempt || plan.planDigest !== request.planDigest) {
      return { kind: "stale", message: "检查后来源或修复计划已变化，未启动修复。请重新检查。" };
    }
    await plan.verifyLatest(lease);
    // The launcher owns the lease after its persisted input/adoption startup barrier succeeds.
    const started = await launch(scope, { plan, lease });
    transferred = true;
    return { kind: "started", runId: started.runId, sourceAttempt: plan.source.scope.attempt };
  } catch (error) {
    if (error instanceof ApprovedSourcePlanError) return { kind: "stale", message: error.message };
    throw error;
  } finally {
    if (!transferred) await lease.release();
  }
}
