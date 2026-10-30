type RecordValue = Record<string, unknown>;

export interface MarketingPrdNormalization {
  prd: RecordValue;
  applied: boolean;
  changes: string[];
}

const isRecord = (value: unknown): value is RecordValue =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const textList = (value: unknown): string[] => list(value).map(text).filter(Boolean);

const BODY_REFERENCE = /手指|手部|手掌|脸部|人体局部|人物动作|人影|转身|蹲下/u;
const UNREQUESTED_TIME = /第\s*\d+(?:\.\d+)?\s*秒|scene[-\s]?\d+/iu;
const UNSUPPORTED_MODULE_COUNT = /(?:九|9)\s*(?:个|块|组)?\s*(?:空心)?(?:方块|模块|节点)/u;
const SUBTITLE_POLICY = "客户未明确要求字幕：默认不烧录、不生成 SRT/VTT；屏上已审原文属于画面内容，不属于字幕交付";
const VIDEO_TECHNICAL = "30fps；竖屏安全区按目标平台遮挡区在渲染前测量并留证";

function normalizeText(value: string): string {
  const next = value
    .replace(/\bawarenes\b/giu, "awareness")
    .replace(/商业广告\s*\/\s*商业广告/gu, "商业广告")
    .replace(/字幕默认烧录已审画面文字[^；。\n]*/gu, SUBTITLE_POLICY)
    .replace(/字幕仅烧录已审画面文字[^；。\n]*/gu, SUBTITLE_POLICY)
    .replace(/(?<!https:\/\/)github\.com\//giu, "https://github.com/")
    .replace(/全片仅此一个视觉落点/gu, "只在对应已审场景内使用视觉强调，不作全片唯一性承诺")
    .replace(/收束字幕条|底部字幕条|来源限定字幕条/gu, (value) =>
      value.startsWith("收束") ? "收束屏上原文行" : value.startsWith("来源") ? "来源限定屏上文字行" : "底部屏上原文行")
    .replace(/一行\s*README\s*原文[，,]\s*对抗满屏形容词/gu, "一行 README 原文，作为可核对依据")
    .replace(/(?:小号)?标注\s*[「“]?integration[」”]?/giu, "不显示未入 G1 的文字标签")
    .replace(/数百个(?=\s*(?:冷白|等大|点阵|光点))/gu, "一组数量未示意的")
    .replace(/数百个/gu, "一组数量未示意的")
    .replace(/全片文字层仅来自\s*G1\s*原文/giu, "屏上文字只使用本次 G1 可核实原文或其明确截取，并标注完整行或截取范围")
    .replace(/与\s*G1\s*原文逐字一致/giu, "与本次 G1 原文或其明确截取一致，并标注完整行或截取范围")
    .replace(/已审场景节点/gu, "创作假设（未审）；实际执行以已审 G3 场景为准");
  return /^无字幕依赖[：:]/u.test(next)
    ? "不依赖口播或对白字幕；关键信息由已审屏上原文和图形结构共同承载，屏上原文不属于字幕交付"
    : next;
}

function normalizeGlobalStrings(value: unknown): boolean {
  let changed = false;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index++) {
        const item = node[index];
        if (typeof item === "string") {
          const next = normalizeText(item);
          if (next !== item) {
            node[index] = next;
            changed = true;
          }
        } else {
          walk(item);
        }
      }
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, item] of Object.entries(node)) {
      if (typeof item === "string") {
        const next = normalizeText(item);
        if (next !== item) {
          node[key] = next;
          changed = true;
        }
      } else {
        walk(item);
      }
    }
  };
  walk(value);
  return changed;
}

function dimensions(resolution: string, aspect: string): string {
  const width = resolution === "4K" ? 3840 : 1920;
  if (aspect === "9:16") return `${Math.round(width * 9 / 16)}x${width}`;
  if (aspect === "1:1") return `${width}x${width}`;
  if (aspect === "4:3") return `${Math.round(width * 4 / 3)}x${width}`;
  return `${width}x${Math.round(width * 9 / 16)}`;
}

function truncated(value: string): boolean {
  const opens = (value.match(/[「“（(]/gu) ?? []).length;
  const closes = (value.match(/[」”）)]/gu) ?? []).length;
  return opens !== closes || /(?:…|\.\.\.)$/u.test(value) || /(?:删除|标注「)$/u.test(value);
}

function noPerson(value: RecordValue): boolean {
  const selection = isRecord(value.builtinCharacterSelection) ? value.builtinCharacterSelection : {};
  return text(selection.mode) === "none" || value.hasPerson === false || value.noCharacters === true;
}

/**
 * Marketing PRD models can add external works, human body language, invented
 * object counts, second timelines and incomplete delivery numbers even after G1
 * and G3 were approved. Normalize only host-authoritative production facts while
 * keeping the model's approved scene purposes and visual subject matter.
 */
export function normalizeMarketingPrdContract(
  prdValue: RecordValue,
  metadataValue: unknown,
  profileValue: unknown,
  contractValue: unknown,
): MarketingPrdNormalization {
  if (!isRecord(metadataValue)) return { prd: prdValue, applied: false, changes: [] };
  const prd = structuredClone(prdValue);
  const metadata = metadataValue;
  const profile = isRecord(profileValue) ? profileValue : {};
  const contract = isRecord(contractValue) ? contractValue : {};
  const intent = text(metadata.customerOriginalIntent);
  const noPeople = noPerson(metadata);
  const changes: string[] = [];

  const visual = isRecord(prd.visualSpecification) ? prd.visualSpecification : {};
  visual.visualReferences = [
    "本次已审 G3 场景的画面目的、关键元素与用户 Brief；不引用未获客户提供的外部影片、导演或品牌案例",
  ];
  if (noPeople) {
    const camera = text(visual.cameraLanguage);
    if (!camera || BODY_REFERENCE.test(camera)) {
      visual.cameraLanguage = "围绕已审抽象界面、代码块、材质与示意图使用固定或缓慢运动镜头；不出现人物、人体局部或人物动作";
      changes.push("no-person-camera-normalized");
    }
  }
  prd.visualSpecification = visual;

  const references = isRecord(prd.referenceCases) ? prd.referenceCases : {};
  references.filmReferences = ["客户未指定外部影片；只使用已审 G3 场景和视觉规格"];
  references.adReferences = [];
  references.styleReferences = ["由本次 G3 场景、G1 来源事实和客户 Brief 形成的通用视觉系统"];
  prd.referenceCases = references;
  changes.push("external-reference-cases-removed");

  const creative = isRecord(prd.creativeCore) ? prd.creativeCore : {};
  const hook = text(creative.creativeHook);
  if (noPeople && (!hook || BODY_REFERENCE.test(hook))) {
    creative.creativeHook = "以抽象界面、代码块、材质和示意图建立冷峻、精确的首屏视觉钩子；不出现人物、人体局部或人物动作";
    changes.push("no-person-hook-normalized");
  }
  const messages = textList(creative.keyMessages);
  const normalizedMessages = messages.map((message) =>
    UNREQUESTED_TIME.test(message) || /落点/u.test(message)
      ? "使用本次 G1 已审官方主张；具体落点、时长和场景以已审 G3 合同为唯一时间轴"
      : message);
  creative.keyMessages = normalizedMessages.length ? normalizedMessages : ["使用本次 G1 已审官方主张，不扩展事实用途"];
  if (JSON.stringify(creative.keyMessages) !== JSON.stringify(messages)) changes.push("message-timeline-authority-normalized");
  if (UNREQUESTED_TIME.test(text(creative.twistPoint))) {
    creative.twistPoint = "结尾在已审 ending 场景内收束；不新增第二套场景、时间点或事实结论";
    changes.push("twist-timeline-authority-normalized");
  }
  prd.creativeCore = creative;

  const audio = isRecord(prd.audioSpecification) ? prd.audioSpecification : {};
  if (noPeople) {
    audio.voicePolicy = "无对白";
    audio.musicStyle = "无人声、低频音床、材质提示音与机械节奏；无旋律配乐";
    const design = text(audio.soundDesign);
    const technical = `技术交付口径：AAC 48 kHz 双声道，整体响度 -14 LUFS，True Peak ≤ -1 dBTP；${SUBTITLE_POLICY}。`;
    audio.soundDesign = `${design}${design ? "\n" : ""}${technical}`;
    changes.push("no-person-audio-subtitle-contract-normalized");
  }
  prd.audioSpecification = audio;

  const scenes = isRecord(prd.scenePlan) ? prd.scenePlan : {};
  for (const rawScene of list(scenes.scenes).filter(isRecord)) {
    const visualRequirements = textList(rawScene.visualRequirements);
    const normalized = visualRequirements.map((requirement) => {
      let next = requirement;
      if (!intent.includes("九") && UNSUPPORTED_MODULE_COUNT.test(next)) next = next.replace(UNSUPPORTED_MODULE_COUNT, "若干空心方块");
      if (/任何一帧.*来源|来源.*任何一帧/u.test(next)) {
        next = "来源标识只按本场明确列出的位置出现；未列出时不声称每一帧都能独立自证出处";
      }
      if (noPeople && BODY_REFERENCE.test(next)) {
        next = "全片无人：不出现人物、人体局部或人物动作；只保留已审抽象视觉元素";
      }
      return next;
    });
    if (JSON.stringify(normalized) !== JSON.stringify(visualRequirements)) {
      rawScene.visualRequirements = normalized;
      changes.push("scene-visual-contract-normalized");
    }
  }
  prd.scenePlan = scenes;

  const constraints = isRecord(prd.productionConstraints) ? prd.productionConstraints : {};
  const sanitizeConstraints = (items: unknown[], controlled: string): string[] => {
    const values = textList(items).filter((item) => !truncated(item)).map((item) =>
      /HOME-HERO-001|HOME-REF-002/u.test(item) && /调用|license_risk/u.test(item)
        ? "HOME-HERO-001/HOME-REF-002 的 license_risk=high；未取得明确商用授权前禁止调用、传播或出图，必须替换或补充授权证据"
        : /语义锚点|设备轮廓/u.test(item)
          ? "官方英文原文只以原文或明确节选出现并标注官方来源；不为无依据设备添加实物锚点，不延伸为性能或运行效果"
          : noPeople && BODY_REFERENCE.test(item)
            ? "全片无人：不出现人物、人体局部或人物动作"
            : item);
    return values.length ? values : [controlled];
  };
  constraints.technicalConstraints = sanitizeConstraints(list(constraints.technicalConstraints), "按已审 G3 场景和交付 profile 执行");
  constraints.businessConstraints = sanitizeConstraints(list(constraints.businessConstraints), "遵守 G1 用途限制和客户 Brief");
  constraints.forbiddenElements = sanitizeConstraints(list(constraints.forbiddenElements), "不新增客户未要求的人物、外部作品或未核实事实");
  const profileRules = [
    `输出画布 ${dimensions(text(profile.resolution) || "4K", text(profile.aspectRatio) || "9:16")}，时长 ${String(profile.targetDuration ?? "按已审场景")} 秒，时长帧容差 ${String(profile.durationToleranceFrames ?? 1)} 帧；${VIDEO_TECHNICAL}`,
    "AAC 48 kHz 双声道；整体响度 -14 LUFS；True Peak ≤ -1 dBTP",
    SUBTITLE_POLICY,
    "G1 已接受原文只作官方来源自述，不延伸为性能、安全、兼容性或运行效果承诺；来源中未经 claim 绑定的其他名称不得成为画面事实",
  ];
  constraints.technicalConstraints = [
    ...new Set([...textList(constraints.technicalConstraints).slice(0, 1), ...profileRules]),
  ].slice(0, 5);
  prd.productionConstraints = constraints;

  const audience = isRecord(prd.audienceProfile) ? prd.audienceProfile : {};
  audience.emotionTriggers = textList(audience.emotionTriggers).map((trigger) => {
    let next = UNREQUESTED_TIME.test(trigger) ? trigger.replace(UNREQUESTED_TIME, "已审场景节点") : trigger;
    if (noPeople && BODY_REFERENCE.test(next)) next = "观众通过抽象界面、结构与声音节奏感到精密可信；不生成人物或人体画面";
    return next;
  });
  prd.audienceProfile = audience;

  const delivery = isRecord(prd.deliveryStandard) ? prd.deliveryStandard : {};
  const deliverables = list(delivery.deliverables).filter(isRecord);
  const master = deliverables.find((item) => item.item === "video_master");
  if (master) {
    const dimensionsValue = dimensions(text(profile.resolution) || "4K", text(profile.aspectRatio) || "9:16");
    const spec = text(master.spec);
    const technical = `画布 ${dimensionsValue}；时长 ${String(profile.targetDuration ?? "按已审场景")} 秒 ±${String(profile.durationToleranceFrames ?? 1)} 帧；AAC 48 kHz 双声道；-14 LUFS / -1 dBTP；${VIDEO_TECHNICAL}；${SUBTITLE_POLICY}`;
    if (!spec.includes("-14 LUFS") || !spec.includes(dimensionsValue) || !spec.includes("30fps") || !spec.includes("安全区")) {
      master.spec = [spec, technical].filter(Boolean).join("；");
      changes.push("delivery-technical-baseline-normalized");
    }
  }
  prd.deliveryStandard = delivery;

  if (normalizeGlobalStrings(prd)) changes.push("global-prd-contradictions-normalized");

  // Keep the scene authority hash consumers honest: this function never rewrites
  // scene IDs, durations, purposes or shotMapping.
  const authorityScenes = list(contract.scenes).filter(isRecord);
  const currentScenes = list(scenes.scenes).filter(isRecord);
  if (authorityScenes.length !== currentScenes.length) {
    throw new Error("MARKETING_PRD_SCENE_AUTHORITY_CHANGED：PRD 场景数量与已审 G3 合同不一致");
  }
  return { prd, applied: changes.length > 0, changes: [...new Set(changes)] };
}
