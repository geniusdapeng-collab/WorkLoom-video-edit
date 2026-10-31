import { describe, expect, it } from "vitest";
import { configureRequirementRetryPolicy } from "./requirement-retry-policy.js";

describe("requirement discovery retry policy", () => {
  it("raises scene/risk retry budget without changing other agents", () => {
    const reference = { maxRetries: 1, timeoutMs: 180_000 };
    const engine = {
      agentTimeoutMs: 180_000,
      agents: {
        scene: { maxRetries: 1, timeoutMs: 180_000 },
        risk: { maxRetries: 1, timeoutMs: 180_000 },
        reference,
      },
    };
    expect(configureRequirementRetryPolicy(engine)).toMatchObject({
      changed: ["scene-timeout", "scene-retries", "risk-retries", "stage-budget"],
      policy: { sceneTimeoutMs: 240_000, maxRetries: 2, stageBudgetMs: 420_000 },
    });
    expect(engine.agents.scene).toEqual({ maxRetries: 2, timeoutMs: 240_000 });
    expect(engine.agents.risk).toEqual({ maxRetries: 2, timeoutMs: 180_000 });
    expect(engine.agentTimeoutMs).toBe(420_000);
    expect(engine.agents.reference).toBe(reference);
  });

  it("never lowers a stricter caller-provided policy", () => {
    const engine = {
      agentTimeoutMs: 600_000,
      agents: {
        scene: { maxRetries: 3, timeoutMs: 300_000 },
        risk: { maxRetries: 3, timeoutMs: 180_000 },
      },
    };
    expect(configureRequirementRetryPolicy(engine).changed).toEqual([]);
    expect(engine.agents.scene.timeoutMs).toBe(300_000);
    expect(engine.agents.scene.maxRetries).toBe(3);
  });

  it("fails closed when the vendor agent shape changes", () => {
    expect(() => configureRequirementRetryPolicy({ agents: {} })).toThrow(/BRIDGE_UNAVAILABLE/);
  });
});
