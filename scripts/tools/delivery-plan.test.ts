import { describe, expect, it } from "vitest";
import { BASELINE_RATES, machineFactor, planDelivery } from "../../packages/video-studio/src/edit/delivery-plan.js";

const baselineMachine = { chip: "Apple M3", cores: 8, memoryGb: 8 };

describe("delivery-plan 估算器", () => {
  it("基准机（M3 8 核 8GB）的 1080P 先行版在几分钟量级", () => {
    const plan = planDelivery({
      sourceSeconds: 586,
      outputSeconds: 124,
      sourceMaxEdge: 3840,
      variants: 2,
      machine: baselineMachine,
    });
    const fastSeconds = 124 * (BASELINE_RATES.fastAssembleSecondsPerSecond + BASELINE_RATES.fastBurnSecondsPerSecond + BASELINE_RATES.fastMixSecondsPerSecond);
    expect(plan.fastLane.resolution).toBe("1080p");
    expect(plan.fastLane.minutes).toBe(Math.max(1, Math.round(fastSeconds / 60)));
    expect(plan.fastLane.minutes).toBeGreaterThanOrEqual(3);
    expect(plan.fastLane.minutes).toBeLessThanOrEqual(10);
    expect(plan.fullLane.resolution).toBe("4k");
    expect(plan.fullLane.minutes).toBeGreaterThan(plan.fastLane.minutes);
  });

  it("素材原生 1080P 时不冒充 4K 正式版", () => {
    const plan = planDelivery({
      sourceSeconds: 120,
      outputSeconds: 60,
      sourceMaxEdge: 1920,
      variants: 2,
      machine: baselineMachine,
    });
    expect(plan.fullLane.resolution).toBe("1080p");
    expect(plan.fullLane.resolutionLabel).toContain("1080P");
  });

  it("变体数与素材时长都会拉长正式版；先行版只跟成片时长相关", () => {
    const one = planDelivery({ sourceSeconds: 300, outputSeconds: 120, sourceMaxEdge: 3840, variants: 2, machine: baselineMachine });
    const moreVariants = planDelivery({ sourceSeconds: 300, outputSeconds: 120, sourceMaxEdge: 3840, variants: 3, machine: baselineMachine });
    const moreSource = planDelivery({ sourceSeconds: 900, outputSeconds: 120, sourceMaxEdge: 3840, variants: 2, machine: baselineMachine });
    expect(moreVariants.fullLane.minutes).toBeGreaterThan(one.fullLane.minutes);
    expect(moreSource.fullLane.minutes).toBeGreaterThan(one.fullLane.minutes);
    expect(moreVariants.fastLane.minutes).toBe(one.fastLane.minutes);
    expect(moreSource.fastLane.minutes).toBe(one.fastLane.minutes);
  });

  it("机器档位：Pro/Max 更快，入门机更慢；升级建议给出节省比例", () => {
    expect(machineFactor({ chip: "M3 Pro", cores: 12, memoryGb: 36 }).factor).toBeLessThan(1);
    expect(machineFactor({ chip: "Intel i5", cores: 4, memoryGb: 8 }).factor).toBeGreaterThan(1);
    const plan = planDelivery({ sourceSeconds: 586, outputSeconds: 124, sourceMaxEdge: 3840, variants: 2, machine: baselineMachine });
    expect(plan.upgrades).toHaveLength(2);
    for (const upgrade of plan.upgrades) {
      expect(upgrade.savesPercent).toBeGreaterThan(0);
      expect(upgrade.fullLaneMinutes).toBeLessThan(plan.fullLane.minutes);
    }
  });

  it("话术包含三条必备信息：先行版时长、正式版规格/版本数、本机配置", () => {
    const plan = planDelivery({ sourceSeconds: 586, outputSeconds: 124, sourceMaxEdge: 3840, variants: 2, machine: baselineMachine });
    expect(plan.headline).toContain("1080P");
    expect(plan.headline).toContain("2 个风格");
    expect(plan.headline).toMatch(/8 核/);
    expect(plan.assumptions.some((line) => line.includes("实测"))).toBe(true);
  });
});
