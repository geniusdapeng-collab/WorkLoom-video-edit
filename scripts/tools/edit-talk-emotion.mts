#!/usr/bin/env tsx
/**
 * edit-talk-emotion —— 口播情绪与"活人感"画像（本地声学确定 + 标注通道补充）。
 *
 * 分工（与 skills/talk-emotion 同口径）：
 *   · 本地算得出的一律本地算：句级语速、能量、停顿形态、语速变异、动态范围 → 唤起度（arousal）；
 *   · 本地算不出的不猜：效价（valence）与情绪词只有 `--labels`（模型/人工标注）给出，缺就写 null；
 *   · 笑声/叹气只认标注通道（ASR 从文本里认不出笑声，能量峰值也不等于笑）。
 *
 * 为什么这么严：情绪是口播的第二根主轴。如果这里用"能量高 = 情绪高"糊过去，下游就会把
 * "大声念稿"当成"情绪峰值"来剪，最后片子又吵又假。宁可字段是 null，也不给假信号。
 *
 * 用法：
 *   pnpm edit:talk-emotion -- --transcript <talk.transcript.json> --out <talk.emotion.json>
 *     [--analysis <probe.json>] [--labels <labels.json>] [--json]
 *
 * `--analysis` 提供 `probe.loudness.envelope`（edit:probe 产物）时启用本地能量通道；
 * `--labels` 形如 `{"labels":[{"sentenceId":"s001","valence":0.4,"label":"笃定","laughter":false}]}`，
 * 亦支持纯数组。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  analyzeTalkTranscript, buildEmotionCurve, type LoudnessLikePoint, type TalkEmotionLabelInput,
  type TalkSentence, type TalkTranscriptDoc,
} from "../../packages/video-studio/src/edit/index.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

function main(): void {
  const transcriptPath = arg("--transcript");
  if (!transcriptPath) throw new Error("用法：pnpm edit:talk-emotion -- --transcript <talk.transcript.json> --out <talk.emotion.json>");
  const transcriptFile = abs(transcriptPath);
  if (!existsSync(transcriptFile)) throw new Error(`逐字稿不存在：${transcriptFile}`);
  const transcript = JSON.parse(readFileSync(transcriptFile, "utf8")) as TalkTranscriptDoc;
  if (transcript.schemaVersion !== "workloom.video-edit/talk-transcript/v1") {
    throw new Error(`逐字稿契约版本不符：${String(transcript.schemaVersion)}（请用 pnpm edit:talk-asr 重新产出）`);
  }
  const outPath = abs(arg("--out", transcriptFile.replace(/\.transcript\.json$/u, ".emotion.json")));

  /** 逐字稿里的标记就是事实源：重跑分析会因浮点/次序差异与产物漂移，这里只重建句子表。 */
  const sentences: TalkSentence[] = transcript.sentences.map((sentence) => ({
    id: sentence.id,
    text: sentence.text,
    start: sentence.start,
    end: sentence.end,
    pauseAfterSeconds: sentence.pauseAfterSeconds ?? null,
    words: sentence.words.map((word) => ({ ...word })),
  }));
  const analysis = analyzeTalkTranscript(sentences);

  let envelope: LoudnessLikePoint[] | undefined;
  const analysisPath = arg("--analysis");
  if (analysisPath) {
    const file = abs(analysisPath);
    if (!existsSync(file)) throw new Error(`信号层解析结果不存在：${file}`);
    const doc = JSON.parse(readFileSync(file, "utf8")) as {
      probe?: { loudness?: { envelope?: Array<{ t?: number; db?: number }> } };
    };
    const points = (doc.probe?.loudness?.envelope ?? [])
      .map((point) => ({ t: Number(point.t ?? 0), db: Number(point.db ?? 0) }))
      .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.db));
    if (points.length > 0) envelope = points;
  }

  let labels: TalkEmotionLabelInput[] = [];
  const labelsPath = arg("--labels");
  if (labelsPath) {
    const file = abs(labelsPath);
    if (!existsSync(file)) throw new Error(`情绪标注不存在：${file}`);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    labels = (Array.isArray(parsed) ? parsed : (parsed as { labels?: unknown[] }).labels ?? [])
      .map((entry) => entry as TalkEmotionLabelInput)
      .filter((entry) => typeof entry?.sentenceId === "string");
    const known = new Set(sentences.map((sentence) => sentence.id));
    const unknown = labels.filter((label) => !known.has(label.sentenceId));
    if (unknown.length > 0) {
      throw new Error(`情绪标注引用了不存在的句：${unknown.map((label) => label.sentenceId).join("、")}`);
    }
  }

  const emotion = buildEmotionCurve(sentences, analysis, {
    ...(envelope ? { envelope } : {}),
    labels,
  });
  const doc = {
    ...emotion,
    source: {
      transcript: transcriptFile,
      transcriptChannel: transcript.backend.channel,
      transcriptPrecision: transcript.backend.precision,
      envelope: envelope ? `${envelope.length} 点（edit:probe）` : null,
      labels: labels.length,
    },
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

  const summary = {
    ok: true,
    output: outPath,
    acoustic: emotion.channel.acoustic,
    semantic: emotion.channel.semantic,
    sentences: emotion.curve.length,
    peaks: emotion.peaks.length,
    peakKinds: emotion.peaks.reduce<Record<string, number>>((acc, peak) => {
      acc[peak.kind] = (acc[peak.kind] ?? 0) + 1;
      return acc;
    }, {}),
    humanness: emotion.humanness,
    paceVariation: emotion.prosody.paceVariation,
    notes: emotion.humanness.notes,
  };
  if (flag("--json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`✓ 情绪画像完成：${summary.sentences} 句 / ${summary.peaks} 个峰值（${emotion.channel.acoustic}+${emotion.channel.semantic}）`);
    console.log(`  活人感 ${emotion.humanness.score}｜语速变异 ${emotion.prosody.paceVariation}｜笑声 ${emotion.humanness.signals.laughter} · 叹气 ${emotion.humanness.signals.sighs} · 自纠 ${emotion.humanness.signals.selfCorrections}`);
    for (const note of emotion.humanness.notes) console.log(`  · ${note}`);
    console.log(`  产物：${outPath}`);
    if (!envelope) console.log("  ⚠ 未提供 --analysis（edit:probe 产物）：能量通道关闭，唤起度只用语速与停顿推算");
    if (labels.length === 0) console.log("  ⚠ 未提供 --labels：效价与情绪词保持 null（不猜）");
  }
}

try {
  main();
} catch (err) {
  console.error(`✗ edit-talk-emotion 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
