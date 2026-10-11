#!/usr/bin/env tsx
/**
 * edit-retention-check —— 注意力体检：把"排期表 + 覆盖回执 + 字幕"合成一份可核对的体检报告。
 *
 * 为什么要有这一闸：注意力层的失败模式不是"崩"，而是**悄悄变稀**——卡片没画上、空窗没人补、
 * 关键词挤成一团、字幕压了标题。这里把三类事实合起来判定：
 *   · 排期（attention-plan）：覆盖率 / 最大空窗 / 关键词密度 / 卡片数量与时长（咨询项）、
 *     同刻多主事件与卡片越界（硬项）；
 *   · 渲染（overlay-receipt）：卡片区确实变化、字幕带未被动、时长/分辨率/音轨守恒（硬项）；
 *   · 字幕（SRT）：每行字数、行数（口播口径 ≤2 行 ×12 字）。
 *
 * 用法：
 *   pnpm edit:retention-check -- --attention <attention-plan.json> [--overlay-receipt <json>] \
 *     [--srt <字幕.srt>] --out <体检报告.json> [--json]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { auditAttention, type AttentionCardPlan, type AttentionEvent } from "../../packages/video-studio/src/edit/index.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

try {
  const attentionPath = abs(arg("--attention"));
  const outPath = abs(arg("--out"));
  if (!attentionPath || !outPath) throw new Error("用法：pnpm edit:retention-check -- --attention <attention-plan.json> --out <report.json>");
  if (!existsSync(attentionPath)) throw new Error(`注意力排期不存在：${attentionPath}`);
  const plan = JSON.parse(readFileSync(attentionPath, "utf8")) as {
    schemaVersion: string;
    generatedFor: { durationSeconds: number; timelineId?: string | null; platform?: string | null };
    events: AttentionEvent[];
    options: { targetGapSec: number; maxGapSec: number; angleEverySec: number; hookCardSec: number; maxCards: number; keywordPerMinute: { min: number; max: number } };
    keywords: Array<{ text: string; start: number; end: number }>;
    audit: ReturnType<typeof auditAttention>;
  };
  const duration = plan.generatedFor.durationSeconds;
  /**
   * 卡片要从事件 detail 里取**原始卡片 id**（`ov-price @价值锚点…`），
   * 用事件 id（att-014）会让"同一张卡的分阶段"去重逻辑把所有卡片并成 1 张（实测计数 1）。
   */
  const cards: AttentionCardPlan[] = plan.events
    .filter((event) => ["knowledge-card", "full-card", "lower-third", "pip"].includes(event.kind))
    .map((event) => ({
      id: String(event.detail).split(" @")[0]?.trim() || event.id,
      kind: event.kind as AttentionCardPlan["kind"],
      start: event.at,
      end: event.at + event.durationSec,
      anchor: event.detail,
    }));
  const fresh = auditAttention({
    durationSeconds: duration,
    events: plan.events,
    cards,
    keywords: plan.keywords,
    options: { ...plan.options, subtitleBand: { topRatio: 0.78, bottomRatio: 1 } },
  });

  const hardFailures = [...fresh.hardFailures];
  const advisories = [...fresh.advisories];
  const sections: Array<Record<string, unknown>> = [];

  const overlayPath = arg("--overlay-receipt");
  if (overlayPath && existsSync(abs(overlayPath))) {
    const receipt = JSON.parse(readFileSync(abs(overlayPath), "utf8")) as {
      ok?: boolean; hardFailures?: string[]; overlays?: Array<{ id: string; checks?: Record<string, unknown> }>;
      checks?: Record<string, unknown>;
    };
    for (const failure of receipt.hardFailures ?? []) hardFailures.push(`覆盖渲染：${failure}`);
    sections.push({ kind: "overlay-receipt", path: abs(overlayPath), ok: receipt.ok ?? null, checks: receipt.checks ?? null, overlays: receipt.overlays?.length ?? 0 });
  } else {
    advisories.push("未提供覆盖渲染回执（overlay-receipt）：无法核对卡片是否真的画上去、字幕带是否被动");
  }

  const srtPath = arg("--srt");
  if (srtPath && existsSync(abs(srtPath))) {
    const text = readFileSync(abs(srtPath), "utf8");
    const blocks = text.trim().split(/\n{2,}/u).filter(Boolean);
    let maxLine = 0;
    let overTwoLines = 0;
    let overTwelveChars = 0;
    for (const block of blocks) {
      const lines = block.split("\n").slice(2).filter(Boolean);
      if (lines.length > 2) overTwoLines += 1;
      for (const line of lines) {
        const length = [...line].length;
        maxLine = Math.max(maxLine, length);
        if (length > 12) overTwelveChars += 1;
      }
    }
    if (overTwoLines > 0) hardFailures.push(`字幕 ${overTwoLines} 条超过 2 行（口播口径：一屏 ≤2 行 ×12 字）`);
    if (overTwelveChars > 0) advisories.push(`字幕 ${overTwelveChars} 行超过 12 字`);
    sections.push({ kind: "subtitle", path: abs(srtPath), cues: blocks.length, maxLineChars: maxLine, overTwoLines, overTwelveChars });
  }

  const report = {
    schemaVersion: "workloom.video-edit/retention-report/v1",
    attentionPlan: attentionPath,
    durationSeconds: duration,
    ok: hardFailures.length === 0,
    hardFailures,
    advisories,
    metrics: fresh.metrics,
    windows: fresh.windows,
    gaps: fresh.gaps,
    sections,
    generatedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (flag("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.ok ? "✓" : "✗"} 注意力体检：覆盖率 ${(fresh.metrics.coverageRate * 100).toFixed(0)}% · 最大空窗 ${fresh.metrics.maxGapSeconds}s · 关键词 ${fresh.metrics.keywordPerMinute}/分钟 · 卡片 ${fresh.metrics.cards} 张 · 全屏卡 ${fresh.metrics.fullCards} 张 · 景别切换 ${fresh.metrics.angleSwitches} 次`);
    if (hardFailures.length) console.log(`  硬项：${hardFailures.join("；")}`);
    if (advisories.length) console.log(`  咨询项：${advisories.join("；")}`);
    console.log(`  产物：${outPath}`);
  }
  if (!report.ok) process.exit(1);
} catch (error) {
  console.error(`✗ edit-retention-check 失败：${(error as Error).message}`);
  process.exit(1);
}
