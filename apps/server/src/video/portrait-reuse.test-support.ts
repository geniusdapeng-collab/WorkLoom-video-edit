import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ReuseFileReceipt } from "./portrait-reuse-acceptance.js";

/** 独立源文件、选择 manifest 与当前项目复制图，供真实文件核验测试复用。 */
export function portraitReuseFixture(workDir: string, projectId: string) {
  const base = realpathSync(workDir), sourceDir = path.join(base, "reuse-sources", projectId);
  const root = path.join(base, "characters", projectId);
  mkdirSync(sourceDir, { recursive: true }); mkdirSync(root, { recursive: true });
  const receipt = (file: string): ReuseFileReceipt => ({ path: file, realPath: realpathSync(file),
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"), bytes: readFileSync(file).length });
  const profilePath = path.join(sourceDir, "profile.json");
  writeFileSync(profilePath, JSON.stringify({ id: "model-01", kind: "generated", synthetic: true, wardrobe: "white T-shirt and jeans", authorization: { status: "synthetic-no-real-person" } }));
  const profile = receipt(profilePath), files: Record<string, ReuseFileReceipt> = {}, outputs: Record<string, ReuseFileReceipt> = {};
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH7sAAAAASUVORK5CYII=", "base64");
  for (const angle of ["front", "threeQuarter", "closeup", "side"]) {
    const source = path.join(sourceDir, `${angle}.png`), output = path.join(root, `${angle}.png`);
    writeFileSync(source, png); writeFileSync(output, png); files[angle] = receipt(source); outputs[angle] = receipt(output);
  }
  const approvedSelection = { schemaVersion: "workloom.portrait-reuse-selection/v1", rawIntent: "本次使用既有一号AI模特v4白T牛仔裤四角度", selectedVersion: 4,
    expectedPortraits: 4, selectedAt: "2026-10-24T01:00:00.000Z" };
  const character = { id: "model-01", name: "一号AI模特", aliases: ["c1"], version: 4,
    authorization: { status: "synthetic-no-real-person" }, profile, files };
  const manifestPath = path.join(sourceDir, "manifest.json");
  const manifest = { schemaVersion: "workloom.portrait-reuse-manifest/v1", approvedSelection, characters: [character] };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const manifestRef = { path: manifestPath, sha256: receipt(manifestPath).sha256 };
  const reuseReceipts = Object.fromEntries(Object.keys(files).map(angle => [angle, { schemaVersion: "workloom.portrait-reuse/v1", projectId,
    kind: "character", id: "c1", angle, archiveId: character.id, archiveName: character.name, version: 4, manifest: manifestRef,
    selectionReceipt: approvedSelection, profile, source: files[angle], output: outputs[angle], copiedAt: "2026-10-24T01:01:00.000Z", generationCount: 0 }]));
  const entry = { kind: "character", id: "c1", name: character.name, dir: root, portraitVersion: 4, pinnedVersion: 4,
    files: Object.fromEntries(Object.entries(outputs).map(([angle, item]) => [angle, item.path])), reuseReceipts, artifacts: outputs, receipts: {} };
  const index = { schemaVersion: "workloom.portrait-index/v1", projectId, generatedAt: "2026-10-24T01:01:00.000Z", characters: { c1: entry }, products: {} };
  const indexPath = path.join(root, "portrait-index.json");
  const persistIndex = () => writeFileSync(indexPath, JSON.stringify(index)); persistIndex();
  const stage = { status: "completed", characters: 1, products: 0, completedPortraits: 4, pendingPortraits: 0, reusedPortraits: 4, generatedPortraits: 0 };
  return { root, sourceDir, profile, files, outputs, approvedSelection, manifestPath, manifest, manifestRef, entry, index, indexPath, persistIndex, stage,
    input: { workDir: base, projectId, stage, manifest: manifestRef } };
}
