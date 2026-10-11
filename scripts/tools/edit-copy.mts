#!/usr/bin/env tsx
/**
 * edit-copy —— 字幕文案的"风格 × 目标 × 人设"执行器。
 *
 * 三个动作（可组合）：
 *   · `--brief`   ：给"文案字幕师"岗位出写作简报（风格/目标/人设/禁用/镜头事实/原字幕）；
 *   · 默认         ：对给定 SRT 做机检（AI 腔、书面语、字数带、标点、句首重复、无据数字），出评分与逐条建议；
 *   · `--rewrite` ：在机检基础上做**保守**的规则化口语替换，写回一份新 SRT（真正的创作仍由岗位完成）。
 *
 * 用法：
 *   pnpm edit:copy -- --srt <原字幕.srt> [--style vlog|promo|knowledge|story|food]
 *     [--persona <persona.json>] [--facts <facts.json>] [--out <新字幕.srt>] [--report <报告.json>]
 *     [--brief] [--rewrite] [--json]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  buildCopyBrief, evaluateCopy, resolveCopyProfile, rewriteCue, type CopyCue, type CopyFacts,
} from "../../packages/video-studio/src/edit/copy-style.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

interface Cue { index: number; start: number; end: number; text: string }

function parseSrt(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/\r\n/gu, "\n").trim().split(/\n{2,}/u);
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length < 3) continue;
    const index = Number(lines[0]);
    const timing = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/u.exec(lines[1] ?? "");
    if (!timing) continue;
    const toSeconds = (h: string, m: string, s: string, ms: string): number => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
    cues.push({
      index: Number.isFinite(index) ? index : cues.length + 1,
      start: toSeconds(timing[1]!, timing[2]!, timing[3]!, timing[4]!),
      end: toSeconds(timing[5]!, timing[6]!, timing[7]!, timing[8]!),
      text: lines.slice(2).join(" "),
    });
  }
  return cues;
}

function formatTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  const pad = (value: number, size = 2): string => String(value).padStart(size, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(ms, 3)}`;
}

function buildSrt(cues: CopyCue[]): string {
  return `${cues.map((cue, index) => [
    String(cue.index ?? index + 1),
    `${formatTime(Number(cue.start ?? 0))} --> ${formatTime(Number(cue.end ?? 0))}`,
    String(cue.text ?? ""),
  ].join("\n")).join("\n\n")}\n`;
}

function main(): void {
  const srtPath = arg("--srt");
  if (!srtPath) throw new Error("用法：pnpm edit:copy -- --srt <字幕.srt> [--style vlog] [--persona p.json] [--facts f.json] [--out 新.srt] [--rewrite]");
  const srtFile = abs(srtPath);
  if (!existsSync(srtFile)) throw new Error(`字幕文件不存在：${srtFile}`);
  const cues = parseSrt(readFileSync(srtFile, "utf8"));
  if (!cues.length) throw new Error(`没有解析到字幕条：${srtFile}`);
  const personaPath = arg("--persona");
  const persona = personaPath && existsSync(abs(personaPath)) ? JSON.parse(readFileSync(abs(personaPath), "utf8")) as Record<string, unknown> : {};
  const factsPath = arg("--facts");
  const facts = factsPath && existsSync(abs(factsPath)) ? JSON.parse(readFileSync(abs(factsPath), "utf8")) as CopyFacts : {};
  const profile = resolveCopyProfile({ styleId: arg("--style", "vlog"), persona });

  if (flag("--brief")) {
    console.log(buildCopyBrief({ profile, cues, facts, goal: arg("--goal") || null, platform: arg("--platform") || null }));
  }

  const evaluation = evaluateCopy({ cues, profile, facts });
  const outPath = arg("--out", join(srtFile.replace(/\.srt$/iu, ""), `${profile.style.id}.styled.srt`));
  const rewritten = flag("--rewrite")
    ? cues.map((cue) => ({ ...cue, text: rewriteCue(cue.text, profile) }))
    : null;
  if (rewritten) writeFileSync(abs(outPath), buildSrt(rewritten), "utf8");
  const reportPath = arg("--report", `${dirOf(abs(outPath))}/${profile.style.id}.copy-report.json`);
  const report = {
    schema: "workloom.video-edit/copy-style-report/v1",
    source: srtFile,
    style: { id: profile.style.id, name: profile.style.name },
    persona: profile.persona,
    bannedWords: profile.bannedWords,
    metrics: evaluation.metrics,
    score: evaluation.score,
    ok: evaluation.ok,
    issues: evaluation.issues,
    rewritten: rewritten ? { path: abs(outPath), cues: rewritten.length } : null,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`文案机检：${evaluation.score}/100（${evaluation.ok ? "通过" : "有硬伤"}）· 风格「${profile.style.name}」`);
  console.log(`  口语标记率 ${(evaluation.metrics.oralMarkerRate * 100).toFixed(0)}% · 人设词率 ${(evaluation.metrics.personaTicRate * 100).toFixed(0)}% · 平均 ${evaluation.metrics.avgChars} 字/条`);
  for (const issue of evaluation.issues.slice(0, 10)) {
    console.log(`  - #${issue.cueIndex} [${issue.code}/${issue.severity}] ${issue.detail}${issue.suggestion ? ` → ${issue.suggestion}` : ""}`);
  }
  console.log(`报告：${reportPath}`);
  if (flag("--json")) console.log(JSON.stringify(report, null, 2));
}

function dirOf(file: string): string {
  const index = file.lastIndexOf("/");
  return index > 0 ? file.slice(0, index) : ".";
}

main();
