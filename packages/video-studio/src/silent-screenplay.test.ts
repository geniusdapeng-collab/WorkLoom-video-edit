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
