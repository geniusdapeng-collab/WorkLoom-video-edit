import path from "node:path";
import { sha256Json } from "./canonical.js";
import { artifactEnvelopeSchema, artifactRefSchema } from "./schema.js";
import type { ArtifactEdge, ArtifactEnvelope, ArtifactRef } from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export class PipelineControlError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "PipelineControlError";
  }
}

function fail(code: string, message: string): never {
  throw new PipelineControlError(code, message);
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail("CONTROL_FIELD_INVALID", `${field} 必须是非空文本`);
  return value.trim();
}

function safeStorageRef(value: unknown): string {
  const ref = nonEmpty(value, "storageRef");
  if (path.isAbsolute(ref) || ref.split(/[\\/]/).some((part) => part === ".." || part === "." || part === "")) {
    fail("ARTIFACT_PATH_INVALID", "storageRef 必须是仓库/档案根内相对路径");
  }
  return ref.replaceAll("\\", "/");
}

export function assertArtifactRef(ref: ArtifactRef): ArtifactRef {
  const parsed = artifactRefSchema.safeParse({
    id: ref.id,
    logicalId: ref.logicalId,
    role: ref.role,
    revision: ref.revision,
    schema: ref.schema,
    storageRef: ref.storageRef,
    sha256: ref.sha256,
    bytes: ref.bytes,
    mediaType: ref.mediaType,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail("ARTIFACT_REF_INVALID", issue?.message ?? "artifact ref 非法");
  }
  if (!ID.test(parsed.data.id) || !ID.test(parsed.data.logicalId)) fail("ARTIFACT_ID_INVALID", "artifact id 非法");
  return { ...parsed.data, storageRef: safeStorageRef(parsed.data.storageRef) };
}

export function assertArtifactEnvelope(value: ArtifactEnvelope): ArtifactEnvelope {
  const parsed = artifactEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail("ARTIFACT_SCHEMA_INVALID", issue?.message ?? "artifact schema 非法");
  }
  const normalized = assertArtifactRef(parsed.data);
  return structuredClone({ ...parsed.data, ...normalized });
}

export function assertArtifactEdge(edge: ArtifactEdge): ArtifactEdge {
  nonEmpty(edge.runId, "edge.runId");
  nonEmpty(edge.parentArtifactId, "edge.parentArtifactId");
  nonEmpty(edge.childArtifactId, "edge.childArtifactId");
  nonEmpty(edge.inputRole, "edge.inputRole");
  if (!SHA256.test(edge.parentSha256) || !SHA256.test(edge.childSha256)) fail("ARTIFACT_EDGE_HASH_INVALID", "edge 摘要非法");
  if (edge.parentArtifactId === edge.childArtifactId) fail("ARTIFACT_EDGE_CYCLE", "artifact 不能以自身为父");
  return { ...edge };
}

export function artifactManifestHash(artifacts: ArtifactRef[]): string {
  if (!Array.isArray(artifacts) || artifacts.length === 0) fail("ARTIFACT_MANIFEST_EMPTY", "artifact manifest 不能为空");
  const normalized = artifacts.map(assertArtifactRef).sort((left, right) =>
    `${left.logicalId}\0${left.role}\0${left.sha256}`.localeCompare(`${right.logicalId}\0${right.role}\0${right.sha256}`));
  if (new Set(normalized.map((item) => `${item.logicalId}:${item.role}:${item.revision}`)).size !== normalized.length) {
    fail("ARTIFACT_MANIFEST_DUPLICATE", "artifact manifest 存在重复 logicalId/role/revision");
  }
  return sha256Json(normalized.map(({ logicalId, role, revision, schema, sha256, bytes }) => ({
    logicalId, role, revision, schema, sha256, bytes,
  })));
}
