#!/usr/bin/env tsx
/**
 * edit-fastlane —— "1080P 先行版" 一键出片（先交付，再走 4K 正式后期）。
 *
 * 产品口径（2026-10-17 产品所有者）：用户等成片很焦虑，先用同一份帧级时间轴快速交
 * 一版 1080P（烧字+配乐）能直接看，4K/多风格/封面烧封再分批补。
 *
 * 三步（全部复用仓内既有执行器，不另造剪辑逻辑）：
 *   ① pnpm edit:assemble（1080P 裁切/归一化/拼接，含首尾快切）
 *   ② subtitle-cli burn（字库/安全区/标点口径与正式版同源）
 *   ③ bgm-cli mix（BGM 让位原声，单次 -14 LUFS 处理）
 *
 * 用法：
 *   pnpm edit:fastlane -- --timeline <compiled.timeline.json> --subtitle <film.zh.srt>
 *     --bgm <曲目文件> --out-dir work/edit/<film>/fastlane
 *     [--name "片名"] [--platform 哔哩哔哩] [--width 1920 --height 1080]
 *     [--music-level -23] [--track-license royalty-free] [--json]
 *
 * 回执：<out-dir>/fastlane-receipt.json（每步耗时、产物、sha256；失败即非零退出）。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));
const sha256File = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

interface StepReceipt {
  step: string;
  ok: boolean;
  ms: number;
  command: string[];
  output: string;
  sha256?: string;
  stderrTail?: string;
}

function run(step: string, command: string[], output: string, env?: NodeJS.ProcessEnv): StepReceipt {
  const startedAt = Date.now();
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, ...(env ?? {}) },
  });
  const ms = Date.now() - startedAt;
  if (result.status !== 0) {
    const tail = (result.stderr || result.stdout || "").trim().split("\n").slice(-8).join("\n");
    return { step, ok: false, ms, command, output, stderrTail: tail };
  }
  return { step, ok: true, ms, command, output, sha256: existsSync(output) ? sha256File(output) : undefined };
}

function main(): void {
  const timeline = arg("--timeline");
  const subtitle = arg("--subtitle");
  const bgm = arg("--bgm");
  const outDirArg = arg("--out-dir");
  if (!timeline || !subtitle || !bgm || !outDirArg) {
    throw new Error("用法：pnpm edit:fastlane -- --timeline <compiled.timeline.json> --subtitle <film.zh.srt> --bgm <曲目> --out-dir <目录>");
  }
  const name = arg("--name", "1080p-先行版");
  const platform = arg("--platform", "哔哩哔哩");
  const width = Number(arg("--width", "1920"));
  const height = Number(arg("--height", "1080"));
  const musicLevel = arg("--music-level", "-23");
  const license = arg("--track-license", "royalty-free");
  const outDir = abs(outDirArg);
  mkdirSync(outDir, { recursive: true });
  const timelineFile = abs(timeline);
  const subtitleFile = abs(subtitle);
  const bgmFile = abs(bgm);
  for (const file of [timelineFile, subtitleFile, bgmFile]) {
    if (!existsSync(file)) throw new Error(`输入不存在：${file}`);
  }

  const master = join(outDir, "master-1080p.mp4");
  const burned = join(outDir, "master-1080p.burned.mp4");
  const finalFile = join(outDir, `${name}.mp4`);
  const node = process.execPath;
  const steps: StepReceipt[] = [];

  steps.push(run("assemble", [node, "--import", "tsx", join(REPO_ROOT, "scripts/tools/edit-assemble.mts"),
    "--timeline", timelineFile, "--out", master, "--width", String(width), "--height", String(height)], master));
  if (!steps.at(-1)!.ok) throw fail(steps, outDir);

  steps.push(run("subtitle-burn", [node, join(REPO_ROOT, "bundles/ai-video/connectors/subtitle-bridge/cli.mjs"),
    "burn", "--in", master, "--out", burned, "--srt", subtitleFile, "--platform", platform], burned));
  if (!steps.at(-1)!.ok) throw fail(steps, outDir);

  /** bgm-cli 有路径监狱：显式把曲目所在目录加进白名单（等价于 edit:post 的 --bgm-pack 口径）。 */
  const allowed = [dirname(bgmFile), join(REPO_ROOT, "bundles/ai-video/library/bgm-library"), join(REPO_ROOT, "bundles/ai-video/library/bgm-library-curated"), REPO_ROOT]
    .filter(Boolean).join(":");
  steps.push(run("bgm-mix", [node, join(REPO_ROOT, "bundles/ai-video/connectors/bgm-bridge/cli.mjs"),
    "mix", "--in", burned, "--out", finalFile, "--bgm", bgmFile, "--policy", "keep-dialogue",
    "--declared-program-mix", "--music-level", musicLevel, "--ducking", "12", "--lufs", "-14", "--track-license", license],
  finalFile, { WORKLOOM_BGM_ALLOWED_ROOTS: allowed }));
  if (!steps.at(-1)!.ok) throw fail(steps, outDir);

  const receipt = {
    schemaVersion: "workloom.video-edit/fastlane-receipt/v1",
    timeline: timelineFile,
    subtitle: subtitleFile,
    bgm: bgmFile,
    resolution: { width, height },
    file: finalFile,
    sha256: steps.at(-1)!.sha256,
    totalMs: steps.reduce((sum, step) => sum + step.ms, 0),
    steps,
    note: "1080P 先行版；正式版（原生分辨率 × 多变体 × 三形态 + 封面）走 edit:post，可与本回执并行分批交付",
    generatedAt: new Date().toISOString(),
  };
  const receiptPath = join(outDir, "fastlane-receipt.json");
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  if (flag("--json")) {
    console.log(JSON.stringify(receipt, null, 2));
  } else {
    console.log(`✓ 1080P 先行版完成：${finalFile}`);
    console.log(`  分辨率 ${width}×${height}｜总耗时 ${(receipt.totalMs / 1000).toFixed(1)}s｜${steps.map((step) => `${step.step} ${(step.ms / 1000).toFixed(1)}s`).join(" / ")}`);
    console.log(`  回执：${receiptPath}`);
  }
}

function fail(steps: StepReceipt[], outDir: string): Error {
  const last = steps.at(-1)!;
  const receiptPath = join(outDir, "fastlane-receipt.json");
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify({
    schemaVersion: "workloom.video-edit/fastlane-receipt/v1",
    ok: false,
    steps,
    failedAt: last.step,
    generatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  return new Error(`fastlane 在 ${last.step} 失败：\n${last.stderrTail ?? "（无输出）"}`);
}

try {
  main();
} catch (error) {
  console.error(`✗ edit:fastlane 失败：${error instanceof Error ? error.message : String(error)}`);
  console.error(`  提示：先跑 edit:delivery-plan 给用户预估，再决定是否先交 1080P 先行版。`);
  process.exitCode = 1;
}
