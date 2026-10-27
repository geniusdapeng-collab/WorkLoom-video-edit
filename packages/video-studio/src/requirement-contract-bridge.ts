import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import path from "node:path";
import {
  RequirementContractError, bindRequirementContract, renderRequirementContract, requirementCast,
  requirementHash, requirementRecord, requirementScenes, structuredRiskFeedback, structuredSceneFeedback, structuredSceneInstructions, structuredScenePrompt, structuredSceneSchema,
  validateRequirementSchema, verifiedRequirementContract, type RequirementCast, type RequirementRecord
} from "./requirement-contract.js";
import { acquireVendorRequirementEntry } from "./vendor-requirement-entry.js";
import {
  qualifyRequirementThemeInput, requirementAuthorityFailure, requirementAuthorityPrompt, scopedRequirementEngine,
  type RequirementAuthorityOptions
} from "./requirement-authority.js";
import type { PrdAuthority } from "./prd-authority.js";

type Method = (this: RequirementRecord, ...args: unknown[]) => unknown;
interface Scope {
  metadata: RequirementRecord;
  cast?: RequirementCast;
  active: boolean;
  fatal?: { error: unknown };
  authority?: PrdAuthority;
  authoritySource?: PrdAuthority;
  authorityHash?: string;
  options?: RequirementAuthorityOptions;
  optionsSource?: RequirementAuthorityOptions;
}
const scopes = new AsyncLocalStorage<Scope>();
const receivers = new WeakMap<object, Scope>();

function fatal(scope: Scope, error: unknown): never {
  if (!scope.authority) throw error;
  scope.fatal ??= { error };
  throw scope.fatal.error;
}
function guard<T>(scope: Scope, operation: () => T): T {
  try {
    if (!scope.active || scopes.getStore() !== scope) requirementAuthorityFailure("REQUIREMENT_SCOPE_CLOSED", "运行结束后不能继续消耗需求合同");
    if (scope.fatal) throw scope.fatal.error;
    if (scope.authoritySource && requirementHash(scope.authoritySource) !== scope.authorityHash) {
      requirementAuthorityFailure("REQUIREMENT_AUTHORITY_CHANGED", "宿主私有需求权威原件在本次运行中发生变化");
    }
    if (scope.optionsSource && (scope.optionsSource.approvedTheme !== scope.options!.approvedTheme
      || scope.optionsSource.validateAuthority !== scope.options!.validateAuthority)) {
      requirementAuthorityFailure("REQUIREMENT_AUTHORITY_CHANGED", "宿主私有校验或批准上下文入口发生变化");
    }
    return operation();
  } catch (error) { return fatal(scope, error); }
}
async function awaited<T>(scope: Scope, operation: () => T | Promise<T>): Promise<T> {
  try {
    guard(scope, () => undefined);
    const result = await operation();
    guard(scope, () => undefined);
    return result;
  } catch (error) { return fatal(scope, error); }
}

/** The immutable authority belongs to this awaited Studio run, including its discovery agents. */
export async function withRequirementContractScope<T>(
  metadata: RequirementRecord, operation: () => T | Promise<T>, options?: RequirementAuthorityOptions
): Promise<T> {
  const scope: Scope = { metadata: structuredClone(metadata), active: true,
    ...(options ? { authority: structuredClone(options.authority), authoritySource: options.authority,
      authorityHash: requirementHash(options.authority), options: Object.freeze({ ...options }), optionsSource: options } : {}) };
  return scopes.run(scope, async () => {
    try {
      if (scope.authority && requirementHash(scope.metadata) !== requirementHash(scope.authority.metadata)) {
        requirementAuthorityFailure("REQUIREMENT_AUTHORITY_CHANGED", "需求清单与宿主私有权威不属于同一输入快照");
      }
      return await awaited(scope, operation);
    }
    finally { scope.active = false; }
  });
}

function currentScope(): Scope | undefined {
  const scope = scopes.getStore();
  if (scope) guard(scope, () => undefined);
  return scope;
}
function receiverScope(receiver: object): Scope | undefined {
  const scope = currentScope(), bound = receivers.get(receiver);
  if (bound && bound !== scope) {
    return fatal(scope ?? bound, new RequirementContractError("REQUIREMENT_SCOPE_CONFLICT", "需求对象不能脱离其原运行作用域调用"));
  }
  return scope;
}
function bindReceiver(scope: Scope, receiver: object): void {
  if (!scope.authority) return;
  const bound = receivers.get(receiver);
  if (bound && bound !== scope) requirementAuthorityFailure("REQUIREMENT_SCOPE_CONFLICT", "需求对象已经属于另一运行");
  receivers.set(receiver, scope);
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

interface Change { owner: RequirementRecord; key: string; original: PropertyDescriptor; patched: Method }
interface Installed { changes: Change[] }
const active = new WeakMap<object, Installed>();
const nativeIdentities = new WeakMap<object, Array<{ owner: RequirementRecord; key: string; original: PropertyDescriptor }>>();
function sameDescriptor(a: PropertyDescriptor | undefined, b: PropertyDescriptor): boolean {
  return Boolean(a && a.value === b.value && a.writable === b.writable && a.configurable === b.configurable
    && a.enumerable === b.enumerable && a.get === b.get && a.set === b.set);
}

export function assertRequirementContractBridge(vendorPrototype: object): void {
  const state = active.get(vendorPrototype);
  if (!state || state.changes.some(change => !sameDescriptor(Object.getOwnPropertyDescriptor(change.owner, change.key),
    { ...change.original, value: change.patched }))) {
    throw new RequirementContractError("REQUIREMENT_BRIDGE_CHANGED", "需求合同桥身份发生变化");
  }
}

/** Pure dependency seam for isolated fixtures; production supplies the exact cached vendor prototypes. */
export function installRequirementContractBridge(
  vendorPrototype: RequirementRecord, discoveryPrototype: RequirementRecord, themePrototype?: RequirementRecord
): () => void {
  if (active.has(vendorPrototype)) throw new RequirementContractError("REQUIREMENT_BRIDGE_ACTIVE", "需求合同桥应通过共享引用计数安装");
  const previous = nativeIdentities.get(vendorPrototype);
  if (previous?.some(change => !sameDescriptor(Object.getOwnPropertyDescriptor(change.owner, change.key), change.original))) {
    throw new RequirementContractError("REQUIREMENT_BRIDGE_CHANGED", "原始 vendor 方法与首次受控身份不一致");
  }
  const convert = method(vendorPrototype, "_convertDiscoveryToRequirementList");
  const render = method(vendorPrototype, "_renderRequirementContract");
  const discover = method(discoveryPrototype, "discover");
  const fast = method(discoveryPrototype, "_fastMode");
  const markdown = method(discoveryPrototype, "generateMarkdown");
  const themeInput = themePrototype ? method(vendorPrototype, "_buildThemeInput") : undefined;
  const themeGenerate = themePrototype ? method(themePrototype, "generate") : undefined;
  const changes: Change[] = [];
  const check = (scope: Scope) => guard(scope, () => assertRequirementContractBridge(vendorPrototype));
  const protectModel = <T>(scope: Scope, operation: () => T): T => guard(scope, () => {
    check(scope);
    scope.options?.validateAuthority();
    return operation();
  });
  const promptContext = (scope: Scope): string => guard(scope, () => {
    if (!scope.authority) requirementAuthorityFailure("REQUIREMENT_AUTHORITY_REQUIRED", "缺少宿主私有需求权威");
    return requirementAuthorityPrompt(scope.authority, scope.options?.approvedTheme());
  });

  const qualifiedInput: Method = function (...args) {
    const scope = receiverScope(this);
    if (!scope?.authority) return Reflect.apply(themeInput!, this, args);
    return guard(scope, () => {
      check(scope); bindReceiver(scope, this);
      return qualifyRequirementThemeInput(Reflect.apply(themeInput!, this, args), args[0], args[1] ?? {});
    });
  };
  const themed: Method = async function (...args) {
    const scope = receiverScope(this);
    if (!scope?.authority) return Reflect.apply(themeGenerate!, this, args);
    return awaited(scope, async () => {
      check(scope); bindReceiver(scope, this);
      const view = Object.create(this) as RequirementRecord;
      const protect = <T>(operation: () => T) => protectModel(scope, operation);
      view.llmEngine = protect(() => scopedRequirementEngine(this.llmEngine, protect, () => promptContext(scope)));
      const extract = method(this, "_extractFieldsWithLLM");
      view._extractFieldsWithLLM = function (this: RequirementRecord, ...input: unknown[]) {
        // The native extraction/JSON retry remains in place. A swallowed failure is sticky.
        return awaited(scope, () => Reflect.apply(extract, this, input));
      };
      const resolver = requirementRecord(this.typeResolver, "原始主题动态类型解析器");
      const resolve = method(resolver, "resolve");
      method(resolver, "_fallbackConfig");
      const resolverView = Object.create(resolver) as RequirementRecord;
      resolverView.llmEngine = protect(() => scopedRequirementEngine(resolver.llmEngine, protect, () => promptContext(scope)));
      // This cache contains themes, input-specific descriptions/notes and audience,
      // keyed only by type. A private run cannot reuse a different run's creative input.
      // Only a dynamic type that would have hit that cache adds at most one dispatch.
      resolverView.cacheEnabled = false;
      resolverView.resolve = function (this: RequirementRecord, ...input: unknown[]) {
        return awaited(scope, () => Reflect.apply(resolve, this, input));
      };
      resolverView._fallbackConfig = function () {
        return guard(scope, () => requirementAuthorityFailure("REQUIREMENT_THEME_UNVERIFIED", "本次主题动态类型失败，拒绝规则主题回填"));
      };
      view.typeResolver = resolverView;
      const result = requirementRecord(await Reflect.apply(themeGenerate!, view, args), "真实主题生成结果");
      check(scope);
      if (!Array.isArray(result.tasks) || result.tasks.some(task => requirementRecord(task, "真实主题 task")._degraded)) {
        requirementAuthorityFailure("REQUIREMENT_THEME_UNVERIFIED", "本次主题生成失败或降级，不能用规则主题继续");
      }
      return result;
    });
  };

  const converted: Method = async function (discovery, upstream, metadata) {
    const scope = receiverScope(this);
    if (!scope) return Reflect.apply(convert, this, [discovery, upstream]);
    return awaited(scope, async () => {
      const expectedCast = scope ? scopeCast(scope).hash : undefined;
      const ownerAudience = scope ? audience(scope) : undefined;
      if (scope && requirementCast(requirementRecord(metadata, "转换 metadata")).hash !== expectedCast) {
        throw new RequirementContractError("REQUIREMENT_CAST_CHANGED", "转换前人物合同与本次宿主选择不一致");
      }
      // The controlled caller really awaits this result; original profile generation is not replaced.
      const original = await Reflect.apply(convert, this, [discovery, upstream]);
      if (currentScope() !== scope) throw new RequirementContractError("REQUIREMENT_SCOPE_CLOSED", "转换结束时运行作用域已经关闭");
      return bindRequirementContract(original, discovery, upstream, metadata, expectedCast!,
        typeof ownerAudience === "string" && ownerAudience.trim() ? ownerAudience : null);
    });
  };
  const rendered: Method = function (intent, metadata, list, discovery) {
    const scope = receiverScope(this);
    if (!scope) return Reflect.apply(render, this, [intent, metadata, list, discovery]);
    return guard(scope, () => {
      const contract = verifiedRequirementContract(list, metadata, discovery);
      if (contract.cast.hash !== scopeCast(scope).hash) throw new RequirementContractError("REQUIREMENT_CAST_CHANGED", "G3 使用了另一运行的人物合同");
      const ownerAudience = audience(scope);
      if (contract.ownerAudience !== (typeof ownerAudience === "string" && ownerAudience.trim() ? ownerAudience : null)) {
        throw new RequirementContractError("REQUIREMENT_AUDIENCE_CHANGED", "G3 与本次宿主冻结的客户受众口径不一致");
      }
      return renderRequirementContract(contract, requirementRecord(metadata, "G3 metadata"));
    });
  };
  const discovered: Method = async function (input) {
    const scope = receiverScope(this);
    if (!scope) return Reflect.apply(discover, this, [input]);
    return awaited(scope, async () => {
      check(scope); bindReceiver(scope, this);
      const cast = scopeCast(scope);
      const agents = requirementRecord(this.agents, "需求洞察 agents");
      const inputHash = scope.authority ? requirementHash(input) : undefined;
      const originalEngine = this;
      const requireActiveScope = () => {
        guard(scope, () => {
          check(scope);
          if (scope.authority && (originalEngine.agents !== agents || requirementHash(input) !== inputHash)) {
            requirementAuthorityFailure("REQUIREMENT_DISCOVERY_CHANGED", "需求输入或原始 agents 在本次调用中发生变化");
          }
        });
      };
      const guardedAgents = Object.fromEntries(Object.entries(agents).map(([name, value]) => {
        const agent = requirementRecord(value, `洞察 agent ${name}`);
        const call = method(agent, "_callLLM"), fallback = method(agent, "_fallback");
        const view = Object.create(agent) as RequirementRecord;
        if (scope.authority) {
          const protect = <T>(operation: () => T) => protectModel(scope, () => { requireActiveScope(); return operation(); });
          view.llmEngine = protect(() => scopedRequirementEngine(agent.llmEngine, protect, () => promptContext(scope), () => {
            const upstream = requirementRecord(input, "原始洞察来源");
            const story = upstream._originalStoryText || upstream.original_story_text || "";
            if (typeof story !== "string") requirementAuthorityFailure("REQUIREMENT_DISCOVERY_CHANGED", "本次原始故事不是完整文本");
            return story;
          }));
          view._validateAndFill = function (this: RequirementRecord, value: unknown, schema: unknown) {
            requireActiveScope();
            validateRequirementSchema(value, schema);
            return structuredClone(value);
          };
        }
        view._callLLM = function (this: RequirementRecord, ...args: unknown[]) {
          requireActiveScope();
          return Reflect.apply(call, this, args);
        };
        view._fallback = function (this: RequirementRecord, ...args: unknown[]) {
          requireActiveScope();
          if (scope.authority) return guard(scope, () => requirementAuthorityFailure("REQUIREMENT_DISCOVERY_UNVERIFIED", "本次需求模型失败，拒绝规则洞察回填"));
          return Reflect.apply(fallback, this, args);
        };
        return [name, view];
      }));
      if (scope.authority) {
        const risk = requirementRecord(guardedAgents.risk, "RiskAssessor");
        const runRisk = method(risk, "run"), callRisk = method(risk, "_callLLM"), buildRisk = method(risk, "_buildPrompt");
        const riskView = Object.create(risk) as RequirementRecord;
        let finalRiskFailure: { error: unknown } | undefined;
        const unverifiedRisk = () => new RequirementContractError("REQUIREMENT_DISCOVERY_UNVERIFIED", "RiskAssessor 未提供完整真实响应，拒绝规则洞察回填");
        riskView.run = async function (this: RequirementRecord, value: unknown, schema: unknown) {
          requireActiveScope();
          finalRiskFailure = undefined;
          const runView = Object.create(this) as RequirementRecord;
          let pendingFeedback = "", attemptFeedback = "";
          let currentFailure: { error: unknown } | undefined;
          runView._callLLM = async function (this: RequirementRecord, ...args: unknown[]) {
            requireActiveScope();
            attemptFeedback = pendingFeedback;
            pendingFeedback = "";
            // The second transport/parser failure must replace the first schema
            // failure. Authority/engine failures remain sticky in requireActiveScope.
            currentFailure = undefined;
            try { return await Reflect.apply(callRisk, this, args); }
            catch (error) { currentFailure = { error }; throw error; }
            finally { attemptFeedback = ""; }
          };
          runView._buildPrompt = function (this: RequirementRecord, input: unknown) {
            requireActiveScope();
            const original = Reflect.apply(buildRisk, this, [input]);
            if (typeof original !== "string") requirementAuthorityFailure("REQUIREMENT_VENDOR_UNAVAILABLE", "RiskAssessor 原始 prompt 不是文本");
            return original + attemptFeedback;
          };
          runView._validateAndFill = function (this: RequirementRecord, response: unknown, responseSchema: unknown) {
            requireActiveScope();
            // Semantic response rejection is retryable inside the native loop;
            // throwing it inside guard/protect would make attempt one fatal.
            try { validateRequirementSchema(response, responseSchema, "RiskAssessor response"); }
            catch (error) {
              currentFailure = { error };
              pendingFeedback = structuredRiskFeedback(error);
              throw error;
            }
            pendingFeedback = "";
            currentFailure = undefined;
            return structuredClone(response);
          };
          runView._fallback = function () {
            requireActiveScope();
            finalRiskFailure = currentFailure ?? { error: unverifiedRisk() };
            throw finalRiskFailure.error;
          };
          try { return await Reflect.apply(runRisk, runView, [value, schema]); }
          finally { pendingFeedback = ""; attemptFeedback = ""; currentFailure = undefined; }
        };
        riskView._fallback = function () {
          requireActiveScope();
          // The native discover catch invokes the agent fallback a second time.
          throw (finalRiskFailure ?? { error: unverifiedRisk() }).error;
        };
        guardedAgents.risk = riskView;
      }
      const scene = requirementRecord(guardedAgents.scene, "SceneArchitect");
      const build = method(scene, "_buildPrompt"), run = method(scene, "run");
      const callScene = method(scene, "_callLLM");
      method(scene, "_validateAndFill");
      // Each run gets its own engine/agent view. No global or shared agent carries project metadata.
      const sceneView = Object.create(scene) as RequirementRecord;
      let finalSceneFailure: RequirementContractError | undefined;
      const unverifiedScene = () => new RequirementContractError("REQUIREMENT_SCENE_UNVERIFIED", "SceneArchitect 未提供完整真实结构，拒绝规则道具或动作回填");
      sceneView.run = async function (this: RequirementRecord, value: unknown, schema: unknown) {
        requireActiveScope();
        finalSceneFailure = undefined;
        const effectiveSchema = structuredSceneSchema(schema);
        const runView = Object.create(this) as RequirementRecord;
        let pendingFeedback = "", attemptFeedback = "";
        let currentValidationFailure: RequirementContractError | undefined;
        runView._callLLM = async function (this: RequirementRecord, ...args: unknown[]) {
          requireActiveScope();
          // Feedback belongs to the previous completed validation. The current
          // failure must be cleared independently before transport/JSON parsing.
          attemptFeedback = pendingFeedback;
          pendingFeedback = "";
          currentValidationFailure = undefined;
          try { return await Reflect.apply(callScene, this, args); }
          finally { attemptFeedback = ""; }
        };
        runView._buildPrompt = function (this: RequirementRecord, input: unknown) {
          requireActiveScope();
          const original = Reflect.apply(build, this, [input]);
          return structuredScenePrompt(original, input, effectiveSchema) + structuredSceneInstructions(cast, audience(scope)) + attemptFeedback;
        };
        runView._validateAndFill = function (this: RequirementRecord, response: unknown, responseSchema: unknown) {
          requireActiveScope();
          // Validate the real response before vendor fallback can invent fields.
          const upstream = requirementRecord(input, "SceneArchitect 上游输入");
          try {
            validateRequirementSchema(response, responseSchema);
            requirementScenes(response, cast, upstream.duration_sec);
          } catch (error) {
            const feedback = structuredSceneFeedback(error);
            if (feedback && error instanceof RequirementContractError) {
              currentValidationFailure = error;
              pendingFeedback = feedback;
            }
            throw error;
          }
          pendingFeedback = "";
          currentValidationFailure = undefined;
          // The native defaults bridge eagerly evaluates _fallback, even for a
          // complete object. Strict responses never enter that invented path.
          return structuredClone(response);
        };
        runView._fallback = function () {
          requireActiveScope();
          finalSceneFailure = currentValidationFailure ?? unverifiedScene();
          throw finalSceneFailure;
        };
        try { return await Reflect.apply(run, runView, [value, effectiveSchema]); }
        finally {
          pendingFeedback = "";
          attemptFeedback = "";
          currentValidationFailure = undefined;
        }
      };
      sceneView._fallback = function () {
        requireActiveScope();
        // The native discover catch calls this again after the runView fallback.
        throw finalSceneFailure ?? unverifiedScene();
      };
      const engineView = Object.create(this) as RequirementRecord;
      engineView.agents = { ...guardedAgents, scene: sceneView };
      const result = await awaited(scope, () => Reflect.apply(discover, engineView, [input]));
      if (currentScope() !== scope) throw new RequirementContractError("REQUIREMENT_SCOPE_CLOSED", "需求洞察结束时运行作用域已经关闭");
      const record = requirementRecord(result, "实际需求洞察结果");
      requirementScenes(record.sceneStructure, cast, requirementRecord(input, "上游输入").duration_sec);
      return { ...record, audienceAuthority: audience(scope) ?? null, audienceProfileStatus: "model-hypothesis" };
    });
  };
  const noFastFallback: Method = function (...args) {
    const scope = receiverScope(this);
    if (!scope) return Reflect.apply(fast, this, args);
    return guard(scope, () => { throw new RequirementContractError("REQUIREMENT_DISCOVERY_UNVERIFIED", "本次需求洞察失败，不能用规则兜底冒充完整合同"); });
  };
  const renderedDiscovery: Method = function (...args) {
    const scope = receiverScope(this);
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
  const patches: Array<[RequirementRecord, string, Method]> = [
    [vendorPrototype, "_convertDiscoveryToRequirementList", converted], [vendorPrototype, "_renderRequirementContract", rendered],
    [discoveryPrototype, "discover", discovered], [discoveryPrototype, "_fastMode", noFastFallback],
    [discoveryPrototype, "generateMarkdown", renderedDiscovery]
  ];
  if (themePrototype) patches.push([vendorPrototype, "_buildThemeInput", qualifiedInput], [themePrototype, "generate", themed]);
  for (const [owner, key, patched] of patches) {
    const original = Object.getOwnPropertyDescriptor(owner, key);
    if (!original || typeof original.value !== "function" || original.writable !== true || original.configurable !== true) {
      throw new RequirementContractError("REQUIREMENT_VENDOR_UNAVAILABLE", `${key} 不是可恢复的原始自有方法`);
    }
    changes.push({ owner, key, original, patched });
  }
  const installed: Change[] = [];
  try {
    for (const change of changes) {
      Object.defineProperty(change.owner, change.key, { ...change.original, value: change.patched });
      installed.push(change);
    }
  } catch (error) {
    for (const change of installed.reverse()) Object.defineProperty(change.owner, change.key, change.original);
    throw error;
  }
  nativeIdentities.set(vendorPrototype, changes.map(({ owner, key, original }) => ({ owner, key, original })));
  active.set(vendorPrototype, { changes });
  let disposed = false;
  return () => {
    if (disposed) return;
    assertRequirementContractBridge(vendorPrototype);
    for (const change of [...changes].reverse()) Object.defineProperty(change.owner, change.key, change.original);
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
    const theme = require(path.join(path.dirname(lease.identity.entryPath), "skills/creative-theme-generator")) as {
      CreativeThemeGenerator?: { prototype?: RequirementRecord };
    };
    if (!theme.CreativeThemeGenerator?.prototype) throw new RequirementContractError("REQUIREMENT_VENDOR_UNAVAILABLE", "缺少实际主题生成器");
    return installRequirementContractBridge(requirementRecord(constructor.prototype, "受控 vendor prototype"), mod.RequirementDiscoveryEngine.prototype,
      theme.CreativeThemeGenerator.prototype);
  } finally {
    lease.release();
  }
}
