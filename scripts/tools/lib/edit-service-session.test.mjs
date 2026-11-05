import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { withVerifiedEditService } from "./edit-service-session.mjs";

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
