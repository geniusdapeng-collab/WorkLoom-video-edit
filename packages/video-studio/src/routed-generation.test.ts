import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleProvider, resetCircuit, type ChatOptions, type EventSink, type ModelProvider } from "@workloom/base/model-router";
import { WorkloomLLMEngine, type LLMReasonOptions } from "./llm-adapter.js";

let server: Server;
let origin: string;
let bodies: Array<Record<string, unknown>>;
let httpStatus: number;
let hang: boolean;
beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.url === "/models") { res.writeHead(200); res.end("{}"); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (hang) return;
    res.writeHead(httpStatus, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 100, completion_tokens: 25 } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => { bodies = []; httpStatus = 200; hang = false; resetCircuit(); });
afterEach(() => { vi.restoreAllMocks(); resetCircuit(); });
function setup(routed = true, timeoutMs = 180_000, maxTokens = 8192) {
  const traces: unknown[] = [], degrades: unknown[] = [];
  const sink: EventSink = { recordModelTrace: async t => { traces.push(t); }, recordDegradation: async d => { degrades.push(d); }, recordCircuitBreak: async () => undefined };
  const provider = new OpenAiCompatibleProvider("deepseek-v4-pro", { baseUrl: origin });
  const providers = new Map<string, ModelProvider>([[provider.modelId, provider]]);
  const engine = new WorkloomLLMEngine({ baseUrl: origin, apiKey: "local-test-only", model: "direct-model", timeoutMs, maxTokens,
    ...(routed ? { router: { providers, sink, scene: "preproduction" } } : {}) });
  return { engine, provider, traces, degrades };
}

describe("video adapter → routeSmart → provider → serialized HTTP", () => {
  it("resolves the base implementation in this isolated worktree", () => {
    const resolved = realpathSync(createRequire(import.meta.url).resolve("@workloom/base/model-router"));
    expect(resolved).toBe(fileURLToPath(new URL("../../base/model-router/index.ts", import.meta.url)));
  });
  it("preserves all explicit controls, forceJson precedence, 180s and original metering", async () => {
    const { engine, provider, traces } = setup();
    const chat = vi.spyOn(provider, "chat");
    const result = await engine.reason("Return JSON", { forceJson: true, responseFormat: { type: "text" }, temperature: 0, topP: 0.7, maxTokens: 7000, thinking: { type: "disabled" } });
    expect(result.success).toBe(true); expect(result.data).toEqual({ ok: true });
    expect(chat.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 180_000, temperature: 0, topP: 0.7, maxTokens: 7000, responseFormat: { type: "json_object" }, thinking: { type: "disabled" } });
    expect(bodies[0]).toMatchObject({ model: "deepseek-v4-pro", temperature: 0, top_p: 0.7, max_tokens: 7000, response_format: { type: "json_object" }, thinking: { type: "disabled" } });
    expect(traces).toHaveLength(1); expect(traces[0]).toMatchObject({ model_id: "deepseek-v4-pro", scene: "preproduction", bill_to: "tenant", tier: "L2", credits: expect.any(Number) });
  });
  it("matches direct adapter defaults while leaving thinking and JSON absent", async () => {
    expect(await setup().engine.reason("text")).toMatchObject({ success: true });
    const routed = bodies[0]!;
    expect(await setup(false).engine.reason("text")).toMatchObject({ success: true });
    const direct = bodies[1]!;
    expect({ ...routed, model: direct.model }).toEqual(direct);
    expect(routed).toMatchObject({ temperature: 1, top_p: 0.95, max_tokens: 8192 });
    expect(routed).not.toHaveProperty("response_format"); expect(routed).not.toHaveProperty("thinking");
  });
  it.each([true, false])("preserves explicit responseFormat and configured token limit (routed=%s)", async routed => {
    await setup(routed, 9000, 1234).engine.reason("text", { responseFormat: { type: "text" }, thinking: { type: "enabled", budget: 3 } });
    expect(bodies[0]).toMatchObject({ response_format: { type: "text" }, max_tokens: 1234, thinking: { type: "enabled", budget: 3 } });
  });
  it("reasonRaw disables forced JSON without discarding explicit responseFormat", async () => {
    await setup().engine.reasonRaw("text", { forceJson: true, responseFormat: { type: "text" } });
    expect(bodies[0]).toMatchObject({ response_format: { type: "text" } });
  });
  it("forwards the adapter timeout to a short cancellable HTTP request", async () => {
    hang = true;
    const { engine, provider, traces, degrades } = setup(true, 30);
    const chat = vi.spyOn(provider, "chat");
    const result = await engine.reason("text");
    expect(result).toMatchObject({ success: false, retryable: true });
    expect(chat.mock.calls[0]?.[1]?.timeoutMs).toBe(30); expect(traces).toHaveLength(0);
    expect(degrades).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("模型调用超时") }));
  });
  it.each([true, false])("caller abort reaches the HTTP request (routed=%s)", async routed => {
    hang = true;
    const controller = new AbortController();
    const { engine, provider } = setup(routed);
    const chat = vi.spyOn(provider, "chat");
    const promise = engine.reason("text", { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    expect(await promise).toMatchObject({ success: false, retryable: true });
    if (routed) expect(chat.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
  it("keeps provider errors as degradation evidence and preserves retryable failure", async () => {
    httpStatus = 400;
    const { engine, traces, degrades } = setup();
    expect(await engine.reason("text")).toMatchObject({ success: false, retryable: true });
    expect(traces).toHaveLength(0);
    expect(degrades).toContainEqual(expect.objectContaining({ reason: "模型调用失败：HTTP 400" }));
  });
  it("does not allow generation options to overwrite routing signal or timeout", async () => {
    const { engine, provider } = setup(true, 2222);
    const chat = vi.spyOn(provider, "chat");
    await engine.reason("text", { temperature: 0, timeoutMs: 1 } as LLMReasonOptions);
    expect(chat.mock.calls[0]?.[1] as ChatOptions).toMatchObject({ timeoutMs: 2222, temperature: 0 });
    expect(bodies[0]).not.toHaveProperty("timeoutMs");
  });
  it("preserves structured third-argument options and chat zero through the real vendor bridge", async () => {
    // The production tsx loader owns CommonJS vendor loading; Vite's ESM test loader cannot load it directly.
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    const temp = await mkdtemp(path.join(tmpdir(), "routed-llm-bridge-"));
    try {
      const script = path.join(temp, "probe.mts");
      await writeFile(script, `
import { createRequire } from "node:module";
import { WorkloomLLMEngine, installVendorEngineBridge } from ${JSON.stringify(fileURLToPath(new URL("./llm-adapter.ts", import.meta.url)))};
import { OpenAiCompatibleProvider } from ${JSON.stringify(path.join(repo, "packages/base/model-router/index.ts"))};
const module = createRequire(${JSON.stringify(path.join(repo, "package.json"))})(${JSON.stringify(path.join(repo, "vendor/supermickey/systems/llm-reasoning-engine.js"))});
const provider = new OpenAiCompatibleProvider("deepseek-v4-pro", { baseUrl: ${JSON.stringify(origin)} });
const engine = new WorkloomLLMEngine({ baseUrl: ${JSON.stringify(origin)}, apiKey: "local-test-only", model: "direct-model",
 router: { providers: new Map([[provider.modelId, provider]]), sink: { recordModelTrace: async()=>{}, recordDegradation: async()=>{}, recordCircuitBreak: async()=>{} } } });
const restore = installVendorEngineBridge(engine);
try {
 const vendor = Object.create(module.LLMEngine.prototype);
 const structured = await vendor.reasonStructured("JSON", { type: "object" }, { temperature: 0, topP: 0.5, maxTokens: 4321, thinking: { type: "disabled" } });
 const chat = await vendor.chat("system", "text", 0);
 console.log("RESULT " + JSON.stringify({ structured, chat }));
} finally { restore(); }
`, "utf8");
      const { stdout } = await promisify(execFile)(process.execPath, [path.join(repo, "node_modules/tsx/dist/cli.mjs"), script], { cwd: repo, timeout: 20_000 });
      const result = JSON.parse(stdout.split("\n").find(line => line.startsWith("RESULT "))!.slice(7));
      expect(result).toMatchObject({ structured: { success: true, data: { ok: true } }, chat: '{"ok":true}' });
      expect(bodies[0]).toMatchObject({ temperature: 0, top_p: 0.5, max_tokens: 4321, response_format: { type: "json_object" }, thinking: { type: "disabled" } });
      expect(bodies[1]).toMatchObject({ temperature: 0 });
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
});
