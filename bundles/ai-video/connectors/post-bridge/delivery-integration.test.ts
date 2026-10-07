/** 实际总装回归：本地 FFmpeg、仓内调色/字体/配乐，不替换生产函数。 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assembleTimeline, buildDeliveryPackage, callTool, normaliseShots, readRevisionBase, reedit, resolveBinaries } from "./core.mjs";
import { describeAudioStemSources } from "../bgm-bridge/audio-stems.mjs";
import { audioStemReceiptPayload } from "../bgm-bridge/audio-stems-trust.mjs";

const bins = resolveBinaries();
const hasMediaTools = (() => {
  try {
    execFileSync(bins.ffmpeg, ["-version"], { stdio: "ignore" });
    execFileSync(bins.ffprobe, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const readJsonProbe = (file: string) => JSON.parse(execFileSync(bins.ffprobe,
  ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8" }));
const expectedBase = (file: string) => {
  const base = readRevisionBase(file);
  return { expectedVersion: base.version, expectedProjectSha256: base.sha256 };
};

const cliPath = fileURLToPath(new URL("./cli.mjs", import.meta.url));
function testLibrary(root: string) {
  const dir = path.join(root, "custom-library");
  fs.mkdirSync(dir);
  const tracks = [
    ["acoustic-warm", "温暖自在"], ["corporate-clean", "干净可信"], ["sports-hype", "激昂有力"],
  ].map(([style, mood], index) => {
    const file = `${style}.wav`;
    execFileSync(bins.ffmpeg, ["-hide_banner", "-v", "error", "-n", "-f", "lavfi", "-i",
      `sine=frequency=${600 + index * 200}:duration=8`, "-c:a", "pcm_s16le", path.join(dir, file)]);
    return { id: `000-growth-${style}`, title: style, style, mood, file, durationSec: 8,
      license: "workloom-self-generated", source: "offline-synthetic-fixture", artist: "test fixture" };
  });
  fs.writeFileSync(path.join(dir, "tracks.json"), JSON.stringify({ tracks }));
  return dir;
}

describe.skipIf(!hasMediaTools)("后期真实总装与连续返修（需 FFmpeg/FFprobe）", () => {
  let root: string;
  let shots: Array<{ shotId: string; path: string; audioStems: Record<string, any> }>;
  let delivery: Awaited<ReturnType<typeof buildDeliveryPackage>>;
  const env = {
    ...process.env, WORKLOOM_BGM_DISCOVER: "0",
    WORKLOOM_BGM_LIBRARY_DIR: "", WORKLOOM_BGM_HOME: "",
    WORKLOOM_AUDIO_STEM_SIGNING_SECRET: randomBytes(32).toString("hex"), WORKLOOM_AUDIO_STEM_SIGNING_KEY_ID: "synthetic-test-only",
    WORKLOOM_POST_ALLOWED_ROOTS: "", WORKLOOM_BGM_ALLOWED_ROOTS: "",
  };
  const scope = { tenantId: "fixture-t", workspaceId: "fixture-w", projectId: "post-p1-fixture", revision: 1 };
  const project = {
    projectId: "post-p1-fixture",
    audioScope: scope,
    title: "真实回归",
    resolution: [320, 240],
    fps: 30,
    targetDurationSec: 7.5,
    copy: { title: "真实回归", hook: "连续返修", body: "本地合成验证", cta: "查看产物" },
  };
  const subtitles = { zhText: "1\n00:00:00,100 --> 00:00:02,000\n真实回归\n\n" };

  function makeClip(file: string, seed: number, hue: number) {
    // 三个独立噪声信号能查出错位；纯音/静音无法可靠证明拼接血缘和音画窗口。
    execFileSync(bins.ffmpeg, [
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=2.5",
      "-f", "lavfi", "-i", `anoisesrc=color=white:amplitude=0.2:seed=${seed}:sample_rate=48000:duration=2.5`,
      "-vf", `hue=h=${hue}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", file,
    ], { stdio: "pipe", timeout: 30_000 });
  }

  function sourceDescriptors(video: string, shotId: string, seed: number) {
    // Independent audio-only synthetic source; never extract the scored video's audio.
    const file = path.join(root, `ambience-${seed}.wav`);
    execFileSync(bins.ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i",
      `anoisesrc=color=pink:amplitude=0.001:seed=${seed}:sample_rate=48000:duration=2.5`,
      "-c:a", "pcm_f32le", "-ac", "2", file], { stdio: "pipe", timeout: 30000 });
    const stems: Record<string, any> = {
      ambience: { status: "ready", path: file, sha256: hash(file), sourceKind: "synthesized_ambience" },
      ...Object.fromEntries(["dialogue", "foley", "music"].map((role) => [role, { status: "not_applicable", reason: "Synthetic ambience-only test scene" }])),
    };
    for (const { binding, bindingSha256 } of describeAudioStemSources({ scope, shots: [{ shotId, videoSha256: hash(video), durationSec: 2.5, stems }] })) {
      const now = Date.now();
      const receipt: Record<string, string> = { schemaVersion: "workloom.audio-stem-receipt/v1", purpose: "independent-audio-source",
        bindingSha256, workerId: "synthetic-test-worker", jobId: `fixture-${seed}`, evidenceSha256: "e".repeat(64),
        issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(), keyId: "synthetic-test-only" };
      receipt.signature = createHmac("sha256", env.WORKLOOM_AUDIO_STEM_SIGNING_SECRET).update(audioStemReceiptPayload(receipt)).digest("hex");
      stems[binding.role].receipt = receipt;
    }
    return stems;
  }

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "post-p1-")));
    env.WORKLOOM_POST_ALLOWED_ROOTS = root;
    env.WORKLOOM_BGM_ALLOWED_ROOTS = root;
    env.WORKLOOM_BGM_LIBRARY_DIR = testLibrary(root);
    env.WORKLOOM_BGM_HOME = path.join(root, "bgm-home");
    shots = [11, 29, 47].map((seed, index) => {
      const file = path.join(root, `镜头 ${index + 1}.mp4`);
      makeClip(file, seed, index * 35);
      const shotId = `NC-${index + 1}`;
      return { shotId, path: file, audioStems: sourceDescriptors(file, shotId, seed) };
    });
  }, 60_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("硬切与淡入淡出实际拼接三镜并记录加工事实，不默认测品质窗口", async () => {
    for (const mode of ["hard", "fade"]) {
      const output = path.join(root, `assemble-${mode}`, "result.mp4");
      const result = await assembleTimeline({
        clips: shots.map((shot) => ({ ...shot, duration: 2.5 })),
        transitions: { mode, fadeSec: 0.3 }, output, resolution: [320, 240], fps: 30, bins,
      });
      expect(result.avSync).toMatchObject({ qualityReviewed: false, sourceClips: 3, correlation: null });
      expect(readJson(output.replace(/\.mp4$/, ".av-sync.json"))).toMatchObject({ processed: true,
        report: { qualityReviewed: false, sourceClips: 3, correlation: null } });
      const probe = readJsonProbe(output);
      expect(probe.streams.some((stream: any) => stream.codec_type === "video")).toBe(true);
      expect(probe.streams.some((stream: any) => stream.codec_type === "audio")).toBe(true);
      expect(Number(probe.format.duration)).toBeCloseTo(7.5, 1);
    }
  }, 120_000);

  it("无效时长和空镜头明确拒绝，不能以未校验结果继续合流", async () => {
    for (const duration of [undefined, 0, -1, Number.NaN]) {
      await expect(assembleTimeline({
        clips: [{ ...shots[0], duration }], output: path.join(root, "invalid.mp4"), bins,
      })).rejects.toMatchObject({ code: "bad_media" });
    }
    await expect(assembleTimeline({ clips: [], output: path.join(root, "empty.mp4"), bins }))
      .rejects.toMatchObject({ code: "bad_request" });
  });

  it("母版交叉转场不二次扣除各变体源时间轴，三镜真实导出按各自装配时长核对", async () => {
    const sourceHashes = shots.map((shot) => hash(shot.path));
    const outcome = await buildDeliveryPackage({
      project: { ...project, transitions: { mode: "xfade", fadeSec: 0.6 } }, shots,
      variants: ["clean-tech", "bold-promo"], outDir: path.join(root, "xfade-base"), bins, env,
    });
    const sourceSeconds = outcome.normalised.reduce((sum: number, clip: { duration: number }) => sum + clip.duration, 0);
    const check = outcome.checks.find((entry: { kind: string }) => entry.kind === "duration_consistent");
    expect(outcome.passed).toBe(true);
    expect(check.ok).toBe(true);
    expect(check.detail.sourceTimelineSeconds).toBeCloseTo(sourceSeconds, 3);
    expect(outcome.master.output).toBeDefined();
    expect(Number(readJsonProbe(outcome.master.output).format.duration)).toBeCloseTo(sourceSeconds - 1.2, 1);
    for (const variant of outcome.variants) {
      const detail = check.detail.variants.find((entry: { id: string }) => entry.id === variant.id);
      const overlap = variant.style.transitions.mode === "xfade" ? 2 * variant.style.transitions.fadeSec : 0;
      expect(detail.expected).toBeCloseTo(variant.layers.assembly.durationSeconds, 3);
      // Encoded frame/sample clocks quantize xfade boundaries; compare the theoretical
      // overlap separately without pretending it is the actual rendered stream clock.
      const probe = readJsonProbe(variant.artifacts.video.path);
      const videoStream = probe.streams.find((stream: any) => stream.codec_type === "video");
      const [rateNumerator, rateDenominator] = videoStream.avg_frame_rate.split("/").map(Number);
      const frameSeconds = rateDenominator / rateNumerator;
      expect(Math.abs(detail.expected - (sourceSeconds - overlap))).toBeLessThanOrEqual(frameSeconds + 0.001);
      expect(Math.abs(detail.duration - detail.expected)).toBeLessThanOrEqual(frameSeconds + 0.001);
      expect(detail.duration).toBeCloseTo(Number(probe.format.duration), 3);
      expect(variant.artifacts.video.duration).toBeCloseTo(Number(probe.format.duration), 3);
      expect(hash(variant.artifacts.video.path)).toBe(variant.artifacts.video.sha256);
      expect(videoStream).toMatchObject({ width: 320, height: 240 });
      expect(probe.streams.some((stream: any) => stream.codec_type === "audio")).toBe(true);
    }
    expect(shots.map((shot) => hash(shot.path))).toEqual(sourceHashes);
  }, 150_000);

  it("真实交付同时验证有计划和无计划分支，净时长不再抛 ReferenceError", async () => {
    const outDir = path.join(root, "交付 包");
    const sourceHashes = shots.map((shot) => hash(shot.path));
    delivery = await buildDeliveryPackage({
      project, shots, subtitles, variants: ["warm-story", "clean-tech"], outDir, bins, env,
    });
    const duration = delivery.checks.find((check: { kind: string }) => check.kind === "planned_duration_reference");
    const measured = delivery.normalised.reduce((sum: number, clip: { duration: number }) => sum + clip.duration, 0);
    expect(duration.ok).toBe(true);
    expect(duration.detail.actualSourceSeconds).toBeCloseTo(measured, 5);
    expect(duration.detail.plannedSeconds).toBe(7.5);
    expect(delivery.master.avSync.sourceClips).toBe(3);
    expect(fs.existsSync(delivery.manifestPath)).toBe(true);
    expect(shots.map((shot) => hash(shot.path))).toEqual(sourceHashes);

    const unplanned = await buildDeliveryPackage({
      project: { ...project, targetDurationSec: undefined }, shots, subtitles,
      variants: ["warm-story", "clean-tech"], outDir: path.join(root, "unplanned"), bins, env,
    });
    expect(unplanned.checks.find((check: { kind: string }) => check.kind === "planned_duration_reference").detail)
      .toMatchObject({ plannedSeconds: null, actualSourceSeconds: measured, basis: "planning-reference-only" });
    const tooLong = await buildDeliveryPackage({
      project: { ...project, targetDurationSec: 20 }, shots, subtitles,
      variants: ["warm-story", "clean-tech"], outDir: path.join(root, "too-long"), bins, env,
    });
    expect(tooLong.checks.find((check: { kind: string }) => check.kind === "planned_duration_reference"))
      .toMatchObject({ ok: true, detail: { plannedSeconds: 20 } });
    expect(tooLong.passed).toBe(true);
    expect(delivery.checks.find((check: { kind: string }) => check.kind === "bgm_layer").ok).toBe(true);
    for (const variant of delivery.variants) expect(hash(variant.artifacts.video.path)).toBe(variant.artifacts.video.sha256);
    console.info("P1 media evidence", JSON.stringify({
      measuredSeconds: measured, avSync: delivery.master.avSync,
      checks: delivery.checks.map((check: { kind: string; ok: boolean }) => ({ kind: check.kind, ok: check.ok })),
      sourceQualityReviewed: false,
    }));
  }, 300_000);

  it("显式换镜后 v2→v3 持续指向新素材和新归一化文件，未点名镜头保持哈希及 mtime", async () => {
    expect(delivery).toBeDefined();
    const replacement = path.join(root, "新 镜头.mp4");
    makeClip(replacement, 73, 145);
    const oldShots = delivery.filmProject.layers.shots;
    const oldPaths = oldShots.map((shot: { normalised: string }) => path.resolve(delivery.outDir, shot.normalised));
    const oldHashes = oldPaths.map(hash);
    const oldMtimes = oldPaths.map((file: string) => fs.statSync(file).mtimeMs);
    const v2 = await reedit({
      projectPath: delivery.projectPath, deliveryDir: delivery.outDir,
      ...expectedBase(delivery.projectPath),
      patch: { shots: { replace: [{ shotId: "NC-1" }] } }, shotPaths: { "NC-1": replacement }, bins, env,
      audioStemsByShot: { "NC-1": sourceDescriptors(replacement, "NC-1", 73) },
    });
    expect(v2.executed).toBe(true);
    const second = readJson(v2.projectPath);
    const newShot = second.layers.shots[0];
    const newPath = path.resolve(path.dirname(v2.projectPath), newShot.normalised);
    expect(newPath).not.toBe(oldPaths[0]);
    expect(hash(newPath)).toBe(newShot.sha256);
    expect(newShot.sha256).not.toBe(oldHashes[0]);
    expect(path.resolve(path.dirname(v2.projectPath), newShot.source)).toBe(replacement);
    expect(newShot.sourceSha256).toBe(hash(replacement));

    const v3 = await reedit({
      projectPath: v2.projectPath, deliveryDir: delivery.outDir,
      ...expectedBase(v2.projectPath),
      patch: { copy: { body: "第二次只改文案" } }, bins, env,
    });
    const third = readJson(v3.projectPath);
    expect(v3.version).toBe(3);
    expect(v3.targetDir).toBe(path.join(delivery.outDir, "versions", "v3"));
    for (const [index, shot] of third.layers.shots.entries()) {
      const storedPath = path.resolve(path.dirname(v3.projectPath), shot.normalised);
      expect(hash(storedPath)).toBe(shot.sha256);
      expect(storedPath).toBe(index === 0 ? newPath : oldPaths[index]);
    }
    expect(path.resolve(path.dirname(v3.projectPath), third.layers.shots[0].source)).toBe(replacement);
    expect(third.layers.shots[0].sourceSha256).toBe(hash(replacement));
    expect(v3.rebuilt.some((entry: { layer: string }) => entry.layer === "shots")).toBe(false);
    expect(v3.reused.filter((entry: { layer: string }) => entry.layer === "shots")).toHaveLength(3);
    expect(oldPaths.map(hash)).toEqual(oldHashes);
    expect(oldPaths.map((file: string) => fs.statSync(file).mtimeMs)).toEqual(oldMtimes);

    const originalBytes = fs.readFileSync(newPath);
    try {
      fs.appendFileSync(newPath, "external-tamper");
      const rejectedDir = path.join(delivery.outDir, "versions", "v4");
      await expect(reedit({
        projectPath: v3.projectPath, deliveryDir: delivery.outDir, outDir: rejectedDir,
        ...expectedBase(v3.projectPath),
        patch: { copy: { body: "不得接纳漂移" } }, bins, env,
      })).rejects.toMatchObject({ code: "verify_failed", retryable: false });
      expect(fs.existsSync(path.join(rejectedDir, "film-project.json"))).toBe(false);
      expect(fs.existsSync(path.join(rejectedDir, "revision.json"))).toBe(false);
      expect(readJson(path.join(rejectedDir, "revision-failed.json")).code).toBe("verify_failed");
    } finally {
      fs.writeFileSync(newPath, originalBytes);
    }
    const noMusic = await reedit({ projectPath: v3.projectPath, deliveryDir: delivery.outDir,
      ...expectedBase(v3.projectPath), patch: { bgm: { enabled: false } }, bins, env });
    expect(noMusic.version).toBe(5); // The rejected v4 remains reserved.
    expect(noMusic.revision.checks.find((check: { kind: string }) => check.kind === "bgm_layer").ok).toBe(true);
    for (const variant of noMusic.variants) {
      const data = execFileSync(bins.ffmpeg, ["-v", "error", "-i", variant.video.path, "-vn", "-f", "f32le", "-ac", "1", "-ar", "48000", "-"], { maxBuffer: 8 << 20 });
      let squared = 0;
      for (let index = 0; index < data.byteLength; index += 4) squared += data.readFloatLE(index) ** 2;
      expect(Math.sqrt(squared / (data.byteLength / 4))).toBeLessThan(0.002); // Only the independent quiet ambience, no original noise or old BGM.
      expect(readJson(path.join(variant.dir, "audio.json")).track).toBeNull();
    }
    const copyOnly = await reedit({ projectPath: noMusic.projectPath, deliveryDir: delivery.outDir,
      ...expectedBase(noMusic.projectPath), patch: { copy: { body: "保留无配乐版本" } }, bins, env });
    expect(copyOnly.variants.map((variant: any) => variant.video.sha256)).toEqual(noMusic.variants.map((variant: any) => variant.video.sha256));
    expect(copyOnly.revision.checks.find((check: { kind: string }) => check.kind === "bgm_layer").ok).toBe(true);
  }, 300_000);
});

describe.skipIf(!hasMediaTools)("后期显式音轨边界和原节目默认路径", () => {
  let root: string;
  let source: string;
  let nativeDelivery: Awaited<ReturnType<typeof buildDeliveryPackage>>;
  let sourceHash: string;
  const project = { projectId: "native-post", title: "原节目", resolution: [320, 240], fps: 17,
    targetDurationSec: 30, copy: { title: "原节目", hook: "黑帧无声也可加工" } };
  const env: NodeJS.ProcessEnv = { ...process.env, WORKLOOM_BGM_DISCOVER: "0" };
  const badSources = [null, false, 0, "", [], {}, { dialogue: {} }];
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "growth-post-boundary-")));
    source = path.join(root, "original.mp4");
    execFileSync(bins.ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i",
      "color=black:size=160x120:rate=17:duration=0.6", "-an", "-c:v", "libx264", "-preset", "ultrafast", source]);
    sourceHash = hash(source);
    env.WORKLOOM_POST_ALLOWED_ROOTS = root;
    env.WORKLOOM_BGM_ALLOWED_ROOTS = root;
    env.WORKLOOM_BGM_HOME = path.join(root, "bgm-home");
    env.WORKLOOM_BGM_LIBRARY_DIR = testLibrary(root);
    fs.writeFileSync(path.join(root, "project.json"), JSON.stringify(project));
    delete env.WORKLOOM_AUDIO_STEM_SIGNING_SECRET;
  });
  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it("显式 null/false/空或缺角色来源在 core/tool/真实 CLI 创建交付目录前失败", async () => {
    for (const [index, audioStems] of badSources.entries()) {
      const shots = [{ shotId: "S1", path: source, audioStems }];
      for (const entry of ["core", "tool", "cli"]) {
        const outDir = path.join(root, `invalid-${index}-${entry}`);
        if (entry === "core") {
          await expect(buildDeliveryPackage({ project, shots, outDir, bins, env }))
            .rejects.toMatchObject({ code: "audio_stems_source_unverified" });
        } else if (entry === "tool") {
          await expect(callTool("postwrite.package", { project, shots, out_dir: outDir }, { bins, env }))
            .rejects.toMatchObject({ code: "audio_stems_source_unverified" });
        } else {
          const file = path.join(root, `shots-${index}.json`);
          fs.writeFileSync(file, JSON.stringify(shots));
          const result = spawnSync(process.execPath, [cliPath,
            "deliver", "--project", path.join(root, "project.json"), "--shots", file, "--out-dir", outDir],
          { env, encoding: "utf8", timeout: 30_000 });
          expect(result.status).toBe(3);
          expect(result.stderr).toContain("audio_stems_source_unverified");
        }
        expect(fs.existsSync(outDir)).toBe(false);
      }
    }
    expect(hash(source)).toBe(sourceHash);
  }, 120_000);

  it("省略音轨实际加工黑帧无声原片并返修，不要求分轨密钥或品质复检", async () => {
    nativeDelivery = await buildDeliveryPackage({ project, shots: [{ shotId: "S1", path: source }],
      subtitles: { zhText: "1\n00:00:00,100 --> 00:00:00,500\n原片后期\n\n" },
      variants: ["warm-story", "clean-tech"], outDir: path.join(root, "native"), bins, env });
    expect(nativeDelivery.passed).toBe(true);
    expect(nativeDelivery.manifest.independentAudio).toBeNull();
    expect(nativeDelivery.manifest.variants.every((variant: any) => variant.independentAudio === null)).toBe(true);
    expect(nativeDelivery.manifest.master.duration).toBeLessThan(1);
    expect(nativeDelivery.manifest.checks.find((check: any) => check.kind === "planned_duration_reference"))
      .toMatchObject({ ok: true, detail: { plannedSeconds: 30, basis: "planning-reference-only" } });
    const revision = await reedit({ projectPath: nativeDelivery.projectPath, ...expectedBase(nativeDelivery.projectPath),
      patch: { copy: { body: "文字返修" } }, bins, env });
    expect(revision.executed).toBe(true);
    expect(revision.variants.map((variant: any) => variant.video.sha256))
      .toEqual(nativeDelivery.variants.map((variant: any) => variant.artifacts.video.sha256));
    expect(hash(source)).toBe(sourceHash);
  }, 120_000);

  it.each(["core", "tool", "cli"])("%s 交付长标题保留版式建议失败并接受真实封面产物", async (entry) => {
    const title = "成功原片完整长标题不因建议行宽被拒收".repeat(4);
    const requested = { ...project, title, copy: { ...project.copy, title } };
    const outDir = path.join(root, `long-title-${entry}`);
    const options = { project: requested, shots: [{ shotId: "S1", path: source }],
      variants: ["warm-story", "clean-tech"], outDir, bins, env };
    if (entry === "core") {
      const outcome = await buildDeliveryPackage(options);
      expect(outcome.passed).toBe(true);
    } else if (entry === "tool") {
      const outcome = await callTool("postwrite.package", { project: requested, shots: options.shots,
        variants: options.variants, out_dir: outDir }, { bins, env });
      expect(outcome.result.passed).toBe(true);
      expect(outcome.receipt.synced).toBe(true);
    } else {
      const projectFile = path.join(root, "long-title-project.json");
      const shotsFile = path.join(root, "long-title-shots.json");
      fs.writeFileSync(projectFile, JSON.stringify(requested)); fs.writeFileSync(shotsFile, JSON.stringify(options.shots));
      const outcome = spawnSync(process.execPath, [cliPath, "deliver", "--project", projectFile,
        "--shots", shotsFile, "--variants", "warm-story,clean-tech", "--out-dir", outDir], { env, encoding: "utf8", timeout: 120000 });
      expect(outcome.status, outcome.stdout + outcome.stderr).toBe(0);
    }
    const manifest = readJson(path.join(outDir, "delivery-manifest.json"));
    expect(manifest.checks.find((check: any) => check.kind === "covers_valid").ok).toBe(true);
    for (const variant of manifest.variants) {
      const cover = variant.cover;
      expect(cover.text).toContain(title);
      expect(cover.checks.find((check: any) => check.kind === "cover_layout")).toMatchObject({ ok: false, hard: false });
      expect(cover.checks.find((check: any) => check.kind === "cover_font_resolved")).toMatchObject({ ok: true, hard: true });
      expect(hash(path.join(outDir, cover.path))).toBe(cover.sha256);
      const probe = readJsonProbe(path.join(outDir, cover.path));
      expect(probe.streams.find((stream: any) => stream.codec_type === "video")).toMatchObject({ width: 320, height: 240 });
    }
    expect(hash(source)).toBe(sourceHash);
  }, 150_000);

  it("显式错误 audioStemsByShot 在 core/tool/真实返修 CLI 占版本前失败", async () => {
    const baseDir = path.join(root, "invalid-reedit-base");
    fs.mkdirSync(baseDir);
    const projectPath = path.join(baseDir, "film-project.json");
    fs.writeFileSync(projectPath, JSON.stringify({ schemaVersion: "workloom.film-project/v1", projectId: "native-post",
      version: 1, resolution: [320, 240], fps: 17, layers: { shots: [{ shotId: "S1" }], variants: [] } }));
    const patch = { shots: { replace: [{ shotId: "S1" }] } };
    const patchFile = path.join(root, "patch.json");
    fs.writeFileSync(patchFile, JSON.stringify(patch));
    for (const [index, invalid] of [...badSources, { S1: null }, { S1: false }, { S1: {} }].entries()) {
      await expect(reedit({ projectPath, ...expectedBase(projectPath), patch, shotPaths: { S1: source },
        audioStemsByShot: invalid, bins, env })).rejects.toMatchObject({ code: "audio_stems_source_unverified" });
      await expect(callTool("postwrite.reedit", { project_path: projectPath,
        expected_version: 1, expected_project_sha256: hash(projectPath), patch, shot_paths: { S1: source },
        audio_stems_by_shot: invalid }, { bins, env })).rejects.toMatchObject({ code: "audio_stems_source_unverified" });
      const mapFile = path.join(root, `invalid-stems-${index}.json`);
      fs.writeFileSync(mapFile, JSON.stringify(invalid));
      const result = spawnSync(process.execPath, [cliPath,
        "reedit", "--project", projectPath, "--patch", patchFile, "--shot", `S1=${source}`,
        "--audio-stems-by-shot", mapFile], { env, encoding: "utf8", timeout: 30_000 });
      expect(result.status).toBe(3);
      expect(result.stderr).toContain("audio_stems_source_unverified");
      expect(fs.existsSync(path.join(baseDir, "versions"))).toBe(false);
      expect(fs.existsSync(path.join(baseDir, ".revision.lock"))).toBe(false);
    }
  }, 120_000);

  it("UHD 请求是本地目标画布加工，低分辨率文字或原片不自动启动增强模型", async () => {
    const normalized = await normaliseShots({ shots: [{ shotId: "S1", path: source, kind: "text" }],
      project: { projectId: "native-uhd", quality: "uhd", resolution: [3840, 2160], fps: 2 },
      workDir: path.join(root, "uhd-work"), bins, env });
    expect(normalized[0].enhancement).toMatchObject({ status: "not-requested", sourceSha256: sourceHash,
      sourceResolution: [160, 120], method: "local-canvas-resize" });
    const probe = JSON.parse(execFileSync(bins.ffprobe, ["-v", "error", "-show_streams", "-of", "json", normalized[0].path], { encoding: "utf8" }));
    expect(probe.streams.find((stream: any) => stream.codec_type === "video")).toMatchObject({ width: 3840, height: 2160 });
    expect(hash(source)).toBe(sourceHash);
  }, 120_000);
});
