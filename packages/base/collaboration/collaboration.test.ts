/**
 * 协作底座纯逻辑测试：契约状态机 / 事件归约 / 决策配额 / 组合汇总与叙事。
 * DB 读写在 apps/server/src/service/collaboration.ts，由真库套件覆盖。
 */
import { describe, expect, it } from "vitest";
import { advanceContractStatus, reduceContractStatus } from "./contract.js";
import { buildDecisionPacket } from "./quota.js";
import { buildPortfolio, composeNarrative } from "./portfolio.js";
import type { DecisionItem } from "./schema.js";

describe("任务契约状态机", () => {
  it("标准链路 draft→offered→accepted→in_progress→delivered→verified→settled", () => {
    let s = "draft" as const;
    for (const action of ["offer", "accept", "start", "deliver", "verify", "settle"] as const) {
      const r = advanceContractStatus(s, action);
      expect(r.ok).toBe(true);
      if (r.ok) s = r.status;
    }
    expect(s).toBe("settled");
  });

  it("非法迁移被拒且给出原因（不允许跳步）", () => {
    const r = advanceContractStatus("draft", "start");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("不允许");
    expect(advanceContractStatus("settled", "cancel").ok).toBe(false);
  });

  it("从事件流归约状态：contract.create → offer → accept", () => {
    const s = reduceContractStatus([
      { action: "contract.create" },
      { action: "contract.offer" },
      { action: "contract.accept" },
    ]);
    expect(s).toBe("accepted");
    expect(reduceContractStatus([])).toBeNull();
  });

  it("审计加固：伪造的 after.status 不能跳过状态机（offer 声明 settled 仍为 offered；draft 直接 settle 无效）", () => {
    expect(reduceContractStatus([
      { action: "contract.create" },
      { action: "contract.offer", after: { status: "settled" } },
    ])).toBe("offered");
    expect(reduceContractStatus([
      { action: "contract.create" },
      { action: "contract.settle" },
    ])).toBe("draft");
  });
});

describe("决策信箱 ≤7 配额", () => {
  const item = (id: string, tier: DecisionItem["tier"], risk: number, deadline: string | null, createdAt: string): DecisionItem => ({
    id, title: `事项 ${id}`, tier, risk, deadline, createdAt,
  });

  it("按层级→截止→风险→先来后到排序，超出配额进 overflow", () => {
    const items = [
      item("a", "l2_captain", 1, null, "2026-09-19T00:00:00Z"),
      item("b", "l4_chairman", 2, null, "2026-09-19T00:00:01Z"),
      item("c", "l3_fleet", 9, "2026-09-19T12:00:00Z", "2026-09-19T00:00:02Z"),
      item("d", "l4_chairman", 5, "2026-09-19T09:00:00Z", "2026-09-19T00:00:03Z"),
      item("e", "l4_chairman", 5, "2026-09-19T09:00:00Z", "2026-09-19T00:00:00Z"),
      item("f", "l3_fleet", 1, null, "2026-09-19T00:00:04Z"),
      item("g", "l2_captain", 3, null, "2026-09-19T00:00:05Z"),
      item("h", "l2_captain", 0, null, "2026-09-19T00:00:06Z"),
      item("i", "l2_captain", 0, null, "2026-09-19T00:00:07Z"),
      item("j", "l2_captain", 0, null, "2026-09-19T00:00:08Z"),
    ];
    const p = buildDecisionPacket(items, 7);
    expect(p.items).toHaveLength(7);
    expect(p.overflowCount).toBe(3);
    // l4 优先；同为 l4 时早截止优先；再同则风险高优先；再同则先来先办（e 早于 d）
    expect(p.items.slice(0, 3).map((x) => x.id)).toEqual(["e", "d", "b"]);
    expect(p.items[3]!.id).toBe("c");
  });

  it("配额必须为正整数", () => {
    expect(() => buildDecisionPacket([], 0)).toThrow(/配额/);
    expect(() => buildDecisionPacket([], 1.5)).toThrow(/配额/);
  });

  it("非法截止时间不破坏排序稳定性（排到最后，且其余顺序不变）", () => {
    const items = [
      item("bad", "l4_chairman", 5, "not-a-date", "2026-09-19T00:00:00Z"),
      item("ok1", "l4_chairman", 5, "2026-09-19T09:00:00Z", "2026-09-19T00:00:01Z"),
      item("ok2", "l4_chairman", 5, "2026-09-19T10:00:00Z", "2026-09-19T00:00:02Z"),
    ];
    const p = buildDecisionPacket(items, 7);
    expect(p.items.map((x) => x.id)).toEqual(["ok1", "ok2", "bad"]);
  });
});

describe("组合汇总与数字人叙事", () => {
  const portfolio = buildPortfolio([
    { domain: "growth", label: "获客增长", agents: 9, pending: 2, actions7d: 40, redLines7d: 0 },
    { domain: "content", label: "内容与视频", agents: 30, pending: 1, actions7d: 120, redLines7d: 1 },
    { domain: "hotel", label: "酒店运营", agents: 16, pending: 0, actions7d: 60, redLines7d: 0 },
  ]);

  it("totals 逐项求和", () => {
    expect(portfolio.totals).toEqual({ agents: 55, pending: 3, actions7d: 220, redLines7d: 1 });
  });

  it("叙事只陈述事实；缺北极星标待接入，不编数", () => {
    const packet = buildDecisionPacket([
      { id: "x", title: "报价审批", tier: "l4_chairman", risk: 3, deadline: null, createdAt: "2026-09-19T00:00:00Z" },
    ], 7);
    const text = composeNarrative({ workspaceName: "云栖酒店", portfolio, packet });
    expect(text).toContain("云栖酒店");
    expect(text).toContain("55 人");
    expect(text).toContain("拍板 1 件");
    expect(text).toContain("待接入");
  });
});
