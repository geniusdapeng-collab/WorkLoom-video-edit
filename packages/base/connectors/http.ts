import {
  ConnectorRequestError, ConnectorUnconfiguredError, type ConnectorContext, type ConnectorSpec,
} from "./types.js";

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function env(ctx?: ConnectorContext): NodeJS.ProcessEnv {
  return ctx?.env ?? process.env;
}

/** 环境校验（fail-closed）：返回 base URL 与 token。 */
export function resolveAuth(spec: ConnectorSpec, ctx?: ConnectorContext): { baseUrl: string; token: string; extra: Record<string, string> } {
  const e = env(ctx);
  const missing = spec.auth.filter((k) => !e[k]?.trim());
  if (missing.length > 0) throw new ConnectorUnconfiguredError(spec, missing);
  const [baseKey, tokenKey, ...rest] = spec.auth;
  const extra: Record<string, string> = {};
  for (const k of rest) extra[k] = e[k]!.trim();
  return { baseUrl: e[baseKey!]!.trim().replace(/\/$/, ""), token: e[tokenKey!]!.trim(), extra };
}

/** 统一请求：超时（AbortController）+ 429/5xx 指数退避重试；4xx（除 429）直接失败。 */
export async function connectorFetch(
  spec: ConnectorSpec, path: string, init: RequestInit = {}, ctx?: ConnectorContext,
): Promise<{ response: Response; attempts: number }> {
  const { baseUrl, token, extra } = resolveAuth(spec, ctx);
  const fetchImpl = ctx?.fetchImpl ?? fetch;
  const sleep = ctx?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= spec.maxRetries + 1; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), spec.timeoutMs);
    try {
      const response = await fetchImpl(url, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...extra,
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (RETRYABLE.has(response.status) && attempt <= spec.maxRetries) {
        await sleep(Math.min(2_000, 50 * 2 ** (attempt - 1)));
        continue;
      }
      if (!response.ok) throw new ConnectorRequestError(spec, response.status, await response.text().catch(() => ""));
      return { response, attempts: attempt };
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof ConnectorRequestError) throw error;
      lastError = error;
      if (attempt > spec.maxRetries) break;
      await sleep(Math.min(2_000, 50 * 2 ** (attempt - 1)));
    }
  }
  throw new ConnectorRequestError(spec, 0, `重试 ${spec.maxRetries} 次后仍失败：${(lastError as Error)?.message ?? lastError}`);
}
