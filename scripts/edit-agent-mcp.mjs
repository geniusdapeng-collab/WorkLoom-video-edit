#!/usr/bin/env node
/** Product-owned Edit stdio MCP. stdout is exclusively newline-delimited JSON-RPC. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { toolName } from "./agent-capabilities.mjs";
import { EDIT_AGENT_ROOT, editAgentError, editAgentTools, invokeEditAgent, loadEditAgentCatalog } from "./tools/lib/edit-agent-catalog.mjs";

const MAX_FRAME_BYTES = 9 * 1024 * 1024;
const MAX_REQUEST_IDS = 4096;
const MAX_RESPONSE_CACHE_BYTES = 32 * 1024 * 1024;
const SUPPORTED_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
export const EDIT_AGENT_INSTRUCTIONS = "WorkLoom Video Edit：先调用 workloom_growth_video_workbench_guide，再用 workloom_edit_agent_doctor 分清接入、认证与生产授权；workloom_edit_video_workflow_plan 保留原话与完整 Brief，不替用户添加分镜约束。明确文本授权后 start 才可传 authorization.textGeneration=true；同一请求沿用 idempotencyKey 和 jobId。先查 status，明确媒体授权后才 continue 并传 authorization.mediaGeneration=true。待审、启动未知、前期归档和执行中均未交付；只有 status 回读当前媒体质检且 delivered=true 才能报告完成。取消等待不撤销已提交作业，沿原 jobId 查询，禁止换键重提。服务、私有目录与凭据只由操作者环境配置，工具输入不得放 API、路径或密钥。";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (value) => typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value);

export function createEditMcpServer({ catalog, invoke = invokeEditAgent, output = process.stdout, env = process.env,
  responseCacheLimit = MAX_RESPONSE_CACHE_BYTES }) {
  const tools = editAgentTools(catalog);
  const byName = new Map([...catalog.entries.values()].filter((item) => item.enabled !== false)
    .map((item) => [toolName(item), item]));
  const requests = new Map();
  const cachedResponses = [];
  let cachedBytes = 0;
  let initialized = false;
  const send = (payload) => output.write(JSON.stringify(payload) + "\n");
  const failure = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

  async function handle(request) {
    if (!object(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string"
        || request.params !== undefined && !object(request.params)) {
      // Malformed notifications (including cancellation) are fire-and-forget.
      if (object(request) && request.jsonrpc === "2.0" && typeof request.method === "string" && request.id === undefined) return;
      failure(validId(request?.id) ? request.id : null, -32600, "invalid request"); return;
    }
    const { id, method, params } = request;
    if (id === undefined) {
      if (method === "notifications/cancelled" && validId(params?.requestId)) {
        const pending = requests.get(JSON.stringify([typeof params.requestId, params.requestId]));
        // Submitted work is durable and cannot be safely undone by cancelling a transport wait.
        if (pending && pending.method !== "initialize" && !pending.completed) pending.cancelled = true;
      }
      return;
    }
    if (!validId(id)) { failure(null, -32600, "invalid request id"); return; }
    const key = JSON.stringify([typeof id, id]);
    const signature = createHash("sha256").update(JSON.stringify({ method, params })).digest("hex");
    const previous = requests.get(key);
    if (previous) {
      if (previous.signature !== signature) failure(id, -32600, "request id already used");
      else if (previous.completed && !previous.cancelled) {
        if (previous.serialized) output.write(previous.serialized + "\n");
        else failure(id, -32600, "request already completed; query the original job");
      }
      return;
    }
    if (requests.size >= MAX_REQUEST_IDS) { failure(id, -32000, "session request limit reached; reconnect and query the original job"); return; }
    const row = { signature, method, completed: false, cancelled: false };
    requests.set(key, row);
    const reply = (result) => { row.response = { jsonrpc: "2.0", id, result }; };
    const reject = (code, message) => { row.response = { jsonrpc: "2.0", id, error: { code, message } }; };
    try {
      if (method === "initialize") {
        if (initialized) reject(-32600, "already initialized");
        else {
          initialized = true;
          reply({ protocolVersion: SUPPORTED_VERSIONS.has(params?.protocolVersion) ? params.protocolVersion : "2025-11-25",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "workloom-edit-agent", version: "1.0.0" }, instructions: EDIT_AGENT_INSTRUCTIONS });
        }
      } else if (!initialized && method !== "ping") reject(-32000, "initialize first");
      else if (method === "ping") reply({});
      else if (method === "tools/list") {
        if (params?.cursor !== undefined) reject(-32602, "pagination cursor is not supported");
        else reply({ tools });
      } else if (method === "tools/call") {
        const descriptor = byName.get(params?.name);
        if (!descriptor) reject(-32602, "unknown tool");
        else if (params.arguments !== undefined && !object(params.arguments)) reject(-32602, "tool arguments must be an object");
        else {
          try {
            const result = await invoke(catalog, descriptor.id, params?.arguments ?? {}, { env });
            reply({ content: [{ type: "text", text: JSON.stringify(result) }], isError: false });
          } catch (error) {
            reply({ content: [{ type: "text", text: JSON.stringify(editAgentError(error, env)) }], isError: true });
          }
        }
      } else reject(-32601, "method not found");
    } catch (error) {
      reject(-32000, editAgentError(error, env).error.code);
    }
    row.completed = true;
    if (!row.cancelled) {
      const serialized = JSON.stringify(row.response);
      output.write(serialized + "\n");
      const bytes = Buffer.byteLength(serialized);
      if (bytes <= responseCacheLimit) {
        row.serialized = serialized; row.bytes = bytes;
        cachedResponses.push(row); cachedBytes += bytes;
        while (cachedBytes > responseCacheLimit) {
          const oldest = cachedResponses.shift(); cachedBytes -= oldest.bytes; delete oldest.serialized;
        }
      }
    }
    delete row.response;
  }
  return { handle, parseError: (message = "parse error") => failure(null, -32700, message) };
}

export function attachEditMcpInput(server, input = process.stdin) {
  let buffer = Buffer.alloc(0), dropping = false;
  input.on("data", (value) => {
    let chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (dropping) {
      const end = chunk.indexOf(10);
      if (end < 0) return;
      chunk = chunk.subarray(end + 1); dropping = false;
    }
    buffer = Buffer.concat([buffer, chunk]);
    let newline;
    while ((newline = buffer.indexOf(10)) >= 0) {
      const bytes = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
      if (bytes.length > MAX_FRAME_BYTES) { server.parseError("frame too large"); continue; }
      try {
        const line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (!line.trim()) continue;
        void server.handle(JSON.parse(line)).catch(() => server.parseError("request failed"));
      }
      catch { server.parseError(); }
    }
    if (buffer.length > MAX_FRAME_BYTES) {
      buffer = Buffer.alloc(0); dropping = true; server.parseError("frame too large");
    }
  });
  input.on("end", () => { if (buffer.toString("utf8").trim() && !dropping) server.parseError("incomplete JSON-RPC frame"); });
  input.on("error", () => { process.exitCode = 2; });
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const catalog = await loadEditAgentCatalog(process.env.WORKLOOM_PRODUCT_ROOT ?? EDIT_AGENT_ROOT);
    attachEditMcpInput(createEditMcpServer({ catalog }));
    process.stderr.write("WorkLoom Edit agent MCP ready (stdio)\n");
  } catch (error) {
    process.stderr.write(JSON.stringify(editAgentError(error)) + "\n"); process.exitCode = 2;
  }
}
