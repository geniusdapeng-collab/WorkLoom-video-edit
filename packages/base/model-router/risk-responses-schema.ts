import { types } from "node:util";
import type { ResponsesJsonSchema } from "./providers.js";

export const RISK_RESPONSES_SCHEMA_NAME = "workloom_risk_assessor";

function freezeSchema<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeSchema);
    Object.freeze(value);
  }
  return value;
}

/** Pinned vendor RiskAssessmentSchema, with the nested risk object closed on the wire. */
export const riskResponsesJsonSchema: ResponsesJsonSchema = freezeSchema({
  name: RISK_RESPONSES_SCHEMA_NAME,
  schema: {
    type: "object",
    required: ["technicalRisks", "businessConstraints", "mitigationSuggestions"],
    properties: {
      technicalRisks: {
        type: "array",
        items: {
          type: "object",
          required: ["risk", "level", "impact"],
          properties: {
            risk: { type: "string" },
            level: { type: "string", enum: ["high", "medium", "low"] },
            impact: { type: "string" },
          },
          additionalProperties: false,
        },
        minItems: 1,
        maxItems: 5,
      },
      businessConstraints: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4 },
      mitigationSuggestions: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4 },
    },
    additionalProperties: false,
  },
});

function matchesSchema(value: unknown, expected: unknown): boolean {
  if (!expected || typeof expected !== "object") return value === expected;
  if (!value || typeof value !== "object" || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.getPrototypeOf(expected)) return false;
  const keys = Reflect.ownKeys(expected);
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const actual = Object.getOwnPropertyDescriptor(value, key);
    const required = Object.getOwnPropertyDescriptor(expected, key)!;
    return !!actual && actual.enumerable === required.enumerable && "value" in actual
      && matchesSchema(actual.value, required.value);
  });
}

/** Accept only the exact ordinary-data envelope and closed schema, independent of object key order. */
export function isRiskResponsesJsonSchema(value: unknown): value is ResponsesJsonSchema {
  return matchesSchema(value, riskResponsesJsonSchema);
}
