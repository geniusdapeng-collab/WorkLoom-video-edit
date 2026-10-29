/**
 * Video-pipeline model policy.
 *
 * DeepSeek currently serves `deepseek-v4-flash` as a compatibility alias for
 * `deepseek-flash` (V4.1-Flash-1017). New code must use the canonical name so
 * routing, evidence budgets and traces all identify the same live model.
 */
import {
  DEEPSEEK_FLASH_CONTEXT_TOKENS,
  DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  DEEPSEEK_FLASH_MODEL_ID,
  DEFAULT_JSON_OUTPUT_TOKENS,
  deepSeekInputTokenBudget,
  estimateDeepSeekTokens,
} from "@workloom/base/model-router";

export {
  DEEPSEEK_FLASH_CONTEXT_TOKENS,
  DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  estimateDeepSeekTokens,
};
export const DEEPSEEK_FLASH_MODEL = DEEPSEEK_FLASH_MODEL_ID;
export const DEEPSEEK_VIDEO_JSON_OUTPUT_TOKENS = DEFAULT_JSON_OUTPUT_TOKENS;
export const DEEPSEEK_FLASH_INPUT_TOKEN_BUDGET = deepSeekInputTokenBudget(DEEPSEEK_VIDEO_JSON_OUTPUT_TOKENS);

type Env = Record<string, string | undefined>;

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function isDeepSeekEndpoint(value: string): boolean {
  try {
    return new URL(value).hostname === "api.deepseek.com";
  } catch {
    return false;
  }
}

/** Canonical model used by every video-pipeline call. Explicit pins win. */
export function resolveVideoModel(env: Env = process.env): string {
  const configured = clean(env.LLM_FORCE_MODEL)
    || clean(env.LLM_MODEL)
    || clean(env.DEEPSEEK_MODEL);
  if (configured) return configured === "deepseek-v4-flash" ? DEEPSEEK_FLASH_MODEL : configured;
  const endpoint = clean(env.LLM_BASE_URL) || clean(env.DEEPSEEK_BASE_URL);
  return isDeepSeekEndpoint(endpoint) || clean(env.DEEPSEEK_API_KEY)
    ? DEEPSEEK_FLASH_MODEL
    : "";
}

/**
 * OpenAI-compatible endpoint for chat completions.
 * `DEEPSEEK_BASE_URL` may point at `/anthropic` in deployed secrets; that path
 * cannot serve `/chat/completions`, so normalize it without hiding the config.
 */
export function resolveOpenAiCompatibleBaseUrl(env: Env = process.env): string {
  const base = clean(env.LLM_BASE_URL) || clean(env.DEEPSEEK_BASE_URL);
  return base.replace(/\/+$/, "").replace(/\/anthropic$/i, "");
}

export function resolveVideoApiKey(env: Env = process.env): string {
  return clean(env.LLM_API_KEY) || clean(env.DEEPSEEK_API_KEY);
}

/**
 * Video generation and review calls use non-thinking mode by default for the
 * Flash model: hidden reasoning competes with the finite output budget and can
 * leave structured scene responses empty. `LLM_NON_THINKING=0` is the explicit
 * rollback switch.
 */
export function resolveVideoNonThinking(model: string, env: Env = process.env): boolean {
  const flag = clean(env.LLM_NON_THINKING).toLowerCase();
  if (["0", "false", "off", "no"].includes(flag)) return false;
  if (["1", "true", "on", "yes"].includes(flag)) return true;
  return model === DEEPSEEK_FLASH_MODEL || model === "deepseek-v4-flash";
}
