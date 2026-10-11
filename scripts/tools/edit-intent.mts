#!/usr/bin/env tsx
/**
 * edit-intent —— 创作意图推断（"用户啥都没说"时的默认拍板）。
 *
 * 输入：一条或多条 edit:probe / 镜头理解产物；输出：建议平台、时长带、节奏档案、
 * 受众与情绪目标、选题候选（每条带证据）。显式 `--platform/--duration/--aspect` 覆盖推断。
 * 本产物供 `edit:auto` 与创作岗（creative-weaver / edit-producer）消费：
 * 人审从"填四问"变成"选一个/改一处"。
 *
 * 用法：
 *   pnpm edit:intent -- --analysis <probe.json>… [--platform 抖音] [--duration 60] [--aspect 9:16] \
 *     [--out edit-intent.json] [--json]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { inferEditIntent, type IntentAnalysisDoc } from "../../packages/video-studio/src/edit/index.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

function main(): void {
  const analyses: IntentAnalysisDoc[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== "--analysis" || !process.argv[index + 1]) continue;
    const file = abs(process.argv[index + 1]!);
    if (!existsSync(file)) throw new Error(`素材解析结果不存在：${file}`);
    analyses.push(JSON.parse(readFileSync(file, "utf8")) as IntentAnalysisDoc);
  }
  if (analyses.length === 0) throw new Error("用法：pnpm edit:intent -- --analysis <probe.json> [--platform …] [--duration …]");
  const durationText = arg("--duration");
  const durationHintSeconds = durationText ? Number(durationText) : null;
  if (durationText && (!Number.isFinite(durationHintSeconds) || (durationHintSeconds as number) <= 0)) throw new Error("--duration 需要正数秒");

  const intent = inferEditIntent({
    analyses,
    ...(arg("--platform") ? { platformHint: arg("--platform") } : {}),
    ...(durationHintSeconds ? { durationHintSeconds } : {}),
    ...(arg("--aspect") ? { aspectHint: arg("--aspect") } : {}),
  });
  const report = {
    schema: "workloom.video-edit/intent-report/v1",
    sources: analyses.length,
    totalFootageSeconds: Number(analyses.reduce((sum, doc) => sum + (Number(doc.asset?.durationSeconds) || 0), 0).toFixed(3)),
    intent,
    generatedAt: new Date().toISOString(),
  };
  const outPath = arg("--out");
  if (outPath) {
    const target = abs(outPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (flag("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`✓ 建议方案：平台「${intent.platform}」｜时长带 ${intent.durationBand.label}｜节奏 ${intent.pacingProfile}｜画幅 ${intent.aspectRatio ?? "未知"}`);
    console.log(`  受众：${intent.audience.join(" / ") || "（未命中领域，按平台通用）"}`);
    console.log(`  情绪目标：${intent.emotionGoals.join(" / ") || "（无标签）"}`);
    console.log("  选题候选：");
    for (const topic of intent.topicCandidates) {
      console.log(`   · ${topic.title}（分 ${topic.score}${topic.evidence.length ? `；证据 ${topic.evidence.join("、")}` : ""}）`);
    }
    console.log(`  依据：平台=${intent.basis.platform}｜时长=${intent.basis.duration}`);
    for (const note of intent.notes) console.log(`  ! ${note}`);
    if (outPath) console.log(`  产物：${abs(outPath)}`);
  }
}

try {
  main();
} catch (err) {
  console.error(`✗ edit-intent 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
