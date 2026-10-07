/** Industry policy regressions using the repository's real DSL evaluator and judge. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { evalCondition } from "../fence-engine/expr.js";
import { judge, type RuntimeRule } from "../fence-engine/judge.js";
import { bundlesRoot } from "./assembly.js";

function pack(name: string) {
  const raw = YAML.parse(readFileSync(join(bundlesRoot(), "ai-video/fences", `ai-video-${name}.yml`), "utf8"));
  return { defaultLevel: raw.default_level, rules: raw.rules.map((rule: any): RuntimeRule => ({
    rule_id: rule.rule_id, version: raw.version, name: rule.name, level: rule.level,
    is_baseline: rule.is_baseline, objectTypes: rule.match.object_types, actions: rule.match.actions, when: rule.when,
  })) };
}
const context = { tenant_daily_grades: 0, tenant_daily_subtitle: 0, tenant_daily_bgm: 0, tenant_daily_voice_seconds: 0 };
const evaluate = (name: string, type: string, action: string, params: Record<string, unknown>) => {
  const policy = pack(name);
  return judge({ object: { type }, action, effect: "write", params, context }, policy.rules, policy.defaultLevel);
};

describe("post-render quality does not block industry processing policies", () => {
  it.each([
    ["color", "final_video", "colorwrite.grade"],
    ["subtitle", "final_video", "subtitlewrite.burn"],
    ["bgm", "final_video", "bgmwrite.mix"],
    ["voice", "final_video", "voicewrite.dub"],
    ["delivery", "delivery_package", "postwrite.package"],
  ])("%s accepts production inputs with legacy quality flags", (name, type, action) => {
    const result = evaluate(name, type, action, { input_path: "/source.mp4", output_path: "/new.mp4",
      verify: false, skip_verify: true, variants_distinct: false, identical_variants: true, variant_count: 1,
      uhd_requested: true, resolution_exact: true, enhancement_verified: false });
    expect(result.level).toBe("auto");
    expect(result.evalErrors).toEqual([]);
  });

  it.each([
    ["color", "final_video", "colorwrite.grade"],
    ["subtitle", "final_video", "subtitlewrite.burn"],
    ["bgm", "final_video", "bgmwrite.mix"],
    ["voice", "final_video", "voicewrite.dub"],
    ["delivery", "delivery_package", "postwrite.package"],
  ])("%s still blocks source overwrite", (name, type, action) => {
    const result = evaluate(name, type, action, { input_path: "/source.mp4", output_path: "/source.mp4" });
    expect(result.level).toBe("block");
    expect(result.evalErrors).toEqual([]);
  });

  it("sparse path fields do not mistake missing/missing for a source overwrite", () => {
    for (const [name, type, action] of [["delivery", "delivery_package", "postwrite.package"],
      ["subtitle", "subtitle_report", "subtitlewrite.sidecar"], ["bgm", "bgm_track", "bgmwrite.compose"]]) {
      const result = evaluate(name, type, action, {});
      expect(result.level).toBe("auto");
      expect(result.evalErrors).toEqual([]);
    }
  });

  it("font/music licensing, clone consent, quota and voice privacy remain effective", () => {
    expect(evaluate("subtitle", "subtitle_report", "subtitlewrite.burn", { commercial_use: true, font_license: "unknown" }).level).toBe("block");
    expect(evaluate("bgm", "bgm_report", "bgmwrite.mix", { commercial_use: true, track_license: "cc-by-nc-4.0" }).level).toBe("block");
    expect(evaluate("bgm", "bgm_report", "bgmwrite.mix", { policy: "music-only" }).level).toBe("block");
    expect(evaluate("voice", "voice_profile", "voicewrite.register", {}).level).toBe("review");
    expect(evaluate("voice", "voice_report", "voicewrite.speak", { upload_voiceprint: true }).level).toBe("block");
    const policy = pack("color");
    expect(judge({ object: { type: "final_video" }, action: "colorwrite.grade", effect: "write", params: {}, context: { tenant_daily_grades: 30 } }, policy.rules, policy.defaultLevel).level).toBe("block");
  });

  it("material receipt presence uses valid DSL and rejects empty or wrongly typed proof fields", () => {
    const policy = pack("material");
    const rule = policy.rules.find((item) => item.rule_id === "G-MAT2")!;
    const proof = { material_usage: "generation-reference", render_task_id: "provider-task-123", model: "provider-model",
      source_material_sha256: "a".repeat(64), output_sha256: "b".repeat(64) };
    expect(evalCondition(rule.when, { params: proof })).toBe(false);
    for (const key of ["render_task_id", "model", "source_material_sha256", "output_sha256"]) {
      for (const bad of [undefined, null, "", false, true, 0, 7, {}, []]) {
        expect(evalCondition(rule.when, { params: { ...proof, [key]: bad } }), `${key}=${JSON.stringify(bad)}`).toBe(true);
      }
    }
    const accepted = evaluate("material", "video_asset", "render.write", { ...proof, reference_only: true,
      fidelity_reviewed: false, landmark_altered: true, text_identifier_changed: true });
    expect(accepted.level).toBe("auto");
    expect(accepted.evalErrors).toEqual([]);
    expect(evaluate("material", "render_job", "render.submit", { material_usage: "generation-reference", reference_only: false }).level).toBe("block");
  });
});
