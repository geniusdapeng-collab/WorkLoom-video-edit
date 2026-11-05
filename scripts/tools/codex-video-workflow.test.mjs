import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const token = randomUUID();
const script = "scripts/tools/codex-video-workflow.mjs";
const intent = '  用 Codex 调用 Edit 做１７秒《产品演示》  ';
const normalStart = { kind: "routed", projectId: "VID-001", runId: "RUN-001", pipeline: "marketing" };
const editProduct = { schemaVersion: "workloom.service-product/v1", productId: "workloom-ai-video-edit", repository: "workloom-ai/WorkLoom-video-edit" };
const state = (status, extra = {}) => ({ ...normalStart, status, currentGate: null, pendingApprovalId: null, ...extra });
const stage = (overrides = {}) => ({ stageId: "preproduction", attempt: 1, status: "done", runId: "RUN-001",
  outputRef: "stages/preproduction/attempt-1.output.json", outputSha256: "d".repeat(64), ...overrides });
const archive = (stages) => ({ projectId: "VID-001", archiveExists: true, pendingApprovalId: null, stages });

async function cli(args, bearer = token, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  if (bearer === null) delete env.WORKLOOM_ACCESS_TOKEN;
  else env.WORKLOOM_ACCESS_TOKEN = bearer;
  let out;
  try { out = { ...await execute(process.execPath, ["--import", "tsx", script, ...args], { env, timeout: 45_000 }), code: 0 }; }
  catch (error) { out = { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
  assert.equal((out.stdout + out.stderr).includes(token), false, "bearer must never be printed");
  assert.ok(out.stdout || out.stderr, `CLI produced no receipt (exit ${out.code})`);
  return { code: out.code, body: JSON.parse(out.stdout || out.stderr) };
}

async function fixture(t, handlers = {}) {
  const root = mkdtempSync(join(tmpdir(), "edit-workflow-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const requests = [];
  const productRequests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/health/product") {
      productRequests.push({ method: req.method, hasAuthorization: req.headers.authorization !== undefined });
      const identity = handlers.product ? handlers.product(req, res) : editProduct;
      if (!res.writableEnded) res.end(JSON.stringify(identity));
      return;
    }
    const body = [];
    for await (const chunk of req) body.push(chunk);
    const input = req.method === "POST" ? JSON.parse(Buffer.concat(body).toString("utf8")) : JSON.parse(url.searchParams.get("input") ?? "null");
    requests.push({ path: url.pathname, method: req.method, input, auth: req.headers.authorization === `Bearer ${token}` });
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    const procedure = url.pathname.split(".").at(-1);
    const handler = handlers[procedure];
    if (!handler) { res.writeHead(404).end(); return; }
    const data = handler(req, res);
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result: { data } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((done) => { server.close(done); server.closeAllConnections(); }));
  const api = `http://127.0.0.1:${server.address().port}`, receipt = join(root, "studio.json");
  return { root, api, receipt, requests, productRequests, start: ["--intent", intent, "--execute", "--api", api, "--receipt", receipt],
    status: ["--status", "--receipt", receipt] };
}

test("one-line plan preserves raw text and uses the canonical duration and brief contract without HTTP", async (t) => {
  const f = await fixture(t);
  const briefPath = join(f.root, "brief.json");
  writeFileSync(briefPath, JSON.stringify({ duration: "17", product: "合成商品", brand: { name: "合成品牌" }, platform: "douyin" }));
  const result = await cli(["--intent", intent, "--brief", briefPath, "--api", f.api], null);
  assert.equal(result.code, 0);
  assert.equal(result.body.state, "plan");
  assert.deepEqual(result.body.input, { intent, route: "auto", metadata: { brief: { duration: 17, product: "合成商品", brand: { name: "合成品牌" }, platform: "douyin" } } });
  assert.equal(result.body.delivered, false);
  assert.equal((await cli(["--intent", "用 Codex 调用 Edit 做十七秒叙事短片"], null)).body.durationSeconds, 17);
  assert.equal((await cli(["--intent", "做半分钟短片"], null)).body.durationSeconds, 30);
  assert.deepEqual(f.requests, []);
  assert.equal(existsSync(f.receipt), false);
});

test("unsupported, out-of-range, ambiguous and conflicting duration or brief fail before dispatch", async (t) => {
  const f = await fixture(t), briefPath = join(f.root, "brief.json");
  writeFileSync(briefPath, JSON.stringify({ duration: 30 }));
  const cases = [
    [["--intent", "用 Codex 调用 Edit 做一个视频"], "DURATION_REQUIRED"],
    [["--intent", "做 17 秒或 30 秒"], "DURATION_AMBIGUOUS"],
    [["--intent", "做 17-30 秒"], "DURATION_AMBIGUOUS"],
    [["--intent", "做 1 分 30 秒"], "DURATION_AMBIGUOUS"],
    [["--intent", "做约十七秒短片"], "DURATION_AMBIGUOUS"],
    [["--intent", "做 3 秒"], "DURATION_INVALID"],
    [["--intent", "做 200 秒"], "DURATION_INVALID"],
    [["--intent", intent, "--brief", briefPath], "DURATION_CONFLICT"],
  ];
  await Promise.all(cases.map(async ([args, code]) => {
    const result = await cli([...args, "--execute", "--api", f.api, "--receipt", f.receipt]);
    assert.equal(result.code, 2); assert.equal(result.body.code, code);
  }));
  for (const brief of [{ duration: [] }, { product: 123 }, { approval: "yes" }, { brand: {} }, { productionRequirements: {} }]) {
    writeFileSync(briefPath, JSON.stringify(brief));
    const result = await cli([...f.start, "--brief", briefPath]);
    assert.equal(result.code, 2); assert.equal(result.body.code, "BRIEF_INVALID");
  }
  assert.deepEqual(f.requests, []);
  assert.equal(existsSync(f.receipt), false);
});

test("authorized start persists one private marker before POST and duplicates cannot dispatch", async (t) => {
  let f;
  f = await fixture(t, { start: () => {
    assert.equal(JSON.parse(readFileSync(f.receipt, "utf8")).state, "start_unknown");
    return normalStart;
  } });
  const results = await Promise.all([cli(f.start), cli(f.start)]);
  assert.equal(results.filter(x => x.body.state === "studio_started").length, 1);
  assert.equal(results.filter(x => x.body.code === "RECEIPT_EXISTS").length, 1);
  assert.deepEqual(f.requests, [{ path: "/trpc/video.studio.start", method: "POST", auth: true, input: { intent, route: "auto", metadata: { brief: { duration: 17 } } } }]);
  assert.equal(statSync(f.receipt).mode & 0o777, 0o600);
  const raw = readFileSync(f.receipt, "utf8"), receipt = JSON.parse(raw);
  assert.equal(receipt.runId, "RUN-001"); assert.equal(receipt.delivered, false);
  assert.equal(raw.includes(token) || raw.includes(intent), false);
});

test("explicit bearer, literal loopback, private directory and no receipt symlink are required", async (t) => {
  const f = await fixture(t, { start: () => normalStart });
  assert.equal((await cli(f.start, null)).body.code, "MEMBER_TOKEN_REQUIRED");
  assert.equal((await cli(["--intent", `做17秒视频 ${token}`])).body.code, "CREDENTIAL_IN_INPUT");
  for (const api of ["http://localhost:55555", "http://2130706433:55555", "https://127.0.0.1:55555", `${f.api}/other`]) {
    const args = f.start.map(arg => arg === f.api ? api : arg);
    assert.equal((await cli(args)).body.code, "API_NOT_LOOPBACK");
  }
  const shared = join(f.root, "shared"); mkdirSync(shared, { mode: 0o755 });
  assert.equal((await cli(f.start.map(arg => arg === f.receipt ? join(shared, "studio.json") : arg))).body.code, "RECEIPT_DIRECTORY_NOT_PRIVATE");
  const unrelated = join(f.root, "untouched"); writeFileSync(unrelated, "unrelated", { mode: 0o600 });
  symlinkSync(unrelated, f.receipt);
  assert.equal((await cli(f.start)).body.code, "RECEIPT_EXISTS");
  assert.equal((await cli(f.status)).body.code, "RECEIPT_INVALID");
  assert.equal(readFileSync(unrelated, "utf8"), "unrelated");
  assert.deepEqual(f.requests, []);
});

test("disconnect and HTTP redirects preserve an unknown marker and do not retry or follow", async (t) => {
  const uncertain = await fixture(t, { start: (req) => { req.socket.destroy(); } });
  const result = await cli(uncertain.start);
  assert.equal(result.code, 1); assert.equal(result.body.state, "start_unknown");
  assert.equal((await cli(uncertain.status)).body.state, "start_unknown");
  assert.equal(JSON.parse(readFileSync(uncertain.receipt, "utf8")).errorCode, "STUDIO_RESPONSE_UNKNOWN");
  assert.equal((await cli(uncertain.start)).body.code, "RECEIPT_EXISTS");
  assert.equal(uncertain.requests.length, 1);
  const target = await fixture(t, { start: () => normalStart });
  const redirect = await fixture(t, { start: (_req, res) => res.writeHead(307, { location: target.api + "/trpc/video.studio.start" }).end() });
  assert.equal((await cli(redirect.start)).body.state, "start_unknown");
  assert.deepEqual(target.requests, []);
});

test("the member bearer goes directly to the chosen loopback Studio, independent of proxy environment", async (t) => {
  const proxy = await fixture(t), f = await fixture(t, { start: () => normalStart });
  const result = await cli(f.start, token, { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: proxy.api, http_proxy: proxy.api, NO_PROXY: "", no_proxy: "" });
  assert.equal(result.body.state, "studio_started");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].auth, true);
  assert.deepEqual(proxy.requests, []);
  assert.deepEqual(proxy.productRequests, []);
  assert.deepEqual(f.productRequests, [{ method: "GET", hasAuthorization: false }]);
});

test("unverified or mismatched product cannot receive a member credential or Studio request", async (t) => {
  for (const [identity, code] of [
    [{ ...editProduct, productId: "workloom-ai-growth" }, "STUDIO_PRODUCT_MISMATCH"],
    [{ ...editProduct, repository: "geniusdapeng-collab/workloom-growthtest" }, "STUDIO_PRODUCT_MISMATCH"],
    [{ schemaVersion: editProduct.schemaVersion, productId: editProduct.productId }, "STUDIO_PRODUCT_UNVERIFIED"],
    [{ ok: true, service: "workloom-im-server" }, "STUDIO_PRODUCT_UNVERIFIED"],
  ]) {
    const f = await fixture(t, { product: () => identity, start: () => normalStart });
    assert.deepEqual((await cli(f.start)).body, { code, delivered: false });
    assert.deepEqual(f.productRequests, [{ method: "GET", hasAuthorization: false }]);
    assert.deepEqual(f.requests, []);
    assert.equal(existsSync(f.receipt), false);
  }
});

test("closing the verified socket cannot send the credential on a new connection to the same port", async (t) => {
  const f = await fixture(t, { product: (_req, res) => {
    res.setHeader("connection", "close");
    return editProduct;
  }, start: () => normalStart });
  const result = await cli(f.start);
  assert.equal(result.body.errorCode, "STUDIO_CONNECTION_CHANGED");
  assert.deepEqual(f.productRequests, [{ method: "GET", hasAuthorization: false }]);
  assert.deepEqual(f.requests, []);
});

test("official status and latest same-run archive distinguish approval, stale, failed and preproduction archived", async (t) => {
  let current = state("running"), currentArchive = archive([stage()]);
  const f = await fixture(t, { start: () => normalStart, status: () => current, archive: () => currentArchive });
  assert.equal((await cli(f.start)).body.state, "studio_started");
  assert.equal((await cli(f.status)).body.state, "preproduction_running");
  current = state("awaiting_approval", { currentGate: "G7_FINAL", pendingApprovalId: "APP-001" });
  const awaiting = (await cli(f.status)).body;
  assert.equal(awaiting.state, "awaiting_approval"); assert.equal(awaiting.pendingApprovalId, "APP-001");
  current = state("failed", { error: `private failure ${token}` });
  const reflected = (await cli(f.status)).body;
  assert.equal(reflected.state, "status_unavailable"); assert.equal(reflected.errorCode, "STUDIO_RESPONSE_INVALID");
  current = state("failed", { error: "private failure without credentials" });
  const failed = (await cli(f.status)).body;
  assert.equal(failed.studioStatus, "failed"); assert.equal(failed.errorPresent, true);
  current = state("finished"); currentArchive = archive([stage(), stage({ attempt: 2, runId: "RUN-OTHER" })]);
  assert.equal((await cli(f.status)).body.state, "preproduction_source_unverified");
  currentArchive = archive([stage({ outputRef: "stages/preproduction/attempt-2.output.json" })]);
  assert.equal((await cli(f.status)).body.state, "preproduction_source_unverified");
  currentArchive = archive([stage()]);
  const finished = (await cli(f.status)).body;
  assert.equal(finished.state, "preproduction_archived"); assert.equal(finished.delivered, false);
  assert.deepEqual(finished.source, { attempt: 1, outputRef: "stages/preproduction/attempt-1.output.json", outputSha256: "d".repeat(64) });
  assert.equal(finished.next[0], "video.production.shots");
  current = state("finished", { runId: "DIFFERENT-RUN" });
  const mismatch = (await cli(f.status)).body;
  assert.equal(mismatch.state, "status_unavailable");
  assert.equal(mismatch.errorCode, "STUDIO_STATUS_MISMATCH");
  assert.equal(mismatch.next[0], "video.studio.archive");
  assert.equal((await cli([...f.status, "--api", "http://127.0.0.1:50000"])).body.code, "RECEIPT_API_MISMATCH");
  assert.deepEqual(f.requests.map(({ path, method }) => [path, method]), [
    ["/trpc/video.studio.start", "POST"], ["/trpc/video.studio.status", "GET"], ["/trpc/video.studio.status", "GET"],
    ["/trpc/video.studio.status", "GET"], ["/trpc/video.studio.status", "GET"], ["/trpc/video.studio.status", "GET"], ["/trpc/video.studio.archive", "GET"],
    ["/trpc/video.studio.status", "GET"], ["/trpc/video.studio.archive", "GET"],
    ["/trpc/video.studio.status", "GET"], ["/trpc/video.studio.archive", "GET"],
    ["/trpc/video.studio.status", "GET"],
  ]);
});

test("official clarify and explainer results keep their own next actions and stay incomplete", async (t) => {
  for (const start of [{ kind: "clarify", missing: ["product"] }, { kind: "routed", projectId: "VID-E1", runId: null, pipeline: "explainer", shotbookId: "SB-1" }]) {
    const f = await fixture(t, { start: () => start });
    const expected = start.kind === "clarify" ? "clarify" : "explainer_handoff";
    const launch = (await cli(f.start)).body;
    assert.equal(launch.state, expected); assert.equal(launch.delivered, false);
    assert.equal((await cli(f.status, null)).body.state, expected);
    assert.equal(f.requests.length, 1);
  }
});

test("a provider-shaped identifier cannot persist or echo the configured bearer", async (t) => {
  const f = await fixture(t, { start: () => ({ ...normalStart, runId: token }) });
  const result = await cli(f.start);
  assert.equal(result.body.state, "start_unknown");
  assert.equal(result.body.errorCode, "STUDIO_RESPONSE_INVALID");
  assert.equal(readFileSync(f.receipt, "utf8").includes(token), false);
  assert.equal(f.requests.length, 1);
});

test("the existing CLI continues only from the original receipt and preserves pending approval", async (t) => {
  const f = await fixture(t, { start: () => normalStart,
    status: () => state("awaiting_approval", { currentGate: "G7_FINAL", pendingApprovalId: "APR-1" }) });
  assert.equal((await cli(f.start)).body.state, "studio_started");
  const args = ["--continue", "--receipt", f.receipt];
  const invalid = await cli([...args, "--shots", join(f.root, "manual.json")]);
  assert.equal(invalid.body.code, "ARGUMENTS_INVALID");
  const pending = await cli(args);
  assert.equal(pending.body.state, "awaiting_approval");
  assert.equal(pending.body.delivered, false);
  assert.equal(pending.body.pendingApprovalId, "APR-1");
  assert.deepEqual(f.requests.map(({ path, method }) => [path, method]), [
    ["/trpc/video.studio.start", "POST"], ["/trpc/video.studio.status", "GET"],
  ]);
  assert.equal(existsSync(join(f.root, "film-continuation.json")), false);
});

test("an existing unknown Film receipt is read by the same CLI without a service token or another dispatch", async (t) => {
  const f = await fixture(t, { start: () => normalStart });
  assert.equal((await cli(f.start)).body.state, "studio_started");
  const original = JSON.parse(readFileSync(f.receipt, "utf8"));
  writeFileSync(join(f.root, "film-continuation.json"), JSON.stringify({ schemaVersion: "workloom.codex-video-film-continuation/v1",
    projectId: original.projectId, runId: original.runId, requestSha256: original.requestSha256,
    shotlistSha256: "a".repeat(64), sourceCommit: "b".repeat(40), outDir: "delivery",
    targetDuration: 17, frameRate: 30, durationToleranceFrames: null }), { mode: 0o600 });
  for (const mode of ["--status", "--continue"]) {
    const readback = await cli([mode, "--receipt", f.receipt], null);
    assert.equal(readback.code, 1);
    assert.equal(readback.body.state, "film_dispatch_unknown");
    assert.equal(readback.body.delivered, false);
    assert.equal(readback.body.shotlistSha256, "a".repeat(64));
  }
  assert.equal(f.requests.length, 1);
  assert.equal(f.productRequests.length, 1);
});

// The production script test entry already imports this file; exercise the reviewed async bridge there too.
import "./edit-agent-workflow.test.mjs";
