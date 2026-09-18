/**
 * 获客控制台数据面（行业扩展页 p10–p20）。
 *
 * 这不是"酒店后台"，也不是"视频后台"，而是**酒店获客复合系统**的经营台：
 * 每个页面回答获客闭环上的一个问题——
 *   意图洞察（渠道/评价/搜索）→ 双域触达（内容生产与发布）→ 四路承接（服务前台/语音/私信/落地页）
 *   → 线索转化（订单/券/直连）→ 归因复盘（收益、目标偏差、断点根因、一店一档）。
 *
 * 口径纪律：
 *  - 只读聚合，全部经工作区 RLS 上下文（svcQuery）；跨店视角走 owner 池并显式带 tenant 过滤；
 *  - 没有数据的指标如实返回空集/零值，由前端显示空态——不填演示假数；
 *  - 指标带 source 字段说明数据来源（事件账本 / 订单台账 / 账号指标 / 一店一档）。
 */
import { getOwnerPool } from "@workloom/db";
import { protectedProcedure, router, scopeOf } from "./context.js";
import { svcQuery } from "../service/events.js";

type Scope = { tenantId: string; workspaceId: string };
type Row = Record<string, unknown>;
const n = (value: unknown): number => Number(value ?? 0);

/** 事件计数（可选动作前缀），返回 [{action, n}] */
async function eventCounts(scope: Scope, patterns: string[], days = 7, limit = 12): Promise<Array<{ action: string; n: number }>> {
  const rows = await svcQuery<Row>(
    scope.workspaceId,
    `SELECT payload->'decision'->>'action' AS action, count(*)::int AS n
       FROM biz_events
      WHERE workspace_id=$1 AND created_at > now() - ($2 || ' days')::interval
        AND payload->'decision'->>'action' LIKE ANY($3::text[])
      GROUP BY 1 ORDER BY 2 DESC LIMIT $4`,
    [scope.workspaceId, String(days), patterns, limit],
  );
  return rows.map((row) => ({ action: String(row.action ?? ""), n: n(row.n) }));
}

export const acquisitionRouter = router({
  /** p10 断点流：失败/暂停的 Quest 与根因（事件账本） */
  breakpoints: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const threads = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT id, title, mode, status, error, current_action, updated_at
         FROM threads WHERE workspace_id=$1 AND status IN ('failed','paused')
         ORDER BY updated_at DESC LIMIT 20`,
      [scope.workspaceId],
    );
    const roots = await eventCounts(scope, ["%failed%", "%blocked%", "%.blocked", "inspect.run.failed"], 14);
    const byStatus = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT status, count(*)::int AS n FROM threads WHERE workspace_id=$1 GROUP BY 1`,
      [scope.workspaceId],
    );
    return {
      source: "threads + biz_events",
      byStatus: byStatus.map((row) => ({ status: String(row.status), n: n(row.n) })),
      roots,
      items: threads.map((row) => ({
        id: String(row.id), title: String(row.title ?? ""), mode: String(row.mode ?? ""),
        status: String(row.status), error: row.error ? String(row.error) : null,
        currentAction: row.current_action ? String(row.current_action) : null,
        updatedAt: String(row.updated_at),
      })),
    };
  }),

  /** p11 价格健康：调价与围栏命中（倒挂/保底价/熔断）+ 价带现状 */
  priceHealth: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const adjustments = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT payload->'decision'->'params'->>'room_type' AS room_type,
              payload->'decision'->'after'->>'price' AS after_price,
              payload->'decision'->>'action' AS action,
              payload->'rule_impact' AS impacts, created_at
         FROM biz_events
        WHERE workspace_id=$1 AND payload->'decision'->>'action' IN ('price.adjust','pms.price.write','ota.price.write')
        ORDER BY seq DESC LIMIT 20`,
      [scope.workspaceId],
    );
    const fences = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT impact->>'rule_id' AS rule_id, count(*)::int AS n
         FROM biz_events, jsonb_array_elements(payload->'rule_impact') AS impact
        WHERE workspace_id=$1 AND created_at > now() - interval '30 days'
        GROUP BY 1 ORDER BY 2 DESC`,
      [scope.workspaceId],
    );
    const profile = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT archive->'business' AS business, archive->'price_calendar' AS calendar FROM profiles WHERE workspace_id=$1`,
      [scope.workspaceId],
    );
    const parityAnomalies = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT payload->'decision'->'after'->>'summary' AS summary, created_at
         FROM biz_events
        WHERE workspace_id=$1 AND payload->'decision'->>'action'='inspect.anomaly'
          AND payload->'decision'->'after'->>'source' IN ('hotel.channel-price','hotel.room-state-sync')
        ORDER BY seq DESC LIMIT 10`,
      [scope.workspaceId],
    );
    return {
      source: "biz_events（调价与围栏命中）+ 一店一档（价带）",
      business: (profile[0]?.business ?? null) as Record<string, unknown> | null,
      calendar: (profile[0]?.calendar ?? null) as Record<string, unknown> | null,
      fenceHits: fences.map((row) => ({ ruleId: String(row.rule_id ?? ""), n: n(row.n) })),
      adjustments: adjustments.map((row) => ({
        roomType: row.room_type ? String(row.room_type) : null,
        afterPrice: row.after_price ? Number(row.after_price) : null,
        rules: Array.isArray(row.impacts) ? (row.impacts as Array<{ rule_id?: string; result?: string }>).map((i) => `${i.rule_id ?? ""}:${i.result ?? ""}`) : [],
        at: String(row.created_at),
      })),
      parityAnomalies: parityAnomalies.map((row) => ({ summary: String(row.summary ?? ""), at: String(row.created_at) })),
    };
  }),

  /** p12 目标仪表盘：年度/月度目标 + 目标偏差事件（goal.tracking） */
  goals: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const profile = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT archive->'goals' AS goals FROM profiles WHERE workspace_id=$1`,
      [scope.workspaceId],
    );
    const tracking = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT payload->'decision'->'after' AS after, created_at
         FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action'='goal.tracking'
         ORDER BY seq DESC LIMIT 12`,
      [scope.workspaceId],
    );
    const initiatives = await eventCounts(scope, ["initiative.%"], 30);
    return {
      source: "一店一档（goals）+ goal.tracking 事件",
      goals: (profile[0]?.goals ?? null) as Record<string, unknown> | null,
      tracking: tracking.map((row) => ({ after: (row.after ?? {}) as Record<string, unknown>, at: String(row.created_at) })),
      initiatives,
    };
  }),

  /** p13 订单流：订单台账 + 转化链事件（线索→成交） */
  orderFlow: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const orders = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT order_id, room_type, check_in, check_out, amount_fen, status
         FROM demo_orders WHERE workspace_id=$1 ORDER BY check_in DESC LIMIT 20`,
      [scope.workspaceId],
    );
    const chain = await eventCounts(scope, ["lead.%", "conversion.%", "deal.%", "booking.%", "service.ticket.%"], 30, 16);
    const totals = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT count(*)::int AS orders, COALESCE(SUM(amount_fen),0)::bigint AS amount_fen FROM demo_orders WHERE workspace_id=$1`,
      [scope.workspaceId],
    );
    const commissions = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT COALESCE(SUM((payload->'decision'->'after'->>'ota_commission_saved_fen')::bigint),0)::bigint AS saved_fen
         FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action' LIKE 'conversion.%'`,
      [scope.workspaceId],
    );
    return {
      source: "demo_orders（订单台账）+ biz_events（来源链/佣金节省）",
      totals: { orders: n(totals[0]?.orders), amountFen: n(totals[0]?.amount_fen), commissionSavedFen: n(commissions[0]?.saved_fen) },
      orders: orders.map((row) => ({
        id: String(row.order_id), roomType: String(row.room_type ?? ""),
        checkIn: row.check_in ? String(row.check_in).slice(0, 10) : null,
        checkOut: row.check_out ? String(row.check_out).slice(0, 10) : null,
        amountFen: n(row.amount_fen), status: String(row.status ?? ""),
      })),
      chain,
    };
  }),

  /** p14 渠道巡检：渠道清单 + 渠道异常 + 内容生产/发布留痕 */
  channels: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const profile = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT archive->'channels' AS channels, archive->'audience' AS audience FROM profiles WHERE workspace_id=$1`,
      [scope.workspaceId],
    );
    const anomalies = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT payload->'decision'->'after'->>'summary' AS summary,
              payload->'decision'->'after'->>'source' AS source, created_at
         FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action'='inspect.anomaly'
        ORDER BY seq DESC LIMIT 12`,
      [scope.workspaceId],
    );
    const content = await eventCounts(scope, ["content.%"], 30);
    const publishes = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT payload->'decision'->'after'->>'platform' AS platform, count(*)::int AS n
         FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action' IN ('content.publish','publish.execute')
        GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
      [scope.workspaceId],
    );
    return {
      source: "一店一档（渠道/客群）+ inspect.anomaly + content.* 事件",
      channels: Array.isArray(profile[0]?.channels) ? profile[0]!.channels : [],
      audience: (profile[0]?.audience ?? null) as Record<string, unknown> | null,
      anomalies: anomalies.map((row) => ({ summary: String(row.summary ?? ""), source: String(row.source ?? ""), at: String(row.created_at) })),
      content,
      publishes: publishes.map((row) => ({ platform: row.platform ? String(row.platform) : "未标注", n: n(row.n) })),
    };
  }),

  /** p15 差评 SLA：评价回复留痕 + 24h 响应口径 + 评价异常 */
  reviewSla: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const replies = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT payload->'decision'->'params'->>'rating' AS rating,
              payload->'decision'->>'action' AS action,
              payload->'rule_impact' AS impacts, created_at
         FROM biz_events
        WHERE workspace_id=$1 AND payload->'decision'->>'action' LIKE 'review.%'
        ORDER BY seq DESC LIMIT 20`,
      [scope.workspaceId],
    );
    const findings = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT payload->'decision'->'after'->>'summary' AS summary, created_at
         FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action'='inspect.anomaly'
          AND payload->'decision'->'after'->>'source'='hotel.guest-review'
        ORDER BY seq DESC LIMIT 10`,
      [scope.workspaceId],
    );
    const pending = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT count(*)::int AS n FROM approvals WHERE workspace_id=$1 AND status='pending' AND snapshot->>'action' LIKE 'review.%'`,
      [scope.workspaceId],
    );
    return {
      source: "review.* 事件（回复/评分/围栏命中）+ inspect.anomaly（评价扫描）",
      pendingApprovals: n(pending[0]?.n),
      replies: replies.map((row) => ({
        action: String(row.action ?? ""),
        rating: row.rating !== null && row.rating !== undefined ? Number(row.rating) : null,
        rules: Array.isArray(row.impacts) ? (row.impacts as Array<{ rule_id?: string; result?: string }>).map((i) => `${i.rule_id ?? ""}:${i.result ?? ""}`) : [],
        at: String(row.created_at),
      })),
      findings: findings.map((row) => ({ summary: String(row.summary ?? ""), at: String(row.created_at) })),
    };
  }),

  /** p16 语音前台与 FAQ 自生长：知识库规模 + 电话记录 + C 端工单 */
  serviceFront: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const kb = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT (SELECT count(*)::int FROM kb_collections WHERE workspace_id=$1) AS collections,
              (SELECT count(*)::int FROM kb_documents WHERE workspace_id=$1) AS documents,
              (SELECT count(*)::int FROM kb_chunks WHERE workspace_id=$1) AS chunks`,
      [scope.workspaceId],
    );
    const recentDocs = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT title, status, created_at FROM kb_documents WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 8`,
      [scope.workspaceId],
    );
    const calls = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT payload->'decision'->'params'->>'intent' AS intent, created_at
         FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action' IN ('phone_call.log','phone.call.log')
        ORDER BY seq DESC LIMIT 10`,
      [scope.workspaceId],
    );
    const tickets = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT kind, count(*)::int AS n FROM c_tickets WHERE workspace_id=$1 GROUP BY 1 ORDER BY 2 DESC`,
      [scope.workspaceId],
    );
    return {
      source: "知识库台账（kb_*）+ phone_call.log 事件 + C 端工单",
      kb: { collections: n(kb[0]?.collections), documents: n(kb[0]?.documents), chunks: n(kb[0]?.chunks) },
      recentDocs: recentDocs.map((row) => ({ title: String(row.title ?? ""), status: String(row.status ?? ""), at: String(row.created_at) })),
      calls: calls.map((row) => ({ intent: row.intent ? String(row.intent) : "未归档", at: String(row.created_at) })),
      tickets: tickets.map((row) => ({ kind: String(row.kind), n: n(row.n) })),
    };
  }),

  /** p17 入退与派单：C 端工单（送物/报修/投诉）+ 布草耗材相关事件 */
  housekeeping: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const tickets = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT id, kind, title, status, sla_due_at, created_at FROM c_tickets
        WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [scope.workspaceId],
    );
    const bySla = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT
          count(*) FILTER (WHERE status IN ('created','assigned','processing'))::int AS open,
          count(*) FILTER (WHERE sla_due_at IS NOT NULL AND sla_due_at < now() AND status NOT IN ('done','closed'))::int AS overdue,
          count(*) FILTER (WHERE status IN ('done','closed'))::int AS closed
        FROM c_tickets WHERE workspace_id=$1`,
      [scope.workspaceId],
    );
    const linen = await eventCounts(scope, ["linen.%", "stock.%", "room.inspect%"], 30);
    return {
      source: "c_tickets（C 端工单）+ linen/stock/room.inspect 事件",
      counts: { open: n(bySla[0]?.open), overdue: n(bySla[0]?.overdue), closed: n(bySla[0]?.closed) },
      tickets: tickets.map((row) => ({
        id: String(row.id), kind: String(row.kind ?? ""), title: String(row.title ?? ""),
        status: String(row.status ?? ""), slaDueAt: row.sla_due_at ? String(row.sla_due_at) : null,
        at: String(row.created_at),
      })),
      linen,
    };
  }),

  /** p18 多店驾驶舱：同租户各工作区的经营规模对比（owner 池 + 显式 tenant 过滤） */
  fleet: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const rows = (await getOwnerPool().query<Row>(
      `SELECT w.id, w.name, w.slug, w.industry, w.stage,
              (SELECT count(*)::int FROM agents a WHERE a.workspace_id=w.id) AS agents,
              (SELECT count(*)::int FROM biz_events e WHERE e.workspace_id=w.id) AS events,
              (SELECT count(*)::int FROM threads t WHERE t.workspace_id=w.id) AS threads,
              (SELECT COALESCE(SUM(o.amount_fen),0)::bigint FROM demo_orders o WHERE o.workspace_id=w.id) AS amount_fen
         FROM workspaces w WHERE w.tenant_id=$1 ORDER BY w.created_at`,
      [scope.tenantId],
    )).rows;
    return {
      source: "workspaces + 各表按工作区聚合（owner 池，按 tenant_id 过滤）",
      stores: rows.map((row) => ({
        id: String(row.id), name: String(row.name ?? ""), slug: String(row.slug ?? ""),
        industry: String(row.industry ?? ""), stage: row.stage ? String(row.stage) : null,
        agents: n(row.agents), events: n(row.events), threads: n(row.threads), amountFen: n(row.amount_fen),
      })),
    };
  }),

  /** p19 收益问数：订单收入 + 账号指标（播放/互动/转化）+ 历史曲线 */
  revenue: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const orders = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT count(*)::int AS orders, COALESCE(SUM(amount_fen),0)::bigint AS amount_fen,
              COALESCE(AVG(amount_fen),0)::bigint AS avg_fen
         FROM demo_orders WHERE workspace_id=$1`,
      [scope.workspaceId],
    );
    const metrics = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT COALESCE(SUM(plays),0)::bigint AS plays, COALESCE(SUM(likes),0)::bigint AS likes,
              COALESCE(SUM(comments),0)::bigint AS comments, COALESCE(SUM(conversions),0)::bigint AS conversions
         FROM account_metrics WHERE workspace_id=$1 AND captured_at > now() - interval '30 days'`,
      [scope.workspaceId],
    );
    const profile = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT archive->'history_curve' AS history, archive->'conversion_assets' AS conversion FROM profiles WHERE workspace_id=$1`,
      [scope.workspaceId],
    );
    return {
      source: "demo_orders（收入）+ account_metrics（播放/互动/转化）+ 一店一档（历史曲线/转化资产）",
      orders: { orders: n(orders[0]?.orders), amountFen: n(orders[0]?.amount_fen), avgFen: n(orders[0]?.avg_fen) },
      metrics: {
        plays: n(metrics[0]?.plays), likes: n(metrics[0]?.likes),
        comments: n(metrics[0]?.comments), conversions: n(metrics[0]?.conversions),
      },
      history: (profile[0]?.history ?? null) as Record<string, unknown> | null,
      conversion: (profile[0]?.conversion ?? null) as Record<string, unknown> | null,
    };
  }),

  /** p20 一店一档全景：档案模块齐备度 + 围栏 + 编制来源 + 技能装配 */
  profileOverview: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const profile = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT archive, forbidden, industry FROM profiles WHERE workspace_id=$1`,
      [scope.workspaceId],
    );
    const fences = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT count(DISTINCT rule_id)::int AS rules, count(*) FILTER (WHERE is_baseline)::int AS baseline
         FROM fence_rules WHERE workspace_id=$1 AND status='active'`,
      [scope.workspaceId],
    );
    const roster = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT COALESCE(meta->>'sourceBundleId','未标注') AS source_bundle, count(*)::int AS n
         FROM agents WHERE workspace_id=$1 GROUP BY 1 ORDER BY 2 DESC`,
      [scope.workspaceId],
    );
    const skills = await svcQuery<Row>(
      scope.workspaceId,
      `SELECT count(*)::int AS n FROM skill_installs WHERE workspace_id=$1
         AND NOT EXISTS (SELECT 1 FROM skill_revocations r WHERE r.skill_id = skill_installs.skill_id)`,
      [scope.workspaceId],
    );
    const archive = (profile[0]?.archive ?? {}) as Record<string, unknown>;
    return {
      source: "一店一档（profiles.archive）+ fence_rules + agents.meta + skill_installs",
      industry: profile[0]?.industry ? String(profile[0].industry) : null,
      modules: Object.keys(archive).sort(),
      forbidden: Array.isArray(profile[0]?.forbidden) ? (profile[0]!.forbidden as unknown[]).map(String) : [],
      journey: (archive.journey ?? null) as Record<string, unknown> | null,
      fence: { rules: n(fences[0]?.rules), baseline: n(fences[0]?.baseline) },
      roster: roster.map((row) => ({ bundle: String(row.source_bundle), n: n(row.n) })),
      skillsInstalled: n(skills[0]?.n),
    };
  }),
});
