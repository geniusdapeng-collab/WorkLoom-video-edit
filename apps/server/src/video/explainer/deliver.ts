/**
 * explainer/deliver.ts —— 默认保留原片原声，明确请求时执行一次响度处理。
 * measureLoudness/normalizeLoudness 是独立诊断与处理函数，不参与默认交付。
 *
 * 入库口径（spec §6.7 + 媒资库 0039）：`kind='final_cut'`、`source_type='generated'`、
 * `pipeline_kind='explainer'`、prompt=口播稿摘要、tags 带「口播/解说/片名」，
 * 走 `registerLocalAsset`（sha256 幂等 + 版本链 + D16 同事务事件）——**不新开第二条入库路径**。
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";


export interface LoudnormMeasurement {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
}

function run(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; onLog?: (l: string) => void } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${cmd} 超时`)); }, opts.timeoutMs ?? 1_800_000);
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => {
      const text = String(d);
      stderr += text;
      for (const line of text.split("\n")) if (line.trim() && opts.onLog && /loudnorm|input_|Error/.test(line)) opts.onLog(line.trim());
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

export function ffmpegBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.WL_FFMPEG?.trim() || env.FFMPEG_PATH?.trim() || "ffmpeg";
}

/** 第一遍：只量测（读 stderr 里 loudnorm 的 JSON 块） */
export async function measureLoudness(
  input: string,
  opts: { env?: NodeJS.ProcessEnv; onLog?: (l: string) => void } = {},
): Promise<LoudnormMeasurement> {
  const r = await run(ffmpegBin(opts.env), [
    "-hide_banner", "-nostats", "-i", input,
    "-af", "loudnorm=I=-15:TP=-1.5:LRA=11:print_format=json",
    "-f", "null", "-",
  ], opts);
  if (r.code !== 0) throw new Error(`loudnorm 量测失败（退出码 ${r.code}）：${r.stderr.slice(-300)}`);
  const json = /\{[\s\S]*?"target_offset"[\s\S]*?\}/.exec(r.stderr);
  if (!json) throw new Error("loudnorm 量测输出里找不到 JSON（格式变了？）");
  const parsed = JSON.parse(json[0]) as Record<string, string>;
  const num = (key: string): number => {
    const value = Number(parsed[key]);
    if (!Number.isFinite(value)) throw new Error(`loudnorm 量测字段非法：${key}=${parsed[key]}`);
    return value;
  };
  return {
    input_i: num("input_i"),
    input_tp: num("input_tp"),
    input_lra: num("input_lra"),
    input_thresh: num("input_thresh"),
    target_offset: num("target_offset"),
  };
}

/** 第二遍：线性归一（视频轨 copy，只重编码音频） */
export async function normalizeLoudness(
  input: string,
  output: string,
  measured: LoudnormMeasurement,
  opts: { env?: NodeJS.ProcessEnv; onLog?: (l: string) => void } = {},
): Promise<void> {
  const filter = [
    "loudnorm=I=-15:TP=-1.5:LRA=11",
    `measured_I=${measured.input_i}`,
    `measured_TP=${measured.input_tp}`,
    `measured_LRA=${measured.input_lra}`,
    `measured_thresh=${measured.input_thresh}`,
    `offset=${measured.target_offset}`,
    "linear=true",
  ].join(":");
  const r = await run(ffmpegBin(opts.env), [
    "-hide_banner", "-nostats", "-y", "-i", input,
    "-c:v", "copy", "-af", filter, "-ar", "48000", "-c:a", "aac", "-b:a", "192k",
    output,
  ], { ...opts, timeoutMs: 3_600_000 });
  if (r.code !== 0) throw new Error(`loudnorm 归一失败（退出码 ${r.code}）：${r.stderr.slice(-300)}`);
}

export interface DeliverResult {
  deliveryPath: string;
  rawPath: string;
  measurement: LoudnormMeasurement | null;
  bytes: number;
  sha256: string;
}

/** 默认原视频/原音字节直接交付；响度归一仅在 normalize=true 明确请求时执行。 */
export async function deliverFilm(input: {
  jobDir: string;
  env?: NodeJS.ProcessEnv;
  onLog?: (line: string) => void;
  normalize?: boolean;
  sourceSha256?: string;
}): Promise<DeliverResult> {
  const raw = join(input.jobDir, "out", "v1.mp4");
  if (!existsSync(raw)) throw new Error(`成片不存在：${raw}（先渲染）`);
  const delivery = join(input.jobDir, "out", "delivery.mp4");
  const before = statSync(raw);
  if (!before.isFile() || before.size <= 0) throw new Error("POST_DELIVERY_SOURCE_REQUIRED");
  const sourceSha256 = createHash("sha256").update(readFileSync(raw)).digest("hex");
  if (input.sourceSha256 && input.sourceSha256 !== sourceSha256) throw new Error("POST_DELIVERY_SOURCE_CHANGED");
  let measurement: LoudnormMeasurement | null = null;
  const candidate = `${delivery}.${randomUUID()}.pending.mp4`;
  try {
    if (input.normalize === true) {
      const result = await run(ffmpegBin(input.env), ["-hide_banner", "-nostats", "-n", "-i", raw,
        "-map", "0:v:0", "-map", "0:a?", "-c:v", "copy", "-af",
        "loudnorm=I=-15:TP=-1.5:LRA=11,aeval=if(isnan(val(ch))+isinf(val(ch))\\,0\\,val(ch)):c=same",
        "-ar", "48000", "-c:a", "aac", "-b:a", "192k", candidate], { env: input.env, onLog: input.onLog });
      if (result.code !== 0) throw new Error(`POST_DELIVERY_PROCESSING_FAILED: ${result.stderr.slice(-1000)}`);
    } else copyFileSync(raw, candidate);
    const after = statSync(raw);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || createHash("sha256").update(readFileSync(raw)).digest("hex") !== sourceSha256) throw new Error("POST_DELIVERY_SOURCE_CHANGED_DURING_PROCESS");
    if (!statSync(candidate).isFile() || statSync(candidate).size <= 0) throw new Error("POST_DELIVERY_OUTPUT_REQUIRED");
    const sha256 = createHash("sha256").update(readFileSync(candidate)).digest("hex");
    if (!input.normalize && sha256 !== sourceSha256) throw new Error("POST_DELIVERY_ORIGINAL_BYTES_CHANGED");
    if (existsSync(delivery)) renameSync(delivery, `${delivery}.previous-${randomUUID()}`);
    renameSync(candidate, delivery);
    writeFileSync(join(input.jobDir, "out", "delivery-loudnorm.json"), JSON.stringify({
      requested: input.normalize === true, measured: measurement, qualityReviewed: false, qualityScore: null,
      target: input.normalize ? { I: -15, TP: -1.5, LRA: 11 } : null,
      source: { sha256: sourceSha256, bytes: before.size, path: "out/v1.mp4" },
      delivery: { sha256, bytes: statSync(delivery).size, path: "out/delivery.mp4" },
    }, null, 1));
  } catch (error) { rmSync(candidate, { force: true }); throw error; }
  const fp = { sha256: createHash("sha256").update(readFileSync(delivery)).digest("hex"), bytes: statSync(delivery).size };

  return {
    deliveryPath: delivery,
    rawPath: raw,
    measurement,
    bytes: statSync(delivery).size,
    sha256: fp.sha256,
  };
}
