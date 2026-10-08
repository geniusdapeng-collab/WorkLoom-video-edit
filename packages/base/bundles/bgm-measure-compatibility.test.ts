import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSpectralStats, resolveBinaries, segmentSpectralStats } from "../../../bundles/ai-video/connectors/bgm-bridge/measure.mjs";

const directories: string[] = [];
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), "bgm-spectral-compat-"));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("频谱实测的 FFmpeg 选项兼容性", () => {
  it("FFmpeg 5.1 选项契约夹具可返回两项量测，输入和时间范围完整传递", async () => {
    // This process fixture models the documented n5.1.9 option contract.
    // It is not a substitute for the actual native Linux FFmpeg execution.
    const directory = temporary();
    const executable = join(directory, "legacy-option-contract.mjs");
    const log = join(directory, "arguments.json");
    writeFileSync(executable, `#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(log)},JSON.stringify(args));\nconst filter=args[args.indexOf('-af')+1]??'';\nif(/aspectralstats=[^,]*measure=/.test(filter)){process.stderr.write("Option 'measure' not found\\n");process.exit(1);}\nprocess.stderr.write('lavfi.aspectralstats.1.mean=99\\nlavfi.aspectralstats.1.centroid=1000\\nlavfi.aspectralstats.1.flatness=0.1\\nlavfi.aspectralstats.1.centroid=2000\\nlavfi.aspectralstats.1.flatness=0.15\\n');\n`);
    chmodSync(executable, 0o755);
    const input = join(directory, "未执行的 '输入 音频.wav");
    const value = await segmentSpectralStats({ input, start: 0.5, duration: 1.25, bins: { ffmpeg: executable, ffprobe: "not-used" } });
    expect(value).toEqual({ frames: 2, centroidHz: 1500, flatness: 0.125 });
    const argumentsUsed = JSON.parse(readFileSync(log, "utf8")) as string[];
    expect(argumentsUsed[argumentsUsed.indexOf("-i") + 1]).toBe(input);
    expect(argumentsUsed[argumentsUsed.indexOf("-ss") + 1]).toBe("0.5");
    expect(argumentsUsed[argumentsUsed.indexOf("-t") + 1]).toBe("1.25");
    expect(argumentsUsed[argumentsUsed.indexOf("-map") + 1]).toBe("0:a:0");
  });

  it("真实 FFmpeg 测得 1kHz 音轨频谱且不改原文件", async () => {
    const directory = temporary();
    const input = join(directory, "真实 空格-'音轨.wav");
    const bins = resolveBinaries();
    execFileSync(bins.ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=44100:duration=2", "-c:a", "pcm_s16le", input]);
    const hash = () => createHash("sha256").update(readFileSync(input)).digest("hex");
    const before = hash();
    const value = await segmentSpectralStats({ input, start: 0.3, duration: 0.5, bins });
    expect(value.frames).toBeGreaterThan(0);
    expect(Math.abs(value.centroidHz - 1000)).toBeLessThan(100);
    expect(value.flatness).toBeGreaterThanOrEqual(0);
    expect(value.flatness).toBeLessThan(0.1);
    expect(hash()).toBe(before);
  }, 30_000);

  it("真实缺源错误继续向调用方失败，不返回空量测或改为成功", async () => {
    const input = join(temporary(), "missing.wav");
    await expect(segmentSpectralStats({ input })).rejects.toMatchObject({ code: "ffmpeg_failed" });
  }, 30_000);

  it("默认输出的其余频谱字段不影响量测，缺所需字段保持 null", () => {
    expect(parseSpectralStats("lavfi.aspectralstats.1.mean=30\nlavfi.aspectralstats.1.spread=400")).toEqual({ frames: 0, centroidHz: null, flatness: null });
    expect(parseSpectralStats("lavfi.aspectralstats.1.mean=30\nlavfi.aspectralstats.1.centroid=900\nlavfi.aspectralstats.1.flatness=0.02\nlavfi.aspectralstats.1.spread=400")).toEqual({ frames: 1, centroidHz: 900, flatness: 0.02 });
  });
});
