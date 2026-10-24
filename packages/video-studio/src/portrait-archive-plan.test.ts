import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installPortraitArchivePlanBridge, withPortraitArchivePlan } from "./portrait-archive-plan.js";
import type { PortraitRuntimePlan, PortraitRuntime } from "./portrait-runtime.js";
import { installSharedBridge, listSharedBridges } from "./vendor-compat.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const { PortraitStudio } = require(resolve(repoRoot,
  "vendor/supermickey/hyperreality-system/engines/portrait-studio/index.js")) as {
  PortraitStudio: {
    new (options?: Record<string, unknown>): { plan(context?: Record<string, unknown>): PortraitRuntimePlan };
    prototype: { plan(context?: Record<string, unknown>): PortraitRuntimePlan };
  };
};
const nativePlan = PortraitStudio.prototype.plan;
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  expect(PortraitStudio.prototype.plan).toBe(nativePlan);
});

function install() {
  const dispose = installSharedBridge("test-portrait-archive-plan", installPortraitArchivePlanBridge);
  disposers.push(dispose);
  return dispose;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
type PlanRuntime = Pick<PortraitRuntime, "preparePlan">;
function runtime(label: string): PlanRuntime {
  return { preparePlan: (plan) => ({ ...plan, archiveProject: label }) };
}

describe("archived portrait planning bridge", () => {
  it("keeps the real vendor plan and instance context unchanged without an archive hook", async () => {
    const portrait = new PortraitStudio({ mode: "auto", executor: "spec" });
    const context = { characters: [{ id: "hero", name: "主角", role: "protagonist", description: "原创人物" }] };
    const original = nativePlan.call(portrait, context);
    install();
    expect(portrait.plan(context)).toEqual(original);
    expect(await withPortraitArchivePlan({}, () => portrait.plan(context))).toEqual(original);
    expect(await withPortraitArchivePlan(null, () => portrait.plan(context))).toEqual(original);
  });

  it("runs the native planner before the runtime transforms a plan and preserves its receiver", async () => {
    const portrait = new PortraitStudio({ mode: "auto" });
    install();
    const hook = vi.fn(function (this: PlanRuntime, plan: PortraitRuntimePlan) {
      expect(this).toBe(archive);
      expect(plan.mode).toBe("auto");
      expect(plan.characterTasks).toHaveLength(1);
      expect(plan.characterTasks[0]?.characterId).toBe("hero");
      expect(plan.characterTasks[0]?.portraits).toBeInstanceOf(Array);
      return { ...plan, archiveProject: "A" };
    });
    const archive: PlanRuntime = { preparePlan: hook };
    const result = await withPortraitArchivePlan(archive, () => portrait.plan({
      characters: [{ id: "hero", name: "原创主角", role: "protagonist" }]
    }));
    expect(hook).toHaveBeenCalledTimes(1);
    expect(result.archiveProject).toBe("A");
  });

  it("isolates overlapping projects even when the later run finishes first", async () => {
    const portrait = new PortraitStudio();
    install();
    const ready = [deferred(), deferred()];
    const release = [deferred(), deferred()];
    const run = (index: number, label: string) => withPortraitArchivePlan(runtime(label), async () => {
      ready[index]!.resolve();
      await release[index]!.promise;
      return portrait.plan().archiveProject;
    });
    const a = run(0, "A"), b = run(1, "B");
    await Promise.all(ready.map((item) => item.promise));
    release[1]!.resolve();
    expect(await b).toBe("B");
    expect(portrait.plan().archiveProject).toBeUndefined();
    release[0]!.resolve();
    expect(await a).toBe("A");
    expect(portrait.plan().archiveProject).toBeUndefined();
  });

  it("nested and empty scopes restore their outer scope after failure", async () => {
    const portrait = new PortraitStudio();
    install();
    await withPortraitArchivePlan(runtime("outer"), async () => {
      expect(portrait.plan().archiveProject).toBe("outer");
      await expect(withPortraitArchivePlan(runtime("inner"), async () => {
        expect(portrait.plan().archiveProject).toBe("inner");
        throw new Error("inner failed");
      })).rejects.toThrow("inner failed");
      expect(portrait.plan().archiveProject).toBe("outer");
      expect(await withPortraitArchivePlan(null, () => portrait.plan().archiveProject)).toBeUndefined();
      expect(portrait.plan().archiveProject).toBe("outer");
    });
    expect(portrait.plan().archiveProject).toBeUndefined();
  });

  it("propagates the original planner error without consuming the archive and recovers next run", async () => {
    const portrait = new PortraitStudio();
    install();
    const hook = vi.fn((plan: PortraitRuntimePlan) => plan);
    await expect(withPortraitArchivePlan({ preparePlan: hook }, () =>
      portrait.plan.call({ _extractVisualStyle() { throw new Error("native failed"); } })
    )).rejects.toThrow("native failed");
    expect(hook).not.toHaveBeenCalled();
    expect(await withPortraitArchivePlan(runtime("next"), () => portrait.plan().archiveProject)).toBe("next");
  });

  it("propagates a failed archive hook and restores the caller's scope", async () => {
    const portrait = new PortraitStudio();
    install();
    await expect(withPortraitArchivePlan({ preparePlan() { throw new Error("archive mismatch"); } }, () => portrait.plan()))
      .rejects.toThrow("archive mismatch");
    expect(portrait.plan().archiveProject).toBeUndefined();
    expect(await withPortraitArchivePlan(runtime("recovered"), () => portrait.plan().archiveProject)).toBe("recovered");
  });

  it("rejects a detached late archive call after its run has closed", async () => {
    const portrait = new PortraitStudio();
    install();
    const release = deferred();
    let late!: Promise<PortraitRuntimePlan>;
    await withPortraitArchivePlan(runtime("closed"), () => {
      late = release.promise.then(() => portrait.plan());
    });
    release.resolve();
    await expect(late).rejects.toThrow("PORTRAIT_ARCHIVE_PLAN_SCOPE_CLOSED");
  });

  it("keeps the bridge for the remaining run and restores exactly once after all holders finish", async () => {
    const portrait = new PortraitStudio();
    const releaseA = install(), releaseB = install();
    const bridge = PortraitStudio.prototype.plan;
    expect(bridge).not.toBe(nativePlan);
    expect(listSharedBridges().find((entry) => entry.key === "test-portrait-archive-plan")?.refs).toBe(2);
    releaseA();
    releaseA();
    expect(PortraitStudio.prototype.plan).toBe(bridge);
    expect(await withPortraitArchivePlan(runtime("still-running"), () => portrait.plan().archiveProject)).toBe("still-running");
    releaseB();
    expect(PortraitStudio.prototype.plan).toBe(nativePlan);
    expect(listSharedBridges().some((entry) => entry.key === "test-portrait-archive-plan")).toBe(false);
  });
});
