import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { loadCharacterEntry, readPortraitArtifact, REQUIRED_PORTRAIT_ANGLES } from "./character-archive.js";
import { assessPortraitDecision, selectPortraitDecisionRecord, type PortraitDecisionRecord } from "./portrait-decision.js";
import { hasExplicitPortraitAuthorization, verifyPortraitOwnerAuthorization } from "./portrait-owner-authorization.js";
import type { ArchivedPortraitCharacters, PortraitInputReceipt } from "./portrait-runtime.js";
import { requirementCast, requirementHash, requirementRecord, type RequirementRecord } from "./requirement-contract.js";

type FileBinding = { path: string; sha256: string };
export interface PrdPortraitSource {
  status: "source-verified-awaiting-current-g5";
  characterId: string;
  name: string;
  role: string;
  portraitVersion: number;
  manifest: FileBinding;
  archiveProfile: PortraitInputReceipt;
  catalogProfile: FileBinding;
  ownerAuthorization: { basis: "explicit-owner-authorization"; decisionOwnerRole: "product-owner"; receipt: FileBinding; ledger: FileBinding };
  originals: Record<string, PortraitInputReceipt>;
}
export interface PrdPortraitReferenceSelection {
  characterId: string;
  portraitVersion: number;
  angles: string[];
}

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
function invalid(message: string): never { throw new Error(`PRD_PORTRAIT_SOURCE_UNVERIFIED: ${message}`); }

function readEvidence(file: string, expectedSha256?: string): { binding: FileBinding; bytes: Buffer } {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || realpathSync(file) !== file) invalid("来源文件路径未规范或经过符号链接");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 2_000_000) invalid("来源文件不在证据读取范围内");
  const bytes = readFileSync(file), sha256 = digest(bytes);
  if (bytes.length !== stat.size || realpathSync(file) !== file || (expectedSha256 !== undefined && sha256 !== expectedSha256)) {
    invalid("来源文件字节、路径或摘要已变化");
  }
  return { binding: { path: file, sha256 }, bytes };
}

function verifyOriginals(originals: Record<string, PortraitInputReceipt>): void {
  if (Object.keys(originals).length !== REQUIRED_PORTRAIT_ANGLES.length) invalid("原始定妆照角度不完整");
  for (const angle of REQUIRED_PORTRAIT_ANGLES) {
    const source = originals[angle];
    if (!source || source.path !== source.realPath || requirementHash(readPortraitArtifact(source.path)) !== requirementHash(source)) {
      invalid(`原始定妆照 ${angle} 与清单不一致`);
    }
  }
}

export function preparePrdPortraitReferenceSelection(value: unknown,
  sources: readonly PrdPortraitSource[]): PrdPortraitReferenceSelection | undefined {
  if (value === undefined) return undefined;
  const selection = requirementRecord(value, "客户冻结定妆参考选择");
  const { characterId, portraitVersion, angles } = selection;
  if (Object.keys(selection).length !== 3 || typeof characterId !== "string"
    || typeof portraitVersion !== "number" || !Number.isSafeInteger(portraitVersion)
    || !Array.isArray(angles) || !angles.length || new Set(angles).size !== angles.length
    || angles.some(angle => typeof angle !== "string" || !REQUIRED_PORTRAIT_ANGLES.some(valid => valid === angle))) {
    invalid("定妆参考选择必须明确人物 ID、版本与无重复的有序角度");
  }
  const matched = sources.filter(source => source.characterId === characterId && source.portraitVersion === portraitVersion);
  if (matched.length !== 1 || angles.some(angle => !Object.hasOwn(matched[0]!.originals, angle))) {
    invalid("冻结定妆参考选择缺少本次相同人物、版本与原始字节用途授权");
  }
  return { characterId, portraitVersion, angles: [...angles] };
}

/** Only host-configured, case-bound archives with current owner use evidence are reportable before G5. */
export function preparePrdPortraitSources(archive: ArchivedPortraitCharacters | undefined, metadata: RequirementRecord): PrdPortraitSource[] {
  if (!archive) return [];
  const selection = archive.approvedSelection;
  if (typeof metadata.customerOriginalIntent !== "string" || !metadata.customerOriginalIntent.trim()
    || selection.rawIntent !== metadata.customerOriginalIntent) invalid("定妆照选择未绑定本次客户原文");
  const manifest = readEvidence(archive.manifestPath, archive.manifestSha256);
  const stored = requirementRecord(JSON.parse(manifest.bytes.toString("utf8")), "定妆照来源清单");
  if (stored.schemaVersion !== "workloom.portrait-reuse-manifest/v1"
    || requirementHash(stored.approvedSelection) !== requirementHash(selection)
    || requirementHash(stored.characters) !== requirementHash(archive.characters)
    || selection.schemaVersion !== "workloom.portrait-reuse-selection/v1"
    || selection.expectedPortraits !== archive.characters.length * REQUIRED_PORTRAIT_ANGLES.length) invalid("本次选择与归档清单不一致");
  const cast = requirementCast(metadata);
  if (archive.characters.length !== cast.characters.length) invalid("定妆照归档人数与本次选角不一致");
  const sources: PrdPortraitSource[] = [];
  for (const item of archive.characters) {
    const character = cast.characters.find(person => person.id === item.id && person.name === item.name);
    if (!character || item.version !== selection.selectedVersion || item.authorization.status !== "synthetic-no-real-person"
      || (character.portraitVersion !== undefined && character.portraitVersion !== item.version)) invalid("定妆照归档身份、版本或用途类型不一致");
    if (!character.builtinCharacterSource) continue; // An archive alone is not governed catalog provenance.
    const catalog = requirementRecord(character.builtinCharacterSource, "当前选角档案");
    if (typeof catalog.profilePath !== "string" || typeof catalog.profileSha256 !== "string") invalid("当前选角档案缺少完整路径或摘要");
    const catalogProfile = readEvidence(catalog.profilePath, catalog.profileSha256).binding;
    const dir = path.dirname(catalogProfile.path), ledgerPath = path.join(dir, "gates.jsonl");
    if (!existsSync(ledgerPath)) continue; // Legacy evidence has no provable owner authorization to project.
    const ledger = readEvidence(ledgerPath);
    const rows = ledger.bytes.toString("utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as PortraitDecisionRecord);
    const gate = selectPortraitDecisionRecord(rows, `portrait:${item.id}:v${item.version}`);
    if (assessPortraitDecision(gate).blocking) invalid("当前角色账本不支持既有定妆照用途");
    if (!gate || !hasExplicitPortraitAuthorization(gate)) continue;
    const entry = loadCharacterEntry(dir, { pinnedVersion: item.version });
    if (!entry || entry.id !== item.id || entry.name !== item.name) invalid("当前人物档案与归档身份不一致");
    const owner = verifyPortraitOwnerAuthorization(gate, { dir, characterId: item.id, version: item.version, files: entry.files });
    if (!owner.ok || !owner.authorization) invalid("当前所有者授权与角色原始字节不一致");
    const profile = readEvidence(item.profile.path, item.profile.sha256);
    const profileData = requirementRecord(JSON.parse(profile.bytes.toString("utf8")), "归档定妆照档案");
    if (profile.bytes.length !== item.profile.bytes || item.profile.realPath !== item.profile.path || profileData.id !== item.id || profileData.name !== item.name) {
      invalid("归档原始档案与本次选角不一致");
    }
    verifyOriginals(item.files);
    for (const angle of REQUIRED_PORTRAIT_ANGLES) {
      if (!owner.authorization.artifacts.some(authorized => authorized.angle === angle && authorized.sha256 === item.files[angle]!.sha256)) {
        invalid(`归档定妆照 ${angle} 没有当前所有者授权的相同字节`);
      }
    }
    const receipt = readEvidence(path.join(dir, "reviews", path.basename(String(gate.evidence!.ownerAcceptance))), String(gate.evidence!.ownerAcceptanceSha256));
    sources.push({ status: "source-verified-awaiting-current-g5", characterId: item.id, name: item.name, role: String(character.role),
      portraitVersion: item.version, manifest: manifest.binding, archiveProfile: structuredClone(item.profile), catalogProfile,
      ownerAuthorization: { basis: owner.authorization.basis, decisionOwnerRole: owner.authorization.decisionOwnerRole,
        receipt: receipt.binding, ledger: ledger.binding }, originals: structuredClone(item.files) });
  }
  return sources;
}

/** G4 review can take minutes; recheck source evidence at each side of that review. */
export function verifyPrdPortraitSources(sources: readonly PrdPortraitSource[] = []): void {
  for (const source of sources) {
    for (const file of [source.manifest, source.catalogProfile, source.archiveProfile, source.ownerAuthorization.ledger, source.ownerAuthorization.receipt]) {
      readEvidence(file.path, file.sha256);
    }
    verifyOriginals(source.originals);
  }
}
