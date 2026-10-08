/**
 * 白板交付按请求把旁白和软字幕装入真实渲染片。默认保留已有原声，
 * 不测量响度或检查品质；明确请求响度处理时只在这一次混流中应用滤镜。
 * measureLoudness 保留为独立诊断，不参与默认交付。
 */
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { WhiteboardEngineError, whiteboardEnv } from "./engine.js";

const execFileAsync = promisify(execFile);

export interface LoudnormMeasurement {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
  normalizedI: number | null;
}

async function ffmpeg(args: string[], timeoutMs: number, ffmpegBin: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(ffmpegBin, args, {
      timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, killSignal: "SIGKILL",
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    if (e.killed) throw new WhiteboardEngineError(`ffmpeg 超时被终止：${args.slice(0, 6).join(" ")}`);
    throw new WhiteboardEngineError(
      `ffmpeg 失败：${args.slice(0, 6).join(" ")}`,
      `${e.stderr ?? e.stdout ?? e.message ?? ""}`.trim().slice(-1200),
    );
  }
}

/** 第一遍：只测量，不改音频（`-f null` 不出文件） */
export async function measureLoudness(
  audioPath: string,
  opts: { env?: NodeJS.ProcessEnv; targetLufs?: number } = {},
): Promise<LoudnormMeasurement> {
  const cfg = whiteboardEnv(opts.env);
  const target = opts.targetLufs ?? Number(opts.env?.WHITEBOARD_VOICE_LUFS ?? "-16");
  const run = await ffmpeg([
    "-hide_banner", "-nostats", "-i", audioPath,
    "-af", `loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`,
    "-f", "null", "-",
  ], 10 * 60_000, cfg.ffmpeg);
  // loudnorm 的 JSON 打在 stderr，形如 { "input_i" : "-23.13", ... }
  const match = /\{[\s\S]*"input_i"[\s\S]*\}/.exec(run.stderr);
  if (!match) {
    throw new WhiteboardEngineError(
      "响度测量失败：ffmpeg 没有输出 loudnorm 读数",
      run.stderr.trim().slice(-600),
    );
  }
  const raw = JSON.parse(match[0]) as Record<string, string>;
  const value = Number(raw.input_i);
  return {
    input_i: raw.input_i ?? "",
    input_tp: raw.input_tp ?? "",
    input_lra: raw.input_lra ?? "",
    input_thresh: raw.input_thresh ?? "",
    target_offset: raw.target_offset ?? "",
    normalizedI: Number.isFinite(value) ? value : null,
  };
}

export interface MuxOptions {
  /** 无声白板片（上游渲染器产物） */
  silentVideo: string;
  /** 配音整轨（narration.ts 产物） */
  narrationWav: string;
  output: string;
  /** 可选 SRT 软字幕轨（不烧字：母版保持干净，字幕作为可开关轨道） */
  srtPath?: string;
  targetLufs?: number;
  normalize?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface MuxResult {
  output: string;
  videoSeconds: number;
  audioSeconds: number;
  loudnessBefore: number | null;
  loudnessAfter: number | null;
  /** 视频与音频时长差（秒）；绝对值 > 0.2s 视为异常，调用方需显式对待 */
  avDriftSec: number;
  qualityReviewed: false;
  qualityScore: null;
  normalizationRequested: boolean;
  sha256: string;
  bytes: number;
  sourceFiles: Array<{ path: string; sha256: string; bytes: number }>;
}

/** 一次请求混流：原视频 copy、原声保留、旁白与可选软字幕同次处理。 */
export async function muxWhiteboardFilm(opts: MuxOptions): Promise<MuxResult> {
  const env = opts.env ?? process.env;
  const cfg = whiteboardEnv(env);
  const target = opts.targetLufs ?? Number(env.WHITEBOARD_VOICE_LUFS ?? "-16");
  if (opts.normalize && (!Number.isFinite(target) || target < -70 || target > -5)) throw new WhiteboardEngineError("请求响度参数非法");
  const files = [opts.silentVideo, opts.narrationWav, ...(opts.srtPath ? [opts.srtPath] : [])];
  const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const sources = files.map(file => {
    if (resolve(file) === resolve(opts.output)) throw new WhiteboardEngineError("禁止覆盖白板混流输入");
    if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || statSync(file).size <= 0) throw new WhiteboardEngineError(`混流输入缺失或非法：${file}`);
    const stat = statSync(file);
    return { path: resolve(file), sha256: sha(file), bytes: stat.size, mtimeMs: stat.mtimeMs };
  });
  const videoSeconds = await probeSeconds(opts.silentVideo, cfg.ffprobe);
  const audioSeconds = await probeSeconds(opts.narrationWav, cfg.ffprobe);
  if (!await hasAudioStream(opts.narrationWav, cfg.ffprobe)) throw new WhiteboardEngineError("请求的旁白输入缺少音轨");
  const originalAudio = await hasAudioStream(opts.silentVideo, cfg.ffprobe);
  mkdirSync(dirname(opts.output), { recursive: true });
  const candidate = `${opts.output}.${randomUUID()}.pending.mp4`;
  const filters = [`[1:a]apad,atrim=duration=${videoSeconds},asetpts=N/SR/TB[narration]`];
  if (originalAudio) {
    filters.push(`[0:a:0]apad,atrim=duration=${videoSeconds},asetpts=N/SR/TB[original]`);
    filters.push("[original][narration]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixed]");
  } else filters.push("[narration]anull[mixed]");
  filters.push(opts.normalize
    ? `[mixed]loudnorm=I=${target}:TP=-1.5:LRA=11,aeval=if(isnan(val(ch))+isinf(val(ch))\\,0\\,val(ch)):c=same,aresample=48000[a]`
    : "[mixed]anull[a]");
  try {
    await ffmpeg(["-n", "-v", "error", "-i", opts.silentVideo, "-i", opts.narrationWav,
      ...(opts.srtPath ? ["-i", opts.srtPath] : []), "-filter_complex", filters.join(";"),
      "-map", "0:v:0", "-map", "[a]",
      ...(opts.srtPath ? ["-map", "2:0", "-c:s", "mov_text", "-metadata:s:s:0", "language=chi"] : []),
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-t", String(videoSeconds), "-movflags", "+faststart", candidate], opts.timeoutMs ?? 15 * 60_000, cfg.ffmpeg);
    if (!existsSync(candidate) || !statSync(candidate).isFile() || statSync(candidate).size <= 0
      || !await hasAudioStream(candidate, cfg.ffprobe) || !(await probeSeconds(candidate, cfg.ffprobe) > 0)) throw new WhiteboardEngineError("混流未产出真实可读音视频");
    for (const source of sources) {
      const stat = statSync(source.path);
      if (stat.size !== source.bytes || stat.mtimeMs !== source.mtimeMs || sha(source.path) !== source.sha256) throw new WhiteboardEngineError(`混流期间输入字节变化：${source.path}`);
    }
    if (existsSync(opts.output)) {
      if (!lstatSync(opts.output).isFile() || lstatSync(opts.output).isSymbolicLink()) throw new WhiteboardEngineError("混流输出路径非法");
      renameSync(opts.output, `${opts.output}.previous-${randomUUID()}`);
    }
    renameSync(candidate, opts.output);
  } catch (error) { rmSync(candidate, { force: true }); throw error; }
  return { output: opts.output, videoSeconds, audioSeconds, loudnessBefore: null, loudnessAfter: null,
    avDriftSec: Math.round((videoSeconds - audioSeconds) * 1000) / 1000,
    qualityReviewed: false, qualityScore: null, normalizationRequested: opts.normalize === true,
    sha256: sha(opts.output), bytes: statSync(opts.output).size,
    sourceFiles: sources.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })) };
}

/** 时长探测（交付对账面：音画不同长要在报告里显式暴露，不能"看着差不多"） */
export async function probeSeconds(file: string, ffprobe = "ffprobe"): Promise<number> {
  try {
    const { stdout } = await execFileAsync(ffprobe, [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file,
    ], { timeout: 60_000 });
    const value = Number(stdout.trim());
    if (!Number.isFinite(value) || value <= 0) throw new Error("媒体时间线不可读");
    return value;
  } catch (error) {
    throw new WhiteboardEngineError(`媒体时间线探测失败：${file}`, error instanceof Error ? error.message : String(error));
  }
}

/** 探测音轨是否存在（混流前的白板片应当**没有**音轨——这条也是自检项） */
export async function hasAudioStream(file: string, ffprobe = "ffprobe"): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(ffprobe, [
      "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
      "-of", "csv=p=0", file,
    ], { timeout: 60_000 });
    return stdout.trim().length > 0;
  } catch (error) {
    throw new WhiteboardEngineError(`媒体音轨探测失败：${file}`, error instanceof Error ? error.message : String(error));
  }
}
