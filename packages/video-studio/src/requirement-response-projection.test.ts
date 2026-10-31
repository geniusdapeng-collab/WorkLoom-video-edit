import { describe, expect, it } from "vitest";
import { projectDeclaredFields } from "./requirement-contract.js";

describe("strict model response projection", () => {
  it("drops only undeclared top-level fields while preserving every declared value", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["technicalRisks", "businessConstraints", "mitigationSuggestions"],
      properties: {
        technicalRisks: { type: "array" },
        businessConstraints: { type: "array" },
        mitigationSuggestions: { type: "array" },
      },
    };
    const response = {
      technicalRisks: [{ risk: "真实风险" }],
      businessConstraints: ["真实限制"],
      mitigationSuggestions: ["真实建议"],
      confidence: 0.9,
      notes: "未声明",
    };
    expect(projectDeclaredFields(response, schema)).toEqual({
      technicalRisks: [{ risk: "真实风险" }],
      businessConstraints: ["真实限制"],
      mitigationSuggestions: ["真实建议"],
    });
    expect(projectDeclaredFields({ technicalRisks: [] }, schema)).toEqual({ technicalRisks: [] });
    expect(projectDeclaredFields("not-object", schema)).toBe("not-object");
  });
  it("preserves all string constraints while compacting an array over its schema cap", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["businessConstraints", "technicalRisks"],
      properties: {
        businessConstraints: { type: "array", maxItems: 2, items: { type: "string" } },
        technicalRisks: {
          type: "array",
          maxItems: 2,
          items: { type: "object", additionalProperties: false, properties: { risk: { type: "string" } } },
        },
      },
    };
    expect(projectDeclaredFields({
      businessConstraints: ["A", "B", "C", "D"],
      technicalRisks: [{ risk: "R1" }, { risk: "R2" }, { risk: "R3" }],
      extra: true,
    }, schema)).toEqual({
      businessConstraints: ["A", "B；C；D"],
      technicalRisks: [{ risk: "R1" }, { risk: "R2" }],
    });
  });
});
