import { describe, expect, it } from "vitest";
import {
  auditAttention, cardFitsSafeArea, detectAttentionKeywords, findGaps, planAttention, planAttentionSfx,
  type AttentionEvent, type AttentionWord,
} from "./attention.js";

/** 造词级逐字稿：把一段文本按 0.25s/字 铺开（够用即可，关键是跨词匹配与时间映射） */
function words(text: string, start = 0, step = 0.25): AttentionWord[] {
  return [...text].map((char, index) => ({
    text: char,
    start: Number((start + index * step).toFixed(3)),
    end: Number((start + (index + 1) * step).toFixed(3)),
  }));
}

describe("edit/attention：关键词锚点", () => {
  it("阿拉伯数字与中文数量都能跨词命中（12个维度 / 一两块钱 / 一两个小时）", () => {
    const transcript = words("有12个维度吧一条片子一两块钱大概花了一两个小时");
    const spans = detectAttentionKeywords(transcript);
    const texts = spans.map((span) => span.text);
    expect(texts.some((text) => text.includes("12个维度"))).toBe(true);
    expect(texts.some((text) => text.includes("一两块钱"))).toBe(true);
    expect(texts.some((text) => text.includes("一两个小时"))).toBe(true);
    for (const span of spans) {
      expect(span.end).toBeGreaterThan(span.start);
      expect(span.start).toBeGreaterThanOrEqual(0);
    }
  });

  it("结论词是锚点，纯形容词不是", () => {
    const spans = detectAttentionKeywords(words("我觉得这是一个范式而且成本特别低看起来很舒服"));
    const texts = spans.map((span) => span.text);
    expect(texts).toContain("范式");
    expect(texts).toContain("成本特别低");
    expect(texts).not.toContain("很舒服");
  });

  it("额外领域正则注入非法时 fail-closed", () => {
    expect(() => detectAttentionKeywords(words("随便"), { extraKeywordPatterns: ["("] })).toThrow(/非法正则/u);
  });
});

describe("edit/attention：安全区与音效", () => {
  it("卡片压字幕带 / 越画布 / 压右侧操作栏都被拒", () => {
    expect(cardFitsSafeArea({ x: 0.06, y: 0.2, w: 0.8, h: 0.3 }).ok).toBe(true);
    expect(cardFitsSafeArea({ x: 0.06, y: 0.6, w: 0.8, h: 0.3 }).ok).toBe(false);
    expect(cardFitsSafeArea({ x: 0.9, y: 0.2, w: 0.3, h: 0.3 }).ok).toBe(false);
    expect(cardFitsSafeArea({ x: -0.1, y: 0.2, w: 0.5, h: 0.3 }).ok).toBe(false);
  });

  it("钩子卡给 impact、知识卡给 whoosh、景别切换给 whoosh、金句卡前给 riser（全片 riser ≤2）", () => {
    const events: AttentionEvent[] = [
      { id: "a", kind: "hook-card", at: 0, durationSec: 3, source: "manual", detail: "hook" },
      { id: "b", kind: "knowledge-card", at: 20, durationSec: 2.5, source: "card", detail: "card" },
      { id: "c", kind: "angle-switch", at: 52, durationSec: 0.2, source: "angle", detail: "angle" },
      { id: "d", kind: "full-card", at: 90, durationSec: 3.5, source: "card", detail: "quote" },
      { id: "e", kind: "full-card", at: 150, durationSec: 3.5, source: "card", detail: "quote2" },
      { id: "f", kind: "full-card", at: 200, durationSec: 3.5, source: "card", detail: "quote3" },
    ];
    const sfx = planAttentionSfx(events);
    expect(sfx.find((item) => item.reason.includes("hook-card"))?.kind).toBe("impact");
    expect(sfx.find((item) => item.reason.includes("知识卡进出"))?.kind).toBe("whoosh");
    expect(sfx.find((item) => item.reason.includes("景别切换"))?.kind).toBe("whoosh");
    expect(sfx.filter((item) => item.kind === "riser")).toHaveLength(2);
    for (let index = 1; index < sfx.length; index += 1) {
      expect(sfx[index]!.at).toBeGreaterThanOrEqual(sfx[index - 1]!.at);
    }
  });
});

describe("edit/attention：排期与体检", () => {
  const segments = [
    { segmentId: "talk-001", masterIn: 0, masterOut: 20, text: "开场" },
    { segmentId: "talk-002", masterIn: 20, masterOut: 44, text: "第二段" },
    { segmentId: "talk-003", masterIn: 44, masterOut: 70, text: "第三段" },
    { segmentId: "talk-004", masterIn: 70, masterOut: 100, text: "第四段" },
    { segmentId: "talk-005", masterIn: 100, masterOut: 140, text: "第五段" },
  ];

  it("空窗会被补上景别切换：40s 无事件的片子不应留 >7s 空窗", () => {
    const plan = planAttention({
      durationSeconds: 140,
      segments,
      keywords: detectAttentionKeywords(words("12个维度交叉相乘", 74)),
      cards: [{ id: "card-1", kind: "knowledge-card", start: 46, end: 48.5, anchor: "三块链路" }],
      options: { hookCardSec: 3 },
    });
    expect(plan.schemaVersion).toBe("workloom.video-edit/attention-plan/v1");
    expect(plan.audit.metrics.maxGapSeconds).toBeLessThanOrEqual(plan.options.maxGapSec + 0.001);
    expect(plan.audit.metrics.coverageRate).toBeGreaterThanOrEqual(0.85);
    expect(plan.events.some((event) => event.kind === "angle-switch")).toBe(true);
  });

  it("同一时刻两个主事件 → 硬失败；单主事件 + 弹幕不算冲突", () => {
    const conflict = auditAttention({
      durationSeconds: 60,
      events: [
        { id: "c1", kind: "knowledge-card", at: 10, durationSec: 2.5, source: "card", detail: "a" },
        { id: "c2", kind: "full-card", at: 11, durationSec: 3, source: "card", detail: "b" },
      ],
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.hardFailures.some((item) => item.includes("同刻两个主事件"))).toBe(true);

    const ok = auditAttention({
      durationSeconds: 60,
      events: [
        { id: "c1", kind: "knowledge-card", at: 10, durationSec: 2.5, source: "card", detail: "a" },
        { id: "d1", kind: "danmaku", at: 10.5, durationSec: 3, source: "danmaku", detail: "弹幕" },
      ],
    });
    expect(ok.ok).toBe(true);
  });

  it("卡片越界进硬失败；密度/时长/全屏卡数量进咨询项", () => {
    const audit = auditAttention({
      durationSeconds: 60,
      events: [
        { id: "c1", kind: "knowledge-card", at: 5, durationSec: 1, source: "card", detail: "a" },
        { id: "f1", kind: "full-card", at: 20, durationSec: 6, source: "card", detail: "b" },
        { id: "f2", kind: "full-card", at: 40, durationSec: 4, source: "card", detail: "c" },
      ],
      cards: [
        { id: "c1", kind: "knowledge-card", start: 5, end: 6, layout: { x: 0.05, y: 0.1, w: 0.9, h: 0.8 } },
        { id: "f1", kind: "full-card", start: 20, end: 26 },
        { id: "f2", kind: "full-card", start: 40, end: 44 },
      ],
      keywords: [],
    });
    expect(audit.ok).toBe(false);
    expect(audit.hardFailures.some((item) => item.includes("c1 越界"))).toBe(true);
    expect(audit.advisories.some((item) => item.includes("全屏字卡"))).toBe(true);
    expect(audit.advisories.some((item) => item.includes("关键词锚点"))).toBe(true);
    expect(audit.advisories.some((item) => item.includes("停留"))).toBe(true);
    expect(audit.metrics.fullCards).toBe(2);
  });

  it("前 2 秒出现非钩子事件 → 咨询项（钩子窗口应干净）", () => {
    const audit = auditAttention({
      durationSeconds: 30,
      events: [
        { id: "x", kind: "knowledge-card", at: 1.2, durationSec: 2, source: "card", detail: "太早" },
      ],
    });
    expect(audit.metrics.firstHookWindowClean).toBe(false);
    expect(audit.advisories.some((item) => item.includes("钩子窗口"))).toBe(true);
  });
});

describe("edit/attention：空窗计算", () => {
  it("空窗与占用互补、按升序返回，且忽略零长区间", () => {
    const gaps = findGaps(30, [{ start: 5, end: 10 }, { start: 10, end: 12 }, { start: 20, end: 20 }]);
    expect(gaps).toEqual([
      { start: 0, end: 5, seconds: 5 },
      { start: 12, end: 30, seconds: 18 },
    ]);
  });
});
