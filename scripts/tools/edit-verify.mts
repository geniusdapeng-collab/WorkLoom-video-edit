#!/usr/bin/env tsx
/**
 * edit-verify —— 剪辑时间轴契约校验（纯事实判定，不花模型钱）
 *
 * 校验项（硬项失败即退出码 1）：
 *   契约字段 / 素材溯源（sha256）/ 源轨重叠 / 同源间隔 / 主轨连续 / 片段时长 / 转场与声音枚举 / 总时长带。
 * 咨询项：间隔未达理想值、片段偏长、总时长轻微偏离——只提示，不阻断。
 *
 * 用法：
 *   pnpm edit:verify -- --timeline work/edit/<film>.timeline.json [--analysis <probe.json>]… \
 *                      [--report work/edit/<film>.cut-report.json] [--json]
 *
 * `--analysis`（可重复）：把素材的 `footage_analysis`（edit:probe 产物）一起带上，质检会额外核对
 * **画面文字 / 人声 / 环境音三字段**是否已采集、并如实标注通道（model / fallback / none）：
 *   · 时间轴引用的素材没有对应解析结果 → 硬失败（不许"没看懂就剪"）；
 *   · 解析结果里三字段未采集 → 咨询项逐条列出（提示走模型主通道或兜底通道补采），不阻断出片。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { resolveTimelineSourcePaths, validateEditTimeline, assertRhythmDirection, type EditTimeline } from "../../packages/video-studio/src/edit/index.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

function main(): void {
  const timelinePath = arg("--timeline");
  if (!timelinePath) throw new Error("用法：pnpm edit:verify -- --timeline <timeline.json>");
  const file = abs(timelinePath);
  if (!existsSync(file)) throw new Error(`时间轴文件不存在：${file}`);
  let timeline: EditTimeline;
  try {
    timeline = resolveTimelineSourcePaths(JSON.parse(readFileSync(file, "utf8")) as EditTimeline, dirname(file));
  } catch (err) {
    throw new Error(`时间轴不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }

  const result = validateEditTimeline(timeline);
  const rhythmDirection = assertRhythmDirection(timeline);

  // —— 三字段核对（画面文字 / 人声 / 环境音）：素材必须已解析；三字段缺采如实列出 ——
  const analysisPaths: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === "--analysis" && process.argv[index + 1]) analysisPaths.push(process.argv[index + 1]!);
  }
  const analyses: Array<{ path: string; doc: Record<string, unknown> }> = [];
  for (const candidate of analysisPaths) {
    const file = abs(candidate);
    if (!existsSync(file)) throw new Error(`解析结果不存在：${file}`);
    analyses.push({ path: file, doc: JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> });
  }
  const fieldChecks: Array<{ checkId: string; pass: boolean; hard: boolean; detail: string }> = [];
  for (const source of timeline.sources ?? []) {
    const matched = analyses.find((entry) => {
      const asset = (entry.doc.asset ?? {}) as { sha256?: string; localPath?: string };
      return asset.sha256 === source.sha256 || asset.localPath === source.path;
    });
    if (!matched) {
      fieldChecks.push({
        checkId: `fields.analysis:${source.sourceId}`,
        pass: false,
        hard: true,
        detail: `素材 ${source.sourceId} 没有对应的解析结果（请先对该素材跑 edit:probe）`,
      });
      continue;
    }
    const probe = (matched.doc.probe ?? {}) as {
      speech?: { sentences?: unknown[] };
      onScreenText?: unknown[];
      ambience?: Record<string, unknown>;
    };
    const coverage = (matched.doc.coverage ?? {}) as {
      asr?: { status?: string; channel?: string };
      ocr?: { status?: string; channel?: string };
    };
    const sentences = probe.speech?.sentences?.length ?? 0;
    const ocrHits = probe.onScreenText?.length ?? 0;
    const ambience = probe.ambience ?? null;
    /** 已跑过扫描（如本机兜底通道）但没检出内容，与"根本没采集"是两回事，措辞必须区分。 */
    const speechScanned = coverage.asr?.status === "ran";
    const ocrScanned = coverage.ocr?.status === "ran";
    const speechReady = sentences > 0;
    const ocrReady = ocrHits > 0;
    const ambienceReady = Boolean(ambience);
    fieldChecks.push({
      checkId: `fields.analysis:${source.sourceId}`,
      pass: true,
      hard: true,
      detail: `素材已解析：人声=${speechReady ? `${sentences} 句` : speechScanned ? "已扫描未检出" : "未采集"}（${coverage.asr?.status ?? "?"}/${coverage.asr?.channel ?? "none"}）；`
        + `画面文字=${ocrReady ? `${ocrHits} 处` : ocrScanned ? "已扫描未检出" : "未采集"}（${coverage.ocr?.status ?? "?"}/${coverage.ocr?.channel ?? "none"}）；`
        + `环境音=${ambienceReady ? `底噪 ${String(ambience?.noiseFloorDb ?? "?")}dB / 人声覆盖 ${String(ambience?.speechCoverage ?? "?")} / 静音覆盖 ${String(ambience?.silenceCoverage ?? "?")}` : "未采集"}`,
    });
    if (!speechReady && !speechScanned) {
      fieldChecks.push({ checkId: `fields.speech:${source.sourceId}`, pass: false, hard: false, detail: "人声未采集：走模型主通道（音频模态）或 edit:probe --asr 兜底通道" });
    }
    if (!ocrReady && !ocrScanned) {
      fieldChecks.push({ checkId: `fields.onScreenText:${source.sourceId}`, pass: false, hard: false, detail: "画面文字未采集：走模型主通道（读关键帧）或 edit:probe --ocr 兜底通道" });
    }
    if (!ambienceReady) {
      fieldChecks.push({ checkId: `fields.ambience:${source.sourceId}`, pass: false, hard: false, detail: "环境音画像未采集：edit:probe 本地计算（噪声底/动态范围/静音与人声覆盖）" });
    }
  }
  const report = {
    schema: "workloom.video-edit/cut-report/v1",
    timeline: file,
    timelineId: timeline.timelineId,
    ok: result.ok && fieldChecks.every((check) => check.pass || !check.hard),
    totalDurationSeconds: result.totalDurationSeconds,
    targetDurationSeconds: timeline.target?.durationSeconds ?? null,
    rhythmDirection: rhythmDirection ? { mode: rhythmDirection.mode, reasons: rhythmDirection.reasons, expectedOutputSeconds: rhythmDirection.expectedOutputSeconds } : null,
    checks: result.checks,
    fixes: result.fixes,
    fieldChecks,
    generatedAt: new Date().toISOString(),
  };
  const reportPath = arg("--report");
  if (reportPath) {
    const target = abs(reportPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (flag("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const check of result.checks) {
      const mark = check.pass ? "✓" : check.hard ? "✗" : "!";
      console.log(`${mark} [${check.hard ? "硬" : "咨询"}] ${check.id}：${check.detail}`);
    }
    if (fieldChecks.length > 0) {
      console.log("\n三字段核对（画面文字 / 人声 / 环境音）：");
      for (const check of fieldChecks) {
        const mark = check.pass ? "✓" : check.hard ? "✗" : "!";
        console.log(`${mark} [${check.hard ? "硬" : "咨询"}] ${check.checkId}：${check.detail}`);
      }
    }
    if (result.fixes.length > 0) {
      console.log("\n返修动作：");
      for (const fix of result.fixes) console.log(`  · ${fix.segmentId} / ${fix.field} → ${fix.action}`);
    }
    console.log(`\n总时长 ${result.totalDurationSeconds}s｜硬项${report.ok ? "全通过" : "存在失败"}${reportPath ? `｜报告：${abs(reportPath)}` : ""}`);
  }
  if (!report.ok) process.exit(1);
}

try {
  main();
} catch (err) {
  console.error(`✗ edit-verify 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
