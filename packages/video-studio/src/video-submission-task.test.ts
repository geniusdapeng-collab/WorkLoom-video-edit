import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVideoSubmissionRequest } from "./video-submission-request.js";
import { readVideoSubmissionRecovery, runVideoSubmission, VideoSubmissionError, type VideoSubmissionScope } from "./video-submission-task.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const response = (value: unknown, status = 200) => new Response(typeof value === "string" ? value : JSON.stringify(value), { status, headers: { "x-request-id": "actual-test-trace" } });
const success = () => response({ status: "succeeded", content: { video_url: "https://test.invalid/original.mp4?token=temporary", last_frame_url: "https://test.invalid/last.png" }, usage: { completion_tokens: 42 } });
function fixture(): VideoSubmissionScope {
  const root = mkdtempSync(join(tmpdir(), "video-journal-中文 ")); roots.push(root);
  const path = join(root, "prompt.txt"); writeFileSync(path, "frozen real prompt bytes");
  return { directory: join(root, "private-journal"), projectId: "P-1", stage: "videos", shotId: "S1", sourceHash: sha("source"), target: join(root, "S1.mp4"),
    request: buildVideoSubmissionRequest({ model: "doubao-seedance-2-5-260628", prompt: "frozen real prompt bytes", refs: [], seconds: 30, generateAudio: true, aspect: "9:16", resolution: "720p", seed: 4 }),
    inputArtifacts: [{ path, realpath: realpathSync(path), sha256: sha(readFileSync(path)), bytes: readFileSync(path).length }] };
}
function files(root: string): string[] { return existsSync(root) ? readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]) : []; }
function options(fetcher: typeof fetch, timeout = 6) {
  let clock = 1_800_000_000_000;
  return { baseUrl: "https://test.invalid/api/v3", authorization: "Bearer isolated-test-secret", fetch: fetcher,
    now: () => clock, sleep: async (ms: number) => { clock += ms; }, pollIntervalMs: 2, pollTimeoutMs: timeout };
}
function fake(fn: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch { return (async (input, init) => fn(String(input), init)) as typeof fetch; }
const method = (init?: RequestInit) => init?.method ?? "GET";
const recoveryScope = (scope: VideoSubmissionScope) => ({ directory: scope.directory, projectId: scope.projectId, shotId: scope.shotId, sourceHash: scope.sourceHash, model: String(scope.request.body.model) });

describe("persistent video task admission and cold recovery", () => {
  it("writes exact ACK before first GET, with private files and no credentials/raw images/signed URLs in JSON", async () => {
    const scope = fixture(); const calls: string[] = [];
    const result = await runVideoSubmission(scope, options(fake((_url, init) => {
      calls.push(method(init)); if (method(init) === "POST") { expect(sha(String(init?.body))).toBe(scope.request.wireRequestSha256); return response({ id: "task-original-01" }); }
      const ack = files(scope.directory).find((file) => file.endsWith("/ack.json"))!;
      expect(JSON.parse(readFileSync(ack, "utf8")).taskId).toBe("task-original-01"); expect(lstatSync(ack).mode & 0o777).toBe(0o600); return success();
    })));
    expect(calls).toEqual(["POST", "GET"]); expect(result.receipt.recovered).toBe(false);
    const journal = files(scope.directory).map((file) => readFileSync(file, "utf8")).join("\n");
    for (const secret of ["isolated-test-secret", "temporary", "data:image"]) expect(journal).not.toContain(secret);
    expect(journal).toContain(scope.request.wireRequestSha256);
  });
  it("query timeout retains ACK; cold recovery only GETs original task", async () => {
    const scope = fixture(); let posts = 0;
    await expect(runVideoSubmission(scope, options(fake((_url, init) => { if (method(init) === "POST") { posts++; return response({ data: { id: "task-cold" } }); } return response("temporary", 503); })))).rejects.toThrow("taskId=task-cold");
    const recovered = readVideoSubmissionRecovery(recoveryScope(scope))!;
    const result = await runVideoSubmission({ directory: scope.directory, ...recovered }, { ...options(fake((url, init) => { expect(method(init)).toBe("GET"); expect(url).toContain("task-cold"); return success(); })), recoveryOnly: true });
    expect(posts).toBe(1); expect(result.taskId).toBe("task-cold"); expect(result.receipt.recovered).toBe(true);
  });
  it("POST response lost after acceptance reserves contract and blocks every later automatic POST", async () => {
    const scope = fixture(); let calls = 0; const fetcher = fake(() => { calls++; throw new TypeError("response lost"); });
    await expect(runVideoSubmission(scope, options(fetcher))).rejects.toThrow("OUTCOME_UNKNOWN");
    await expect(runVideoSubmission(scope, options(fetcher))).rejects.toThrow("OUTCOME_UNKNOWN");
    expect(() => readVideoSubmissionRecovery(recoveryScope(scope))).toThrow("OUTCOME_UNKNOWN"); expect(calls).toBe(1);
  });
  it.each(["{invalid-json", JSON.stringify({ accepted: true }), JSON.stringify({ id: "bad/id" })])("unusable POST response stays unknown: %s", async (body) => {
    const scope = fixture(); let calls = 0; const fetcher = fake(() => { calls++; return response(body); });
    await expect(runVideoSubmission(scope, options(fetcher))).rejects.toThrow("OUTCOME_UNKNOWN");
    await expect(runVideoSubmission(scope, options(fetcher))).rejects.toThrow("OUTCOME_UNKNOWN"); expect(calls).toBe(1);
  });
  it("concurrent callers produce at most one POST while response is pending", async () => {
    const scope = fixture(); let posts = 0; let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const fetcher = fake(async (_url, init) => { if (method(init) === "POST") { posts++; await gate; return response({ id: "task-one" }); } return success(); });
    const first = runVideoSubmission(scope, options(fetcher)); await expect(runVideoSubmission(scope, options(fetcher))).rejects.toThrow("OUTCOME_UNKNOWN");
    release(); expect((await first).taskId).toBe("task-one"); expect(posts).toBe(1);
  });
  it.each(["failed", "expired", "cancelled", "canceled"])("terminal %s is recorded and blocks repeat dispatch/query", async (status) => {
    const scope = fixture(); let posts = 0; let calls = 0; const fetcher = fake((_url, init) => { calls++; if (method(init) === "POST") { posts++; return response({ id: "task-terminal" }); } return response({ status, error: { code: "ActualProviderFailure", message: "real failure" } }); });
    await expect(runVideoSubmission(scope, options(fetcher))).rejects.toThrow(status); const oldCalls = calls;
    await expect(runVideoSubmission(scope, options(fetcher))).rejects.toThrow("TERMINAL"); expect(calls).toBe(oldCalls); expect(posts).toBe(1);
    expect(JSON.parse(readFileSync(files(scope.directory).find((path) => path.endsWith("/terminal.json"))!, "utf8"))).toMatchObject({ taskId: "task-terminal", status, errorCode: "ActualProviderFailure" });
  });
  it.each([400, 401, 403, 429, 500])("POST rejection HTTP %s is not retried", async (status) => {
    const scope = fixture(); let calls = 0; const fetcher = fake(() => { calls++; return response({ error: { code: "Rejected" } }, status); });
    await expect(runVideoSubmission(scope, options(fetcher))).rejects.toThrow(`HTTP ${status}`);
    await expect(runVideoSubmission(scope, options(fetcher))).rejects.toThrow("TERMINAL"); expect(() => readVideoSubmissionRecovery(recoveryScope(scope))).toThrow("TERMINAL"); expect(calls).toBe(1);
  });
  it.each([401, 403, 404])("query HTTP %s retains task for GET-only recovery", async (status) => {
    const scope = fixture(); let posts = 0;
    await expect(runVideoSubmission(scope, options(fake((_url, init) => { if (method(init) === "POST") { posts++; return response({ id: "task-query" }); } return response("failure", status); })))).rejects.toThrow("taskId=task-query");
    const result = await runVideoSubmission(scope, options(fake((_url, init) => { expect(method(init)).toBe("GET"); return success(); })));
    expect(result.taskId).toBe("task-query"); expect(posts).toBe(1);
  });
  it.each(["queued", "running", "unknown", "{bad", "null", "[]"])("pending/invalid query %s reaches local deadline and retains ACK", async (state) => {
    const scope = fixture(); let posts = 0;
    await expect(runVideoSubmission(scope, options(fake((_url, init) => { if (method(init) === "POST") { posts++; return response({ id: "task-pending" }); } return response(state.startsWith("{") || state === "null" || state === "[]" ? state : { status: state }); })))).rejects.toThrow("VIDEO_TASK_PENDING");
    expect(posts).toBe(1); expect(files(scope.directory).some((path) => path.endsWith("/ack.json"))).toBe(true); expect(files(scope.directory).some((path) => path.endsWith("/terminal.json"))).toBe(false);
  });
  it("429 and 5xx permit bounded GET retries with zero second POST", async () => {
    const scope = fixture(); const calls: string[] = []; let query = 0;
    const result = await runVideoSubmission(scope, options(fake((_url, init) => { calls.push(method(init)); if (method(init) === "POST") return response({ id: "task-transient" }); query++; return query === 1 ? response("limit", 429) : query === 2 ? response("server", 502) : success(); }), 10));
    expect(result.taskId).toBe("task-transient"); expect(calls).toEqual(["POST", "GET", "GET", "GET"]);
  });
  it("success without video URL retains original task for next query/download", async () => {
    const scope = fixture(); let posts = 0;
    await expect(runVideoSubmission(scope, options(fake((_url, init) => { if (method(init) === "POST") { posts++; return response({ id: "task-no-url" }); } return response({ status: "succeeded", content: {} }); })))).rejects.toThrow("VIDEO_URL_MISSING");
    expect((await runVideoSubmission(scope, options(fake((_url, init) => { expect(method(init)).toBe("GET"); return success(); })))).taskId).toBe("task-no-url"); expect(posts).toBe(1);
  });
  it("ACK write failure reports taskId before any GET; invalid ACK cannot unlock POST", async () => {
    const scope = fixture(); let gets = 0; let posts = 0;
    await expect(runVideoSubmission(scope, options(fake((_url, init) => { if (method(init) === "POST") { posts++; const prepared = files(scope.directory).find((file) => file.endsWith("/prepared.json"))!; mkdirSync(join(prepared.slice(0, -"prepared.json".length), "ack.json")); return response({ id: "task-ack-write" }); } gets++; return success(); })))).rejects.toThrow("taskId=task-ack-write");
    await expect(runVideoSubmission(scope, options(fake(() => { throw new Error("network must not run"); })))).rejects.toThrow("RECORD_INVALID"); expect(posts).toBe(1); expect(gets).toBe(0);
  });
  it("same-size modified input is blocked before POST", async () => {
    const scope = fixture(); writeFileSync(scope.inputArtifacts[0]!.path, "X".repeat(scope.inputArtifacts[0]!.bytes)); let calls = 0;
    await expect(runVideoSubmission(scope, options(fake(() => { calls++; return success(); })))).rejects.toThrow("INPUT_CHANGED"); expect(calls).toBe(0);
  });
  it("symlinked source or journal directory is rejected", async () => {
    const scope = fixture(); const file = scope.inputArtifacts[0]!.path; const original = readFileSync(file); const redirected = `${file}.actual`; writeFileSync(redirected, original); rmSync(file); symlinkSync(redirected, file);
    await expect(runVideoSubmission(scope, options(fake(() => { throw new Error("must not call"); })))).rejects.toThrow("INPUT_CHANGED");
    rmSync(file); writeFileSync(file, original); const real = `${scope.directory}.actual`; mkdirSync(real); symlinkSync(real, scope.directory);
    await expect(runVideoSubmission(scope, options(fake(() => { throw new Error("must not call"); })))).rejects.toThrow("PATH_INVALID");
  });
  it("mutated wire or changed frozen contract cannot create another request", async () => {
    const scope = fixture(); scope.request.body.duration = 13; await expect(runVideoSubmission(scope, options(fake(() => { throw new Error("must not call"); })))).rejects.toThrow("REQUEST_CHANGED"); scope.request.body.duration = 30;
    await runVideoSubmission(scope, options(fake((_url, init) => method(init) === "POST" ? response({ id: "task-frozen" }) : success())));
    scope.request = buildVideoSubmissionRequest({ model: "doubao-seedance-2-5-260628", prompt: "changed prompt", refs: [], seconds: 30, generateAudio: true, aspect: "9:16", resolution: "720p" });
    await expect(runVideoSubmission(scope, options(fake(() => { throw new Error("must not call"); })))).rejects.toThrow("CONTRACT_CHANGED");
  });
  it("malformed prepared JSON is preserved instead of overwritten", async () => {
    const scope = fixture(); await expect(runVideoSubmission(scope, options(fake(() => { throw new Error("lost"); })))).rejects.toBeInstanceOf(VideoSubmissionError);
    const path = files(scope.directory).find((file) => file.endsWith("/prepared.json"))!; writeFileSync(path, '{"partial":', { mode: 0o600 });
    await expect(runVideoSubmission(scope, options(fake(() => { throw new Error("must not call"); })))).rejects.toThrow("JSON_INVALID"); expect(readFileSync(path, "utf8")).toBe('{"partial":');
  });
  it("GET-only recovery refuses creating a new task without prepared+ACK", async () => {
    const scope = fixture(); expect(readVideoSubmissionRecovery(recoveryScope(scope))).toBeNull();
    await expect(runVideoSubmission(scope, { ...options(fake(() => { throw new Error("must not call"); })), recoveryOnly: true })).rejects.toThrow("RECOVERY_PREPARED_REQUIRED");
  });
  it("mutated safe input plan or prompt identity is rejected before any POST", async () => {
    const scope = fixture(); const fetcher = fake(() => { throw new Error("must not call"); });
    scope.request.inputs.push({ role: "reference_image", purpose: "invented", sourceType: "asset-reference", verification: "external-reference" });
    await expect(runVideoSubmission(scope, options(fetcher))).rejects.toThrow("INPUT_PLAN_CHANGED");
    scope.request.inputs.pop(); scope.request.promptSha256 = sha("different prompt");
    await expect(runVideoSubmission(scope, options(fetcher))).rejects.toThrow("PROMPT_CHANGED");
  });
  it("provider error echoes cannot leak bare token, signed URLs or inline images", async () => {
    const scope = fixture(); const message = "bare isolated-test-secret https://test.invalid/a?signature=SENSITIVE_SIGNATURE data:image/png;base64,QUJDREVGRw== Bearer isolated-test-secret";
    let caught = "";
    try { await runVideoSubmission(scope, options(fake(() => response({ error: { code: "ActualRejection", message } }, 400)))); }
    catch (error) { caught = String(error); }
    const recorded = files(scope.directory).map((file) => readFileSync(file, "utf8")).join("\n") + caught;
    for (const value of ["isolated-test-secret", "SENSITIVE_SIGNATURE", "data:image/png;base64", "QUJDREVGRw=="]) expect(recorded).not.toContain(value);
    expect(recorded).toContain("ActualRejection");
  });
  it("usage persists only fixed finite numeric counters and request trace ID rejects URLs", async () => {
    const scope = fixture();
    await runVideoSubmission(scope, options(fake((_url, init) => method(init) === "POST"
      ? new Response(JSON.stringify({ id: "task-safe-usage" }), { headers: { "x-request-id": "https://test.invalid/trace?secret=TRACE_SECRET" } })
      : response({ status: "succeeded", content: { video_url: "https://test.invalid/v.mp4" }, usage: { completion_tokens: 42, "https://test.invalid/usage?signature=USAGE_SECRET": 1, arbitrary_secret_key: 2 } }))));
    const recorded = files(scope.directory).map((file) => readFileSync(file, "utf8")).join("\n");
    expect(recorded).toContain('"completion_tokens": 42');
    for (const value of ["TRACE_SECRET", "USAGE_SECRET", "arbitrary_secret_key"]) expect(recorded).not.toContain(value);
  });

});
