import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArchiveStore } from "./store.js";

let directory: string;
const entry = (attempt: number, status: string) => ({ attempt, status, finishedAt: status === "running" ? null : "2026-11-03T00:00:00Z" });
const makeStore = () => new ArchiveStore(directory, "W1", "P1");

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "archive-manifest-r2-"));
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("manifest is the latest monotonic stage projection", () => {
  it("does not let older completions or late running receipts hide the newest terminal attempt", async () => {
    const first = makeStore();
    const second = makeStore();
    await first.ensure();
    await second.updateLedger("renderPoll", entry(2, "interrupted"));
    await first.updateLedger("renderPoll", entry(2, "running"));
    await first.updateLedger("renderPoll", entry(1, "done"));
    expect((await first.readManifest())?.ledger.renderPoll).toEqual(entry(2, "interrupted"));
  });

  it("serializes read-modify-write across different stores and preserves concurrent distinct stages", async () => {
    const first = makeStore();
    const second = makeStore();
    await first.ensure();
    let signalWriting!: () => void;
    let resumeWriting!: () => void;
    const writing = new Promise<void>((resolve) => { signalWriting = resolve; });
    const resume = new Promise<void>((resolve) => { resumeWriting = resolve; });
    const write = first.writeJsonAtomic.bind(first);
    vi.spyOn(first, "writeJsonAtomic").mockImplementation(async (ref, data) => {
      if (ref === "manifest.json") {
        signalWriting();
        await resume;
      }
      return write(ref, data);
    });
    const original = first.updateLedger("renderPoll", entry(1, "done"));
    await writing;
    const next = second.updateLedger("renderSubmit", entry(1, "done"));
    const timer = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100));
    let escaped: boolean;
    try { escaped = await Promise.race([next.then(() => true), timer]); }
    finally { resumeWriting(); }
    await Promise.all([original, next]);
    expect(escaped).toBe(false);
    expect((await first.readManifest())?.ledger).toEqual({
      renderPoll: entry(1, "done"), renderSubmit: entry(1, "done"),
    });
  });

  it("starts a fresh latest projection after a different project creation identity", async () => {
    const first = makeStore();
    const second = makeStore();
    const identity = { kind: "narrative", title: "fixture", createdAt: "2026-11-02T00:00:00Z" };
    await first.ensure(identity);
    await first.updateLedger("renderPoll", entry(8, "done"));
    await second.ensure({ ...identity, createdAt: "2026-11-03T00:00:00Z" });
    await second.updateLedger("renderPoll", entry(1, "running"));
    const manifest = await second.readManifest();
    expect(manifest?.ledger.renderPoll).toEqual(entry(1, "running"));
    expect(manifest?.identityDrifts?.at(-1)?.previousLedger).toMatchObject({ renderPoll: entry(8, "done") });
  });
});
