import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import { loadCatalog, mcpTools } from "./agent-capabilities.mjs";
import { parseEditAgentArgs, readEditAgentInput } from "./edit-agent.mjs";
import { attachEditMcpInput, createEditMcpServer, EDIT_AGENT_INSTRUCTIONS } from "./edit-agent-mcp.mjs";
import { EDIT_AGENT_ROOT, EDIT_READ_PROCEDURES, editAgentError, editAgentTools, invokeEditAgent, loadEditAgentCatalog } from "./tools/lib/edit-agent-catalog.mjs";

const execute = promisify(execFile);
const catalog = await loadEditAgentCatalog();
const nativeNames = ["plan", "start", "status", "continue", "repair_plan", "repair"].map((name) => "workloom_edit_video_workflow_" + name);
const identity = { schemaVersion: "workloom.service-product/v1", productId: "workloom-ai-video-edit", repository: "workloom-ai/WorkLoom-video-edit" };
const token = randomUUID();
function output() { const messages = []; return { messages, write(value) { messages.push(JSON.parse(value)); return true; } }; }
const request = (id, method, params) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
async function serverHarness(invoke) {
  const out = output(), server = createEditMcpServer({ catalog, output: out, ...(invoke ? { invoke } : {}) });
  await server.handle(request(1, "initialize", { protocolVersion: "2025-11-25" }));
  return { out, server };
}
async function fixture(t, product = identity, data = { models: [], fixture: true }) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push({ path: url.pathname, method: req.method, token: req.headers.authorization,
      key: req.headers["x-workloom-desktop-key"], input: url.searchParams.get("input") });
    if (url.pathname === "/health/product") { res.end(JSON.stringify(product)); return; }
    res.end(JSON.stringify({ result: { data } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((done) => { server.close(done); server.closeAllConnections(); }));
  return { requests, api: `http://127.0.0.1:${server.address().port}` };
}

test("product catalog preserves enabled legacy read tool names and keeps legacy writes disabled", async () => {
  const legacy = await loadCatalog(EDIT_AGENT_ROOT);
  const expected = mcpTools(legacy).filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name);
  const tools = editAgentTools(catalog), names = tools.map((tool) => tool.name);
  assert.deepEqual(names.filter((name) => !name.startsWith("workloom_edit_")), expected);
  for (const name of [...nativeNames, "workloom_edit_agent_doctor"]) assert.ok(names.includes(name), name);
  assert.equal(names.includes("workloom_growth_service_inquiry_execute"), false);
  assert.equal(new Set(names).size, names.length);
  for (const name of ["start", "continue", "repair"]) {
    assert.equal(tools.find((tool) => tool.name === "workloom_edit_video_workflow_" + name).annotations.readOnlyHint, false);
  }
  for (const name of ["plan", "status", "repair_plan"]) {
    assert.equal(tools.find((tool) => tool.name === "workloom_edit_video_workflow_" + name).annotations.readOnlyHint, true);
  }
  await assert.rejects(invokeEditAgent(catalog, "growth.service.inquiry.execute", {}), { code: "DISABLED" });
});

test("CLI parsing accepts JSON file/stdin, never intent, API, key, or root flags", () => {
  assert.deepEqual(parseEditAgentArgs(["invoke", "edit.video.workflow.plan", "--input-file", "-"]),
    { command: "invoke", id: "edit.video.workflow.plan", inputFile: "-" });
  for (const args of [["list", "--root", "/tmp"], ["invoke", "edit.video.workflow.plan", "--intent", "raw"],
    ["invoke", "edit.video.workflow.plan", "--base-url", "http://127.0.0.1:1"], ["describe"], ["invoke", "--help"]]) {
    assert.throws(() => parseEditAgentArgs(args), { code: "USAGE" });
  }
});

test("CLI input checks UTF-8 JSON, ordinary files and streaming size before dispatch", async (t) => {
  assert.deepEqual(await readEditAgentInput("-", Readable.from(['{"intent":"17秒短片"}'])), { intent: "17秒短片" });
  await assert.rejects(readEditAgentInput("-", Readable.from(["{"])), { code: "INVALID_INPUT" });
  await assert.rejects(readEditAgentInput("-", Readable.from([Buffer.from([0xff])])), { code: "INVALID_INPUT" });
  await assert.rejects(readEditAgentInput("-", Readable.from([Buffer.alloc(8 * 1024 * 1024 + 1)])), { code: "INPUT_TOO_LARGE" });
  const folder = await mkdtemp(join(tmpdir(), "edit-agent-cli-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, "input.json"); await writeFile(file, '{"x":1}');
  assert.deepEqual(await readEditAgentInput(file), { x: 1 });
  await symlink(file, join(folder, "link.json"));
  await assert.rejects(readEditAgentInput(join(folder, "link.json")), { code: "INPUT_READ_FAILED" });
  await assert.rejects(readEditAgentInput(folder), { code: "INPUT_TOO_LARGE" });
});

test("legacy query verifies Edit identity before member token on the same connection", async (t) => {
  const f = await fixture(t);
  const result = await invokeEditAgent(catalog, "growth.video.gen.catalog", { kind: "video" },
    { env: { WORKLOOM_BASE_URL: f.api, WORKLOOM_ACCESS_TOKEN: token } });
  assert.equal(result.result.fixture, true);
  assert.deepEqual(f.requests.map(({ path, token: bearer }) => [path, bearer]), [
    ["/health/product", undefined], ["/trpc/video.gen.catalog", `Bearer ${token}`],
  ]);
  const other = await fixture(t, { ...identity, productId: "wrong-product" });
  await assert.rejects(invokeEditAgent(catalog, "core.threads.list", {},
    { env: { WORKLOOM_BASE_URL: other.api, WORKLOOM_ACCESS_TOKEN: token } }), { code: "STUDIO_PRODUCT_MISMATCH" });
  assert.deepEqual(other.requests.map(({ path, token: bearer }) => [path, bearer]), [["/health/product", undefined]]);
});

test("legacy query rejects caller-controlled and unreviewed transports without network", async () => {
  const original = catalog.entries.get("core.threads.list");
  for (const transport of [{ kind: "trpc", path: "video.studio.start", method: "mutation" },
    { kind: "trpc", path: "arbitrary.route", method: "query" }]) {
    const copy = { ...catalog, entries: new Map(catalog.entries).set(original.id, { ...original, transport }) };
    await assert.rejects(invokeEditAgent(copy, original.id, {}, { env: { WORKLOOM_BASE_URL: "http://127.0.0.1:1", WORKLOOM_ACCESS_TOKEN: token } }),
      { code: "CATALOG_INVALID" });
  }
  assert.equal(EDIT_READ_PROCEDURES.length, 10);
  await assert.rejects(invokeEditAgent(catalog, original.id, { api: "http://127.0.0.1:1" }), { code: "INVALID_INPUT" });
});

test("a verified server cannot reflect a member credential into tool output", async (t) => {
  const f = await fixture(t, identity, { reflected: token });
  await assert.rejects(invokeEditAgent(catalog, "growth.video.gen.catalog", {},
    { env: { WORKLOOM_BASE_URL: f.api, WORKLOOM_ACCESS_TOKEN: token } }),
  (error) => ["STUDIO_RESPONSE_INVALID", "EDIT_AGENT_RESPONSE_CONTAINS_CREDENTIAL"].includes(error.code));
  assert.equal(editAgentError({ code: "SECRET_TOKEN_123456" }, { WORKLOOM_ACCESS_TOKEN: "SECRET_TOKEN_123456" }).error.code, "EDIT_AGENT_FAILED");
});

test("credential reflection checks decoded string leaves and keys even when JSON escapes them", async (t) => {
  const quoted = 'independent-synthetic-"-\\-secret-value';
  for (const name of ["OTHER_PROVIDER_API_KEY", "OTHER_PROVIDER_ACCESS_KEY", "DATABASE_URL", "REDIS_URL", "MONGODB_URI", "PGPASSWORD"]) {
    for (const result of [{ nested: [quoted] }, { [quoted]: true }, { encoded: JSON.stringify(quoted) }]) {
      const f = await fixture(t, identity, result);
      await assert.rejects(invokeEditAgent(catalog, "core.workspace.profile", {}, { env: {
        WORKLOOM_BASE_URL: f.api, WORKLOOM_ACCESS_TOKEN: token, [name]: quoted,
      } }), { code: "EDIT_AGENT_RESPONSE_CONTAINS_CREDENTIAL" });
    }
  }
});

test("instructions first 512 characters describe the complete authorized conversation flow", async () => {
  const initial = EDIT_AGENT_INSTRUCTIONS.slice(0, 512);
  for (const part of ["workbench_guide", "workflow_plan", "textGeneration=true", "mediaGeneration=true", "delivered=true", "jobId"]) {
    assert.ok(initial.includes(part), part);
  }
  const { out, server } = await serverHarness();
  assert.equal(out.messages[0].result.instructions, EDIT_AGENT_INSTRUCTIONS);
  await server.handle(request(2, "tools/list"));
  assert.ok(out.messages[1].result.tools.some((tool) => tool.name === "workloom_edit_video_workflow_start"));
  await server.handle(request(3, "tools/call", { name: "workloom_growth_service_inquiry_execute", arguments: {} }));
  assert.equal(out.messages[2].error.code, -32602);
});

test("MCP concurrent duplicate IDs and completed replays dispatch only once", async () => {
  let release, calls = 0;
  const gate = new Promise((done) => { release = done; });
  const { out, server } = await serverHarness(async () => { calls++; await gate; return { state: "pending", jobId: "original" }; });
  const call = request(2, "tools/call", { name: "workloom_edit_video_workflow_start", arguments: { idempotencyKey: "same-key" } });
  const original = server.handle(call);
  await server.handle(call); assert.equal(calls, 1);
  release(); await original;
  await server.handle(call); assert.equal(calls, 1);
  assert.equal(out.messages.filter((item) => item.id === 2).length, 2);
  await server.handle({ ...call, params: { ...call.params, arguments: { idempotencyKey: "changed" } } });
  assert.equal(calls, 1); assert.equal(out.messages.at(-1).error.code, -32600);
});

test("MCP cancellation suppresses waiting response and never repeats submitted work", async () => {
  let release, calls = 0;
  const gate = new Promise((done) => { release = done; });
  const { out, server } = await serverHarness(async () => { calls++; await gate; return { state: "pending" }; });
  const call = request("start", "tools/call", { name: "workloom_edit_video_workflow_start", arguments: {} });
  const pending = server.handle(call);
  await server.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: null });
  await server.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "unknown" } });
  await server.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "start", reason: token } });
  release(); await pending; await server.handle(call);
  assert.equal(calls, 1); assert.equal(out.messages.some((message) => message.id === "start"), false);
  assert.equal(JSON.stringify(out.messages).includes(token), false);
});

test("MCP response-cache eviction retains the dispatch guard", async () => {
  let calls = 0;
  const out = output(), server = createEditMcpServer({ catalog, output: out, responseCacheLimit: 1,
    invoke: async () => { calls++; return { state: "pending", jobId: "original" }; } });
  await server.handle(request(1, "initialize"));
  const call = request(2, "tools/call", { name: "workloom_edit_video_workflow_start", arguments: {} });
  await server.handle(call); await server.handle(call);
  assert.equal(calls, 1); assert.equal(out.messages.at(-1).error.code, -32600);
});

test("MCP rejects malformed arguments and request frames before invocation", async () => {
  let calls = 0;
  const { out, server } = await serverHarness(async () => { calls++; return {}; });
  for (const [i, value] of [null, [], 1, "bad"].entries()) {
    await server.handle(request(i + 2, "tools/call", { name: "workloom_edit_agent_doctor", arguments: value }));
    assert.equal(out.messages.at(-1).error.code, -32602);
  }
  await server.handle([]); await server.handle({ jsonrpc: "2.0", id: null, method: "ping" });
  assert.equal(calls, 0); assert.equal(out.messages.at(-1).error.code, -32600);
});

test("MCP line framing handles chunks, multiline input, invalid JSON and oversized resynchronization", async () => {
  const out = output(), server = createEditMcpServer({ catalog, output: out });
  const input = new PassThrough(); attachEditMcpInput(server, input);
  const init = JSON.stringify(request(1, "initialize", { protocolVersion: "2024-11-05" }));
  input.write(init.slice(0, 17)); input.write(init.slice(17) + "\ninvalid\n" + JSON.stringify(request(2, "ping")) + "\n");
  await setImmediate();
  assert.equal(out.messages.find((message) => message.id === 1).result.protocolVersion, "2024-11-05");
  assert.ok(out.messages.some((message) => message.error?.code === -32700));
  input.write("x".repeat(9 * 1024 * 1024 + 1));
  input.write("rest\n" + JSON.stringify(request(3, "ping")) + "\n");
  input.end("incomplete"); await setImmediate();
  assert.ok(out.messages.some((message) => message.id === 3 && message.result));
  assert.ok(out.messages.filter((message) => message.error?.code === -32700).length >= 3);
});

test("MCP preserves split UTF-8 characters and rejects malformed UTF-8 before dispatch", async () => {
  const seen = [];
  const { out, server } = await serverHarness(async (_catalog, _id, input) => { seen.push(input.intent); return { state: "plan" }; });
  const input = new PassThrough(); attachEditMcpInput(server, input);
  input.write(Buffer.concat([
    Buffer.from('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"workloom_edit_video_workflow_plan","arguments":{"intent":"'),
    Buffer.from([0xff]), Buffer.from('"}}}\n'),
  ]));
  await setImmediate();
  assert.deepEqual(seen, []);
  assert.ok(out.messages.some((message) => message.error?.code === -32700));
  const intent = "海边的17秒叙事短片🌊";
  const frame = Buffer.from(JSON.stringify(request(3, "tools/call", {
    name: "workloom_edit_video_workflow_plan", arguments: { intent },
  })) + "\n");
  const offset = frame.indexOf(Buffer.from("海")) + 1;
  input.write(frame.subarray(0, offset)); input.end(frame.subarray(offset));
  await setImmediate();
  assert.deepEqual(seen, [intent]);
  assert.equal(out.messages.find((message) => message.id === 3).result.isError, false);
});

test("tool failures expose only stable codes and never arbitrary upstream messages", async () => {
  const { out, server } = await serverHarness(async () => { const error = new Error(`secret ${token}`); error.code = "STUDIO_ACCESS_DENIED"; throw error; });
  await server.handle(request(2, "tools/call", { name: "workloom_edit_agent_doctor", arguments: {} }));
  assert.equal(out.messages.at(-1).result.isError, true);
  assert.equal(JSON.stringify(out.messages).includes(token), false);
  assert.deepEqual(editAgentError(new Error(token)), { error: { code: "EDIT_AGENT_FAILED", message: "EDIT_AGENT_FAILED" }, delivered: false });
});

test("real CLI and stdio MCP start under plain Node and preserve JSON-only stdout", async () => {
  const cli = await execute(process.execPath, ["scripts/edit-agent.mjs", "list"], { cwd: EDIT_AGENT_ROOT });
  assert.equal(JSON.parse(cli.stdout).productId, "workloom-ai-video-edit");
  const lines = [request(1, "initialize", { protocolVersion: "2025-11-25" }), request(2, "tools/list"),
    request(3, "tools/call", { name: "workloom_growth_video_workbench_guide", arguments: {} })];
  const child = await new Promise((done, reject) => {
    const proc = execFile(process.execPath, ["scripts/edit-agent-mcp.mjs"], { cwd: EDIT_AGENT_ROOT }, (error, stdout, stderr) => error ? reject(error) : done({ stdout, stderr }));
    proc.stdin.end(lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  });
  const messages = child.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(messages.length, 3);
  assert.equal(messages.find((message) => message.id === 3).result.isError, false);
  assert.equal(JSON.parse(messages.find((message) => message.id === 3).result.content[0].text).result.productId, "workloom-ai-video-edit");
  assert.ok(child.stderr.includes("stdio"));
});

test("real JSON-stdin CLI and MCP share the native read-only plan and authorization errors", async () => {
  const env = { ...process.env, WORKLOOM_ACCESS_TOKEN: "", WORKLOOM_DESKTOP_LOGIN_KEY: "", WORKLOOM_BASE_URL: "" };
  const input = { intent: "  为海边民宿做17秒叙事短片  ", brief: { platform: "douyin", aspectRatio: "9:16", duration: 17 } };
  const cli = await new Promise((done, reject) => {
    const child = execFile(process.execPath, ["scripts/edit-agent.mjs", "invoke", "edit.video.workflow.plan", "--input-file", "-"],
      { cwd: EDIT_AGENT_ROOT, env }, (error, stdout) => error ? reject(error) : done(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify(input));
  });
  assert.equal(cli.state, "plan"); assert.equal(cli.delivered, false);
  assert.equal(cli.input.intent, input.intent); assert.equal(cli.input.metadata.brief.duration, 17);
  const { out, server } = await serverHarness();
  await server.handle(request(2, "tools/call", { name: "workloom_edit_video_workflow_plan", arguments: input }));
  const mcp = JSON.parse(out.messages.at(-1).result.content[0].text);
  assert.deepEqual(mcp.input, cli.input);
  await server.handle(request(3, "tools/call", { name: "workloom_edit_video_workflow_start",
    arguments: { idempotencyKey: "no-auth-test", ...input, authorization: { textGeneration: false } } }));
  assert.equal(out.messages.at(-1).result.isError, true);
  assert.equal(JSON.parse(out.messages.at(-1).result.content[0].text).error.code, "EDIT_AUTHORIZATION_REQUIRED");
});
