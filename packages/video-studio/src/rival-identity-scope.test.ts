import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindRequirementContract, requirementCast, requirementRecord, type RequirementContract, type RequirementRecord } from "./requirement-contract.js";
import { preparePrdAuthority } from "./prd-authority.js";
import { installPrdAuthorityBridge, installPrdProductionBridge, productionModelInput, withPrdAuthorityScope } from "./prd-authority-bridge.js";
import { PRDGenerator, PRDSchema, prdFixture } from "./prd-authority.test-support.js";
import { bindRivalAuthorityIdentity, bindRivalFusionIdentity, bindRivalRepairIdentity } from "./rival-identity-scope.js";

type NativeConstructor = { new (...args: unknown[]): RequirementRecord; prototype: RequirementRecord };
const nativeRequire = createRequire(import.meta.url);
const load = (relative: string, name: string): NativeConstructor => nativeRequire(
  `../../../vendor/supermickey/hyperreality-system/${relative}`,
)[name] as NativeConstructor;
const { standardizeShot, validateShot, CRITICAL_FIELDS } = nativeRequire(
  "../../../vendor/supermickey/hyperreality-system/engines/field-standardizer.js",
) as Pick<Parameters<typeof installPrdProductionBridge>[0], "standardizeShot" | "validateShot"> & {
  CRITICAL_FIELDS: Parameters<typeof installPrdProductionBridge>[0]["fields"];
};
const { extractJson } = nativeRequire("../../../vendor/supermickey/hyperreality-system/engines/field-quality/json-salvage.js") as {
  extractJson: (content: string) => unknown;
};
const PromptFusionAgent = load("engines/production-engine/agents/prompt-fusion-agent.js", "PromptFusionAgent");
const RuleChecker = load("engines/field-quality/field-check-agent.js", "RuleChecker");
const LLMRepairer = load("engines/field-quality/field-repair-agent.js", "LLMRepairer");
const { FIELD_REQUIREMENTS } = nativeRequire("../../../vendor/supermickey/hyperreality-system/engines/field-quality/field-check-agent.js") as {
  FIELD_REQUIREMENTS: Record<string, string>;
};
const disposers: Array<() => void> = [];
const fixtures: ReturnType<typeof prdFixture>[] = [];
const invoke = (receiver: RequirementRecord, key: string, ...args: unknown[]): unknown =>
  Reflect.apply(receiver[key] as (...args: unknown[]) => unknown, receiver, args);

function refreshSource(value: ReturnType<typeof prdFixture>) {
  value.list = bindRequirementContract({ keyPoints: [] }, value.discovery, requirementRecord(value.discovery.upstreamFields, "upstream"),
    structuredClone(value.metadata), requirementCast(value.metadata).hash, "原始年轻消费者");
  value.contract = value.list._workloomRequirementContract as RequirementContract;
  value.authority = preparePrdAuthority({ metadata: value.metadata, marketing: value.marketing, workDir: value.workDir, projectId: value.scope.projectId });
}

function raceFixture(name: string) {
  const value = prdFixture(name, [10, 10, 10]);
  fixtures.push(value);
  const brief = requirementRecord(value.metadata.brief, "brief");
  Object.assign(requirementRecord(brief.productionRequirements, "production"), { speechPolicy: "none" });
  brief.segmentContract = { count: 3, totalSeconds: 30, secondsPerSegment: 10, hardCuts: true, intervals: [
    { startSec: 0, endSec: 10, brief: "第一帧已在虚构封闭赛道高速追击。前两段共同完成两次清楚超车再冲线。" },
    { startSec: 10, endSec: 20, brief: "两次超车针对两辆不同对手车，每次从车后到完全领先，第一辆已超车继续在后。" },
    { startSec: 20, endSec: 30, brief: "主角停稳下车，在领奖台自取奖杯。" },
  ] };
  const structure = requirementRecord(value.discovery.sceneStructure, "structure");
  const nodes = [structure.opening, ...(structure.scenes as unknown[]), structure.ending] as RequirementRecord[];
  for (const [index, node] of nodes.entries()) {
    const action = index < 2 ? "合成人物驾驶摩托车从前方对手车后高速追近并完成完全超车" : "合成人物停稳下车自取奖杯";
    node.purpose = action;
    node.productionContract = { props: [{ name: "无标识赛道摩托车", description: "与两辆不同对手摩托车在封闭赛道竞速" }],
      actions: [{ actorId: "builtin-person", description: action }] };
    Object.assign(value.production.scenePlan.scenes[index]!, { purpose: action, visualRequirements: [action] });
  }
  refreshSource(value);
  return value;
}

function nativeHarness(value: ReturnType<typeof prdFixture>) {
  class System {
    prdGenerator = new PRDGenerator();
    async _confirmRequirementList(_content: unknown, requirementList: unknown) { return { approved: true, requirementList }; }
    _generateMinimalPRD() { throw new Error("Unexpected fallback"); }
    async _confirmPRD(_content: unknown, prd: unknown) { return { approved: true, prd }; }
    create(operation: () => unknown) { return operation(); }
    _optimizeOpeningTitle() { return undefined; }
    _generatePromptsReport() { return "native synthetic fixture"; }
  }
  const systemPrototype = System.prototype as unknown as RequirementRecord;
  disposers.push(installPrdAuthorityBridge(systemPrototype, PRDGenerator.prototype, PRDSchema));
  const productionPrototype: RequirementRecord = {
    produce() { return {}; }, _loadLatestCheckpoint() {}, _saveCheckpoint() {}, _clearCheckpoints() {},
  };
  const phase1Prototype: RequirementRecord = { _shouldGenerateOpening() { return true; } };
  disposers.push(installPrdProductionBridge({ systemPrototype, productionPrototype, phase1Prototype,
    fusionPrototype: PromptFusionAgent.prototype,
    refinerPrototype: load("engines/production-engine/agents/field-content-refiner.js", "FieldContentRefiner").prototype,
    costumePrototype: load("engines/character-system/character-costume-prompter.js", "CharacterCostumePrompter").prototype,
    fieldGuardPrototype: load("engines/field-guard.js", "FieldGuard").prototype,
    qualityGatePrototype: load("engines/production-engine/utils/quality-gate.js", "QualityGate").prototype,
    deliveryGuardPrototype: load("engines/production-engine/agents/prompt-delivery-guard.js", "PromptDeliveryGuard").prototype,
    semanticPrototype: load("engines/production-engine/agents/semantic-refinement-pass.js", "SemanticRefinementPass").prototype,
    fieldConsistencyPrototype: load("engines/field-consistency-checker.js", "FieldConsistencyChecker").prototype,
    ruleCheckPrototype: RuleChecker.prototype,
    ruleRepairPrototype: load("engines/field-quality/field-repair-agent.js", "RuleRepairer").prototype,
    llmRepairPrototype: LLMRepairer.prototype, extractFieldRepairJson: extractJson,
    standardizeShot, validateShot, fields: CRITICAL_FIELDS,
  }));
  const system = new System() as unknown as RequirementRecord;
  const generator = requirementRecord(system.prdGenerator, "generator");
  for (const [key, payload] of [["agent2", value.creative], ["agent3", value.production]] as const) {
    const agent = requirementRecord(generator[key], key);
    agent._llmEngineLoaded = true;
    agent._llmEngine = { reasonStructured: async () => ({ success: true, data: structuredClone(payload) }) };
  }
  return (operation: (prd: RequirementRecord) => unknown) => withPrdAuthorityScope(value.authority, async () => {
    await invoke(system, "_confirmRequirementList", "synthetic G3 review", value.list);
    const prd = requirementRecord(await invoke(generator, "generate", value.discovery), "prd");
    await invoke(system, "_confirmPRD", invoke(generator, "generateMarkdown", prd), prd);
    await operation(prd);
    return { syntheticFixture: true };
  });
}

function shot(value: ReturnType<typeof prdFixture>, index = 0): RequirementRecord {
  return { shotId: value.contract.scenes[index]!.id, duration: 10,
    character_constraint: "命名主角仅合成人物，其他为全盔匿名成年对手骑手；禁止主角分身克隆。" };
}

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  for (const value of fixtures.splice(0)) value.cleanup();
  vi.restoreAllMocks();
});

describe("current reviewed moving rivals keep the unique lead identity", () => {
  it("the actual native per-shot Fusion system template distinguishes required anonymous riders", async () => {
    const value = raceFixture("RIVAL-FUSION"), accepted = nativeHarness(value);
    const fusion = new PromptFusionAgent({ semanticRefinement: false });
    const captured: string[] = [];
    fusion._callLLM = async function (this: RequirementRecord) {
      captured.push(String(invoke(this, "_getSystemPrompt")));
      throw new Error("SYNTHETIC_NATIVE_PROMPT_CAPTURE");
    };
    await accepted(async () => {
      await expect(invoke(fusion, "_fuseSingleShot", shot(value), "9:16", [], {})).rejects.toThrow("SYNTHETIC_NATIVE_PROMPT_CAPTURE");
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toContain("24. character_constraint: 角色约束(只出现指定角色,禁止分身)");
    expect(captured[0]).toContain("匿名成年对手骑手");
    expect(captured[0]).toContain("合成人物");
    expect(captured[0]).toContain("禁止主角分身或克隆");
    expect(String(invoke(new PromptFusionAgent({ semanticRefinement: false }), "_getSystemPrompt")))
      .toContain("24. character_constraint: 角色约束(只出现指定角色,禁止分身)");
  });

  it("the actual native format check accepts the scoped identity while retaining the no-clone requirement", async () => {
    const value = raceFixture("RIVAL-RULE"), accepted = nativeHarness(value), checker = new RuleChecker();
    await accepted(() => {
      const source = shot(value), before = structuredClone(source);
      const issues = invoke(checker, "_checkFormat", source) as RequirementRecord[];
      expect(issues.filter(issue => issue.fieldEn === "character_constraint")).toEqual([]);
      expect(source).toEqual(before);
      const noCloneMissing = { ...source, character_constraint: "命名主角仅合成人物，其他为全盔匿名成年对手骑手。" };
      const remaining = (invoke(checker, "_checkFormat", noCloneMissing) as RequirementRecord[])
        .filter(issue => issue.fieldEn === "character_constraint");
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.description).toContain("禁止分身声明");
      expect(remaining[0]!.description).not.toContain("单角色限制");
    });
  });

  it("the same native scope recognizes a bound motorcycle action that explicitly 连超 its rival", async () => {
    const value = raceFixture("RIVAL-ACTUAL-SOURCE-VERB");
    const opening = requirementRecord(requirementRecord(value.discovery.sceneStructure, "structure").opening, "opening");
    (requirementRecord(opening.productionContract, "contract").actions as RequirementRecord[])[0]!.description =
      "合成人物在最后一弯重刹切入内线，车身压低贴弯连超第二辆对手车，随后前轮先压过终点线";
    refreshSource(value);
    const accepted = nativeHarness(value), checker = new RuleChecker();
    await accepted(() => {
      const issues = invoke(checker, "_checkFormat", shot(value)) as RequirementRecord[];
      expect(issues.filter(issue => issue.fieldEn === "character_constraint")).toEqual([]);
    });
  });

  it("the actual native repair replaces only its owned field rule, retaining input quotations and native options", async () => {
    const value = raceFixture("RIVAL-REPAIR"), accepted = nativeHarness(value), captured: Array<{ prompt: string; options: unknown }> = [];
    const source = shot(value), nativeHint = ` - character_constraint：${FIELD_REQUIREMENTS.character_constraint}`;
    const engine = { reason: vi.fn(async (prompt: string, options: unknown) => {
      captured.push({ prompt, options });
      return { success: true, content: JSON.stringify({ repaired_fields: { character_constraint: source.character_constraint } }) };
    }) };
    const repairer = new LLMRepairer(engine, 1000, { temperature: 0.31 });
    const prd = { toConstraintText: () => `原始输入引述保留\n${nativeHint}\n原始输入结束` };
    const issue = { fieldEn: "character_constraint", fieldCn: "角色约束", severity: "major", issueType: "inconsistent",
      description: "保持命名主角与必要对手骑手的身份区分", suggestion: "保留对手驾驶员", currentValue: source.character_constraint };
    await accepted(() => invoke(repairer, "_repairBatch", source, [issue], ["character_constraint"], prd, 1000, 1, 1));
    expect(captured).toHaveLength(1);
    const [owned] = captured[0]!.prompt.split("【字段格式硬约束】（修复后必须逐项满足，机器将按此复检）\n").slice(1);
    expect(owned!.split("\n\n【检查发现的问题】")[0]).not.toContain(FIELD_REQUIREMENTS.character_constraint);
    expect(owned!.split("\n\n【检查发现的问题】")[0]).toContain("匿名成年对手骑手");
    expect(captured[0]!.prompt).toContain(prd.toConstraintText());
    expect(captured[0]!.options).toMatchObject({ temperature: 0.31 });
    expect(engine.reason).toHaveBeenCalledTimes(1);
  });

  it("the native production authority qualifies only its own named-cast rule for the same moving-rival shot", async () => {
    const value = raceFixture("RIVAL-AUTHORITY");
    const nativeOwned = "\n客户受众原文是权威口径；模型年龄/性别细分仅为推测。只使用合同内人物，characterId 必须等于所选 id，姓名一致。";
    requirementRecord(value.metadata.brief, "brief").description += `${nativeOwned}人物档案是人物表达依据，不能当成商品事实；`;
    refreshSource(value);
    const accepted = nativeHarness(value);
    const fusion = new PromptFusionAgent({ semanticRefinement: false });
    const captured: string[] = [];
    let lateVerify: (() => void) | undefined;
    fusion._callLLM = async function (this: RequirementRecord, prompt: string) {
      const input = productionModelInput(`${String(invoke(this, "_getSystemPrompt"))}\n\n${prompt}`);
      input.verify();
      lateVerify = input.verify;
      captured.push(input.prompt);
      expect(await withPrdAuthorityScope(undefined, () => productionModelInput(nativeOwned).prompt)).toBe(nativeOwned);
      throw new Error("SYNTHETIC_NATIVE_PROMPT_CAPTURE");
    };
    await accepted(async prd => {
      const before = structuredClone(prd);
      await expect(invoke(fusion, "_fuseSingleShot", shot(value), "9:16", [], {})).rejects.toThrow("SYNTHETIC_NATIVE_PROMPT_CAPTURE");
      expect(prd).toEqual(before);
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toContain(nativeOwned);
    expect(captured[0]).toContain("只使用合同内命名人物身份");
    expect(captured[0]).toContain(JSON.stringify(value.metadata.brief));
    expect(productionModelInput(nativeOwned).prompt).toBe(nativeOwned);
    expect(lateVerify).toBeTypeOf("function");
    expect(() => lateVerify!()).toThrow("PRD_SCOPE_CLOSED");
  });

  it.each(["ending", "wrong-id", "wrong-duration", "G4-no-moving-rival", "G4-negated-rival", "G3-no-moving-rival", "owner-no-race", "no-frozen-contract", "speech-unspecified"])(
    "native rule and repair stay unchanged outside the current per-shot prerequisite %s", async mode => {
      const value = raceFixture(`RIVAL-BOUNDARY-${mode}`), current = shot(value, mode === "ending" ? 2 : 0);
      if (mode === "wrong-id") current.shotId = "not-this-reviewed-shot";
      if (mode === "wrong-duration") current.duration = 8;
      if (mode === "G4-no-moving-rival" || mode === "G4-negated-rival") {
        const note = mode === "G4-no-moving-rival" ? "合成人物停在展台旁观察静态摩托车" : "对手车不可高速行驶或超车";
        Object.assign(value.production.scenePlan.scenes[0]!, { purpose: note, visualRequirements: [note] });
      }
      if (mode === "G3-no-moving-rival") {
        const node = requirementRecord(requirementRecord(value.discovery.sceneStructure, "structure").opening, "opening");
        (requirementRecord(node.productionContract, "contract").actions as RequirementRecord[])[0]!.description = "合成人物停在展示摩托车旁";
      }
      const brief = requirementRecord(value.metadata.brief, "brief");
      if (mode === "owner-no-race") {
        const cuts = requirementRecord(brief.segmentContract, "cuts");
        for (const interval of cuts.intervals as RequirementRecord[]) interval.brief = "主角观察赛道旁的静止对手车陈设，禁止超车。";
      }
      if (mode === "no-frozen-contract") delete brief.segmentContract;
      if (mode === "speech-unspecified") delete requirementRecord(brief.productionRequirements, "requirements").speechPolicy;
      refreshSource(value);
      const accepted = nativeHarness(value), checker = new RuleChecker(), captures: string[] = [];
      const repairer = new LLMRepairer({ reason: async (prompt: string) => {
        captures.push(prompt);
        return { success: true, content: JSON.stringify({ repaired_fields: {} }) };
      } });
      const before = structuredClone(current);
      await accepted(async () => {
        const issues = (invoke(checker, "_checkFormat", current) as RequirementRecord[]).filter(issue => issue.fieldEn === "character_constraint");
        expect(issues).toHaveLength(1);
        expect(issues[0]!.description).toContain("单角色限制");
        await invoke(repairer, "_repairBatch", current, issues, ["character_constraint"], null, 1000, 1, 1);
      });
      expect(captures).toHaveLength(1);
      expect(captures[0]).toContain(` - character_constraint：${FIELD_REQUIREMENTS.character_constraint}`);
      expect(current).toEqual(before);
    },
  );

  it.each([
    "命名主角仅其他人，其他为全盔匿名成年对手骑手；合成人物仅在档案内；禁止主角分身克隆。",
    "命名主角仅合成人物，其他为全盔成年对手骑手；禁止主角分身克隆。",
    "命名主角仅合成人物，其他为匿名成年对手骑手；禁止主角分身克隆。",
    "命名主角仅合成人物，其他为全盔匿名对手骑手；禁止主角分身克隆。",
    "命名主角仅合成人物，其他为全盔匿名成年对手骑手；允许主角分身克隆。",
    "主角为合成人物和其他具名人物，其他为全盔匿名成年对手骑手；禁止主角分身克隆。",
  ])("the scoped native format check retains an unresolved identity or clone issue for %s", async characterConstraint => {
    const value = raceFixture("RIVAL-IDENTITY-CONTROL"), accepted = nativeHarness(value), checker = new RuleChecker();
    await accepted(() => {
      const issues = invoke(checker, "_checkFormat", { ...shot(value), character_constraint: characterConstraint }) as RequirementRecord[];
      const relevant = issues.filter(issue => issue.fieldEn === "character_constraint");
      expect(relevant).toHaveLength(1);
      expect(relevant[0]!.suggestion).toContain("匿名成年对手骑手");
      expect(relevant[0]!.suggestion).not.toContain("禁止其他人物入镜");
    });
  });

  it("pinned owned-template drift fails before it can be used as a substitute source rule", () => {
    const scope = { leadId: "builtin-person", leadName: "合成人物" };
    expect(() => bindRivalFusionIdentity("changed native system", scope)).toThrow("PRD_VENDOR_UNAVAILABLE");
    expect(() => bindRivalRepairIdentity("changed native repair", scope)).toThrow("PRD_VENDOR_UNAVAILABLE");
    expect(() => bindRivalAuthorityIdentity("changed host authority")).toThrow("PRD_VENDOR_UNAVAILABLE");
  });

  it("interleaved native shots retain distinct identity semantics across an awaited request boundary", async () => {
    const value = raceFixture("RIVAL-INTERLEAVED"), accepted = nativeHarness(value);
    const fusion = new PromptFusionAgent({ semanticRefinement: false });
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    let arrived = 0;
    const captured: Array<{ opening: boolean; system: string; authority: string }> = [];
    fusion._callLLM = async function (this: RequirementRecord, prompt: string) {
      if (++arrived === 2) release();
      await ready;
      captured.push({ opening: prompt.includes("镜头:\nopening(10s)"),
        system: String(invoke(this, "_getSystemPrompt")), authority: productionModelInput(prompt).prompt });
      throw new Error("SYNTHETIC_NATIVE_PROMPT_CAPTURE");
    };
    await accepted(async () => {
      const results = await Promise.allSettled([0, 2].map(index => invoke(fusion, "_fuseSingleShot", shot(value, index), "9:16", [], {})));
      expect(results.every(result => result.status === "rejected" && String(result.reason).includes("SYNTHETIC_NATIVE_PROMPT_CAPTURE"))).toBe(true);
    });
    expect(captured).toHaveLength(2);
    for (const row of captured) {
      expect(row.system.includes("匿名成年对手骑手")).toBe(row.opening);
      expect(row.authority.includes("只使用合同内命名人物身份")).toBe(row.opening);
    }
  });
});
