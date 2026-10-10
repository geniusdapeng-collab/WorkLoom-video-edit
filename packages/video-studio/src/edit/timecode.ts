/**
 * edit/timecode.ts —— 剪辑时间码（v2 帧级口径）
 *
 * 为什么单独一层：旧链路的 `mm:ss` 秒级时间码在剪辑里不够用——3.2s 的镜头切在 3s 还是 3.183s，
 * 观感完全不同；而秒级浮点在多次换算后会累积漂移。本模块把"秒 ↔ 时间码 ↔ 帧号"三者的换算
 * 收口成一组纯函数，供探测解析、时间轴校验与合成执行器共用同一口径。
 *
 * 口径：
 *   · 时间码一律 `HH:MM:SS.mmm`（24 小时制，毫秒三位）；
 *   · 帧号 = round(seconds × fps)，反向 = frames / fps；
 *   · 非法输入（负数、NaN、格式不符）一律抛错，不返回近似值（fail-closed）。
 */

export const TIMECODE_PATTERN = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/u;

function assertFiniteSeconds(seconds: number, label = "seconds"): void {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`${label} 必须是非负有限数字，收到：${String(seconds)}`);
  }
}

function assertFps(fps: number): void {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`fps 必须是正数，收到：${String(fps)}`);
  }
}

/** 秒 → `HH:MM:SS.mmm`（毫秒四舍五入；不进位溢出到 24 小时以外时按实际小时数输出） */
export function toTimecode(seconds: number): string {
  assertFiniteSeconds(seconds);
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = (totalMs - ms) / 1000;
  const s = totalSeconds % 60;
  const totalMinutes = (totalSeconds - s) / 60;
  const m = totalMinutes % 60;
  const h = (totalMinutes - m) / 60;
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

/** `HH:MM:SS.mmm` → 秒；格式不符即抛错 */
export function parseTimecode(timecode: string): number {
  if (typeof timecode !== "string") throw new Error(`时间码必须是字符串，收到：${typeof timecode}`);
  const matched = TIMECODE_PATTERN.exec(timecode.trim());
  if (!matched) throw new Error(`时间码格式必须是 HH:MM:SS.mmm，收到：${timecode}`);
  const [, hh, mm, ss, mmm] = matched;
  const hours = Number(hh);
  const minutes = Number(mm);
  const seconds = Number(ss);
  const millis = Number(mmm);
  if (minutes > 59 || seconds > 59) throw new Error(`时间码分秒越界：${timecode}`);
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

/** 秒 → 帧号（四舍五入，保证同一时刻在同一帧率下总是同一帧） */
export function frameOf(seconds: number, fps: number): number {
  assertFiniteSeconds(seconds);
  assertFps(fps);
  return Math.round(seconds * fps);
}

/** 帧号 → 秒 */
export function secondsOfFrame(frame: number, fps: number): number {
  assertFps(fps);
  if (!Number.isInteger(frame) || frame < 0) throw new Error(`帧号必须是非负整数，收到：${String(frame)}`);
  return frame / fps;
}

/**
 * 把任意秒值吸附到帧网格。
 * 剪辑执行器（裁切/拼接）只能在帧边界上切，未吸附的时间码会在导出时产生 ±1 帧误差。
 */
export function snapToFrame(seconds: number, fps: number): number {
  return secondsOfFrame(frameOf(seconds, fps), fps);
}

/**
 * 秒 → `M:SS` 或 `MM:SS`（字幕/交付清单口径；与时间码口径分开，避免混用）。
 */
export function formatDuration(seconds: number): string {
  assertFiniteSeconds(seconds);
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 时间码区间字符串（`HH:MM:SS.mmm-HH:MM:SS.mmm`），用于回执与日志 */
export function timecodeRange(inSeconds: number, outSeconds: number): string {
  return `${toTimecode(inSeconds)}-${toTimecode(outSeconds)}`;
}
