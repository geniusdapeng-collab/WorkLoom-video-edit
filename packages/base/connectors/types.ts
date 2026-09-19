/**
 * base/connectors · 真实连接器就绪层（《GROWTH 深度产品方案》§9 G7）
 *
 * 设计口径：
 *   - 连接器只做"取数与回执"，不承载业务判断；
 *   - 凭证一律来自环境变量；缺配置 → fail-closed（抛 ConnectorUnconfiguredError），
 *     绝不回退到 mock 数据（mock 退出标准见 docs/connectors-mock-exit.md）；
 *   - 统一超时 / 重试（429 与 5xx）/ 速率上限；每次调用产出可留痕的回执信息。
 */

export interface ConnectorSpec {
  id: string;
  name: string;
  /** 必填环境变量（URL/Token 等）；任一缺失即 unconfigured */
  auth: readonly string[];
  timeoutMs: number;
  maxRetries: number;
  rateLimitPerMin: number;
  docs: string;
  mode: "live" | "fixture";
}

export interface ConnectorContext {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
}

export interface ConnectorHealth {
  id: string;
  name: string;
  state: "ready" | "unconfigured" | "error";
  detail: string;
}

export class ConnectorUnconfiguredError extends Error {
  constructor(public readonly spec: ConnectorSpec, public readonly missing: readonly string[]) {
    super(`连接器 ${spec.id} 缺少环境变量：${missing.join("、")}（fail-closed，不回退 mock）`);
    this.name = "ConnectorUnconfiguredError";
  }
}

export class ConnectorRequestError extends Error {
  constructor(public readonly spec: ConnectorSpec, public readonly status: number, public readonly detail: string) {
    super(`连接器 ${spec.id} 请求失败：HTTP ${status} ${detail}`);
    this.name = "ConnectorRequestError";
  }
}
