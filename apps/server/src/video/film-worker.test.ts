import { describe, expect, it } from "vitest";
import { filmWorkerEnvironment, handleFilmChannelRequest, validateFilmChannelScope } from "./film-worker.js";
import { FILM_CHANNEL_METHOD_COMPONENT, filmRequestHash, resolveEraProfile, type FilmChannelRequestFrame } from "@hyperreality/video-studio";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
describe("film worker child environment", () => {
  it("keeps public local tools while dropping every account, database, model and signing credential", () => {
    const env = filmWorkerEnvironment({ PATH: "/local/bin", WL_FFMPEG: "/local/ffmpeg", SEEDANCE_MODEL: "test-model", LLM_API_KEY: "test-secret", DEEPSEEK_API_KEY: "test-secret", DEEPSEEK_BASE_URL: "https://api.deepseek.com", JWT_SECRET: "test-secret", CNB_TOKEN: "test-secret", DATABASE_URL: "test-secret", CUSTOMER_OAUTH_TOKEN: "test-secret", NODE_OPTIONS: "--import arbitrary" });
    expect(env).toEqual({ PATH: "/local/bin", WL_FFMPEG: "/local/ffmpeg", SEEDANCE_MODEL: "test-model" });
  });
});

describe("film parent local post budget", () => {
  it.each(["shot", "compose", "color", "subtitle", "mux", "danmaku", "bgm", "sfx", "cover", "master"])("%s completes the actual parent channel with no model budget", async (stage) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "film-post-zero-budget-")));
    try {
      writeFileSync(join(dir, "actual-post-receipt.json"), JSON.stringify({ processing: "actual-local-post" }));
      const frozenStage = stage === "shot" ? "videos" : stage;
      const shotId = stage === "shot" ? "S1" : null;
      const stepKey = shotId ? `${frozenStage}:${shotId}` : frozenStage;
      const accepted: Array<Record<string, unknown>> = [];
      const reserved: number[] = [];
      const dispatched: string[] = [];
      const params = { stage, projectId: "project-a", context: shotId ? { shotId } : {},
        artifacts: [{ ref: "actual-post-receipt.json", kind: "json" }],
        deterministic: [{ id: "tool-exit", hard: true, pass: true, detail: "local command completed" }],
      };
      const requestHash = filmRequestHash({ method: "gate.review", stepKey, shotId, params });
      const frame: FilmChannelRequestFrame = { kind: "film.request", id: "actual-parent-request",
        method: "gate.review", component: FILM_CHANNEL_METHOD_COMPONENT["gate.review"]!,
        stepKey, shotId, params, requestHash, idempotencyKey: `post:${stage}` };
      const ctx = {
        scope: { workspaceId: "workspace-a", tenantId: "tenant-a" }, env: {},
        job: { id: "job-a", project_id: "project-a", stages: [frozenStage], options: { "review-policy": "blocking" }, attempt: 1 },
        worker: { capabilities: ["gate.review"] }, workDir: dir, archiveRoot: dir,
        shots: new Map([["S1", { shotId: "S1", scene: "black silent source" }]]), frozen: {},
        contractSource: { projectId: "project-a", shots: [{ shotId: "S1", scene: "black silent source" }], eraProfile: resolveEraProfile({ storyDate: "2026-10-07" }) },
        signal: new AbortController().signal, deadlineAt: Date.now() + 60_000,
        ownerToken: "parent-owner", issuedUrls: new Map(), log: () => undefined, send: () => undefined,
        ledger: {
          reserveComponent: async (input: { reservedCny: number }) => {
            reserved.push(input.reservedCny);
            if (input.reservedCny > 0) throw new Error("ZERO_MODEL_BUDGET: no funds for a model call");
            return { row: { id: "component-a" }, deduped: false };
          },
          claimComponent: async () => ({ id: "component-a" }),
          recordDispatch: async (_id: string, _owner: string, provider: string) => { dispatched.push(provider); },
          recordComponentAccepted: async (_id: string, _owner: string, receipt: Record<string, unknown>) => { accepted.push(receipt); },
          recordComponentFailure: async () => { throw new Error("unexpected local-post failure"); },
        },
      } as unknown as Parameters<typeof handleFilmChannelRequest>[0];
      const verdict = await handleFilmChannelRequest(ctx, frame) as { approved: boolean; score: number | null };
      expect(verdict).toMatchObject({ approved: true, score: null });
      expect(reserved).toEqual([0]);
      expect(dispatched).toEqual(["workloom.producer-gate"]);
      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toMatchObject({ actualCny: 0, evidence: { score: null, approved: true } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("film parent frozen method and shot scope", () => {
  const scope = { stages: ["cine-kb", "plates", "videos", "material-gen", "voice", "cover", "spec", "continuity"], projectId: "project-a", shotIds: new Set(["S1", "S2"]) };
  const frame = (method: string, stepKey: string, shotId: string | null, params: unknown = {}): FilmChannelRequestFrame => ({
    kind: "film.request", id: "request-a", method, component: FILM_CHANNEL_METHOD_COMPONENT[method]!,
    stepKey, shotId, params, idempotencyKey: "idempotency-a", requestHash: "unused-by-scope-validation",
  });
  it.each([
    ["image.generate", "cine-kb:S1", "S1", "METHOD_STAGE_MISMATCH"],
    ["video.generate", "plates:S1", "S1", "METHOD_STAGE_MISMATCH"],
    ["image.generate", "plates:S1", "S2", "STEP_SHOT_MISMATCH"],
    ["image.generate", "plates", "S1", "STEP_SHOT_MISMATCH"],
    ["image.generate", "plates:S1:extra", "S1", "STEP_SHOT_MISMATCH"],
    ["image.generate", "plates", null, "SHOT_NOT_FOUND"],
    ["voice.dub", "videos:S1", "S1", "METHOD_STAGE_MISMATCH"],
    ["llm.chat", "spec", null, "METHOD_STAGE_MISMATCH"],
    ["media.fetch", "cover", null, "METHOD_STAGE_MISMATCH"],
    ["image.generate", "outside:S1", "S1", "STEP_OUT_OF_SCOPE"],
    ["image.generate", "plates:S3", "S3", "SHOT_NOT_FOUND"],
  ])("rejects %s at %s bound to %s", (method, stepKey, shotId, error) => {
    expect(() => validateFilmChannelScope(frame(String(method), String(stepKey), shotId as string | null), scope)).toThrow(String(error));
  });
  it("accepts registered component routes and bound step keys", () => {
    for (const [method, stage, shot] of [["image.generate", "plates", "S1"], ["video.generate", "videos", "S1"], ["video.generate", "material-gen", "S2"], ["voice.dub", "voice", "S1"], ["voice.verify", "voice", "S2"], ["llm.chat", "cover", null], ["media.fetch", "plates", null]] as const) {
      expect(() => validateFilmChannelScope(frame(method, shot === null ? stage : `${stage}:${shot}`, shot), scope)).not.toThrow();
    }
  });
  it("binds review aliases, project, shot and material source before reservation", () => {
    const review = (stage: string, key: string, shotId: string | null, context: object = {}) => frame("gate.review", key, shotId, { projectId: "project-a", stage, context });
    expect(() => validateFilmChannelScope(review("prompt", "spec", null), scope)).not.toThrow();
    expect(() => validateFilmChannelScope(review("continuity", "continuity", null), scope)).not.toThrow();
    expect(() => validateFilmChannelScope(review("shot", "material-gen:S1", "S1", { shotId: "S1", sourceStage: "material-gen" }), scope)).not.toThrow();
    expect(() => validateFilmChannelScope(review("prompt", "plates", null), scope)).toThrow("METHOD_STAGE_MISMATCH");
    expect(() => validateFilmChannelScope(frame("gate.review", "spec", null, { projectId: "other", stage: "prompt" }), scope)).toThrow("REVIEW_SCOPE_INVALID");
    expect(() => validateFilmChannelScope(review("keyframe", "plates:S1", "S1", { shotId: "S2" }), scope)).toThrow("REVIEW_SCOPE_INVALID");
    expect(() => validateFilmChannelScope(review("shot", "material-gen:S1", "S1", { shotId: "S1", sourceStage: "videos" }), scope)).toThrow("REVIEW_SCOPE_INVALID");
  });
  it("denies a frozen source shot outside an explicit only selection", () => {
    expect(() => validateFilmChannelScope(frame("image.generate", "plates:S2", "S2"), { ...scope, shotIds: new Set(["S1"]) })).toThrow("SHOT_NOT_FOUND");
  });
});
