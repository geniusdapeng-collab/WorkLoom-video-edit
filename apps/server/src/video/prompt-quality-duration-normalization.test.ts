import { describe, expect, it } from "vitest";
import { normalizePromptShotDurations } from "./prompt-quality-gate.js";

const model = {
  modelId: "doubao-seedance-2-5",
  provider: "seedance",
  providerModel: "doubao-seedance-2-5-260628",
  version: "test",
  modes: ["t2v"] as const,
  durationSec: { min: 4, max: 30 },
  aspectRatios: ["9:16"],
  resolutions: ["1080p"],
  maxReferenceImages: 30,
  maxPromptChars: 4000,
};
const compile = {
  delivery: { aspectRatio: "9:16", resolution: "1080p", fps: 30, format: "mp4" as const, generateAudio: true },
  model: { ...model, modes: [...model.modes] },
};

describe("G6 duration normalization", () => {
  it("preserves total duration while moving short shots to the provider minimum", () => {
    const shots = [3, 5, 5, 4, 5, 5, 3].map((duration, index) => ({
      source: { shotId: index === 0 ? "opening" : index === 6 ? "ending" : `scene-${index}`,
        duration,
        timeline: `T00:00-T00:0${duration}`,
        fields: { timeline: `T00:00-T00:0${duration}` } },
      compile,
    }));
    const normalized = normalizePromptShotDurations(shots, 30);
    const durations = normalized.map(({ source }) => source.duration);
    expect(durations.every(duration => Number.isInteger(duration) && Number(duration) >= 4 && Number(duration) <= 30)).toBe(true);
    expect(durations.reduce<number>((sum, duration) => sum + Number(duration), 0)).toBe(30);
    expect(normalized[0]!.source.timeline).toBe("T00:00-T00:04");
    expect((normalized[1]!.source.fields as Record<string, unknown>).timeline).toBe("T00:00-T00:04");
    expect((normalized[4]!.source.fields as Record<string, unknown>).timeline).toBe("T00:00-T00:05");
    expect(normalized.reduce<number>((sum, { source }) => sum + Number(source.duration), 0)).toBe(30);
  });

  it("leaves already valid duration plans unchanged", () => {
    const shots = [
      { source: { shotId: "S1", duration: 4, timeline: "T00:00-T00:04", fields: { timeline: "T00:00-T00:04" } }, compile },
      { source: { shotId: "S2", duration: 6, timeline: "T00:00-T00:06", fields: { timeline: "T00:00-T00:06" } }, compile },
    ];
    expect(normalizePromptShotDurations(shots)).toEqual(shots);
  });

  it("clamps an overrunning timeline even when every shot duration is already valid", () => {
    const shots = [{
      source: {
        shotId: "scene-2",
        duration: 4,
        timeline: "T00:00-T00:01.2 起幅; T00:01.2-T00:02.6 中段; T00:02.6-T00:04.0 超越; T00:04.0-T00:05.0 落幅",
        fields: {
          timeline: "T00:00-T00:01.2 起幅; T00:01.2-T00:02.6 中段; T00:02.6-T00:04.0 超越; T00:04.0-T00:05.0 落幅",
        },
      },
      compile,
    }];
    const normalized = normalizePromptShotDurations(shots, 4);
    expect(normalized[0]!.source.duration).toBe(4);
    expect(normalized[0]!.source.timeline).not.toContain("T00:05.0");
    expect((normalized[0]!.source.fields as Record<string, unknown>).timeline).not.toContain("T00:05.0");
    expect(normalized[0]!.source.timeline).toContain("T00:04.0");
  });

  it("restores the explicitly requested total when all shots are individually valid", () => {
    const shots = [3, 5, 5, 4, 4, 4, 4].map((duration, index) => ({
      source: { shotId: index === 0 ? "opening" : index === 6 ? "ending" : `scene-${index}`,
        duration,
        timeline: `T00:00-T00:0${duration}` },
      compile,
    }));
    const normalized = normalizePromptShotDurations(shots, 30);
    const durations = normalized.map(({ source }) => Number(source.duration));
    expect(durations).toEqual([4, 5, 5, 4, 4, 4, 4]);
    expect(durations.reduce<number>((sum, duration) => sum + duration, 0)).toBe(30);
    expect(normalized[0]!.source.timeline).toBe("T00:00-T00:04");
  });
});
