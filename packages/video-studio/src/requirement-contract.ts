import { createHash } from "node:crypto";
import {
  SCENE_SUM_ARITHMETIC_TOLERANCE_SECONDS,
  TARGET_DURATION_TOLERANCE_SECONDS,
  withinTargetDurationTolerance,
} from "./duration-contract.js";

export type RequirementRecord = Record<string, unknown>;
export const REQUIREMENT_CONTRACT_VERSION = "workloom.requirement-contract/v1";

export class RequirementContractError extends Error {
  readonly status = "unverified";
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "RequirementContractError";
  }
}

const validationFacts = new WeakMap<RequirementContractError, Readonly<RequirementRecord>>();
const riskValidationFacts = new WeakMap<RequirementContractError, Readonly<RequirementRecord>>();
const finiteNumber = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const schemaPath = /^SceneArchitect response(?:\/(?:opening|scenes|ending|duration|purpose|keyElements|index|emotionalBeat|productionContract|props|actions|name|description|actorId|noPropsReason|totalDuration|sceneCount|narrativeArc|\d{1,6}))*$/;
const riskArrayPath = /^RiskAssessor response\/(?:technicalRisks|businessConstraints|mitigationSuggestions)$/;

function withValidationFacts(error: RequirementContractError, details: RequirementRecord,
  registry = validationFacts): RequirementContractError {
  const facts = Object.freeze(details);
  Object.defineProperty(error, "details", { value: facts, enumerable: true });
  registry.set(error, facts);
  return error;
}

/** Only facts produced by our validator can reach the next native attempt. */
export function structuredSceneFeedback(error: unknown): string {
  const facts = error instanceof RequirementContractError ? validationFacts.get(error) : undefined;
  if (!facts) return "";
  const duration = finiteNumber(facts.durationSum), target = finiteNumber(facts.targetDuration);
  const durationCorrection = duration !== null && target !== null
    && !withinTargetDurationTolerance(duration, target)
    ? `\n本次必须把 opening、scenes、ending 的 duration 合计${duration > target ? "减少" : "增加"} ${Math.abs(duration - target)} 秒，`
      + `并把 totalDuration 精确设为 ${target}；保持真实场景内容重新完整生成，不得复用或补填上一次节点。`
    : "";
  return `\n\n## 上一次原生场景校验反馈\n${JSON.stringify(facts)}\n仅依据这些校验事实重新生成完整合法响应；不复用或补填上次场景，不改变原有 schema、人物与时长约束。${durationCorrection}`;
}

/** Risk retries receive only our exact array-bound facts, never the prior response. */
export function structuredRiskFeedback(error: unknown): string {
  const facts = error instanceof RequirementContractError ? riskValidationFacts.get(error) : undefined;
  return facts ? `\n\n## 上一次原生风险校验反馈\n${JSON.stringify(facts)}\n仅依据这些数组数量校验事实重新生成完整合法响应；不截取、补填或复用上次风险文本，不改变原有 schema 与完整来源约束。` : "";
}

export function requirementRecord(value: unknown, label: string): RequirementRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof (value as RequirementRecord).then === "function") {
    throw new RequirementContractError("REQUIREMENT_CONTRACT_INVALID", `${label} 必须为已完成的普通对象`);
  }
  return value as RequirementRecord;
}

/**
 * Project a strict top-level object response onto the declared schema keys.
 * Missing required keys remain missing and still fail validation; undeclared
 * model chatter is dropped instead of being reinterpreted as production facts.
 */
export function projectDeclaredFields(value: unknown, schemaValue: unknown): unknown {
  if (!schemaValue || typeof schemaValue !== "object" || Array.isArray(schemaValue)) return value;
  const schema = schemaValue as RequirementRecord;
  if (Array.isArray(value) && schema.type === "array") {
    const max = typeof schema.maxItems === "number" && Number.isSafeInteger(schema.maxItems) && schema.maxItems >= 0
      ? schema.maxItems
      : value.length;
    const projected = value.map(item => projectDeclaredFields(item, schema.items));
    if (projected.length <= max) return projected;
    const itemSchema = schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)
      ? schema.items as RequirementRecord
      : {};
    if (max > 0 && itemSchema.type === "string") {
      const kept = projected.slice(0, max - 1);
      const merged = projected.slice(max - 1).filter((item): item is string => typeof item === "string" && Boolean(item.trim())).join("；");
      if (merged) kept.push(merged);
      return kept;
    }
    return projected.slice(0, max);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const properties = schema.properties;
  if (schema.type !== "object" || schema.additionalProperties !== false
    || !properties || typeof properties !== "object" || Array.isArray(properties)) return value;
  const source = value as RequirementRecord;
  return Object.fromEntries(Object.keys(properties as RequirementRecord)
    .filter((key) => Object.prototype.hasOwnProperty.call(source, key))
    .map((key) => [key, projectDeclaredFields(source[key], (properties as RequirementRecord)[key])]));
}

function text(value: unknown, label: string, minimum = 1): string {
  if (typeof value !== "string" || value.trim().length < minimum) {
    throw new RequirementContractError("REQUIREMENT_CONTRACT_INVALID", `${label} 缺少完整文本`);
  }
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new RequirementContractError("REQUIREMENT_CONTRACT_INVALID", `${label} 必须显式为数组`);
  return value;
}

function canonical(value: unknown, seen = new Set<object>()): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") throw new RequirementContractError("REQUIREMENT_CONTRACT_INVALID", "契约包含非 JSON 值");
  if (seen.has(value)) throw new RequirementContractError("REQUIREMENT_CONTRACT_INVALID", "契约包含循环引用");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => canonical(item, seen) ?? null);
    return Object.fromEntries(Object.keys(value).sort().flatMap(key => {
      const next = canonical((value as RequirementRecord)[key], seen);
      return next === undefined ? [] : [[key, next]];
    }));
  } finally { seen.delete(value); }
}

export function requirementHash(value: unknown): string {
  const serialized = JSON.stringify(canonical(value));
  if (serialized === undefined) throw new RequirementContractError("REQUIREMENT_CONTRACT_INVALID", "契约摘要缺少 JSON 内容");
  return createHash("sha256").update(serialized).digest("hex");
}

/** Strictly check the JSON Schema subset used by the actual discovery schema; never fill defaults. */
export function validateRequirementSchema(value: unknown, schemaValue: unknown, label = "SceneArchitect response"): void {
  const ancestors = new Set<object>();
  const risk = label === "RiskAssessor response";
  const check = (item: unknown, schemaInput: unknown, location: string): void => {
    const schema = requirementRecord(schemaInput, "SceneArchitect schema");
    const invalid = (reason: string, keyword = "type", observed: unknown = item, limit?: unknown): never => {
      const error = new RequirementContractError(risk ? "REQUIREMENT_DISCOVERY_UNVERIFIED" : "REQUIREMENT_SCENE_UNVERIFIED",
        `${risk ? label : location} ${reason}`);
      // Fixed schema keys and bounded indices only; never echo a response key,
      // string value, arbitrary label, enum prose or the raw response.
      if (risk && riskArrayPath.test(location) && ["minItems", "maxItems"].includes(keyword)
        && typeof observed === "number" && Number.isSafeInteger(observed) && observed >= 0
        && typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0) {
        const details = { kind: "schema", path: location, keyword, observed, limit };
        error.message += `；validation ${JSON.stringify(details)}`;
        throw withValidationFacts(error, details, riskValidationFacts);
      }
      if (!risk && location.length <= 256 && schemaPath.test(location)) {
        const details = { kind: "schema", path: location, keyword, observed: finiteNumber(observed), limit: finiteNumber(limit) };
        error.message += `；validation ${JSON.stringify(details)}`;
        throw withValidationFacts(error, details);
      }
      throw error;
    };
    if (Array.isArray(schema.enum) && !schema.enum.some(allowed => JSON.stringify(allowed) === JSON.stringify(item))) invalid("不在允许的枚举内", "enum");
    switch (schema.type) {
      case "object": {
        if (!item || typeof item !== "object" || Array.isArray(item)) invalid("必须为对象");
        const record = item as RequirementRecord;
        if (ancestors.has(record)) invalid("包含循环引用");
        ancestors.add(record);
        try {
          const properties = schema.properties === undefined ? {} : requirementRecord(schema.properties, "schema properties");
          for (const key of schema.required === undefined ? [] : array(schema.required, "schema required")) {
            if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(record, key)) invalid("缺少必需字段", "required", null);
          }
          for (const key of Object.keys(record)) {
            if (Object.prototype.hasOwnProperty.call(properties, key)) check(record[key], properties[key], `${location}/${key}`);
            else if (schema.additionalProperties === false) invalid("包含未声明字段", "additionalProperties", null);
          }
        } finally { ancestors.delete(record); }
        return;
      }
      case "array": {
        if (!Array.isArray(item)) invalid("必须为数组");
        const items = item as unknown[];
        if (ancestors.has(items)) invalid("包含循环引用");
        ancestors.add(items);
        try {
          if (typeof schema.minItems === "number" && items.length < schema.minItems) invalid("项目数量不足", "minItems", items.length, schema.minItems);
          if (typeof schema.maxItems === "number" && items.length > schema.maxItems) invalid("项目数量超出范围", "maxItems", items.length, schema.maxItems);
          if (schema.items !== undefined) items.forEach((child, index) => check(child, schema.items, `${location}/${index}`));
        } finally { ancestors.delete(items); }
        return;
      }
      case "string": {
        if (typeof item !== "string") invalid("必须为文本");
        const length = Array.from(item as string).length;
        if (typeof schema.minLength === "number" && length < schema.minLength) invalid("文本不完整", "minLength", length, schema.minLength);
        if (typeof schema.maxLength === "number" && length > schema.maxLength) invalid("文本超出范围", "maxLength", length, schema.maxLength);
        return;
      }
      case "number": case "integer":
        if (typeof item !== "number" || !Number.isFinite(item) || (schema.type === "integer" && !Number.isInteger(item))) invalid("必须为有效数值");
        if (typeof schema.minimum === "number" && (item as number) < schema.minimum) invalid("低于允许范围", "minimum", item, schema.minimum);
        if (typeof schema.maximum === "number" && (item as number) > schema.maximum) invalid("高于允许范围", "maximum", item, schema.maximum);
        return;
      case "boolean": if (typeof item !== "boolean") invalid("必须为布尔值"); return;
      case "null": if (item !== null) invalid("必须为 null"); return;
      case undefined: return;
      default: throw new RequirementContractError("REQUIREMENT_SCHEMA_UNSUPPORTED", "SceneArchitect schema 出现未支持的类型");
    }
  };
  check(value, schemaValue, label);
}

export interface RequirementCast {
  mode: "builtin" | "custom" | "mixed" | "none";
  selection: RequirementRecord;
  characters: RequirementRecord[];
  hash: string;
}

/** Consume the host's resolved selection. This function never picks a model or reads a profile. */
export function requirementCast(metadata: RequirementRecord): RequirementCast {
  const selection = requirementRecord(metadata.builtinCharacterSelection, "宿主出镜选择凭据");
  const mode = selection.mode;
  if (selection.schemaVersion !== "workloom.video-character-selection/v1"
    || !["builtin", "custom", "mixed", "none"].includes(String(mode))) {
    throw new RequirementContractError("REQUIREMENT_CAST_UNVERIFIED", "缺少本次宿主选角口径");
  }
  const selected = array(selection.characters, "选角凭据 characters").map(value => requirementRecord(value, "选中人物"));
  const characters = array(metadata.characters, "宿主 characters").map(value => requirementRecord(value, "出镜人物"));
  if (mode === "none") {
    if (selected.length || characters.length || metadata.hasPerson === true || metadata.noCharacters === false) {
      throw new RequirementContractError("REQUIREMENT_CAST_CONFLICT", "明确无人凭据与出镜名单冲突");
    }
  } else {
    if (!characters.length || selected.length !== characters.length || metadata.hasPerson === false || metadata.noCharacters === true) {
      throw new RequirementContractError("REQUIREMENT_CAST_CONFLICT", "人物选择与实际出镜名单不一致");
    }
    const seen = new Set<string>();
    for (const [index, character] of characters.entries()) {
      const id = text(character.id, "人物 ID"), name = text(character.name, "人物姓名");
      if (id.trim() !== id || seen.has(id) || (character.character_id !== undefined && character.character_id !== id)) {
        throw new RequirementContractError("REQUIREMENT_CAST_CONFLICT", "人物 ID 重复或别名字段冲突");
      }
      seen.add(id);
      const choice = selected[index]!;
      if (choice.id !== id || choice.name !== name || !/^[a-f0-9]{64}$/.test(String(choice.profileSha256))) {
        throw new RequirementContractError("REQUIREMENT_CAST_CONFLICT", "人物 ID、姓名或档案来源与宿主选择不一致");
      }
      text(character.role, "人物叙事角色");
      if (choice.source === "builtin") {
        const source = requirementRecord(character.builtinCharacterSource, "内置人物档案来源");
        if (source.profilePath !== choice.profilePath || source.profileSha256 !== choice.profileSha256
          || source.registrySha256 !== selection.registrySha256 || !/^[a-f0-9]{64}$/.test(String(selection.registrySha256))) {
          throw new RequirementContractError("REQUIREMENT_CAST_CONFLICT", "内置人物档案和目录摘要未绑定本次选择");
        }
      } else if (choice.source !== "explicit-custom") {
        throw new RequirementContractError("REQUIREMENT_CAST_UNVERIFIED", "人物来源未经过宿主解析");
      }
    }
    const builtinCount = selected.filter(choice => choice.source === "builtin").length;
    if ((mode === "builtin" && builtinCount !== selected.length) || (mode === "custom" && builtinCount !== 0)
      || (mode === "mixed" && (builtinCount === 0 || builtinCount === selected.length))) {
      throw new RequirementContractError("REQUIREMENT_CAST_CONFLICT", "人物来源类型与宿主选择模式冲突");
    }
  }
  const result = { mode: mode as RequirementCast["mode"], selection: structuredClone(selection), characters: structuredClone(characters) };
  return { ...result, hash: requirementHash(result) };
}

export interface RequirementProp {
  name: string;
  description: string;
  source: string;
}
export interface RequirementAction {
  actorId: string;
  description: string;
  source: string;
}
export interface RequirementScene {
  id: string;
  source: string;
  duration: number;
  purpose: string;
  keyElements: string[];
  props: RequirementProp[];
  actions: RequirementAction[];
  noPropsReason: string | null;
}
export interface RequirementContract {
  schemaVersion: typeof REQUIREMENT_CONTRACT_VERSION;
  status: "ready-for-g3";
  cast: RequirementCast;
  ownerAudience: string | null;
  modelAudienceHypothesis: unknown;
  scenes: RequirementScene[];
  props: RequirementProp[];
  actions: RequirementAction[];
  sceneStructureHash: string;
  hash: string;
}

/** Every physical item and action must be present in the same SceneArchitect response. */
export function requirementScenes(structureValue: unknown, cast: RequirementCast, targetDuration?: unknown): RequirementScene[] {
  const structure = requirementRecord(structureValue, "SceneArchitect 场景结构");
  const middle = array(structure.scenes, "主体场景");
  const nodes: Array<[string, string, unknown]> = [
    ["opening", "/sceneStructure/opening", structure.opening],
    ...middle.map((node, index): [string, string, unknown] => [`scene-${index + 1}`, `/sceneStructure/scenes/${index}`, node]),
    ["ending", "/sceneStructure/ending", structure.ending]
  ];
  const allowed = new Set([...cast.characters.map(character => String(character.id)), "$product", "$scene"]);
  const performed = new Set<string>();
  const scenes = nodes.map(([id, source, value]): RequirementScene => {
    const node = requirementRecord(value, source);
    const duration = node.duration;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) throw new RequirementContractError("REQUIREMENT_SCENE_UNVERIFIED", `${source} 时长无效`);
    const physical = requirementRecord(node.productionContract, `${source}/productionContract`);
    const props = array(physical.props, `${source}/productionContract/props`).map((item, index): RequirementProp => {
      const prop = requirementRecord(item, "物理道具");
      return { name: text(prop.name, "道具名称"), description: text(prop.description, "道具的可见外观或用途", 4), source: `${source}/productionContract/props/${index}` };
    });
    const actions = array(physical.actions, `${source}/productionContract/actions`).map((item, index): RequirementAction => {
      const action = requirementRecord(item, "场景动作");
      const actorId = text(action.actorId, "动作主体 ID");
      if (!allowed.has(actorId)) throw new RequirementContractError("REQUIREMENT_CAST_CONFLICT", "场景动作引用了未选中的人物");
      performed.add(actorId);
      return { actorId, description: text(action.description, "完整可拍行为", 6), source: `${source}/productionContract/actions/${index}` };
    });
    if (!actions.length) throw new RequirementContractError("REQUIREMENT_SCENE_UNVERIFIED", `${source} 没有结构化动作，不能用泛化动词补位`);
    if (props.length && physical.noPropsReason !== undefined) {
      throw new RequirementContractError("REQUIREMENT_SCENE_UNVERIFIED", `${source} 同时声明有道具和无道具理由`);
    }
    const noPropsReason = props.length ? null : text(physical.noPropsReason, "无可见道具的明确理由", 8);
    const keyElements = array(node.keyElements, `${source}/keyElements`).map(item => text(item, "场景关键元素"));
    if (!keyElements.length) throw new RequirementContractError("REQUIREMENT_SCENE_UNVERIFIED", `${source} 缺少可见关键元素`);
    return { id, source, duration, purpose: text(node.purpose, "完整场景目的"), keyElements, props, actions, noPropsReason };
  });
  for (const character of cast.characters) {
    if (!performed.has(String(character.id))) throw new RequirementContractError("REQUIREMENT_CAST_UNVERIFIED", "选中的出镜人物没有任何结构化动作");
  }
  const total = scenes.reduce((sum, scene) => sum + scene.duration, 0);
  const declared = structure.totalDuration, target = Number(targetDuration);
  if (typeof declared !== "number" || !Number.isFinite(declared)
    || Math.abs(total - declared) > SCENE_SUM_ARITHMETIC_TOLERANCE_SECONDS
    || (Number.isFinite(target) && target > 0 && !withinTargetDurationTolerance(total, target))
    || structure.sceneCount !== scenes.length) {
    // Fixed numeric fields only: diagnostics must never expose scene prose, cast,
    // source stories or the private authority appended to the model transport.
    const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
    const details = Object.freeze({ nodeCount: scenes.length, declaredSceneCount: number(structure.sceneCount),
      durationSum: number(total), declaredTotalDuration: number(declared), targetDuration: Number.isFinite(target) && target > 0 ? target : null,
      declaredDurationDelta: typeof declared === "number" ? number(total - declared) : null,
      targetDurationDelta: Number.isFinite(target) && target > 0 ? number(total - target) : null,
      targetDurationToleranceSeconds: TARGET_DURATION_TOLERANCE_SECONDS });
    throw withValidationFacts(new RequirementContractError("REQUIREMENT_SCENE_UNVERIFIED",
      `场景节点数、声明总时长或目标总时长（允许 ±${TARGET_DURATION_TOLERANCE_SECONDS}s）不一致；numeric ${JSON.stringify(details)}`), details);
  }
  return scenes;
}

export function bindRequirementContract(
  originalValue: unknown, discoveryValue: unknown, upstreamValue: unknown, metadataValue: unknown, expectedCastHash: string,
  expectedOwnerAudience: string | null
): RequirementRecord {
  const original = requirementRecord(originalValue, "ProfileResolver 完成后的需求清单");
  const discovery = requirementRecord(discoveryValue, "需求洞察结果");
  const upstream = requirementRecord(upstreamValue, "上游创意字段");
  const metadata = requirementRecord(metadataValue, "当前运行 metadata");
  const cast = requirementCast(metadata);
  if (cast.hash !== expectedCastHash) throw new RequirementContractError("REQUIREMENT_CAST_CHANGED", "洞察前后权威人物合同发生变化");
  const scenes = requirementScenes(discovery.sceneStructure, cast, upstream.duration_sec);
  const brief = metadata.brief === undefined ? {} : requirementRecord(metadata.brief, "客户 Brief");
  const ownerAudience = expectedOwnerAudience;
  if (ownerAudience !== null && brief.audience !== ownerAudience) {
    throw new RequirementContractError("REQUIREMENT_AUDIENCE_CHANGED", "客户原始受众口径被生成内容覆盖");
  }
  const props = scenes.flatMap(scene => scene.props), actions = scenes.flatMap(scene => scene.actions);
  if (typeof brief.product === "string" && brief.product.trim() && !props.length) {
    throw new RequirementContractError("REQUIREMENT_SCENE_UNVERIFIED", "商品片没有任何真实结构化物理道具");
  }
  const payload: Omit<RequirementContract, "hash"> = {
    schemaVersion: REQUIREMENT_CONTRACT_VERSION, status: "ready-for-g3" as const, cast, ownerAudience,
    modelAudienceHypothesis: structuredClone(discovery.audienceProfile ?? null), scenes, props, actions,
    sceneStructureHash: requirementHash(discovery.sceneStructure)
  };
  const contract: RequirementContract = { ...payload, hash: requirementHash(payload) };
  const originalKeyPoints = original.keyPoints === undefined ? [] : array(original.keyPoints, "原始 keyPoints");
  // This same object continues through G3, PRD and script metadata; it is not a display-only correction.
  metadata._workloomRequirementContract = contract;
  return {
    ...original,
    characters: structuredClone(cast.characters),
    ...(ownerAudience ? { targetAudience: ownerAudience } : {}),
    inferredAudienceProfile: structuredClone(discovery.audienceProfile ?? null),
    _workloomRequirementContract: contract,
    keyPoints: [...originalKeyPoints, `[本次结构化需求契约 ${REQUIREMENT_CONTRACT_VERSION}] ${JSON.stringify(contract)}`]
  };
}

export function verifiedRequirementContract(listValue: unknown, metadataValue: unknown, discoveryValue: unknown): RequirementContract {
  const list = requirementRecord(listValue, "G3 需求清单");
  const metadata = requirementRecord(metadataValue, "G3 metadata");
  const discovery = requirementRecord(discoveryValue, "G3 洞察结果");
  const contract = requirementRecord(list._workloomRequirementContract, "宿主需求合同") as unknown as RequirementContract;
  const brief = metadata.brief === undefined ? {} : requirementRecord(metadata.brief, "G3 Brief");
  const cast = requirementCast(metadata);
  const scenes = requirementScenes(discovery.sceneStructure, cast);
  const { hash, ...payload } = contract;
  if (contract.schemaVersion !== REQUIREMENT_CONTRACT_VERSION || contract.status !== "ready-for-g3"
    || hash !== requirementHash(payload) || requirementHash(metadata._workloomRequirementContract) !== requirementHash(contract)
    || requirementHash(cast) !== requirementHash(contract.cast) || requirementHash(list.characters) !== requirementHash(cast.characters)
    || requirementHash(discovery.sceneStructure) !== contract.sceneStructureHash
    || requirementHash(scenes) !== requirementHash(contract.scenes)
    || requirementHash(scenes.flatMap(scene => scene.props)) !== requirementHash(contract.props)
    || requirementHash(scenes.flatMap(scene => scene.actions)) !== requirementHash(contract.actions)
    || (contract.ownerAudience !== null && brief.audience !== contract.ownerAudience)) {
    throw new RequirementContractError("REQUIREMENT_CONTRACT_CHANGED", "G3 与下游消费的合同或其来源发生变化");
  }
  return contract;
}

export function renderRequirementContract(contract: RequirementContract, metadata: RequirementRecord): string {
  const brief = metadata.brief === undefined ? {} : requirementRecord(metadata.brief, "Brief");
  const characters = contract.cast.characters.map(character => `- ${String(character.name)}（ID ${String(character.id)}；角色 ${String(character.role)}）`);
  const scenes = contract.scenes.map(scene => `### ${scene.id}（${scene.duration}s）\n\n${scene.purpose}\n\n关键元素：${scene.keyElements.join("、")}\n\n来源：${scene.source}`);
  const props = contract.props.map(prop => `- ${prop.name}：${prop.description}（来源 ${prop.source}）`);
  const actions = contract.actions.map(action => `- ${action.actorId}：${action.description}（来源 ${action.source}）`);
  const absentProps = contract.scenes.filter(scene => scene.noPropsReason).map(scene => `- ${scene.id} 明确无可见道具：${scene.noPropsReason}`);
  return `\n\n---\n\n## 四、需求契约（同一结构继续进入 PRD、剧本与镜头卡）\n\n`
    + `状态：结构已形成，等待本次 G3 真实审核；不代表事实或影片已经通过。\n\n`
    + `### 角色（${contract.cast.characters.length}）\n\n${characters.length ? characters.join("\n") : "明确无人：宿主选角凭据 mode=none。"}\n\n`
    + `人物档案、语气与行为约束完整保留如下，仅用于角色表达，不作为道具或商品事实：\n\n\`\`\`json\n${JSON.stringify({ selection: contract.cast.selection, characters: contract.cast.characters }, null, 2)}\n\`\`\`\n\n`
    + `${scenes.join("\n\n")}\n\n### 道具（${contract.props.length}）\n\n${props.join("\n")}${absentProps.length ? `\n${absentProps.join("\n")}` : ""}\n\n`
    + `### 动作（${contract.actions.length}）\n\n${actions.join("\n")}\n\n`
    + `## 五、权威口径与推测边界\n\n- 客户受众原文：${contract.ownerAudience ?? "客户未显式指定；模型细分仍为待审核推测"}\n`
    + `- 模型受众细分仅为推测，不覆盖客户 Brief，不构成真实市场数据。\n`
    + `- 时长 ${String(brief.duration ?? "未指定")}s / 画幅 ${String(brief.aspectRatio ?? brief.aspect_ratio ?? "未指定")} / 平台 ${String(brief.platform ?? "未指定")}\n`
    + `- 合同摘要：${contract.hash}；场景结构摘要：${contract.sceneStructureHash}\n`
    + `- 商品事实是否已被本次审核覆盖，仍由真实 G3 结合宿主提供的本次 G1 证据判断；本合同不产生事实通过凭据。\n`;
}

export function structuredSceneInstructions(cast: RequirementCast, audience: unknown): string {
  return `\n\n## 宿主结构化需求合同（本次 SceneArchitect 同一响应，不新增提取调用）\n`
    + `唯一出镜人物：${JSON.stringify(cast.characters.map(character => ({ id: character.id, name: character.name, role: character.role })))}。`
    + `动作 actorId 只能是这些 ID；非人物动作可用 "$product"（商品）或 "$scene"（环境）。\n`
    + `客户受众原文：${typeof audience === "string" ? audience : "未显式指定"}。不得把模型年龄/性别推测当作客户要求。\n`
    + `自行决定开场、零个或多个主体节点和结尾；sceneCount 必须等于 opening + scenes.length + ending 的真实节点总数；节点时长之和必须等于 totalDuration，并位于目标时长 ±${TARGET_DURATION_TOLERANCE_SECONDS} 秒内。\n`
    + `每个 opening、scenes[i]、ending 必须在原有 duration/purpose/keyElements 字段之外，直接输出 productionContract：\n`
    + `有可见道具时：{"props":[{"name":"镜头中实际可见的物体","description":"这个物体的可见形态或本场用途"}],"actions":[{"actorId":"所选人物ID或$product/$scene","description":"完整可拍的动作过程、对象和结果，至少6字"}]}\n`
    + `确实无可见道具时：{"props":[],"actions":[{"actorId":"$scene","description":"云影缓慢移过封闭场地的地面"}],"noPropsReason":"本场只展示环境光影变化，没有独立可见道具"}。有 props 时必须完全省略 noPropsReason，不能填空串或 null；两个示例互斥。\n`
    + `props 必须是当前场景中实际可见的物理对象，不得把性格、语气、摄影、履历、否定规则或人物日常爱好当道具；人物档案里的用品只有本场真正出现才可声明。`
    + `actions 不能只填“起身”“看向”等孤立动词；每个所选出镜人物至少在一个节点有明确动作。每个节点至少一个动作；真正没有可见道具时才允许显式空props并说明原因。`
    + `完整保留场景目的和约束，不截断，不虚构额外人物；商品参数和部件事实必须能由本次商品事实证据支持，未知项不得靠人物设定补齐。\n`;
}

/** Derive constraints from the exact effective schema; this never allocates a scene. */
export function structuredSceneTiming(schemaValue: unknown, targetDuration: number) {
  const unsupported = (): never => { throw new RequirementContractError("REQUIREMENT_SCHEMA_UNSUPPORTED", "场景时长边界或数量边界不是可派生的有效范围"); };
  const properties = requirementRecord(requirementRecord(schemaValue, "场景时长 schema").properties, "场景时长 properties");
  const bounds = (nodeValue: unknown) => {
    const node = requirementRecord(nodeValue, "场景时长节点");
    const duration = requirementRecord(requirementRecord(node.properties, "节点 properties").duration, "节点 duration");
    const minimum = duration.minimum, maximum = duration.maximum;
    if (duration.type !== "number" || typeof minimum !== "number" || !Number.isFinite(minimum) || minimum <= 0
      || typeof maximum !== "number" || !Number.isFinite(maximum) || maximum < minimum) return unsupported();
    return Object.freeze({ minimum, maximum });
  };
  const opening = bounds(properties.opening), ending = bounds(properties.ending);
  const middleSchema = requirementRecord(properties.scenes, "主体场景时长 schema"), middle = bounds(middleSchema.items);
  const minimum = middleSchema.minItems, maximum = middleSchema.maxItems;
  if (typeof minimum !== "number" || !Number.isSafeInteger(minimum) || minimum < 0
    || typeof maximum !== "number" || !Number.isSafeInteger(maximum) || maximum < minimum) return unsupported();
  if (!Number.isFinite(targetDuration) || targetDuration <= 0) {
    throw new RequirementContractError("REQUIREMENT_SCENE_UNVERIFIED", "场景目标时长不是有效正数");
  }
  const feasibleMiddleCounts: number[] = [];
  for (let count = minimum; count <= maximum; count++) {
    const lower = opening.minimum + ending.minimum + count * middle.minimum;
    const upper = opening.maximum + ending.maximum + count * middle.maximum;
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) return unsupported();
    // A count is feasible when its schema-derived duration interval intersects
    // the accepted target band, not only the exact target point.
    const acceptedMinimum = targetDuration - TARGET_DURATION_TOLERANCE_SECONDS;
    const acceptedMaximum = targetDuration + TARGET_DURATION_TOLERANCE_SECONDS;
    if (lower <= acceptedMaximum && upper >= acceptedMinimum) feasibleMiddleCounts.push(count);
  }
  if (!feasibleMiddleCounts.length) {
    throw new RequirementContractError("REQUIREMENT_SCENE_UNVERIFIED",
      `本次 schema 时长边界内没有满足目标 ±${TARGET_DURATION_TOLERANCE_SECONDS} 秒容差的节点数量`);
  }
  return Object.freeze({ targetDuration,
    targetToleranceSeconds: TARGET_DURATION_TOLERANCE_SECONDS,
    arithmeticToleranceSeconds: SCENE_SUM_ARITHMETIC_TOLERANCE_SECONDS,
    opening, middle, ending,
    middleCount: Object.freeze({ minimum, maximum }), feasibleMiddleCounts: Object.freeze(feasibleMiddleCounts) });
}

/** Correct only the pinned vendor-generated suffix, never matching customer text. */
export function structuredScenePrompt(value: unknown, inputValue: unknown, schemaValue: unknown): string {
  if (typeof value !== "string") throw new RequirementContractError("REQUIREMENT_VENDOR_UNAVAILABLE", "原始场景 prompt 不是文本");
  const input = requirementRecord(inputValue, "SceneArchitect 输入");
  const duration = input.duration_sec || 45, target = Number(duration);
  if (!["string", "number"].includes(typeof duration) || !Number.isFinite(target) || target <= 0) {
    throw new RequirementContractError("REQUIREMENT_SCENE_UNVERIFIED", "场景目标时长不是有效正数");
  }
  const count = Math.min(Math.max(Math.ceil(target / 15), 2), 8);
  const countLine = `请设计 ${count} 个场景（含开场和结尾），总时长约 ${duration} 秒。`;
  const example = `{"opening":{"duration":10,"purpose":"开场目的 —— 观众第一眼看到什么？为什么会被吸引？","keyElements":["元素1","元素2"]},"scenes":[{"index":1,"duration":10,"purpose":"场景目的 —— 如果删掉这镜，故事会损失什么？","keyElements":["元素1","元素2"],"emotionalBeat":"setup"}],"ending":{"duration":10,"purpose":"结尾目的 —— 观众离开时会记住什么？","keyElements":["元素1","元素2"]},"totalDuration":${duration},"sceneCount":${count},"narrativeArc":"linear"}`;
  // The suffix begins after description and the type's film grammar. Matching the
  // whole terminal suffix keeps identical literals inside either source intact.
  const suffix = `${countLine}

输出 JSON 格式（严格遵守，只输出合法 JSON，不要 markdown 代码块）：
${example}

要求：
1. 所有场景时长之和 ≈ ${duration} 秒
2. 每个场景必须有 emotionalBeat（从枚举中选一个：setup/rising/climax/falling/resolution/twist）
3. 场景按叙事节奏排列：setup → rising → climax → resolution
4. 关键元素 1-3 个
5. purpose 必须具体、电影化，避免"推动叙事发展"这种泛化描述。要回答：观众看到了什么具体画面？感受到了什么情绪？为什么继续看？
6. 只输出 JSON，不要任何解释文字

【结构心法——三幕呼吸法】
1. opening（前3秒抓眼）：第一帧即悬念——把全片最大的矛盾浓缩成一个画面（巨大vs渺小/颤抖的手vs一整车安危），禁止平铺直叙的建立镜头。
2. 每个 scenes[i].purpose 必须写'删掉这镜故事会损失什么'——答不上来就说明这镜该删。
3. 情绪弧线必须有'换气口'：高潮(climax)之后、结尾(ending)之前，安排一个 falling 级的留白场景（3-6秒），让最后的释放有落差。60秒短片没有喘息就是噪音。
4. ending 必须落到'一个特写+一句台词'的收束结构：观众最后记住的永远是一个细节，不是一个道理。
5. keyElements 只写能被镜头拍到的物理元素，禁止'氛围''感觉'类词。

【时长铁律】所有场景时长之和≈目标时长；climax 场景时长必须≥任一其他场景的1.3倍——重点不突出等于没有重点。`;
  if (!value.endsWith(`\n\n${suffix}`)) {
    throw new RequirementContractError("REQUIREMENT_VENDOR_UNAVAILABLE", "原始场景生成段不再匹配受控字段位置");
  }
  let schema: string;
  try { schema = JSON.stringify(requirementRecord(schemaValue, "本次实际 SceneArchitect schema")); }
  catch { throw new RequirementContractError("REQUIREMENT_SCHEMA_UNSUPPORTED", "本次实际场景 schema 无法完整序列化"); }
  const timing = structuredSceneTiming(schemaValue, target);
  const fallingMinimum = Math.max(3, timing.middle.minimum), fallingMaximum = Math.min(6, timing.middle.maximum);
  const fallingRange = fallingMinimum <= fallingMaximum
    ? `${fallingMinimum}-${fallingMaximum}秒，遵守主体节点 schema 边界`
    : `${timing.middle.minimum}-${timing.middle.maximum}秒内自行决定；原节奏建议与本次 schema 无合法交集`;
  const correctedTail = suffix.slice(suffix.indexOf(example) + example.length)
    .replace("falling 级的留白场景（3-6秒）", `falling 级的留白场景（${fallingRange}）`);
  const guidance = `场景数量与逐节点时长由本次模型根据叙事自行决定，不采用固定数量或预制镜头。scenes 数组只包含主体节点，opening 和 ending 各为一个独立节点。`;
  const contract = `本次实际 SceneArchitect 响应 JSON Schema（完整适用，不是示例成品）：\n${schema}\n`
    + `本次 schema 派生时长边界与可行数量（仅约束，不分配节点）：\n${JSON.stringify(timing)}\n`
    + `以下精确结构约束优先于本段其余“约/≈”表述：sceneCount 必须等于 2 + scenes.length；所有节点 duration 之和必须等于 totalDuration（算术容差 ${SCENE_SUM_ARITHMETIC_TOLERANCE_SECONDS} 秒），并位于目标 ${target} 秒 ±${TARGET_DURATION_TOLERANCE_SECONDS} 秒内。`
    + `逐节点内容、数量和时长仍由本次模型创作，输出前核对节点数与时长之和；不得用预制节点或返回后补值替代。`;
  const exampleAt = suffix.indexOf(example);
  return value.slice(0, value.length - suffix.length) + guidance
    + suffix.slice(countLine.length, exampleAt) + contract + correctedTail;
}

/** Extend the schema supplied to the existing SceneArchitect run, preserving its other fields. */
export function structuredSceneSchema(value: unknown): RequirementRecord {
  const schema = structuredClone(requirementRecord(value, "SceneArchitect schema"));
  const properties = requirementRecord(schema.properties, "场景 schema.properties");
  const physical = {
    type: "object", required: ["props", "actions"], additionalProperties: false,
    properties: {
      props: { type: "array", items: { type: "object", required: ["name", "description"], properties: { name: { type: "string", minLength: 1 }, description: { type: "string", minLength: 4 } }, additionalProperties: false } },
      actions: { type: "array", minItems: 1, items: { type: "object", required: ["actorId", "description"], properties: { actorId: { type: "string", minLength: 1 }, description: { type: "string", minLength: 6 } }, additionalProperties: false } },
      noPropsReason: { type: "string", minLength: 8 }
    }
  };
  const extend = (value: unknown) => {
    const node = requirementRecord(value, "场景节点 schema");
    const nodeProperties = requirementRecord(node.properties, "场景节点 properties");
    const purpose = requirementRecord(nodeProperties.purpose, "场景 purpose schema");
    // Completeness takes precedence over the old 100-character advisory ceiling.
    // The minimum and every other existing field/enum/duration bound remain enforced.
    delete purpose.maxLength;
    node.properties = { ...nodeProperties, productionContract: structuredClone(physical) };
    node.required = [...new Set([...array(node.required, "场景 required").map(String), "productionContract"])];
  };
  extend(properties.opening);
  extend(properties.ending);
  const middle = requirementRecord(properties.scenes, "主体场景 schema");
  extend(middle.items);
  middle.minItems = 0;
  return schema;
}
