import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { SceneDesignAgent } = require("../../../vendor/supermickey/hyperreality-system/engines/production-engine/agents/scene-design-agent.js");
const { Phase1SceneDesign } = require("../../../vendor/supermickey/hyperreality-system/engines/production-engine/phases/phase-1-scene-design.js");
const { AgentContractValidator } = require("../../../vendor/supermickey/hyperreality-system/engines/production-engine/utils/agent-contract-validator.js");

const scene = "封闭赛道外线，".repeat(24) + "场景末尾：第二个超车发生在最终弯心";
const dialogue = "赛后说完一句。".repeat(24) + "对白末尾：比赛已经结束";
const shot = {
  shotId: "opening", duration: 10, scene, dialogue,
  dialogueBlocks: [{ lines: [{ content: dialogue }] }],
  action: "在封闭赛道骑行", costume: "全盔与连体赛车服", makeup: "全盔下不展示妆容",
  timing: { start: 0, duration: 10, end: 10 }, sceneFunction: "racing",
  emotionArcTarget: { emotion: "冷静追击" }, characterDescs: "原有骑手锚点",
  _blueprint: { debug: "不要序列化运行对象" },
};
const otherShot = { ...shot, shotId: "ending", action: "停车摘盔" };
const design = {
  shotId: "opening", scene: "封闭赛道，路肩护栏和自然光", genre: "action", mood: "紧张",
  action: "骑车贴弯，追赶前车", makeup: "全盔下不展示妆容",
  props: "全覆式安全头盔", emotional_target: "专注",
};
const blueprint = {
  _originalStoryText: "开场骑行，停稳才摘盔。",
  character_system: { characters: [{ name: "骑手", description: "授权角色" }] },
};

describe("native SceneDesign shot contract", () => {
  it("sends the full same-shot source and preserves the established shot without forcing indoor standing", async () => {
    const agent = new SceneDesignAgent();
    agent._callLLM = async (prompt: string, schema: Record<string, unknown>) => {
      expect(prompt).toContain(scene);
      expect(prompt).toContain(dialogue);
      expect(prompt).toContain("dialogueBlocks");
      expect(prompt).toContain(shot.costume);
      expect(prompt).toContain(blueprint._originalStoryText);
      for (const key of ["timing", "sceneFunction", "emotionArcTarget", "characterDescs"]) expect(prompt).toContain(key);
      expect(prompt).not.toContain("不要序列化运行对象");
      expect(agent._getSystemPrompt() + prompt).not.toMatch(/角色必须在真实地面站立|背景必须是真实墙面/);
      expect(agent._validateSchema({ shots: [design] }, schema)).toEqual({ valid: true });
      return { result: { shots: [design] }, degraded: false };
    };
    const result = await agent.process([shot], blueprint);
    expect(result.degraded).toBe(false);
    expect(result.shots[0]).toMatchObject({ ...design, dialogue, costume: shot.costume, duration: 10 });
  });

  it.each([
    ["missing shot", [design]],
    ["duplicate shot", [design, design]],
    ["wrong shot", [design, { ...design, shotId: "another" }]],
    ["missing required design", [design, { ...design, shotId: "ending", makeup: "" }]],
    ["unexpected revision to approved dialogue", [design, { ...design, shotId: "ending", dialogue: "不应改写" }]],
  ])("rejects %s even if an alternate path claims success", async (_label, rows) => {
    const agent = new SceneDesignAgent();
    agent._callLLM = async (_prompt: string, schema: Record<string, unknown>) => {
      expect(agent._validateSchema({ shots: rows }, schema).valid).toBe(false);
      return { result: { shots: rows }, degraded: false };
    };
    const result = await agent.process([shot, otherShot], blueprint);
    expect(result.degraded).toBe(true);
    expect(result.shots).toEqual([shot, otherShot]);
  });

  it("does not save or advance a native Phase1 checkpoint for a degraded SceneDesign response", async () => {
    const saveCheckpoint = vi.fn();
    const mergeShots = vi.fn();
    const phase = new Phase1SceneDesign({
      cloneShots: structuredClone, logFn: vi.fn(), saveCheckpoint, mergeShots,
      agents: { sceneDesign: { process: async () => ({ shots: [shot], degraded: true, degradeReason: "invalid source" }) },
        openingDesign: { process: async () => null } },
    });
    const result = await phase.execute({ shots: [shot], result: { llmStats: {} }, adaptedBlueprint: {} });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("invalid source") });
    expect(saveCheckpoint).not.toHaveBeenCalled();
    expect(mergeShots).not.toHaveBeenCalled();
  });

  it("accepts native string (including no dialogue) and structured dialogue but rejects an invalid value", async () => {
    const validator = new AgentContractValidator({ autoFix: false });
    for (const value of [dialogue, "", { lines: [{ content: dialogue }] }]) {
      const input = { shots: [{ ...shot, dialogue: value }], blueprint: { meta: {}, character_system: {} } };
      expect(validator.validate("phase1-phase2", input).valid).toBe(true);
      expect(input.shots[0]?.dialogue).toBe(value);
    }
    const invalid = { ...shot, dialogue: 42 };
    const agent = new SceneDesignAgent();
    agent._callLLM = vi.fn();
    expect(await agent.process([invalid], blueprint)).toMatchObject({ degraded: true });
    expect(agent._callLLM).not.toHaveBeenCalled();
    expect(validator.validate("phase1-phase2", { shots: [invalid], blueprint: { meta: {}, character_system: {} } }).valid).toBe(false);
  });
});
