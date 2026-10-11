#!/usr/bin/env tsx
/**
 * edit-overlay —— 覆盖层渲染：知识卡 / 画中画 / 下三分之一 / 全屏字卡盖在成片上，**声音保持原声**。
 *
 * 为什么需要独立执行器：口播成片是"单机位长镜头"，视觉变化只能靠覆盖层（信息卡、录屏画中画、字卡）。
 * 与 post-bridge 的分工：post 负责画面母版与变体；本执行器是**后置合成层**，可反复迭代（改卡不改片）。
 *
 * 契约（`overlay-plan.json`）：每条覆盖物 = 资产（PNG/MP4）+ 时间窗 + 归一化布局 + 淡入。
 * 机检（硬项，全部写进回执）：
 *   1. 输出分辨率/时长与输入一致（±0.05s）；
 *   2. 音轨保留（画面覆盖不改声音）；
 *   3. 覆盖窗口内：卡片区域确实发生变化（PSNR 下降，证明画上去了）；
 *   4. 覆盖窗口内：字幕带几乎不被碰（PSNR 不低于阈值，证明没压字幕）。
 *
 * 用法：
 *   pnpm edit:overlay -- --input <成片.mp4> --plan <overlay-plan.json> --out <输出.mp4> \
 *     [--evidence-dir <目录>] [--crf 18] [--json]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { cardFitsSafeArea } from "../../packages/video-studio/src/edit/index.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const FFMPEG = process.env.WL_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.WL_FFPROBE ?? "ffprobe";
const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

interface OverlayItem {
  id: string;
  kind: "knowledge-card" | "full-card" | "lower-third" | "pip";
  start: number;
  end: number;
  asset: { type: "png" | "mp4"; path: string };
  /** 归一化布局（0–1，原点左上）：w/h 为占画布比例，x/y 为左上角位置 */
  layout: { x: number; y: number; w: number; h: number };
  fadeSec?: number;
  opacity?: number;
  radius?: number;
  note?: string;
}

interface OverlayPlan {
  schemaVersion: string;
  overlays: OverlayItem[];
  checks?: { subtitleBand?: { topRatio: number; bottomRatio: number }; rightRailRatio?: number };
}

function run(bin: string, args: string[]): string {
  return execFileSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function probe(file: string): { width: number; height: number; duration: number; hasAudio: boolean } {
  const doc = JSON.parse(run(FFPROBE, ["-v", "error", "-show_entries", "stream=width,height,codec_type:format=duration", "-of", "json", file])) as {
    streams: Array<{ width?: number; height?: number; codec_type?: string }>;
    format: { duration?: string };
  };
  const video = doc.streams.find((stream) => stream.codec_type === "video") ?? {};
  return {
    width: Number(video.width ?? 0),
    height: Number(video.height ?? 0),
    duration: Number(doc.format?.duration ?? 0),
    hasAudio: doc.streams.some((stream) => stream.codec_type === "audio"),
  };
}

/** 两路输入在某时间窗内的区域 PSNR（裁剪到归一化矩形），用于"画上去了/没压字幕"的事实判定 */
function regionPsnr(input: string, output: string, window: { start: number; end: number }, rect: { x: number; y: number; w: number; h: number }, size: { width: number; height: number }): number | null {
  const crop = `crop=${Math.max(2, Math.round(size.width * rect.w))}:${Math.max(2, Math.round(size.height * rect.h))}:${Math.round(size.width * rect.x)}:${Math.round(size.height * rect.y)}`;
  const args = [
    "-hide_banner", "-v", "info", "-ss", String(Math.max(0, window.start + 0.3)), "-t", String(Math.max(0.4, Math.min(2, window.end - window.start - 0.4))),
    "-i", output, "-ss", String(Math.max(0, window.start + 0.3)), "-t", String(Math.max(0.4, Math.min(2, window.end - window.start - 0.4))),
    "-i", input,
    "-lavfi", `[0:v]${crop}[a];[1:v]${crop}[b];[a][b]psnr=stats_file=-`,
    "-f", "null", "-",
  ];
  /**
   * psnr 的统计行走 **stderr**（`[Parsed_psnr] … average:…`），不是 stdout——
   * 早先只读 stdout，导致所有区域判定拿到 null（"画上去 ✗"是假警报，字幕带 ✓ 也是假通过）。
   */
  const result = spawnSync(FFMPEG, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const match = /average:([0-9.]+|inf)/u.exec(text);
  if (!match) return null;
  return match[1] === "inf" ? Number.POSITIVE_INFINITY : Number(match[1]);
}

try {
  const inputPath = abs(arg("--input"));
  const planPath = abs(arg("--plan"));
  const outPath = abs(arg("--out"));
  const crf = arg("--crf", "18");
  if (!inputPath || !planPath || !outPath) {
    throw new Error("用法：pnpm edit:overlay -- --input <成片.mp4> --plan <overlay-plan.json> --out <输出.mp4>");
  }
  if (!existsSync(inputPath)) throw new Error(`输入不存在：${inputPath}`);
  if (!existsSync(planPath)) throw new Error(`覆盖计划不存在：${planPath}`);
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as OverlayPlan;
  const overlays = (plan.overlays ?? []).filter((item) => item.kind);
  if (overlays.length === 0) throw new Error("覆盖计划为空");
  const base = probe(inputPath);
  const band = plan.checks?.subtitleBand ?? { topRatio: 0.78, bottomRatio: 1 };
  const rail = plan.checks?.rightRailRatio ?? 0.11;
  const hardFailures: string[] = [];

  // 计划层硬检：遮挡带 / 画布越界 / 时间窗合法 / 资产存在
  for (const item of overlays) {
    /**
     * 右侧操作栏只在画面**下半部**（抖音/视频号点赞评论区）遮挡内容，因此只有卡片重心落在下半部时才检查它；
     * 上半部的知识卡按平台 UI 事实可以占满宽度（否则"全宽信息卡"永远过不了安全区）。
     */
    const centerY = item.layout.y + item.layout.h / 2;
    const railForThis = item.kind === "full-card" || centerY <= 0.5 ? 0 : rail;
    const fit = cardFitsSafeArea(item.layout, { subtitleBand: band, rightRailRatio: railForThis, allowFullBleed: item.kind === "full-card" });
    if (!fit.ok) hardFailures.push(`覆盖物 ${item.id} 越界：${fit.reasons.join("；")}`);
    if (!(item.end > item.start)) hardFailures.push(`覆盖物 ${item.id} 时间窗非法：${item.start}–${item.end}`);
    const assetPath = abs(item.asset.path);
    if (!existsSync(assetPath)) hardFailures.push(`覆盖物 ${item.id} 资产缺失：${assetPath}`);
  }
  if (base.duration > 0) {
    for (const item of overlays) {
      if (item.end > base.duration + 0.05) hardFailures.push(`覆盖物 ${item.id} 超出成片时长：${item.end}s > ${base.duration.toFixed(2)}s`);
    }
  }
  if (hardFailures.length > 0) {
    throw new Error(`覆盖计划硬项失败（fail-closed）：\n- ${hardFailures.join("\n- ")}`);
  }

  // 渲染链：base + 每条覆盖物 → overlay（enable 时间窗），声音原样 copy
  const args: string[] = ["-hide_banner", "-v", "error", "-y", "-i", inputPath];
  const filters: string[] = [];
  let last = "[0:v]";
  overlays.forEach((item, index) => {
    const assetPath = abs(item.asset.path);
    if (item.asset.type === "png") args.push("-loop", "1", "-i", assetPath);
    else args.push("-i", assetPath);
    const width = Math.max(2, Math.round(base.width * item.layout.w));
    const height = Math.max(2, Math.round(base.height * item.layout.h));
    const fade = Math.max(0, Number(item.fadeSec ?? 0.25));
    const opacity = Math.min(1, Math.max(0.05, Number(item.opacity ?? 1)));
    /**
     * 画中画（mp4 资产）必须把 PTS 平移到它自己的时间窗起点：
     * 否则 3.4s 的插片只在成片 0–3.4s 有效，`enable=between(t,61.2,…)` 那段根本画不上去
     * （本机实测：卡片区 PSNR 46.6dB = 没有变化，被机检抓出）。
     */
    const chain: string[] = item.asset.type === "mp4"
      ? [`setpts=PTS-STARTPTS+${item.start.toFixed(3)}/TB`, `scale=${width}:${height}`, "format=rgba"]
      : [`scale=${width}:${height}`, "format=rgba"];
    if (opacity < 1) chain.push(`colorchannelmixer=aa=${opacity.toFixed(2)}`);
    if (fade > 0) chain.push(`fade=t=in:st=${item.start.toFixed(2)}:d=${fade.toFixed(2)}:alpha=1`);
    if (item.asset.type === "mp4") chain.push(`fps=${30}`);
    const label = `ov${index}`;
    filters.push(`[${index + 1}:v]${chain.join(",")}[${label}]`);
    const next = `[v${index + 1}]`;
    const x = Math.round(base.width * item.layout.x);
    const y = Math.round(base.height * item.layout.y);
    filters.push(`${last}[${label}]overlay=${x}:${y}:enable='between(t,${item.start.toFixed(3)},${item.end.toFixed(3)})'${next}`);
    last = next;
  });
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", last,
    ...(base.hasAudio ? ["-map", "0:a:0", "-c:a", "copy"] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", crf, "-pix_fmt", "yuv420p",
    "-t", base.duration.toFixed(3),
    "-movflags", "+faststart", outPath,
  );
  mkdirSync(dirname(outPath), { recursive: true });
  execFileSync(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const output = probe(outPath);

  // 渲染后机检
  const checksHard: string[] = [];
  if (Math.abs(output.duration - base.duration) > 0.05) checksHard.push(`时长不守恒：${output.duration.toFixed(3)} vs ${base.duration.toFixed(3)}`);
  if (output.width !== base.width || output.height !== base.height) checksHard.push(`分辨率变化：${output.width}×${output.height} vs ${base.width}×${base.height}`);
  if (base.hasAudio && !output.hasAudio) checksHard.push("音轨丢失（覆盖层不得改声音）");

  const bandRect = { x: 0, y: band.topRatio, w: 1, h: Math.max(0.02, band.bottomRatio - band.topRatio) };
  const perOverlay: Array<Record<string, unknown>> = [];
  for (const item of overlays) {
    const window = { start: item.start, end: item.end };
    const cardPsnr = regionPsnr(inputPath, outPath, window, item.layout, base);
    /**
     * 全屏字卡（full-card）是**声明的全屏接管**：它就是要盖住整屏（含字幕带），
     * 因此这一条豁免"字幕带未被压"机检；其余覆盖物一律硬检（漏压字幕带直接失败）。
     */
    const fullBleed = item.kind === "full-card";
    const bandPsnr = fullBleed ? null : regionPsnr(inputPath, outPath, window, bandRect, base);
    const cardChanged = cardPsnr !== null && (cardPsnr === Number.POSITIVE_INFINITY ? false : cardPsnr < 45);
    const bandLeak = !fullBleed && bandPsnr !== null && bandPsnr < 30;
    /** 机检拿不到读数 = 无法证明"画上去了/没压字幕" → fail-closed，不能当通过 */
    if (cardPsnr === null) checksHard.push(`覆盖物 ${item.id} 无法测量卡片区 PSNR（机检不可用）`);
    else if (!cardChanged) checksHard.push(`覆盖物 ${item.id} 区域没有变化（可能没画上去）：PSNR=${cardPsnr.toFixed(2)}`);
    if (!fullBleed) {
      if (bandPsnr === null) checksHard.push(`覆盖物 ${item.id} 无法测量字幕带 PSNR（机检不可用）`);
      else if (bandLeak) checksHard.push(`覆盖物 ${item.id} 疑似压到字幕带：字幕带 PSNR=${bandPsnr.toFixed(2)} < 30`);
    }
    perOverlay.push({
      id: item.id, kind: item.kind, start: item.start, end: item.end,
      asset: { path: abs(item.asset.path), sha256: createHash("sha256").update(readFileSync(abs(item.asset.path))).digest("hex") },
      layout: item.layout,
      checks: { cardRegionChanged: cardChanged, cardRegionPsnr: cardPsnr, subtitleBandPsnr: bandPsnr, subtitleBandUntouched: fullBleed ? "exempt(full-card)" : !bandLeak, fullBleed },
    });
  }

  const receipt = {
    schemaVersion: "workloom.video-edit/overlay-receipt/v1",
    input: { path: inputPath, sha256: createHash("sha256").update(readFileSync(inputPath)).digest("hex"), ...base },
    output: { path: outPath, bytes: statSync(outPath).size, sha256: createHash("sha256").update(readFileSync(outPath)).digest("hex"), ...output },
    plan: planPath,
    audio: base.hasAudio ? "original-kept" : "no-audio",
    overlays: perOverlay,
    checks: { durationPreserved: Math.abs(output.duration - base.duration) <= 0.05, resolutionPreserved: output.width === base.width && output.height === base.height, audioPreserved: base.hasAudio === output.hasAudio },
    hardFailures: checksHard,
    ok: checksHard.length === 0,
    generatedAt: new Date().toISOString(),
  };
  const evidenceDir = abs(arg("--evidence-dir", dirname(outPath)));
  mkdirSync(evidenceDir, { recursive: true });
  const receiptPath = resolve(evidenceDir, "overlay-receipt.json");
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  if (flag("--json")) console.log(JSON.stringify(receipt, null, 2));
  else {
    console.log(`✓ 覆盖渲染完成：${overlays.length} 条覆盖物 → ${outPath}`);
    console.log(`  机检：时长 ${receipt.checks.durationPreserved ? "守恒" : "不守恒"} · 分辨率 ${receipt.checks.resolutionPreserved ? "守恒" : "变化"} · 音轨 ${receipt.checks.audioPreserved ? "保留" : "丢失"}`);
    for (const item of perOverlay) {
      const checks = item.checks as { cardRegionChanged: boolean; subtitleBandUntouched: boolean; cardRegionPsnr: number | null };
      console.log(`  · ${item.id}：画上去 ${checks.cardRegionChanged ? "✓" : "✗"}（PSNR ${checks.cardRegionPsnr === null ? "n/a" : checks.cardRegionPsnr.toFixed(1)}）· 字幕带未动 ${checks.subtitleBandUntouched ? "✓" : "✗"}`);
    }
    console.log(`  回执：${receiptPath}`);
  }
  process.exit(receipt.ok ? 0 : 1);
} catch (error) {
  console.error(`✗ edit-overlay 失败：${(error as Error).message}`);
  process.exit(1);
}
