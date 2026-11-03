import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArchiveStore } from "@hyperreality/video-studio";
import { canonicalRenderJson, renderSha256 } from "./gen/compiled-request.js";

const db = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), connect: vi.fn() }));
vi.mock("@workloom/db", () => ({ getAppPool: () => ({ connect: db.connect }) }));

import { resumeProject, type ResumeOptions } from "./archive-resume.js";

const scope = { tenantId: "tenant-r2", workspaceId: "ws-r2" };
const projectId = "VID-R2";
const runId = "RUN-origin";
const sourceStageRunId = "SR-origin";
const createdAt = "2026-11-03T00:00:00.000Z";
const inputRef = "stages/preproduction/attempt-2.input.json";
const rawIntent = "客户原始营销请求。" + "完整保留原文与限制。".repeat(40) + "结尾要求，不显示价格。";
const request = {
  intent: `[需求口径] 时长：35秒；平台：xiaohongshu\n${rawIntent}`,
  rawIntent,
  isMarketing: true,
  metadata: {
    platform: "xiaohongshu",
    dataMining: { name: "MODEL-R2", brand: "BRAND-R2" },
    brief: { product: "MODEL-R2", duration: 35, productionRequirements: { frameRate: 60, audio: false } },
    characters: [{ id: "owner-selected" }],
  },
};
const snapshotBody = () => ({
  schemaVersion: "workloom.preproduction-resume-input/v1",
  scope: { ...scope, projectId, runId },
  projectCreatedAt: createdAt,
  request: structuredClone(request),
});

let workDir: string;
let archive: ArchiveStore;

beforeEach(async () => {
  vi.resetAllMocks();
  workDir = await mkdtemp(path.join(tmpdir(), "archive-resume-input-r2-"));
  vi.stubEnv("HR_WORK_DIR", workDir);
  archive = new ArchiveStore(workDir, scope.workspaceId, projectId, "marketing");
  await archive.ensure({ kind: "marketing", title: rawIntent.slice(0, 200), createdAt });
  db.connect.mockResolvedValue({ query: db.query, release: db.release });
  db.query.mockImplementation(async (sql: string) => {
    if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ ok: true }], rowCount: 1 };
    if (sql.startsWith("SELECT stage_id AS")) return { rows: [
      { stageId: "preproduction", attempt: 2, status: "failed", errorClass: "NETWORK", startedAt: createdAt },
    ], rowCount: 1 };
    if (sql.includes("SELECT title, kind")) return { rows: [
      { title: rawIntent.slice(0, 200), kind: "marketing", thread_id: null, created_at: createdAt },
    ], rowCount: 1 };
    if (sql.includes("input_ref")) return { rows: [{ id: sourceStageRunId, attempt: 2, run_id: runId, input_ref: inputRef, status: "failed" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(workDir, { recursive: true, force: true });
});

async function save(body = snapshotBody(), hash = renderSha256(canonicalRenderJson(body))) {
  await archive.writeJsonAtomic(inputRef, {
    stageId: "preproduction", attempt: 2, input: { resumeSnapshot: { ...body, sha256: hash } }, startedAt: createdAt,
  });
}

function start(options?: Pick<ResumeOptions, "fromStage" | "intent">) {
  const startRun = vi.fn<ResumeOptions["startRun"]>().mockReturnValue({ kind: "started", runId: "RUN-new" });
  const run = () => resumeProject(scope, {
    projectId, startRun, actor: { id: "MEM-R2", type: "human" }, ...options,
  });
  return { startRun, run };
}

describe("preproduction resume input provenance", () => {
  it("hands exact scoped source row identity and the archived byte digest to the real start seam", async () => {
    await save();
    const { run, startRun } = start();
    expect(await run()).toMatchObject({ kind: "resumed", attempt: 2 });
    const [workerInput, guard] = startRun.mock.calls[0] as unknown as [unknown, unknown];
    expect(workerInput).toEqual({ projectId, ...request });
    expect(guard).toMatchObject({
      ...scope, projectId, projectCreatedAt: createdAt, sourceStageRunId, attempt: 2, runId, inputRef,
      inputSha256: renderSha256(await readFile(path.join(archive.root, inputRef))), status: "failed",
    });
  });

  it("restores the archived raw intent, effective intent and full metadata without using the title", async () => {
    await save();
    const { run, startRun } = start();
    expect(await run()).toMatchObject({ kind: "resumed", attempt: 2, runId: "RUN-new" });
    expect(startRun).toHaveBeenCalledExactlyOnceWith({ projectId, ...request }, expect.any(Object));
  });

  it("retains full metadata when a caller explicitly supplies a new intent", async () => {
    await save();
    const intent = "修订要求：全片不显示价格。";
    const { run, startRun } = start({ fromStage: "preproduction", intent });
    expect(await run()).toMatchObject({ kind: "resumed", attempt: 2 });
    expect(startRun).toHaveBeenCalledExactlyOnceWith({ projectId, ...request, intent, rawIntent: intent }, expect.any(Object));
  });

  it.each(["legacy", "missing", "hash mismatch", "foreign run", "foreign tenant", "old project identity"] as const)(
    "does not launch an unverifiable %s input even under forced resume", async (kind) => {
      if (kind === "legacy") {
        await archive.writeJsonAtomic(inputRef, { stageId: "preproduction", attempt: 2, input: { intent: rawIntent, isMarketing: true } });
      } else if (kind !== "missing") {
        const body = snapshotBody();
        if (kind === "foreign run") body.scope.runId = "RUN-other";
        if (kind === "foreign tenant") body.scope.tenantId = "tenant-other";
        if (kind === "old project identity") body.projectCreatedAt = "2026-01-01T00:00:00.000Z";
        await save(body, kind === "hash mismatch" ? "0".repeat(64) : undefined);
      }
      const { run, startRun } = start({ fromStage: "preproduction" });
      expect(await run()).toMatchObject({ kind: "noaction", stage: "preproduction" });
      expect(startRun).not.toHaveBeenCalled();
    },
  );
});
