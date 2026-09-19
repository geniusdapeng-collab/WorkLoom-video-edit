/**
 * base/captain · 多 Agent 冲突仲裁 v0（S7）
 *
 * 适用：预算再分配、排期/资源、归因归属三类冲突（多 Agent 对同一资源给出不同方案）。
 * 规则（按序执行，硬边界优先）：
 *   ① 硬边界：涉钱 / 对外承诺 / 超自治带 → escalate（L4），不得自动裁决；
 *   ② 证据强度：confirmed > reported > inferred，最高者胜（grant）；
 *   ③ 同强度：归因贡献差 ≥10% 才可判（高者胜）；差值不足视为不可仲裁；
 *   ④ 仍不能决 → escalate，附双语备忘录（两个方案 + 明确建议）。
 * 说明：本函数只做裁决建议与留痕文本；执行仍走既有治理链（含围栏与审批）。
 */

export type ConflictType = "budget" | "schedule" | "attribution";
export type EvidenceStrength = "confirmed" | "reported" | "inferred";

export interface ConflictParty {
  agent: string;
  proposal: string;
  evidence: EvidenceStrength;
  /** 归因贡献（0–1，可缺省；仅用于同强度时的比较） */
  contribution?: number;
}

export interface Conflict {
  type: ConflictType;
  domain: string;
  summary: string;
  parties: ConflictParty[];
  involvesMoney?: boolean;
  involvesCommitment?: boolean;
  overBand?: boolean;
}

export interface ArbitrationOutcome {
  verdict: "grant" | "escalate";
  winner?: string;
  rationale: string;
  memo: string;
}

const EVIDENCE_RANK: Record<EvidenceStrength, number> = { confirmed: 3, reported: 2, inferred: 1 };
const CONTRIBUTION_GAP = 0.1;

export function arbitrate(conflict: Conflict): ArbitrationOutcome {
  if (conflict.parties.length < 2) {
    throw new Error("冲突仲裁至少需要两方提案");
  }
  if (conflict.involvesMoney || conflict.involvesCommitment || conflict.overBand) {
    const reason = conflict.overBand ? "超自治带" : conflict.involvesMoney ? "涉钱" : "涉对外承诺";
    return {
      verdict: "escalate",
      rationale: `硬边界（${reason}）：一律升级 L4 人审，AI 不自动裁决`,
      memo: arbitrationMemo(conflict, "按硬边界升级董事长裁决"),
    };
  }
  const ranked = [...conflict.parties].sort((a, b) => EVIDENCE_RANK[b.evidence] - EVIDENCE_RANK[a.evidence]);
  const top = ranked[0]!;
  const second = ranked[1]!;
  if (EVIDENCE_RANK[top.evidence] > EVIDENCE_RANK[second.evidence]) {
    return {
      verdict: "grant",
      winner: top.agent,
      rationale: `证据强度胜出：${top.agent}（${top.evidence}）> ${second.agent}（${second.evidence}）`,
      memo: arbitrationMemo(conflict, `采纳 ${top.agent} 方案（证据强度优先）`),
    };
  }
  const cTop = top.contribution ?? 0;
  const cSecond = second.contribution ?? 0;
  if (Math.abs(cTop - cSecond) >= CONTRIBUTION_GAP) {
    const winner = cTop > cSecond ? top : second;
    const loser = cTop > cSecond ? second : top;
    return {
      verdict: "grant",
      winner: winner.agent,
      rationale: `同证据强度，归因贡献差 ≥${CONTRIBUTION_GAP}：${winner.agent}（${Math.round(Math.max(cTop, cSecond) * 100)}%）> ${loser.agent}（${Math.round(Math.min(cTop, cSecond) * 100)}%）`,
      memo: arbitrationMemo(conflict, `采纳 ${winner.agent} 方案（归因贡献优先）`),
    };
  }
  return {
    verdict: "escalate",
    rationale: `证据强度同级且归因贡献差 <${CONTRIBUTION_GAP}：不可自动仲裁，升级 L4`,
    memo: arbitrationMemo(conflict, "不可仲裁：请在两方案间拍板"),
  };
}

/** 双语（中英）决策备忘录：两个方案 + 明确建议（升级场景使用）。 */
export function arbitrationMemo(conflict: Conflict, recommendation: string): string {
  const options = conflict.parties
    .map((p, i) => `方案 ${String.fromCharCode(65 + i)}（${p.agent}）：${p.proposal}〔证据：${p.evidence}${p.contribution !== undefined ? `，贡献 ${Math.round(p.contribution * 100)}%` : ""}〕`)
    .join("\n");
  return [
    `【冲突裁决备忘录 · ${conflict.domain} / ${conflict.type}】`,
    conflict.summary,
    options,
    `建议：${recommendation}`,
    "Situation / Options / Recommendation — WorkLoom Captain Arbitration v0",
  ].join("\n");
}
