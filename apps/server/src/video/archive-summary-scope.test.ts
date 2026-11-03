import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), connect: vi.fn() }));
vi.mock("@workloom/db", () => ({ getAppPool: () => ({ connect: db.connect }), getOwnerPool: () => ({ query: db.query }) }));
import { ArchiveStore } from "@hyperreality/video-studio";
import { readArchiveSummary } from "./archive-resume.js";

describe("archive summary project scope", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "archive-summary-scope-"));
    vi.stubEnv("HR_WORK_DIR", directory);
    vi.resetAllMocks();
    db.connect.mockResolvedValue({ query: db.query, release: db.release });
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

  it("does not read archive bytes until the scoped project query has succeeded", async () => {
    const store = new ArchiveStore(directory, "own", "project");
    await store.ensure();
    await store.writeJsonAtomic("context-bundle.json", { projectId: "project", privateBrief: "synthetic-only" });
    await store.appendJsonl("events.jsonl", { kind: "synthetic-only" });
    const readManifest = vi.spyOn(ArchiveStore.prototype, "readManifest");
    const result = await readArchiveSummary({ tenantId: "tenant", workspaceId: "own" }, "project");
    expect(result.archiveExists).toBe(false);
    expect(result.contextBundle).toBeNull();
    expect(result.recentEvents).toEqual([]);
    expect(readManifest).not.toHaveBeenCalled();
    readManifest.mockRestore();
  });

  it("returns the current workspace's archive when its project is visible", async () => {
    const store = new ArchiveStore(directory, "own", "project");
    await store.ensure();
    await store.writeJsonAtomic("context-bundle.json", { projectId: "project", progress: "owned fixture" });
    db.query.mockImplementation(async (sql: string) => ({ rows: /FROM video_projects/.test(sql) ? [{ id: "project" }] : [], rowCount: /FROM video_projects/.test(sql) ? 1 : 0 }));
    const result = await readArchiveSummary({ tenantId: "tenant", workspaceId: "own" }, "project");
    expect(result.archiveExists).toBe(true);
    expect(result.manifest).toMatchObject({ workspaceId: "own", projectId: "project" });
    expect(result.contextBundle).toMatchObject({ projectId: "project", progress: "owned fixture" });
    const projectCall = db.query.mock.calls.find(([sql]) => /FROM video_projects/.test(sql));
    expect(projectCall?.[1]).toEqual(["own", "project"]);
  });
});
