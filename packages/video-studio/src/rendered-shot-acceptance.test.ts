import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptRenderedShot, findRenderedShotAcceptance } from "./rendered-shot-acceptance.js";
import { createLineageReceipt, fingerprintArtifact, productionHash } from "./production-lineage.js";
const directories: string[] = [];
afterEach(() => { directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });
const scope = { projectId: "project", shotId: "S1", sourceHash: productionHash({ author: "original" }) };
function file() { const dir = mkdtempSync(join(tmpdir(), "render-admission-")); directories.push(dir);
  const file = join(dir, "source.mp4"); writeFileSync(file, "actual supplier bytes"); return file; }
describe("successful rendered shot acceptance", () => {
  it("binds actual supplier success to current bytes without nominal/identity/speech metrics", () => {
    const path = file(); const receipt = acceptRenderedShot({ ...scope, file: path, taskId: "actual-issued-task", providerStatus: "succeeded" });
    expect(receipt).toMatchObject({ providerStatus: "succeeded", artifact: { path, bytes: 21 }, source: "provider-success" });
    expect(readFileSync(path, "utf8")).toBe("actual supplier bytes");
  });
  it.each(["failed", "unknown", "running", ""])("refuses provider state %s", (providerStatus) => {
    expect(() => acceptRenderedShot({ ...scope, file: file(), taskId: "task", providerStatus })).toThrow("PROVIDER_SUCCESS_REQUIRED");
  });
  it("rejects a missing task, missing file, empty file and invalid scope", () => {
    const path = file(); expect(() => acceptRenderedShot({ ...scope, file: path, taskId: "", providerStatus: "succeeded" })).toThrow();
    expect(() => acceptRenderedShot({ ...scope, file: path + ".missing", taskId: "task", providerStatus: "succeeded" })).toThrow();
    writeFileSync(path, ""); expect(() => acceptRenderedShot({ ...scope, file: path, taskId: "task", providerStatus: "succeeded" })).toThrow();
    expect(() => acceptRenderedShot({ ...scope, sourceHash: "bad", file: file(), taskId: "task", providerStatus: "succeeded" })).toThrow("SCOPE_INVALID");
  });
  it("adopts old quality-rejected successful bytes without rewriting the old verdict or recipe", () => {
    const path = file(); const lineage = createLineageReceipt({ ...scope, runId: "old-run", stage: "shot", recipe: { component: "old" },
      status: "failed", inputs: [path], outputs: [path] });
    const row = { at: "2026-10-01", stage: "shot", shotId: "S1", ok: false,
      verdict: { approved: false }, lineage, evidence: { taskId: "successful-task", motion: 0, identity: "different" } };
    const before = JSON.stringify(row);
    const receipt = findRenderedShotAcceptance({ ...scope, file: path, records: [row] });
    expect(receipt).toMatchObject({ taskId: "successful-task", source: "historical-provider-success", historicalAt: "2026-10-01" });
    expect(JSON.stringify(row)).toBe(before);
    const appended = { ...row, ok: true, verdict: null, evidence: { renderedShotAcceptance: receipt } };
    expect(findRenderedShotAcceptance({ ...scope, file: path, records: [row, appended] })).toEqual(receipt);
  });
  it("does not adopt failed providers, changed inputs/output, other projects or authored revisions", () => {
    const path = file(); const input = path + ".input"; writeFileSync(input, "original input");
    const lineage = createLineageReceipt({ ...scope, runId: "old-run", stage: "shot", recipe: { component: "old" },
      status: "failed", inputs: [input], outputs: [path] });
    const row = { stage: "shot", shotId: "S1", ok: false, lineage, evidence: { taskId: "task" } };
    expect(findRenderedShotAcceptance({ ...scope, file: path, records: [{ ...row, evidence: { taskId: "task", providerStatus: "failed" } }] })).toBeNull();
    expect(findRenderedShotAcceptance({ ...scope, projectId: "other", file: path, records: [row] })).toBeNull();
    expect(findRenderedShotAcceptance({ ...scope, sourceHash: productionHash({ author: "changed" }), file: path, records: [row] })).toBeNull();
    writeFileSync(input, "tampered input"); expect(findRenderedShotAcceptance({ ...scope, file: path, records: [row] })).toBeNull();
    writeFileSync(input, "original input"); writeFileSync(path, "tampered artifact");
    expect(findRenderedShotAcceptance({ ...scope, file: path, records: [row] })).toBeNull();
  });
  it.each([
    { providerStatus: "failed" }, { providerStatus: "unknown" }, { providerStatus: "running" },
    { providerStatus: "invented-success" }, { providerFailed: true }, { providerSucceeded: false },
    { error: "provider timeout" }, { gateBlocked: "g8-render-submit" },
  ])("does not let an appended receipt bypass provider failure %j", (failure) => {
    const path = file();
    const receipt = acceptRenderedShot({ ...scope, file: path, taskId: "task", providerStatus: "succeeded" });
    const lineage = createLineageReceipt({ ...scope, runId: "old-run", stage: "shot", recipe: {}, status: "failed", inputs: [path], outputs: [path] });
    for (const renderedShotAcceptance of [undefined, receipt]) {
      const row = { stage: "shot", shotId: "S1", lineage, evidence: { taskId: "task", renderedShotAcceptance, ...failure } };
      expect(findRenderedShotAcceptance({ ...scope, file: path, records: [row] })).toBeNull();
    }
  });
  it("requires complete source lineage for historical and appended acceptance", () => {
    const path = file();
    const receipt = acceptRenderedShot({ ...scope, file: path, taskId: "task", providerStatus: "succeeded" });
    const lineage = createLineageReceipt({ ...scope, runId: "old-run", stage: "shot", recipe: {}, status: "failed", inputs: [path], outputs: [path] });
    const row = { stage: "shot", shotId: "S1", lineage, evidence: { taskId: "task", renderedShotAcceptance: receipt } };
    for (const changed of [{ inputs: [] }, { stage: "other" }, { schemaVersion: "invented" }, { status: "unverified" },
      { status: "not_applicable" }, { outputs: [] }, { errors: ["input failed"] }, { runId: "" }, { recipeHash: "invalid" }]) {
      expect(findRenderedShotAcceptance({ ...scope, file: path, records: [{ ...row, lineage: { ...lineage, ...changed } as typeof lineage }] })).toBeNull();
    }
    expect(findRenderedShotAcceptance({ ...scope, file: path, records: [{ ...row, lineage: undefined }] })).toBeNull();
    expect(findRenderedShotAcceptance({ ...scope, file: path, records: [{ ...row, evidence: { ...row.evidence, taskId: "another-task" } }] })).toBeNull();
  });
  it("carries original provider inputs into a new acceptance after a historical quality rejection", () => {
    const path = file(); const prompt = path + ".prompt"; writeFileSync(prompt, "original paid prompt");
    const lineage = createLineageReceipt({ ...scope, runId: "old", stage: "shot", recipe: { component: "old" },
      status: "failed", inputs: [prompt], outputs: [path] });
    const original = { stage: "shot", shotId: "S1", lineage, evidence: { taskId: "issued-task" } };
    const receipt = findRenderedShotAcceptance({ ...scope, file: path, records: [original] })!;
    expect(receipt.sourceInputs).toEqual([fingerprintArtifact(prompt)]);
    const current = { ...original, lineage: createLineageReceipt({ ...scope, runId: "new", stage: "shot", recipe: { component: "new" },
      status: "passed", inputs: [path], outputs: [path] }), evidence: { taskId: "issued-task", renderedShotAcceptance: receipt } };
    expect(findRenderedShotAcceptance({ ...scope, file: path, records: [current] })).toEqual(receipt);
    writeFileSync(prompt, "changed prompt after acceptance");
    expect(findRenderedShotAcceptance({ ...scope, file: path, records: [current] })).toBeNull();
    expect(() => acceptRenderedShot({ ...scope, file: path, taskId: "issued-task", providerStatus: "succeeded",
      sourceInputs: receipt.sourceInputs })).toThrow("INPUT_CHANGED");
  });
  it.each([undefined, [], [{ path: "/missing", realpath: "/missing", sha256: "a".repeat(64), bytes: 1 }]])(
    "rejects an appended receipt with damaged input fingerprints %j", (sourceInputs) => {
      const path = file(); const receipt = acceptRenderedShot({ ...scope, file: path, taskId: "task", providerStatus: "succeeded" });
      const lineage = createLineageReceipt({ ...scope, runId: "run", stage: "shot", recipe: {}, status: "passed", inputs: [path], outputs: [path] });
      expect(findRenderedShotAcceptance({ ...scope, file: path, records: [{ stage: "shot", shotId: "S1", lineage,
        evidence: { taskId: "task", renderedShotAcceptance: { ...receipt, sourceInputs } } }] })).toBeNull();
    });
});
