#!/usr/bin/env tsx
/**
 * 视觉工位 KPI（T-2026-0919-0010）。
 *
 * 从 biz_events + threads 汇总视觉任务的经营指标，供 ops-rhythm 周报使用：
 *   tasks / completed / failed / paused / pending_review
 *   renders（compose+render+text）/ verify pass-fail / receipts synced
 *   产物数（distinct snapshot_uri）/ 按天与按租户分布
 *
 * 用法：
 *   set -a; source .env; set +a
 *   ./node_modules/.bin/tsx scripts/visual-kpi.mts --days 7 [--markdown kpi.md] [--json]
 */

import { writeFileSync } from "node:fs";
import pg from "pg";

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

interface EventRow {
  session_id: string;
  tenant_id: string;
  workspace_id: string;
  action: string;
  synced: string | null;
  verify_ok: string | null;
  snapshot_uri: string | null;
  day: string;
}

async function main(): Promise<number> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL 未设置（先 set -a; source .env; set +a）");
    return 2;
  }
  const days = Math.max(1, Number(arg("--days", "7")));
  const app = new pg.Pool({ connectionString });
  try {
    const events = await app.query<EventRow>(
      `SELECT session_id, tenant_id, workspace_id,
              payload->'decision'->>'action' AS action,
              payload->'receipt'->>'synced' AS synced,
              payload->'decision'->'after'->'result'->>'ok' AS verify_ok,
              payload->'receipt'->>'snapshot_uri' AS snapshot_uri,
              to_char(created_at, 'YYYY-MM-DD') AS day
         FROM biz_events
        WHERE created_at >= now() - ($1::text || ' days')::interval
          AND payload->'decision'->>'action' LIKE 'visual%'
        ORDER BY seq`,
      [String(days)],
    );
    const sessions = [...new Set(events.rows.map((row) => row.session_id))];
    const threads = sessions.length === 0 ? [] : (await app.query<{ id: string; status: string }>(
      `SELECT id, status FROM threads WHERE id = ANY($1::text[])`,
      [sessions],
    )).rows;
    const statusById = new Map(threads.map((row) => [row.id, row.status]));

    const renders = events.rows.filter((row) => row.action.startsWith("visualwrite."));
    const verifies = events.rows.filter((row) => row.action === "visualread.verify");
    const synced = events.rows.filter((row) => row.synced === "true");
    const artifacts = new Set(events.rows.map((row) => row.snapshot_uri).filter(Boolean));

    const byTenant = new Map<string, { tasks: Set<string>; renders: number }>();
    for (const row of events.rows) {
      const entry = byTenant.get(row.tenant_id) ?? { tasks: new Set<string>(), renders: 0 };
      entry.tasks.add(row.session_id);
      if (row.action.startsWith("visualwrite.")) entry.renders += 1;
      byTenant.set(row.tenant_id, entry);
    }
    const byDay = new Map<string, number>();
    for (const row of renders) byDay.set(row.day, (byDay.get(row.day) ?? 0) + 1);

    const statusCounts = threads.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1;
      return acc;
    }, {});

    const claims = [...new Set(renders.map((row) => row.session_id))];
    const report = {
      window_days: days,
      generated_at: new Date().toISOString(),
      tasks: sessions.length,
      threads: statusCounts,
      renders: renders.length,
      verify: {
        total: verifies.length,
        pass: verifies.filter((row) => row.verify_ok === "true").length,
        fail: verifies.filter((row) => row.verify_ok === "false").length,
      },
      receipts_synced: synced.length,
      receipt_rate: events.rows.length === 0 ? null : Number((synced.length / events.rows.length).toFixed(3)),
      artifacts: artifacts.size,
      sessions_with_renders: claims.length,
      by_tenant: Object.fromEntries([...byTenant].map(([tenant, entry]) => [tenant, {
        tasks: entry.tasks.size,
        renders: entry.renders,
      }])),
      by_day: Object.fromEntries([...byDay].sort()),
      note: "receipt_rate = 有 synced=true 回执的事件 / 视觉事件总数；failed/paused 越多说明围栏或工位越需要关注",
    };

    const markdownPath = arg("--markdown");
    if (markdownPath) {
      const lines = [
        `# 视觉工位 KPI（最近 ${days} 天）`,
        "",
        `生成时间：${report.generated_at}`,
        "",
        "| 指标 | 数值 |",
        "|---|---|",
        `| 任务数 | ${report.tasks} |`,
        `| 渲染次数 | ${report.renders} |`,
        `| 成品数 | ${report.artifacts} |`,
        `| 回执率 | ${report.receipt_rate ?? "n/a"} |`,
        `| verify 通过/失败 | ${report.verify.pass}/${report.verify.fail} |`,
        `| 线程状态 | ${Object.entries(statusCounts).map(([k, v]) => `${k}=${v}`).join(", ") || "—"} |`,
        "",
        "## 按天渲染",
        "",
        "| 日期 | 渲染 |",
        "|---|---|",
        ...[...byDay].sort().map(([day, count]) => `| ${day} | ${count} |`),
        "",
        "## 按租户",
        "",
        "| 租户 | 任务 | 渲染 |",
        "|---|---|---|",
        ...Object.entries(report.by_tenant).map(([tenant, entry]) => `| ${tenant} | ${entry.tasks} | ${entry.renders} |`),
        "",
      ];
      writeFileSync(markdownPath, lines.join("\n"));
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await app.end();
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(2);
});
