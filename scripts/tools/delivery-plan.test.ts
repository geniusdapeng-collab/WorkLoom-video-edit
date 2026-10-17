import { describe, expect, it } from "vitest";
import { BASELINE_RATES, machineFactor, planDelivery } from "../../packages/video-studio/src/edit/delivery-plan.js";

const baselineMachine = { chip: "Apple M3", cores: 8, memoryGb: 8 };
const film = { sourceSeconds: 586, outputSeconds: 124, sourceMaxEdge: 3840, variants: 2, machine: baselineMachine };

describe("delivery-plan 估算器（默认 1080P 完整版 + 4K 先确认）", () => {
  it("默认第一条交付是 1080P 完整版（全链路），量级在一小时内", () => {
    const plan = planDelivery(film);
    expect(plan.fastLane.resolution).toBe("1080p");
    expect(plan.fastLane.resolutionLabel).toContain("完整版");
    expect(plan.fastLane.resolutionLabel).toContain("封面");
    expect(plan.fastLane.minutes).toBeGreaterThan(30);
    expect(plan.fastLane.minutes).toBeLessThan(120);
    /** 三个步骤必须覆盖核验/全链路/封面清单 */
    expect(plan.fastLane.steps.map((step) => step.step).join(" ")).toMatch(/核验.*全链路.*封面/);
  });

  it("极速预览是可选轻链路，明显快于完整版，且不冒充完整版", () => {
    const plan = planDelivery(film);
    const previewSeconds = 124 * (BASELINE_RATES.previewAssembleSecondsPerSecond + BASELINE_RATES.previewBurnSecondsPerSecond + BASELINE_RATES.previewMixSecondsPerSecond);
    expect(plan.previewLane.resolution).toBe("1080p");
    expect(plan.previewLane.minutes).toBe(Math.max(1, Math.round(previewSeconds / 60)));
    expect(plan.previewLane.minutes).toBeLessThan(plan.fastLane.minutes);
    expect(plan.assumptions.some((line) => line.includes("极速预览") && line.includes("不作为默认交付件"))).toBe(true);
  });

  it("素材是 4K 时给出 4K 车道与确认话术，且不自动开跑", () => {
    const plan = planDelivery(film);
    expect(plan.sourceIs4K).toBe(true);
    expect(plan.fourKLane?.resolution).toBe("4k");
    expect(plan.fourKLane!.minutes).toBeGreaterThan(plan.fastLane.minutes);
    expect(plan.confirmFourK).toContain("1080P 完整版交付后");
    expect(plan.confirmFourK).toContain("不确认就不跑");
    expect(plan.headline).toContain("不会自动开跑");
  });

  it("素材原生 1080P 时不出现 4K 车道，也不问 4K", () => {
    const plan = planDelivery({ ...film, sourceMaxEdge: 1920 });
    expect(plan.sourceIs4K).toBe(false);
    expect(plan.fourKLane).toBeNull();
    expect(plan.confirmFourK).toBeNull();
    expect(plan.headline).toContain("无需再出 4K");
  });

  it("变体数与素材时长拉长 1080P 完整版与 4K 车道；预览只跟成片时长相关", () => {
    const one = planDelivery(film);
    const moreVariants = planDelivery({ ...film, variants: 3 });
    const moreSource = planDelivery({ ...film, sourceSeconds: 900 });
    expect(moreVariants.fastLane.minutes).toBeGreaterThan(one.fastLane.minutes);
    expect(moreSource.fastLane.minutes).toBeGreaterThan(one.fastLane.minutes);
    expect(moreVariants.previewLane.minutes).toBe(one.previewLane.minutes);
    expect(moreSource.previewLane.minutes).toBe(one.previewLane.minutes);
    expect(moreVariants.fourKLane!.minutes).toBeGreaterThan(one.fourKLane!.minutes);
  });

  it("机器档位与升级建议：Pro/Max 更快，入门更慢，节省比例为真实折算", () => {
    expect(machineFactor({ chip: "M3 Pro", cores: 12, memoryGb: 36 }).factor).toBeLessThan(1);
    expect(machineFactor({ chip: "Intel i5", cores: 4, memoryGb: 8 }).factor).toBeGreaterThan(1);
    const plan = planDelivery(film);
    expect(plan.upgrades).toHaveLength(2);
    for (const upgrade of plan.upgrades) {
      expect(upgrade.savesPercent).toBeGreaterThan(0);
      expect(upgrade.fourKMinutes).toBeLessThan(plan.fourKLane!.minutes);
    }
  });

  it("话术包含三条必备信息：默认 1080P 完整版时长、4K 需确认、本机配置", () => {
    const plan = planDelivery(film);
    expect(plan.headline).toContain("1080P 完整版");
    expect(plan.headline).toContain("1080P 交付后我先问你");
    expect(plan.headline).toMatch(/8 核/);
    expect(plan.assumptions.some((line) => line.includes("实测"))).toBe(true);
  });
});
