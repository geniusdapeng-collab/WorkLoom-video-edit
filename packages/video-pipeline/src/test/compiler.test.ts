import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertVideoPipelinePlan,
  compileVideoPipelineDocument,
  loadVideoPipelinePlan,
} from "../compiled-plan.js";

const ROOT = resolve(import.meta.dirname, "../../../..");

describe("video pipeline compiler", () => {
  it("compiles marketing, narrative and explainer definitions", () => {
    const marketing = loadVideoPipelinePlan(resolve(ROOT, "bundles/ai-video/pipelines/marketing-film.yml"), "marketing-film");
    const narrative = loadVideoPipelinePlan(resolve(ROOT, "bundles/ai-video/pipelines/narrative-film.yml"), "narrative-film");
    const explainer = loadVideoPipelinePlan(resolve(ROOT, "bundles/ai-video/pipelines/explainer-film.yml"), "explainer-film");
    expect(marketing.nodes.find((node) => node.key === "production")?.kind).toBe("call");
    expect(narrative.nodes.find((node) => node.key === "g6-prompt-confirm")?.kind).toBe("gate");
    expect(explainer.nodes.find((node) => node.key === "render")?.sideEffect).toBe("provider");
    expect(marketing.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(narrative.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(explainer.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(assertVideoPipelinePlan(marketing).planHash).toBe(marketing.planHash);
    expect(assertVideoPipelinePlan(narrative).planHash).toBe(narrative.planHash);
    expect(assertVideoPipelinePlan(explainer).planHash).toBe(explainer.planHash);
    expect(narrative.nodes.find((node) => node.key === "g6-prompt-confirm")?.kind).toBe("gate");
    expect("checkSetVersion" in (narrative.nodes.find((node) => node.key === "g6-prompt-confirm") ?? {})).toBe(true);
  });

  it("rejects cycles and unknown dependencies", () => {
    expect(() => compileVideoPipelineDocument({
      quest: "bad", name: "bad", version: "1", steps: [
        { step_key: "a", name: "A", owner: "o", outputs: ["x"], depends_on: ["b"] },
        { step_key: "b", name: "B", owner: "o", outputs: ["y"], depends_on: ["a"] },
      ],
    })).toThrow(/存在环/);
    expect(() => compileVideoPipelineDocument({
      quest: "bad", name: "bad", version: "1", steps: [
        { step_key: "a", name: "A", owner: "o", outputs: ["x"], depends_on: ["missing"] },
      ],
    })).toThrow(/依赖未知/);
  });

  it("rejects duplicate step keys", () => {
    expect(() => compileVideoPipelineDocument({
      quest: "bad", name: "bad", version: "1", steps: [
        { step_key: "a", name: "A", owner: "o", outputs: ["x"] },
        { step_key: "a", name: "B", owner: "o", outputs: ["y"] },
      ],
    })).toThrow(/重复/);
  });

  it("rejects unknown adapters and gates", () => {
    expect(() => compileVideoPipelineDocument({
      quest: "bad", name: "bad", version: "1", steps: [
        { step_key: "a", name: "A", owner: "o", outputs: ["x"], adapter: "missing.adapter" },
      ],
    })).toThrow(/未知 adapter/);
    expect(() => compileVideoPipelineDocument({
      quest: "bad", name: "bad", version: "1", steps: [
        { step_key: "g99", name: "G99", owner: "o", gate: "G99", outputs: ["x"] },
      ],
    })).toThrow(/未知 gate/);
  });

  it("rejects a producer/consumer schema mismatch", () => {
    expect(() => compileVideoPipelineDocument({
      quest: "bad", name: "bad", version: "1", steps: [
        { step_key: "a", name: "A", owner: "o", outputs: [{ role: "x", schema: "one/v1" }] },
        {
          step_key: "b", name: "B", owner: "o", depends_on: ["a"],
          inputs: [{ role: "x", schema: "two/v1" }], outputs: ["y"],
        },
      ],
    })).toThrow(/SCHEMA_MISMATCH|期望 two\/v1/);
  });

  it("rejects a missing producer for a non-root input", () => {
    expect(() => compileVideoPipelineDocument({
      quest: "bad", name: "bad", version: "1", steps: [
        { step_key: "a", name: "A", owner: "o", outputs: ["x"] },
        {
          step_key: "b", name: "B", owner: "o", depends_on: ["a"], inputs: ["missing"], outputs: ["y"],
        },
      ],
    })).toThrow(/没有上游 producer/);
  });
});
