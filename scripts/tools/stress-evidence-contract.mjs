import { createHash } from "node:crypto";

const MARKETING_GATES = Object.freeze([
  "G1_DOSSIER",
  "G2_THEME",
  "G3_INSIGHT",
  "G4_PRD",
  "G6_PROMPT",
  "G7_FINAL",
]);
const NARRATIVE_GATES = Object.freeze([
  "G2_THEME",
  "G3_INSIGHT",
  "G4_PRD",
  "G6_PROMPT",
  "G7_FINAL",
]);

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function fingerprint(value) {
  return sha256Bytes(JSON.stringify(value));
}

export function requiredGates(pipeline) {
  if (pipeline === "marketing") return MARKETING_GATES;
  if (pipeline === "narrative") return NARRATIVE_GATES;
  return [];
}

function latestGateStatus(gates, gate) {
  const records = Array.isArray(gates)
    ? gates.filter((item) => item && item.gate === gate)
    : [];
  return records.length ? records[records.length - 1] : null;
}

export function positiveSummaryErrors(summary, pipeline) {
  const errors = [];
  if (summary?.success !== true) errors.push("summary.success must be true");
  if (summary?.renderSubmitted !== false) errors.push("summary.renderSubmitted must be false");
  if (!(Number(summary?.shots) > 0)) errors.push("summary.shots must be positive");
  if (!(Number(summary?.prompts) > 0)) errors.push("summary.prompts must be positive");
  if (!Array.isArray(summary?.errors) || summary.errors.length > 0) errors.push("summary.errors must be empty");

  for (const gate of requiredGates(pipeline)) {
    const record = latestGateStatus(summary?.gates, gate);
    if (!record) errors.push(`latest gate ${gate} is missing`);
    else if (record.approved !== true) errors.push(`latest gate ${gate} is not approved`);
  }
  if (pipeline === "marketing") {
    const finalFactsSha256 = summary?.marketingFacts?.finalFactsSha256;
    if (typeof finalFactsSha256 !== "string" || !/^[a-f0-9]{64}$/.test(finalFactsSha256)) {
      errors.push("marketingFacts.finalFactsSha256 must be a current 64-hex digest");
    }
  }
  return errors;
}

export function canResumePositive(existing, summary, item, binding) {
  return Boolean(
    existing?.pass === true
    && existing.kind === "positive"
    && existing.sourceCommit === binding.sourceCommit
    && existing.sourceDirty === false
    && existing.caseSha256 === fingerprint(item)
    && existing.harnessSha256 === binding.harnessSha256
    && summary?.success === true
    && summary?.renderSubmitted === false
    && positiveSummaryErrors(summary, item.pipeline).length === 0,
  );
}

export function validateStressReport(report, cases, binding) {
  const errors = [];
  const expected = new Map([
    ...cases.positive.map((item) => [item.id, { item, kind: "positive" }]),
    ...cases.negative.map((item) => [item.id, { item, kind: "negative" }]),
  ]);
  const seen = new Set();
  const results = Array.isArray(report?.results) ? report.results : [];

  if (report?.source?.commit !== binding.sourceCommit) errors.push("report.source.commit is stale");
  if (report?.source?.dirty !== false) errors.push("report.source.dirty must be false");
  if (report?.source?.harnessSha256 !== binding.harnessSha256) errors.push("report.source.harnessSha256 is stale");
  if (report?.renderSubmissionAllowed !== false) errors.push("report.renderSubmissionAllowed must be false");

  for (const result of results) {
    if (!result?.id) {
      errors.push("result without id");
      continue;
    }
    if (seen.has(result.id)) errors.push(`duplicate result ${result.id}`);
    seen.add(result.id);
    const item = expected.get(result.id);
    if (!item) {
      errors.push(`unexpected result ${result.id}`);
      continue;
    }
    if (result.kind !== item.kind) errors.push(`${result.id} kind must be ${item.kind}`);
    if (result.sourceCommit !== binding.sourceCommit) errors.push(`${result.id} sourceCommit is stale`);
    if (result.sourceDirty !== false) errors.push(`${result.id} sourceDirty must be false`);
    if (result.caseSha256 !== fingerprint(item.item)) errors.push(`${result.id} caseSha256 is stale`);
    if (result.harnessSha256 !== binding.harnessSha256) errors.push(`${result.id} harnessSha256 is stale`);
    if (result.pass !== true) errors.push(`${result.id} did not pass`);
    if (result.renderSubmitted === true) errors.push(`${result.id} submitted a render`);
  }
  for (const id of expected.keys()) {
    if (!seen.has(id)) errors.push(`missing result ${id}`);
  }
  if (results.length !== expected.size) errors.push(`expected ${expected.size} results, observed ${results.length}`);
  if (report?.summary?.total !== expected.size) errors.push("summary.total does not cover the complete matrix");
  if (report?.summary?.passed !== expected.size) errors.push("summary.passed does not cover the complete matrix");
  if (report?.summary?.failed !== 0) errors.push("summary.failed must be zero");
  if (report?.summary?.renderSubmissions !== 0) errors.push("summary.renderSubmissions must be zero");
  return errors;
}
