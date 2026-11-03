import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeMarketingDossierPresentation } from "./marketing-dossier-normalization.js";

const require = createRequire(import.meta.url);
const { JennyLoomEngine } = require("../../../../vendor/supermickey/hyperreality-system/engines/data-mining-engine/index.js");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function assemble(points: string[], reviews: Array<Record<string, unknown>> = []) {
  const root = mkdtempSync(path.join(tmpdir(), "marketing-presentation-r2-"));
  roots.push(root);
  const engine = new JennyLoomEngine({ mode: "api", storeRoot: root });
  const product = { name: "MODEL-R2", category: "软件平台" };
  const source_url = "https://official.example.com/model";
  const result = engine.assemble(engine.plan(product).trace_id, product, {
    A1: {
      identity: {
        ...product,
        specs: { 部署: { value: "本地", source_url } },
        official_selling_points: points.map(point => ({ point, source_url })),
      },
      images: [],
    },
    A2: { reviews },
    A3: { competitors: [] },
  });
  expect(result.ok).toBe(true);
  return { result, product };
}

describe("marketing presentation evidence binding", () => {
  it("never counts an official claim as user consensus when A2 is empty", () => {
    const { result, product } = assemble(["本地部署"]);
    const normalized = normalizeMarketingDossierPresentation(result.dossier, result.cards, product, {
      hasReviewEvidence: false, hasCompetitorEvidence: false,
    });
    expect(normalized.cards.brief_card).toMatchObject({ evidence_note: expect.stringContaining("0 条可核实用户共识") });
    expect(normalized.cards.insight_card).toMatchObject({ consensus_points: [] });
    expect(result.cards.insight_card.consensus_points).toHaveLength(1);
  });

  it("keeps the actual A2 user observation separate from the official A1 claim", () => {
    const { result, product } = assemble(["本地部署"], [
      { text: "使用方便，安装完就能上手，挺满意", rating: 5, url: "https://example.com/review" },
    ]);
    const normalized = normalizeMarketingDossierPresentation(result.dossier, result.cards, product, {
      hasReviewEvidence: true, hasCompetitorEvidence: false,
    });
    expect(normalized.cards.brief_card).toMatchObject({ evidence_note: expect.stringContaining("1 条可核实用户共识") });
    expect(normalized.cards.insight_card).toMatchObject({
      consensus_points: [expect.objectContaining({ point: expect.stringContaining("用户认可") })],
    });
  });

  it("deduplicates display text without shifting the next claim's source pointer", () => {
    const { result, product } = assemble(["本地部署", "本地部署", "模块化架构"]);
    const normalized = normalizeMarketingDossierPresentation(result.dossier, result.cards, product, {
      hasReviewEvidence: false,
      sellingPointClaims: [
        { pointer: "/identity/official_selling_points/0/point", claimId: "CL-A0", sourceId: "SRC-A" },
        { pointer: "/identity/official_selling_points/1/point", claimId: "CL-A1", sourceId: "SRC-A-SECOND" },
        { pointer: "/identity/official_selling_points/2/point", claimId: "CL-B", sourceId: "SRC-B" },
      ],
    });
    expect(normalized.cards.brief_card).toMatchObject({ sellingPoints: ["本地部署", "模块化架构"] });
    expect(normalized.cards.prd_card).toMatchObject({
      selling_point_evidence: [
        expect.objectContaining({ point: "本地部署", claimId: "CL-A0", sourceId: "SRC-A" }),
        expect.objectContaining({ point: "模块化架构", claimId: "CL-B", sourceId: "SRC-B" }),
      ],
    });
  });

  it("withholds a vendor evidence id when only a different source is registered for the claim", () => {
    const { result, product } = assemble(["本地部署"]);
    const normalized = normalizeMarketingDossierPresentation(result.dossier, result.cards, product, {
      sellingPointClaims: [{
        pointer: "/identity/official_selling_points/0/point", claimId: "CL-A", sourceId: "SRC-A",
        sourceUrl: "https://primary.example.com/verified",
      }],
    });
    expect(normalized.cards.prd_card).toMatchObject({
      selling_point_evidence: [{
        point: "本地部署", claimId: "CL-A", sourceId: "SRC-A",
        sourceUrl: "https://primary.example.com/verified", evidenceId: null,
      }],
    });
  });
});
