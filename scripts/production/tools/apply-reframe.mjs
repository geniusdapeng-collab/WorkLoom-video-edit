#!/usr/bin/env node
/**
 * apply-reframe —— 给口播时间轴逐段写"二次构图（reframe）"声明（剪辑决策留痕）。
 *
 * 为什么不用全局参数：`--reframe auto` 只给未声明段落加"呼吸感微推"（1.00→1.03），
 * 而口播片的关键节点（开场钩子 / 金句 / 落点）值得明确的镜头语言；逐段声明还能把取景中心
 * 往人脸方向偏（anchor=manual）。另外：**原生分辨率输出（4K）下任何 scale>1 的推近都是
 * 上采样**，机检（`reframe_n`）只接受"无损预算内"或"显式 allow-upscale"两种——`--native`
 * 会把计划声明与历史遗留的静态推近（legacy `punchIn`）统一改成显式声明，避免"以为写了其实被拒"。
 *
 * 用法：
 *   node apply-reframe.mjs --timeline <in.json> --out <out.json> --plan <plan.json> [--native]
 *
 * plan.json：
 *   { "rules": [ { "match": { "sourceFrom": 536, "sourceTo": 543 },
 *                  "reframe": { "mode": "push", "scale": { "from": 1, "to": 1.12 }, "anchor": "manual" },
 *                  "note": "金句：一条片子一两块钱" } ] }
 * 每条规则必须命中至少一个片段，否则 fail closed（避免"以为加了其实没加"）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const flag = (name) => args.includes(name);

const timelinePath = resolve(arg("--timeline"));
const outPath = resolve(arg("--out"));
const planPath = resolve(arg("--plan"));
const native = flag("--native");
if (!existsSync(timelinePath) || !existsSync(planPath)) {
  console.error("用法：node apply-reframe.mjs --timeline <in.json> --out <out.json> --plan <plan.json> [--native]");
  process.exit(2);
}

const timeline = JSON.parse(readFileSync(timelinePath, "utf8"));
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const applied = [];

for (const rule of plan.rules ?? []) {
  const { sourceFrom, sourceTo } = rule.match ?? {};
  if (!Number.isFinite(sourceFrom) || !Number.isFinite(sourceTo)) {
    console.error(`规则缺少 sourceFrom/sourceTo：${JSON.stringify(rule.match)}`);
    process.exit(3);
  }
  const hits = (timeline.segments ?? []).filter((segment) => {
    const mid = (segment.sourceIn + segment.sourceOut) / 2;
    return mid >= sourceFrom && mid <= sourceTo;
  });
  if (hits.length === 0) {
    console.error(`二次构图规则未命中任何片段（fail closed）：${sourceFrom}-${sourceTo} ${rule.note ?? ""}`);
    process.exit(4);
  }
  for (const segment of hits) {
    segment.reframe = { ...rule.reframe, note: rule.note ?? rule.reframe?.note ?? "二次构图（剪辑声明）" };
    applied.push({
      segmentId: segment.segmentId,
      sourceIn: segment.sourceIn,
      sourceOut: segment.sourceOut,
      mode: segment.reframe.mode,
      scale: segment.reframe.scale,
    });
  }
}

/** 原生分辨率：把所有 >1 的取景声明改成显式 allow-upscale（含历史遗留 punchIn 的归一化）。 */
let nativeConverted = 0;
let legacyConverted = 0;
if (native) {
  for (const segment of timeline.segments ?? []) {
    const spec = segment.reframe ?? null;
    const punch = segment.punchIn ?? null;
    if (spec) {
      const max = Math.max(Number(spec.scale?.from ?? 1), Number(spec.scale?.to ?? 1));
      if (max > 1.0001 && spec.maxZoomPolicy !== "allow-upscale") {
        spec.maxZoomPolicy = "allow-upscale";
        nativeConverted += 1;
      }
      continue;
    }
    if (punch && Number(punch.scale) > 1.0001) {
      const x = Number.isFinite(punch.x) ? punch.x : 0.5;
      const y = Number.isFinite(punch.y) ? punch.y : 0.46;
      segment.reframe = {
        mode: "static",
        intent: "shot-size",
        scale: { from: 1, to: Number(punch.scale) },
        center: { from: { x, y }, to: { x, y } },
        anchor: "manual",
        easing: "smooth",
        fill: "pad",
        maxZoomPolicy: "allow-upscale",
        safeArea: "respect",
        note: String(punch.note ?? "跳切遮盖推近") + "｜原生输出：显式声明 allow-upscale",
      };
      delete segment.punchIn;
      legacyConverted += 1;
    }
  }
}

writeFileSync(outPath, `${JSON.stringify(timeline, null, 2)}\n`, "utf8");
const receipt = {
  schema: "workloom.video-edit/apply-reframe/v1",
  timeline: timelinePath,
  plan: planPath,
  out: outPath,
  native,
  rulesApplied: applied.length,
  applied,
  nativePolicyUpgraded: nativeConverted,
  legacyPunchInConverted: legacyConverted,
  generatedAt: new Date().toISOString(),
};
writeFileSync(join(dirname(outPath), "reframe-apply-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, rulesApplied: applied.length, nativePolicyUpgraded: nativeConverted, legacyPunchInConverted: legacyConverted, out: outPath }, null, 1));
