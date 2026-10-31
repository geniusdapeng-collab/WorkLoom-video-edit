import { describe, expect, it } from "vitest";
import { artifactManifestHash, assertArtifactEnvelope } from "../artifact.js";
import type { ArtifactEnvelope } from "../types.js";

function artifact(): ArtifactEnvelope {
  return {
    schemaVersion: "workloom.video-artifact/v1",
    id: "A1",
    logicalId: "prd",
    role: "prd",
    revision: 1,
    schema: "workloom.prd/v3",
    storageRef: "artifacts/prd-v1.json",
    sha256: "a".repeat(64),
    bytes: 100,
    mediaType: "application/json",
    creator: { kind: "model", id: "prd-generator", version: "1" },
    parents: [],
    metadata: {},
  };
}

describe("artifact control", () => {
  it("rejects absolute and escaping storage paths", () => {
    expect(() => assertArtifactEnvelope({ ...artifact(), storageRef: "/tmp/x" })).toThrow(/相对路径/);
    expect(() => assertArtifactEnvelope({ ...artifact(), storageRef: "../x" })).toThrow(/相对路径/);
  });

  it("produces a stable manifest hash independent of input order", () => {
    const first = artifact();
    const second = { ...artifact(), id: "A2", logicalId: "theme", role: "theme", sha256: "b".repeat(64) };
    expect(artifactManifestHash([first, second])).toBe(artifactManifestHash([second, first]));
  });

  it("rejects duplicate logical artifact revisions", () => {
    const first = artifact();
    expect(() => artifactManifestHash([first, { ...first, sha256: "b".repeat(64) }])).toThrow(/重复/);
  });
});
