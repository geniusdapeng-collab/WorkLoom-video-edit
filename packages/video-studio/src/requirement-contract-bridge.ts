import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import path from "node:path";
import {
  RequirementContractError, bindRequirementContract, renderRequirementContract, requirementCast,
  requirementRecord, requirementScenes, structuredSceneInstructions, structuredSceneSchema,
  validateRequirementSchema, verifiedRequirementContract, type RequirementCast, type RequirementRecord
} from "./requirement-contract.js";
import { acquireVendorRequirementEntry } from "./vendor-requirement-entry.js";

type Method = (this: RequirementRecord, ...args: unknown[]) => unknown;
interface Scope {
  metadata: RequirementRecord;
  cast?: RequirementCast;
  active: boolean;
}
const scopes = new AsyncLocalStorage<Scope>();

/** The immutable authority belongs to this awaited Studio run, including its discovery agents. */
export async function withRequirementContractScope<T>(
  metadata: RequirementRecord, operation: () => T | Promise<T>
): Promise<T> {
  const scope: Scope = { metadata: structuredClone(metadata), active: true };
  return scopes.run(scope, async () => {
    try { return await operation(); }
    finally { scope.active = false; }
  });
}

function currentScope(): Scope | undefined {
  const scope = scopes.getStore();
  if (scope && !scope.active) throw new RequirementContractError("REQUIREMENT_SCOPE_CLOSED", "运行结束后不能继续消耗需求合同");
  return scope;
}
function scopeCast(scope: Scope): RequirementCast {
  return scope.cast ??= requirementCast(scope.metadata);
}
function audience(scope: Scope): unknown {
  return scope.metadata.brief && requirementRecord(scope.metadata.brief, "Brief").audience;
}
function method(owner: RequirementRecord, key: string): Method {
  const value = owner[key];
  if (typeof value !== "function") throw new RequirementContractError("REQUIREMENT_VENDOR_UNAVAILABLE", `vendor 缺少 ${key}`);
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (descriptor && descriptor.writable === false && !descriptor.set) {
    throw new RequirementContractError("REQUIREMENT_VENDOR_UNAVAILABLE", `vendor ${key} 不可安装兼容桥`);
  }
  return value as Method;
}

interface Change { owner: RequirementRecord; key: string; original: Method; patched: Method }
interface Installed { changes: Change[] }
const active = new WeakMap<object, Installed>();
const nativeIdentities = new WeakMap<object, Array<{ owner: RequirementRecord; key: string; original: Method }>>();

export function assertRequirementContractBridge(vendorPrototype: object): void {
  const state = active.get(vendorPrototype);
  if (!state || state.changes.some(change => change.owner[change.key] !== change.patched)) {
    throw new RequirementContractError("REQUIREMENT_BRIDGE_CHANGED", "需求合同桥身份发生变化");
  }
}

/** Pure dependency seam for isolated fixtures; production supplies the exact cached vendor prototypes. */
export function installRequirementContractBridge(
  vendorPrototype: RequirementRecord, discoveryPrototype: RequirementRecord
): () => void {
  if (active.has(vendorPrototype)) throw new RequirementContractError("REQUIREMENT_BRIDGE_ACTIVE", "需求合同桥应通过共享引用计数安装");
  const previous = nativeIdentities.get(vendorPrototype);
  if (previous?.some(change => change.owner[change.key] !== change.original)) {
    throw new RequirementContractError("REQUIREMENT_BRIDGE_CHANGED", "原始 vendor 方法与首次受控身份不一致");
  }
  const convert = method(vendorPrototype, "_convertDiscoveryToRequirementList");
  const render = method(vendorPrototype, "_renderRequirementContract");
  const discover = method(discoveryPrototype, "discover");
  const fast = method(discoveryPrototype, "_fastMode");
  const markdown = method(discoveryPrototype, "generateMarkdown");
  const changes: Change[] = [];

  const converted: Method = async function (discovery, upstream, metadata) {
    const scope = currentScope();
    const expectedCast = scope ? scopeCast(scope).hash : undefined;
    const ownerAudience = scope ? audience(scope) : undefined;
    if (scope && requirementCast(requirementRecord(metadata, "转换 metadata")).hash !== expectedCast) {
      throw new RequirementContractError("REQUIREMENT_CAST_CHANGED", "转换前人物合同与本次宿主选择不一致");
    }
    // The controlled caller really awaits this result; original profile generation is not replaced.
    const original = await Reflect.apply(convert, this, [discovery, upstream]);
    if (!scope) return original;
    if (currentScope() !== scope) throw new RequirementContractError("REQUIREMENT_SCOPE_CLOSED", "转换结束时运行作用域已经关闭");
    return bindRequirementContract(original, discovery, upstream, metadata, expectedCast!,
      typeof ownerAudience === "string" && ownerAudience.trim() ? ownerAudience : null);
  };
  const rendered: Method = function (intent, metadata, list, discovery) {
    const scope = currentScope();
    if (!scope) return Reflect.apply(render, this, [intent, metadata, list, discovery]);
    const contract = verifiedRequirementContract(list, metadata, discovery);
    if (contract.cast.hash !== scopeCast(scope).hash) throw new RequirementContractError("REQUIREMENT_CAST_CHANGED", "G3 使用了另一运行的人物合同");
    const ownerAudience = audience(scope);
    if (contract.ownerAudience !== (typeof ownerAudience === "string" && ownerAudience.trim() ? ownerAudience : null)) {
      throw new RequirementContractError("REQUIREMENT_AUDIENCE_CHANGED", "G3 与本次宿主冻结的客户受众口径不一致");
    }
    return renderRequirementContract(contract, requirementRecord(metadata, "G3 metadata"));
  };
  const discovered: Method = async function (input) {
    const scope = currentScope();
    if (!scope) return Reflect.apply(discover, this, [input]);
    const cast = scopeCast(scope);
    const agents = requirementRecord(this.agents, "需求洞察 agents");
    const requireActiveScope = () => {
      if (currentScope() !== scope) throw new RequirementContractError("REQUIREMENT_SCOPE_CLOSED", "需求洞察不能在运行结束后继续调用模型");
    };
    const guardedAgents = Object.fromEntries(Object.entries(agents).map(([name, value]) => {
      const agent = requirementRecord(value, `洞察 agent ${name}`);
      const call = method(agent, "_callLLM"), fallback = method(agent, "_fallback");
      const view = Object.create(agent) as RequirementRecord;
      view._callLLM = function (this: RequirementRecord, ...args: unknown[]) {
        requireActiveScope();
        return Reflect.apply(call, this, args);
      };
      view._fallback = function (this: RequirementRecord, ...args: unknown[]) {
        requireActiveScope();
        return Reflect.apply(fallback, this, args);
      };
      return [name, view];
    }));
    const scene = requirementRecord(guardedAgents.scene, "SceneArchitect");
    const build = method(scene, "_buildPrompt"), run = method(scene, "run");
    method(scene, "_validateAndFill");
    // Each run gets its own engine/agent view. No global or shared agent carries project metadata.
    const sceneView = Object.create(scene) as RequirementRecord;
    sceneView._buildPrompt = function (this: RequirementRecord, value: unknown) {
      requireActiveScope();
      const original = Reflect.apply(build, this, [value]);
      if (typeof original !== "string") throw new RequirementContractError("REQUIREMENT_VENDOR_UNAVAILABLE", "SceneArchitect prompt 不是文本");
      return original + structuredSceneInstructions(cast, audience(scope));
    };
    sceneView.run = function (this: RequirementRecord, value: unknown, schema: unknown) {
      requireActiveScope();
      return Reflect.apply(run, this, [value, structuredSceneSchema(schema)]);
    };
    sceneView._validateAndFill = function (this: RequirementRecord, value: unknown, schema: unknown) {
      requireActiveScope();
      // Validate the real response before vendor fallback can invent missing fields.
      const upstream = requirementRecord(input, "SceneArchitect 上游输入");
      validateRequirementSchema(value, schema);
      requirementScenes(value, cast, upstream.duration_sec);
      // The existing vendor defaults bridge evaluates _fallback eagerly even for
      // complete required objects. A strict contract must not enter that path.
      return structuredClone(value);
    };
    sceneView._fallback = function () {
      requireActiveScope();
      throw new RequirementContractError("REQUIREMENT_SCENE_UNVERIFIED", "SceneArchitect 未提供完整真实结构，拒绝规则道具或动作回填");
    };
    const engineView = Object.create(this) as RequirementRecord;
    engineView.agents = { ...guardedAgents, scene: sceneView };
    const result = await Reflect.apply(discover, engineView, [input]);
    if (currentScope() !== scope) throw new RequirementContractError("REQUIREMENT_SCOPE_CLOSED", "需求洞察结束时运行作用域已经关闭");
    const record = requirementRecord(result, "实际需求洞察结果");
    requirementScenes(record.sceneStructure, cast, requirementRecord(input, "上游输入").duration_sec);
    return { ...record, audienceAuthority: audience(scope) ?? null, audienceProfileStatus: "model-hypothesis" };
  };
  const noFastFallback: Method = function (...args) {
    if (!currentScope()) return Reflect.apply(fast, this, args);
    throw new RequirementContractError("REQUIREMENT_DISCOVERY_UNVERIFIED", "本次需求洞察失败，不能用规则兜底冒充完整合同");
  };
  const renderedDiscovery: Method = function (...args) {
    const scope = currentScope();
    const original = Reflect.apply(markdown, this, args);
    if (!scope) return original;
    if (typeof original !== "string" || original.split("### 2.1 目标受众画像").length !== 2
      || original.split("**主要受众**").length !== 2) {
      throw new RequirementContractError("REQUIREMENT_VENDOR_UNAVAILABLE", "需求洞察的受众渲染口径发生变化");
    }
    const ownerAudience = audience(scope);
    return original.replace("### 2.1 目标受众画像", "### 2.1 模型受众细分假设（待审核）")
      .replace("**主要受众**", `**客户 Brief 权威受众原文**\n${typeof ownerAudience === "string" && ownerAudience.trim() ? ownerAudience : "客户未显式指定"}\n\n**模型细分推测（不覆盖客户口径，不是已核实人群事实）**`);
  };
  changes.push(
    { owner: vendorPrototype, key: "_convertDiscoveryToRequirementList", original: convert, patched: converted },
    { owner: vendorPrototype, key: "_renderRequirementContract", original: render, patched: rendered },
    { owner: discoveryPrototype, key: "discover", original: discover, patched: discovered },
    { owner: discoveryPrototype, key: "_fastMode", original: fast, patched: noFastFallback },
    { owner: discoveryPrototype, key: "generateMarkdown", original: markdown, patched: renderedDiscovery }
  );
  const installed: Change[] = [];
  try {
    for (const change of changes) {
      change.owner[change.key] = change.patched;
      installed.push(change);
    }
  } catch (error) {
    for (const change of installed.reverse()) if (change.owner[change.key] === change.patched) change.owner[change.key] = change.original;
    throw error;
  }
  nativeIdentities.set(vendorPrototype, changes.map(({ owner, key, original }) => ({ owner, key, original })));
  active.set(vendorPrototype, { changes });
  let disposed = false;
  return () => {
    if (disposed) return;
    assertRequirementContractBridge(vendorPrototype);
    for (const change of [...changes].reverse()) change.owner[change.key] = change.original;
    active.delete(vendorPrototype);
    disposed = true;
  };
}

/** Called only after the pinned entry has been installed in the shared CJS cache. */
export function installVendorRequirementContractBridge(
  constructor: { prototype: object }, entryPath: string
): () => void {
  const lease = acquireVendorRequirementEntry(entryPath);
  try {
    if (lease.exports.HyperrealitySystem !== (constructor as unknown)) {
      throw new RequirementContractError("REQUIREMENT_BRIDGE_CHANGED", "需求合同桥与受控入口的 constructor 不一致");
    }
    const require = createRequire(lease.identity.entryPath);
    const mod = require(path.join(path.dirname(lease.identity.entryPath), "engines/requirement-discovery-engine.js")) as {
      RequirementDiscoveryEngine?: { prototype?: RequirementRecord };
    };
    if (!mod.RequirementDiscoveryEngine?.prototype) {
      throw new RequirementContractError("REQUIREMENT_VENDOR_UNAVAILABLE", "缺少实际需求洞察引擎");
    }
    return installRequirementContractBridge(requirementRecord(constructor.prototype, "受控 vendor prototype"), mod.RequirementDiscoveryEngine.prototype);
  } finally {
    lease.release();
  }
}
