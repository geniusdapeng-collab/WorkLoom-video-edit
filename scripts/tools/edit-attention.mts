#!/usr/bin/env tsx
/**
 * edit-attention —— 注意力排期：把"每 5–7 秒一个视觉事件"变成可复算的计划。
 *
 * 输入：裁剪时间轴（段边界）+ 校对稿（词级时间）+ 可选的卡片计划/弹幕计划；
 * 输出：`attention-plan.json`——事件表（卡片/关键词强调/景别切换/弹幕）+ 音效点位（本地合成）+ 体检指标。
 *
 * 纪律（与 packages/video-studio/src/edit/attention.ts 同口径）：
 *   · 密度/时长/覆盖率是**咨询项**；"同刻两个主事件""卡片越界"才是硬项；
 *   · 卡片由内容决定（清单/数字/抽象名词/长铺垫四处），不由密度反推硬塞；
 *   · 音效全部由 sfx-synth 本地合成（无版权风险），只用 whoosh/impact/riser 三种。
 *
 * 用法：
 *   pnpm edit:attention -- --timeline <talk.reframed.timeline.json> --transcript <校对稿.json> \
 *     --out outputs/edit/talk/<id>/attention-plan.json [--cards <cards-plan.json>] [--danmaku <danmaku.json>] \
 *     [--keyword-pattern <regex>]… [--target-gap 6] [--angle-every 52] [--hook-card-sec 3] [--json]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  detectAttentionKeywords, planAttention, type AttentionCardPlan, type AttentionWord,
} from "../../packages/video-studio/src/edit/index.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
function argAll(name: string): string[] {
  const values: string[] = [];
  process.argv.forEach((value, index) => {
    if (value === name && process.argv[index + 1]) values.push(process.argv[index + 1]!);
  });
  return values;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

try {
  const timelinePath = abs(arg("--timeline"));
  const transcriptPath = abs(arg("--transcript"));
  const outPath = abs(arg("--out"));
  if (!timelinePath || !transcriptPath || !outPath) {
    throw new Error("用法：pnpm edit:attention -- --timeline <timeline.json> --transcript <校对稿.json> --out <attention-plan.json>");
  }
  if (!existsSync(timelinePath)) throw new Error(`时间轴不存在：${timelinePath}`);
  if (!existsSync(transcriptPath)) throw new Error(`逐字稿不存在：${transcriptPath}`);

  const timeline = JSON.parse(readFileSync(timelinePath, "utf8")) as {
    timelineId?: string; segments: Array<{ segmentId: string; masterIn: number; masterOut: number; sourceIn?: number; sourceOut?: number }>;
  };
  const transcript = JSON.parse(readFileSync(transcriptPath, "utf8")) as {
    sentences: Array<{ id: string; text: string; start: number; end: number; words: AttentionWord[] }>;
  };
  const words: AttentionWord[] = transcript.sentences.flatMap((sentence) => sentence.words ?? []);
  const durationSeconds = timeline.segments.reduce((max, segment) => Math.max(max, Number(segment.masterOut ?? 0)), 0);

  const cardsPath = arg("--cards");
  const cards: AttentionCardPlan[] = cardsPath && existsSync(abs(cardsPath))
    ? (JSON.parse(readFileSync(abs(cardsPath), "utf8")) as { cards: AttentionCardPlan[] }).cards
    : [];
  const danmakuPath = arg("--danmaku");
  const danmaku = danmakuPath && existsSync(abs(danmakuPath))
    ? (JSON.parse(readFileSync(abs(danmakuPath), "utf8")) as { items?: Array<{ time: number; text?: string }> }).items ?? []
    : [];

  const keywords = detectAttentionKeywords(words, { extraKeywordPatterns: argAll("--keyword-pattern") });
  const plan = planAttention({
    durationSeconds,
    segments: timeline.segments.map((segment) => ({ segmentId: segment.segmentId, masterIn: segment.masterIn, masterOut: segment.masterOut })),
    keywords,
    cards,
    danmaku,
    timelineId: timeline.timelineId ?? null,
    platform: arg("--platform", "抖音"),
    options: {
      targetGapSec: Number(arg("--target-gap", "6")),
      maxGapSec: Number(arg("--max-gap", "7")),
      angleEverySec: Number(arg("--angle-every", "52")),
      hookCardSec: Number(arg("--hook-card-sec", "3")),
      maxCards: Number(arg("--max-cards", "10")),
      keywordPerMinute: { min: Number(arg("--keyword-min", "3")), max: Number(arg("--keyword-max", "6")) },
      subtitleBand: { topRatio: Number(arg("--subtitle-top", "0.78")), bottomRatio: 1 },
      rightRailRatio: Number(arg("--right-rail", "0.11")),
    },
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  const summary = {
    ok: plan.audit.ok,
    out: outPath,
    durationSeconds: plan.generatedFor.durationSeconds,
    events: plan.events.length,
    sfx: plan.sfx.length,
    keywords: plan.keywords.length,
    metrics: plan.audit.metrics,
    hardFailures: plan.audit.hardFailures,
    advisories: plan.audit.advisories,
  };
  if (flag("--json")) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`✓ 注意力排期完成：${plan.events.length} 个视觉事件 · ${plan.sfx.length} 个音效 · ${plan.keywords.length} 个关键词锚点`);
    console.log(`  覆盖率 ${(plan.audit.metrics.coverageRate * 100).toFixed(0)}%（窗口 ${plan.options.targetGapSec}s）· 最大空窗 ${plan.audit.metrics.maxGapSeconds}s · 关键词 ${plan.audit.metrics.keywordPerMinute}/分钟`);
    if (plan.audit.hardFailures.length) console.log(`  ✗ 硬项：${plan.audit.hardFailures.join("；")}`);
    if (plan.audit.advisories.length) console.log(`  ! 咨询项：${plan.audit.advisories.join("；")}`);
    console.log(`  产物：${outPath}`);
  }
  if (!plan.audit.ok) process.exit(1);
} catch (error) {
  console.error(`✗ edit-attention 失败：${(error as Error).message}`);
  process.exit(1);
}
