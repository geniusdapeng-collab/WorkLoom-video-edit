/** 镜头清晰度统计：取中点一帧，缩到 480 宽灰度，算 p5 / 亮度标准差 / 拉普拉斯方差。 */
import { spawnSync } from "node:child_process";

export interface ClarityMetrics {
  lumaP5: number;
  lumaStd: number;
  detailEnergy: number;
}

export function measureClipClarity(file: string, atSeconds: number, ffmpeg: string): ClarityMetrics {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-ss", atSeconds.toFixed(3), "-i", file, "-frames:v", "1",
    "-vf", "scale=480:-2,format=gray", "-f", "rawvideo", "-"], { maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 || !result.stdout?.length) {
    throw new Error(`清晰度抽帧失败（${file} @ ${atSeconds}s）：${String(result.stderr ?? "").split("\n").slice(-2).join(" | ")}`);
  }
  const buffer = result.stdout as Buffer;
  const width = 480;
  const height = Math.floor(buffer.length / width);
  if (height < 3) throw new Error(`清晰度抽帧尺寸异常：${file}`);
  const hist = new Array(256).fill(0);
  let sum = 0, sumSq = 0, lapSum = 0, lapSumSq = 0, lapN = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = buffer[y * width + x]!;
      hist[value] += 1;
      sum += value;
      sumSq += value * value;
      if (y > 0 && y < height - 1 && x > 0 && x < width - 1) {
        const lap = 4 * value - buffer[(y - 1) * width + x]! - buffer[(y + 1) * width + x]! - buffer[y * width + x - 1]! - buffer[y * width + x + 1]!;
        lapSum += lap;
        lapSumSq += lap * lap;
        lapN += 1;
      }
    }
  }
  const total = width * height;
  const mean = sum / total;
  const std = Math.sqrt(Math.max(0, sumSq / total - mean * mean));
  const detailEnergy = lapN ? lapSumSq / lapN - (lapSum / lapN) ** 2 : 0;
  const target = hist.reduce((acc, value) => acc + value, 0) * 0.05;
  let accumulated = 0, p5 = 0;
  for (let value = 0; value < 256; value += 1) {
    accumulated += hist[value]!;
    if (accumulated >= target) { p5 = value; break; }
  }
  return { lumaP5: p5, lumaStd: Number(std.toFixed(2)), detailEnergy: Number(detailEnergy.toFixed(2)) };
}
