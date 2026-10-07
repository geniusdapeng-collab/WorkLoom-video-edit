/** Provider success admits the issued bytes to postproduction. Quality is the owner's decision. */
import { fingerprintArtifact, LINEAGE_VERSION, type ArtifactFingerprint, type LineageRecord } from "./production-lineage.js";

export const RENDERED_SHOT_ACCEPTANCE_POLICY = "workloom.rendered-shot-default-acceptance/v1" as const;
export interface RenderedShotScope { projectId: string; shotId: string; sourceHash: string }
export interface RenderedShotAcceptance extends RenderedShotScope {
  policy: typeof RENDERED_SHOT_ACCEPTANCE_POLICY;
  providerStatus: "succeeded";
  taskId: string;
  artifact: ArtifactFingerprint;
  sourceInputs: ArtifactFingerprint[];
  source: "provider-success" | "historical-provider-success";
  historicalAt?: string;
}
export interface RenderedShotRecord extends LineageRecord {
  at?: string;
  evidence?: Record<string, unknown>;
}
function sameArtifact(expected: ArtifactFingerprint, actual: ArtifactFingerprint): boolean {
  return Boolean(expected) && expected.path === actual.path && expected.realpath === actual.realpath
    && expected.sha256 === actual.sha256 && expected.bytes === actual.bytes;
}
function currentInputs(inputs: unknown): inputs is ArtifactFingerprint[] {
  return Array.isArray(inputs) && inputs.length > 0 && inputs.every((artifact) => {
    try { return sameArtifact(artifact, fingerprintArtifact(artifact.path)); }
    catch { return false; }
  });
}
function providerEvidenceUsable(evidence: Record<string, unknown>): boolean {
  return (evidence.providerStatus === undefined || evidence.providerStatus === "succeeded")
    && evidence.providerFailed !== true && evidence.providerSucceeded !== false
    && !evidence.error && !evidence.gateBlocked;
}
function assertScope(scope: RenderedShotScope): void {
  if (!scope.projectId.trim() || !scope.shotId.trim() || !/^[a-f0-9]{64}$/.test(scope.sourceHash)) {
    throw new Error("RENDERED_SHOT_SCOPE_INVALID");
  }
}
/** No duration, fps, motion, face, clothing or speech comparison is an admission condition. */
export function acceptRenderedShot(input: RenderedShotScope & {
  file: string; taskId: string; providerStatus: string; sourceInputs?: readonly ArtifactFingerprint[];
}): RenderedShotAcceptance {
  assertScope(input);
  if (input.providerStatus !== "succeeded" || !input.taskId.trim()) throw new Error("RENDERED_SHOT_PROVIDER_SUCCESS_REQUIRED");
  const artifact = fingerprintArtifact(input.file);
  const sourceInputs = input.sourceInputs === undefined ? [artifact] : structuredClone([...input.sourceInputs]);
  if (!currentInputs(sourceInputs)) throw new Error("RENDERED_SHOT_INPUT_CHANGED");
  return { policy: RENDERED_SHOT_ACCEPTANCE_POLICY, projectId: input.projectId, shotId: input.shotId,
    sourceHash: input.sourceHash, providerStatus: "succeeded", taskId: input.taskId,
    artifact, sourceInputs, source: "provider-success" };
}
/** Component/quality-review changes do not invalidate a supplier's already issued original. */
export function findRenderedShotAcceptance(input: RenderedShotScope & {
  file: string; records: readonly RenderedShotRecord[]; stages?: readonly string[];
}): RenderedShotAcceptance | null {
  assertScope(input);
  const current = fingerprintArtifact(input.file);
  const stages = input.stages ?? ["shot", "material-gen"];
  for (const row of [...input.records].reverse()) {
    if (!stages.includes(row.stage) || row.shotId !== input.shotId) continue;
    const evidence = row.evidence ?? {};
    if (!providerEvidenceUsable(evidence)) continue;
    const lineage = row.lineage;
    if (!lineage || lineage.schemaVersion !== LINEAGE_VERSION || lineage.stage !== row.stage
      || lineage.projectId !== input.projectId || lineage.shotId !== input.shotId
      || lineage.sourceHash !== input.sourceHash || !["passed", "failed"].includes(lineage.status)
      || !lineage.runId?.trim() || !/^[a-f0-9]{64}$/.test(lineage.recipeHash)
      || !Array.isArray(lineage.outputs) || !Array.isArray(lineage.inputs) || !lineage.inputs.length
      || !Array.isArray(lineage.errors) || lineage.errors.length) continue;
    if (!lineage.outputs.some((artifact) => sameArtifact(artifact, current))) continue;
    let unchanged = true;
    for (const artifact of lineage.inputs) {
      try { if (!sameArtifact(artifact, fingerprintArtifact(artifact.path))) unchanged = false; }
      catch { unchanged = false; }
    }
    if (!unchanged) continue;
    const receipt = evidence.renderedShotAcceptance as RenderedShotAcceptance | undefined;
    if (receipt?.policy === RENDERED_SHOT_ACCEPTANCE_POLICY && receipt.projectId === input.projectId
      && receipt.shotId === input.shotId && receipt.sourceHash === input.sourceHash
      && receipt.providerStatus === "succeeded" && typeof receipt.taskId === "string" && receipt.taskId.trim()
      && (evidence.taskId === undefined || evidence.taskId === receipt.taskId)
      && ["provider-success", "historical-provider-success"].includes(receipt.source)
      && receipt.artifact && sameArtifact(receipt.artifact, current)
      && currentInputs(receipt.sourceInputs)) return structuredClone(receipt);
    if (receipt !== undefined) continue;
    // A historical quality rejection can still contain the real successful supplier artifact.
    // It remains unchanged; callers append a separate acceptance receipt for that same file.
    const taskId = typeof evidence.taskId === "string" ? evidence.taskId.trim() : "";
    if (!taskId) continue;
    return { policy: RENDERED_SHOT_ACCEPTANCE_POLICY, projectId: input.projectId, shotId: input.shotId,
      sourceHash: input.sourceHash, providerStatus: "succeeded", taskId, artifact: current,
      sourceInputs: structuredClone(lineage.inputs),
      source: "historical-provider-success", ...(row.at ? { historicalAt: row.at } : {}) };
  }
  return null;
}
