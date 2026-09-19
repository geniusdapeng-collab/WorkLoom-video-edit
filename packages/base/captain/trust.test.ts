/**
 * 信任账户 v0 · 策略单测（含 S2「信任风暴」剧本：连续驳回 → 降档 → 恢复 → 升档）。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_TRUST_POLICY, evalDomainEvidence, type DomainEvidence } from "./trust.js";

const base = (over: Partial<DomainEvidence> = {}): DomainEvidence => ({
  domain: "价格",
  decisions: 0, approved: 0, rejected: 0, edited: 0, escalated: 0, incidents: 0,
  outcomes: { hit: 0, miss: 0, fail: 0 },
  ...over,
});

describe("信任账户 v0", () => {
  it("样本不足：一律维持观察（禁止按时间自动升档）", () => {
    const v = evalDomainEvidence(base({ decisions: 19, approved: 19, outcomes: { hit: 19, miss: 0, fail: 0 } }));
    expect(v.level).toBe("hold");
    expect(v.reasons.join()).toContain("样本");
  });

  it("证据达标：命中率 ≥60% 且批准率 ≥80% → 升档建议（需人批）", () => {
    const v = evalDomainEvidence(base({ decisions: 20, approved: 18, rejected: 2, outcomes: { hit: 13, miss: 5, fail: 2 } }));
    expect(v.level).toBe("up");
    expect(v.hitRate).toBeCloseTo(0.65, 2);
    expect(v.approveRate).toBeCloseTo(0.9, 2);
  });

  it("S2 信任风暴：连续驳回拉低批准率 → 降档；红线事故 → 立即降档并补考", () => {
    const storm = evalDomainEvidence(base({ decisions: 20, approved: 8, rejected: 12, outcomes: { hit: 10, miss: 6, fail: 4 } }));
    expect(storm.level).toBe("down");
    expect(storm.reasons.join()).toContain("跌破下限");
    const incident = evalDomainEvidence(base({ decisions: 30, approved: 30, outcomes: { hit: 29, miss: 1, fail: 0 }, incidents: 1 }));
    expect(incident.level).toBe("down");
    expect(incident.retakeRequired).toBe(true);
  });

  it("S2 恢复：连续证据回到达标区间 → 升档建议", () => {
    const recovered = evalDomainEvidence(base({ decisions: 24, approved: 21, rejected: 3, outcomes: { hit: 16, miss: 5, fail: 3 } }), DEFAULT_TRUST_POLICY);
    expect(recovered.level).toBe("up");
  });
});
