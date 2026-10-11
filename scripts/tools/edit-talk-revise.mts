#!/usr/bin/env tsx
/**
 * edit-talk-revise —— 逐字稿修订（ASR 误识修正 + 断句重切），产出可留痕的"生产校对稿"。
 *
 * 为什么需要它（本机生产实测，2026-10-11）：
 *   · mlx-whisper 会把品牌名与同音词写错（Deepstick→DeepSeek、简映→剪映、速度员工→数字员工、
 *     胶枝相乘→交叉相乘、色别→角色…），而口播管线又要求"字幕逐字来自逐字稿"——
 *     不修，错误会原样进字幕；乱改，则等于篡改原话。所以修订必须是**可留痕、可复核、可回滚**的一步。
 *   · ASR 的断句是按停顿切的，常把一句话切成"半句 + 半句"（如 "…如果是说假" / "如你有一个专业的制作团队"）；
 *     选段（G-TK4）会在这类边界上留下悬空半句。断句重切只挪句子边界，**不改任何词**。
 *
 * 纪律：
 *   ① 只做"逐词同长替换""跨词合并（品牌名）""句边界重切"三类动作，禁止改写、禁止增删词；
 *   ② 每个动作写进修订日志（原词 → 新词、类型、置信度、理由），日志与校对稿一起交付；
 *   ③ 未命中的规则 fail-closed（避免"以为修了其实没修"）。
 *
 * 用法：
 *   pnpm exec tsx scripts/tools/edit-talk-revise.mts --transcript <原始逐字稿.json> \
 *     --out <校对稿.json> --plan <修订计划.json> --log <修订日志.json> [--markdown <修订日志.md>] [--json]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  buildTalkTranscriptDoc, flattenTalkWords, type TalkSentence, type TalkTranscriptDoc,
} from "../../packages/video-studio/src/edit/index.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));
const round = (value: number): number => Math.round(value * 1000) / 1000;

interface ReviseCorrection {
  /** 匹配的连续词序列（逐词相等） */
  pattern: string[];
  /** 同长度逐词替换 */
  replace?: string[];
  /** 跨词合并为一个词（品牌名等，长度可变） */
  merge?: string;
  type: "homophone" | "brand" | "segmentation" | "grammar";
  confidence: "high" | "medium" | "low";
  note: string;
}

interface ReviseSplit {
  sentenceId: string;
  /** 从这一串词开始切出新句（这一串词属于新句） */
  before: string[];
  note: string;
}

interface RevisePlan {
  corrections?: ReviseCorrection[];
  splits?: ReviseSplit[];
  /** 合并相邻两句（只改句子边界，不改词）：用于 ASR 把"假如"切成"假 / 如"这类跨句断裂 */
  joins?: Array<{ sentenceId: string; note: string }>;
}

interface ChangeRecord {
  kind: "correction" | "split";
  sentenceId: string;
  before: string;
  after: string;
  type?: string;
  confidence?: string;
  note?: string;
}

function findPattern(words: Array<{ text: string }>, pattern: string[], from = 0): number {
  for (let index = from; index <= words.length - pattern.length; index += 1) {
    let hit = true;
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (words[index + offset]!.text !== pattern[offset]) {
        hit = false;
        break;
      }
    }
    if (hit) return index;
  }
  return -1;
}

function main(): number {
  const transcriptPath = abs(arg("--transcript"));
  const outPath = abs(arg("--out"));
  const planPath = abs(arg("--plan"));
  const logPath = abs(arg("--log", ""));
  const markdownPath = abs(arg("--markdown", ""));
  if (!transcriptPath || !outPath || !planPath) {
    throw new Error("用法：edit-talk-revise --transcript <in.json> --out <out.json> --plan <plan.json> [--log <log.json>] [--markdown <log.md>]");
  }
  const transcript = JSON.parse(readFileSync(transcriptPath, "utf8")) as TalkTranscriptDoc;
  if (transcript.schemaVersion !== "workloom.video-edit/talk-transcript/v1") {
    throw new Error(`逐字稿契约版本不符：${String(transcript.schemaVersion)}`);
  }
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as RevisePlan;
  const changes: ChangeRecord[] = [];
  const sentences: TalkSentence[] = transcript.sentences.map((sentence) => ({
    id: sentence.id,
    text: sentence.text,
    start: sentence.start,
    end: sentence.end,
    pauseAfterSeconds: sentence.pauseAfterSeconds ?? null,
    words: sentence.words.map((word) => ({ ...word })),
  }));

  // ① 误识修正（先做替换，再做断句）
  for (const correction of plan.corrections ?? []) {
    let applied = 0;
    for (const sentence of sentences) {
      let cursor = 0;
      for (;;) {
        const at = findPattern(sentence.words, correction.pattern, cursor);
        if (at < 0) break;
        const hitWords = sentence.words.slice(at, at + correction.pattern.length);
        const before = hitWords.map((word) => word.text).join("");
        if (correction.merge) {
          const merged = {
            text: correction.merge,
            start: hitWords[0]!.start,
            end: hitWords[hitWords.length - 1]!.end,
          };
          sentence.words.splice(at, correction.pattern.length, merged);
          changes.push({
            kind: "correction",
            sentenceId: sentence.id,
            before,
            after: correction.merge,
            type: correction.type,
            confidence: correction.confidence,
            note: correction.note,
          });
          cursor = at + 1;
        } else {
          const replacement = correction.replace ?? [];
          if (replacement.length !== correction.pattern.length) {
            throw new Error(`replace 必须与 pattern 等长（${correction.pattern.join("")}）：${replacement.join("")}`);
          }
          replacement.forEach((text, offset) => {
            sentence.words[at + offset]!.text = text;
          });
          changes.push({
            kind: "correction",
            sentenceId: sentence.id,
            before,
            after: replacement.join(""),
            type: correction.type,
            confidence: correction.confidence,
            note: correction.note,
          });
          cursor = at + correction.pattern.length;
        }
        applied += 1;
      }
    }
    if (applied === 0) {
      throw new Error(`误识修正未命中（fail-closed）：${correction.pattern.join("")} → ${correction.replace?.join("") ?? correction.merge ?? ""}`);
    }
  }
  for (const sentence of sentences) {
    sentence.text = sentence.words.map((word) => word.text).join("");
    sentence.start = sentence.words[0]!.start;
    sentence.end = sentence.words[sentence.words.length - 1]!.end;
  }

  // ② 断句重切（只挪边界，不改词）
  for (const split of plan.splits ?? []) {
    const index = sentences.findIndex((sentence) => sentence.id === split.sentenceId);
    if (index < 0) throw new Error(`断句规则引用了不存在的句子：${split.sentenceId}`);
    const sentence = sentences[index]!;
    const at = findPattern(sentence.words, split.before);
    if (at <= 0) throw new Error(`断句规则未命中或落在句首（fail-closed）：${split.sentenceId} / ${split.before.join("")}`);
    const headWords = sentence.words.slice(0, at);
    const tailWords = sentence.words.slice(at);
    const pieces: TalkWord[][] = [headWords, tailWords];
    const originalPause = sentence.pauseAfterSeconds ?? null;
    const rebuilt: TalkSentence[] = pieces.map((words, pieceIndex) => {
      const id = pieceIndex === 0 ? sentence.id : `${sentence.id}-p${pieceIndex + 1}`;
      const next = pieces[pieceIndex + 1]?.[0];
      return {
        id,
        text: words.map((word) => word.text).join(""),
        start: words[0]!.start,
        end: words[words.length - 1]!.end,
        pauseAfterSeconds: next ? round(Math.max(0, next.start - words[words.length - 1]!.end)) : originalPause,
        words,
      };
    });
    sentences.splice(index, 1, ...rebuilt);
    for (const piece of rebuilt) {
      changes.push({
        kind: "split",
        sentenceId: piece.id,
        before: sentence.text,
        after: piece.text,
        type: "segmentation",
        confidence: "high",
        note: split.note,
      });
    }
  }

  // ③ 句边界合并（只影响分段，不增删词）
  for (const join of plan.joins ?? []) {
    const index = sentences.findIndex((sentence) => sentence.id === join.sentenceId);
    if (index < 0) throw new Error(`合并规则引用了不存在的句子：${join.sentenceId}`);
    const head = sentences[index]!;
    const tail = sentences[index + 1];
    if (!tail) throw new Error(`合并规则的下一句不存在：${join.sentenceId}`);
    const merged: TalkSentence = {
      id: head.id,
      text: head.text + tail.text,
      start: head.start,
      end: tail.end,
      pauseAfterSeconds: tail.pauseAfterSeconds ?? null,
      words: [...head.words, ...tail.words],
    };
    sentences.splice(index, 2, merged);
    changes.push({
      kind: "split",
      sentenceId: merged.id,
      before: `${head.text} ｜ ${tail.text}`,
      after: merged.text,
      type: "segmentation",
      confidence: "high",
      note: join.note,
    });
  }

  const doc = buildTalkTranscriptDoc({
    sentences,
    asset: transcript.asset,
    backend: transcript.backend,
  });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  const summary = {
    schema: "workloom.video-edit/talk-revise-log/v1",
    source: transcriptPath,
    output: outPath,
    plan: planPath,
    generatedAt: new Date().toISOString(),
    counts: {
      corrections: changes.filter((change) => change.kind === "correction").length,
      splits: changes.filter((change) => change.kind === "split" && change.sentenceId.includes("-p")).length,
      sentencesBefore: transcript.sentences.length,
      sentencesAfter: doc.sentences.length,
      wordsBefore: flattenTalkWords(transcript.sentences).length,
      wordsAfter: doc.words.length,
    },
    changes,
  };
  if (logPath) {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }
  if (markdownPath) {
    const lines = [
      "# 逐字稿修订日志（ASR 误识修正 + 断句重切）",
      "",
      `> 原始稿：\`${transcriptPath}\``,
      `> 校对稿：\`${outPath}\``,
      `> 词数：${summary.counts.wordsBefore} → ${summary.counts.wordsAfter}（不做增删，只做同长替换与品牌名合并）`,
      "",
      "| # | 类型 | 句子 | 原文 | 改后 | 置信度 | 说明 |",
      "|---|---|---|---|---|---|---|",
      ...changes.map((change, index) =>
        `| ${index + 1} | ${change.kind === "split" ? "断句" : change.type ?? ""} | ${change.sentenceId} | ${change.before} | ${change.after} | ${change.confidence ?? ""} | ${(change.note ?? "").replace(/\|/gu, "/")} |`),
      "",
    ];
    mkdirSync(dirname(markdownPath), { recursive: true });
    writeFileSync(markdownPath, `${lines.join("\n")}\n`, "utf8");
  }
  console.log(JSON.stringify({
    ok: true,
    out: outPath,
    counts: summary.counts,
    corrections: summary.counts.corrections,
    splits: summary.counts.splits,
  }, null, flag("--json") ? 2 : 0));
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(`✗ edit-talk-revise 失败：${(error as Error).message}`);
  process.exit(1);
}
