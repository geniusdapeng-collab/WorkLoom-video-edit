/** Direct transport for native Edit services. Credentials stay on the verified connection. */
import { Agent, request as requestHttp } from "node:http";

const PRODUCT = "workloom-ai-video-edit";
const REPOSITORY = "workloom-ai/WorkLoom-video-edit";
const START = "video.studio.start";
const WRITE_PROCEDURES = new Set([START, "video.studio.repairPrompts"]);
const READ_PROCEDURES = new Set(["video.gen.catalog", "video.studio.status", "video.studio.archive", "video.production.shots", "video.studio.promptRepairPlan"]);
const HTTP_TIMEOUT_MS = 30_000;
const MAX_RESPONSE = 8 * 1024 * 1024;
const LOGIN = "auth.desktopLogin";
const REVIEWED_AGENT_QUERIES = new Set(["workspace.profile", "workspace.agents", "threads.list", "threads.get", "threads.events",
  "approvals.list", "inspection.status", "skills.list", "video.gen.catalog", "video.production.shots"]);

export class WorkflowError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function check(condition, code) { if (!condition) throw new WorkflowError(code); }
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

export function parseEditLoopbackApi(value) {
  let url;
  try { url = new URL(value); } catch { throw new WorkflowError("API_NOT_LOOPBACK"); }
  check(url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port
    && (value === url.origin || value === `${url.origin}/`), "API_NOT_LOOPBACK");
  return url.origin;
}

async function requestStudio(api, agent, procedure, input, authorization) {
  const post = WRITE_PROCEDURES.has(procedure) || procedure === LOGIN;
  const url = new URL(procedure ? `/trpc/${procedure}` : "/health/product", api);
  const headers = { accept: "application/json" };
  const payload = post ? Buffer.from(JSON.stringify(input)) : undefined;
  if (payload) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(payload.length);
  }
  else if (procedure) url.searchParams.set("input", JSON.stringify(input));
  try {
    const response = await new Promise((resolve, reject) => {
      // Only the socket that returned the product manifest can carry member credentials.
      const req = requestHttp(url, { method: post ? "POST" : "GET", headers, agent,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) }, resolve);
      req.once("error", reject);
      if (!authorization) req.end();
      else req.once("socket", socket => {
        if (socket !== authorization.socket) {
          req.destroy(new WorkflowError("STUDIO_CONNECTION_CHANGED"));
          return;
        }
        if (authorization.desktopKey) req.setHeader("x-workloom-desktop-key", authorization.desktopKey);
        else req.setHeader("authorization", `Bearer ${authorization.token}`);
        req.end(payload);
      });
    });
    const socket = response.socket;
    if (!(response.statusCode >= 200 && response.statusCode < 300)) {
      response.destroy();
      throw new WorkflowError([401, 403].includes(response.statusCode) ? "STUDIO_ACCESS_DENIED" : "STUDIO_RESPONSE_REJECTED");
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      check(size <= (procedure ? MAX_RESPONSE : 4_096), "STUDIO_RESPONSE_TOO_LARGE");
      chunks.push(chunk);
    }
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
    if (!procedure) return { body, socket };
    check(object(body?.result) && !body.error && Object.hasOwn(body.result, "data"), "STUDIO_RESPONSE_INVALID");
    return body.result.data;
  } catch (error) { throw error instanceof WorkflowError ? error : new WorkflowError("STUDIO_RESPONSE_UNKNOWN"); }
}

export async function withVerifiedEditService(api, token, work, { env = process.env, readProcedures = [] } = {}) {
  check(Array.isArray(readProcedures) && readProcedures.every(path => REVIEWED_AGENT_QUERIES.has(path)), "STUDIO_PROCEDURE_INVALID");
  const origin = parseEditLoopbackApi(api);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    let verified;
    try { verified = await requestStudio(origin, agent); }
    catch { throw new WorkflowError("STUDIO_PRODUCT_UNVERIFIED"); }
    const { body, socket } = verified;
    check(object(body) && body.schemaVersion === "workloom.service-product/v1" && socket
      && typeof body.productId === "string" && body.productId.trim()
      && typeof body.repository === "string" && body.repository.trim(), "STUDIO_PRODUCT_UNVERIFIED");
    check(body.productId === PRODUCT && body.repository === REPOSITORY, "STUDIO_PRODUCT_MISMATCH");
    let member = token;
    let bootstrap;
    const ensureMember = async () => {
      if (member) {
        check(typeof member === "string" && /^[A-Za-z0-9._~+\/=-]{16,8192}$/.test(member), "MEMBER_TOKEN_REQUIRED");
        return member;
      }
      if (!bootstrap) bootstrap = (async () => {
        const key = env.WORKLOOM_DESKTOP_LOGIN_KEY;
        check(typeof key === "string" && /^[a-f0-9]{64}$/.test(key), "MEMBER_TOKEN_REQUIRED");
        const login = await requestStudio(origin, agent, LOGIN, {}, { desktopKey: key, socket });
        check(typeof login?.token === "string" && /^[A-Za-z0-9._~+\/=-]{16,8192}$/.test(login.token), "DESKTOP_LOGIN_FAILED");
        member = login.token;
        return member;
      })();
      return bootstrap;
    };
    return await work((procedure, input) => {
      check(WRITE_PROCEDURES.has(procedure) || READ_PROCEDURES.has(procedure) || readProcedures.includes(procedure), "STUDIO_PROCEDURE_INVALID");
      return ensureMember().then(async value => {
        const result = await requestStudio(origin, agent, procedure, input, { token: value, socket });
        const serialized = JSON.stringify(result);
        check(!serialized.includes(value) && (!env.WORKLOOM_DESKTOP_LOGIN_KEY
          || !serialized.includes(env.WORKLOOM_DESKTOP_LOGIN_KEY)), "STUDIO_RESPONSE_INVALID");
        return result;
      });
    }, { sourceCommit: body.sourceCommit, videoStudio: body.videoStudio });
  } finally { agent.destroy(); }
}

/** Product-owned read-only bridge. Its caller supplies only the reviewed catalog paths. */
export async function withVerifiedEditReadService(api, token, work, allowedProcedures, { env = process.env } = {}) {
  check(Array.isArray(allowedProcedures) && allowedProcedures.length > 0
    && allowedProcedures.every(path => REVIEWED_AGENT_QUERIES.has(path)), "STUDIO_PROCEDURE_INVALID");
  return withVerifiedEditService(api, token, call => work((procedure, input) => {
    check(allowedProcedures.includes(procedure), "STUDIO_PROCEDURE_INVALID");
    return call(procedure, input);
  }), { env, readProcedures: allowedProcedures });
}
