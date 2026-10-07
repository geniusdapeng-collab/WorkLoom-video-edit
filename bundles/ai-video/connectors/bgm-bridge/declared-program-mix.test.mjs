/** Real offline mix regression: rendered pictures/audio are accepted without quality measurements. */
import assert from "node:assert/strict";
import { before, after, describe, it } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mix, best } from "./core.mjs";

const bins = { ffmpeg: process.env.WORKLOOM_POST_FFMPEG_PATH || process.env.WL_FFMPEG || "ffmpeg",
  ffprobe: process.env.WORKLOOM_POST_FFPROBE_PATH || process.env.WL_FFPROBE || "ffprobe" };
const hasMedia = [bins.ffmpeg, bins.ffprobe].every((bin) => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0);
const suite = hasMedia ? describe : describe.skip;
const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const encode = (args) => execFileSync(bins.ffmpeg, ["-hide_banner", "-v", "error", "-n", ...args], { timeout: 60000, stdio: "pipe" });
let root, source, silent, quiet, longSource, music, shortMusic, env, originalHash;
const options = (name) => ({ input: source, output: path.join(root, name + ".mp4"), bgmPath: music,
  policy: "keep-dialogue", musicLevelDb: -24, duckingDb: 12, fadeInSec: 0.1, fadeOutSec: 0.1,
  align: false, section: "full", env, bins });

suite("rendered source default acceptance in BGM CLI/core", () => {
  before(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bgm-rendered-")));
    source = path.join(root, "连续原声 片.mp4"); silent = path.join(root, "无音轨片.mp4"); music = path.join(root, "music.wav");
    quiet = path.join(root, "安静原音轨.mp4"); longSource = path.join(root, "long-source.mp4"); shortMusic = path.join(root, "short-music.wav");
    encode(["-f", "lavfi", "-i", "color=c=black:s=96x64:r=24000/1001:d=1.083",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1.083", "-map", "0:v", "-map", "1:a",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source]);
    encode(["-f", "lavfi", "-i", "color=c=black:s=80x60:r=17:d=1.117", "-c:v", "libx264", "-pix_fmt", "yuv420p", silent]);
    encode(["-f", "lavfi", "-i", "sine=frequency=1760:duration=1.2", "-c:a", "pcm_s16le", music]);
    encode(["-f", "lavfi", "-i", "color=c=black:s=96x64:r=29:d=1.2", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "1.2",
      "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", quiet]);
    encode(["-f", "lavfi", "-i", "color=c=black:s=96x64:r=24000/1001:d=7.509", "-f", "lavfi", "-i", "sine=frequency=440:duration=7.509",
      "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", longSource]);
    encode(["-f", "lavfi", "-i", "sine=frequency=1760:duration=0.2", "-c:a", "pcm_s16le", shortMusic]);
    originalHash = hash(source);
    env = { ...process.env, WORKLOOM_AUDIO_STEM_SIGNING_SECRET: "", WORKLOOM_AUDIO_STEM_SIGNING_KEY_ID: "",
      WORKLOOM_BGM_DISCOVER: "0", WORKLOOM_BGM_ALLOWED_ROOTS: root };
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));
  it("preserves legacy declared authority and never claims signed stems", async () => {
    const result = await mix({ ...options("legacy"), declaredProgramMix: true });
    assert.equal(result.independentAudio.sourceAuthority, "declared-unverified");
    assert.equal(result.independentAudio.stemsVerified, false);
    assert.equal(result.independentAudio.dialogueStatus, "original-program-unseparated");
    assert.equal(result.qualityReviewed, false);
    assert.equal(result.qualityScore, null);
    assert.equal(hash(source), originalHash);
  });
  it("accepts continuous original audio and black/odd FPS source without signed stems or quiet windows", async () => {
    const result = await mix(options("default"));
    assert.equal(result.independentAudio.sourceAuthority, "original-media-bytes");
    assert.equal(result.independentAudio.sourceSha256, originalHash);
    assert.equal(result.output.hash, hash(result.output.path));
    assert.equal(result.loudness.after, null);
    assert.equal(result.levels.speechToMusicMarginDb, null);
    assert.equal(result.voiceActivity.method, "not-reviewed");
    assert.equal(hash(source), originalHash);
  });
  it("handles a clip with no source audio by making only the requested post audio bed", async () => {
    const original = hash(silent);
    const result = await mix({ ...options("no-audio"), input: silent });
    assert.equal(result.independentAudio.embeddedAudioUsed, false);
    assert.equal(result.independentAudio.dialogueStatus, "not_applicable");
    assert.ok(result.output.audio);
    assert.equal(hash(silent), original);
  });
  it("finishes finite short-music loops for continuous, quiet and no-audio programs with real binary receipts", { timeout: 20000 }, async () => {
    const realBins = Object.fromEntries(Object.entries(bins).map(([name, bin]) => [name,
      fs.realpathSync(path.isAbsolute(bin) ? bin : execFileSync("which", [bin], { encoding: "utf8" }).trim())]));
    const trace = path.join(root, "actual-media-commands.jsonl");
    const tracedBins = {};
    for (const [name, bin] of Object.entries(realBins)) {
      const wrapper = path.join(root, name + "-trace");
      fs.writeFileSync(wrapper, "#!" + process.execPath + "\n"
        + "const fs=require('node:fs'),cp=require('node:child_process');const args=process.argv.slice(2);"
        + "fs.appendFileSync(" + JSON.stringify(trace) + ",JSON.stringify({binary:" + JSON.stringify(bin) + ",args})+'\\n');"
        + "const r=cp.spawnSync(" + JSON.stringify(bin) + ",args,{timeout:8000,stdio:'inherit'});process.exit(r.status===null?124:r.status);\n");
      fs.chmodSync(wrapper, 0o755); tracedBins[name] = wrapper;
    }
    const binaryReceipts = Object.fromEntries(Object.entries(realBins).map(([name, bin]) => [name, {
      path: bin, sha256: hash(bin), version: execFileSync(bin, ["-version"], { encoding: "utf8" }).split("\n")[0], commandTimeoutMs: 8000 }]));
    const cases = [];
    for (const [name, input] of [["continuous", longSource], ["quiet", quiet], ["no-audio", silent]]) {
      const sourceHash = hash(input), started = Date.now();
      const result = await mix({ ...options("short-loop-" + name), input, bgmPath: shortMusic, bins: tracedBins });
      assert.ok(result.output.audio); assert.equal(result.qualityReviewed, false); assert.equal(result.qualityScore, null);
      assert.equal(hash(input), sourceHash);
      cases.push({ case: name, sourceHash, outputHash: hash(result.output.path), duration: result.output.durationSeconds,
        elapsedMs: Date.now() - started, timeoutMs: 8000, qualityReviewed: result.qualityReviewed });
    }
    const commands = fs.readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(commands.some((command) => command.args.includes("concat")), "short music must actually render a finite loop bed");
    assert.equal(commands.filter((command) => command.args.includes("-stream_loop")).length, 0);
    const evidence = { binaryReceipts, cases, commands, expected: "each finite loop produces a readable audio output within 8s and preserves the source" };
    if (process.env.WORKLOOM_BGM_TEST_EVIDENCE) fs.writeFileSync(process.env.WORKLOOM_BGM_TEST_EVIDENCE, JSON.stringify(evidence, null, 2));
  });
  it("performs requested recipe once without source-quality score or network calls", async () => {
    let calls = 0;
    const result = await best({ ...options("recipe"), recipeIds: ["interview"], sourcePolicy: "compose-only",
      fetchImpl: async () => { calls++; throw new Error("network forbidden"); } });
    assert.equal(result.verdict, "processed");
    assert.equal(result.score, null);
    assert.equal(result.qualityReviewed, false);
    assert.equal(calls, 0);
    assert.equal(result.sha256, hash(result.report.output.path));
  });
  it("actual CLI succeeds without --audio-stems and reports no invented measurements", () => {
    const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
    const output = path.join(root, "actual CLI.mp4");
    const result = spawnSync(process.execPath, [cli, "mix", "--in", source, "--out", output, "--bgm", music],
      { env: { ...env, WL_FFMPEG: bins.ffmpeg, WL_FFPROBE: bins.ffprobe }, encoding: "utf8", timeout: 60000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /未进行源音质比较/);
    assert.equal(hash(source), originalHash);
  });
  it("retains explicit signed-source verification, source permission and tenant authority", async () => {
    await assert.rejects(() => mix({ ...options("bad-signed"), audioStems: { dir: root } }),
      (error) => /audio_stems|source|bad_request|verify/.test(error.code));
    await assert.rejects(() => mix({ ...options("music-only"), policy: "music-only" }),
      (error) => error.code === "audio_stems_source_unverified");
    await assert.rejects(() => mix({ ...options("tenant"), audioStems: { scope: { tenantId: "another" } },
      env: { ...env, WORKLOOM_BGM_BRIDGE_TENANT: "owner" } }), (error) => error.code === "tenant_mismatch");
  });
  it("fails explicitly for missing/corrupt sources, illegal paths, overwrite, duplicate output and invalid request", async () => {
    const corrupt = path.join(root, "corrupt.mp4"); fs.writeFileSync(corrupt, "not media");
    for (const changed of [{ input: source + ".missing" }, { input: corrupt }, { bgmPath: music + ".missing" },
      { output: source }, { input: path.resolve(root, "..", "outside.mp4") }, { musicLevelDb: Number.NaN },
      { policy: "unknown" }, { sectionStartSec: 0, sectionEndSec: 99 }]) {
      await assert.rejects(() => mix({ ...options("invalid-" + Math.random().toString(16).slice(2)), ...changed }));
    }
    await assert.rejects(() => mix(options("default")), (error) => error.code === "idempotency_conflict");
    assert.equal(hash(source), originalHash);
  });
});
