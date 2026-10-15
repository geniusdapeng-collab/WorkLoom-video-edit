import { describe, expect, it } from "vitest";
import { planAutoCaptions, type AutoCaptionWord, type AutoPlanAnalysisDoc } from "./auto-plan.js";
import { analyzeCaption, cuesToSrtBody, type CaptionDocInput } from "./caption.js";
import type { EditTimeline, EditTimelineSegment } from "./timeline.js";

const text32 = "春夏秋冬天地山川风花雪月江河湖海日月星辰东西南北梅兰竹菊金木水火";
const wordsFor = (text: string, start = 0, step = 0.25): AutoCaptionWord[] =>
  [...text].map((text, index) => ({ text, start: start + index * step, end: start + (index + 1) * step }));
const source = (sourceId: string, words: AutoCaptionWord[]) => ({ sourceId, analysis: { probe: { speech: { words } } } });
function timeline(segments?: EditTimelineSegment[]): EditTimeline {
  return {
    schemaVersion: "workloom.video-edit/edit-timeline/v2", timelineId: "caption-fixture",
    target: { durationSeconds: 8, fps: 30, aspectRatio: "9:16", platform: "fixture" },
    sources: ["src-a", "src-b"].map((sourceId, index) => ({ sourceId, sha256: String(index).repeat(64), path: `/fixture/${sourceId}.mp4`, fps: 30, durationSeconds: 120 })),
    segments: segments ?? [{ seq: 0, segmentId: "body", sourceId: "src-a", sourceIn: 0, sourceOut: 8, durationSeconds: 8 }],
    audioDesign: { originalAudioPolicy: "keep" },
  };
}
function check(tl: EditTimeline, plan: ReturnType<typeof planAutoCaptions>) {
  return analyzeCaption({ timeline: tl, caption: plan.captionDoc as CaptionDocInput, transcript: plan.transcript, mode: "talk", allowSilentShots: true });
}
const joined = (result: ReturnType<typeof analyzeCaption>) => result.cues.map(cue => cue.text.replace(/\n/gu, "")).join("");
const shots = (plan: ReturnType<typeof planAutoCaptions>) => (plan.captionDoc as CaptionDocInput).video_groups![0]!.shots!;

describe("AUTO-01: complete timed multi-screen captions", () => {
  it("keeps all 32 source characters in two screens and exports both SRT cues", () => {
    const tl = timeline();
    const plan = planAutoCaptions({ timeline: tl, sources: [source("src-a", wordsFor(text32))] });
    const result = check(tl, plan);
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    expect(plan.cues).toBe(2);
    expect(result.cues.map(cue => [cue.start, cue.end])).toEqual([[0, 6], [6, 8]]);
    expect(joined(result)).toBe(text32);
    for (const cue of result.cues) {
      expect([...cue.text.replace(/\n/gu, "")].length).toBeLessThanOrEqual(24);
      expect(cue.text.split("\n").length).toBeLessThanOrEqual(2);
      expect(cue.text.split("\n").every(line => [...line].length <= 12)).toBe(true);
    }
    expect(cuesToSrtBody(result.cues)).toContain("2\n00:00:06,000 --> 00:00:08,000");
  });

  it("uses real nonuniform ASR boundaries, keeps word order, and does not fill a speech pause", () => {
    const words = [
      { text: "春夏秋冬天地山川风花雪月", start: 0.3, end: 2.1 },
      { text: "江河湖海日月星辰东西南北", start: 2.1, end: 5.7 },
      { text: "梅兰竹菊金木水火", start: 6.5, end: 7.9 },
    ];
    const tl = timeline();
    const plan = planAutoCaptions({ timeline: tl, sources: [source("src-a", words)] });
    const result = check(tl, plan);
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    expect(joined(result)).toBe(text32);
    expect(result.cues.map(cue => [cue.start, cue.end])).toEqual([[0.3, 5.7], [6.5, 7.9]]);
    expect(plan.transcript.sentences.flatMap(sentence => sentence.words).map(({ text, start, end }) => ({ text, start, end }))).toEqual(words);
  });

  it("isolates equal source timestamps and permits repeated segment-local cue indexes", () => {
    const tl = timeline([
      { seq: 0, segmentId: "a", sourceId: "src-a", sourceIn: 0, sourceOut: 8, durationSeconds: 8 },
      { seq: 1, segmentId: "b", sourceId: "src-b", sourceIn: 0, sourceOut: 8, durationSeconds: 8 },
    ]);
    const other = [...text32].reverse().join("");
    const plan = planAutoCaptions({ timeline: tl, sources: [source("src-a", wordsFor(text32)), source("src-b", wordsFor(other))] });
    const result = check(tl, plan);
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    expect(joined(result)).toBe(text32 + other);
    expect(result.cues.map(cue => [cue.segmentId, cue.start, cue.end])).toEqual([["a", 0, 6], ["a", 6, 8], ["b", 8, 14], ["b", 14, 16]]);
    plan.transcript.sentences[0]!.sourceId = undefined;
    expect(check(tl, plan).issues.some(issue => issue.id.startsWith("caption.transcriptSource:") && issue.severity === "hard")).toBe(true);
  });

  it("maps speed once onto concat time and leaves transition overlap to the post clock", () => {
    const tl = timeline([
      { seq: 0, segmentId: "lead", sourceId: "src-b", sourceIn: 0, sourceOut: 2, durationSeconds: 2 },
      { seq: 1, segmentId: "body", sourceId: "src-a", sourceIn: 10, sourceOut: 18, durationSeconds: 4, speed: 2, transitionIn: { type: "dissolve", durationSeconds: 0.4 } },
      { seq: 2, segmentId: "tail", sourceId: "src-b", sourceIn: 20, sourceOut: 22, durationSeconds: 4, speed: 0.5 },
    ]);
    const plan = planAutoCaptions({ timeline: tl, sources: [source("src-a", wordsFor(text32, 10)), source("src-b", [{ text: "尾声", start: 20.5, end: 21.5 }])] });
    const result = check(tl, plan);
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    expect(result.cues.map(cue => [cue.start, cue.end])).toEqual([[2, 5], [5, 6], [7, 9]]);
    expect(result.metrics.totalSeconds).toBe(10);
  });

  it("marks sentence-only timing as estimated and keeps complete words in the transcript", () => {
    const tl = timeline();
    const analysis: AutoPlanAnalysisDoc = { probe: { speech: { sentences: [{ text: text32, start: 0, end: 8 }] } } };
    const plan = planAutoCaptions({ timeline: tl, sources: [{ sourceId: "src-a", analysis }] });
    const result = check(tl, plan);
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    expect(joined(result)).toBe(text32);
    expect(JSON.stringify(plan.transcript)).toContain("sentence-estimated");
    expect(JSON.stringify(plan.captionDoc)).toContain("sentence-estimated");
  });

  it("splits an oversized ASR token without losing its original text and declares estimated internal timing", () => {
    const tl = timeline();
    const plan = planAutoCaptions({ timeline: tl, sources: [source("src-a", [{ text: text32, start: 0.5, end: 7.7 }])] });
    const result = check(tl, plan);
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    expect(joined(result)).toBe(text32);
    expect(result.cues).toHaveLength(2);
    expect(JSON.stringify(plan.captionDoc)).toContain("word-estimated");
    expect(plan.transcript.sentences[0]!.text).toBe(text32);
  });

  it("distinguishes actual silence from missing subtitles even with allowSilentShots", () => {
    const tl = timeline();
    const silent = planAutoCaptions({ timeline: tl, sources: [] });
    expect(silent.cues).toBe(0);
    expect(shots(silent)).toHaveLength(1);
    expect(silent.gaps).toHaveLength(1);
    expect(check(tl, silent).ok).toBe(true);
    const plan = planAutoCaptions({ timeline: tl, sources: [source("src-a", wordsFor(text32))] });
    shots(plan)[0]!.subtitle_text = [];
    expect(check(tl, plan).ok).toBe(false);
  });

  it("rejects omitted, duplicated and swapped screens instead of validating only the first entry", () => {
    for (const mutation of ["omitted", "duplicated", "swapped"] as const) {
      const tl = timeline();
      const plan = planAutoCaptions({ timeline: tl, sources: [source("src-a", wordsFor(text32))] });
      const entries = shots(plan)[0]!.subtitle_text!;
      if (mutation === "omitted") entries.pop();
      if (mutation === "duplicated") entries.push(structuredClone(entries[0]!));
      if (mutation === "swapped") entries.reverse();
      expect(check(tl, plan).ok, mutation).toBe(false);
    }
  });

  it("fails closed for illegal word/segment intervals and invalid cue limits", () => {
    for (const word of [{ text: "坏", start: -1, end: 1 }, { text: "坏", start: 1, end: 1 }, { text: "坏", start: Number.NaN, end: 2 }]) {
      expect(() => planAutoCaptions({ timeline: timeline(), sources: [source("src-a", [word])] })).toThrow();
    }
    for (const value of [0, -1, Number.NaN, 25, 1.5]) {
      expect(() => planAutoCaptions({ timeline: timeline(), sources: [], maxCharsPerCue: value })).toThrow();
    }
    for (const patch of [{ sourceIn: -1 }, { sourceOut: 0 }, { speed: 0 }, { durationSeconds: 0 }]) {
      const tl = timeline(); Object.assign(tl.segments[0]!, patch);
      expect(() => planAutoCaptions({ timeline: tl, sources: [] })).toThrow();
    }
  });

  it("rejects invalid, overlapping or unrelated nested source/concat timestamps", () => {
    for (const patch of [{ source_timestamp: "7-2" }, { source_timestamp: "0-99" }, { original_timestamp: "0-0" }, { original_timestamp: "2-7" }]) {
      const tl = timeline();
      const plan = planAutoCaptions({ timeline: tl, sources: [source("src-a", wordsFor(text32))] });
      Object.assign(shots(plan)[0]!.subtitle_text![0]!, patch);
      expect(check(tl, plan).ok, JSON.stringify(patch)).toBe(false);
    }
  });

  it("keeps Unicode codepoints intact and honors a smaller cue size", () => {
    const text = "𠮷野家春夏秋冬天地山川风花雪月";
    const tl = timeline();
    const plan = planAutoCaptions({ timeline: tl, sources: [source("src-a", wordsFor(text))], maxCharsPerCue: 7 });
    const result = check(tl, plan);
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    expect(joined(result)).toBe(text);
    expect(result.cues.every(cue => [...cue.text.replace(/\n/gu, "")].length <= 7)).toBe(true);
  });

  it("keeps disjoint selections from the same source on the correct concat offsets", () => {
    const tl = timeline([
      { seq: 0, segmentId: "first", sourceId: "src-a", sourceIn: 0, sourceOut: 8, durationSeconds: 8 },
      { seq: 1, segmentId: "later", sourceId: "src-a", sourceIn: 10, sourceOut: 18, durationSeconds: 8 },
    ]);
    const later = [...text32].reverse().join("");
    const plan = planAutoCaptions({ timeline: tl, sources: [source("src-a", [...wordsFor(text32), ...wordsFor(later, 10)])] });
    const result = check(tl, plan);
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    expect(joined(result)).toBe(text32 + later);
    expect(result.cues.map(cue => [cue.start, cue.end, cue.sourceStart, cue.sourceEnd])).toEqual([[0, 6, 0, 6], [6, 8, 6, 8], [8, 14, 10, 16], [14, 16, 16, 18]]);
  });

  it("never lets a neighboring word bleed across a cue boundary through the old 20ms tolerance", () => {
    const tl = timeline();
    const plan = planAutoCaptions({ timeline: tl, sources: [source("src-a", wordsFor(text32, 1, 0.01))] });
    const result = check(tl, plan);
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    expect(joined(result)).toBe(text32);
    expect(result.cues.map(cue => [cue.start, cue.end])).toEqual([[1, 1.24], [1.24, 1.32]]);
  });

  it("handles the exact 24/25-character boundary and preserves the input objects", () => {
    for (const length of [24, 25]) {
      const tl = timeline();
      const input = { timeline: tl, sources: [source("src-a", wordsFor(text32.slice(0, length)))] };
      const before = structuredClone(input);
      const plan = planAutoCaptions(input);
      expect(plan.cues).toBe(length === 24 ? 1 : 2);
      expect(check(tl, plan).ok).toBe(true);
      expect(joined(check(tl, plan))).toBe(text32.slice(0, length));
      expect(input).toEqual(before);
    }
  });

  it("preserves a long Latin token with estimated split bounds and its original measured token", () => {
    const text = "supercalifragilisticexpialidocious";
    const tl = timeline();
    const original = { text, start: 1.25, end: 7.125 };
    const plan = planAutoCaptions({ timeline: tl, sources: [source("src-a", [original])] });
    const result = check(tl, plan);
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    expect(joined(result)).toBe(text);
    expect(plan.transcript.sentences[0]!.words.every(word => word.timingPrecision === "word-estimated" && JSON.stringify(word.originalWord) === JSON.stringify(original))).toBe(true);
    expect(result.cues[0]!.start).toBe(1.25);
    expect(result.cues.at(-1)!.end).toBe(7.125);
  });

  it("rejects overlapping evidence, duplicate source IDs and invalid sentence-only ranges", () => {
    expect(() => planAutoCaptions({ timeline: timeline(), sources: [source("src-a", [{ text: "甲", start: 0, end: 1 }, { text: "乙", start: 0.5, end: 1.5 }])] })).toThrow(/重叠/u);
    expect(() => planAutoCaptions({ timeline: timeline(), sources: [source("src-a", []), source("src-a", [])] })).toThrow(/重复/u);
    expect(() => planAutoCaptions({ timeline: timeline(), sources: [{ sourceId: "src-a", analysis: { probe: { speech: { sentences: [{ text: "甲", start: 1, end: 0 }] } } } }] })).toThrow();
    const empty = planAutoCaptions({ timeline: timeline([]), sources: [] });
    expect(empty.cues).toBe(0);
    expect(empty.gaps).toEqual([]);
    expect(shots(empty)).toEqual([]);
  });

  it("rejects invalid transcript evidence independently of caption generation", () => {
    const tl = timeline();
    const plan = planAutoCaptions({ timeline: tl, sources: [source("src-a", wordsFor(text32))] });
    plan.transcript.sentences[0]!.words[0]!.end = Number.NaN;
    expect(check(tl, plan).issues.some(issue => issue.id.startsWith("caption.transcriptTime:") && issue.severity === "hard")).toBe(true);
  });

  it("rejects sub-millisecond screens which would become zero-duration SRT entries", () => {
    const tl = timeline();
    expect(() => planAutoCaptions({ timeline: tl, sources: [source("src-a", [{ text: "甲", start: 1, end: 1.0001 }])] })).toThrow(/SRT/u);
    const plan = planAutoCaptions({ timeline: tl, sources: [source("src-a", [{ text: "甲", start: 1, end: 2 }])] });
    Object.assign(shots(plan)[0]!.subtitle_text![0]!, { source_timestamp: "1-1.0001", original_timestamp: "1-1.0001" });
    expect(check(tl, plan).issues.some(issue => issue.id.startsWith("caption.cueTime:") && issue.severity === "hard")).toBe(true);
  });
});
