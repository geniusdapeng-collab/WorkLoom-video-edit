import { describe, expect, it } from "vitest";
import { computeMasterTimeline, planAssembly, validateEditTimeline, type EditTimeline } from "./timeline.js";

const SHA = "a".repeat(64);

function baseTimeline(overrides: Partial<EditTimeline> = {}): EditTimeline {
  return {
    schemaVersion: "workloom.video-edit/edit-timeline/v2",
    timelineId: "tl-test",
    target: { durationSeconds: 30, aspectRatio: "9:16", fps: 30, platform: "douyin" },
    sources: [{ sourceId: "src-1", sha256: SHA, path: "/tmp/src1.mp4", fps: 30, durationSeconds: 120 }],
    segments: [
      { seq: 0, segmentId: "s1", sourceId: "src-1", sourceIn: 0, sourceOut: 15, durationSeconds: 15, transitionIn: { type: "cut" } },
      { seq: 1, segmentId: "s2", sourceId: "src-1", sourceIn: 20, sourceOut: 35, durationSeconds: 15, transitionIn: { type: "dissolve", durationSeconds: 0.6 } },
    ],
    audioDesign: { originalAudioPolicy: "keep" },
    ...overrides,
  };
}

describe("edit/timeline：时间轴校验", () => {
  it("合法时间轴通过：主轨连续、同源间隔达标、总时长贴合目标", () => {
    const result = validateEditTimeline(baseTimeline());
    expect(result.ok).toBe(true);
    expect(result.totalDurationSeconds).toBeCloseTo(30, 3);
    expect(result.checks.filter((c) => c.hard).every((c) => c.pass)).toBe(true);
    expect(result.fixes).toEqual([]);
  });

  it("同源重叠/间隔不足：硬项失败并给出可执行的改法", () => {
    const overlap = baseTimeline({
      segments: [
        { seq: 0, segmentId: "s1", sourceId: "src-1", sourceIn: 0, sourceOut: 15, durationSeconds: 15 },
        { seq: 1, segmentId: "s2", sourceId: "src-1", sourceIn: 14, sourceOut: 29, durationSeconds: 15 },
      ],
    });
    const overlapResult = validateEditTimeline(overlap);
    expect(overlapResult.ok).toBe(false);
    expect(overlapResult.fixes.some((f) => f.segmentId === "s2" && f.field === "sourceIn")).toBe(true);

    const tightGap = baseTimeline({
      segments: [
        { seq: 0, segmentId: "s1", sourceId: "src-1", sourceIn: 0, sourceOut: 15, durationSeconds: 15 },
        { seq: 1, segmentId: "s2", sourceId: "src-1", sourceIn: 15.5, sourceOut: 30.5, durationSeconds: 15 },
      ],
    });
    expect(validateEditTimeline(tightGap).ok).toBe(false);
  });

  it("总时长严重偏离（>20%）为硬失败，轻微偏离（>5%）为咨询项", () => {
    const short = baseTimeline({
      segments: [{ seq: 0, segmentId: "s1", sourceId: "src-1", sourceIn: 0, sourceOut: 15, durationSeconds: 15 }],
    });
    const fail = validateEditTimeline(short);
    expect(fail.ok).toBe(false);
    const mild = baseTimeline({
      segments: [{ seq: 0, segmentId: "s1", sourceId: "src-1", sourceIn: 0, sourceOut: 28, durationSeconds: 28 }],
    });
    const mildResult = validateEditTimeline(mild);
    expect(mildResult.ok).toBe(true);
    expect(mildResult.checks.some((c) => c.id === "duration.targetIdeal" && !c.pass)).toBe(true);
  });

  it("非法枚举与越界：转场/速度/声音模式/时长下限 fail-closed", () => {
    const bad = baseTimeline({
      segments: [
        { seq: 0, segmentId: "s1", sourceId: "src-1", sourceIn: 0, sourceOut: 0.2, durationSeconds: 0.2, transitionIn: { type: "cut" } },
        { seq: 1, segmentId: "s2", sourceId: "src-1", sourceIn: 1, sourceOut: 16, durationSeconds: 15, speed: 12, transitionIn: { type: "flash" as never, durationSeconds: 3 }, audio: { mode: "loud" as never } },
      ],
    });
    const result = validateEditTimeline(bad);
    expect(result.ok).toBe(false);
    const failed = new Set(result.checks.filter((c) => !c.pass && c.hard).map((c) => c.id));
    expect(failed.has("segment.minLength:s1")).toBe(true);
    expect(failed.has("segment.speed:s2")).toBe(true);
    expect(failed.has("transition.type:s2")).toBe(true);
    expect(failed.has("transition.duration:s2")).toBe(true);
    expect(failed.has("audio.mode:s2")).toBe(true);
  });

  it("溯源缺失：素材 sha256 非法 = 硬失败", () => {
    const bad = baseTimeline({ sources: [{ sourceId: "src-1", sha256: "not-a-sha", path: "/tmp/x.mp4", fps: 30 }] });
    const result = validateEditTimeline(bad);
    expect(result.ok).toBe(false);
    expect(result.checks.some((c) => c.id.startsWith("source.sha256") && c.hard && !c.pass)).toBe(true);
  });
});

describe("edit/timeline：合成计划", () => {
  it("节奏档案：默认只给咨询项（不阻断），enforce=true 才升级为硬项", () => {
    const dense = baseTimeline({
      groups: [
        { groupId: "g1", name: "一" }, { groupId: "g2", name: "二" }, { groupId: "g3", name: "三" },
        { groupId: "g4", name: "四" }, { groupId: "g5", name: "五" },
      ],
      segments: Array.from({ length: 6 }, (_, index) => ({
        seq: index,
        segmentId: `s${index + 1}`,
        groupId: `g${(index % 5) + 1}`,
        sourceId: "src-1",
        sourceIn: index * 6,
        sourceOut: index * 6 + 5,
        durationSeconds: 5,
      })),
    });
    const advisory = validateEditTimeline(dense);
    const sceneCheck = advisory.checks.find((check) => check.id === "pacing.scenes")!;
    expect(sceneCheck.pass).toBe(false);
    expect(sceneCheck.hard).toBe(false);
    expect(advisory.ok).toBe(true);

    const strict = validateEditTimeline({ ...dense, pacing: { profile: "documentary", enforce: true } });
    const strictCheck = strict.checks.find((check) => check.id === "pacing.scenes")!;
    expect(strictCheck.hard).toBe(true);
    expect(strict.ok).toBe(false);
  });

  it("节奏档案：快剪片切到 fast_cut 后，同样的密度不再报警（档案是默认值不是硬闸）", () => {
    const dense = baseTimeline({
      groups: Array.from({ length: 8 }, (_, index) => ({ groupId: `g${index + 1}`, name: `${index + 1}` })),
      segments: Array.from({ length: 16 }, (_, index) => ({
        seq: index,
        segmentId: `s${index + 1}`,
        groupId: `g${(index % 8) + 1}`,
        sourceId: "src-1",
        sourceIn: index * 4,
        sourceOut: index * 4 + 2,
        durationSeconds: 2,
      })),
    });
    const doc = validateEditTimeline({ ...dense, pacing: { profile: "documentary" } });
    const fast = validateEditTimeline({ ...dense, pacing: { profile: "fast_cut" } });
    expect(doc.checks.find((c) => c.id === "pacing.scenes")!.pass).toBe(false);
    expect(fast.checks.find((c) => c.id === "pacing.scenes")!.pass).toBe(true);
  });

  it("主轨由片段顺序推导且与声明值一致", () => {
    const master = computeMasterTimeline(baseTimeline().segments);
    expect(master).toEqual([
      { segmentId: "s1", masterIn: 0, masterOut: 15 },
      { segmentId: "s2", masterIn: 15, masterOut: 30 },
    ]);
  });

  it("合成计划：逐段裁切归一化 + concat 无损拼接，参数取自目标规格", () => {
    const plan = planAssembly(baseTimeline(), { workDir: "/tmp/work", outputPath: "/tmp/out.mp4", width: 1080, height: 1920, fps: 30 });
    expect(plan.normalize).toHaveLength(2);
    expect(plan.normalize[0]!.args.join(" ")).toContain("-ss 0 -to 15 -i /tmp/src1.mp4");
    expect(plan.normalize[0]!.args.join(" ")).toContain("scale=1080:1920:force_original_aspect_ratio=decrease");
    expect(plan.normalize[0]!.args.join(" ")).toContain("-t 15");
    expect(plan.concat.args.join(" ")).toContain("-f concat -safe 0 -i /tmp/work/concat.txt");
    expect(plan.totalDurationSeconds).toBeCloseTo(30, 3);
  });

  it("变速片段：计划里出现 setpts 且目标时长按变速换算", () => {
    const timeline = baseTimeline({
      segments: [{ seq: 0, segmentId: "s1", sourceId: "src-1", sourceIn: 0, sourceOut: 30, durationSeconds: 15, speed: 2 }],
    });
    const plan = planAssembly(timeline, { workDir: "/tmp/work", outputPath: "/tmp/out.mp4", fps: 30 });
    expect(plan.normalize[0]!.args.join(" ")).toContain("setpts=");
    expect(plan.normalize[0]!.args.join(" ")).toContain("-t 15");
    expect(plan.totalDurationSeconds).toBeCloseTo(15, 3);
  });
});
