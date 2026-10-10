import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  INTENT_TIMING, PACING_SCENE_INTENT, TRANSITION_LIMITS, TRANSITION_PLAN_SCHEMA, describeTransitionPlan, planToPerCut, planTransitions,
  type TransitionPlanOptions,
} from "./transitions.js";
import { TRANSITION_TYPES } from "./timeline.js";

const CATALOG_PATH = resolve(import.meta.dirname ?? process.cwd(), "../../../../bundles/ai-video/library/transitions/catalog.json");

interface Catalog {
  schemaVersion: string;
  engine: { filter: string; minVersion: string; customExprVars: string[] };
  intents: Record<string, { type: string | null; durationSec: number; easing: string; directions?: Record<string, string>; blackDip?: boolean }>;
  packs: Record<string, { sceneIntent: string; scale: number }>;
  transitions: Array<{ name: string; family: string; since: string; direction: string }>;
  blackDipAllowed: string[];
  durationPolicy: { minSec: number; maxSec: number; maxShareOfClip: number; minFrames: number };
}

const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as Catalog;

function segment(overrides: Partial<TransitionPlanOptions["segments"][number]> & { segmentId: string }) {
  return { groupId: "场景1", durationSeconds: 4, transitionIn: null, ...overrides };
}

describe("edit/transitions：目录与代码表一致性（单一事实源）", () => {
  it("catalog.json 结构完整：转场唯一、since 合法、引擎口径明确", () => {
    expect(catalog.schemaVersion).toBe("workloom.transition-catalog/v1");
    expect(catalog.engine.filter).toBe("xfade");
    expect(catalog.engine.customExprVars).toEqual(["X", "Y", "W", "H", "P", "PLANE", "A", "B"]);
    const names = catalog.transitions.map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
    for (const item of catalog.transitions) {
      expect(["6.0", "7.0"]).toContain(item.since);
      expect(item.family.length).toBeGreaterThan(0);
      expect(item.direction.length).toBeGreaterThan(0);
    }
    // 6.0 线由本机 ffmpeg 6.0 实测（46 种命名转场）；7.0 线为 FFmpeg master 源码新增。
    expect(names.filter((name) => catalog.transitions.find((item) => item.name === name)?.since === "6.0").length).toBe(46);
    expect(names.length).toBe(58);
  });

  it("时长安全边界与 catalog.json#durationPolicy 一致", () => {
    expect(TRANSITION_LIMITS.minSeconds).toBe(catalog.durationPolicy.minSec);
    expect(TRANSITION_LIMITS.maxSeconds).toBe(catalog.durationPolicy.maxSec);
    expect(TRANSITION_LIMITS.maxShareOfClip).toBeCloseTo(catalog.durationPolicy.maxShareOfClip, 4);
    expect(TRANSITION_LIMITS.minFrames).toBe(catalog.durationPolicy.minFrames);
  });

  it("编辑意图表与 catalog.json#intents 完全一致（含方向与黑场标记）", () => {
    expect(Object.keys(INTENT_TIMING).sort()).toEqual([...TRANSITION_TYPES].sort());
    for (const intent of TRANSITION_TYPES) {
      const timing = INTENT_TIMING[intent];
      const spec = catalog.intents[intent];
      if (!spec) expect.fail(`catalog 缺少意图 ${intent}`);
      expect(timing.type).toBe(spec.type);
      expect(timing.durationSeconds).toBe(spec.durationSec);
      expect(timing.easing).toBe(spec.easing);
      expect(timing.blackDip === true).toBe(spec.blackDip === true);
      if (timing.directions) expect(timing.directions).toEqual(spec.directions);
    }
  });

  it("意图引用的引擎转场都在目录内，且黑场豁免清单与意图表一致", () => {
    const names = new Set(catalog.transitions.map((item) => item.name));
    for (const timing of Object.values(INTENT_TIMING)) {
      if (timing.type) expect(names.has(timing.type), `目录缺少 ${timing.type}`).toBe(true);
      for (const mapped of Object.values(timing.directions ?? {})) {
        expect(names.has(mapped), `目录缺少方向转场 ${mapped}`).toBe(true);
      }
    }
    // 意图层的黑场类型必须落在引擎豁免清单内；清单还可包含引擎直接支持的白闪/灰场（fadewhite/fadegrays）。
    const blackDipTypes = [...new Set(Object.values(INTENT_TIMING).filter((timing) => timing.blackDip).map((timing) => timing.type))];
    expect(blackDipTypes.length).toBeGreaterThan(0);
    for (const type of blackDipTypes) expect(catalog.blackDipAllowed, `${type} 应豁免黑场机检`).toContain(type);
    for (const type of catalog.blackDipAllowed) expect(names.has(type), `豁免清单里的 ${type} 不在目录内`).toBe(true);
  });

  it("节奏档案的场景意图与 catalog.json#packs 一致", () => {
    for (const [pack, spec] of Object.entries(PACING_SCENE_INTENT)) {
      const fromCatalog = catalog.packs[pack];
      if (!fromCatalog) expect.fail(`catalog 缺少节奏档案 ${pack}`);
      expect(spec.intent).toBe(fromCatalog.sceneIntent);
      expect(spec.scale).toBe(fromCatalog.scale);
      expect(INTENT_TIMING[spec.intent].type).not.toBeNull();
    }
  });
});

describe("edit/transitions：转场计划判定", () => {
  it("hard 模式：全硬切、零转场，且如实给出提示", () => {
    const plan = planTransitions({
      segments: [segment({ segmentId: "s1" }), segment({ segmentId: "s2", transitionIn: { type: "dissolve", durationSeconds: 0.6 } })],
      mode: "hard",
    });
    expect(plan.cuts).toEqual([]);
    expect(plan.hardCuts).toBe(1);
    expect(plan.expectedOutputDurationSeconds).toBeCloseTo(8, 3);
    expect(plan.advisories[0]).toContain("hard");
  });

  it("declared 模式：只渲染脚本声明，未声明切点保持硬切", () => {
    const plan = planTransitions({
      segments: [
        segment({ segmentId: "s1" }),
        segment({ segmentId: "s2" }),
        segment({ segmentId: "s3", transitionIn: { type: "dissolve", durationSeconds: 0.6 } }),
      ],
      mode: "declared",
    });
    expect(plan.cuts).toHaveLength(1);
    expect(plan.cuts[0]).toMatchObject({
      cutIndex: 2, afterSegmentId: "s2", incomingSegmentId: "s3", intent: "dissolve", engineType: "fade", durationSeconds: 0.6, source: "declared",
    });
    expect(plan.transitionCount).toBe(1);
    expect(plan.hardCuts).toBe(1);
    expect(plan.expectedOutputDurationSeconds).toBeCloseTo(11.4, 3);
  });

  it("方向参数与显式引擎转场：wipe 按 direction 解析，params.xfade 可覆盖", () => {
    const plan = planTransitions({
      segments: [
        segment({ segmentId: "s1" }),
        segment({ segmentId: "s2", transitionIn: { type: "wipe", durationSeconds: 0.4, params: { direction: "up" } } }),
        segment({ segmentId: "s3", transitionIn: { type: "wipe", durationSeconds: 0.4, params: { xfade: "hlslice" } } }),
      ],
      mode: "declared",
    });
    expect(plan.cuts[0]).toMatchObject({ engineType: "wipeup", direction: "up" });
    expect(plan.cuts[0]!.explicit).toBe(false);
    expect(plan.cuts[1]).toMatchObject({ engineType: "hlslice", explicit: true });
  });

  it("编辑技法类意图（match_cut / jump_cut / cut）必须硬切，并给出说明", () => {
    const plan = planTransitions({
      segments: [
        segment({ segmentId: "s1" }),
        segment({ segmentId: "s2", transitionIn: { type: "match_cut" } }),
        segment({ segmentId: "s3", transitionIn: { type: "jump_cut" } }),
        segment({ segmentId: "s4", transitionIn: { type: "cut" } }),
      ],
      mode: "declared",
    });
    expect(plan.cuts).toEqual([]);
    expect(plan.advisories.filter((line) => line.includes("硬切")).length).toBe(2);
  });

  it("auto 模式：声明优先；未声明时只在场景组切换处补默认意图，组内保持硬切", () => {
    const plan = planTransitions({
      segments: [
        segment({ segmentId: "s1", groupId: "场景1" }),
        segment({ segmentId: "s2", groupId: "场景1" }),
        segment({ segmentId: "s3", groupId: "场景2" }),
        segment({ segmentId: "s4", groupId: "场景3", transitionIn: { type: "zoom_blur", durationSeconds: 0.35 } }),
        segment({ segmentId: "s5", groupId: "场景3" }),
      ],
      mode: "auto",
      pacing: { profile: "documentary" },
    });
    expect(plan.cuts).toHaveLength(2);
    expect(plan.cuts[0]).toMatchObject({ cutIndex: 2, incomingSegmentId: "s3", intent: "dissolve", engineType: "fade", source: "scene-change" });
    expect(plan.cuts[0]!.durationSeconds).toBeCloseTo(0.575, 3);
    expect(plan.cuts[1]).toMatchObject({ cutIndex: 3, incomingSegmentId: "s4", intent: "zoom_blur", engineType: "zoomin", source: "declared", durationSeconds: 0.35 });
    expect(plan.hardCuts).toBe(2);
  });

  it("相邻镜头过短：不硬凑转场，降级为硬切并记录原因", () => {
    const plan = planTransitions({
      segments: [
        segment({ segmentId: "s1", durationSeconds: 0.4 }),
        segment({ segmentId: "s2", durationSeconds: 0.4, transitionIn: { type: "dissolve", durationSeconds: 0.6 } }),
      ],
      mode: "declared",
    });
    expect(plan.cuts).toEqual([]);
    expect(plan.advisories.some((line) => line.includes("已降级为硬切"))).toBe(true);
  });

  it("时长钳制：上限 2s 且不超过相邻较短镜头的 1/3", () => {
    const plan = planTransitions({
      segments: [
        segment({ segmentId: "s1", durationSeconds: 2 }),
        segment({ segmentId: "s2", durationSeconds: 2, transitionIn: { type: "dissolve", durationSeconds: 3 } }),
      ],
      mode: "declared",
      fps: 30,
    });
    expect(plan.cuts[0]!.maxDurationSeconds).toBeCloseTo(0.667, 3);
    expect(plan.cuts[0]!.durationSeconds).toBeCloseTo(0.667, 3);
  });

  it("缓动只对 fade 生效：其余转场回退 native 并提示，避免静默改语义", () => {
    const plan = planTransitions({
      segments: [
        segment({ segmentId: "s1" }),
        segment({ segmentId: "s2", transitionIn: { type: "dissolve", durationSeconds: 0.5 } }),
        segment({ segmentId: "s3", transitionIn: { type: "wipe", durationSeconds: 0.4 } }),
      ],
      mode: "declared",
      easing: "smooth",
    });
    expect(plan.cuts[0]!.easing).toBe("smooth");
    expect(plan.cuts[1]!.easing).toBe("native");
    expect(plan.advisories.some((line) => line.includes("不支持 custom 缓动"))).toBe(true);
  });

  it("纯函数：同输入同输出，且 perCut 以进入镜头为键、摘要可读", () => {
    const options: TransitionPlanOptions = {
      segments: [
        segment({ segmentId: "s1" }),
        segment({ segmentId: "s2", transitionIn: { type: "dissolve", durationSeconds: 0.5 } }),
      ],
      mode: "declared",
    };
    const first = planTransitions(options);
    const second = planTransitions(options);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.schemaVersion).toBe(TRANSITION_PLAN_SCHEMA);
    const perCut = planToPerCut(first);
    expect(Object.keys(perCut)).toEqual(["s2"]);
    expect(perCut.s2).toMatchObject({ intent: "dissolve", type: "fade", explicit: false, durationSeconds: 0.5, easing: "native", source: "declared" });
    expect(describeTransitionPlan(first).join("\n")).toContain("转场 1 刀 / 硬切 0 刀");
  });
});
