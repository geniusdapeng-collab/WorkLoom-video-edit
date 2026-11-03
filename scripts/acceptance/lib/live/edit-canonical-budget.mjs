import {
  DEEPSEEK_FLASH_MODEL_ID,
  DEEPSEEK_FLASH_CONTEXT_TOKENS,
  DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  maxDeepSeekOutputForInput,
} from "../../../../packages/base/model-router/deepseek-limits.ts";

/** Edit's explicit one-case policy. Ordinary RDAS profile limits remain separate. */
export const EDIT_CANONICAL_CASE_BUDGET = Object.freeze({
  modelId: DEEPSEEK_FLASH_MODEL_ID,
  maxLlmTokens: DEEPSEEK_FLASH_CONTEXT_TOKENS,
  maxLlmOutputTokens: DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
});

/** Input tokens must be computed by the native planner from the actual model request. */
export function verifyEditCanonicalLlmEnvelope({ modelId, inputTokens, maxOutputTokens }) {
  if (modelId !== EDIT_CANONICAL_CASE_BUDGET.modelId) throw new Error("EDIT_CANONICAL_LLM_MODEL_INVALID");
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 1 || inputTokens >= EDIT_CANONICAL_CASE_BUDGET.maxLlmTokens) {
    throw new Error("EDIT_CANONICAL_LLM_INPUT_UNVERIFIED");
  }
  if (maxOutputTokens !== maxDeepSeekOutputForInput(inputTokens)) throw new Error("EDIT_CANONICAL_LLM_OUTPUT_CEILING_MISMATCH");
  return { inputTokens, maxOutputTokens, grossTokens: inputTokens + maxOutputTokens };
}
