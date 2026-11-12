import { describe, expect, it } from "vitest";
import { normalizeFrameCadenceMode, planFrameCadence } from "./frame-cadence.js";

describe("frame cadence", () => {
  it("uses duplicate/drop conversion only when explicitly requested", () => {
    expect(planFrameCadence({ sourceFps: 24, targetFps: 30, mode: "fps" })).toMatchObject({
      applied: false,
      conversion: "duplicate-or-drop",
      filter: "fps=30",
    });
  });

  it("interpolates 24 fps source frames for 30 fps delivery", () => {
    expect(planFrameCadence({ sourceFps: 24, targetFps: 30, mode: "blend" })).toMatchObject({
      applied: true,
      conversion: "linear-interpolation",
    });
    const motion = planFrameCadence({ sourceFps: 24, targetFps: 30, mode: "motion" });
    expect(motion.applied).toBe(true);
    expect(motion.conversion).toBe("motion-interpolation");
    expect(motion.filter).toContain("minterpolate=fps=30");
    expect(motion.filter).toContain("mi_mode=mci");
    expect(motion.filter).toContain("vsbmc=1");
  });

  it("does not interpolate when the source already matches the target", () => {
    expect(planFrameCadence({ sourceFps: 30, targetFps: 30, mode: "motion" })).toMatchObject({
      applied: false,
      conversion: "unchanged",
    });
  });

  it("rejects unknown modes and invalid frame rates", () => {
    expect(() => normalizeFrameCadenceMode("optical-flow-like-magic")).toThrow("FRAME_CADENCE_MODE_INVALID");
    expect(() => planFrameCadence({ sourceFps: 24, targetFps: NaN, mode: "motion" })).toThrow("FRAME_CADENCE_TARGET_INVALID");
  });
});
