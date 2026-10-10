#!/usr/bin/env tsx
/**
 * edit-talk-asr —— 口播逐字稿（ASR 主通道 + 导入通道），口播精剪的第一步。
 *
 * 为什么单独一个执行器：口播的第一事实源是"逐字稿"——字幕、剪取决策、质检都要用它。
 * 逐字稿一旦不可信（时间码漂、错字、润色），后面每一层都会错。所以这一步只做三件事：
 *   ① 拿到**词级时间戳**（精度如实标注，句级降档必须显式声明）；
 *   ② 保留口语原样（语气词、重复、口误都在，不做"书面化"）；
 *   ③ 产出标记（语气词/停顿/重复/自纠/话题块）与统计，供剪取决策消费。
 *
 * 三条通道（按顺序尝试，全部失败即 fail-closed）：
 *   A. `--transcript <file>`：导入已有逐字稿（JSON / SRT / VTT）——人工校对稿、外部工具稿；
 *   B. 本机 mlx-whisper：`python3 scripts/tools/talkcraft-asr-words.py`（Apple Silicon 词级时间戳）；
 *   C. 本机引擎 HTTP：OpenAI 兼容 `/v1/audio/transcriptions`（`--engine <url|auto>`）。
 *
 * 精度纪律（重要）：`precision != word` 时，**剪取决策不得在词内切分**——`edit-talk-cut` 会拒绝
 * 没有 `--allow-segment-precision` 的句级稿，避免"按估算时间码切进词里"。
 *
 * 用法：
 *   pnpm edit:talk-asr -- --input <口播素材.mp4> --out outputs/edit/talk/<id>.transcript.json
 *     [--transcript 已有逐字稿.json|字幕.srt|字幕.vtt] [--engine local|auto|<url>]
 *     [--model mlx-community/whisper-large-v3-turbo] [--language zh] [--json]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  analyzeTalkTranscript, buildTalkTranscriptDoc, splitTalkSentences, type TalkSentence, type TalkWord,
  type TalkTranscriptDoc,
} from "../../packages/video-studio/src/edit/index.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const FFMPEG = process.env.WL_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.WL_FFPROBE ?? "ffprobe";
const PYTHON = process.env.WL_PYTHON ?? "python3";

const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

function run(bin: string, args: string[], options: { allowFailure?: boolean } = {}): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw new Error(`${bin} 启动失败：${result.error.message}`);
  const status = result.status ?? -1;
  if (status !== 0 && !options.allowFailure) {
    const detail = (result.stderr ?? "").split("\n").slice(-6).join(" | ");
    throw new Error(`${bin} 执行失败（退出码 ${status}）：${detail}`);
  }
  return { status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function sha256File(file: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

/** ffprobe 规格（时长/帧率）；失败时返回 null 而不是编造数字 */
function probeMedia(file: string): { durationSeconds: number | null; fps: number | null } {
  const out = run(FFPROBE, [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type,r_frame_rate",
    "-of", "json", file,
  ], { allowFailure: true });
  if (out.status !== 0) return { durationSeconds: null, fps: null };
  try {
    const parsed = JSON.parse(out.stdout) as {
      format?: { duration?: string };
      streams?: Array<{ codec_type?: string; r_frame_rate?: string }>;
    };
    const duration = Number(parsed.format?.duration ?? NaN);
    const video = (parsed.streams ?? []).find((stream) => stream.codec_type === "video");
    const rate = (video?.r_frame_rate ?? "").split("/");
    const fps = rate.length === 2 && Number(rate[1]) > 0 ? Number(rate[0]) / Number(rate[1]) : NaN;
    return {
      durationSeconds: Number.isFinite(duration) ? Number(duration.toFixed(3)) : null,
      fps: Number.isFinite(fps) && fps > 0 ? Number(fps.toFixed(3)) : null,
    };
  } catch {
    return { durationSeconds: null, fps: null };
  }
}

const srtTime = (value: string): number => {
  const match = /(\d+):(\d+):(\d+)[,.](\d+)/u.exec(value.trim());
  if (!match) throw new Error(`SRT/VTT 时间码无法解析：${value}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
};

/**
 * 解析 SRT/VTT 逐字稿。
 * 注意：字幕文件**没有词级时间戳**，这里把每行按字符均匀铺在该条时间码上并标 `precision=segment`；
 * 下游（剪取决策）只有在显式 `--allow-segment-precision` 时才允许消费，防止"按估算码切进词里"。
 */
function parseSubtitleTranscript(text: string): { sentences: TalkSentence[]; precision: "segment" } {
  const blocks = text.replace(/\r\n/gu, "\n").split(/\n{2,}/u);
  const sentences: TalkSentence[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim().length > 0 && !/^WEBVTT/u.test(line.trim()));
    if (lines.length === 0) continue;
    const index = lines.findIndex((line) => line.includes("-->"));
    if (index < 0) continue;
    const [from, to] = lines[index]!.split("-->").map((part) => part.trim().split(" ")[0]!);
    const start = srtTime(from!);
    const end = srtTime(to!);
    const content = lines.slice(index + 1).join("").replace(/<[^>]+>/gu, "").trim();
    if (!content) continue;
    const chars = [...content];
    const step = (end - start) / Math.max(1, chars.length);
    const words: TalkWord[] = chars.map((char, charIndex) => ({
      text: char,
      start: Number((start + charIndex * step).toFixed(3)),
      end: Number((start + (charIndex + 1) * step).toFixed(3)),
    }));
    sentences.push({
      id: `s${String(sentences.length + 1).padStart(3, "0")}`,
      text: content,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      pauseAfterSeconds: null,
      words,
    });
  }
  if (sentences.length === 0) throw new Error("字幕文件里没有解析出任何字幕条");
  return {
    sentences: sentences.map((sentence, index) => {
      const next = sentences[index + 1];
      return { ...sentence, pauseAfterSeconds: next ? Math.max(0, Number((next.start - sentence.end).toFixed(3))) : 0 };
    }),
    precision: "segment",
  };
}

/** 解析 JSON 逐字稿：支持 {sentences:[…]} / {words:[…]} / {segments:[…]}（OpenAI verbose_json 形态） */
function parseJsonTranscript(text: string): { sentences: TalkSentence[]; precision: "word" | "segment"; engineNote: string | null } {
  const doc = JSON.parse(text) as {
    sentences?: Array<{ id?: string; text?: string; start?: number; end?: number; words?: Array<{ text?: string; start?: number; end?: number }> }>;
    words?: Array<{ text?: string; start?: number; end?: number }>;
    segments?: Array<{ text?: string; start?: number; end?: number; words?: Array<{ word?: string; text?: string; start?: number; end?: number }> }>;
  };
  if (Array.isArray(doc.sentences) && doc.sentences.length > 0) {
    const sentences: TalkSentence[] = doc.sentences.map((sentence, index) => ({
      id: sentence.id ?? `s${String(index + 1).padStart(3, "0")}`,
      text: String(sentence.text ?? "").trim(),
      start: Number(sentence.start ?? 0),
      end: Number(sentence.end ?? 0),
      pauseAfterSeconds: null,
      words: (sentence.words ?? []).map((word) => ({
        text: String(word.text ?? "").trim(),
        start: Number(word.start ?? 0),
        end: Number(word.end ?? 0),
      })),
    }));
    const hasWords = sentences.some((sentence) => sentence.words.length > 0);
    if (!hasWords) {
      /** 只有句级时间戳时按字符均匀铺开，精度如实降档。 */
      const segmentDoc = parseSubtitleTranscript(sentences
        .map((sentence, index) =>
          `${index + 1}\n${new Date(sentence.start * 1000).toISOString().slice(11, 23).replace(".", ",")} --> ${
            new Date(sentence.end * 1000).toISOString().slice(11, 23).replace(".", ",")}\n${sentence.text}\n`)
        .join("\n"));
      return { sentences: segmentDoc.sentences, precision: "segment", engineNote: "句级稿按字符均匀铺开（估算词级）" };
    }
    const withPauses = sentences.map((sentence, index) => {
      const next = sentences[index + 1];
      return { ...sentence, pauseAfterSeconds: next ? Number(Math.max(0, next.start - sentence.end).toFixed(3)) : 0 };
    });
    return { sentences: withPauses, precision: "word", engineNote: null };
  }
  if (Array.isArray(doc.words) && doc.words.length > 0) {
    const words: TalkWord[] = doc.words.map((word) => ({
      text: String(word.text ?? "").trim(),
      start: Number(word.start ?? 0),
      end: Number(word.end ?? 0),
    }));
    return { sentences: splitTalkSentences(words), precision: "word", engineNote: null };
  }
  if (Array.isArray(doc.segments) && doc.segments.length > 0) {
    const words: TalkWord[] = [];
    for (const segment of doc.segments) {
      for (const word of segment.words ?? []) {
        words.push({
          text: String(word.word ?? word.text ?? "").trim(),
          start: Number(word.start ?? segment.start ?? 0),
          end: Number(word.end ?? segment.end ?? 0),
        });
      }
    }
    if (words.length > 0) return { sentences: splitTalkSentences(words), precision: "word", engineNote: null };
    const subtitle = doc.segments
      .map((segment, index) => {
        const from = new Date(Number(segment.start ?? 0) * 1000).toISOString().slice(11, 23).replace(".", ",");
        const to = new Date(Number(segment.end ?? 0) * 1000).toISOString().slice(11, 23).replace(".", ",");
        return `${index + 1}\n${from} --> ${to}\n${String(segment.text ?? "").trim()}\n`;
      })
      .join("\n");
    const parsed = parseSubtitleTranscript(subtitle);
    return { sentences: parsed.sentences, precision: "segment", engineNote: "引擎只返回句级时间戳" };
  }
  throw new Error("逐字稿 JSON 里既没有 sentences，也没有 words/segments");
}

/** 本机 mlx-whisper 是否可用（探测一次；不可用就换通道，不在这里装包） */
function localAsrAvailable(): boolean {
  const probe = run(PYTHON, ["-c", "import mlx_whisper"], { allowFailure: true });
  return probe.status === 0;
}

function transcribeLocal(wav: string, outJson: string, model: string, language: string): { sentences: TalkSentence[]; precision: "word"; engine: string } {
  const script = join(REPO_ROOT, "scripts", "tools", "talkcraft-asr-words.py");
  if (!existsSync(script)) throw new Error(`缺少词级转写脚本：${script}`);
  run(PYTHON, [script, wav, outJson, "--model", model, "--language", language]);
  const parsed = JSON.parse(readFileSync(outJson, "utf8")) as {
    words?: Array<{ text?: string; start?: number; end?: number }>;
    precision?: string;
    backend?: string;
  };
  const words: TalkWord[] = (parsed.words ?? []).map((word) => ({
    text: String(word.text ?? "").trim(),
    start: Number(word.start ?? 0),
    end: Number(word.end ?? 0),
  })).filter((word) => word.text.length > 0);
  if (words.length === 0) throw new Error("mlx-whisper 没有产出词级时间戳");
  return { sentences: splitTalkSentences(words), precision: "word", engine: `${parsed.backend ?? "mlx-whisper"}@${model}` };
}

async function transcribeEngine(wav: string, engineUrl: string, model: string, language: string): Promise<{ sentences: TalkSentence[]; precision: "word" | "segment"; engine: string; note: string | null }> {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(wav)) chunks.push(chunk as Buffer);
  const form = new FormData();
  form.append("file", new Blob([Buffer.concat(chunks)], { type: "audio/wav" }), "audio.wav");
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("language", language);
  const response = await fetch(`${engineUrl.replace(/\/$/u, "")}/v1/audio/transcriptions`, { method: "POST", body: form });
  if (!response.ok) throw new Error(`ASR 引擎返回 ${response.status}`);
  const parsed = await response.json() as unknown;
  const result = parseJsonTranscript(JSON.stringify(parsed));
  return { sentences: result.sentences, precision: result.precision, engine: `${model}@${engineUrl}`, note: result.engineNote };
}

async function main(): Promise<void> {
  const input = arg("--input");
  const importPath = arg("--transcript");
  if (!input && !importPath) {
    throw new Error("用法：pnpm edit:talk-asr -- --input <口播素材> --out <transcript.json>（或 --transcript 导入已有稿）");
  }
  const inputPath = input ? abs(input) : null;
  if (inputPath && !existsSync(inputPath)) throw new Error(`素材不存在：${inputPath}`);
  const outPath = abs(arg("--out", `outputs/edit/talk/${inputPath ? createHash("sha256").update(inputPath).digest("hex").slice(0, 12) : "imported"}.transcript.json`));
  const language = arg("--language", "zh");
  const model = arg("--model", process.env.WL_TALK_ASR_MODEL ?? "mlx-community/whisper-large-v3-turbo");
  const engineArg = arg("--engine", "auto");
  mkdirSync(dirname(outPath), { recursive: true });

  let sentences: TalkSentence[];
  let precision: "word" | "segment" | "none" = "none";
  let channel: TalkTranscriptDoc["backend"]["channel"];
  let engine: string | null = null;
  let engineNote: string | null = null;

  if (importPath) {
    const file = abs(importPath);
    if (!existsSync(file)) throw new Error(`逐字稿不存在：${file}`);
    const text = readFileSync(file, "utf8");
    if (/\.(srt|vtt)$/iu.test(file) || /\d+:\d+:\d+[,.]\d+\s*-->/u.test(text.slice(0, 4000))) {
      const parsed = parseSubtitleTranscript(text);
      sentences = parsed.sentences;
      precision = parsed.precision;
      engineNote = "导入字幕稿：无词级时间戳（按字符均匀估算）";
    } else {
      const parsed = parseJsonTranscript(text);
      sentences = parsed.sentences;
      precision = parsed.precision;
      engineNote = parsed.engineNote;
    }
    channel = "imported";
    engine = "imported";
  } else {
    if (!inputPath) throw new Error("缺少 --input");
    const tempDir = join(dirname(outPath), ".asr-tmp");
    mkdirSync(tempDir, { recursive: true });
    const wav = join(tempDir, `${createHash("sha256").update(inputPath).digest("hex").slice(0, 12)}.wav`);
    run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
    const failures: string[] = [];
    const engineUrl = engineArg === "auto" ? (process.env.WL_TALK_ASR_ENGINE_URL ?? process.env.WL_ASR_ENGINE_URL ?? "") : engineArg;
    const preferEngine = engineArg !== "local" && engineUrl.length > 0;
    if (!preferEngine && localAsrAvailable()) {
      try {
        const local = transcribeLocal(wav, join(tempDir, "local-words.json"), model, language);
        sentences = local.sentences;
        precision = local.precision;
        channel = "local-mlx";
        engine = local.engine;
      } catch (err) {
        failures.push(`本机 mlx-whisper：${err instanceof Error ? err.message : String(err)}`);
        sentences = [];
      }
    } else if (!preferEngine) {
      failures.push("本机 mlx-whisper：未安装（pip install mlx-whisper 或用 --engine 指向本机引擎）");
      sentences = [];
    } else {
      sentences = [];
    }
    if (sentences.length === 0 && engineUrl.length > 0) {
      try {
        const remote = await transcribeEngine(wav, engineUrl, model, language);
        sentences = remote.sentences;
        precision = remote.precision;
        channel = "engine-http";
        engine = remote.engine;
        engineNote = remote.note;
      } catch (err) {
        failures.push(`引擎通道 ${engineUrl}：${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (sentences.length === 0) {
      failures.push("引擎通道：未配置（--engine <url> 或 WL_TALK_ASR_ENGINE_URL）");
    }
    if (sentences.length === 0) {
      throw new Error([
        "三条 ASR 通道都不可用，逐字稿无法产出（fail-closed，不编造时间码）：",
        ...failures.map((failure) => `  - ${failure}`),
        "可选替代：① pip install mlx-whisper；② --engine http://127.0.0.1:8099；③ --transcript 导入人工校对稿。",
      ].join("\n"));
    }
  }

  const media = inputPath ? probeMedia(inputPath) : { durationSeconds: null, fps: null };
  const sha256 = inputPath ? await sha256File(inputPath) : "0".repeat(64);
  const analysis = analyzeTalkTranscript(sentences);
  const doc = buildTalkTranscriptDoc({
    sentences,
    asset: {
      assetId: `talk-${sha256.slice(0, 12)}`,
      sha256,
      path: inputPath ?? abs(importPath),
      durationSeconds: media.durationSeconds,
      fps: media.fps,
      language,
    },
    backend: { channel, engine, precision, engineNote },
    analysis,
  });
  writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

  const summary = {
    ok: true,
    output: outPath,
    channel,
    engine,
    precision,
    sentences: sentences.length,
    words: doc.words.length,
    fillers: analysis.fillers.length,
    pauses: analysis.pauses.length,
    repetitions: analysis.repetitions.length,
    selfCorrections: analysis.selfCorrections.length,
    blocks: analysis.blocks.length,
    stats: analysis.stats,
    engineNote,
  };
  if (flag("--json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`✓ 逐字稿完成：${summary.sentences} 句 / ${summary.words} 词（${channel}，精度 ${precision}）`);
    console.log(`  语气词 ${summary.fillers} · 停顿 ${summary.pauses} · 重复 ${summary.repetitions} · 自纠 ${summary.selfCorrections} · 话题块 ${summary.blocks}`);
    console.log(`  有效语速 ${analysis.stats.wpm} 字/分，停顿共 ${analysis.stats.pauseSeconds}s（其中死停 ${analysis.stats.deadAirSeconds}s）`);
    console.log(`  产物：${outPath}`);
    if (precision !== "word") console.log("  ⚠ 精度非词级：剪取决策需要 --allow-segment-precision 才能继续（按估算码切片会切进词里）");
  }
}

main().catch((err) => {
  console.error(`✗ edit-talk-asr 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
