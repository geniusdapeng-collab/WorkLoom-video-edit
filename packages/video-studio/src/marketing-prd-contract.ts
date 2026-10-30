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
const SUBTITLE_POLICY = "客户未明确要求字幕：不生成字幕轨或 SRT/VTT；屏上已审原文只作为画面图形层叠加，不属于字幕交付";
const FONT_POLICY = "屏上所有可读文字统一受最小字号屏高3%、文字与底色对比度4.5:1、平台安全区和遮挡检查约束；辅助文字与脚注不豁免";
const QUOTE_POLICY = "G1 原文核对按连续子串截取：只允许原字符、原顺序、原标点；不得补写、拼接或改写标点";
const VIDEO_TECHNICAL = `30fps；竖屏安全区按目标平台遮挡区在渲染前测量并留证；${FONT_POLICY}；${QUOTE_POLICY}`;

function normalizeText(value: string): string {
  const next = value
    .replace(/\bawarenes\b/giu, "awareness")
    .replace(/\blicense(?=\s*:\s*Apache-2\.0)/giu, "License")
    .replace(/\bLicense\s*[：:]\s*Apache-2\.0/giu, "License: Apache-2.0")
    .replace(/商业广告\s*\/\s*商业广告/gu, "商业广告")
    .replace(/剧情短片\s*\/\s*商业广告（[^）]*）/gu, "商业广告")
    .replace(/剧情短片\s*\/\s*商业广告/gu, "商业广告")
    .replace(/没有中心的系统最难被关掉/gu, "本片不推断系统韧性、安全或竞品差异")
    .replace(/把控制权从云里搬回本地/gu, "呈现官方原文中的 local control 与 privacy first 自述")
    .replace(/Local control\. Privacy first\. Apache-2\.0\./gu,
      "按本次 G1 已审连续原句逐字呈现，不拆句或改写标点")
    .replace(/三行原文/gu, "本次 G1 已审连续原文")
    .replace(/这些不是宣传语，是摘自[^。\n]*逐字原文/gu,
      "屏上只显示本次 G1 已审连续子串；归属只使用已审来源地址，不新增中文说明")
    .replace(/底部浮出极小号说明字幕/gu, "底部不显示额外中文说明")
    .replace(/底部一行极小号来源说明字幕/gu, "底部不显示额外中文说明字幕")
    .replace(/底部中文说明字幕自下而上淡入后保持不动[^,，。\n]*/gu,
      "屏上只保留官方仓库地址与 License: Apache-2.0 的连续原文，不显示中文说明字幕")
    .replace(/底部浮出一行极小号说明字幕“摘自[^”]+”/gu, "不显示任何额外中文说明字幕")
    .replace(/因为插槽还空着两格，必须看到它们被填满/gu,
      "按已审场景保留两格空位作为悬念")
    .replace(/并留下两格空位牵引下一步/gu, "并保留两格空位作为悬念")
    .replace(/可无限接驳/gu, "可继续扩展接入其他设备与动作")
    .replace(/极小脚注/gu, "达到统一最小字号下界的辅助脚注")
    .replace(/极小字号/gu, "达到统一字号下界的辅助文字")
    .replace(/字幕执行计划（客户未显式指定字幕，沿用已有任务，不加持续警示字幕、不加封面）/gu, "屏上原文执行计划（客户未显式指定字幕）")
    .replace(/所有屏幕文字为画面内烧录的等宽字体英文原文与来源标注，不另做 sidecar/gu,
      "所有屏上文字只作为画面图形层叠加的等宽字体英文原文与来源标注；不生成字幕轨或 sidecar")
    .replace(/烧录字幕核对/gu, "屏上原文图层核对")
    .replace(/烧录文字与台词/gu, "屏上原文图层与台词")
    .replace(/字幕内容与 G1 原文逐字符一致/gu, "屏上原文与 G1 原文连续子串逐字符一致并保留原标点")
    .replace(/单行字幕/gu, "单行屏上原文")
    .replace(/主字幕/gu, "主屏上原文")
    .replace(/小字内容须与 G1 原文完全一致/gu, "小字内容须为 G1 原文的连续子串并保留原标点")
    .replace(/字段文本须与 G1 原文完全一致/gu, "字段文本须为 G1 原文的连续子串并保留原标点")
    .replace(/文字须与 G1 原文一致/gu, "文字须为 G1 原文的连续子串并保留原标点")
    .replace(/字幕默认烧录已审画面文字[^；。\n]*/gu, SUBTITLE_POLICY)
    .replace(/字幕仅烧录已审画面文字[^；。\n]*/gu, SUBTITLE_POLICY)
    .replace(/(?<!https:\/\/)github\.com\//giu, "https://github.com/")
    .replace(/(https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s*·\s*README/gu, "$1")
    .replace(/屏幕上给出收束的一句：来源\s*(https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/gu,
      "屏幕上只连续显示 $1")
    .replace(/来源\s*(https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/gu, "$1")
    .replace(/README 首句逐字符浮现/gu,
      "G1 已审原句的明确连续半句逐字符浮现（不是全句完整呈现）")
    .replace(/这是全片唯一一次把文字说完整/gu,
      "这是全片唯一完整呈现两行官方自述原句的场景；其它场景只显示明确截取的半句、地址或许可字段")
    .replace(/本场景为全片唯一完整呈现文字的一段/gu,
      "本场景是全片唯一完整呈现两行官方自述原句的场景；其它场景只显示明确截取的半句、地址或许可字段")
    .replace(/全片唯一一次说完整的句子落地之后/gu, "官方自述原句在本场完整落地之后")
    .replace(/整屏仅\s*License:\s*Apache-2\.0\s*一处被点亮/gu,
      "整屏仅在 G1 连续子串 License: Apache-2.0 处点亮")
    .replace(/标签文字须与 G1 claim\s+[A-Za-z0-9-]+\s+原文 Apache-2\.0 一致/gu,
      "标签文字须与 G1 原文连续子串 License: Apache-2.0 一致")
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

function replaceRenderedStrings(value: unknown, pattern: RegExp, replacement: string): boolean {
  let changed = false;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index++) {
        const item = node[index];
        if (typeof item === "string") {
          const next = item.replace(pattern, replacement);
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
        const next = item.replace(pattern, replacement);
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

  const positioning = isRecord(prd.productPositioning) ? prd.productPositioning : {};
  for (const key of ["productType", "genre"] as const) {
    if (positioning[key] !== "商业广告") {
      positioning[key] = "商业广告";
      changes.push("marketing-production-type-normalized");
    }
  }
  const targetResolution = text(profile.resolution) || "4K";
  const targetFrameRate = Number(profile.frameRate) || 30;
  const targetDuration = Number(profile.targetDuration);
  const targetAspectRatio = text(profile.aspectRatio);
  const targetPlatform = text(profile.targetPlatform);
  if (Number.isFinite(targetDuration) && targetDuration > 0) positioning.targetDuration = targetDuration;
  if (targetAspectRatio) positioning.aspectRatio = targetAspectRatio;
  if (targetPlatform) positioning.targetPlatform = targetPlatform;
  if (positioning.resolution !== targetResolution) {
    positioning.resolution = targetResolution;
    changes.push("delivery-resolution-normalized");
  }
  if (positioning.frameRate !== targetFrameRate) {
    positioning.frameRate = targetFrameRate;
    changes.push("delivery-frame-rate-normalized");
  }
  prd.productPositioning = positioning;

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
    const technical = `技术交付口径：AAC 48 kHz 双声道，整体响度 -14 LUFS，True Peak ≤ -1 dBTP；${FONT_POLICY}；${QUOTE_POLICY}；${SUBTITLE_POLICY}。`;
    audio.soundDesign = `${design}${design ? "\n" : ""}${technical}`;
    changes.push("no-person-audio-subtitle-contract-normalized");
  }
  prd.audioSpecification = audio;

  const scenes = isRecord(prd.scenePlan) ? prd.scenePlan : {};
  for (const rawScene of list(scenes.scenes).filter(isRecord)) {
    const visualRequirements = textList(rawScene.visualRequirements);
    let normalized = visualRequirements.map((requirement) => {
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
    if (noPeople) {
      const screenText = /屏上文字|屏幕文字|文字层|来源行|来源角标|标题内容|副标题内容|License\s*[：:]|github\.com\/|Home Assistant/u;
      normalized = normalized.filter((requirement) => !screenText.test(requirement));
      normalized = [
        ...normalized.slice(0, 4),
        "屏上可见文字只允许从本次 G1 已审名称、官方卖点、许可证与仓库地址中取用，并由 G6 逐镜列明精确字符串；不生成字幕轨，不新增中文说明。",
      ];
    }
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
  let deliverables = list(delivery.deliverables).filter(isRecord);
  if (noPeople && deliverables.some((item) => item.item === "character_portraits")) {
    deliverables = deliverables.filter((item) => item.item !== "character_portraits");
    changes.push("no-person-deliverables-normalized");
  }
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
  const outputFormat = isRecord(delivery.outputFormat) ? delivery.outputFormat : {};
  outputFormat.resolution = targetResolution;
  outputFormat.frameRate = targetFrameRate;
  delivery.deliverables = deliverables;
  delivery.outputFormat = outputFormat;
  prd.deliveryStandard = delivery;

  if (normalizeGlobalStrings(prd)) changes.push("global-prd-contradictions-normalized");
  if (targetFrameRate !== 24 && replaceRenderedStrings(prd, /\b24fps\b/giu, `${targetFrameRate}fps`)) {
    changes.push("frame-rate-text-normalized");
  }
  if (targetResolution === "4K" && replaceRenderedStrings(prd, /\b1080p\b/giu, "4K")) {
    changes.push("resolution-text-normalized");
  }

  // Keep the scene authority hash consumers honest: this function never rewrites
  // scene IDs, durations, purposes or shotMapping.
  const authorityScenes = list(contract.scenes).filter(isRecord);
  const currentScenes = list(scenes.scenes).filter(isRecord);
  if (authorityScenes.length !== currentScenes.length) {
    throw new Error("MARKETING_PRD_SCENE_AUTHORITY_CHANGED：PRD 场景数量与已审 G3 合同不一致");
  }
  return { prd, applied: changes.length > 0, changes: [...new Set(changes)] };
}
