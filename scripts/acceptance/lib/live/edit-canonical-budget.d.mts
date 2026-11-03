export const EDIT_CANONICAL_CASE_BUDGET: Readonly<{
  modelId: string;
  maxLlmTokens: number;
  maxLlmOutputTokens: number;
}>;

export function verifyEditCanonicalLlmEnvelope(args: {
  modelId: unknown;
  inputTokens: unknown;
  maxOutputTokens: unknown;
}): { inputTokens: number; maxOutputTokens: number; grossTokens: number };
