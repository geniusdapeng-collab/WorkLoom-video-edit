#!/usr/bin/env tsx
/**
 * edit-subtitle —— 《剪辑脚本字幕版（音画强关联）》→ 交付字幕文件的转换与规则门禁。
 *
 * 为什么单独一步（2026-10-10 复盘）：AI 剪辑链路的字幕**不是后期加的一层字**，
 * 而是剪辑脚本的一部分——按**原始素材时间码**绑定镜头写，再映射到成片时间轴。
 * 规则来自封板资产《撰写〈剪辑脚本字幕版（音画强关联）〉agent》：
 *   ① 出现规则：单镜 ≥2.0s 必须上字幕；<2.0s 不上；连续 <2.0s 合并为 VMG，合并 >3.9s 时只在首镜写一条概括；
 *   ② 字数带：ceil(时长×2.0) ≤ 总字数 ≤ floor(时长×2.5)（结尾话术块为固定块，豁免字数带）；
 *   ③ 断句格式：每句独占一行（`\n` 分隔），行内无空格、无标点、无 Emoji、无外文（专有名词除外）；
 *   ④ 结构与时长：video_title ≤12 字无标点；video_id = YYYYMMDD-8位哈希；group_duration = 组内镜头时长之和；
 *      total_duration ≥ 所有镜头结束时间；
 *   ⑤ 结尾话术：最后 ~10s 内留固定话术位（账号口径，允许跨行固定块）。
 *
 * 用法：
 *   pnpm edit:subtitle -- --timeline <film.timeline.json> --caption <剪辑脚本字幕版.json> \
 *     --out <成片字幕.srt> [--report <字幕校验报告.json>] [--json]
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

interface CaptionShot {
  segmentId?: string;
  original_timestamp: string;
  subtitle_text: Array<{ text: string }>;
  role?: string;
}
interface CaptionDoc {
  video_title: string;
  video_id: string;
  total_duration: string;
  video_groups: Array<{ group_name: string; group_duration: string; shots: CaptionShot[] }>;
}

function mmss(seconds: number): string {
  const total = Math.round(seconds);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
function srtTime(seconds: number): string {
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

/** 行内禁标点/空格/Emoji；`\n` 是规定分隔符，必须放行；专有名词外的外文按提示处理 */
const INLINE_FORBIDDEN = /[，。！？、,.!?;；:："'“”‘’()（）[\]【】…—\-·~@#$%^&*+=|\\/<>{}]/u;
const LATIN = /[A-Za-z]{2,}/u;

function main(): void {
  const timelinePath = arg("--timeline");
  const captionPath = arg("--caption");
  const outPath = arg("--out");
  if (!timelinePath || !captionPath || !outPath) {
    throw new Error("用法：pnpm edit:subtitle -- --timeline <film.timeline.json> --caption <剪辑脚本字幕版.json> --out <字幕.srt>");
  }
  const timeline = JSON.parse(readFileSync(abs(timelinePath), "utf8")) as EditTimeline;
  const caption = JSON.parse(readFileSync(abs(captionPath), "utf8")) as CaptionDoc;
  const validation = validateEditTimeline(timeline);
  if (!validation.ok) throw new Error("时间轴未通过契约校验，先修正时间轴再出字幕");

  // 成片时间轴：按片段顺序累加（主轨连续），得到每个 segmentId 的 [start, end)
  const masterStart = new Map<string, number>();
  let cursor = 0;
  for (const segment of timeline.segments) {
    masterStart.set(segment.segmentId, Number(cursor.toFixed(3)));
    cursor = Number((cursor + segment.durationSeconds).toFixed(3));
  }
  const totalSeconds = Number(cursor.toFixed(3));

  const issues: Array<{ id: string; severity: "hard" | "advisory"; detail: string }> = [];
  const cues: Array<{ segmentId: string; start: number; end: number; text: string; role: string }> = [];
  const seen = new Set<string>();
  for (const group of caption.video_groups ?? []) {
    let groupSum = 0;
    for (const shot of group.shots ?? []) {
      const segmentId = shot.segmentId;
      if (!segmentId) {
        issues.push({ id: "caption.segmentId", severity: "hard", detail: `镜头 ${shot.original_timestamp} 缺 segmentId（流水线匹配字段）` });
        continue;
      }
      const segment = timeline.segments.find((entry) => entry.segmentId === segmentId);
      if (!segment) {
        issues.push({ id: `caption.segment:${segmentId}`, severity: "hard", detail: `${segmentId} 不在时间轴里` });
        continue;
      }
      if (seen.has(segmentId)) issues.push({ id: `caption.duplicate:${segmentId}`, severity: "hard", detail: `${segmentId} 在字幕脚本里出现两次` });
      seen.add(segmentId);
      groupSum += segment.durationSeconds;
      const expected = `${segment.segmentId}`;
      void expected;
      const text = shot.subtitle_text?.[0]?.text ?? "";
      const role = shot.role ?? "normal";
      const duration = segment.durationSeconds;
      const start = masterStart.get(segmentId)!;
      const end = Number((start + duration).toFixed(3));
      if (!text) {
        if (duration >= 2.0) issues.push({ id: `caption.missing:${segmentId}`, severity: "hard", detail: `${segmentId} 时长 ${duration}s ≥2s 必须有字幕` });
        continue;
      }
      if (duration < 2.0) issues.push({ id: `caption.tooShort:${segmentId}`, severity: "hard", detail: `${segmentId} 时长 ${duration}s <2s 不应有字幕（VMG 合并需连续短镜）` });
      const plain = text.replace(/\n/gu, "");
      const chars = [...plain].length;
      const lo = Math.ceil(duration * 2);
      const hi = Math.floor(duration * 2.5);
      if (role === "ending-cta") {
        if (start < totalSeconds - 10.5) {
          issues.push({ id: `caption.ctaWindow:${segmentId}`, severity: "advisory", detail: `结尾话术应在最后 10s 内（当前起于 ${start.toFixed(1)}s / 全片 ${totalSeconds}s）` });
        }
      } else if (chars < lo || chars > hi) {
        issues.push({ id: `caption.band:${segmentId}`, severity: "hard", detail: `${segmentId} 字数 ${chars} 不在 ${lo}–${hi}（时长 ${duration}s）` });
      }
      for (const line of text.split("\n")) {
        if (INLINE_FORBIDDEN.test(line)) {
          issues.push({ id: `caption.punct:${segmentId}`, severity: "hard", detail: `${segmentId} 行内含标点/空格：${line}` });
          break;
        }
        if (LATIN.test(line) && !/^[A-Za-z]{1,3}$/u.test(line)) {
          issues.push({ id: `caption.latin:${segmentId}`, severity: "advisory", detail: `${segmentId} 含外文（专有名词可保留）：${line}` });
        }
      }
      cues.push({ segmentId, start, end, text, role });
    }
    const declared = group.group_duration.split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
    if (Math.abs(declared - groupSum) > 1.0) {
      issues.push({ id: `caption.group:${group.group_name}`, severity: "hard", detail: `组「${group.group_name}」时长 ${group.group_duration} 与镜头时长之和 ${mmss(groupSum)} 不符` });
    }
  }
  if ([...caption.video_title].length > 12) {
    issues.push({ id: "caption.title", severity: "hard", detail: `标题超过 12 字：${caption.video_title}` });
  }
  if (INLINE_FORBIDDEN.test(caption.video_title)) {
    issues.push({ id: "caption.titlePunct", severity: "hard", detail: `标题含标点/空格：${caption.video_title}` });
  }
  if (!/^\d{8}-[0-9a-f]{8}$/u.test(caption.video_id)) {
    issues.push({ id: "caption.videoId", severity: "advisory", detail: `video_id 建议形如 YYYYMMDD-8位哈希：${caption.video_id}` });
  }
  const declaredTotal = caption.total_duration.split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
  if (declaredTotal + 1 < totalSeconds) {
    issues.push({ id: "caption.total", severity: "hard", detail: `total_duration ${caption.total_duration} 小于成片时长 ${mmss(totalSeconds)}` });
  }

  cues.sort((a, b) => a.start - b.start);
  const srt = cues.map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`).join("\n");
  const target = abs(outPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, srt, "utf8");
  const report = {
    schema: "workloom.video-edit/subtitle-report/v1",
    caption: abs(captionPath),
    timeline: abs(timelinePath),
    cues: cues.length,
    coveredShots: cues.map((cue) => cue.segmentId),
    totalDuration: mmss(totalSeconds),
    issues,
    ok: issues.every((issue) => issue.severity !== "hard"),
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
    console.log(`✓ 字幕版 → SRT：${cues.length} 条（覆盖 ${cues.length} 个镜头）`);
    for (const issue of issues) console.log(`  ${issue.severity === "hard" ? "✗" : "!"} [${issue.severity === "hard" ? "硬" : "咨询"}] ${issue.id}：${issue.detail}`);
    console.log(`  产物：${target}${reportPath ? `｜报告：${abs(reportPath)}` : ""}`);
  }
  if (!report.ok) process.exit(1);
}

try {
  main();
} catch (err) {
  console.error(`✗ edit-subtitle 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
