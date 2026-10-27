import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import path from "node:path";
import {
  requirementHash, requirementRecord, verifiedRequirementContract,
  type RequirementContract, type RequirementRecord
} from "./requirement-contract.js";
import {
  authoritativeDelivery, authoritativeProduct, bindPrdProvenance, effectivePrdModelSchema, prdAuthorityPrompt, prdFail,
  validatePrdModelPayload, validatePrdProduction, type PrdAuthority
} from "./prd-authority.js";
import { acquireVendorRequirementEntry } from "./vendor-requirement-entry.js";

type Method = (this: RequirementRecord, ...args: unknown[]) => unknown;
interface Scope {
  authority: PrdAuthority;
  active: boolean;
  fatal?: { error: unknown };
  system?: RequirementRecord;
  generator?: RequirementRecord;
  list?: RequirementRecord;
  listHash?: string;
  contract?: RequirementContract;
  reviewedHash?: string;
  reviewedProjectionHash?: string;
  reviewedResult?: RequirementRecord;
  generated: WeakSet<object>;
}
const scopes = new AsyncLocalStorage<Scope | undefined>();
const systems = new WeakMap<object, Scope>();
const generators = new WeakMap<object, Scope>();

function fatal(scope: Scope, error: unknown): never {
  scope.fatal ??= { error };
  throw scope.fatal.error;
}
function guard<T>(scope: Scope, operation: () => T): T {
  try {
    if (!scope.active || scopes.getStore() !== scope) prdFail("PRD_SCOPE_CLOSED", "PRD 不能在本次运行结束后继续消耗权威输入");
    if (scope.fatal !== undefined) throw scope.fatal.error;
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
function current(): Scope | undefined {
  const scope = scopes.getStore();
  if (scope) guard(scope, () => undefined);
  return scope;
}

function scopedReceiver(receiver: RequirementRecord, kind: "system" | "generator"): Scope | undefined {
  const scope = current(), bound = (kind === "system" ? systems : generators).get(receiver);
  if (bound && bound !== scope) {
    return fatal(bound, new Error("PRD_SCOPE_CONFLICT: 已绑定的系统或生成器不能脱离本次权威作用域调用"));
  }
  return scope;
}

/** A swallowed vendor exception stays fatal when the outer operation eventually returns. */
export async function withPrdAuthorityScope<T>(authority: PrdAuthority | undefined, operation: () => T | Promise<T>): Promise<T> {
  if (!authority) return scopes.run(undefined, operation);
  const scope: Scope = { authority: structuredClone(authority), active: true, generated: new WeakSet() };
  return scopes.run(scope, async () => {
    try {
      const result = await awaited(scope, operation);
      if (result && typeof result === "object" && (result as RequirementRecord).success === true) {
        const stages = requirementRecord((result as RequirementRecord).stages, "成功运行 stages");
        const finalPrd = requirementRecord(requirementRecord(stages.prdGeneration, "成功运行 prdGeneration").data, "成功运行 PRD");
        if (!scope.reviewedHash || finalPrd !== scope.reviewedResult
          || reviewProjectionHash(finalPrd) !== scope.reviewedProjectionHash) {
          prdFail("PRD_REVIEW_UNVERIFIED", "成功返回前最终 PRD 未绑定本次真实 G4 或审核后内容发生变化");
        }
      }
      return result;
    } catch (error) { return fatal(scope, error); }
    finally { scope.active = false; }
  });
}

function reviewProjectionHash(value: RequirementRecord): string {
  const projection = structuredClone(value);
  const characters = requirementRecord(projection.characterSystem, "已审人物系统").characters;
  if (!Array.isArray(characters)) prdFail("PRD_REVIEW_UNVERIFIED", "已审人物系统缺少名单");
  for (const value of characters) {
    const character = requirementRecord(value, "已审人物");
    if (typeof character.portraitPath !== "string") prdFail("PRD_REVIEW_UNVERIFIED", "定妆照路径必须为明确文本");
    // G5 may later fill this lifecycle field. It never alters the G4 creation contract.
    character.portraitPath = "";
  }
  return requirementHash(projection);
}

function method(owner: RequirementRecord, key: string): Method {
  const value = owner[key];
  if (typeof value !== "function") prdFail("PRD_VENDOR_UNAVAILABLE", `vendor 缺少 ${key}`);
  return value as Method;
}
interface Change { owner: RequirementRecord; key: string; original: PropertyDescriptor; patched: Method }
interface Installed { changes: Change[]; schema: RequirementRecord; schemaHash: string }
const active = new WeakMap<object, Installed>();
const nativeIdentities = new WeakMap<object, Array<{ owner: RequirementRecord; key: string; descriptor: PropertyDescriptor }>>();
function descriptorEqual(a: PropertyDescriptor | undefined, b: PropertyDescriptor): boolean {
  return Boolean(a && a.value === b.value && a.writable === b.writable && a.configurable === b.configurable
    && a.enumerable === b.enumerable && a.get === b.get && a.set === b.set);
}

export function assertPrdAuthorityBridge(vendorPrototype: object): void {
  const installed = active.get(vendorPrototype);
  if (!installed || installed.schemaHash !== requirementHash(installed.schema) || installed.changes.some(change =>
    !descriptorEqual(Object.getOwnPropertyDescriptor(change.owner, change.key), { ...change.original, value: change.patched }))) {
    prdFail("PRD_BRIDGE_CHANGED", "PRD 权威桥的方法、属性或 schema 身份已经变化");
  }
}

function verifyOutput(scope: Scope, value: unknown): RequirementRecord {
  return guard(scope, () => {
    const result = requirementRecord(value, "PRD 当前结果");
    if (!scope.contract || !scope.generated.has(result)) prdFail("PRD_RESULT_UNBOUND", "PRD 不属于本次真实生成调用");
    validatePrdProduction(result, scope.contract, scope.authority.profile);
    const marker = requirementRecord(result._workloomPrdAuthority, "PRD 来源凭据");
    const positioning = requirementRecord(result.productPositioning, "PRD 产品定位");
    const output = requirementRecord(requirementRecord(result.deliveryStandard, "PRD 交付标准").outputFormat, "PRD 输出格式");
    const profile = scope.authority.profile;
    const g1 = requirementRecord(marker.g1, "PRD G1 来源锚点");
    const characters = requirementRecord(result.characterSystem, "PRD characterSystem").characters as RequirementRecord[];
    const scenes = requirementRecord(result.scenePlan, "PRD scenePlan").scenes as RequirementRecord[];
    const audienceAuthority = requirementRecord(requirementRecord(result.audienceProfile, "PRD 受众")._workloomAudienceAuthority, "PRD 受众权威标记");
    if (marker.schemaVersion !== "workloom.prd-authority/v1" || marker.status !== "ready-for-g4"
      || g1.path !== scope.authority.marketing.g1Artifact.path || g1.sha256 !== scope.authority.marketing.g1Artifact.sha256
      || marker.requirementContractHash !== scope.contract.hash || marker.castHash !== scope.contract.cast.hash
      || marker.scenePlanHash !== requirementHash(result.scenePlan) || marker.characterSystemHash !== requirementHash(result.characterSystem)
      || requirementHash(result._workloomRequirementContract) !== requirementHash(scope.contract)
      || audienceAuthority.schemaVersion !== "workloom.prd-audience-authority/v1"
      || audienceAuthority.customerOriginal !== scope.contract.ownerAudience || audienceAuthority.modelStatus !== "model-hypothesis"
      || scenes.some((scene, index) => requirementHash(scene._workloomRequirementScene) !== requirementHash(scope.contract!.scenes[index]))
      || characters.some(character => {
        const selected = scope.contract!.cast.characters.find(item => item.id === character.characterId);
        return requirementHash(character._workloomCharacterSource) !== requirementHash(selected)
          || requirementHash(character._workloomCharacterSelection) !== requirementHash(scope.contract!.cast.selection);
      })
      || requirementHash(marker.scope) !== requirementHash(scope.authority.marketing.scope)
      || requirementHash(marker.profile) !== requirementHash(profile)
      || ["targetDuration", "aspectRatio", "targetPlatform", "resolution", "frameRate"].some(key => Object.hasOwn(profile, key) && positioning[key] !== profile[key as keyof typeof profile])
      || Object.keys(profile).some(key => output[key] !== profile[key as keyof typeof profile])) {
      prdFail("PRD_AUTHORITY_CHANGED", "PRD 权威规格或本次场景/人物来源在生成后发生变化");
    }
    return result;
  });
}

/** Dependency seam: production supplies the exact pinned CJS prototypes and native PRD schema. */
export function installPrdAuthorityBridge(
  vendorPrototype: RequirementRecord, prdPrototype: RequirementRecord, schema: RequirementRecord
): () => void {
  if (active.has(vendorPrototype)) prdFail("PRD_BRIDGE_ACTIVE", "PRD 权威桥只能由共享引用计数安装");
  if (nativeIdentities.get(vendorPrototype)?.some(item => !descriptorEqual(Object.getOwnPropertyDescriptor(item.owner, item.key), item.descriptor))) {
    prdFail("PRD_BRIDGE_CHANGED", "原始 PRD 方法与首次受控身份不一致");
  }
  const schemaHash = requirementHash(schema);
  const confirmList = method(vendorPrototype, "_confirmRequirementList");
  const minimal = method(vendorPrototype, "_generateMinimalPRD");
  const confirmPrd = method(vendorPrototype, "_confirmPRD");
  const generate = method(prdPrototype, "generate");
  const markdown = method(prdPrototype, "generateMarkdown");
  const changes: Change[] = [];
  const check = (scope: Scope) => guard(scope, () => assertPrdAuthorityBridge(vendorPrototype));

  const confirmed: Method = async function (content, listValue) {
    const scope = scopedReceiver(this, "system");
    if (!scope) return Reflect.apply(confirmList, this, [content, listValue]);
    return awaited(scope, async () => {
      check(scope);
      const list = requirementRecord(listValue, "G3 实际需求清单");
      const generator = requirementRecord(this.prdGenerator, "本次 PRDGenerator");
      const previousSystem = systems.get(this), previousGenerator = generators.get(generator);
      if ((previousSystem && previousSystem !== scope) || (previousGenerator && previousGenerator !== scope)
        || (scope.system && scope.system !== this) || (scope.generator && scope.generator !== generator)) {
        prdFail("PRD_SCOPE_CONFLICT", "系统或 PRDGenerator 属于另一运行的权威作用域");
      }
      systems.set(this, scope); generators.set(generator, scope);
      scope.system = this; scope.generator = generator;
      const before = requirementHash(list);
      const result = requirementRecord(await Reflect.apply(confirmList, this, [content, listValue]), "G3 实际确认结果");
      check(scope);
      if (requirementHash(list) !== before || result.requirementList !== listValue) prdFail("PRD_G3_CHANGED", "G3 审核前后的实际需求合同不是同一内容");
      if (result.approved === true) {
        scope.list = structuredClone(list);
        scope.listHash = requirementHash(scope.list);
      }
      return result;
    });
  };
  const noMinimal: Method = function (...args) {
    const scope = scopedReceiver(this, "system");
    if (!scope) return Reflect.apply(minimal, this, args);
    return guard(scope, () => prdFail("PRD_FALLBACK_FORBIDDEN", "本次 PRD 失败不能改用最小规则文档继续生产"));
  };

  const generated: Method = async function (discoveryValue) {
    const scope = scopedReceiver(this, "generator");
    if (!scope) return Reflect.apply(generate, this, [discoveryValue]);
    return awaited(scope, async () => {
      check(scope);
      if (!scope.system || scope.generator !== this || systems.get(scope.system) !== scope || generators.get(this) !== scope
        || !scope.list || requirementHash(scope.list) !== scope.listHash) prdFail("PRD_G3_UNVERIFIED", "PRD 缺少本次已获真实 G3 批准的完整合同");
      if (scope.reviewedHash) prdFail("PRD_UNREVIEWED_REGENERATION", "G4 批准后不能用未经重新审核的 PRD 覆盖已审版本");
      const discovery = structuredClone(requirementRecord(discoveryValue, "PRD 原始 discovery"));
      const sourceHash = requirementHash(discovery.sceneStructure);
      const metadata = { ...scope.authority.metadata, _workloomRequirementContract: scope.list._workloomRequirementContract };
      const contract = verifiedRequirementContract(scope.list, metadata, discovery);
      scope.contract = structuredClone(contract);
      const promptContext = prdAuthorityPrompt(scope.authority, contract);
      const view = Object.create(this) as RequirementRecord;
      for (let number = 1; number <= 5; number++) {
        const key = `agent${number}`, agent = requirementRecord(this[key], key);
        const agentView = Object.create(agent) as RequirementRecord;
        const process = method(agent, "process");
        if (number === 1 || number === 5) {
          agentView.process = function (this: RequirementRecord, ...args: unknown[]) {
            return guard(scope, () => {
              check(scope);
              const result = Reflect.apply(process, this, args);
              return number === 1 ? authoritativeProduct(result, scope.authority.profile) : authoritativeDelivery(result, scope.authority.profile);
            });
          };
        } else if (number === 2 || number === 3) {
          const build = method(agent, "_buildPrompt"), call = method(agent, "_callLLM"), parse = method(agent, "_parseResult");
          const getEngine = method(agent, "_getLLMEngine");
          method(agent, "fallback");
          const kind = number === 2 ? "creative" : "production";
          const effectiveSchema = effectivePrdModelSchema(kind, schema, contract);
          const schemaHeading = `\n\n## 本次宿主 PRD ${kind} 响应 JSON Schema（${requirementHash(effectiveSchema)}）\n`;
          const responseContext = schemaHeading
            + `本次实际模型响应必须符合以下完整 JSON Schema；它与宿主严格校验使用同一份有效结构，补充前述通用示例。`
            + (kind === "creative" ? `只输出创意核心的裸 JSON 对象，不要包裹 creativeCore。\n` : `只输出以下四个制作模块组成的 JSON 对象。\n`)
            + `\`\`\`json\n${JSON.stringify(effectiveSchema)}\n\`\`\`\n` + promptContext;
          let builtPrompt: { original: string; complete: string } | undefined;
          agentView._getLLMEngine = function (this: RequirementRecord, ...args: unknown[]) {
            return guard(scope, () => {
              check(scope);
              const value = Reflect.apply(getEngine, this, args);
              if (value === null || value === undefined) return value;
              const engine = requirementRecord(value, "PRD 原始模型引擎"), reason = method(engine, "reasonStructured");
              const enginePrototype = Object.getPrototypeOf(engine);
              let methodOwner: object | null = engine;
              while (methodOwner && !Object.getOwnPropertyDescriptor(methodOwner, "reasonStructured")) methodOwner = Object.getPrototypeOf(methodOwner);
              const reasonDescriptor = methodOwner && Object.getOwnPropertyDescriptor(methodOwner, "reasonStructured");
              if (!methodOwner || !reasonDescriptor || reasonDescriptor.value !== reason) prdFail("PRD_VENDOR_UNAVAILABLE", "原始模型方法不是固定的数据属性");
              const checkEngine = () => {
                if (Object.getPrototypeOf(engine) !== enginePrototype || engine.reasonStructured !== reason
                  || !descriptorEqual(Object.getOwnPropertyDescriptor(methodOwner!, "reasonStructured"), reasonDescriptor)) {
                  prdFail("PRD_ENGINE_CHANGED", "本次模型引擎方法或属性身份已经变化");
                }
              };
              const engineView = Object.create(engine) as RequirementRecord;
              let nativePrefix: string | undefined;
              engineView.reasonStructured = async function (prompt: unknown, ...callArgs: unknown[]) {
                const complete = guard(scope, () => {
                  check(scope); checkEngine();
                  if (typeof prompt !== "string") prdFail("PRD_VENDOR_UNAVAILABLE", "实际模型调用 prompt 不是文本");
                  if (!builtPrompt) prdFail("PRD_VENDOR_UNAVAILABLE", "实际模型调用缺少本次亲自构建的 PRD prompt");
                  if (nativePrefix === undefined) {
                    if (!prompt.endsWith(builtPrompt.complete)) prdFail("PRD_VENDOR_UNAVAILABLE", "首次模型 prompt 不属于本次完整构建结果");
                    nativePrefix = prompt.slice(0, prompt.length - builtPrompt.complete.length);
                    return prompt;
                  }
                  if (!prompt.startsWith(nativePrefix)) prdFail("PRD_VENDOR_UNAVAILABLE", "原生模型 prompt 前缀在重试期间变化");
                  const currentPrompt = prompt.slice(nativePrefix.length);
                  if (currentPrompt === builtPrompt.complete) return prompt;
                  // The pinned native example-removal branch adds this trailer.
                  // Keep it separately while proving which prefix came from our build.
                  const retryTrailer = "\n[输出结构见schema]\n}";
                  const trailer = currentPrompt.endsWith(retryTrailer) ? retryTrailer : "";
                  const surviving = trailer ? currentPrompt.slice(0, -trailer.length) : currentPrompt;
                  // Restore both the effective response schema and complete frozen
                  // authority only at our recorded suffix position. A heading quoted
                  // in the customer's original text is never a truncation boundary.
                  const ownSuffixSurvived = surviving.length >= builtPrompt.original.length
                    && builtPrompt.complete.startsWith(surviving);
                  return (ownSuffixSurvived ? nativePrefix + builtPrompt.original + trailer : prompt) + responseContext;
                });
                let result: unknown;
                try { result = await Reflect.apply(reason, engine, [complete, ...callArgs]); }
                catch (error) {
                  // A provider/parse failure may use the native retry budget. Authority,
                  // scope or engine identity failures remain sticky and prevent that retry.
                  guard(scope, () => { check(scope); checkEngine(); });
                  throw error;
                }
                guard(scope, () => { check(scope); checkEngine(); });
                return result;
              };
              return engineView;
            });
          };
          agentView._buildPrompt = function (this: RequirementRecord, ...args: unknown[]) {
            return guard(scope, () => {
              check(scope);
              const original = Reflect.apply(build, this, args);
              if (typeof original !== "string") prdFail("PRD_VENDOR_UNAVAILABLE", "原始 PRD prompt 不是文本");
              builtPrompt = { original, complete: original + responseContext };
              return builtPrompt.complete;
            });
          };
          agentView._callLLM = function (this: RequirementRecord, ...args: unknown[]) {
            return awaited(scope, async () => {
              check(scope);
              const result = requirementRecord(await Reflect.apply(call, this, args), "PRD 模型调用回执");
              check(scope);
              if (result.degraded !== false || result.result === null || result.result === undefined) prdFail("PRD_MODEL_UNVERIFIED", "本次 PRD 模型失败或降级，不能使用模板创意");
              return result;
            });
          };
          agentView._parseResult = function (this: RequirementRecord, value: unknown, ...args: unknown[]) {
            return guard(scope, () => {
              check(scope);
              const raw = validatePrdModelPayload(value, kind, schema, contract, scope.authority.profile);
              const result = Reflect.apply(parse, this, [value, ...args]);
              if (requirementHash(result) !== requirementHash(kind === "creative" ? { creativeCore: raw } : raw)) {
                prdFail("PRD_RESPONSE_CHANGED", "原生 parser 用规则修改了真实模型模块，拒绝把补全文字当作模型创作");
              }
              return result;
            });
          };
          agentView.fallback = function () {
            return guard(scope, () => prdFail("PRD_MODEL_UNVERIFIED", "本次创意和制作规格必须来自真实模型，拒绝模板 fallback"));
          };
          agentView.process = function (this: RequirementRecord, ...args: unknown[]) {
            return awaited(scope, () => {
              check(scope);
              return Reflect.apply(process, this, args);
            });
          };
        } else {
          agentView.process = function (this: RequirementRecord, ...args: unknown[]) {
            return guard(scope, () => { check(scope); return Reflect.apply(process, this, args); });
          };
        }
        view[key] = agentView;
      }
      // Keep the native two real LLM process calls, timeout/retry budget, rule agents and schema pipeline.
      const original = await Reflect.apply(generate, view, [discovery]);
      check(scope);
      if (requirementHash(discovery.sceneStructure) !== sourceHash) prdFail("PRD_G3_CHANGED", "PRD 生成修改了已经批准的源场景");
      const result = bindPrdProvenance(original, scope.authority, contract);
      scope.generated.add(result);
      return verifyOutput(scope, result);
    });
  };
  const rendered: Method = function (value) {
    const scope = scopedReceiver(this, "generator");
    if (!scope) return Reflect.apply(markdown, this, [value]);
    return guard(scope, () => {
      check(scope);
      if (scope.generator !== this) prdFail("PRD_SCOPE_CONFLICT", "PRD Markdown 使用了另一生成器");
      const result = verifyOutput(scope, value);
      const original = Reflect.apply(markdown, this, [result]);
      if (typeof original !== "string") prdFail("PRD_VENDOR_UNAVAILABLE", "原始 PRD Markdown 不是文本");
      if (original.split("## 9. 受众定位").length !== 2) prdFail("PRD_VENDOR_UNAVAILABLE", "PRD 受众 Markdown 的受控章节发生变化");
      const labeled = original.replace("## 9. 受众定位", `## 9. 客户受众与模型细分推测\n\n`
        + `- **客户 Brief 权威受众原文**：${scope.contract!.ownerAudience ?? "客户未显式指定"}\n`
        + `- **以下年龄、性别与兴趣细分仅为模型推测**：不覆盖客户原文，不构成已核实市场事实，仍待本次 G4 独立评审。\n\n### 模型细分原文`);
      // This field is inapplicable when props exist; retain the canonical contract and hashes.
      const displayContract = { ...scope.contract!, scenes: scope.contract!.scenes.map(scene => {
        if (Array.isArray(scene.props) && scene.props.length > 0 && scene.noPropsReason === null) {
          const { noPropsReason: _inapplicableReason, ...displayScene } = scene;
          return displayScene;
        }
        return scene;
      }) };
      return labeled + `\n\n## 宿主本次权威生产与交付要求\n\n\`\`\`json\n${JSON.stringify({ profile: scope.authority.profile, source: result._workloomPrdAuthority, approvedRequirementContract: displayContract }, null, 2)}\n\`\`\`\n\n`
        + `上述来源绑定只说明本次输入一致；G1 不批准本 PRD，G4 与 G5 均须实际审核。空 portraitPath 是 G4 前正常状态，不能当成已完成定妆照。\n`;
    });
  };
  const reviewed: Method = async function (content, value) {
    const scope = scopedReceiver(this, "system");
    if (!scope) return Reflect.apply(confirmPrd, this, [content, value]);
    return awaited(scope, async () => {
      check(scope);
      if (scope.system !== this || systems.get(this) !== scope) prdFail("PRD_SCOPE_CONFLICT", "G4 不是本次系统的 PRD");
      const result = verifyOutput(scope, value), before = requirementHash(result);
      const verdict = requirementRecord(await Reflect.apply(confirmPrd, this, [content, value]), "G4 实际确认结果");
      check(scope); verifyOutput(scope, value);
      if (requirementHash(result) !== before || verdict.prd !== value) prdFail("PRD_REVIEW_CHANGED", "G4 审核期间 PRD 实际内容发生变化");
      if (verdict.approved === true) {
        scope.reviewedHash = before;
        scope.reviewedProjectionHash = reviewProjectionHash(result);
        scope.reviewedResult = result;
      }
      return verdict;
    });
  };
  for (const [owner, key, patched] of [
    [vendorPrototype, "_confirmRequirementList", confirmed], [vendorPrototype, "_generateMinimalPRD", noMinimal],
    [vendorPrototype, "_confirmPRD", reviewed], [prdPrototype, "generate", generated], [prdPrototype, "generateMarkdown", rendered]
  ] as Array<[RequirementRecord, string, Method]>) {
    const original = Object.getOwnPropertyDescriptor(owner, key);
    if (!original || typeof original.value !== "function" || original.writable !== true || original.configurable !== true) {
      prdFail("PRD_VENDOR_UNAVAILABLE", `${key} 不是可恢复的原始自有方法`);
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
  nativeIdentities.set(vendorPrototype, changes.map(({ owner, key, original: descriptor }) => ({ owner, key, descriptor })));
  active.set(vendorPrototype, { changes, schema, schemaHash });
  let disposed = false;
  return () => {
    if (disposed) return;
    assertPrdAuthorityBridge(vendorPrototype);
    for (const change of [...changes].reverse()) Object.defineProperty(change.owner, change.key, change.original);
    active.delete(vendorPrototype);
    disposed = true;
  };
}

export function installVendorPrdAuthorityBridge(constructor: { prototype: object }, entryPath: string): () => void {
  const lease = acquireVendorRequirementEntry(entryPath);
  try {
    if (lease.exports.HyperrealitySystem !== (constructor as unknown)) prdFail("PRD_BRIDGE_CHANGED", "PRD 桥与受控 vendor 入口 constructor 不一致");
    const require = createRequire(lease.identity.entryPath);
    const directory = path.join(path.dirname(lease.identity.entryPath), "engines/prd-generator");
    const { PRDGenerator } = require(path.join(directory, "prd-generator.js")) as { PRDGenerator: { prototype: RequirementRecord } };
    const { PRDSchema } = require(path.join(directory, "schema/prd-schema-v3.js")) as { PRDSchema: RequirementRecord };
    return installPrdAuthorityBridge(requirementRecord(constructor.prototype, "受控 vendor prototype"), PRDGenerator.prototype, PRDSchema);
  } finally { lease.release(); }
}
