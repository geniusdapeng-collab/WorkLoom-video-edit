import { describe, expect, it } from "vitest";
import { normalizeMarketingDossierPresentation } from "./marketing-dossier-normalization.js";

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
      provenance: [{ evidence_id: "EV-1" }],
      gaps: [],
    };
    const cards = {
      brief_card: {
        evidence_note: "卖点来自 0 条用户共识 + 0 条官方确认主张",
        sellingPoints: [],
      },
      router_material: { product_kind: "physical" },
      portrait_manifest: { needs_more_reference: false, reference_images: dossier.visual_assets.images },
      prd_card: { compliance_redlines: [] },
      insight_card: { audience_profile: [] },
    };
    const result = normalizeMarketingDossierPresentation(
      dossier,
      cards,
      { name: "Home Assistant", category: "开源家庭自动化平台" },
    );
    const normalizedCards = result.cards as any;
    const normalizedDossier = result.dossier as any;
    expect(normalizedCards.brief_card.sellingPoints).toEqual(["本地控制和隐私优先", "模块化架构"]);
    expect(normalizedCards.brief_card.evidence_note).toContain("2 条来源绑定官方主张");
    expect(normalizedCards.brief_card.evidence_note).toContain("0 条可核实用户共识");
    expect(normalizedCards.router_material).toMatchObject({ product_kind: "digital" });
    expect(normalizedCards.router_material.product_kind_basis).toContain("开源家庭自动化平台");
    expect(normalizedCards.portrait_manifest.needs_more_reference).toBe(true);
    expect(normalizedCards.prd_card.compliance_redlines.join(" ")).toContain("许可风险");
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
});
