#!/usr/bin/env tsx
/**
 * edit-delivery-plan —— 交付前先把"先给你什么、多久、后面还有什么"说清楚。
 *
 * 产品口径（2026-10-17）：用户等待成片是焦虑源。开工即给出
 *   ① 1080P 先行版预计几分钟；
 *   ② 正式版分辨率（跟素材原生档位）/几个风格/预计多久；
 *   ③ 本机配置对时长的影响，以及升级建议。
 *
 * 用法：
 *   pnpm edit:delivery-plan -- --timeline <compiled.timeline.json>
 *     [--variants warm-story,clean-tech] [--analysis <probe.json>]…
 *     [--out work/edit/<film>/delivery-plan.json] [--json]
 *
 * 估算模型是纯函数 `planDelivery()`（packages/video-studio/src/edit/delivery-plan.ts），
 * 系数来自本机真实素材实测；只做提示，不改任何生产执行器。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { planDelivery, type MachineProfile, type EditTimeline } from "../../packages/video-studio/src/edit/index.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

function machineProfile(): MachineProfile {
  const read = (key: string): string => {
    try {
      return execFileSync("sysctl", ["-n", key], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  const chip = read("machdep.cpu.brand_string") || read("hw.model") || process.platform;
  const cores = Number(read("hw.ncpu")) || 8;
  const bytes = Number(read("hw.memsize")) || 0;
  return { chip, cores, memoryGb: bytes > 0 ? Math.round(bytes / (1024 ** 3)) : 16 };
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function main(): void {
  const timelinePath = arg("--timeline");
  if (!timelinePath) throw new Error("用法：pnpm edit:delivery-plan -- --timeline <compiled.timeline.json> [--variants …]");
  const file = abs(timelinePath);
  if (!existsSync(file)) throw new Error(`时间轴不存在：${file}`);
  const timeline = JSON.parse(readFileSync(file, "utf8")) as EditTimeline;
  const variants = arg("--variants", "warm-story,clean-tech").split(",").map((value) => value.trim()).filter(Boolean);

  const uniqueSources = new Map<string, number>();
  for (const source of timeline.sources ?? []) {
    const seconds = Number(source.durationSeconds ?? 0);
    if (Number.isFinite(seconds) && seconds > 0) uniqueSources.set(source.sourceId, seconds);
  }
  const sourceSeconds = [...uniqueSources.values()].reduce((sum, value) => sum + value, 0);
  const outputSeconds = Number(timeline.rhythmDirection?.expectedOutputSeconds
    ?? timeline.segments.reduce((sum, segment) => sum + segment.durationSeconds, 0));

  /** 素材长边：优先用 --analysis 的探测规格，其次 ffprobe 第一条源片。 */
  let sourceMaxEdge = 1080;
  const analysisPaths: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === "--analysis" && process.argv[index + 1]) analysisPaths.push(abs(process.argv[index + 1]!));
  }
  const widths: number[] = [];
  for (const analysisPath of analysisPaths) {
    if (!existsSync(analysisPath)) continue;
    const doc = JSON.parse(readFileSync(analysisPath, "utf8")) as { asset?: { width?: number; height?: number } };
    if (doc.asset?.width && doc.asset?.height) widths.push(Math.max(doc.asset.width, doc.asset.height));
  }
  if (widths.length > 0) {
    sourceMaxEdge = Math.max(...widths);
  } else {
    const first = timeline.sources?.[0];
    if (first?.path) {
      try {
        const raw = execFileSync(process.env.WL_FFPROBE ?? "ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", first.path], { encoding: "utf8" }).trim();
        const [width, height] = raw.split(",").map((value) => Number(value.trim()));
        if (Number.isFinite(width) && Number.isFinite(height)) sourceMaxEdge = Math.max(width, height);
      } catch {
        /* probing failure keeps the conservative 1080 fallback */
      }
    }
  }

  const plan = planDelivery({
    sourceSeconds,
    outputSeconds,
    sourceMaxEdge,
    variants: variants.length,
    machine: machineProfile(),
  });

  const outPath = arg("--out");
  const receipt = {
    ...plan,
    timeline: file,
    timelineSha256: sha256File(file),
    variants,
    generatedAt: new Date().toISOString(),
  };
  if (outPath) {
    const target = abs(outPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`);
  }

  if (flag("--json")) {
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }
  console.log(`\n交付计划（估算，非 SLA）`);
  console.log(`· 素材 ${plan.sourceSeconds}s ｜ 成片 ${plan.outputSeconds}s ｜ 变体 ${plan.variants} 个 ｜ 源片长边 ${plan.sourceMaxEdge}px`);
  console.log(`\n① 极速预览（可选，轻链路）：约 ${plan.previewLane.minutes} 分钟`);
  for (const step of plan.previewLane.steps) console.log(`   - ${step.step}：约 ${step.minutes} 分钟（${step.note}）`);
  console.log(`\n② 默认第一条交付：${plan.fastLane.resolutionLabel}，约 ${plan.fastLane.minutes} 分钟`);
  for (const step of plan.fastLane.steps) console.log(`   - ${step.step}：约 ${step.minutes} 分钟（${step.note}）`);
  if (plan.fourKLane) {
    console.log(`\n③ 可选第二条交付：${plan.fourKLane.resolutionLabel} × ${plan.variants} 个风格，约 ${plan.fourKLane.minutes} 分钟（1080P 交付后先确认，不自动开跑）`);
    for (const step of plan.fourKLane.steps) console.log(`   - ${step.step}：约 ${step.minutes} 分钟（${step.note}）`);
  } else {
    console.log(`\n③ 4K：素材原生就是 1080P，不需要 4K 车道`);
  }
  console.log(`\n④ 本机配置说明：${plan.machine.chip} ${plan.machine.cores} 核 / ${plan.machine.memoryGb}GB（${plan.machine.tier}）：${plan.machine.note}`);
  for (const upgrade of plan.upgrades) {
    console.log(`   - ${upgrade.label}：4K 完整版约 ${upgrade.fourKMinutes} 分钟（省约 ${upgrade.savesPercent}%）— ${upgrade.chipExample}`);
  }
  console.log(`\n话术：${plan.headline}`);
  if (plan.confirmFourK) console.log(`\n交付 1080P 后要问用户：${plan.confirmFourK}`);
  if (outPath) console.log(`\n回执：${abs(outPath)}`);
}

try {
  main();
} catch (error) {
  console.error(`✗ edit-delivery-plan 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
