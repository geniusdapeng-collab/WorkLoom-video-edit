#!/usr/bin/env tsx
/**
 * edit-talk-cut —— 口播精剪决策与交付物生成（本管线的核心执行器）。
 *
 * 一次产出五件东西（全部可复核）：
 *   ① `talk-cut-list.json`：每个删除/压缩/保留决定的理由、时间码、"人味价值"与指标；
 *   ② `talk.timeline.json`：帧级时间轴（单素材 + 跳切推近遮盖 + 逐段溯源）；
 *   ③ `talk.captions.json`：剪辑脚本字幕版（逐字来自 ASR，供 edit:subtitle 直接消费）；
 *   ④ `talk.srt`：可直接交付的字幕文件（口播字幕：逐字、短句、不卡 BGM 拍）；
 *   ⑤ `talk-qc.json`：口播质检（逐字一致 / 不切进词 / 不剪残句 / 人味下限 / 平滑风险）。
 *
 * 产品纪律（与 docs/talking-head-pipeline.md、skills/talk-cutting 同口径）：
 *   · 先保护后删除：自纠、笑点、情绪峰值、修辞强调先划进保护窗口，再在剩余区间上做删除；
 *   · 人味下限：语气词保留率与停顿保留率跌破下限即**拒绝出片**，除非人审显式 `--human-approved-below-floor`；
 *   · 精度门槛：逐字稿不是词级（precision != word）时必须显式 `--allow-segment-precision`——
 *     按估算时间码切片会切进词里，这是本管线最贵的一类事故。
 *
 * 用法：
 *   pnpm edit:talk-cut -- --transcript <talk.transcript.json> --emotion <talk.emotion.json>
 *     --out-dir outputs/edit/talk/<filmId> [--source <口播素材.mp4>] [--target 60]
 *     [--aspect 9:16 --platform 微信视频号 --fps 30] [--punch-in alternate|none]
 *     [--self-correction keep|trim-mistake] [--filler-floor 0.2 --pause-floor 0.15]
 *     [--max-segment-seconds 12] [--drop-tangents] [--allow-segment-precision] [--human-approved-below-floor] [--json]
 *     [--keep-blocks block-03,block-22 | --keep-sentences s085,s086,…]（G-TK4 选段定稿：长口播 → 1 条短片）
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  analysisFromTranscriptDoc, applyTalkSelection, buildTalkCaptionDoc, buildTalkTimeline, computeTalkStats, planTalkCut,
  talkCuesToSrt, validateEditTimeline, validateTalkCut, type TalkCutPlan, type TalkEmotionDoc,
  type TalkSentence, type TalkTranscriptDoc,
} from "../../packages/video-studio/src/edit/index.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

async function sha256File(file: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

async function main(): Promise<void> {
  const transcriptPath = arg("--transcript");
  const emotionPath = arg("--emotion");
  const outDirArg = arg("--out-dir");
  if (!transcriptPath || !emotionPath || !outDirArg) {
    throw new Error("用法：pnpm edit:talk-cut -- --transcript <talk.transcript.json> --emotion <talk.emotion.json> --out-dir <交付目录>");
  }
  const transcriptFile = abs(transcriptPath);
  const emotionFile = abs(emotionPath);
  if (!existsSync(transcriptFile)) throw new Error(`逐字稿不存在：${transcriptFile}`);
  if (!existsSync(emotionFile)) throw new Error(`情绪画像不存在：${emotionFile}`);
  const outDir = abs(outDirArg);
  mkdirSync(outDir, { recursive: true });

  const transcript = JSON.parse(readFileSync(transcriptFile, "utf8")) as TalkTranscriptDoc;
  if (transcript.schemaVersion !== "workloom.video-edit/talk-transcript/v1") {
    throw new Error(`逐字稿契约版本不符：${String(transcript.schemaVersion)}`);
  }
  const emotion = JSON.parse(readFileSync(emotionFile, "utf8")) as TalkEmotionDoc;
  if (emotion.schemaVersion !== "workloom.video-edit/talk-emotion/v1") {
    throw new Error(`情绪画像契约版本不符：${String(emotion.schemaVersion)}`);
  }
  /**
   * 逐字稿 ↔ 情绪画像一致性：两份产物必须描述同一批句子。
   * 用错稿/错情绪（例如上一次录制的 emotion.json）会让峰值保护窗落在不相干的句子上，
   * 这是"看不出报错、成片全歪"的静默事故。
   */
  const emotionSentenceIds = new Set(emotion.curve.map((point) => point.sentenceId));
  const missingEmotion = transcript.sentences.filter((sentence) => !emotionSentenceIds.has(sentence.id)).map((sentence) => sentence.id);
  if (missingEmotion.length > 0) {
    throw new Error(
      `情绪画像与逐字稿不是同一批句子：${missingEmotion.slice(0, 5).join("、")}${missingEmotion.length > 5 ? ` 等 ${missingEmotion.length} 句` : ""} 缺情绪曲线。`
      + "请用同一份 talk.transcript.json 重跑 pnpm edit:talk-emotion。",
    );
  }

  /** 精度门槛：句级/估算稿不允许直接进剪辑决策（会切进词里），必须显式放行。 */
  const allowSegment = flag("--allow-segment-precision");
  if (transcript.backend.precision !== "word" && !allowSegment) {
    throw new Error([
      `逐字稿精度为 ${transcript.backend.precision}（非词级）：按估算时间码切片会切进词里。`,
      "请用词级 ASR 重出逐字稿；确要用当前稿，显式加 --allow-segment-precision 并在回执里说明。",
    ].join("\n"));
  }

  const sourcePath = abs(arg("--source", transcript.asset.path));
  if (!existsSync(sourcePath)) {
    throw new Error(`口播素材不在本地：${sourcePath}——时间轴必须能追溯到源素材（G-ED3），请先用 --source 指定原件路径`);
  }
  const sourceSha256 = await sha256File(sourcePath);

  const sentences: TalkSentence[] = transcript.sentences.map((sentence) => ({
    id: sentence.id,
    text: sentence.text,
    start: sentence.start,
    end: sentence.end,
    pauseAfterSeconds: sentence.pauseAfterSeconds ?? null,
    words: sentence.words.map((word) => ({ ...word })),
  }));
  const analysis = analysisFromTranscriptDoc(transcript);
  /** 统计以当前句表重算并写进交付回执：避免"逐字稿统计"与"实际剪辑输入"两套数字。 */
  const stats = computeTalkStats(sentences, analysis);

  const targetSeconds = Number(arg("--target", "0"));
  const fillerFloor = Number(arg("--filler-floor", "0.2"));
  const pauseFloor = Number(arg("--pause-floor", "0.15"));
  const maxSegmentSeconds = Number(arg("--max-segment-seconds", "12"));
  const selfCorrectionPolicy = arg("--self-correction", "keep");
  if (!["keep", "trim-mistake"].includes(selfCorrectionPolicy)) throw new Error("--self-correction 只接受 keep / trim-mistake");
  const punchIn = arg("--punch-in", "alternate");
  if (!["alternate", "none"].includes(punchIn)) throw new Error("--punch-in 只接受 alternate / none");
  if (!(fillerFloor >= 0 && fillerFloor <= 1)) throw new Error("--filler-floor 需要 0–1");
  if (!(pauseFloor >= 0 && pauseFloor <= 1)) throw new Error("--pause-floor 需要 0–1");
  if (!(maxSegmentSeconds >= 2 && maxSegmentSeconds <= 20)) throw new Error("--max-segment-seconds 需要 2–20");

  const planBase: TalkCutPlan = planTalkCut(sentences, analysis, emotion, {
    ...(targetSeconds > 0 ? { targetDurationSeconds: targetSeconds } : {}),
    fillerKeepRateFloor: fillerFloor,
    pauseKeepRateFloor: pauseFloor,
    selfCorrectionPolicy: selfCorrectionPolicy as "keep" | "trim-mistake",
    /**
     * 跑题块默认**只列拆分候选、不硬删**（skills/talk-cutting: "拆成独立片子，不硬删"；
     * 候选是否剔出由 G-TK4 人在环决定）。确要系统剔出时显式 --drop-tangents。
     * `--keep-tangents` 保留为向后兼容的显式 no-op（语义等同默认）。
     */
    splitTangents: flag("--drop-tangents") && !flag("--keep-tangents"),
    punchIn: punchIn as "alternate" | "none",
  });

  /**
   * 本机生产补丁（2026-10-11，G-TK4 选段定稿）：长口播 → 1 条明确主题的短片。
   * 主线只做"片内逐句留删"，不提供"哪几段话进这条片子"的入口；本补丁把那个人工决策
   * 落成显式参数：`--keep-blocks block-03,block-22`（按话题块）或 `--keep-sentences s085,s086,…`（按句）。
   * 未选中的句子整体剔除；指标按成片 scope 重算（见 applyTalkSelection）。
   */
  const keepBlocks = arg("--keep-blocks", "").split(",").map((value) => value.trim()).filter(Boolean);
  const keepSentences = arg("--keep-sentences", "").split(",").map((value) => value.trim()).filter(Boolean);
  const selectedSentenceIds = [
    ...keepSentences,
    ...analysis.blocks
      .filter((block) => keepBlocks.includes(block.id))
      .flatMap((block) => block.sentenceIds),
  ];
  const unknownBlocks = keepBlocks.filter((id) => !analysis.blocks.some((block) => block.id === id));
  if (unknownBlocks.length > 0) throw new Error(`--keep-blocks 引用了不存在的话题块：${unknownBlocks.join("、")}`);
  const plan: TalkCutPlan = selectedSentenceIds.length > 0
    ? applyTalkSelection(sentences, analysis, planBase, {
      sentenceIds: [...new Set(selectedSentenceIds)],
      paceVariation: emotion.prosody.paceVariation,
    }).plan
    : planBase;

  const fps = Number(arg("--fps", String(transcript.asset.fps ?? 30)));
  const aspect = arg("--aspect", "9:16");
  const platform = arg("--platform", "微信视频号");
  const filmId = arg("--film-id", `talk-${sourceSha256.slice(0, 8)}`);
  const build = buildTalkTimeline(sentences, analysis, plan, {
    timelineId: `${filmId}-v1`,
    filmId,
    source: {
      sourceId: `src-${sourceSha256.slice(0, 8)}`,
      sha256: sourceSha256,
      path: sourcePath,
      fps,
      durationSeconds: transcript.asset.durationSeconds ?? sentences[sentences.length - 1]!.end,
      hasAudio: true,
    },
    target: {
      durationSeconds: plan.metrics.keptSeconds,
      aspectRatio: aspect,
      fps,
      platform,
    },
    maxSegmentSeconds,
    punchIn: punchIn as "alternate" | "none",
  });

  const timelineValidation = validateEditTimeline(build.timeline);
  const qc = validateTalkCut({
    sentences,
    analysis,
    plan,
    captions: build.captions,
    timelineOk: timelineValidation.ok,
    timelineChecks: timelineValidation.checks,
    humanApprovedBelowFloor: flag("--human-approved-below-floor"),
  });

  const cutPath = join(outDir, "talk-cut-list.json");
  const timelinePath = join(outDir, "talk.timeline.json");
  const captionDocPath = join(outDir, "talk.captions.json");
  const srtPath = join(outDir, "talk.srt");
  const qcPath = join(outDir, "talk-qc.json");
  writeFileSync(cutPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  writeFileSync(timelinePath, `${JSON.stringify(build.timeline, null, 2)}\n`, "utf8");
  writeFileSync(captionDocPath, `${JSON.stringify(buildTalkCaptionDoc({
    cues: build.captions.cues,
    videoTitle: build.captions.videoTitle,
    videoId: `${new Date().toISOString().slice(0, 10).replace(/-/gu, "")}-${sourceSha256.slice(0, 8)}`,
    totalDurationSeconds: build.captions.totalDurationSeconds,
  }), null, 2)}\n`, "utf8");
  writeFileSync(srtPath, talkCuesToSrt(build.captions.cues), "utf8");
  writeFileSync(qcPath, `${JSON.stringify({
    schema: "workloom.video-edit/talk-qc/v1",
    filmId,
    transcript: transcriptFile,
    emotion: emotionFile,
    source: { path: sourcePath, sha256: sourceSha256 },
    precision: transcript.backend.precision,
    allowSegmentPrecision: allowSegment,
    humanApprovedBelowFloor: flag("--human-approved-below-floor"),
    stats,
    metrics: plan.metrics,
    checks: qc.checks,
    fixes: qc.fixes,
    timelineChecks: timelineValidation.checks,
    ok: qc.ok,
    generatedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");

  const summary = {
    ok: qc.ok,
    filmId,
    outDir,
    outputs: { cut: cutPath, timeline: timelinePath, captions: captionDocPath, srt: srtPath, qc: qcPath },
    keptSeconds: plan.metrics.keptSeconds,
    removedSeconds: plan.metrics.removedSeconds,
    segments: build.timeline.segments.length,
    cues: build.captions.cues.length,
    metrics: plan.metrics,
    hardFailures: qc.checks.filter((check) => check.hard && !check.pass).map((check) => `${check.id}：${check.detail}`),
    advisories: qc.checks.filter((check) => !check.hard && !check.pass).map((check) => `${check.id}：${check.detail}`),
    splitCandidates: plan.splitCandidates,
    notes: plan.notes,
  };
  if (flag("--json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`✓ 口播精剪决策完成：保留 ${plan.metrics.keptSeconds}s / 原 ${stats.speechSeconds + stats.pauseSeconds}s（删 ${plan.metrics.removedSeconds}s）`);
    console.log(`  段数 ${summary.segments} · 字幕 ${summary.cues} 条 · 跳切遮盖 ${punchIn === "alternate" ? "交替推近" : "关闭"}`);
    console.log(`  语气词保留率 ${plan.metrics.fillerKeepRate}（下限 ${plan.options.fillerKeepRateFloor}）· 停顿保留率 ${plan.metrics.pauseKeepRate}（下限 ${plan.options.pauseKeepRateFloor}）· 平滑风险 ${plan.metrics.smoothingRisk}`);
    console.log(`  人味信号保留 ${plan.metrics.humanSignalsKept} 处（自纠/笑点/修辞强调/下限回补）`);
    for (const note of plan.notes) console.log(`  · ${note}`);
    for (const failure of summary.hardFailures) console.log(`  ✗ ${failure}`);
    for (const advisory of summary.advisories) console.log(`  ! ${advisory}`);
    console.log(`  产物：${outDir}`);
  }
  if (!qc.ok) process.exit(1);
}

main().catch((err) => {
  console.error(`✗ edit-talk-cut 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
