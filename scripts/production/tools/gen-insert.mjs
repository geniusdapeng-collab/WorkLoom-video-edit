#!/usr/bin/env node
/**
 * gen-insert —— AI 插片生成（Ark / 火山方舟 Seedance）：提交任务 → 轮询 → 下载 → 回执。
 *
 * 用途：口播片里"讲解抽象概念"的段落，用一段语义相关的 AI 画面做**画中画插片**补信息密度
 * （例：讲"AI 数字员工在电脑上做后期"时插一段"素材缩略图自动对齐成时间线"）。素材是 1080p，
 * 用作画中画足够——覆盖计划里把窗口设短于素材时长时，请先循环到窗口长度（见 README 五）。
 *
 * 用法：
 *   ARK_API_KEY=… node gen-insert.mjs --prompt "…" --out <插入.mp4>
 *     [--duration 4] [--ratio 9:16] [--first-frame <首帧图 URL>] [--timeout-sec 900]
 *
 * 环境：ARK_API_KEY（必需）、SEEDANCE_MODEL（默认 seedance-2.0）、ARK_BASE_URL（默认官方 v3）。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const prompt = arg("--prompt");
const out = resolve(arg("--out", "insert.mp4"));
if (!prompt || !arg("--prompt")) { console.error("用法：ARK_API_KEY=… node gen-insert.mjs --prompt \"…\" --out <插入.mp4> [--duration 4] [--ratio 9:16] [--first-frame <URL>]"); process.exit(2); }
const apiKey = process.env.ARK_API_KEY;
if (!apiKey) { console.error("缺少 ARK_API_KEY（火山方舟密钥，只在进程环境里传，不要写进文件）"); process.exit(3); }
const baseUrl = (process.env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, "");
const model = process.env.SEEDANCE_MODEL ?? "seedance-2.0";
const duration = Number(arg("--duration", "4"));
const ratio = arg("--ratio", "9:16");
const firstFrame = arg("--first-frame", "");
const timeoutSec = Number(arg("--timeout-sec", "900"));

const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
const content = [{ type: "text", text: prompt }];
if (firstFrame) content.push({ type: "image_url", image_url: { url: firstFrame }, role: "first_frame" });

const submit = await fetch(`${baseUrl}/contents/generations/tasks`, {
  method: "POST",
  headers,
  body: JSON.stringify({ model, content, duration: Math.round(duration), ratio }),
});
if (!submit.ok) { console.error(`提交失败：HTTP ${submit.status} ${(await submit.text()).slice(0, 200)}`); process.exit(4); }
const task = await submit.json();
const taskId = task.id ?? task.task_id;
if (!taskId) { console.error(`提交返回没有任务 id：${JSON.stringify(task).slice(0, 200)}`); process.exit(5); }
console.log(`任务已提交：${taskId}（模型 ${model} · ${duration}s · ${ratio}）`);

const deadline = Date.now() + timeoutSec * 1000;
let video = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 10_000));
  const poll = await fetch(`${baseUrl}/contents/generations/tasks/${taskId}`, { headers });
  if (!poll.ok) { console.error(`轮询失败：HTTP ${poll.status}`); process.exit(6); }
  const body = await poll.json();
  const status = String(body.status ?? "").toLowerCase();
  const url = body.content?.video_url ?? body.video_url ?? body.output?.video_url ?? null;
  if (url && (status === "succeeded" || status === "success" || status === "")) { video = url; break; }
  if (status === "failed" || status === "error") { console.error(`任务失败：${JSON.stringify(body).slice(0, 300)}`); process.exit(7); }
  process.stdout.write(`  …轮询中（${status || "running"}）\n`);
}
if (!video) { console.error(`等待超时（${timeoutSec}s）仍未产出：${taskId}`); process.exit(8); }

const download = await fetch(video);
if (!download.ok) { console.error(`下载失败：HTTP ${download.status}`); process.exit(9); }
mkdirSync(dirname(out), { recursive: true });
const bytes = Buffer.from(await download.arrayBuffer());
writeFileSync(out, bytes);
const receipt = {
  schema: "workloom.video-edit/insert-receipt/v1",
  taskId,
  model,
  prompt,
  durationSec: duration,
  ratio,
  firstFrame: firstFrame || null,
  output: { path: out, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
  sourceUrl: video,
  generatedAt: new Date().toISOString(),
};
writeFileSync(`${out}.receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, out, bytes: bytes.length, taskId }, null, 1));
