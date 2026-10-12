#!/usr/bin/env node
/**
 * make-danmaku —— 把"按源素材时间写的弹幕计划"换算成"成片主轨时间"的弹幕计划。
 *
 * 为什么要这一步：校对稿与弹幕灵感都来自**源素材时间**，而弹幕渲染吃的是**成片主轨时间**；
 * 跳切之后两者不是同一根时间轴（割掉的部分会让弹幕飘到别的句子上）。这里按时间轴段
 * （sourceIn/Out ↔ masterIn/Out）逐条换算，**越界直接失败**（不猜、不后移）。
 *
 * 用法：
 *   node make-danmaku.mjs --timeline <talk.reframed.timeline.json> --plan <plan.json> --out <danmaku.json>
 *
 * plan.json：{ "items": [ { "text": "一两块钱", "sourceTime": 543.0, "mode": "scroll",
 *                          "colour": "#FFD166", "sizeScale": 1.0, "note": "氛围" } ] }
 * 输出：{ items: [ { at, text, mode, colour, sizeScale, sourceTime, segmentId } ] }（at = 主轨秒）
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const timelinePath = resolve(arg("--timeline"));
const planPath = resolve(arg("--plan"));
const outPath = resolve(arg("--out"));
if (!existsSync(timelinePath) || !existsSync(planPath)) {
  console.error("用法：node make-danmaku.mjs --timeline <timeline.json> --plan <plan.json> --out <danmaku.json>");
  process.exit(2);
}

const timeline = JSON.parse(readFileSync(timelinePath, "utf8"));
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const segments = timeline.segments ?? [];
if (segments.length === 0) { console.error("时间轴没有片段"); process.exit(3); }
const items = plan.items ?? [];
if (items.length === 0) { console.error("弹幕计划为空"); process.exit(4); }

const mapped = [];
const failures = [];
for (const item of items) {
  const sourceTime = Number(item.sourceTime);
  if (!Number.isFinite(sourceTime)) { failures.push(`缺少 sourceTime：${JSON.stringify(item).slice(0, 80)}`); continue; }
  const hit = segments.find((segment) => sourceTime >= segment.sourceIn - 0.02 && sourceTime <= segment.sourceOut + 0.02);
  if (!hit) { failures.push(`sourceTime ${sourceTime}s 不在任何保留片段内（被剪掉的段落不能放弹幕）：${String(item.text).slice(0, 20)}`); continue; }
  const at = Number((hit.masterIn + (sourceTime - hit.sourceIn)).toFixed(3));
  const entry = { at, text: String(item.text), mode: item.mode ?? "scroll" };
  if (item.colour) entry.colour = String(item.colour);
  if (Number.isFinite(Number(item.sizeScale))) entry.sizeScale = Number(item.sizeScale);
  entry.sourceTime = sourceTime;
  entry.segmentId = hit.segmentId;
  mapped.push(entry);
}

if (failures.length) {
  console.error(`弹幕换算失败（fail closed，共 ${failures.length} 条）：`);
  for (const line of failures) console.error("  - " + line);
  process.exit(5);
}

mapped.sort((a, b) => a.at - b.at);
writeFileSync(outPath, `${JSON.stringify({ items: mapped }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  ok: true,
  count: mapped.length,
  firstAt: mapped[0]?.at ?? null,
  lastAt: mapped[mapped.length - 1]?.at ?? null,
  out: outPath,
}, null, 1));
