import { describe, expect, it } from "vitest";
import { structuredSceneSchema } from "./requirement-contract.js";

function nativeSchema() {
  const node = {
    type: "object",
    properties: {
      duration: { type: "number", minimum: 5, maximum: 60 },
      purpose: { type: "string", maxLength: 100 },
      keyElements: { type: "array", items: { type: "string" }, minItems: 1 },
    },
    required: ["duration", "purpose", "keyElements"],
  };
  return {
    type: "object",
    properties: {
      opening: { ...node, properties: { ...node.properties, duration: { type: "number", minimum: 3, maximum: 15 } } },
      scenes: { type: "array", items: structuredClone(node), minItems: 0, maxItems: 8 },
      ending: { ...node, properties: { ...node.properties, duration: { type: "number", minimum: 3, maximum: 15 } } },
      totalDuration: { type: "number", minimum: 1 },
      sceneCount: { type: "number", minimum: 2 },
    },
    required: ["opening", "scenes", "ending", "totalDuration", "sceneCount"],
  };
}

describe("structured scene supported duration floor", () => {
  it("lowers only the middle scene floor to the audited 4-second provider capability", () => {
    const source = nativeSchema(), before = structuredClone(source);
    const actual = structuredSceneSchema(source, undefined, { middleMinimum: 4 });
    expect((actual.properties as any).scenes.items.properties.duration).toMatchObject({ minimum: 4, maximum: 60 });
    expect((actual.properties as any).opening.properties.duration.minimum).toBe(3);
    expect((actual.properties as any).ending.properties.duration.minimum).toBe(3);
    expect(source).toEqual(before);
  });

  it("retains the native floor unless the option is explicitly supplied", () => {
    expect((structuredSceneSchema(nativeSchema()).properties as any).scenes.items.properties.duration.minimum).toBe(5);
  });
});
