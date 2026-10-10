import { describe, expect, it } from "vitest";
import {
  aspectRatioOf, buildFootageProbe, deriveShotBoundaries, parseFfprobeJson, parseRate,
  parseRmsEnvelope, parseSceneCuts, parseSilences, parseVolumeDetect, peakMomentsOf,
} from "./probe-parse.js";

const FFPROBE_FIXTURE = JSON.stringify({
  streams: [
    { index: 0, codec_type: "video", width: 1080, height: 1920, r_frame_rate: "30000/1001" },
    { index: 1, codec_type: "audio", sample_rate: "48000", channels: 2 },
  ],
  format: { duration: "42.617000" },
});

const SCENE_LOG = [
  "[Parsed_showinfo_1 @ 0x1] config in time_base: 1/12800, frame_rate: 25/1",
  "[Parsed_showinfo_1 @ 0x1] n:   0 pts:  25894 pts_time:2.02297 duration:    512 fmt:yuv420p s:640x360",
  "[Parsed_showinfo_1 @ 0x1] n:  17 pts:  40102 pts_time:12.34500 duration:    512 fmt:yuv420p s:640x360",
].join("\n");

const SILENCE_LOG = [
  "[silencedetect @ 0x2] silence_start: 3.104",
  "[silencedetect @ 0x2] silence_end: 3.612 | silence_duration: 0.508",
  "[silencedetect @ 0x2] silence_start: 18.4",
].join("\n");

const RMS_LOG = [
  "[Parsed_ametadata_1 @ 0x3] frame:0    pts:0       pts_time:0",
  "[Parsed_ametadata_1 @ 0x3] lavfi.astats.Overall.RMS_level=-60.848653",
  "[Parsed_ametadata_1 @ 0x3] frame:11   pts:11264   pts_time:0.255556",
  "[Parsed_ametadata_1 @ 0x3] lavfi.astats.Overall.RMS_level=-21.057690",
  "[Parsed_ametadata_1 @ 0x3] frame:12   pts:12288   pts_time:0.278776",
  "[Parsed_ametadata_1 @ 0x3] lavfi.astats.Overall.RMS_level=-18.500000",
].join("\n");

describe("edit/probe-parse：信号层解析（确定性）", () => {
  it("ffprobe 解析：时长/帧率/画幅/音轨（NTSC 29.97 不取整成 30）", () => {
    const media = parseFfprobeJson(FFPROBE_FIXTURE);
    expect(media.durationSeconds).toBeCloseTo(42.617, 3);
    expect(media.fps).toBeCloseTo(29.97, 2);
    expect(media.aspectRatio).toBe("9:16");
    expect(media.hasAudio).toBe(true);
    expect(media.channels).toBe(2);
    expect(parseRate("25/1")).toBe(25);
    expect(Number.isNaN(parseRate("bad"))).toBe(true);
    expect(aspectRatioOf(1920, 1080)).toBe("16:9");
  });

  it("场景切点解析：去重排序，忽略没有 pts_time 的配置行", () => {
    expect(parseSceneCuts(SCENE_LOG)).toEqual([2.02297, 12.345]);
  });

  it("静音解析：配对成区间；未闭合的静音不产出半条记录", () => {
    const spans = parseSilences(SILENCE_LOG);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toEqual({ start: 3.104, end: 3.612, duration: 0.508 });
  });

  it("响度包络：按桶取峰值（不把峰值平均掉），未测到返回空数组", () => {
    const envelope = parseRmsEnvelope(RMS_LOG, 0.25);
    expect(envelope).toEqual([{ t: 0, db: -60.85 }, { t: 0.25, db: -18.5 }]);
    expect(parseRmsEnvelope("", 0.25)).toEqual([]);
  });

  it("volumedetect 解析与峰值时刻排序", () => {
    const volume = parseVolumeDetect("[Parsed_volumedetect_0 @ 0x4] mean_volume: -24.1 dB\n[Parsed_volumedetect_0 @ 0x4] max_volume: -1.2 dB");
    expect(volume).toEqual({ meanDb: -24.1, maxDb: -1.2 });
    const peaks = peakMomentsOf([{ t: 5, db: -30 }, { t: 1, db: -12 }, { t: 3, db: -20 }], { topN: 2 });
    expect(peaks).toEqual([{ t: 1, db: -12 }, { t: 3, db: -20 }]);
  });

  it("切点 → 镜头区间：MECE 覆盖、首尾闭合、过近切点被丢弃", () => {
    const boundaries = deriveShotBoundaries({ durationSeconds: 10, fps: 25 }, [0.2, 4, 4.15, 7.5, 9.95]);
    expect(boundaries.map((b) => b.inTimecode)).toEqual(["00:00:00.000", "00:00:04.000", "00:00:07.500"]);
    expect(boundaries.map((b) => b.outTimecode)).toEqual(["00:00:04.000", "00:00:07.500", "00:00:10.000"]);
    expect(boundaries.every((b, i) => i === 0 || boundaries[i - 1]!.outFrame === b.inFrame)).toBe(true);
  });

  it("组装 probe 文档：未测指标如实为 null/空，不编造", () => {
    const media = parseFfprobeJson(FFPROBE_FIXTURE);
    const probe = buildFootageProbe({
      media,
      cuts: parseSceneCuts(SCENE_LOG),
      silences: parseSilences(SILENCE_LOG),
      envelope: parseRmsEnvelope(RMS_LOG, 0.25),
      volume: parseVolumeDetect("mean_volume: -24.1 dB\nmax_volume: -1.2 dB"),
    });
    expect(probe.shotBoundaries).toHaveLength(3);
    expect(probe.speech.words).toEqual([]);
    expect(probe.music.detected).toBe(false);
    expect(probe.loudness.peakMoments.length).toBeGreaterThan(0);
    expect(probe.technical.perShot.every((s) => s.sharpness === null)).toBe(true);
  });
});
