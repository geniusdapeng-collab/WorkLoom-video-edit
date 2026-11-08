import { PipelineControlError } from "./artifact.js";

export type CoordinatorMode = "off" | "shadow" | "enforce";
export type RepairModeFlag = "off" | "dry-run" | "bounded";
export type PrespendGuardMode = "off" | "shadow" | "enforce";
export type SystemAutoApprovalMode = "off" | "enforce";
export type PromptContractMode = "off" | "shadow" | "enforce";
export type VideoPipelineKind = "marketing" | "narrative";
export type PipelineControlPlaneMode = "off" | "shadow" | "enforce";

export interface PipelineFeatureFlags {
  coordinator: CoordinatorMode;
  managedCli: boolean;
  repair: RepairModeFlag;
  autoPaidRepair: false;
  legacyProjection: true;
  promptPrespendGuard: PrespendGuardMode;
  promptContract: PromptContractMode;
  systemAutoApproval: SystemAutoApprovalMode;
  scope: "marketing" | "narrative" | "all";
}

/**
 * Read-only projection of the policy that will actually affect a video run.
 * It intentionally contains no model, provider, endpoint or credential values.
 */
export interface EffectiveVideoPolicy {
  schemaVersion: "workloom.video-effective-policy/v1";
  promptContract: PromptContractMode;
  promptQuality: {
    mode: PromptContractMode;
    active: boolean;
    blocking: boolean;
    semanticChecks: 5;
    technicalCorrectionAttempts: 1;
    contentRepairAttempts: number;
  };
  producerRetry: {
    configuredRetries: number;
    maxAttempts: number;
  };
  repairCoordinator: {
    mode: CoordinatorMode;
    active: boolean;
  };
  pipelineControlPlane: PipelineControlPlaneMode;
  supportedPipelines: {
    promptQuality: VideoPipelineKind[];
    approvedSourcePromptRepair: VideoPipelineKind[];
  };
  paidRenderRequiresHuman: true;
}

const DEFAULTS: PipelineFeatureFlags = Object.freeze({
  coordinator: "off",
  managedCli: false,
  repair: "off",
  autoPaidRepair: false,
  legacyProjection: true,
  promptPrespendGuard: "off",
  promptContract: "off",
  systemAutoApproval: "enforce",
  scope: "marketing",
});

function fail(code: string, message: string): never {
  throw new PipelineControlError(code, message);
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, name: string): T {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (!allowed.includes(normalized as T)) fail("PIPELINE_FLAG_INVALID", `${name}=${value}`);
  return normalized as T;
}

function nonNegativeInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim();
  if (!/^\d+$/u.test(normalized)) fail("PIPELINE_FLAG_INVALID", `${name}=${value}`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed > 20) fail("PIPELINE_FLAG_INVALID", `${name}=${value}`);
  return parsed;
}

export function loadPipelineFeatureFlags(
  env: Record<string, string | undefined> = process.env,
): PipelineFeatureFlags {
  oneOf(env.PIPELINE_AUTO_PAID_REPAIR, ["off"] as const, "off", "PIPELINE_AUTO_PAID_REPAIR");
  oneOf(env.PIPELINE_LEGACY_PROJECTION, ["on"] as const, "on", "PIPELINE_LEGACY_PROJECTION");
  return {
    coordinator: oneOf(env.PIPELINE_COORDINATOR, ["off", "shadow", "enforce"] as const, DEFAULTS.coordinator, "PIPELINE_COORDINATOR"),
    managedCli: oneOf(env.PIPELINE_MANAGED_CLI, ["off", "on"] as const, "off", "PIPELINE_MANAGED_CLI") === "on",
    repair: oneOf(env.PIPELINE_REPAIR, ["off", "dry-run", "bounded"] as const, DEFAULTS.repair, "PIPELINE_REPAIR"),
    autoPaidRepair: false,
    legacyProjection: true,
    promptPrespendGuard: oneOf(
      env.PIPELINE_PROMPT_PRESPEND_GUARD,
      ["off", "shadow", "enforce"] as const,
      DEFAULTS.promptPrespendGuard,
      "PIPELINE_PROMPT_PRESPEND_GUARD",
    ),
    promptContract: oneOf(
      env.PROMPT_CONTRACT_V2,
      ["off", "shadow", "enforce"] as const,
      DEFAULTS.promptContract,
      "PROMPT_CONTRACT_V2",
    ),
    systemAutoApproval: oneOf(
      env.PIPELINE_SYSTEM_AUTO_APPROVAL,
      ["off", "enforce"] as const,
      DEFAULTS.systemAutoApproval,
      "PIPELINE_SYSTEM_AUTO_APPROVAL",
    ),
    scope: oneOf(env.PIPELINE_SCOPE, ["marketing", "narrative", "all"] as const, DEFAULTS.scope, "PIPELINE_SCOPE"),
  };
}

export function pipelineFeatureFlagDefaults(): PipelineFeatureFlags {
  return structuredClone(DEFAULTS);
}

/**
 * Resolve one effective video policy from the same environment used by the
 * worker. Invalid values and unsafe combinations fail before a run starts.
 */
export function effectiveVideoPolicy(
  env: Record<string, string | undefined> = process.env,
): EffectiveVideoPolicy {
  const flags = loadPipelineFeatureFlags(env);
  const pipelineControlPlane = oneOf(
    env.PIPELINE_CONTROL_PLANE,
    ["off", "shadow", "enforce"] as const,
    "off",
    "PIPELINE_CONTROL_PLANE",
  );
  const configuredRetries = nonNegativeInteger(env.VM_PRODUCER_RETRY, 0, "VM_PRODUCER_RETRY");
  const promptQualityActive = flags.promptContract !== "off";
  return {
    schemaVersion: "workloom.video-effective-policy/v1",
    promptContract: flags.promptContract,
    promptQuality: {
      mode: flags.promptContract,
      active: promptQualityActive,
      blocking: flags.promptContract === "enforce",
      semanticChecks: 5,
      technicalCorrectionAttempts: 1,
      contentRepairAttempts: flags.promptContract === "enforce" ? 1 : 0,
    },
    producerRetry: {
      configuredRetries,
      maxAttempts: configuredRetries + 1,
    },
    repairCoordinator: {
      mode: flags.coordinator,
      active: flags.coordinator === "enforce" && flags.repair === "bounded",
    },
    pipelineControlPlane,
    supportedPipelines: {
      promptQuality: ["marketing", "narrative"],
      approvedSourcePromptRepair: ["marketing"],
    },
    paidRenderRequiresHuman: true,
  };
}
