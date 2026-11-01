import { describe, expect, it } from "vitest";
import {
  loadPipelineFeatureFlags,
  pipelineFeatureFlagDefaults,
} from "../feature-flags.js";

describe("prompt contract rollout flag", () => {
  it("defaults to off so existing runs retain their historical field policy", () => {
    expect(pipelineFeatureFlagDefaults().promptContract).toBe("off");
    expect(loadPipelineFeatureFlags({}).promptContract).toBe("off");
  });

  it.each(["off", "shadow", "enforce"] as const)("accepts %s", (value) => {
    expect(loadPipelineFeatureFlags({ PROMPT_CONTRACT_V2: value.toUpperCase() }).promptContract).toBe(value);
  });

  it("fails closed on an unknown rollout value", () => {
    expect(() => loadPipelineFeatureFlags({ PROMPT_CONTRACT_V2: "on" }))
      .toThrow("PIPELINE_FLAG_INVALID");
  });
});
