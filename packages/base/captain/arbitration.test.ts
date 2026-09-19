/**
 * S7 多 Agent 冲突仲裁 · 规则单测（硬边界 / 证据强度 / 归因贡献 / 不可仲裁升级）。
 */
import { describe, expect, it } from "vitest";
import { arbitrate, type Conflict } from "./arbitration.js";

const base = (over: Partial<Conflict> = {}): Conflict => ({
  type: "budget",
  domain: "投放",
  summary: "增长负责人与投放组合经理对下周预算分配方案不一致",
  parties: [
    { agent: "growth-lead", proposal: "把 60% 给信源建设", evidence: "reported", contribution: 0.7 },
    { agent: "media-portfolio-manager", proposal: "把 60% 给投放放量", evidence: "reported", contribution: 0.55 },
  ],
  ...over,
});

describe("S7 仲裁", () => {
  it("硬边界：涉钱/承诺/超带一律升级 L4", () => {
    expect(arbitrate(base({ involvesMoney: true })).verdict).toBe("escalate");
    expect(arbitrate(base({ involvesCommitment: true })).memo).toContain("冲突裁决备忘录");
    expect(arbitrate(base({ overBand: true })).rationale).toContain("硬边界");
  });

  it("证据强度优先：confirmed 胜过 reported", () => {
    const r = arbitrate(base({
      parties: [
        { agent: "a", proposal: "A 案", evidence: "confirmed", contribution: 0.4 },
        { agent: "b", proposal: "B 案", evidence: "reported", contribution: 0.9 },
      ],
    }));
    expect(r.verdict).toBe("grant");
    expect(r.winner).toBe("a");
    expect(r.rationale).toContain("证据强度");
  });

  it("同证据强度：归因贡献差 ≥10% 可裁", () => {
    const r = arbitrate(base());
    expect(r.verdict).toBe("grant");
    expect(r.winner).toBe("growth-lead");
  });

  it("差值不足：不可自动仲裁，升级并保留两方案", () => {
    const r = arbitrate(base({
      parties: [
        { agent: "a", proposal: "A 案", evidence: "reported", contribution: 0.6 },
        { agent: "b", proposal: "B 案", evidence: "reported", contribution: 0.55 },
      ],
    }));
    expect(r.verdict).toBe("escalate");
    expect(r.memo).toContain("方案 A");
    expect(r.memo).toContain("方案 B");
  });

  it("排期冲突使用同一规则（单一裁决器，不为冲突类型另设权力）", () => {
    const r = arbitrate(base({
      type: "schedule",
      domain: "内容排期",
      parties: [
        { agent: "production-planner", proposal: "拍摄日排 3 条", evidence: "inferred" },
        { agent: "live-producer", proposal: "拍摄日让给直播", evidence: "inferred" },
      ],
    }));
    expect(r.verdict).toBe("escalate");
  });
});
