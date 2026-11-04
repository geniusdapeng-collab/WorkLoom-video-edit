import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../../apps/server/src/video/gen/catalog.js";
import { compileRenderRequest } from "../../apps/server/src/video/gen/compiled-request.js";
import { ArkImageProvider, ArkVideoProvider } from "../../apps/server/src/video/gen/providers.js";
import { OpenAiCompatibleProvider } from "../../packages/base/model-router/providers.js";
import { riskResponsesJsonSchema } from "../../packages/base/model-router/risk-responses-schema.js";
import { structuredSceneSchema } from "../../packages/video-studio/src/requirement-contract.js";
import { startProviderBudgetGateway } from "./lib/provider-budget-gateway.js";
import { BudgetJournal } from "./lib/provider-budget-journal.js";
import {
  ARK_IMAGE_PATH, ARK_VIDEO_PATH, DEEPSEEK_CHAT_PATH, DEEPSEEK_MODEL, digest, llmMicroCny, normalizeBudgetScope,
  SEEDANCE_MODEL, SEEDREAM_MODEL, TASK_CAPS,
} from "./lib/provider-budget-policy.js";

const CLIENT = "local_fixture_0123456789012345678901234567890123456789";
const DEEPSEEK = "fixture-private-deepseek";
const ARK = "fixture-private-ark";
const TASK = "isolated-test-case";
const IMAGE_URL = "https://fixture.tos-cn-beijing.volces.com/plate.png?signature=signed-fixture-only";
const VIDEO_URL = "https://fixture.tos-cn-beijing.volces.com/clip.mp4?signature=fixture-video";
const IMAGE_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X9f1kAAAAASUVORK5CYII=", "base64");
const IMAGE_DATA = `data:image/png;base64,${IMAGE_BYTES.toString("base64")}`;
const videoScope = { video: { seconds: 10, ratio: "9:16", resolution: "1080p" } };
const responsesPath = "/responses";
const roots: string[] = [];
const close: Array<() => Promise<void>> = [];

type Gateway = Awaited<ReturnType<typeof startProviderBudgetGateway>>;

afterEach(async () => {
  await Promise.all(close.splice(0).map((stop) => stop()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function location() {
  const dir = mkdtempSync(join(tmpdir(), "workloom-provider-budget-"));
  roots.push(dir);
  return join(dir, "journal.jsonl");
}

async function gate(fetchImpl: typeof fetch, options: { journalPath?: string; scope?: unknown; port?: number; now?: () => number; task?: string; profile?: string } = {}) {
  const journalPath = options.journalPath ?? location();
  const server = await startProviderBudgetGateway({
    task: options.task ?? TASK, port: options.port ?? 0, journalPath, clientToken: CLIENT,
    deepSeekApiKey: DEEPSEEK, arkApiKey: ARK, fetchImpl, scope: options.scope, now: options.now, profile: options.profile,
  });
  close.push(() => server.close());
  return { server, journalPath };
}

async function call(server: Gateway, path: string, body?: unknown, token = CLIENT) {
  const response = await fetch(server.baseUrl + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

const llm = (prompt = "private task fixture", max = 393_216) => ({
  model: DEEPSEEK_MODEL, max_tokens: max, messages: [{ role: "user", content: prompt }],
});
async function responseSceneSchema(count = 3) {
  type Agent = { run: (input: unknown, schema: unknown) => Promise<unknown>; _fallback: (input: unknown) => unknown };
  const { RequirementDiscoveryEngine } = createRequire(import.meta.url)(
    "../../vendor/supermickey/hyperreality-system/engines/requirement-discovery-engine.js",
  ) as { RequirementDiscoveryEngine: new () => {
    agents: Record<string, Agent>; discover: (input: Record<string, unknown>) => Promise<unknown>;
  } };
  const engine = new RequirementDiscoveryEngine();
  let nativeSchema: unknown;
  for (const [name, agent] of Object.entries(engine.agents)) {
    agent.run = async (input, schema) => {
      if (name === "scene") nativeSchema = schema;
      return agent._fallback(input);
    };
  }
  await engine.discover({ type: "商业广告", theme: "合法架空示例", duration_sec: count * 10 });
  return structuredSceneSchema(nativeSchema, { count, totalSeconds: count * 10, secondsPerSegment: 10, hardCuts: true,
    intervals: Array.from({ length: count }, (_, i) => ({ startSec: i * 10, endSec: i * 10 + 10, brief: "fixture" })) });
}
const strictScene = (schema: Record<string, unknown>, input = "完整原始创作输入，末行不得裁剪。") => ({
  model: DEEPSEEK_MODEL, input, instructions: "私有完整系统指令。",
  reasoning: { effort: "high" }, max_output_tokens: 393_216, stream: false,
  text: { format: { type: "json_schema", name: "workloom_scene_architect", schema } },
});
const strictRisk = (input = "完整风险审查输入。") => ({
  model: DEEPSEEK_MODEL, input, instructions: "私有完整系统指令。",
  reasoning: { effort: "high" }, max_output_tokens: 393_216, stream: false,
  text: { format: { type: "json_schema", ...riskResponsesJsonSchema } },
});
const responsesBody = (status = "completed") => ({
  id: "response-inert-fixture", object: "response", status, model: DEEPSEEK_MODEL,
  output: status === "completed"
    ? [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "{}" }] }] : [],
  usage: { input_tokens: 30, output_tokens: 20, total_tokens: 50 },
});
const image = (prompt = "private image fixture") => ({
  model: SEEDREAM_MODEL, prompt, size: "1080x1920", response_format: "url",
});
const video = (prompt = "private video fixture", duration = 10, resolution = "1080p") => ({
  model: SEEDANCE_MODEL, duration, ratio: "9:16", resolution, generate_audio: true,
  content: [{ type: "text", text: prompt }],
});
const llmResponse = (input = 12, output = 8) => Response.json({
  model: DEEPSEEK_MODEL, choices: [{ message: { role: "assistant", content: "private completion" }, finish_reason: "stop" }],
  usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
}, { headers: { "x-request-id": "deepseek-fixture-id", "set-cookie": "do-not-forward" } });
const imageResponse = (inputs = 0) => Response.json({
  model: SEEDREAM_MODEL, data: [{ url: IMAGE_URL, size: "1080x1920" }],
  usage: { input_images: inputs, generated_images: 1 },
});
const videoResponse = (id: string, duration = 10, resolution = "1080p", tokens = 486_000) => Response.json({
  id, model: SEEDANCE_MODEL, status: "succeeded", resolution, ratio: "9:16", duration, framespersecond: 24,
  content: { video_url: VIDEO_URL }, usage: { completion_tokens: tokens, total_tokens: tokens },
});
const code = (reply: Awaited<ReturnType<typeof call>>) => reply.data.error?.code;
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

describe("task-local provider budget gateway", () => {
  it("accepts the actual Edit adapter wire formats through the localhost entry point", async () => {
    const calls: Array<{ method: string | undefined; path: string; body?: string }> = [];
    const upstream = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push({ method: init?.method, path, body: init?.body ? Buffer.from(init.body as Uint8Array).toString() : undefined });
      if (path === DEEPSEEK_CHAT_PATH) return llmResponse();
      if (path === ARK_IMAGE_PATH) return imageResponse();
      if (path === ARK_VIDEO_PATH) return Response.json({ id: "native-video-wire" });
      return videoResponse("native-video-wire");
    });
    const { server } = await gate(upstream, { scope: videoScope });
    const text = new OpenAiCompatibleProvider(DEEPSEEK_MODEL, { baseUrl: server.baseUrl, apiKey: CLIENT });
    const completion = await text.chat([{ role: "user", content: "native A1 fixture" }], { scene: "preproduction" });
    expect(completion.text).toBe("private completion");
    expect(JSON.parse(calls[0]!.body!).max_tokens).toBe(393_216);

    const arkBase = `${server.baseUrl}/api/v3`;
    const images = new ArkImageProvider({ apiKey: CLIENT, baseUrl: arkBase });
    const picture = await images.submit({ prompt: "native plate fixture", estimatedUnits: 1,
      params: { providerModel: SEEDREAM_MODEL, resolution: "1080x1920" } });
    expect((await images.poll(picture.taskId)).uri).toBe(IMAGE_URL);

    const videos = new ArkVideoProvider({ apiKey: CLIENT, baseUrl: arkBase });
    const shot = await videos.submit({ prompt: "native shot fixture", estimatedUnits: 10,
      params: { providerModel: SEEDANCE_MODEL, resolution: "1080p", aspectRatio: "9:16", durationSec: 10, generateAudio: true } });
    expect((await videos.poll(shot.taskId)).uri).toBe(VIDEO_URL);
    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `POST ${DEEPSEEK_CHAT_PATH}`, `POST ${ARK_IMAGE_PATH}`, `POST ${ARK_VIDEO_PATH}`, `GET ${ARK_VIDEO_PATH}/native-video-wire`,
    ]);
  });

  it("forwards the exact compiled G8 Seedance 2.5 MP4 request and rejects other explicit video formats", async () => {
    const upstream = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ id: "g8-video-wire" }));
    const { server } = await gate(upstream, { scope: { ...videoScope, inlineImageSha256: [digest(IMAGE_BYTES)] } });
    const arkBase = `${server.baseUrl}/api/v3`;
    const params = { durationSec: 10, aspectRatio: "9:16", resolution: "1080p", generateAudio: true,
      cameraFixed: false, outputFormat: "mp4", referenceImageUrls: [IMAGE_DATA] };
    const model = getModel("doubao-seedance-2-5")!;
    const script = { id: "fixture-script", project_id: "fixture-project", shot_id: "fixture-shot", script_key: "qualified:fixture",
      version: 1, status: "draft", md: "Reviewed reference shot.", fields: { durationSec: 10 } };
    const { compiled } = compileRenderRequest({ script, model, params, scope: { tenantId: "fixture-tenant", workspaceId: "fixture-workspace" },
      mode: "manual", env: { SEEDANCE_ENDPOINT: arkBase } });
    const provider = new ArkVideoProvider({ apiKey: CLIENT, baseUrl: arkBase });
    await expect(provider.submit({ prompt: script.md, estimatedUnits: 10,
      params: { ...params, providerModel: compiled.providerModel } })).resolves.toEqual({ taskId: "g8-video-wire" });
    expect(compiled.body).toMatchObject({ model: SEEDANCE_MODEL, output_format: "mp4" });
    expect(compiled.body).not.toHaveProperty("camera_fixed");
    expect(Buffer.from(upstream.mock.calls[0]![1]!.body as Uint8Array).toString()).toBe(compiled.bodyJson);
    for (const output_format of ["mov", "MP4", null, true]) {
      expect(code(await call(server, ARK_VIDEO_PATH, { ...compiled.body, output_format }))).toBe("BUDGET_UNSUPPORTED_REQUEST");
    }
    expect(code(await call(server, ARK_VIDEO_PATH, { ...compiled.body, camera_fixed: false }))).toBe("BUDGET_UNSUPPORTED_REQUEST");
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("authenticates and denies off-contract routes, methods, models, media and noncanonical JSON before any upstream call", async () => {
    const upstream = vi.fn(async () => llmResponse());
    const { server } = await gate(upstream);
    expect((await call(server, "/budget/status", undefined, "wrong")).status).toBe(401);
    expect((await call(server, "/arbitrary", llm())).status).toBe(404);
    expect((await call(server, "/chat/completions?alternate=true", llm())).status).toBe(404);
    expect((await call(server, `${ARK_VIDEO_PATH}/unknown`)).status).toBe(404);
    expect(code(await call(server, DEEPSEEK_CHAT_PATH, '{"model":"unapproved","model":"deepseek-flash","messages":[],"max_tokens":5}')))
      .toBe("BUDGET_NONCANONICAL_JSON");
    expect(code(await call(server, DEEPSEEK_CHAT_PATH, { ...llm(), model: "deepseek-v4-pro" }))).toBe("BUDGET_UNSUPPORTED_REQUEST");
    expect(code(await call(server, DEEPSEEK_CHAT_PATH, { ...llm(), stream: true }))).toBe("BUDGET_UNSUPPORTED_REQUEST");
    expect(code(await call(server, ARK_IMAGE_PATH, { ...image(), layer_decomposition: true }))).toBe("BUDGET_UNSUPPORTED_REQUEST");
    expect(code(await call(server, ARK_IMAGE_PATH, { ...image(), image: IMAGE_DATA }))).toBe("BUDGET_UNPROVEN_IMAGE_REFERENCE");
    expect(code(await call(server, ARK_VIDEO_PATH, { ...video(), content: [...video().content,
      { type: "video_url", role: "reference_video", video_url: { url: VIDEO_URL } }] }))).toBe("BUDGET_UNSUPPORTED_REQUEST");
    expect(upstream).not.toHaveBeenCalled();
    const status = await call(server, "/budget/status");
    expect(status.data).toMatchObject({ task: TASK, state: "live", live: true, held: false, caps: TASK_CAPS,
      phaseRelays: { llm: { model: DEEPSEEK_MODEL }, image: { model: SEEDREAM_MODEL }, video: { model: SEEDANCE_MODEL } } });
  });

  it("fsyncs a reservation before the unchanged POST, denies concurrent overspend, and settles actual gross usage", async () => {
    const first = deferred();
    const second = deferred();
    const release = deferred();
    const wire = JSON.stringify(llm("private inbound text"));
    const journalPath = location();
    const upstream = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe("https://api.deepseek.com/chat/completions");
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${DEEPSEEK}` });
      expect(init?.redirect).toBe("error");
      if (upstream.mock.calls.length === 1) {
        expect(Buffer.from(init!.body as Uint8Array).toString()).toBe(wire);
        const journal = readFileSync(journalPath, "utf8");
        expect(journal).toContain('"type":"reserve"');
        expect(journal).toContain(digest(wire));
        expect(journal).not.toContain("private inbound text");
        first.release();
        await release.promise;
      } else if (upstream.mock.calls.length === 2) {
        second.release();
        await release.promise;
      }
      return llmResponse();
    });
    const { server } = await gate(upstream, { journalPath });
    const pending = [call(server, DEEPSEEK_CHAT_PATH, wire)];
    try {
      await first.promise;
      expect((await call(server, "/budget/status")).data).toMatchObject({ state: "held", live: true,
        reserved: { calls: 1 }, usage: { llmCalls: 1 } });
      pending.push(call(server, DEEPSEEK_CHAT_PATH, llm("second native full-window request")));
      await second.promise;
      expect(code(await call(server, DEEPSEEK_CHAT_PATH, llm("third concurrent spending")))).toBe("BUDGET_LLM_TOKENS_EXCEEDED");
      expect(code(await call(server, DEEPSEEK_CHAT_PATH, llm("arbitrary stage trim", 300_000)))).toBe("BUDGET_ILLEGAL_LLM_WINDOW");
      expect(code(await call(server, DEEPSEEK_CHAT_PATH, llm("out-of-contract output maximum", 393_217)))).toBe("BUDGET_ILLEGAL_LLM_WINDOW");
      expect(upstream).toHaveBeenCalledTimes(2);
    } finally {
      release.release();
      expect((await Promise.all(pending)).map((reply) => reply.status)).toEqual([200, 200]);
    }
    expect((await call(server, DEEPSEEK_CHAT_PATH, llm("same remaining budget after settlement"))).status).toBe(200);
    expect(code(await call(server, DEEPSEEK_CHAT_PATH, wire))).toBe("BUDGET_DUPLICATE_REQUEST");
    expect((await call(server, "/budget/status")).data).toMatchObject({ state: "live", held: false,
      consumed: { llmGrossTokens: 60, microCny: llmMicroCny(12, 8) * 3 }, reserved: { calls: 0, llmGrossTokens: 0 } });
    expect(readFileSync(journalPath, "utf8")).not.toMatch(/private inbound|private completion|fixture-private|local_fixture/);
  });

  it("limits the task to 40 model POST attempts even after tokens settle", async () => {
    const upstream = vi.fn(async () => llmResponse());
    const { server } = await gate(upstream);
    for (let i = 0; i < TASK_CAPS.llmCalls; i++) expect((await call(server, DEEPSEEK_CHAT_PATH, llm(`call ${i}`))).status).toBe(200);
    expect(code(await call(server, DEEPSEEK_CHAT_PATH, llm("forty-first")))).toBe("BUDGET_LLM_CALLS_EXCEEDED");
    expect(upstream).toHaveBeenCalledTimes(TASK_CAPS.llmCalls);
  });

  it("charges one image per admitted POST and accepts only pre-authorized bytes or task-issued image URLs", async () => {
    const upstream = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe("https://ark.cn-beijing.volces.com/api/v3/images/generations");
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${ARK}` });
      const body = JSON.parse(Buffer.from(init!.body as Uint8Array).toString());
      return imageResponse(body.image ? 1 : 0);
    });
    const { server, journalPath } = await gate(upstream, { scope: { inlineImageSha256: [digest(IMAGE_BYTES)] } });
    expect((await call(server, ARK_IMAGE_PATH, { ...image(), image: IMAGE_DATA })).status).toBe(200);
    expect((await call(server, ARK_IMAGE_PATH, { ...image("edit issued"), image: IMAGE_URL })).status).toBe(200);
    expect(code(await call(server, ARK_IMAGE_PATH, { ...image("unknown remote"), image: "https://unverified.volces.com/unissued" })))
      .toBe("BUDGET_UNPROVEN_IMAGE_REFERENCE");
    for (let i = 2; i < TASK_CAPS.imageCalls; i++) expect((await call(server, ARK_IMAGE_PATH, image(`image ${i}`))).status).toBe(200);
    expect(code(await call(server, ARK_IMAGE_PATH, image("ninth image")))).toBe("BUDGET_IMAGE_COUNT_EXCEEDED");
    expect(upstream).toHaveBeenCalledTimes(TASK_CAPS.imageCalls);
    expect((await call(server, "/budget/status")).data).toMatchObject({ consumed: { microCny: 2_400_000 }, usage: { imageCalls: 8 } });
    expect(readFileSync(journalPath, "utf8")).not.toContain("signed-fixture-only");
  });

  it("enforces exact video scope and rejects ambiguous adaptive inputs before spending", async () => {
    const upstream = vi.fn(async (url: string | URL | Request) => String(url).endsWith(ARK_IMAGE_PATH) ? imageResponse() : Response.json({ id: "task-first-frame" }));
    const { server } = await gate(upstream, { scope: videoScope });
    expect(code(await call(server, ARK_VIDEO_PATH, video("outside duration", 11)))).toBe("BUDGET_VIDEO_SCOPE_MISMATCH");
    expect(code(await call(server, ARK_VIDEO_PATH, { ...video(), ratio: "16:9" }))).toBe("BUDGET_VIDEO_SCOPE_MISMATCH");
    expect(code(await call(server, ARK_VIDEO_PATH, { ...video(), ratio: "adaptive" }))).toBe("BUDGET_UNSUPPORTED_REQUEST");
    expect(code(await call(server, ARK_VIDEO_PATH, { ...video(), duration: 9 }))).toBe("BUDGET_UNSUPPORTED_REQUEST");
    expect(upstream).not.toHaveBeenCalled();
    expect((await call(server, ARK_IMAGE_PATH, image())).status).toBe(200);
    const first = { ...video("first frame"), ratio: undefined, content: [...video().content,
      { type: "image_url", role: "first_frame", image_url: { url: IMAGE_URL } }] };
    expect((await call(server, ARK_VIDEO_PATH, first)).data).toEqual({ id: "task-first-frame" });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("reserves exact 3×10s at 1080p, recovers acknowledged tasks across restart, and never resubmits exact bytes", async () => {
    let postCount = 0;
    const upstream = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      expect(String(url)).toMatch(/^https:\/\/ark\.cn-beijing\.volces\.com\//);
      if (path === ARK_VIDEO_PATH && init?.method === "POST") return Response.json({ id: `ark-task-${++postCount}` });
      const id = path.split("/").at(-1)!;
      return videoResponse(id);
    });
    const first = await gate(upstream, { scope: videoScope });
    const one = video("A");
    for (const prompt of ["A", "B", "C"]) expect((await call(first.server, ARK_VIDEO_PATH, video(prompt))).status).toBe(200);
    expect(code(await call(first.server, ARK_VIDEO_PATH, video("D")))).toBe("BUDGET_VIDEO_LIMIT_EXCEEDED");
    expect((await call(first.server, "/budget/status")).data).toMatchObject({ state: "held",
      reserved: { microCny: 112_266_000, calls: 3 }, usage: { videoCalls: 3, videoSeconds: 30 } });
    await first.server.close();
    const { server } = await gate(upstream, { scope: videoScope, journalPath: first.journalPath, port: first.server.port });
    expect((await call(server, ARK_VIDEO_PATH, one)).data).toEqual({ id: "ark-task-1" });
    expect((await call(server, `${ARK_VIDEO_PATH}/ark-task-1`)).status).toBe(200);
    expect((await call(server, `${ARK_VIDEO_PATH}/ark-task-1`)).status).toBe(200);
    expect((await call(server, "/budget/status")).data).toMatchObject({ state: "held", frozen: null,
      consumed: { microCny: 37_422_000 }, reserved: { microCny: 74_844_000, calls: 2 },
      tasks: [{ taskId: "ark-task-1", state: "succeeded" }, { taskId: "ark-task-2", state: "accepted" }, { taskId: "ark-task-3", state: "accepted" }] });
    expect(postCount).toBe(3);
    expect(readFileSync(first.journalPath, "utf8")).not.toContain("fixture-video");
  });

  it("applies the shared ¥120 official estimate before starting a third 1080p video", async () => {
    let postCount = 0;
    const upstream = vi.fn(async () => Response.json({ id: `fixture-task-${++postCount}` }));
    const { server } = await gate(upstream);
    expect((await call(server, ARK_VIDEO_PATH, video("first", 15))).status).toBe(200);
    expect((await call(server, ARK_VIDEO_PATH, video("second", 15))).status).toBe(200);
    expect(code(await call(server, ARK_VIDEO_PATH, video("third", 10)))).toBe("BUDGET_CNY_EXCEEDED");
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("keeps a timed-out video reservation and still reconciles its original task after the deadline", async () => {
    let now = 1_800_000_000_000;
    let pollCount = 0;
    const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") return Response.json({ id: "original-held-task" });
      if (++pollCount === 1) throw new Error("lost provider readback");
      return videoResponse("original-held-task");
    });
    const { server } = await gate(upstream, { scope: videoScope, now: () => now });
    const body = video();
    expect((await call(server, ARK_VIDEO_PATH, body)).status).toBe(200);
    expect(code(await call(server, `${ARK_VIDEO_PATH}/original-held-task`))).toBe("BUDGET_OUTCOME_UNKNOWN");
    expect((await call(server, "/budget/status")).data).toMatchObject({ frozen: "BUDGET_UPSTREAM_TRANSPORT_UNKNOWN", held: true,
      reserved: { microCny: 37_422_000 }, tasks: [{ taskId: "original-held-task", state: "accepted" }] });
    now += TASK_CAPS.windowMs + 1;
    expect((await call(server, ARK_VIDEO_PATH, body)).data).toEqual({ id: "original-held-task" });
    expect((await call(server, `${ARK_VIDEO_PATH}/original-held-task`)).status).toBe(200);
    expect((await call(server, "/budget/status")).data).toMatchObject({ frozen: "BUDGET_UPSTREAM_TRANSPORT_UNKNOWN", expired: true,
      held: false, consumed: { microCny: 37_422_000 }, tasks: [{ taskId: "original-held-task", state: "succeeded" }] });
    expect(code(await call(server, ARK_VIDEO_PATH, video("no replacement for the original task")))).toBe("BUDGET_FROZEN");
    expect(upstream.mock.calls.map((call) => call[1]?.method)).toEqual(["POST", "GET", "GET"]);
  });

  it.each(["transport", "usage", "http"])("freezes and retains the reservation for unknown upstream %s", async (mode) => {
    const upstream = vi.fn(async () => {
      if (mode === "transport") throw new Error("do not leak upstream credentials");
      if (mode === "http") return Response.json({ message: "do not echo provider diagnostic" }, { status: 500 });
      return Response.json({ model: DEEPSEEK_MODEL, choices: [{ message: { content: "{}" } }] });
    });
    const first = await gate(upstream);
    const reply = await call(first.server, DEEPSEEK_CHAT_PATH, llm("unknown paid receipt"));
    expect(reply.status).toBe(502);
    expect(code(reply)).toBe("BUDGET_OUTCOME_UNKNOWN");
    expect(code(await call(first.server, DEEPSEEK_CHAT_PATH, llm("prevent another dispatch")))).toBe("BUDGET_FROZEN");
    expect((await call(first.server, "/budget/status")).data).toMatchObject({ state: "frozen", live: false, held: true, reserved: { calls: 1 } });
    await first.server.close();
    const { server } = await gate(upstream, { journalPath: first.journalPath, port: first.server.port });
    expect(code(await call(server, DEEPSEEK_CHAT_PATH, llm("prevent another dispatch")))).toBe("BUDGET_FROZEN");
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(readFileSync(first.journalPath, "utf8")).not.toMatch(/do not|unknown paid receipt/);
  });

  it("reconciles a confirmed overrun and freezes before any new paid request", async () => {
    const upstream = vi.fn(async () => llmResponse(600_000, 390_000));
    const { server } = await gate(upstream);
    expect((await call(server, DEEPSEEK_CHAT_PATH, llm("provider reported unexpectedly high input usage"))).status).toBe(200);
    expect((await call(server, "/budget/status")).data).toMatchObject({ frozen: "BUDGET_UPSTREAM_EXCEEDED_RESERVATION",
      held: false, consumed: { llmGrossTokens: 990_000 } });
    expect(code(await call(server, DEEPSEEK_CHAT_PATH, llm("no second paid call")))).toBe("BUDGET_FROZEN");
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("cannot reuse a journal on another port or scope and enforces its original deadline after restart", async () => {
    let now = 1_800_000_000_000;
    const upstream = vi.fn(async () => llmResponse());
    const first = await gate(upstream, { scope: videoScope, now: () => now });
    await expect(gate(upstream, { journalPath: first.journalPath, now: () => now, scope: videoScope })).rejects.toThrow("BUDGET_JOURNAL_SCOPE_MISMATCH");
    await first.server.close();
    await expect(gate(upstream, { journalPath: first.journalPath, port: first.server.port, now: () => now, scope: {} })).rejects.toThrow("BUDGET_JOURNAL_SCOPE_MISMATCH");
    now += TASK_CAPS.windowMs;
    const { server } = await gate(upstream, { journalPath: first.journalPath, port: first.server.port, now: () => now, scope: videoScope });
    expect(code(await call(server, DEEPSEEK_CHAT_PATH, llm()))).toBe("BUDGET_DEADLINE_EXCEEDED");
    expect((await call(server, "/budget/status")).data).toMatchObject({ expired: true, state: "expired", live: false, deadlineAt: now });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("admits a workflow beyond the legacy case and combined price caps while preserving every wire byte and the 40-call limit", async () => {
    const wireBodies: string[] = [];
    const upstream = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(url)).pathname === ARK_VIDEO_PATH) return Response.json({ id: "workflow-media-held" });
      wireBodies.push(Buffer.from(init!.body as Uint8Array).toString());
      return llmResponse(12, 390_000);
    });
    const { server, journalPath } = await gate(upstream, { profile: "workflow", scope: videoScope });
    expect((await call(server, ARK_VIDEO_PATH, video())).status).toBe(200);
    const sent = Array.from({ length: 40 }, (_, i) => JSON.stringify(llm(`full workflow request ${i}`)));
    for (const wire of sent) expect((await call(server, DEEPSEEK_CHAT_PATH, wire)).status).toBe(200);
    expect(wireBodies).toEqual(sent);
    expect(code(await call(server, DEEPSEEK_CHAT_PATH, sent[0]))).toBe("BUDGET_DUPLICATE_REQUEST");
    expect(code(await call(server, DEEPSEEK_CHAT_PATH, llm("forty-first workflow call")))).toBe("BUDGET_LLM_CALLS_EXCEEDED");
    expect(code(await call(server, DEEPSEEK_CHAT_PATH, llm("arbitrary clipping", 300_000)))).toBe("BUDGET_ILLEGAL_LLM_WINDOW");
    expect((await call(server, "/budget/status")).data).toMatchObject({
      profile: "workflow", live: true, held: true,
      caps: { llmCalls: 40, llmGrossTokens: 41_943_040, llmEstimatedMaxMicroCny: 178_257_920, mediaMicroCny: 120_000_000 },
      usage: { llmCalls: 40, settledLlmGrossTokens: (390_000 + 12) * 40, videoCalls: 1 },
      settledLlmTokens: { input: 12 * 40, output: 390_000 * 40 },
      estimatedCost: {
        llm: { settledMicroCny: llmMicroCny(12, 390_000) * 40, reservedMicroCny: 0 },
        media: { settledMicroCny: 0, reservedMicroCny: 37_422_000 },
      },
    });
    expect(upstream).toHaveBeenCalledTimes(41);
    expect(JSON.parse(readFileSync(journalPath, "utf8").split("\n")[0]!)).toMatchObject({ profile: "workflow" });
  });

  it("opens an explicit v2 journal and admits exactly 64 original full-window requests across restart", async () => {
    const wireBodies: string[] = [];
    const upstream = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      wireBodies.push(Buffer.from(init!.body as Uint8Array).toString());
      return new URL(String(url)).pathname === responsesPath
        ? Response.json({ ...responsesBody(), usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } })
        : llmResponse();
    });
    const now = 1_800_000_000_000;
    const options = { profile: "workflow-v2", scope: videoScope, now: () => now };
    const first = await gate(upstream, options);
    const sent = Array.from({ length: 65 }, (_, i) => JSON.stringify({
      ...llm(`full quality workflow request ${i}`), thinking: { type: "enabled" },
      reasoning_effort: "high", response_format: { type: "json_object" },
    }));
    sent[40] = JSON.stringify(strictScene(await responseSceneSchema(), "same exact workflow forty-first call"));
    for (const wire of sent.slice(0, 40)) expect((await call(first.server, DEEPSEEK_CHAT_PATH, wire)).status).toBe(200);
    await first.server.close();
    const restart = { ...options, journalPath: first.journalPath, port: first.server.port };
    const priorJournal = readFileSync(first.journalPath, "utf8");
    for (const profile of ["case", "workflow"]) {
      await expect(gate(upstream, { ...restart, profile })).rejects.toThrow("BUDGET_JOURNAL_SCOPE_MISMATCH");
    }
    expect(readFileSync(first.journalPath, "utf8")).toBe(priorJournal);
    const { server } = await gate(upstream, restart);
    expect((await call(server, "/budget/status")).data).toMatchObject({
      profile: "workflow-v2", openedAt: now, deadlineAt: now + TASK_CAPS.windowMs, usage: { llmCalls: 40 },
    });
    expect(code(await call(server, DEEPSEEK_CHAT_PATH, sent[0]))).toBe("BUDGET_DUPLICATE_REQUEST");
    expect(code(await call(server, DEEPSEEK_CHAT_PATH, llm("arbitrary clipping", 300_000)))).toBe("BUDGET_ILLEGAL_LLM_WINDOW");
    expect(code(await call(server, DEEPSEEK_CHAT_PATH, llm("too much output", 393_217)))).toBe("BUDGET_ILLEGAL_LLM_WINDOW");
    expect((await call(server, responsesPath, sent[40])).status).toBe(200);
    for (const wire of sent.slice(41, 64)) expect((await call(server, DEEPSEEK_CHAT_PATH, wire)).status).toBe(200);
    const fullJournal = readFileSync(first.journalPath, "utf8");
    expect(await call(server, DEEPSEEK_CHAT_PATH, sent[64])).toEqual({
      status: 429, data: { error: { code: "BUDGET_LLM_CALLS_EXCEEDED", message: "BUDGET_LLM_CALLS_EXCEEDED",
        limit: { profile: "workflow-v2", resource: "llmCalls", used: 64, cap: 64 } } },
    });
    expect(readFileSync(first.journalPath, "utf8")).toBe(fullJournal);
    expect(wireBodies).toEqual(sent.slice(0, 64));
    const caps = { llmCalls: 64, llmGrossTokens: 67_108_864, llmEstimatedMaxMicroCny: 285_212_672,
      mediaMicroCny: 120_000_000, imageCalls: 8, videoCalls: 3, minVideoSeconds: 10, maxVideoSeconds: 15,
      totalVideoSeconds: 45, windowMs: TASK_CAPS.windowMs };
    expect(JSON.parse(fullJournal.split("\n")[0]!)).toMatchObject({ profile: "workflow-v2", caps });
    expect((await call(server, "/budget/status")).data).toMatchObject({
      profile: "workflow-v2", live: true, held: false, caps,
      usage: { llmCalls: 64, settledLlmGrossTokens: 64 * 20, videoCalls: 0, imageCalls: 0 },
      settledLlmTokens: { input: 64 * 12, output: 64 * 8 },
      estimatedCost: { llm: { settledMicroCny: 64 * llmMicroCny(12, 8), reservedMicroCny: 0 },
        media: { settledMicroCny: 0, reservedMicroCny: 0 } },
    });
  });

  it("fsyncs each exact stateless Responses request and preserves complete and metered terminal bodies", async () => {
    const journalPath = location();
    const schema = await responseSceneSchema();
    const sent = ["completed", "incomplete", "failed"].map(state => ({
      state, wire: JSON.stringify(strictScene(schema, `original entire prompt for ${state}`)),
    }));
    const upstream = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const expected = sent[upstream.mock.calls.length - 1]!;
      expect(url).toBe("https://api.deepseek.com/responses");
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${DEEPSEEK}` });
      expect(Buffer.from(init!.body as Uint8Array).toString()).toBe(expected.wire);
      const reserved = readFileSync(journalPath, "utf8");
      expect(reserved).toContain(digest(expected.wire));
      expect(reserved).not.toContain("original entire prompt");
      return Response.json(responsesBody(expected.state), { headers: { "x-request-id": "responses-fixture" } });
    });
    const { server } = await gate(upstream, { scope: videoScope, profile: "workflow-v2", journalPath });
    for (const { state, wire } of sent) expect(await call(server, responsesPath, wire))
      .toEqual({ status: 200, data: responsesBody(state) });
    expect(code(await call(server, responsesPath, sent[0]!.wire))).toBe("BUDGET_DUPLICATE_REQUEST");
    expect(upstream).toHaveBeenCalledTimes(3);
    expect((await call(server, "/budget/status")).data).toMatchObject({ state: "live", held: false,
      phaseRelays: { llm: { structuredScenePath: responsesPath, admitted: 3 } },
      settledLlmTokens: { input: 90, output: 60 }, usage: { llmCalls: 3, settledLlmGrossTokens: 150, imageCalls: 0, videoCalls: 0 } });
  });

  it("only enables native frozen Scene Responses in workflow v2 with exact scope and no tools or continuation state", async () => {
    const upstream = vi.fn(async () => Response.json(responsesBody()));
    const schema = await responseSceneSchema();
    const body = strictScene(schema);
    for (const profile of ["case", "workflow"]) {
      const { server } = await gate(upstream, { profile, scope: videoScope });
      expect((await call(server, responsesPath, body)).status).toBe(404);
      expect((await call(server, "/budget/status")).data.phaseRelays.llm).not.toHaveProperty("structuredScenePath");
    }
    const { server } = await gate(upstream, { profile: "workflow-v2", scope: videoScope });
    expect((await call(server, responsesPath, body, "wrong")).status).toBe(401);
    expect((await call(server, responsesPath + "?unsafe", body)).status).toBe(404);
    for (const patch of [{ tools: [] }, { previous_response_id: "resp-other" }, { truncation: "disabled" },
      { store: false }, { stream: true }, { input: [{ role: "user", content: "text" }] },
      { reasoning: { effort: "none" } }, { model: "deepseek-v4-pro" },
      { text: { format: { ...body.text.format, name: "unrelated_schema" } } }]) {
      expect((await call(server, responsesPath, { ...body, ...patch })).status).toBe(400);
    }
    const unpinned = strictScene({ ...schema, $ref: "https://external.invalid/schema" });
    expect((await call(server, responsesPath, unpinned)).status).toBe(400);
    const wrongScope = await gate(upstream, { profile: "workflow-v2", scope: { video: { ...videoScope.video, seconds: 11 } } });
    expect((await call(wrongScope.server, responsesPath, body)).status).toBe(400);
    for (const max_output_tokens of [300_000, 393_217]) {
      expect(code(await call(server, responsesPath, { ...body, max_output_tokens }))).toBe("BUDGET_ILLEGAL_LLM_WINDOW");
    }
    expect(upstream).not.toHaveBeenCalled();
    expect((await call(server, responsesPath, strictScene(await responseSceneSchema(2)))).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("settles exact closed-schema Risk Responses in the same v2 WAL without forwarding a duplicate", async () => {
    const journalPath = location();
    const wire = JSON.stringify(strictRisk("Original private risk fixture."));
    const reply = responsesBody();
    const upstream = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe("https://api.deepseek.com/responses");
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${DEEPSEEK}` });
      expect(Buffer.from(init!.body as Uint8Array).toString()).toBe(wire);
      const journal = readFileSync(journalPath, "utf8");
      expect(journal).toContain(digest(wire));
      expect(journal).not.toContain("Original private risk fixture");
      return Response.json(reply);
    });
    const { server } = await gate(upstream, { scope: videoScope, profile: "workflow-v2", journalPath });
    expect(await call(server, responsesPath, wire)).toEqual({ status: 200, data: reply });
    expect(code(await call(server, responsesPath, wire))).toBe("BUDGET_DUPLICATE_REQUEST");
    expect(upstream).toHaveBeenCalledTimes(1);
    expect((await call(server, "/budget/status")).data).toMatchObject({ state: "live", held: false,
      usage: { llmCalls: 1, settledLlmGrossTokens: 50, imageCalls: 0, videoCalls: 0 },
      settledLlmTokens: { input: 30, output: 20 } });
  });

  it("rejects Risk Responses outside their exact schema, v2 scope and stateless controls before reserving", async () => {
    const upstream = vi.fn(async () => Response.json(responsesBody()));
    const risk = strictRisk();
    for (const profile of ["case", "workflow"]) {
      const { server } = await gate(upstream, { profile, scope: videoScope });
      expect((await call(server, responsesPath, risk)).status).toBe(404);
    }
    for (const scope of [{ seconds: 11 }, { ratio: "16:9" }, { resolution: "720p" }]) {
      const { server } = await gate(upstream, { profile: "workflow-v2", scope: { video: { ...videoScope.video, ...scope } } });
      expect((await call(server, responsesPath, risk)).status).toBe(400);
    }
    const { server, journalPath } = await gate(upstream, { profile: "workflow-v2", scope: videoScope });
    const before = readFileSync(journalPath, "utf8");
    const format = risk.text.format;
    for (const patch of [
      { tools: [] }, { previous_response_id: "other" }, { store: false }, { stream: true },
      { reasoning: { effort: "low" } }, { model: "deepseek-v4-pro" },
      { text: { format: { ...format, type: "json_object" } } },
      { text: { format: { ...format, name: "unrelated" } } },
      { text: { format: { ...format, schema: { ...format.schema, additionalProperties: true } } } },
      { text: { format: { ...format, schema: await responseSceneSchema() } } },
    ]) expect((await call(server, responsesPath, { ...risk, ...patch })).status).toBe(400);
    expect(code(await call(server, responsesPath, { ...risk, max_output_tokens: 300_000 }))).toBe("BUDGET_ILLEGAL_LLM_WINDOW");
    expect(readFileSync(journalPath, "utf8")).toBe(before);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("retains the Risk reservation and freezes on a prohibited upstream tool response", async () => {
    const upstream = vi.fn(async () => Response.json({ ...responsesBody(), output: [{ type: "function_call" }] }));
    const { server } = await gate(upstream, { profile: "workflow-v2", scope: videoScope });
    expect(code(await call(server, responsesPath, strictRisk()))).toBe("BUDGET_OUTCOME_UNKNOWN");
    expect((await call(server, "/budget/status")).data).toMatchObject({ state: "frozen", held: true,
      reserved: { calls: 1 }, usage: { llmCalls: 1, imageCalls: 0, videoCalls: 0 } });
    expect(code(await call(server, responsesPath, strictRisk("another request")))).toBe("BUDGET_FROZEN");
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it.each(["meter", "tool", "transport"])("freezes the same v2 WAL for unverifiable Responses %s", async (mode) => {
    const upstream = vi.fn(async () => {
      if (mode === "transport") throw new Error("fixture socket loss");
      return Response.json(mode === "meter"
        ? { ...responsesBody(), usage: { input_tokens: 30, output_tokens: 20, total_tokens: 49 } }
        : { ...responsesBody(), output: [{ type: "function_call", name: "forbidden" }] });
    });
    const first = await gate(upstream, { profile: "workflow-v2", scope: videoScope });
    expect(code(await call(first.server, responsesPath, strictScene(await responseSceneSchema())))).toBe("BUDGET_OUTCOME_UNKNOWN");
    expect(code(await call(first.server, DEEPSEEK_CHAT_PATH, llm("after unknown response")))).toBe("BUDGET_FROZEN");
    await first.server.close();
    const { server } = await gate(upstream, { profile: "workflow-v2", scope: videoScope,
      port: first.server.port, journalPath: first.journalPath });
    expect((await call(server, "/budget/status")).data).toMatchObject({ state: "frozen", held: true, reserved: { calls: 1 } });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it.each(["workflow", "workflow-v2"])("keeps the media price cap independent in %s mode", async (profile) => {
    let mediaSubmissions = 0;
    const upstream = vi.fn(async (url: string | URL | Request) => {
      if (new URL(String(url)).pathname === ARK_VIDEO_PATH) return Response.json({ id: `media-${++mediaSubmissions}` });
      return llmResponse();
    });
    const scope = { video: { ...videoScope.video, seconds: 15 } };
    const { server } = await gate(upstream, { profile, scope });
    expect((await call(server, DEEPSEEK_CHAT_PATH, llm())).status).toBe(200);
    expect((await call(server, ARK_VIDEO_PATH, video("first media shot", 15))).status).toBe(200);
    expect((await call(server, ARK_VIDEO_PATH, video("second media shot", 15))).status).toBe(200);
    expect(code(await call(server, ARK_VIDEO_PATH, video("third exceeds media funds", 15)))).toBe("BUDGET_MEDIA_CNY_EXCEEDED");
    expect(code(await call(server, ARK_VIDEO_PATH, video("off approved exact duration", 10)))).toBe("BUDGET_VIDEO_SCOPE_MISMATCH");
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("fails closed when a workflow profile is missing exact media scope or an unrecognized profile is selected", async () => {
    const upstream = vi.fn(async () => llmResponse());
    await expect(gate(upstream, { profile: "workflow" })).rejects.toThrow("BUDGET_WORKFLOW_SCOPE_REQUIRED");
    await expect(gate(upstream, { profile: "workflow-v2" })).rejects.toThrow("BUDGET_WORKFLOW_SCOPE_REQUIRED");
    await expect(gate(upstream, { profile: "unbounded", scope: videoScope })).rejects.toThrow("BUDGET_PROFILE_INVALID");
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["workflow", "workflow-v2"])("binds the %s WAL to its profile and preserves unknown holds after restart", async (profile) => {
    const upstream = vi.fn(async () => { throw new Error("fixture outcome unknown"); });
    const legacy = await gate(upstream, { scope: videoScope });
    await legacy.server.close();
    await expect(gate(upstream, { profile, scope: videoScope, journalPath: legacy.journalPath, port: legacy.server.port }))
      .rejects.toThrow("BUDGET_JOURNAL_SCOPE_MISMATCH");
    const first = await gate(upstream, { profile, scope: videoScope });
    const wire = llm("private uncertain workflow dispatch");
    expect(code(await call(first.server, DEEPSEEK_CHAT_PATH, wire))).toBe("BUDGET_OUTCOME_UNKNOWN");
    await first.server.close();
    const restart = { scope: videoScope, journalPath: first.journalPath, port: first.server.port };
    await expect(gate(upstream, restart)).rejects.toThrow("BUDGET_JOURNAL_SCOPE_MISMATCH");
    const otherProfile = profile === "workflow" ? "workflow-v2" : "workflow";
    await expect(gate(upstream, { ...restart, profile: otherProfile })).rejects.toThrow("BUDGET_JOURNAL_SCOPE_MISMATCH");
    const { server } = await gate(upstream, { ...restart, profile });
    expect((await call(server, "/budget/status")).data).toMatchObject({ profile, state: "frozen", held: true,
      reserved: { calls: 1 }, estimatedCost: { media: { settledMicroCny: 0, reservedMicroCny: 0 } } });
    expect(code(await call(server, DEEPSEEK_CHAT_PATH, wire))).toBe("BUDGET_DUPLICATE_REQUEST");
    expect(code(await call(server, DEEPSEEK_CHAT_PATH, llm("different but frozen")))).toBe("BUDGET_FROZEN");
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("fails closed on an interrupted reservation and on corrupt or exposed WALs", async () => {
    const upstream = vi.fn(async () => llmResponse());
    const first = await gate(upstream);
    await first.server.close();
    const path = first.journalPath;
    const store = BudgetJournal.open(path, first.server.port, TASK, normalizeBudgetScope(), Date.now);
    store.reserve(digest("durable reservation before lost receipt"), digest("original request bytes"), { kind: "llm", inputTokens: 40,
      maxOutputTokens: 393_216, microCny: llmMicroCny(40, 393_216) });
    store.close();
    const { server } = await gate(upstream, { journalPath: path, port: first.server.port });
    expect((await call(server, "/budget/status")).data).toMatchObject({ frozen: "BUDGET_INTERRUPTED_WITHOUT_RECEIPT",
      held: true, reserved: { llmGrossTokens: 393_256, calls: 1 } });
    expect(code(await call(server, DEEPSEEK_CHAT_PATH, llm()))).toBe("BUDGET_FROZEN");
    await server.close();
    chmodSync(path, 0o644);
    await expect(gate(upstream, { journalPath: path, port: first.server.port })).rejects.toThrow("BUDGET_JOURNAL_UNSAFE");
    chmodSync(path, 0o600);
    writeFileSync(path, "{truncated");
    await expect(gate(upstream, { journalPath: path, port: first.server.port })).rejects.toThrow("BUDGET_JOURNAL_INVALID");
    expect(upstream).not.toHaveBeenCalled();
  });
});
