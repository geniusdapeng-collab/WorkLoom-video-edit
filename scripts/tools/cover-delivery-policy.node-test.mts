import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalCoverIntroRelativePath,
  parseCoverIntroSeconds,
  resolveCoverStyleId,
  validateCoverCopyDeck,
} from "./lib/cover-delivery-policy.mjs";

const candidates = [
  {
    text: "数字锚点标题",
    hookFormula: "data-shock",
    fact: "成片中的真实数字",
    total: 9,
    reason: "数字前置",
  },
  {
    text: "具体动作标题",
    hookFormula: "value-preview",
    fact: "片中的实际动作",
    total: 8,
    reason: "动作可验证",
  },
  {
    text: "疑问式标题",
    hookFormula: "question",
    fact: "片中有答案",
    total: 8,
    reason: "答案在片中",
  },
  {
    text: "冲突式标题",
    hookFormula: "conflict",
    fact: "冲突来自真实限制",
    total: 8,
    reason: "立场与成片一致",
  },
  {
    text: "价值预览标题",
    hookFormula: "value-preview",
    fact: "成片兑现该承诺",
    total: 7,
    reason: "收益明确",
  },
];

function deck(variant = "variant-a") {
  return {
    schemaVersion: "workloom.cover-copy-deck/v1",
    variants: {
      [variant]: {
        chosen: "数字锚点标题",
        candidates,
        copySelfCheck: {
          passed: true,
          forbiddenExamplesHit: [],
        },
      },
    },
  };
}

test("cover intro duration has one shared default and rejects invalid values", () => {
  assert.equal(parseCoverIntroSeconds(undefined), 0.6);
  assert.equal(parseCoverIntroSeconds("0.6"), 0.6);
  assert.equal(parseCoverIntroSeconds("0"), 0);
  assert.throws(() => parseCoverIntroSeconds("-0.1"), /0–5/);
  assert.throws(() => parseCoverIntroSeconds("5.1"), /0–5/);
  assert.throws(() => parseCoverIntroSeconds("abc"), /0–5/);
});

test("variant IDs resolve only through explicit styles or documented aliases", () => {
  const known = ["warm-story", "clean-tech", "bold-promo", "natural-clean"];
  assert.equal(resolveCoverStyleId("clean-tech", known), "clean-tech");
  assert.equal(resolveCoverStyleId("warm-film", known), "warm-story");
  assert.equal(resolveCoverStyleId("cool-tech", known), "clean-tech");
  assert.equal(resolveCoverStyleId("punchy-social", known), "bold-promo");
  assert.equal(resolveCoverStyleId("original", known), "natural-clean");
  assert.equal(resolveCoverStyleId("content-auto", known), "clean-tech");
  assert.equal(resolveCoverStyleId("campaign-cut", known, { "campaign-cut": "bold-promo" }), "bold-promo");
  assert.throws(() => resolveCoverStyleId("unknown-cut", known), /未显式映射/);
});

test("copy deck enforces five scored candidates and a passed self-check", () => {
  const result = validateCoverCopyDeck(deck(), ["variant-a"]);
  assert.equal(result.variants["variant-a"].candidates.length, 5);
  assert.throws(() => validateCoverCopyDeck({
    ...deck(),
    variants: { "variant-a": { ...deck().variants["variant-a"], candidates: candidates.slice(0, 4) } },
  }, ["variant-a"]), /至少 5 条/);
  assert.throws(() => validateCoverCopyDeck({
    ...deck(),
    variants: { "variant-a": { ...deck().variants["variant-a"], copySelfCheck: { passed: false, forbiddenExamplesHit: [] } } },
  }, ["variant-a"]), /自检/);
  assert.throws(() => validateCoverCopyDeck(deck(), ["missing-variant"]), /缺少变体/);
});

test("complete cover videos use canonical non-staging paths", () => {
  assert.equal(canonicalCoverIntroRelativePath("warm-story", ""), "variants/warm-story/warm-story.cover.mp4");
  assert.equal(canonicalCoverIntroRelativePath("warm-story", ".burned"), "variants/warm-story/warm-story.burned.cover.mp4");
  assert.equal(canonicalCoverIntroRelativePath("warm-story", ".burned.danmaku"), "variants/warm-story/warm-story.burned.danmaku.cover.mp4");
});
