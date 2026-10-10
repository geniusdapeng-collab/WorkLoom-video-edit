#!/usr/bin/env tsx
/**
 * edit-danmaku —— 弹幕轨生成（复用字幕工位的弹幕能力：`subtitlewrite.danmaku` 同口径）。
 *
 * 参数口径（来自 `skills/subtitle-layout-design` + `subtitle-bridge`）：
 *   · 字号走统一字号规则（2026-10-11）：短边 × 场景基准比(弹幕 0.054) × 分辨率档 × 朝向修正 × 粗细修正 × 平台倍率，
 *     按 minPx/maxRatio 夹取（1080p 横屏约 58px，竖屏约 61px，详见 font_db.json#size_policy.resolution_rules）；
 *     2–4 条分道，滚动/顶部/底部三种模式；
 *   · 默认**保留全部传入条目**，不隐式删减；传 `--max-concurrent` 才做密度裁剪并留痕；
 *   · 产出：烧弹幕的视频副本 + 弹幕计划 ASS + 密度体检报告（before/after 并发条数）。
 *
 * 用法：
 *   pnpm edit:danmaku -- --input <带封面片头的成片.mp4> --out <输出.mp4>
 *     [--items <danmaku.json>] [--platform 微信视频号] [--lanes 4] [--opacity 0.85]
 *     [--evidence-dir <目录>] [--json]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

async function main(): Promise<void> {
  const input = arg("--input");
  const output = arg("--out");
  if (!input || !output) throw new Error("用法：pnpm edit:danmaku -- --input <成片.mp4> --out <输出.mp4> [--items danmaku.json]");
  const inputFile = abs(input);
  const outputFile = abs(output);
  if (!existsSync(inputFile)) throw new Error(`输入不存在：${inputFile}`);
  mkdirSync(dirname(outputFile), { recursive: true });
  const itemsFile = arg("--items");
  if (!itemsFile) throw new Error("--items 必填（弹幕条目 JSON：数组或 {items:[…]}）");
  const itemsDoc = JSON.parse(readFileSync(abs(itemsFile), "utf8")) as unknown;
  const items = Array.isArray(itemsDoc) ? itemsDoc : (itemsDoc as { items?: unknown[] }).items ?? [];
  if (items.length === 0) throw new Error("弹幕条目为空");

  const platform = arg("--platform", "微信视频号");
  const lanes = Number(arg("--lanes", "4"));
  const opacity = Number(arg("--opacity", "0.85"));
  const maxConcurrentRaw = arg("--max-concurrent");
  const evidenceDir = abs(arg("--evidence-dir", join(dirname(outputFile), "danmaku-evidence")));
  mkdirSync(evidenceDir, { recursive: true });

  const bridge = await import(`file://${abs("bundles/ai-video/connectors/subtitle-bridge/core.mjs")}`) as {
    parseDanmaku: (input: unknown) => Array<Record<string, unknown>>;
    checkDanmakuDensity: (items: unknown[], options?: Record<string, unknown>) => Record<string, unknown>;
    renderDanmaku: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  const parsed = bridge.parseDanmaku(items);
  const densityBefore = bridge.checkDanmakuDensity(parsed, { windowSec: 1, maxConcurrent: maxConcurrentRaw ? Number(maxConcurrentRaw) : Math.max(1, parsed.length) });

  const fontsDir = abs("bundles/ai-video/library/fonts");
  const report = await bridge.renderDanmaku({
    input: inputFile,
    output: outputFile,
    items,
    platform,
    brief: { 平台: platform, 内容调性: "温暖克制" },
    fontsDir,
    evidenceDir,
    lanes: Number.isInteger(lanes) && lanes > 0 ? lanes : 4,
    opacity: Number.isFinite(opacity) && opacity > 0 && opacity <= 1 ? opacity : 0.85,
    ...(maxConcurrentRaw ? { maxConcurrent: Number(maxConcurrentRaw), windowSec: 1 } : {}),
  });
  if (!existsSync(outputFile)) throw new Error("弹幕渲染结束但没有产物");

  const sha256 = createHash("sha256").update(readFileSync(outputFile)).digest("hex");
  const receipt = {
    schema: "workloom.video-edit/danmaku-receipt/v1",
    input: inputFile,
    output: outputFile,
    sha256,
    entries: parsed.length,
    lanes: lanes,
    modeMix: parsed.reduce<Record<string, number>>((acc, item) => {
      const mode = String(item.mode ?? "scroll");
      acc[mode] = (acc[mode] ?? 0) + 1;
      return acc;
    }, {}),
    densityBefore,
    engine: (report.result ?? report) as unknown,
    evidenceDir,
  };
  const receiptFile = join(evidenceDir, "danmaku-receipt.json");
  writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  if (flag("--json")) console.log(JSON.stringify(receipt, null, 2));
  else {
    console.log(`✓ 弹幕轨完成：${parsed.length} 条 · ${lanes} 分道 · 不透明度 ${opacity}`);
    console.log(`  产物：${outputFile}`);
    console.log(`  回执：${receiptFile}`);
  }
}

main().catch((err) => {
  console.error(`✗ edit-danmaku 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
