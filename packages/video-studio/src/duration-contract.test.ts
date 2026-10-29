import { describe, expect, it } from "vitest";
import {
  SCENE_SUM_ARITHMETIC_TOLERANCE_SECONDS,
  TARGET_DURATION_TOLERANCE_SECONDS,
  withinTargetDurationTolerance,
} from "./duration-contract.js";

describe("target duration contract", () => {
  it("defines one system-wide ±5-second target and a 0.05-second arithmetic tolerance", () => {
    expect(TARGET_DURATION_TOLERANCE_SECONDS).toBe(5);
    expect(SCENE_SUM_ARITHMETIC_TOLERANCE_SECONDS).toBe(0.05);
  });

  it.each([
    [25, 30, true],
    [34, 30, true],
    [35, 30, true],
    [24.9, 30, false],
    [35.1, 30, false],
    [Number.NaN, 30, false],
    [30, 0, false],
  ])("checks total %s against target %s", (actual, target, accepted) => {
    expect(withinTargetDurationTolerance(actual, target)).toBe(accepted);
  });
});
