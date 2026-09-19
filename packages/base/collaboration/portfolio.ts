import type { DecisionPacket, PortfolioDomain, PortfolioSummary } from "./schema.js";

export function buildPortfolio(domains: readonly PortfolioDomain[]): PortfolioSummary {
  return {
    domains: [...domains],
    totals: domains.reduce(
      (acc, d) => ({
        agents: acc.agents + d.agents,
        pending: acc.pending + d.pending,
        actions7d: acc.actions7d + d.actions7d,
        redLines7d: acc.redLines7d + d.redLines7d,
      }),
      { agents: 0, pending: 0, actions7d: 0, redLines7d: 0 },
    ),
  };
}

export interface NarrativeInput {
  workspaceName: string;
  portfolio: PortfolioSummary;
  packet: DecisionPacket;
  /** 增长回路北极星（未接入时传 null，叙事如实标"待接入"，不编数） */
  northStar?: { label: string; value: string } | null;
}

/**
 * 数字人单一叙事：把"组合看板 + 决策包"压成一段可直接播报的中文叙述。
 * 纪律：只陈述有数据来源的事实；缺数据说"待接入"，不编造。
 */
export function composeNarrative(input: NarrativeInput): string {
  const { workspaceName, portfolio, packet, northStar } = input;
  const domainLine = portfolio.domains
    .filter((d) => d.agents > 0)
    .map((d) => `${d.label} ${d.agents} 人（近 7 天动作 ${d.actions7d}，红线 ${d.redLines7d}）`)
    .join("；");
  const decisionLine = packet.overflowCount > 0
    ? `今日需您拍板 ${packet.items.length} 件（另有 ${packet.overflowCount} 件超出配额，已按层级排序，将在明日报送或由上级先带内处理）。`
    : `今日需您拍板 ${packet.items.length} 件。`;
  const starLine = northStar ? `增长北极星：${northStar.label} ${northStar.value}。` : "增长北极星：待接入（不编造数据）。";
  return `董事长好，${workspaceName} 当前在岗 ${portfolio.totals.agents} 人：${domainLine}。${decisionLine}${starLine}`;
}
