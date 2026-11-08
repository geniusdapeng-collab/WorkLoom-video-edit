import { describe, expect, it } from "vitest";
import {
  effectiveVideoPolicy,
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

describe("effective video policy", () => {
  it("publishes the defaults without exposing secrets", () => {
    const policy = effectiveVideoPolicy({
      LLM_API_KEY: "must-not-appear",
      PIPELINE_CONTROL_PLANE: "shadow",
      PIPELINE_REPAIR: "bounded",
      VM_PRODUCER_RETRY: "2",
    });
    expect(policy).toMatchObject({
      schemaVersion: "workloom.video-effective-policy/v1",
      promptContract: "off",
      promptQuality: {
        mode: "off",
        active: false,
        blocking: false,
        semanticChecks: 5,
        technicalCorrectionAttempts: 1,
        contentRepairAttempts: 0,
      },
      producerRetry: { configuredRetries: 2, maxAttempts: 3 },
      repairCoordinator: { mode: "off", active: false },
      pipelineControlPlane: "shadow",
      supportedPipelines: {
        promptQuality: ["marketing", "narrative"],
        approvedSourcePromptRepair: ["marketing"],
      },
      paidRenderRequiresHuman: true,
    });
    expect(JSON.stringify(policy)).not.toContain("must-not-appear");
  });

  it.each([
    ["off", false, false],
    ["shadow", true, false],
    ["enforce", true, true],
  ] as const)("derives prompt quality activation from %s", (mode, active, blocking) => {
    expect(effectiveVideoPolicy({ PROMPT_CONTRACT_V2: mode })).toMatchObject({
      promptContract: mode,
      promptQuality: { mode, active, blocking },
    });
  });

  it.each([
    ["PIPELINE_CONTROL_PLANE", "on"],
    ["VM_PRODUCER_RETRY", "-1"],
    ["VM_PRODUCER_RETRY", "1.5"],
    ["VM_PRODUCER_RETRY", "unbounded"],
  ])("fails closed on invalid %s=%s", (name, value) => {
    expect(() => effectiveVideoPolicy({ [name]: value })).toThrow("PIPELINE_FLAG_INVALID");
  });
});
