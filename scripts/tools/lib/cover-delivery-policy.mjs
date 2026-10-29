import { join } from "node:path";

export const DEFAULT_COVER_INTRO_SECONDS = 0.6;
export const MAX_COVER_INTRO_SECONDS = 5;

/**
 * Variant IDs are content-pipeline identities, not cover layouts. These aliases
 * cover the currently published variant catalogs while every custom identity
 * still requires an explicit style-map entry.
 */
export const COVER_STYLE_ALIASES = Object.freeze({
  "cool-tech": "clean-tech",
  "warm-film": "warm-story",
  "punchy-social": "bold-promo",
  original: "natural-clean",
  "content-auto": "clean-tech",
});

export function parseCoverIntroSeconds(raw, fallback = DEFAULT_COVER_INTRO_SECONDS) {
  const fallbackSeconds = Number(fallback);
  if (!Number.isFinite(fallbackSeconds) || fallbackSeconds < 0 || fallbackSeconds > MAX_COVER_INTRO_SECONDS) {
    throw new Error(`默认封面片头时长必须在 0–${MAX_COVER_INTRO_SECONDS} 秒`);
  }
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallbackSeconds;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > MAX_COVER_INTRO_SECONDS) {
    throw new Error(`封面片头时长必须在 0–${MAX_COVER_INTRO_SECONDS} 秒（收到 ${String(raw)}）`);
  }
  return Number(value.toFixed(3));
}

export function resolveCoverStyleId(variantId, knownStyleIds, styleMap = {}) {
  const id = String(variantId ?? "").trim();
  if (!id) throw new Error("封面变体 ID 不能为空");
  const known = new Set(knownStyleIds.map(String));
  const mapped = styleMap && typeof styleMap === "object" ? styleMap[id] : undefined;
  const resolved = String(mapped ?? COVER_STYLE_ALIASES[id] ?? id);
  if (!known.has(resolved)) {
    throw new Error(`封面样式未显式映射：${id}（可用样式 ${[...known].join(" / ")}；自定义变体请传 --style-map）`);
  }
  return resolved;
}

function fail(message) {
  throw new Error(`封面文案候选表无效：${message}`);
}

function candidateTotal(candidate) {
  if (Number.isFinite(Number(candidate?.total))) return Number(candidate.total);
  const scores = candidate?.scores;
  if (scores && typeof scores === "object") {
    const values = Object.values(scores).map(Number);
    if (values.length > 0 && values.every(Number.isFinite)) return values.reduce((sum, value) => sum + value, 0);
  }
  return Number.NaN;
}

/**
 * Enforces the cover-designer preset's copy-before-render discipline. A deck is
 * optional on legacy jobs, but when supplied it must be genuinely reviewable.
 */
export function validateCoverCopyDeck(deck, expectedVariantIds = []) {
  if (!deck || typeof deck !== "object" || Array.isArray(deck)) fail("根节点必须是对象");
  const variants = deck.variants;
  if (!variants || typeof variants !== "object" || Array.isArray(variants)) fail("缺少 variants 对象");
  const ids = expectedVariantIds.length > 0 ? expectedVariantIds.map(String) : Object.keys(variants);
  if (ids.length === 0) fail("没有可校验的变体");

  for (const variantId of ids) {
    const entry = variants[variantId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`缺少变体 ${variantId}`);
    const candidates = entry.candidates;
    if (!Array.isArray(candidates) || candidates.length < 5) fail(`${variantId} 至少 5 条文案候选`);
    for (const [index, candidate] of candidates.entries()) {
      if (!candidate || typeof candidate !== "object") fail(`${variantId} 候选 ${index + 1} 不是对象`);
      for (const field of ["text", "hookFormula", "fact", "reason"]) {
        if (!String(candidate[field] ?? "").trim()) fail(`${variantId} 候选 ${index + 1} 缺 ${field}`);
      }
      const total = candidateTotal(candidate);
      if (!Number.isFinite(total) || total < 6) fail(`${variantId} 候选 ${index + 1} 总分必须 ≥6`);
    }
    const chosen = String(entry.chosen ?? entry.selected ?? "").trim();
    if (!chosen) fail(`${variantId} 缺 chosen`);
    if (!candidates.some((candidate) => String(candidate.text).trim() === chosen)) {
      fail(`${variantId} 的 chosen 不在候选表中`);
    }
    const selfCheck = entry.copySelfCheck;
    if (!selfCheck || selfCheck.passed !== true) fail(`${variantId} 自检未通过`);
    if (!Array.isArray(selfCheck.forbiddenExamplesHit) || selfCheck.forbiddenExamplesHit.length > 0) {
      fail(`${variantId} 自检必须记录空的 forbiddenExamplesHit`);
    }
  }
  return deck;
}

export function canonicalCoverIntroRelativePath(variantId, form = "") {
  const id = String(variantId ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`封面变体 ID 非法：${id}`);
  const suffix = String(form ?? "");
  if (!/^(?:|\.[a-z0-9]+(?:\.[a-z0-9]+)*)$/.test(suffix)) throw new Error(`封面形态后缀非法：${suffix}`);
  return `variants/${id}/${id}${suffix}.cover.mp4`;
}

export function canonicalCoverIntroPath(outDir, variantId, form = "") {
  return join(outDir, canonicalCoverIntroRelativePath(variantId, form));
}
