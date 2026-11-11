import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compilePromptShot, promptFieldPolicy, SHOT_FIELD_SCHEMA_V2, SHOT_FIELD_SCHEMA_V1, sha256Json, WorkloomLLMEngine,
  type PromptCompileOptions,
} from "@hyperreality/video-studio";
import { DEFAULT_MODEL_POLICY, OpenAiCompatibleProvider, resetCircuit } from "@workloom/base/model-router";
import {
  authorRepairFields, planFieldAuthoring, recoverContractFields,
  type FieldAuthoringArchiveInput, type FieldAuthoringBudgetEvent, type FieldAuthoringSourceContext,
} from "./approved-source-fields.js";

const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const options: PromptCompileOptions = {
  schemaVersion: SHOT_FIELD_SCHEMA_V2, titleCard: false, createdAt: "2026-11-05T00:00:00.000Z",
  delivery: { aspectRatio: "9:16", resolution: "1080p", fps: 30, format: "mp4", generateAudio: true },
  model: { modelId: "fixture-video", provider: "fixture", providerModel: "fixture-video", version: "fixture/v1",
    modes: ["t2v", "i2v", "r2v"], durationSec: { min: 1, max: 20 }, aspectRatios: ["9:16"],
    resolutions: ["1080p"], maxReferenceImages: 4, maxPromptChars: 100_000 },
  assets: [{ field: "portraits", role: "reference_image", sha256: digest("fixture-image-bytes"), bytes: 19,
    mediaType: "image/png", sourceRef: "fixture/image.png" }],
};
function fixture(patch: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) {
  const fields: Record<string, unknown> = Object.fromEntries(promptFieldPolicy(SHOT_FIELD_SCHEMA_V2, false).fields.map(field => [field.key,
    `字段${field.key}原有完整文本，包含中文、emoji🛵、引号\"、反斜线\\以及换行\n下一行。`]));
  Object.assign(fields, { portraits: ["image://fixture/front.png", "image://fixture/side.png"], dialogue: "无台词。",
    constraint: "9:16画幅，1080p分辨率，30fps，MP4格式", timeline: "T00:00至T00:10，保留完整动作。", ...patch });
  const compiled = compilePromptShot({ shotId: "scene-a", duration: 10, fields, ...metadata }, options);
  expect(compiled.hardErrors).toEqual([]);
  const bytes = Buffer.from(JSON.stringify(compiled.contract, null, 2));
  const recovered = recoverContractFields({ contractBytes: bytes, expectedSha256: digest(bytes),
    ...(Object.keys(metadata).length ? { sceneMetadata: metadata as { sceneType?: string } } : {}) });
  return { fields, compiled, bytes, recovered };
}
function verified(value: unknown) { const bytes = Buffer.from(JSON.stringify(value)); return { bytes, expectedSha256: digest(bytes) }; }
const sourceContext: FieldAuthoringSourceContext = { brief: { title: "同一冻结需求", duration: 10, noSpeech: true },
  gates: { G1: { content: "真实档案全部原文", createdAt: "2026-11-04T00:00:00.000Z" }, G2: { content: "已审主题" },
    G3: { content: "已审洞察" }, G4: { content: "已审场景与核验计划" } } };
function fieldPlan(recovered = fixture().recovered, fields = ["action"]) {
  return planFieldAuthoring({ shots: [recovered], sourceContextSha256: sha256Json(sourceContext),
    diagnosedFindings: [verified({ schemaVersion: "workloom.video-prompt-quality/v2", findings: fields.map(field => ({
      code: "FIXTURE_APPROVED_ACTION_MISSING", field, shotId: recovered.shotId, detail: "必须呈现已审动作的完整过程。",
      blocking: true, repairClass: "semantic",
    })) })] });
}
function reviewedFieldPlan(recovered: ReturnType<typeof fixture>["recovered"], maxFinalPromptChars: number) {
  return planFieldAuthoring({ shots: [recovered], sourceContextSha256: sha256Json(sourceContext), maxFinalPromptChars,
    diagnosedFindings: [verified({ schemaVersion: "workloom.video-prompt-quality/v2", findings: [{
      code: "FIXTURE_APPROVED_ACTION_MISSING", field: "action", shotId: recovered.shotId,
      detail: "必须呈现已审动作的完整过程。", blocking: true, repairClass: "semantic",
    }] })] });
}
function missingFixture(missing: string[] = ["action"], otherFields: Record<string, unknown> = {}) {
  const fields = { ...fixture().fields, ...otherFields };
  for (const key of missing) delete fields[key];
  const compiled = compilePromptShot({ shotId: "scene-a", duration: 10, fields }, options);
  const bytes = Buffer.from(JSON.stringify(compiled.contract, null, 2));
  const report = { schemaVersion: "workloom.video-prompt-quality/v2", findings: compiled.hardErrors.map(error => ({
    ...error, shotId: "scene-a", blocking: true, repairClass: "deterministic",
  })) };
  const evidence = verified(report);
  const recover = () => recoverContractFields({ contractBytes: bytes, expectedSha256: digest(bytes), missingEvidence: [evidence] });
  return { fields, compiled, bytes, report, evidence, recover };
}
function nativeEngine(reply: string, patch: Record<string, unknown> = {}) {
  const requests: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ id: `offline-fixture-${requests.length}`, object: "chat.completion", created: 1,
      model: "deepseek-flash", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: reply } }],
      usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 }, ...patch });
  };
  const config = { baseUrl: "http://approved-source-fields.invalid/v1", apiKey: "offline-fixture-only", fetchImpl };
  const engine = new WorkloomLLMEngine({ ...config, model: "deepseek-flash" });
  const provider = new OpenAiCompatibleProvider("deepseek-flash", config);
  const policy = structuredClone(DEFAULT_MODEL_POLICY);
  const router = { providers: new Map([[provider.modelId, provider]]), forceModel: "deepseek-flash", policy,
    sink: { recordModelTrace: async () => undefined, recordDegradation: async () => undefined, recordCircuitBreak: async () => undefined } };
  engine.attachRouter(router);
  return { engine, requests, policy, router };
}
function authorInput(reply: string, patch: Record<string, unknown> = {}, plan = fieldPlan()) {
  const native = nativeEngine(reply, patch), archives: FieldAuthoringArchiveInput[] = [], events: FieldAuthoringBudgetEvent[] = [];
  const input = { plan, sourceContext: structuredClone(sourceContext), engine: native.engine,
    verifyCurrent: vi.fn(async () => undefined), budgetHook: vi.fn(async (event: FieldAuthoringBudgetEvent) => { events.push(event); }),
    archive: vi.fn(async (item: FieldAuthoringArchiveInput) => { archives.push(item); return { ref: `attempt-new/${item.shotId}/${item.kind}`, sha256: digest(item.bytes) }; }) };
  return { ...native, input, archives, events };
}
afterEach(() => { resetCircuit("preproduction"); vi.restoreAllMocks(); });

describe("canonical source-contract recovery", () => {
  it("does not treat downstream-only hard findings as replayed compiler errors", () => {
    const { fields, bytes } = fixture();
    const report = verified({ schemaVersion: "workloom.video-prompt-quality/v2", findings: [
      { shotId: "scene-a", field: null, code: "HARD_FINAL_PROMPT_TOO_LONG", detail: "下游最终长度门",
        blocking: true, repairClass: "deterministic" },
      { shotId: "scene-a", field: "director_intent", code: "HARD_FIELD_UNKNOWN", detail: "非规范字段由重建丢弃",
        blocking: true, repairClass: "deterministic" },
    ] });
    expect(recoverContractFields({ contractBytes: bytes, expectedSha256: digest(bytes), missingEvidence: [report] }).fields).toEqual(fields);
  });
  it("reconstructs all fields, arrays and UTF-16 spans with exact full compiler identity", () => {
    const { recovered, fields, compiled } = fixture();
    expect(recovered.fields).toEqual(fields);
    expect(recovered.prompt).toBe(compiled.prompt);
    expect(recovered.fieldProofs).toHaveLength(25);
    expect(recovered.fieldProofs.find(proof => proof.field === "portraits")?.carrier).toBe("prompt-array");
    expect(recovered).not.toHaveProperty("sceneType");
    expect(recovered).not.toHaveProperty("sceneId");
    expect(recovered.rawAliasState).toBe("not-retained");
    expect(compilePromptShot(recovered, recovered.compileOptions).contract).toEqual(compiled.contract);
  });
  it("retains trusted scene metadata without deriving a scene from a shot id", () => {
    const { recovered } = fixture({}, { sceneId: "approved-scene-a", sceneType: "content" });
    expect(recovered.sceneId).toBe("approved-scene-a");
    expect(recovered.sceneType).toBe("content");
  });
  it("requires a retained typed carrier for a lossy composite value", () => {
    const fields = fixture().fields;
    fields.action = { actor: "原演员", steps: ["步骤一", "步骤二"] };
    const compiled = compilePromptShot({ shotId: "scene-a", duration: 10, fields }, options);
    expect(compiled.hardErrors).toEqual([]);
    const bytes = Buffer.from(JSON.stringify(compiled.contract));
    expect(() => recoverContractFields({ contractBytes: bytes, expectedSha256: digest(bytes) })).toThrow("VALUE_UNRECOVERABLE:action");
    expect(recoverContractFields({ contractBytes: bytes, expectedSha256: digest(bytes), archivedFields: fields }).fields).toEqual(fields);
  });
  it("uses a request's preserved typed object without reconstructing its shape from prose", () => {
    const fields = fixture().fields;
    fields.baseline = { string: "已保留的基础全文", nested: { flag: true } };
    const compiled = compilePromptShot({ shotId: "scene-a", duration: 10, fields }, options);
    const bytes = Buffer.from(JSON.stringify(compiled.contract));
    const result = recoverContractFields({ contractBytes: bytes, expectedSha256: digest(bytes) });
    expect(result.fields.baseline).toEqual(fields.baseline);
    expect(result.fieldProofs.find(proof => proof.field === "baseline")?.carrier).toBe("request");
  });
  it.each(["whole-bytes", "value-hash", "span-fraction", "span-overlap", "label", "unknown-field", "policy", "request-extra"])("rejects tampering: %s", kind => {
    const { bytes, compiled } = fixture();
    if (kind === "whole-bytes") return expect(() => recoverContractFields({ contractBytes: bytes, expectedSha256: "a".repeat(64) })).toThrow("ARTIFACT_HASH_MISMATCH");
    const contract = structuredClone(compiled.contract);
    if (kind === "value-hash") contract.bindings[0]!.valueSha256 = "a".repeat(64);
    if (kind === "span-fraction") contract.bindings[0]!.promptSpan!.end += 0.5;
    if (kind === "span-overlap") contract.bindings[1]!.promptSpan!.start = 0;
    if (kind === "label") contract.bindings[0]!.promptSpan!.label = "【假的】";
    if (kind === "unknown-field") contract.bindings[0]!.field = "unapproved";
    if (kind === "policy") (contract as unknown as Record<string, unknown>).policyVersion = "future/v3";
    if (kind === "request-extra") contract.request.parameters.unapproved = true;
    const changed = Buffer.from(JSON.stringify(contract));
    expect(() => recoverContractFields({ contractBytes: changed, expectedSha256: digest(changed) })).toThrow("APPROVED_SOURCE_FIELDS_");
  });
  it("rejects malformed and duplicate-key source JSON", () => {
    for (const raw of ['{"a":1,"a":2}', "{broken", "[]"]) {
      expect(() => recoverContractFields({ contractBytes: Buffer.from(raw), expectedSha256: digest(raw) })).toThrow("APPROVED_SOURCE_FIELDS_");
    }
  });
  it("recovers the supported historical v1 schema without relabeling it as v2", () => {
    const fields = fixture().fields;
    const compiled = compilePromptShot({ shotId: "S00", duration: 10, fields }, { ...options, schemaVersion: SHOT_FIELD_SCHEMA_V1 });
    const bytes = Buffer.from(JSON.stringify(compiled.contract));
    const recovered = recoverContractFields({ contractBytes: bytes, expectedSha256: digest(bytes) });
    expect(recovered.sourceContract.fieldSchema).toBe(SHOT_FIELD_SCHEMA_V1);
    expect(recovered.fields).toEqual(fields);
  });
  it("requires trusted opening metadata when only the source scene declared a 30-field title card", () => {
    const fields = { ...fixture().fields, ...Object.fromEntries(promptFieldPolicy(SHOT_FIELD_SCHEMA_V2, true).fields.slice(25)
      .map(field => [field.key, `已审${field.label}全文`])) };
    const compiled = compilePromptShot({ shotId: "opening", sceneType: "opening", duration: 10, fields }, { ...options, titleCard: true });
    expect(compiled.hardErrors).toEqual([]);
    const bytes = Buffer.from(JSON.stringify(compiled.contract));
    expect(() => recoverContractFields({ contractBytes: bytes, expectedSha256: digest(bytes) })).toThrow("RECOMPILE_MISMATCH");
    const recovered = recoverContractFields({ contractBytes: bytes, expectedSha256: digest(bytes), sceneMetadata: { sceneType: "opening" } });
    expect(recovered.fieldProofs).toHaveLength(30);
    expect(recovered.fields).toEqual(fields);
  });
  it("keeps a no-person canonical marker and requires any unrecoverable explicit source flag", () => {
    const fields = { ...fixture().fields, character: "台面上的产品", portraits: "NONE" };
    const compiled = compilePromptShot({ shotId: "product", noPeople: true, duration: 10, fields }, { ...options, assets: [] });
    expect(compiled.hardErrors).toEqual([]);
    const bytes = Buffer.from(JSON.stringify(compiled.contract));
    expect(() => recoverContractFields({ contractBytes: bytes, expectedSha256: digest(bytes) })).toThrow("RECOMPILE_MISMATCH");
    expect(recoverContractFields({ contractBytes: bytes, expectedSha256: digest(bytes), sceneMetadata: { noPeople: true } }).fields.portraits).toBe("NONE");
  });
  it("refuses a sparse array hidden by an unrelated extra property", () => {
    const { bytes } = fixture();
    const sparse = new Array(1) as string[] & { extra?: string };
    sparse.extra = "pretend entry";
    expect(() => recoverContractFields({ contractBytes: bytes, expectedSha256: digest(bytes), archivedFields: { action: sparse } })).toThrow("ARCHIVED_FIELDS_INVALID");
  });
  it("does not execute an accessor while checking an archived typed carrier", () => {
    const { bytes } = fixture(), getter = vi.fn(() => "never");
    const values = Object.defineProperty({}, "action", { enumerable: true, get: getter });
    expect(() => recoverContractFields({ contractBytes: bytes, expectedSha256: digest(bytes), archivedFields: values })).toThrow("ARCHIVED_FIELDS_INVALID");
    expect(getter).not.toHaveBeenCalled();
  });
});

describe("host diagnostic field authoring plan", () => {
  it("turns final prompt overflow into bounded descriptive fields and refuses a non-shortening rewrite", async () => {
    const shot = fixture({ color_palette: "色".repeat(3200) }).recovered;
    expect(shot.prompt.length).toBeGreaterThan(3000);
    const report = verified({ schemaVersion: "workloom.video-prompt-quality/v2", findings: [{
      shotId: shot.shotId, field: null, code: "HARD_FINAL_PROMPT_TOO_LONG",
      detail: `完整提示词 ${shot.prompt.length} 字符超过最终上限 3000`, blocking: true, repairClass: "deterministic",
    }] });
    const plan = planFieldAuthoring({ shots: [shot], sourceContextSha256: sha256Json(sourceContext),
      maxFinalPromptChars: 3000, diagnosedFindings: [report] });
    expect(plan.fieldsByShot[shot.shotId]).toEqual(["lighting", "composition", "color_palette", "depth_of_field", "mood"]);
    const fields = Object.fromEntries(plan.fieldsByShot[shot.shotId]!.map(field =>
      [field, `${String(shot.fields[field])}新`]));
    const authored = authorInput(JSON.stringify({ shotId: shot.shotId, fields }), {}, plan);
    await expect(authorRepairFields(authored.input)).rejects.toThrow("AUTHORING_PROMPT_STILL_TOO_LONG");
    const shortened = Object.fromEntries(plan.fieldsByShot[shot.shotId]!.map(field => [field, `${field}短版`]));
    const shortenedInput = authorInput(JSON.stringify({ shotId: shot.shotId, fields: shortened }), {}, plan);
    await expect(authorRepairFields(shortenedInput.input)).resolves.toMatchObject({
      shots: [expect.objectContaining({ fields: expect.objectContaining(shortened) })],
    });
  });
  it("defers the verified G5 portrait rebinding while authoring a shorter prompt", async () => {
    const fields = { ...fixture().fields, color_palette: "色".repeat(3200) };
    const compiled = compilePromptShot({ shotId: "scene-a", duration: 10, fields }, { ...options, assets: [] });
    expect(compiled.hardErrors).toEqual([expect.objectContaining({ code: "HARD_ASSET_MISSING", field: "portraits" })]);
    const bytes = Buffer.from(JSON.stringify(compiled.contract));
    const report = verified({ schemaVersion: "workloom.video-prompt-quality/v2", findings: [
      { shotId: "scene-a", field: "portraits", code: "HARD_ASSET_MISSING", detail: "G5 后重新绑定", blocking: true, repairClass: "deterministic" },
      { shotId: "scene-a", field: null, code: "HARD_FINAL_PROMPT_TOO_LONG",
        detail: `完整提示词 ${compiled.contract.prompt.length} 字符超过最终上限 3000`, blocking: true, repairClass: "deterministic" },
    ] });
    const recovered = recoverContractFields({ contractBytes: bytes, expectedSha256: digest(bytes), missingEvidence: [report] });
    const plan = planFieldAuthoring({ shots: [recovered], sourceContextSha256: sha256Json(sourceContext),
      maxFinalPromptChars: 3000, deferPortraitAssetBinding: true, diagnosedFindings: [report] });
    const shortened = Object.fromEntries(plan.fieldsByShot[recovered.shotId]!.map(field => [field, `${field}短版`]));
    const authored = authorInput(JSON.stringify({ shotId: recovered.shotId, fields: shortened }), {}, plan);
    await expect(authorRepairFields(authored.input)).resolves.toMatchObject({
      shots: [expect.objectContaining({ fields: expect.objectContaining(shortened) })],
    });
  });
  it("derives current fields from verified G6 findings and preserves every other field", () => {
    const recovered = fixture().recovered, plan = fieldPlan(recovered, ["action", "timeline"]);
    expect(plan.fieldsByShot).toEqual({ "scene-a": ["action", "timeline"] });
    expect(plan.shots[0]).toEqual(recovered);
    expect(plan.diagnoses.every(entry => entry.kind === "conflict")).toBe(true);
  });
  it("does not infer truncation or writes merely from a field reaching a cap", () => {
    const recovered = fixture({ costume: "长".repeat(100), makeup: "妆".repeat(60), consistency: "同".repeat(80) }).recovered;
    const plan = planFieldAuthoring({ shots: [recovered], sourceContextSha256: sha256Json(sourceContext), diagnosedFindings: [] });
    expect(plan.fieldsByShot[recovered.shotId]).toEqual([]);
    expect(plan.diagnoses).toEqual([]);
  });
  it.each(["asset", "spec", "unknown-shot", "unverified-bytes", "free-list"])("rejects untrusted or forbidden field plans: %s", kind => {
    if (kind === "asset" || kind === "spec") return expect(() => fieldPlan(fixture().recovered, [kind === "asset" ? "portraits" : "constraint"])).toThrow("DIAGNOSIS_SCOPE_INVALID");
    const findings = verified({ schemaVersion: "workloom.video-prompt-quality/v2", findings: [{ shotId: "other", field: "action", code: "FAIL", detail: "真实问题", blocking: true, repairClass: "semantic" }] });
    if (kind === "unverified-bytes") findings.expectedSha256 = "b".repeat(64);
    if (kind === "free-list") Object.assign(findings, verified({ fields: ["action"] }));
    expect(() => planFieldAuthoring({ shots: [fixture().recovered], sourceContextSha256: sha256Json(sourceContext), diagnosedFindings: [findings] })).toThrow("APPROVED_SOURCE_FIELDS_");
  });
  it("checks retained value and context hashes for an explicit host diagnostic", () => {
    const shot = fixture().recovered;
    const diagnostic = { schemaVersion: "workloom.approved-source-field-diagnostics/v1", sourceContextSha256: sha256Json(sourceContext),
      diagnoses: [{ shotId: shot.shotId, field: "action", kind: "missing", code: "APPROVED_STEP_MISSING", reason: "当前字段未落实已审步骤。",
        sourceContractSha256: shot.sourceContractSha256, valueSha256: sha256Json(shot.fields.action), evidenceRefs: ["approved-G4/actions/0", "current-G6/action"] }] };
    const make = () => planFieldAuthoring({ shots: [shot], sourceContextSha256: sha256Json(sourceContext), diagnosedFindings: [verified(diagnostic)] });
    expect(make().fieldsByShot[shot.shotId]).toEqual(["action"]);
    diagnostic.diagnoses[0]!.valueSha256 = "a".repeat(64);
    expect(make).toThrow("DIAGNOSIS_VALUE_DRIFT");
  });
  it.each(["original-digest", "original-whitespace", "compiler-options", "contract-object", "field-proof"])("refuses reconstructed-lineage drift: %s", kind => {
    const shot = fixture().recovered;
    if (kind === "original-digest") shot.sourceContractSha256 = "b".repeat(64);
    if (kind === "original-whitespace") shot.sourceContractText += " ";
    if (kind === "compiler-options") shot.compileOptions.model.maxPromptChars++;
    if (kind === "contract-object") shot.sourceContract.createdAt = "2026-11-05T01:00:00.000Z";
    if (kind === "field-proof") shot.fieldProofs[0]!.valueSha256 = "f".repeat(64);
    expect(() => fieldPlan(shot)).toThrow("APPROVED_SOURCE_FIELDS_");
  });
  it.each(["baseline", "dialogue", "negative", "consistency", "bright_constraint", "audio"])("keeps the existing request channel for %s immutable", field => {
    expect(() => fieldPlan(fixture().recovered, [field])).toThrow("DIAGNOSIS_SCOPE_INVALID");
  });
});

describe("normal native dispatcher authoring with complete controlled artifacts", () => {
  it("scopes otherwise identical authoring prompts by the durable plan digest", async () => {
    const shot = fixture().recovered;
    const response = JSON.stringify({ shotId: shot.shotId, fields: { action: "完整呈现已审动作的前后过程。" } });
    const first = authorInput(response, {}, reviewedFieldPlan(shot, 3000));
    const second = authorInput(response, {}, reviewedFieldPlan(shot, 3001));
    await authorRepairFields(first.input); await authorRepairFields(second.input);
    const lastMessage = (request: Record<string, unknown>) =>
      String((request.messages as Array<{ content: string }>).at(-1)!.content);
    const firstPrompt = lastMessage(first.requests[0]!);
    const secondPrompt = lastMessage(second.requests[0]!);
    expect(firstPrompt).toContain(`\"authoringPlanSha256\":\"${first.input.plan.sha256}\"`);
    expect(secondPrompt).toContain(`\"authoringPlanSha256\":\"${second.input.plan.sha256}\"`);
    expect(secondPrompt).not.toBe(firstPrompt);
  });
  const content = JSON.stringify({ shotId: "scene-a", fields: { action: "新写完整动作：先完成已审步骤，再保持原演员、道具与切点。" } });
  it("authors only diagnosed fields once and archives the full raw body and complete snapshot", async () => {
    const { input, requests, archives, events } = authorInput(content);
    const result = await authorRepairFields(input);
    expect(requests).toHaveLength(1);
    const sent = JSON.stringify(requests[0]);
    expect(sent).toContain("真实档案全部原文");
    expect(sent).toContain("readOnlyFields");
    const user = (requests[0]!.messages as Array<{ role: string; content: string }>).find(message => message.role === "user")!.content;
    const authorData = JSON.parse(user.split("\n").find(line => line.startsWith('{"allowedFields":'))!);
    expect(authorData.readOnlyFields.costume).toBe(input.plan.shots[0]!.fields.costume);
    expect(result.shots[0]!.fields.action).toBe(JSON.parse(content).fields.action);
    for (const [field, value] of Object.entries(input.plan.shots[0]!.fields)) if (field !== "action") expect(result.shots[0]!.fields[field]).toEqual(value);
    expect(result.shots[0]!.sourceContract).toEqual(input.plan.shots[0]!.sourceContract);
    expect(archives.map(item => item.kind)).toEqual(["request", "response", "snapshot"]);
    expect(Buffer.from(archives[1]!.bytes).toString()).toBe(content);
    expect(JSON.parse(Buffer.from(archives[2]!.bytes).toString()).fields).toEqual(result.shots[0]!.fields);
    expect(events).toEqual([{ phase: "before", shotId: "scene-a" }, { phase: "dispatch", shotId: "scene-a" },
      { phase: "after", shotId: "scene-a", usage: { promptTokens: 500, completionTokens: 100 }, success: true,
        dispatchOutcome: "verified-complete", nativeCompleted: true }]);
    expect(result.receipts[0]!.dispatch.modelId).toBe("deepseek-flash");
    expect(result.receipts[0]!.request.sha256).toBe(digest(archives[0]!.bytes));
    expect(result.shots[0]!.authoringProof).toEqual(result.receipts[0]);
    expect(result.shots[0]!.currentContract?.prompt).toBe(result.shots[0]!.prompt);
    expect(result.shots[0]!.currentContract?.createdAt).toBe(result.receipts[0]!.authoredAt);
    expect(result.shots[0]!.sourceContract.createdAt).toBe(options.createdAt);
    expect(result.shots[0]!.sourceContractText).toBe(input.plan.shots[0]!.sourceContractText);
    expect(input.plan.shots[0]!.fields.action).not.toBe(result.shots[0]!.fields.action);
  });
  it.each([
    ["extra-field", JSON.stringify({ shotId: "scene-a", fields: { action: "新的动作", costume: "不准改的服装" } })],
    ["extra-reference", JSON.stringify({ shotId: "scene-a", fields: { action: "新的动作", portraits: ["image://unapproved/replacement.png"] } })],
    ["extra-envelope", JSON.stringify({ shotId: "scene-a", fields: { action: "新的动作" }, approved: true })],
    ["other-shot", JSON.stringify({ shotId: "other", fields: { action: "新的动作" } })],
    ["missing", JSON.stringify({ shotId: "scene-a", fields: {} })],
    ["empty", JSON.stringify({ shotId: "scene-a", fields: { action: " " } })],
    ["type-change", JSON.stringify({ shotId: "scene-a", fields: { action: ["新的动作"] } })],
    ["partial-json", '{"shotId":"scene-a","fields":'],
    ["duplicate", '{"shotId":"scene-a","fields":{"action":"新的动作","action":"重复写值"}}'],
  ])("fails closed without retry on %s", async (_label, body) => {
    const { input, requests, archives, events } = authorInput(body!);
    await expect(authorRepairFields(input)).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(archives.some(item => item.kind === "snapshot")).toBe(false);
    expect(events.at(-1)?.phase).toBe("after");
  });
  it("rejects a no-op while retaining its raw response for inspection", async () => {
    const { input, archives } = authorInput(content);
    const unchanged = JSON.stringify({ shotId: "scene-a", fields: { action: input.plan.shots[0]!.fields.action } });
    input.engine = nativeEngine(unchanged).engine;
    await expect(authorRepairFields(input)).rejects.toThrow("AUTHORING_NOOP_OR_TYPE_INVALID");
    expect(Buffer.from(archives[1]!.bytes).toString()).toBe(unchanged);
  });
  it.each(["unknown-usage", "truncated"])("rejects incomplete model outcome %s with no retry", async kind => {
    const patch = kind === "unknown-usage" ? { usage: undefined } : { choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content } }] };
    const { input, requests } = authorInput(content, patch);
    await expect(authorRepairFields(input)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });
  it("blocks source drift before a dispatch", async () => {
    const { input, requests } = authorInput(content);
    input.sourceContext.brief = "changed";
    await expect(authorRepairFields(input)).rejects.toThrow("AUTHORING_SOURCE_DRIFT");
    expect(requests).toHaveLength(0);
  });
  it("detects source mutation during dispatch before accepting a new snapshot", async () => {
    const { input, requests, archives } = authorInput(content);
    let verifies = 0;
    input.verifyCurrent = vi.fn(async () => { if (++verifies === 4) input.sourceContext.gates.G1 = "changed bytes"; });
    await expect(authorRepairFields(input)).rejects.toThrow("AUTHORING_SOURCE_DRIFT");
    expect(requests).toHaveLength(1);
    expect(archives.some(item => item.kind === "snapshot")).toBe(false);
  });
  it("does not dispatch when an explicit budget hook rejects", async () => {
    const { input, requests } = authorInput(content);
    input.budgetHook = vi.fn(async () => { throw new Error("EXPLICIT_BUDGET_EXHAUSTED"); });
    await expect(authorRepairFields(input)).rejects.toThrow("EXPLICIT_BUDGET_EXHAUSTED");
    expect(requests).toHaveLength(0);
  });
  it("rejects unproved fake engines before any request", async () => {
    const { input, requests } = authorInput(content);
    input.engine.reasonStructuredWithProof = vi.fn(async () => ({ result: { success: true, content } }));
    await expect(authorRepairFields(input)).rejects.toThrow("AUTHORING_ENGINE_UNPROVEN");
    expect(requests).toHaveLength(0);
  });
  it("still reports measured usage when controlled response archival fails", async () => {
    const { input, requests, events } = authorInput(content);
    const originalArchive = input.archive;
    input.archive = vi.fn(async item => { if (item.kind === "response") throw new Error("ARCHIVE_OFFLINE"); return originalArchive(item); });
    await expect(authorRepairFields(input)).rejects.toThrow("ARCHIVE_OFFLINE");
    expect(requests).toHaveLength(1);
    expect(events.at(-1)).toEqual({ phase: "after", shotId: "scene-a", usage: { promptTokens: 500, completionTokens: 100 }, success: true,
      dispatchOutcome: "verified-complete", nativeCompleted: true });
  });
  it("refuses an archive receipt whose digest does not match the full written bytes", async () => {
    const { input, requests } = authorInput(content);
    input.archive = vi.fn(async () => ({ ref: "attempt-new/wrong", sha256: "c".repeat(64) }));
    await expect(authorRepairFields(input)).rejects.toThrow("AUTHORING_ARCHIVE_UNVERIFIED");
    expect(requests).toHaveLength(0);
  });
  it("allows empty optional upstream lists while retaining all source documents", async () => {
    const { input } = authorInput(content);
    input.sourceContext.gates.G1 = { content: "完整原文", optionalReferences: [] };
    input.plan = planFieldAuthoring({ shots: input.plan.shots, sourceContextSha256: sha256Json(input.sourceContext),
      diagnosedFindings: [verified({ schemaVersion: "workloom.video-prompt-quality/v2", findings: [{ shotId: "scene-a", field: "action",
        code: "ACTION_MISSING", detail: "实际缺失动作", blocking: true, repairClass: "semantic" }] })] });
    await expect(authorRepairFields(input)).resolves.toHaveProperty("receipts.length", 1);
  });
  it("can author an array value without flattening it into prompt prose", async () => {
    const shot = fixture({ props: ["原有道具一", "原有道具二"] }).recovered;
    const body = JSON.stringify({ shotId: shot.shotId, fields: { props: ["新写已审道具一的状态", "新写已审道具二的交接"] } });
    const { input } = authorInput(body);
    input.plan = fieldPlan(shot, ["props"]);
    const result = await authorRepairFields(input);
    expect(result.shots[0]!.fields.props).toEqual(JSON.parse(body).fields.props);
    expect(result.shots[0]!.currentContract?.bindings.find(binding => binding.field === "props")?.valueSha256)
      .toBe(sha256Json(JSON.parse(body).fields.props));
  });
  it("does not call a model when no field has a verified diagnosis", async () => {
    const { input, requests, archives, events } = authorInput(content);
    input.plan = planFieldAuthoring({ shots: input.plan.shots, sourceContextSha256: sha256Json(input.sourceContext), diagnosedFindings: [] });
    const result = await authorRepairFields(input);
    expect(requests).toHaveLength(0);
    expect(archives).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(result.receipts).toEqual([]);
    expect(result.shots).toEqual(input.plan.shots);
  });
  it("permits only the currently diagnosed timeline text channel", async () => {
    const timeline = "T00:00至T00:05，先落实已审动作；T00:05至T00:10，保留完整结尾。";
    const { input } = authorInput(JSON.stringify({ shotId: "scene-a", fields: { timeline } }));
    input.plan = fieldPlan(input.plan.shots[0], ["timeline"]);
    const result = await authorRepairFields(input);
    const prior = input.plan.shots[0]!.sourceContract.request;
    expect(result.shots[0]!.currentContract!.request).toEqual({ ...prior, technical: { ...prior.technical, timeline } });
    expect(result.receipts[0]!.mutableRequestTextPaths).toEqual(["technical.timeline"]);
  });
  it("cannot change camera_fixed while correcting camera prose", async () => {
    const { input, requests } = authorInput(JSON.stringify({ shotId: "scene-a", fields: { camera_movement: "固定机位，保留原动作与时长。" } }));
    input.plan = fieldPlan(input.plan.shots[0], ["camera_movement"]);
    await expect(authorRepairFields(input)).rejects.toThrow("AUTHORING_REQUEST_DRIFT");
    expect(requests).toHaveLength(1);
  });
  it.each(["delivery", "audio-switch", "model", "asset-bytes", "asset-order"])("rejects a corrupt persisted plan changing %s before dispatch", async kind => {
    const { input, requests } = authorInput(content);
    if (kind === "asset-order") {
      const compiled = compilePromptShot({ shotId: "scene-a", duration: 10, fields: fixture().fields }, { ...options,
        assets: [...options.assets!, { ...options.assets![0]!, sha256: digest("second-fixture-image"), sourceRef: "fixture/second.png" }] });
      const bytes = Buffer.from(JSON.stringify(compiled.contract));
      input.plan = fieldPlan(recoverContractFields({ contractBytes: bytes, expectedSha256: digest(bytes) }));
      input.plan.shots[0]!.compileOptions.assets!.reverse();
    } else {
      const compile = input.plan.shots[0]!.compileOptions;
      if (kind === "delivery") compile.delivery.resolution = "720p";
      if (kind === "audio-switch") compile.delivery.generateAudio = false;
      if (kind === "model") compile.model.modelId = "unapproved-model";
      if (kind === "asset-bytes") compile.assets![0]!.sha256 = "d".repeat(64);
    }
    input.plan.sourceShotsSha256 = sha256Json(input.plan.shots);
    const { sha256: _previous, ...body } = input.plan;
    input.plan.sha256 = sha256Json(body);
    await expect(authorRepairFields(input)).rejects.toThrow("SHOT_DRIFT");
    expect(requests).toHaveLength(0);
  });
});

describe("existing host witness for character-constraint request text", () => {
  const driverless = "唯一命名主角；对手摩托车均为无人驾驶空车。";
  const corrected = "唯一命名成年主角不变；对手摩托车由匿名成年全盔骑手正常驾驶，禁止无人空车。";
  const purpose = "主车从第一辆对手车后方贴身追近，在封闭赛道完全超越第一辆对手摩托车。";
  const approvedProductionPlan = { g4ArtifactSha256: "a".repeat(64), requirementContractHash: "b".repeat(64), scenes: [
    { shotId: "scene-a", sceneId: "scene-a", interval: { startSec: 0, endSec: 10, brief: purpose },
      approvedScene: { purpose, actions: [{ actorId: "lead-fixture", description: purpose }], props: [{ name: "赛道摩托车" }] },
      verificationPlan: { visualRequirements: ["第一辆对手从车后到完全领先的完整过程。"] } },
    { shotId: "scene-b", sceneId: "scene-b", interval: { startSec: 10, endSec: 20,
      brief: "两次超车分别针对两辆不同的对手车，每次完整超车。" }, approvedScene: {}, verificationPlan: {} },
  ] };
  function setup(body: string, includeCurrentPlan: boolean) {
    const setup = authorInput(body), shot = fixture({ character_constraint: driverless, props: "主车和对手摩托车。" }).recovered;
    setup.input.sourceContext = { ...structuredClone(sourceContext), ...(includeCurrentPlan ? { approvedProductionPlan } : {}) };
    setup.input.plan = planFieldAuthoring({ shots: [shot], sourceContextSha256: sha256Json(setup.input.sourceContext),
      diagnosedFindings: [verified({ schemaVersion: "workloom.video-prompt-quality/v2", findings: [{ shotId: shot.shotId,
        field: "character_constraint", code: "APPROVED_MOVING_RIVAL_DRIVERLESS", detail: "原字段把正常对手车写成无人空车。",
        blocking: true, repairClass: "semantic", eventWitness: { family: "rival-driver", forged: "serialized payload is not authority" } }] })] });
    return setup;
  }
  it("recomputes the host proof before allowing the one existing request text path", async () => {
    const { input, requests } = setup(JSON.stringify({ shotId: "scene-a", fields: { character_constraint: corrected } }), true);
    const result = await authorRepairFields(input);
    expect(requests).toHaveLength(1);
    expect(result.receipts[0]!.mutableRequestTextPaths).toEqual(["technical.character_constraint"]);
    const before = input.plan.shots[0]!.sourceContract.request;
    expect(result.shots[0]!.currentContract!.request).toEqual({ ...before, technical: { ...before.technical, character_constraint: corrected } });
  });
  it("does not accept a serialized proof without the current approved plan", async () => {
    const { input, requests } = setup(JSON.stringify({ shotId: "scene-a", fields: { character_constraint: corrected } }), false);
    await expect(authorRepairFields(input)).rejects.toThrow("AUTHORING_REQUEST_TEXT_UNPROVEN");
    expect(requests).toHaveLength(0);
  });
  it("keeps the exact current host obligation after newly authored text", async () => {
    const { input } = setup(JSON.stringify({ shotId: "scene-a", fields: { character_constraint: "主角唯一；对手摩托车仍为无人空车。" } }), true);
    await expect(authorRepairFields(input)).rejects.toThrow("AUTHORING_EVENT_WITNESS_DRIFT");
  });
});

describe("explicitly diagnosed canonical omissions", () => {
  it("keeps strict recovery closed without the real missing-field report", () => {
    const { bytes } = missingFixture();
    expect(() => recoverContractFields({ contractBytes: bytes, expectedSha256: digest(bytes) })).toThrow("MISSING_EVIDENCE_REQUIRED:action");
  });
  it("retains absence without fabricating an old value or value hash, and recreates the full original contract", () => {
    const source = missingFixture(), shot = source.recover();
    expect(shot.fields).not.toHaveProperty("action");
    expect(shot.sourceContract.bindings).toHaveLength(24);
    expect(shot.fieldProofs).toHaveLength(24);
    expect(shot.unboundFields).toEqual([{ field: "action", sourceState: "canonical-unbound", valueSha256: null,
      diagnosisEvidenceSha256: [source.evidence.expectedSha256] }]);
    const rebuilt = compilePromptShot(shot, shot.compileOptions);
    expect(rebuilt.contract).toEqual(source.compiled.contract);
    expect(rebuilt.hardErrors).toEqual([expect.objectContaining({ code: "HARD_FIELD_VALUE_MISSING", field: "action" })]);
    expect(shot.sourceContractText).toBe(source.bytes.toString());
  });
  it.each(["wrong-code", "not-blocking", "wrong-shot", "wrong-integrity"])("cannot enable an unbound field from %s", kind => {
    const source = missingFixture();
    if (kind === "wrong-code") source.report.findings[0]!.code = "HARD_ANOTHER_ISSUE";
    if (kind === "not-blocking") source.report.findings[0]!.blocking = false;
    if (kind === "wrong-shot") source.report.findings[0]!.shotId = "another-shot";
    const evidence = verified(source.report);
    if (kind === "wrong-integrity") evidence.expectedSha256 = "e".repeat(64);
    expect(() => recoverContractFields({ contractBytes: source.bytes, expectedSha256: digest(source.bytes), missingEvidence: [evidence] })).toThrow("APPROVED_SOURCE_FIELDS_");
  });
  it("still rejects unrelated compiler failures in an otherwise reproducible missing-field contract", () => {
    const source = missingFixture(["action"], { timeline: "T00:00至T00:31，超出本镜总时长。" });
    expect(source.recover).toThrow("RECOMPILE_MISMATCH");
  });
  it("refuses an unbound source row carrying authored text instead of the exact compiler omission", () => {
    const source = missingFixture(), contract = structuredClone(source.compiled.contract);
    contract.prompt = contract.prompt.replace("08.【动作】undefined", "08.【动作】不存在绑定却藏入的文本");
    contract.promptSha256 = digest(contract.prompt);
    const bytes = Buffer.from(JSON.stringify(contract));
    expect(() => recoverContractFields({ contractBytes: bytes, expectedSha256: digest(bytes), missingEvidence: [source.evidence] })).toThrow("UNBOUND_PROMPT_LINE_INVALID");
  });
  it.each(["portraits", "constraint", "audio", "timeline", "character_constraint"])("does not authorize an unbound immutable/native-request field: %s", field => {
    const source = missingFixture([field]);
    expect(source.recover).toThrow(`UNBOUND_REQUEST_FIELD_UNSUPPORTED:${field}`);
  });
  it("requires that the plan use the same original missing-field report which established absence", () => {
    const source = missingFixture(), shot = source.recover();
    const altered = verified({ ...source.report, extra: "A different body does not become the original G6 evidence" });
    expect(() => planFieldAuthoring({ shots: [shot], sourceContextSha256: sha256Json(sourceContext), diagnosedFindings: [altered] })).toThrow("MISSING_DIAGNOSIS_UNBOUND");
    expect(() => planFieldAuthoring({ shots: [shot], sourceContextSha256: sha256Json(sourceContext), diagnosedFindings: [] })).toThrow("MISSING_DIAGNOSIS_REQUIRED");
  });
  it("does not turn a semantic finding or an ad hoc host field list into an absence grant", () => {
    const source = missingFixture(), shot = source.recover();
    expect(() => fieldPlan(shot)).toThrow("MISSING_DIAGNOSIS_UNBOUND");
  });
  it("rejects a forged marker attached to a complete historical source", () => {
    const shot = fixture().recovered;
    shot.unboundFields = [{ field: "action", sourceState: "canonical-unbound", valueSha256: null, diagnosisEvidenceSha256: ["c".repeat(64)] }];
    expect(() => fieldPlan(shot)).toThrow("SHOT_DRIFT");
  });
  it("authors new content only after proven absence and produces a complete new contract without rewriting history", async () => {
    const source = missingFixture(), shot = source.recover();
    const action = "新创作：主角按原G4完成同一可见动作与道具交接，保持冻结时长。";
    const { input, requests } = authorInput(JSON.stringify({ shotId: shot.shotId, fields: { action } }));
    input.plan = planFieldAuthoring({ shots: [shot], sourceContextSha256: sha256Json(input.sourceContext), diagnosedFindings: [source.evidence] });
    expect(input.plan.diagnoses[0]).toMatchObject({ field: "action", kind: "missing", origin: "g6-missing", valueSha256: null, sourceBinding: "unbound" });
    const result = await authorRepairFields(input), next = result.shots[0]!;
    expect(requests).toHaveLength(1);
    expect(next.fields.action).toBe(action);
    expect(next.currentContract!.bindings).toHaveLength(25);
    expect(compilePromptShot(next, { ...next.compileOptions, createdAt: next.currentContract!.createdAt }).hardErrors).toEqual([]);
    expect(next.sourceContract.bindings).toHaveLength(24);
    expect(next.sourceContractText).toBe(source.bytes.toString());
    expect(next.fieldProofs.some(proof => proof.field === "action")).toBe(false);
    expect(next.unboundFields[0]!.valueSha256).toBeNull();
    expect(result.receipts[0]!.newFields).toEqual(["action"]);
    for (const [field, value] of Object.entries(shot.fields)) expect(next.fields[field]).toEqual(value);
    expect(next.currentContract!.request).toEqual(shot.sourceContract.request);
  });
  it.each(["", "从完整已审来源新创作本字段的非空文本", ["unknown historical array type"], { text: "unknown historical object type" }])("requires newly authored missing content to be a nonempty concrete string: %j", async action => {
    const source = missingFixture(), shot = source.recover();
    const { input } = authorInput(JSON.stringify({ shotId: shot.shotId, fields: { action } }));
    input.plan = planFieldAuthoring({ shots: [shot], sourceContextSha256: sha256Json(input.sourceContext), diagnosedFindings: [source.evidence] });
    await expect(authorRepairFields(input)).rejects.toThrow("AUTHORING_NOOP_OR_TYPE_INVALID");
  });
  it("requires all proven omissions to be authored in the one affected-shot completion", async () => {
    const source = missingFixture(["action", "lighting", "makeup"]), shot = source.recover();
    const newValues = { action: "新写完整已审动作。", lighting: "按已审场景新写完整光向与照明。", makeup: "按已审角色新写完整妆容。" };
    const { input } = authorInput(JSON.stringify({ shotId: shot.shotId, fields: newValues }));
    input.plan = planFieldAuthoring({ shots: [shot], sourceContextSha256: sha256Json(input.sourceContext), diagnosedFindings: [source.evidence] });
    const result = await authorRepairFields(input);
    expect(result.shots[0]!.currentContract!.bindings).toHaveLength(25);
    expect(new Set(result.receipts[0]!.newFields)).toEqual(new Set(Object.keys(newValues)));
    const incomplete = authorInput(JSON.stringify({ shotId: shot.shotId, fields: { action: newValues.action } }));
    incomplete.input.plan = input.plan;
    await expect(authorRepairFields(incomplete.input)).rejects.toThrow("AUTHORING_RESPONSE_SCOPE_INVALID");
  });
});

describe("trusted native-call outcomes for durable replay protection", () => {
  const body = JSON.stringify({ shotId: "scene-a", fields: { action: "按完整已审来源新写动作，保留身份、时长和道具。" } });
  it("does not issue a dispatch/after outcome for a budget or source refusal before the native invocation", async () => {
    for (const cause of ["budget", "source"]) {
      const setup = authorInput(body), priorHook = setup.input.budgetHook;
      setup.input.budgetHook = vi.fn(async event => {
        await priorHook(event);
        if (event.phase === "before") {
          if (cause === "budget") throw new Error("BUDGET_DENIED_BEFORE_CALL");
          setup.input.sourceContext.gates.G1 = "changed-before-dispatch";
        }
      });
      await expect(authorRepairFields(setup.input)).rejects.toThrow();
      expect(setup.requests).toHaveLength(0);
      expect(setup.events.map(event => event.phase)).toEqual(["before"]);
    }
  });
  it("marks unknown usage as unverified after an actual native invocation", async () => {
    const setup = authorInput(body, { usage: undefined });
    await expect(authorRepairFields(setup.input)).rejects.toThrow();
    expect(setup.requests).toHaveLength(1);
    expect(setup.events.map(event => event.phase)).toEqual(["before", "dispatch", "after"]);
    expect(setup.events.at(-1)).toMatchObject({ phase: "after", usage: null, dispatchOutcome: "unverified", nativeCompleted: false });
  });
  it("keeps measured usage but marks a native answer without a pinned dispatch proof unverified", async () => {
    const setup = authorInput(body);
    setup.router.forceModel = "";
    await expect(authorRepairFields(setup.input)).rejects.toThrow("AUTHORING_RESPONSE_UNPROVEN");
    expect(setup.requests).toHaveLength(1);
    expect(setup.events.at(-1)).toMatchObject({ dispatchOutcome: "unverified", nativeCompleted: true,
      usage: { promptTokens: 500, completionTokens: 100 } });
  });
  it.each(["known", "missing-usage", "missing-id", "route-drift"] as const)(
    "retains the private strict-native syntax receipt only while its measured route is current: %s", async kind => {
      const setup = authorInput("{", kind === "missing-usage" ? { usage: undefined }
        : kind === "missing-id" ? { id: undefined } : {});
      if (kind === "route-drift") {
        const original = setup.input.archive;
        setup.input.archive = vi.fn(async item => {
          const receipt = await original(item);
          if (item.kind === "response") setup.policy.version += "-drifted";
          return receipt;
        });
      }
      await expect(authorRepairFields(setup.input)).rejects.toThrow("AUTHORING_RESPONSE_UNPROVEN");
      expect(setup.requests).toHaveLength(1);
      const archived = Buffer.from(setup.archives.find(item => item.kind === "response")!.bytes).toString();
      if (kind === "missing-usage") expect(JSON.parse(archived)).toMatchObject({ success: false });
      else expect(archived).toBe("{");
      expect(setup.archives.some(item => item.kind === "snapshot")).toBe(false);
      expect(setup.events.filter(event => event.phase === "after")).toHaveLength(1);
      expect(setup.events.at(-1)).toMatchObject({ success: false,
        dispatchOutcome: kind === "known" ? "verified-complete" : "unverified" });
    },
  );
  it.each(["response", "snapshot"] as const)("notices proof drift during %s archival before the sole outcome is emitted", async kind => {
    const setup = authorInput(body), original = setup.input.archive;
    setup.input.archive = vi.fn(async item => {
      const result = await original(item);
      if (item.kind === kind) setup.policy.version = `${setup.policy.version}-changed-after-native-call`;
      return result;
    });
    await expect(authorRepairFields(setup.input)).rejects.toThrow();
    expect(setup.events.filter(event => event.phase === "after")).toHaveLength(1);
    expect(setup.events.at(-1)).toMatchObject({ dispatchOutcome: "unverified", nativeCompleted: true,
      usage: { promptTokens: 500, completionTokens: 100 } });
  });
  it.each(["schema", "noop"])("keeps a measured, proven native %s rejection as a known completion", async kind => {
    const setup = authorInput(body);
    const content = kind === "schema" ? JSON.stringify({ shotId: "scene-a", fields: { action: "新动作" }, extra: true })
      : JSON.stringify({ shotId: "scene-a", fields: { action: setup.input.plan.shots[0]!.fields.action } });
    setup.input.engine = nativeEngine(content).engine;
    await expect(authorRepairFields(setup.input)).rejects.toThrow();
    expect(setup.events.at(-1)).toMatchObject({ dispatchOutcome: "verified-complete", nativeCompleted: true,
      usage: { promptTokens: 500, completionTokens: 100 } });
  });
  it("still retains the complete response and actual outcome when dispatch journaling rejects", async () => {
    const setup = authorInput(body), original = setup.input.budgetHook;
    setup.input.budgetHook = vi.fn(async event => {
      await original(event);
      if (event.phase === "dispatch") throw new Error("DISPATCH_JOURNAL_FAILED");
    });
    await expect(authorRepairFields(setup.input)).rejects.toThrow("DISPATCH_JOURNAL_FAILED");
    expect(setup.requests).toHaveLength(1);
    expect(Buffer.from(setup.archives.find(item => item.kind === "response")!.bytes).toString()).toBe(body);
    expect(setup.events.at(-1)).toMatchObject({ dispatchOutcome: "verified-complete", nativeCompleted: true,
      usage: { promptTokens: 500, completionTokens: 100 } });
  });
  it("emits one unverified outcome when the genuine native adapter rejects after invocation", async () => {
    const setup = authorInput(body);
    Object.defineProperty(setup.input.engine.stats, "totalCalls", { get: () => { throw new Error("NATIVE_INVOCATION_FAILED"); } });
    await expect(authorRepairFields(setup.input)).rejects.toThrow("NATIVE_INVOCATION_FAILED");
    expect(setup.events.map(event => event.phase)).toEqual(["before", "dispatch", "after"]);
    expect(setup.events.at(-1)).toMatchObject({ dispatchOutcome: "unverified", nativeCompleted: false, usage: null });
  });
});
