import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadCharacterEntry, readPortraitArtifact, REQUIRED_PORTRAIT_ANGLES } from "./character-archive.js";
import type { ArchivedPortraitCharacters } from "./portrait-runtime.js";
import { preparePrdPortraitSources, verifyPrdPortraitSources } from "./prd-portrait-source.js";

const root = fileURLToPath(new URL("../../../bundles/ai-video/library/characters/model-01-young-rider", import.meta.url));
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "wl-prd-portrait-")));
  temporary.push(dir);
  const version = 2, entry = loadCharacterEntry(root, { pinnedVersion: version })!;
  const source = { profilePath: path.join(root, "profile.json"), profileSha256: sha(path.join(root, "profile.json")), registrySha256: "a".repeat(64) };
  const historicalProfile = path.join(dir, "profile.json");
  // An earlier immutable wardrobe description can coexist with the same role and V2 images.
  writeFileSync(historicalProfile, JSON.stringify({ ...JSON.parse(readFileSync(source.profilePath, "utf8")), note: "早期档案" }));
  const approval = { schemaVersion: "workloom.portrait-reuse-selection/v1" as const, rawIntent: "使用1号角色定妆制作当前任务", selectedVersion: version,
    expectedPortraits: 4, selectedAt: "2026-11-03T14:00:00.000Z" };
  const files = Object.fromEntries(REQUIRED_PORTRAIT_ANGLES.map(angle => [angle, readPortraitArtifact(entry.files[angle]!, root)]));
  const archived: ArchivedPortraitCharacters = {
    manifestPath: path.join(dir, "manifest.json"), manifestSha256: "", approvedSelection: approval,
    characters: [{ id: entry.id, name: entry.name, version, authorization: { status: "synthetic-no-real-person" }, profile: readPortraitArtifact(historicalProfile), files }],
  };
  const seal = () => {
    writeFileSync(archived.manifestPath, JSON.stringify({ schemaVersion: "workloom.portrait-reuse-manifest/v1", approvedSelection: approval, characters: archived.characters }));
    archived.manifestSha256 = sha(archived.manifestPath);
  };
  seal();
  const character = { id: entry.id, name: entry.name, role: "protagonist", portraitVersion: version, builtinCharacterSource: source };
  const choice = { id: entry.id, name: entry.name, source: "builtin", profilePath: source.profilePath, profileSha256: source.profileSha256 };
  const metadata = { customerOriginalIntent: approval.rawIntent, characters: [character], builtinCharacterSelection: {
    schemaVersion: "workloom.video-character-selection/v1", mode: "builtin", registrySha256: source.registrySha256, characters: [choice] } };
  return { archived, metadata, seal, character, choice, historicalProfile };
}

describe("G4 portrait sources before project G5", () => {
  it("binds real current owner-authorized original assets, the selected role and historical source without claiming project output", () => {
    const f = fixture(), sources = preparePrdPortraitSources(f.archived, f.metadata);
    expect(sources).toHaveLength(1);
    const evidence = sources[0]!;
    expect(evidence).toMatchObject({ status: "source-verified-awaiting-current-g5", characterId: "young-rider-01",
      name: "李英子", role: "protagonist", portraitVersion: 2, originals: f.archived.characters[0]!.files,
      ownerAuthorization: { basis: "explicit-owner-authorization", decisionOwnerRole: "product-owner" } });
    expect(evidence.catalogProfile.sha256).not.toBe(evidence.archiveProfile.sha256);
    expect(evidence).not.toHaveProperty("portraitPath");
    expect(evidence).not.toHaveProperty("g5Approval");
    expect(() => verifyPrdPortraitSources(sources)).not.toThrow();
    writeFileSync(f.archived.manifestPath, "changed during G4");
    expect(() => verifyPrdPortraitSources(sources)).toThrow("PRD_PORTRAIT_SOURCE_UNVERIFIED");
  });
  it("reports no readiness for an absent archive or a catalog with no owner record", () => {
    const f = fixture();
    expect(preparePrdPortraitSources(undefined, f.metadata)).toEqual([]);
    f.character.builtinCharacterSource.profilePath = f.choice.profilePath = f.historicalProfile;
    f.character.builtinCharacterSource.profileSha256 = f.choice.profileSha256 = sha(f.historicalProfile);
    expect(preparePrdPortraitSources(f.archived, f.metadata)).toEqual([]);
  });
  it("refuses an archive for another case, a different portrait version, or an unauthorized angle", () => {
    const f = fixture();
    expect(() => preparePrdPortraitSources(f.archived, { ...f.metadata, customerOriginalIntent: "另一个需求" })).toThrow("未绑定本次客户原文");
    f.character.portraitVersion = 3;
    expect(() => preparePrdPortraitSources(f.archived, f.metadata)).toThrow("身份、版本或用途类型不一致");
    f.character.portraitVersion = 2;
    f.archived.characters[0]!.files.front = f.archived.characters[0]!.files.side!;
    f.seal();
    expect(() => preparePrdPortraitSources(f.archived, f.metadata)).toThrow("没有当前所有者授权的相同字节");
  });
});
