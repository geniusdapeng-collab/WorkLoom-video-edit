import type { ContractStatus } from "./schema.js";
import { CONTRACT_STATUSES } from "./schema.js";

/** 契约动作（事件 action = contract.<动作>） */
export const CONTRACT_ACTIONS = ["offer", "accept", "start", "deliver", "verify", "settle", "cancel"] as const;
export type ContractAction = (typeof CONTRACT_ACTIONS)[number];

const TRANSITIONS: Record<ContractAction, { from: readonly ContractStatus[]; to: ContractStatus }> = {
  offer: { from: ["draft"], to: "offered" },
  accept: { from: ["offered"], to: "accepted" },
  start: { from: ["accepted"], to: "in_progress" },
  deliver: { from: ["in_progress"], to: "delivered" },
  verify: { from: ["delivered"], to: "verified" },
  settle: { from: ["verified"], to: "settled" },
  cancel: { from: ["draft", "offered", "accepted", "in_progress", "delivered", "verified"], to: "cancelled" },
};

export type AdvanceResult = { ok: true; status: ContractStatus } | { ok: false; reason: string };

/** 校验一次状态迁移；非法迁移返回原因，不抛异常（由调用方决定拒绝策略） */
export function advanceContractStatus(current: ContractStatus, action: ContractAction): AdvanceResult {
  const t = TRANSITIONS[action];
  if (!t) return { ok: false, reason: `未知契约动作 ${action}` };
  if (!t.from.includes(current)) return { ok: false, reason: `状态 ${current} 不允许动作 ${action}` };
  return { ok: true, status: t.to };
}

export interface ContractEventLike {
  action: string;
  after?: { status?: string } | null;
}

/**
 * 由事件流归约契约当前状态（事件溯源读模型）。
 * 只认 contract.* 动作；无事件返回 null（契约不存在）。
 *
 * 审计加固：**不信任事件里声明的 after.status**。状态只能由合法迁移推进；
 * 声明值与迁移结果一致时才采纳（兼容历史写法），不一致时以迁移结果为准——
 * 防止伪造/错写的事件把契约直接"跳"到 settled。
 */
export function reduceContractStatus(events: readonly ContractEventLike[]): ContractStatus | null {
  let status: ContractStatus | null = null;
  for (const ev of events) {
    const action = ev.action.startsWith("contract.") ? ev.action.slice("contract.".length) : ev.action;
    if (action === "create") {
      status = "draft";
      continue;
    }
    if (!(CONTRACT_ACTIONS as readonly string[]).includes(action)) continue;
    const declared = ev.after?.status;
    if (status) {
      const next = advanceContractStatus(status, action as ContractAction);
      if (next.ok) {
        status = declared === next.status && (CONTRACT_STATUSES as readonly string[]).includes(declared)
          ? declared as ContractStatus
          : next.status;
      }
    }
  }
  return status;
}
