/** Product-owned transport: reviewed read capabilities plus the native Edit workflow. */
import { resolve } from "node:path";
import { CapabilityError, invokeCapability, loadCatalog, toolName, validateInput } from "../../agent-capabilities.mjs";
import { EDIT_WORKFLOW_CAPABILITIES, invokeEditWorkflow } from "./edit-agent-workflow.mjs";
import { withVerifiedEditReadService } from "./edit-service-session.mjs";

export const EDIT_AGENT_ROOT = resolve(import.meta.dirname, "../../..");
export const EDIT_READ_PROCEDURES = Object.freeze([
  "workspace.profile", "workspace.agents", "threads.list", "threads.get", "threads.events",
  "approvals.list", "inspection.status", "skills.list", "video.gen.catalog", "video.production.shots",
]);
const readProcedures = new Set(EDIT_READ_PROCEDURES);
const nativeIds = new Set(EDIT_WORKFLOW_CAPABILITIES.map(({ id }) => id));
const readOperations = new Set(["read", "preview", "receipt"]);
const dataModes = new Set(["real", "simulated", "provided-unverified", "unverified"]);
const secretValues = (env) => Object.entries(env).filter(([key, value]) =>
  (/(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|LOGIN[_-]?KEY|CREDENTIAL)(?:$|_)/iu.test(key)
    || /^(?:DATABASE_URL|REDIS_URL|MONGODB_URI|PGPASSWORD)$/u.test(key))
    && typeof value === "string" && value.length > 0).map(([, value]) => value);

function safeOutput(value, env) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new CapabilityError("EDIT_AGENT_RESPONSE_TOO_LARGE", "响应超过上限", 2);
  const secrets = secretValues(env);
  const containsCredential = (item) => {
    if (typeof item === "string") return secrets.some((secret) => item.includes(secret)
      || item.includes(JSON.stringify(secret).slice(1, -1)));
    if (Array.isArray(item)) return item.some(containsCredential);
    if (item !== null && typeof item === "object") {
      return Object.entries(item).some(([key, child]) => containsCredential(key) || containsCredential(child));
    }
    return false;
  };
  if (secrets.some((secret) => text.includes(secret)) || containsCredential(value)) {
    throw new CapabilityError("EDIT_AGENT_RESPONSE_CONTAINS_CREDENTIAL", "响应包含凭据", 2);
  }
  return value;
}

export async function loadEditAgentCatalog(root = EDIT_AGENT_ROOT) {
  const catalog = await loadCatalog(resolve(root));
  if (catalog.product.productId !== "workloom-ai-video-edit"
      || catalog.product.repository !== "workloom-ai/WorkLoom-video-edit" || catalog.bundle !== "geo-growth") {
    throw new CapabilityError("EDIT_PRODUCT_MISMATCH", "当前入口仅支持 WorkLoom Video Edit", 2);
  }
  const entries = new Map();
  for (const [id, descriptor] of catalog.entries) {
    // This adapter does not expose legacy mutations, including any enabled in a later catalog.
    const item = readOperations.has(descriptor.operation) ? descriptor : Object.freeze({ ...descriptor,
      enabled: false, disabledReason: descriptor.disabledReason ?? "此入口仅开放旧只读能力与原生 Edit workflow" });
    entries.set(id, item);
  }
  for (const descriptor of EDIT_WORKFLOW_CAPABILITIES) {
    if (entries.has(descriptor.id)) throw new CapabilityError("CATALOG_INVALID", "产品能力 ID 重复", 2);
    entries.set(descriptor.id, descriptor);
  }
  const names = [...entries.values()].filter((item) => item.enabled !== false).map(toolName);
  if (new Set(names).size !== names.length) throw new CapabilityError("CATALOG_INVALID", "MCP 工具名称重复", 2);
  return { ...catalog, entries };
}

export function editAgentTools(catalog) {
  return [...catalog.entries.values()].filter((item) => item.enabled !== false).map((item) => ({
    name: toolName(item), title: item.title,
    description: item.description + "（" + item.dataMode + "；" + item.risk + "）",
    inputSchema: item.inputSchema,
    annotations: { title: item.title, readOnlyHint: item.operation !== "execute",
      destructiveHint: nativeIds.has(item.id) ? false : item.operation === "execute" && item.risk === "review",
      idempotentHint: nativeIds.has(item.id) || item.operation !== "execute",
      openWorldHint: nativeIds.has(item.id) ? item.operation === "execute" : item.transport.kind !== "local" },
  }));
}

function readEnvelope(descriptor, raw) {
  if (raw?.schemaVersion === "workloom.capability-result/v1") {
    if (raw.capabilityId !== descriptor.id || raw.operation !== descriptor.operation
        || !["succeeded", "pending", "failed"].includes(raw.status) || !dataModes.has(raw.dataMode)
        || descriptor.dataMode !== "real" && raw.dataMode === "real") {
      throw new CapabilityError("REMOTE_INVALID", "能力回执与请求契约不一致", 7);
    }
    return raw;
  }
  return { schemaVersion: "workloom.capability-result/v1", capabilityId: descriptor.id,
    operation: descriptor.operation, status: "succeeded", dataMode: descriptor.dataMode, result: raw,
    ...(descriptor.operation === "receipt" ? { receipt: {
      eventId: typeof raw?.receipt?.eventId === "string" ? raw.receipt.eventId : undefined,
      synced: descriptor.dataMode === "real" && raw?.receipt?.synced === true, sourceVerified: false } } : {}) };
}

export async function invokeEditAgent(catalog, id, input = {}, options = {}) {
  const descriptor = catalog.entries.get(id);
  if (!descriptor) throw new CapabilityError("NOT_FOUND", "能力不存在", 2);
  if (descriptor.enabled === false) throw new CapabilityError("DISABLED", descriptor.disabledReason, 8);
  const env = options.env ?? process.env;
  if (nativeIds.has(id)) return safeOutput(await invokeEditWorkflow(id, input, { env, root: catalog.root }), env);
  if (!readOperations.has(descriptor.operation)) throw new CapabilityError("DISABLED", "旧写能力不可通过此入口执行", 8);
  const value = validateInput(descriptor, input);
  if (descriptor.transport.kind === "trpc") {
    const { path, method } = descriptor.transport;
    if (method !== "query" || !readProcedures.has(path)) {
      throw new CapabilityError("CATALOG_INVALID", "服务端读取过程不在 Edit 固定清单中", 2);
    }
    const api = env.WORKLOOM_BASE_URL;
    if (!api) throw new CapabilityError("EDIT_API_REQUIRED", "缺少操作者设置的 Edit 服务地址", 2);
    const raw = await withVerifiedEditReadService(api, env.WORKLOOM_ACCESS_TOKEN,
      (call) => call(path, value), EDIT_READ_PROCEDURES, { env });
    return safeOutput(readEnvelope(descriptor, raw), env);
  }
  // Existing local modules and C-service read authorization retain their reviewed contracts.
  return safeOutput(await invokeCapability(catalog, id, value, { env, baseUrl: env.WORKLOOM_BASE_URL }), env);
}

export function editAgentList(catalog) {
  return { schemaVersion: "workloom.agent-capability-list/v1", productId: catalog.product.productId,
    bundleId: catalog.bundle, capabilities: [...catalog.entries.values()].map((item) => ({
      id: item.id, version: item.version, title: item.title, description: item.description,
      operation: item.operation, risk: item.risk, dataMode: item.dataMode, enabled: item.enabled !== false,
      ...(item.enabled === false ? { disabledReason: item.disabledReason } : {}),
    })) };
}

export function editAgentError(error, env = process.env) {
  const candidate = error?.code;
  const code = typeof candidate === "string" && /^[A-Z][A-Z0-9_]{1,99}$/u.test(candidate)
      && !secretValues(env).some((secret) => candidate.includes(secret))
    ? candidate : "EDIT_AGENT_FAILED";
  // Transport errors never copy upstream stderr, member tokens, arbitrary paths or request text.
  return { error: { code, message: code }, delivered: false };
}
