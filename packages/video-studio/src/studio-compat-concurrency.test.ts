import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VideoStudio } from "./studio.js";
import { WorkloomLLMEngine } from "./llm-adapter.js";
import { listSharedBridges } from "./vendor-compat.js";

const runtime = vi.hoisted(() => ({ create: vi.fn() }));
// Only business execution is inert. Every compatibility installer and its real
// vendor prototype is the same code used by VideoStudio in production.
vi.mock("./vendor-requirement-entry.js", () => ({
  acquireVendorRequirementEntry: () => ({ exports: { HyperrealitySystem: class {
    requirementDiscoveryEngine = { agents: { scene: { timeoutMs: 1, maxRetries: 0 }, risk: { maxRetries: 0 } }, agentTimeoutMs: 0 };
    creativeThemeGenerator = { generate: async () => ({}) };
    prdGenerator = { generate: async () => ({}) };
    durationConstraintManager = {};
    create(intent: string) { return runtime.create(intent); }
  } }, identity: { entryPath: "/fixture/vendor/index.js" }, release: () => undefined }),
}));
vi.mock("./requirement-contract-bridge.js", () => ({
  assertRequirementContractBridge: () => undefined,
  installVendorRequirementContractBridge: () => () => undefined,
  withRequirementContractScope: (_metadata: unknown, operation: () => unknown) => operation(),
}));

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(resolve(root, "package.json"));
const vendor = "vendor/supermickey/hyperreality-system/";
const isolator = require(resolve(root, vendor, "utils/config-isolator.js")).ConfigIsolator;
const phase = require(resolve(root, vendor, "engines/production-engine/phases/phase-3-prompt-fusion.js")).Phase3PromptFusion.prototype;
const field = require(resolve(root, vendor, "engines/field-quality/field-quality-pipeline.js")).FieldQualityPipeline.prototype;
const micro = require(resolve(root, vendor, "engines/enhancers/micro-motion-adapter.js")).MicroMotionAdapter.prototype;
const validator = require(resolve(root, vendor, "engines/production-engine/utils/agent-contract-validator.js")).AgentContractValidator.prototype;
const fusion = require(resolve(root, vendor, "engines/production-engine/agents/prompt-fusion-agent.js")).PromptFusionAgent.prototype;
const engine = require(resolve(root, vendor, "engines/production-engine/production-engine.js")).ProductionEngine.prototype;
const snapshot = () => [isolator.isolate, phase.execute, field.run, micro._generateMicroMotion,
  validator.validate, fusion._assembleStandardPrompt, engine.produce, engine._normalizeDurations];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { runtime.create.mockReset(); vi.unstubAllGlobals(); });

describe("VideoStudio real compatibility prototype lifecycle", () => {
  it.each(["A", "B"] as const)("keeps all shared patches when %s finishes first and restores originals last", async (first) => {
    const network = vi.fn(async () => { throw new Error("Unexpected paid/network path"); });
    vi.stubGlobal("fetch", network);
    const before = snapshot(), ready = { A: deferred(), B: deferred() }, finish = { A: deferred(), B: deferred() };
    runtime.create.mockImplementation(async (id: "A" | "B") => {
      ready[id].resolve(); await finish[id].promise;
      return { success: true, stages: {} };
    });
    const start = (id: "A" | "B") => new VideoStudio({
      llm: new WorkloomLLMEngine({ baseUrl: "https://example.invalid", apiKey: "test-only", model: "deepseek-flash" }),
      workDir: "/unused/compat-lifecycle", onApproval: async () => ({ approved: true }), log: () => undefined,
    }).runPreproduction({ projectId: `project-${id}`, intent: id });
    const a = start("A"), b = start("B");
    try {
      await Promise.all([ready.A.promise, ready.B.promise]);
      const during = snapshot();
      during.forEach((method, index) => expect(method).not.toBe(before[index]));
      finish[first].resolve(); await (first === "A" ? a : b);
      expect(snapshot()).toEqual(during);
      const second = first === "A" ? "B" : "A";
      finish[second].resolve(); await (second === "A" ? a : b);
      expect(snapshot()).toEqual(before);
      expect(listSharedBridges()).toEqual([]);
      expect(network).not.toHaveBeenCalled();
    } finally {
      finish.A.resolve(); finish.B.resolve();
      await Promise.allSettled([a, b]);
    }
  });
});
