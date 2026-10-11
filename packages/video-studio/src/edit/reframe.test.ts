import { describe, expect, it } from "vitest";
import {
  buildReframeFilters, computeBaseWindow, computeLosslessBudget, describeReframePlan,
  normalizeReframeSegment, planReframe, requiredScaleForShotSize, validateReframeSegment,
  type ReframeDescriptor,
} from "./reframe.js";
import { planAssembly, validateEditTimeline, type EditTimeline } from "./timeline.js";

const SHA = "b".repeat(64);
const CANVAS_V = { width: 1080, height: 1920 };
const CANVAS_H = { width: 1920, height: 1080 };

function descriptor(overrides: Partial<ReframeDescriptor> = {}): ReframeDescriptor {
  return {
    mode: "static",
    intent: "shot-size",
    shotSize: { from: "MS", to: "CU" },
    scale: { from: 1, to: 1.3 },
    center: { from: { x: 0.5, y: 0.4 }, to: { x: 0.5, y: 0.4 } },
    anchor: "face",
    easing: "smooth",
    fill: "cover",
    maxZoomPolicy: "lossless",
    safeArea: "respect",
    note: null,
    legacyPunchIn: false,
    budget: { baseWindow: null, sMaxLossless: null, effectiveUpscale: null },
    ...overrides,
  };
}

function timeline(overrides: Partial<EditTimeline> = {}): EditTimeline {
  return {
    schemaVersion: "workloom.video-edit/edit-timeline/v2",
    timelineId: "tl-reframe",
    target: { durationSeconds: 10, aspectRatio: "9:16", fps: 30, platform: "douyin" },
    sources: [{ sourceId: "src-1", sha256: SHA, path: "/tmp/a.mp4", fps: 30, durationSeconds: 60 }],
    segments: [
      { seq: 0, segmentId: "s1", sourceId: "src-1", sourceIn: 0, sourceOut: 10, durationSeconds: 10 },
    ],
    audioDesign: { originalAudioPolicy: "keep" },
    ...overrides,
  };
}

describe("edit/reframe：契约归一与校验", () => {
  it("legacy punchIn 归一为静态推近（保留 x/y 与 legacy 标记）", () => {
    const normalized = normalizeReframeSegment({ segmentId: "s1", punchIn: { scale: 1.12, x: 0.3, y: 0.2 } } as never);
    expect(normalized).not.toBeNull();
    expect(normalized!.legacyPunchIn).toBe(true);
    expect(normalized!.scale.to).toBeCloseTo(1.12, 4);
    expect(normalized!.center.from).toEqual({ x: 0.3, y: 0.2 });
    expect(normalized!.anchor).toBe("manual");
  });

  it("显式 reframe 优先于 punchIn；缺省值合法（居中、smooth、lossless）", () => {
    const normalized = normalizeReframeSegment({
      segmentId: "s1",
      punchIn: { scale: 1.2 },
      reframe: { mode: "push", intent: "emphasis", scale: { from: 1, to: 1.4 } },
    } as never);
    expect(normalized!.legacyPunchIn).toBe(false);
    expect(normalized!.mode).toBe("push");
    expect(normalized!.scale.to).toBeCloseTo(1.4, 4);
    expect(normalized!.center.from).toEqual({ x: 0.5, y: 0.5 });
    expect(normalized!.easing).toBe("smooth");
  });

  it("非法枚举/越界是硬失败，并给出可执行改法", () => {
    const checks = validateReframeSegment({
      seq: 0, segmentId: "s1", sourceId: "src-1", sourceIn: 0, sourceOut: 5, durationSeconds: 5,
      reframe: { mode: "orbit" as never, fill: "rainbow" as never, scale: { from: 0.5, to: 9 }, center: { from: { x: -1, y: 2 } } },
    });
    const failed = checks.filter((check) => !check.pass).map((check) => check.id);
    expect(failed.some((id) => id.startsWith("reframe.mode"))).toBe(true);
    expect(failed.some((id) => id.startsWith("reframe.fill"))).toBe(true);
    expect(failed.some((id) => id.startsWith("reframe.scale.to"))).toBe(true);
    expect(failed.some((id) => id.startsWith("reframe.center.from.x"))).toBe(true);
    expect(checks.every((check) => check.fix === undefined || check.fix.field.startsWith("reframe"))).toBe(true);
  });

  it("时间轴校验接入取景字段（非法 reframe 使整体 fail）", () => {
    const bad = timeline({
      segments: [{
        seq: 0, segmentId: "s1", sourceId: "src-1", sourceIn: 0, sourceOut: 10, durationSeconds: 10,
        reframe: { mode: "static", easing: "bounce" as never },
      }],
    });
    const result = validateEditTimeline(bad);
    expect(result.ok).toBe(false);
    expect(result.checks.some((check) => check.id.startsWith("reframe.easing") && check.hard && !check.pass)).toBe(true);
  });
});

describe("edit/reframe：无损预算与景别换算", () => {
  it("基窗 = 画布同比例、能放进源画面的最大矩形", () => {
    expect(computeBaseWindow({ width: 3840, height: 2160 }, CANVAS_H)).toEqual({ w: 3840, h: 2160 });
    const verticalFrom16x9 = computeBaseWindow({ width: 3840, height: 2160 }, CANVAS_V);
    expect(Math.round(verticalFrom16x9.h)).toBe(2160);
    expect(Math.round(verticalFrom16x9.w)).toBe(1215);
  });

  it("无损预算三档：4K→1080p 横屏 2.0×；4K→竖屏 1.125×；1080p 竖屏→竖屏 1.0×", () => {
    expect(computeLosslessBudget({ width: 3840, height: 2160 }, CANVAS_H).sMaxLossless).toBeCloseTo(2, 3);
    expect(computeLosslessBudget({ width: 3840, height: 2160 }, CANVAS_V).sMaxLossless).toBeCloseTo(1.125, 3);
    expect(computeLosslessBudget({ width: 1080, height: 1920 }, CANVAS_V).sMaxLossless).toBeCloseTo(1, 3);
    expect(computeLosslessBudget(null, CANVAS_V).sMaxLossless).toBeNull();
  });

  it("景别换算：当前人脸占比 0.11（中景）→ 近景约 2.9×，→ 中近景约 1.7×", () => {
    expect(requiredScaleForShotSize(0.11, "CU")).toBeCloseTo(2.909, 2);
    expect(requiredScaleForShotSize(0.11, "MCU")).toBeCloseTo(1.727, 2);
    expect(requiredScaleForShotSize(null, "CU")).toBeNull();
  });
});

describe("edit/reframe：计划（降级必须可解释）", () => {
  it("mode=off 不产出任何取景（保持现状）", () => {
    const plan = planReframe({ timeline: timeline(), options: { mode: "off" } });
    expect(plan.plannedCount).toBe(0);
    expect(plan.segments[0]!.descriptor).toBeNull();
  });

  it("declared：超预算时如实降级到无损上限并写 advisory", () => {
    const tl = timeline({
      segments: [{
        seq: 0, segmentId: "s1", sourceId: "src-1", sourceIn: 0, sourceOut: 10, durationSeconds: 10,
        reframe: { mode: "static", scale: { from: 1, to: 1.6 }, fill: "cover", maxZoomPolicy: "lossless" },
      }],
    });
    const plan = planReframe({ timeline: tl, options: { mode: "declared", sourceSizes: { s1: { width: 1080, height: 1920 } } } });
    const entry = plan.segments[0]!;
    expect(entry.descriptor!.scale.to).toBeCloseTo(1, 3);
    expect(entry.advisories.join(" ")).toContain("超出预算");
    expect(plan.advisories.length).toBeGreaterThan(0);
  });

  it("allow-upscale：保留请求倍率并记录等效上采样", () => {
    const tl = timeline({
      segments: [{
        seq: 0, segmentId: "s1", sourceId: "src-1", sourceIn: 0, sourceOut: 10, durationSeconds: 10,
        reframe: { mode: "push", scale: { from: 1, to: 1.5 }, fill: "cover", maxZoomPolicy: "allow-upscale" },
      }],
    });
    const plan = planReframe({ timeline: tl, options: { mode: "declared", sourceSizes: { s1: { width: 1080, height: 1920 } } } });
    const entry = plan.segments[0]!;
    expect(entry.descriptor!.scale.to).toBeCloseTo(1.5, 3);
    expect(entry.budget.effectiveUpscale).toBeCloseTo(1.5, 3);
  });

  it("auto：未声明段落给确定性呼吸感微推（1.00→1.03）", () => {
    const plan = planReframe({ timeline: timeline(), options: { mode: "auto" } });
    expect(plan.plannedCount).toBe(1);
    expect(plan.segments[0]!.descriptor!.intent).toBe("breathing");
    expect(plan.segments[0]!.descriptor!.scale.to).toBeCloseTo(1.03, 3);
  });

  it("全局推近（--reframe-scale）：只作用于未声明段落，声明段落优先", () => {
    const tl = timeline({
      segments: [
        {
          seq: 0, segmentId: "s1", sourceId: "src-1", sourceIn: 0, sourceOut: 10, durationSeconds: 10,
          reframe: { mode: "static", scale: { from: 1, to: 1.1 }, fill: "cover" },
        },
        { seq: 1, segmentId: "s2", sourceId: "src-1", sourceIn: 12, sourceOut: 22, durationSeconds: 10 },
      ],
    });
    const plan = planReframe({
      timeline: tl,
      options: { mode: "declared", defaultScale: { from: 1, to: 1.2 }, sourceSizes: { s1: { width: 3840, height: 2160 }, s2: { width: 3840, height: 2160 } } },
    });
    expect(plan.segments[0]!.descriptor!.scale.to).toBeCloseTo(1.1, 3);
    expect(plan.segments[1]!.descriptor!.scale.to).toBeCloseTo(1.125, 3); // 4K 16:9 → 竖屏无损上限
    expect(plan.segments[1]!.advisories.join(" ")).toContain("超出预算");
  });

  it("摘要可读且包含降级原因", () => {
    const tl = timeline({
      segments: [{
        seq: 0, segmentId: "s1", sourceId: "src-1", sourceIn: 0, sourceOut: 10, durationSeconds: 10,
        reframe: { mode: "push", scale: { from: 1, to: 1.4 }, fill: "cover" },
      }],
    });
    const plan = planReframe({ timeline: tl, options: { mode: "declared", sourceSizes: { s1: { width: 1080, height: 1920 } } } });
    const lines = describeReframePlan(plan).join("\n");
    expect(lines).toContain("取景计划");
    expect(lines).toContain("s1");
  });
});

describe("edit/reframe：渲染链（crop-first）", () => {
  it("静态 cover：先裁源窗口再缩放到画布（不出现先 scale 到画布再 crop 的旧顺序）", () => {
    const built = buildReframeFilters({
      descriptor: descriptor({ scale: { from: 1.3, to: 1.3 } }),
      source: { width: 3840, height: 2160 },
      canvas: CANVAS_V,
      durationSeconds: 5,
      fps: 30,
    });
    const joined = built.filters.join(",");
    expect(built.mode).toBe("static");
    expect(joined.startsWith("crop=")).toBe(true);
    expect(joined).toContain("scale=1080:1920:flags=lanczos");
    expect(joined.indexOf("crop=")).toBeLessThan(joined.indexOf("scale=1080:1920"));
  });

  it("动态 push：包含 eval=frame 的动画缩放与逐帧中心裁切", () => {
    const built = buildReframeFilters({
      descriptor: descriptor({ mode: "push", scale: { from: 1, to: 1.25 } }),
      source: { width: 3840, height: 2160 },
      canvas: CANVAS_V,
      durationSeconds: 4,
      fps: 30,
    });
    const joined = built.filters.join(",");
    expect(built.mode).toBe("animated");
    expect(joined).toContain("zoompan=z=");
    expect(joined).toContain("d=1:s=1080x1920");
    expect(joined).toContain("clip(time/4");
    expect(joined).toContain("(iw-iw/zoom)");
  });

  it("blur 填充：一张合法的多路图（split/overlay），可直接拼进 -vf", () => {
    const built = buildReframeFilters({
      descriptor: descriptor({ fill: "blur", scale: { from: 1, to: 1 } }),
      source: { width: 3840, height: 2160 },
      canvas: CANVAS_V,
      durationSeconds: 3,
      fps: 30,
    });
    const joined = built.filters.join(",");
    expect(joined).toContain("split=2[bgsrc][fgsrc]");
    expect(joined).toContain("gblur=sigma=20");
    expect(joined).toContain("overlay=(W-w)/2:(H-h)/2");
  });

  it("pad 填充：保留整幅入画 + 黑边的兼容语义", () => {
    const built = buildReframeFilters({
      descriptor: descriptor({ fill: "pad", scale: { from: 1, to: 1 } }),
      source: { width: 3840, height: 2160 },
      canvas: CANVAS_V,
      durationSeconds: 3,
      fps: 30,
    });
    const joined = built.filters.join(",");
    expect(joined).toContain("force_original_aspect_ratio=decrease");
    expect(joined).toContain("pad=1080:1920");
  });
});

describe("edit/timeline：planAssembly 接入取景", () => {
  it("未开启取景：完全沿用旧归一化链（零行为变化）", () => {
    const plan = planAssembly(timeline(), { workDir: "/tmp/w", outputPath: "/tmp/o.mp4", fps: 30 });
    const joined = plan.normalize[0]!.args.join(" ");
    expect(joined).toContain("scale=1080:1920:force_original_aspect_ratio=decrease");
    expect(plan.reframePlan).toBeNull();
    expect(plan.normalize[0]!.reframe).toBeNull();
  });

  it("declared：声明 reframe 的段落走 crop-first 链并带描述子；未声明段落保持旧链", () => {
    const tl = timeline({
      segments: [
        {
          seq: 0, segmentId: "s1", sourceId: "src-1", sourceIn: 0, sourceOut: 10, durationSeconds: 10,
          reframe: { mode: "static", scale: { from: 1, to: 1.2 }, fill: "cover" },
        },
        { seq: 1, segmentId: "s2", sourceId: "src-1", sourceIn: 12, sourceOut: 22, durationSeconds: 10 },
      ],
    });
    const plan = planAssembly(tl, {
      workDir: "/tmp/w", outputPath: "/tmp/o.mp4", fps: 30,
      reframe: { mode: "declared", sourceSizes: { s1: { width: 3840, height: 2160 } } },
    });
    expect(plan.reframePlan!.plannedCount).toBe(1);
    const withReframe = plan.normalize[0]!.args.join(" ");
    const legacy = plan.normalize[1]!.args.join(" ");
    expect(withReframe).toContain("crop=");
    expect(withReframe).not.toContain("force_original_aspect_ratio=decrease");
    expect(legacy).toContain("force_original_aspect_ratio=decrease");
    expect(plan.normalize[0]!.reframe?.fill).toBe("cover");
    expect(plan.normalize[1]!.reframe).toBeNull();
  });

  it("legacy punchIn 在未开启取景时仍走旧像素路径（兼容）", () => {
    const tl = timeline({
      segments: [{
        seq: 0, segmentId: "s1", sourceId: "src-1", sourceIn: 0, sourceOut: 10, durationSeconds: 10,
        punchIn: { scale: 1.12 },
      }],
    });
    const plan = planAssembly(tl, { workDir: "/tmp/w", outputPath: "/tmp/o.mp4", fps: 30 });
    const joined = plan.normalize[0]!.args.join(" ");
    expect(joined).toContain("scale=1080:1920:force_original_aspect_ratio=decrease");
    expect(joined).toContain("ceil(iw*1.12");
  });

  it("preserveSource：预切只做源分辨率 trim（不缩放），描述子仍随计划返回给后期引擎", () => {
    const tl = timeline({
      segments: [{
        seq: 0, segmentId: "s1", sourceId: "src-1", sourceIn: 0, sourceOut: 10, durationSeconds: 10,
        reframe: { mode: "push", scale: { from: 1, to: 1.15 }, fill: "cover" },
      }],
    });
    const plan = planAssembly(tl, {
      workDir: "/tmp/w", outputPath: "/tmp/o.mp4", fps: 30,
      reframe: { mode: "declared", sourceSizes: { s1: { width: 3840, height: 2160 } } },
      preserveSource: true,
    });
    const joined = plan.normalize[0]!.args.join(" ");
    expect(joined).not.toContain("scale=1080:1920");
    expect(joined).not.toContain("pad=1080:1920");
    expect(joined).toContain("setsar=1");
    expect(plan.normalize[0]!.reframe?.fill).toBe("cover");
    expect(plan.normalize[0]!.reframe?.scale.to).toBeCloseTo(1.125, 3);
  });
});
