/** Existing owner instructions may be recorded by an agent without claiming a human visual review. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadCharacterEntry, readPortraitArtifact, REQUIRED_PORTRAIT_ANGLES, type CharacterEntry } from "./character-archive.js";

export const EXPLICIT_PORTRAIT_AUTHORIZATION = "explicit-owner-authorization" as const;
export interface PortraitOwnerAuthorization {
  schemaVersion: "workloom.portrait-owner-authorization/v1";
  basis: typeof EXPLICIT_PORTRAIT_AUTHORIZATION;
  characterId: string;
  version: number;
  approved: true;
  decisionOwner: string;
  decisionOwnerRole: "product-owner";
  recordedBy: string;
  statement: string;
  anchor: { kind: "generated-ai-front"; angle: "front"; file: string; sha256: string };
  artifacts: Array<{ angle: string; file: string; sha256: string }>;
}
export interface PortraitOwnerGateRecord {
  stepKey?: string; projectId?: string; via?: string | null; sourceStage?: string | null; approved?: boolean | null;
  evidence?: { basis?: string | null; [key: string]: unknown } | null;
}
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim()) && !value.trim().startsWith("--");
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const localPath = (value: unknown): value is string => text(value) && !isAbsolute(value) && !value.includes("\\")
  && value.split("/").every((part) => Boolean(part) && part !== "." && part !== "..");
const fingerprint = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** New-contract markers survive a missing/changed basis; they must never enter legacy compatibility. */
export function hasExplicitPortraitAuthorization(record: PortraitOwnerGateRecord): boolean {
  const evidence = record.evidence;
  return String(evidence?.basis ?? "").trim().toLowerCase() === EXPLICIT_PORTRAIT_AUTHORIZATION
    || Boolean(evidence && (Object.hasOwn(evidence, "authorization") || Object.hasOwn(evidence, "ownerAcceptanceSha256")));
}

/** Shape checks are also used during ledger selection: a malformed new claim cannot fall back to an older acceptance. */
export function portraitOwnerAuthorizationIssues(value: unknown): string[] {
  if (!plain(value)) return ["缺少明确所有者授权合同"];
  const issues: string[] = [];
  if (value.schemaVersion !== "workloom.portrait-owner-authorization/v1" || value.basis !== EXPLICIT_PORTRAIT_AUTHORIZATION || value.approved !== true) issues.push("授权合同类型、依据或放行值无效");
  if (!text(value.characterId) || /[\\/\u0000-\u001f]/.test(value.characterId) || !Number.isInteger(value.version) || Number(value.version) < 1) issues.push("授权角色或版本无效");
  if (!text(value.decisionOwner) || value.decisionOwnerRole !== "product-owner" || !text(value.recordedBy)
    || String(value.decisionOwner).trim().toLowerCase() === String(value.recordedBy).trim().toLowerCase()) issues.push("须分别记录产品所有者决策人和代录执行人");
  if (!text(value.statement) || value.statement.trim().length < 8) issues.push("缺少既有用途授权原话或依据（至少8字）");
  const anchor = value.anchor;
  if (!plain(anchor) || anchor.kind !== "generated-ai-front" || anchor.angle !== "front" || !localPath(anchor.file) || !sha(anchor.sha256)) issues.push("新AI正面身份锚无效");
  const artifacts = value.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length < REQUIRED_PORTRAIT_ANGLES.length
    || artifacts.some((item) => !plain(item) || !text(item.angle) || !/^[A-Za-z][A-Za-z0-9]*$/.test(item.angle) || !localPath(item.file) || !sha(item.sha256))) {
    issues.push("授权角度及当前字节指纹无效");
  } else {
    if (new Set(artifacts.map((item) => item.angle)).size !== artifacts.length || new Set(artifacts.map((item) => item.file)).size !== artifacts.length) issues.push("授权角度或文件重复");
    if (!REQUIRED_PORTRAIT_ANGLES.every((angle) => artifacts.some((item) => item.angle === angle))) issues.push("授权缺少必需角度");
    const front = artifacts.find((item) => item.angle === "front");
    if (plain(anchor) && (front?.file !== anchor.file || front?.sha256 !== anchor.sha256)) issues.push("身份锚必须是本授权集当前front");
  }
  return issues;
}

export function explicitPortraitGateIssues(record: PortraitOwnerGateRecord): string[] {
  const evidence = record.evidence;
  const authorization = evidence?.authorization;
  const issues = portraitOwnerAuthorizationIssues(authorization);
  if (record.via !== "owner-acceptance" || record.sourceStage !== "owner-acceptance" || record.approved !== true
    || evidence?.advisory === true || evidence?.decisionPolicy === "machine-evidence-only") issues.push("机器或未知来源不能代替所有者决定");
  if (evidence?.basis !== EXPLICIT_PORTRAIT_AUTHORIZATION || !text(evidence?.ownerAcceptance) || !sha(evidence?.ownerAcceptanceSha256)) issues.push("授权门缺少回执路径或完整SHA256");
  if (plain(authorization) && (record.stepKey !== "g5-portrait-confirm" || record.projectId !== `portrait:${authorization.characterId}:v${authorization.version}`
    || evidence?.characterId !== authorization.characterId || evidence?.version !== authorization.version)) issues.push("授权门与角色版本不一致");
  return issues;
}

export function buildPortraitOwnerAuthorization(entry: CharacterEntry, input: {
  decisionOwner: string; recordedBy: string; statement: string; anchorFile: string;
}): PortraitOwnerAuthorization {
  if (!entry.activeSet || entry.verification.status !== "passed") throw new Error(`PORTRAIT_AUTHORIZATION_INVALID: 当前版本未核实：${entry.verification.issues.join("；")}`);
  if (entry.kind === "authorized-real" || entry.activeSet.source === "real-authorized") throw new Error("PORTRAIT_AUTHORIZATION_INVALID: 新AI身份锚授权不能声称真人授权");
  if (!entry.files.front || resolve(input.anchorFile) !== resolve(entry.files.front)) throw new Error("PORTRAIT_AUTHORIZATION_INVALID: 必须显式指定本版本当前front作为新AI身份锚");
  const artifacts = entry.activeSet.angles.map((angle) => {
    const file = entry.files[angle];
    if (!file) throw new Error(`PORTRAIT_AUTHORIZATION_INVALID: 缺少声明角度 ${angle}`);
    const asset = readPortraitArtifact(file, entry.dir);
    if (asset.bytes <= 50_000) throw new Error(`PORTRAIT_AUTHORIZATION_INVALID: ${angle} 必须大于50KB`);
    return { angle, file: relative(entry.dir, asset.path).split(sep).join("/"), sha256: asset.sha256 };
  });
  const front = artifacts.find((item) => item.angle === "front")!;
  const authorization: PortraitOwnerAuthorization = {
    schemaVersion: "workloom.portrait-owner-authorization/v1", basis: EXPLICIT_PORTRAIT_AUTHORIZATION,
    characterId: entry.id, version: entry.activeSet.version, approved: true,
    decisionOwner: input.decisionOwner.trim(), decisionOwnerRole: "product-owner", recordedBy: input.recordedBy.trim(), statement: input.statement.trim(),
    anchor: { kind: "generated-ai-front", angle: "front", file: front.file, sha256: front.sha256 }, artifacts,
  };
  const issues = portraitOwnerAuthorizationIssues(authorization);
  if (issues.length) throw new Error(`PORTRAIT_AUTHORIZATION_INVALID: ${issues.join("；")}`);
  return authorization;
}

/** Refuse redirected output paths before the CLI writes either an owner receipt or its ledger. */
export function assertPortraitOwnerWritePaths(characterDir: string): void {
  if (lstatSync(characterDir).isSymbolicLink() || !lstatSync(characterDir).isDirectory()) throw new Error("PORTRAIT_AUTHORIZATION_PATH_INVALID: 角色目录不能是symlink");
  for (const [file, directory] of [[join(characterDir, "reviews"), true], [join(characterDir, "gates.jsonl"), false]] as const) {
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error(`PORTRAIT_AUTHORIZATION_PATH_INVALID: 授权输出不能重定向：${file}`);
  }
}

const authorizationKey = (value: PortraitOwnerAuthorization): string => JSON.stringify({
  schemaVersion: value.schemaVersion, basis: value.basis, characterId: value.characterId, version: value.version, approved: value.approved,
  decisionOwner: value.decisionOwner, decisionOwnerRole: value.decisionOwnerRole, recordedBy: value.recordedBy, statement: value.statement,
  anchor: { kind: value.anchor.kind, angle: value.anchor.angle, file: value.anchor.file, sha256: value.anchor.sha256 },
  artifacts: value.artifacts.map(({ angle, file, sha256 }) => ({ angle, file, sha256 })).sort((a, b) => a.angle.localeCompare(b.angle)),
});

/** G5 rechecks the sealed receipt, strict active-version loader, every declared angle, and the current AI front. No model is called. */
export function verifyPortraitOwnerAuthorization(record: PortraitOwnerGateRecord, expected: {
  dir: string; characterId: string; version: number | null; files: Record<string, string>;
}): { ok: boolean; issues: string[]; authorization: PortraitOwnerAuthorization | null } {
  const issues = explicitPortraitGateIssues(record);
  if (issues.length) return { ok: false, issues, authorization: null };
  const authorization = record.evidence!.authorization as PortraitOwnerAuthorization;
  try {
    if (authorization.characterId !== expected.characterId || authorization.version !== expected.version) throw new Error("当前出镜角色版本与授权不一致");
    assertPortraitOwnerWritePaths(expected.dir);
    const reviewDir = join(expected.dir, "reviews");
    const receiptFile = join(reviewDir, basename(String(record.evidence!.ownerAcceptance)));
    const stat = lstatSync(receiptFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 1_000_000
      || realpathSync(receiptFile) !== join(realpathSync(reviewDir), basename(receiptFile))) throw new Error("授权回执不是角色reviews中的普通文件");
    const bytes = readFileSync(receiptFile);
    if (bytes.length !== stat.size || fingerprint(bytes) !== record.evidence!.ownerAcceptanceSha256) throw new Error("授权回执完整SHA256不符");
    const receipt: unknown = JSON.parse(bytes.toString("utf8"));
    if (!plain(receipt) || receipt.kind !== "owner-acceptance" || receipt.basis !== EXPLICIT_PORTRAIT_AUTHORIZATION || receipt.approved !== true
      || receipt.characterId !== authorization.characterId || receipt.version !== authorization.version
      || receipt.acceptedBy !== authorization.decisionOwner || receipt.note !== authorization.statement) throw new Error("授权回执身份、依据或决定与门不一致");
    const receiptIssues = portraitOwnerAuthorizationIssues(receipt.authorization);
    if (receiptIssues.length || authorizationKey(receipt.authorization as PortraitOwnerAuthorization) !== authorizationKey(authorization)) throw new Error(`授权门与回执合同不一致：${receiptIssues.join("；")}`);
    if (!Array.isArray(receipt.artifacts) || JSON.stringify(receipt.artifacts) !== JSON.stringify(authorization.artifacts)
      || !Array.isArray(receipt.anchors) || JSON.stringify(receipt.anchors) !== JSON.stringify([authorization.anchor])) throw new Error("授权回执角度或锚点摘要与合同不一致");
    const current = loadCharacterEntry(expected.dir);
    if (!current || current.id !== authorization.characterId || current.activeSet?.version !== authorization.version) throw new Error("授权版本不是当前显式激活版本");
    const currentAuthorization = buildPortraitOwnerAuthorization(current, { decisionOwner: authorization.decisionOwner,
      recordedBy: authorization.recordedBy, statement: authorization.statement, anchorFile: current.files.front ?? "" });
    if (authorizationKey(currentAuthorization) !== authorizationKey(authorization)) throw new Error("当前全部声明角度或新AI front字节与授权不一致");
    if (Object.keys(expected.files).length !== authorization.artifacts.length || authorization.artifacts.some(({ angle, file }) => resolve(expected.files[angle] ?? "") !== resolve(expected.dir, file))) throw new Error("出片实际角度路径与授权集不一致");
  } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
  return { ok: issues.length === 0, issues, authorization };
}
