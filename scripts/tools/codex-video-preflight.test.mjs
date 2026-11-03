import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { checkLoopbackHealth, parsePreflightArgs } from "./codex-video-preflight.mjs";

test("only an explicit, literal loopback API origin is allowed", () => {
  assert.deepEqual(parsePreflightArgs([]), {});
  assert.deepEqual(parsePreflightArgs(["--api", "http://127.0.0.1:58791/"]), { api: "http://127.0.0.1:58791" });
  for (const url of ["https://127.0.0.1:58791", "http://localhost:58791", "http://127.0.0.1:58791/path",
    "http://127.0.0.1:58791?query", "http://u:p@127.0.0.1:58791", "http://127.0.0.1",
    "http://2130706433:58791", "http://external.test:58791"]) {
    assert.throws(() => parsePreflightArgs(["--api", url]), { message: "API_NOT_LOOPBACK" });
  }
  assert.throws(() => parsePreflightArgs(["--api"]), { message: "INVALID_ARGUMENTS" });
});

test("health is read-only and never follows a redirect", async (t) => {
  const requests = [];
  let mode = "ok";
  const server = createServer((req, res) => {
    requests.push([req.method, req.url]);
    if (mode === "redirect") { res.writeHead(302, { Location: "/not-health" }); res.end(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, service: mode === "ok" ? "workloom-im-server" : "other" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise((done) => server.close(done)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await checkLoopbackHealth(origin), "responded");
  mode = "mismatch";
  assert.equal(await checkLoopbackHealth(origin), "unverified");
  mode = "redirect";
  assert.equal(await checkLoopbackHealth(origin), "unavailable");
  assert.deepEqual(requests, Array.from({ length: 3 }, () => ["GET", "/health"]));
});
