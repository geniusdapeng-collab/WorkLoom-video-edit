import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkloomLLMEngine } from "./llm-adapter.js";
import type { PortraitIndex, PortraitInputReceipt, PortraitRuntime } from "./portrait-runtime.js";
import { VideoStudio } from "./studio.js";

const state = vi.hoisted(() => ({
  runtime: null as PortraitRuntime | null,
  create: vi.fn()
}));
vi.mock("node:module", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:module")>();
  return {
    ...original,
    createRequire: (url: string | URL) => {
      const require = original.createRequire(url);
      return new Proxy(require, {
        apply(target, thisArg, args: [string]) {
          if (args[0].endsWith("/vendor/supermickey/hyperreality-system/index.js")) {
            return { HyperrealitySystem: class { create(...input: unknown[]) { return state.create(...input); } } };
          }
          return Reflect.apply(target, thisArg, args);
        }
      });
    }
  };
});
vi.mock("./portrait-runtime.js", () => ({
  createPortraitRuntime: () => {
    if (!state.runtime) throw new Error("test runtime not configured");
    return state.runtime;
  }
}));
vi.mock("./vendor-compat.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./vendor-compat.js")>();
  const noop = () => () => undefined;
  return {
    ...original,
    applyDurationPolicyToManager: () => undefined,
    installVendorConfigIsolatorBridge: noop,
    installVendorPhaseDiagnosticsBridge: noop,
    installVendorFieldQualityBridge: noop,
    installVendorMicroMotionBridge: noop,
    installVendorContractBridge: noop,
    installVendorPromptRebuildBridge: noop,
    installVendorDiscoveryFixBridge: noop,
    installVendorPhaseInternalsDiagnostics: noop,
    installVendorAudioDisciplineBridge: noop,
    installVendorDurationPolicyBridge: noop,
    installVendorDurationProjectionBridge: noop
  };
});
vi.mock("./duration-rules.js", () => ({
  loadDurationRules: () => ({ modelMin: 4, modelMax: 30, sources: [], nonLive: [], blockers: [], aligned: true })
}));

const temporary: string[] = [];
beforeEach(() => { state.create.mockReset(); state.runtime = null; });
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wl-studio-reuse-count-"));
  temporary.push(dir);
  const artifact = (name: string, content: string | Buffer): PortraitInputReceipt => {
    const path = join(dir, name);
    writeFileSync(path, content);
    const bytes = readFileSync(path);
    return { path, realPath: realpathSync(path), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const profile = artifact("profile.json", JSON.stringify({ id: "test-archive", kind: "generated" }));
  const manifest = artifact("manifest.json", JSON.stringify({ projectId: "P1", version: 4 }));
  const entry: PortraitIndex["characters"][string] = {
    kind: "character", id: "hero", name: "原创人物", dir,
    files: {}, artifacts: {}, reuseReceipts: {}, portraitVersion: 4, pinnedVersion: 4
  };
  for (const [i, angle] of ["front", "threeQuarter", "closeup", "side"].entries()) {
    const bytes = Buffer.alloc(2048, i + 1);
    const source = artifact(`${angle}-source.jpg`, bytes);
    const output = artifact(`${angle}-output.jpg`, bytes);
    entry.files[angle] = output.path;
    entry.artifacts![angle] = output;
    entry.reuseReceipts![angle] = {
      schemaVersion: "workloom.portrait-reuse/v1", projectId: "P1", kind: "character", id: "hero", angle,
      archiveId: "test-archive", archiveName: "测试原创人物", version: 4,
      manifest: { path: manifest.path, sha256: manifest.sha256 },
      selectionReceipt: { schemaVersion: "workloom.portrait-reuse-selection/v1", rawIntent: "test fixture selection", selectedVersion: 4,
        expectedPortraits: 4, selectedAt: new Date().toISOString() },
      source, output, profile, copiedAt: new Date().toISOString(), generationCount: 0
    };
  }
  const index: PortraitIndex = { schemaVersion: "workloom.portrait-index/v1", projectId: "P1", generatedAt: new Date().toISOString(),
    characters: { hero: entry }, products: {} };
  state.runtime = {
    apiRender: vi.fn(async () => { throw new Error("unexpected paid path"); }),
    searchReferences: vi.fn(async () => []), processImage: vi.fn(async () => ""),
    snapshot: () => structuredClone(index), indexPath: () => join(dir, "portrait-index.json")
  };
  const run = () => new VideoStudio({
    llm: new WorkloomLLMEngine({ baseUrl: "https://example.invalid", apiKey: "test-only", model: "test" }),
    workDir: dir, log: () => undefined, onApproval: async () => ({ approved: true }),
    portraits: { apiKey: "test-only", model: "test" }
  }).runPreproduction({ projectId: "P1", intent: "test original character" });
  return { index, entry, run };
}

describe("VideoStudio reuse accounting from current bytes", () => {
  it("counts four verified copies and subtracts them from the real completed total", async () => {
    const { run } = fixture();
    const result = { success: true, stages: { portraitStudio: { status: "completed", completedPortraits: 5 } } };
    state.create.mockResolvedValue(result);
    expect(await run()).toBe(result);
    expect(result.stages.portraitStudio).toMatchObject({ completedPortraits: 5, reusedPortraits: 4, generatedPortraits: 1 });
    expect(state.runtime!.apiRender).not.toHaveBeenCalled();
  });

  it.each(["output", "source", "profile", "manifest"] as const)("rejects a changed %s instead of counting stale receipts", async (kind) => {
    const { entry, run } = fixture();
    const receipt = entry.reuseReceipts!.front!;
    writeFileSync(receipt[kind].path, "changed after vendor create");
    state.create.mockResolvedValue({ success: true, stages: { portraitStudio: { completedPortraits: 4 } } });
    await expect(run()).rejects.toThrow("PORTRAIT_REUSE_COUNT_INVALID");
  });

  it("rejects receipt evidence from a different project", async () => {
    const { entry, run } = fixture();
    entry.reuseReceipts!.front!.projectId = "OTHER";
    state.create.mockResolvedValue({ success: true, stages: { portraitStudio: { completedPortraits: 4 } } });
    await expect(run()).rejects.toThrow("PORTRAIT_REUSE_COUNT_INVALID");
  });

  it("cannot report more reused portraits than the vendor actually completed", async () => {
    const { run } = fixture();
    state.create.mockResolvedValue({ success: true, stages: { portraitStudio: { completedPortraits: 3 } } });
    await expect(run()).rejects.toThrow("PORTRAIT_REUSE_COUNT_INVALID");
  });
});
