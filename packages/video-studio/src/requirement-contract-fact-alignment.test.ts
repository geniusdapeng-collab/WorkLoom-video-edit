import { describe, expect, it } from "vitest";
import { reconcileRenderedRequirementFacts } from "./requirement-contract-bridge.js";
import type { PrdAuthority } from "./prd-authority.js";

function authority(): PrdAuthority {
  const content = JSON.stringify({
    facts: {
      claims: [
        { pointer: "/identity/specs/前轮胎规格", value: "120/70 ZR17" },
        { pointer: "/identity/specs/后轮胎规格", value: "180/60 ZR17" },
      ],
    },
  });
  return {
    metadata: { brief: { duration: 30 } },
    profile: { targetDuration: 30 },
    marketing: {
      schemaVersion: "workloom.prd-marketing-authority/v1",
      scope: { tenantId: "t", workspaceId: "w", projectId: "p", runId: "r", attempt: 1 },
      g1Artifact: { path: "/fixture/G1_DOSSIER.md", sha256: "a".repeat(64), content },
      g1Proof: {
        gate: "G1_DOSSIER", approved: true, status: "passed", via: "llm",
        degraded: false, model: "fixture", evidence: [],
      },
    },
  };
}

describe("G3 rendered fact alignment", () => {
  it("replaces only a uniquely attributable tire width and labels rights-safe vehicle styling", () => {
    const source = authority(), before = structuredClone(source);
    const report = [
      "缓解建议：按 G1 原文核对后使用后轮胎规格 180/70 ZR17。",
      "前轮胎仍为 120/70 ZR17；整车具有哑光车身高光。",
      "另一车型的 200/55 ZR17 不得被改写成当前商品事实。",
    ].join("\n");
    const actual = reconcileRenderedRequirementFacts(report, source);
    const correctedBody = actual.split("\n\n## 宿主事实边界校正")[0]!;
    expect(actual).toContain("后轮胎规格 180/60 ZR17");
    expect(correctedBody).not.toContain("180/70 ZR17");
    expect(actual).toContain("哑光车身（权利安全示意美术处理）");
    expect(actual).toContain("200/55 ZR17");
    expect(actual).toContain("## 宿主事实边界校正");
    expect(actual).toContain("轮胎规格 180/70 ZR17 → 180/60 ZR17");
    expect(actual).toContain(source.marketing.g1Artifact.sha256);
    expect(source).toEqual(before);
  });

  it("leaves already accepted values and unrelated reports byte-for-byte unchanged", () => {
    const report = "后轮胎规格 180/60 ZR17；前轮胎规格 120/70 ZR17。";
    expect(reconcileRenderedRequirementFacts(report, authority())).toBe(report);
  });
});
