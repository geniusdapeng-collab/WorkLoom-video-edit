import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const base = dirname(fileURLToPath(import.meta.url));
const repoFlag = process.argv.indexOf("--repo");
if (repoFlag < 0 || !process.argv[repoFlag + 1] || process.argv[repoFlag + 1].startsWith("--")) throw new Error("--repo requires an explicit source checkout");
const repo = resolve(process.argv[repoFlag + 1]);
for (const name of ["DATABASE_URL", "DATABASE_APP_URL", "DATABASE_GATEWAY_URL"]) {
  const url = new URL(process.env[name]);
  assert.equal(url.pathname, "/growth_audit"); assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
}
const fixture = JSON.parse(await readFile(join(base, "auth-nonexample-input.json"), "utf8"));
const capability = randomBytes(32).toString("hex");
const secret = randomBytes(48).toString("hex");
const issuer = JSON.parse(await readFile(join(repo, "product.manifest.json"), "utf8")).productId;
const childEnv = { ...process.env, NODE_ENV: "production", SERVER_HOST: "127.0.0.1", SERVER_PORT: "28878", JWT_SECRET: secret,
  SERVICE_C_SECRET: randomBytes(32).toString("hex"), LLM_PROVIDER: "mock", SCHEDULER_ENABLED: "0", PORTRAIT_AGENT_ENABLED: "0", HR_PORTRAIT_ENABLED: "0", HR_PORTRAIT_AUTO_ENABLED: "0",
  WORKLOOM_DESKTOP_LOGIN_KEY: capability, WORKLOOM_DESKTOP_WORKSPACE: fixture.workspaceSlug, WORKLOOM_DESKTOP_MEMBER: fixture.memberNo };
for (const key of Object.keys(childEnv)) if (/(?:API_KEY|KEY_SECRET|SIGNING_SECRET|CNB_TOKEN)/u.test(key)) delete childEnv[key];
let log = "";
const child = spawn(process.execPath, ["--env-file=.env", "--import", "tsx", "apps/server/src/index.ts"], { cwd: repo, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (chunk) => { log = (log + chunk).slice(-16000); });
child.stderr.on("data", (chunk) => { log = (log + chunk).slice(-16000); });
const url = "http://127.0.0.1:28878";
const checks = [];
const request = (path, body, headers = {}) => fetch(url + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
const record = (name, healthy, actual) => checks.push({ name, healthy, actual });
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("Fixture server exited before readiness");
    try { ready = (await request("/health")).ok; } catch { ready = false; }
    if (ready) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(ready, "Fixture server failed to become ready");
  const demo = await request("/trpc/auth.loginAs", { workspaceSlug: fixture.workspaceSlug, memberNo: fixture.memberNo });
  record("Anonymous production owner impersonation denied on non-example real-mode fixture", demo.status === 403, { http: demo.status });
  const anonymous = await request("/trpc/access.me");
  record("Protected API rejects anonymous requests", anonymous.status === 401, { http: anonymous.status });
  for (const key of ["", "0".repeat(64)]) {
    const response = await request("/trpc/auth.desktopLogin", {}, { "x-workloom-desktop-key": key });
    record(key ? "Wrong desktop capability rejected" : "Desktop capability is mandatory", response.status === 401, { http: response.status });
  }
  const valid = await request("/trpc/auth.desktopLogin", { workspaceSlug: "cannot-select-other-workspace", memberNo: "cannot-select-other-member" }, { "x-workloom-desktop-key": capability });
  const value = await valid.json();
  const session = value.result?.data;
  assert.equal(typeof session?.token, "string", "Trusted local login did not return a session");
  record("Trusted local capability signs only the configured identity", valid.status === 200 && session.identity.workspaceId === fixture.workspaceId && session.identity.memberNo === fixture.memberNo,
    { http: valid.status, targetMatches: session.identity.workspaceId === fixture.workspaceId });
  const accepted = await request("/trpc/access.me", undefined, { authorization: `Bearer ${session.token}` });
  record("Trusted local session can access the real protected API", accepted.status === 200, { http: accepted.status });
  const require = createRequire(join(repo, "packages/base/package.json"));
  const { SignJWT } = await import(pathToFileURL(require.resolve("jose")).href);
  const key = new TextEncoder().encode(secret);
  const payload = { ...session.identity, kind: "member" };
  const badTokens = [
    ["Unsupported JWT algorithm", new SignJWT(payload).setProtectedHeader({ alg: "HS384" }).setIssuer(issuer).setIssuedAt().setExpirationTime("1h")],
    ["JWT without expiration", new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setIssuer(issuer).setIssuedAt()],
    ["JWT without issue time", new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setIssuer(issuer).setExpirationTime("1h")],
    ["Expired JWT", new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setIssuer(issuer).setIssuedAt(1).setExpirationTime(2)],
    ["Wrong product issuer", new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setIssuer("another-product").setIssuedAt().setExpirationTime("1h")],
  ];
  for (const [name, signer] of badTokens) {
    const token = await signer.sign(key);
    const response = await request("/trpc/access.me", undefined, { authorization: `Bearer ${token}` });
    record(name + " denied", response.status === 401, { http: response.status });
  }
} finally {
  const exit = new Promise((done) => child.once("exit", done));
  if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([exit, new Promise((done) => setTimeout(done, 5000))]); }
  if (child.exitCode === null) { child.kill("SIGKILL"); await exit; }
  delete childEnv.WORKLOOM_DESKTOP_LOGIN_KEY; delete childEnv.JWT_SECRET;
}
const result = { passed: checks.every((entry) => entry.healthy), environment: "isolated loopback production HTTP, fake non-example business data, no provider calls", checks };
await writeFile(join(base, "auth-production-http-results.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (!result.passed) process.exitCode = 1;
