/**
 * edit/intent.ts —— 创作意图推断（"用户啥都不说"时的默认拍板）。
 *
 * 目标体验：素材丢进来 → 系统给出**建议平台 / 时长带 / 节奏档案 / 选题候选 / 受众与情绪目标**，
 * 让人审只需要"选一个/改一处"，而不是从零填四问。
 *
 * 纪律：
 *   · 全部结论带 basis（为什么这么建议）与 evidence（来自哪几镜/哪段时间码）；
 *   · 推断只读素材事实（画幅/时长/语音/画面文字/实体/场景类型），不编造素材里没有的东西；
 *   · 这是**默认值**不是硬闸：显式传入的 platform/duration 直接覆盖（basis=explicit）；
 *   · 素材不足（<20s）时如实给短带并提示补料，不硬凑长片。
 */

export interface IntentAnalysisDoc {
  asset?: {
    sha256?: string;
    filename?: string;
    durationSeconds?: number | null;
    width?: number | null;
    height?: number | null;
    aspectRatio?: string | null;
    localPath?: string | null;
  } | null;
  contentDomain?: string | null;
  probe?: {
    speech?: { sentences?: Array<{ text?: string; start?: number; end?: number }>; words?: unknown[] } | null;
    shotBoundaries?: Array<{ index?: number; inTimecode?: string; outTimecode?: string; durationSeconds?: number }> | null;
    onScreenText?: Array<{ t?: number; texts?: string[] }> | null;
    ambience?: { speechCoverage?: number | null } | null;
  } | null;
  shots?: Array<{
    shotId?: string;
    inTimecode?: string;
    outTimecode?: string;
    durationSeconds?: number;
    sceneType?: string;
    content?: { keyEntities?: string[]; coreMessage?: string | null; speechText?: string | null; onScreenText?: string | null } | null;
    emotion?: { dominant?: string | null; intensity?: number | null; valence?: number | null } | null;
  }> | null;
}

export interface TopicCandidate {
  title: string;
  score: number;
  evidence: string[];
}

export interface InferredIntent {
  schemaVersion: "workloom.video-edit/edit-intent/v1";
  platform: string;
  durationBand: { minSeconds: number; maxSeconds: number; label: string };
  pacingProfile: "documentary" | "vlog" | "fast_cut" | "information" | "talk";
  audience: string[];
  emotionGoals: string[];
  topicCandidates: TopicCandidate[];
  aspectRatio: string | null;
  basis: {
    platform: string;
    duration: string;
    pacing: string;
    audience: string;
    emotion: string;
    topics: string;
  };
  notes: string[];
}

/** 平台默认时长带（秒）：以"用户能发出去的成片"为准，不用素材总量倒推。 */
const PLATFORM_BANDS: Record<string, { minSeconds: number; maxSeconds: number; pacing: InferredIntent["pacingProfile"] }> = {
  "抖音": { minSeconds: 30, maxSeconds: 60, pacing: "vlog" },
  "快手": { minSeconds: 30, maxSeconds: 60, pacing: "vlog" },
  "小红书": { minSeconds: 30, maxSeconds: 60, pacing: "vlog" },
  "微信视频号": { minSeconds: 45, maxSeconds: 90, pacing: "documentary" },
  "B站": { minSeconds: 180, maxSeconds: 300, pacing: "information" },
  "YouTube": { minSeconds: 180, maxSeconds: 600, pacing: "information" },
};

const DOMAIN_HINTS: Array<{ pattern: RegExp; audience: string[]; emotion: string[]; platform: string }> = [
  { pattern: /(美食|餐饮|菜|汤|火锅|烘焙)/u, audience: ["爱吃的人", "本地生活人群"], emotion: ["馋", "温暖", "想立刻去吃"], platform: "抖音" },
  { pattern: /(旅行|旅拍|风景|自驾|露营)/u, audience: ["向往出行的人", "同城周末游人群"], emotion: ["想去", "被治愈", "开阔"], platform: "小红书" },
  { pattern: /(知识|科普|教学|课程|教程)/u, audience: ["想学一件事的人", "学生与职场新人"], emotion: ["涨知识", "看明白", "想收藏"], platform: "B站" },
  { pattern: /(产品|评测|数码|科技|SaaS)/u, audience: ["准备下单的人", "数码爱好者"], emotion: ["可信", "对比清楚", "想了解"], platform: "B站" },
  { pattern: /(剧情|情感|家庭|亲子|生活记录)/u, audience: ["有类似经历的人", "愿意共情的观众"], emotion: ["共鸣", "被安慰", "想起谁"], platform: "微信视频号" },
];

function aspectFromDoc(doc: IntentAnalysisDoc): { ratio: string | null; orientation: "portrait" | "landscape" | "square" | null } {
  const width = Number(doc.asset?.width ?? 0);
  const height = Number(doc.asset?.height ?? 0);
  const declared = doc.asset?.aspectRatio ?? null;
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    const ratio = declared ?? `${width}:${height}`;
    const orientation = height > width ? "portrait" : height < width ? "landscape" : "square";
    return { ratio, orientation };
  }
  if (declared) {
    const [a, b] = declared.split(":").map(Number);
    if (Number.isFinite(a) && Number.isFinite(b) && a! > 0 && b! > 0) {
      return { ratio: declared, orientation: b! > a! ? "portrait" : b! < a! ? "landscape" : "square" };
    }
  }
  return { ratio: null, orientation: null };
}

/** 从画面文字/实体/核心信息里抽选题候选（可复算：命中次数 × 权重 + 数字锚点加成） */
export function extractTopicCandidates(analyses: IntentAnalysisDoc[], options: { maxTopics?: number } = {}): TopicCandidate[] {
  const maxTopics = options.maxTopics ?? 3;
  const scores = new Map<string, { score: number; evidence: Set<string> }>();
  const add = (raw: string, weight: number, evidence: string): void => {
    const title = raw.replace(/[【】\[\]()（）"“”'‘’]/gu, "").replace(/\s+/gu, "").trim();
    if (title.length < 2 || title.length > 12) return;
    if (/^\d+$/u.test(title)) return;
    const entry = scores.get(title) ?? { score: 0, evidence: new Set<string>() };
    entry.score += weight + (/[0-9０-９]/u.test(title) ? 0.5 : 0);
    entry.evidence.add(evidence);
    scores.set(title, entry);
  };
  for (const doc of analyses) {
    const filename = doc.asset?.filename ?? "";
    for (const shot of doc.shots ?? []) {
      const where = [shot.shotId, shot.inTimecode].filter(Boolean).join("@");
      for (const entity of shot.content?.keyEntities ?? []) add(entity, 2, where);
      for (const text of String(shot.content?.onScreenText ?? "").split(/[\/、,，;；\s]+/u)) add(text, 1.5, where);
      if (shot.content?.coreMessage) add(shot.content.coreMessage, 1, where);
    }
    for (const observation of doc.probe?.onScreenText ?? []) {
      for (const text of observation.texts ?? []) add(text, 1.5, `${filename}#${observation.t ?? 0}s`);
    }
  }
  return [...scores.entries()]
    .map(([title, entry]) => ({ title, score: Number(entry.score.toFixed(2)), evidence: [...entry.evidence].slice(0, 3) }))
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, maxTopics);
}

/**
 * 推断创作意图。`platformHint` / `durationHintSeconds` 为显式覆盖（来自用户或调用方）。
 * `aspectHint` 用于调用方已知目标画幅（例如竖屏项目）时覆盖素材画幅。
 */
export function inferEditIntent(input: {
  analyses: IntentAnalysisDoc[];
  platformHint?: string | null;
  durationHintSeconds?: number | null;
  aspectHint?: string | null;
}): InferredIntent {
  const analyses = input.analyses ?? [];
  const notes: string[] = [];
  const firstWithAsset = analyses.find((doc) => doc.asset) ?? null;
  const aspect = input.aspectHint
    ? { ratio: input.aspectHint, orientation: (() => {
      const [a, b] = input.aspectHint.split(":").map(Number);
      return Number.isFinite(a) && Number.isFinite(b) && a! > 0 && b! > 0 ? (b! > a! ? "portrait" : b! < a! ? "landscape" : "square") : null;
    })() }
    : aspectFromDoc(firstWithAsset ?? {});
  const totalFootageSeconds = analyses.reduce((sum, doc) => sum + (Number(doc.asset?.durationSeconds) || 0), 0);
  const speechSeconds = analyses.reduce((sum, doc) => sum + (doc.probe?.speech?.sentences ?? []).reduce((acc, sentence) => acc + Math.max(0, Number(sentence.end ?? 0) - Number(sentence.start ?? 0)), 0), 0);
  const contentDomain = analyses.map((doc) => doc.contentDomain).find((domain) => domain && domain.length > 0) ?? null;
  const domainHint = DOMAIN_HINTS.find((hint) => hint.pattern.test(`${contentDomain ?? ""} ${firstWithAsset?.asset?.filename ?? ""}`)) ?? null;

  // —— 平台 —— 
  let platform: string;
  let platformBasis: string;
  if (input.platformHint) {
    platform = input.platformHint;
    platformBasis = `显式指定（explicit）：${input.platformHint}`;
  } else if (aspect.orientation === "portrait") {
    /** 领域倾向只在**同画幅可用平台**里生效（旅行→小红书 属于竖屏平台；知识→B站 不适用于竖屏默认）。 */
    const portraitPlatforms = ["抖音", "小红书", "快手"];
    platform = domainHint && portraitPlatforms.includes(domainHint.platform) ? domainHint.platform : "抖音";
    platformBasis = `素材为竖屏（${aspect.ratio ?? "竖屏"}），优先短视频平台${domainHint ? `；内容领域命中「${domainHint.platform}」倾向` : ""}`;
  } else if (aspect.orientation === "landscape") {
    const landscapePlatforms = ["B站", "YouTube", "微信视频号"];
    platform = domainHint && landscapePlatforms.includes(domainHint.platform) ? domainHint.platform : (totalFootageSeconds >= 150 ? "B站" : "微信视频号");
    platformBasis = `素材为横屏（${aspect.ratio ?? "横屏"}）且可用时长 ${Math.round(totalFootageSeconds)}s，优先横屏长视频平台`;
  } else if (aspect.orientation === "square") {
    platform = "小红书";
    platformBasis = "方形画幅，优先图文/视频混排的小红书";
  } else {
    platform = domainHint?.platform ?? "微信视频号";
    platformBasis = `未取得画幅信息，按内容领域${domainHint ? `「${domainHint.platform}」` : "的通用选择"}给出默认`;
  }

  // —— 时长带（平台默认 × 素材可用量上限）—— 
  const band = PLATFORM_BANDS[platform] ?? PLATFORM_BANDS["微信视频号"]!;
  let minSeconds = band.minSeconds;
  let maxSeconds = band.maxSeconds;
  let durationBasis = `平台「${platform}」默认带 ${minSeconds}–${maxSeconds}s`;
  if (input.durationHintSeconds && input.durationHintSeconds > 0) {
    const target = Math.round(input.durationHintSeconds);
    minSeconds = Math.round(target * 0.9);
    maxSeconds = Math.round(target * 1.1);
    durationBasis = `显式指定目标 ${target}s（±10%）`;
  } else if (totalFootageSeconds > 0 && totalFootageSeconds * 0.6 < maxSeconds) {
    const capped = Math.max(10, Math.floor(totalFootageSeconds * 0.6));
    maxSeconds = Math.min(maxSeconds, capped);
    minSeconds = Math.min(minSeconds, Math.max(10, Math.floor(maxSeconds * 0.6)));
    durationBasis = `平台默认 ${band.minSeconds}–${band.maxSeconds}s，但可用素材只有 ${Math.round(totalFootageSeconds)}s：收敛为 ${minSeconds}–${maxSeconds}s（不要把 20s 素材硬拉成 60s 片）`;
  }
  if (totalFootageSeconds > 0 && totalFootageSeconds < 20) {
    notes.push(`可用素材仅 ${Math.round(totalFootageSeconds)}s：成片会偏短，建议补料或降低目标时长`);
  }

  // —— 节奏档案 —— 
  const speechRatio = totalFootageSeconds > 0 ? speechSeconds / totalFootageSeconds : 0;
  const talkLike = analyses.length === 1 && speechRatio >= 0.5;
  const pacingProfile: InferredIntent["pacingProfile"] = talkLike ? "talk" : band.pacing;
  const pacingBasis = talkLike
    ? `单条素材且语音占比 ${(speechRatio * 100).toFixed(0)}%：口播精剪节奏（内容推进，不堆切点）`
    : `按平台体裁默认：${band.pacing}`;

  // —— 受众 / 情绪目标 —— 
  const dominantEmotions = new Map<string, number>();
  for (const doc of analyses) {
    for (const shot of doc.shots ?? []) {
      const dominant = shot.emotion?.dominant;
      if (dominant) dominantEmotions.set(dominant, (dominantEmotions.get(dominant) ?? 0) + 1);
    }
  }
  const audience = [...new Set([...(domainHint?.audience ?? []), platform === "B站" ? "愿意看长内容的深度观众" : "通勤/碎片时间刷视频的人"])].slice(0, 3);
  const emotionGoals = [...new Set([
    ...(domainHint?.emotion ?? []),
    ...[...dominantEmotions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([emotion]) => emotion),
  ])].slice(0, 4);
  if (emotionGoals.length === 0) {
    emotionGoals.push("看明白这件事", "愿意看完");
    notes.push("素材没有可用的情绪标签（未跑镜头理解或标签为空）：情绪目标按平台通用值给默认，建议跑一次镜头理解后复核");
  }

  // —— 选题候选 —— 
  const topicCandidates = extractTopicCandidates(analyses);
  if (topicCandidates.length === 0) {
    notes.push("没有从画面文字/实体里抽到选题候选：建议先跑镜头理解（keyEntities）或 OCR，再让创意岗出候选");
  } else if (topicCandidates.length < 3) {
    notes.push(`只抽到 ${topicCandidates.length} 个选题候选（建议 3–7）：可用候选已如实列出，不编造池外选题`);
  }

  return {
    schemaVersion: "workloom.video-edit/edit-intent/v1",
    platform,
    durationBand: { minSeconds, maxSeconds, label: `${minSeconds}–${maxSeconds}s` },
    pacingProfile,
    audience,
    emotionGoals,
    topicCandidates,
    aspectRatio: aspect.ratio,
    basis: {
      platform: platformBasis,
      duration: durationBasis,
      pacing: pacingBasis,
      audience: domainHint ? `内容领域/文件名命中「${domainHint.pattern.source}」` : "平台通用受众（未命中领域关键词）",
      emotion: dominantEmotions.size > 0 ? `素材情绪标签统计（${[...dominantEmotions.entries()].map(([emotion, count]) => `${emotion}×${count}`).join("、")}）` : "无情绪标签，按平台通用目标",
      topics: topicCandidates.length > 0 ? "画面文字/实体/核心信息频次（频次×权重 + 数字锚点加成）" : "无可用素材证据",
    },
    notes,
  };
}
