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

/**
 * 口播口径（2026-10-11，随 AI 口播精剪管线新增）：
 * 口播字幕跟着说话出字——不套 ≥2s 门槛与字数带，改守"一屏两行 ≤24 字"与"逐字等于 ASR 稿"。
 */
describe("edit/caption：口播口径（--talk）", () => {
  const talkTimeline = (durations: number[]): EditTimeline => timelineOf(durations);

  const talkCaption = (
    entries: Array<{ segmentId: string; text: string; source: string }>,
    totalSeconds: number,
  ): CaptionDocInput => ({
    video_title: "口播测试",
    video_id: "20261011-abcd1234",
    total_duration: `00:${String(Math.round(totalSeconds)).padStart(2, "0")}`,
    video_groups: [{
      group_name: "口播正片",
      /** 组时长必须与镜头时长之和一致（契约硬项），测试夹具按参数生成，避免与断言无关的硬失败。 */
      group_duration: `00:${String(Math.round(totalSeconds)).padStart(2, "0")}`,
      shots: entries.map((entry) => ({
        segmentId: entry.segmentId,
        original_timestamp: "00:00:00.000-00:00:10.000",
        source_timestamp: entry.source,
        subtitle_text: [{ text: entry.text }],
      })),
    }],
  });

  const transcript = {
    sentences: [{
      id: "s001",
      words: [
        { text: "大家", start: 0, end: 0.4 },
        { text: "好", start: 0.4, end: 0.7 },
        { text: "我", start: 0.8, end: 1.0 },
        { text: "想说", start: 1.0, end: 1.3 },
        { text: "三个", start: 10.0, end: 10.3 },
        { text: "方法", start: 10.3, end: 10.6 },
      ],
    }],
  };

  it("短段也要出字：1.2s 段落的 5 字字幕在口播口径下通过（标准口径会报 tooShort）", () => {
    const timeline = talkTimeline([1.2]);
    const caption = talkCaption([{ segmentId: "seg-001", text: "大家好", source: "0.000-0.700" }], 1.2);
    const talk = analyzeCaption({ timeline, caption, mode: "talk", transcript });
    expect(talk.ok).toBe(true);
    const standard = analyzeCaption({ timeline, caption });
    expect(standard.ok).toBe(false);
    /** 标准口径下 1.2s 单镜要么被判"太短不上字幕"，要么落在 VMG 里被判"合并太短"——两者都是硬失败。 */
    expect(standard.issues.some((issue) => issue.severity === "hard" && /caption\.(tooShort|vmgTooShort)/u.test(issue.id))).toBe(true);
  });

  it("一屏上限：超过两行 / 24 字 / 单行 12 字都为硬失败", () => {
    const timeline = talkTimeline([6]);
    const tooLong = analyzeCaption({
      timeline,
      caption: talkCaption([{
        segmentId: "seg-001",
        text: "这是一句明显超过一屏两行限制的口播字幕内容特别长真的很长",
        source: "0.000-0.700",
      }], 6),
      mode: "talk",
      transcript,
    });
    expect(tooLong.ok).toBe(false);
    expect(tooLong.issues.some((issue) => issue.id.startsWith("caption.talkLength:"))).toBe(true);

    const threeLines = analyzeCaption({
      timeline,
      caption: talkCaption([{ segmentId: "seg-001", text: "第一行\n第二行\n第三行", source: "0.000-0.700" }], 6),
      mode: "talk",
      transcript,
    });
    expect(threeLines.ok).toBe(false);
    expect(threeLines.issues.some((issue) => issue.id.startsWith("caption.talkLines:"))).toBe(true);

    const wideLine = analyzeCaption({
      timeline,
      caption: talkCaption([{ segmentId: "seg-001", text: "这是一行超过十二个字的宽行", source: "0.000-0.700" }], 6),
      mode: "talk",
      transcript,
    });
    expect(wideLine.ok).toBe(false);
    expect(wideLine.issues.some((issue) => issue.id.startsWith("caption.talkLineChars:"))).toBe(true);
  });

  it("逐字一致：字幕与 ASR 稿不一致即硬失败；一致时通过", () => {
    const timeline = talkTimeline([1.5, 1.5]);
    const good = talkCaption([
      { segmentId: "seg-001", text: "大家好", source: "0.000-0.700" },
      { segmentId: "seg-002", text: "我想说三个方法", source: "0.800-10.600" },
    ], 3);
    const goodResult = analyzeCaption({ timeline, caption: good, mode: "talk", transcript });
    expect(goodResult.issues.filter((issue) => issue.id.startsWith("caption.verbatim"))).toEqual([]);
    expect(goodResult.ok).toBe(true);

    const rewritten = talkCaption([
      { segmentId: "seg-001", text: "各位好", source: "0.000-0.700" },
      { segmentId: "seg-002", text: "我想说三个方法", source: "0.800-10.600" },
    ], 3);
    const badResult = analyzeCaption({ timeline, caption: rewritten, mode: "talk", transcript });
    expect(badResult.ok).toBe(false);
    expect(badResult.issues.some((issue) => issue.id === "caption.verbatim:seg-001" && issue.severity === "hard")).toBe(true);
  });

  it("未提供逐字稿时只出咨询提示（不得伪称已校验）", () => {
    const timeline = talkTimeline([1.5]);
    const caption = talkCaption([{ segmentId: "seg-001", text: "大家好", source: "0.000-0.700" }], 1.5);
    const result = analyzeCaption({ timeline, caption, mode: "talk" });
    expect(result.ok).toBe(true);
    expect(result.issues.some((issue) => issue.id === "caption.verbatimUnchecked:seg-001" && issue.severity === "advisory")).toBe(true);
  });
});
