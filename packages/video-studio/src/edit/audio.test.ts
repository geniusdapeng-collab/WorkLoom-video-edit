import { describe, expect, it } from "vitest";
import { deriveAmbienceMetrics, estimateTempo, normalizeAsrResponse, parseOcrJsonl } from "./audio.js";

describe("edit/audio：节拍估计（可复现）", () => {
  it("120 BPM 的脉冲包络：估出 120 且节拍网格等距", () => {
    const envelope = Array.from({ length: 60 }, (_, index) => {
      const t = index * 0.25;
      const beat = index % 2 === 0;
      return { t, db: beat ? -12 : -34 };
    });
    const tempo = estimateTempo(envelope, { minBpm: 60, maxBpm: 180 });
    expect(tempo.bpm).toBeGreaterThan(112);
    expect(tempo.bpm).toBeLessThan(128);
    expect(tempo.confidence).toBeGreaterThan(0.3);
    expect(tempo.beatGrid.length).toBeGreaterThan(20);
    const gaps = tempo.beatGrid.slice(1).map((t, i) => Number((t - tempo.beatGrid[i]!).toFixed(3)));
    expect(new Set(gaps).size).toBe(1);
  });

  it("平坦/过短包络：如实返回 null（不猜 BPM）", () => {
    const flat = Array.from({ length: 40 }, (_, i) => ({ t: i * 0.25, db: -20 }));
    expect(estimateTempo(flat).bpm).toBeNull();
    expect(estimateTempo([{ t: 0, db: -20 }, { t: 1, db: -10 }]).bpm).toBeNull();
    expect(estimateTempo([]).confidence).toBe(0);
  });
});

describe("edit/audio：环境音画像", () => {
  it("噪声底/动态范围/静音覆盖/人声覆盖/峰值点", () => {
    const envelope = Array.from({ length: 40 }, (_, i) => ({ t: i * 0.25, db: i < 10 ? -50 : (i % 10 === 5 ? -8 : -20) }));
    const metrics = deriveAmbienceMetrics({
      envelope,
      silences: [{ start: 0, end: 2.5 }],
      speechSegments: [{ start: 2, end: 6 }, { start: 3, end: 7 }],
      durationSeconds: 10,
    });
    expect(metrics.noiseFloorDb).toBeCloseTo(-50, 1);
    expect(metrics.loudnessRangeDb).toBeCloseTo(30, 1);
    expect(metrics.silenceCoverage).toBeCloseTo(0.25, 3);
    expect(metrics.speechCoverage).toBeCloseTo(0.5, 3);
    expect(metrics.peakCount).toBeGreaterThan(0);
  });

  it("非法时长直接抛错（fail-closed）", () => {
    expect(() => deriveAmbienceMetrics({ envelope: [], silences: [], speechSegments: [], durationSeconds: 0 })).toThrow();
  });
});

describe("edit/audio：ASR / OCR 归一化", () => {
  it("只有 segments 时标注 precision=segment，并计算句末停顿", () => {
    const speech = normalizeAsrResponse({
      segments: [
        { start: 0, end: 3.24, text: " 等待出餐的才女士 " },
        { start: 4.0, end: 5.0, text: "是的" },
      ],
    }, { language: "zh", engine: "mlx-audio/whisper-large-v3-turbo" });
    expect(speech.precision).toBe("segment");
    expect(speech.sentences).toHaveLength(2);
    expect(speech.sentences[0]!.pauseAfterSeconds).toBeCloseTo(0.76, 2);
    expect(speech.words).toHaveLength(0);
  });

  it("带 words 时标注 precision=word；空输入为 none", () => {
    const speech = normalizeAsrResponse({
      segments: [{ start: 0, end: 1, text: "你好", words: [{ word: "你", start: 0, end: 0.5 }, { word: "好", start: 0.5, end: 1 }] }],
    });
    expect(speech.precision).toBe("word");
    expect(speech.words.map((w) => w.text)).toEqual(["你", "好"]);
    expect(normalizeAsrResponse({}).precision).toBe("none");
  });

  it("OCR JSONL：坏行计数、结果按时间排序、空文本过滤", () => {
    const lines = [
      '{"t":2,"texts":["青岛啤酒","1903"]}',
      "not-json",
      '{"t":0.5,"texts":[]}',
      '{"t":1.5,"texts":["项林炒鸡"]}',
      "",
    ];
    const { observations, skippedLines } = parseOcrJsonl(lines.join("\n"));
    expect(observations.map((o) => o.t)).toEqual([1.5, 2]);
    expect(observations[0]!.texts).toEqual(["项林炒鸡"]);
    expect(skippedLines).toBe(2);
  });
});
