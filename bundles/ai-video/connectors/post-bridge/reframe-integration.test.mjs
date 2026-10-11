/**
 * 二次构图（取景轨道）真机集成测试（T-2026-1011-0008）。
 *
 * 口径：无 ffmpeg 的环境自动跳过（与 delivery-integration.test.ts 同款探测）；
 * 有 ffmpeg 时做**事实类**断言：
 *   ① cover 填充：输出画布尺寸正确、左右边缘非纯黑（黑边缺陷＝0）、时长守恒；
 *   ② blur 填充：同上 + 多路图可执行；
 *   ③ 动画推近：zoompan 路径可执行且时长守恒；
 *   ④ 超预算 + lossless 策略：必须 fail-closed（不允许静默上采样）；
 *   ⑤ 未声明 reframe：走旧归一化链，回执不含 reframe（零行为变化）。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { normaliseShots, resolveBinaries } from "./core.mjs";

const bins = resolveBinaries(process.env);
const hasMediaTools = (() => {
  try {
    execFileSync(bins.ffmpeg, ["-version"], { stdio: "ignore" });
    execFileSync(bins.ffprobe, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function probe(file) {
  const doc = JSON.parse(execFileSync(bins.ffprobe, [
    "-v", "error", "-show_entries", "stream=width,height,codec_type:format=duration", "-of", "json", file,
  ], { encoding: "utf8" }));
  const video = doc.streams.find((stream) => stream.codec_type === "video") ?? {};
  return { width: Number(video.width), height: Number(video.height), duration: Number(doc.format?.duration ?? 0) };
}

/** 左边缘 8px 条带的平均亮度（黑边缺陷的最小可用代理）。 */
function edgeLuma(file, height) {
  /** 注意：execFileSync 在设置 encoding 时直接返回 stdout 字符串（不是 {stdout} 对象）。 */
  const stdout = execFileSync(bins.ffmpeg, [
    "-hide_banner", "-v", "info", "-i", file,
    "-vf", `crop=8:${height}:0:0,signalstats,metadata=print:file=-`,
    "-frames:v", "4", "-an", "-f", "null", "-",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const values = [...stdout.matchAll(/YAVG=([0-9.]+)/g)].map((match) => Number(match[1]));
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

async function fixture(run, { width = 1440, height = 2560 } = {}) {
  /**
   * macOS 的 $TMPDIR 是 `/var/folders/...`，realpath 是 `/private/var/folders/...`；
   * audio-stems 的路径守卫只 realpath 允许根、不 realpath 文件，因此测试根必须用 realpath 形态，
   * 否则本机（macOS）会被误判为"不在允许根内"（CI 的 Linux 无此问题）。
   */
  const root = realpathSync(mkdtempSync(join(tmpdir(), "reframe-it-")));
  const source = join(root, "src.mp4");
  execFileSync(bins.ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i",
    `testsrc2=size=${width}x${height}:rate=30:duration=2.5`, "-f", "lavfi", "-i", "sine=frequency=440:duration=2.5",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source]);
  /** 四个工位各有自己的路径白名单（与 edit-post 的 jailRoots 同款）：全部指向临时根。 */
  const env = {
    ...process.env,
    WORKLOOM_POST_ALLOWED_ROOTS: root,
    WORKLOOM_BGM_ALLOWED_ROOTS: root,
    WORKLOOM_COLOR_ALLOWED_ROOTS: root,
    WORKLOOM_SUBTITLE_ALLOWED_ROOTS: root,
  };
  const project = { projectId: "it-reframe", resolution: [540, 960], quality: "hd", fps: 30 };
  try {
    /** 注意：必须 await——否则 finally 会在被测异步流程跑完前删掉临时目录（本测试首版踩过）。 */
    return await run({ root, source, env, project });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const baseReframe = {
  mode: "static", intent: "shot-size", fill: "cover",
  scale: { from: 1, to: 1.05 }, center: { from: { x: 0.5, y: 0.45 }, to: { x: 0.5, y: 0.45 } },
  anchor: "center", easing: "smooth", maxZoomPolicy: "lossless", safeArea: "respect",
};

test("二次构图：横向源 cover 填充裁切填满、无黑边、时长守恒、回执全过", { skip: !hasMediaTools }, async () => {
  const result = await fixture(async ({ root, source, env, project }) => {
    const [clip] = await normaliseShots({
      shots: [{ shotId: "SC-01", path: source, kind: "live-action", reframe: { ...baseReframe, maxZoomPolicy: "allow-upscale" } }],
      project, workDir: join(root, "work"), bins, env,
    });
    /** 断言所需的事实必须在夹具内测量（临时目录在夹具返回后即被清理）。 */
    return {
      probe: probe(clip.path),
      luma: edgeLuma(clip.path, 960),
      passed: clip.reframe.passed,
      receipt: JSON.parse(readFileSync(`${clip.path}.json`, "utf8")).reframe,
    };
  }, { width: 1280, height: 720 });
  assert.equal(result.probe.width, 540);
  assert.equal(result.probe.height, 960);
  assert.ok(Math.abs(result.probe.duration - 2.5) <= 0.2, `时长应守恒，实测 ${result.probe.duration}`);
  assert.ok(result.luma > 6, `cover 不应出现黑边，左边缘亮度=${result.luma}`);
  assert.equal(result.passed, true);
  assert.equal(result.receipt.schemaVersion, "workloom.reframe-receipt/v1");
  assert.ok(result.receipt.checks.every((check) => check.ok !== false), JSON.stringify(result.receipt.checks));
  assert.ok(result.receipt.budget.effectiveUpscale !== null, "应记录等效上采样倍率");
  assert.ok(result.receipt.budget.fillUpscale > 1, "横转竖的填充上采样应如实记账");
});

test("二次构图：横向源 blur 填充可执行（多路图 split/overlay）且无黑边", { skip: !hasMediaTools }, async () => {
  const result = await fixture(async ({ root, source, env, project }) => {
    const [clip] = await normaliseShots({
      shots: [{ shotId: "SC-02", path: source, kind: "live-action", reframe: { ...baseReframe, fill: "blur", scale: { from: 1, to: 1 }, maxZoomPolicy: "allow-upscale" } }],
      project, workDir: join(root, "work"), bins, env,
    });
    return { probe: probe(clip.path), luma: edgeLuma(clip.path, 960), fill: clip.reframe.fill };
  }, { width: 1280, height: 720 });
  assert.equal(result.probe.width, 540);
  assert.equal(result.probe.height, 960);
  assert.ok(result.luma > 6, "blur 填充不应出现黑边");
  assert.equal(result.fill, "blur");
});

test("二次构图：动画推近（zoompan）可执行且时长守恒", { skip: !hasMediaTools }, async () => {
  const result = await fixture(async ({ root, source, env, project }) => {
    const [clip] = await normaliseShots({
      shots: [{ shotId: "SC-03", path: source, kind: "live-action", reframe: { ...baseReframe, mode: "push", scale: { from: 1, to: 1.12 } } }],
      project, workDir: join(root, "work"), bins, env,
    });
    return { probe: probe(clip.path), mode: clip.reframe.mode };
  });
  assert.equal(result.probe.height, 960);
  assert.ok(Math.abs(result.probe.duration - 2.5) <= 0.2, `动画推近不得吞/涨时长，实测 ${result.probe.duration}`);
  assert.equal(result.mode, "push");
});

test("二次构图：超无损预算且策略为 lossless → fail-closed（不静默上采样）", { skip: !hasMediaTools }, async () => {
  await fixture(async ({ root, source, env, project }) => {
    await assert.rejects(
      () => normaliseShots({
        // 竖屏 1440×2560 源 → 540×960 画布的额外推近上限 = 2.67×；请求 3× 必须被拒（fail-closed）。
        shots: [{ shotId: "SC-04", path: source, kind: "live-action", reframe: { ...baseReframe, scale: { from: 1, to: 3 } } }],
        project, workDir: join(root, "work"), bins, env,
      }),
      /取景机检未通过|reframe_zoom_with_budget/u,
    );
  });
});

test("二次构图：未声明 reframe 时沿用旧归一化链（零行为变化）", { skip: !hasMediaTools }, async () => {
  const result = await fixture(async ({ root, source, env, project }) => {
    const [clip] = await normaliseShots({
      shots: [{ shotId: "SC-05", path: source, kind: "live-action" }],
      project, workDir: join(root, "work"), bins, env,
    });
    return {
      probe: probe(clip.path),
      hasReceiptReframe: JSON.parse(readFileSync(`${clip.path}.json`, "utf8")).reframe !== undefined,
      clipReframe: clip.reframe,
      workExists: existsSync(join(root, "work")),
    };
  });
  assert.equal(result.probe.width, 540);
  assert.equal(result.probe.height, 960);
  assert.equal(result.hasReceiptReframe, false);
  assert.equal(result.clipReframe, null);
  assert.ok(result.workExists);
});
