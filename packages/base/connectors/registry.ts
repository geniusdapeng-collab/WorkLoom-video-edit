import type { ConnectorContext, ConnectorHealth, ConnectorSpec } from "./types.js";

/** G7 首批两个真实连接器（凭证就绪后即可 live；当前环境通常为 unconfigured）。 */
export const ADS_GATEWAY: ConnectorSpec = {
  id: "ads-gateway",
  name: "广告投放网关（Meta / 千川）",
  auth: ["ADS_GATEWAY_URL", "ADS_GATEWAY_TOKEN"],
  timeoutMs: 10_000,
  maxRetries: 2,
  rateLimitPerMin: 60,
  docs: "docs/connectors-mock-exit.md",
  mode: "live",
};

export const SOCIAL_DOUYIN: ConnectorSpec = {
  id: "social-douyin",
  name: "抖音开放平台（内容与评论）",
  auth: ["DOUYIN_OPEN_URL", "DOUYIN_ACCESS_TOKEN", "DOUYIN_OPEN_ID"],
  timeoutMs: 10_000,
  maxRetries: 2,
  rateLimitPerMin: 120,
  docs: "docs/connectors-mock-exit.md",
  mode: "live",
};

export const CONNECTORS: readonly ConnectorSpec[] = [ADS_GATEWAY, SOCIAL_DOUYIN];

export function connectorReadiness(ctx?: ConnectorContext): ConnectorHealth[] {
  const e = ctx?.env ?? process.env;
  return CONNECTORS.map((spec) => {
    const missing = spec.auth.filter((k) => !e[k]?.trim());
    return missing.length === 0
      ? { id: spec.id, name: spec.name, state: "ready", detail: "凭证已配置（可 live 取数）" }
      : { id: spec.id, name: spec.name, state: "unconfigured", detail: `缺少：${missing.join("、")}（fail-closed，不回退 mock）` };
  });
}
