/**
 * Per-run archived-portrait planning seam. The vendor still builds its original
 * plan; an explicitly configured runtime may then bind existing portrait bytes.
 * AsyncLocalStorage keeps concurrent projects from consuming each other's assets.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PortraitRuntimePlan, PortraitRuntime } from "./portrait-runtime.js";

type PlanRuntime = Pick<PortraitRuntime, "preparePlan">;
interface PlanScope {
  runtime: PlanRuntime | null | undefined;
  active: boolean;
}

const scopes = new AsyncLocalStorage<PlanScope>();

/** The operation must cover the complete vendor run, including awaited children. */
export async function withPortraitArchivePlan<T>(
  runtime: PlanRuntime | null | undefined,
  operation: () => T | Promise<T>
): Promise<T> {
  const scope: PlanScope = { runtime, active: true };
  return scopes.run(scope, async () => {
    try {
      return await operation();
    } finally {
      scope.active = false;
    }
  });
}

interface PortraitStudioPrototype {
  plan: (this: unknown, ...args: unknown[]) => PortraitRuntimePlan;
}

function vendorPrototype(): PortraitStudioPrototype {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const require = createRequire(import.meta.url);
  const candidates = [
    path.resolve(here, "../../../vendor/supermickey/hyperreality-system/engines/portrait-studio/index.js"),
    path.resolve(here, "../../../../vendor/supermickey/hyperreality-system/engines/portrait-studio/index.js")
  ];
  const entry = candidates.find((candidate) => {
    try { require.resolve(candidate); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") return false;
      throw error;
    }
  });
  if (!entry) throw new Error("PORTRAIT_ARCHIVE_PLAN_VENDOR_MISSING");
  const mod = require(entry) as { PortraitStudio?: { prototype?: PortraitStudioPrototype } };
  const prototype = mod.PortraitStudio?.prototype;
  if (!prototype || typeof prototype.plan !== "function") {
    throw new Error("PORTRAIT_ARCHIVE_PLAN_VENDOR_INVALID");
  }
  return prototype;
}

/** Install through installSharedBridge so concurrent runs share one prototype seam. */
export function installPortraitArchivePlanBridge(): () => void {
  const prototype = vendorPrototype();
  const original = prototype.plan;
  const bridged: PortraitStudioPrototype["plan"] = function (...args) {
    const plan = Reflect.apply(original, this, args) as PortraitRuntimePlan;
    const scope = scopes.getStore();
    if (typeof scope?.runtime?.preparePlan !== "function") return plan;
    if (!scope.active) throw new Error("PORTRAIT_ARCHIVE_PLAN_SCOPE_CLOSED");
    return scope.runtime.preparePlan(plan);
  };
  prototype.plan = bridged;
  let disposed = false;
  return () => {
    if (disposed) return;
    if (prototype.plan !== bridged) throw new Error("PORTRAIT_ARCHIVE_PLAN_BRIDGE_CHANGED");
    prototype.plan = original;
    disposed = true;
  };
}
