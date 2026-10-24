import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPortraitRuntime, REQUIRED_ANGLES, type ArchivedPortraitCharacters, type PortraitInputReceipt } from "./portrait-runtime.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture({ shortProfile = false, pngSources = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "wl-portrait-reuse-")); roots.push(root);
  const receipt = (file: string): PortraitInputReceipt => {
    const bytes = readFileSync(file);
    return { path: file, realPath: realpathSync(file), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  };
  const profile = join(root, "profile.json");
  writeFileSync(profile, JSON.stringify({ id: "existing-actor", kind: "generated", authorization: { status: "synthetic-no-real-person" }, ...(shortProfile ? {} : { note: "existing fixture ".repeat(160) }) }));
  const files = Object.fromEntries(REQUIRED_ANGLES.map((angle, i) => {
    const file = join(root, `${angle}.jpg`);
    const bytes = Buffer.alloc(4096, i + 1);
    if (pngSources) Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    writeFileSync(file, bytes); return [angle, receipt(file)];
  }));
  const manifest = {
    schemaVersion: "workloom.portrait-reuse-manifest/v1",
    approvedSelection: { schemaVersion: "workloom.portrait-reuse-selection/v1" as const, rawIntent: "Use this existing AI trousers version", selectedVersion: 4, expectedPortraits: 4, selectedAt: "2026-10-24T00:00:00Z" },
    characters: [{ id: "existing-actor", name: "裤装模特", aliases: ["host"], version: 4, authorization: { status: "synthetic-no-real-person" as const }, profile: receipt(profile), files }],
  };
  const manifestPath = join(root, "reuse.json"); writeFileSync(manifestPath, JSON.stringify(manifest));
  const archivedCharacters: ArchivedPortraitCharacters = { ...manifest, manifestPath, manifestSha256: receipt(manifestPath).sha256 };
  const fetchImpl = vi.fn(() => { throw new Error("Existing archive must not call the provider"); }) as unknown as typeof fetch;
  const configured = () => createPortraitRuntime({ workDir: join(root, "work"), projectId: "PROJECT", apiKey: "test-only", model: "unused", archivedCharacters, archivedCharactersOnly: true, fetchImpl });
  return { root, configured, archivedCharacters, fetchImpl, manifestPath, files };
}

describe("existing user-selected synthetic portraits", () => {
  it("plans only the four existing views, copies exact bytes with independent reuse evidence, and resumes without generation", async () => {
    const f = fixture(); const runtime = f.configured();
    const plan = runtime.preparePlan!({ characterTasks: [{ characterId: "char_001", characterName: "裤装模特", portraits: [{ angle: "action_pose" }], angleCount: 8 }], productTasks: [] });
    const tasks = plan.characterTasks[0]!.portraits as Array<Record<string, unknown>>;
    expect(tasks.map(task => task.angle)).toEqual([...REQUIRED_ANGLES]);
    for (const task of tasks) await runtime.apiRender(task);
    const entry = runtime.snapshot().characters.char_001!;
    expect(entry.receipts).toBeUndefined(); expect(entry.pinnedVersion).toBe(4);
    for (const angle of REQUIRED_ANGLES) {
      expect(readFileSync(entry.files[angle]!)).toEqual(readFileSync(f.files[angle]!.path));
      expect(entry.reuseReceipts?.[angle]).toMatchObject({ schemaVersion: "workloom.portrait-reuse/v1", projectId: "PROJECT", archiveId: "existing-actor", version: 4, angle, generationCount: 0 });
      expect(entry.artifacts?.[angle]?.sha256).toBe(f.files[angle]!.sha256);
    }
    const resumed = f.configured();
    expect(await resumed.apiRender(tasks[0]!)).toBe(entry.files.front);
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it("refuses an unknown actor, missing requested view, omitted or duplicate selected character without paid fallback", async () => {
    const f = fixture(); const r = f.configured();
    await expect(r.apiRender({ characterId: "stranger", characterName: "stranger", angle: "front" })).rejects.toThrow("IDENTITY_MISMATCH");
    await expect(r.apiRender({ characterId: "host", angle: "back_full" })).rejects.toThrow("ANGLE_MISSING");
    expect(() => r.preparePlan!({ characterTasks: [] })).toThrow("遗漏");
    expect(() => r.preparePlan!({ characterTasks: [{ characterId: "host" }, { characterId: "host" }] })).toThrow("重复");
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it("fails closed when the manifest or source bytes change, and never treats them as a cache miss", async () => {
    const f = fixture(); const r = f.configured();
    writeFileSync(f.files.front!.path, Buffer.alloc(4096, 99));
    await expect(r.apiRender({ characterId: "host", angle: "front" })).rejects.toThrow("INPUT_CHANGED");
    expect(() => f.configured()).toThrow("INPUT_CHANGED");
    writeFileSync(f.manifestPath, " ".repeat(2048));
    expect(() => f.configured()).toThrow("ARCHIVE_CHANGED");
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it("requires explicit selection and the exact manifest, not a supplied actor object alone", () => {
    const f = fixture(); f.archivedCharacters.approvedSelection.rawIntent = "different request";
    expect(() => f.configured()).toThrow("运行参数");
    expect(() => createPortraitRuntime({ workDir: join(f.root, "other"), projectId: "PROJECT", apiKey: "fixture", model: "unused", archivedCharactersOnly: true })).toThrow("ARCHIVE_REQUIRED");
  });
  it("accepts a short valid profile but rejects mixed/unknown identities and view-based provider fallback", async () => {
    const f = fixture({ shortProfile: true }); const r = f.configured();
    await r.apiRender({ characterId: "host", view: "front" });
    await expect(r.apiRender({ characterId: "stranger", view: "front" })).rejects.toThrow("IDENTITY_MISMATCH");
    await expect(r.apiRender({ characterId: "host", productId: "product", view: "front" })).rejects.toThrow("TASK_AMBIGUOUS");
    await expect(r.apiRender({ portraitId: "unknown-front", view: "front" })).rejects.toThrow("ARCHIVE_ONLY");
    await expect(r.apiRender({ productId: "product", view: "front" })).rejects.toThrow("ARCHIVE_ONLY");
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it("replaces the active view selection on resume while keeping historical image files intact", async () => {
    const f = fixture(); const r = f.configured();
    for (const angle of REQUIRED_ANGLES) await r.apiRender({ characterId: "host", angle });
    const index = r.snapshot(); const entry = index.characters.host!;
    entry.files.back = entry.files.front!;
    entry.artifacts!.back = entry.artifacts!.front!;
    entry.reuseReceipts!.back = entry.reuseReceipts!.front!;
    entry.receipts = { front: {} as never };
    writeFileSync(r.indexPath(), JSON.stringify(index));
    const resumed = f.configured(); await resumed.apiRender({ characterId: "host", angle: "front" });
    const current = resumed.snapshot().characters.host!;
    expect(Object.keys(current.files).sort()).toEqual([...REQUIRED_ANGLES].sort());
    expect(Object.keys(current.artifacts!).sort()).toEqual([...REQUIRED_ANGLES].sort());
    expect(Object.keys(current.reuseReceipts!).sort()).toEqual([...REQUIRED_ANGLES].sort());
    expect(current.receipts).toBeUndefined();
    expect(readFileSync(entry.files.front!)).toEqual(readFileSync(f.files.front!.path));
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it("preserves PNG content type when publishing copies, including a mislabeled legacy source extension", async () => {
    const f = fixture({ pngSources: true }); const r = f.configured();
    const file = await r.apiRender({ characterId: "host", angle: "front" });
    expect(file.endsWith("-front.png")).toBe(true);
    expect(readFileSync(file)).toEqual(readFileSync(f.files.front!.path));
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
});
