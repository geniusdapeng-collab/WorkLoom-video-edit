import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetCircuit, DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS } from "@workloom/base/model-router";
import { WorkloomLLMEngine } from "./llm-adapter.js";
import { installPrdAuthorityBridge, installPrdProductionBridge, withPrdAuthorityScope } from "./prd-authority-bridge.js";
import { PRDGenerator, PRDSchema, prdFixture } from "./prd-authority.test-support.js";
import type { RequirementRecord } from "./requirement-contract.js";

const require = createRequire(import.meta.url);
type BridgeDependencies = Parameters<typeof installPrdProductionBridge>[0];
const { globalLLMLimiter } = require("../../../vendor/supermickey/hyperreality-system/core/llm-concurrency-limiter.js") as {
  globalLLMLimiter: { withLimit<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> };
};
const { BaseAgent } = require("../../../vendor/supermickey/hyperreality-system/engines/production-engine/agents/base-agent.js") as {
  BaseAgent: { prototype: RequirementRecord };
};
const standardizer = require("../../../vendor/supermickey/hyperreality-system/engines/field-standardizer.js") as
  Pick<BridgeDependencies, "standardizeShot" | "validateShot"> & { CRITICAL_FIELDS: BridgeDependencies["fields"] };
const { SceneDesignAgent } = require("../../../vendor/supermickey/hyperreality-system/engines/production-engine/agents/scene-design-agent.js") as {
  SceneDesignAgent: new (options?: RequirementRecord) => {
    process(shots: RequirementRecord[], blueprint: RequirementRecord): Promise<{ shots: RequirementRecord[]; degraded: boolean }>;
    _getSystemPrompt(): string;
    _buildPrompt(shots: RequirementRecord[], blueprint: RequirementRecord): string;
    _fallback(shots: RequirementRecord[]): unknown;
    _getAltLLMEngine?: () => unknown;
    enabled: boolean;
    _llmEngineLoaded: boolean;
    _llmEngine: WorkloomLLMEngine;
    setDeadline(at: number): void;
  };
};
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  resetCircuit("video.preproduction.plan");
  vi.restoreAllMocks();
});

const shots = [{ shotId: "SC-01", duration: 10, dialogue: { lines: [{ content: "本镜原始现场声音要求" }] } }];
const blueprint = { _originalStoryText: "原始导演资料须完整保留。".repeat(200) + "原始导演资料尾部哨兵" };
const good = '{"shots":[{"shotId":"SC-01","scene":"测试赛道","genre":"action","mood":"专注","action":"清楚的实际动作","makeup":"实际妆容","props":"轮胎墙","emotional_target":"速度感"}]}';
type Wire = { model: string; max_tokens: number; response_format: unknown; thinking: unknown;
  messages: Array<{ role: string; content: string }> };
type Reply = string | Response | Error;
function fixture(replies: Reply[]) {
  resetCircuit("video.preproduction.plan");
  const value = prdFixture("FULL-PRODUCTION");
  cleanups.push(value.cleanup);
  const wires: Wire[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    wires.push(JSON.parse(String(init!.body)) as Wire);
    const reply = replies[wires.length - 1];
    if (reply instanceof Error) throw reply;
    if (reply instanceof Response) return reply;
    if (reply === undefined) throw new Error("unexpected additional fixture request");
    return Response.json({ id: `synthetic-response-${wires.length}`, model: "deepseek-flash",
      choices: [{ finish_reason: "stop", message: { content: reply } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  });
  const engine = new WorkloomLLMEngine({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-only", model: "deepseek-flash", fetchImpl });
  const generator = new PRDGenerator();
  for (const [name, data] of [["agent2", value.creative], ["agent3", value.production]] as const) {
    Object.assign(generator[name] as object, { _llmEngineLoaded: true,
      _llmEngine: { reasonStructured: async () => ({ success: true, data: structuredClone(data) }) } });
  }
  class System {
    prdGenerator = generator;
    llmEngine = engine;
    _confirmRequirementList(_review: string, requirementList: unknown) { return { approved: true, requirementList }; }
    _generateMinimalPRD() { throw new Error("fixture unexpectedly called legacy PRD fallback"); }
    _confirmPRD(_review: string, prd: unknown) { return { approved: true, prd }; }
    create() { throw new Error("fixture unexpectedly called system.create"); }
    _optimizeOpeningTitle() { throw new Error("fixture unexpectedly called title optimization"); }
    _generatePromptsReport() { throw new Error("fixture unexpectedly called report generation"); }
  }
  const systemPrototype = System.prototype as unknown as RequirementRecord;
  cleanups.push(installPrdAuthorityBridge(systemPrototype, PRDGenerator.prototype, PRDSchema));
  const unused = (...keys: string[]): RequirementRecord => Object.fromEntries(keys.map(key => [key, () => {
    throw new Error(`fixture unexpectedly called ${key}`);
  }]));
  const dependencies = {
    systemPrototype,
    productionPrototype: unused("produce", "_loadLatestCheckpoint", "_saveCheckpoint", "_clearCheckpoints"),
    phase1Prototype: unused("_shouldGenerateOpening"), refinerPrototype: unused("_normalizeConstraint"),
    costumePrototype: unused("enhance"), fieldGuardPrototype: unused("normalizeAndValidate", "check", "assertOpeningFields"),
    fusionPrototype: unused("_loadSubCheckpoint", "_saveSubCheckpoint", "_clearSubCheckpoint"),
    qualityGatePrototype: unused("run"), deliveryGuardPrototype: unused("verify"), semanticPrototype: unused("_buildPrompt"),
    standardizeShot: standardizer.standardizeShot, validateShot: standardizer.validateShot, fields: standardizer.CRITICAL_FIELDS,
    structuredAgent: { prototype: BaseAgent.prototype, limiter: globalLLMLimiter },
  };
  cleanups.push(installPrdProductionBridge(dependencies));
  const system = new System();
  const run = <T,>(operation: () => Promise<T>) => withPrdAuthorityScope(value.authority, async () => {
    await system._confirmRequirementList("synthetic G3 fixture", value.list);
    const prd = await (generator.generate as (discovery: unknown) => Promise<RequirementRecord>)(value.discovery);
    const review = (generator.generateMarkdown as (prd: RequirementRecord) => string)(prd);
    await system._confirmPRD(review, prd);
    return operation();
  });
  const agent = new SceneDesignAgent({ llmTimeout: 15_000 });
  // Exercise native BaseAgent on red without starting the vendor's standalone
  // SDK, then the same actual per-run host adapter through the private bridge.
  agent._llmEngineLoaded = true;
  agent._llmEngine = engine;
  const alt = vi.fn(() => undefined); agent._getAltLLMEngine = alt;
  const fallback = vi.spyOn(agent, "_fallback");
  return { run, value, wires, agent, alt, fallback };
}

describe("host-bound Studio production with the native SceneDesignAgent", () => {
  it.each(["malformed", "wrong-shape"])("repairs a settled %s response using the complete original prompt and same schema", async kind => {
    const invalid = kind === "malformed" ? '{"shots":[RAW_BAD_CONTENT_MARKER' : '{"shots":[]}';
    const f = fixture([invalid, good]);
    const original = f.agent._buildPrompt(shots, blueprint);
    const result = await f.run(() => f.agent.process(shots, blueprint));
    expect(result).toMatchObject({ degraded: false, shots: [{ shotId: "SC-01", scene: "测试赛道", makeup: "实际妆容" }] });
    expect(f.wires).toHaveLength(2);
    const [first, second] = f.wires;
    const basePrompt = first!.messages[1]!.content;
    const corrected = second!.messages[1]!.content;
    for (const wire of f.wires) {
      expect(wire).toMatchObject({ model: "deepseek-flash", max_tokens: DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
        response_format: { type: "json_object" }, thinking: first!.thinking });
      const message = wire.messages[1]!.content;
      expect(message).toContain(f.agent._getSystemPrompt() + "\n\n" + original);
      expect(message).toContain('"required": [\n    "shots"\n  ]');
      expect(message.split(f.value.content)).toHaveLength(2);
      expect(message).not.toContain("RAW_BAD_CONTENT_MARKER");
      expect(message).not.toContain("极度压缩");
    }
    expect(corrected).not.toBe(basePrompt);
    expect(corrected).toContain("完整结构修正");
    expect(f.alt).not.toHaveBeenCalled();
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it.each(["auth", "network", "unsettled", "truncated", "wrong-model"])("stops after a %s response without an altered resend or fallback", async failure => {
    const reply = failure === "auth" ? Response.json({ error: "fixture-auth" }, { status: 401 })
      : failure === "network" ? new Error("fixture network unavailable")
      : Response.json({ id: "synthetic-failed", model: failure === "wrong-model" ? "other-model" : "deepseek-flash",
          choices: [{ finish_reason: failure === "truncated" ? "length" : "stop", message: { content: '{"malformed":' } }],
          ...(failure === "unsettled" ? {} : { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }) });
    const f = fixture([reply, good]);
    await expect(f.run(async () => {
      try { return await f.agent.process(shots, blueprint); }
      catch { return { success: false }; } // Swallowed native exceptions still fail the host scope.
    })).rejects.toThrow("PRD_PRODUCTION_MODEL_UNVERIFIED");
    expect(f.wires).toHaveLength(1);
    expect(f.alt).not.toHaveBeenCalled();
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it("requires the correction itself to pass the native shape check and forbids a third request", async () => {
    const f = fixture(['{"shots":', '{"shots":"invalid"}', good]);
    await expect(f.run(() => f.agent.process(shots, blueprint))).rejects.toThrow("PRD_PRODUCTION_MODEL_UNVERIFIED");
    expect(f.wires).toHaveLength(2);
    expect(f.alt).not.toHaveBeenCalled();
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it("fails before dispatch when the original production deadline has expired", async () => {
    const f = fixture([good]);
    f.agent.setDeadline(Date.now() - 100);
    await expect(f.run(() => f.agent.process(shots, blueprint))).rejects.toThrow("PRD_PRODUCTION_MODEL_DEADLINE");
    expect(f.wires).toHaveLength(0);
  });

  it("rejects a disabled agent in approved G4 while preserving standalone fallback", async () => {
    const f = fixture([good]);
    f.agent.enabled = false;
    const standalone = await f.agent.process(shots, blueprint);
    expect(standalone).toMatchObject({ degraded: true });
    expect(f.fallback).toHaveBeenCalledTimes(1);
    await expect(f.run(() => f.agent.process(shots, blueprint))).rejects.toThrow("PRD_PRODUCTION_MODEL_DISABLED");
    expect(f.wires).toHaveLength(0);
    expect(f.fallback).toHaveBeenCalledTimes(1);
  });

  it("preserves standalone native critical fallback outside the private G4 scope", async () => {
    const f = fixture(['{"shots":', good]);
    const result = await f.agent.process(shots, blueprint);
    expect(result.degraded).toBe(false);
    expect(f.wires).toHaveLength(2);
    expect(f.wires[1]!.messages[1]!.content).toContain("极度压缩，仅保留核心指令");
    expect(f.alt).toHaveBeenCalledTimes(1);
  });
});
