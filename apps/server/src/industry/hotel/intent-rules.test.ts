/**
 * 酒店服务前台业务意图单测（不触 DB）。
 *
 * 覆盖的是"业务对象识别"这一层的可验证行为契约：
 *   ① 业务对象（订单/会员/房型/工单进度）→ biz_query，且优先于疑问句判定
 *      （「我的会员积分还有多少」是查业务，不是问知识库）；
 *   ② 履约动作（报修/送物）→ service_request，但低于疑问句判定
 *      （「送站巴士几点发车」只问信息，不能建单）；
 *   ③ 投诉恒优先（行业扩展不得覆盖投诉）；
 *   ④ 非酒店业务对象（面膜/地铁站）不得被行业词表截获（行业扩展不吞通用问答）。
 */
import { describe, expect, it } from "vitest";
import { ruleBasedIntent } from "@workloom/base/service-dialog";
import { hotelIntentRules, hotelTicketKindOf } from "./intent-rules.js";

const classify = (text: string) => ruleBasedIntent(text, hotelIntentRules);

describe("酒店行业意图扩展：业务对象 → biz_query", () => {
  it.each([
    "查一下我的订单",
    "我的会员积分还有多少",
    "豪华大床房多少钱一晚",
    "我的工单进度怎么样了",
    "帮我看看去年 8 月的账单",
    "订单可以改期吗",
  ])("「%s」识别为业务查询", (text) => {
    expect(classify(text)).toBe("biz_query");
  });

  it("业务对象优先于疑问句标记：含「多少」的会员查询不能被降级为 kb_qa", () => {
    expect(classify("我的会员积分还有多少")).toBe("biz_query");
    expect(classify("会员等级怎么算")).toBe("biz_query");
  });
});

describe("酒店行业意图扩展：履约动作 → service_request", () => {
  it.each([
    "空调坏了，帮我修一下",
    "帮我送两瓶矿泉水",
    "房间要打扫一下",
  ])("「%s」识别为服务请求", (text) => {
    expect(classify(text)).toBe("service_request");
  });

  it("疑问句优先：问信息不建单（送站巴士/早餐时间）", () => {
    expect(classify("送站巴士几点发车")).toBe("kb_qa");
    expect(classify("早餐几点开始？收费吗")).toBe("kb_qa");
  });
});

describe("酒店行业意图扩展：优先级与边界", () => {
  it("投诉优先级最高，行业扩展不得覆盖", () => {
    expect(classify("我要投诉，我的订单被取消了")).toBe("complaint");
  });

  it("非酒店业务对象不被截获（行业词表不吞通用问答）", () => {
    // 无房型名词的通用询价仍走知识库
    expect(classify("面膜多少钱")).toBe("kb_qa");
    expect(classify("附近地铁站怎么走")).toBe("kb_qa");
    // 基座无行业扩展时的中立口径不受影响
    expect(ruleBasedIntent("查一下我的订单")).toBeNull();
  });

  it("扩展标识稳定且唯一（活动 Bundle 投影按 id 选中适配器）", () => {
    expect(hotelIntentRules.map((rule) => rule.id)).toEqual(["hotel.service-front-v1"]);
    expect(new Set(hotelIntentRules.map((rule) => rule.id)).size).toBe(hotelIntentRules.length);
  });
});

describe("工单类型判定（ticketKindOf 共用词表）", () => {
  it.each([
    ["空调坏了，帮我修一下", "repair"],
    ["马桶漏水", "repair"],
    ["帮我送两瓶矿泉水", "delivery"],
    ["换床单", "delivery"],
  ])("「%s」→ %s", (text, kind) => {
    expect(hotelTicketKindOf(text)).toBe(kind);
  });

  it("无履约动作 → null（由调用方决定兜底为 other）", () => {
    expect(hotelTicketKindOf("帮我安排一个安静点的房间")).toBeNull();
    expect(hotelTicketKindOf("早餐几点开始")).toBeNull();
  });
});
