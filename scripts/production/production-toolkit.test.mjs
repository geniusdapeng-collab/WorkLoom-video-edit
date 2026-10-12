/**
 * 生产工具链自检：语法门 + 两个纯逻辑工具的行为断言（apply-reframe / make-danmaku）。
 *
 * 为什么要这些断言：这两个工具都在"源头口径"上把关——
 *   · apply-reframe --native：原生 4K 输出下必须把 >1 的推近转成显式 allow-upscale，
 *     否则 `edit:post` 的取景机检会硬失败（真机踩过）；
 *   · make-danmaku：源素材时间→主轨时间的换算必须"越界即失败"，不许把弹幕糊到别的句子上。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PROD = join(REPO_ROOT, "scripts", "production");
const TOOLS = join(PROD, "tools");

test("shell 脚本语法（bash -n）", () => {
  for (const file of [join(PROD, "run-pipeline.sh"), join(TOOLS, "qa-video.sh")]) {
    const result = spawnSync("bash", ["-n", file], { encoding: "utf8" });
    assert.equal(result.status, 0, `${file} 语法错误：${result.stderr}`);
  }
});

test("node 工具语法（node --check）", () => {
  for (const file of ["apply-reframe.mjs", "make-danmaku.mjs", "gen-cover.mjs", "gen-insert.mjs"]) {
    const result = spawnSync(process.execPath, ["--check", join(TOOLS, file)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${file} 语法错误：${result.stderr}`);
  }
});

/** 造一份两端时间轴：s1 保留 0–10（主轨 0–10），s2 保留 20–30（主轨 10–20，带 legacy punchIn） */
function fixtureTimeline(dir) {
  const file = join(dir, "timeline.json");
  writeFileSync(file, `${JSON.stringify({
    target: { aspectRatio: "9:16", fps: 30 },
    segments: [
      { segmentId: "s1", sourceIn: 0, sourceOut: 10, masterIn: 0, masterOut: 10, sourceId: "src" },
      { segmentId: "s2", sourceIn: 20, sourceOut: 30, masterIn: 10, masterOut: 20, sourceId: "src", punchIn: { scale: 1.12, x: 0.5, y: 0.4, note: "跳切遮盖" } },
    ],
  }, null, 2)}\n`, "utf8");
  return file;
}

test("apply-reframe：计划命中 + --native 把推近转成 allow-upscale（含 legacy punchIn 归一化）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wlp-apply-reframe-"));
  const timeline = fixtureTimeline(dir);
  const plan = join(dir, "plan.json");
  writeFileSync(plan, `${JSON.stringify({
    // 命中规则按"片段中点"判定：s1 中点在源 5s → 窗口 0–6 命中
    rules: [{ match: { sourceFrom: 0, sourceTo: 6 }, note: "开场推近", reframe: { mode: "push", scale: { from: 1, to: 1.14 } } }],
  })}\n`, "utf8");
  const out = join(dir, "out.json");
  const stdout = execFileSync(process.execPath, [join(TOOLS, "apply-reframe.mjs"), "--timeline", timeline, "--out", out, "--plan", plan, "--native"], { encoding: "utf8" });
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.rulesApplied, 1);
  const merged = JSON.parse(readFileSync(out, "utf8"));
  const s1 = merged.segments[0];
  const s2 = merged.segments[1];
  assert.equal(s1.reframe.maxZoomPolicy, "allow-upscale", "计划里的推近必须转成显式声明");
  assert.equal(s2.reframe.mode, "static");
  assert.equal(s2.reframe.maxZoomPolicy, "allow-upscale");
  assert.equal(s2.reframe.scale.to, 1.12);
  assert.equal("punchIn" in s2, false, "legacy punchIn 应被归一化成显式 reframe");
});

test("apply-reframe：规则未命中任何片段 → fail closed（exit 4）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wlp-apply-reframe-miss-"));
  const timeline = fixtureTimeline(dir);
  const plan = join(dir, "plan.json");
  writeFileSync(plan, `${JSON.stringify({ rules: [{ match: { sourceFrom: 100, sourceTo: 110 }, reframe: { mode: "push", scale: { from: 1, to: 1.1 } } }] })}\n`, "utf8");
  const result = spawnSync(process.execPath, [join(TOOLS, "apply-reframe.mjs"), "--timeline", timeline, "--out", join(dir, "out.json"), "--plan", plan], { encoding: "utf8" });
  assert.equal(result.status, 4, `应 fail closed，实际 ${result.status}：${result.stderr}`);
});

test("make-danmaku：源素材时间 → 成片主轨时间（跨跳切正确平移）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wlp-danmaku-"));
  const timeline = fixtureTimeline(dir);
  const plan = join(dir, "plan.json");
  writeFileSync(plan, `${JSON.stringify({ items: [
    { text: "第一句氛围", sourceTime: 5, mode: "scroll" },
    { text: "跳切之后", sourceTime: 25, mode: "top", colour: "#FFD166" },
  ] })}\n`, "utf8");
  const out = join(dir, "danmaku.json");
  execFileSync(process.execPath, [join(TOOLS, "make-danmaku.mjs"), "--timeline", timeline, "--plan", plan, "--out", out], { encoding: "utf8" });
  const mapped = JSON.parse(readFileSync(out, "utf8")).items;
  assert.equal(mapped.length, 2);
  assert.deepEqual(mapped.map((item) => item.at), [5, 15], "s2 的源 25s 应平移到主轨 15s");
  assert.equal(mapped[1].segmentId, "s2");
});

test("make-danmaku：源时间落在被剪掉的段落 → fail closed（exit 5）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wlp-danmaku-miss-"));
  const timeline = fixtureTimeline(dir);
  const plan = join(dir, "plan.json");
  writeFileSync(plan, `${JSON.stringify({ items: [{ text: "被剪段落", sourceTime: 15 }] })}\n`, "utf8");
  const result = spawnSync(process.execPath, [join(TOOLS, "make-danmaku.mjs"), "--timeline", timeline, "--plan", plan, "--out", join(dir, "out.json")], { encoding: "utf8" });
  assert.equal(result.status, 5, `应 fail closed，实际 ${result.status}`);
});
