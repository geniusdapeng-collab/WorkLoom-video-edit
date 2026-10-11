import { describe, expect, it } from "vitest";
import { checkCreativeSet, parseDurationBandSeconds, type CreativeSetDocLike } from "./creative-check.js";

function candidate(slot: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slot,
    title: `方案${slot}`,
    logline: "一句话概念足够长",
    differentiators: {
      narrativeVoice: slot === "T01" ? "first_person" : "third_person",
      structure: slot === "T01" ? "linear" : slot === "T02" ? "flashback" : "question_driven",
      emotion: slot === "T01" ? "治愈" : slot === "T02" ? "热血" : "沉思",
      tempo: slot === "T01" ? "slow_burn" : slot === "T02" ? "punchy" : "wave",
      visualStyle: slot === "T01" ? "自然光纪实" : slot === "T02" ? "高对比海报感" : "手绘插画感",
    },
    openingMove: slot === "T01" ? "结果前置开场" : slot === "T02" ? "提问开场" : "环境声先入",
    turningPoint: "转折点描述",
    endingMove: "落点描述",
    materialPlan: [{ beat: "开场", role: "钩子", candidateShotIds: ["shot-001"], highlightRefs: ["hl-1"] }],
    withoutIt: "少看到一种讲法",
    ...overrides,
  };
}

function doc(overrides: Partial<CreativeSetDocLike["creativeSet"]> = {}, extras: Partial<CreativeSetDocLike> = {}): CreativeSetDocLike {
  const candidates = [candidate("T01"), candidate("T02"), candidate("T03")];
  return {
    creativeSet: {
      intent: { platform: "抖音", durationBand: "45–60s", audience: "想家的人", emotionGoal: ["想起"] },
      candidates: candidates as never,
      review: ["T01", "T02", "T03"].map((slot, index) => ({
        slot,
        scores: { narrative: 8 - index * 0.5, emotion: 7.5 + index * 0.5, platform: 8, feasibility: 7.5 },
        total: 7.8,
        notes: "扣分理由",
      })),
      recommendedOrder: ["T03", "T01"],
      ...overrides,
    },
    storyPlan: {
      slot: "T03",
      structure: "hook_cta",
      beats: [
        { beatId: "b1", name: "钩子", targetSeconds: 10, materialRefs: ["shot-001"], highlightRefs: ["hl-1"], intensity: 0.4 },
        { beatId: "b2", name: "推进", targetSeconds: 30, materialRefs: ["shot-002"], intensity: 0.7 },
        { beatId: "b3", name: "落点", targetSeconds: 15, materialRefs: ["shot-003"], intensity: 0.5 },
      ],
      emotionCurve: [
        { t: 0, intensity: 0.3 },
        { t: 30, intensity: 0.8 },
        { t: 55, intensity: 0.4 },
      ],
      tempoMap: [{ avgShotSeconds: 2, cutsPerMinute: 20 }],
    },
    ...extras,
  };
}

const MATERIAL = { shotIds: ["shot-001", "shot-002", "shot-003"], highlightIds: ["hl-1"], keyframeIds: ["kf-1"] };

describe("edit/creative-check：创作环节检查器", () => {
  it("合格方案集通过：3 个候选两两 ≥3 维不同、引用真实存在、评审覆盖齐全", () => {
    const result = checkCreativeSet({ doc: doc(), material: MATERIAL });
    expect(result.issues.filter((issue) => issue.severity === "hard")).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.metrics.minDifferentDims).toBeGreaterThanOrEqual(3);
    expect(result.metrics.referencesMissing).toBe(0);
  });

  it("换壳方案被硬拦：两个候选只在文案上不同", () => {
    const set = doc();
    set.creativeSet!.candidates![1] = candidate("T02", {
      differentiators: {
        narrativeVoice: "first_person",
        structure: "linear",
        emotion: "治愈",
        tempo: "slow_burn",
        visualStyle: "自然光纪实",
      },
    }) as never;
    const result = checkCreativeSet({ doc: set, material: MATERIAL });
    const hit = result.issues.find((issue) => issue.id.startsWith("candidates.differentiation"));
    expect(hit?.severity).toBe("hard");
    expect(result.ok).toBe(false);
  });

  it("素材引用必须真实存在；缺索引时只出咨询不伪称已校验", () => {
    const set = doc();
    set.creativeSet!.candidates![0]!.materialPlan![0]!.candidateShotIds = ["shot-999"];
    const withIndex = checkCreativeSet({ doc: set, material: MATERIAL });
    expect(withIndex.issues.some((issue) => issue.id.includes("material.missing") && issue.severity === "hard")).toBe(true);
    const withoutIndex = checkCreativeSet({ doc: set, material: null });
    expect(withoutIndex.issues.some((issue) => issue.id === "material.indexMissing" && issue.severity === "advisory")).toBe(true);
    expect(withoutIndex.issues.some((issue) => issue.id.includes("material.missing"))).toBe(false);
  });

  it("生成阶段自评被硬拦；评审缺视角/漏候选被硬拦", () => {
    const set = doc();
    (set.creativeSet!.candidates![0] as Record<string, unknown>).score = 9.5;
    set.creativeSet!.review = (set.creativeSet!.review ?? []).slice(0, 2);
    const result = checkCreativeSet({ doc: set, material: MATERIAL });
    expect(result.issues.some((issue) => issue.id.startsWith("candidates.selfScore") && issue.severity === "hard")).toBe(true);
    expect(result.issues.some((issue) => issue.id === "review.coverage" && issue.severity === "hard")).toBe(true);
  });

  it("时长带解析与咨询项：总分加权偏差、情绪曲线无回落、beat 时长超带", () => {
    expect(parseDurationBandSeconds("45–60s")).toEqual({ minSeconds: 45, maxSeconds: 60 });
    expect(parseDurationBandSeconds("00:45-01:00")).toEqual({ minSeconds: 45, maxSeconds: 60 });
    expect(parseDurationBandSeconds("3-5分钟")).toEqual({ minSeconds: 180, maxSeconds: 300 });
    const set = doc();
    set.creativeSet!.review![0]!.total = 3;
    set.storyPlan!.emotionCurve = [{ t: 0, intensity: 0.3 }, { t: 20, intensity: 0.9 }, { t: 50, intensity: 0.85 }];
    set.storyPlan!.beats![0]!.targetSeconds = 5;
    const result = checkCreativeSet({ doc: set, material: MATERIAL });
    expect(result.issues.some((issue) => issue.id === "review.total:T01" && issue.severity === "advisory")).toBe(true);
    expect(result.issues.some((issue) => issue.id === "storyPlan.curveFall" && issue.severity === "advisory")).toBe(true);
    expect(result.ok).toBe(true);
  });
});
