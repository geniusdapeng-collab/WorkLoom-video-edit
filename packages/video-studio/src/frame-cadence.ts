/**
 * Frame-rate conversion policy for delivery.
 *
 * FFmpeg's `fps` filter converts cadence by duplicating or dropping frames.
 * For fast action this makes a 24 fps source visibly steppy at 30 fps.
 * `framerate` interpolates source frames, while `minterpolate` adds motion
 * estimation. The latter is opt-in because it is more expensive and can
 * introduce artifacts around occlusion.
 */
export type FrameCadenceMode = "fps" | "blend" | "motion";

export interface FrameCadencePlan {
  mode: FrameCadenceMode;
  sourceFps: number | null;
  targetFps: number;
  applied: boolean;
  filter: string;
  conversion: "unchanged" | "duplicate-or-drop" | "linear-interpolation" | "motion-interpolation";
  note: string;
}
export const FRAME_CADENCE_MODES: readonly FrameCadenceMode[] = ["fps", "blend", "motion"];

export function normalizeFrameCadenceMode(value: unknown): FrameCadenceMode {
  if (value === "" || value === undefined || value === "auto") return "fps";
  if (typeof value === "string" && (FRAME_CADENCE_MODES as readonly string[]).includes(value)) {
    return value as FrameCadenceMode;
  }
  throw new Error(`FRAME_CADENCE_MODE_INVALID: ${String(value)}`);
}

export function planFrameCadence(options: {
  sourceFps: unknown;
  targetFps: unknown;
  mode: unknown;
}): FrameCadencePlan {
  const targetFps = Number(options.targetFps);
  if (!Number.isFinite(targetFps) || targetFps <= 0 || targetFps > 120) {
    throw new Error("FRAME_CADENCE_TARGET_INVALID");
  }
  const sourceNumber = Number(options.sourceFps);
  const sourceFps = Number.isFinite(sourceNumber) && sourceNumber > 0 ? sourceNumber : null;
  const mode = normalizeFrameCadenceMode(options.mode);
  const needsConversion = sourceFps !== null && Math.abs(sourceFps - targetFps) > 0.01;
  if (!needsConversion || mode === "fps") {
    return {
      mode,
      sourceFps,
      targetFps,
      applied: false,
      filter: `fps=${targetFps}`,
      conversion: needsConversion ? "duplicate-or-drop" : "unchanged",
      note: needsConversion
        ? `源 ${sourceFps}fps → ${targetFps}fps 使用帧复制/丢弃`
        : `源已是 ${targetFps}fps，无需变更`,
    };
  }
  if (mode === "blend") {
    return {
      mode,
      sourceFps,
      targetFps,
      applied: true,
      filter: `framerate=fps=${targetFps}:interp_start=0:interp_end=255`,
      conversion: "linear-interpolation",
      note: `源 ${sourceFps}fps → ${targetFps}fps 使用线性插帧`,
    };
  }
  return {
    mode,
    sourceFps,
    targetFps,
    applied: true,
    filter: `minterpolate=fps=${targetFps}:mi_mode=mci:mc_mode=aobmc:me_mode=bilat:me=epzs:mb_size=16:search_param=32:vsbmc=1:scd=fdiff:scd_threshold=10`,
    conversion: "motion-interpolation",
    note: `源 ${sourceFps}fps → ${targetFps}fps 使用运动补偿插帧`,
  };
}
