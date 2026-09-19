/**
 * base/captain · 信任账户 v0（《GROWTH 深度产品方案》§4.3）
 *
 * 口径：以**决策域**为单位记账（价格/投放/内容/评论/信源/数据/实验…），
 * 证据来自真实账本：审批手势（批准/修改/驳回/上浮） + 决策回测（命中/偏离/打脸） + 熔断事件。
 * 升降规则（v0，可挑战）：
 *   - 红线事故（熔断/一票否决事件） ≥1 → 降档 + 补考；
 *   - 样本不足 → 维持观察（不许"因为跑了很久"自动升档）；
 *   - 命中率 ≥60% 且 批准率 ≥80% → 升档建议；
 *   - 命中率 <50% 或 批准率 <50% → 降档；
 *   - 其余 → 维持。
 * 说明：升档建议必须人批（沿用 §1 治理链）；降档可自动执行（收紧方向）。
 */
import type pg from "pg";

export interface TrustPolicy {
  windowDays: number;
  upgradeSample: number;
  upgradeHitRate: number;
  upgradeApproveRate: number;
  downgradeHitRate: number;
  downgradeApproveRate: number;
}

export const DEFAULT_TRUST_POLICY: TrustPolicy = {
  windowDays: 30,
  upgradeSample: 20,
  upgradeHitRate: 0.6,
  upgradeApproveRate: 0.8,
  downgradeHitRate: 0.5,
  downgradeApproveRate: 0.5,
};

export interface DomainEvidence {
  domain: string;
  decisions: number;      // 已裁决决策数（approvals 已出手势）
  approved: number;
  rejected: number;
  edited: number;
  escalated: number;      // 上浮 L4
  incidents: number;      // 红线事故（熔断/一票否决）
  outcomes: { hit: number; miss: number; fail: number };
}

export interface TrustVerdict {
  domain: string;
  level: "up" | "hold" | "down";
  sample: number;
  hitRate: number | null;
  approveRate: number | null;
  retakeRequired: boolean;
  reasons: string[];
}

export function evalDomainEvidence(evidence: DomainEvidence, policy = DEFAULT_TRUST_POLICY): TrustVerdict {
  const outcomes = evidence.outcomes.hit + evidence.outcomes.miss + evidence.outcomes.fail;
  const hitRate = outcomes > 0 ? evidence.outcomes.hit / outcomes : null;
  const approveRate = evidence.decisions > 0 ? evidence.approved / evidence.decisions : null;
  const sample = Math.max(evidence.decisions, outcomes);
  const reasons: string[] = [];

  if (evidence.incidents > 0) {
    reasons.push(`红线事故 ${evidence.incidents} 起（熔断/一票否决）：立即降档并补考`);
    return { domain: evidence.domain, level: "down", sample, hitRate, approveRate, retakeRequired: true, reasons };
  }
  if (sample < policy.upgradeSample) {
    reasons.push(`样本 ${sample} < ${policy.upgradeSample}：维持观察（禁止按时间自动升档）`);
    return { domain: evidence.domain, level: "hold", sample, hitRate, approveRate, retakeRequired: false, reasons };
  }
  if ((hitRate !== null && hitRate < policy.downgradeHitRate) || (approveRate !== null && approveRate < policy.downgradeApproveRate)) {
    reasons.push(`命中率 ${fmt(hitRate)} / 批准率 ${fmt(approveRate)} 跌破下限：降档`);
    return { domain: evidence.domain, level: "down", sample, hitRate, approveRate, retakeRequired: false, reasons };
  }
  if (hitRate !== null && hitRate >= policy.upgradeHitRate && approveRate !== null && approveRate >= policy.upgradeApproveRate) {
    reasons.push(`命中率 ${fmt(hitRate)} ≥${policy.upgradeHitRate} 且批准率 ${fmt(approveRate)} ≥${policy.upgradeApproveRate}：升档建议（需人批）`);
    return { domain: evidence.domain, level: "up", sample, hitRate, approveRate, retakeRequired: false, reasons };
  }
  reasons.push(`命中率 ${fmt(hitRate)} / 批准率 ${fmt(approveRate)}：维持当前档位`);
  return { domain: evidence.domain, level: "hold", sample, hitRate, approveRate, retakeRequired: false, reasons };
}

function fmt(v: number | null): string {
  return v === null ? "无样本" : `${Math.round(v * 100)}%`;
}

/** 从真实账本聚合各决策域的证据（批准/修改/驳回/上浮 + 回测 + 熔断）。 */
export async function buildTrustAccounts(
  app: pg.Pool, scope: { tenantId: string; workspaceId: string }, policy = DEFAULT_TRUST_POLICY,
): Promise<Array<{ evidence: DomainEvidence; verdict: TrustVerdict }>> {
  const windowDays = policy.windowDays;
  const rows = await app.query<{
    domain: string; decided: string; approved: string; rejected: string; edited: string; escalated: string;
  }>(
    `SELECT split_part(snapshot->>'action','.',1) AS domain,
            count(*) FILTER (WHERE status <> 'pending')::text AS decided,
            count(*) FILTER (WHERE status='approved')::text AS approved,
            count(*) FILTER (WHERE status='rejected')::text AS rejected,
            count(*) FILTER (WHERE status='edited')::text AS edited,
            count(*) FILTER (WHERE tier='l4_chairman')::text AS escalated
       FROM approvals
      WHERE workspace_id=$1 AND created_at > now() - ($2 || ' days')::interval
        AND COALESCE(snapshot->>'action','') <> ''
      GROUP BY 1 ORDER BY 1`,
    [scope.workspaceId, String(windowDays)],
  );
  const outcomeRows = await app.query<{ domain: string; verdict: string; n: string }>(
    `SELECT split_part(a.snapshot->>'action','.',1) AS domain,
            o.payload->'decision'->'params'->>'verdict' AS verdict, count(*)::text AS n
       FROM biz_events o
       JOIN biz_events d ON d.workspace_id=o.workspace_id
                        AND d.event_id = o.payload->'decision'->'params'->>'ref_decision'
       JOIN approvals a ON a.workspace_id=d.workspace_id
                       AND a.approval_id = d.payload->'decision'->'params'->>'approval_id'
      WHERE o.workspace_id=$1 AND o.payload->'decision'->>'action'='decision.outcome'
        AND o.created_at > now() - ($2 || ' days')::interval
      GROUP BY 1, 2`,
    [scope.workspaceId, String(windowDays)],
  );
  const incidentRows = await app.query<{ domain: string; n: string }>(
    `SELECT COALESCE(payload->'decision'->'params'->>'domain','未分域') AS domain, count(*)::text AS n
       FROM biz_events
      WHERE workspace_id=$1 AND payload->'decision'->>'action' IN ('breaker.trigger','circuit_breaker.trip')
        AND created_at > now() - ($2 || ' days')::interval
      GROUP BY 1`,
    [scope.workspaceId, String(windowDays)],
  ).catch(() => ({ rows: [] as Array<{ domain: string; n: string }> }));

  const byDomain = new Map<string, DomainEvidence>();
  for (const r of rows.rows) {
    byDomain.set(r.domain, {
      domain: r.domain,
      decisions: Number(r.decided), approved: Number(r.approved), rejected: Number(r.rejected),
      edited: Number(r.edited), escalated: Number(r.escalated), incidents: 0,
      outcomes: { hit: 0, miss: 0, fail: 0 },
    });
  }
  for (const o of outcomeRows.rows) {
    const e = byDomain.get(o.domain);
    if (!e) continue;
    if (o.verdict === "命中") e.outcomes.hit = Number(o.n);
    else if (o.verdict === "偏离") e.outcomes.miss = Number(o.n);
    else if (o.verdict === "打脸") e.outcomes.fail = Number(o.n);
  }
  for (const i of incidentRows.rows) {
    const e = byDomain.get(i.domain);
    if (e) e.incidents = Number(i.n);
  }
  return [...byDomain.values()]
    .filter((e) => e.decisions > 0)
    .sort((a, b) => b.decisions - a.decisions)
    .map((evidence) => ({ evidence, verdict: evalDomainEvidence(evidence, policy) }));
}

/** 三条曲线（§7）：自治率 / 客户干预率 / 回测命中率（按窗口，含 dry_run 排除口径）。 */
export async function buildMetricCurves(
  app: pg.Pool, scope: { tenantId: string; workspaceId: string }, windowDays = 30,
): Promise<{
  windowDays: number;
  autonomyRate: number | null;
  interventionRate: number | null;
  hitRate: number | null;
  counts: { ceoDecisions: number; escalated: number; clientGestures: number; outcomes: { hit: number; miss: number; fail: number } };
}> {
  const ceo = await app.query<{ n: string; esc: string }>(
    `SELECT count(*)::text AS n,
            count(*) FILTER (WHERE payload->'decision'->'params'->>'verdict'='escalate')::text AS esc
       FROM biz_events
      WHERE workspace_id=$1 AND payload->'decision'->>'action'='ceo.decision'
        AND COALESCE(payload->'decision'->'params'->>'dry_run','false') <> 'true'
        AND created_at > now() - ($2 || ' days')::interval`,
    [scope.workspaceId, String(windowDays)],
  );
  const gestures = await app.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM approvals
      WHERE workspace_id=$1 AND decided_by IS NOT NULL AND decided_by <> 'company-ceo'
        AND created_at > now() - ($2 || ' days')::interval`,
    [scope.workspaceId, String(windowDays)],
  );
  const outcomes = await app.query<{ verdict: string; n: string }>(
    `SELECT payload->'decision'->'params'->>'verdict' AS verdict, count(*)::text AS n
       FROM biz_events
      WHERE workspace_id=$1 AND payload->'decision'->>'action'='decision.outcome'
        AND created_at > now() - ($2 || ' days')::interval
      GROUP BY 1`,
    [scope.workspaceId, String(windowDays)],
  );
  const ceoDecisions = Number(ceo.rows[0]?.n ?? 0);
  const escalated = Number(ceo.rows[0]?.esc ?? 0);
  const clientGestures = Number(gestures.rows[0]?.n ?? 0);
  const oc = { hit: 0, miss: 0, fail: 0 };
  for (const o of outcomes.rows) {
    if (o.verdict === "命中") oc.hit = Number(o.n);
    else if (o.verdict === "偏离") oc.miss = Number(o.n);
    else if (o.verdict === "打脸") oc.fail = Number(o.n);
  }
  const totalOutcomes = oc.hit + oc.miss + oc.fail;
  const decidedTotal = ceoDecisions + clientGestures;
  return {
    windowDays,
    autonomyRate: decidedTotal > 0 ? ceoDecisions / decidedTotal : null,
    interventionRate: decidedTotal > 0 ? clientGestures / decidedTotal : null,
    hitRate: totalOutcomes > 0 ? oc.hit / totalOutcomes : null,
    counts: { ceoDecisions, escalated, clientGestures, outcomes: oc },
  };
}
