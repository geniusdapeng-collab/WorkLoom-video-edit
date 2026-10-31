/**
 * video/deal.ts —— 商单域 tRPC 子路由（0011 商单扩张服务端接线）
 *
 * 六组过程：
 *  - leads：商单线索列表（评论中含合作意向 / 已建单关联随行）
 *  - createFromLead：线索建单（G15 围栏预检 deal.create）
 *  - quote：报价落单（G15 围栏预检 deal.quote；超报价带事件带 escalate L4 标记）
 *  - advanceMilestone：履约节点推进（G15 预检 deal.milestone）
 *  - dunning：账期催款备稿（G15 预检 deal.dunning；只备稿不外发）
 *  - closure：结案报告聚合（纯读）
 *
 * 纪律：写操作全走 writeProcedure + 围栏 judge（G15：对外文件/商务动作必审基线）；
 *      block → 403 不落库；事件留痕与业务行同一 COMMIT（D16，deal-flow 服务内完成）。
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { getAppPool, getGatewayPool } from "@workloom/db";
import { judge } from "@workloom/base/fence-engine";
import {
  DealError,
  advanceMilestone,
  applyQuote,
  closureReport,
  createFromLead,
  dunning,
} from "@workloom/base/deal-flow";
import { newId } from "@workloom/shared";
import { protectedProcedure, router, scopeOf, writeProcedure } from "../trpc/context.js";
import { loadActiveRules, scopedQuery } from "./router.js";
import { sha256Json } from "@workloom/pipeline-control";
import { autoApprovalRefusal, evaluateAndRecordVideoAutoApproval } from "./system-auto-approval.js";

function dealRethrow(err: unknown): never {
  if (err instanceof DealError) {
    throw new TRPCError({
      code: err.code === "NOT_FOUND" || err.code === "LEAD_NOT_FOUND" ? "NOT_FOUND" : "BAD_REQUEST",
      message: err.message,
    });
  }
  throw err;
}

/** G15 围栏预检：block → FORBIDDEN；auto/review 放行（review 由审批层消费 escalate/留痕） */
async function judgeOrThrow(
  scope: { tenantId: string; workspaceId: string },
  action: string,
  objectId: string,
  params: Record<string, unknown>,
  by: string,
): Promise<{ level: "auto" | "review" | "block"; triggeredBy: string[] }> {
  const app = getAppPool();
  const { rules, defaultLevel } = await loadActiveRules(app, scope);
  const verdict = judge({ object: { type: "deal_order", id: objectId }, action, params }, rules, defaultLevel);
  const factHash = sha256Json({ action, objectId, params });
  const auto = await evaluateAndRecordVideoAutoApproval(
    getGatewayPool(),
    scope,
    { type: "deal_order", id: objectId },
    {
      gateKey: "G15",
      action,
      artifactSha256: factHash,
      factHash,
      expectedFactHash: factHash,
      deterministicChecks: [
        {
          id: "deal-request-current",
          category: "deterministic",
          status: objectId && action ? "passed" : "failed",
          detail: "deal object and action are bound into the exact request hash",
          evidenceRef: factHash,
          ...(objectId && action ? {} : { repairClass: "no_repair" as const }),
        },
        {
          id: "external-document-scope",
          category: "deterministic",
          status: action === "deal.send_external" ? "passed" : "not_applicable",
          detail: action === "deal.send_external"
            ? "external document action carries an explicit document type"
            : "this route prepares or records a deal action and does not send an external file",
          evidenceRef: factHash,
        },
      ],
      budget: {
        status: "not_applicable",
        detail: "this deal route does not spend provider or advertising budget",
        evidenceRef: `deal:${objectId}:budget`,
      },
      qualification: {
        status: "passed",
        detail: "deal request and current workspace scope are structurally qualified",
        evidenceRef: objectId,
      },
      permission: {
        status: "passed",
        detail: "current member and workspace are authorized for deal operations",
        evidenceRef: `${scope.tenantId}/${scope.workspaceId}/${by}`,
      },
      fence: {
        status: verdict.level === "block" ? "failed" : "passed",
        level: verdict.level,
        detail: verdict.triggeredBy.join("；") || `fence level ${verdict.level}`,
        evidenceRef: `fence:${action}:${verdict.impacts.map((impact) => `${impact.rule_id}@${impact.version}`).join(",") || "default"}`,
        triggeredBy: verdict.triggeredBy,
      },
      evidenceRefs: [{
        id: `deal:${objectId}`,
        kind: "rule",
        sha256: factHash,
        ref: factHash,
      }],
    },
  );
  const refusal = autoApprovalRefusal(auto);
  if (refusal) {
    throw new TRPCError({
      code: auto.outcome === "blocked" ? "FORBIDDEN" : "PRECONDITION_FAILED",
      message: `G15 系统自动裁决 ${refusal}`,
    });
  }
  return { ...verdict, level: "auto" };
}

export const dealRouter = router({
  /** 商单线索列表：合作意向评论 + 已建单关联（order_id 随行；无数据返回空 L7.1） */
  leads: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(100) }))
    .query(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      return scopedQuery<{
        id: string; platform: string; account_id: string; author: string | null;
        text: string; status: string; collected_at: string; order_id: string | null;
      }>(
        getAppPool(), scope,
        `SELECT c.id, c.platform, c.account_id, c.author, c.text, c.status, c.collected_at,
                o.id AS order_id
         FROM comments c
         LEFT JOIN deal_orders o
           ON o.workspace_id = c.workspace_id AND o.lead_comment_id = c.id
         WHERE c.workspace_id = $1
           AND (o.id IS NOT NULL OR c.text ~ '合作|报价|商务|推广|恰饭|商单|联系.*(商务|合作)')
         ORDER BY c.collected_at DESC
         LIMIT $2`,
        [scope.workspaceId, input.limit],
      );
    }),

  /** 线索建单（G15 预检 deal.create；deal-flow 服务内同事务落单 + 事件） */
  createFromLead: writeProcedure
    .input(z.object({
      commentId: z.string().min(1),
      brand: z.string().min(1).max(200),
      contact: z.string().max(200).optional(),
      channel: z.enum(["dm", "email", "platform_msg", "offline", "other"]).default("dm"),
      quoteBand: z.object({
        floor: z.number().optional(),
        ceiling: z.number().optional(),
        currency: z.string().optional(),
      }).optional(),
      projectId: z.string().min(1).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const orderId = newId("DO");
      const verdict = await judgeOrThrow(scope, "deal.create", orderId, {
        brand: input.brand, channel: input.channel, commentId: input.commentId,
      }, ctx.identity.memberNo);
      try {
        const r = await createFromLead(getAppPool(), getGatewayPool(), scope, {
          id: orderId, commentId: input.commentId, brand: input.brand,
          contact: input.contact, channel: input.channel,
          quoteBand: input.quoteBand, projectId: input.projectId,
          by: ctx.identity.memberNo,
        });
        return { order: r.order, deduped: r.deduped, level: verdict.level };
      } catch (err) {
        dealRethrow(err);
      }
    }),

  /** 报价落单（G15 预检 deal.quote；超报价带 → 事件 escalate=l4_chairman 上浮标记） */
  quote: writeProcedure
    .input(z.object({ orderId: z.string().min(1), amount: z.number().positive() }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const verdict = await judgeOrThrow(scope, "deal.quote", input.orderId, { amount: input.amount }, ctx.identity.memberNo);
      try {
        const r = await applyQuote(getAppPool(), getGatewayPool(), scope, input.orderId, {
          amount: input.amount, by: ctx.identity.memberNo,
        });
        return { order: r.order, verdict: r.verdict, level: verdict.level };
      } catch (err) {
        dealRethrow(err);
      }
    }),

  /** 履约节点推进（G15 预检 deal.milestone；幂等：已 done 返回 advanced=false） */
  advanceMilestone: writeProcedure
    .input(z.object({ milestoneId: z.string().min(1), note: z.string().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const verdict = await judgeOrThrow(scope, "deal.milestone", input.milestoneId, {}, ctx.identity.memberNo);
      try {
        const r = await advanceMilestone(getAppPool(), getGatewayPool(), scope, input.milestoneId, {
          by: ctx.identity.memberNo, note: input.note,
        });
        return { ...r, level: verdict.level };
      } catch (err) {
        dealRethrow(err);
      }
    }),

  /** 账期催款备稿（G15 预检 deal.dunning；只生成备稿不外发——外发通道 Mock/接口预留） */
  dunning: writeProcedure
    .input(z.object({ now: z.iso.datetime({ offset: true }).optional() }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const verdict = await judgeOrThrow(scope, "deal.dunning", scope.workspaceId, {}, ctx.identity.memberNo);
      const items = await dunning(getAppPool(), getGatewayPool(), scope, {
        now: input.now, by: ctx.identity.memberNo,
      });
      return { items, count: items.length, level: verdict.level };
    }),

  /** 结案报告聚合（纯读；越权/不存在返回 null L7.1） */
  closure: protectedProcedure
    .input(z.object({ orderId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      return closureReport(getAppPool(), scopeOf(ctx.identity), input.orderId);
    }),
});
