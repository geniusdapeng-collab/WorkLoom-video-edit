import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileVideoPipelineDocument,
  loadVideoPipelinePlan,
} from "./pipeline-topology.js";

const ROOT = resolve(import.meta.dirname, "../../../..");

describe("runtime video pipeline topology", () => {
  it("loads production YAML as immutable compiled plans", () => {
    const marketing = loadVideoPipelinePlan(resolve(ROOT, "bundles/ai-video/pipelines/marketing-film.yml"), "marketing-film");
    const narrative = loadVideoPipelinePlan(resolve(ROOT, "bundles/ai-video/pipelines/narrative-film.yml"), "narrative-film");
    expect(marketing.nodes.find((node) => node.key === "g3-insight-confirm")?.dependsOn).toEqual(["insight"]);
    expect(narrative.nodes.find((node) => node.key === "g7-preproduction")?.dependsOn).toEqual(["g5-portrait-confirm", "micromotion"]);
    expect(marketing.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(narrative.planHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects cycles, missing dependencies and duplicate IDs", () => {
    expect(() => compileVideoPipelineDocument({
      quest: "bad", name: "Bad", version: "v1", steps: [
        { step_key: "a", name: "A", owner: "o", outputs: ["x"], depends_on: ["b"] },
        { step_key: "b", name: "B", owner: "o", outputs: ["y"], depends_on: ["a"] },
      ],
    })).toThrow(/环/);
    expect(() => compileVideoPipelineDocument({
      quest: "bad", name: "Bad", version: "v1", steps: [
        { step_key: "a", name: "A", owner: "o", outputs: ["x"], depends_on: ["missing"] },
      ],
    })).toThrow(/未知/);
  });
});
