import { describe, expect, it } from "vitest";
import {
  assertSystemAutoApprovalReceipt,
  type AutoApprovalCheck,
  type SystemAutoApprovalEvidence,
} from "@workloom/pipeline-control";
import {
  evaluateVideoSystemAutoApproval,
  VIDEO_SYSTEM_AUTO_APPROVAL_POLICY,
} from "../auto-approval.js";

const hash = "a".repeat(64);
const evidenceRef = {
  id: "evidence-1",
  kind: "file" as const,
  sha256: hash,
  ref: "evidence/current.json",
};

function passedCheck(id = "schema-current"): AutoApprovalCheck {
  return {
    id,
    category: "deterministic",
    status: "passed",
    detail: "current artifact passed the deterministic schema check",
    evidenceRef: evidenceRef.ref,
  };
}

function evidence(gateKey: string, overrides: Partial<SystemAutoApprovalEvidence> = {}): SystemAutoApprovalEvidence {
  return {
    gateKey,
    action: `${gateKey.toLowerCase()}.confirm`,
    artifactSha256: hash,
    factHash: hash,
    expectedFactHash: hash,
    deterministicChecks: [passedCheck()],
    budget: { status: "passed", detail: "request remains within the frozen budget", evidenceRef: "budget:current" },
    qualification: { status: "passed", detail: "current qualification hash is valid", evidenceRef: "qualification:current" },
    permission: { status: "passed", detail: "workspace permission and scope match", evidenceRef: "permission:current" },
    fence: { status: "passed", level: "review", detail: "review converts only after every mandatory check", evidenceRef: "fence:current" },
    evidenceRefs: [evidenceRef],
    ...overrides,
  };
}

describe("versioned video system auto-approval policy", () => {
  it.each(["G5", "G8", "G9", "G10", "G11", "G12", "G15"])(
    "%s passes only after every mandatory control is satisfied",
    (gateKey) => {
      const result = evaluateVideoSystemAutoApproval(true, evidence(gateKey));
      expect(result.outcome).toBe("passed");
      expect(result.gateStatus).toBe("passed");
      expect(result.receipt.policyId).toBe("video-system-auto-approval");
      expect(result.receipt.policyVersion).toBe(VIDEO_SYSTEM_AUTO_APPROVAL_POLICY.version);
      expect(result.checks.map((check) => check.category)).toEqual(expect.arrayContaining([
        "deterministic", "fact_hash", "budget", "qualification", "permission", "fence",
      ]));
      expect(() => assertSystemAutoApprovalReceipt(result.receipt, {
        policyId: VIDEO_SYSTEM_AUTO_APPROVAL_POLICY.id,
        policyVersion: VIDEO_SYSTEM_AUTO_APPROVAL_POLICY.version,
        gateKey,
        outcome: "passed",
      })).not.toThrow();
    },
  );

  it.each(["G5", "G8", "G9", "G10", "G11", "G12", "G15"])(
    "keeps every explicit %s block fail-closed",
    (gateKey) => {
      const result = evaluateVideoSystemAutoApproval(true, evidence(gateKey, {
        fence: { status: "failed", level: "block", detail: "hard red line", evidenceRef: "fence:block" },
      }));
      expect(result.outcome).toBe("blocked");
      expect(result.gateStatus).toBe("blocked");
    },
  );

  it("keeps review rejection fail-closed", () => {
    const result = evaluateVideoSystemAutoApproval(true, evidence("G9", {
      fence: { status: "failed", level: "review", detail: "review rejected", evidenceRef: "fence:reject" },
    }));
    expect(result.outcome).toBe("blocked");
    expect(result.gateStatus).toBe("blocked");
  });

  it("blocks when the global kill switch is off", () => {
    const result = evaluateVideoSystemAutoApproval(false, evidence("G8"));
    expect(result.outcome).toBe("blocked");
    expect(result.blockingChecks.some((check) => check.id === "auto-approval-kill-switch")).toBe(true);
  });

  it.each([
    ["fact hash", { expectedFactHash: "b".repeat(64) }],
    ["budget", { budget: { status: "failed" as const, detail: "budget exceeded", evidenceRef: "budget:exceeded" } }],
    ["qualification", { qualification: { status: "failed" as const, detail: "qualification missing", evidenceRef: "qualification:missing" } }],
    ["permission", { permission: { status: "failed" as const, detail: "permission denied", evidenceRef: "permission:denied" } }],
  ])("blocks on invalid %s evidence", (_label, overrides) => {
    const result = evaluateVideoSystemAutoApproval(true, evidence("G12", overrides));
    expect(result.outcome).toBe("blocked");
  });

  it("maps a repairable deterministic failure to repair and never passed", () => {
    const result = evaluateVideoSystemAutoApproval(true, evidence("G5", {
      deterministicChecks: [{
        ...passedCheck("portrait-angle"),
        status: "failed",
        detail: "side angle is missing",
        repairClass: "local_patch",
      }],
    }));
    expect(result.outcome).toBe("repair");
    expect(result.gateStatus).toBe("rejected");
  });

  it("rejects an unsupported gate instead of silently borrowing policy coverage", () => {
    const result = evaluateVideoSystemAutoApproval(true, evidence("G99"));
    expect(result.outcome).toBe("blocked");
  });

  it("rejects a tampered evidence digest", () => {
    const result = evaluateVideoSystemAutoApproval(true, evidence("G15"));
    expect(() => assertSystemAutoApprovalReceipt({
      ...result.receipt,
      evidenceDigest: "b".repeat(64),
    }, {
      policyId: VIDEO_SYSTEM_AUTO_APPROVAL_POLICY.id,
      policyVersion: VIDEO_SYSTEM_AUTO_APPROVAL_POLICY.version,
      gateKey: "G15",
      outcome: "passed",
    })).toThrow("AUTO_APPROVAL_RECEIPT_INVALID");
  });
});
