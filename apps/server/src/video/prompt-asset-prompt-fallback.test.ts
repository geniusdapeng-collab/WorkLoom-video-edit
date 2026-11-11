import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePromptAssets } from "./prompt-quality-gate.js";

const angles = ["front", "threeQuarter", "closeup", "side"] as const;
const charactersDir = "/synthetic/workspace/characters/P1";
const receipt = (file: string, index: number) => ({
  path: file, realPath: file, sha256: String(index).repeat(64), bytes: 100 + index,
});
const archiveCopies = {
  schemaVersion: "workloom.portrait-reuse-acceptance/v1" as const,
  projectId: "P1",
  character: { id: "lead", name: "林夏", angles },
  selectionReceipt: {
    schemaVersion: "workloom.portrait-reuse-selection/v1" as const,
    rawIntent: "原始二版角色",
    selectedVersion: 2,
    expectedPortraits: 4 as const,
    selectedAt: "2026-11-04T00:00:00Z",
  },
  manifest: { path: "/original/manifest.json", sha256: "a".repeat(64) },
  index: receipt(`${charactersDir}/portrait-index.json`, 8),
  profile: receipt("/original/profile.json", 9),
  sources: angles.map((angle, index) => receipt(`/original/lead-${angle}.png`, index)),
  outputs: angles.map((angle, index) => receipt(`${charactersDir}/lead-archive-v2-${angle}.png`, index)),
};

describe("G6 archive assets from a compiled prompt", () => {
  it("uses the one exact canonical URI retained in prompt text when sibling fields are null", () => {
    const uri = "image://characters/lead/portraits/v2/front.png";
    const assets = resolvePromptAssets({
      source: {
        portraits: null,
        fields: { portraits: null },
        prompt: `12.【角色】林夏走入画面。\n17.【定妆照】${uri}`,
      },
      workDir: "/synthetic/workspace",
      charactersDir,
      archiveCopies,
    });
    expect(assets).toEqual([{
      field: "portraits",
      role: "reference_image",
      sha256: archiveCopies.outputs[0]!.sha256,
      bytes: archiveCopies.outputs[0]!.bytes,
      mediaType: "image/png",
      sourceRef: "characters/P1/lead-archive-v2-front.png",
    }]);
  });

  it("falls back to the frozen prompt URI when a stale sibling portrait value cannot resolve", () => {
    const uri = "image://characters/lead/portraits/v2/closeup.png";
    const assets = resolvePromptAssets({
      source: {
        portraits: "/characters/character/portrait_v1.png",
        fields: { portraits: null },
        prompt: `17.【定妆照】${uri}`,
      },
      workDir: "/synthetic/workspace",
      charactersDir,
      archiveCopies,
    });
    expect(assets).toEqual([{
      field: "portraits",
      role: "reference_image",
      sha256: archiveCopies.outputs[2]!.sha256,
      bytes: archiveCopies.outputs[2]!.bytes,
      mediaType: "image/png",
      sourceRef: "characters/P1/lead-archive-v2-closeup.png",
    }]);
  });

  it("does not infer an asset from a role-only or no-person prompt", () => {
    for (const prompt of ["12.【角色】林夏走入画面。", "12.【角色】无角色出场。\n17.【定妆照】无角色出场，无定妆照。"]) {
      expect(resolvePromptAssets({
        source: { portraits: null, fields: { portraits: null }, prompt },
        workDir: "/synthetic/workspace",
        charactersDir,
        archiveCopies,
      })).toEqual([]);
    }
  });

  it("accepts a same-identity archived alias only when its current bytes equal the canonical copy", () => {
    const root = mkdtempSync(path.join(tmpdir(), "prompt-alias-assets-"));
    try {
      const projectDir = path.join(root, "characters", "P1");
      const canonicalDir = path.join(projectDir, "lead", "portraits", "v2");
      const aliasDir = path.join(projectDir, "林夏", "portraits");
      mkdirSync(canonicalDir, { recursive: true });
      mkdirSync(aliasDir, { recursive: true });
      const outputs = angles.map((angle, index) => {
        const bytes = Buffer.from(`portrait-${angle}-${index}`.repeat(24));
        const file = path.join(canonicalDir, `lead-${angle}.png`);
        writeFileSync(file, bytes);
        return {
          path: file, realPath: file, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
        };
      });
      const aliasPortraits = angles.map((angle, index) => {
        const file = path.join(aliasDir, `林夏-${angle}.png`);
        writeFileSync(file, Buffer.from(`portrait-${angle}-${index}`.repeat(24)));
        return { angle, outputFile: file };
      });
      const realArchive = { ...archiveCopies, character: { ...archiveCopies.character, name: "林夏" }, outputs };
      const binding = { character: "林夏", mode: "studio", source: "portrait-set://lead", portraits: aliasPortraits };
      const source = {
        portraits: "image://characters/lead/portraits/v2/front.png",
        fields: { portraits: "image://characters/lead/portraits/v2/front.png" },
        portraitBindings: [binding],
      };
      expect(resolvePromptAssets({ source, workDir: root, charactersDir: projectDir, archiveCopies: realArchive }))
        .toEqual([expect.objectContaining({ field: "portraits", sha256: outputs[0]!.sha256, bytes: outputs[0]!.bytes })]);

      writeFileSync(aliasPortraits[0]!.outputFile, "different-current-bytes");
      expect(resolvePromptAssets({ source, workDir: root, charactersDir: projectDir, archiveCopies: realArchive })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
