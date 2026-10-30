type RecordValue = Record<string, unknown>;

const record = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

function classifyProductKind(product: RecordValue): { kind: "physical" | "digital" | null; basis: string } {
  const source = `${text(product.name)} ${text(product.category)}`;
  const digital = /平台|软件|应用|系统|服务|开源|SaaS|SDK|API|开发/i.test(source);
  const physical = /空气净化|家电|耳机|相机|手机|汽车|摩托|机器|设备|食品|饮料|鞋|服饰|家具|工具|玩具|净化器|充电器/i.test(source);
  if (digital && !physical) return { kind: "digital", basis: `品类“${text(product.category) || text(product.name)}”属于软件/平台/服务` };
  if (physical && !digital) return { kind: "physical", basis: `品类“${text(product.category) || text(product.name)}”属于实体商品` };
  return { kind: null, basis: "品类不足以可靠区分实体或数字商品，保留未判定" };
}

/**
 * Reconcile host-generated dossier presentation cards with the source-bound
 * claims already accepted by A1. This removes contradictory summary labels and
 * surfaces licensing/compliance limits without adding product facts.
 */
export function normalizeMarketingDossierPresentation(
  dossierValue: unknown,
  cardsValue: unknown,
  productValue: unknown,
  options: { hasReviewEvidence?: boolean; hasCompetitorEvidence?: boolean } = {},
): { dossier: RecordValue; cards: RecordValue; changes: string[] } {
  const dossier = structuredClone(record(dossierValue));
  const cards = structuredClone(record(cardsValue));
  const product = record(productValue);
  const identity = record(dossier.identity);
  const changes: string[] = [];

  const sellingPoints = [...new Set(list(identity.official_selling_points)
    .map((item) => text(record(item).point))
    .filter(Boolean))];
  const brief = record(cards.brief_card);
  if (JSON.stringify(brief.sellingPoints) !== JSON.stringify(sellingPoints)) {
    brief.sellingPoints = sellingPoints;
    changes.push("selling-point-summary-reconciled");
  }
  const userConsensus = list(record(cards.insight_card).consensus_points).length;
  const evidenceNote = `卖点来自 ${sellingPoints.length} 条来源绑定官方主张 + ${userConsensus} 条可核实用户共识；完整溯源见档案 ${text(dossier.product_id) || "(当前项目)"}`;
  if (brief.evidence_note !== evidenceNote) {
    brief.evidence_note = evidenceNote;
    changes.push("evidence-note-reconciled");
  }
  cards.brief_card = brief;

  const router = record(cards.router_material);
  const classification = classifyProductKind(product);
  if (router.product_kind !== classification.kind) changes.push("product-kind-reconciled");
  router.product_kind = classification.kind;
  router.product_kind_basis = classification.basis;
  cards.router_material = router;

  const visual = record(dossier.visual_assets);
  const images = list(visual.images).map(record);
  const highRisk = images.filter((image) => text(image.license_risk) === "high");
  const portrait = record(cards.portrait_manifest);
  if (highRisk.length > 0) {
    portrait.needs_more_reference = true;
    const prdCard = record(cards.prd_card);
    const redlines = list(prdCard.compliance_redlines).map(text).filter(Boolean);
    const ids = highRisk.map((image) => text(image.id)).filter(Boolean);
    const line = `来源档案 visual_assets.images[].license_risk=high（${ids.join("、") || `${highRisk.length} 张`}）；未取得明确商用授权前禁止传播，必须替换或补充授权证据`;
    if (!redlines.includes(line)) {
      redlines.push(line);
      prdCard.compliance_redlines = redlines;
      cards.prd_card = prdCard;
      changes.push("image-license-redline-added");
    }
  }
  cards.portrait_manifest = portrait;

  if (!options.hasCompetitorEvidence) {
    const theme = record(cards.theme_card);
    if (list(theme.differentiation_space).length > 0 || list(theme.crowded_space).length > 0) {
      theme.differentiation_space = [];
      theme.crowded_space = [];
      cards.theme_card = theme;
      changes.push("unsupported-differentiation-claims-removed");
    }
    const market = record(record(cards.insight_card).market_position);
    if (list(market.our_opening).length > 0 || list(market.crowded_points).length > 0) {
      market.our_opening = [];
      market.crowded_points = [];
      const insight = record(cards.insight_card);
      insight.market_position = market;
      cards.insight_card = insight;
      changes.push("unsupported-market-position-removed");
    }
  }

  const insight = record(cards.insight_card);
  if (list(insight.audience_profile).length === 0) {
    const gaps = list(dossier.gaps).map(text).filter(Boolean);
    const gap = "未采集到可核实受众画像；只能使用客户 Brief 原文或标注为创作假设，不能冒充市场事实";
    if (!gaps.includes(gap)) {
      gaps.push(gap);
      dossier.gaps = gaps;
      changes.push("audience-gap-recorded");
    }
  }
  cards.insight_card = insight;
  return { dossier, cards, changes: [...new Set(changes)] };
}
