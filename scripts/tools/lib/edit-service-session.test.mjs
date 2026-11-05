import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { withVerifiedEditService, withVerifiedEditReadService } from "./edit-service-session.mjs";

const token = "offline_fixture_member_token_not_a_credential";
const product = { schemaVersion: "workloom.service-product/v1", productId: "workloom-ai-video-edit",
  repository: "workloom-ai/WorkLoom-video-edit", sourceCommit: "a".repeat(40) };

async function fixture(t, manifest = product) {
  const calls = [];
  const sockets = new Map();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const url = new URL(request.url, "http://127.0.0.1");
    const socketId = sockets.get(request.socket) ?? sockets.size + 1;
    sockets.set(request.socket, socketId);
    calls.push({ path: url.pathname, method: request.method, token: request.headers.authorization,
      input: request.method === "POST" ? JSON.parse(Buffer.concat(chunks)) : url.searchParams.has("input") ? JSON.parse(url.searchParams.get("input")) : null,
      socketId });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(url.pathname === "/health/product" ? manifest : { result: { data: { fixture: true } } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { api: `http://127.0.0.1:${server.address().port}`, calls };
}

test("prompt repair inspection is GET and execution is POST on the same identity-verified local socket", async t => {
  const f = await fixture(t);
  const request = { projectId: "P1", expectedLatestAttempt: 48, planDigest: "b".repeat(64) };
  await withVerifiedEditService(f.api, token, async call => {
    assert.deepEqual(await call("video.studio.promptRepairPlan", { projectId: "P1" }), { fixture: true });
    assert.deepEqual(await call("video.studio.repairPrompts", request), { fixture: true });
  });
  assert.deepEqual(f.calls.map(call => [call.path, call.method]), [
    ["/health/product", "GET"], ["/trpc/video.studio.promptRepairPlan", "GET"], ["/trpc/video.studio.repairPrompts", "POST"],
  ]);
  assert.equal(f.calls[0].token, undefined);
  assert.equal(f.calls[1].token, `Bearer ${token}`);
  assert.equal(f.calls[2].token, `Bearer ${token}`);
  assert.deepEqual(f.calls[2].input, request);
  assert.equal(new Set(f.calls.map(call => call.socketId)).size, 1);
});

test("reading a repair plan never sends the execution mutation", async t => {
  const f = await fixture(t);
  await withVerifiedEditService(f.api, token, call => call("video.studio.promptRepairPlan", { projectId: "P1" }));
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.method === "GET"));
});

test("a product mismatch denies both new procedures before sending member credentials", async t => {
  const f = await fixture(t, { ...product, productId: "different-product" });
  await assert.rejects(withVerifiedEditService(f.api, token, call => call("video.studio.repairPrompts", {})), /STUDIO_PRODUCT_MISMATCH/u);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].token, undefined);
});

test("the repair extension grants no arbitrary mutation or rendering procedure", async t => {
  const f = await fixture(t);
  for (const procedure of ["video.render.submit", "video.production.qualifyShotReceipt", "approvals.decide", "video.studio.repairPrompts.untrusted"]) {
    await assert.rejects(withVerifiedEditService(f.api, token, call => call(procedure, {})), /STUDIO_PROCEDURE_INVALID/u);
  }
  assert.ok(f.calls.every(call => call.path === "/health/product" && call.token === undefined));
});

test("legacy Studio start remains POST and its existing status remains read-only", async t => {
  const f = await fixture(t);
  await withVerifiedEditService(f.api, token, async call => {
    await call("video.studio.start", { intent: "offline fixture" });
    await call("video.studio.status", { runId: "R1" });
  });
  assert.deepEqual(f.calls.map(call => call.method), ["GET", "POST", "GET"]);
});

test("trusted desktop bootstrap stays on the identity-verified socket and JWT exists only in the call closure", async t => {
  const key = "e".repeat(64), jwt = "offline-desktop-jwt-not-a-credential", calls = [], sockets = new Set();
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    sockets.add(request.socket);
    calls.push({ path: request.url, method: request.method, auth: request.headers.authorization,
      key: request.headers["x-workloom-desktop-key"], body: Buffer.concat(chunks).toString() });
    response.end(JSON.stringify(request.url === "/health/product" ? product : { result: { data:
      request.url === "/trpc/auth.desktopLogin" ? { token: jwt, identity: { workspaceId: "WS-native" } } : { workspaceId: "WS-native" } } }));
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
  const env = { WORKLOOM_DESKTOP_LOGIN_KEY: key }, before = { ...env };
  await withVerifiedEditReadService("http://127.0.0.1:" + server.address().port, undefined, async call => {
    const reads = await Promise.all([call("workspace.profile", {}), call("video.gen.catalog", {})]);
    assert.deepEqual(reads, [{ workspaceId: "WS-native" }, { workspaceId: "WS-native" }]);
    assert.throws(() => call("video.studio.start", {}), /STUDIO_PROCEDURE_INVALID/u);
  }, ["workspace.profile", "video.gen.catalog"], { env });
  assert.deepEqual(env, before); assert.equal(sockets.size, 1);
  assert.deepEqual(calls.map(call => [call.path, call.method]), [["/health/product", "GET"], ["/trpc/auth.desktopLogin", "POST"],
    ["/trpc/workspace.profile?input=%7B%7D", "GET"], ["/trpc/video.gen.catalog?input=%7B%7D", "GET"]]);
  assert.equal(calls[0].auth, undefined); assert.equal(calls[0].key, undefined);
  assert.equal(calls[1].auth, undefined); assert.equal(calls[1].key, key); assert.equal(calls[1].body, "{}");
  assert.ok(calls.slice(2).every(call => call.auth === "Bearer " + jwt && call.key === undefined));
});

test("untrusted product, absent bootstrap, arbitrary read procedure and reflected bearer are rejected", async t => {
  const mismatch = await fixture(t, { ...product, productId: "foreign" });
  await assert.rejects(withVerifiedEditService(mismatch.api, undefined, call => call("video.studio.start", {}), {
    env: { WORKLOOM_DESKTOP_LOGIN_KEY: "a".repeat(64) },
  }), /STUDIO_PRODUCT_MISMATCH/u);
  assert.equal(mismatch.calls.length, 1);
  const f = await fixture(t);
  await assert.rejects(withVerifiedEditService(f.api, undefined, call => call("video.studio.start", {}), { env: {} }), /MEMBER_TOKEN_REQUIRED/u);
  await assert.rejects(withVerifiedEditReadService(f.api, token, () => {}, ["auth.loginAs"]), /STUDIO_PROCEDURE_INVALID/u);
  await assert.rejects(withVerifiedEditReadService(f.api, token, call => call("video.production.qualifyShot", {}), ["workspace.profile"]), /STUDIO_PROCEDURE_INVALID/u);
  assert.ok(f.calls.every(call => call.path === "/health/product"));
  const reflecting = createServer((request, response) => response.end(JSON.stringify(request.url === "/health/product" ? product : { result: { data: { echoed: token } } })));
  await new Promise(done => reflecting.listen(0, "127.0.0.1", done));
  t.after(() => { reflecting.closeAllConnections(); return new Promise(done => reflecting.close(done)); });
  await assert.rejects(withVerifiedEditService("http://127.0.0.1:" + reflecting.address().port, token,
    call => call("video.studio.status", {})), /STUDIO_RESPONSE_INVALID/u);
});
