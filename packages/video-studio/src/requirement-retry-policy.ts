type RecordValue = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordValue =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

export interface RequirementRetryPolicy {
  sceneTimeoutMs: number;
  maxRetries: number;
  stageBudgetMs: number;
}

export const DEFAULT_REQUIREMENT_RETRY_POLICY: Readonly<RequirementRetryPolicy> = Object.freeze({
  sceneTimeoutMs: 240_000,
  maxRetries: 2,
  stageBudgetMs: 420_000,
});

/**
 * The vendor hardcodes two attempts and 180 seconds for a large scene contract.
 * Raise only the structured discovery retry envelope; strict schema validation
 * and fail-closed fallback behavior remain unchanged.
 */
export function configureRequirementRetryPolicy(
  engineValue: unknown,
  policy: Partial<RequirementRetryPolicy> = {},
): { changed: string[]; policy: RequirementRetryPolicy } {
  if (!isRecord(engineValue) || !isRecord(engineValue.agents)) {
    throw new Error("REQUIREMENT_DISCOVERY_BRIDGE_UNAVAILABLE：缺少需求洞察 agents");
  }
  const scene = engineValue.agents.scene;
  const risk = engineValue.agents.risk;
  if (!isRecord(scene) || !isRecord(risk)) {
    throw new Error("REQUIREMENT_DISCOVERY_BRIDGE_UNAVAILABLE：缺少 SceneArchitect/RiskAssessor");
  }
  const current = Object.fromEntries(Object.entries(DEFAULT_REQUIREMENT_RETRY_POLICY).map(([key, fallback]) => {
    const requested = policy[key as keyof RequirementRetryPolicy];
    const value = typeof requested === "number" && Number.isFinite(requested) && requested > 0
      ? Math.floor(requested)
      : fallback;
    return [key, value];
  })) as unknown as RequirementRetryPolicy;
  const changed: string[] = [];
  if (Number(scene.timeoutMs) < current.sceneTimeoutMs) {
    scene.timeoutMs = current.sceneTimeoutMs;
    changed.push("scene-timeout");
  }
  for (const [name, agent] of [["scene", scene], ["risk", risk]] as const) {
    if (!Number.isSafeInteger(agent.maxRetries) || Number(agent.maxRetries) < current.maxRetries) {
      agent.maxRetries = current.maxRetries;
      changed.push(`${name}-retries`);
    }
  }
  if (Number(engineValue.agentTimeoutMs) < current.stageBudgetMs) {
    engineValue.agentTimeoutMs = current.stageBudgetMs;
    changed.push("stage-budget");
  }
  return { changed, policy: current };
}
