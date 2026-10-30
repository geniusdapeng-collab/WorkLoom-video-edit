import type { RepairPlaybook } from "@workloom/pipeline-control";

export const VIDEO_REPAIR_PLAYBOOKS: Record<string, RepairPlaybook> = {
  "repair-schema-field": {
    id: "repair-schema-field",
    version: "1",
    allowedChanges: ["$.schema", "$.fieldTypes", "$.enum"],
    forbiddenChanges: ["$.facts", "$.approvedTheme", "$.gateThreshold"],
    maxAttempts: 2,
    requiresApproval: false,
  },
  "repair-duration-conservation": {
    id: "repair-duration-conservation",
    version: "1",
    allowedChanges: ["$.delivery.durationSeconds", "$.shots[*].duration"],
    forbiddenChanges: ["$.intent", "$.facts", "$.approvedTheme", "$.approvedInsight"],
    maxAttempts: 2,
    requiresApproval: false,
  },
  "repair-fact-reference": {
    id: "repair-fact-reference",
    version: "1",
    allowedChanges: ["$.references", "$.claims[*].sourceIds"],
    forbiddenChanges: ["$.facts", "$.sourceBytes", "$.gateThreshold"],
    maxAttempts: 2,
    requiresApproval: false,
  },
  "repair-insight-contract": {
    id: "repair-insight-contract",
    version: "1",
    allowedChanges: ["$.audience", "$.scenes", "$.props", "$.actions", "$.risks", "$.referenceCases"],
    forbiddenChanges: ["$.facts", "$.approvedTheme", "$.intent"],
    maxAttempts: 2,
    requiresApproval: false,
  },
  "repair-prd-delivery-fields": {
    id: "repair-prd-delivery-fields",
    version: "1",
    allowedChanges: ["$.delivery", "$.productionConstraints", "$.audio", "$.subtitlePolicy"],
    forbiddenChanges: ["$.intent", "$.facts", "$.approvedTheme", "$.approvedInsight"],
    maxAttempts: 2,
    requiresApproval: false,
  },
  "repair-prompt-item": {
    id: "repair-prompt-item",
    version: "1",
    allowedChanges: ["$.shots[item].fields", "$.shots[item].prompt"],
    forbiddenChanges: ["$.shots[other].*", "$.approvedTheme", "$.approvedInsight", "$.approvedPrd"],
    maxAttempts: 2,
    requiresApproval: false,
  },
  "repair-subtitle-layer": {
    id: "repair-subtitle-layer",
    version: "1",
    allowedChanges: ["$.subtitle", "$.subtitleTiming", "$.subtitleStyle"],
    forbiddenChanges: ["$.videoSource", "$.renderJobs"],
    maxAttempts: 2,
    requiresApproval: false,
  },
  "repair-cover-layer": {
    id: "repair-cover-layer",
    version: "1",
    allowedChanges: ["$.cover", "$.coverText", "$.coverFrame"],
    forbiddenChanges: ["$.videoSource", "$.renderJobs"],
    maxAttempts: 2,
    requiresApproval: false,
  },
  "repair-selected-shot": {
    id: "repair-selected-shot",
    version: "1",
    allowedChanges: ["$.shots[item]"],
    forbiddenChanges: ["$.approvedTheme", "$.approvedInsight", "$.approvedPrd", "$.unselectedShots"],
    maxAttempts: 1,
    requiresApproval: true,
  },
};

export function requireVideoRepairPlaybook(id: string): RepairPlaybook {
  const playbook = VIDEO_REPAIR_PLAYBOOKS[id];
  if (!playbook) throw new Error(`VIDEO_REPAIR_PLAYBOOK_UNKNOWN: ${id}`);
  return structuredClone(playbook);
}
