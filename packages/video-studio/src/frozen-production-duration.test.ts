import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { frozenSegmentContract } from "./requirement-contract.js";
import { installVendorDurationProjectionBridge, withVendorDurationProjectionScope } from "./vendor-compat.js";
import { assertFrozenProductionTiming } from "./frozen-production-duration.js";

const vendor = createRequire(import.meta.url);
const load = (name: string) => vendor(fileURLToPath(new URL(`../../../vendor/supermickey/hyperreality-system/engines/${name}`, import.meta.url)));
const { ScriptGenerator } = load("script-engine/core/script-generator.js");
const { ProductionEngine } = load("production-engine/production-engine.js");
const { DurationConstraintManager } = load("duration-constraint/duration-constraint-manager.js");
const intervals = ["追击并完成第一次超越", "第二次超越并率先冲线", "停车、摘盔后登台"].map((brief, i) => ({ startSec: i * 10, endSec: (i + 1) * 10, brief }));
const frozenSegments = frozenSegmentContract({ duration: 30, segmentContract: { count: 3, totalSeconds: 30, secondsPerSegment: 10, hardCuts: true, intervals } }, 30)!;
const options = { frozenSegments };
const rows = (lengths: number[]) => {
  let start = 0;
  return lengths.map((duration, i) => {
    const end = start + duration;
    const scene = { scene_id: `SC-${i + 1}`, scene_type: ["opening", "emotional_climax", "resolution"][i], duration, timing: { start, duration, end }, action: `原始动作 ${i + 1}` };
    start = end;
    return scene;
  });
};
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

describe("frozen production duration through actual native prototypes", () => {
  it("replaces contradictory native timing advice and supplies the exact ordered hard cuts to the real script prompt", async () => {
    restore = installVendorDurationProjectionBridge();
    const script = Object.create(ScriptGenerator.prototype);
    const args = [{ metadata: { title: "闭环", target_duration: 30 }, constraints: {}, parsed: { primary_mode: "dramatic" } }, { structure: { acts: [] } }];
    const standard = script._buildGenerationPrompt(...args);
    expect(standard).toContain("场景数量建议 5-7");
    const prompt = await withVendorDurationProjectionScope(options, () => script._buildGenerationPrompt(...args));
    expect(prompt).toContain("冻结分段合同");
    expect(prompt).toContain(JSON.stringify({ start: 20, duration: 10, end: 30 }));
    expect(prompt).toContain("停车、摘盔后登台");
    expect(prompt).not.toContain("场景数量建议 5-7");
    expect(prompt).not.toContain("场景时长是否全场最长");
    expect(prompt).not.toContain("是否有一个让观众喘气的留白场景");
  });

  it("rejects the attempt17 duration vector before native production and does not rewrite the rejected screenplay", async () => {
    restore = installVendorDurationProjectionBridge();
    const parsed = { structure: { scenes: rows([10, 12, 8]) }, meta: {} };
    const before = structuredClone(parsed);
    await expect(withVendorDurationProjectionScope(options, () =>
      ScriptGenerator.prototype._enforceTargetDuration.call({}, parsed, 30))).rejects.toThrow("FROZEN_PRODUCTION_TIMING_UNVERIFIED");
    expect(parsed).toEqual(before);
    await withVendorDurationProjectionScope({}, () => ScriptGenerator.prototype._enforceTargetDuration.call({}, parsed, 30));
    expect(parsed.structure.scenes.map(({ duration }) => duration)).toEqual([10, 12, 8]);
  });

  it("accepts unchanged exact cuts through native script, production and constraint entry points", async () => {
    restore = installVendorDurationProjectionBridge();
    const scenes = rows([10, 10, 10]);
    const parsed = { structure: { scenes }, meta: {} };
    const before = structuredClone(scenes);
    const manager = new DurationConstraintManager();
    await withVendorDurationProjectionScope(options, () => {
      ScriptGenerator.prototype._enforceTargetDuration.call({}, parsed, 30);
      ProductionEngine.prototype._normalizeDurations.call({}, scenes, 30);
      expect(manager.constrain(scenes, { targetDuration: 30 })).toMatchObject({ valid: true });
    });
    expect(scenes).toEqual(before);
    expect(parsed.meta).toEqual({ total_duration: 30 });
  });

  it("fails closed when subsequent production merges omit a segment or alter its boundary even at the same total", async () => {
    restore = installVendorDurationProjectionBridge();
    const changed = rows([10, 10, 10]);
    changed[2]!.timing.start = 19;
    for (const invalid of [changed, rows([15, 15]), rows([10, 10, 10]).map((row, i) => i === 1 ? { ...row, duration: 11 } : row)]) {
      await expect(withVendorDurationProjectionScope(options, () =>
        ProductionEngine.prototype._normalizeDurations.call({}, invalid, 30))).rejects.toThrow("FROZEN_PRODUCTION_TIMING_UNVERIFIED");
    }
  });

  it("does not relax a voice floor to fit an otherwise exact frozen scene", async () => {
    restore = installVendorDurationProjectionBridge();
    const scenes = rows([10, 10, 10]).map((row, i) => i === 1
      ? { ...row, dialogue: { lines: [{ text: "字".repeat(130) }] } } : row);
    await expect(withVendorDurationProjectionScope(options, () =>
      ProductionEngine.prototype._normalizeDurations.call({}, scenes, 30))).rejects.toThrow("台词无法在冻结区间内完整呈现");
    expect(scenes.map(row => row.duration)).toEqual([10, 10, 10]);
  });

  it("rechecks the actual G6/G7 prompt shape, which may retain only duration instead of a timing object", () => {
    const current = ["opening", "scene-1", "ending"].map(shotId => ({ shotId, duration: 10, fields: { timeline: "模型原始时间轴" } }));
    expect(() => assertFrozenProductionTiming(current, frozenSegments, "G6_PROMPT", false)).not.toThrow();
    expect(() => assertFrozenProductionTiming([{ ...current[0], duration_sec: 12 }, ...current.slice(1)],
      frozenSegments, "G7_FINAL", false)).toThrow("FROZEN_PRODUCTION_TIMING_UNVERIFIED");
  });
});
