import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindRequirementContract, requirementCast, requirementRecord, type RequirementContract, type RequirementRecord } from "./requirement-contract.js";
import { preparePrdAuthority } from "./prd-authority.js";
import { installPrdAuthorityBridge, installPrdProductionBridge, productionModelInput, withPrdAuthorityScope } from "./prd-authority-bridge.js";
import { PRDGenerator, PRDSchema, prdFixture } from "./prd-authority.test-support.js";
import { bindRivalAuthorityIdentity, bindRivalFusionIdentity, bindRivalRepairIdentity, rivalIdentityRequirement } from "./rival-identity-scope.js";

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
const FieldQualityPipeline = load("engines/field-quality/field-quality-pipeline.js", "FieldQualityPipeline");
const NativePRD = load("engines/field-quality/field-repair-agent.js", "PRD");
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
    fieldQualityPrototype: FieldQualityPipeline.prototype,
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

function fieldQualityShot(value: ReturnType<typeof prdFixture>, index = 0): RequirementRecord {
  const detail = "，保留本镜已审的场地与动作细节";
  const complete = (prefix: string, minimum: number) => prefix
    + detail.repeat(Math.max(0, Math.ceil((minimum - prefix.length) / detail.length)));
  const fields = {
    director_instruction: complete("电影写实质感，真实自然光，紧张氛围，所有动作由实体人物完成", 80),
    constraint: "9:16画幅，1080p分辨率，30fps，MP4格式",
    baseline: complete("真实皮肤与服装材质，画面锐利清楚，保持电影级写实摄影", 30),
    scene: complete("虚构封闭赛道、路肩与远处看台可见，午后日光照亮沥青和真实轮胎痕迹", 120),
    lighting: complete("主光从右前方照入，色温5600K柔光漫射，左侧反光板补光保留脸部和护具层次", 150),
    camera_movement: complete("跟拍机位缓慢平移，速度0.5m/s，0至10秒由中全景起幅并保持完整车辆关系", 100),
    character: complete("合成人物为同一成年命名主角，面部和体型沿用本次档案，全盔下保持原有发型", 50),
    action: complete("合成人物驾驶摩托车从对手车后追近并完成完整超越，保持本次已审的动作与方向", 120),
    portraits: "/characters/fixture/portrait_v2.png",
    dialogue: "无台词。",
    negative: complete("no text, no watermark，禁止多余肢体与变形，车辆与防护服保持完整真实结构", 40),
    consistency: complete("合成人物面部、黑色长发和同一赛车防护服跨镜头保持一致", 30),
    composition: complete("中景居中构图，主体位置清楚，画面保留必要车辆与人物的空间关系", 100),
    color_palette: complete("主色为中性灰，辅助色来自现场环境，肤色自然，饱和度与对比度适中", 80),
    depth_of_field: complete("焦点落在主角与当前对手车，光圈f/5.6，前景与背景保留真实可见细节", 80),
    timeline: complete("T00:00-00:03 从后方接近对手车；T00:03-00:07 并排后完成整车领先；T00:07-00:10 保持当前方向与前后车位", 200),
    mood: "紧张专注，沉着克制，保持清晰动作",
    bright_constraint: "明亮光线充足，画面清晰可见，面部明亮无阴影",
    character_constraint: "只出现合成人物一人，禁止分身或克隆，保持命名身份一致",
    costume: "黑色赛车外套、灰色内搭、同色长裤与黑色赛车鞋，护肩护肘护膝完整，服装材质与护具保持一致",
    props: complete("无标识赛道摩托车、全盔与必要对手车辆，实体外观和位置连续", 25),
    pacing: complete("整体节奏清晰，开头接近，中段并排，高潮超越，结尾保持相对车位", 40),
    audio: complete("只保留原生引擎、轮胎摩擦和环境声，现场声场连续，无对白或配乐", 100),
    makeup: "同一黑色长发收在全盔内，面部妆容自然，真实皮肤纹理清楚",
    transition: "切镜过渡采用直接硬切，保留相同的行驶方向和车辆位置",
  };
  return { ...fields, fields: structuredClone(fields), shotId: value.contract.scenes[index]!.id,
    sceneType: index === 0 ? "opening" : index === 2 ? "ending" : "content", duration: 10, prompt: "synthetic native field-quality input" };
}

interface FieldQualityCapture { kind: "check" | "repair"; scoped: boolean; source: string; fields?: string[] }

function nativeFieldQualityCapture(captures: FieldQualityCapture[], beforeCheck?: (check: number) => Promise<void>) {
  const pipeline = new FieldQualityPipeline({ maxRounds: 2, checkerTimeout: 1000, repairerTimeout: 1000 });
  const checker = requirementRecord(requirementRecord(pipeline.checker, "checker").llmChecker, "native LLM checker");
  let checks = 0;
  checker.llm = { reason: async (prompt: string) => {
    checks++;
    await beforeCheck?.(checks);
    const input = productionModelInput(prompt); input.verify();
    captures.push({ kind: "check", scoped: input.prompt.includes("只使用合同内命名人物身份"), source: input.prompt });
    return { success: true, content: JSON.stringify({ issues: checks === 1 ? [{ field_en: "costume", field_cn: "服装",
      severity: "major", issue_type: "inconsistent", description: "本镜服装细节需要单独修复", suggestion: "只修服装字段" }] : [] }) };
  } };
  const repairer = requirementRecord(pipeline.repairer, "repairer");
  repairer.prd = new NativePRD({});
  requirementRecord(repairer.llmRepairer, "native LLM repairer").llm = { reason: async (prompt: string) => {
    const input = productionModelInput(prompt); input.verify();
    const snapshot = prompt.split("\n\n【需要修复的字段当前内容】\n")[1]!.split("\n\n【字符数预算限制】")[0]!;
    captures.push({ kind: "repair", scoped: input.prompt.includes("只使用合同内命名人物身份"), source: input.prompt,
      fields: Object.keys(JSON.parse(snapshot) as RequirementRecord) });
    return { success: true, content: JSON.stringify({ repaired_fields: {
      costume: "同一黑色赛车外套、灰色内搭、同色长裤与黑色赛车鞋，护肩护肘护膝完整，护具固定牢靠且保持连续",
    } }) };
  } };
  return pipeline;
}

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  for (const value of fixtures.splice(0)) value.cleanup();
  vi.restoreAllMocks();
});

describe("current reviewed moving rivals keep the unique lead identity", () => {
  it.each([0, 1])("the actual native FieldQuality run carries one reviewed rider identity through checking and costume-only repair for shot %i", async index => {
    const value = raceFixture(`RIVAL-NATIVE-FIELD-QUALITY-${index}`), accepted = nativeHarness(value);
    const captured: FieldQualityCapture[] = [];
    const pipeline = nativeFieldQualityCapture(captured), source = fieldQualityShot(value, index), before = structuredClone(source);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("OFFLINE_NETWORK_FORBIDDEN"); });
    await accepted(async () => {
      const result = requirementRecord(await invoke(pipeline, "run", source, String(source.shotId)), "native field-quality result");
      expect((result.reports as RequirementRecord[]).at(-1)!.passed).toBe(true);
    });
    expect(captured.map(row => row.kind)).toEqual(["check", "repair", "check"]);
    expect(captured.find(row => row.kind === "repair")!.fields).toEqual(["costume"]);
    expect(captured.map(row => row.scoped)).toEqual([true, true, true]);
    for (const row of captured) expect(row.source).toContain(JSON.stringify(value.metadata.brief));
    expect(source).toEqual(before);
    await expect(invoke(pipeline, "run", source, String(source.shotId))).rejects.toThrow("PRD_SCOPE_CONFLICT");
    expect(captured).toHaveLength(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["ending", "wrong-id", "wrong-duration", "unfrozen"])(
    "the actual native FieldQuality run retains the original authority outside the current rival shot %s", async mode => {
      const value = raceFixture(`RIVAL-NATIVE-FIELD-QUALITY-${mode}`);
      if (mode === "unfrozen") {
        delete requirementRecord(value.metadata.brief, "brief").segmentContract;
        refreshSource(value);
      }
      const accepted = nativeHarness(value), source = fieldQualityShot(value, mode === "ending" ? 2 : 0);
      if (mode === "wrong-id") source.shotId = "another-shot";
      if (mode === "wrong-duration") source.duration = 8;
      const captures: FieldQualityCapture[] = [], pipeline = nativeFieldQualityCapture(captures);
      await accepted(async () => { await invoke(pipeline, "run", source, String(source.shotId)); });
      expect(captures.map(row => row.kind)).toEqual(["check", "repair", "check"]);
      expect(captures.map(row => row.scoped)).toEqual([false, false, false]);
      expect(captures.find(row => row.kind === "repair")!.fields).toEqual(["costume"]);
    },
  );

  it("interleaved actual native FieldQuality runs keep the racing shot scope out of the ending", async () => {
    const value = raceFixture("RIVAL-NATIVE-FIELD-QUALITY-INTERLEAVED"), accepted = nativeHarness(value);
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    let arrivals = 0;
    const beforeCheck = async (check: number) => {
      if (check !== 1) return;
      if (++arrivals === 2) release();
      await ready;
    };
    const captures: FieldQualityCapture[][] = [[], []];
    const pipelines = captures.map(capture => nativeFieldQualityCapture(capture, beforeCheck));
    const sources = [fieldQualityShot(value), fieldQualityShot(value, 2)];
    await accepted(async () => {
      await Promise.all(pipelines.map((pipeline, index) => invoke(pipeline, "run", sources[index], String(sources[index]!.shotId))));
    });
    expect(captures[0]!.map(row => row.scoped)).toEqual([true, true, true]);
    expect(captures[1]!.map(row => row.scoped)).toEqual([false, false, false]);
    for (const capture of captures) expect(capture.map(row => row.kind)).toEqual(["check", "repair", "check"]);
  });

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

  it.each([
    "命名主角仅合成人物和张三",
    "合成人物和张三是唯一命名主角",
    "命名主角仅合成人物替身",
    "合成人物替身是唯一命名主角",
    "命名主角仅合成人物（builtin-person）和张三",
    "命名主角仅合成人物（foreign-person）",
    "命名主角仅合成人物；另一个具名角色为张三",
    "命名主角仅合成人物；另有合成人物替身参加",
  ])("the actual native identity issue survives a conflicting complete-name declaration: %s", async declaration => {
    const value = raceFixture("RIVAL-EXACT-NAME-REJECTION"), accepted = nativeHarness(value), checker = new RuleChecker();
    const current = { ...shot(value), character_constraint: `${declaration}，其他为全盔匿名成年对手骑手；禁止主角分身克隆。` };
    const before = structuredClone(current);
    const original = (invoke(checker, "_checkFormat", current) as RequirementRecord[])
      .filter(issue => issue.fieldEn === "character_constraint");
    expect(original).toHaveLength(1);
    expect(original[0]!.description).toContain("单角色限制");
    await accepted(() => {
      const remaining = (invoke(checker, "_checkFormat", current) as RequirementRecord[])
        .filter(issue => issue.fieldEn === "character_constraint");
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.description).toContain("命名主角身份与必要对手骑手区分");
      expect(current).toEqual(before);
    });
  });

  it.each([
    "命名主角仅合成人物",
    "命名主角仅合成人物（builtin-person）",
    "命名主角只有合成人物",
    "唯一命名主角为合成人物",
    "唯一具名主角是合成人物",
    "合成人物是唯一命名主角",
    "合成人物（builtin-person）为唯一具名主角",
    "“合成人物”（builtin-person）是唯一命名主角",
  ])("the actual native identity check keeps the same exact lead in either declaration order: %s", async declaration => {
    const value = raceFixture("RIVAL-EXACT-NAME-CONTROL"), accepted = nativeHarness(value), checker = new RuleChecker();
    const current = { ...shot(value), character_constraint: `${declaration}，其他为全盔匿名成年对手骑手；禁止主角分身克隆。` };
    const before = structuredClone(current);
    await accepted(() => {
      const issues = (invoke(checker, "_checkFormat", current) as RequirementRecord[])
        .filter(issue => issue.fieldEn === "character_constraint");
      expect(issues).toEqual([]);
      expect(current).toEqual(before);
    });
  });

  it.each(["匿名", "无名", "不具名"])("the native exact-name check keeps explicitly %s adult counterpart roles", async anonymous => {
    const value = raceFixture("RIVAL-EXACT-NAME-ANONYMOUS"), accepted = nativeHarness(value), checker = new RuleChecker();
    const current = { ...shot(value), character_constraint:
      `命名主角仅合成人物，其他${anonymous}角色为全盔成年对手骑手；禁止主角分身克隆。` };
    const before = structuredClone(current);
    await accepted(() => {
      const issues = (invoke(checker, "_checkFormat", current) as RequirementRecord[])
        .filter(issue => issue.fieldEn === "character_constraint");
      expect(issues).toEqual([]);
      expect(current).toEqual(before);
    });
  });

  it.each([false, true])("the actual native check retains the complete canonical host rule without hiding another named lead (%s)", async extraLead => {
    const value = raceFixture("RIVAL-CANONICAL-COMPLETE-IDENTITY"), accepted = nativeHarness(value), checker = new RuleChecker();
    const canonical = rivalIdentityRequirement({ leadName: "合成人物", leadId: "builtin-person" });
    const current = { ...shot(value), character_constraint: canonical + (extraLead ? "命名主角仅合成人物和张三。" : "") };
    const before = structuredClone(current);
    const original = (invoke(checker, "_checkFormat", current) as RequirementRecord[])
      .filter(issue => issue.fieldEn === "character_constraint");
    expect(original).toHaveLength(1);
    await accepted(() => {
      const relevant = (invoke(checker, "_checkFormat", current) as RequirementRecord[])
        .filter(issue => issue.fieldEn === "character_constraint");
      expect(relevant).toHaveLength(extraLead ? 1 : 0);
      expect(current).toEqual(before);
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

  it.each(["ending", "wrong-id", "wrong-duration", "G4-no-moving-rival", "G4-negated-rival", "G3-no-moving-rival", "owner-no-race", "no-frozen-contract", "speech-unspecified",
    "owner-driverless", "G3-driverless", "G4-driverless", "G4-negated-then-driverless"])(
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
      if (mode === "G3-driverless") {
        const node = requirementRecord(requirementRecord(value.discovery.sceneStructure, "structure").opening, "opening");
        (requirementRecord(node.productionContract, "contract").actions as RequirementRecord[])[0]!.description = "合成人物从无人驾驶对手车后高速追近并完成超车";
      }
      if (mode === "G4-driverless" || mode === "G4-negated-then-driverless") {
        value.production.scenePlan.scenes[0]!.visualRequirements.push(mode === "G4-driverless"
          ? "对手车为无人驾驶空车且在赛道高速行驶" : "禁止对手车无人驾驶且对手车无人驾驶");
      }
      const brief = requirementRecord(value.metadata.brief, "brief");
      if (mode === "owner-driverless") {
        (requirementRecord(brief.segmentContract, "cuts").intervals as RequirementRecord[])[0]!.brief = "在虚构封闭赛道追击无人驾驶对手车并完成超车";
      }
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

  it("an actual prohibition against driverless rivals keeps the normal anonymous-rider scope eligible", async () => {
    const value = raceFixture("RIVAL-DRIVERLESS-NEGATION");
    value.production.scenePlan.scenes[0]!.visualRequirements.push("对手车不得为无人驾驶空车；禁止对手车无驾驶员");
    const accepted = nativeHarness(value), checker = new RuleChecker();
    await accepted(() => {
      const issues = invoke(checker, "_checkFormat", shot(value)) as RequirementRecord[];
      expect(issues.filter(issue => issue.fieldEn === "character_constraint")).toEqual([]);
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
