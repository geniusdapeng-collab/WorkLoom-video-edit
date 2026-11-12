import { execFileSync } from "node:child_process";

export interface RenderedMotionMeasurements {
  meanEnergy: number;
  maxEnergy: number;
  rampRatio: number;
  frames: number;
}
/** Compute deterministic adjacent-frame differences from a gray raw-video buffer. */
export function measureGrayFrameMotion(
  buffer: Uint8Array,
  width: number,
  height: number,
): RenderedMotionMeasurements {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error("MOTION_FRAME_DIMENSIONS_INVALID");
  }
  const frameBytes = width * height;
  const frames = Math.floor(buffer.length / frameBytes);
  if (frames < 2) throw new Error("MOTION_FRAME_COUNT_INSUFFICIENT");
  const energies: number[] = [];
  for (let frame = 1; frame < frames; frame += 1) {
    const before = buffer.subarray((frame - 1) * frameBytes, frame * frameBytes);
    const after = buffer.subarray(frame * frameBytes, (frame + 1) * frameBytes);
    let sum = 0;
    for (let pixel = 0; pixel < frameBytes; pixel += 1) {
      sum += Math.abs(after[pixel]! - before[pixel]!);
    }
    energies.push(sum / frameBytes);
  }
  const meanEnergy = energies.reduce((sum, value) => sum + value, 0) / energies.length;
  const maxEnergy = Math.max(...energies);
  return {
    meanEnergy: Number(meanEnergy.toFixed(3)),
    maxEnergy: Number(maxEnergy.toFixed(3)),
    rampRatio: Number((maxEnergy / Math.max(meanEnergy, 1e-9)).toFixed(3)),
    frames,
  };
}

/** Decode one video as low-resolution gray frames and measure actual frame differences. */
export function measureVideoMotion(options: {
  file: string;
  width?: number;
  height: number;
  targetFps?: number;
  ffmpeg?: string;
  maxBufferBytes?: number;
}): RenderedMotionMeasurements {
  const width = options.width ?? 160;
  const targetFps = options.targetFps ?? 12;
  if (!Number.isInteger(targetFps) || targetFps < 1 || targetFps > 120) throw new Error("MOTION_FPS_INVALID");
  if (!Number.isInteger(options.height) || options.height < 2) throw new Error("MOTION_FRAME_DIMENSIONS_INVALID");
  const buffer = execFileSync(options.ffmpeg ?? "ffmpeg", [
    "-v", "error", "-i", options.file,
    "-vf", `fps=${targetFps},scale=${width}:${options.height}:flags=area,format=gray`,
    "-f", "rawvideo", "-pix_fmt", "gray", "-",
  ], {
    maxBuffer: options.maxBufferBytes ?? 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }) as Buffer;
  return measureGrayFrameMotion(buffer, width, options.height);
}
