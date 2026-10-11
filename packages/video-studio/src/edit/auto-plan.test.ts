import { describe, expect, it } from "vitest";
import { planAutoCaptions, planAutoTimeline, type AutoPlanAnalysisDoc, type AutoPlanSource } from "./auto-plan.js";
import { validateEditTimeline } from "./timeline.js";

function analysis(overrides: Partial<AutoPlanAnalysisDoc> = {}): AutoPlanAnalysisDoc {
  return {
    asset: { filename: "a.mp4", durationSeconds: 120, fps: 30, hasAudio: true },
    probe: {
      shotBoundaries: [
        { index: 0, inTimecode: "00:00:00.000", outTimecode: "00:00:04.000", durationSeconds: 4 },
        { index: 1, inTimecode: "00:00:04.000", outTimecode: "00:00:08.000", durationSeconds: 4 },
        { index: 2, inTimecode: "00:00:20.000", outTimecode: "00:00:26.000", durationSeconds: 6 },
        { index: 3, inTimecode: "00:00:30.000", outTimecode: "00:00:36.000", durationSeconds: 6 },
      ],
      technical: {
        perShot: [
          { index: 0, sharpness: 0.9, exposure: 0.9 },
          { index: 1, sharpness: 0.85, exposure: 0.8 },
          { index: 2, sharpness: 0.2, exposure: 0.3 },
          { index: 3, sharpness: 0.9, exposure: 0.85 },
        ],
      },
      speech: {
        sentences: [
          { text: "今天带你去古城夜市", start: 0.5, end: 3.5 },
          { text: "这家店开了二十年", start: 4.5, end: 7.5 },
        ],
        words: [
          { text: "今天", start: 0.5, end: 0.9 },
          { text: "带你", start: 0.9, end: 1.3 },
          { text: "去", start: 1.3, end: 1.5 },
          { text: "古城", start: 1.5, end: 1.9 },
          { text: "夜市", start: 1.9, end: 2.4 },
        ],
      },
    },
    ...overrides,
  };
}

function source(overrides: Partial<AutoPlanSource> = {}): AutoPlanSource {
  return {
    sourceId: "src-1",
    path: "/tmp/a.mp4",
    sha256: "a".repeat(64),
    fps: 30,
    durationSeconds: 120,
    hasAudio: true,
    analysis: analysis(),
    ...overrides,
  };
}

describe("edit/auto-plan：零输入自动排片", () => {
  it("按源顺序选镜；相邻同源镜头合并；输出满足时间轴硬契约", () => {
    const result = planAutoTimeline({
      sources: [source()],
      timelineId: "auto-1",
      target: { durationSeconds: 20, aspectRatio: "9:16", fps: 30, platform: "抖音" },
      pacing: "documentary",
    });
    expect(result.selected.length).toBeGreaterThan(0);
    /** 开头两个相邻镜头（0–4 / 4–8）应合并为一段，避免"同源间隔 0"违反契约。 */
    expect(result.selected[0]!.mergedFrom).toBe(2);
    expect(result.selected[0]!.sourceIn).toBe(0);
    expect(result.selected[0]!.sourceOut).toBe(8);
    const validation = validateEditTimeline(result.timeline);
    const hardFailures = validation.checks.filter((check) => check.hard && !check.pass);
    expect(hardFailures.map((check) => check.id)).toEqual([]);
    expect(result.timeline.validation?.continuous).toBe(true);
  });

  it("超长镜头取居中窗口；质量分低的镜头在有更好选择时跳过", () => {
    const long = planAutoTimeline({
      sources: [source({ analysis: analysis({ probe: { shotBoundaries: [{ index: 0, inTimecode: "00:00:00.000", outTimecode: "00:00:30.000", durationSeconds: 30 }] } }) })],
      timelineId: "auto-2",
      target: { durationSeconds: 10, aspectRatio: "9:16", fps: 30, platform: "抖音" },
      maxShotSeconds: 8,
    });
    expect(long.selected[0]!.durationSeconds).toBe(8);
    expect(long.selected[0]!.sourceIn).toBe(11);

    const skipped = planAutoTimeline({
      sources: [source()],
      timelineId: "auto-3",
      target: { durationSeconds: 20, aspectRatio: "9:16", fps: 30, platform: "抖音" },
      qualityFloor: 0.5,
    });
    expect(skipped.skipped.some((entry) => entry.shotId.includes("s003"))).toBe(true);
  });

  it("字幕与逐字稿：按词截断到 24 字、无语音段如实留空并记录 gap", () => {
    const plan = planAutoTimeline({
      sources: [source()],
      timelineId: "auto-4",
      target: { durationSeconds: 20, aspectRatio: "9:16", fps: 30, platform: "抖音" },
    });
    const withSilent = {
      ...plan.timeline,
      segments: [...plan.timeline.segments, {
        seq: plan.timeline.segments.length,
        segmentId: "auto-999",
        sourceId: "src-1",
        sourceIn: 40,
        sourceOut: 45,
        durationSeconds: 5,
      }],
    };
    const captions = planAutoCaptions({ timeline: withSilent, sources: [{ sourceId: "src-1", analysis: analysis() }] });
    /** 只有第一段（含语音词）出字幕；无语音的段与追加的静音段都进 gaps。 */
    expect(captions.cues).toBe(1);
    const first = (captions.captionDoc.video_groups as Array<{ shots: Array<{ subtitle_text: Array<{ text: string }> }> }>)[0]!.shots[0]!;
    expect([...first.subtitle_text[0]!.text].length).toBeLessThanOrEqual(24);
    expect(captions.gaps.some((gap) => gap.includes("auto-999"))).toBe(true);
    expect(captions.gaps.length).toBeGreaterThanOrEqual(2);
    expect(captions.transcript.sentences.length).toBeGreaterThan(0);
    expect(captions.transcript.sentences[0]!.words.length).toBeGreaterThan(0);
  });
});
