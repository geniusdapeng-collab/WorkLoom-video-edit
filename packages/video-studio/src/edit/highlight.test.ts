import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEYFRAME_THRESHOLDS, dedupeHighlights, normalizeToUnit, scoreHighlight, selectKeyframes, weightsFor,
} from "./highlight.js";

describe("edit/highlight：高光打分与关键帧筛选", () => {
  it("打分可复算：加权和减惩罚，边界钳在 0–1", () => {
    const result = scoreHighlight(
      { speechEmphasis: 1, semanticValue: 1, novelty: 1 },
      {},
      { weights: { speechEmphasis: 0.4, semanticValue: 0.4, novelty: 0.2 } },
    );
    expect(result.base).toBeCloseTo(1, 6);
    expect(result.score).toBe(1);
    const penalized = scoreHighlight(
      { speechEmphasis: 1 },
      { blur: 0.5, repetition: 0.5 },
      { weights: { speechEmphasis: 1 } },
    );
    expect(penalized.penalty).toBeCloseTo(0.65, 6);
    expect(penalized.score).toBeCloseTo(0.35, 6);
  });

  it("缺省信号按 0 处理（无证据不加分），越界/非法值抛错不静默钳制", () => {
    const empty = scoreHighlight({});
    expect(empty.score).toBe(0);
    expect(() => scoreHighlight({ motion: 1.4 })).toThrow();
    expect(() => scoreHighlight({}, {}, { weights: { motion: -0.2 } })).toThrow();
  });

  it("权重档案：五个 profile 均为正数且合计接近 1（口径可审计）", () => {
    for (const profile of ["knowledge", "travel", "review", "drama", "talking"] as const) {
      const weights = weightsFor(profile);
      const total = Object.values(weights).reduce((sum, w) => sum + w, 0);
      expect(total).toBeCloseTo(1, 2);
      expect(Object.values(weights).every((w) => w >= 0)).toBe(true);
    }
    expect(normalizeToUnit(5, 0, 10)).toBe(0.5);
    expect(normalizeToUnit(-3, 0, 10)).toBe(0);
  });

  it("去重：同镜近距离只保留高分候选，并留下被合并记录", () => {
    const { kept, merged } = dedupeHighlights([
      { highlightId: "h1", shotId: "s1", peakSeconds: 10.0, score: 0.6 },
      { highlightId: "h2", shotId: "s1", peakSeconds: 10.8, score: 0.9 },
      { highlightId: "h3", shotId: "s2", peakSeconds: 11.2, score: 0.5 },
    ], { minGapSeconds: 1.5 });
    expect(kept.map((k) => k.highlightId)).toEqual(["h2", "h3"]);
    expect(merged).toEqual([{ keptId: "h2", mergedId: "h1", gapSeconds: 0.8 }]);
  });

  it("关键帧：三类各自门槛，未达标进 rejected，无合格帧时如实报缺口", () => {
    const selection = selectKeyframes([
      { keyframeId: "k1", shotId: "s1", seconds: 3, kind: "composition_best", score: 0.9, sharpness: 0.5, stability: 0.9, textSafe: true },
      { keyframeId: "k2", shotId: "s1", seconds: 4, kind: "composition_best", score: 0.7, sharpness: 0.8, stability: 0.85, textSafe: true },
      { keyframeId: "k3", shotId: "s2", seconds: 8, kind: "emotion_peak", score: 0.8, sharpness: 0.7, faceVisible: true },
      { keyframeId: "k4", shotId: "s3", seconds: 12, kind: "action_peak", score: 0.6, stability: 0.9 },
    ]);
    expect(selection.picked.map((p) => p.keyframeId).sort()).toEqual(["k2", "k3", "k4"]);
    expect(selection.rejected.map((r) => r.keyframeId)).toEqual(["k1"]);
    expect(selection.gaps).toEqual([]);

    const noComposition = selectKeyframes([
      { keyframeId: "x1", shotId: "s1", seconds: 1, kind: "composition_best", score: 0.9, sharpness: 0.3, stability: 0.4, textSafe: false },
    ]);
    expect(noComposition.picked).toHaveLength(0);
    expect(noComposition.gaps.some((g) => g.includes("composition_best"))).toBe(true);
    expect(DEFAULT_KEYFRAME_THRESHOLDS.allowFallback).toBe(false);
  });
});
