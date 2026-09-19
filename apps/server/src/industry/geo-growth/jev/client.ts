/**
 * Jev 网关客户端（Vercel AI Gateway · evaluation 协议 v4）
 *
 * 为什么不用基座 model-router：model-router 的提供方契约是 OpenAI 兼容 chat（messages → text），
 * 而 Jev 是 evaluation 协议（state + typed questions → typed answers，官方文档明确不支持
 * OpenAI 兼容端点）。把它硬塞进 chat 契约会破坏"出站必备脱敏"的既有语义，因此本试点先在行业侧
 * 独立实现；若验证通过，再按协议 §10.2 走提案任务卡把 DecisionProvider 演进到基座。
 *
 * 可靠性纪律（对齐 jev-ultrafast 的传输层）：
 *   - 只读调用：evaluation 不产生副作用，因此 429/529/503 与网络/超时可安全重试；
 *   - 退避：指数退避 + 抖动，尊重 retry-after 头；
 *   - 超时：AbortController 硬超时（默认 20s）；
 *   - 密钥：只从参数/环境读取，绝不进入日志与错误消息（错误消息里只出现状态码与主机名）。
 */
import { JevResponseError, parseAnswers } from "./protocol.js";
import type { JevCallResult, JevRequest } from "./types.js";

export type JevErrorCode =
  | "missing_key"
  | "auth"
  | "bad_request"
  | "rate_limited"
  | "overloaded"
  | "server"
  | "timeout"
  | "network"
  | "invalid_response";

export class JevError extends Error {
  constructor(
    readonly code: JevErrorCode,
    message: string,
    readonly options: { status?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "JevError";
  }

  get retryable(): boolean {
    return this.options.retryable ?? false;
  }
}

export interface JevClientOptions {
  apiKey?: string;
  /** 网关根地址；默认 https://ai-gateway.vercel.sh */
  baseUrl?: string;
  /** 模型 id；默认 typesafe-ai/jev */
  model?: string;
  /** 单次请求硬超时（毫秒） */
  timeoutMs?: number;
  /** 最大尝试次数（含首次） */
  maxAttempts?: number;
  /** 注入点：测试用假 fetch；默认全局 fetch */
  fetchImpl?: typeof fetch;
  /** 注入点：测试用假睡眠；默认真实等待 */
  sleepImpl?: (ms: number) => Promise<void>;
  /** 注入点：测试用假时钟；默认 Date.now */
  nowImpl?: () => number;
}

export const DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh";
export const DEFAULT_MODEL = "typesafe-ai/jev";
export const GATEWAY_PROTOCOL_VERSION = "0.0.1";
export const EVALUATION_SPEC_VERSION = "4";

const RETRY_STATUS = new Set([429, 500, 502, 503, 529]);

function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfterSeconds = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1000, 15_000);
  }
  const base = Math.min(500 * 2 ** (attempt - 1), 8_000);
  return base + Math.floor(Math.random() * 250);
}

export class JevClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly nowImpl: () => number;

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.nowImpl = options.nowImpl ?? (() => Date.now());
  }

  get modelId(): string {
    return this.model;
  }

  get host(): string {
    try {
      return new URL(this.baseUrl).host;
    } catch {
      return this.baseUrl;
    }
  }

  /** 单次评估：state + 若干类型化问题 → 类型化回答（失败抛 JevError） */
  async evaluate(request: JevRequest, signal?: AbortSignal): Promise<JevCallResult> {
    if (!this.apiKey) {
      // 免 key 网关（如本地 mock）允许空 key；真实网关必须显式给出，避免"以为在调真模型"
      if (!this.baseUrl.includes("127.0.0.1") && !this.baseUrl.includes("localhost")) {
        throw new JevError("missing_key", "缺少 AI_GATEWAY_API_KEY（真实网关必须提供；--mock 走本地模拟）");
      }
    }
    const url = `${this.baseUrl}/v4/ai/evaluation-model`;
    const body = JSON.stringify({ state: request.state, questions: request.questions });
    let lastError: JevError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const started = this.nowImpl();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const onOuterAbort = () => controller.abort();
      signal?.addEventListener("abort", onOuterAbort, { once: true });
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey ?? ""}`,
            "ai-gateway-protocol-version": GATEWAY_PROTOCOL_VERSION,
            "ai-evaluation-model-specification-version": EVALUATION_SPEC_VERSION,
            "ai-model-id": this.model,
          },
          body,
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
          const error = this.errorForStatus(response.status, response.headers.get("retry-after"));
          if (error.retryable && attempt < this.maxAttempts) {
            lastError = error;
            await this.sleepImpl(backoffMs(attempt, response.headers.get("retry-after")));
            continue;
          }
          throw error;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new JevError("invalid_response", "网关返回非 JSON 响应");
        }
        return parseAnswers(parsed, request.questions, this.model, this.nowImpl() - started);
      } catch (error) {
        const normalized = this.normalizeError(error);
        if (normalized.code === "invalid_response") throw normalized;
        if (normalized.retryable && attempt < this.maxAttempts) {
          lastError = normalized;
          await this.sleepImpl(backoffMs(attempt, null));
          continue;
        }
        throw normalized;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onOuterAbort);
      }
    }
    throw lastError ?? new JevError("network", "网关不可用且无可返回结果");
  }

  private errorForStatus(status: number, retryAfter: string | null): JevError {
    if (status === 401 || status === 403) {
      return new JevError("auth", `网关鉴权失败（HTTP ${status}，host=${this.host}）`);
    }
    if (status === 429) {
      return new JevError("rate_limited", `网关限流（HTTP 429，retry-after=${retryAfter ?? "无"}）`, {
        status,
        retryable: true,
      });
    }
    if (status === 529) {
      return new JevError("overloaded", "网关过载（HTTP 529）", { status, retryable: true });
    }
    if (RETRY_STATUS.has(status)) {
      return new JevError("server", `网关错误（HTTP ${status}）`, { status, retryable: true });
    }
    if (status === 400 || status === 422) {
      return new JevError("bad_request", `请求被拒（HTTP ${status}；检查协议头/问题结构）`, { status });
    }
    return new JevError("server", `网关返回 HTTP ${status}`, { status });
  }

  private normalizeError(error: unknown): JevError {
    if (error instanceof JevError) return error;
    if (error instanceof JevResponseError) {
      return new JevError("invalid_response", `回答非法：${error.message}`);
    }
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      return new JevError("timeout", `网关超时（>${this.timeoutMs}ms）`, { retryable: true });
    }
    const message = error instanceof Error ? error.message : String(error);
    return new JevError("network", `网关连接失败：${message}`, { retryable: true });
  }
}

/** 从环境构造（key 缺失时返回 null，由调用方决定 mock 还是报错） */
export function clientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<JevClientOptions> = {},
): JevClient {
  return new JevClient({
    apiKey: env["AI_GATEWAY_API_KEY"] ?? env["VERCEL_AI_GATEWAY_KEY"],
    baseUrl: env["JEV_BASE_URL"] ?? DEFAULT_BASE_URL,
    model: env["JEV_MODEL"] ?? DEFAULT_MODEL,
    timeoutMs: env["JEV_TIMEOUT_MS"] ? Number(env["JEV_TIMEOUT_MS"]) : undefined,
    ...overrides,
  });
}
