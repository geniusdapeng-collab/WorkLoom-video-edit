/**
 * 经营宪章自治边界契约单测（纯函数，无 PG）。
 *
 * 回归背景（2026-09-18 审计）：三端 seed 与 captain.grant 接口曾用平铺旧形状
 * （price_band / procurement_cap / campaign_cap），而 charterSchema.autonomy 是
 * .strict() 的 ranges/caps/lists 结构 —— parseCharter 会静默回落默认宪章，
 * 结果是"种子写了 trial + 5000 上限，运行期却是 disabled + 无上限"，
 * 所有金额决策被误判为重大决策；前端 P21 签署也会因接口 schema 不匹配而 400。
 * 本测试把形状契约钉死，防止再次分叉。
 */
import { describe, expect, it } from "vitest";
import { defaultCharter, effectiveAutonomy, parseCharter, tightenAutonomy } from "./charter.js";

/** 三端 seed 使用的规范形状（键名沿用产品词汇：price_quote_band / procurement_cap …） */
const canonical = () => ({
  version: 2,
  mode: "trial",
  identity: { name: "公司CEO", persona: "酒店经营型" },
  autonomy: {
    ranges: { price_quote_band: { label: "调价相对基准区间", lower: 0.85, upper: 1.15, anchor: 1 } },
    caps: {
      procurement_cap: { label: "单笔采购上限", limit: 5000 },
      campaign_cap: { label: "单次活动预算上限", limit: 2000 },
    },
    lists: { reply_auto_scope: ["夸赞", "感谢"] },
  },
});

describe("宪章自治边界：规范形状原值保留", () => {
  it("ranges/caps/lists 全量解析，不被静默丢弃", () => {
    const c = parseCharter(canonical());
    expect(c.mode).toBe("trial");
    expect(c.autonomy.caps["procurement_cap"]?.limit).toBe(5000);
    expect(c.autonomy.caps["campaign_cap"]?.limit).toBe(2000);
    expect(c.autonomy.ranges["price_quote_band"]).toMatchObject({ lower: 0.85, upper: 1.15, anchor: 1 });
    expect(c.autonomy.lists["reply_auto_scope"]).toEqual(["夸赞", "感谢"]);
  });

  it("缺省自治为三段空结构（ranges/caps/lists 齐备，不留 undefined）", () => {
    expect(defaultCharter().autonomy).toEqual({ ranges: {}, caps: {}, lists: {} });
  });
});

describe("宪章自治边界：旧形状必须失败关闭", () => {
  it("平铺旧形状被 .strict() 拒绝 → 回落默认宪章（disabled + 空自治）", () => {
    const legacy = {
      version: 2, mode: "trial",
      autonomy: { price_band: [0.85, 1.15], procurement_cap: 5000, campaign_cap: 2000 },
    };
    const parsed = parseCharter(legacy);
    expect(parsed.mode).toBe("disabled");
    expect(parsed.autonomy).toEqual({ ranges: {}, caps: {}, lists: {} });
  });

  it("ranges 越界（lower ≤ anchor ≤ upper 不成立）整段拒绝，不半信半疑地采用", () => {
    const bad = {
      mode: "trial",
      autonomy: { ranges: { price_quote_band: { label: "越界", lower: 1.2, upper: 1.5, anchor: 1 } } },
    };
    expect(parseCharter(bad).mode).toBe("disabled");
  });
});

describe("自治边界降档（试用期与熔断收紧）", () => {
  it("试用期：上限减半、区间向锚点收窄（anchor 不变）", () => {
    const eff = effectiveAutonomy(parseCharter(canonical()));
    expect(eff.caps["procurement_cap"]?.limit).toBe(2500);
    expect(eff.caps["campaign_cap"]?.limit).toBe(1000);
    expect(eff.ranges["price_quote_band"]).toMatchObject({ lower: 0.925, upper: 1.075, anchor: 1 });
  });

  it("熔断收紧：在已生效边界上再收一档，且不产生越界区间", () => {
    const tightened = tightenAutonomy(parseCharter(canonical()));
    expect(tightened.autonomy.caps["procurement_cap"]?.limit).toBe(2500);
    const range = tightened.autonomy.ranges["price_quote_band"]!;
    expect(range.lower).toBeLessThanOrEqual(range.anchor);
    expect(range.anchor).toBeLessThanOrEqual(range.upper);
  });
});
