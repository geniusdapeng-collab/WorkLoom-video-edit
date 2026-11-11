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
});
