/**
 * 开户即托管 · 纯函数单测：影子对照报告聚合、文本结构与升级口径。
 * PG 全链路见 scripts/acceptance/onboarding.mts（acceptance:onboarding 门禁）。
 */
import { describe, expect, it } from "vitest";
import { buildShadowReport, type ShadowDecisionEvent } from "./onboarding.js";

const ev = (over: Partial<ShadowDecisionEvent> = {}): ShadowDecisionEvent => ({
  eventId: "E-1",
  action: "ceo.briefing",
  title: "晨报",
  outcome: "other",
  domain: "公司经营",
  ...over,
});

describe("buildShadowReport", () => {
  it("空窗口：零决策也产出可读报告（首登不空屏）", () => {
    const r = buildShadowReport([], { windowStart: "t0", windowEnd: "t1" });
    expect(r.version).toBe("shadow-report/v1");
    expect(r.totals.decisions).toBe(0);
    expect(r.text).toContain("本窗口暂无判断");
    expect(r.text).toContain("转正前不会产生任何对外动作");
  });

  it("聚合口径：按结果与域计数，上浮事项单列且截断到 5 条", () => {
    const events = [
      ev({ outcome: "approve", domain: "投放" }),
      ev({ outcome: "approve", domain: "投放" }),
      ev({ outcome: "escalate", domain: "内容", title: "品牌表态需拍板 1" }),
      ev({ outcome: "escalate", domain: "内容", title: "品牌表态需拍板 2" }),
      ev({ outcome: "block", domain: "信源", title: "事实红线阻断" }),
      ev({ outcome: "escalate", domain: "内容", title: "上浮 3" }),
      ev({ outcome: "escalate", domain: "内容", title: "上浮 4" }),
      ev({ outcome: "escalate", domain: "内容", title: "上浮 5" }),
      ev({ outcome: "escalate", domain: "内容", title: "上浮 6" }),
    ];
    const r = buildShadowReport(events, { workspaceName: "获客用增演示", windowStart: "t0", windowEnd: "t1" });
    expect(r.totals.decisions).toBe(9);
    expect(r.totals.byOutcome.approve).toBe(2);
    expect(r.totals.byOutcome.escalate).toBe(6);
    expect(r.totals.byDomain["投放"]).toBe(2);
    expect(r.escalations.length).toBe(5);
    expect(r.text).toContain("获客用增演示");
    expect(r.text).toContain("上浮 6");
    expect(r.text).toContain("通过 2");
    expect(r.text).toContain("阻断 1");
  });

  it("无升级事项时给出明确空态文案（不制造焦虑）", () => {
    const r = buildShadowReport([ev({ outcome: "approve" })], { windowStart: "t0", windowEnd: "t1" });
    expect(r.text).toContain("没有需要你拍板的事项");
  });
});
