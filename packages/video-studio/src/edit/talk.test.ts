import { describe, expect, it } from "vitest";
import {
  analyzeTalkTranscript, buildEmotionCurve, buildTalkCaptionDoc, buildTalkCaptions, buildTalkTimeline,
  computeTalkProsody, detectTalkFillers, detectTalkPauses, detectTalkRepetitions, detectTalkSelfCorrections,
  draftTalkSegments, flattenTalkWords, mergeSpans, normalizeTalkText, planTalkCut, scoreTalkBlocks,
  segmentTalkBlocks, splitTalkCaptionLines, subtractSpans, talkCuesToSrt, validateTalkCut,
  type TalkSentence, type TalkWord,
} from "./talk.js";
import { validateEditTimeline, planAssembly, type EditTimeline } from "./timeline.js";

const round = (value: number): number => Math.round(value * 1000) / 1000;

type Part = [text: string, duration: number, gapBefore?: number];

/** 逐字稿夹具构造器：`[句 id, [[词, 词时长, 与前词间隔?]…]]`，光标在句间继续累加 */
function buildSentences(rows: Array<[string, Part[]]>): TalkSentence[] {
  let cursor = 0;
  const sentences = rows.map(([id, parts]) => {
    const words: TalkWord[] = [];
    for (const [text, duration, gap] of parts) {
      cursor += gap ?? 0;
      words.push({ text, start: round(cursor), end: round(cursor + duration) });
      cursor += duration;
    }
    const first = words[0]!;
    const last = words[words.length - 1]!;
    return { id, text: parts.map((part) => part[0]).join(""), start: first.start, end: last.end, words } as TalkSentence;
  });
  return sentences.map((sentence, index) => {
    const next = sentences[index + 1];
    return {
      ...sentence,
      pauseAfterSeconds: next ? round(Math.max(0, next.start - sentence.end)) : 0,
    };
  });
}

/**
 * 标准口播夹具：一条 40 秒左右的"想到哪儿说到哪儿"素材——
 * 含语气词、死停、思考停顿、卡壳、单词重复、口误自纠、修辞性重复，以及一句跑题块。
 */
function fixture(): TalkSentence[] {
  return buildSentences([
    ["s1", [["大家好", 0.6], ["嗯", 0.3, 0.1], ["今天", 0.4, 0.1], ["我", 0.2], ["想", 0.2], ["聊", 0.2], ["一个", 0.3], ["特别", 0.35], ["重要", 0.35], ["的", 0.15], ["事情", 0.35]]],
    ["s2", [["就是", 0.35, 1.6], ["很多人", 0.5], ["拍", 0.2], ["口播", 0.4], ["的", 0.15], ["时候", 0.3], ["会", 0.2], ["觉得", 0.3], ["自己", 0.3], ["说", 0.2], ["得", 0.15], ["不", 0.15], ["好", 0.25]]],
    ["s3", [["我", 0.25, 0.1], ["我", 0.2], ["我", 0.2], ["觉得", 0.3], ["这个", 0.3], ["这个", 0.3], ["问题", 0.35], ["其实", 0.3], ["不在", 0.3], ["你", 0.2]]],
    ["s4", [["不对", 0.4], ["我是说", 0.5], ["问题", 0.35], ["不在", 0.3], ["你", 0.2], ["说得", 0.3], ["够不够", 0.4], ["完美", 0.4]]],
    ["s5", [["而", 0.2, 2.2], ["在", 0.2], ["于", 0.15], ["你", 0.2], ["敢不敢", 0.45], ["把", 0.2], ["真实", 0.35], ["的", 0.15], ["自己", 0.3], ["放", 0.25], ["出来", 0.35]]],
    ["s6", [["很重要", 0.45, 0.05], ["很重要", 0.5]]],
    ["s7", [["记住", 0.45, 1.4], ["观众", 0.35], ["要", 0.2], ["的", 0.15], ["不是", 0.3], ["完美", 0.35], ["是", 0.2], ["真诚", 0.4]]],
    ["s8", [["那", 0.25, 0.9], ["诶", 0.25], ["话说回来", 0.6], ["昨天", 0.35], ["我", 0.2], ["家", 0.2], ["猫", 0.25], ["把", 0.2], ["沙发", 0.35], ["抓", 0.25], ["坏", 0.3], ["了", 0.2]]],
  ]);
}

describe("edit/talk：逐字稿标记", () => {
  it("语气词按词表标记，并区分 hesitation 与 discourse 与可删性", () => {
    const sentences = fixture();
    const fillers = detectTalkFillers(flattenTalkWords(sentences));
    const texts = fillers.map((filler) => filler.text);
    expect(texts).toContain("嗯");
    expect(texts).toContain("就是");
    expect(texts).toContain("其实");
    const hesitation = fillers.find((filler) => filler.text === "嗯")!;
    expect(hesitation.kind).toBe("hesitation");
    expect(hesitation.removability).toBeGreaterThan(0.8);
    const discourse = fillers.find((filler) => filler.text === "然后" || filler.text === "就是")!;
    expect(discourse.kind).toBe("discourse");
    expect(discourse.removability).toBeLessThan(0.5);
  });

  it("停顿分级：换气/思考/死停，并区分句内与句间", () => {
    const pauses = detectTalkPauses(fixture());
    expect(pauses.every((pause) => pause.durationSeconds >= 0.28)).toBe(true);
    const kinds = new Set(pauses.map((pause) => pause.kind));
    expect(kinds.has("thinking")).toBe(true);
    expect(kinds.has("dead")).toBe(true);
    const between = pauses.filter((pause) => pause.betweenSentences);
    expect(between.length).toBeGreaterThan(0);
    expect(pauses.every((pause) => pause.end > pause.start)).toBe(true);
  });

  it("重复检测：识出连续单字重复（卡壳）与一口气复述（修辞强调）", () => {
    const marks = detectTalkRepetitions(fixture());
    const stumbles = marks.filter((mark) => mark.kind === "word-repeat");
    expect(stumbles.some((mark) => mark.text === "我" && mark.times >= 3)).toBe(true);
    const rhetorical = marks.find((mark) => mark.kind === "rhetorical");
    expect(rhetorical).toBeTruthy();
    expect(rhetorical!.text).toContain("很重要");
    expect(rhetorical!.keepOccurrence).toBe("all");
  });

  it("口误自纠：命中提示词并给出被纠正与纠正后的原文", () => {
    const marks = detectTalkSelfCorrections(fixture());
    expect(marks.length).toBeGreaterThan(0);
    const mark = marks[0]!;
    expect(mark.cue).toBe("不对");
    expect(mark.mistaken.length).toBeGreaterThan(0);
    expect(mark.corrected).toContain("我是说");
    expect(mark.end).toBeGreaterThan(mark.start);
  });

  it("话题块切分：显式连接词（回到刚才/那…话说回来）与长停顿都会切块", () => {
    const sentences = fixture();
    const analysis = analyzeTalkTranscript(sentences);
    expect(analysis.blocks.length).toBeGreaterThanOrEqual(2);
    expect(analysis.blocks.every((block) => block.sentenceIds.length > 0)).toBe(true);
    const titles = analysis.blocks.map((block) => block.title);
    expect(titles.every((title) => title.length > 0)).toBe(true);
  });

  it("统计口径：词数/语气词率/停顿秒数/语速都可复算", () => {
    const sentences = fixture();
    const analysis = analyzeTalkTranscript(sentences);
    expect(analysis.stats.wordCount).toBe(flattenTalkWords(sentences).length);
    expect(analysis.stats.fillerCount).toBe(analysis.fillers.length);
    expect(analysis.stats.pauseSeconds).toBeGreaterThan(0);
    expect(analysis.stats.wpm).toBeGreaterThan(0);
    expect(analysis.stats.deadAirSeconds).toBeGreaterThan(0);
  });

  it("非法逐字稿 fail-closed：时间码倒置 / 词越出句区间 / 空稿都抛错", () => {
    expect(() => analyzeTalkTranscript([])).toThrow(/逐字稿为空/u);
    expect(() => analyzeTalkTranscript([{ id: "x", text: "a", start: 2, end: 1, words: [] }])).toThrow(/时间区间非法/u);
    expect(() => analyzeTalkTranscript([{
      id: "x", text: "a", start: 0, end: 1, words: [{ text: "a", start: 0, end: 2 }],
    }])).toThrow(/越出句区间/u);
  });
});

describe("edit/talk：情绪与活人感", () => {
  it("韵律画像给出语速、相对倍率与变异系数（可复算）", () => {
    const sentences = fixture();
    const prosody = computeTalkProsody(sentences, { pauses: detectTalkPauses(sentences) });
    expect(prosody.sentences.length).toBe(sentences.length);
    expect(prosody.meanCharsPerSecond).toBeGreaterThan(0);
    expect(prosody.paceVariation).toBeGreaterThanOrEqual(0);
    expect(prosody.sentences.every((entry) => entry.paceRatio > 0)).toBe(true);
  });

  it("无标签通道时效价为 null（不猜情绪词），有标签时如实写入", () => {
    const sentences = fixture();
    const analysis = analyzeTalkTranscript(sentences);
    const plain = buildEmotionCurve(sentences, analysis, {});
    expect(plain.curve.every((point) => point.valence === null)).toBe(true);
    expect(plain.channel.semantic).toBe("none");
    const labeled = buildEmotionCurve(sentences, analysis, {
      labels: [{ sentenceId: "s7", valence: 0.6, label: "笃定", laughter: false }],
    });
    expect(labeled.channel.semantic).toBe("labels");
    expect(labeled.curve.find((point) => point.sentenceId === "s7")!.label).toBe("笃定");
  });

  it("情绪峰值可检出，且带证据；活人感分落在 0–1", () => {
    const sentences = fixture();
    const analysis = analyzeTalkTranscript(sentences);
    const emotion = buildEmotionCurve(sentences, analysis, {
      labels: [{ sentenceId: "s6", label: "兴奋", valence: 0.5 }, { sentenceId: "s8", label: "幽默", laughter: true }],
    });
    expect(emotion.peaks.length).toBeGreaterThan(0);
    expect(emotion.peaks.every((peak) => peak.reason.length > 0)).toBe(true);
    expect(emotion.peaks.some((peak) => peak.kind === "humor_peak")).toBe(true);
    expect(emotion.humanness.score).toBeGreaterThanOrEqual(0);
    expect(emotion.humanness.score).toBeLessThanOrEqual(1);
    expect(emotion.humanness.signals.selfCorrections).toBeGreaterThan(0);
  });
});

describe("edit/talk：剪取决策", () => {
  it("死停被压到 0.4s；换气停顿原样保留", () => {
    const sentences = fixture();
    const analysis = analyzeTalkTranscript(sentences);
    const emotion = buildEmotionCurve(sentences, analysis, {});
    const plan = planTalkCut(sentences, analysis, emotion);
    const deadDecisions = plan.decisions.filter((decision) => decision.reason === "dead-air");
    expect(deadDecisions.length).toBeGreaterThan(0);
    expect(deadDecisions.every((decision) => decision.action === "trim")).toBe(true);
    expect(deadDecisions.every((decision) => round(decision.keepTo! - decision.keepFrom!) <= 0.401)).toBe(true);
    const breath = plan.decisions.filter((decision) => decision.reason === "breath-keep");
    expect(breath.every((decision) => decision.action === "keep")).toBe(true);
  });

  it("默认策略保留口误自纠（错句+纠正），只压缩中间停顿", () => {
    const sentences = fixture();
    const analysis = analyzeTalkTranscript(sentences);
    const emotion = buildEmotionCurve(sentences, analysis, {});
    const plan = planTalkCut(sentences, analysis, emotion);
    const keep = plan.decisions.find((decision) => decision.reason === "self-correction-keep");
    expect(keep).toBeTruthy();
    expect(keep!.humanValue).toBeGreaterThan(0.8);
    /** 自纠区间必须仍被保留（除非只落在死停上） */
    const correction = analysis.selfCorrections[0]!;
    const overlap = plan.keepSpans.some((span) => span.start < correction.end - 0.05 && span.end > correction.start + 0.05);
    expect(overlap).toBe(true);
  });

  it("trim-mistake 口径：删除错句，只保留纠正后的说法", () => {
    const sentences = fixture();
    const analysis = analyzeTalkTranscript(sentences);
    const emotion = buildEmotionCurve(sentences, analysis, {});
    const plan = planTalkCut(sentences, analysis, emotion, { selfCorrectionPolicy: "trim-mistake" });
    const correction = analysis.selfCorrections[0]!;
    /** 删除区间可能与被合并的其他删除相邻合并，因此检查"重叠"而不是"起点严格落在区间内"。 */
    const overlapsCorrection = plan.cutSpans.some((span) => span.start < correction.end && span.end > correction.start);
    expect(overlapsCorrection).toBe(true);
    expect(plan.decisions.some((decision) => decision.reason === "self-correction-keep")).toBe(false);
  });

  it("修辞性重复保留；卡壳只留最完整的一次", () => {
    const sentences = fixture();
    const analysis = analyzeTalkTranscript(sentences);
    const emotion = buildEmotionCurve(sentences, analysis, {});
    const plan = planTalkCut(sentences, analysis, emotion);
    expect(plan.decisions.some((decision) => decision.reason === "rhetorical-keep")).toBe(true);
    /**
     * 卡壳要放在**没有保护窗**的语料上测：共享夹具里的「我我我」落在口误自纠的错句区间内，
     * 按"自纠=错句+纠正都留"的口径它必须保留（旧实现会被重复处理器删掉，属于规则打架）。
     */
    const stumbleSentences = buildSentences([
      ["s1", [["我", 0.2], ["我", 0.2], ["我", 0.2], ["觉得", 0.3], ["这样", 0.3], ["挺", 0.2], ["好", 0.2]]],
    ]);
    const stumbleAnalysis = analyzeTalkTranscript(stumbleSentences);
    const stumblePlan = planTalkCut(stumbleSentences, stumbleAnalysis, buildEmotionCurve(stumbleSentences, stumbleAnalysis, {}));
    expect(stumblePlan.decisions.some((decision) => decision.reason === "stumble" && decision.action === "cut")).toBe(true);
  });

  it("保护窗口优先于重复处理器：自纠错句里的卡壳/语气词不会被重复删除", () => {
    const sentences = fixture();
    const analysis = analyzeTalkTranscript(sentences);
    const emotion = buildEmotionCurve(sentences, analysis, {});
    const plan = planTalkCut(sentences, analysis, emotion);
    const correction = analysis.selfCorrections[0]!;
    const cutsInsideCorrection = plan.cutSpans.filter((span) => span.start < correction.end && span.end > correction.start);
    /**
     * 自纠策略 keep 时，错句区间内只允许"停顿压缩"（可用理由被合并覆盖为 self-correction-keep）；
     * 语气词/卡壳一律不得在保护窗内被删——这是"先保护后删除"的具体断言。
     */
    expect(cutsInsideCorrection.some((span) => span.reason === "filler-noise" || span.reason === "stumble")).toBe(false);
  });

  it("人味下限：语气词删得过多时自动回补，保留率达到下限", () => {
    const sentences = fixture();
    const analysis = analyzeTalkTranscript(sentences);
    const emotion = buildEmotionCurve(sentences, analysis, {});
    const plan = planTalkCut(sentences, analysis, emotion, { fillerKeepRateFloor: 1 });
    expect(plan.metrics.fillerKeepRate).toBeGreaterThanOrEqual(1);
    expect(plan.decisions.some((decision) => decision.reason === "human-floor-keep" && decision.target === "filler")).toBe(true);
    expect(plan.notes.some((note) => note.includes("人味下限"))).toBe(true);
  });

  it("保留区间与删除区间互补，且互不重叠", () => {
    const sentences = fixture();
    const analysis = analyzeTalkTranscript(sentences);
    const emotion = buildEmotionCurve(sentences, analysis, {});
    const plan = planTalkCut(sentences, analysis, emotion);
    const deadline = sentences[sentences.length - 1]!.end;
    const covered = plan.keepSpans.reduce((sum, span) => sum + (span.end - span.start), 0)
      + plan.cutSpans.reduce((sum, span) => sum + (span.end - span.start), 0);
    expect(covered).toBeCloseTo(deadline, 2);
    for (let i = 1; i < plan.keepSpans.length; i += 1) {
      expect(plan.keepSpans[i]!.start).toBeGreaterThanOrEqual(plan.keepSpans[i - 1]!.end - 0.001);
    }
  });

  it("平滑风险是 0–1 的指标；删得越干净风险越高", () => {
    const sentences = fixture();
    const analysis = analyzeTalkTranscript(sentences);
    const emotion = buildEmotionCurve(sentences, analysis, {});
    const gentle = planTalkCut(sentences, analysis, emotion, { fillerKeepRateFloor: 0.9, punchIn: "alternate" });
    const harsh = planTalkCut(sentences, analysis, emotion, { fillerKeepRateFloor: 0, pauseKeepRateFloor: 0, punchIn: "none" });
    expect(gentle.metrics.smoothingRisk).toBeGreaterThanOrEqual(0);
    expect(harsh.metrics.smoothingRisk).toBeLessThanOrEqual(1);
    expect(harsh.metrics.smoothingRisk).toBeGreaterThan(gentle.metrics.smoothingRisk);
  });

  it("话题块打分与跑题拆分：低分块进拆分候选，不硬删素材", () => {
    const sentences = fixture();
    const analysis = analyzeTalkTranscript(sentences);
    const emotion = buildEmotionCurve(sentences, analysis, {});
    const scores = scoreTalkBlocks(sentences, analysis, emotion);
    expect(scores.length).toBe(analysis.blocks.length);
    expect(scores.every((score) => score.score >= 0 && score.score <= 1)).toBe(true);
    const plan = planTalkCut(sentences, analysis, emotion, { splitTangents: true });
    expect(plan.splitCandidates.every((candidate) => candidate.reason.includes("块评分"))).toBe(true);
  });

  it("工具函数：合并/求差与文本归一化", () => {
    const merged = mergeSpans([{ start: 1, end: 2 }, { start: 2.01, end: 3 }, { start: 5, end: 6 }], 10);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.end).toBe(3);
    const keep = subtractSpans({ start: 0, end: 10 }, [{ start: 2, end: 4 }, { start: 6, end: 7 }]);
    expect(keep).toEqual([{ start: 0, end: 2 }, { start: 4, end: 6 }, { start: 7, end: 10 }]);
    expect(normalizeTalkText("你好，世界！")).toBe("你好世界");
  });
});

describe("edit/talk：时间轴、字幕与质检", () => {
  const build = () => {
    const sentences = fixture();
    const analysis = analyzeTalkTranscript(sentences);
    const emotion = buildEmotionCurve(sentences, analysis, {});
    const plan = planTalkCut(sentences, analysis, emotion);
    const timelineOptions = {
      timelineId: "talk-tl-1",
      source: {
        sourceId: "src-talk",
        sha256: "b".repeat(64),
        path: "/tmp/talk.mp4",
        fps: 30,
        durationSeconds: 60,
        hasAudio: true,
      },
      target: { durationSeconds: plan.metrics.keptSeconds, aspectRatio: "9:16", fps: 30, platform: "微信视频号" },
    };
    return { sentences, analysis, emotion, plan, timelineOptions };
  };

  it("口播时间轴通过校验：单素材密集跳切不再触发同源间隔硬闸", () => {
    const { sentences, analysis, plan, timelineOptions } = build();
    const { timeline, drafts } = buildTalkTimeline(sentences, analysis, plan, timelineOptions);
    expect(timeline.sourceGapPolicy).toBe("single-take-talking-head");
    expect(drafts.length).toBeGreaterThan(1);
    const validation = validateEditTimeline(timeline);
    const hardFailures = validation.checks.filter((check) => check.hard && !check.pass);
    expect(hardFailures).toEqual([]);
    expect(validation.checks.some((check) => check.id === "talk.monotonicOrder" && check.pass)).toBe(true);
    expect(validation.checks.some((check) => check.id === "talk.jumpCutCoverage")).toBe(true);
  });

  it("跳切用交替推近遮盖：相邻段 punch-in 落在 1.0–1.5 且至少覆盖一半跳切", () => {
    const { sentences, analysis, plan, timelineOptions } = build();
    const { timeline } = buildTalkTimeline(sentences, analysis, plan, timelineOptions);
    const jumpCuts = timeline.segments.filter((segment) => (segment.motive ?? "").includes("跳切"));
    expect(jumpCuts.length).toBeGreaterThan(0);
    const covered = jumpCuts.filter((segment) => (segment.punchIn?.scale ?? 1) > 1.0001);
    expect(covered.length / jumpCuts.length).toBeGreaterThanOrEqual(0.5);
    expect(covered.every((segment) => (segment.punchIn!.scale ?? 0) <= 1.5)).toBe(true);
    const plan1 = planAssembly(timeline, { workDir: "/tmp/w", outputPath: "/tmp/out.mp4", width: 1080, height: 1920, fps: 30 });
    const punched = plan1.normalize.find((step) => step.args.join(" ").includes("crop=w=1080:h=1920:x="));
    expect(punched).toBeTruthy();
  });

  it("标准策略仍然硬拦同源间隔不足（口播策略只对声明过的轴生效）", () => {
    const { sentences, analysis, plan, timelineOptions } = build();
    const { timeline } = buildTalkTimeline(sentences, analysis, plan, timelineOptions);
    const standard: EditTimeline = { ...timeline, sourceGapPolicy: "standard" };
    const validation = validateEditTimeline(standard);
    expect(validation.ok).toBe(false);
    expect(validation.checks.some((check) => check.id.startsWith("source.gap:") && !check.pass)).toBe(true);
  });

  it("逐字字幕：文本等于保留词原文（不润色），并给出关键词强调", () => {
    const { sentences, analysis, plan, timelineOptions } = build();
    const { captions, drafts } = buildTalkTimeline(sentences, analysis, plan, timelineOptions);
    expect(captions.cues.length).toBe(drafts.length);
    const normalization = (text: string) => normalizeTalkText(text);
    for (const [index, cue] of captions.cues.entries()) {
      const draft = drafts[index]!;
      const kept = flattenTalkWords(sentences)
        .filter((word) => word.start >= draft.start - 0.02 && word.end <= draft.end + 0.02)
        .map((word) => word.text)
        .join("");
      expect(normalization(cue.text)).toBe(normalization(kept));
    }
    expect(captions.cues.some((cue) => cue.emphasis.length > 0)).toBe(true);
    expect(captions.cues.every((cue) => cue.lines.every((line) => line.length <= 12))).toBe(true);
  });

  it("质检：字幕被改写即硬失败；删除端点切进词内即硬失败", () => {
    const { sentences, analysis, plan, timelineOptions } = build();
    const { captions } = buildTalkTimeline(sentences, analysis, plan, timelineOptions);
    const okResult = validateTalkCut({ sentences, analysis, plan, captions });
    expect(okResult.checks.filter((check) => check.hard && !check.pass)).toEqual([]);

    const rewritten = {
      cues: captions.cues.map((cue, index) =>
        index === 0 ? { ...cue, text: `${cue.text}（润色）` } : cue),
    };
    const rewrittenResult = validateTalkCut({ sentences, analysis, plan, captions: rewritten });
    expect(rewrittenResult.ok).toBe(false);
    expect(rewrittenResult.fixes.some((fix) => fix.action.includes("逐字稿原文"))).toBe(true);

    const badPlan = {
      ...plan,
      cutSpans: [...plan.cutSpans, { start: plan.cutSpans[0]!.start + 0.1, end: plan.cutSpans[0]!.end + 0.1, reason: "filler-noise" as const }],
    };
    const boundaryResult = validateTalkCut({ sentences, analysis, plan: badPlan, captions });
    expect(boundaryResult.checks.some((check) => check.id.startsWith("cut.boundary:") && !check.pass)).toBe(true);
  });

  it("质检：把整句剪成残句即硬失败（防「但是…」式断句）", () => {
    const { sentences, analysis, plan, timelineOptions } = build();
    const { captions } = buildTalkTimeline(sentences, analysis, plan, timelineOptions);
    const target = sentences[1]!;
    const keepSeconds = (target.end - target.start) * 0.15;
    const cutStart = round(target.start + keepSeconds);
    /** 只留下这句话的 15%，并把保留区间同步收窄——模拟"剪出半句就收工"的坏轴。 */
    const fragmentPlan = {
      ...plan,
      keepSpans: [
        ...plan.keepSpans.filter((span) => span.end <= target.start + 0.02 || span.start >= target.end - 0.02),
        { start: target.start, end: cutStart },
      ].sort((a, b) => a.start - b.start),
      cutSpans: [...plan.cutSpans, { start: cutStart, end: round(target.end), reason: "filler-noise" as const }],
    };
    const result = validateTalkCut({ sentences, analysis, plan: fragmentPlan, captions });
    expect(result.checks.some((check) => check.id === `sentence.fragment:${target.id}` && !check.pass)).toBe(true);
  });

  it("质检：人味下限未达标时挂起，可由人审显式放行", () => {
    const { sentences, analysis, plan, timelineOptions } = build();
    const { captions } = buildTalkTimeline(sentences, analysis, plan, timelineOptions);
    const strict = {
      ...plan,
      options: { ...plan.options, fillerKeepRateFloor: 0.99 },
      metrics: { ...plan.metrics, fillerKeepRate: 0.1 },
    };
    const blocked = validateTalkCut({ sentences, analysis, plan: strict, captions });
    expect(blocked.ok).toBe(false);
    expect(blocked.checks.some((check) => check.id === "humanness.fillerFloor" && check.hard && !check.pass)).toBe(true);
    const approved = validateTalkCut({ sentences, analysis, plan: strict, captions, humanApprovedBelowFloor: true });
    expect(approved.checks.find((check) => check.id === "humanness.fillerFloor")!.pass).toBe(true);
  });

  it("字幕产物：SRT 与 caption_script 文档形状正确", () => {
    const { sentences, analysis, plan, timelineOptions } = build();
    const { captions } = buildTalkTimeline(sentences, analysis, plan, timelineOptions);
    const srt = talkCuesToSrt(captions.cues);
    expect(srt).toMatch(/^1\n00:00:00,000 --> /u);
    expect(srt.split("\n\n").length).toBe(captions.cues.length);
    const doc = buildTalkCaptionDoc({
      cues: captions.cues,
      videoTitle: captions.videoTitle,
      videoId: "20261011-abcdef01",
      totalDurationSeconds: captions.totalDurationSeconds,
    });
    const groups = doc.video_groups as Array<{ shots: Array<{ segmentId: string }> }>;
    expect(groups[0]!.shots.length).toBe(captions.cues.length);
    expect(String(doc.total_duration)).toMatch(/^\d{2}:\d{2}$/u);
  });

  it("断句与草稿：单段不超过 12s，段间跳切被标记", () => {
    const { sentences, analysis, plan } = build();
    const drafts = draftTalkSegments(sentences, analysis, plan, { maxSegmentSeconds: 6 });
    expect(drafts.every((draft) => draft.end - draft.start <= 6.05)).toBe(true);
    expect(drafts.some((draft) => draft.jumpCut)).toBe(true);
    expect(splitTalkCaptionLines("一二三四五六七八九十十一十二十三").length).toBeGreaterThan(1);
  });
});
