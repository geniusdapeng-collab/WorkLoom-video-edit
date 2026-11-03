import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FILM_CHANNEL_METHOD_COMPONENT, filmRequestHash, type FilmChannelRequestFrame } from "@hyperreality/video-studio";

let handle: typeof import("./film-worker.js")["handleFilmChannelRequest"];
const roots: string[] = [];
const endpoint = "https://film-reconcile.invalid/api/v3";
const uri = "https://film-asset.invalid/issued.mp4";
const taskId = "accepted-film-provider-task";
beforeAll(async () => {
  vi.stubEnv("FILM_VIDEO_POLL_MS", "1");
  vi.stubEnv("FILM_VIDEO_DEADLINE_MS", "100");
  handle = (await import("./film-worker.js")).handleFilmChannelRequest;
});
afterAll(() => vi.unstubAllEnvs());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(mode: "retry" | "deadline" | "provider-failed" | "ledger-failed" | "aborted" | "late-ack") {
  const workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "film-reconciliation-")));
  roots.push(workDir);
  const aborted = new AbortController();
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let polls = 0;
  let acknowledgeSubmit!: () => void;
  const delayedSubmit = new Promise<void>((resolve) => { acknowledgeSubmit = resolve; });
  const sequence: string[] = [];
  const ledger = {
    reserveComponent: vi.fn(async () => ({ row: { id: "component-id" }, deduped: false })),
    claimComponent: vi.fn(async () => ({ id: "component-id" })),
    recordDispatch: vi.fn(async () => { sequence.push("dispatch"); }),
    recordComponentProviderTask: vi.fn(async (_id: string, _owner: string, _receipt: Record<string, unknown>) => {
      sequence.push("receipt");
      if (mode === "ledger-failed") throw new Error("temporary receipt write failure");
      if (mode === "aborted") aborted.abort();
    }),
    recordComponentAccepted: vi.fn(async (_id: string, _owner: string, _receipt: Record<string, unknown>) => undefined),
    recordComponentFailure: vi.fn(async (_id: string, _owner: string, _receipt: Record<string, unknown>) => undefined),
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (input === endpoint + "/contents/generations/tasks" && init?.method === "POST") {
      sequence.push("submit");
      if (mode === "late-ack") {
        aborted.abort();
        await delayedSubmit;
      }
      return Response.json({ id: taskId });
    }
    if (input === endpoint + "/contents/generations/tasks/" + taskId && init?.method === "GET") {
      sequence.push("poll");
      polls++;
      if (mode === "provider-failed") return Response.json({ status: "failed", error: { message: "explicit supplier rejection" } });
      if (mode === "deadline") {
        now += 100;
        return new Response("temporary unavailable", { status: 503 });
      }
      if (polls === 1) return new Response("temporary unavailable", { status: 503 });
      return Response.json({ status: "succeeded", content: { video_url: uri } });
    }
    if (input === uri) {
      sequence.push("download");
      return new Response("fixture-video-bytes");
    }
    throw new Error("NON_FIXTURE_OUTBOUND_REQUEST");
  }));
  const ctx = {
    scope: { tenantId: "film-tenant", workspaceId: "film-workspace" },
    env: { VOLCENGINE_ARK_API_KEY: "fixture-only", SEEDANCE_ENDPOINT: endpoint, SEEDANCE_MODEL: "fixture-video-model" },
    job: { id: "film-job", project_id: "film-project", stages: ["videos"], options: {} },
    worker: { capabilities: ["video.generate"] }, workDir, shots: new Map([["S1", { shotId: "S1" }]]),
    signal: aborted.signal, deadlineAt: now + 200, ownerToken: "film-owner", issuedUrls: new Map(),
    log: vi.fn(), ledger,
  } as unknown as Parameters<typeof handle>[0];
  const params = { prompt: "固定机位记录水面", seconds: 5, targetRef: "issued.mp4" };
  const frame: FilmChannelRequestFrame = {
    kind: "film.request", id: "fixture-frame", method: "video.generate",
    component: FILM_CHANNEL_METHOD_COMPONENT["video.generate"]!,
    stepKey: "videos:S1", shotId: "S1", params, idempotencyKey: "issued-render-key",
    requestHash: filmRequestHash({ method: "video.generate", stepKey: "videos:S1", shotId: "S1", params }),
  };
  return { workDir, ledger, sequence, acknowledgeSubmit, run: () => handle(ctx, frame) };
}

const providerTask = {
  provider: "seedance", providerModel: "fixture-video-model",
  taskId, requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
};

describe("固定影片工位已接受任务的回查", () => {
  it("短暂查询503后在原时限内只查询同一task，保留唯一生成和完整产物回执", async () => {
    const f = fixture("retry");
    const result = await f.run();
    expect(result).toMatchObject({ taskId, hostedUrl: uri, ref: "issued.mp4" });
    expect(f.sequence).toEqual(["dispatch", "submit", "receipt", "poll", "poll", "download"]);
    expect(f.ledger.recordComponentProviderTask).toHaveBeenCalledExactlyOnceWith("component-id", "film-owner", providerTask);
    expect(f.ledger.recordComponentAccepted).toHaveBeenCalledExactlyOnceWith("component-id", "film-owner",
      expect.objectContaining({ evidence: expect.objectContaining({ providerTaskId: taskId, artifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }) }));
    expect(f.ledger.recordComponentFailure).not.toHaveBeenCalled();
    expect(readFileSync(path.join(f.workDir, "issued.mp4"), "utf8")).toBe("fixture-video-bytes");
  });

  it.each(["deadline", "ledger-failed", "aborted"] as const)("已接受后的%s保持unknown并把原任务证据带入对账", async (mode) => {
    const f = fixture(mode);
    await expect(f.run()).rejects.toThrow();
    expect(f.sequence.filter((action) => action === "submit")).toHaveLength(1);
    expect(f.sequence.filter((action) => action === "poll")).toHaveLength(mode === "deadline" ? 1 : 0);
    expect(f.ledger.recordComponentAccepted).not.toHaveBeenCalled();
    expect(f.ledger.recordComponentFailure).toHaveBeenCalledExactlyOnceWith("component-id", "film-owner",
      expect.objectContaining({ state: "unknown", evidence: expect.objectContaining({ providerTask }) }));
  });

  it("明确的供应商失败仍写真实终态并保留已接受任务身份", async () => {
    const f = fixture("provider-failed");
    await expect(f.run()).rejects.toMatchObject({ code: "PROVIDER_FAILED" });
    expect(f.sequence).toEqual(["dispatch", "submit", "receipt", "poll"]);
    expect(f.ledger.recordComponentFailure).toHaveBeenCalledExactlyOnceWith("component-id", "film-owner",
      expect.objectContaining({ state: "failed", failureClass: "PROVIDER_FAILED", evidence: expect.objectContaining({ providerTask }) }));
  });

  it("作业中止后迟到的提交回执仍入账，但不会开启新的查询或产物下载", async () => {
    const f = fixture("late-ack");
    try {
      await expect(f.run()).rejects.toMatchObject({ code: "JOB_DEADLINE_EXCEEDED" });
      expect(f.ledger.recordComponentFailure).toHaveBeenCalledExactlyOnceWith("component-id", "film-owner",
        expect.objectContaining({ state: "unknown" }));
    } finally {
      f.acknowledgeSubmit();
    }
    await vi.waitFor(() => expect(f.ledger.recordComponentProviderTask)
      .toHaveBeenCalledExactlyOnceWith("component-id", "film-owner", providerTask));
    expect(f.sequence).toEqual(["dispatch", "submit", "receipt"]);
    expect(f.ledger.recordComponentAccepted).not.toHaveBeenCalled();
  });
});
