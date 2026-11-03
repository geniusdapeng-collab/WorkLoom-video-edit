import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logStageOutcome } from "./stage-log.js";
import type { StageLedgerWriter } from "./stage-runner.js";
import { ArchiveStore } from "./store.js";

let workDir: string;
let store: ArchiveStore;
const stageId = "renderPoll";
const artifactKinds = ["input", "output"] as const;
const attemptRef = (attempt: number, kind: "input" | "output") => `stages/${stageId}/attempt-${attempt}.${kind}.json`;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "archive-stage-integrity-"));
  store = new ArchiveStore(workDir, "ws-r2", "VID-R2");
  await store.ensure();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(workDir, { recursive: true, force: true });
});

function ledgerWith(claimRun: StageLedgerWriter["claimRun"]) {
  return {
    claimRun,
    finishRun: vi.fn<StageLedgerWriter["finishRun"]>().mockResolvedValue(undefined),
    nextAttempt: async () => 2,
  };
}

describe("one-shot stage archive integrity", () => {
  it.each(["claim error", "invalid receipt"] as const)("preserves old attempt bytes on %s", async (failure) => {
    await store.writeJsonAtomic(attemptRef(1, "input"), { jobId: "OLD" });
    await store.writeJsonAtomic(attemptRef(1, "output"), { jobId: "OLD", assetId: "VA-OLD" });
    const priorLedger = { attempt: 1, status: "failed", finishedAt: "2026-11-01T00:00:00.000Z" };
    await store.updateLedger(stageId, priorLedger);
    const before = await Promise.all(artifactKinds.map(kind => readFile(path.join(store.root, attemptRef(1, kind)))));
    const ledger = ledgerWith(async () => {
      if (failure === "claim error") throw new Error("ECONNREFUSED");
      return { attempt: 1, inputRef: attemptRef(2, "input") };
    });
    const result = await logStageOutcome(store, ledger, {
      stageId, status: "done", input: { jobId: "NEW" }, output: { jobId: "NEW", assetId: "VA-NEW" },
    });
    const after = await Promise.all(artifactKinds.map(kind => readFile(path.join(store.root, attemptRef(1, kind)))));
    expect(after.map(digest)).toEqual(before.map(digest));
    expect((await store.readManifest())?.ledger[stageId]).toEqual(priorLedger);
    expect((await store.readEvents()).some(event => event.kind === "stage.done")).toBe(false);
    expect(ledger.finishRun).not.toHaveBeenCalled();
    expect(result).toMatchObject({ attempt: null, outputRef: null, outputSha256: null, error: expect.any(String) });
  });

  it.each(["input", "output", "receipt"] as const)("does not project done when %s cannot be archived", async (failure) => {
    const original = store.writeJsonAtomic.bind(store);
    vi.spyOn(store, "writeJsonAtomic").mockImplementation(async (ref, data) => {
      if (ref === `stages/${stageId}/attempt-2.${failure}.json`) throw new Error("ENOSPC");
      return original(ref, data);
    });
    const ledger = ledgerWith(async () => ({ attempt: 2, inputRef: attemptRef(2, "input") }));
    if (failure === "receipt") ledger.finishRun.mockRejectedValue(new Error("commit acknowledgement lost"));
    const result = await logStageOutcome(store, ledger, {
      stageId, status: "done", input: { jobId: "RJ-2" }, output: { jobId: "RJ-2" },
    });
    expect(result).toMatchObject({ attempt: 2, error: expect.any(String) });
    expect((await store.readManifest())?.ledger[stageId]?.status).not.toBe("done");
    expect((await store.readEvents()).some(event => event.kind === "stage.done")).toBe(false);
    if (failure !== "receipt") {
      expect(ledger.finishRun).toHaveBeenCalledWith(expect.objectContaining({
        status: "interrupted", errorClass: "RECEIPT_UNVERIFIED",
      }));
    }
    if (failure === "output") expect(result).toMatchObject({ outputRef: null, outputSha256: null });
    else expect(await store.readJson(attemptRef(2, "output"))).toEqual({ jobId: "RJ-2" });
  });
});
