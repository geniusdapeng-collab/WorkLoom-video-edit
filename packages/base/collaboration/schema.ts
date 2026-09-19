import { z } from "zod";

/** 协作五模式（与《规模化协作设计》§2 同口径） */
export const COLLABORATION_MODES = ["m1_single", "m2_pipeline", "m3_blackboard", "m4_contract", "m5_campaign"] as const;
export type CollaborationMode = (typeof COLLABORATION_MODES)[number];

/** 任务契约状态机（draft→offered→accepted→in_progress→delivered→verified→settled；任意未结状态可 cancel） */
export const CONTRACT_STATUSES = ["draft", "offered", "accepted", "in_progress", "delivered", "verified", "settled", "cancelled"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const TaskContractSchema = z.object({
  id: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  goal: z.string().min(1).max(2000),
  requester: z.string().min(1).max(120),
  assigneePreset: z.string().min(1).max(120),
  verifierPreset: z.string().min(1).max(120),
  successCriteria: z.array(z.string().min(1).max(300)).min(1).max(20),
  budgetAmount: z.number().nonnegative().default(0),
  currency: z.string().min(1).max(8).default("CNY"),
  deadline: z.string().max(40).nullable().default(null),
  mode: z.enum(COLLABORATION_MODES),
  status: z.enum(CONTRACT_STATUSES).default("draft"),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type TaskContract = z.infer<typeof TaskContractSchema>;

export const HandoffReceiptSchema = z.object({
  id: z.string().min(1).max(120),
  contractId: z.string().min(1).max(120),
  from: z.string().min(1).max(120),
  to: z.string().min(1).max(120),
  summary: z.string().min(1).max(1000),
  evidence: z.array(z.string().min(1).max(300)).max(50).default([]),
  qualityFlags: z.array(z.string().min(1).max(80)).max(20).default([]),
  createdAt: z.string().min(1),
});
export type HandoffReceipt = z.infer<typeof HandoffReceiptSchema>;

export const DECISION_TIERS = ["l2_captain", "l3_fleet", "l4_chairman"] as const;
export type DecisionTier = (typeof DECISION_TIERS)[number];

export interface DecisionItem {
  id: string;
  title: string;
  tier: DecisionTier;
  risk: number;
  deadline: string | null;
  createdAt: string;
  action?: string;
  objectType?: string;
  objectId?: string;
}

export interface DecisionPacket {
  quota: number;
  items: DecisionItem[];
  overflow: DecisionItem[];
  overflowCount: number;
}

export interface ObjectState {
  objectType: string;
  objectId: string;
  version: number;
  state: Record<string, unknown>;
  owner: string | null;
  updatedAt: string;
  lastEventId: string;
}

export interface PortfolioDomain {
  domain: string;
  label: string;
  agents: number;
  pending: number;
  actions7d: number;
  redLines7d: number;
}

export interface PortfolioSummary {
  domains: PortfolioDomain[];
  totals: { agents: number; pending: number; actions7d: number; redLines7d: number };
}
