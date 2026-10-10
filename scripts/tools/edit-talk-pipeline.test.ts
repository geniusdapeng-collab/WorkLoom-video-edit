import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  analyzeTalkTranscript, buildEmotionCurve, buildTalkTranscriptDoc, type TalkSentence,
} from "../../packages/video-studio/src/edit/index.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");

/** 口播执行器级回归：走真实 CLI（不依赖 ffmpeg 与 ASR 引擎），覆盖三条关键行为。 */
function runTool(script: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(TSX, [join(REPO_ROOT, "scripts", "tools", script), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

type Part = [text: string, duration: number, gapBefore?: number];

function sentencesFrom(rows: Array<[string, Part[]]>): TalkSentence[] {
  let cursor = 0;
  const sentences = rows.map(([id, parts]) => {
    const words: Array<{ text: string; start: number; end: number }> = [];
    for (const [text, duration, gap] of parts) {
      cursor += gap ?? 0;
      words.push({
        text,
        start: Math.round(cursor * 1000) / 1000,
        end: Math.round((cursor + duration) * 1000) / 1000,
      });
      cursor += duration;
    }
    const first = words[0]!;
    const last = words[words.length - 1]!;
    return {
      id,
      text: parts.map((part) => part[0]).join(""),
      start: first.start,
      end: last.end,
      pauseAfterSeconds: null as number | null,
      words,
    };
  });
  return sentences.map((sentence, index) => {
    const next = sentences[index + 1];
    return { ...sentence, pauseAfterSeconds: next ? Math.max(0, Number((next.start - sentence.end).toFixed(3))) : 0 };
  });
}

function fixture(): { sentences: TalkSentence[]; transcript: Record<string, unknown>; emotion: Record<string, unknown> } {
  const sentences = sentencesFrom([
    ["s01", [["大家好", 0.5], ["嗯", 0.3, 0.1], ["我", 0.2], ["想", 0.2], ["聊", 0.2], ["一个", 0.3], ["事", 0.3]]],
    ["s02", [["就是", 0.3, 1.6], ["口播", 0.35], ["要", 0.2], ["真实", 0.35], ["一点", 0.3]]],
    ["s03", [["我", 0.25, 0.2], ["我", 0.2], ["我", 0.2], ["觉得", 0.3], ["这个", 0.3], ["这个", 0.3], ["问题", 0.35]]],
    ["s04", [["不对", 0.4], ["我是说", 0.5], ["真实", 0.35], ["比", 0.2], ["完美", 0.4], ["好", 0.2]]],
    ["s05", [["记住", 0.4, 1.4], ["三个", 0.3], ["方法", 0.35], ["很", 0.2], ["重要", 0.35]]],
  ]);
  const analysis = analyzeTalkTranscript(sentences);
  const emotion = buildEmotionCurve(sentences, analysis, {
    labels: [{ sentenceId: "s05", label: "笃定", valence: 0.5 }],
  });
  const transcript = buildTalkTranscriptDoc({
    sentences,
    asset: {
      assetId: "talk-fixture",
      sha256: "0".repeat(64),
      path: "",
      /** 素材时长必须覆盖最后一句话（时间轴会做"片段不越界"硬校验）。 */
      durationSeconds: Math.ceil(sentences[sentences.length - 1]!.end) + 1,
      fps: 30,
      language: "zh",
    },
    backend: { channel: "imported", engine: "fixture", precision: "word", engineNote: null },
    analysis,
  }) as unknown as Record<string, unknown>;
  return { sentences, transcript, emotion: emotion as unknown as Record<string, unknown> };
}

function workspace(): { dir: string; transcriptPath: string; emotionPath: string; sourcePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "wl-talk-"));
  mkdirSync(join(dir, "delivery"), { recursive: true });
  const { transcript, emotion } = fixture();
  const transcriptPath = join(dir, "talk.transcript.json");
  const emotionPath = join(dir, "talk.emotion.json");
  const sourcePath = join(dir, "talk-src.mp4");
  writeFileSync(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
  writeFileSync(emotionPath, `${JSON.stringify(emotion, null, 2)}\n`, "utf8");
  /** 口播裁剪执行器只需要素材可读以计算指纹（不调用 ffmpeg），这里放一小段占位字节。 */
  writeFileSync(sourcePath, Buffer.from("fake-video-bytes-for-hash"), "utf8");
  return { dir, transcriptPath, emotionPath, sourcePath };
}

describe("edit-talk 执行器级回归", () => {
  it("词级稿全链路出五件产物，且质检硬项全过", () => {
    const { dir, transcriptPath, emotionPath, sourcePath } = workspace();
    const outDir = join(dir, "delivery");
    const result = runTool("edit-talk-cut.mts", [
      "--transcript", transcriptPath,
      "--emotion", emotionPath,
      "--out-dir", outDir,
      "--source", sourcePath,
      "--target", "12",
    ]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    for (const file of ["talk-cut-list.json", "talk.timeline.json", "talk.captions.json", "talk.srt", "talk-qc.json"]) {
      expect(existsSync(join(outDir, file))).toBe(true);
    }
    const timeline = JSON.parse(readFileSync(join(outDir, "talk.timeline.json"), "utf8")) as {
      sourceGapPolicy?: string;
      segments: Array<{ punchIn?: { scale?: number } | null }>;
    };
    expect(timeline.sourceGapPolicy).toBe("single-take-talking-head");
    expect(timeline.segments.length).toBeGreaterThan(0);
    const qc = JSON.parse(readFileSync(join(outDir, "talk-qc.json"), "utf8")) as {
      ok: boolean;
      checks: Array<{ id: string; hard: boolean; pass: boolean }>;
      metrics: { fillerKeepRate: number; smoothingRisk: number };
    };
    expect(qc.ok).toBe(true);
    expect(qc.checks.filter((check) => check.hard && !check.pass)).toEqual([]);
    expect(qc.metrics.fillerKeepRate).toBeGreaterThan(0);
    expect(qc.metrics.smoothingRisk).toBeGreaterThanOrEqual(0);
  });

  it("句级稿（precision=segment）在未显式放行时 fail-closed", () => {
    const { dir, transcriptPath, emotionPath, sourcePath } = workspace();
    const transcript = JSON.parse(readFileSync(transcriptPath, "utf8")) as { backend: { precision: string } };
    transcript.backend.precision = "segment";
    writeFileSync(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
    const result = runTool("edit-talk-cut.mts", [
      "--transcript", transcriptPath,
      "--emotion", emotionPath,
      "--out-dir", join(dir, "delivery-2"),
      "--source", sourcePath,
    ]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("精度");
    expect(existsSync(join(dir, "delivery-2", "talk.timeline.json"))).toBe(false);
  });

  it("素材不在本地时拒绝出轴（时间轴必须可溯源）", () => {
    const { dir, transcriptPath, emotionPath } = workspace();
    const result = runTool("edit-talk-cut.mts", [
      "--transcript", transcriptPath,
      "--emotion", emotionPath,
      "--out-dir", join(dir, "delivery-3"),
      "--source", join(dir, "missing.mp4"),
    ]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("素材不在本地");
  });
});
