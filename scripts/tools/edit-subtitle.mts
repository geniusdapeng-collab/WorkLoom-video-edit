#!/usr/bin/env tsx
/**
 * edit-subtitle —— 《剪辑脚本字幕版（音画强关联）》→ 交付字幕文件的转换与规则门禁。
 *
 * 为什么单独一步（2026-10-10 复盘）：AI 剪辑链路的字幕**不是后期加的一层字**，
 * 而是剪辑脚本的一部分——按**原始素材时间码**绑定镜头写，再映射到成片时间轴。
 * 规则来自封板资产《撰写〈剪辑脚本字幕版（音画强关联）〉agent》：
 *   ① 出现规则：单镜 ≥2.0s 必须上字幕；<2.0s 不上；连续 <2.0s 合并为 VMG，合并 >3.9s 时只在首镜写一条概括；
 *   ② 字数带：ceil(时长×2.0) ≤ 总字数 ≤ floor(时长×2.5)（结尾话术块为固定块，豁免字数带）；
 *   ③ 断句格式：每句独占一行（`\n` 分隔），行内无空格、无标点、无 Emoji、无外文（专有名词除外），≤4 行；
 *   ④ 结构与时长：video_title ≤12 字无标点；video_id = YYYYMMDD-8位哈希；group_duration = 组内镜头时长之和；
 *      total_duration ≥ 镜头结束时间；结尾话术留最后 ~10s；
 *   ⑤ 信息密度与语速（2026-10-11 增补）：带 `--analysis` 时，把字幕字数与该段**实测口语**对比——
 *      低于口语内容 40% 提示"信息密度不够"，并给出按语速推算的建议最小字数；不改契约字段，只出咨询项。
 *   ⑥ 口播口径（`--talk`，2026-10-11 随 AI 口播精剪管线新增）：口播字幕跟着说话出字——
 *      不套 ≥2s 门槛与字数带，改守一屏 ≤2 行 / 每行 ≤12 字 / 总字数 ≤24；
 *      带 `--transcript <逐字稿.json>` 时做**逐字一致**硬校验（字幕必须等于 ASR 原文）。
 *
 * 判定全部收在 `packages/video-studio/src/edit/caption.ts`（纯函数，可复算）；本执行器只做 IO 与报告。
 *
 * 用法：
 *   pnpm edit:subtitle -- --timeline <film.timeline.json> --caption <剪辑脚本字幕版.json> \
 *     --out <成片字幕.srt> [--analysis <probe.json>]… [--report <字幕校验报告.json>] [--json]
 *   pnpm edit:subtitle -- --talk --timeline … --caption … --transcript <talk.transcript.json> --out …
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  analyzeCaption, cuesToSrtBody, validateEditTimeline, type EditTimeline,
} from "../../packages/video-studio/src/edit/index.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

function readJson(file: string, label: string): Record<string, unknown> {
  if (!existsSync(file)) throw new Error(`${label}不存在：${file}`);
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${label}不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
}

function main(): void {
  const timelinePath = arg("--timeline");
  const captionPath = arg("--caption");
  const outPath = arg("--out");
  const talkMode = flag("--talk");
  /** 自动粗剪放行：无语音/无画面文字的段落允许留空字幕（只降级"缺字"这一条硬项）。 */
  const allowSilentShots = flag("--allow-silent-shots");
  if (!timelinePath || !captionPath || !outPath) {
    throw new Error("用法：pnpm edit:subtitle -- --timeline <film.timeline.json> --caption <剪辑脚本字幕版.json> --out <字幕.srt> [--talk --transcript <逐字稿.json>]");
  }
  const timeline = readJson(abs(timelinePath), "时间轴") as unknown as EditTimeline;
  const caption = readJson(abs(captionPath), "字幕脚本");
  const validation = validateEditTimeline(timeline);
  if (!validation.ok) throw new Error("时间轴未通过契约校验，先修正时间轴再出字幕");

  /**
   * 口播口径（`--talk`）：逐字稿是唯一事实源；提供它时逐字一致是**硬闸**，
   * 未提供时该项只出咨询提示（不得伪称已校验）。
   */
  const transcriptPath = talkMode ? arg("--transcript") : "";
  const talkTranscript = transcriptPath
    ? readJson(abs(transcriptPath), "口播逐字稿") as { sentences?: Array<{ id?: string; words?: Array<{ text?: string; start?: number; end?: number }> }> }
    : null;

  const analyses: Array<Record<string, unknown>> = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === "--analysis" && process.argv[index + 1]) {
      analyses.push(readJson(abs(process.argv[index + 1]!), "素材解析结果"));
    }
  }

  const analysis = analyzeCaption({
    timeline,
    caption: caption as never,
    analyses: analyses as never,
    mode: talkMode ? "talk" : "standard",
    transcript: talkTranscript,
    ...(allowSilentShots ? { allowSilentShots: true } : {}),
  });

  const srt = cuesToSrtBody(analysis.cues);
  const target = abs(outPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, srt, "utf8");

  const densityRows = analysis.metrics.density.filter((row) => row.speechChars !== null && row.captionChars !== null);
  const lowDensity = densityRows.filter((row) => row.densityRatio !== null && row.densityRatio < 0.4);
  const densitySummary = densityRows.length > 0
    ? {
      measuredShots: densityRows.length,
      lowDensityShots: lowDensity.length,
      minRatio: Number(Math.min(...densityRows.map((row) => row.densityRatio ?? 1)).toFixed(2)),
      medianSpeechRateCps: (() => {
        const rates = densityRows.map((row) => row.speechRateCps).filter((value): value is number => value !== null).sort((a, b) => a - b);
        return rates.length ? rates[Math.floor(rates.length / 2)]! : null;
      })(),
      note: "信息密度=字幕字数/同段实测口语字数；低于 0.4 提示补关键信息（咨询项，不阻断）",
    }
    : null;

  const report = {
    schema: "workloom.video-edit/subtitle-report/v1",
    mode: talkMode ? "talk" : "standard",
    transcript: transcriptPath ? abs(transcriptPath) : null,
    caption: abs(captionPath),
    timeline: abs(timelinePath),
    analyses: analyses.map((doc) => String((doc.asset as { localPath?: string } | undefined)?.localPath ?? (doc.asset as { filename?: string } | undefined)?.filename ?? "?")),
    cues: analysis.cues.length,
    coveredShots: analysis.cues.map((cue) => cue.segmentId),
    vmgGroups: analysis.metrics.vmgGroups,
    metrics: analysis.metrics,
    densitySummary,
    totalDuration: analysis.metrics.totalSeconds,
    issues: analysis.issues,
    ok: analysis.ok,
    generatedAt: new Date().toISOString(),
  };
  const reportPath = arg("--report");
  if (reportPath) {
    const file = abs(reportPath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (flag("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`✓ 字幕版 → SRT：${analysis.cues.length} 条（覆盖 ${analysis.cues.length} 个镜头；VMG ${analysis.metrics.vmgGroups.length} 组）`);
    for (const issue of analysis.issues) {
      console.log(`  ${issue.severity === "hard" ? "✗" : "!"} [${issue.severity === "hard" ? "硬" : "咨询"}] ${issue.id}：${issue.detail}`);
    }
    if (densitySummary) {
      console.log(`  信息密度：${densitySummary.measuredShots} 段实测｜低密度 ${densitySummary.lowDensityShots} 段｜最低 ${densitySummary.minRatio}｜口语语速中位 ${densitySummary.medianSpeechRateCps ?? "?"} 字/秒`);
    } else if (analyses.length === 0) {
      console.log("  提示：未提供 --analysis，本轮不做信息密度/语速对比（规则校验已执行）");
    }
    console.log(`  产物：${target}${reportPath ? `｜报告：${abs(reportPath)}` : ""}`);
  }
  if (!analysis.ok) process.exit(1);
}

try {
  main();
} catch (err) {
  console.error(`✗ edit-subtitle 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
