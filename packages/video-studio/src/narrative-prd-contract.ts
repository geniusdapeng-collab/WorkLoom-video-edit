type RecordValue = Record<string, unknown>;

export interface NarrativePrdNormalization<T extends RecordValue = RecordValue> {
  prd: T;
  applied: boolean;
  changes: string[];
}

const isRecord = (value: unknown): value is RecordValue =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

function platformLabel(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  return ({
    douyin: "抖音",
    tiktok: "TikTok",
    xiaohongshu: "小红书",
    bilibili: "B站",
    shipinhao: "视频号",
    wechat_channels: "视频号",
    youtube: "YouTube",
    instagram: "Instagram",
  } as Record<string, string>)[raw.toLowerCase()] ?? raw;
}

function exactCharacters(metadata: RecordValue): RecordValue[] {
  const selected = list(metadata.characters).filter(isRecord);
  return selected.map((character, index) => {
    const id = text(character.id) || text(character.character_id);
    const name = text(character.name) || id;
    const identity = isRecord(character.identity) ? character.identity : {};
    const appearance = isRecord(character.appearance) ? character.appearance : {};
    const persona = isRecord(character.persona) ? character.persona : {};
    const wardrobe = list(character.wardrobe).filter(isRecord);
    const activeWardrobeId = text(character.activeWardrobeId) || text(character.wardrobeId);
    const activeWardrobe = wardrobe.find((entry) => text(entry.id) === activeWardrobeId);
    const costume = activeWardrobe ? text(activeWardrobe.detail) || text(activeWardrobe.name) : "";
    const appearanceParts = [
      text(identity.gender),
      text(identity.age),
      text(appearance.face),
      text(appearance.skin),
      text(appearance.eyes),
      text(appearance.hair),
      text(appearance.bodyType),
      ...list(appearance.features).map(text),
    ].filter(Boolean);
    const personalityParts = [
      text(persona.archetype),
      text(persona.tone),
      ...list(persona.coreTraits).map(text),
    ].filter(Boolean);
    const continuity = list(character.continuityRules).map(text).filter(Boolean);
    if (costume) continuity.push(`服装仅使用当前激活版本 ${activeWardrobeId || "(未编号)"}，不得改写`);
    return {
      characterId: id,
      character_id: id,
      name,
      role: text(character.role) || (index === 0 ? "protagonist" : "supporting"),
      ageRange: text(identity.age) || "按人物档案",
      appearance: appearanceParts.join("；") || "按人物档案",
      personality: personalityParts.join("；") || "按人物档案",
      costume: costume || "按人物档案当前激活服装",
      consistencyRequirements: [...new Set(continuity)].join("；") || "必须保持人物档案中的身份、外貌与服装版本",
      profilePath: text(character.builtinCharacterSource && isRecord(character.builtinCharacterSource)
        ? character.builtinCharacterSource.profilePath
        : undefined),
      profileSha256: text(character.builtinCharacterSource && isRecord(character.builtinCharacterSource)
        ? character.builtinCharacterSource.profileSha256
        : undefined),
    };
  });
}

function contractScenes(metadata: RecordValue): RecordValue[] {
  const contract = isRecord(metadata._workloomRequirementContract) ? metadata._workloomRequirementContract : undefined;
  return list(contract?.scenes).filter(isRecord);
}

function stripUnrequestedSubtitleClauses(value: unknown): string {
  const original = text(value);
  if (!original) return "";
  return original
    .split(/(?<=[。；;\n])/u)
    .filter((part) => !part.includes("字幕"))
    .join("")
    .trim();
}

function stripSubtitleArray(value: unknown): string[] {
  return list(value)
    .map(stripUnrequestedSubtitleClauses)
    .filter(Boolean);
}

function maxMetric(a: unknown, b: unknown): number {
  const left = typeof a === "number" && Number.isFinite(a) ? a : 0;
  const right = typeof b === "number" && Number.isFinite(b) ? b : 0;
  return Math.max(left, right);
}

/**
 * Narrative preproduction has a separate cast authority and an approved G3
 * scene contract, but the native PRD generator also receives creative-control
 * context and can invent a second actor, alternate wardrobe, extra scenes and
 * conflicting delivery thresholds. Normalize those hard production facts while
 * preserving the model's creative treatment.
 */
export function normalizeNarrativePrdContract(
  prdValue: RecordValue,
  metadataValue: unknown,
): NarrativePrdNormalization {
  const route = isRecord(metadataValue) && isRecord(metadataValue.pipelineRoute)
    ? metadataValue.pipelineRoute
    : undefined;
  if (!isRecord(metadataValue) || route?.kind !== "narrative") {
    return { prd: prdValue, applied: false, changes: [] };
  }

  const prd: RecordValue = structuredClone(prdValue);
  const metadata = metadataValue;
  const brief = isRecord(metadata.brief) ? metadata.brief : {};
  const changes: string[] = [];

  const characters = exactCharacters(metadata);
  const characterSystem = isRecord(prd.characterSystem) ? prd.characterSystem : {};
  const previousCharacters = list(characterSystem.characters).filter(isRecord);
  if (JSON.stringify(previousCharacters) !== JSON.stringify(characters)) {
    changes.push("cast-and-wardrobe-normalized");
  }
  prd.characterSystem = { ...characterSystem, characters };

  const positioning = isRecord(prd.productPositioning) ? prd.productPositioning : {};
  const duration = Number(brief.duration);
  if (Number.isFinite(duration) && duration > 0) positioning.targetDuration = duration;
  if (typeof brief.aspectRatio === "string" && brief.aspectRatio.trim()) {
    positioning.aspectRatio = brief.aspectRatio.trim();
  }
  const platform = platformLabel(brief.platform);
  if (platform) positioning.targetPlatform = platform;
  prd.productPositioning = positioning;

  const scenes = contractScenes(metadata);
  if (scenes.length) {
    const scenePlan = isRecord(prd.scenePlan) ? prd.scenePlan : {};
    const previousScenes = list(scenePlan.scenes).filter(isRecord);
    const previousMapping = list(scenePlan.shotMapping).filter(isRecord);
    const normalizedScenes = scenes.map((scene, index) => {
      const previous = previousScenes.find((entry) => text(entry.sceneId) === text(scene.id)) ?? previousScenes[index] ?? {};
      const keyElements = list(scene.keyElements).map(text).filter(Boolean);
      const props = list(scene.props).filter(isRecord);
      const actions = list(scene.actions).filter(isRecord);
      return {
        ...previous,
        sceneId: text(scene.id),
        sequence: index + 1,
        duration: Number(scene.duration),
        purpose: text(scene.purpose),
        setting: keyElements.join("；"),
        keyProps: props.map((prop) => text(prop.name)).filter(Boolean),
        visualRequirements: [
          ...keyElements,
          ...actions.map((action) => text(action.description)).filter(Boolean),
        ],
        source: text(scene.source),
        contractProps: structuredClone(props),
        contractActions: structuredClone(actions),
      };
    });
    const mapping = scenes.map((scene, index) => {
      const previous = previousMapping.find((entry) => text(entry.sceneId) === text(scene.id)) ?? previousMapping[index] ?? {};
      return { ...previous, sceneId: text(scene.id) };
    });
    if (JSON.stringify(previousScenes) !== JSON.stringify(normalizedScenes)
      || JSON.stringify(scenePlan.shotMapping) !== JSON.stringify(mapping)) {
      changes.push("scene-contract-normalized");
    }
    prd.scenePlan = { ...scenePlan, scenes: normalizedScenes, shotMapping: mapping };
    const creative = isRecord(prd.creativeCore) ? prd.creativeCore : {};
    const first = normalizedScenes[0]!;
    const firstActions = list(first.contractActions).filter(isRecord).map((action) => text(action.description)).filter(Boolean);
    creative.creativeHook = [first.purpose, firstActions[0]].filter(Boolean).join("；");
    const timing = normalizedScenes.map((scene) => `${scene.sceneId} ${scene.duration}s`).join("＋");
    creative.keyMessages = list(creative.keyMessages).map((message) => {
      const value = text(message);
      return /(?:\d+\s*(?:s|秒)).*(?:opening|scene-?\d+|ending)/i.test(value)
        ? `[时间锁定] ${timing}`
        : value;
    }).filter(Boolean);
    prd.creativeCore = creative;
    changes.push("scene-contract-normalized");
  }

  const visual = isRecord(prd.visualSpecification) ? prd.visualSpecification : {};
  const cameraLanguage = text(visual.cameraLanguage);
  if (cameraLanguage) {
    const cleaned = cameraLanguage
      .replace(/(?:^|[，,；;])\s*\d+\s*秒内[^，,；;。]*/gu, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    const normalized = cleaned || "分镜数量由正式分镜卡按叙事与模型能力决定";
    if (normalized && normalized !== cameraLanguage) {
      visual.cameraLanguage = normalized;
      changes.push("unspecified-shot-capacity-removed");
    }
  }
  prd.visualSpecification = visual;

  const explicitSubtitleRequest = /字幕|旁挂|烧录|subtitle/i.test(text(metadata.customerOriginalIntent))
    || isRecord(brief.productionRequirements);
  const deliveryForSubtitle = isRecord(prd.deliveryStandard) ? prd.deliveryStandard : {};
  const deliverables = list(deliveryForSubtitle.deliverables).filter(isRecord);
  if (!explicitSubtitleRequest && !deliverables.some((item) => /subtitle/i.test(text(item.item)))) {
    const subtitleMode = isRecord(brief.productionRequirements)
      ? text(brief.productionRequirements.subtitleMode)
      : "";
    deliverables.push({
      item: "subtitle_policy",
      priority: "required",
      spec: subtitleMode
        ? `subtitleMode=${subtitleMode}`
        : "系统默认：成片烧录中文台词字幕；关闭平台自动字幕；未请求的SRT/VTT不作为交付物",
    });
    deliveryForSubtitle.deliverables = deliverables;
    changes.push("subtitle-delivery-policy-explicit");
  }
  prd.deliveryStandard = deliveryForSubtitle;
  if (!explicitSubtitleRequest) {
    const creative = isRecord(prd.creativeCore) ? prd.creativeCore : {};
    creative.keyMessages = stripSubtitleArray(creative.keyMessages);
    prd.creativeCore = creative;
    const constraints = isRecord(prd.productionConstraints) ? prd.productionConstraints : {};
    constraints.technicalConstraints = stripSubtitleArray(constraints.technicalConstraints);
    constraints.businessConstraints = stripSubtitleArray(constraints.businessConstraints);
    constraints.forbiddenElements = stripSubtitleArray(constraints.forbiddenElements);
    prd.productionConstraints = constraints;
    changes.push("unrequested-subtitle-hard-rules-removed");
  }

  const productionConstraints = isRecord(prd.productionConstraints) ? prd.productionConstraints : {};
  const delivery = isRecord(prd.deliveryStandard) ? prd.deliveryStandard : {};
  const quality = isRecord(productionConstraints.qualityThresholds) ? productionConstraints.qualityThresholds : {};
  const acceptance = isRecord(delivery.acceptanceCriteria) ? delivery.acceptanceCriteria : {};
  const consistentThresholds = {
    ...quality,
    visual: maxMetric(quality.visual, acceptance.visual),
    audio: maxMetric(quality.audio, acceptance.audio),
    narrative: maxMetric(quality.narrative, acceptance.narrative),
    consistency: maxMetric(quality.consistency, acceptance.consistency),
  };
  if (JSON.stringify(quality) !== JSON.stringify(consistentThresholds)
    || JSON.stringify(acceptance) !== JSON.stringify(consistentThresholds)) {
    changes.push("quality-thresholds-unified");
  }
  productionConstraints.qualityThresholds = consistentThresholds;
  delivery.acceptanceCriteria = structuredClone(consistentThresholds);
  const fallbackPlan = isRecord(delivery.fallbackPlan) ? delivery.fallbackPlan : {};
  fallbackPlan.trigger = `任一质量指标低于统一阈值：视觉 ${consistentThresholds.visual} / 音频 ${consistentThresholds.audio} / 叙事 ${consistentThresholds.narrative} / 一致性 ${consistentThresholds.consistency}`;
  delivery.fallbackPlan = fallbackPlan;
  prd.productionConstraints = productionConstraints;
  prd.deliveryStandard = delivery;

  if (characters.length === 0) {
    const updatedDeliverables = list(delivery.deliverables).filter(isRecord)
      .filter((item) => text(item.item) !== "character_portraits");
    if (!updatedDeliverables.some((item) => text(item.item) === "environment_keyframes")) {
      updatedDeliverables.push({
        item: "environment_keyframes",
        priority: "required",
        spec: "本次无人场景的固定高光/水面/材质关键帧；不生成人物定妆照",
      });
    }
    delivery.deliverables = updatedDeliverables;
    changes.push("no-person-delivery-normalized");
  }

  prd._workloomNarrativeContractNormalization = {
    schemaVersion: "workloom.narrative-prd-normalization/v1",
    applied: true,
    changes: [...new Set(changes)],
    castMode: isRecord(metadata.builtinCharacterSelection) ? metadata.builtinCharacterSelection.mode : undefined,
    sceneContractSource: "/metadata/_workloomRequirementContract",
    authority: "host-selected-cast-and-approved-g3-scenes",
  };
  return { prd, applied: true, changes: [...new Set(changes)] };
}
