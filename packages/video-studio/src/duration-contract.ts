/**
 * System-wide duration contract shared by scene discovery, PRD projection,
 * continuity review and duration validation.
 */
export const TARGET_DURATION_TOLERANCE_SECONDS = 5;
export const SCENE_SUM_ARITHMETIC_TOLERANCE_SECONDS = 0.05;

export function withinTargetDurationTolerance(
  actual: number,
  target: number,
  tolerance = TARGET_DURATION_TOLERANCE_SECONDS,
): boolean {
  return Number.isFinite(actual)
    && Number.isFinite(target)
    && target > 0
    && tolerance >= 0
    && Math.abs(actual - target) <= tolerance + Number.EPSILON;
}
