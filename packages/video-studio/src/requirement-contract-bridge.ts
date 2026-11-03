import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import {
  RequirementContractError, bindRequirementContract, renderRequirementContract, requirementCast,
  projectDeclaredFields, requirementHash, requirementRecord, requirementScenes, structuredDiscoveryFeedback, structuredRiskFeedback, structuredSceneFeedback, structuredSceneInstructions, structuredScenePrompt, structuredSceneSchema,
  frozenSegmentContract, techniqueReferenceSchema, validateFrozenSceneTiming, validateRequirementSchema, validateTechniqueReferences,
  verifiedRequirementContract, type FrozenSegmentContract, type RequirementCast, type RequirementRecord
} from "./requirement-contract.js";
import { nativeReasonCompleted, nativeReasonFailure, nativeSceneResponseSource, type LLMReasonResult } from "./llm-adapter.js";
import { recoverSceneJsonMissingComma } from "./scene-json-comma-recovery.js";
import { acquireVendorRequirementEntry } from "./vendor-requirement-entry.js";
import {
  qualifyRequirementThemeInput, requirementAuthorityFailure, requirementAuthorityPrompt, scopedRequirementEngine,
  type RequirementAuthorityOptions
} from "./requirement-authority.js";
import type { PrdAuthority } from "./prd-authority.js";

type Method = (this: RequirementRecord, ...args: unknown[]) => unknown;
interface SceneSyntaxRecovery {
  schemaVersion: "workloom.scene-json-single-comma/v1";
  requestSha256: string;
  responseSha256: string;
  schemaSha256: string;
  originalSha256: string;
  repairedSha256: string;
  insertionByteOffset: number;
}
type SceneDraft = Readonly<{ body: string; hash: string; recovery?: Readonly<SceneSyntaxRecovery> }>;
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
  segments?: FrozenSegmentContract;
  sceneResponsesSchema?: true;
  sceneSyntaxRecovery?: Readonly<{
    discovery: RequirementRecord;
    receipt: Readonly<SceneSyntaxRecovery & { sceneHash: string }>;
  }>;
}
const scopes = new AsyncLocalStorage<Scope>();
const receivers = new WeakMap<object, Scope>();
const sceneJsonCorrection = "\n\n## 上一次原生场景 JSON 语法纠正\n"
  + "上一次已返回正文，但正文无法解析为 JSON。根据完整原始输入和本次实际 schema 重新生成一个完整 JSON 对象。"
  + "检查数组元素之间的逗号、对象与数组逐层闭合，以及字符串内引号和换行的合法转义。只输出对象，禁止代码围栏或解释。";

function frozenSceneAnnex(segments: FrozenSegmentContract, draft: SceneDraft): string {
  return "\n\n## 本次冻结分段及原生场景草案\n"
    + `精确硬切合同（客户权威）：\n${JSON.stringify(segments)}\n`
    + (draft.recovery
      ? `本次 SceneArchitect 单分隔符校正后通过严格结构校验的完整 JSON（场景摘要 ${draft.hash}，仍待独立 G3 审核）：\n${draft.body}\n语法校正证据：${JSON.stringify(draft.recovery)}\n`
      : `本次 SceneArchitect 已通过结构校验的完整原始 JSON（场景摘要 ${draft.hash}，仍待独立 G3 审核）：\n${draft.body}\n`)
    + "用原草案的区间、动作先后、机位和声场做交叉核对，建议应指出作用的现有区间。"
    + "不得新增生成段、补拍输出或依赖额外生成的插入镜头，不得改动已有硬切、时长、动作前提或终态。"
    + "需要调整时，在对应单次生成输出内部控制构图、机位移动、遮挡、运动或声场，保留 Brief 要求可辨认的动作和结果。"
    + "跨硬切核对同一人物、服装与护具、发型、姿态、道具、运动方向和相对位置。前段终态与后段首态相承，只有草案明确展示的动作才改变状态。"
    + "若当前方案有矛盾或无法在既定段内完成，按真实风险报告，指出受影响的具体动作、状态或区间，交 G3 审核。"
    + "不要把额外生成、跳过必需动作或换成未获批准的方案写成可执行缓解或参考。\n";
}

/**
 * The vendor treats every populated brief as a marketing brief. A host-routed
 * narrative run must bypass that suffix while retaining duration/platform in
 * the already-built pipeline intent.
 */
export function narrativeThemeInputForRoute(
  value: unknown,
  metadataValue: unknown,
): string | undefined {
  const metadata = metadataValue && typeof metadataValue === "object" && !Array.isArray(metadataValue)
    ? metadataValue as Record<string, unknown>
    : undefined;
  const route = metadata?.pipelineRoute;
  const kind = route && typeof route === "object" && !Array.isArray(route)
    ? (route as Record<string, unknown>).kind
    : undefined;
  return kind === "narrative" && typeof value === "string" ? value : undefined;
}

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
      if (scope.authority && scope.metadata.brief !== undefined) {
        const brief = requirementRecord(scope.metadata.brief, "冻结客户 Brief");
        scope.segments = frozenSegmentContract(brief, brief.duration);
        if (scope.segments) {
          const format = process.env.WORKLOOM_VIDEO_SCENE_RESPONSE_FORMAT ?? "json_object";
          if (format === "json_schema") scope.sceneResponsesSchema = true;
          else if (format !== "json_object") {
            requirementAuthorityFailure("REQUIREMENT_VENDOR_UNAVAILABLE", "冻结场景模型响应格式未获本机受控配置支持");
          }
        }
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
/** Read-only snapshot for host bridges that run inside the current preproduction scope. */
export function currentRequirementMetadata(): RequirementRecord | undefined {
  const scope = currentScope();
  return scope ? structuredClone(scope.metadata) : undefined;
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
    const narrativeInput = narrativeThemeInputForRoute(args[0], args[1] ?? {});
    if (narrativeInput !== undefined) return narrativeInput;
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
      const bound = bindRequirementContract(original, discovery, upstream, metadata, expectedCast!,
        typeof ownerAudience === "string" && ownerAudience.trim() ? ownerAudience : null, scope.segments);
      if (scope && !scope.authority && bound && typeof bound === "object") {
        scope.metadata._workloomRequirementContract = structuredClone(
          (bound as RequirementRecord)._workloomRequirementContract,
        );
      }
      return bound;
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
      const report = renderRequirementContract(contract, requirementRecord(metadata, "G3 metadata"));
      const evidence = scope.sceneSyntaxRecovery;
      if (!evidence) return report;
      if (evidence.discovery !== discovery || evidence.receipt.sceneHash !== requirementHash(evidence.discovery.sceneStructure)) {
        throw new RequirementContractError("REQUIREMENT_DISCOVERY_CHANGED", "G3 未绑定本次语法校正场景");
      }
      return report + `\n\n## 原生场景单分隔符校正证据\n${JSON.stringify(evidence.receipt)}\n`;
    });
  };
  const discovered: Method = async function (input) {
    const scope = receiverScope(this);
    if (!scope) return Reflect.apply(discover, this, [input]);
    return awaited(scope, async () => {
      check(scope); bindReceiver(scope, this);
      const cast = scopeCast(scope);
      const brief = scope.authority && scope.metadata.brief !== undefined
        ? requirementRecord(scope.metadata.brief, "冻结客户 Brief") : {};
      const techniqueOnly = typeof brief.requirements === "string"
        && /参考(?:案例)?(?:只|仅)(?:写|使用)无品牌的?摄影[、，,]剪辑(?:和|与|及|[、，,])声音手法/u.test(brief.requirements);
      const segments = scope.segments;
      if (segments && Number(requirementRecord(input, "原始洞察来源").duration_sec) !== segments.totalSeconds) {
        throw new RequirementContractError("REQUIREMENT_SCENE_UNVERIFIED", "上游创意时长与冻结分段合同不一致");
      }
      const agents = requirementRecord(this.agents, "需求洞察 agents");
      let sceneDraft: SceneDraft | undefined;
      if (scope.sceneSyntaxRecovery) requirementAuthorityFailure("REQUIREMENT_DISCOVERY_CHANGED", "本次运行已有绑定校正证据的原生洞察");
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
        for (const [name, label] of [
          ["audience", "AudienceProfiler"], ["risk", "RiskAssessor"], ["reference", "ReferenceCurator"],
        ] as const) {
          const agent = requirementRecord(guardedAgents[name], label);
          const run = method(agent, "run"), call = method(agent, "_callLLM"), build = method(agent, "_buildPrompt");
          const agentView = Object.create(agent) as RequirementRecord;
          const unverified = (reason: string) => new RequirementContractError("REQUIREMENT_DISCOVERY_UNVERIFIED", `${label} ${reason}`);
          let finalFailure: { error: unknown } | undefined;
          agentView.run = async function (this: RequirementRecord, value: unknown, schema: unknown) {
            requireActiveScope();
            finalFailure = undefined;
            const techniqueReference = name === "reference" && techniqueOnly;
            const effectiveSchema = techniqueReference ? techniqueReferenceSchema(schema) : schema;
            const runView = Object.create(this) as RequirementRecord;
            let pendingFeedback = "", attemptFeedback = "";
            let started = false, correctionUsed = false;
            let currentFailure: { error: unknown } | undefined;
            runView._callLLM = async function (this: RequirementRecord, ...args: unknown[]) {
              requireActiveScope();
              // Native retries may continue looping. Only a completed invalid
              // response can admit one distinct, fully validated correction.
              if (started && (!pendingFeedback || correctionUsed)) {
                throw currentFailure?.error ?? unverified("未收到可验证的模型响应");
              }
              correctionUsed = started;
              started = true;
              attemptFeedback = pendingFeedback;
              pendingFeedback = "";
              currentFailure = undefined;
              try {
                const response = await Reflect.apply(call, this, args);
                requireActiveScope();
                const failure = nativeReasonFailure(response);
                if (failure === "json-syntax") {
                  pendingFeedback = `\n\n## 上一次原生需求 JSON 语法纠正\n`
                    + "上一次已返回正文，但正文无法解析为 JSON。根据完整原始输入和本次实际 schema 重新生成完整 JSON 对象。"
                    + "检查逗号、对象与数组闭合、引号和转义。只输出对象，禁止代码围栏或解释。";
                  throw unverified("模型正文不是有效 JSON");
                }
                if (failure === "unavailable") throw unverified("未收到可验证的模型响应");
                return response;
              } catch (error) { currentFailure = { error }; throw error; }
              finally { attemptFeedback = ""; }
            };
            runView._buildPrompt = function (this: RequirementRecord, input: unknown) {
              requireActiveScope();
              const original = Reflect.apply(build, this, [input]);
              if (typeof original !== "string") requirementAuthorityFailure("REQUIREMENT_VENDOR_UNAVAILABLE", `${label} 原始 prompt 不是文本`);
              let prompt = original;
              if (segments && name === "risk") {
                const boundary = original.lastIndexOf("\n\n【评估心法】");
                const format = original.lastIndexOf("\n\n请输出 JSON 格式：");
                if (boundary < 0 || format <= boundary) {
                  requirementAuthorityFailure("REQUIREMENT_VENDOR_UNAVAILABLE", "RiskAssessor 原始创作指令边界发生变化");
                }
                // Keep native input fields and output format. Replace generic
                // examples that explicitly prescribe extra cuts or audiences.
                prompt = original.slice(0, boundary)
                  + "\n\n【本次评估】逐段指出最可能影响交付的具体风险、影响与严重级别。"
                  + "businessConstraints 使用本次 Brief 的真实约束，mitigationSuggestions 只写符合精确分段合同且可执行的措施。"
                  + "无法消除的关键风险留在风险字段供独立 G3 裁决。"
                  + original.slice(format);
              }
              if (techniqueReference) {
                const boundary = original.lastIndexOf("\n\n【推荐心法】");
                if (boundary === -1 || !original.startsWith("你是一位泡在片库里的剪辑指导。")) {
                  requirementAuthorityFailure("REQUIREMENT_VENDOR_UNAVAILABLE", "ReferenceCurator 原始创作指令边界发生变化");
                }
                // Keep the native video fields and remove the incompatible named-case brief and examples.
                const fields = original.indexOf("\n\n视频类型: ");
                if (fields < 0 || fields >= boundary) requirementAuthorityFailure("REQUIREMENT_VENDOR_UNAVAILABLE", "ReferenceCurator 原始主题字段边界发生变化");
                prompt = "你是一位泡在片库里的剪辑指导。只提出适合本片的具体摄影、剪辑和声音手法。"
                  + original.slice(fields, boundary)
                  + "\n\n客户只允许无品牌的视听手法。filmReferences 和 adReferences 均必须是空数组。"
                  + "styleReferences 写 2–4 条可执行的具体手法，覆盖本片所需的摄影、剪辑与声音，不写导演、影片、作品、品牌或其他商业标识。"
                  + "只输出符合实际 schema 的完整 JSON 对象。";
              }
              if (segments && name !== "audience") {
                if (!sceneDraft) requirementAuthorityFailure("REQUIREMENT_DISCOVERY_CHANGED", "后续原生角色缺少本次已校验场景原件");
                prompt += frozenSceneAnnex(segments, sceneDraft);
              }
              return prompt + attemptFeedback;
            };
            runView._validateAndFill = function (this: RequirementRecord, response: unknown, responseSchema: unknown) {
              requireActiveScope();
              const candidate = name === "risk" ? projectDeclaredFields(response, responseSchema) : response;
              try {
                validateRequirementSchema(candidate, responseSchema, `${label} response`);
                if (techniqueReference) validateTechniqueReferences(candidate);
              }
              catch (error) {
                currentFailure = { error };
                pendingFeedback = structuredRiskFeedback(error) || structuredDiscoveryFeedback(error);
                throw error;
              }
              return structuredClone(candidate);
            };
            runView._fallback = function () {
              requireActiveScope();
              finalFailure = currentFailure ?? { error: unverified("未提供完整真实响应，拒绝规则洞察回填") };
              throw finalFailure.error;
            };
            return Reflect.apply(run, runView, [value, effectiveSchema]);
          };
          agentView._fallback = function () {
            requireActiveScope();
            // Native discover invokes fallback again after the runView failure.
            throw (finalFailure ?? { error: unverified("未提供完整真实响应，拒绝规则洞察回填") }).error;
          };
          guardedAgents[name] = agentView;
        }
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
        const effectiveSchema = structuredSceneSchema(schema, segments);
        const runView = Object.create(this) as RequirementRecord;
        let pendingFeedback = "", attemptFeedback = "";
        let currentSceneFailure: RequirementContractError | undefined;
        let jsonCorrectionScheduled = false;
        let jsonCorrectionExhausted = false;
        let started = false, correctionUsed = false;
        let completedSyntaxFailure = false;
        let nativeSceneBody: string | undefined;
        let syntaxRecovery: Readonly<SceneSyntaxRecovery> | undefined;
        if (segments) {
          const model = requirementRecord(this.llmEngine, "SceneArchitect 已守护模型");
          const reason = model.reason;
          const schemaSha256 = createHash("sha256").update(JSON.stringify(effectiveSchema)).digest("hex");
          if (typeof reason !== "function") requirementAuthorityFailure("REQUIREMENT_VENDOR_UNAVAILABLE", "SceneArchitect 缺少原生 reason");
          runView.llmEngine = Object.create(model, {
            reason: { value: async (...args: unknown[]) => {
              const dispatchArgs = scope.sceneResponsesSchema
                ? [args[0], { ...requirementRecord(args[1], "SceneArchitect 原生选项"),
                  responsesJsonSchema: { name: "workloom_scene_architect", schema: structuredClone(effectiveSchema) } }, ...args.slice(2)]
                : args;
              const result = await Reflect.apply(reason, model, dispatchArgs) as LLMReasonResult;
              completedSyntaxFailure = nativeReasonFailure(result) === "json-syntax" && nativeReasonCompleted(result);
              if (completedSyntaxFailure && scope.sceneResponsesSchema) {
                requireActiveScope();
                const source = nativeSceneResponseSource(result);
                const repaired = source && source.schemaSha256 === schemaSha256 && source.rawText.trim() === result.content
                  ? recoverSceneJsonMissingComma(source.rawText) : undefined;
                if (source && repaired) {
                  try {
                    validateRequirementSchema(repaired.data, effectiveSchema);
                    requirementScenes(repaired.data, cast, requirementRecord(input, "SceneArchitect 上游输入").duration_sec);
                    validateFrozenSceneTiming(repaired.data, segments);
                  } catch (error) {
                    if (error instanceof RequirementContractError) return result;
                    throw error;
                  }
                  syntaxRecovery = Object.freeze({
                    schemaVersion: "workloom.scene-json-single-comma/v1",
                    requestSha256: source.requestSha256, responseSha256: source.responseSha256,
                    schemaSha256,
                    originalSha256: repaired.originalSha256, repairedSha256: repaired.repairedSha256,
                    insertionByteOffset: repaired.insertionByteOffset,
                  });
                  // Only this native agent view receives the locally verified JSON.
                  // The original adapter result remains a measured syntax failure.
                  completedSyntaxFailure = false;
                  return { success: true, content: repaired.content, data: repaired.data, usage: result.usage };
                }
              }
              return result;
            } },
            // The pinned vendor parses the returned text with JSON.parse. Its
            // legacy candidate extractor may salvage partial data or clip a
            // valid full-window response. Send only the whole body to that parser.
            _extractJsonObject: { value: (value: unknown) => {
              if (typeof value !== "string" || !value.trim()) return null;
              nativeSceneBody = value;
              return value.trim();
            } },
          });
        }
        runView._callLLM = async function (this: RequirementRecord, ...args: unknown[]) {
          requireActiveScope();
          if (jsonCorrectionExhausted) throw currentSceneFailure;
          if (segments) {
            if (started && (!pendingFeedback || correctionUsed)) throw currentSceneFailure ?? unverifiedScene();
            correctionUsed = started;
            started = true;
          }
          // Feedback belongs to the previous completed validation. The current
          // failure must be cleared independently before transport/JSON parsing.
          attemptFeedback = pendingFeedback;
          pendingFeedback = "";
          currentSceneFailure = undefined;
          completedSyntaxFailure = false;
          nativeSceneBody = undefined;
          syntaxRecovery = undefined;
          try { return await Reflect.apply(callScene, this, args); }
          catch (error) {
            // The adapter strictly parses returned content; the pinned vendor
            // promotes its parse result to Error.message or parses content itself.
            // Never put response bytes or transport errors into a new prompt.
            const correctable = segments ? completedSyntaxFailure
              : error instanceof SyntaxError || (error instanceof Error && error.message.startsWith("JSON 解析失败: "));
            if (correctable) {
              currentSceneFailure = new RequirementContractError("REQUIREMENT_SCENE_UNVERIFIED", "SceneArchitect 模型正文不是有效 JSON");
              jsonCorrectionExhausted = jsonCorrectionScheduled;
              if (!jsonCorrectionScheduled) {
                jsonCorrectionScheduled = true;
                pendingFeedback = sceneJsonCorrection;
              }
            }
            throw error;
          }
          finally { attemptFeedback = ""; }
        };
        runView._buildPrompt = function (this: RequirementRecord, input: unknown) {
          requireActiveScope();
          const original = Reflect.apply(build, this, [input]);
          return structuredScenePrompt(original, input, effectiveSchema, segments)
            + structuredSceneInstructions(cast, audience(scope), segments) + attemptFeedback;
        };
        runView._validateAndFill = function (this: RequirementRecord, response: unknown, responseSchema: unknown) {
          requireActiveScope();
          // Validate the real response before vendor fallback can invent fields.
          const upstream = requirementRecord(input, "SceneArchitect 上游输入");
          try {
            validateRequirementSchema(response, responseSchema);
            requirementScenes(response, cast, upstream.duration_sec);
            if (segments) {
              validateFrozenSceneTiming(response, segments);
              if (!nativeSceneBody || sceneDraft) {
                throw new RequirementContractError("REQUIREMENT_DISCOVERY_CHANGED", "本次严格校验场景缺少唯一原始正文");
              }
              if (syntaxRecovery && createHash("sha256").update(nativeSceneBody).digest("hex") !== syntaxRecovery.repairedSha256) {
                throw new RequirementContractError("REQUIREMENT_DISCOVERY_CHANGED", "单分隔符校正正文在原生解析过程中发生变化");
              }
              const hash = requirementHash(response);
              sceneDraft = Object.freeze({ body: nativeSceneBody, hash, ...(syntaxRecovery ? { recovery: syntaxRecovery } : {}) });
            }
          } catch (error) {
            const feedback = structuredSceneFeedback(error);
            if (feedback && error instanceof RequirementContractError) {
              currentSceneFailure = error;
              pendingFeedback = feedback;
            }
            throw error;
          }
          pendingFeedback = "";
          currentSceneFailure = undefined;
          // The native defaults bridge eagerly evaluates _fallback, even for a
          // complete object. Strict responses never enter that invented path.
          return structuredClone(response);
        };
        runView._fallback = function () {
          requireActiveScope();
          finalSceneFailure = currentSceneFailure ?? unverifiedScene();
          throw finalSceneFailure;
        };
        try { return await Reflect.apply(run, runView, [value, effectiveSchema]); }
        finally {
          pendingFeedback = "";
          attemptFeedback = "";
          currentSceneFailure = undefined;
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
      if (segments) {
        validateFrozenSceneTiming(record.sceneStructure, segments);
        if (sceneDraft?.hash !== requirementHash(record.sceneStructure)) {
          throw new RequirementContractError("REQUIREMENT_DISCOVERY_CHANGED", "需求洞察结果不再匹配本次原始场景草案");
        }
      }
      const bound = { ...record, audienceAuthority: audience(scope) ?? null, audienceProfileStatus: "model-hypothesis" };
      if (sceneDraft?.recovery) {
        if (scope.sceneSyntaxRecovery) requirementAuthorityFailure("REQUIREMENT_DISCOVERY_CHANGED", "同一运行不能替换已绑定的原生场景校正证据");
        scope.sceneSyntaxRecovery = Object.freeze({ discovery: bound,
          receipt: Object.freeze({ ...sceneDraft.recovery, sceneHash: sceneDraft.hash }) });
      }
      return bound;
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
