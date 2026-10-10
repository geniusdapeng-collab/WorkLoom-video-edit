#!/usr/bin/env tsx
/**
 * edit-probe —— 视频AI剪辑管线的信号层解析器（确定性、零模型成本）
 *
 * 干什么：把一条视频素材变成 footage-analysis 契约里的"可解释骨架"——
 *   · 媒体规格（时长/帧率/画幅/音轨）+ 内容指纹
 *   · 镜头边界（ffmpeg 内容感知检测，帧级 in/out）
 *   · 静音/停顿（供切点与字幕使用）
 *   · 响度包络与峰值时刻（供高光与卡点使用）
 *   · 峰值电平（mean/max dB）
 *   · 人声转写（`--asr`：**兜底通道**，本机 mlx-audio/whisper 引擎，离线）→ probe.speech（如实标注 channel=fallback）
 *   · 画面文字（`--ocr`：**兜底通道**，本机 Vision OCR，离线）→ probe.onScreenText（channel=fallback）
 *   · 节拍与节拍网格（本地自相关估计）→ probe.music.bpm/beatGrid；环境音画像 → probe.ambience
 *
 * 通道纪律（产品口径）：画面文字与人声的**主通道是多模态模型自己在理解阶段读/听**；
 * 本文件的 `--asr` / `--ocr` 只是"没有模型能力时的兜底"，默认关闭，且产出必须标 `channel=fallback`。
 * 不干什么：不做语义理解、不做审美判断，也不在缺通道时编数据（缺就写 unavailable/skipped）。
 *
 * 用法：
 *   pnpm edit:probe -- --input <素材> --out work/edit/<id>.analysis.json [--source-kind real-shot]
 *                    [--scene-threshold 0.3] [--bucket 0.25] [--scale 640]
 *                    [--asr off|auto|<url>] [--asr-model <hf repo>] [--ocr] [--ocr-fps 0.5] [--json]
 *
 * `--scale`：场景检测前先缩到该宽度（默认 640；4K 原片必须降采样，否则解码慢一个数量级）。
 *            切点时间戳与分辨率无关——缩放只影响检测速度，不影响时间码。
 *
 * 失败语义（fail-closed）：缺 ffmpeg/ffprobe、素材不可读、无视频流、时长不可解析 → 直接报错退出，
 * 不产出"看起来成功"的空壳文件。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  buildFootageProbe, deriveAmbienceMetrics, estimateTempo, normalizeAsrResponse, parseFfprobeJson,
  parseOcrJsonl, parseRmsEnvelope, parseSceneCuts, parseSilences, parseVolumeDetect,
} from "../../packages/video-studio/src/edit/index.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const FFMPEG = process.env.WL_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.WL_FFPROBE ?? "ffprobe";

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const flag = (name: string) => process.argv.includes(name);
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

/**
 * 跑外部命令：非零退出即抛错，并把 stderr 尾部带出来（便于定位是"缺工具"还是"文件坏"）。
 *
 * 为什么用 spawnSync 而不是 execFileSync：ffmpeg 的**分析日志全部在 stderr**，而 execFileSync
 * 在命令成功时只回传 stdout、把 stderr 丢掉（失败才挂在 error 上）——用它会得到"跑成功但解析为空"
 * 的假成功（本文件初版就踩过：镜头数恒为 1、响度包络恒为空）。
 */
function run(bin: string, args: string[], options: { allowFailure?: boolean } = {}): { stdout: string; stderr: string } {
  const result = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw new Error(`${bin} 启动失败：${result.error.message}`);
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (!options.allowFailure && result.status !== 0) {
    const detail = (stderr || `退出码 ${String(result.status)}`).split("\n").slice(-6).join(" | ");
    throw new Error(`${bin} 执行失败：${detail}`);
  }
  return { stdout, stderr };
}

function assertAvailable(bin: string): void {
  try {
    execFileSync(bin, ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error(`找不到可用的 ${bin}；请安装 ffmpeg 或用 WL_FFMPEG/WL_FFPROBE 指定路径（视频剪线必需）`);
  }
}

async function sha256File(file: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

/** 临时文件用短指纹（不给中间产物留下完整路径依赖） */
function sha256ForTemp(file: string): string {
  return createHash("sha256").update(file).digest("hex").slice(0, 12);
}

/** 读成 fetch 可用的 Blob（Node 18+ 原生 FormData/Blob，避免额外依赖） */
async function readFileAsBlob(file: string): Promise<Blob> {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(file)) chunks.push(chunk as Buffer);
  return new Blob([Buffer.concat(chunks)], { type: "audio/wav" });
}

/**
 * 确保离屏 OCR 二进制可用：
 *   · `WL_VISION_OCR` 指向现成二进制时直接用；
 *   · 否则在 macOS 上用 swiftc 把 `scripts/tools/vision-ocr.swift` 编到 `~/.workloom-edit/bin/`；
 *   · 非 macOS / 缺 swiftc / 编译失败 → 返回不可用原因（由调用方写进 coverage.ocr，不崩整条解析）。
 */
function ensureOcrBinary(): { path: string } | { reason: string } {
  const explicit = process.env.WL_VISION_OCR?.trim();
  if (explicit && existsSync(explicit)) return { path: explicit };
  if (process.platform !== "darwin") return { reason: "画面文字提取目前仅 macOS（Apple Vision）可用" };
  const target = join(homedir(), ".workloom-edit", "bin", "vision-ocr");
  if (existsSync(target)) return { path: target };
  const source = join(REPO_ROOT, "scripts", "tools", "vision-ocr.swift");
  if (!existsSync(source)) return { reason: `缺少 OCR 源码：${source}` };
  try {
    mkdirSync(dirname(target), { recursive: true });
    execFileSync("swiftc", ["-O", source, "-o", target], { stdio: ["ignore", "pipe", "pipe"] });
    return existsSync(target) ? { path: target } : { reason: "swiftc 编译后未产出二进制" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { reason: `vision-ocr 编译失败：${detail.split("\n").slice(-2).join(" | ")}` };
  }
}

async function main(): Promise<void> {
  const input = arg("--input");
  if (!input) throw new Error("用法：pnpm edit:probe -- --input <素材> --out <analysis.json>");
  const inputPath = abs(input);
  if (!existsSync(inputPath)) throw new Error(`素材不存在：${inputPath}`);
  const outPath = abs(arg("--out", `work/edit/${createHash("sha256").update(inputPath).digest("hex").slice(0, 12)}.analysis.json`));
  const sceneThreshold = Number(arg("--scene-threshold", "0.3"));
  const bucketSeconds = Number(arg("--bucket", "0.25"));
  const sceneScaleWidth = Number(arg("--scale", "640"));
  const asrMode = arg("--asr", "off");                 // off | auto | http(s)://…
  const asrModel = arg("--asr-model", "mlx-community/whisper-large-v3-turbo");
  const asrLanguage = arg("--asr-language", "zh");
  const wantOcr = flag("--ocr");
  const ocrFps = Number(arg("--ocr-fps", "0.5"));
  const sourceKind = arg("--source-kind", "real-shot");
  if (!Number.isFinite(sceneThreshold) || sceneThreshold <= 0 || sceneThreshold >= 1) throw new Error("--scene-threshold 必须落在 (0,1)");
  if (!Number.isFinite(sceneScaleWidth) || sceneScaleWidth < 160 || sceneScaleWidth > 3840) throw new Error("--scale 必须是 160–3840 之间的宽度");
  if (wantOcr && (!Number.isFinite(ocrFps) || ocrFps <= 0 || ocrFps > 5)) throw new Error("--ocr-fps 必须落在 (0,5]");

  assertAvailable(FFPROBE);
  assertAvailable(FFMPEG);

  const probeJson = run(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration:stream=index,codec_type,width,height,r_frame_rate,sample_rate,channels",
    "-of", "json", inputPath,
  ]).stdout;
  const media = parseFfprobeJson(probeJson);

  const sceneLog = run(FFMPEG, [
    "-hide_banner", "-i", inputPath,
    // 先降采样再算场景分：4K 原片直算要多花一个数量级的解码时间，时间码不受影响
    "-filter:v", `scale=${sceneScaleWidth}:-2,select='gt(scene,${sceneThreshold})',showinfo`,
    "-an", "-f", "null", "-",
  ], { allowFailure: true }).stderr;
  const cuts = parseSceneCuts(sceneLog);

  let silences: ReturnType<typeof parseSilences> = [];
  let envelope: ReturnType<typeof parseRmsEnvelope> = [];
  let volume: ReturnType<typeof parseVolumeDetect> = { meanDb: null, maxDb: null };
  if (media.hasAudio) {
    const silenceLog = run(FFMPEG, [
      "-hide_banner", "-i", inputPath,
      "-af", "silencedetect=noise=-30dB:d=0.25",
      "-f", "null", "-",
    ], { allowFailure: true }).stderr;
    silences = parseSilences(silenceLog);

    const rmsLog = run(FFMPEG, [
      "-hide_banner", "-i", inputPath,
      "-af", "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
      "-vn", "-f", "null", "-",
    ], { allowFailure: true }).stderr;
    envelope = parseRmsEnvelope(rmsLog, bucketSeconds);

    const volumeLog = run(FFMPEG, [
      "-hide_banner", "-i", inputPath,
      "-af", "volumedetect", "-vn", "-f", "null", "-",
    ], { allowFailure: true }).stderr;
    volume = parseVolumeDetect(volumeLog);
  }

  const probe = buildFootageProbe({
    media,
    cuts,
    silences,
    envelope,
    volume,
    detector: "ffmpeg-scene",
    threshold: sceneThreshold,
  });

  // —— 节拍估计（纯本地计算，估不出就如实 null）——
  const tempo = estimateTempo(probe.loudness.envelope);
  probe.music = {
    detected: tempo.bpm !== null,
    bpm: tempo.bpm,
    beatGrid: tempo.beatGrid,
    downbeats: [],
    sections: [],
  };

  // —— 人声转写（可选通道：本机 mlx-audio 引擎 / 兼容 OpenAI 的 /v1/audio/transcriptions）——
  const coverageAsr: Record<string, unknown> = { status: "skipped", channel: "none", engine: null, precision: "none", sentences: 0, reason: null };
  if (asrMode !== "off" && media.hasAudio) {
    const engineUrl = asrMode === "auto" ? (process.env.WL_ASR_ENGINE_URL ?? "http://127.0.0.1:8099") : asrMode;
    const tempDir = join(dirname(outPath), ".asr-tmp");
    mkdirSync(tempDir, { recursive: true });
    const wavPath = join(tempDir, `${sha256ForTemp(inputPath)}.wav`);
    try {
      run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavPath]);
      const audio = await readFileAsBlob(wavPath);
      const form = new FormData();
      form.append("file", audio, "audio.wav");
      form.append("model", asrModel);
      form.append("response_format", "verbose_json");
      form.append("language", asrLanguage);
      const response = await fetch(`${engineUrl.replace(/\/$/u, "")}/v1/audio/transcriptions`, { method: "POST", body: form });
      if (!response.ok) throw new Error(`ASR 引擎返回 ${response.status}`);
      const parsed = await response.json() as unknown;
      const speech = normalizeAsrResponse(parsed, { language: asrLanguage, engine: `${asrModel}@${engineUrl}` });
      probe.speech = { language: speech.language, engine: speech.engine, words: speech.words, sentences: speech.sentences };
      coverageAsr.status = "ran";
      coverageAsr.channel = "fallback";   // 本机引擎兜底，非模型自采
      coverageAsr.engine = speech.engine;
      coverageAsr.precision = speech.precision;
      coverageAsr.sentences = speech.sentences.length;
    } catch (err) {
      coverageAsr.status = "unavailable";
      coverageAsr.reason = err instanceof Error ? err.message : String(err);
    }
  } else if (asrMode !== "off") {
    coverageAsr.reason = "素材无音轨";
  }

  // —— 画面文字提取（可选通道：本机 Vision OCR）——
  const coverageOcr: Record<string, unknown> = { status: "skipped", channel: "none", engine: null, hits: 0, reason: null };
  if (wantOcr) {
    const binary = ensureOcrBinary();
    if ("path" in binary) {
      const ocrRun = spawnSync(binary.path, [inputPath, String(ocrFps)], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      if (ocrRun.status === 0) {
        const { observations, skippedLines } = parseOcrJsonl(ocrRun.stdout ?? "");
        probe.onScreenText = observations;
        coverageOcr.status = "ran";
        coverageOcr.channel = "fallback";   // 本机 Vision 兜底，非模型自采
        coverageOcr.engine = "apple-vision";
        coverageOcr.hits = observations.length;
        if (skippedLines > 0) coverageOcr.reason = `${skippedLines} 行输出无法解析（已跳过）`;
      } else {
        coverageOcr.status = "unavailable";
        coverageOcr.reason = (ocrRun.stderr ?? "").trim().split("\n").slice(-2).join(" | ") || `OCR 退出码 ${String(ocrRun.status)}`;
      }
    } else {
      coverageOcr.status = "unavailable";
      coverageOcr.reason = binary.reason;
    }
  }

  // —— 环境音画像（可量化部分；语义标签由理解层写进 shots[].audio.ambience）——
  probe.ambience = deriveAmbienceMetrics({
    envelope: probe.loudness.envelope,
    silences: probe.silences,
    speechSegments: (probe.speech.sentences as Array<{ start: number; end: number }>) ?? [],
    durationSeconds: media.durationSeconds,
  });

  const sha256 = await sha256File(inputPath);
  const now = new Date().toISOString();
  const analysis = {
    schemaVersion: "workloom.video-edit/footage-analysis/v2",
    asset: {
      assetId: `fa-${sha256.slice(0, 12)}`,
      sha256,
      filename: inputPath.split("/").pop() ?? inputPath,
      durationSeconds: Number(media.durationSeconds.toFixed(3)),
      fps: Number(media.fps.toFixed(3)),
      width: media.width,
      height: media.height,
      aspectRatio: media.aspectRatio,
      audio: {
        channels: media.channels,
        sampleRate: media.sampleRate,
        // 未跑 EBU R128 就不冒充 LUFS；峰值电平单列在 volumeDetect
        integratedLufs: null,
        truePeakDb: volume.maxDb,
      },
      rights: { status: "unknown", declaredUsage: ["archive-only"], license: null, source: null, expiresAt: null },
      ingestedAt: now,
      proxyPath: null,
      localPath: inputPath,
    },
    source: { kind: sourceKind, device: null, capturedAt: null, projectLink: null, notes: null },
    probe,
    shots: [],
    highlights: [],
    keyframes: [],
    coverage: {
      analyzedShots: 0,
      analyzedSeconds: 0,
      totalShots: probe.shotBoundaries.length,
      skippedShots: [],
      promptVersion: "probe-only",
      notes: "信号层解析完成；语义层（shot-understanding）与高光层尚未运行。",
      asr: coverageAsr,
      ocr: coverageOcr,
    },
    generatedBy: {
      pipeline: "edit-film",
      stage: "probe",
      tools: [
        { name: FFMPEG, version: null },
        { name: FFPROBE, version: null },
      ],
      model: null,
      startedAt: now,
      finishedAt: now,
    },
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");

  const summary = {
    ok: true,
    input: inputPath,
    output: outPath,
    sha256,
    bytes: statSync(inputPath).size,
    durationSeconds: Number(media.durationSeconds.toFixed(3)),
    fps: Number(media.fps.toFixed(3)),
    resolution: `${media.width}x${media.height}`,
    shots: probe.shotBoundaries.length,
    silences: probe.silences.length,
    envelopePoints: probe.loudness.envelope.length,
    peakMoments: probe.loudness.peakMoments.length,
    volumeDetect: volume,
    bpm: probe.music.bpm,
    beats: probe.music.beatGrid.length,
    ambience: probe.ambience,
    asr: { status: coverageAsr.status, sentences: coverageAsr.sentences, precision: coverageAsr.precision, reason: coverageAsr.reason },
    ocr: { status: coverageOcr.status, hits: coverageOcr.hits, reason: coverageOcr.reason },
    note: "本次只跑确定性信号层（未调用任何模型）；语义理解请走 shot-understanding 阶段。",
  };
  if (flag("--json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`✓ 信号解析完成：${summary.shots} 个镜头 / ${summary.silences} 段停顿 / ${summary.envelopePoints} 个包络点`);
    console.log(`  素材 ${summary.resolution} @ ${summary.fps}fps，时长 ${summary.durationSeconds}s，sha256 ${sha256.slice(0, 12)}…`);
    console.log(`  产物：${outPath}`);
  }
}

main().catch((err) => {
  console.error(`✗ edit-probe 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
