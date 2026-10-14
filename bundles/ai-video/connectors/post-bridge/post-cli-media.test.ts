/** Actual CLI and media boundary tests. All inputs are local synthetic fixtures; production functions are not mocked. */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, test, expect } from "vitest";
import { applyPostRhythmSound } from "./rhythm-post.mjs";
import { normaliseShots, resolveBinaries } from "./core.mjs";
import { inspectDeliveryManifest } from "./quality-gate.mjs";
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const bins = resolveBinaries();
const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const json = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const media = (file: string) => JSON.parse(execFileSync(bins.ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8" }));
let root: string, out: string, timeline: any, plan: any, env: NodeJS.ProcessEnv, original: string[];
function command(script: string, args: string[], override: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; text: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repo, "node_modules/tsx/dist/cli.mjs"), path.join(repo, script), ...args], { cwd: repo, env: { ...env, ...override }, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk)); child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject); child.on("close", code => resolve({ code, text: Buffer.concat(chunks).toString("utf8") }));
  });
}
beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "post-cli-media-"))); out = path.join(root, "delivery");
  const library = path.join(root, "music"); fs.mkdirSync(library);
  execFileSync(bins.ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=660:duration=9", "-c:a", "pcm_s16le", path.join(library, "music.wav")]);
  write(path.join(library, "tracks.json"), { tracks: ["acoustic-warm", "corporate-clean"].map((style, index) => ({ id: `synthetic-${index}`, title: "Local fixture", style, mood: index ? "干净可信" : "温暖自在", file: "music.wav", durationSec: 9, license: "workloom-self-generated", source: "offline-synthetic-fixture", artist: "test" })) });
  env = { ...process.env, WORKLOOM_BGM_DISCOVER: "0", WORKLOOM_BGM_LIBRARY_DIR: library, WORKLOOM_BGM_HOME: path.join(root, "bgm-home"),
    WORKLOOM_POST_WORK_DIR: path.join(root, "post-work"), WORKLOOM_POST_ALLOWED_ROOTS: root, WORKLOOM_COLOR_ALLOWED_ROOTS: root,
    WORKLOOM_SUBTITLE_ALLOWED_ROOTS: `${root}:${path.join(repo, "bundles/ai-video/library/fonts")}`, WORKLOOM_BGM_ALLOWED_ROOTS: root };
  const sources = [0, 1, 2].map(index => {
    const file = path.join(root, `source-${index}.mp4`);
    execFileSync(bins.ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=5", "-f", "lavfi", "-i", `sine=frequency=${440 + index * 200}:duration=5`, "-vf", `hue=h=${index * 60}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
    return { sourceId: `S${index}`, sha256: sha(file), path: file, fps: 30, durationSeconds: 5, hasAudio: true };
  });
  original = sources.map(source => source.sha256);
  const durations = [0.5, 2, 3];
  const segments = sources.map((source, index) => ({ seq: index, segmentId: `clip-${index}`, sourceId: source.sourceId, sourceIn: index ? 0 : 1, sourceOut: (index ? 0 : 1) + durations[index]!, durationSeconds: durations[index], motive: "实际剪辑测试", transitionIn: { type: "cut", durationSeconds: 0 } }));
  timeline = { schemaVersion: "workloom.video-edit/edit-timeline/v2", timelineId: "actual-native-fast-cut", pacing: { profile: "fast_cut" }, target: { durationSeconds: 5.5, aspectRatio: "16:9", fps: 30, platform: "微信视频号" }, sources, segments, audioDesign: { originalAudioPolicy: "keep" } };
  plan = { profile: "fast-cut", segments: segments.map((segment: any, index: number) => ({ id: segment.segmentId, sourceId: segment.sourceId, inSeconds: segment.sourceIn, outSeconds: segment.sourceOut, durationSeconds: segment.durationSeconds, role: index === 0 ? "fast" : index === 1 ? "hold" : "breath", cutReason: segment.motive })), soundCues: [{ atSeconds: 0.5, kind: "impact", reason: "动作强调", gainDb: -14 }] };
  write(path.join(root, "timeline.json"), timeline); write(path.join(root, "rhythm.json"), plan); write(path.join(root, "danmaku.json"), [{ at: 0.2, text: "看见山和饺子" }]);
  fs.writeFileSync(path.join(root, "caption.srt"), "1\n00:00:00,100 --> 00:00:02,000\n看山吃饺子\n\n");
  const missingPack = path.join(root, "missing-home", "Downloads", "optional-pack");
  expect(fs.existsSync(path.join(root, "missing-home"))).toBe(false);
  const result = await command("scripts/tools/edit-post.mts", ["--timeline", path.join(root, "timeline.json"), "--out-dir", out, "--variants", "warm-story,clean-tech", "--rhythm-plan", path.join(root, "rhythm.json"), "--subtitle", path.join(root, "caption.srt"), "--danmaku", path.join(root, "danmaku.json"), "--title", "看山吃饺子", "--bgm-section", "full", "--bgm-pack", missingPack, "--json"]);
  expect(result.text, "actual edit-post stdout/stderr").toBeTruthy(); expect(result.code, result.text).toBe(0);
  expect(fs.existsSync(path.join(root, "missing-home"))).toBe(false);
}, 180_000);
afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });
test("actual edit-post preserves native pixels/frames, default declared hard cuts, requested text forms and SFX", async () => {
  const manifest = json(path.join(out, "delivery-manifest.json"));
  expect(manifest.resolution).toEqual([320, 180]); expect(manifest.nativeResolution).toEqual([320, 180]); expect(manifest.postQuality.passed).toBe(true);
  const rhythm = json(path.join(out, "edit-rhythm-receipt.json")); expect(rhythm.status).toBe("passed"); expect(rhythm.actualClips.map((clip: any) => clip.media.videoFrames)).toEqual([15, 60, 90]);
  expect(manifest.postRequirements.danmaku).toBe(true); expect(manifest.danmaku.forms).toHaveLength(2);
  for (const variant of manifest.variants) {
    expect(variant.style.transitions.mode).toBe("hard"); expect(variant.burned.path).toBeTruthy(); expect(variant.softsub.path).toBeTruthy();
    const proof = manifest.processing.find((row: any) => row.id === `${variant.id}-sound`);
    const document = json(path.join(out, proof.path)); expect(document.execution.videoPacketsUnchanged).toBe(true); expect(document.execution.placements[0].atSec).toBe(0.5);
    expect(media(path.join(out, variant.video.path)).streams.find((stream: any) => stream.codec_type === "video").nb_read_frames).toBe("165");
  }
  expect(timeline.sources.map((source: any) => sha(source.path))).toEqual(original);
  expect((await inspectDeliveryManifest({ root: out, manifest, bins })).passed).toBe(true);
}, 60_000);
test("explicit fast cut rejects speed changes and partial/downsampled canvas before formal completion", async () => {
  const changed = structuredClone(timeline); changed.segments[0].speed = 2; changed.segments[0].durationSeconds = 0.25; write(path.join(root, "speed.json"), changed);
  for (const [suffix, args] of [["speed", ["--timeline", path.join(root, "speed.json"), "--rhythm-plan", path.join(root, "rhythm.json")]], ["partial", ["--timeline", path.join(root, "timeline.json"), "--width", "160"]], ["downsample", ["--timeline", path.join(root, "timeline.json"), "--width", "160", "--height", "90"]]] as Array<[string, string[]]>) {
    const result = await command("scripts/tools/edit-post.mts", [...args, "--out-dir", path.join(root, suffix)]); expect(result.code).not.toBe(0); expect(fs.existsSync(path.join(root, suffix, "delivery-manifest.json"))).toBe(false);
  }
}, 45_000);
test("actual cover CLI without a timeline publishes declared intro forms and preserves every soft subtitle stream", async () => {
  const result = await command("scripts/tools/edit-cover.mts", ["--input", path.join(out, "master/master-clean.mp4"), "--out-dir", out, "--variants", "warm-story,clean-tech", "--title", "看山吃饺子", "--hook", "吃饺子", "--burn-intro", "0.2", "--renderer", "ffmpeg"]);
  expect(result.code, result.text).toBe(0);
  const manifest = json(path.join(out, "delivery-manifest.json")); expect(manifest.coverIntro.forms.length).toBeGreaterThan(0);
  const project = json(path.join(out, "film-project.json"));
  for (const variant of manifest.variants) {
    const saved = project.layers.variants.find((row: any) => row.id === variant.id);
    expect(saved.artifacts.cover.path).toBe(variant.cover.path);
    expect(saved.artifacts.cover.sha256).toBe(sha(path.join(out, variant.cover.path)));
    expect(saved.style.cover).toMatchObject({ title: "看山吃饺子", hook: "吃饺子" });
  }
  for (const form of manifest.coverIntro.forms.filter((row: any) => row.form === "softsub" || row.form === ".softsub")) expect(media(path.join(out, form.output ?? form.path)).streams.some((stream: any) => stream.codec_type === "subtitle")).toBe(true);
  expect((await inspectDeliveryManifest({ root: out, manifest, bins })).passed).toBe(true);
}, 120_000);
test("actual Chinese package selects declared burned/danmaku/intro assets and repairs an owned stale file", async () => {
  const args = ["--delivery", out, "--title", "看山吃饺子", "--version", "V1"];
  let result = await command("scripts/tools/edit-package.mts", args); expect(result.code, result.text).toBe(0);
  let manifest = json(path.join(out, "delivery-manifest.json")); expect(manifest.displaySet.artifacts.some((row: any) => row.role === "danmaku")).toBe(true);
  for (const row of manifest.displaySet.artifacts) { expect(sha(row.path)).toBe(row.sha256); expect(sha(row.source)).toBe(row.sha256); }
  const owned = manifest.displaySet.artifacts[0]; fs.unlinkSync(owned.path); fs.writeFileSync(owned.path, "stale owned bytes");
  expect((await inspectDeliveryManifest({ root: out, manifest, bins })).passed).toBe(false);
  result = await command("scripts/tools/edit-package.mts", args); expect(result.code, result.text).toBe(0);
  manifest = json(path.join(out, "delivery-manifest.json")); expect(sha(owned.path)).toBe(sha(owned.source)); expect((await inspectDeliveryManifest({ root: out, manifest, bins })).passed).toBe(true);
}, 90_000);
test("Chinese package refuses unknown collisions and unregistered publish-shaped files", async () => {
  const args = ["--delivery", out, "--title", "看山吃饺子", "--version", "V1"];
  const manifest = json(path.join(out, "delivery-manifest.json")), row = manifest.displaySet.artifacts[0];
  fs.unlinkSync(row.path); fs.writeFileSync(row.path, "unowned collision"); fs.unlinkSync(path.join(out, "交付/交付清单.json"));
  const result = await command("scripts/tools/edit-package.mts", args); expect(result.code).not.toBe(0); expect(result.text).toMatch(/其他文件占用/); expect(fs.readFileSync(row.path, "utf8")).toBe("unowned collision");
  fs.unlinkSync(row.path);
}, 45_000);
test("actual SFX adapter validates source bytes and refuses a plan that disagrees with the current video clock", async () => {
  const source = path.join(out, "master/master-clean.mp4"), before = sha(source);
  const result = await applyPostRhythmSound({ input: source, plan, workDir: path.join(root, "sfx-adapter"), bins, env });
  expect(result.receipt.programmeSpeed).toBe(1); expect(result.receipt.videoPacketsUnchanged).toBe(true); expect(sha(source)).toBe(before);
  const wrong = structuredClone(plan); wrong.segments[2].outSeconds = 4; wrong.segments[2].durationSeconds = 4;
  await expect(applyPostRhythmSound({ input: source, plan: wrong, workDir: path.join(root, "sfx-invalid"), bins, env })).rejects.toMatchObject({ code: "rhythm_processing_failed", retryable: false });
}, 60_000);
test("normalization applies HDR conversion before 8-bit canvas encoding and retains current source hash", async () => {
  const file = path.join(root, "pq.mkv");
  execFileSync(bins.ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=1", "-vf", "format=yuv420p10le", "-c:v", "ffv1", "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc", "-color_range", "tv", file]);
  const before = sha(file), outputs = await normaliseShots({ shots: [{ shotId: "HDR", path: file }], workDir: path.join(root, "hdr-normalize"), project: { resolution: [320, 180], fps: 30 }, bins, env });
  expect(sha(file)).toBe(before); const video = media(outputs[0].path).streams.find((stream: any) => stream.codec_type === "video");
  expect(video.color_primaries).toBe("bt709"); expect(video.color_transfer).toBe("bt709"); expect(video.color_space).toBe("bt709"); expect(video.nb_read_frames).toBe("30");
  expect(outputs[0].colorManagement.chain).toMatch(/tonemap=/); expect(outputs[0].filterChain.indexOf("tonemap=")).toBeLessThan(outputs[0].filterChain.lastIndexOf("format=yuv420p"));
}, 30_000);

test("editorial shot labels cannot move normalized output into the source directory", async () => {
  const source = timeline.sources[0].path, before = sha(source), workDir = path.join(root, "labels-normalize");
  for (const shotId of ["../../victim", "剪辑标签/山与饺子", "..\\source-0"]) {
    const [clip] = await normaliseShots({ shots: [{ shotId, path: source }], project: { resolution: [320, 180], fps: 30 }, workDir, bins, env });
    expect(clip.shotId).toBe(shotId); expect(path.dirname(clip.path)).toBe(path.join(workDir, "norm"));
    expect(sha(source)).toBe(before); expect(clip.path).not.toBe(source);
  }
}, 30_000);

test("failed cover candidates preserve the accepted manifest and every accepted cover and intro", async () => {
  const manifestFile = path.join(out, "delivery-manifest.json"), before = sha(manifestFile), manifest = json(manifestFile);
  const projectFile = path.join(out, "film-project.json"), projectBefore = sha(projectFile);
  const accepted = [...manifest.variants.map((row: any) => path.join(out, row.cover.path)), ...(manifest.coverIntro?.forms ?? []).map((row: any) => path.join(out, row.output ?? row.path))];
  const hashes = accepted.map(sha);
  const result = await command("scripts/tools/edit-cover.mts", ["--input", path.join(out, "master/master-clean.mp4"), "--out-dir", out,
    "--variants", "warm-story,clean-tech", "--title", "看山吃饺子", "--hero-sec", "999", "--renderer", "ffmpeg"]);
  expect(result.code).not.toBe(0); expect(sha(manifestFile)).toBe(before); expect(accepted.map(sha)).toEqual(hashes);
  expect(sha(projectFile)).toBe(projectBefore);
}, 45_000);

test("an existing optional pack outside the original roots remains usable and read only through the actual edit-post CLI", async () => {
  const pack = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "post-owned-pack-")));
  const delivery = path.join(root, "existing-pack-delivery");
  try {
    fs.copyFileSync(path.join(root, "music", "music.wav"), path.join(pack, "music.wav"));
    fs.copyFileSync(path.join(root, "music", "tracks.json"), path.join(pack, "tracks.json"));
    const files = fs.readdirSync(pack).sort(), before = files.map(file => sha(path.join(pack, file)));
    const result = await command("scripts/tools/edit-post.mts", ["--timeline", path.join(root, "timeline.json"),
      "--out-dir", delivery, "--variants", "warm-story,clean-tech", "--rhythm-plan", path.join(root, "rhythm.json"),
      "--bgm-section", "full", "--bgm-pack", pack, "--title", "Owned local pack", "--json"],
    { WORKLOOM_BGM_LIBRARY_DIR: pack });
    expect(result.code, result.text).toBe(0);
    const manifest = json(path.join(delivery, "delivery-manifest.json"));
    expect(manifest.postQuality.passed).toBe(true);
    for (const variant of manifest.variants) {
      const audio = json(path.join(delivery, "variants", variant.id, "audio.json"));
      expect(audio.track.id).toMatch(/^synthetic-[01]$/);
      expect(audio.track.sourceSha256).toBe(before[files.indexOf("music.wav")]);
    }
    expect((await inspectDeliveryManifest({ root: delivery, manifest, bins })).passed).toBe(true);
    expect(fs.readdirSync(pack).sort()).toEqual(files);
    expect(files.map(file => sha(path.join(pack, file)))).toEqual(before);
    expect(timeline.sources.map((source: any) => sha(source.path))).toEqual(original);
  } finally { fs.rmSync(pack, { recursive: true, force: true }); }
}, 120_000);

test("an optional pack that is a file fails before processing and preserves its bytes and all source media", async () => {
  const pack = path.join(root, "pack-is-a-file"), delivery = path.join(root, "pack-file-refused");
  fs.writeFileSync(pack, "owned fixture must not be replaced by a directory\n");
  const before = sha(pack);
  const result = await command("scripts/tools/edit-post.mts", ["--timeline", path.join(root, "timeline.json"),
    "--out-dir", delivery, "--bgm-pack", pack, "--json"]);
  expect(result.code, result.text).toBe(1);
  expect(result.text).toContain(`本地曲库根不是目录：${pack}`);
  expect(fs.existsSync(path.join(delivery, "delivery-manifest.json"))).toBe(false);
  expect(fs.readdirSync(delivery)).toEqual([]);
  expect(sha(pack)).toBe(before);
  expect(timeline.sources.map((source: any) => sha(source.path))).toEqual(original);
}, 30_000);

test("real EACCES in the current optional-root declaration is rethrown rather than treated as an absent library", async () => {
  const script = path.join(repo, "scripts/tools/edit-post.mts"), bytes = fs.readFileSync(script), source = bytes.toString("utf8");
  const start = source.indexOf("  const optionalMusicRoots = "), end = source.indexOf("  const jailRoots = ", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  expect(source.indexOf("  const optionalMusicRoots = ", start + 1)).toBe(-1);
  // Execute the entire current production declaration with actual Node/fs errors.
  // No fs operation, production function, HOME, or user library is replaced.
  const declaration = source.slice(start, end);
  const parent = path.join(root, "permission-denied-pack-parent"), pack = path.join(parent, "pack");
  fs.mkdirSync(pack, { recursive: true });
  fs.writeFileSync(path.join(pack, "sentinel"), "owned permission fixture\n");
  const before = sha(path.join(pack, "sentinel")), rootMode = fs.statSync(root).mode & 0o777;
  const uid = process.getuid?.();
  expect(typeof uid).toBe("number");
  const program = `import {statSync} from 'node:fs';import {join} from 'node:path';import {homedir} from 'node:os';\nconst bgmPack=process.argv[1];\n${declaration}\nconsole.log(JSON.stringify(optionalMusicRoots));`;
  try {
    fs.chmodSync(root, 0o755); fs.chmodSync(parent, 0o000);
    const result = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
      // CI containers run as root; use an unprivileged child only for this owned fixture.
      const child = spawn(process.execPath, ["--input-type=module", "--eval", program, pack],
        { cwd: os.tmpdir(), env: process.env, ...(uid === 0 ? { uid: 65534, gid: 65534 } : {}), stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      child.stdout.on("data", chunk => chunks.push(chunk)); child.stderr.on("data", chunk => chunks.push(chunk));
      child.on("error", reject); child.on("close", code => resolve({ code, text: Buffer.concat(chunks).toString("utf8") }));
    });
    expect(result.code, result.text).not.toBe(0);
    expect(result.text).toMatch(/EACCES/);
    expect(result.text).toContain(pack);
    expect(result.text).not.toContain('console.log(JSON.stringify(optionalMusicRoots))');
  } finally { fs.chmodSync(parent, 0o755); fs.chmodSync(root, rootMode); }
  expect(sha(path.join(pack, "sentinel"))).toBe(before);
  expect(fs.readFileSync(script)).toEqual(bytes);
  expect(timeline.sources.map((item: any) => sha(item.path))).toEqual(original);
}, 30_000);
