/**
 * Cross-layer reference-anchor contract.
 *
 * A prompt saying `image://...` is not evidence that an image was submitted.
 * This module binds the semantic requirement (who/product/wardrobe appears)
 * to the provider request's actual reference-image evidence.
 */
import { createHash } from "node:crypto";

export interface ReferenceAnchorInput {
  purpose: string;
  characterId?: string;
  characterVersion?: number;
  wardrobeId?: string;
  productId?: string;
  angle?: string;
  imageSha256?: string;
}

export interface PersonReferenceRequirement {
  characterId: string;
  characterVersion: number;
  wardrobeId?: string;
  requiredAngles?: string[];
}

export interface ProductReferenceRequirement {
  productId: string;
  requiredImageCount: number;
  requiredImageSha256?: string[];
}

export interface ReferenceAnchorRequirement {
  shotId: string;
  prompt: string;
  person?: PersonReferenceRequirement;
  products?: ProductReferenceRequirement[];
}

export interface ReferenceAnchorIssue {
  code:
    | "PERSON_DECLARED_WITHOUT_INPUT"
    | "PERSON_IDENTITY_MISMATCH"
    | "PERSON_ANGLE_MISSING"
    | "WARDROBE_INPUT_MISSING"
    | "PRODUCT_DECLARED_WITHOUT_INPUT"
    | "PRODUCT_ID_MISMATCH"
    | "PRODUCT_INPUT_COUNT_MISMATCH"
    | "PRODUCT_BYTES_MISSING"
    | "PROMPT_DECLARES_UNBOUND_CHARACTER"
    | "PROMPT_DECLARES_UNBOUND_PRODUCT";
  detail: string;
}

export interface ReferenceAnchorReport {
  ok: boolean;
  schemaVersion: "workloom.reference-anchor-audit/v1";
  shotId: string;
  issues: ReferenceAnchorIssue[];
  personInputs: ReferenceAnchorInput[];
  productInputs: ReferenceAnchorInput[];
  wardrobeInputs: ReferenceAnchorInput[];
  contractSha256: string;
}

const REFERENCE_PURPOSE = /^portrait-|^wardrobe-|^product-reference$|^authorized-person-reference$/;
const promptCharacter = /image:\/\/characters\//i;
const promptProduct = /image:\/\/(?:products?|materials?)\//i;
const sha256 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Fail closed unless every declared visible anchor is present in the exact
 * ordered input plan that will be sent to the provider.
 */
export function auditReferenceAnchors(
  requirement: ReferenceAnchorRequirement,
  inputs: readonly ReferenceAnchorInput[],
): ReferenceAnchorReport {
  if (!requirement.shotId.trim()) throw new Error("REFERENCE_ANCHOR_SHOT_INVALID");
  if (!Array.isArray(inputs)) throw new Error("REFERENCE_ANCHOR_INPUTS_INVALID");
  const references = inputs.filter((input) => REFERENCE_PURPOSE.test(input.purpose));
  const personInputs = references.filter((input) => input.characterId
    && /^portrait-|^wardrobe-|^authorized-person-reference$/.test(input.purpose));
  const wardrobeInputs = references.filter((input) => input.characterId && input.wardrobeId
    && /^wardrobe-|^portrait-/.test(input.purpose));
  const productInputs = references.filter((input) => input.productId && input.purpose === "product-reference");
  const issues: ReferenceAnchorIssue[] = [];

  if (promptCharacter.test(requirement.prompt) && !requirement.person) {
    issues.push({
      code: "PROMPT_DECLARES_UNBOUND_CHARACTER",
      detail: "提示词声明了 image://characters/...，但镜头合同没有解析出可提交的人物身份",
    });
  }
  if (promptProduct.test(requirement.prompt) && !(requirement.products?.length)) {
    issues.push({
      code: "PROMPT_DECLARES_UNBOUND_PRODUCT",
      detail: "提示词声明了商品图片引用，但镜头合同没有解析出可提交的商品档案",
    });
  }

  if (requirement.person) {
    const person = requirement.person;
    if (personInputs.length === 0) {
      issues.push({
        code: "PERSON_DECLARED_WITHOUT_INPUT",
        detail: `镜头声明人物 ${person.characterId}，但实际请求没有人物参考图`,
      });
    }
    const identityInputs = personInputs.filter((input) => input.characterId === person.characterId
      && input.characterVersion === person.characterVersion);
    if (personInputs.length > 0 && identityInputs.length !== personInputs.length) {
      issues.push({
        code: "PERSON_IDENTITY_MISMATCH",
        detail: `人物参考必须全部绑定 ${person.characterId} v${person.characterVersion}`,
      });
    }
    for (const angle of person.requiredAngles ?? ["front", "closeup"]) {
      if (!identityInputs.some((input) => input.angle === angle
        && /^portrait-|^wardrobe-|^authorized-person-reference$/.test(input.purpose))) {
        issues.push({
          code: "PERSON_ANGLE_MISSING",
          detail: `缺少人物身份角度 ${angle}（${person.characterId} v${person.characterVersion}）`,
        });
      }
    }
    if (person.wardrobeId) {
      const wardrobeMatches = wardrobeInputs.filter((input) => input.characterId === person.characterId
        && input.characterVersion === person.characterVersion && input.wardrobeId === person.wardrobeId);
      if (wardrobeMatches.length < 2) {
        issues.push({
          code: "WARDROBE_INPUT_MISSING",
          detail: `人物 ${person.characterId} 使用服装 ${person.wardrobeId}，实际请求必须有至少两个该服装版本角度`
            + `，当前 ${wardrobeMatches.length} 张`,
        });
      }
    }
  }

  for (const product of requirement.products ?? []) {
    const matches = productInputs.filter((input) => input.productId === product.productId);
    if (matches.length === 0) {
      issues.push({
        code: "PRODUCT_DECLARED_WITHOUT_INPUT",
        detail: `镜头声明商品 ${product.productId}，但实际请求没有商品参考图`,
      });
      continue;
    }
    if (matches.length !== product.requiredImageCount) {
      issues.push({
        code: "PRODUCT_INPUT_COUNT_MISMATCH",
        detail: `商品 ${product.productId} 要求 ${product.requiredImageCount} 张参考图，实际 ${matches.length} 张`,
      });
    }
    if (matches.some((input) => !sha256(input.imageSha256))) {
      issues.push({
        code: "PRODUCT_BYTES_MISSING",
        detail: `商品 ${product.productId} 的参考图缺少可核验 SHA256`,
      });
    }
    for (const expected of product.requiredImageSha256 ?? []) {
      if (!matches.some((input) => input.imageSha256 === expected)) {
        issues.push({
          code: "PRODUCT_ID_MISMATCH",
          detail: `商品 ${product.productId} 缺少已绑定参考字节 ${expected.slice(0, 12)}…`,
        });
      }
    }
  }

  const contractSha256 = createHash("sha256").update(stable({
    schemaVersion: "workloom.reference-anchor-audit/v1",
    shotId: requirement.shotId,
    person: requirement.person ?? null,
    products: requirement.products ?? [],
    inputs: references,
  })).digest("hex");
  return {
    ok: issues.length === 0,
    schemaVersion: "workloom.reference-anchor-audit/v1",
    shotId: requirement.shotId,
    issues,
    personInputs,
    productInputs,
    wardrobeInputs,
    contractSha256,
  };
}
