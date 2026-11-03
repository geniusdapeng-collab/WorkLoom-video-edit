import { describe, expect, it } from "vitest";
import {
  EDIT_CANONICAL_CASE_BUDGET,
  verifyEditCanonicalLlmEnvelope,
} from "../acceptance/lib/live/edit-canonical-budget.mjs";

describe("Edit's canonical case budget", () => {
  const modelId = EDIT_CANONICAL_CASE_BUDGET.modelId;

  it("accepts the full native output, including the exact total context boundary", () => {
    expect(EDIT_CANONICAL_CASE_BUDGET).toEqual({
      modelId: "deepseek-flash", maxLlmTokens: 1_048_576, maxLlmOutputTokens: 393_216,
    });
    const cases = [
      { inputTokens: 20, maxOutputTokens: 393_216, grossTokens: 393_236 },
      { inputTokens: 655_360, maxOutputTokens: 393_216, grossTokens: 1_048_576 },
      { inputTokens: 655_361, maxOutputTokens: 393_215, grossTokens: 1_048_576 },
      { inputTokens: 1_048_575, maxOutputTokens: 1, grossTokens: 1_048_576 },
    ];
    for (const expected of cases) {
      const { inputTokens, maxOutputTokens } = expected;
      expect(verifyEditCanonicalLlmEnvelope({ modelId, inputTokens, maxOutputTokens })).toEqual(expected);
    }
  });

  it("rejects an unverified model or input and any altered output ceiling", () => {
    const valid = { modelId, inputTokens: 655_361, maxOutputTokens: 393_215 };
    for (const inputTokens of [null, undefined, 0, -1, NaN, Infinity, "655361", 655_361.5, 1_048_576]) {
      expect(() => verifyEditCanonicalLlmEnvelope({ ...valid, inputTokens })).toThrow("EDIT_CANONICAL_LLM_INPUT_UNVERIFIED");
    }
    for (const maxOutputTokens of [undefined, NaN, "393215", 393_216, 16_384]) {
      expect(() => verifyEditCanonicalLlmEnvelope({ ...valid, maxOutputTokens })).toThrow("EDIT_CANONICAL_LLM_OUTPUT_CEILING_MISMATCH");
    }
    expect(() => verifyEditCanonicalLlmEnvelope({ ...valid, modelId: "deepseek-v4-flash" })).toThrow("EDIT_CANONICAL_LLM_MODEL_INVALID");
  });
});
