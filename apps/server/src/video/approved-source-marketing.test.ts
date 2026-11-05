/** Real archived facts, original source bytes and native final judge; HTTP completions are offline fixtures. */
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvedSourceFixture, fixtureHash } from "./approved-source-plan.test-support.js";
import { MARKETING_FACTS_TTL_MS, finalizeMarketingFacts, prepareAdoptedMarketingFacts, verifyMarketingFacts } from "./marketing-authority.js";
import { canonicalRenderJson } from "./gen/compiled-request.js";

const sourceScope = { tenantId: "tenant-a", workspaceId: "ws-a", projectId: "P1", runId: "RUN-original", attempt: 3 };
const targetScope = { ...sourceScope, runId: "RUN-target", attempt: 5 };
const judgeEnv = { LLM_BASE_URL: "http://offline-final-facts.invalid/v1", LLM_API_KEY: "offline-only", LLM_MODEL: "deepseek-flash" };
const shots = [{ shotId: "opening", prompt: "合成人物完整观察合成商品，保留九档规格的事实限定。", fields: { action: "合成人物完整观察合成商品。" } }];
let workDir: string;
let fixture: Awaited<ReturnType<typeof approvedSourceFixture>>;
let calls: number;
beforeEach(async () => {
  workDir = await realpath(await mkdtemp(path.join(tmpdir(), "approved-source-marketing-")));
  fixture = await approvedSourceFixture({ workDir, scope: sourceScope, createdAt: new Date().toISOString() });
  calls = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    calls++;
    return Response.json({ id: `offline-final-${calls}`, model: "deepseek-flash",
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ approved: true, score: 96, issues: [], suggestions: [], reason: "offline exact facts reviewed" }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } });
  }));
});
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); await rm(workDir, { recursive: true, force: true }); });
async function adoption(patch: Record<string, unknown> = {}) {
  const ref = `stages/preproduction/attempt-${targetScope.attempt}.approved-source-adoption.json`;
  const original = { ...fixture.row, scope: sourceScope };
  const latestFailure = { ...original, scope: { ...sourceScope, attempt: targetScope.attempt - 1, runId: "RUN-last-failure" } };
  const g1 = fixture.gateFiles[0]!;
  const manifest = { schemaVersion: "workloom.approved-source-adoption/v1", mode: "approved-source-prompt-repair",
    source: latestFailure, rootApprovalSource: original, currentDraftSource: original, target: targetScope,
    sourceCollectedAt: fixture.collectedAt, sourceExpiresAt: new Date(Date.parse(fixture.collectedAt) + MARKETING_FACTS_TTL_MS).toISOString(),
    retainedGates: { G1_DOSSIER: { artifact: g1.path, sha256: g1.sha256, proof: fixture.output.productionEvidence.gates[0] } }, ...patch };
  const bytes = canonicalRenderJson(manifest);
  await writeFile(path.join(fixture.store.root, ref), bytes);
  return { ref, sha256: fixtureHash(bytes) };
}
describe("historical source facts with new target reviews", () => {
  it("retains root scope/time/bytes across repeated repairs and judges every final shot under the new scope", async () => {
    const original = await readFile(fixture.sourceTextPath), binding = await adoption();
    const prepared = await prepareAdoptedMarketingFacts({ root: fixture.store.root, scope: targetScope, adoption: binding });
    expect(calls).toBe(0);
    expect(prepared.bundle.scope).toEqual(targetScope);
    expect(prepared.bundle.collectedAt).toBe(fixture.collectedAt);
    expect(prepared.bundle.sources[0]!.textRef).toContain("attempt-3.marketing");
    expect(prepared.bundle.stages[0]!.review!.ref).toContain("attempt-3.marketing");
    const final = await finalizeMarketingFacts(prepared, shots, judgeEnv);
    const checked = await verifyMarketingFacts({ root: fixture.store.root, ...final, scope: targetScope, shots });
    expect(calls).toBe(1);
    expect(checked.approvedSourceAdoption).toEqual(binding);
    expect(checked.outputReviews[0]!.ref).toContain("attempt-5.marketing-shot-1");
    const review = JSON.parse(await readFile(path.join(fixture.store.root, checked.outputReviews[0]!.ref), "utf8"));
    expect(review.scope).toEqual(targetScope);
    expect(checked.rawByAgent).toEqual(JSON.parse(fixture.gateFiles[0]!.path && await readFile(fixture.gateFiles[0]!.path, "utf8")).facts.rawByAgent);
    expect(await readFile(fixture.sourceTextPath)).toEqual(original);
    expect(await readFile(path.join(fixture.store.root, fixture.row.input_ref))).toEqual(fixture.sourceInputBytes);
    expect(await readFile(path.join(fixture.store.root, fixture.row.output_ref))).toEqual(fixture.sourceOutputBytes);
  });
  it.each(["tenant", "workspace", "project", "target-attempt", "source-attempt", "time-refresh", "expires-refresh", "g1-hash"])("rejects %s adoption before any judge call", async kind => {
    const g1 = fixture.gateFiles[0]!;
    const patch: Record<string, unknown> = {};
    if (["tenant", "workspace", "project", "target-attempt"].includes(kind)) {
      patch.target = { ...targetScope, ...({ tenant: { tenantId: "other" }, workspace: { workspaceId: "other" }, project: { projectId: "other" }, "target-attempt": { attempt: 8 } }[kind]) };
    }
    if (kind === "source-attempt") patch.rootApprovalSource = { scope: { ...sourceScope, attempt: 8 } };
    if (kind === "time-refresh") patch.sourceCollectedAt = new Date(Date.now() + 1_000).toISOString();
    if (kind === "expires-refresh") patch.sourceExpiresAt = new Date(Date.now() + 2 * MARKETING_FACTS_TTL_MS).toISOString();
    if (kind === "g1-hash") patch.retainedGates = { G1_DOSSIER: { artifact: g1.path, sha256: "a".repeat(64), proof: fixture.output.productionEvidence.gates[0] } };
    const binding = await adoption(patch);
    await expect(prepareAdoptedMarketingFacts({ root: fixture.store.root, scope: targetScope, adoption: binding })).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it("rejects TTL expiry before dispatch and does not refresh the old collection time", async () => {
    const binding = await adoption(), prepared = await prepareAdoptedMarketingFacts({ root: fixture.store.root, scope: targetScope, adoption: binding });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(fixture.collectedAt) + MARKETING_FACTS_TTL_MS + 1);
    await expect(finalizeMarketingFacts(prepared, shots, judgeEnv)).rejects.toThrow("MARKETING_FACTS_EXPIRED");
    expect(calls).toBe(0);
  });
  it("detects changed original source and rehashed target fact claims instead of accepting new scope labels", async () => {
    const binding = await adoption(), prepared = await prepareAdoptedMarketingFacts({ root: fixture.store.root, scope: targetScope, adoption: binding });
    prepared.bundle.restrictions.push("伪造新的来源用途");
    await expect(finalizeMarketingFacts(prepared, shots, judgeEnv)).rejects.toThrow("MARKETING_FACTS_CHANGED");
    prepared.bundle.restrictions.pop();
    const saved = await finalizeMarketingFacts(prepared, shots, judgeEnv);
    await writeFile(fixture.sourceTextPath, "改变原文");
    await expect(verifyMarketingFacts({ root: fixture.store.root, ...saved, scope: targetScope, shots })).rejects.toThrow("MARKETING_FACTS_CHANGED");
  });
  it.each(["before", "after"])("source verifier blocks %s a native final-facts call without losing the actual dispatched count", async boundary => {
    const binding = await adoption(), prepared = await prepareAdoptedMarketingFacts({ root: fixture.store.root, scope: targetScope, adoption: binding });
    const verify = vi.fn(async () => { if (boundary === "before" || calls) throw new Error("SOURCE_CHANGED"); });
    await expect(finalizeMarketingFacts(prepared, shots, judgeEnv, verify)).rejects.toThrow("SOURCE_CHANGED");
    expect(calls).toBe(boundary === "before" ? 0 : 1);
    await expect(readFile(path.join(fixture.store.root, `stages/preproduction/attempt-${targetScope.attempt}.marketing-facts.json`))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
