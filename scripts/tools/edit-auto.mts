#!/usr/bin/env tsx
/**
 * edit-auto —— 一键自动出片（"用户只丢素材"的最小可用全链路）。
 *
 * 一条命令把本地可确定的环节全部串起来：
 *   probe（逐素材信号层）→ 意图推断（平台/时长带/节奏/选题候选）→ 自动排片（选镜+时间轴）
 *   → 契约校验 → 逐字字幕（有 ASR 就出，没有的段如实留空）→ 本地粗剪
 *   → 正式后期（调色/字幕/配乐/封面/多变体交付）。
 *
 * 边界（说清楚，不冒充）：
 *   · 这是**确定性粗剪**，不含镜头理解与创意评审；要"更懂内容"的版本请让 Agent/创意岗
 *     跑完 understand/highlight/creative 后再用 edit:post 出片；
 *   · 自动字幕只来自 ASR 原文（没有就是没有，不编字）；逐字一致仍按口播口径硬校验；
 *   · 每个环节的真实产物与退出码都写进 auto-receipt.json，中间产物保留可复查。
 *
 * 用法：
 *   pnpm edit:auto -- --inputs <素材目录|a.mp4,b.mp4> --out-dir outputs/edit/auto/<片名> \
 *     [--platform 抖音] [--duration 60] [--aspect 9:16] [--variants warm-story,clean-tech] \
 *     [--title "标题"] [--skip-assemble] [--skip-post] [--json]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  inferEditIntent, planAutoCaptions, planAutoTimeline, type IntentAnalysisDoc,
} from "../../packages/video-studio/src/edit/index.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

interface StepReceipt {
  step: string;
  ok: boolean;
  outputs: string[];
  summary?: unknown;
  error?: string;
}

/** 统一以 `node --import tsx` 调用仓内执行器（不依赖 node_modules/.bin 的 shell 包装）。 */
function runTool(script: string, args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts", "tools", script), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `退出码 ${String(result.status)}`).split("\n").slice(-12).join("\n");
    throw new Error(`${script} 失败（退出码 ${String(result.status)}）：\n${detail}`);
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** 从执行器 `--json` 输出里取最后一个 JSON 对象（用于把关键结论写进总回执） */
function lastJson(stdout: string): unknown {
  const start = stdout.lastIndexOf("\n{");
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start + 1));
  } catch {
    return null;
  }
}

async function sha256File(file: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi)$/iu;

function resolveInputs(raw: string): string[] {
  const path = abs(raw);
  if (existsSync(path) && statSync(path).isDirectory()) {
    return readdirSync(path)
      .filter((file) => VIDEO_EXT.test(file))
      .sort((a, b) => a.localeCompare(b, "zh-Hans-CN", { numeric: true }))
      .map((file) => join(path, file));
  }
  const files = raw.split(",").map((entry) => abs(entry.trim())).filter(Boolean);
  for (const file of files) {
    if (!existsSync(file)) throw new Error(`素材不存在：${file}`);
  }
  return files;
}

async function main(): Promise<void> {
  const inputsArg = arg("--inputs");
  const outDirArg = arg("--out-dir");
  if (!inputsArg || !outDirArg) {
    throw new Error("用法：pnpm edit:auto -- --inputs <素材目录|a.mp4,b.mp4> --out-dir <目录> [--platform …] [--duration …]");
  }
  const inputs = resolveInputs(inputsArg);
  if (inputs.length === 0) throw new Error(`没有找到可用视频素材：${abs(inputsArg)}`);
  const outDir = abs(outDirArg);
  const analysisDir = join(outDir, "analysis");
  const workDir = join(outDir, "work");
  mkdirSync(analysisDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  const steps: StepReceipt[] = [];
  const step = (entry: StepReceipt): void => { steps.push(entry); };

  // ① 逐素材信号层解析
  const analysisPaths: string[] = [];
  const analyses: IntentAnalysisDoc[] = [];
  for (const [index, input] of inputs.entries()) {
    const out = join(analysisDir, `${String(index + 1).padStart(2, "0")}-${createHash("sha256").update(input).digest("hex").slice(0, 8)}.analysis.json`);
    runTool("edit-probe.mts", ["--input", input, "--out", out, "--json"]);
    analysisPaths.push(out);
    analyses.push(JSON.parse(readFileSync(out, "utf8")) as IntentAnalysisDoc);
  }
  step({ step: "probe", ok: true, outputs: analysisPaths, summary: { sources: inputs.length } });

  // ② 意图推断（显式参数优先）
  const intent = inferEditIntent({
    analyses,
    ...(arg("--platform") ? { platformHint: arg("--platform") } : {}),
    ...(arg("--duration") ? { durationHintSeconds: Number(arg("--duration")) } : {}),
    ...(arg("--aspect") ? { aspectHint: arg("--aspect") } : {}),
  });
  const intentPath = join(outDir, "edit-intent.json");
  writeFileSync(intentPath, `${JSON.stringify({ schema: "workloom.video-edit/intent-report/v1", sources: inputs.length, intent, generatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  step({ step: "intent", ok: true, outputs: [intentPath], summary: { platform: intent.platform, durationBand: intent.durationBand, pacing: intent.pacingProfile, topics: intent.topicCandidates.map((topic) => topic.title) } });

  // ③ 自动排片
  const targetSeconds = arg("--duration")
    ? Number(arg("--duration"))
    : Math.round((intent.durationBand.minSeconds + intent.durationBand.maxSeconds) / 2);
  const sources = await Promise.all(inputs.map(async (input, index) => {
    const analysis = analyses[index]!;
    const asset = (analysis.asset ?? {}) as { sha256?: string; fps?: number | null; durationSeconds?: number | null; hasAudio?: boolean | null };
    return {
      sourceId: `src-${String(index + 1).padStart(2, "0")}`,
      path: input,
      sha256: asset.sha256 ?? await sha256File(input),
      fps: asset.fps ?? 30,
      durationSeconds: asset.durationSeconds ?? null,
      hasAudio: asset.hasAudio ?? null,
      analysis,
    };
  }));
  const plan = planAutoTimeline({
    sources,
    timelineId: `auto-${Date.now().toString(36)}`,
    filmId: arg("--title") || null,
    target: {
      durationSeconds: targetSeconds,
      aspectRatio: arg("--aspect") || intent.aspectRatio || "9:16",
      fps: sources[0]?.fps ?? 30,
      platform: intent.platform,
    },
    pacing: intent.pacingProfile,
  });
  if (plan.timeline.segments.length === 0) throw new Error("自动排片没有选出任何镜头：检查素材是否可解码、是否有 ≥1s 的镜头");
  const timelinePath = join(outDir, "auto.timeline.json");
  const planPath = join(outDir, "auto-plan.json");
  writeFileSync(timelinePath, `${JSON.stringify(plan.timeline, null, 2)}\n`, "utf8");
  writeFileSync(planPath, `${JSON.stringify({ targetSeconds: plan.targetSeconds, plannedSeconds: plan.plannedSeconds, selected: plan.selected, skipped: plan.skipped, notes: plan.notes }, null, 2)}\n`, "utf8");
  step({ step: "auto-plan", ok: true, outputs: [timelinePath, planPath], summary: { segments: plan.timeline.segments.length, plannedSeconds: plan.plannedSeconds, skipped: plan.skipped.length, notes: plan.notes } });

  // ④ 时间轴契约校验
  const cutReportPath = join(outDir, "cut-report.json");
  runTool("edit-verify.mts", ["--timeline", timelinePath, ...analysisPaths.flatMap((path) => ["--analysis", path]), "--report", cutReportPath, "--json"]);
  step({ step: "verify", ok: true, outputs: [cutReportPath] });

  // ⑤ 自动字幕（有 ASR 出字；没有的段留空并记录）+ 口播口径硬校验
  const captionPlan = planAutoCaptions({ timeline: plan.timeline, sources: sources.map((source) => ({ sourceId: source.sourceId, analysis: source.analysis })) });
  const captionPath = join(outDir, "auto.captions.json");
  const transcriptPath = join(outDir, "auto.transcript.json");
  writeFileSync(captionPath, `${JSON.stringify(captionPlan.captionDoc, null, 2)}\n`, "utf8");
  writeFileSync(transcriptPath, `${JSON.stringify({ sentences: captionPlan.transcript.sentences }, null, 2)}\n`, "utf8");
  const srtPath = join(outDir, "auto.srt");
  const subtitleReportPath = join(outDir, "subtitle-report.json");
  runTool("edit-subtitle.mts", [
    "--talk", "--allow-silent-shots",
    "--timeline", timelinePath, "--caption", captionPath, "--transcript", transcriptPath,
    "--out", srtPath, "--report", subtitleReportPath, "--json",
  ]);
  step({ step: "subtitle", ok: true, outputs: [captionPath, transcriptPath, srtPath, subtitleReportPath], summary: { cues: captionPlan.cues, silentSegments: captionPlan.gaps.length, gaps: captionPlan.gaps } });

  // ⑥ 本地粗剪（可跳过）
  let roughcutPath: string | null = null;
  if (!flag("--skip-assemble")) {
    roughcutPath = join(outDir, "roughcut.mp4");
    runTool("edit-assemble.mts", ["--timeline", timelinePath, "--out", roughcutPath, "--json"]);
    step({ step: "assemble", ok: true, outputs: [roughcutPath] });
  }

  // ⑦ 正式后期（调色/字幕/配乐/封面/多变体；可跳过）
  let deliveryDir: string | null = null;
  if (!flag("--skip-post")) {
    deliveryDir = join(outDir, "delivery");
    const variants = arg("--variants", "warm-story,clean-tech");
    /** 没有可用字幕（素材无语音转写）时不带空 SRT 进后期：空字幕文件会被后期契约拒绝。 */
    const subtitleArgs = captionPlan.cues > 0 ? ["--subtitle", srtPath] : [];
    const postRun = runTool("edit-post.mts", [
      "--timeline", timelinePath,
      "--out-dir", deliveryDir,
      "--variants", variants,
      ...subtitleArgs,
      "--segment-color",
      "--bgm-section", arg("--bgm-section", "auto"),
      ...analysisPaths.flatMap((path) => ["--analysis", path]),
      ...(arg("--title") ? ["--title", arg("--title")] : []),
      "--platform", intent.platform,
      "--json",
    ]);
    const postSummary = lastJson(postRun.stdout) as {
      coverAtSource?: unknown;
      segmentColor?: unknown;
      bgmPlacement?: unknown;
    } | null;
    step({
      step: "post",
      ok: true,
      outputs: [deliveryDir, join(deliveryDir, "delivery-manifest.json")],
      summary: postSummary
        ? {
          coverAtSource: postSummary.coverAtSource ?? null,
          segmentColor: postSummary.segmentColor ?? null,
          bgmPlacement: postSummary.bgmPlacement ?? null,
        }
        : null,
    });
  }

  const receipt = {
    schema: "workloom.video-edit/auto-receipt/v1",
    inputs,
    outDir,
    target: { platform: intent.platform, durationBand: intent.durationBand, pacing: intent.pacingProfile, requestedSeconds: targetSeconds },
    plan: {
      segments: plan.timeline.segments.length,
      plannedSeconds: plan.plannedSeconds,
      selected: plan.selected,
      skipped: plan.skipped,
      notes: plan.notes,
    },
    subtitle: { cues: captionPlan.cues, silentSegments: captionPlan.gaps, report: subtitleReportPath },
    roughcut: roughcutPath,
    deliveryDir,
    steps,
    notes: [
      "自动粗剪不含镜头理解/创意评审：要更懂内容的版本，请先跑 understand/highlight/creative 再用 edit:post 出片",
      "自动字幕只来自 ASR 原文；无语音段留空并列入 silentSegments（不编字）",
    ],
    generatedAt: new Date().toISOString(),
  };
  const receiptPath = join(outDir, "auto-receipt.json");
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  if (flag("--json")) {
    console.log(JSON.stringify(receipt, null, 2));
  } else {
    console.log(`✓ 一键出片完成：${inputs.length} 个素材 → ${plan.timeline.segments.length} 段 / 计划 ${plan.plannedSeconds}s（目标 ${targetSeconds}s）`);
    console.log(`  平台「${intent.platform}」· 节奏 ${intent.pacingProfile} · 字幕 ${captionPlan.cues} 条（${captionPlan.gaps.length} 段无语音留空）`);
    if (roughcutPath) console.log(`  粗剪：${roughcutPath}`);
    if (deliveryDir) console.log(`  交付包：${deliveryDir}（含多变体/封面/调色/配乐/软字幕轨）`);
    for (const note of plan.notes) console.log(`  · ${note}`);
    console.log(`  回执：${receiptPath}`);
  }
}

main().catch((err) => {
  console.error(`✗ edit-auto 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
