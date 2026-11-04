import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frozenSegmentContract } from "./requirement-contract.js";
import { installVendorDurationProjectionBridge, withVendorDurationProjectionScope } from "./vendor-compat.js";

const vendor = createRequire(import.meta.url);
const load = (name: string) => vendor(fileURLToPath(new URL(
  `../../../vendor/supermickey/hyperreality-system/engines/script-engine/core/${name}.js`, import.meta.url,
)));
const { ScriptGenerator } = load("script-generator");
const { ScriptValidator } = load("script-validator");
const { ScriptBlueprint } = load("script-blueprint");
const silent = { speechPolicy: "none" as const };
const frozenSegments = frozenSegmentContract({ duration: 30, segmentContract: {
  count: 3, totalSeconds: 30, secondsPerSegment: 10, hardCuts: true,
  intervals: ["起步追击", "完成超越", "率先冲线"].map((brief, i) => ({ startSec: i * 10, endSec: (i + 1) * 10, brief })),
} }, 30)!;
const intent = {
  metadata: { title: "冲线", target_duration: 30, _prd: { audioSpecification: { voicePolicy: "无可辨人声，无对白或旁白" } } },
  constraints: {},
  parsed: { primary_mode: "dramatic" },
};
const template = { structure: { acts: [] } };
const noDialogue = () => ({ has_dialogue: false, lines: [], blocks: [] });
const blueprint = () => ({
  meta: { title: "冲线", _metadata: intent.metadata },
  character_system: { characters: [{ character_id: "LEAD", name: "车手", role: "protagonist" }] },
  voice_system: { global_voice_policy: "no_speech", voice_profiles: [] },
  structure: { acts: [], scenes: ["opening", "emotional_climax", "resolution"].map((scene_type, i) => ({
    scene_id: `SC-${i + 1}`, scene_type, characters: ["LEAD"], dialogue: noDialogue(),
    timing: { start: 10 * i, duration: 10, end: 10 * (i + 1) }, visual_notes: "后轮卷起尘土，保留引擎轰鸣与轮胎摩擦声",
  })) },
});
const generator = () => Object.assign(Object.create(ScriptGenerator.prototype), { config: { timeout: 5_000 } });

function narrationFixture(sceneFields: Record<string, unknown>) {
  const candidate = blueprint();
  Object.assign(candidate.structure.scenes[2]!, sceneFields);
  return new ScriptBlueprint({
    ...candidate,
    meta: { title: "冲线", target_duration: 30 },
    structure: { ...candidate.structure, acts: [{ act_id: "ACT-1" }] },
  });
}

let restore: () => void;
beforeEach(() => { restore = installVendorDurationProjectionBridge(); });
afterEach(() => { restore(); vi.useRealTimers(); });

describe("frozen speech policy in the actual native script path", () => {
  it("replaces native speech requirements on both prompt roles, keeps visuals and preserves the engine call", async () => {
    const script = generator();
    const engine = { generate: vi.fn(async function(this: unknown) {
      expect(this).toBe(engine);
      return { success: true, content: JSON.stringify(blueprint()) };
    }) };
    script.llmEngine = engine;
    expect(script._buildGenerationPrompt(intent, template)).toContain("每个场景必须有台词");
    const result = await withVendorDurationProjectionScope({ ...silent, frozenSegments }, () => script.generate(intent, template));
    expect(engine.generate).toHaveBeenCalledTimes(1);
    expect(engine.generate).toHaveBeenCalledWith(
      expect.stringContaining('"dialogue": {"has_dialogue": false, "lines": [], "blocks": []}'),
      expect.objectContaining({ systemPrompt: expect.stringContaining("禁止可辨识人声") }),
    );
    const call = engine.generate.mock.calls[0] as unknown as [string, { systemPrompt: string }];
    expect(call[0]).toContain("冻结分段合同");
    expect(call[0]).toContain('{"start":20,"duration":10,"end":30}');
    expect(call[1].systemPrompt).toContain("严格遵守用户冻结的分段区间");
    expect(call[0]).not.toMatch(/每个场景必须有台词|旁白台词写法|原文的钉子台词/);
    expect(call[1].systemPrompt).not.toMatch(/台词极简主义|每句台词必须挂在/);
    expect(result.meta._metadata.voiceoverAllowed).toBe(false);
    expect(result.voice_system).toEqual(blueprint().voice_system);
    expect(result.structure.scenes[0].visual_notes).toBe(blueprint().structure.scenes[0]!.visual_notes);
    expect(script.llmEngine).toBe(engine);
  });

  it.each([
    ["positive lines", { dialogue: { ...noDialogue(), lines: [{ text: "欢迎回来" }] } }],
    ["positive blocks", { dialogue: { ...noDialogue(), blocks: [{ line: "欢迎回来" }] } }],
    ["contradictory flag", { dialogue: { ...noDialogue(), has_dialogue: true } }],
    ["legacy string", { dialogue: "欢迎回来" }],
    ["stray narration", { narration: [{ text: "欢迎回来" }] }],
    ["stray voice over", { voice_over: { text: "欢迎回来" } }],
    ["stray lines", { lines: [{ text: "欢迎回来" }] }],
  ])("rejects %s before native normalization can rewrite the authored content", async (_label, wrong) => {
    const candidate = blueprint();
    Object.assign(candidate.structure.scenes[0]!, wrong);
    const script = generator();
    await expect(withVendorDurationProjectionScope(silent, () =>
      script._parseLLMResponse(JSON.stringify(candidate), intent),
    )).rejects.toThrow("FROZEN_SCREENPLAY_SPEECH_UNVERIFIED");
  });

  it("validates the whole silent plan while retaining native validator checks and the standard policy outside scope", async () => {
    const script = generator();
    const validator = new ScriptValidator();
    const candidate = blueprint();
    const old = validator._checkDialogue(candidate);
    expect(old[0]).toMatchObject({ name: "has_dialogue", passed: false });
    expect(validator._isVoiceoverAllowed(candidate)).toBe(true);
    await withVendorDurationProjectionScope(silent, () => {
      const checks = validator._checkDialogue(candidate);
      expect(checks[0]).toMatchObject({ name: "no_identifiable_speech", passed: true, severity: "critical" });
      expect(checks.slice(1).map((check: { name: string }) => check.name)).toEqual(old.slice(1).map((check: { name: string }) => check.name));
      candidate.voice_system.voice_profiles.push({ speaker: "LEAD" } as never);
      expect(validator._checkDialogue(candidate)[0].passed).toBe(false);
      expect(() => script._parseLLMResponse(JSON.stringify(candidate), intent)).toThrow("FROZEN_SCREENPLAY_SPEECH_UNVERIFIED");
    });
    expect(validator._isVoiceoverAllowed(candidate)).toBe(true);
  });

  it("accepts exclusively negated narration prose in the frozen native validator without changing screenplay bytes", async () => {
    const candidate = narrationFixture({
      visual_notes: "全段无对白、旁白或口播；保留引擎和轮胎摩擦声。",
      setting: "no voiceover. 封闭赛道内停车。",
    });
    const original = candidate.toJSON();
    const validator = new ScriptValidator();
    const before = await withVendorDurationProjectionScope(silent, () => validator.validate(candidate));
    const report = await withVendorDurationProjectionScope({ ...silent, frozenSegments }, () => validator.validate(candidate));
    const other = (row: { name: string }) => !["forbidden_旁白", "forbidden_voiceover"].includes(row.name);
    expect(before.passed).toBe(false);
    expect(report.passed).toBe(true);
    expect(report.checks.filter(other)).toEqual(before.checks.filter(other));
    expect(report.checks.filter((row: { name: string }) => !other(row))).toEqual([
      expect.objectContaining({ name: "forbidden_旁白", passed: true, severity: "critical",
        details: { narrationTextDisposition: "verified_negated_prose" } }),
      expect.objectContaining({ name: "forbidden_voiceover", passed: true, severity: "critical",
        details: { narrationTextDisposition: "verified_negated_prose" } }),
    ]);
    expect(validator.validate(candidate).passed).toBe(false);
    expect(candidate.toJSON()).toBe(original);
  });

  it.each([
    ["positive prose", { visual_notes: "结尾增加旁白：欢迎回来。" }],
    ["mixed narration", { visual_notes: "无旁白；结尾增加旁白：欢迎回来。" }],
    ["mixed different speech", { visual_notes: "无旁白；结尾增加解说：欢迎回来。" }],
    ["mixed ambient speech", { visual_notes: "无旁白；有两人低声交谈。" }],
    ["mixed different field", { visual_notes: "无旁白。", setting: "voiceover: welcome back." }],
    ["ambiguous grammar", { visual_notes: "没有旁白盖过引擎声。" }],
    ["ambiguous question", { visual_notes: "无旁白？" }],
    ["unsupported prose field", { visual_notes: "无旁白。", extra_notes: "无旁白。" }],
    ["unknown structured key", { visual_notes: "无旁白。", audio: { voiceover: null } }],
    ["unknown speech alias", { visual_notes: "无旁白。", audio: { narration_text: "欢迎回来" } }],
    ["invalid explicit speech structure", { visual_notes: "无旁白。", dialogue: { ...noDialogue(), lines: [{ text: "欢迎回来" }] } }],
    ["mismatched frozen timing", { visual_notes: "无旁白。", timing: { start: 21, duration: 10, end: 31 } }],
  ])("leaves the native narration finding unchanged for %s", async (_label, fields) => {
    const candidate = narrationFixture(fields);
    const validator = new ScriptValidator();
    const original = candidate.toJSON();
    const before = await withVendorDurationProjectionScope(silent, () => validator.validate(candidate));
    const report = await withVendorDurationProjectionScope({ ...silent, frozenSegments }, () => validator.validate(candidate));
    expect(report.passed).toBe(false);
    expect(report.checks).toEqual(before.checks);
    expect(candidate.toJSON()).toBe(original);
  });

  it("preserves unrelated native forbidden checks even when their text overlaps a proven negated mention", async () => {
    const candidate = narrationFixture({ visual_notes: "无旁白。车壳有金属光泽。" });
    const validator = new ScriptValidator({ forbiddenElements: ["旁白", "voiceover", "无旁白", "金属光泽"] });
    const report = await withVendorDurationProjectionScope({ ...silent, frozenSegments }, () => validator.validate(candidate));
    expect(report.passed).toBe(false);
    expect(report.checks.filter((row: { category: string }) => row.category === "forbidden")).toEqual([
      expect.objectContaining({ name: "forbidden_旁白", passed: true }),
      expect.objectContaining({ name: "forbidden_voiceover", passed: true }),
      expect.objectContaining({ name: "forbidden_无旁白", passed: false }),
      expect.objectContaining({ name: "forbidden_金属光泽", passed: false }),
    ]);
  });

  it("does not dispatch another model request after a complete response violates the policy", async () => {
    vi.useFakeTimers();
    const script = generator();
    const candidate = blueprint();
    Object.assign(candidate.structure.scenes[0]!, { voiceover: "欢迎回来" });
    const generate = vi.fn(async () => ({ success: true, content: JSON.stringify(candidate) }));
    script.llmEngine = { generate };
    const attempt = withVendorDurationProjectionScope(silent, () => script.generate(intent, template));
    const result = attempt.then(
      () => ({ error: "" }),
      (error: Error) => ({ error: error.message }),
    );
    await vi.runAllTimersAsync();
    expect((await result).error).toContain("FROZEN_SCREENPLAY_SPEECH_UNVERIFIED");
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
