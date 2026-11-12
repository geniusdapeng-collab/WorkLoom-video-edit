import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { measureVideoMotion } from "../../packages/video-studio/src/video-motion-measurement.ts";

const ffmpeg = process.env.WL_FFMPEG ?? "ffmpeg";
const ffprobe = process.env.WL_FFPROBE ?? "ffprobe";

function run(bin, args) {
  return execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
}

function adjacentDuplicateFrames(file) {
  const width = 32;
  const height = 18;
  const raw = execFileSync(ffmpeg, ["-v", "error", "-i", file, "-vf", `scale=${width}:${height},format=gray`,
    "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 8 * 1024 * 1024 });
  const size = width * height;
  const frames = Math.floor(raw.length / size);
  let duplicates = 0;
  for (let index = 1; index < frames; index += 1) {
    const before = raw.subarray((index - 1) * size, index * size);
    const after = raw.subarray(index * size, (index + 1) * size);
    let delta = 0;
    for (let offset = 0; offset < size; offset += 1) delta += Math.abs(after[offset] - before[offset]);
    if (delta / size < 0.5) duplicates += 1;
  }
  return { frames, duplicates };
}

test("compose motion interpolation removes 24→30 fps duplicate cadence and fully decodes", { timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "compose-cadence-"));
  try {
    const source = join(dir, "source-24.mp4");
    run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=24:d=1.2",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-shortest",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source]);
    const execute = (mode, output) => {
      const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/tools/compose-film.mts",
        "--clips", source, "--out", output, "--width", "160", "--height", "90", "--fps", "30",
        "--frame-interp", mode, "--fade", "0", "--color", "none", "--json"], {
        cwd: process.cwd(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      run(ffmpeg, ["-v", "error", "-i", output, "-f", "null", "-"]);
      const report = JSON.parse(readFileSync(output.replace(/\.mp4$/i, ".av-sync.json"), "utf8"));
      return report;
    };
    const fpsOutput = join(dir, "fps-30.mp4");
    const fpsReport = execute("fps", fpsOutput);
    const fpsFrames = adjacentDuplicateFrames(fpsOutput);
    const motionOutput = join(dir, "motion-30.mp4");
    const motionReport = execute("motion", motionOutput);
    const motionFrames = adjacentDuplicateFrames(motionOutput);

    assert.equal(fpsReport.frameCadence[0].conversion, "duplicate-or-drop");
    assert.equal(motionReport.frameCadence[0].conversion, "motion-interpolation");
    assert.equal(motionReport.frameCadence[0].applied, true);
    assert.ok(Math.abs(motionFrames.frames - fpsFrames.frames) <= 2,
      `cadence outputs differ by more than two frames: fps=${fpsFrames.frames}, motion=${motionFrames.frames}`);
    assert.ok(Math.abs(motionFrames.frames - 36) <= 2, `unexpected frame count ${motionFrames.frames}`);
    assert.ok(fpsFrames.duplicates > 4, `expected duplicate/drop cadence, got ${JSON.stringify(fpsFrames)}`);
    assert.equal(motionFrames.duplicates, 0, `motion interpolation still duplicated frame bytes: ${JSON.stringify(motionFrames)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("rendered-motion measurement separates a static frame from real movement", { timeout: 30_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "motion-measurement-"));
  try {
    const staticFile = join(dir, "static.mp4");
    const movingFile = join(dir, "moving.mp4");
    run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=160x90:r=24:d=0.8",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", staticFile]);
    run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=24:d=0.8",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", movingFile]);
    const quiet = measureVideoMotion({ file: staticFile, height: 90, targetFps: 12, ffmpeg });
    const moving = measureVideoMotion({ file: movingFile, height: 90, targetFps: 12, ffmpeg });
    assert.ok(quiet.meanEnergy < 0.5, `static scene should have near-zero frame energy: ${JSON.stringify(quiet)}`);
    assert.ok(moving.meanEnergy > 2, `moving scene should have measurable frame energy: ${JSON.stringify(moving)}`);
    assert.ok(moving.maxEnergy >= moving.meanEnergy);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
