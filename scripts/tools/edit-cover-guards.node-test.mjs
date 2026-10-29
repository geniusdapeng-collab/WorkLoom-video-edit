import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");
const CLI = join(ROOT, "scripts/tools/edit-cover.mts");
const FFMPEG = process.env.WL_FFMPEG || process.env.FFMPEG_PATH || "ffmpeg";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "edit-cover-guards-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, "master.mp4"), outDir = join(root, "out");
  mkdirSync(outDir, { recursive: true });
  const media = spawnSync(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x25303a:s=64x96:r=30:d=2",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    "-map", "0:v:0", "-map", "1:a:0", "-t", "2",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", input,
  ], { encoding: "utf8", timeout: 30000 });
  assert.equal(media.status, 0, media.stderr || "fixture ffmpeg failed");
  return { root, input, outDir };
}

function run(f, extra, env = {}) {
  const hasRenderer = extra.includes("--renderer");
  const hasBurnIntro = extra.includes("--burn-intro");
  return spawnSync(process.execPath, ["--import", "tsx", CLI,
    "--input", f.input, "--out-dir", f.outDir, "--platform", "抖音",
    "--title", "测试封面", ...(hasRenderer ? [] : ["--renderer", "ffmpeg"]), ...(hasBurnIntro ? [] : ["--burn-intro", "0"]),
    ...extra,
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}:${process.env.PATH || ""}`,
      WL_FFMPEG: FFMPEG,
      WL_FFPROBE: process.env.WL_FFPROBE || process.env.FFPROBE_PATH || "ffprobe",
      ...env,
    },
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

test("explicit missing input files fail closed instead of silently disabling cover features", t => {
  const f = fixture(t);
  for (const [args, pattern] of [
    [["--copies", join(f.root, "missing-copy-deck.json")], /--copies.*不存在/],
    [["--variant-copy", join(f.root, "missing-variant-copy.json")], /--variant-copy.*不存在/],
    [["--account", "missing-account"], /账号档案不存在/],
  ]) {
    const result = run(f, ["--variants", "warm-story", ...args]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, pattern);
  }
});

test("unknown variants fail closed unless explicitly style-mapped", t => {
  const f = fixture(t);
  const result = run(f, ["--variants", "campaign-cut"]);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /封面样式|未显式映射/);
});

test("explicit compositor renderer never silently falls back to ffmpeg", t => {
  const f = fixture(t);
  const result = run(f, [
    "--variants", "warm-story",
    "--renderer", "compositor",
    "--bridge-url", "http://127.0.0.1:9",
  ]);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /COMPOSITOR_UNAVAILABLE|工位不可达/);
  assert.equal(existsSync(join(f.outDir, "delivery-manifest.json")), false);
});

test("cover-burned complete video is promoted out of staging to the canonical variant path", t => {
  const f = fixture(t);
  const variantDir = join(f.outDir, "variants", "warm-story");
  mkdirSync(variantDir, { recursive: true });
  copyFileSync(f.input, join(variantDir, "warm-story.burned.mp4"));
  const result = run(f, ["--variants", "warm-story", "--burn-intro", "0.6"], { WL_FFMPEG: FFMPEG });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const complete = join(variantDir, "warm-story.burned.cover.mp4");
  assert.ok(existsSync(complete));
  const summaryLine = (result.stdout + result.stderr).split("\n").find((line) => line.includes("设计稿："));
  assert.ok(summaryLine);
  const planFile = summaryLine.split("设计稿：")[1].split("｜")[0];
  const plan = JSON.parse(readFileSync(planFile, "utf8"));
  assert.equal(plan.copyDeck, null);
  const reportFile = summaryLine.split("机检：")[1].trim();
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  assert.equal(report.introBurned[0].introSeconds, 0.6);
  assert.equal(report.introBurned[0].output, complete);
  assert.equal(report.publish[0].file, "variants/warm-story/warm-story.burned.cover.mp4");
  assert.equal(report.publish[0].completeVideo, true);
});
