import { describe, expect, it } from "vitest";
import { customerRestrictionLines, normalizeMarketingDossierPresentation } from "./marketing-dossier-normalization.js";

describe("marketing dossier host presentation", () => {
  it("does not relabel verified software claims as zero evidence or a physical product", () => {
    const dossier = {
      identity: {
        name: "Home Assistant",
        category: "开源家庭自动化平台",
        official_selling_points: [
          { point: "本地控制和隐私优先", source_url: "https://github.com/home-assistant/core" },
          { point: "模块化架构", source_url: "https://github.com/home-assistant/core" },
        ],
      },
      visual_assets: {
        images: [
          { id: "IMG-1", url: "https://example.com/1.png", license_risk: "high" },
          { id: "IMG-2", url: "https://example.com/2.png", license_risk: "high" },
        ],
      },
      provenance: [
        { evidence_id: "EV-1", claim_ref: "identity.official_selling_points:本地控制和隐私优先" },
        { evidence_id: "EV-2", claim_ref: "identity.official_selling_points:模块化架构" },
      ],
      differentiation: { our_opening: ["把官方卖点当市场空白"] },
      gaps: ["[A2_MINE] 未挖到吐槽点（警惕样本偏倚：全是好评通常不真实）"],
    };
    const cards = {
      brief_card: {
        evidence_note: "卖点来自 0 条用户共识 + 0 条官方确认主张",
        sellingPoints: [],
      },
      router_material: { product_kind: "physical" },
      portrait_manifest: { needs_more_reference: false, reference_images: dossier.visual_assets.images },
      prd_card: { compliance_redlines: [] },
      theme_card: { differentiation_space: ["冒充竞品没讲的"], crowded_space: ["未核实"] },
      insight_card: { audience_profile: [], market_position: { our_opening: ["未核实"], crowded_points: ["未核实"] } },
    };
    const result = normalizeMarketingDossierPresentation(
      dossier,
      cards,
      { name: "Home Assistant", category: "开源家庭自动化平台" },
      {
        sellingPointClaims: [
          { pointer: "/identity/official_selling_points/0/point", claimId: "CL-1", sourceId: "SRC-1" },
          { pointer: "/identity/official_selling_points/1/point", claimId: "CL-2", sourceId: "SRC-1" },
        ],
      },
    );
    const normalizedCards = result.cards as any;
    const normalizedDossier = result.dossier as any;
    expect(normalizedCards.brief_card.sellingPoints).toEqual(["本地控制和隐私优先", "模块化架构"]);
    expect(normalizedCards.brief_card.evidence_note).toContain("2 条来源绑定官方主张");
    expect(normalizedCards.brief_card.evidence_note).toContain("0 条可核实用户共识");
    expect(normalizedCards.router_material).toMatchObject({ product_kind: "digital" });
    expect(normalizedCards.router_material.product_kind_basis).toContain("开源家庭自动化平台");
    expect(normalizedCards.portrait_manifest.needs_more_reference).toBe(true);
    expect(normalizedCards.prd_card.compliance_redlines.join(" ")).toContain("license_risk=high");
    expect(normalizedCards.prd_card.compliance_redlines.join(" ")).toContain("IMG-1");
    expect(normalizedCards.prd_card.selling_point_evidence).toEqual([
      expect.objectContaining({ point: "本地控制和隐私优先", claimId: "CL-1", evidenceId: "EV-1" }),
      expect.objectContaining({ point: "模块化架构", claimId: "CL-2", evidenceId: "EV-2" }),
    ]);
    expect(normalizedCards.portrait_manifest.handoff_note).toContain("未取得明确商用授权前禁止传播");
    expect(normalizedDossier.visual_assets.needs_more_reference).toBe(true);
    expect(normalizedDossier.differentiation.our_opening).toEqual([]);
    expect(normalizedDossier.gaps.join(" ")).not.toContain("全是好评");
    expect(normalizedCards.theme_card.differentiation_space).toEqual([]);
    expect(normalizedCards.insight_card.market_position.our_opening).toEqual([]);
    expect(normalizedDossier.gaps.join(" ")).toContain("受众");
    expect(result.changes.length).toBeGreaterThanOrEqual(5);
  });

  it("keeps a verified physical product classification", () => {
    const result = normalizeMarketingDossierPresentation(
      { identity: { name: "星野 F3", category: "家用空气净化器", official_selling_points: [] }, gaps: [] },
      { router_material: { product_kind: "digital" } },
      { name: "星野 F3", category: "家用空气净化器" },
    );
    expect((result.cards as any).router_material.product_kind).toBe("physical");
  });

  it("surfaces missing source images and customer redlines across dossier, PRD and theme", () => {
    const restrictions = customerRestrictionLines("全片无人，不展示未核实硬件或可运行效果，不声称用户评价、销量或竞品优势。");
    const result = normalizeMarketingDossierPresentation(
      { identity: { name: "Acme", official_selling_points: [] }, visual_assets: null, gaps: [] },
      {
        portrait_manifest: { handoff_note: "预填参考图，仅核对型号一致性", needs_more_reference: false, reference_images: [{}] },
        prd_card: {}, theme_card: {},
      },
      { name: "Acme", category: "软件平台" },
      { customerRestrictions: restrictions },
    );
    expect((result.dossier as any).restrictions).toEqual(restrictions);
    expect((result.dossier as any).visual_assets).toMatchObject({ images: [], needs_more_reference: true });
    expect((result.cards as any).portrait_manifest).toMatchObject({ hero_image_id: null, reference_images: [], needs_more_reference: true });
    expect((result.cards as any).portrait_manifest.handoff_note).toContain("不得生成或声称已有定妆照");
    expect((result.cards as any).prd_card.compliance_redlines).toEqual(restrictions);
    expect((result.cards as any).theme_card.avoid_pits).toEqual(restrictions);
  });
});
