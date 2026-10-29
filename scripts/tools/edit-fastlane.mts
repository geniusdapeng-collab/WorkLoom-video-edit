#!/usr/bin/env tsx
/**
 * edit-fastlane —— 默认「1080P 完整版」快速交付；可选极速预览；4K 不在本工具里自动开跑。
 *
 * 产品口径（2026-10-17 产品所有者）：
 *   · 默认第一条交付 = **1080P 完整版全链路**：调色 + BGM + 字幕 + 转场 + 首尾快切 +
 *     封面设计/机检/烧封 + 弹幕 + 交付清单；
 *   · `--mode light` 是可选极速预览（assemble → 烧字 → 混音，无调色/封面/弹幕），不冒充完整版；
 *   · 4K 不在这里自动跑：素材是 4K 时，用 `edit:delivery-plan` 给出的话术在 1080P 交付后再问用户。
 *
 * 用法：
 *   pnpm edit:fastlane -- --timeline <compiled.timeline.json> --subtitle <film.zh.srt>
 *     --out-dir work/edit/<film>/fastlane [--mode full|light] [--variants warm-story,clean-tech]
 *     [--danmaku <danmaku.json>] [--analysis <understood.json>]… [--bgm-pack <曲库>]
 *     [--title "片名"] [--cover-title "封面主标题"] [--hook "封面副标题"]
 *     [--variant-copy <cover-copy.json>] [--copies <cover-copy-deck.json>] [--style-map <variant-style.json>]
 *     [--platform 哔哩哔哩] [--bridge-url <url>]
 *     [--bgm <曲目>] [--name "<文件名>"] [--music-level -23] [--json]
 *     [--bgm-section auto|climax|calm|full] [--bgm-cut-driven]
 *     [--clarity auto|off|light|medium|strong]
 *
 * full 模式（默认）：
 *   ① edit:post（1920×1080 全链路，含变体调色/BGM/字幕/转场/弹幕；分段调色需显式 --segment-color）
 *   ② edit:cover（封面三风格机检 + 统一 0.6s 烧封片头，写推荐发布件）
 * light 模式：
 *   edit:assemble → subtitle-cli burn → bgm-cli mix（几分钟量级的"先看版"）
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
function argAll(name: string): string[] {
  const values: string[] = [];
  process.argv.forEach((value, index) => {
    if (value === name && process.argv[index + 1] && !process.argv[index + 1]!.startsWith("--")) values.push(process.argv[index + 1]!);
  });
  return values;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));
const sha256File = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

interface StepReceipt {
  step: string;
  ok: boolean;
  ms: number;
  output: string;
  sha256?: string;
  stderrTail?: string;
}

function run(step: string, command: string[], output: string, env?: NodeJS.ProcessEnv): StepReceipt {
  const startedAt = Date.now();
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...(env ?? {}) },
  });
  const ms = Date.now() - startedAt;
  if (result.status !== 0) {
    const tail = (result.stderr || result.stdout || "").trim().split("\n").slice(-10).join("\n");
    return { step, ok: false, ms, output, stderrTail: tail };
  }
  const isFile = existsSync(output) && statSync(output).isFile();
  return { step, ok: true, ms, output, sha256: isFile ? sha256File(output) : undefined };
}

function main(): void {
  const mode = arg("--mode", "full");
  if (!["full", "light"].includes(mode)) throw new Error("--mode 只接受 full / light");
  const timeline = arg("--timeline");
  const subtitle = arg("--subtitle");
  const outDirArg = arg("--out-dir");
  if (!timeline || !subtitle || !outDirArg) {
    throw new Error("用法：pnpm edit:fastlane -- --timeline <compiled.timeline.json> --subtitle <film.zh.srt> --out-dir <目录> [--mode full|light]");
  }
  const timelineFile = abs(timeline);
  const subtitleFile = abs(subtitle);
  for (const file of [timelineFile, subtitleFile]) if (!existsSync(file)) throw new Error(`输入不存在：${file}`);
  const outDir = abs(outDirArg);
  mkdirSync(outDir, { recursive: true });
  const node = process.execPath;
  const variants = arg("--variants", "warm-story,clean-tech,bold-promo");
  const platform = arg("--platform", "哔哩哔哩");
  const title = arg("--title", arg("--name", "1080P 完整版"));
  const steps: StepReceipt[] = [];

  if (mode === "light") {
    const bgm = abs(arg("--bgm"));
    if (!bgm || !existsSync(bgm)) throw new Error("light 模式必须提供 --bgm <曲目文件>");
    const musicLevel = arg("--music-level", "-23");
    const license = arg("--track-license", "royalty-free");
    const name = arg("--name", "1080p-极速预览");
    const master = join(outDir, "preview-1080p.mp4");
    const burned = join(outDir, "preview-1080p.burned.mp4");
    const finalFile = join(outDir, `${name}.mp4`);
    steps.push(run("assemble", [node, "--import", "tsx", join(REPO_ROOT, "scripts/tools/edit-assemble.mts"),
      "--timeline", timelineFile, "--out", master, "--width", "1920", "--height", "1080"], master));
    if (!steps.at(-1)!.ok) throw fail(steps, outDir, mode);
    steps.push(run("subtitle-burn", [node, join(REPO_ROOT, "bundles/ai-video/connectors/subtitle-bridge/cli.mjs"),
      "burn", "--in", master, "--out", burned, "--srt", subtitleFile, "--platform", platform], burned));
    if (!steps.at(-1)!.ok) throw fail(steps, outDir, mode);
    const allowed = [dirname(bgm), join(REPO_ROOT, "bundles/ai-video/library/bgm-library"), join(REPO_ROOT, "bundles/ai-video/library/bgm-curated"), REPO_ROOT].join(":");
    steps.push(run("bgm-mix", [node, join(REPO_ROOT, "bundles/ai-video/connectors/bgm-bridge/cli.mjs"),
      "mix", "--in", burned, "--out", finalFile, "--bgm", bgm, "--policy", "keep-dialogue",
      "--declared-program-mix", "--music-level", musicLevel, "--ducking", "12", "--lufs", "-14", "--track-license", license],
    finalFile, { WORKLOOM_BGM_ALLOWED_ROOTS: allowed }));
    if (!steps.at(-1)!.ok) throw fail(steps, outDir, mode);
    writeReceipt(steps, outDir, mode, finalFile);
    return;
  }

  const deliveryDir = join(outDir, "delivery-1080p");
  const danmaku = arg("--danmaku");
  const bgmPack = arg("--bgm-pack");
  const analysisFiles = argAll("--analysis").map(abs);
  const postArgs = [node, "--import", "tsx", join(REPO_ROOT, "scripts/tools/edit-post.mts"),
    "--timeline", timelineFile, "--out-dir", deliveryDir,
    "--width", "1920", "--height", "1080", "--allow-downscale",
    "--variants", variants, "--subtitle", subtitleFile,
    "--bgm", "agent", "--platform", platform, "--title", title, "--json",
    ...(arg("--clarity") ? ["--clarity", arg("--clarity")] : []),
    ...(flag("--segment-color") ? ["--segment-color"] : []),
    ...(bgmPack ? ["--bgm-pack", abs(bgmPack)] : []),
    ...(arg("--bgm-section") ? ["--bgm-section", arg("--bgm-section")] : []),
    ...(flag("--bgm-cut-driven") ? ["--bgm-cut-driven"] : []),
    ...(danmaku ? ["--danmaku", abs(danmaku)] : []),
    ...analysisFiles.flatMap((file) => ["--analysis", file])];
  steps.push(run("post-1080p", postArgs, join(deliveryDir, "delivery-manifest.json")));
  if (!steps.at(-1)!.ok) throw fail(steps, outDir, mode);

  const coverArgs = [node, "--import", "tsx", join(REPO_ROOT, "scripts/tools/edit-cover.mts"),
    "--input", join(deliveryDir, "master/master-clean.mp4"), "--out-dir", deliveryDir,
    "--timeline", timelineFile, "--variants", variants, "--platform", platform,
    "--title", arg("--cover-title", title), "--hook", arg("--hook", ""),
    "--renderer", "auto", "--json",
    ...(arg("--variant-copy") ? ["--variant-copy", abs(arg("--variant-copy"))] : []),
    ...(arg("--copies") ? ["--copies", abs(arg("--copies"))] : []),
    ...(arg("--style-map") ? ["--style-map", abs(arg("--style-map"))] : []),
    ...(arg("--bridge-url") ? ["--bridge-url", arg("--bridge-url")] : [])];
  steps.push(run("cover-1080p", coverArgs, join(deliveryDir, "covers", "cover-report.json")));
  if (!steps.at(-1)!.ok) throw fail(steps, outDir, mode);
  /** 只交每个风格一条成片（字幕+弹幕+封面全烧录），过程产物留在 delivery 内部。 */
  const finalOut = join(outDir, "最终成片");
  const packageArgs = [node, "--import", "tsx", join(REPO_ROOT, "scripts/tools/edit-package.mts"),
    "--delivery", deliveryDir, "--final-only", "--title", title, "--out", finalOut];
  steps.push(run("final-package", packageArgs, finalOut));
  if (!steps.at(-1)!.ok) throw fail(steps, outDir, mode);
  writeReceipt(steps, outDir, mode, finalOut);
}

function writeReceipt(steps: StepReceipt[], outDir: string, mode: string, finalOutput: string): void {
  const receipt = {
    schemaVersion: "workloom.video-edit/fastlane-receipt/v1",
    mode,
    resolution: "1080p",
    file: finalOutput,
    sha256: steps.at(-1)?.sha256,
    totalMs: steps.reduce((sum, step) => sum + step.ms, 0),
    steps,
    note: mode === "full"
      ? "1080P 完整版（变体调色/BGM/字幕/转场/快切/字幕+弹幕单次编码/封面烧封/交付清单）；分段调色需显式 --segment-color；4K 需用户确认后另跑 edit:post"
      : "极速预览（轻链路，无调色/封面/弹幕），不作为默认交付件",
    generatedAt: new Date().toISOString(),
  };
  const path = join(outDir, "fastlane-receipt.json");
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`✓ ${mode === "full" ? "1080P 完整版" : "1080P 极速预览"}完成：${finalOutput}`);
  console.log(`  总耗时 ${(receipt.totalMs / 1000).toFixed(1)}s｜${steps.map((step) => `${step.step} ${(step.ms / 1000).toFixed(1)}s`).join(" / ")}`);
  console.log(`  回执：${path}`);
}

function fail(steps: StepReceipt[], outDir: string, mode: string): Error {
  const last = steps.at(-1)!;
  const path = join(outDir, "fastlane-receipt.json");
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: "workloom.video-edit/fastlane-receipt/v1",
    mode,
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
  console.error(`  提示：先跑 edit:delivery-plan 给用户预估；4K 必须等 1080P 交付后用户确认再跑。`);
  process.exitCode = 1;
}
