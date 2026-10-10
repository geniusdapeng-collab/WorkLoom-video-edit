import { describe, expect, it } from "vitest";
import {
  formatDuration, frameOf, parseTimecode, secondsOfFrame, snapToFrame, timecodeRange, toTimecode,
} from "./timecode.js";

describe("edit/timecode：帧级时间码口径", () => {
  it("秒 → 时间码 → 秒 往返一致（毫秒精度）", () => {
    for (const seconds of [0, 0.001, 1.5, 62.345, 3599.999, 3661.042]) {
      const timecode = toTimecode(seconds);
      expect(timecode).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/u);
      expect(parseTimecode(timecode)).toBeCloseTo(seconds, 3);
    }
  });

  it("帧号换算与吸附：25fps 下 3.123s 吸附到最近帧", () => {
    expect(frameOf(3.123, 25)).toBe(78);
    expect(secondsOfFrame(78, 25)).toBeCloseTo(3.12, 6);
    expect(snapToFrame(3.123, 25)).toBeCloseTo(3.12, 6);
    // 吸附后再吸附不变（幂等）
    expect(snapToFrame(snapToFrame(3.123, 25), 25)).toBeCloseTo(3.12, 6);
  });

  it("非法输入 fail-closed：负数/NaN/格式错/分秒越界一律抛错", () => {
    expect(() => toTimecode(-1)).toThrow();
    expect(() => toTimecode(Number.NaN)).toThrow();
    expect(() => parseTimecode("0:00.000")).toThrow();
    expect(() => parseTimecode("00:60:00.000")).toThrow();
    expect(() => frameOf(1, 0)).toThrow();
    expect(() => secondsOfFrame(1.5, 30)).toThrow();
  });

  it("字幕/清单时长格式为 MM:SS，区间输出两端完整时间码", () => {
    expect(formatDuration(42.6)).toBe("00:43");
    expect(formatDuration(125)).toBe("02:05");
    expect(timecodeRange(0.5, 3.25)).toBe("00:00:00.500-00:00:03.250");
  });
});
