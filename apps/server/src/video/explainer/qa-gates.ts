/** Successful renders enter post directly. This report records actual media processing failures only. */
import { spawn } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { explainerOutputSize, type ExplainerQuality, type GateResult, type QaReport } from "./types.js";
import { assertRemotionSourceBinding, readJobState, renderedOutputFingerprint } from "./remotion-provider.js";

export interface GateInput {
  jobDir: string; cards: string[]; cueCount: number; baseline?: string | null; qaScale?: number;
  aspect?: "9:16" | "16:9"; quality?: ExplainerQuality;
  shots?: Array<{ id: string; start: number; end: number }>;
  engineDir?: string; env?: NodeJS.ProcessEnv; onLog?: (line: string) => void; timeoutMs?: number;
  /** 正式渲染/HTTP finalize 必须有原任务来源绑定；独立文件诊断不补认证。 */
  requireProviderState?: boolean;
}
export interface GateRunResult { report: QaReport; qaFramesDir: string; sheetsDir: string }
async function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`POST_MEDIA_TOOL_TIMEOUT: ${cmd}`)); }, timeoutMs);
    child.stdout.on("data", (data) => { stdout += String(data); if (stdout.length > 4_000_000) { child.kill("SIGKILL"); reject(new Error("POST_MEDIA_TOOL_OUTPUT_LIMIT")); } });
    child.stderr.on("data", (data) => { stderr = (stderr + String(data)).slice(-20_000); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); if (code !== 0) reject(new Error(`POST_MEDIA_TOOL_FAILED: ${cmd}(${code}): ${stderr.slice(-1000)}`)); else resolve(stdout); });
  });
}
export async function runMachineGates(input: GateInput): Promise<GateRunResult> {
  const env = input.env ?? process.env, timeoutMs = input.timeoutMs ?? 30 * 60_000;
  const video = join(input.jobDir, "out", "v1.mp4");
  const qaFramesDir = join(input.jobDir, "out", "qa-frames"), sheetsDir = join(input.jobDir, "out", "qa-sheets");
  const gates: GateResult[] = [];
  let sourceArtifact: QaReport["sourceArtifact"] = null;
  try {
    const before = statSync(video);
    if (!before.isFile() || before.size <= 0) throw new Error("POST_MEDIA_FILE_REQUIRED");
    const fingerprint = renderedOutputFingerprint(video), sha256 = fingerprint.sha256;
    const state = readJobState(input.jobDir);
    if (state || input.requireProviderState) assertRemotionSourceBinding(state, input.jobDir, video, fingerprint);
    const ffprobe = env.WL_FFPROBE || env.FFPROBE_PATH || "ffprobe";
    const metadata = JSON.parse(await run(ffprobe, ["-v", "error", "-show_format", "-show_streams", "-of", "json", video], env, timeoutMs)) as {
      streams?: Array<{ codec_type?: string; width?: number; height?: number }>; format?: { duration?: string };
    };
    const stream = metadata.streams?.find((item) => item.codec_type === "video"), duration = Number(metadata.format?.duration);
    if (!stream || !(duration > 0)) throw new Error("POST_MEDIA_VIDEO_UNREADABLE");
    const canvas = explainerOutputSize(input.aspect ?? "9:16", input.quality ?? "hd");
    if (stream.width !== canvas.width || stream.height !== canvas.height) throw new Error(`POST_EXPORT_CANVAS_MISMATCH: ${stream.width}x${stream.height} != ${canvas.width}x${canvas.height}`);
    const after = statSync(video);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || createHash("sha256").update(readFileSync(video)).digest("hex") !== sha256) throw new Error("POST_MEDIA_BYTES_CHANGED_DURING_READ");
    sourceArtifact = { path: video, sha256, bytes: after.size, duration, width: canvas.width, height: canvas.height };
    gates.push({ gate: "actual-media-processing", status: "pass", command: "ffprobe processing metadata",
      summary: "真实文件可读，实际请求导出画布与当前字节一致；未做画面或声音品质复核", details: [] });
  } catch (error) {
    gates.push({ gate: "actual-media-processing", status: "fail", command: "ffprobe processing metadata",
      summary: error instanceof Error ? error.message : String(error), details: [] });
  }
  for (const gate of ["motion_check", "sfx_check:solo", "sfx_check:mix", "card_lint", "beat_lint", "qa_materials"]) {
    gates.push({ gate, status: "skip", command: "not invoked", summary: "成功渲染后默认接受；不复核静止/抖动/音效掩蔽/源卡保真/词落点，不重渲音效或抽帧评审", details: [] });
  }
  const report: QaReport = { jobId: input.jobDir, totalFrames: null, gates,
    pass: gates.every((gate) => gate.status !== "fail"), qualityReviewed: false, qualityScore: null, sourceArtifact };
  mkdirSync(join(input.jobDir, "out"), { recursive: true });
  const reportFile = join(input.jobDir, "out", "qa-report.json");
  if (existsSync(reportFile)) copyFileSync(reportFile, join(input.jobDir, "out", `qa-report.previous-${randomUUID()}.json`), constants.COPYFILE_EXCL);
  writeFileSync(reportFile, JSON.stringify(report, null, 1));
  input.onLog?.(`[post] ${report.pass ? "processing receipt recorded" : "actual processing failed"}; quality review not invoked`);
  return { report, qaFramesDir, sheetsDir };
}
