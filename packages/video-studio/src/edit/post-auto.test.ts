import { describe, expect, it } from "vitest";
import { deriveCoverTheme, planCoverMoment, planCoverMoments, planSegmentColor, type ColorRecipe, type PostAnalysisDoc } from "./post-auto.js";
import type { EditTimeline } from "./timeline.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function timeline(): EditTimeline {
  return {
    schemaVersion: "workloom.video-edit/edit-timeline/v2",
    timelineId: "tl-post",
    target: { durationSeconds: 4, aspectRatio: "9:16", fps: 30, platform: "抖音" },
    groups: [
      { groupId: "g-warm", name: "饭桌上的团圆", storyline: "回家吃饭", emotion: "温暖", intensity: 0.8 },
      { groupId: "g-cool", name: "城市通勤", storyline: "清晨出发", emotion: "克制", intensity: 0.5 },
      { groupId: "g-screen", name: "录屏演示", emotion: "中性", intensity: 0.4 },
    ],
    sources: [
      { sourceId: "src-a", sha256: SHA_A, path: "/tmp/a.mp4", fps: 30, durationSeconds: 10 },
      { sourceId: "src-b", sha256: SHA_B, path: "/tmp/b.mp4", fps: 30, durationSeconds: 10 },
    ],
    segments: [
      { seq: 0, segmentId: "seg-001", groupId: "g-warm", sourceId: "src-a", sourceIn: 0, sourceOut: 2, durationSeconds: 2 },
      { seq: 1, segmentId: "seg-002", groupId: "g-cool", sourceId: "src-b", sourceIn: 2, sourceOut: 4, durationSeconds: 2 },
      { seq: 2, segmentId: "seg-003", groupId: "g-screen", sourceId: "src-b", sourceIn: 4, sourceOut: 6, durationSeconds: 2 },
    ],
    audioDesign: { originalAudioPolicy: "keep" },
  };
}

const RECIPES: ColorRecipe[] = [
  { id: "food-appetite", genre: "美食 / 餐饮", scene: "菜品特写", mood: "诱人温暖", profile: "warm-film", lut: "look-warm-film.cube", intensity: 0.85 },
  { id: "tech-dark-ui", genre: "科技 / SaaS", scene: "夜景都市", mood: "冷净", profile: "cool-technical", lut: "look-cool-technical.cube", intensity: 0.6 },
];

describe("edit/post-auto：后期自动决策", () => {
  it("封面取帧：优先 composition_best 关键帧并映射到主轨；不可用候选被跳过", () => {
    const analyses: PostAnalysisDoc[] = [
      {
        asset: { sha256: SHA_A, localPath: "/tmp/a.mp4" },
        shots: [{ shotId: "shot-001", inTimecode: "00:00:00.000", outTimecode: "00:00:02.000", sceneType: "on_location" }],
        keyframes: [
          { keyframeId: "kf-emotion", shotId: "shot-001", kind: "emotion_peak", timecode: "00:00:01.000", score: 0.95, technical: { sharpness: 0.9, textSafe: true } },
          { keyframeId: "kf-compose", shotId: "shot-001", kind: "composition_best", timecode: "00:00:01.500", score: 0.8, technical: { sharpness: 0.8, textSafe: true } },
        ],
      },
    ];
    const plan = planCoverMoment({ timeline: timeline(), analyses });
    expect(plan.basis).toBe("keyframe-composition");
    expect(plan.keyframeId).toBe("kf-compose");
    expect(plan.masterSeconds).toBe(1.5);
    // 主轨总长 6s（3×2s），1.5s 落点 → 0.25
    expect(plan.ratio).toBeCloseTo(0.25, 3);

    const unsafe: PostAnalysisDoc[] = [{
      asset: { sha256: SHA_A },
      keyframes: [
        { keyframeId: "kf-bad", shotId: "s", kind: "composition_best", timecode: "00:00:01.000", score: 0.99, technical: { sharpness: 0.9, textSafe: false } },
        { keyframeId: "kf-blur", shotId: "s", kind: "composition_best", timecode: "00:00:01.200", score: 0.99, technical: { sharpness: 0.2, textSafe: true } },
      ],
    }];
    const fallback = planCoverMoment({ timeline: timeline(), analyses: unsafe, fallbackRatio: 0.32 });
    expect(fallback.basis).toBe("fallback");
    expect(fallback.ratio).toBe(0.32);
  });

  it("封面取帧：第二段关键帧按主轨偏移换算；无解析结果回退配方比例", () => {
    const analyses: PostAnalysisDoc[] = [{
      asset: { sha256: SHA_B },
      keyframes: [{ keyframeId: "kf-2", shotId: "shot-2", kind: "emotion_peak", timecode: "00:00:03.000", score: 0.7, technical: { textSafe: true } }],
    }];
    const plan = planCoverMoment({ timeline: timeline(), analyses });
    expect(plan.basis).toBe("keyframe-emotion");
    expect(plan.segmentId).toBe("seg-002");
    expect(plan.masterSeconds).toBe(3);
    expect(plan.ratio).toBeCloseTo(0.5, 3);
    expect(planCoverMoment({ timeline: timeline() }).basis).toBe("fallback");
  });

  it("封面多帧：每个变体一个互不相同的时刻（同镜头只用一次，候选不足用分散兜底）", () => {
    const analyses: PostAnalysisDoc[] = [
      {
        asset: { sha256: SHA_A },
        keyframes: [
          { keyframeId: "kf-a1", shotId: "s1", kind: "composition_best", timecode: "00:00:01.000", score: 0.9, technical: { textSafe: true } },
          { keyframeId: "kf-a2", shotId: "s1b", kind: "emotion_peak", timecode: "00:00:01.800", score: 0.7, technical: { textSafe: true } },
        ],
      },
      {
        asset: { sha256: SHA_B },
        keyframes: [{ keyframeId: "kf-b1", shotId: "s2", kind: "emotion_peak", timecode: "00:00:03.000", score: 0.8, technical: { textSafe: true } }],
      },
    ];
    const moments = planCoverMoments({ timeline: timeline(), analyses, count: 4 });
    expect(moments).toHaveLength(4);
    expect(moments[0]!.basis).toBe("keyframe-composition");
    // 同镜头候选只用一次：第一段只出 1 个（其余由兜底补齐），不同时刻互不相同
    expect(new Set(moments.map((moment) => moment.ratio)).size).toBe(4);
    const fallback = planCoverMoments({ timeline: timeline(), count: 4 });
    expect(fallback.every((moment) => moment.basis === "fallback")).toBe(true);
    expect(new Set(fallback.map((moment) => moment.ratio)).size).toBe(4);
  });

  it("分段调色：暖词/冷词/中性按组投票出 LUT 与强度，中性组不叠加统一调色", () => {
    const analyses: PostAnalysisDoc[] = [
      {
        asset: { sha256: SHA_A },
        shots: [{ shotId: "s1", inTimecode: "00:00:00.000", outTimecode: "00:00:02.000", sceneType: "on_location", editing: { colorGradeBase: "暖调" }, emotion: { valence: 0.6 } }],
      },
      {
        asset: { sha256: SHA_B },
        shots: [
          { shotId: "s2", inTimecode: "00:00:02.000", outTimecode: "00:00:04.000", sceneType: "on_location", editing: { colorGradeBase: "冷调" }, emotion: { valence: -0.4 } },
          { shotId: "s3", inTimecode: "00:00:04.000", outTimecode: "00:00:06.000", sceneType: "screen_recording", editing: { colorGradeBase: "保持原色" } },
        ],
      },
    ];
    const plan = planSegmentColor({ timeline: timeline(), analyses, recipes: RECIPES, availableLuts: ["look-warm-film.cube", "look-cool-technical.cube"] });
    const warm = plan.assignments.find((entry) => entry.segmentId === "seg-001")!;
    const cool = plan.assignments.find((entry) => entry.segmentId === "seg-002")!;
    const neutral = plan.assignments.find((entry) => entry.segmentId === "seg-003")!;
    expect(warm.profile).toBe("warm-film");
    expect(warm.lut).toBe("look-warm-film.cube");
    expect(warm.intensity).toBeGreaterThanOrEqual(0.4);
    expect(cool.profile).toBe("cool-technical");
    expect(cool.lut).toBe("look-cool-technical.cube");
    expect(neutral.profile).toBe("none");
    expect(neutral.lut).toBeNull();
    expect(plan.warnings).toEqual([]);
    expect(warm.basis).toContain("votes warm=");
  });

  it("分段调色：显式覆盖优先；LUT 不在白名单时回退并留 warning", () => {
    const analyses: PostAnalysisDoc[] = [{
      asset: { sha256: SHA_A },
      shots: [{ shotId: "s1", inTimecode: "00:00:00.000", outTimecode: "00:00:02.000", editing: { colorGradeBase: "暖调" } }],
    }];
    const override = planSegmentColor({
      timeline: timeline(),
      analyses,
      recipes: RECIPES,
      legacyGroupMap: { "g-warm": { lut: "look-custom.cube", intensity: 0.66 } },
      availableLuts: ["look-custom.cube"],
    });
    expect(override.assignments.find((entry) => entry.segmentId === "seg-001")!.lut).toBe("look-custom.cube");
    const missing = planSegmentColor({
      timeline: timeline(),
      analyses,
      recipes: RECIPES,
      legacyGroupMap: { "g-warm": { lut: "look-custom.cube", intensity: 0.66 } },
      availableLuts: ["look-warm-film.cube", "look-cool-technical.cube"],
    });
    expect(missing.assignments.find((entry) => entry.segmentId === "seg-001")!.lut).toBe("look-warm-film.cube");
    expect(missing.warnings.length).toBe(1);
    /** 零票组也必须吃显式覆盖：否则"显式指定"会被"证据不足→不调色"吞掉（实机踩坑） */
    const zeroVoteOverride = planSegmentColor({
      timeline: timeline(),
      analyses,
      recipes: RECIPES,
      legacyGroupMap: { "g-screen": { lut: "look-warm-film.cube", intensity: 0.55 } },
      availableLuts: ["look-warm-film.cube", "look-cool-technical.cube"],
    });
    const screen = zeroVoteOverride.assignments.find((entry) => entry.segmentId === "seg-003")!;
    expect(screen.lut).toBe("look-warm-film.cube");
    expect(screen.intensity).toBe(0.55);
    expect(screen.basis).toContain("显式覆盖");
  });

  it("封面主题内容驱动：命中题材取题材，无证据回退通用主题并注明", () => {
    const food = deriveCoverTheme({
      analyses: [{
        contentDomain: "美食探店",
        shots: [{ shotId: "s1", content: { keyEntities: ["羊汤", "火锅"], onScreenText: "20年老店" } }],
      }],
    });
    expect(food.theme).toBe("美食");
    expect(food.keywords.length).toBeGreaterThan(0);
    const empty = deriveCoverTheme({ analyses: [] });
    expect(empty.theme).toBe("生活");
    expect(empty.basis).toContain("未命中");
  });

  it("实体参与分段调色投票：食物/家 → 暖；海/城市 → 冷（内容驱动，不再依赖场景名）", () => {
    const plan = planSegmentColor({
      timeline: timeline(),
      analyses: [
        {
          asset: { sha256: SHA_A },
          shots: [{ shotId: "s1", inTimecode: "00:00:00.000", outTimecode: "00:00:02.000", sceneType: "on_location", content: { keyEntities: ["火锅", "羊汤"], onScreenText: "家里的味道" } }],
        },
        {
          asset: { sha256: SHA_B },
          shots: [
            { shotId: "s2", inTimecode: "00:00:02.000", outTimecode: "00:00:04.000", sceneType: "on_location", content: { keyEntities: ["海边", "城市天际线"] } },
            { shotId: "s3", inTimecode: "00:00:04.000", outTimecode: "00:00:06.000", sceneType: "on_location", content: { keyEntities: ["雪山"] } },
          ],
        },
      ],
      recipes: RECIPES,
      availableLuts: ["look-warm-film.cube", "look-cool-technical.cube"],
    });
    expect(plan.assignments.find((entry) => entry.segmentId === "seg-001")!.profile).toBe("warm-film");
    expect(plan.assignments.find((entry) => entry.segmentId === "seg-002")!.profile).toBe("cool-technical");
    /** 录屏组（g-screen，"录屏演示"命中中性词）保持中性：录屏不叠加风格化调色。 */
    expect(plan.assignments.find((entry) => entry.segmentId === "seg-003")!.profile).toBe("none");
  });
});
