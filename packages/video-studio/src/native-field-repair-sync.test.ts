import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import {
  bindRequirementContract, requirementCast, requirementRecord, type RequirementRecord,
} from "./requirement-contract.js";
import { preparePrdAuthority } from "./prd-authority.js";
import {
  installPrdAuthorityBridge, installPrdProductionBridge, withPrdAuthorityScope,
} from "./prd-authority-bridge.js";
import { PRDGenerator, PRDSchema, prdFixture } from "./prd-authority.test-support.js";
import { compilePromptShot, type PromptCompileShot } from "./prompt-compiler.js";

const require = createRequire(import.meta.url);
const nativeRoot = "../../../vendor/supermickey/hyperreality-system/";
type RecordConstructor = { new (...args: unknown[]): RequirementRecord; prototype: RequirementRecord };
const { LLMRepairer } = require(nativeRoot + "engines/field-quality/field-repair-agent.js") as {
  LLMRepairer: RecordConstructor;
};
const standardizer = require(nativeRoot + "engines/field-standardizer.js") as {
  standardizeShot: (shot: RequirementRecord) => RequirementRecord;
  validateShot: (shot: RequirementRecord) => RequirementRecord;
  CRITICAL_FIELDS: Parameters<typeof installPrdProductionBridge>[0]["fields"];
};
const { extractJson } = require(nativeRoot + "engines/field-quality/json-salvage.js") as {
  extractJson: (text: string) => unknown;
};
const fixtures: ReturnType<typeof prdFixture>[] = [];
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  vi.unstubAllGlobals();
});
const invoke = (owner: RequirementRecord, key: string, ...args: unknown[]) =>
  Reflect.apply(owner[key] as (...values: unknown[]) => unknown, owner, args);

/** Explicitly synthetic G3/G4 scope. The batch class, parser and compiler are pinned native code. */
function harness(frozen = true) {
  const fixture = prdFixture("OFFLINE-FIELD-SYNC", [10, 10, 10]);
  fixtures.push(fixture);
  const brief = requirementRecord(fixture.metadata.brief, "fixture brief");
  Object.assign(requirementRecord(brief.productionRequirements, "fixture delivery"), { speechPolicy: "none" });
  if (frozen) brief.segmentContract = { count: 3, totalSeconds: 30, secondsPerSegment: 10, hardCuts: true,
    intervals: [0, 1, 2].map(index => ({ startSec: index * 10, endSec: (index + 1) * 10, brief: `合成冻结段${index}` })) };
  fixture.list = bindRequirementContract({ keyPoints: [] }, fixture.discovery,
    requirementRecord(fixture.discovery.upstreamFields, "fixture upstream"), structuredClone(fixture.metadata),
    requirementCast(fixture.metadata).hash, "原始年轻消费者");
  fixture.authority = preparePrdAuthority({ metadata: fixture.metadata, marketing: fixture.marketing,
    workDir: fixture.workDir, projectId: fixture.scope.projectId });
  const generator = new PRDGenerator();
  for (const [key, payload] of [["agent2", fixture.creative], ["agent3", fixture.production]] as const) {
    const agent = requirementRecord(generator[key], key);
    agent._llmEngineLoaded = true;
    agent._llmEngine = { reasonStructured: async () => ({ success: true, data: structuredClone(payload) }) };
  }
  class SyntheticSystem {
    prdGenerator = generator;
    async _confirmRequirementList(_content: unknown, list: unknown) { return { approved: true, requirementList: list, fixtureOnly: true }; }
    _generateMinimalPRD() { throw new Error("OFFLINE_UNEXPECTED_FALLBACK"); }
    async _confirmPRD(_content: unknown, prd: unknown) { return { approved: true, prd, fixtureOnly: true }; }
    async create(operation: () => Promise<unknown>) { return operation(); }
    _optimizeOpeningTitle() { return { fixtureOnly: true }; }
    _generatePromptsReport() { return "OFFLINE_UNUSED_REPORT"; }
  }
  const systemPrototype = SyntheticSystem.prototype as unknown as RequirementRecord;
  disposers.push(installPrdAuthorityBridge(systemPrototype, PRDGenerator.prototype, PRDSchema));
  const fakePrototype = (keys: string[]) => Object.fromEntries(keys.map(key => [key, function (...args: unknown[]) {
    return { fixtureOnly: true, method: key, args };
  }]));
  const deps = {
    systemPrototype,
    productionPrototype: fakePrototype(["produce", "_loadLatestCheckpoint", "_saveCheckpoint", "_clearCheckpoints"]),
    phase1Prototype: fakePrototype(["_shouldGenerateOpening"]),
    refinerPrototype: fakePrototype(["_normalizeConstraint"]), costumePrototype: fakePrototype(["enhance"]),
    fieldGuardPrototype: fakePrototype(["normalizeAndValidate", "check", "assertOpeningFields"]),
    fusionPrototype: fakePrototype(["_loadSubCheckpoint", "_saveSubCheckpoint", "_clearSubCheckpoint"]),
    qualityGatePrototype: fakePrototype(["run"]), deliveryGuardPrototype: fakePrototype(["verify"]),
    semanticPrototype: fakePrototype(["_buildPrompt"]), llmRepairPrototype: LLMRepairer.prototype,
    extractFieldRepairJson: extractJson, ...standardizer, fields: standardizer.CRITICAL_FIELDS,
  };
  disposers.push(installPrdProductionBridge(deps));
  const system = new SyntheticSystem() as unknown as RequirementRecord;
  const accepted = (operation: () => Promise<unknown>) => withPrdAuthorityScope(fixture.authority, () => invoke(system, "create", async () => {
    await invoke(system, "_confirmRequirementList", "synthetic G3, fixture only", fixture.list);
    const prd = await invoke(generator, "generate", fixture.discovery) as RequirementRecord;
    const markdown = invoke(generator, "generateMarkdown", prd);
    await invoke(system, "_confirmPRD", markdown, prd);
    await operation();
    return { success: true, stages: { prdGeneration: { data: prd } } };
  }));
  const network = vi.fn(async () => { throw new Error("OFFLINE_NETWORK_FORBIDDEN"); });
  vi.stubGlobal("fetch", network);
  return { accepted, network };
}

function shot(): RequirementRecord {
  return { shotId: "opening", sceneType: "opening", duration: 10,
    character_constraint: "同一命名主角，禁止分身", characterConstraint: "同一命名主角，禁止分身",
    costume: "同一套完整防护服", mood: "专注", fields: {
      character_constraint: "同一命名主角，禁止分身", characterConstraint: "同一命名主角，禁止分身",
      costume: "同一套完整防护服", mood: "专注",
    } };
}
const repairedText = "保持同一命名主角身份，必要匿名全盔骑手独立驾驶，禁止分身";
function repairer(replies: unknown[]) {
  const reason = vi.fn(async () => ({ success: true, content: JSON.stringify({ repaired_fields: replies.shift() ?? {} }) }));
  return { repairer: new LLMRepairer({ reason }), reason };
}
async function batch(repair: RequirementRecord, source: RequirementRecord, fields: string[]) {
  return await invoke(repair, "_repairBatch", source, fields.map(fieldEn => ({ fieldEn, fieldCn: fieldEn,
    description: "synthetic current field conflict", suggestion: "repair this field only" })), fields, null, 2_000, 1, 1) as RequirementRecord;
}
function expectCurrentAliases(result: RequirementRecord, key: string, expected: unknown) {
  const final = requirementRecord(result.repaired, "native result");
  const camel = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  expect(final[key]).toEqual(expected);
  if (Object.hasOwn(final, camel)) expect(final[camel]).toEqual(expected);
  const fields = requirementRecord(final.fields, "native nested");
  expect(fields[key]).toEqual(expected);
  if (Object.hasOwn(fields, camel)) expect(fields[camel]).toEqual(expected);
  return final;
}

describe("native successful field repair synchronization", () => {
  it("sends the native snake repair to every existing alias and the unchanged compiler", async () => {
    const h = harness(), source = shot(), before = structuredClone(source), native = repairer([{ character_constraint: repairedText }]);
    await h.accepted(async () => {
      const result = await batch(native.repairer, source, ["character_constraint"]);
      const final = expectCurrentAliases(result, "character_constraint", repairedText);
      const compiled = compilePromptShot(final as PromptCompileShot, { titleCard: false,
        delivery: { aspectRatio: "9:16", resolution: "1080p", fps: 30, format: "mp4", generateAudio: true },
        model: { modelId: "fixture-video", provider: "fixture", providerModel: "fixture", maxPromptChars: 3000,
          durationSec: { min: 1, max: 15 }, aspectRatios: ["9:16"], resolutions: ["1080p"], modes: ["text"], maxReferenceImages: 2 } });
      expect(compiled.fieldValues.character_constraint).toBe(repairedText);
      expect(compiled.contract.request.technical.character_constraint).toBe(repairedText);
      expect(final.mood).toBe(source.mood);
    });
    expect(source).toEqual(before);
    expect(h.network).not.toHaveBeenCalled();
  });

  it("normalizes an allowed camel response key without leaving its snake value stale", async () => {
    const h = harness(), native = repairer([{ characterConstraint: repairedText }]);
    await h.accepted(async () => { expectCurrentAliases(await batch(native.repairer, shot(), ["character_constraint"]), "character_constraint", repairedText); });
  });

  it("synchronizes a field without an underscore rather than retaining a top-level prior value", async () => {
    const h = harness(), native = repairer([{ costume: "完整防护服保持相同，左右护具与靴子完整" }]);
    await h.accepted(async () => { expectCurrentAliases(await batch(native.repairer, shot(), ["costume"]), "costume", "完整防护服保持相同，左右护具与靴子完整"); });
  });

  it("starts a subsequent batch from the same accepted field version", async () => {
    const h = harness(), second = repairedText + "，保持已有引用", native = repairer([{ character_constraint: repairedText }, { character_constraint: second }]);
    await h.accepted(async () => {
      const one = expectCurrentAliases(await batch(native.repairer, shot(), ["character_constraint"]), "character_constraint", repairedText);
      const two = await batch(native.repairer, one, ["character_constraint"]);
      expect((two.actions as RequirementRecord[])[0]!.before).toBe(repairedText);
      expectCurrentAliases(two, "character_constraint", second);
    });
    expect(native.reason).toHaveBeenCalledTimes(2);
  });

  it("rejects a native response that applied an unrequested known field", async () => {
    const h = harness(), native = repairer([{ character_constraint: repairedText, costume: "未获本批诊断许可的服装改动" }]);
    await expect(h.accepted(async () => { await batch(native.repairer, shot(), ["character_constraint"]); })).rejects.toThrow(/PRD_FIELD_REPAIR_SCOPE/);
  });

  it("rejects an unknown field accepted by the permissive native parser", async () => {
    const h = harness(), native = repairer([{ character_constraint: repairedText, another_character: "未声明人物" }]);
    await expect(h.accepted(async () => { await batch(native.repairer, shot(), ["character_constraint"]); })).rejects.toThrow(/PRD_FIELD_REPAIR_SCOPE/);
  });

  it("does not synthesize a repair for a no-op response", async () => {
    const h = harness(), source = shot(), native = repairer([{}]);
    await h.accepted(async () => {
      const result = await batch(native.repairer, source, ["character_constraint"]);
      expect(result.actions).toEqual([]); expect(result.repaired).toEqual(source);
    });
  });

  it("preserves a failed native batch and its original source", async () => {
    const h = harness(), source = shot(), before = structuredClone(source);
    const native = new LLMRepairer({ reason: async () => ({ success: false, error: "synthetic settled failure" }) });
    await h.accepted(async () => { expect(await batch(native, source, ["character_constraint"])).toEqual({ repaired: null, actions: [] }); });
    expect(source).toEqual(before);
  });

  it("preserves native alias behavior outside an authority scope", async () => {
    const h = harness(), source = shot(), native = repairer([{ character_constraint: repairedText }]);
    const result = await batch(native.repairer, source, ["character_constraint"]);
    const final = requirementRecord(result.repaired, "legacy result");
    expect(final.characterConstraint).toBe(repairedText);
    expect(requirementRecord(final.fields, "legacy fields").character_constraint).toBe(source.character_constraint);
    expect(h.network).not.toHaveBeenCalled();
  });

  it("preserves native behavior for an approved task without a frozen segment contract", async () => {
    const h = harness(false), source = shot(), native = repairer([{ character_constraint: repairedText }]);
    await h.accepted(async () => {
      const result = await batch(native.repairer, source, ["character_constraint"]);
      expect(requirementRecord(requirementRecord(result.repaired, "legacy result").fields, "legacy nested").character_constraint).toBe(source.character_constraint);
    });
  });
});
