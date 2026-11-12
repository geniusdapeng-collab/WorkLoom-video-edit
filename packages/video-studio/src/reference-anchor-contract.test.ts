import { describe, expect, it } from "vitest";
import { auditReferenceAnchors, type ReferenceAnchorInput } from "./reference-anchor-contract.js";

const sha = (digit: string) => digit.repeat(64);
const portrait = (angle: string, patch: Partial<ReferenceAnchorInput> = {}): ReferenceAnchorInput => ({
  purpose: `portrait-${angle}`,
  characterId: "actor",
  characterVersion: 3,
  wardrobeId: "w2",
  angle,
  imageSha256: sha(angle === "front" ? "a" : "b"),
  ...patch,
});
const product = (digit: string, patch: Partial<ReferenceAnchorInput> = {}): ReferenceAnchorInput => ({
  purpose: "product-reference",
  productId: "product-a",
  angle: "front",
  imageSha256: sha(digit),
  ...patch,
});

describe("reference anchor contract", () => {
  it("passes only when person, wardrobe and product requirements are all present", () => {
    const report = auditReferenceAnchors({
      shotId: "S1",
      prompt: "image://characters/actor/portraits/v3/front.png image://products/product-a/front.jpg",
      person: { characterId: "actor", characterVersion: 3, wardrobeId: "w2" },
      products: [{ productId: "product-a", requiredImageCount: 2, requiredImageSha256: [sha("c"), sha("d")] }],
    }, [portrait("front"), portrait("closeup"), product("c"), product("d")]);
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.contractSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects the historical vacuous pass: prompt declares a person but request has zero person images", () => {
    const report = auditReferenceAnchors({
      shotId: "S1",
      prompt: "image://characters/actor/portraits/v3/front.png",
      person: { characterId: "actor", characterVersion: 3, wardrobeId: "w2" },
    }, [product("a")]);
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("PERSON_DECLARED_WITHOUT_INPUT");
  });

  it("rejects prompt image tokens that have no typed anchor contract", () => {
    const report = auditReferenceAnchors({
      shotId: "S1",
      prompt: "image://characters/actor image://products/product-a",
    }, []);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "PROMPT_DECLARES_UNBOUND_CHARACTER",
      "PROMPT_DECLARES_UNBOUND_PRODUCT",
    ]));
  });

  it("rejects wrong identity version, missing angle and a baseline portrait masquerading as another wardrobe", () => {
    const report = auditReferenceAnchors({
      shotId: "S1",
      prompt: "image://characters/actor",
      person: { characterId: "actor", characterVersion: 3, wardrobeId: "w2" },
    }, [
      portrait("front", { characterVersion: 2 }),
      portrait("closeup", { characterVersion: 2, wardrobeId: "w1" }),
    ]);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "PERSON_IDENTITY_MISMATCH",
      "PERSON_ANGLE_MISSING",
      "WARDROBE_INPUT_MISSING",
    ]));
  });

  it("rejects an incomplete product set or missing frozen bytes", () => {
    const report = auditReferenceAnchors({
      shotId: "S1",
      prompt: "image://products/product-a",
      products: [{ productId: "product-a", requiredImageCount: 3, requiredImageSha256: [sha("a"), sha("b"), sha("c")] }],
    }, [product("a"), product("b", { imageSha256: undefined })]);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "PRODUCT_INPUT_COUNT_MISMATCH",
      "PRODUCT_BYTES_MISSING",
      "PRODUCT_ID_MISMATCH",
    ]));
  });
});
