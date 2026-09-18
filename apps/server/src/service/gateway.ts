/**
 * service · C 端公开网关（Hono 子应用，挂 /c，独立于员工 tRPC）
 *  - POST /c/session（S2）：h5 直登仅 SERVICE_C_DEMO_AUTH==='true' 放行（默认开发态 true，启动告警）；
 *    wechat-mini/alipay 走 code→openid 交换 seam（无凭据 503「渠道未配置」）；
 *    IP+channel 限流 60 次/分（限流 Map 5 分钟 TTL 清扫）
 *  - 鉴权：Bearer c-token（verifyCToken）；内存限流 60 次/分钟/用户
 *  - POST /c/chat：service-dialog 流水线；toolCall → 活动行业适配器执行并渲染契约卡片（基座零行业词汇）；
 *    ticketDraft + confirmTicket:true → 服务端幂等键 + createTicket/assignTicket/五元事件同一 serviceTx（H2）；
 *    pushMessage 失败 catch 落库 status='failed' 不阻断响应
 *  - 契约（H6，以 webc types.ts 为准）：cards={kind:'order'|'member'|'catalog',data}；
 *    工单附 statusText 中文枚举（保留英文 status）；/member={level,points,benefits[],demo?}；
 *    /orders=[{id,title,status,checkIn?,roomType?,amount?}]；/notifications 每项含 read:false
 *  - 输入约束（M9）：/chat text≤2000；/tickets kind 白名单 + title≤120 + payload JSON≤10KB
 * 工作区解析：C 端无工作区入参，取 env SERVICE_C_WORKSPACE_ID，缺省第一个工作区（演示口径）。
 */
import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { getOwnerPool } from "@workloom/db";
import {
  bindCUserIdentityOn, CHANNELS, cSecret, exchangeCodeForOpenid, getCUser, h5EntrySecret, issueCToken,
  listNotifications, pushMessage, resolveCUser, verifyCToken, verifyH5EntryToken,
  type Channel, type CTokenPayload,
} from "./channels.js";
import { selectServiceWorkspaceId, ServiceWorkspaceRoutingError } from "./workspace-routing.js";
import { resolveWorkspaceBusinessAdapter, type BusinessAdapterBinding } from "./adapters/business-registry.js";
import { BusinessAdapterError, businessDisplayText, type ServiceFrontBusinessAdapter } from "./adapters/business.js";
import { handleMessage } from "./dialog.js";
import {
  ServiceHttpError, assignTicketOn, createTicketOn, getTicket, listTickets, rateTicket, ticketTimeline,
  type Ticket,
} from "./ticket.js";
import { ensureServiceSchema } from "./store.js";
import { appendEventOn, serviceTx } from "./events.js";

export const serviceGateway = new Hono();

/** S2：h5/openid 演示直登开关（开发缺省 true；P1-11：生产环境缺省 false，必须显式配置渠道凭据或显式开启） */
export const DEMO_AUTH = (process.env.SERVICE_C_DEMO_AUTH ?? (process.env.NODE_ENV === "production" ? "false" : "true")) === "true";
if (DEMO_AUTH) {
  console.warn("[service-c] SERVICE_C_DEMO_AUTH 已开启：h5/openid 演示直登可用（生产环境必须置 false 并配置渠道 code 交换凭据）");
}

/** C 端工作区解析（登录引导同款 owner 池例外点，F7.1） */
let cachedWorkspaceId: string | null = null;
async function cWorkspaceId(): Promise<string> {
  if (process.env.SERVICE_C_WORKSPACE_ID) return process.env.SERVICE_C_WORKSPACE_ID;
  if (cachedWorkspaceId) return cachedWorkspaceId;
  await ensureServiceSchema();
  const r = await getOwnerPool().query(`SELECT id FROM workspaces ORDER BY created_at LIMIT 1`);
  const id = r.rows[0]?.id as string | undefined;
  if (!id) throw new Error("无可用工作区（请先完成员工端登录引导）");
  cachedWorkspaceId = id;
  return id;
}

/* ---------------- 内存限流（60 次/分钟；Map 5 分钟 TTL 清扫防内存膨胀） ---------------- */
const buckets = new Map<string, { count: number; resetAt: number; touchedAt: number }>();
const BUCKET_TTL_MS = 5 * 60_000;
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (b.resetAt <= now || now - b.touchedAt > BUCKET_TTL_MS) buckets.delete(k);
  }
}, 60_000);
sweeper.unref?.();

function rateLimited(key: string, limit = 60): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + 60_000, touchedAt: now });
    return false;
  }
  b.count += 1;
  b.touchedAt = now;
  return b.count > limit;
}

/* ---------------- 鉴权中间件（Bearer c-token） ---------------- */
async function cAuth(c: Context, next: Next): Promise<Response | void> {
  const auth = c.req.header("authorization");
  if (!auth?.startsWith("Bearer ")) return c.json({ error: "未认证（缺少 c-token）" }, 401);
  const payload = await verifyCToken(auth.slice(7), cSecret());
  if (!payload) return c.json({ error: "c-token 无效或已过期" }, 401);
  if (rateLimited(`c:${payload.cUserId}`)) return c.json({ error: "请求过于频繁（60 次/分钟）" }, 429);
  c.set("cAuth", payload);
  await next();
}

function authOf(c: Context): CTokenPayload {
  return c.get("cAuth") as CTokenPayload;
}

/** 解析 JSON body（非法/空 body → {}），属性经 Partial 访问、校验后使用 */
async function bodyOf<T>(c: Context): Promise<Partial<T>> {
  try {
    return (await c.req.json()) as Partial<T>;
  } catch {
    return {};
  }
}

function clientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/** 统一错误映射：ServiceHttpError → 语义状态码；其余 → 500 带 requestId（L9） */
function fail(c: Context, err: unknown, requestId: string): Response {
  if (err instanceof ServiceHttpError) return c.json({ error: err.message, requestId }, err.status as 400);
  // 行业适配器的失败关闭：状态码与稳定错误码都要给 C 端（webc 按 code 出中文提示）
  if (err instanceof BusinessAdapterError) {
    return c.json({ error: err.message, code: err.code, requestId }, err.status as 400);
  }
  console.warn(`[service-c] 请求处理失败 requestId=${requestId}：`, err instanceof Error ? err.message : err);
  return c.json({ error: "服务内部错误", requestId }, 500);
}

/**
 * 活动行业适配器（身份核验等业务能力的唯一入口）：
 * 未装配/投影非法一律 503 失败关闭，绝不回退到示例行业。
 */
async function activeBusinessAdapter(workspaceId: string): Promise<ServiceFrontBusinessAdapter> {
  const binding = await resolveWorkspaceBusinessAdapter(workspaceId);
  if (binding.state !== "ready" || !binding.adapter) {
    throw new ServiceHttpError(`当前服务前台不可用：${binding.reason}`, 503);
  }
  return binding.adapter;
}

/**
 * 业务查询用的软着陆适配器：
 *  - 未声明行业适配器 / 前台未启用 → 返回 null，由调用方给出**明确的空态**（available:false），
 *    而不是 503 报错——C 端契约（apps/webc 的 api.ts）就是按 `available === false` 渲染空态的；
 *  - 其他异常（未安装、指针冲突、投影被篡改、适配器未登记）→ 抛 503 失败关闭，绝不回退示例行业。
 */
function unavailableBusinessAdapter(binding: BusinessAdapterBinding): ServiceFrontBusinessAdapter | null {
  if (binding.state === "ready") return binding.adapter;
  if (binding.state === "adapter-not-declared" || binding.state === "front-disabled") return null;
  throw new BusinessAdapterError("当前服务前台的业务能力暂不可用", 503, "BUSINESS_ADAPTER_UNAVAILABLE");
}

/**
 * 工单部门名：**行业词汇由活动适配器提供**，基座只保留通用兜底（ticket.ts 的 DEPT_ROUTE）。
 * 适配器未装配/投影非法时不阻断建单——返回 undefined，由通用兜底接管（工单照样进队列）。
 */
async function projectedDepartmentForTicket(workspaceId: string, kind: string): Promise<string | undefined> {
  try {
    const adapter = await activeBusinessAdapter(workspaceId);
    const department = adapter.departmentForTicket?.(kind);
    return department ? businessDisplayText(department, "ticket.department") : undefined;
  } catch {
    return undefined;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/* ---------------- H6 契约序列化 ---------------- */

/** 工单状态 → webc 中文枚举（保留英文 status，提供 statusText） */
const TICKET_STATUS_TEXT: Record<string, string> = {
  created: "已受理",
  assigned: "已受理",
  processing: "处理中",
  done: "已完成",
  closed: "已关闭",
};

export function serializeTicket(t: Ticket): Ticket & { statusText: string } {
  return { ...t, statusText: TICKET_STATUS_TEXT[t.status] ?? t.status };
}

/** 工单受理推送：失败 catch 落库 status='failed' 不阻断响应（H2） */
async function pushAcceptedSafely(input: {
  workspaceId: string; cUserId: string; ticketId: string; title: string; dept: string | null;
}): Promise<void> {
  const payload = {
    ticketId: input.ticketId, title: input.title,
    text: `您的工单「${input.title}」已受理，${input.dept ?? "客服部"}将尽快跟进。`,
  };
  try {
    await pushMessage({ workspaceId: input.workspaceId, cUserId: input.cUserId, kind: "ticket.accepted", payload });
  } catch (err) {
    console.warn(`[service-c] 受理推送失败，落 failed 通知（不阻断建单响应）：`, err instanceof Error ? err.message : err);
    try {
      await serviceTx(input.workspaceId, async (client) => {
        await client.query(
          `INSERT INTO c_notifications (workspace_id, c_user_id, channel, kind, payload, driver, status)
           VALUES ($1,$2,'h5','ticket.accepted',$3,'mock','failed')`,
          [input.workspaceId, input.cUserId, JSON.stringify(payload)],
        );
      });
    } catch (err2) {
      console.warn(`[service-c] failed 通知落库也失败：`, err2 instanceof Error ? err2.message : err2);
    }
  }
}

/** 建单链路（H2）：createTicket + assignTicket + 五元事件同一 serviceTx；幂等命中直接返回原单 */
async function createTicketFlow(input: {
  workspaceId: string; cUserId: string; channel: string; conversationId?: string;
  kind: string; title: string; payload: Record<string, unknown>; idempotencyKey: string;
  /** 行业部门名（由活动适配器投影）；缺省走基座通用兜底 */
  dept?: string;
}): Promise<{ ticket: Ticket; deduped: boolean; eventId: string | null }> {
  return serviceTx(input.workspaceId, async (client, scope) => {
    const { ticket, deduped } = await createTicketOn(client, {
      workspaceId: input.workspaceId, cUserId: input.cUserId, conversationId: input.conversationId,
      kind: input.kind, title: input.title, payload: input.payload, idempotencyKey: input.idempotencyKey,
    });
    if (deduped) return { ticket, deduped: true, eventId: null }; // 幂等重放：不重复派单/推送/留痕
    const assigned = await assignTicketOn(client, {
      workspaceId: input.workspaceId, ticketId: ticket.id,
      ...(input.dept ? { dept: input.dept } : {}),
    });
    const ev = await appendEventOn(client, scope, { id: input.cUserId, type: "human" }, {
      objectType: "ticket", objectId: ticket.id, action: "service.ticket.create",
      after: { kind: input.kind, title: input.title, dept: assigned.dept, channel: input.channel },
      channel: input.channel,
    });
    return { ticket: assigned, deduped: false, eventId: ev.eventId };
  });
}

/**
 * 正式 H5 入口（SERVICE_C_DEMO_AUTH=false）：身份与租户只能来自受信身份网关签发的
 * entryToken——客户端自报的 openid/workspaceKey 只参与一致性校验，不决定身份。
 * 全部失败在访问数据库之前关闭（fail closed）。
 */
async function resolveH5Entry(
  body: { entryToken?: string; workspaceKey?: string },
): Promise<{ ok: true; subject: string; workspaceKey: string } | { ok: false; status: 401 | 403 | 503; code: string; error: string }> {
  const entryToken = body.entryToken?.trim() ?? "";
  if (!entryToken) {
    return { ok: false, status: 401, code: "H5_ENTRY_REQUIRED", error: "缺少入口凭据（entryToken），请从服务方提供的入口进入" };
  }
  const secret = h5EntrySecret();
  if (!secret) {
    return { ok: false, status: 503, code: "H5_ENTRY_UNCONFIGURED", error: "服务端未配置 H5 入口签名密钥（SERVICE_C_H5_ENTRY_SECRET）" };
  }
  const payload = await verifyH5EntryToken(entryToken, secret);
  if (!payload) {
    return { ok: false, status: 401, code: "H5_ENTRY_INVALID", error: "入口凭据无效或已过期" };
  }
  const claimed = body.workspaceKey?.trim() ?? "";
  if (claimed && claimed !== payload.workspaceKey) {
    return { ok: false, status: 403, code: "H5_ENTRY_SCOPE_MISMATCH", error: "入口凭据与页面工作区不一致" };
  }
  return { ok: true, subject: payload.subject, workspaceKey: payload.workspaceKey };
}

/* ---------------- 会话 ---------------- */
serviceGateway.post("/session", async (c) => {
  const requestId = randomUUID();
  try {
    const body = await bodyOf<{
      channel: string; openid: string; nickname: string; code: string;
      entryToken: string; workspaceKey: string;
    }>(c);
    if (!body.channel || !(CHANNELS as readonly string[]).includes(body.channel)) {
      return c.json({ error: `channel 须为 ${CHANNELS.join("/")}` }, 400);
    }
    const channel = body.channel as Channel;
    // S2：IP+channel 限流（60 次/分，防 openid 爆破）
    if (rateLimited(`session:${clientIp(c)}:${channel}`)) {
      return c.json({ error: "请求过于频繁（60 次/分钟）" }, 429);
    }
    let openid: string;
    /** 正式 H5 入口解析出的工作区（来自签名声明）；null = 走演示/单租户口径 */
    let entryWorkspaceId: string | null = null;
    if (channel === "h5") {
      const hasEntryToken = Boolean(body.entryToken?.trim());
      if (!DEMO_AUTH || hasEntryToken) {
        // 正式入口：凭据缺失/伪造/跨租户一律在查库前失败关闭
        const entry = await resolveH5Entry(body);
        if (!entry.ok) return c.json({ code: entry.code, error: entry.error, requestId }, entry.status);
        try {
          entryWorkspaceId = selectServiceWorkspaceId({
            fixedWorkspaceId: process.env.SERVICE_C_WORKSPACE_ID,
            workspaceMap: process.env.SERVICE_C_WORKSPACE_MAP,
            workspaceKey: entry.workspaceKey,
          });
        } catch (err) {
          if (err instanceof ServiceWorkspaceRoutingError) {
            console.warn(`[service-c] H5 入口工作区路由失败 requestId=${requestId}：${err.message}`);
            return c.json({ code: "H5_ENTRY_WORKSPACE_UNMAPPED", error: "入口凭据对应的服务站点未配置", requestId }, 503);
          }
          throw err;
        }
        openid = `h5:${entry.subject}`;
      } else {
        // 演示直登（仅 LOCAL/演示部署；生产必须 SERVICE_C_DEMO_AUTH=false）
        if (!body.openid) return c.json({ error: "缺少 openid" }, 400);
        openid = body.openid;
      }
    } else if (DEMO_AUTH && body.openid) {
      openid = body.openid; // 开发态：小程序渠道也允许 openid 直登
    } else {
      // wechat-mini / alipay：code → openid 交换 seam（无凭据 503 渠道未配置）
      if (!body.code) return c.json({ error: `缺少 code（${channel} 需经 code 换取 openid）` }, 400);
      const ex = await exchangeCodeForOpenid(channel, body.code);
      if (!ex.ok) return c.json({ error: `渠道未配置：${channel}（${ex.reason}）`, requestId }, 503);
      openid = ex.openid;
    }
    const workspaceId = entryWorkspaceId ?? await cWorkspaceId();
    const user = await resolveCUser({ workspaceId, channel, openid, nickname: body.nickname });
    const token = await issueCToken({ workspaceId, cUserId: user.id, channel: user.channel, secret: cSecret() });
    // authMode 只描述"本次会话如何建立"：演示直登 vs 渠道/受信入口核验（webc 据此出徽标）
    return c.json({ token, user: { ...user, authMode: DEMO_AUTH && !entryWorkspaceId ? "demo" : "channel" } });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

/* ---------------- 对话 ---------------- */
serviceGateway.post("/chat", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const body = await bodyOf<{
      conversationId: string; text: string; confirmTicket: boolean; idempotencyKey: string;
      ticketDraft: { kind: string; title: string; payload: Record<string, unknown> };
    }>(c);
    if (!body.text?.trim()) return c.json({ error: "缺少 text" }, 400);
    if (body.text.length > 2000) return c.json({ error: "text 超长（≤2000 字符）" }, 400);

    const r = await handleMessage({
      workspaceId: a.workspaceId, cUserId: a.cUserId, channel: a.channel,
      text: body.text.trim(), conversationId: body.conversationId,
    });

    // 业务查询工具：执行适配器并渲染契约卡片（H6：{kind:'order'|'member'|'catalog', data}）
    const cards: Array<{ kind: "order" | "member" | "catalog"; data: Record<string, unknown> }> = [];
    let answer = r.answer;
    if (r.toolCall) {
      const user = await getCUser(a.workspaceId, a.cUserId);
      const ctx = {
        workspaceId: a.workspaceId, cUserId: a.cUserId, memberId: user?.memberId ?? null,
      };
      if (r.toolCall.tool === "query_ticket") {
        // 工单进度只读本人真实工单：没有就如实说没有，不编造一条进度（E2.1）
        const tickets = await listTickets({ workspaceId: a.workspaceId, cUserId: a.cUserId });
        answer = tickets.length === 0
          ? "暂未查到您的工单记录。您可以直接说需要办理的事（送物/报修/投诉），我马上为您建单。"
          : `为您查询到 ${tickets.length} 条工单：${tickets.slice(0, 3).map((t) => `「${t.title}」${TICKET_STATUS_TEXT[t.status] ?? t.status}`).join("；")}。`;
      } else {
        // 业务查询一律经活动行业包选中的适配器投影（基座不得内置行业形状）；
        // 未声明适配器的门店如实告知"未开通"，不猜、不回落示例行业。
        const adapter = unavailableBusinessAdapter(await resolveWorkspaceBusinessAdapter(a.workspaceId));
        if (!adapter) {
          answer = "当前门店尚未开通这项查询能力，可先办理送物/报修/投诉等事项目。";
        } else if (r.toolCall.tool === "query_order") {
          const data = await adapter.queryOrder(ctx);
          if (data.bindRequired) answer = data.hint ?? "请先绑定会员身份后再查询。";
          else for (const order of data.orders) {
            cards.push({ kind: "order", data: order as unknown as Record<string, unknown> });
          }
        } else if (r.toolCall.tool === "query_member") {
          const data = await adapter.queryMember(ctx);
          if (data.bindRequired) answer = data.hint ?? "请先绑定会员身份后再查询。";
          else if (data.member) {
            cards.push({ kind: "member", data: { ...data.member, demo: data.demo } as unknown as Record<string, unknown> });
          }
        } else if (r.toolCall.tool === "query_catalog") {
          const data = await adapter.queryCatalog(ctx);
          cards.push({
            kind: "catalog",
            data: { cardTitle: data.cardTitle, items: data.items, demo: data.demo } as unknown as Record<string, unknown>,
          });
        }
      }
    }

    // 工单草稿确认：confirmTicket:true → 服务端幂等键 + 同事务建单/派单/五元事件（H2）
    let ticket: (Ticket & { statusText: string }) | null = null;
    let deduped = false;
    let ticketReceipt: Record<string, unknown> | null = null;
    const draft = body.confirmTicket ? (body.ticketDraft ?? r.ticketDraft) : undefined; // 客户端显式回传的草稿优先于本轮新产生的兜底草稿
    if (draft) {
      const idempotencyKey = body.idempotencyKey ?? `chat:${r.conversationId}:${sha256(body.text.trim()).slice(0, 16)}`;
      const flow = await createTicketFlow({
        workspaceId: a.workspaceId, cUserId: a.cUserId, channel: a.channel, conversationId: r.conversationId,
        kind: draft.kind, title: draft.title.slice(0, 120), payload: draft.payload ?? {}, idempotencyKey,
        dept: await projectedDepartmentForTicket(a.workspaceId, draft.kind),
      });
      deduped = flow.deduped;
      if (!flow.deduped) {
        await pushAcceptedSafely({
          workspaceId: a.workspaceId, cUserId: a.cUserId,
          ticketId: flow.ticket.id, title: flow.ticket.title, dept: flow.ticket.dept,
        });
      }
      ticket = serializeTicket(flow.ticket);
      ticketReceipt = {
        requestId, state: flow.deduped ? "recorded" : "accepted", resourceId: flow.ticket.id,
        eventId: flow.eventId, demo: true, ...(flow.deduped ? { idempotentReplay: true } : { delivery: { state: "demo" } }),
      };
    }

    return c.json({
      conversationId: r.conversationId,
      intent: r.intent,
      answer,
      confidence: r.confidence,
      citations: r.citations,
      cards,
      ticket,
      ...(ticketReceipt ? { receipt: ticketReceipt } : {}),
      ...(deduped ? { deduped: true } : {}),
      ticketDraft: r.ticketDraft ?? null,
      latencyMs: r.latencyMs,
      ...(r.mock ? { mock: true } : {}),
    });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

/* ---------------- 业务查询（活动行业适配器投影；H6 契约形状） ---------------- */
serviceGateway.get("/orders", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const user = await getCUser(a.workspaceId, a.cUserId);
    const binding = await resolveWorkspaceBusinessAdapter(a.workspaceId);
    const adapter = unavailableBusinessAdapter(binding);
    // 未开通业务能力的门店：明确空态（available:false），不伪装成"没有订单"，也不 503
    if (!adapter) return c.json({ orders: [], demo: false, available: false });
    const data = await adapter.queryOrder({ workspaceId: a.workspaceId, cUserId: a.cUserId, memberId: user?.memberId ?? null });
    return c.json({
      orders: data.orders,
      demo: data.demo,
      available: true,
      ...(data.bindRequired ? { bindRequired: true, hint: data.hint } : {}),
    });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

serviceGateway.get("/member", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const user = await getCUser(a.workspaceId, a.cUserId);
    const binding = await resolveWorkspaceBusinessAdapter(a.workspaceId);
    const adapter = unavailableBusinessAdapter(binding);
    if (!adapter) {
      return c.json({ title: "权益信息不可用", benefits: [], demo: false, available: false });
    }
    const data = await adapter.queryMember({ workspaceId: a.workspaceId, cUserId: a.cUserId, memberId: user?.memberId ?? null });
    if (data.bindRequired || !data.member) {
      // H6 契约（webc MemberInfo + 绑定引导）：未绑定不返回等级/积分为 0 的伪会员信息
      return c.json({
        title: "身份尚未绑定", benefits: [], demo: data.demo,
        available: true,
        bindRequired: true, hint: data.hint ?? "完成手机号验证绑定后即可查询本人订单与会员信息。",
      });
    }
    return c.json({ ...data.member, demo: data.demo, available: true });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

/* ---------------- 工单 ---------------- */
const TICKET_KINDS = ["delivery", "repair", "complaint", "other", "service_request", "consult"] as const;

/* ---------------- 身份绑定（H6：webc IdentityCodeResponse / IdentityBindResponse） ---------------- */

/** 手机号只以哈希落库（R24：客资明文不出系统），因此入口先做格式约束再交给行业适配器核验。 */
const PHONE_RE = /^1\d{10}$/;

serviceGateway.post("/identity/code", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const body = await bodyOf<{ phone: string }>(c);
    const phone = body.phone?.trim() ?? "";
    if (!PHONE_RE.test(phone)) return c.json({ error: "手机号格式不正确", code: "INVALID_IDENTITY_PHONE", requestId }, 400);
    const adapter = await activeBusinessAdapter(a.workspaceId);
    if (!adapter.identity) {
      return c.json({ error: "当前行业未提供身份核验能力", code: "IDENTITY_UNAVAILABLE", requestId }, 503);
    }
    const challenge = await adapter.identity.requestCode(phone);
    return c.json({
      state: challenge.state,
      message: challenge.message,
      requestId,
      ...(challenge.demoCode ? { demoCode: challenge.demoCode } : {}),
    });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

serviceGateway.post("/identity/bind", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const body = await bodyOf<{ phone: string; code: string }>(c);
    const phone = body.phone?.trim() ?? "";
    const code = body.code?.trim() ?? "";
    if (!PHONE_RE.test(phone) || !code) {
      return c.json({ error: "手机号或验证码格式不正确", code: "INVALID_IDENTITY_INPUT", requestId }, 400);
    }
    const adapter = await activeBusinessAdapter(a.workspaceId);
    if (!adapter.identity) {
      return c.json({ error: "当前行业未提供身份核验能力", code: "IDENTITY_UNAVAILABLE", requestId }, 503);
    }
    // 核验在行业适配器内完成（行业自己决定权威身份源）；失败按 BusinessAdapterError 映射状态码与错误码
    const matched = await serviceTx(a.workspaceId, async (client) =>
      adapter.identity!.verifyCode(client, { workspaceId: a.workspaceId, cUserId: a.cUserId }, { phone, code }));
    // 绑定写回 + 五元事件同一 COMMIT：回执里的 eventId 必须能对上账本，不允许"绑了但没留痕"
    const bound = await serviceTx(a.workspaceId, async (client, scope) => {
      const user = await bindCUserIdentityOn(client, {
        workspaceId: a.workspaceId, cUserId: a.cUserId,
        memberId: matched.subjectId, phoneHash: sha256(phone),
        identityMode: matched.demo ? "demo" : "verified",
      });
      if (!user) throw new ServiceHttpError("C 端用户不存在（会话已失效）", 401);
      const ev = await appendEventOn(client, scope, { id: a.cUserId, type: "human" }, {
        objectType: "c_user", objectId: a.cUserId, action: "service.identity.bind",
        after: {
          memberId: matched.subjectId,
          identityMode: user.identityMode,
          phoneHashSuffix: sha256(phone).slice(0, 8),
        },
        channel: a.channel,
      });
      return { user, eventId: ev.eventId };
    });
    return c.json({
      // 与会话口径一致：演示直登态标记 demo，其余（渠道/受信入口）标记 channel
      user: { ...bound.user, authMode: DEMO_AUTH ? "demo" : "channel" },
      receipt: {
        requestId, state: "bound", resourceId: matched.subjectId, eventId: bound.eventId, demo: matched.demo,
      },
    });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

serviceGateway.post("/tickets", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const body = await bodyOf<{
      kind: string; title: string; payload: Record<string, unknown>;
      conversationId: string; idempotencyKey: string;
    }>(c);
    if (!body.kind || !body.title?.trim()) return c.json({ error: "缺少 kind/title" }, 400);
    // M9 输入约束：kind 白名单 / title≤120 / payload JSON≤10KB
    if (!(TICKET_KINDS as readonly string[]).includes(body.kind)) {
      return c.json({ error: `kind 须为 ${TICKET_KINDS.join("/")}` }, 400);
    }
    const title = body.title.trim();
    if (title.length > 120) return c.json({ error: "title 超长（≤120 字符）" }, 400);
    const payload = body.payload ?? {};
    if (JSON.stringify(payload).length > 10 * 1024) return c.json({ error: "payload 超大（≤10KB）" }, 400);
    // H2：客户端传入幂等键优先，否则服务端强制生成（重放安全）
    const idempotencyKey = body.idempotencyKey
      ?? `ticket:${a.cUserId}:${sha256(`${body.kind}|${title}|${JSON.stringify(payload)}`).slice(0, 16)}`;

    const flow = await createTicketFlow({
      workspaceId: a.workspaceId, cUserId: a.cUserId, channel: a.channel, conversationId: body.conversationId,
      kind: body.kind, title, payload, idempotencyKey,
      dept: await projectedDepartmentForTicket(a.workspaceId, body.kind),
    });
    // H6 契约：回执 {requestId,state,resourceId,eventId,demo,delivery}；重放不重复落事件，标记 recorded
    if (flow.deduped) {
      return c.json({
        ticket: serializeTicket(flow.ticket),
        idempotentReplay: true,
        receipt: {
          requestId, state: "recorded", resourceId: flow.ticket.id, idempotentReplay: true, demo: true,
        },
      });
    }
    await pushAcceptedSafely({
      workspaceId: a.workspaceId, cUserId: a.cUserId,
      ticketId: flow.ticket.id, title: flow.ticket.title, dept: flow.ticket.dept,
    });
    return c.json({
      ticket: serializeTicket(flow.ticket),
      receipt: {
        requestId, state: "accepted", resourceId: flow.ticket.id, eventId: flow.eventId, demo: true,
        delivery: { state: "demo" },
      },
    });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

serviceGateway.get("/tickets", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const tickets = await listTickets({ workspaceId: a.workspaceId, cUserId: a.cUserId });
    return c.json({ tickets: tickets.map(serializeTicket) });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

serviceGateway.get("/tickets/:id", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const ticket = await getTicket(a.workspaceId, String(c.req.param("id")));
    if (!ticket || ticket.cUserId !== a.cUserId) return c.json({ error: "工单不存在", requestId }, 404);
    const timeline = await ticketTimeline({ workspaceId: a.workspaceId, ticketId: ticket.id });
    // H6：detail 归一为字符串（webc TimelineItem.detail: string）
    const items = timeline.map((e) => ({
      action: e.action,
      actorType: e.actorType,
      actorId: e.actorId,
      detail: typeof e.detail === "string" ? e.detail : String((e.detail as Record<string, unknown>).note ?? JSON.stringify(e.detail)),
      createdAt: e.createdAt,
    }));
    return c.json({ ticket: serializeTicket(ticket), timeline: items });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

serviceGateway.post("/tickets/:id/rate", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const body = await bodyOf<{ score: number; comment: string }>(c);
    if (!body.score || body.score < 1 || body.score > 5) return c.json({ error: "score 须为 1-5" }, 400);
    // L9：仅 done 可评且只可评一次（rateTicket 内状态机/幂等断言，409/404 语义）
    const ticket = await rateTicket({
      workspaceId: a.workspaceId, ticketId: String(c.req.param("id")), cUserId: a.cUserId,
      score: body.score, comment: body.comment,
    });
    let rateEventId: string | null = null;
    await serviceTx(a.workspaceId, async (client, scope) => {
      const ev = await appendEventOn(client, scope, { id: a.cUserId, type: "human" }, {
        objectType: "ticket", objectId: ticket.id, action: "service.ticket.rate",
        after: { score: body.score, comment: body.comment ?? null }, channel: a.channel,
      });
      rateEventId = ev.eventId;
    });
    return c.json({
      ticket: serializeTicket(ticket),
      receipt: { requestId, state: "recorded", resourceId: ticket.id, eventId: rateEventId, demo: true },
    });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

/* ---------------- 推送箱 ---------------- */
serviceGateway.get("/notifications", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const notifications = await listNotifications({ workspaceId: a.workspaceId, cUserId: a.cUserId });
    return c.json({ notifications });
  } catch (err) {
    return fail(c, err, requestId);
  }
});
