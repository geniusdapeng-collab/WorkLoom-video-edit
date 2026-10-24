/**
 * portrait-decision —— 定妆照门的“谁能做决定”口径（T-2026-1001-0007）。
 *
 * 背景（真机 2026-10-01）：同一批 8 张定妆照，机器像不像判据实测出现 92 / 15 / 86 三种结论，
 * 而机器监制还给出过 score=86 的“打回”。若让机器记录成为放行/否决依据，就会反复重做并烧钱。
 *
 * 口径：所有者视觉验收或已存在的明确用途授权才是决策来源；代录用途授权不声称所有者看过原图。
 * 机器监制/像不像记录只作留证，永远不参与放行判定。
 */
import { explicitPortraitGateIssues, hasExplicitPortraitAuthorization } from "./portrait-owner-authorization.js";
export interface PortraitDecisionRecord {
  stepKey?: string;
  projectId?: string;
  approved?: boolean | null;
  via?: string | null;
  sourceStage?: string | null;
  at?: string | null;
  score?: number | null;
  reason?: string | null;
  evidence?: { basis?: string | null; [key: string]: unknown } | null;
}

export type PortraitDecisionKind = "human" | "machine" | "none" | "invalid";

export interface PortraitDecision {
  kind: PortraitDecisionKind;
  /** 只有人类验收记录才是决策来源 */
  decisive: boolean;
  /** 人类明确否决；机器记录永远不返回 true（机器不得否决定妆照） */
  blocking: boolean;
  detail: string;
}

const HUMAN_VIAS = new Set(["owner-acceptance", "human"]);

/** 账本追加顺序为准：同一角色版本最新的人类决策优先，后来的机器留证不能覆盖它。 */
export function selectPortraitDecisionRecord<T extends PortraitDecisionRecord>(records: T[], projectId: string): T | null {
  const scoped = records.filter((entry) => entry.stepKey === "g5-portrait-confirm" && entry.projectId === projectId);
  for (let index = scoped.length - 1; index >= 0; index--) {
    if (assessPortraitDecision(scoped[index]).decisive) return scoped[index]!;
  }
  return scoped.at(-1) ?? null;
}

/**
 * 纯函数：把一条门账本/评审记录翻译成决策语义。
 * 兼容旧记录：只有 `approved=true` 或显式 `basis=human-review` 的 owner-acceptance 记录才算人类决策；
 * 旧版“机器判据把 owner-acceptance 也标成 approved=false”的记录按机器留证处理，不再阻断。
 */
export function assessPortraitDecision(record: PortraitDecisionRecord | null | undefined): PortraitDecision {
  if (!record) {
    return {
      kind: "none",
      decisive: false,
      blocking: false,
      detail: "无人类验收记录；机器评审判据不构成放行依据",
    };
  }
  const via = String(record.via ?? "").trim().toLowerCase();
  const sourceStage = String(record.sourceStage ?? "").trim().toLowerCase();
  const at = record.at ? `（${record.at}）` : "";
  const basis = String(record.evidence?.basis ?? "").trim().toLowerCase();
  const humanVia = HUMAN_VIAS.has(via) && (!sourceStage || HUMAN_VIAS.has(sourceStage));
  const invalid = (detail: string): PortraitDecision => ({ kind: "invalid", decisive: true, blocking: true, detail: `所有者决定证据无效${at}：${detail}` });
  if (hasExplicitPortraitAuthorization(record)) {
    const issues = explicitPortraitGateIssues(record);
    if (issues.length) return invalid(issues.join("；"));
    const authorization = record.evidence!.authorization as { decisionOwner: string; recordedBy: string };
    return { kind: "human", decisive: true, blocking: false,
      detail: `所有者既有用途授权${at}（决策人：${authorization.decisionOwner}；代录执行人：${authorization.recordedBy}；不代表人类逐图视觉验收）` };
  }
  // Only absent legacy basis and the known human-review basis enter the historical compatibility branch.
  if ((HUMAN_VIAS.has(via) || HUMAN_VIAS.has(sourceStage)) && basis && basis !== "human-review") return invalid(`未知授权依据 ${basis}`);
  if (humanVia && (record.evidence?.advisory === true || record.evidence?.decisionPolicy === "machine-evidence-only")) return invalid("机器留证不能伪装为所有者决定");
  const humanBasis = basis === "human-review";
  const humanDecisive = humanVia && (humanBasis || record.approved === true);
  if (humanDecisive) {
    const rejected = record.approved === false;
    return {
      kind: "human",
      decisive: true,
      blocking: rejected,
      detail: rejected
        ? `人类验收${at}明确否决（approval=false）`
        : `人类验收放行${at}（via=${via || sourceStage || "owner-acceptance"}）`,
    };
  }
  if (humanVia) {
    return {
      kind: "machine",
      decisive: false,
      blocking: false,
      detail: `旧版 machine-gated owner-acceptance 记录${at}（approval=${record.approved === true ? "true" : "false"}）`
        + "——按机器留证处理，不参与放行；请用 portrait-agent accept 重新记录人类验收",
    };
  }
  return {
    kind: "machine",
    decisive: false,
    blocking: false,
    detail: `机器评审留证${at}（机器意见：${record.approved === false ? "不合格" : "合格"}`
      + `${record.score === null || record.score === undefined ? "" : `，score=${record.score}`}）——不参与放行，决策交人类`,
  };
}
