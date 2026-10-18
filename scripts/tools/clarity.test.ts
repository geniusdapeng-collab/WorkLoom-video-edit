import { describe, expect, it } from "vitest";
import { CLARITY_CHAINS, LEGACY_CONSERVATIVE_CLARITY, clarityForLevel, planClarity } from "../../packages/video-studio/src/edit/clarity.js";
import {
  CLARITY_CHAINS as BRIDGE_CLARITY_CHAINS,
  LEGACY_CONSERVATIVE_CLARITY as BRIDGE_LEGACY_CONSERVATIVE_CLARITY,
} from "../../bundles/ai-video/connectors/color-bridge/processing-quality.mjs";

describe("镜头级清晰度/去雾计划", () => {
  it("雾感日出镜头（黑位 101 / 细节 59）判强档", () => {
    const decision = planClarity({ lumaP5: 101, lumaStd: 41.8, detailEnergy: 59.3 });
    expect(decision.level).toBe("strong");
    expect(decision.chain).toBe(CLARITY_CHAINS.strong);
    expect(decision.hazeScore).toBeGreaterThan(0.5);
  });

  it("清晰山景（黑位 40 / 细节 102）只做轻档，避免过锐", () => {
    const decision = planClarity({ lumaP5: 40, lumaStd: 57.6, detailEnergy: 102.4 });
    expect(decision.level).toBe("light");
    expect(decision.chain).toBe(CLARITY_CHAINS.light);
  });

  it("干净高对比镜头不处理", () => {
    const decision = planClarity({ lumaP5: 20, lumaStd: 65, detailEnergy: 160 });
    expect(decision.level).toBe("off");
    expect(decision.chain).toBeNull();
  });

  it("中间态按阈值降到中档", () => {
    expect(planClarity({ lumaP5: 60, lumaStd: 50, detailEnergy: 90 }).level).toBe("medium");
    expect(planClarity({ lumaP5: 58, lumaStd: 50, detailEnergy: 85 }).level).toBe("medium");
  });

  it("编辑计划与 color-bridge 执行链保持同一事实源", () => {
    expect(BRIDGE_CLARITY_CHAINS).toEqual(CLARITY_CHAINS);
    expect(BRIDGE_LEGACY_CONSERVATIVE_CLARITY).toBe(LEGACY_CONSERVATIVE_CLARITY);
    expect(LEGACY_CONSERVATIVE_CLARITY).toBe("unsharp=luma_msize_x=3:luma_msize_y=3:luma_amount=0.25:chroma_amount=0");
  });

  it("显式档位与链一致；非法输入报错", () => {
    expect(clarityForLevel("off")).toBeNull();
    expect(clarityForLevel("medium")).toBe(CLARITY_CHAINS.medium);
    expect(() => planClarity({ lumaP5: Number.NaN, lumaStd: 1, detailEnergy: 1 })).toThrow();
  });
});
