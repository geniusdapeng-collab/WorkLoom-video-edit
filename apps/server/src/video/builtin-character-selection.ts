/** Video-domain casting: the verified industry registry supplies defaults, never a remembered name. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { bundlesRoot, loadVerifiedBundleManifest } from "@workloom/base/bundles";
import { shotIntentHash, shotText, splitShotAssertions } from "@hyperreality/video-studio";

type Json = Record<string, unknown>;
interface BuiltinModel { id: string; name: string; ordinal: number; aliases: string[]; archive: string; profile: Json; profilePath: string; profileSha256: string }
interface Catalog { models: BuiltinModel[]; defaultModel: BuiltinModel; registryPath: string; registrySha256: string }
export class BuiltinCharacterSelectionError extends Error {
  constructor(message: string, readonly kind: "selection" | "catalog") { super(message); this.name = "BuiltinCharacterSelectionError"; }
}
export interface BuiltinCharacterResolution {
  mode: "builtin" | "custom" | "mixed" | "none";
  characters: Json[];
  builtinIds: string[];
  decision: {
    schemaVersion: "workloom.video-character-selection/v1";
    mode: "builtin" | "custom" | "mixed" | "none"; reason: string;
    registryPath: string | null; registrySha256: string | null;
    characters: Array<{ id: string; name: string; ordinal: number | null; source: "builtin" | "explicit-custom"; profilePath: string | null; profileSha256: string }>;
  };
}
const plain = (value: unknown): value is Json => Boolean(value && typeof value === "object" && !Array.isArray(value));
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const key = (value: string): string => value.trim().toLocaleLowerCase("en-US");
function invalid(message: string): never { throw new BuiltinCharacterSelectionError(message, "selection"); }
const SOURCE_FIELDS = ["id", "name", "ordinal", "kind", "subjectType", "identity", "appearance", "wardrobe", "activeWardrobeId", "persona", "biography", "speakingStyle", "behavioralRules", "relations", "authorization"] as const;

function loadCatalog(root: string): Catalog {
  try {
    const manifest = loadVerifiedBundleManifest("ai-video", root);
    const assets = manifest.integrity?.assets;
    if (!assets) throw new Error("角色目录必须属于带完整性摘要的行业包");
    const bundleDir = realpathSync(path.resolve(root, "ai-video"));
    const readAsset = (relative: string): { value: Json; file: string; sha256: string } => {
      if (!relative.startsWith("library/characters/") || relative.includes("\\") || relative.split("/").some(part => !part || part === "." || part === "..")) throw new Error("角色资产路径越出受控目录");
      const expected = assets[relative];
      if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`角色资产未登记完整性摘要：${relative}`);
      const file = path.resolve(bundleDir, relative), stat = lstatSync(file);
      if (realpathSync(file) !== file || !stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 8_000_000) throw new Error(`角色资产不是可读取的受控JSON：${relative}`);
      const bytes = readFileSync(file), sha256 = digest(bytes);
      if (sha256 !== expected || bytes.length !== stat.size) throw new Error(`角色资产字节与行业包不符：${relative}`);
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (!plain(value)) throw new Error(`角色资产结构非法：${relative}`);
      return { value, file, sha256 };
    };
    const registry = readAsset("library/characters/registry.json");
    if (registry.value.schemaVersion !== "workloom.character-registry/v1" || !Array.isArray(registry.value.models) || registry.value.models.length === 0) throw new Error("内置角色registry格式非法");
    const identities = new Set<string>(), ordinals = new Set<number>(), aliases = new Map<string, string>();
    const models = registry.value.models.map((raw): BuiltinModel => {
      if (!plain(raw) || typeof raw.id !== "string" || !raw.id.trim() || typeof raw.name !== "string" || !raw.name.trim()
        || !Number.isSafeInteger(raw.ordinal) || Number(raw.ordinal) < 1 || typeof raw.archive !== "string"
        || (raw.aliases !== undefined && (!Array.isArray(raw.aliases) || raw.aliases.some(alias => typeof alias !== "string" || !alias.trim())))) throw new Error("registry人物标识、编号或别名非法");
      const id = raw.id.trim(), name = raw.name.trim(), ordinal = Number(raw.ordinal);
      if (identities.has(id) || ordinals.has(ordinal)) throw new Error("registry人物ID或编号重复");
      identities.add(id); ordinals.add(ordinal);
      const names = [...new Set([id, name, ...((raw.aliases ?? []) as string[])].map(value => value.trim()))];
      for (const alias of names) { const old = aliases.get(key(alias)); if (old && old !== id) throw new Error(`registry别名存在歧义：${alias}`); aliases.set(key(alias), id); }
      const archive = raw.archive.startsWith("bundles/ai-video/") ? raw.archive.slice("bundles/ai-video/".length) : raw.archive;
      const profile = readAsset(`${archive}/profile.json`);
      if (profile.value.schemaVersion !== "workloom.character-profile/v1" || profile.value.id !== id || profile.value.name !== name || profile.value.ordinal !== ordinal
        || !["generated", "authorized-real", "virtual-preset"].includes(String(profile.value.kind))
        || !plain(profile.value.identity) || !plain(profile.value.appearance) || !Array.isArray(profile.value.wardrobe)
        || profile.value.wardrobe.some(item => !plain(item))) throw new Error(`内置角色档案与registry不一致：${id}`);
      if (profile.value.activeWardrobeId !== undefined && (typeof profile.value.activeWardrobeId !== "string" || !profile.value.activeWardrobeId.trim()
        || profile.value.wardrobe.filter(item => item.id === profile.value.activeWardrobeId).length !== 1)) throw new Error(`内置角色当前服装未唯一匹配：${id}`);
      return { id, name, ordinal, aliases: names, archive, profile: profile.value, profilePath: profile.file, profileSha256: profile.sha256 };
    });
    const defaultModel = models.find(model => model.id === registry.value.defaultModel);
    if (!defaultModel || defaultModel.ordinal !== 1) throw new Error("registry.defaultModel必须唯一指向当前1号模特");
    return { models, defaultModel, registryPath: registry.file, registrySha256: registry.sha256 };
  } catch (error) {
    throw new BuiltinCharacterSelectionError(`内置角色目录不可核实：${error instanceof Error ? error.message : String(error)}`, "catalog");
  }
}

function positiveIntent(raw: string): string {
  return splitShotAssertions(raw.replace(/不用|不采用|不选用|不选择|弃用|排除/g, "不要")).positive;
}
function chineseOrdinal(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  const numbers: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return numbers[value] ?? null;
}
function ordinalText(value: string): number | null {
  const match = /^(?:第\s*)?([0-9]{1,3}|[一二两三四五六七八九十])\s*号(?:\s*(?:模特|演员|人物|角色))?$/.exec(value.trim());
  return match ? chineseOrdinal(match[1]!) : null;
}
function emptySelector(value: unknown): boolean { return value === undefined || value === null || (typeof value === "string" && !value.trim()) || (plain(value) && Object.keys(value).length === 0); }
function completeCustom(value: unknown): value is Json {
  return plain(value) && typeof (value.id ?? value.character_id) === "string" && String(value.id ?? value.character_id).trim().length > 0
    && typeof value.name === "string" && value.name.trim().length > 0
    && ((typeof value.description === "string" && value.description.trim().length >= 8) || (plain(value.identity) && plain(value.appearance) && Object.keys(value.appearance).length > 0));
}
function mentionsBuiltin(model: BuiltinModel, positive: string): boolean {
  return model.aliases.some(alias => alias.length > 1 && (/[\u3400-\u9fff]/.test(alias) ? positive.includes(alias)
    : new RegExp(`(?<![A-Za-z0-9_-])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`, "i").test(positive)));
}
function noPerson(rawIntent: string, metadata: Json, brief: Json, hasNamedActor: () => boolean): boolean {
  const fields = [metadata, brief];
  const explicit = fields.some(item => item.hasPerson === false || item.noCharacters === true || item.includeCharacters === false
    || (plain(item.subject) && (item.subject.hasPerson === false || item.subject.count === 0 || ["none", "object", "product", "environment", "landscape", "animal"].includes(String(item.subject.kind))))
    || [item.character, item.modelCharacter].some(value => typeof value === "string" && /^(?:none|无|无人|无人物|无角色)$/i.test(value.trim())));
  const global = /全(?:片|程)(?:都)?(?:无人|无人物|无角色|空镜)|纯(?:产品|商品|风景|空镜)|只(?:拍|要|有)(?:产品|商品|风景|空镜)|不出现(?:任何)?(?:人物|人类|角色)|(?:不要|无需|不需要)(?:任何)?(?:人物|模特|角色)(?:出镜)?|\b(?:no (?:people|person|human|characters?)|product[- ]only)\b/i.test(rawIntent);
  if (explicit || global) return true;
  return /无人(?!机)|无人物|无角色|空镜/.test(rawIntent)
    && !/出镜|口播|演员|模特|女主|男主|主讲/.test(positiveIntent(rawIntent)) && !hasNamedActor();
}

/** Resolve only video actors. metadata.modelId remains a provider model setting. */
export function resolveBuiltinCharacters(rawIntent: string, metadata?: Json, options: { bundleRoot?: string } = {}): BuiltinCharacterResolution {
  const data = metadata ?? {}, brief = plain(data.brief) ? data.brief : {};
  const singles: unknown[] = [];
  const rosters: unknown[][] = [];
  for (const source of [data, brief]) {
    for (const field of ["character", "modelCharacter"] as const) if (!emptySelector(source[field]) && !(typeof source[field] === "string" && /^(?:none|无|无人|无人物|无角色)$/i.test(String(source[field]).trim()))) singles.push(source[field]);
    const scalar: Json = {};
    for (const [field, target] of [["characterId", "id"], ["characterName", "name"], ["characterOrdinal", "ordinal"], ["modelOrdinal", "ordinal"]] as const) {
      if (source[field] !== undefined && source[field] !== null && source[field] !== "") {
        if (scalar[target] !== undefined && scalar[target] !== source[field]) invalid("同一角色有冲突的编号声明");
        scalar[target] = source[field];
      }
    }
    if (Object.keys(scalar).length) singles.push(scalar);
    if (source.characters !== undefined && source.characters !== null) {
      if (!Array.isArray(source.characters) || source.characters.length > 10) invalid("characters必须是最多10个人物的数组");
      if (source.characters.length) rosters.push(source.characters);
    }
  }
  const positive = positiveIntent(rawIntent);
  let catalogCache: Catalog | undefined;
  const catalogFor = () => catalogCache ??= loadCatalog(options.bundleRoot ?? bundlesRoot());
  const hasNamedActor = () => singles.length > 0 || rosters.length > 0
    || /(?:使用|采用|选用|选择|用|选)\s*(?:第\s*)?[0-9一二两三四五六七八九十]+\s*号/.test(positive)
    || catalogFor().models.some(model => mentionsBuiltin(model, positive));
  const absent = noPerson(rawIntent, data, brief, hasNamedActor)
    || (!singles.length && !rosters.length && /风景|风光|自然景观|\blandscape\b/i.test(positive) && !/出镜|口播|演员|模特|女主|男主|主讲/.test(positive) && !hasNamedActor());
  if (absent && (singles.length > 0 || rosters.length > 0)) invalid("明确无人/纯产品要求与具体出镜人选冲突");
  if (absent && /(?:[0-9一二两三四五六七八九十]+\s*号\s*(?:模特|演员|角色|人物)|出镜|出演|主讲|女主|男主)/.test(positiveIntent(rawIntent))) invalid("明确无人/纯产品要求与原文出镜人选冲突");
  if (absent) return { mode: "none", characters: [], builtinIds: [], decision: { schemaVersion: "workloom.video-character-selection/v1", mode: "none", reason: "原始需求明确无人，保留无人流程", registryPath: null, registrySha256: null, characters: [] } };
  const catalog = catalogFor();
  const custom = new Map<string, Json>();
  for (const roster of rosters) for (const item of roster) if (completeCustom(item)) {
    const id = String(item.id ?? item.character_id).trim();
    if (custom.has(id) && shotIntentHash(custom.get(id)) !== shotIntentHash(item)) invalid(`自定义角色重复且内容冲突：${id}`);
    custom.set(id, item);
  }
  const builtin = (value: unknown): BuiltinModel | null => {
    const fields: Array<[string, unknown]> = typeof value === "number" ? [["ordinal", value]] : typeof value === "string" ? [["token", value]]
      : plain(value) ? ["id", "character_id", "name", "ordinal"].filter(field => value[field] !== undefined && value[field] !== null && value[field] !== "").map(field => [field, value[field]]) : invalid("人物选择必须是ID/姓名/编号或角色对象");
    if (!fields.length) invalid("人物选择缺少ID、姓名或编号");
    let result: BuiltinModel | null = null;
    for (const [field, raw] of fields) {
      let matches: BuiltinModel[];
      if (field === "token" && typeof raw === "string" && /^(?:default|默认(?:模特|人物|角色)?)$/i.test(raw.trim())) {
        matches = [catalog.defaultModel];
      } else if (field === "ordinal" || (field === "token" && typeof raw === "string" && (ordinalText(raw) !== null || /^\d+$/.test(raw.trim())))) {
        const number = field === "ordinal" ? (typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : null)
          : ordinalText(String(raw)) ?? Number(String(raw).trim());
        if (!Number.isSafeInteger(number) || Number(number) < 1) invalid("模特编号必须为正整数");
        matches = catalog.models.filter(model => number === 1 ? model.id === catalog.defaultModel.id : model.ordinal === number);
      } else {
        if (typeof raw !== "string" || !raw.trim()) invalid("人物ID/姓名必须是非空文本");
        matches = catalog.models.filter(model => field === "id" || field === "character_id" ? key(model.id) === key(raw) : model.aliases.some(alias => key(alias) === key(raw)));
      }
      if (matches.length > 1) invalid("人物选择存在歧义");
      if (!matches.length) {
        if (completeCustom(value) && !catalog.models.some(model => [value.id, value.character_id, value.name].some(token => typeof token === "string" && model.aliases.some(alias => key(alias) === key(token))))) return null;
        const customHit = [...custom.values()].filter(item => [item.id, item.character_id, item.name].some(token => typeof token === "string" && key(token) === key(String(raw))));
        if (customHit.length === 1 && fields.every(([entry, token]) => entry === "id" || entry === "character_id" ? token === customHit[0]!.id || token === customHit[0]!.character_id : entry === "name" ? token === customHit[0]!.name : entry === "token" ? token === customHit[0]!.id || token === customHit[0]!.name : false)) return null;
        invalid(`未找到明确指定的内置模特：${String(raw)}`);
      }
      if (result && result.id !== matches[0]!.id) invalid("人物ID、姓名或编号指向不同角色");
      result = matches[0]!;
    }
    return result;
  };
  const rows: Array<{ model: BuiltinModel | null; custom: Json | null }> = [];
  const push = (value: unknown): string => {
    const model = builtin(value);
    if (model && plain(value)) {
      const wardrobes = model.profile.wardrobe as Json[];
      const activeId = model.profile.activeWardrobeId;
      const active = wardrobes.find(wardrobe => wardrobe.id === activeId);
      for (const field of ["wardrobeId", "activeWardrobeId"] as const) if (value[field] !== undefined) {
        if (typeof value[field] !== "string" || !value[field].trim() || value[field] !== activeId || !active) {
          invalid(`内置角色 ${model.name} 的服装选择未绑定当前已激活版本：${String(value[field])}`);
        }
      }
      if (value.wardrobe !== undefined && (!active || (Array.isArray(value.wardrobe)
        ? shotIntentHash(value.wardrobe) !== shotIntentHash(wardrobes)
        : !plain(value.wardrobe) || shotIntentHash(value.wardrobe) !== shotIntentHash(active)))) {
        invalid(`内置角色 ${model.name} 的显式服装与当前已激活版本冲突`);
      }
    }
    const user = model ? null : completeCustom(value) ? value : [...custom.values()].find(item => plain(value) ? [value.id, value.character_id, value.name].some(token => token === item.id || token === item.character_id || token === item.name) : value === item.id || value === item.name) ?? null;
    if (!model && !user) invalid("自定义人物需要完整的ID、姓名和外观/人物描述，不能用默认人选补位");
    const id = model?.id ?? String(user!.id ?? user!.character_id);
    if (!rows.some(row => (row.model?.id ?? String(row.custom!.id ?? row.custom!.character_id)) === id)) rows.push({ model, custom: user });
    return id;
  };
  if (rosters.length) {
    const first = rosters[0]!.map(push);
    if (new Set(first).size !== first.length) invalid("同一出镜人物被重复声明");
    for (const roster of rosters.slice(1)) { const ids = roster.map(push); if (ids.length !== first.length || ids.some(id => !first.includes(id))) invalid("根metadata与brief声明了不同出镜名单"); }
    const primary = new Set<string>();
    for (const item of singles) { const id = push(item); if (!first.includes(id)) invalid("明确主角选择与characters名单冲突"); primary.add(id); }
    if (primary.size > 1) invalid("多个主角选择字段指向不同人物");
    const primaryId = [...primary][0];
    if (primaryId) {
      const position = rows.findIndex(row => (row.model?.id ?? String(row.custom!.id ?? row.custom!.character_id)) === primaryId);
      if (position > 0) rows.unshift(rows.splice(position, 1)[0]!);
    }
  } else {
    for (const item of singles) push(item);
    if (rows.length > 1) invalid("多个单人选择字段指向不同模特；多人项目请使用characters数组");
  }
  const textModels = new Map<string, BuiltinModel>();
  for (const model of catalog.models) if (mentionsBuiltin(model, positive)) textModels.set(model.id, model);
  const ordinalPattern = /(?:第\s*)?([0-9]{1,3}|[一二两三四五六七八九十])\s*号\s*(?:模特|演员|角色|人物)|(?:使用|采用|选用|选择|用|选)\s*(?:第\s*)?([0-9]{1,3}|[一二两三四五六七八九十])\s*号(?!\s*(?:车|机|位|线|店|房|产品|商品))|(?:第\s*)?([0-9]{1,3}|[一二两三四五六七八九十])\s*号\s*(?:出镜|出演)/g;
  const ordinalTokens = [...positive.matchAll(ordinalPattern)].map(match => match[1] ?? match[2] ?? match[3]!);
  if (ordinalText(positive) !== null) ordinalTokens.push(String(ordinalText(positive)));
  for (const token of ordinalTokens) { const model = builtin(chineseOrdinal(token)!); if (model) textModels.set(model.id, model); }
  if (rows.length) {
    const selected = new Set(rows.map(row => row.model?.id ?? String(row.custom!.id ?? row.custom!.character_id)));
    if ([...textModels.keys()].some(id => !selected.has(id))) invalid("原始需求点名的人物与metadata选择冲突");
  } else if (textModels.size > 1) invalid("原始需求中的编号与姓名指向多个模特；请明确characters名单");
  else rows.push({ model: [...textModels.values()][0] ?? catalog.defaultModel, custom: null });
  const characters = rows.map((row, index): Json => {
    if (!row.model) {
      const user = structuredClone(row.custom!);
      return { ...user, id: String(user.id ?? user.character_id), character_id: String(user.id ?? user.character_id), role: user.role ?? (index === 0 ? "protagonist" : "supporting"),
        description: typeof user.description === "string" && user.description.trim() ? user.description : shotText({ identity: user.identity, appearance: user.appearance, persona: user.persona, biography: user.biography }) };
    }
    const model = row.model, fields = Object.fromEntries(SOURCE_FIELDS.filter(field => model.profile[field] !== undefined).map(field => [field, structuredClone(model.profile[field])])) as Json;
    // The library's complete persona keeps these under persona; older profiles use root fields.
    const persona = plain(fields.persona) ? fields.persona : {};
    fields.speakingStyle ??= persona.speakingStyle;
    fields.behavioralRules ??= persona.behavioralRules ?? persona.continuityRules;
    const description = JSON.stringify({ identity: fields.identity, appearance: fields.appearance, wardrobe: fields.wardrobe, persona: fields.persona,
      biography: fields.biography, speakingStyle: fields.speakingStyle, behavioralRules: fields.behavioralRules });
    return { ...fields, ...(typeof fields.activeWardrobeId === "string" ? { wardrobeId: fields.activeWardrobeId } : {}),
      id: model.id, character_id: model.id, name: model.name, ordinal: model.ordinal, role: index === 0 ? "protagonist" : "supporting", description,
      builtinCharacterSource: { profilePath: model.profilePath, profileSha256: model.profileSha256, registrySha256: catalog.registrySha256 } };
  });
  const builtinIds = rows.flatMap(row => row.model ? [row.model.id] : []);
  const mode = builtinIds.length === rows.length ? "builtin" : builtinIds.length ? "mixed" : "custom";
  return { mode, characters, builtinIds, decision: { schemaVersion: "workloom.video-character-selection/v1", mode,
    reason: singles.length || rosters.length || textModels.size ? "按客户明确ID、姓名、编号或完整自定义档案选角" : "未指定人选，读取受控registry.defaultModel",
    registryPath: catalog.registryPath, registrySha256: catalog.registrySha256,
    characters: rows.map((row, index) => ({ id: String(characters[index]!.id), name: String(characters[index]!.name), ordinal: row.model?.ordinal ?? null,
      source: row.model ? "builtin" : "explicit-custom", profilePath: row.model?.profilePath ?? null, profileSha256: row.model?.profileSha256 ?? shotIntentHash(row.custom) })) } };
}

export function applyBuiltinCharacters(metadata: Json | undefined, resolution: BuiltinCharacterResolution): Json {
  const next = { ...(metadata ?? {}), characters: structuredClone(resolution.characters), builtinCharacterSelection: structuredClone(resolution.decision) };
  if (resolution.mode === "none") return { ...next, hasPerson: false, noCharacters: true };
  return next;
}

/** Vendor reads both the text and metadata; both receive the same complete stable contract. */
export function appendBuiltinCharacterGuidance(intent: string, resolution: BuiltinCharacterResolution): string {
  if (resolution.mode === "none") return `${intent}\n[出镜角色合同] 本片明确无人；不新增、猜测或替换任何出镜人物。`;
  return `${intent}\n[出镜角色合同 ${resolution.decision.schemaVersion}] ${JSON.stringify({ selection: resolution.decision, characters: resolution.characters })}`
    + "\n剧本、角色系统、镜头卡、对白说话人及定妆照任务必须保持上述唯一人物ID和姓名，不能改为示例人物或凭旧提示猜测人脸。"
    + "人物的identity/persona/biography/speakingStyle/behavioralRules用于角色语气、偏好和行为表达；虚构人物设定不得当成真人履历、品牌实测、产品性能证据或赛事成绩，营销事实只取本次通过审核的商品事实包。";
}
