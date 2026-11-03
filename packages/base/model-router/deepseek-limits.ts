/** Dependency-free limits for the canonical text model and its request planner. */
export const DEEPSEEK_FLASH_MODEL_ID = "deepseek-flash" as const;
export const DEEPSEEK_FLASH_CONTEXT_TOKENS = 1_048_576 as const;
export const DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS = 393_216 as const;

export function maxDeepSeekOutputForInput(
  inputTokens: number,
  contextTokens: number = DEEPSEEK_FLASH_CONTEXT_TOKENS,
  maxOutputTokens: number = DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
): number {
  const remaining = contextTokens - inputTokens;
  if (remaining < 1) throw new Error("DEEPSEEK_CONTEXT_EXCEEDED");
  return Math.min(maxOutputTokens, remaining);
}
