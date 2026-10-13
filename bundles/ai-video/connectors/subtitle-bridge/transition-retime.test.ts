/**
 * 转场 × 字幕 时间轴重映射回归（2026-10-12 客户实测事故）
 *
 * 事故链：转场交叠让成片比时间轴短（每刀短 `durationSeconds`）→ 字幕按时间轴写时间 →
 * 尾部字幕溢出成片时长 → 软字幕内嵌把容器时长拉回时间轴长度 → `duration_kept` 硬闸失败，
 * "转场 + 字幕"组合直接交付不出去（实测母版 6.933s 被尾字幕拉回 7.4s）。
 *
 * 这里钉住四件事：
 * ① 映射语义：时间轴时间 → 成片时间（每刀在**进入镜头**处前移该刀重叠，逐刀累加）；
 * ② 变体各按自己的实际转场回执映射（同一份字幕在不同变体上是不同时间，不能只算母版）；
 * ③ 尾部越界夹到片尾、完全越界的条丢弃并留痕；硬切 = 恒等映射；
 * ④ 软轨内嵌兜底：按容器时长钳制尾条、丢弃越界条，不改正常条。
 */
import { describe, expect, it } from "vitest";

import {
  buildTransitionTimemap,
  clampCuesToDuration,
  cuesToSrt,
  parseSrt,
  retimeCuesForTransitions,
} from "./core.mjs";

/** 两镜 7.4s 时间轴（与事故复现实验同一组数据）。 */
const SEGMENTS = [
  { segmentId: "seg-001", durationSeconds: 3.6 },
  { segmentId: "seg-002", durationSeconds: 3.8 },
];

const CUES = [
  { start: "0:00:00.00", end: "0:00:03.60", text: "第一镜" },
  { start: "0:00:03.60", end: "0:00:07.40", text: "第二镜" },
];

const times = (cues: Array<{ start: string; end: string }>) => cues.map((cue) => [cue.start, cue.end]);

describe("转场交叠时间映射（纯函数，不需要 FFmpeg）", () => {
  it("每刀在进入镜头处前移该刀重叠：7.4s 时间轴 + 0.5s 交叠 → 6.9s 成片时间", () => {
    const timemap = buildTransitionTimemap(
      SEGMENTS,
      [{ incomingSegmentId: "seg-002", durationSeconds: 0.5 }],
      { outputDurationSeconds: 6.933 },
    );
    expect(timemap.totalOverlapSeconds).toBe(0.5);
    expect(timemap.timelineDurationSeconds).toBe(7.4);
    expect(timemap.mapSeconds(0)).toBe(0);
    expect(timemap.mapSeconds(3.6)).toBe(3.1);

    const retimed = retimeCuesForTransitions(CUES, timemap);
    expect(times(retimed.cues)).toEqual([
      ["0:00:00.00", "0:00:03.10"],
      ["0:00:03.10", "0:00:06.90"],
    ]);
    expect(retimed.dropped).toEqual([]);
    expect(retimed.cues[1]!.text).toBe("第二镜");
  });

  it("变体各按自己的实际转场回执映射：暖调 0.747s 与干净版 0.298s 得到不同成片时间", () => {
    const warm = retimeCuesForTransitions(CUES, buildTransitionTimemap(
      SEGMENTS, [{ incomingSegmentId: "seg-002", durationSeconds: 0.747 }], { outputDurationSeconds: 6.7 },
    ));
    const clean = retimeCuesForTransitions(CUES, buildTransitionTimemap(
      SEGMENTS, [{ incomingSegmentId: "seg-002", durationSeconds: 0.298 }], { outputDurationSeconds: 7.202 },
    ));
    expect(times(warm.cues)).toEqual([
      ["0:00:00.00", "0:00:02.85"],
      ["0:00:02.85", "0:00:06.65"],
    ]);
    expect(times(clean.cues)).toEqual([
      ["0:00:00.00", "0:00:03.30"],
      ["0:00:03.30", "0:00:07.10"],
    ]);
    /** 只按母版算一次的实现会在这条上失败：变体之间的时间必须不同。 */
    expect(times(warm.cues)).not.toEqual(times(clean.cues));
  });

  it("硬切是恒等映射；越界条丢弃并留痕；尾部条夹到片尾", () => {
    const identity = retimeCuesForTransitions(CUES, buildTransitionTimemap(
      SEGMENTS, [], { outputDurationSeconds: 7.4 },
    ));
    expect(times(identity.cues)).toEqual(times(CUES));

    const short = retimeCuesForTransitions(CUES, buildTransitionTimemap(
      SEGMENTS, [{ incomingSegmentId: "seg-002", durationSeconds: 0.5 }], { outputDurationSeconds: 3 },
    ));
    expect(times(short.cues)).toEqual([["0:00:00.00", "0:00:03.00"]]);
    expect(short.dropped).toEqual([1]);
  });

  it("重映射后的字幕能落盘再读回（旁挂 SRT 口径不变形）", () => {
    const retimed = retimeCuesForTransitions(CUES, buildTransitionTimemap(
      SEGMENTS, [{ incomingSegmentId: "seg-002", durationSeconds: 0.5 }], { outputDurationSeconds: 6.933 },
    ));
    const roundTrip = parseSrt(cuesToSrt(retimed.cues));
    expect(times(roundTrip)).toEqual(times(retimed.cues));
    expect(roundTrip.map((cue) => cue.text)).toEqual(retimed.cues.map((cue) => cue.text));
  });
});

describe("软字幕内嵌的容器时长兜底（纯函数）", () => {
  it("尾条钳到容器时长，完全越界的条被丢弃，正常条不动", () => {
    const clamped = clampCuesToDuration(CUES, 6.7);
    expect(clamped.clamped).toEqual([1]);
    expect(clamped.removed).toEqual([]);
    /** 越界幅度留痕：交付闸用它区分"编码量化（≤0.1s）"与"重映射失效（>0.1s）"。 */
    expect(clamped.maxOvershootSeconds).toBeCloseTo(0.7, 3);
    expect(times(clamped.cues)).toEqual([
      ["0:00:00.00", "0:00:03.60"],
      ["0:00:03.60", "0:00:06.70"],
    ]);
  });

  it("容器更短时前一条保留（尾钳）、后一条丢弃；时长不可用时原样返回", () => {
    const clamped = clampCuesToDuration(CUES, 3);
    expect(clamped.clamped).toEqual([0]);
    expect(clamped.removed).toEqual([1]);
    expect(clamped.maxOvershootSeconds).toBeCloseTo(0.6, 3);
    expect(times(clamped.cues)).toEqual([["0:00:00.00", "0:00:03.00"]]);

    expect(times(clampCuesToDuration(CUES, 0).cues)).toEqual(times(CUES));
    expect(clampCuesToDuration(CUES, Number.NaN).limitSeconds).toBeNull();
  });
});
