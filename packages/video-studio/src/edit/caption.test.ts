import { describe, expect, it } from "vitest";
import {
  analyzeCaption, captionCharBand, countVisualChars, cuesToSrtBody, srtTimestamp, type CaptionDocInput,
} from "./caption.js";
import type { EditTimeline } from "./timeline.js";

function timelineOf(durations: number[]): EditTimeline {
  return {
    schemaVersion: "workloom.video-edit/edit-timeline/v2",
    timelineId: "tl-1",
    target: { durationSeconds: durations.reduce((sum, value) => sum + value, 0), aspectRatio: "9:16", fps: 30, platform: "抖音" },
    sources: [{ sourceId: "src-a", sha256: "a".repeat(64), path: "/tmp/a.mp4", fps: 30, durationSeconds: 600 }],
    segments: durations.map((duration, index) => ({
      seq: index,
      segmentId: `seg-${String(index + 1).padStart(3, "0")}`,
      groupId: "g1",
      sourceId: "src-a",
      sourceIn: index * 10,
      sourceOut: index * 10 + duration,
      durationSeconds: duration,
    })),
    audioDesign: { originalAudioPolicy: "keep" },
  };
}

function captionOf(
  entries: Array<{ segmentId: string; text?: string; role?: string }>,
  extras: Partial<CaptionDocInput> = {},
  groupDuration = "00:10",
  totalDuration = groupDuration,
): CaptionDocInput {
  return {
    video_title: "回家喝羊汤",
    video_id: "20261011-abcd1234",
    total_duration: totalDuration,
    video_groups: [{
      group_name: "主片",
      group_duration: groupDuration,
      shots: entries.map((entry) => ({
        segmentId: entry.segmentId,
        original_timestamp: "00:00:00.000-00:00:10.000",
        subtitle_text: entry.text === undefined ? [] : [{ text: entry.text }],
        ...(entry.role ? { role: entry.role } : {}),
      })),
    }],
    ...extras,
  };
}

describe("edit/caption：字幕规则引擎", () => {
  it("字数带：ceil(时长×2.0) – floor(时长×2.5)", () => {
    expect(captionCharBand(3)).toEqual({ min: 6, max: 7 });
    expect(captionCharBand(4.5)).toEqual({ min: 9, max: 11 });
    expect(() => captionCharBand(0)).toThrow();
  });

  it("普通镜头：≥2s 有字幕且字数在带内 → 通过；VMG 之外 <2s 有字 → 阻断", () => {
    const ok = analyzeCaption({
      timeline: timelineOf([3, 3, 3]),
      caption: captionOf([
        { segmentId: "seg-001", text: "今天回家看看" },
        { segmentId: "seg-002", text: "开十小时的车" },
        { segmentId: "seg-003", text: "就为这口羊汤" },
      ], {}, "00:09"),
    });
    expect(ok.issues.filter((issue) => issue.severity === "hard")).toEqual([]);
    expect(ok.cues.map((cue) => cue.segmentId)).toEqual(["seg-001", "seg-002", "seg-003"]);

    const missing = analyzeCaption({
      timeline: timelineOf([3, 3]),
      caption: captionOf([{ segmentId: "seg-001", text: "今天回家看看" }, { segmentId: "seg-002" }], {}, "00:03", "00:06"),
    });
    expect(missing.issues.some((issue) => issue.id === "caption.missing:seg-002" && issue.severity === "hard")).toBe(true);
  });

  it("VMG：连续短镜只允许首镜写概括字幕；合并 ≤3.9s 不应上字；总时长超限缺字给建议", () => {
    const vmgOk = analyzeCaption({
      timeline: timelineOf([1.5, 1.5, 1.5, 3]),
      caption: captionOf([
        { segmentId: "seg-001", text: "国庆高速堵了六小时" },
        { segmentId: "seg-004", text: "终于到家喝汤" },
      ], {}, "00:05", "00:08"),
    });
    expect(vmgOk.issues.filter((issue) => issue.severity === "hard")).toEqual([]);
    expect(vmgOk.metrics.vmgGroups).toEqual([{ headSegmentId: "seg-001", segmentIds: ["seg-001", "seg-002", "seg-003"], totalSeconds: 4.5, captionChars: 9 }]);
    expect(vmgOk.cues[0]!.vmg).toEqual({ head: true, size: 3, totalSeconds: 4.5 });

    const misplaced = analyzeCaption({
      timeline: timelineOf([1.5, 1.5, 1.5, 3]),
      caption: captionOf([{ segmentId: "seg-002", text: "国庆高速堵了六小时" }], {}, "00:02", "00:08"),
    });
    expect(misplaced.issues.some((issue) => issue.id === "caption.vmgPlacement:seg-002" && issue.severity === "hard")).toBe(true);

    const tooShort = analyzeCaption({
      timeline: timelineOf([1, 1, 3]),
      caption: captionOf([{ segmentId: "seg-001", text: "短组" }, { segmentId: "seg-003", text: "终于到家喝汤" }], {}, "00:04"),
    });
    expect(tooShort.issues.some((issue) => issue.id === "caption.vmgTooShort:seg-001" && issue.severity === "hard")).toBe(true);

    const missing = analyzeCaption({
      timeline: timelineOf([1.5, 1.5, 1.5, 3]),
      caption: captionOf([{ segmentId: "seg-004", text: "终于到家喝汤" }], {}, "00:03", "00:08"),
    });
    expect(missing.issues.some((issue) => issue.id === "caption.vmgMissing:seg-001" && issue.severity === "advisory")).toBe(true);
  });

  it("格式与读感：标点/Emoji 阻断；行数与行宽给建议；时间轴重叠阻断、间隔过窄提示", () => {
    const result = analyzeCaption({
      timeline: timelineOf([3, 3, 3]),
      caption: captionOf([
        { segmentId: "seg-001", text: "今天回家看看。" },
        { segmentId: "seg-002", text: "开十小时的车😄" },
        { segmentId: "seg-003", text: "就为这口\n羊汤真香" },
      ], {}, "00:09"),
    });
    expect(result.issues.some((issue) => issue.id === "caption.punct:seg-001" && issue.severity === "hard")).toBe(true);
    expect(result.issues.some((issue) => issue.id === "caption.emoji:seg-002" && issue.severity === "hard")).toBe(true);
    expect(result.metrics.maxCueSeconds).toBe(3);
    expect(result.metrics.minGapSeconds).toBe(0);
    expect(result.issues.some((issue) => issue.id === "caption.gap:seg-002" && issue.severity === "advisory")).toBe(true);
  });

  it("信息密度/语速：同段口语 20 字、字幕 5 字 → 低密度建议 + 语速可复算", () => {
    const result = analyzeCaption({
      timeline: timelineOf([5]),
      caption: captionOf([{ segmentId: "seg-001", text: "到了家" }], {}, "00:05"),
      analyses: [{
        asset: { sha256: "a".repeat(64), localPath: "/tmp/a.mp4" },
        probe: {
          speech: {
            sentences: [
              { text: "今天终于回家喝上羊汤", start: 1, end: 3 },
            ],
          },
        },
      }],
    });
    const row = result.metrics.density[0]!;
    expect(row.speechChars).toBe(10);
    expect(row.speechRateCps).toBe(5);
    expect(row.densityRatio).toBeCloseTo(0.3, 2);
    expect(row.recommendedMinChars).toBe(10);
    expect(result.issues.some((issue) => issue.id === "caption.densityLow:seg-001" && issue.severity === "advisory")).toBe(true);
  });

  it("结尾话术块豁免字数带；标题与 total_duration 走事实口径", () => {
    const result = analyzeCaption({
      timeline: timelineOf([3, 3]),
      caption: captionOf([
        { segmentId: "seg-001", text: "今天回家看看" },
        { segmentId: "seg-002", text: "看到这里感觉怎么样记得关注我", role: "ending-cta" },
      ], {}, "00:06"),
    });
    expect(result.issues.filter((issue) => issue.severity === "hard")).toEqual([]);
    const title = analyzeCaption({
      timeline: timelineOf([3]),
      caption: captionOf([{ segmentId: "seg-001", text: "今天回家看看" }], { video_title: "这是一个超过十二个字的封面标题" }, "00:03"),
    });
    expect(title.issues.some((issue) => issue.id === "caption.title" && issue.severity === "hard")).toBe(true);
  });

  it("SRT 输出：毫秒进位不产出 ,1000；条目按开始时间排序", () => {
    expect(srtTimestamp(1.9997)).toBe("00:00:02,000");
    expect(srtTimestamp(0)).toBe("00:00:00,000");
    const result = analyzeCaption({
      timeline: timelineOf([3, 3]),
      caption: captionOf([{ segmentId: "seg-002", text: "开十小时的车" }, { segmentId: "seg-001", text: "今天回家看看" }], {}, "00:06"),
    });
    const srt = cuesToSrtBody(result.cues);
    expect(srt.split("\n")[0]).toBe("1");
    expect(srt).toContain("00:00:00,000 --> 00:00:03,000");
    expect(srt).toContain("00:00:03,000 --> 00:00:06,000");
    expect(countVisualChars("一二三\n四")).toBe(4);
  });
});
