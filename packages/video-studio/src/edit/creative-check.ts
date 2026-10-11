/**
 * edit/creative-check.ts —— 创作环节检查器（纯函数）。
 *
 * 背景：`creative-ideation` / `narrative-structure` 里写了不少硬纪律
 * （候选两两至少 3 维不同、每个 beat 必须绑真实素材 id、评审要覆盖全部候选、
 * 生成阶段不许自评、时长带误差 ≤5%……），但此前**没有任何机器校验**——
 * 模型说做到了就做到了，创作环节成了整条链路最软的一段。
 *
 * 本模块把其中**事实类**的部分变成硬闸（可由 `edit:creative-check` 执行器判定）：
 *   · 方案差异度：候选两两至少 3 个维度明显不同（禁止"换壳方案"）；
 *   · 素材引用：candidateShotIds / highlightRefs / keyframeRefs / materialRefs 必须真实存在；
 *   · 评审覆盖：每个候选都有四视角评分，slot 一一对应；
 *   · 禁止自评：候选对象里出现 score/total/rating 即视为越权（评分只属于评审链）。
 * 其余（情绪曲线峰值/回落、评审区分度、总分加权一致、时长带）为咨询项——
 * 它们是创作判断，报出来给人看，不代替人拍板。
 */

export interface CreativeCandidateLike {
  slot?: string;
  title?: string;
  logline?: string;
  differentiators?: {
    narrativeVoice?: string | null;
    structure?: string | null;
    emotion?: string | null;
    tempo?: string | null;
    visualStyle?: string | null;
  } | null;
  openingMove?: string | null;
  turningPoint?: string | null;
  endingMove?: string | null;
  materialPlan?: Array<{
    beat?: string;
    role?: string;
    candidateShotIds?: string[];
    highlightRefs?: string[];
  }> | null;
  withoutIt?: string | null;
  [key: string]: unknown;
}

export interface CreativeReviewLike {
  slot?: string;
  scores?: { narrative?: number; emotion?: number; platform?: number; feasibility?: number } | null;
  total?: number;
  notes?: string;
}

export interface StoryBeatLike {
  beatId?: string;
  name?: string;
  targetSeconds?: number;
  materialRefs?: string[];
  highlightRefs?: string[];
  keyframeRefs?: string[];
  intensity?: number | null;
}

export interface StoryPlanLike {
  slot?: string;
  structure?: string;
  beats?: StoryBeatLike[] | null;
  emotionCurve?: Array<{ t?: number; intensity?: number; label?: string | null }> | null;
  tempoMap?: Array<{ avgShotSeconds?: number; cutsPerMinute?: number }> | null;
  bgmPlan?: unknown;
  risks?: string[];
}

export interface CreativeSetDocLike {
  creativeSet?: {
    intent?: { platform?: string; durationBand?: string; audience?: string; emotionGoal?: string[]; mustInclude?: string[]; mustAvoid?: string[] } | null;
    candidates?: CreativeCandidateLike[] | null;
    review?: CreativeReviewLike[] | null;
    recommendedOrder?: string[] | null;
  } | null;
  storyPlan?: StoryPlanLike | null;
}

export interface MaterialIndexLike {
  shotIds?: string[];
  highlightIds?: string[];
  keyframeIds?: string[];
}

export interface CreativeCheckIssue {
  id: string;
  severity: "hard" | "advisory";
  detail: string;
  slot?: string;
}

export interface CreativeCheckResult {
  ok: boolean;
  issues: CreativeCheckIssue[];
  metrics: {
    candidateCount: number;
    minDifferentDims: number | null;
    referencesChecked: number;
    referencesMissing: number;
    reviewCoverage: string;
  };
}

const DIFF_DIMS = ["narrativeVoice", "structure", "emotion", "tempo", "visualStyle", "openingMove"] as const;

/** 提取一个候选在 6 个维度上的取值（openingMove 取前 8 字做粗粒度比较，避免整句不同被当差异） */
function dimensionValues(candidate: CreativeCandidateLike): Record<(typeof DIFF_DIMS)[number], string> {
  const differentiators = candidate.differentiators ?? {};
  return {
    narrativeVoice: String(differentiators.narrativeVoice ?? "").trim(),
    structure: String(differentiators.structure ?? "").trim(),
    emotion: String(differentiators.emotion ?? "").trim(),
    tempo: String(differentiators.tempo ?? "").trim(),
    visualStyle: String(differentiators.visualStyle ?? "").trim(),
    openingMove: [...String(candidate.openingMove ?? "").replace(/\s+/gu, "")].slice(0, 8).join(""),
  };
}

/** 解析时长带（支持 "45–60s" / "45-60秒" / "00:45-01:00" / "3–5 分钟"）→ 秒区间 */
export function parseDurationBandSeconds(band: string | null | undefined): { minSeconds: number; maxSeconds: number } | null {
  if (!band) return null;
  const text = String(band).replace(/\s+/gu, "");
  const toSeconds = (value: string, unitMinutes: boolean): number | null => {
    if (/^\d{1,2}:\d{2}(:\d{2})?$/u.test(value)) {
      const parts = value.split(":").map(Number);
      return parts.length === 2 ? parts[0]! * 60 + parts[1]! : parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
    }
    const number = Number(value.replace(/[^\d.]/gu, ""));
    if (!Number.isFinite(number)) return null;
    return unitMinutes ? number * 60 : number;
  };
  const matched = /([0-9:]+)\s*[–~-]\s*([0-9:]+)\s*(分钟|分|秒|s|min)?/iu.exec(text);
  if (!matched) return null;
  const unitMinutes = Boolean(matched[3] && /分|min/iu.test(matched[3]));
  const minSeconds = toSeconds(matched[1]!, unitMinutes);
  const maxSeconds = toSeconds(matched[2]!, unitMinutes);
  if (minSeconds === null || maxSeconds === null || !(maxSeconds > minSeconds)) return null;
  return { minSeconds, maxSeconds };
}

/**
 * 创作集检查。`material` 不提供时，素材引用只报咨询项（"未提供素材索引，未校验"），
 * 不伪称已校验；提供时必须**全部命中**，否则硬失败（创作方案引用不存在的镜头是最贵的一类返工）。
 */
export function checkCreativeSet(input: {
  doc: CreativeSetDocLike;
  material?: MaterialIndexLike | null;
}): CreativeCheckResult {
  const issues: CreativeCheckIssue[] = [];
  const creativeSet = input.doc?.creativeSet ?? null;
  const candidates = creativeSet?.candidates ?? [];
  const review = creativeSet?.review ?? [];
  const material = input.material ?? null;
  const shotIds = new Set(material?.shotIds ?? []);
  const highlightIds = new Set(material?.highlightIds ?? []);
  const keyframeIds = new Set(material?.keyframeIds ?? []);
  let referencesChecked = 0;
  let referencesMissing = 0;

  if (!creativeSet) {
    issues.push({ id: "creativeSet.missing", severity: "hard", detail: "缺少 creativeSet（创意方案集）" });
    return { ok: false, issues, metrics: { candidateCount: 0, minDifferentDims: null, referencesChecked: 0, referencesMissing: 0, reviewCoverage: "0/0" } };
  }

  // —— 候选数量与 slot —— 
  if (candidates.length < 3) {
    issues.push({ id: "candidates.count", severity: "hard", detail: `候选只有 ${candidates.length} 个：至少 3 个才有"选择"的意义（默认 5–7 个）` });
  } else if (candidates.length > 7) {
    issues.push({ id: "candidates.countHigh", severity: "advisory", detail: `候选 ${candidates.length} 个偏多（默认 5–7）：人审成本上升，建议收敛` });
  }
  const slots = candidates.map((candidate) => String(candidate.slot ?? ""));
  const badSlots = slots.filter((slot) => !/^T\d{2}$/u.test(slot));
  if (badSlots.length > 0) {
    issues.push({ id: "candidates.slotFormat", severity: "hard", detail: `候选 slot 不符合 T01–T99：${badSlots.join("、") || "（空）"}` });
  }
  if (new Set(slots).size !== slots.length) {
    issues.push({ id: "candidates.slotUnique", severity: "hard", detail: `候选 slot 重复：${slots.join("、")}` });
  }

  // —— 禁止自评（生成与评分分离）—— 
  for (const candidate of candidates) {
    const selfScoreKeys = Object.keys(candidate).filter((key) => ["score", "total", "rating", "rank", "recommended"].includes(key));
    if (selfScoreKeys.length > 0) {
      issues.push({
        id: `candidates.selfScore:${String(candidate.slot ?? "?")}`,
        severity: "hard",
        detail: `候选 ${String(candidate.slot ?? "?")} 出现自评字段（${selfScoreKeys.join("、")}）：发散阶段不许给自己打分，评分只属于评审链`,
        slot: String(candidate.slot ?? ""),
      });
    }
  }

  // —— 差异化：两两至少 3 维明显不同 —— 
  let minDifferentDims: number | null = null;
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = dimensionValues(candidates[i]!);
      const b = dimensionValues(candidates[j]!);
      const differentDims = DIFF_DIMS.filter((dim) => a[dim] !== b[dim] && a[dim] !== "" && b[dim] !== "");
      const missingDims = DIFF_DIMS.filter((dim) => a[dim] === "" || b[dim] === "");
      const effective = differentDims.length;
      minDifferentDims = minDifferentDims === null ? effective : Math.min(minDifferentDims, effective);
      if (effective < 3) {
        issues.push({
          id: `candidates.differentiation:${slots[i] ?? i}-${slots[j] ?? j}`,
          severity: "hard",
          detail: `候选 ${slots[i] ?? i} 与 ${slots[j] ?? j} 只有 ${effective} 个维度不同（要求 ≥3）：${differentDims.join("、") || "无"}`
            + (missingDims.length > 0 ? `；缺字段：${missingDims.join("、")}` : ""),
        });
      }
    }
  }

  // —— 素材引用真实性 —— 
  const checkRefs = (refs: string[] | null | undefined, kind: "shot" | "highlight" | "keyframe", slot: string, where: string): void => {
    for (const raw of refs ?? []) {
      const ref = String(raw);
      referencesChecked += 1;
      if (!material) continue;
      const id = ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref;
      const exists = kind === "shot" ? shotIds.has(id) : kind === "highlight" ? highlightIds.has(id) : keyframeIds.has(id);
      if (!exists) {
        referencesMissing += 1;
        issues.push({
          id: `material.missing:${slot}:${where}:${ref}`,
          severity: "hard",
          detail: `${slot} 的 ${where} 引用了不存在的${kind === "shot" ? "镜头" : kind === "highlight" ? "高光" : "关键帧"} id：${ref}`,
          slot,
        });
      }
    }
  };
  for (const candidate of candidates) {
    const slot = String(candidate.slot ?? "?");
    if (!Array.isArray(candidate.materialPlan) || candidate.materialPlan.length === 0) {
      issues.push({ id: `material.plan:${slot}`, severity: "hard", detail: `${slot} 缺 materialPlan：每个候选必须给出段落 → 素材 id 的映射`, slot });
      continue;
    }
    for (const [index, plan] of candidate.materialPlan.entries()) {
      if (!Array.isArray(plan.candidateShotIds) || plan.candidateShotIds.length === 0) {
        issues.push({ id: `material.planShots:${slot}:${index}`, severity: "hard", detail: `${slot} 第 ${index + 1} 段（${String(plan.beat ?? "?")}）没有绑定任何镜头 id`, slot });
      }
      checkRefs(plan.candidateShotIds, "shot", slot, `materialPlan[${index}].candidateShotIds`);
      checkRefs(plan.highlightRefs, "highlight", slot, `materialPlan[${index}].highlightRefs`);
    }
  }
  for (const beat of input.doc.storyPlan?.beats ?? []) {
    const beatId = String(beat.beatId ?? "?");
    if (!Array.isArray(beat.materialRefs) || beat.materialRefs.length === 0) {
      issues.push({ id: `material.beat:${beatId}`, severity: "hard", detail: `beat ${beatId} 没有绑定素材 id：无素材支撑的段落只能进 risks`, slot: beatId });
    }
    checkRefs(beat.materialRefs, "shot", beatId, "materialRefs");
    checkRefs(beat.highlightRefs, "highlight", beatId, "highlightRefs");
    checkRefs(beat.keyframeRefs, "keyframe", beatId, "keyframeRefs");
  }
  if (!material && referencesChecked > 0) {
    issues.push({
      id: "material.indexMissing",
      severity: "advisory",
      detail: `共 ${referencesChecked} 处素材引用未校验：未提供素材索引（用 --analysis 传入 edit:probe 产物后再跑）`,
    });
  }

  // —— 评审覆盖与四视角 —— 
  const reviewSlots = review.map((entry) => String(entry.slot ?? ""));
  const missingReviews = slots.filter((slot) => !reviewSlots.includes(slot));
  if (review.length === 0) {
    issues.push({ id: "review.missing", severity: "hard", detail: "缺 review（四视角评审矩阵）" });
  } else {
    if (missingReviews.length > 0) {
      issues.push({ id: "review.coverage", severity: "hard", detail: `评审没覆盖候选：${missingReviews.join("、")} 缺评分` });
    }
    for (const entry of review) {
      const slot = String(entry.slot ?? "?");
      const scores = entry.scores ?? {};
      const missingViews = (["narrative", "emotion", "platform", "feasibility"] as const).filter((view) => typeof scores[view] !== "number");
      if (missingViews.length > 0) {
        issues.push({ id: `review.views:${slot}`, severity: "hard", detail: `${slot} 缺评审视角：${missingViews.join("、")}（四视角必须齐全）`, slot });
      }
    }
    /** 区分度：同一视角不允许全候选同分（skill 口径：视为无效评审重做）——咨询项提示重评。 */
    for (const view of ["narrative", "emotion", "platform", "feasibility"] as const) {
      const values = review.map((entry) => entry.scores?.[view]).filter((value): value is number => typeof value === "number");
      if (values.length >= 2 && new Set(values).size === 1) {
        issues.push({ id: `review.uniform:${view}`, severity: "advisory", detail: `视角「${view}」所有候选同分（${values[0]}）：评审区分度不足，建议重评并写扣分理由` });
      }
    }
    /** 总分与加权一致（0.3/0.3/0.2/0.2）——咨询项，容差 0.5。 */
    for (const entry of review) {
      const scores = entry.scores ?? {};
      if (typeof entry.total === "number" && ["narrative", "emotion", "platform", "feasibility"].every((view) => typeof scores[view as keyof typeof scores] === "number")) {
        const weighted = 0.3 * scores.narrative! + 0.3 * scores.emotion! + 0.2 * scores.platform! + 0.2 * scores.feasibility!;
        if (Math.abs(weighted - entry.total) > 0.5) {
          issues.push({
            id: `review.total:${String(entry.slot ?? "?")}`,
            severity: "advisory",
            detail: `${String(entry.slot ?? "?")} 总分 ${entry.total} 与加权值 ${Number(weighted.toFixed(2))} 差 ${Math.abs(weighted - entry.total).toFixed(2)}（权重 0.3/0.3/0.2/0.2）`,
          });
        }
      }
    }
  }
  for (const slot of creativeSet.recommendedOrder ?? []) {
    if (!slots.includes(String(slot))) {
      issues.push({ id: `review.order:${String(slot)}`, severity: "advisory", detail: `recommendedOrder 引用了不存在的候选 ${String(slot)}` });
    }
  }

  // —— 结构：beat 时长带与情绪曲线（咨询项）—— 
  const storyPlan = input.doc.storyPlan ?? null;
  if (!storyPlan) {
    issues.push({ id: "storyPlan.missing", severity: "advisory", detail: "缺 storyPlan：本轮只检查了创意方案集" });
  } else {
    const beats = storyPlan.beats ?? [];
    if (beats.length < 3) {
      issues.push({ id: "storyPlan.beats", severity: "hard", detail: `beat 只有 ${beats.length} 个：结构至少 3 段（起承转合/钩子-推进-落点）` });
    }
    const band = parseDurationBandSeconds(creativeSet.intent?.durationBand);
    const total = beats.reduce((sum, beat) => sum + Number(beat.targetSeconds ?? 0), 0);
    if (band) {
      const deviation = total > 0 ? Math.abs(total - (band.minSeconds + band.maxSeconds) / 2) / ((band.minSeconds + band.maxSeconds) / 2) : 1;
      if (total < band.minSeconds * 0.95 || total > band.maxSeconds * 1.05) {
        issues.push({
          id: "storyPlan.durationBand",
          severity: "advisory",
          detail: `beat 目标秒数合计 ${Number(total.toFixed(1))}s 落在时长带 ${band.minSeconds}–${band.maxSeconds}s 之外（误差 >5%）：目标带中值偏差 ${(deviation * 100).toFixed(0)}%`,
        });
      }
    } else if (creativeSet.intent?.durationBand) {
      issues.push({ id: "storyPlan.durationBandParse", severity: "advisory", detail: `无法解析时长带「${creativeSet.intent.durationBand}」：跳过时长核算` });
    }
    const curve = storyPlan.emotionCurve ?? [];
    if (curve.length >= 3) {
      const intensities = curve.map((point) => Number(point.intensity ?? 0));
      const maxIndex = intensities.indexOf(Math.max(...intensities));
      const hasFall = intensities.slice(maxIndex + 1).some((value) => value <= Math.max(...intensities) - 0.15);
      if (!hasFall) {
        issues.push({ id: "storyPlan.curveFall", severity: "advisory", detail: "情绪曲线在峰值之后没有明显回落（≥0.15）：观感会「一直顶」，建议补回落点" });
      }
    } else {
      issues.push({ id: "storyPlan.curve", severity: "advisory", detail: `情绪曲线只有 ${curve.length} 点：至少 3 点（含峰值与回落）` });
    }
  }

  const ok = issues.every((issue) => issue.severity !== "hard");
  return {
    ok,
    issues,
    metrics: {
      candidateCount: candidates.length,
      minDifferentDims,
      referencesChecked,
      referencesMissing,
      reviewCoverage: `${reviewSlots.filter((slot) => slots.includes(slot)).length}/${slots.length}`,
    },
  };
}
