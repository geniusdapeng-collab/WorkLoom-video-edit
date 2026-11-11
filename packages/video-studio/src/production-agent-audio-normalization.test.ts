import { describe, expect, it } from "vitest";
import {
  normalizeProductionAgentData, productionAgentDataShape,
} from "./prd-authority-bridge.js";

const shot = { shotId: "opening", backgroundSound: { environment: "track" } };

describe("AudioDesignAgent structured response normalization", () => {
  it.each([
    [ [shot], { shots: [shot] } ],
    [ shot, { shots: [shot] } ],
    [ JSON.stringify([shot]), { shots: [shot] } ],
    [ { shots: JSON.stringify([shot]), extra: "preserved" }, { shots: [shot], extra: "preserved" } ],
  ])("normalizes exact equivalent declarations without inventing fields", (value, expected) => {
    expect(normalizeProductionAgentData("AudioDesignAgent", value)).toEqual(expected);
  });

  it("does not reinterpret other production agents or malformed values", () => {
    expect(normalizeProductionAgentData("VisualLanguageAgent", [shot])).toEqual([shot]);
    expect(normalizeProductionAgentData("AudioDesignAgent", { shots: "not-json" }))
      .toEqual({ shots: "not-json" });
    expect(productionAgentDataShape({ shots: [] })).toBe("object{shots}");
    expect(productionAgentDataShape([shot])).toBe("array[1]");
  });
});
