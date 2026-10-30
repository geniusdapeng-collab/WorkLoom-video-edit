import { describe, expect, it } from "vitest";
import {
  normalizeMarketingPromptResult,
  normalizeMarketingPromptText,
} from "./marketing-prompt-contract.js";

const options = { targetDuration: 30, noPeople: true };

describe("marketing prompt host contract", () => {
  it("normalizes hardware, people, text conflicts and language policy", () => {
    const source = [
      "01.【语言约束】全部字段必须使用中文输出,禁止出现英文单词、英文短语、英文描述。",
      "06.【场景】一台竖屏显示器立在哑光橡胶垫上，旁边有一把黑色办公椅，机箱风扇持续底噪。",
      "06.【场景补充】开放式公共大厅里有接待台、沙发、茶几和灰色哑光瓷砖，85mm镜头持续推近。",
      "07.【明亮约束】主体面部明亮清晰，阴影保留层次不死黑。",
      "13.【角色】无角色出场。，站立姿态，缓慢走动，张开双臂或自然下垂",
      "25.【负面约束】no text, no watermark, no signage, 禁止画面出现中文汉字与无关字母, no hardware devices。",
      "26.【负面约束】。",
      "18.【台词】[00s-06s] 旁白 日志行滚出画面, softly 说:\"空屏一下。\"",
      "19.【微动作】。",
      "30.【副标题内容】官方仓库逐行核对 | 开发者点开许可行亲自验证",
      "33.【微动作】面部细节：眼神专注，嘴唇紧抿；微动作：肩膀紧绷；呼吸：呼吸放缓",
    ].join("\n");
    const normalized = normalizeMarketingPromptText(source, options).value;
    expect(normalized).not.toMatch(/竖屏显示器|橡胶垫|办公椅|机箱风扇/);
    expect(normalized).not.toMatch(/公共大厅|接待台|沙发|茶几|85mm/);
    expect(normalized).not.toMatch(/no text|no watermark|no signage/i);
    expect(normalized).not.toMatch(/站立姿态|嘴唇|肩膀|眼神专注/);
    expect(normalized).toContain("除本次 G1 已审原文");
    expect(normalized).toContain("无人物微动作");
    expect(normalized).toContain("no hardware devices");
    expect(normalized).toContain("18.【台词】无对白");
    expect(normalized).toContain("19.【微动作】无人物微动作");
    expect(normalized).not.toContain("26.【负面约束】。");
  });

  it("rebalances shot durations to the exact target and caps stale timecodes", () => {
    const result = normalizeMarketingPromptResult({
      stages: {
        productionEngine: {
          shots: [
            { shotId: "opening", duration: 4, timeline: "T00:00–T00:04" },
            { shotId: "scene-1", duration: 6, timeline: "T00:00–T00:06" },
            { shotId: "scene-2", duration: 4, timeline: "T00:00–T00:04" },
            { shotId: "scene-3", duration: 5, timeline: "T00:00–T00:05" },
            { shotId: "scene-4", duration: 4, timeline: "T00:00–T00:04" },
            { shotId: "ending", duration: 3, timeline: "T00:00–T00:07", dialogue: "旁白说原文" },
          ],
        },
      },
    }, options).value as any;
    const shots = result.stages.productionEngine.shots;
    expect(shots.map((shot: any) => shot.duration)).toEqual([5, 7, 5, 6, 4, 3]);
    expect(shots.reduce((sum: number, shot: any) => sum + shot.duration, 0)).toBe(30);
    expect(shots[5].timeline).toContain("T00:03");
    expect(shots[5].timeline).not.toContain("T00:07");
    expect(shots[5].dialogue).toContain("无对白");
  });

  it("rewrites the review table to the same conserved durations", () => {
    const report = [
      "## 镜头总览",
      "| 镜头 | 时长 |",
      "| opening | 4s |",
      "| scene-1 | 6s |",
      "| scene-2 | 4s |",
      "| scene-3 | 5s |",
      "| scene-4 | 4s |",
      "| ending | 3s |",
      "## 完整提示词",
      "### opening(片头)",
      "T00:00–T00:04",
      "### scene-1(内容)",
      "T00:00–T00:06",
      "### scene-2(内容)",
      "T00:00–T00:04",
      "### scene-3(内容)",
      "T00:00–T00:05",
      "### scene-4(内容)",
      "T00:00–T00:04",
      "### ending(内容)",
      "T00:00–T00:07",
    ].join("\n");
    const normalized = normalizeMarketingPromptText(report, options).value;
    expect(normalized).toContain("| opening | 5s |");
    expect(normalized).toContain("| scene-1 | 7s |");
    expect(normalized).toContain("### ending(内容)\nT00:00–T00:03");
    expect(normalized).toContain("5s + 7s + 5s + 6s + 4s + 3s = 30s");
  });

  it("conserves decimal durations across any shot count and marks portrait inapplicable", () => {
    const report = [
      "| 镜头 | 时长 | 字符数 | 字段数 | 技能命中 | 有定妆照 | 有时间轴 | 有约束 |",
      "|---|---|---|---|---|---|---|---|",
      "| opening | 4.5s | 1200 | 30 | — | ✓ | ✓ | ✓ |",
      "| scene-1 | 5.5s | 1200 | 25 | — | ✓ | ✓ | ✓ |",
      "| scene-2 | 15s | 1200 | 25 | — | ✓ | ✓ | ✓ |",
      "| scene-3 | 9s | 1200 | 25 | — | ✓ | ✓ | ✓ |",
      "| ending | 6s | 1200 | 25 | — | ✓ | ✓ | ✓ |",
    ].join("\n");
    const normalized = normalizeMarketingPromptText(report, options).value;
    expect(normalized).toContain("| opening | 3s |");
    expect(normalized).toContain("| scene-2 | 11s |");
    expect(normalized).toContain("3s + 4s + 11s + 7s + 5s = 30s");
    expect(normalized).toContain("| — | ✓ | ✓ |");
  });
});
