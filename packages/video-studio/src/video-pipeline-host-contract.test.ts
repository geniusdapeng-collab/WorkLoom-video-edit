import { describe, expect, it } from "vitest";
import { narrativeThemeInputForRoute } from "./requirement-contract-bridge.js";

describe("video pipeline host contract", () => {
  it("narrative route bypasses the vendor marketing brief", () => {
    const intent = "拍一条关于苏州平江路清晨的城市人文短片";
    expect(narrativeThemeInputForRoute(intent, {
      brief: { platform: "抖音", goal: "seeding" },
      pipelineRoute: { kind: "narrative" },
    })).toBe(intent);
  });

  it("marketing route does not bypass the complete vendor marketing brief", () => {
    const intent = "给一款真实商品做一条抖音种草视频";
    expect(narrativeThemeInputForRoute(intent, {
      brief: {
        product: "真实商品",
        platform: "抖音",
        goal: "seeding",
        sellingPoints: ["经来源核实的卖点"],
      },
      pipelineRoute: { kind: "marketing" },
    })).toBeUndefined();
  });
});
