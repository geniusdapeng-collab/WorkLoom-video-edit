import { describe, expect, it } from "vitest";
import {
  reconcileRequirementThemeDraft, requirementThemeApprovalPayload,
} from "./requirement-authority.js";
import type { PrdAuthority } from "./prd-authority.js";

function authority(): PrdAuthority {
  return {
    metadata: {
      customerOriginalIntent: "客户原文保留：最后弯第二位，但剧情以连超两台夺冠。",
      brief: { duration: 30, product: "合成商品" },
    },
    profile: { targetDuration: 30 },
    marketing: {
      schemaVersion: "workloom.prd-marketing-authority/v1",
      scope: { tenantId: "t", workspaceId: "w", projectId: "p", runId: "r", attempt: 1 },
      g1Artifact: { path: "/fixture/G1_DOSSIER.md", sha256: "b".repeat(64), content: "{}" },
      g1Proof: {
        gate: "G1_DOSSIER", approved: true, status: "passed", via: "llm",
        degraded: false, model: "fixture", evidence: [],
      },
    },
  };
}

describe("G2 review fact alignment", () => {
  it("turns a second-place/two-pass contradiction into the consistent third-place premise", () => {
    const draft = "最后一个弯前还在第二位；外线出弯连超两台，冲线夺冠。";
    const actual = requirementThemeApprovalPayload(authority(), draft);
    expect(actual).toContain("最后一个弯前还在第三位；外线出弯连超两台，冲线夺冠。");
    expect(actual).toContain("宿主赛位一致性校正");
    // The frozen customer attachment remains byte-for-byte faithful to its source.
    expect(actual).toContain("客户原文保留：最后弯第二位，但剧情以连超两台夺冠。");
  });

  it("leaves a one-pass second-place premise and unrelated drafts unchanged", () => {
    const draft = "最后一个弯前还在第二位；外线出弯超越一台，冲线夺冠。";
    expect(reconcileRequirementThemeDraft(draft)).toBe(draft);
    expect(reconcileRequirementThemeDraft("完成三台车的外线连续超越。"))
      .toBe("完成三台车的外线连续超越。");
  });

  it("reconciles a draft that says the outside line is blocked and then immediately claims outside passes", () => {
    const draft = "她在最后一弯外线被封，仍连超对手，冲线夺冠。";
    const actual = reconcileRequirementThemeDraft(draft);
    expect(actual).toContain("她在最后一弯从外线出弯连超对手，冲线夺冠。");
    expect(actual).toContain("宿主外线约束校正");
  });
});
