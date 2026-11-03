import { describe, expect, it } from "vitest";
import { normalizePrdProductionProfile } from "./prd-authority.js";
import { assertNoSpokenPromptPackage } from "./frozen-speech-policy.js";

const production = { resolution: "1080p", frameRate: 30, subtitleMode: "burned", nativeAudio: true,
  openWithCover: false, titleCard: false, durationToleranceFrames: 1 };
const profile = (productionRequirements: Record<string, unknown>) => normalizePrdProductionProfile({
  brief: { duration: 30, aspectRatio: "9:16", platform: "douyin", productionRequirements },
});

describe("frozen marketing speech policy", () => {
  it("accepts an explicit no-speech policy and keeps original ambient audio", () => {
    expect(profile({ ...production, speechPolicy: "none" })).toMatchObject({ speechPolicy: "none", nativeAudio: true });
  });
  it("leaves speech applicability unspecified when the current owner does not declare it", () => {
    expect(profile(production)).not.toHaveProperty("speechPolicy");
  });
  it.each([null, "mute", "auto", true])("rejects unknown speech policies %s", (value) => {
    expect(() => profile({ ...production, speechPolicy: value })).toThrow("PRD_PROFILE_INVALID");
  });

  it("accepts the native no-speech field and ambience while keeping every source byte", () => {
    const shot = { shotId: "opening", dialogue: "无台词，无对白", dialogueBlocks: [],
      fields: { dialogue: { has_dialogue: false, lines: [], blocks: [] }, audio: "引擎与看台声" } };
    const before = structuredClone(shot);
    expect(() => assertNoSpokenPromptPackage([shot], "G6_PROMPT")).not.toThrow();
    expect(shot).toEqual(before);
  });
  it.each([
    { fields: { dialogue: "开场语" }, dialogueFree: true },
    { dialogueBlocks: [{ line: "开始！" }], fields: { dialogue: "无台词" } },
    { fields: { voice_over: { text: "欢迎来到赛道" } } },
    { fields: { dialogue: { has_dialogue: false, lines: [{ text: "台词正文" }] } } },
  ])("stops positive authored speech before final gating (%s)", shot => {
    expect(() => assertNoSpokenPromptPackage([shot], "G7_FINAL")).toThrow("PRD_SPEECH_CONFLICT");
  });
});
