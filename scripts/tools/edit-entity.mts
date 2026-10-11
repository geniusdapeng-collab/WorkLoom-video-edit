#!/usr/bin/env tsx
/**
 * edit-entity —— 实体级局部调色执行器（镜头级调色之上的第二层）。
 *
 * 链路：归一化片段 → 抽 3 帧 → macOS Vision 出人物/食物掩膜（vision-entity.swift）
 *      → 纯函数计划（packages/video-studio/src/edit/entity-color.ts）
 *      → ffmpeg maskedmerge 局部执行（人像美白 / 食物暖黄，互不串色）→ 覆盖回片段。
 *
 * 为什么独立成一层：镜头级 LUT 不知道"同一个镜头里谁是谁"，同镜人物+食物时人像会被一起染黄
 * （客户 2026-10-11 反馈）。实体层把"人"和"食物"分开，各自只在自己的掩膜里做优化。
 *
 * 降级纪律：非 macOS / 缺 swiftc / 掩膜缺失 / 无人物实例证据 → 该实体不作用并如实写回执，不猜。
 *
 * 用法：
 *   pnpm edit:entity -- --input <片段.mp4> --out <输出.mp4> [--intensity 1] [--report <json>]
 *   或在 edit:post 里用 `--entity-color` 对每个片段自动执行（推荐）。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildEntityFilterComplex, entityReceiptRows, planEntityGrade, summarizeEntityPlans,
  type EntitySignal,
} from "../../packages/video-studio/src/edit/entity-color.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const FFMPEG = process.env.WL_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.WL_FFPROBE ?? "ffprobe";

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const flag = (name: string) => process.argv.includes(name);
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

function run(bin: string, args: string[]): string {
  try {
    return execFileSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const failure = err as { stderr?: string; message?: string };
    const detail = (failure.stderr || failure.message || "").toString().split("\n").slice(-4).join(" | ");
    throw new Error(`${bin} 执行失败：${detail}`);
  }
}

/** vision-entity 二进制：显式路径优先；否则 macOS 上 swiftc 编译到 ~/.workloom-edit/bin。 */
export function ensureEntityBinary(): { path: string } | { reason: string } {
  const explicit = process.env.WL_VISION_ENTITY?.trim();
  if (explicit && existsSync(explicit)) return { path: explicit };
  if (process.platform !== "darwin") return { reason: "实体掩膜目前仅 macOS（Apple Vision）可用" };
  const target = join(homedir(), ".workloom-edit", "bin", "vision-entity");
  const source = join(REPO_ROOT, "scripts", "tools", "vision-entity.swift");
  if (existsSync(target) && statSync(target).mtimeMs >= statSync(source).mtimeMs) return { path: target };
  if (!existsSync(source)) return { reason: `缺少 Swift 源码：${source}` };
  try {
    mkdirSync(dirname(target), { recursive: true });
    execFileSync("swiftc", ["-O", source, "-o", target], { stdio: ["ignore", "pipe", "pipe"] });
    return existsSync(target) ? { path: target } : { reason: "swiftc 编译后未产出二进制" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { reason: `vision-entity 编译失败：${detail.split("\n").slice(-2).join(" | ")}` };
  }
}

interface VisionSummary {
  personRatio: number;
  personSkinRatio: number | null;
  personInstances: number;
  personRequest: string;
  faceCount: number;
  foodRatio: number;
  foodLabels: string[];
  personMask: boolean;
  foodMask: boolean;
  notes: string[];
}

function probeDuration(file: string): number {
  const out = run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).trim();
  return Number(out) || 0;
}

function probeSize(file: string): { width: number; height: number } {
  const out = run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]).trim();
  const [width, height] = out.split(",").map((value) => Number(value.trim()));
  return { width: width || 0, height: height || 0 };
}

export interface EntityClip { shotId: string; path: string }

export interface EntityPassOptions {
  clips: EntityClip[];
  workDir: string;
  fps: number;
  intensity?: number;
  onLog?: (line: string) => void;
}

export interface EntityPassResult {
  binary: string | null;
  reason: string | null;
  applied: number;
  skipped: number;
  rows: ReturnType<typeof entityReceiptRows>;
  summary: ReturnType<typeof summarizeEntityPlans>;
  generations: Array<{ shotId: string; filterComplex: string; sha256: string }>;
}

/**
 * 对一组片段执行实体级调色。就地覆盖片段文件（后续后期链路直接吃结果），
 * 未被作用的片段不重编码（零改动），回执写明每段的证据与滤镜图。
 */
export async function applyEntityGrade(options: EntityPassOptions): Promise<EntityPassResult> {
  const log = options.onLog ?? (() => {});
  const binary = ensureEntityBinary();
  if ("reason" in binary) {
    log(`⚠ 实体级调色跳过：${binary.reason}`);
    return {
      binary: null, reason: binary.reason, applied: 0, skipped: options.clips.length,
      rows: [], summary: { segments: 0, personSegments: 0, foodSegments: 0, bothSegments: 0 }, generations: [],
    };
  }
  mkdirSync(options.workDir, { recursive: true });
  const signals: EntitySignal[] = [];
  for (const clip of options.clips) {
    const duration = probeDuration(clip.path);
    const dir = join(options.workDir, clip.shotId);
    mkdirSync(dir, { recursive: true });
    const samples = [0.2, 0.5, 0.8].map((ratio) => Number(Math.max(0, Math.min(duration - 0.05, duration * ratio)).toFixed(3)));
    const summaries: Array<VisionSummary & { at: number }> = [];
    const faceBoxes: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (const [index, at] of samples.entries()) {
      const frame = join(dir, `frame-${index}.png`);
      run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(at), "-i", clip.path, "-frames:v", "1", frame]);
      const outDir = join(dir, `mask-${index}`);
      mkdirSync(outDir, { recursive: true });
      const stdout = run(binary.path, [frame, outDir]);
      try {
        const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as VisionSummary;
        summaries.push({ ...parsed, at });
        try {
          const faces = JSON.parse(readFileSync(join(outDir, "faces.json"), "utf8")) as Array<{ x?: number; y?: number; w?: number; h?: number }>;
          faceBoxes.push(...faces.map((face) => ({ x: Number(face.x ?? 0), y: Number(face.y ?? 0), w: Number(face.w ?? 0), h: Number(face.h ?? 0) })));
        } catch {
          /* faces.json 缺失不影响主流程（人脸只是证据之一） */
        }
      } catch {
        summaries.push({
          personRatio: 0, personSkinRatio: null, personInstances: 0, personRequest: "none", faceCount: 0,
          foodRatio: 0, foodLabels: [], personMask: false, foodMask: false, notes: ["vision-entity 输出解析失败"], at,
        });
      }
    }
    const bestPerson = [...summaries].sort((a, b) => b.personRatio - a.personRatio)[0]!;
    const bestFood = [...summaries].sort((a, b) => b.foodRatio - a.foodRatio)[0]!;
    const personIndex = summaries.indexOf(bestPerson);
    const foodIndex = summaries.indexOf(bestFood);
    signals.push({
      segmentId: clip.shotId,
      personRatio: Math.max(...summaries.map((entry) => entry.personRatio)),
      faces: faceBoxes.filter((face) => face.w > 0 && face.h > 0).slice(0, 8),
      personInstances: Math.max(...summaries.map((entry) => entry.personInstances)),
      personSkinRatio: bestPerson.personSkinRatio,
      personRequest: bestPerson.personRequest,
      foodRatio: Math.max(...summaries.map((entry) => entry.foodRatio)),
      foodLabels: [...new Set(summaries.flatMap((entry) => entry.foodLabels))],
      sampledAt: samples,
      personMaskPath: bestPerson.personMask ? join(dir, `mask-${personIndex}`, "person.png") : null,
      foodMaskPath: bestFood.foodMask ? join(dir, `mask-${foodIndex}`, "food.png") : null,
    });
  }
  const plans = signals.map((signal) => planEntityGrade(signal, { intensity: options.intensity ?? 1 }));
  const rows = entityReceiptRows(signals, plans);
  const generations: Array<{ shotId: string; filterComplex: string; sha256: string }> = [];
  let applied = 0;
  let skipped = 0;
  for (const clip of options.clips) {
    const plan = plans.find((entry) => entry.segmentId === clip.shotId)!;
    const signal = signals.find((entry) => entry.segmentId === clip.shotId)!;
    const { width, height } = probeSize(clip.path);
    const wantPerson = plan.person.enabled && Boolean(signal.personMaskPath);
    const wantFood = plan.food.enabled && Boolean(signal.foodMaskPath);
    const outcome = buildEntityFilterComplex(
      { ...plan, person: { ...plan.person, enabled: wantPerson }, food: { ...plan.food, enabled: wantFood } },
      { width, height, personInput: wantPerson && wantFood ? "1:v" : wantPerson ? "1:v" : "1:v", foodInput: wantPerson && wantFood ? "2:v" : "1:v" },
    );
    if (!outcome.applied) {
      skipped += 1;
      continue;
    }
    const duration = probeDuration(clip.path);
    const target = clip.path;
    const temp = join(options.workDir, `${clip.shotId}.entity.mp4`);
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", target];
    if (wantPerson) args.push("-loop", "1", "-framerate", String(options.fps), "-i", signal.personMaskPath!);
    if (wantFood) args.push("-loop", "1", "-framerate", String(options.fps), "-i", signal.foodMaskPath!);
    args.push("-filter_complex", outcome.filterComplex, "-map", "[vout]", "-map", "0:a?", "-t", String(duration),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "copy", "-movflags", "+faststart", temp);
    run(FFMPEG, args);
    if (!existsSync(temp)) throw new Error(`实体级调色未产出文件：${temp}`);
    renameSync(temp, target);
    applied += 1;
    generations.push({
      shotId: clip.shotId,
      filterComplex: outcome.filterComplex,
      sha256: createHash("sha256").update(readFileSync(target)).digest("hex"),
    });
  }
  const summary = summarizeEntityPlans(plans.map((plan) => plan));
  log(`实体级调色：${applied} 段执行 / ${skipped} 段保持原样（人像 ${summary.personSegments} 段、食物 ${summary.foodSegments} 段、同镜 ${summary.bothSegments} 段）`);
  return { binary: binary.path, reason: null, applied, skipped, rows, summary, generations };
}

async function main(): Promise<void> {
  const input = arg("--input");
  const output = arg("--out");
  if (!input) {
    throw new Error("用法：pnpm edit:entity -- --input <片段.mp4> --out <输出.mp4> [--intensity 1] [--report <json>]");
  }
  const inputPath = abs(input);
  if (!existsSync(inputPath)) throw new Error(`输入不存在：${inputPath}`);
  const outputPath = output ? abs(output) : join(dirname(inputPath), `${createHash("sha256").update(inputPath).digest("hex").slice(0, 8)}.entity.mp4`);
  const workDir = join(dirname(outputPath), "entity-work", createHash("sha256").update(inputPath).digest("hex").slice(0, 8));
  const result = await applyEntityGrade({
    clips: [{ shotId: "single", path: inputPath }],
    workDir,
    fps: 30,
    intensity: Number(arg("--intensity", "1")),
    onLog: (line) => console.log(line),
  });
  if (result.applied > 0 && inputPath !== outputPath) {
    renameSync(inputPath, outputPath);
  }
  const reportPath = arg("--report", join(dirname(outputPath), `${createHash("sha256").update(outputPath).digest("hex").slice(0, 8)}.entity-report.json`));
  writeFileSync(reportPath, `${JSON.stringify({
    schema: "workloom.video-edit/entity-grade/v1",
    input: inputPath,
    output: result.applied > 0 ? outputPath : inputPath,
    applied: result.applied,
    personas: result.summary,
    rows: result.rows,
    generations: result.generations,
    binary: result.binary,
    reason: result.reason,
    generatedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  console.log(`回执：${reportPath}`);
  if (flag("--json")) console.log(JSON.stringify({ ...result, report: reportPath }, null, 2));
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`✗ edit-entity 失败：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
