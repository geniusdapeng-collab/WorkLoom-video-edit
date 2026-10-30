import assert from "node:assert/strict";
import test from "node:test";
import {
  canResumePositive,
  fingerprint,
  positiveSummaryErrors,
  validateStressReport,
} from "./stress-evidence-contract.mjs";

const marketing = {
  id: "M01",
  pipeline: "marketing",
  intent: "营销主题",
};
const narrative = {
  id: "N01",
  pipeline: "narrative",
  intent: "叙事主题",
};
const binding = {
  sourceCommit: "a".repeat(40),
  harnessSha256: "b".repeat(64),
};
const marketingGateKeys = ["G1_DOSSIER", "G2_THEME", "G3_INSIGHT", "G4_PRD", "G6_PROMPT", "G7_FINAL"];
const narrativeGateKeys = ["G2_THEME", "G3_INSIGHT", "G4_PRD", "G6_PROMPT", "G7_FINAL"];

function summary(item, overrides = {}) {
  const gates = (item.pipeline === "marketing" ? marketingGateKeys : narrativeGateKeys)
    .map((gate) => ({ gate, approved: true }));
  return {
    success: true,
    renderSubmitted: false,
    shots: 4,
    prompts: 4,
    errors: [],
    gates,
    marketingFacts: item.pipeline === "marketing"
      ? { finalFactsSha256: "c".repeat(64) }
      : null,
    ...overrides,
  };
}

function result(item) {
  return {
    id: item.id,
    kind: "positive",
    pass: true,
    sourceCommit: binding.sourceCommit,
    sourceDirty: false,
    caseSha256: fingerprint(item),
    harnessSha256: binding.harnessSha256,
    renderSubmitted: false,
  };
}

test("a positive case requires every current pre-render gate and a final marketing fact digest", () => {
  assert.deepEqual(positiveSummaryErrors(summary(marketing), "marketing"), []);
  assert.deepEqual(positiveSummaryErrors(summary(narrative), "narrative"), []);

  const retried = summary(marketing);
  retried.gates.push({ gate: "G3_INSIGHT", approved: false });
  assert.match(positiveSummaryErrors(retried, "marketing").join("\n"), /G3_INSIGHT is not approved/);

  assert.match(
    positiveSummaryErrors(summary(marketing, { marketingFacts: { finalFactsSha256: null } }), "marketing").join("\n"),
    /finalFactsSha256/,
  );
  assert.match(
    positiveSummaryErrors(summary(narrative, { renderSubmitted: null }), "narrative").join("\n"),
    /renderSubmitted must be false/,
  );
});

test("resume accepts only the same source, case and harness with current gates", () => {
  const current = result(marketing);
  assert.equal(canResumePositive(current, summary(marketing), marketing, binding), true);
  assert.equal(canResumePositive({ ...current, sourceCommit: "d".repeat(40) }, summary(marketing), marketing, binding), false);
  assert.equal(canResumePositive({ ...current, caseSha256: "e".repeat(64) }, summary(marketing), marketing, binding), false);
  assert.equal(canResumePositive({ ...current, harnessSha256: "f".repeat(64) }, summary(marketing), marketing, binding), false);
  assert.equal(canResumePositive(current, summary(marketing, { renderSubmitted: null }), marketing, binding), false);
});

test("the full report rejects stale partial and render-submitted evidence", () => {
  const cases = { positive: [marketing, narrative], negative: [] };
  const report = {
    source: {
      commit: binding.sourceCommit,
      dirty: false,
      harnessSha256: binding.harnessSha256,
    },
    renderSubmissionAllowed: false,
    results: [result(marketing), result(narrative)],
    summary: { total: 2, passed: 2, failed: 0, renderSubmissions: 0 },
  };
  assert.deepEqual(validateStressReport(report, cases, binding), []);

  const stale = structuredClone(report);
  stale.results[0].sourceCommit = "d".repeat(40);
  stale.results[1].renderSubmitted = true;
  stale.summary.renderSubmissions = 1;
  const errors = validateStressReport(stale, cases, binding).join("\n");
  assert.match(errors, /M01 sourceCommit is stale/);
  assert.match(errors, /N01 submitted a render/);
  assert.match(errors, /summary.renderSubmissions must be zero/);
});
