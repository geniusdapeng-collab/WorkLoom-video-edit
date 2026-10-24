/** 本次明确选用既有合成角色的独立证据；不冒充历史生成或模型视觉审核。 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

type Json = Record<string, unknown>;
export interface ReuseFileReceipt { path: string; realPath: string; sha256: string; bytes: number }
export interface PortraitReuseSelection {
  schemaVersion: "workloom.portrait-reuse-selection/v1";
  rawIntent: string; selectedVersion: number; expectedPortraits: 4; selectedAt: string;
}
export interface ArchivedPortraitCharacters {
  manifestPath: string; manifestSha256: string; approvedSelection: PortraitReuseSelection;
  characters: Array<{ id: string; name: string; aliases?: string[]; version: number;
    authorization: { status: "synthetic-no-real-person" }; profile: ReuseFileReceipt;
    files: Record<string, ReuseFileReceipt>; wardrobe?: Record<string, unknown> }>;
}
export interface PortraitArchiveReuseAcceptance {
  schemaVersion: "workloom.portrait-reuse-acceptance/v1"; projectId: string;
  stage: { status: "completed"; characters: 1; products: 0; completedPortraits: 4; pendingPortraits: 0; reusedPortraits: 4; generatedPortraits: 0 };
  manifest: { path: string; sha256: string }; selectionReceipt: PortraitReuseSelection;
  index: ReuseFileReceipt; profile: ReuseFileReceipt; sources: ReuseFileReceipt[]; outputs: ReuseFileReceipt[];
}
const ANGLES = ["front", "threeQuarter", "closeup", "side"] as const;
function fail(message: string): never { throw new Error(`PORTRAIT_REUSE_UNVERIFIED: ${message}`); }
function object(value: unknown, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} 结构无效`);
  return value as Json;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} 缺失`);
  return value;
}
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function fileReceipt(file: string, maximum = 32_000_000): { receipt: ReuseFileReceipt; bytes: Buffer } {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || realpathSync(file) !== file) fail("文件必须为无符号链接的规范绝对路径");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximum) fail("文件为空、非普通文件或超出读取上限");
  const bytes = readFileSync(file);
  if (bytes.length !== stat.size) fail("读取时文件大小发生变化");
  return { receipt: { path: file, realPath: file, sha256: hash(bytes), bytes: bytes.length }, bytes };
}
function verifyFile(value: unknown, label: string): ReuseFileReceipt {
  const supplied = object(value, label);
  const actual = fileReceipt(text(supplied.path, `${label}.path`)).receipt;
  if (supplied.realPath !== actual.realPath || supplied.sha256 !== actual.sha256 || supplied.bytes !== actual.bytes) fail(`${label} 字节、路径或摘要不符`);
  return actual;
}
function selection(value: unknown): PortraitReuseSelection {
  const item = object(value, "approvedSelection");
  if (item.schemaVersion !== "workloom.portrait-reuse-selection/v1" || !Number.isInteger(item.selectedVersion) || Number(item.selectedVersion) <= 0 || item.expectedPortraits !== 4
    || typeof item.selectedAt !== "string" || !Number.isFinite(Date.parse(item.selectedAt))) fail("缺少本次版本与四角度明确选择快照");
  text(item.rawIntent, "approvedSelection.rawIntent");
  return item as unknown as PortraitReuseSelection;
}
function fourKeys(value: unknown, label: string): Json {
  const item = object(value, label);
  if (Object.keys(item).length !== 4 || ANGLES.some(angle => !Object.hasOwn(item, angle))) fail(`${label} 必须正好包含四个必需角度`);
  return item;
}

/** 仅服务端受控环境变量选择此文件，用户 metadata 不能自行声明复用通过。 */
export function loadPortraitReuseManifest(file: string, expectedSha256?: string): ArchivedPortraitCharacters {
  const { receipt, bytes } = fileReceipt(file, 8_000_000);
  if (expectedSha256 && expectedSha256 !== receipt.sha256) fail("复用 manifest 已改变");
  const manifest = object(JSON.parse(bytes.toString("utf8")), "manifest");
  if (manifest.schemaVersion !== "workloom.portrait-reuse-manifest/v1" || !Array.isArray(manifest.characters) || manifest.characters.length !== 1) fail("复用 manifest 格式或人物数量不符");
  const approvedSelection = selection(manifest.approvedSelection);
  for (const raw of manifest.characters) {
    const item = object(raw, "character");
    text(item.id, "character.id"); text(item.name, "character.name");
    if (item.version !== approvedSelection.selectedVersion || object(item.authorization, "authorization").status !== "synthetic-no-real-person") fail("仅支持本次选定版本的合成角色");
    if (item.aliases !== undefined && (!Array.isArray(item.aliases) || item.aliases.some(value => typeof value !== "string" || !value.trim()))) fail("角色别名无效");
    const profile = verifyFile(item.profile, "角色档案");
    const profileValue = object(JSON.parse(readFileSync(profile.path, "utf8")), "角色档案正文");
    if (profileValue.id !== item.id || !["generated", "synthetic-digital-human"].includes(String(profileValue.kind))
      || object(profileValue.authorization, "档案授权").status !== "synthetic-no-real-person") fail("manifest 不能把其他身份或真人档案改称纯AI角色");
    const files = fourKeys(item.files, "角色四角度");
    for (const angle of ANGLES) verifyFile(files[angle], `源图 ${angle}`);
  }
  return { manifestPath: receipt.path, manifestSha256: receipt.sha256, approvedSelection,
    characters: manifest.characters as ArchivedPortraitCharacters["characters"] };
}

/** 当前项目复制图、来源、档案与选择快照逐字节核验；计数字段本身不能构成通过。 */
export function acceptPortraitArchiveReuse(input: {
  workDir: string; projectId: string; stage: unknown; manifest: { path: string; sha256: string };
}): PortraitArchiveReuseAcceptance {
  const stage = object(input.stage, "portrait stage");
  const expectedStage = { status: "completed", characters: 1, products: 0, completedPortraits: 4, pendingPortraits: 0, reusedPortraits: 4, generatedPortraits: 0 } as const;
  if (Object.entries(expectedStage).some(([key, value]) => stage[key] !== value)) fail("本次阶段必须恰好复用四张且没有新生成或待生成图片");
  const configured = loadPortraitReuseManifest(input.manifest.path, input.manifest.sha256);
  const source = configured.characters[0]!;
  const base = realpathSync(input.workDir);
  if (!input.projectId || /[/\\\0]/.test(input.projectId) || [".", ".."].includes(input.projectId)) fail("项目标识非法");
  const root = path.join(base, "characters", input.projectId);
  if (realpathSync(root) !== root) fail("本次角色目录经过符号链接");
  const indexFile = fileReceipt(path.join(root, "portrait-index.json"), 8_000_000);
  const index = object(JSON.parse(indexFile.bytes.toString("utf8")), "portrait index");
  const characters = object(index.characters, "index.characters"), products = object(index.products, "index.products");
  if (index.schemaVersion !== "workloom.portrait-index/v1" || index.projectId !== input.projectId
    || Object.keys(characters).length !== 1 || Object.keys(products).length !== 0) fail("本次角色索引归属或主体数量不符");
  const item = object(Object.values(characters)[0], "index.character");
  text(item.id, "index.character.id");
  if (item.kind !== "character" || item.portraitVersion !== configured.approvedSelection.selectedVersion || item.pinnedVersion !== configured.approvedSelection.selectedVersion) fail("本次索引未锁定选定版本的合成角色");
  const files = fourKeys(item.files, "本次四角度"), receipts = fourKeys(item.reuseReceipts, "复用回执"), artifacts = fourKeys(item.artifacts, "复制产物回执");
  if (item.receipts !== undefined && Object.keys(object(item.receipts, "generation receipts")).length > 0) fail("复用分支混入生成回执");
  const sources: ReuseFileReceipt[] = [], outputs: ReuseFileReceipt[] = [];
  for (const angle of ANGLES) {
    const receipt = object(receipts[angle], `复用回执 ${angle}`);
    if (receipt.schemaVersion !== "workloom.portrait-reuse/v1" || receipt.projectId !== input.projectId || receipt.kind !== "character" || receipt.id !== item.id || receipt.angle !== angle
      || receipt.archiveId !== source.id || receipt.archiveName !== source.name || receipt.version !== configured.approvedSelection.selectedVersion || receipt.generationCount !== 0
      || typeof receipt.copiedAt !== "string" || !Number.isFinite(Date.parse(receipt.copiedAt))) fail(`${angle} 复用身份、版本或生成计数无效`);
    if (!isDeepStrictEqual(receipt.manifest, input.manifest) || !isDeepStrictEqual(receipt.selectionReceipt, configured.approvedSelection)
      || !isDeepStrictEqual(receipt.profile, source.profile) || !isDeepStrictEqual(receipt.source, source.files[angle])) fail(`${angle} 未绑定同一 manifest、选择、档案与源图`);
    const original = verifyFile(receipt.source, `${angle} 源图`), output = verifyFile(receipt.output, `${angle} 本次图`);
    if (!output.path.startsWith(`${root}${path.sep}`) || files[angle] !== output.path || original.path === output.path
      || original.sha256 !== output.sha256 || original.bytes !== output.bytes || !isDeepStrictEqual(artifacts[angle], receipt.output)) fail(`${angle} 并非当前项目逐字节复制产物`);
    sources.push(original); outputs.push(output);
  }
  if (new Set(outputs.map(item => item.path)).size !== 4 || new Set(sources.map(item => item.path)).size !== 4) fail("角度文件重复");
  return { schemaVersion: "workloom.portrait-reuse-acceptance/v1", projectId: input.projectId, stage: expectedStage,
    manifest: input.manifest, selectionReceipt: configured.approvedSelection, index: indexFile.receipt,
    profile: verifyFile(source.profile, "角色档案"), sources, outputs };
}

export function portraitReuseEvidence(proof: PortraitArchiveReuseAcceptance): Array<{ path: string; sha256: string; scope: string }> {
  return [{ ...proof.manifest, scope: "archive-reuse-manifest" }, { ...proof.index, scope: "archive-reuse-index" },
    { ...proof.profile, scope: "archive-reuse-profile" }, ...proof.sources.map(item => ({ ...item, scope: "archive-reuse-source" })),
    ...proof.outputs.map(item => ({ ...item, scope: "archive-reuse-image" }))];
}

/** 签发/提交资格时重新读取全部字节，不能只接受工作器写出的 passed 字符串。 */
export function verifyPortraitArchiveReuseAcceptance(input: { workDir: string; projectId: string; proof: unknown; evidence: unknown }): void {
  const proof = object(input.proof, "archive reuse acceptance");
  const manifest = object(proof.manifest, "archive reuse manifest");
  const actual = acceptPortraitArchiveReuse({ workDir: input.workDir, projectId: input.projectId, stage: proof.stage,
    manifest: { path: text(manifest.path, "manifest.path"), sha256: text(manifest.sha256, "manifest.sha256") } });
  if (!isDeepStrictEqual(actual, proof) || !isDeepStrictEqual(portraitReuseEvidence(actual), input.evidence)) fail("复用证据与本次实际文件不一致");
}
