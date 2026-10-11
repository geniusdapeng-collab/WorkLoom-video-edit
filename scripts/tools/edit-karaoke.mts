#!/usr/bin/env tsx
/**
 * edit-karaoke —— 关键词"逐字扫过"字幕（卡拉OK）：把词级逐字稿的时间真正用上。
 *
 * 为什么值得单独一步：口播知识视频里"重点字"必须自己跳出来（放大/变色/扫过），
 * 否则观众的眼睛没有落点。`subtitle-bridge` 已有 `renderKaraoke`（`\kf` 逐字扫过），
 * 但需要**真实的词级时间**——字幕是成片主轨时间，逐字稿是源素材时间，本执行器负责两者换算：
 *   主轨窗口 → 时间轴段映射 → 源素材窗口 → 取该窗口内的词 → 再映射回主轨时间。
 *
 * 用法：
 *   pnpm edit:karaoke -- --input <成片.mp4> --srt <字幕.srt> --timeline <timeline.json> \
 *     --transcript <校对稿.json> --out <输出.mp4> [--platform 抖音] [--highlight "#FFE066"] [--json]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { assistToSeconds, parseSrt, renderKaraoke } from "../../bundles/ai-video/connectors/subtitle-bridge/core.mjs";
import { resolveBinaries } from "../../bundles/ai-video/connectors/post-bridge/core.mjs";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

interface TimelineSegment { segmentId: string; masterIn: number; masterOut: number; sourceIn: number; sourceOut: number }
interface Word { text: string; start: number; end: number }

/** 源时间 → 主轨时间（落在片段外返回 null，避免"凭空造时间"） */
function sourceToMaster(segments: TimelineSegment[], time: number): number | null {
  for (const segment of segments) {
    if (time >= segment.sourceIn - 0.02 && time <= segment.sourceOut + 0.02) {
      return segment.masterIn + (time - segment.sourceIn);
    }
  }
  return null;
}

try {
  const inputPath = abs(arg("--input"));
  const srtPath = abs(arg("--srt"));
  const timelinePath = abs(arg("--timeline"));
  const transcriptPath = abs(arg("--transcript"));
  const outPath = abs(arg("--out"));
  const platform = arg("--platform", "抖音");
  const highlight = arg("--highlight", "#FFE066");
  for (const [label, file] of [["输入成片", inputPath], ["字幕", srtPath], ["时间轴", timelinePath], ["逐字稿", transcriptPath]] as const) {
    if (!existsSync(file)) throw new Error(`${label}不存在：${file}`);
  }
  const cues = parseSrt(readFileSync(srtPath, "utf8")) as Array<{ index?: number; text: string; start: number; end: number }>;
  if (!Array.isArray(cues) || cues.length === 0) throw new Error("字幕为空：卡拉OK 必须有字幕条");
  const timeline = JSON.parse(readFileSync(timelinePath, "utf8")) as { segments: TimelineSegment[] };
  if (!Array.isArray(timeline.segments) || timeline.segments.length === 0) throw new Error("时间轴没有片段");
  const transcript = JSON.parse(readFileSync(transcriptPath, "utf8")) as {
    sentences: Array<{ words: Word[] }>;
  };
  const words: Word[] = transcript.sentences.flatMap((sentence) => sentence.words ?? []);
  if (words.length === 0) throw new Error("逐字稿没有词级时间");

  /**
   * parseSrt 给的是 ASS 时间串（"0:00:00.00"）而不是秒数：直接参与比较会得到 NaN，
   * 让所有片段都命中、所有词都重复进同一句（本机实测：一条字幕被塞进 11676 个词）。
   * 这里统一换算成秒再算窗口。
   */
  const toSeconds = (value: unknown, fallback: number): number => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    try {
      const seconds = assistToSeconds(value as never);
      return Number.isFinite(seconds) ? seconds : fallback;
    } catch {
      return fallback;
    }
  };
  const timings: Word[][] = cues.map((cue) => {
    const cueStart = toSeconds(cue.start, 0);
    const cueEnd = toSeconds(cue.end, cueStart + 1);
    const rows: Word[] = [];
    for (const segment of timeline.segments) {
      const from = Math.max(cueStart, segment.masterIn);
      const to = Math.min(cueEnd, segment.masterOut);
      if (to - from <= 0.02) continue;
      const sourceFrom = segment.sourceIn + (from - segment.masterIn);
      const sourceTo = segment.sourceIn + (to - segment.masterIn);
      for (const word of words) {
        const mid = (word.start + word.end) / 2;
        if (mid < sourceFrom - 0.02 || mid > sourceTo + 0.02) continue;
        const start = sourceToMaster(timeline.segments, word.start);
        const end = sourceToMaster(timeline.segments, word.end);
        if (start === null || end === null) continue;
        rows.push({ text: word.text, start: Number(start.toFixed(3)), end: Number(Math.max(end, start + 0.02).toFixed(3)) });
      }
    }
    /**
     * 卡拉OK的逐字扫过必须**铺满整条字幕**：跳切留下的空隙若原样交给渲染器，
     * 各词时长之和会小于字幕时长（实测被复检判 timing_sum_ok 失败）。
     * 做法：把每个词的结束对齐到下一个词的开始，首词对齐字幕起点、末词对齐字幕终点。
     */
    const sorted = rows.sort((a, b) => a.start - b.start);
    return sorted.map((word, index) => {
      const next = sorted[index + 1];
      const start = index === 0 ? Math.min(word.start, cueStart) : word.start;
      const end = next ? Math.max(next.start, start + 0.02) : Math.max(cueEnd, start + 0.02);
      return { text: word.text, start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) };
    });
  });
  const mapped = timings.filter((rows) => rows.length > 0).length;
  if (mapped === 0) throw new Error("字幕窗口与逐字稿对不上：卡拉OK 需要词级时间（检查 timeline/transcript 是否为同一条素材）");

  mkdirSync(dirname(outPath), { recursive: true });
  const report = await renderKaraoke({
    input: inputPath,
    output: outPath,
    cues,
    timings,
    platform,
    highlightColour: highlight,
    brief: { 平台: platform },
    bins: resolveBinaries(process.env),
  });
  const receipt = {
    schemaVersion: "workloom.video-edit/karaoke-receipt/v1",
    input: inputPath,
    output: { path: outPath, sha256: createHash("sha256").update(readFileSync(outPath)).digest("hex") },
    cues: cues.length,
    cuesWithWordTimings: mapped,
    highlightColour: highlight,
    platform,
    engine: report,
    generatedAt: new Date().toISOString(),
  };
  if (flag("--json")) console.log(JSON.stringify(receipt, null, 2));
  else {
    console.log(`✓ 卡拉OK字幕完成：${cues.length} 条（${mapped} 条用真实词级时间）`);
    console.log(`  产物：${outPath}`);
  }
} catch (error) {
  console.error(`✗ edit-karaoke 失败：${(error as Error).message}`);
  process.exit(1);
}
