import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assembleTimeline, resolveBinaries } from "./core.mjs";

const bins = resolveBinaries();
const hash = async file => createHash("sha256").update(await fs.readFile(file)).digest("hex");
const probe = file => JSON.parse(execFileSync(bins.ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-of", "json", file], { encoding: "utf8" }));

for (const fps of [24, 30]) test(`actual ${fps}fps xfade runs keep the cumulative timeline within half a frame`, { timeout: 120_000 }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "transition-clock-")));
  try {
    const files = [];
    for (const [index, color] of ["red", "blue"].entries()) {
      const file = path.join(root, `${color}.mp4`);
      execFileSync(bins.ffmpeg, ["-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=160x90:r=${fps}:d=1.5`,
        "-f", "lavfi", "-i", `sine=frequency=${440 + index * 220}:sample_rate=48000:duration=1.5`,
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
      files.push({ file, sha256: await hash(file), duration: Number(probe(file).streams.find(s => s.codec_type === "video").duration) });
    }
    const clips = Array.from({ length: 16 }, (_, index) => ({ shotId: `S${index + 1}`, path: files[index % 2].file, duration: files[index % 2].duration }));
    const perCut = Object.fromEntries(clips.filter((_, index) => index % 2 === 1).map(clip => [clip.shotId, { type: "fade", explicit: true, durationSeconds: 0.15 }]));
    const output = path.join(root, "mixed-runs.mp4");
    const result = await assembleTimeline({ clips, transitions: { mode: "xfade", perCut }, output, resolution: [160, 90], fps, bins });
    const receipt = result.transitions.receipt;
    const media = probe(output);
    const video = media.streams.find(s => s.codec_type === "video"), audio = media.streams.find(s => s.codec_type === "audio");
    assert.equal(receipt.transitionCount, 8);
    assert.equal(Number(video.nb_read_frames), Math.round(receipt.expectedDurationSeconds * fps));
    assert.ok(Math.abs(Number(video.duration) - receipt.expectedDurationSeconds) <= 0.5 / fps + 0.001);
    assert.ok(Math.abs(Number(audio.duration) - Number(video.duration)) <= 1024 / 48000 + 0.002);
    assert.ok(receipt.checks.filter(check => check.hard).every(check => check.ok === true));
    execFileSync(bins.ffmpeg, ["-v", "error", "-xerror", "-i", output, "-map", "0:v", "-map", "0:a", "-f", "null", "-"]);
    for (const input of files) assert.equal(await hash(input.file), input.sha256);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
