/**
 * 字幕标点口径回归（2026-09-25 产品所有者口径：正规字幕不带标点）
 *
 * 事故：成片字幕把台词里的逗号/句号原样打在画面上（「南昌滕王阁，江南名楼之首」），
 * 与平台头部账号的版面口径不符。这里把"去标点"钉在**入站口**（parseSrt），
 * 因此四条出口（旁挂 srt/vtt/ass、烧录、软轨）自动一致。
 *
 * 同时钉住三条不许误伤的细则：数字分隔符保留、纯西文不强制、整行只剩标点时不产出空字幕。
 */
import { describe, expect, it } from "vitest";
import "./processing.test.ts";
import {
  findSubtitlePunctuation,
  isCjkText,
  karaokeAssText,
  karaokeLineCounts,
  parseSrt,
  stripSubtitlePunctuation,
  cuesToSrt
} from "./core.mjs";

const cue = (text: string, start = "0:00:00.00", end = "0:00:05.00") => [{ start, end, text }];
const srtOf = (text: string): string => `1\n00:00:00,000 --> 00:00:05,000\n${text}\n`;

describe("字幕去标点", () => {
  it("中文台词里的标点全部去掉（逗号/句号/顿号/引号/书名号/省略号/破折号）", () => {
    expect(stripSubtitlePunctuation("南昌滕王阁，江南名楼之首。")).toBe("南昌滕王阁江南名楼之首");
    expect(stripSubtitlePunctuation("落霞与孤鹜齐飞、秋水共长天一色……")).toBe("落霞与孤鹜齐飞秋水共长天一色");
    expect(stripSubtitlePunctuation("「滕王阁」——江南三大名楼之一！")).toBe("滕王阁江南三大名楼之一");
    expect(stripSubtitlePunctuation("《滕王阁序》火了 1300 年")).toBe("滕王阁序火了 1300 年");
  });

  it("数字里的分隔符保留：小数、时间、日期、比例、区间都不动", () => {
    expect(stripSubtitlePunctuation("语速 3.5 字/秒，9:16 竖屏")).toBe("语速 3.5 字/秒9:16 竖屏");
    expect(stripSubtitlePunctuation("2026-09-25 首发")).toBe("2026-09-25 首发");
    expect(stripSubtitlePunctuation("门票 50-80 元")).toBe("门票 50-80 元");
  });

  it("纯西文字幕不强制去标点（英文句读是阅读标准）", () => {
    const english = "Hello, welcome to Tengwang Pavilion.";
    expect(isCjkText(english)).toBe(false);
    expect(stripSubtitlePunctuation(english)).toBe(english);
    expect(findSubtitlePunctuation(english)).toEqual([]);
  });

  it("整行只剩标点时不产出空字幕（退回原文）", () => {
    expect(stripSubtitlePunctuation("……")).toBe("……");
  });

  it("多行（\\N）逐行去标点，行结构保留", () => {
    expect(stripSubtitlePunctuation("落霞与孤鹜齐飞，\\N秋水共长天一色。")).toBe("落霞与孤鹜齐飞\\N秋水共长天一色");
  });

  it("findSubtitlePunctuation 与去标点同一套规则（查得到=清得掉）", () => {
    expect(findSubtitlePunctuation("南昌滕王阁，江南名楼之首。")).toEqual(["，", "。"]);
    expect(findSubtitlePunctuation("语速 3.5 字/秒")).toEqual([]);
    expect(findSubtitlePunctuation("干净的一句字幕")).toEqual([]);
  });
});

describe("卡拉OK 断行（口播字幕一屏 ≤2 行 ×12 字）", () => {
  const words = (text: string) => [...text].map((char) => ({ text: char, start: 0, end: 0.1 }));

  it("沿用字幕换行：SRT 的两行在逐字稿里仍是两行", () => {
    const text = "出去玩拍的素材\n堆着等于白拍";
    const counts = karaokeLineCounts(words(text.replace(/\n/gu, "")), text, { maxLineChars: 12, maxLines: 2 });
    /** 「出去玩拍的素材」7 字 + 「堆着等于白拍」6 字 */
    expect(counts).toEqual([7, 6]);
    const ass = karaokeAssText(words(text.replace(/\n/gu, "")), { lineCounts: counts });
    expect(ass).toContain("\\N");
    expect(ass.split("\\N")).toHaveLength(2);
    /** 标签不被破坏：逐字标签数量 = 词数 */
    expect((ass.match(/\{\\kf\d+\}/gu) ?? []).length).toBe(13);
  });

  it("没有换行时按 ≤12 字/行折行，绝不拼成一整行", () => {
    const text = "但是时间过去了半年多吧现在的话呢已经整个链路就跑通了成型了";
    const list = words(text);
    const counts = karaokeLineCounts(list, text, { maxLineChars: 12, maxLines: 2 });
    expect(counts.length).toBe(2);
    const ass = karaokeAssText(list, { lineCounts: counts });
    expect(ass.split("\\N")).toHaveLength(2);
    const [first, second] = ass.split("\\N");
    const plain = (value: string) => value.replace(/\{\\kf\d+\}/gu, "");
    /**
     * 30 字硬塞 2 行 → 每行 15 字：这是"一屏 ≤2 行"与"≤12 字/行"冲突时的取舍——
     * 优先保证不出第三行（读不完），并由上游字幕门禁保证 cue 本身 ≤24 字。
     */
    expect([...plain(first!)].length).toBeLessThanOrEqual(15);
    expect([...plain(second!)].length).toBeLessThanOrEqual(15);
  });
});

describe("parseSrt 入口接管去标点", () => {
  it("从 SRT 读进来的 cues 已经没有标点（四条出口同源）", () => {
    const cues = parseSrt(srtOf("南昌滕王阁，江南名楼之首。"));
    expect(cues[0].text).toBe("南昌滕王阁江南名楼之首");
  });

  it("导出的 SRT 同样干净（不会出现画面干净、文件带标点）", () => {
    const out = cuesToSrt(cue("今晚的滕王阁，赣江边最亮的楼。"));
    expect(out).toContain("今晚的滕王阁赣江边最亮的楼");
    expect(out).not.toContain("，");
  });

  it("非法块仍然显式失败（不因为去标点而静默吞条）", () => {
    expect(() => parseSrt("1\n00:00:00,000 --> 00:00:05,000\n……\n")).not.toThrow();
    expect(() => parseSrt("1\n没有时间轴\n随便一句\n")).toThrow();
  });
});
