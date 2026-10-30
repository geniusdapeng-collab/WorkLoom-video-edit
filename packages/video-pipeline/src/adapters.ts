export type VideoAdapterKind = "stage" | "gate" | "pipeline";

export interface VideoAdapterRegistration {
  id: string;
  kind: VideoAdapterKind;
  version: string;
  capabilities: string[];
}

export interface VideoGateRegistration {
  id: string;
  checkSetVersion: string;
  rubricVersion: string;
  authority: "host_rule" | "llm_review" | "human_approval" | "external_receipt";
}

export const VIDEO_ADAPTERS: VideoAdapterRegistration[] = [
  {
    id: "legacy.vendor-preproduction",
    kind: "stage",
    version: "1",
    capabilities: ["vendor-preproduction"],
  },
  {
    id: "gate.host",
    kind: "gate",
    version: "1",
    capabilities: ["deterministic", "llm-review", "human-approval"],
  },
  {
    id: "pipeline.child",
    kind: "pipeline",
    version: "1",
    capabilities: ["call-pipeline"],
  },
];

export const VIDEO_GATES: VideoGateRegistration[] = [
  "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10", "G12", "G13",
  "G-MAT1", "G-DLV1",
].map((id) => ({
  id,
  checkSetVersion: `${id.toLowerCase()}/v1`,
  rubricVersion: `${id.toLowerCase()}/v1`,
  authority: ["G5", "G7", "G8", "G9", "G10", "G12", "G13"].includes(id)
    ? "human_approval"
    : "host_rule",
}));

export const DEFAULT_VIDEO_PIPELINES = [
  "marketing-film",
  "narrative-film",
  "explainer-film",
  "account-ops",
  "ads-creative-factory",
  "settlement-recon",
] as const;

function assertRegistration(id: string, version: string, seen: Set<string>, kind: string): void {
  if (!id.trim() || seen.has(id)) throw new Error(`VIDEO_${kind.toUpperCase()}_INVALID: ${id}`);
  seen.add(id);
  if (!/^\d+$/.test(version)) throw new Error(`VIDEO_${kind.toUpperCase()}_INVALID: ${id} version=${version}`);
}

export function createVideoAdapterRegistry(
  extra: VideoAdapterRegistration[] = [],
): Record<string, VideoAdapterRegistration> {
  const all = [...VIDEO_ADAPTERS, ...extra];
  const seen = new Set<string>();
  for (const adapter of all) {
    assertRegistration(adapter.id, adapter.version, seen, "adapter");
  }
  return Object.fromEntries(all.map((adapter) => [adapter.id, structuredClone(adapter)]));
}

export function createVideoGateRegistry(
  extra: VideoGateRegistration[] = [],
): Record<string, VideoGateRegistration> {
  const seen = new Set<string>();
  const all = [...VIDEO_GATES, ...extra];
  for (const gate of all) {
    assertRegistration(gate.id, "1", seen, "gate");
  }
  return Object.fromEntries(all.map((gate) => [gate.id, structuredClone(gate)]));
}
