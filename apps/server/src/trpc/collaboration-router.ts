/**
 * collaboration router —— 协作底座数据面（对象读模型 / 任务契约 / 交接回执 / 决策配额 / 组合看板 / 数字人叙事）
 * 纪律：全部走 RLS 上下文（service 层）；写动作落五元事件（contract.* / receipt.record）。
 */
import { z } from "zod";
import { protectedProcedure, router, scopeOf, writeProcedure } from "./context.js";
import {
  advanceContract, createContract, decisionPacket, fleetNarrative, getContract,
  listContracts, listReceipts, objectChanges, objectState, portfolioSummary, recordReceipt,
} from "../service/collaboration.js";

const actorOf = (ctx: { identity: { memberNo: string } }) => ({ id: ctx.identity.memberNo, type: "human" as const });

export const collaborationRouter = router({
  objects: router({
    /** 对象读模型：某业务对象的当前状态（最新事件投影） */
    state: protectedProcedure
      .input(z.object({ type: z.string().trim().min(1).max(80), id: z.string().trim().min(1).max(160) }))
      .query(async ({ ctx, input }) => objectState(scopeOf(ctx.identity).workspaceId, input.type, input.id)),
    /** 最近变更流：每个对象最新一条事件 */
    changes: protectedProcedure
      .input(z.object({ limit: z.number().int().min(1).max(100).optional() }).optional())
      .query(async ({ ctx, input }) => objectChanges(scopeOf(ctx.identity).workspaceId, input?.limit ?? 20)),
  }),
  contracts: router({
    list: protectedProcedure.query(async ({ ctx }) => listContracts(scopeOf(ctx.identity).workspaceId)),
    get: protectedProcedure
      .input(z.object({ id: z.string().trim().min(1).max(120) }))
      .query(async ({ ctx, input }) => getContract(scopeOf(ctx.identity).workspaceId, input.id)),
    create: writeProcedure
      .input(z.object({
        title: z.string().trim().min(1).max(200),
        goal: z.string().trim().min(1).max(2000),
        assigneePreset: z.string().trim().min(1).max(120),
        verifierPreset: z.string().trim().min(1).max(120),
        successCriteria: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
        budgetAmount: z.number().nonnegative().optional(),
        currency: z.string().trim().min(1).max(8).optional(),
        deadline: z.string().trim().max(40).nullable().optional(),
        mode: z.enum(["m1_single", "m2_pipeline", "m3_blackboard", "m4_contract", "m5_campaign"]),
      }))
      .mutation(async ({ ctx, input }) => createContract(scopeOf(ctx.identity).workspaceId, actorOf(ctx), input)),
    advance: writeProcedure
      .input(z.object({
        id: z.string().trim().min(1).max(120),
        action: z.enum(["offer", "accept", "start", "deliver", "verify", "settle", "cancel"]),
      }))
      .mutation(async ({ ctx, input }) => advanceContract(scopeOf(ctx.identity).workspaceId, actorOf(ctx), input.id, input.action)),
  }),
  receipts: router({
    record: writeProcedure
      .input(z.object({
        contractId: z.string().trim().min(1).max(120),
        from: z.string().trim().min(1).max(120),
        to: z.string().trim().min(1).max(120),
        summary: z.string().trim().min(1).max(1000),
        evidence: z.array(z.string().trim().min(1).max(300)).max(50).optional(),
        qualityFlags: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
      }))
      .mutation(async ({ ctx, input }) => recordReceipt(scopeOf(ctx.identity).workspaceId, actorOf(ctx), input)),
    list: protectedProcedure
      .input(z.object({ contractId: z.string().trim().min(1).max(120).optional() }).optional())
      .query(async ({ ctx, input }) => listReceipts(scopeOf(ctx.identity).workspaceId, input?.contractId)),
  }),
  /** 决策信箱批次化：默认 ≤7 件，超出进 overflow（不丢弃） */
  packet: protectedProcedure
    .input(z.object({ quota: z.number().int().min(1).max(20).optional() }).optional())
    .query(async ({ ctx, input }) => decisionPacket(scopeOf(ctx.identity).workspaceId, input?.quota ?? 7)),
  /** 组合看板：按域聚合在编人数/待批/动作/红线 */
  portfolio: protectedProcedure.query(async ({ ctx }) => portfolioSummary(scopeOf(ctx.identity).workspaceId)),
  /** 数字人单一叙事：组合看板 + 决策包 */
  narrative: protectedProcedure.query(async ({ ctx }) => fleetNarrative(scopeOf(ctx.identity).workspaceId)),
});
