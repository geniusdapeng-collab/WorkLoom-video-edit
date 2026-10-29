import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reviewStage, type ProducerArtifact, type ProducerVerdict } from "@hyperreality/video-studio";
import { createMarketingGateEvidenceGuard, type MarketingGateReviewEvidence } from "./marketing-gate-evidence.js";

const roots: string[] = [];
const scope = { tenantId: "tenant-1", workspaceId: "ws-1", projectId: "VID-1", runId: "RUN-1", attempt: 1 };
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const env = { LLM_BASE_URL: "https://api.deepseek.com", LLM_API_KEY: "isolated-fake-key", LLM_MODEL: "deepseek-flash" };
const good = { approved: true, score: 95, issues: [], suggestions: [], reason: "只按完整已接受 claims 与当前门合同通过" };
const nextGates = ["G2_THEME", "G3_INSIGHT", "G4_PRD", "G5_PORTRAIT", "G6_PROMPT", "G7_FINAL"];

function fixture(attempt = 1) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "marketing-gate-evidence-"))); roots.push(root);
  const guard = createMarketingGateEvidenceGuard({ workDir: root, scope });
  const currentScope = { ...scope, attempt };
  guard.reset(attempt);
  const file = (gate: string, content: string, n = attempt) => {
    const target = path.join(root, "gates", scope.projectId, `attempt-${n}`, `${gate}.md`);
    mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, content); return target;
  };
  const content = JSON.stringify({ facts: { schemaVersion: "workloom.marketing-facts/v1", issuer: "workloom.marketing-authority",
    scope: currentScope, stages: [{ stage: "A1", facts: { claims: [{ value: "818.8 cc", sourceId: "SRC-1" }] },
      review: { score: 88, issues: ["来源是媒体报道，发布日期不等于厂家确认日期", "SBK 赛事型号不等于零售型号"],
        suggestions: ["赛道性能须保留封闭赛道用途限定", "未知外观不能补写为已核实事实"] } }],
    restrictions: ["竞品未提供证据，不能推断市场缺失；鱼鳞焊缝没有已接受 claim"] }, requestedIntent: "李英子与820RR-RC" });
  const g1Path = file("G1_DOSSIER", content);
  const proof = { gate: "G1_DOSSIER", approved: true, status: "passed", via: "llm", model: "deepseek-flash", degraded: false,
    evidence: [{ path: g1Path, sha256: sha(content), scope: "complete-text", bytes: Buffer.byteLength(content) }],
    score: 95, issues: ["评价与竞品未提供"], suggestions: ["保留完整 A1 support review 限定"], reason: "完整原文审核通过" };
  const accept = () => guard.acceptG1({ scope: currentScope, content, proof });
  const current = (gate = "G3_INSIGHT", text = "明确的李英子、场景、动作和镜头合同；818.8 cc 仅来自G1。".repeat(10)): ProducerArtifact => ({
    path: file(gate, text), kind: "text", expectedSha256: sha(text),
  });
  const verdict = (artifact: ProducerArtifact): ProducerVerdict => ({ stage: "script", status: "passed", approved: true, score: 95,
    hardFailures: [], issues: [], suggestions: [], rerun: false, via: "llm", model: "deepseek-flash", ms: 1, reason: "完整证据评审", degraded: false,
    evidence: [{ path: g1Path, sha256: sha(content), scope: "complete-text" }, { path: artifact.path, sha256: artifact.expectedSha256!, scope: "complete-text" }] });
  return { root, guard, currentScope, file, content, g1Path, proof, accept, current, verdict };
}

async function review(f: ReturnType<typeof fixture>, artifact: ProducerArtifact, binding: MarketingGateReviewEvidence, calls: string[],
  answer: unknown = good, onFetch?: () => void) {
  const result = await reviewStage({ stage: "script", projectId: scope.projectId, env,
    artifacts: [artifact, ...binding.artifacts], deterministic: binding.deterministic, requiredCheckIds: binding.requiredCheckIds,
    rubric: binding.rubric, context: { gate: "G3_INSIGHT", marketingFactsAuthority: binding.context },
    fetchImpl: (async (_url, init) => { calls.push(String(init?.body)); onFetch?.();
      return new Response(JSON.stringify({
        id: "marketing-gate-judge",
        model: "deepseek-flash",
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(answer) } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 30,
          total_tokens: 130,
          completion_tokens_details: { reasoning_tokens: 10 },
        },
      })); }) as typeof fetch });
  return f.guard.verifyReview(binding, result);
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("current-attempt host-owned G1 evidence", () => {
  it("exports the exact full current G1 and original proof for PRD without dropping nested support review notes", () => {
    const f = fixture(); f.accept();
    const authority = f.guard.forPrd();
    expect(authority).toEqual({ schemaVersion: "workloom.prd-marketing-authority/v1", scope: f.currentScope,
      g1Artifact: { path: f.g1Path, sha256: sha(f.content), content: f.content }, g1Proof: f.proof });
    const original = JSON.parse(authority.g1Artifact.content);
    expect(original.facts.stages[0].review).toEqual(JSON.parse(f.content).facts.stages[0].review);
    expect(original.facts.restrictions).toEqual(JSON.parse(f.content).facts.restrictions);
    expect(readFileSync(f.g1Path, "utf8")).toBe(f.content);
  });

  it("keeps accepted proof and exported PRD values isolated from caller mutation", () => {
    const f = fixture(); f.accept();
    const authority = f.guard.forPrd();
    f.proof.model = "caller-replacement"; f.proof.suggestions.push("伪造建议");
    f.proof.evidence[0]!.sha256 = "0".repeat(64);
    authority.scope.runId = "forged-run"; authority.g1Artifact.content = "metadata replacement";
    authority.g1Proof.evidence[0]!.sha256 = "f".repeat(64);
    (authority.g1Proof.suggestions as string[]).push("返回对象不能回写私有快照");
    expect(f.guard.forPrd()).toMatchObject({ scope: f.currentScope,
      g1Artifact: { content: f.content, sha256: sha(f.content) },
      g1Proof: { model: "deepseek-flash", suggestions: ["保留完整 A1 support review 限定"],
        evidence: [{ path: f.g1Path, sha256: sha(f.content), scope: "complete-text" }] } });
  });

  it.each(["unaccepted", "reset", "invalid-reset", "failed-replacement"])("does not export PRD authority after %s", kind => {
    const f = fixture();
    if (kind !== "unaccepted") f.accept();
    if (kind === "reset") f.guard.reset(2);
    if (kind === "invalid-reset") expect(() => f.guard.reset(0)).toThrow();
    if (kind === "failed-replacement") expect(() => f.guard.acceptG1({ scope: f.currentScope, content: f.content, proof: {} })).toThrow();
    expect(() => f.guard.forPrd()).toThrow("缺少当前运行与尝试已接受的 G1 原件");
  });

  it.each(["tampered", "missing", "symlink"])("rechecks the current original before every PRD export: %s", kind => {
    const f = fixture(); f.accept(); expect(f.guard.forPrd().g1Artifact.content).toBe(f.content);
    if (kind === "tampered") writeFileSync(f.g1Path, `${f.content} `);
    if (kind === "missing") rmSync(f.g1Path);
    if (kind === "symlink") { const copy = f.file("g1-copy", f.content); rmSync(f.g1Path); symlinkSync(copy, f.g1Path); }
    expect(() => f.guard.forPrd()).toThrow();
  });

  it("cannot adopt a previous run's accepted original or metadata-shaped export", () => {
    const f = fixture(); f.accept(); const old = f.guard.forPrd();
    const next = createMarketingGateEvidenceGuard({ workDir: f.root, scope: { ...scope, runId: "RUN-2" } }); next.reset(1);
    expect(() => next.forPrd()).toThrow();
    expect(() => next.acceptG1({ scope: old.scope, content: old.g1Artifact.content, proof: old.g1Proof })).toThrow("不属于当前运行与尝试");
    expect(() => next.acceptG1({ scope: { ...old.scope, runId: "RUN-2" }, content: old.g1Artifact.content, proof: old.g1Proof })).toThrow("作用域或事实身份不符");
    expect(() => next.forPrd()).toThrow();
  });

  it("revokes earlier authority when a replacement proof cannot be captured as a private snapshot", () => {
    const f = fixture(); f.accept();
    expect(() => f.guard.acceptG1({ scope: f.currentScope, content: f.content,
      proof: { ...f.proof, callerFunction: () => "not a saved verdict" } })).toThrow("无法保存私有快照");
    expect(() => f.guard.forPrd()).toThrow();
  });

  it.each(nextGates)("binds exact original G1 and current gate for %s without changing claims", gate => {
    const f = fixture(); f.accept(); const current = f.current(gate), binding = f.guard.forReview(gate, current)!;
    expect(binding.deterministic).toEqual([expect.objectContaining({ status: "passed", pass: true, hard: true })]);
    expect(binding.artifacts).toEqual([{ path: f.g1Path, kind: "json", expectedSha256: sha(f.content), note: expect.any(String) }]);
    expect(binding.context).toMatchObject({ authorityStatus: "accepted-current-g1", scope: f.currentScope,
      g1: { path: f.g1Path, sha256: sha(f.content), status: "passed", via: "llm", degraded: false, model: "deepseek-flash" } });
    expect(f.guard.verifyReview(binding, f.verdict(current))).toMatchObject({ approved: true, status: "passed", degraded: false });
    expect(readFileSync(f.g1Path, "utf8")).toBe(f.content);
    expect(binding.rubric.join("\n")).toContain("不在已接受 claims 内或超出限定的主张必须拒绝");
    expect(binding.rubric.join("\n")).toContain("人物、场景、动作及镜头合同分别核对");
  });

  it.each(["G1_DOSSIER", "G8_RENDER", "UNKNOWN"])("does not add a downstream marketing requirement to %s", gate => {
    const f = fixture(); expect(f.guard.forReview(gate, f.current(gate))).toBeUndefined();
  });

  it("passes both full original artifacts to the actual reviewer and preserves model rejection of unsupported claims", async () => {
    const f = fixture(); f.accept(); const current = f.current(); const calls: string[] = [];
    const binding = f.guard.forReview("G3_INSIGHT", current)!;
    expect(await review(f, current, binding, calls)).toMatchObject({ approved: true, status: "passed", via: "llm", degraded: false });
    const content = JSON.parse(calls[0]!).messages[0].content;
    expect(content).toContainEqual({ type: "text", text: `以下是产物正文（完整）：${f.g1Path}\n${f.content}` });
    expect(content).toContainEqual({ type: "text", text: `以下是产物正文（完整）：${current.path}\n${readFileSync(current.path, "utf8")}` });
    const rejected = await review(f, current, binding, calls, { ...good, approved: false, score: 45,
      reason: "鱼鳞焊缝没有已接受claim；竞品没讲的违反A3无证据限制" });
    expect(rejected).toMatchObject({ approved: false, status: "failed", degraded: false, via: "llm" });
    expect(rejected.reason).toContain("鱼鳞焊缝"); expect(calls).toHaveLength(2);
  });

  it.each(["missing", "copied-metadata"])("%s cannot supply host approval and makes zero model calls", async kind => {
    const f = fixture(), current = f.current(), calls: string[] = [];
    if (kind === "copied-metadata") Object.assign(current, { metadata: { marketingFactsAuthority: { scope: f.currentScope, ...f.proof } } });
    const binding = f.guard.forReview("G3_INSIGHT", current)!;
    expect(binding.deterministic[0]).toMatchObject({ pass: false, status: "unverified", hard: true });
    expect(await review(f, current, binding, calls)).toMatchObject({ approved: false, status: "unverified", degraded: true });
    expect(calls).toHaveLength(0);
  });

  it.each(["tenantId", "workspaceId", "projectId", "runId", "attempt"] as const)("rejects a mismatched %s at acceptance", key => {
    const f = fixture();
    const altered = { ...f.currentScope, [key]: key === "attempt" ? 2 : "other" };
    expect(() => f.guard.acceptG1({ scope: altered, content: f.content, proof: f.proof })).toThrow("不属于当前运行与尝试");
    expect(() => f.guard.forPrd()).toThrow();
    expect(f.guard.forReview("G3_INSIGHT", f.current())!.deterministic[0]?.pass).toBe(false);
  });

  it.each([
    { approved: false }, { status: "unverified" }, { status: "failed" }, { via: "fallback" }, { via: "deterministic" },
    { degraded: true }, { model: "" }, { model: " " }, { gate: "G2_THEME" }, { evidence: [] },
  ])("rejects non-authoritative G1 proof %j", altered => {
    const f = fixture();
    expect(() => f.guard.acceptG1({ scope: f.currentScope, content: f.content, proof: { ...f.proof, ...altered } })).toThrow("真实 llm passed");
    expect(() => f.guard.forPrd()).toThrow();
  });

  it.each(["path", "hash", "scope", "duplicate", "malformed-extra"])("rejects G1 proof evidence with wrong %s", kind => {
    const f = fixture(), original = f.proof.evidence[0]!;
    const evidence = kind === "duplicate" ? [original, original] : kind === "malformed-extra"
      ? [original, { ...original, path: "metadata-only", scope: "excerpt" }] : [{ ...original,
      ...(kind === "path" ? { path: path.join(f.root, "elsewhere.md") } : {}),
      ...(kind === "hash" ? { sha256: "0".repeat(64) } : {}), ...(kind === "scope" ? { scope: "excerpt" } : {}) }];
    expect(() => f.guard.acceptG1({ scope: f.currentScope, content: f.content, proof: { ...f.proof, evidence } })).toThrow();
  });

  it.each(["issuer", "scope", "schema", "invalid-json"])("rejects a bound G1 original with invalid %s", kind => {
    const f = fixture(); const json = JSON.parse(f.content);
    if (kind === "issuer") json.facts.issuer = "metadata-self-approval";
    if (kind === "scope") json.facts.scope.attempt = 2;
    if (kind === "schema") json.facts.schemaVersion = "other";
    const content = kind === "invalid-json" ? "not-json" : JSON.stringify(json); writeFileSync(f.g1Path, content);
    const proof = { ...f.proof, evidence: [{ ...f.proof.evidence[0]!, sha256: sha(content) }] };
    expect(() => f.guard.acceptG1({ scope: f.currentScope, content, proof })).toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("clears accepted state before rejecting invalid attempt %s", attempt => {
    const f = fixture(); f.accept(); expect(() => f.guard.reset(attempt)).toThrow("尝试编号非法");
    expect(f.guard.forReview("G3_INSIGHT", f.current())!.deterministic[0]?.pass).toBe(false);
  });

  it("clears G1 and old review bindings on retry, even when project and run stay the same", async () => {
    const f = fixture(); f.accept(); const current = f.current(), old = f.guard.forReview("G3_INSIGHT", current)!;
    f.guard.reset(2); const next = { path: f.file("G3_INSIGHT", "第二次尝试完整正文", 2), kind: "text" as const, expectedSha256: sha("第二次尝试完整正文") };
    const calls: string[] = [], binding = f.guard.forReview("G3_INSIGHT", next)!;
    expect(await review(f, next, binding, calls)).toMatchObject({ approved: false, status: "unverified" }); expect(calls).toHaveLength(0);
    expect(f.guard.verifyReview(old, f.verdict(current))).toMatchObject({ approved: false, status: "unverified" });
  });

  it.each(["g1", "current", "missing", "symlink", "outside", "wrong-attempt", "no-hash"])("rejects %s evidence before any model call", async kind => {
    const f = fixture(); f.accept(); const current = f.current(); const calls: string[] = [];
    if (kind === "g1") writeFileSync(f.g1Path, `${f.content} `);
    if (kind === "current") writeFileSync(current.path, "changed");
    if (kind === "missing") rmSync(f.g1Path);
    if (kind === "symlink") { const copy = f.file("g1-copy", f.content); rmSync(f.g1Path); symlinkSync(copy, f.g1Path); }
    if (kind === "outside") current.path = path.join(f.root, "..", "G3_INSIGHT.md");
    if (kind === "wrong-attempt") current.path = f.file("G3_INSIGHT", readFileSync(current.path, "utf8"), 2);
    if (kind === "no-hash") delete current.expectedSha256;
    const binding = f.guard.forReview("G3_INSIGHT", current)!;
    expect(await review(f, current, binding, calls)).toMatchObject({ approved: false, status: "unverified", degraded: true });
    expect(calls).toHaveLength(0);
  });

  it.each(["g1", "current"])("rejects %s changed after preflight but before model invocation", async kind => {
    const f = fixture(); f.accept(); const current = f.current(), binding = f.guard.forReview("G3_INSIGHT", current)!, calls: string[] = [];
    writeFileSync(kind === "g1" ? f.g1Path : current.path, "changed after forReview");
    expect(await review(f, current, binding, calls)).toMatchObject({ approved: false, status: "unverified" }); expect(calls).toHaveLength(0);
  });

  it.each(["g1", "current"])("rejects %s changed during actual model review", async kind => {
    const f = fixture(); f.accept(); const current = f.current(), binding = f.guard.forReview("G3_INSIGHT", current)!, calls: string[] = [];
    const result = await review(f, current, binding, calls, good, () => writeFileSync(kind === "g1" ? f.g1Path : current.path, "changed during review"));
    expect(result).toMatchObject({ approved: false, status: "unverified", degraded: true }); expect(calls).toHaveLength(1);
  });

  it.each(["missing-g1", "missing-current", "wrong-hash", "excerpt", "duplicate", "fallback", "degraded", "no-model", "old-binding"])("rejects apparently-approved downstream verdict with %s", kind => {
    const f = fixture(); f.accept(); const current = f.current(), binding = f.guard.forReview("G3_INSIGHT", current)!, verdict = f.verdict(current);
    if (kind === "missing-g1") verdict.evidence!.shift();
    if (kind === "missing-current") verdict.evidence!.pop();
    if (kind === "wrong-hash") verdict.evidence![0]!.sha256 = "0".repeat(64);
    if (kind === "excerpt") verdict.evidence![0]!.scope = "excerpt";
    if (kind === "duplicate") verdict.evidence!.push({ ...verdict.evidence![0]! });
    if (kind === "fallback") verdict.via = "fallback";
    if (kind === "degraded") verdict.degraded = true;
    if (kind === "no-model") delete verdict.model;
    expect(f.guard.verifyReview(kind === "old-binding" ? { ...binding } : binding, verdict)).toMatchObject({ approved: false, status: "unverified", degraded: true });
  });

  it("does not let a failed replacement acceptance retain earlier approved authority", () => {
    const f = fixture(); f.accept(); expect(() => f.guard.acceptG1({ scope: f.currentScope, content: f.content, proof: {} })).toThrow();
    expect(f.guard.forReview("G3_INSIGHT", f.current())!.deterministic[0]?.pass).toBe(false);
  });
});
