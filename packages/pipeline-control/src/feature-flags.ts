import { PipelineControlError } from "./artifact.js";

export type CoordinatorMode = "off" | "shadow" | "enforce";
export type RepairModeFlag = "off" | "dry-run" | "bounded";
export type PrespendGuardMode = "off" | "shadow" | "enforce";
export type SystemAutoApprovalMode = "off" | "enforce";

export interface PipelineFeatureFlags {
  coordinator: CoordinatorMode;
  managedCli: boolean;
  repair: RepairModeFlag;
  autoPaidRepair: false;
  legacyProjection: true;
  promptPrespendGuard: PrespendGuardMode;
  systemAutoApproval: SystemAutoApprovalMode;
  scope: "marketing" | "narrative" | "all";
}

const DEFAULTS: PipelineFeatureFlags = Object.freeze({
  coordinator: "off",
  managedCli: false,
  repair: "off",
  autoPaidRepair: false,
  legacyProjection: true,
  promptPrespendGuard: "off",
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
