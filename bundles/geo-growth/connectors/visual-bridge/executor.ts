/**
 * geo-growth × 视觉工位 bridge 连接器。
 *
 * 结构兼容 `packages/runtime/src/tools.ts` 的 ToolExecutor seam（不直接 import，
 * 避免行业包反向依赖运行时内部；部署时把返回值注入宿主的 toolExecutor 即可）。
 *
 * 纪律：
 * - 工具名分段（visualread.* / visualwrite.*）——现有 dsh 围栏插件按动作首段匹配，
 *   共用 visual.* 前缀会让只读工具命中写规则；
 * - 不回显 token，不把客户素材写进日志；
 * - 缺回执不伪造：receipt.synced=false，由运行时按「未核实」处理。
 */

export interface ToolReceipt {
  synced: boolean;
  snapshot_uri?: string;
  verified_at?: string;
}

export interface ToolResult {
  result: Record<string, unknown>;
  receipt: ToolReceipt;
}

export type ToolExecutor = (name: string, params: Record<string, unknown>) => Promise<ToolResult>;

export interface VisualBridgeOptions {
  /** 形如 http://127.0.0.1:9773；生产建议经内网反向代理 + mTLS */
  baseUrl: string;
  /** 工位 token，来自受控秘密存储或工位本机文件，不进仓库 */
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class VisualBridgeError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "VisualBridgeError";
    this.code = code;
  }
}

/** 视觉工位声明的工具面；不在表内的工具直接拒绝。 */
export const VISUAL_BRIDGE_TOOLS = [
  "visualread.health",
  "visualread.inspect",
  "visualread.verify",
  "visualwrite.compose",
  "visualwrite.render",
  "visualwrite.text",
] as const;

const TOOL_SET: ReadonlySet<string> = new Set(VISUAL_BRIDGE_TOOLS);

export function isVisualBridgeTool(name: string): boolean {
  return TOOL_SET.has(name);
}

export function createVisualBridgeExecutor(options: VisualBridgeOptions): ToolExecutor {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 300_000;

  return async (name, params) => {
    if (!TOOL_SET.has(name)) {
      throw new VisualBridgeError(`视觉工位不提供工具 ${name}`, "not_provided");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}/action`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.token}`,
        },
        body: JSON.stringify({ tool: name, params }),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new VisualBridgeError("视觉工位返回非 JSON 响应", "bad_response");
      }
      const body = payload as {
        ok?: boolean;
        error?: unknown;
        message?: unknown;
        result?: unknown;
        receipt?: { synced?: unknown; snapshot_uri?: unknown; verified_at?: unknown };
      };
      if (!response.ok || body.ok !== true) {
        const message = typeof body.message === "string" ? body.message : `视觉工位 HTTP ${response.status}`;
        const code = typeof body.error === "string" ? body.error : "bridge_error";
        throw new VisualBridgeError(message, code);
      }
      const receipt = body.receipt ?? {};
      return {
        result: (body.result ?? {}) as Record<string, unknown>,
        receipt: {
          synced: receipt.synced === true,
          ...(typeof receipt.snapshot_uri === "string" ? { snapshot_uri: receipt.snapshot_uri } : {}),
          ...(typeof receipt.verified_at === "string" ? { verified_at: receipt.verified_at } : {}),
        },
      };
    } catch (error) {
      if (error instanceof VisualBridgeError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new VisualBridgeError("视觉工位请求超时", "timeout");
      }
      throw new VisualBridgeError(error instanceof Error ? error.message : String(error), "network_error");
    } finally {
      clearTimeout(timer);
    }
  };
}
