import { describe, expect, it } from "vitest";
import { normalizeCreativeThemeContract } from "./creative-theme-contract.js";

function result() {
  return {
    _originalStoryText: "全片无人，仅使用抽象界面、代码块和示意图。给 Home Assistant 做一条面向开发者的抖音介绍片。",
    tasks: [{
      type: "商业广告",
      theme: "代码把家留在本地",
      tone: "冷酷精密、暗藏温度",
      description: "屏幕前的开发者在复杂配置与隐私顾虑间停手，转身把 Home Assistant 跑在本地服务器。",
      protagonist: "开发者",
      shots: [{ content: "人物转身" }],
      dialogue_requirement: "开发者口播",
      character_consistency: "保持人物造型",
      visual_style: "参考《Her》的极简界面柔光与《社交网络》的冷白屏幕光；以屏幕自发光为主光。",
      special_notes: "只使用官方仓库可核实能力。",
      target_audience: "目标消费者/品牌受众",
    }],
  };
}

describe("creative theme host contract", () => {
  it("removes persons and unverified pain claims under an explicit no-person contract", () => {
    const normalized = normalizeCreativeThemeContract(result(), {
      pipelineRoute: { kind: "marketing" },
      customerOriginalIntent: result()._originalStoryText,
      brief: { product: "Home Assistant", duration: 30, aspectRatio: "9:16", platform: "抖音" },
      builtinCharacterSelection: { mode: "none" },
      _dataDossier: {
        identity: {
          official_selling_points: [
            { point: "local control and privacy first" },
            { point: "modular approach" },
          ],
        },
      },
    });
    const task = (normalized.result.tasks as Array<Record<string, unknown>>)[0]!;
    expect(normalized.applied).toBe(true);
    expect(task.protagonist).toBeNull();
    expect(task.character_consistency).toBeNull();
    expect(task.shots).toEqual([]);
    expect(task.description).toContain("全片无人");
    expect(task.description).not.toMatch(/开发者|转身|屏幕前/);
    expect(task.dialogue_requirement).toContain("无人物对白");
    expect(task.target_audience).toBe("开发者（客户原文明确）");
    expect(task.tone).toBe("冷酷精密");
    expect(task.theme).toContain("官方自述：local control and privacy first");
    expect(task.description).not.toContain("守住");
    expect(task.duration_sec).toBe(30);
    expect(task).not.toHaveProperty("brief_duration_source");
    expect(task.visual_style).not.toContain("《");
    expect(task.special_notes).toContain("不得新增客户原文未提供");
    expect(task.special_notes).toContain("local control and privacy first");
    task.special_notes = `${task.special_notes}；hero_image_id 为 null；undefined；NaN；[object Object]`;
    const placeholders = normalizeCreativeThemeContract({ ...normalized.result, tasks: [task] }, {
      pipelineRoute: { kind: "marketing" },
      customerOriginalIntent: result()._originalStoryText,
      brief: { product: "Home Assistant", duration: 30, aspectRatio: "9:16", platform: "抖音" },
      builtinCharacterSelection: { mode: "none" },
    });
    const cleaned = (placeholders.result.tasks as Array<Record<string, unknown>>)[0]!;
    expect(Object.values(cleaned).filter((value): value is string => typeof value === "string").join("\n"))
      .not.toMatch(/\bnull\b|\bundefined\b|\bNaN\b|\[object Object\]/u);
    expect(cleaned.special_notes).toContain("空值（未提供）");
    expect(placeholders.changes).toContain("display-placeholders-normalized");
  });

  it("keeps an explicitly requested title and a person when the cast contract allows one", () => {
    const input = result();
    input.tasks[0]!.visual_style = "参考《Her》的柔光";
    delete (input.tasks[0] as Record<string, unknown>).protagonist;
    const normalized = normalizeCreativeThemeContract(input, {
      pipelineRoute: { kind: "narrative" },
      customerOriginalIntent: "参考《Her》的柔光，拍一条人物成长片",
      builtinCharacterSelection: { mode: "builtin" },
    });
    const task = (normalized.result.tasks as Array<Record<string, unknown>>)[0]!;
    expect(task.visual_style).toContain("《Her》");
    expect(task.description).toContain("开发者");
    expect(task.target_audience).toBe("客户未明确指定；任何人群假设均为待审核");
  });
});
