#!/usr/bin/env node
/**
 * metrics · 三条曲线 + 域级信任账户（《GROWTH 深度产品方案》§4.3 / §7）
 *
 *   pnpm metrics --tenant <id> --workspace <id> [--days 30] [--json]
 *
 * 三条曲线：自治率（无需人工干预完成的决策占比）/ 客户干预率（客户手势占比）/ 回测命中率。
 * 域级信任账户：按决策域给出 up / hold / down 建议与依据（升档需人批，降档可自动收紧）。
 */
import pg from "pg";
import { DEFAULT_TRUST_POLICY, buildMetricCurves, buildTrustAccounts } from "@workloom/base/captain";

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const has = (name: string) => process.argv.includes(name);

const tenantId = arg("--tenant");
const workspaceId = arg("--workspace");
if (!tenantId || !workspaceId) {
  console.error("用法：pnpm metrics --tenant <id> --workspace <id> [--days 30] [--json]");
  process.exit(2);
}
const days = Number(arg("--days", "30"));
const app = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom",
  max: 4,
});
const scope = { tenantId, workspaceId };

const pct = (v: number | null) => (v === null ? "无样本" : `${(v * 100).toFixed(1)}%`);

try {
  const [curves, accounts] = await Promise.all([
    buildMetricCurves(app, scope, days),
    buildTrustAccounts(app, scope, { ...DEFAULT_TRUST_POLICY, windowDays: days }),
  ]);
  if (has("--json")) {
    console.log(JSON.stringify({ workspaceId, curves, accounts }, null, 2));
  } else {
    console.log(`窗口 ${days} 天 · 工作区 ${workspaceId}`);
    console.log(`自治率 ${pct(curves.autonomyRate)}（AI 裁决 ${curves.counts.ceoDecisions} 件，其中上浮 ${curves.counts.escalated} 件）`);
    console.log(`客户干预率 ${pct(curves.interventionRate)}（客户手势 ${curves.counts.clientGestures} 次）`);
    console.log(`回测命中率 ${pct(curves.hitRate)}（命中 ${curves.counts.outcomes.hit} / 偏离 ${curves.counts.outcomes.miss} / 打脸 ${curves.counts.outcomes.fail}）`);
    console.log("\n域级信任账户（升档需人批；降档可自动收紧）：");
    if (accounts.length === 0) console.log("  （窗口内暂无已裁决的决策域）");
    for (const { evidence, verdict } of accounts) {
      console.log(`  [${verdict.level}] ${evidence.domain}：决策 ${evidence.decisions}（批准 ${evidence.approved}/驳回 ${evidence.rejected}/修改 ${evidence.edited}）· 命中 ${pct(verdict.hitRate)} · ${verdict.reasons.join("；")}`);
    }
  }
} catch (error) {
  console.error(`metrics 失败：${(error as Error)?.message ?? error}`);
  process.exitCode = 1;
} finally {
  await app.end().catch(() => undefined);
}
