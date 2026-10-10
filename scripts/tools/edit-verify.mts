#!/usr/bin/env tsx
/**
 * edit-verify —— 剪辑时间轴契约校验（纯事实判定，不花模型钱）
 *
 * 校验项（硬项失败即退出码 1）：
 *   契约字段 / 素材溯源（sha256）/ 源轨重叠 / 同源间隔 / 主轨连续 / 片段时长 / 转场与声音枚举 / 总时长带。
 * 咨询项：间隔未达理想值、片段偏长、总时长轻微偏离——只提示，不阻断。
 *
 * 用法：
 *   pnpm edit:verify -- --timeline work/edit/<film>.timeline.json [--report work/edit/<film>.cut-report.json] [--json]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { validateEditTimeline, type EditTimeline } from "../../packages/video-studio/src/edit/index.js";

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
    timeline = JSON.parse(readFileSync(file, "utf8")) as EditTimeline;
  } catch (err) {
    throw new Error(`时间轴不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }

  const result = validateEditTimeline(timeline);
  const report = {
    schema: "workloom.video-edit/cut-report/v1",
    timeline: file,
    timelineId: timeline.timelineId,
    ok: result.ok,
    totalDurationSeconds: result.totalDurationSeconds,
    targetDurationSeconds: timeline.target?.durationSeconds ?? null,
    checks: result.checks,
    fixes: result.fixes,
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
    if (result.fixes.length > 0) {
      console.log("\n返修动作：");
      for (const fix of result.fixes) console.log(`  · ${fix.segmentId} / ${fix.field} → ${fix.action}`);
    }
    console.log(`\n总时长 ${result.totalDurationSeconds}s｜硬项${result.ok ? "全通过" : "存在失败"}${reportPath ? `｜报告：${abs(reportPath)}` : ""}`);
  }
  if (!result.ok) process.exit(1);
}

try {
  main();
} catch (err) {
  console.error(`✗ edit-verify 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
