import { describe, expect, it } from "vitest";
import {
  promptSemanticRepairPlaybook,
  requireVideoRepairPlaybook,
} from "../playbooks.js";

describe("prompt semantic repair playbook", () => {
  it("has one attempt and derives a field-level allowlist from the finding", () => {
    const base = requireVideoRepairPlaybook("repair-prompt-semantic-fields-v1");
    expect(base.maxAttempts).toBe(1);
    const plan = promptSemanticRepairPlaybook(["camera_movement", "camera_movement", "timeline"]);
    expect(plan.allowedChanges).toEqual([
      "$.shots[*].fields.camera_movement",
      "$.shots[*].fields.timeline",
    ]);
    expect(plan.forbiddenChanges).toEqual(expect.arrayContaining([
      "$.approvedTheme",
      "$.gateThreshold",
      "$.authorization",
    ]));
  });

  it("refuses an empty allowlist", () => {
    expect(() => promptSemanticRepairPlaybook([])).toThrow("FIELDS_MISSING");
  });
});
