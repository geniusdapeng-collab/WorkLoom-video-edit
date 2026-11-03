import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArkImageProvider, ArkVideoProvider } from "../../apps/server/src/video/gen/providers.js";
import { OpenAiCompatibleProvider } from "../../packages/base/model-router/providers.js";
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

async function gate(fetchImpl: typeof fetch, options: { journalPath?: string; scope?: unknown; port?: number; now?: () => number; task?: string } = {}) {
  const journalPath = options.journalPath ?? location();
  const server = await startProviderBudgetGateway({
    task: options.task ?? TASK, port: options.port ?? 0, journalPath, clientToken: CLIENT,
    deepSeekApiKey: DEEPSEEK, arkApiKey: ARK, fetchImpl, scope: options.scope, now: options.now,
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
