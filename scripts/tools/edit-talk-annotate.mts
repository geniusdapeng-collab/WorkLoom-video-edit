#!/usr/bin/env tsx
/**
 * edit-talk-annotate —— 口播点睛层：知识点弹幕 / 贴纸卡 / 章节条（一次产出，供后期工位渲染）。
 *
 * 口播的信息密度靠"说"，但观众的记忆点靠"看"。点睛层做三件事（全部来自逐字稿，不引入素材外事实）：
 *   ① 章节条：话题块 → 章节（保留段才有章节，删掉的块不生成）；
 *   ② 知识点弹幕：金句/数字/结论句 → 顶部弹幕（短句、可扫读），氛围句 → 滚动弹幕；
 *   ③ 贴纸卡：数字卡（"3 个方法"）、清单卡、金句引用卡——都带进出时间，落在字幕安全区之外。
 *
 * 纪律（与 skills/talk-annotation 同口径）：
 *   · 不遮挡：顶部弹幕与贴纸默认避开字幕带与人脸区（渲染工位按安全区放置；本步只产出计划与告警）；
 *   · 不刷屏：默认上限 6 条/分钟，前 2 秒留白（钩子画面必须干净）；
 *   · 不编造：文案逐字取自逐字稿；弹幕不写"逐字稿里没有的数字/结论"；
 *   · 不重复：同一条弹幕只出现一次；与字幕重复的整句不发射（弹幕是补充，不是复读机）。
 *
 * 用法：
 *   pnpm edit:talk-annotate -- --transcript <talk.transcript.json> --cut <talk-cut-list.json>
 *     --timeline <talk.timeline.json> --out-dir <交付目录> [--platform 微信视频号]
 *     [--max-per-minute 6] [--bare-seconds 2] [--json]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  looksLikeTalkInsight, normalizeTalkText, type TalkCutPlan, type TalkTranscriptDoc,
} from "../../packages/video-studio/src/edit/index.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

interface TimelineSegmentLike {
  segmentId: string;
  sourceIn: number;
  sourceOut: number;
  masterIn?: number | null;
  masterOut?: number | null;
}

interface TimelineLike {
  segments: TimelineSegmentLike[];
  target?: { durationSeconds?: number };
}

const round = (value: number, digits = 3): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** 源素材时间 → 成片主轨时间（落在保留段内才返回；被删掉的内容不生成点睛） */
function toMaster(segments: TimelineSegmentLike[], sourceTime: number): number | null {
  let cursor = 0;
  for (const segment of segments) {
    const duration = segment.sourceOut - segment.sourceIn;
    const masterIn = segment.masterIn ?? cursor;
    const masterOut = segment.masterOut ?? masterIn + duration;
    if (sourceTime >= segment.sourceIn - 0.02 && sourceTime <= segment.sourceOut + 0.02) {
      return round(masterIn + Math.max(0, sourceTime - segment.sourceIn));
    }
    cursor = masterOut;
  }
  return null;
}

function main(): void {
  const transcriptPath = arg("--transcript");
  const cutPath = arg("--cut");
  const timelinePath = arg("--timeline");
  const outDirArg = arg("--out-dir");
  if (!transcriptPath || !cutPath || !timelinePath || !outDirArg) {
    throw new Error("用法：pnpm edit:talk-annotate -- --transcript <…> --cut <…> --timeline <…> --out-dir <目录>");
  }
  const transcriptFile = abs(transcriptPath);
  const cutFile = abs(cutPath);
  const timelineFile = abs(timelinePath);
  for (const file of [transcriptFile, cutFile, timelineFile]) {
    if (!existsSync(file)) throw new Error(`输入不存在：${file}`);
  }
  const outDir = abs(outDirArg);
  mkdirSync(outDir, { recursive: true });

  const transcript = JSON.parse(readFileSync(transcriptFile, "utf8")) as TalkTranscriptDoc;
  const plan = JSON.parse(readFileSync(cutFile, "utf8")) as TalkCutPlan;
  const timeline = JSON.parse(readFileSync(timelineFile, "utf8")) as TimelineLike;
  const platform = arg("--platform", "微信视频号");
  const maxPerMinute = Number(arg("--max-per-minute", "6"));
  const bareSeconds = Number(arg("--bare-seconds", "2"));
  const totalSeconds = timeline.segments.reduce((sum, segment) => sum + (segment.sourceOut - segment.sourceIn), 0);
  const allowance = Math.max(1, Math.floor((totalSeconds / 60) * maxPerMinute));

  /** ① 章节：话题块落在保留段内才生成；标题取块标题（≤14 字） */
  const chapters: Array<{ chapterId: string; title: string; start: number; end: number; blockId: string }> = [];
  for (const block of transcript.blocks) {
    const start = toMaster(timeline.segments, block.start);
    const end = toMaster(timeline.segments, Math.max(block.start, block.end - 0.05));
    if (start === null || end === null || end - start < 3) continue;
    chapters.push({
      chapterId: `ch-${String(chapters.length + 1).padStart(2, "0")}`,
      title: block.title,
      start,
      end,
      blockId: block.id,
    });
  }

  /** ② 弹幕：金句/数字 → 顶部知识点；其余强语气句 → 滚动氛围（上限内、去重、前 N 秒留白） */
  const candidates: Array<{ text: string; at: number; mode: "top" | "scroll"; kind: string; reason: string }> = [];
  for (const sentence of transcript.sentences) {
    const master = toMaster(timeline.segments, sentence.start);
    if (master === null || master < bareSeconds) continue;
    const plain = [...normalizeTalkText(sentence.text)];
    if (plain.length < 6) continue;
    const insight = looksLikeTalkInsight(sentence.text);
    const trimmed = plain.slice(0, 14).join("");
    candidates.push({
      text: insight ? trimmed : `${plain.slice(0, 10).join("")}…`,
      at: master,
      mode: insight ? "top" : "scroll",
      kind: insight ? "knowledge" : "ambience",
      reason: insight ? "含数字/结论锚点：适合顶部知识点弹幕" : "口语节奏句：适合滚动氛围弹幕",
    });
  }
  const seen = new Set<string>();
  const danmaku = candidates
    .filter((candidate) => {
      if (seen.has(candidate.text)) return false;
      seen.add(candidate.text);
      /** 与字幕完全一致的整句不发射：弹幕是补充信息，不是复读字幕。 */
      return !transcript.sentences.some((sentence) => normalizeTalkText(sentence.text) === normalizeTalkText(candidate.text));
    })
    .slice(0, allowance)
    .map((candidate, index) => ({
      id: `dk-${String(index + 1).padStart(3, "0")}`,
      at: candidate.at,
      text: candidate.text,
      mode: candidate.mode,
      fontSize: null,
      color: candidate.mode === "top" ? "#FFE9A8" : "#FFFFFF",
      kind: candidate.kind,
      reason: candidate.reason,
    }));

  /** ③ 贴纸卡：数字卡 / 金句卡——落在保留段内，默认避开字幕带（顶部 12%–28% 区域） */
  const stickers: Array<Record<string, unknown>> = [];
  for (const sentence of transcript.sentences) {
    if (!looksLikeTalkInsight(sentence.text)) continue;
    const master = toMaster(timeline.segments, sentence.start);
    if (master === null || master < bareSeconds) continue;
    const text = [...normalizeTalkText(sentence.text)].slice(0, 18).join("");
    const kind = /[0-9０-９]/u.test(sentence.text) ? "number" : "quote";
    stickers.push({
      id: `st-${String(stickers.length + 1).padStart(3, "0")}`,
      kind,
      text,
      start: master,
      end: round(master + 3.2),
      position: kind === "number" ? "top-right" : "top-left",
      avoidSubtitleBand: true,
      note: "贴纸落顶部安全区，避开字幕带与人脸区；时长 3.2s（够读一遍）",
    });
    if (stickers.length >= Math.max(2, Math.floor(allowance / 2))) break;
  }

  const annotation = {
    schema: "workloom.video-edit/talk-annotation/v1",
    platform,
    totalSeconds: round(totalSeconds),
    policy: {
      maxPerMinute,
      allowance,
      bareSeconds,
      note: "前 2 秒留白（钩子画面干净）· 顶部知识点弹幕与贴纸避开字幕带 · 弹幕文案逐字取自逐字稿",
    },
    chapters,
    danmaku,
    stickers,
    warnings: [
      ...(danmaku.length >= allowance ? ["弹幕已达密度上限：更多知识点请做成贴纸或章节，不刷屏"] : []),
      ...(chapters.length === 0 ? ["未生成章节：话题块都被剪掉了或每块不足 3 秒"] : []),
    ],
  };
  const receipt = {
    schema: "workloom.video-edit/talk-annotation-receipt/v1",
    inputs: { transcript: transcriptFile, cut: cutFile, timeline: timelineFile },
    outputs: { annotation: join(outDir, "talk-annotation.json"), danmaku: join(outDir, "danmaku.json"), stickers: join(outDir, "stickers.json"), chapters: join(outDir, "chapters.json") },
    counts: { chapters: chapters.length, danmaku: danmaku.length, stickers: stickers.length },
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(join(outDir, "talk-annotation.json"), `${JSON.stringify(annotation, null, 2)}\n`, "utf8");
  writeFileSync(join(outDir, "danmaku.json"), `${JSON.stringify({
    items: danmaku.map((item) => ({
      text: item.text,
      time: item.at,
      mode: item.mode,
      color: item.color,
    })),
    note: "供 pnpm edit:danmaku -- --items danmaku.json 渲染（滚动/顶部混合，2–4 分道）",
  }, null, 2)}\n`, "utf8");
  writeFileSync(join(outDir, "stickers.json"), `${JSON.stringify({ stickers }, null, 2)}\n`, "utf8");
  writeFileSync(join(outDir, "chapters.json"), `${JSON.stringify({ chapters }, null, 2)}\n`, "utf8");
  writeFileSync(join(outDir, "talk-annotation-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  if (flag("--json")) {
    console.log(JSON.stringify(receipt, null, 2));
  } else {
    console.log(`✓ 点睛层完成：章节 ${chapters.length} · 知识点弹幕 ${danmaku.length}/${allowance}（上限）· 贴纸卡 ${stickers.length}`);
    console.log(`  产物：${outDir}/talk-annotation.json（渲染入口：danmaku.json / stickers.json / chapters.json）`);
    for (const warning of annotation.warnings) console.log(`  ! ${warning}`);
  }
}

try {
  main();
} catch (err) {
  console.error(`✗ edit-talk-annotate 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
