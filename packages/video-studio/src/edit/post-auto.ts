/**
 * edit/post-auto.ts —— 后期自动决策（封面取帧 / 分段调色）纯函数。
 *
 * 为什么单独一层：过去的后期默认值里有"只为某一支演示片调过"的硬编码
 * （固定取帧秒 35.5/6.6/24.6、固定 场景1..4 → LUT 映射）。对用户随手丢进来的素材，
 * 这些默认值等于随机。这里把两条决定做成可解释、可复算的规则：
 *   · 封面：优先吃素材理解产出的关键帧候选（composition_best / emotion_peak），
 *     映射到成片主轨时间；没有解析结果时如实回退到配方比例并标注 basis；
 *   · 分段调色：把"家里暖 / 城市冷"变成可追溯的投票——镜头理解给的调色建议、
 *     场景类型、情绪效价、场景组名称/情绪关键词 + 调色配方库匹配，最后产出每组 LUT 与强度。
 *
 * 边界：本模块不做审美判断，也不改时间轴/交付包字段；只输出"选哪一帧、用哪支 LUT"的计划，
 * 执行仍由 post-bridge / color-bridge 完成（同一份 plan 可复算、可复核）。
 */

import type { EditTimeline } from "./timeline.js";

export interface PostAnalysisDoc {
  asset?: { sha256?: string; localPath?: string };
  shots?: Array<{
    shotId?: string;
    inTimecode?: string;
    outTimecode?: string;
    sceneType?: string;
    emotion?: { dominant?: string | null; intensity?: number | null; valence?: number | null } | null;
    editing?: { colorGradeBase?: string | null; textSafeZone?: string | null; usage?: string[] } | null;
  }>;
  keyframes?: Array<{
    keyframeId?: string;
    shotId?: string;
    kind?: "emotion_peak" | "action_peak" | "composition_best";
    timecode?: string;
    score?: number;
    technical?: { sharpness?: number | null; stability?: number | null; textSafe?: boolean | null; faceVisible?: boolean | null } | null;
    usage?: string[];
  }>;
}

type AnalysisShot = NonNullable<PostAnalysisDoc["shots"]>[number];

export interface CoverMomentPlan {
  /** 0–1 的成片比例（直接写进变体配方的 `cover.at`） */
  ratio: number;
  masterSeconds: number;
  basis: "keyframe-composition" | "keyframe-emotion" | "keyframe-any" | "fallback";
  keyframeId?: string;
  shotId?: string;
  segmentId?: string;
  note: string;
}

function parseTimecodeSeconds(value: string | undefined | null): number | null {
  if (!value) return null;
  const matched = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/u.exec(value);
  if (!matched) return null;
  return Number(matched[1]) * 3600 + Number(matched[2]) * 60 + Number(matched[3]) + Number(matched[4]) / 1000;
}

function clampRatio(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Number(Math.min(0.95, Math.max(0, value)).toFixed(4));
}

/**
 * 自动选封面时刻：关键帧候选 → 主轨比例。
 *
 * 优先级：`composition_best`（构图最优） > `emotion_peak`（情绪峰值） > 其他关键帧；
 * 同一类按 score 降序；跳过 `technical.textSafe === false` 与 `sharpness < 0.5` 的候选
 * （封面会被平台 UI 挡或糊）；全部不可用时回退 `fallbackRatio`（默认变体配方 0.35）。
 */
export function planCoverMoment(input: {
  timeline: EditTimeline;
  analyses?: PostAnalysisDoc[];
  fallbackRatio?: number;
}): CoverMomentPlan {
  const { timeline } = input;
  const fallbackRatio = clampRatio(input.fallbackRatio ?? 0.35, 0.35);
  const analyses = input.analyses ?? [];
  const segments = timeline.segments ?? [];
  let cursor = 0;
  const masterSpans = segments.map((segment) => {
    const start = cursor;
    cursor = Number((cursor + segment.durationSeconds).toFixed(3));
    return { segment, start, end: cursor };
  });
  const total = cursor;
  if (!(total > 0)) {
    return { ratio: fallbackRatio, masterSeconds: 0, basis: "fallback", note: "时间轴为空，使用配方默认比例" };
  }
  const sourceById = new Map((timeline.sources ?? []).map((source) => [source.sourceId, source]));
  const analysisFor = (sourceId: string): PostAnalysisDoc | null => {
    const source = sourceById.get(sourceId);
    if (!source) return null;
    return analyses.find((doc) => doc?.asset?.sha256 === source.sha256 || (doc?.asset?.localPath && doc.asset.localPath === source.path)) ?? null;
  };

  type Candidate = { kind: string; score: number; keyframeId?: string; shotId?: string; segmentId: string; masterSeconds: number };
  const candidates: Candidate[] = [];
  for (const span of masterSpans) {
    const doc = analysisFor(span.segment.sourceId);
    if (!doc) continue;
    for (const keyframe of doc.keyframes ?? []) {
      if (keyframe.technical?.textSafe === false) continue;
      if (typeof keyframe.technical?.sharpness === "number" && keyframe.technical.sharpness < 0.5) continue;
      const time = parseTimecodeSeconds(keyframe.timecode);
      if (time === null) continue;
      if (time < span.segment.sourceIn || time >= span.segment.sourceOut) continue;
      const speed = span.segment.speed ?? 1;
      const masterSeconds = Number((span.start + (time - span.segment.sourceIn) / speed).toFixed(3));
      candidates.push({
        kind: keyframe.kind ?? "any",
        score: Number.isFinite(keyframe.score as number) ? (keyframe.score as number) : 0,
        keyframeId: keyframe.keyframeId,
        shotId: keyframe.shotId,
        segmentId: span.segment.segmentId,
        masterSeconds,
      });
    }
  }
  const kindRank = (kind: string): number => (kind === "composition_best" ? 2 : kind === "emotion_peak" ? 1 : 0);
  const best = [...candidates].sort((a, b) => kindRank(b.kind) - kindRank(a.kind) || b.score - a.score)[0];
  if (!best) {
    return {
      ratio: fallbackRatio,
      masterSeconds: Number((total * fallbackRatio).toFixed(3)),
      basis: "fallback",
      note: "没有可用的关键帧候选（未跑镜头理解/高光，或候选均未过安全与清晰度门槛）：回退配方默认比例",
    };
  }
  const basis = best.kind === "composition_best" ? "keyframe-composition" : best.kind === "emotion_peak" ? "keyframe-emotion" : "keyframe-any";
  return {
    ratio: clampRatio(best.masterSeconds / total, fallbackRatio),
    masterSeconds: best.masterSeconds,
    basis,
    keyframeId: best.keyframeId,
    shotId: best.shotId,
    segmentId: best.segmentId,
    note: `封面取帧来自${best.kind}关键帧（score ${best.score}）映射到主轨 ${best.masterSeconds}s`,
  };
}

export interface ColorRecipe {
  id: string;
  genre?: string;
  scene?: string;
  mood?: string;
  profile: string;
  lut: string;
  intensity: number;
  platforms?: string[];
}

export interface SegmentColorAssignment {
  segmentId: string;
  groupId: string;
  profile: string;
  lut: string | null;
  intensity: number;
  basis: string;
}

export interface SegmentColorPlan {
  assignments: SegmentColorAssignment[];
  groups: Array<{ groupId: string; profile: string; lut: string | null; intensity: number; votes: { warm: number; cool: number; neutral: number }; basis: string }>;
  warnings: string[];
}

interface ColorVotes {
  warm: number;
  cool: number;
  neutral: number;
}

const WARM_WORDS = /(家|团圆|饭桌|美食|厨房|暖|治愈|回忆|亲子|故乡|老屋|果园|收获|羊汤|火锅|夜宵|民宿)/u;
const COOL_WORDS = /(城市|都市|科技|产品|商务|夜|冷|雨|雪|海|山|公路|旅行|街|人潮|机场|地铁|屏幕|数码)/u;
const NEUTRAL_WORDS = /(纪录|纪实|口播|访谈|教学|教程|screen|录屏)/iu;

/**
 * 分段调色计划：按场景组投票（暖/冷/中性），输出每组 LUT 与强度。
 *
 * 投票来源（全部可解释）：
 *   · 镜头理解 `editing.colorGradeBase`：暖调/冷调/保持原色（每镜 1 票，重复计权）；
 *   · 镜头 `sceneType`：screen_recording/studio_talking → 中性 1 票挑；
 *   · 情绪效价：≥0.2 → 暖 1 票，≤-0.2 → 冷 1 票；
 *   · 场景组名称/情绪关键词：命中暖词/冷词/中性词各 1–2 票。
 *
 * 输出 LUT 必须来自 `recipes`（调色配方库）或 `availableLuts` 白名单；两者都缺时回退到
 * warm-film / cool-technical 的随仓 LUT 名并给出 warning（调用方决定是否继续）。
 */
export function planSegmentColor(input: {
  timeline: EditTimeline;
  analyses?: PostAnalysisDoc[];
  recipes?: ColorRecipe[];
  availableLuts?: string[];
  /** 兼容旧参数：显式组名 → LUT（优先于自动投票） */
  legacyGroupMap?: Record<string, { lut: string; intensity: number; label?: string }>;
}): SegmentColorPlan {
  const { timeline } = input;
  const analyses = input.analyses ?? [];
  const recipes = input.recipes ?? [];
  const luts = input.availableLuts ? new Set(input.availableLuts) : null;
  const warnings: string[] = [];
  const sourceById = new Map((timeline.sources ?? []).map((source) => [source.sourceId, source]));
  const analysisFor = (sourceId: string): PostAnalysisDoc | null => {
    const source = sourceById.get(sourceId);
    if (!source) return null;
    return analyses.find((doc) => doc?.asset?.sha256 === source.sha256 || (doc?.asset?.localPath && doc.asset.localPath === source.path)) ?? null;
  };
  const groupOf = (segment: EditTimeline["segments"][number]): string => segment.groupId ?? "(未分组)";
  const groups = new Map<string, ColorVotes>();
  const votesOf = (groupId: string): ColorVotes => {
    let votes = groups.get(groupId);
    if (!votes) {
      votes = { warm: 0, cool: 0, neutral: 0 };
      groups.set(groupId, votes);
    }
    return votes;
  };

  // 场景组关键词先投票（组名 + 组情绪）
  for (const group of timeline.groups ?? []) {
    const text = `${group.name ?? ""} ${group.storyline ?? ""} ${group.emotion ?? ""}`;
    const votes = votesOf(group.groupId ?? "(未分组)");
    if (WARM_WORDS.test(text)) votes.warm += 2;
    if (COOL_WORDS.test(text)) votes.cool += 2;
    if (NEUTRAL_WORDS.test(text)) votes.neutral += 2;
  }

  // 逐镜信号投票 + 记录每段的来源镜头
  const segmentShots = new Map<string, AnalysisShot[]>();
  for (const segment of timeline.segments ?? []) {
    const doc = analysisFor(segment.sourceId);
    const shots = (doc?.shots ?? []).filter((shot) => {
      const start = parseTimecodeSeconds(shot.inTimecode);
      const end = parseTimecodeSeconds(shot.outTimecode);
      if (start === null || end === null) return false;
      return start < segment.sourceOut && end > segment.sourceIn;
    });
    segmentShots.set(segment.segmentId, shots);
    const votes = votesOf(groupOf(segment));
    for (const shot of shots) {
      const base = String(shot.editing?.colorGradeBase ?? "");
      if (/暖/u.test(base)) votes.warm += 1;
      if (/冷/u.test(base)) votes.cool += 1;
      if (/保持|原色|不变/u.test(base)) votes.neutral += 1;
      if (shot.sceneType === "screen_recording") votes.neutral += 1;
      if (shot.sceneType === "studio_talking") votes.neutral += 1;
      const valence = shot.emotion?.valence;
      if (typeof valence === "number" && Number.isFinite(valence)) {
        if (valence >= 0.2) votes.warm += 1;
        if (valence <= -0.2) votes.cool += 1;
      }
    }
  }

  const pickRecipe = (profile: string, groupText: string): ColorRecipe | null => {
    const candidates = recipes.filter((recipe) => recipe.profile === profile);
    if (candidates.length === 0) return null;
    const scored = candidates.map((recipe) => {
      const haystack = `${recipe.genre ?? ""} ${recipe.scene ?? ""} ${recipe.mood ?? ""}`;
      let score = 0;
      for (const word of ["美食", "菜", "餐", "汤", "果园", "家", "旅行", "旅拍", "夜景", "都市", "产品", "口播", "访谈", "纪录", "亲子"]) {
        if (groupText.includes(word) && haystack.includes(word)) score += 1;
      }
      return { recipe, score };
    }).sort((a, b) => b.score - a.score);
    return scored[0]!.recipe;
  };

  const assignments: SegmentColorAssignment[] = [];
  const groupPlans: SegmentColorPlan["groups"] = [];
  for (const [groupId, votes] of groups) {
    const groupSegments = (timeline.segments ?? []).filter((segment) => groupOf(segment) === groupId);
    const groupText = `${groupId} ${(timeline.groups ?? []).filter((group) => (group.groupId ?? "(未分组)") === groupId).map((group) => `${group.name ?? ""} ${group.emotion ?? ""}`).join(" ")} ${groupSegments.map((segment) => segmentShots.get(segment.segmentId)?.map((shot) => shot.editing?.usage?.join(" ") ?? "").join(" ") ?? "").join(" ")}`;
    const ranked = (Object.entries(votes) as Array<[keyof ColorVotes, number]>).sort((a, b) => b[1] - a[1]);
    const top = ranked[0] ?? (["neutral", 0] as [keyof ColorVotes, number]);
    const runnerUp = ranked[1] ?? (["neutral", 0] as [keyof ColorVotes, number]);
    const margin = top[1] - runnerUp[1];
    const legacy = input.legacyGroupMap?.[groupId];
    /** 显式覆盖（legacy map / `--color-map`）优先级最高：即使该组零票也必须生效，否则"显式指定"名不副实。 */
    const votedProfile = top[1] === 0 ? null : top[0] === "warm" ? "warm-film" : top[0] === "cool" ? "cool-technical" : null;
    /**
     * 显式覆盖的 LUT 家族：能识别暖/冷就按家族走；识别不了（自定义 LUT）则不臆测家族，
     * 由下面"投票兜底 + 白名单回退"决定；两者都没有时才原样保留（执行器的存在性检查负责 fail-fast）。
     */
    const legacyProfile = legacy
      ? (legacy.lut.toLowerCase().includes("warm") ? "warm-film" : legacy.lut.toLowerCase().includes("cool") ? "cool-technical" : null)
      : null;
    const profile = legacyProfile ?? votedProfile;
    const basisVotes = `votes warm=${votes.warm} cool=${votes.cool} neutral=${votes.neutral}`;
    if (!profile || profile === null) {
      for (const segment of groupSegments) {
        assignments.push({ segmentId: segment.segmentId, groupId, profile: "none", lut: null, intensity: 0, basis: `中性/证据不足：不叠加统一调色（${basisVotes}）` });
      }
      groupPlans.push({ groupId, profile: "none", lut: null, intensity: 0, votes, basis: `不调色（${basisVotes}）` });
      continue;
    }
    const recipe = pickRecipe(profile, groupText);
    const lutName = legacy?.lut ?? recipe?.lut ?? (profile === "warm-film" ? "look-warm-film.cube" : "look-cool-technical.cube");
    const baseIntensity = legacy?.intensity ?? recipe?.intensity ?? (profile === "warm-film" ? 0.7 : 0.6);
    /** 显式覆盖的强度原样使用（"指定 0.55 就是 0.55"）；自动投票的强度才按票差微调。 */
    const intensity = legacy
      ? Number(Math.min(1, Math.max(0, legacy.intensity)).toFixed(2))
      : Number(Math.min(0.85, Math.max(0.4, baseIntensity + Math.min(0.15, margin * 0.05))).toFixed(2));
    if (luts && !luts.has(lutName)) {
      warnings.push(`场景组「${groupId}」选择的 LUT ${lutName} 不在随仓 LUT 清单里，已回退到受控配方默认`);
    }
    const missingFromWhitelist = Boolean(luts && !luts.has(lutName));
    const safeLut = missingFromWhitelist
      ? (profile === "warm-film" ? "look-warm-film.cube" : profile === "cool-technical" ? "look-cool-technical.cube" : lutName)
      : lutName;
    const basis = legacy
      ? `显式覆盖（legacy map）→ ${safeLut}@${intensity}`
      : `内容投票 ${basisVotes}｜配方 ${recipe?.id ?? "默认"} → ${safeLut}@${intensity}`;
    for (const segment of groupSegments) {
      assignments.push({ segmentId: segment.segmentId, groupId, profile, lut: safeLut, intensity, basis });
    }
    groupPlans.push({ groupId, profile, lut: safeLut, intensity, votes, basis });
  }

  return { assignments, groups: groupPlans, warnings };
}
