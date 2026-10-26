/** Private, create-only video submission journal. A known/unknown dispatch is never automatically POSTed again. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { VideoSubmissionRequest } from "./video-submission-request.js";

const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export interface VideoSubmissionArtifact { path: string; realpath: string; sha256: string; bytes: number }
export interface VideoSubmissionScope {
  directory: string; projectId: string; stage: string; shotId: string; sourceHash: string; target: string;
  request: VideoSubmissionRequest; inputArtifacts: VideoSubmissionArtifact[];
}
export class VideoSubmissionError extends Error {
  readonly retryPost = false;
  constructor(message: string, readonly taskId: string | null = null) { super(`${message}${taskId ? `; taskId=${taskId}` : ""}`); this.name = "VideoSubmissionError"; }
}
export interface VideoSubmissionResult {
  taskId: string; url: string; lastFrame: string | null;
  receipt: { preparedFile: string; preparedSha256: string; ackFile: string; wireRequestSha256: string; inputPlanSha256: string; recovered: boolean };
}
interface Prepared {
  schemaVersion: "workloom.video-submission/v1"; clientSubmissionId: string; createdAt: string;
  projectId: string; stage: string; shotId: string; sourceHash: string; target: string;
  model: unknown; seconds: unknown; mode: string; promptSha256: string; wireRequestSha256: string; inputPlanSha256: string;
  inputs: VideoSubmissionRequest["inputs"]; inputArtifacts: VideoSubmissionArtifact[];
}
interface Ack { schemaVersion: "workloom.video-submission-ack/v1"; taskId: string; preparedSha256: string; acknowledgedAt: string; httpStatus: number; requestId: string | null }
function safeProviderError(value: unknown, authorization: string): { code: string; message: string } {
  const redact = (part: unknown): string => String(part ?? "")
    .split(authorization).join("[authorization-redacted]")
    .split(authorization.replace(/^Bearer\s+/i, "") || authorization).join("[authorization-redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "[authorization-redacted]")
    .replace(/data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "[image-redacted]")
    .replace(/https?:\/\/[^\s<>"']+/gi, "[url-redacted]").slice(0, 500);
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const error = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : record;
  return { code: redact(error.code || "unknown"), message: redact(error.message || "Provider response did not contain a structured error message") };
}
function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new VideoSubmissionError(`VIDEO_JOURNAL_PATH_INVALID: ${path}`);
}
function syncDirectory(path: string): void { const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
/** A fully synced temporary inode is linked into its final name without replacing any existing evidence. */
function exclusiveJson(path: string, value: unknown, directory: string): void {
  const temporary = join(directory, `.pending-${randomUUID()}.json`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined;
    linkSync(temporary, path); syncDirectory(directory);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
function readJson<T>(path: string): T {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 20_000_000) throw new VideoSubmissionError(`VIDEO_JOURNAL_RECORD_INVALID: ${path}`);
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch (error) { throw new VideoSubmissionError(`VIDEO_JOURNAL_JSON_INVALID: ${path}: ${error instanceof Error ? error.message : String(error)}`); }
}
export function verifyVideoSubmissionArtifacts(artifacts: VideoSubmissionArtifact[]): void {
  for (const expected of artifacts) {
    let fd: number | undefined;
    try {
      fd = openSync(expected.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd), bytes = readFileSync(fd);
      if (!stat.isFile() || realpathSync(expected.path) !== expected.realpath || stat.size !== expected.bytes
        || bytes.length !== expected.bytes || hash(bytes) !== expected.sha256) throw new Error("current bytes, size or realpath differ");
    } catch (error) { throw new VideoSubmissionError(`VIDEO_SUBMISSION_INPUT_CHANGED: ${expected.path}: ${error instanceof Error ? error.message : String(error)}`); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
}
function submissionDirectory(scope: Pick<VideoSubmissionScope, "directory" | "projectId" | "shotId" | "sourceHash">): string {
  return join(scope.directory, hash(JSON.stringify({ projectId: scope.projectId, shotId: scope.shotId, sourceHash: scope.sourceHash })));
}
/** Inspect an existing sealed contract without reconstructing credentialed URLs or inventing request bytes. GET-only recovery is explicit. */
export function readVideoSubmissionRecovery(scope: { directory: string; projectId: string; shotId: string; sourceHash: string; model: string }): Omit<VideoSubmissionScope, "directory"> | null {
  const directory = submissionDirectory(scope);
  if (!existsSync(directory)) return null;
  if (lstatSync(directory).isSymbolicLink()) throw new VideoSubmissionError("VIDEO_JOURNAL_PATH_INVALID");
  const preparedFile = join(directory, "prepared.json");
  if (!existsSync(preparedFile)) throw new VideoSubmissionError("VIDEO_SUBMISSION_PREPARED_MISSING: existing reservation cannot be reused");
  const prepared = readJson<Prepared>(preparedFile);
  if (prepared.schemaVersion !== "workloom.video-submission/v1" || prepared.projectId !== scope.projectId || prepared.shotId !== scope.shotId
    || prepared.sourceHash !== scope.sourceHash || prepared.model !== scope.model || !["videos", "material-gen"].includes(prepared.stage)
    || ![prepared.promptSha256, prepared.wireRequestSha256, prepared.inputPlanSha256].every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
    || !Array.isArray(prepared.inputs) || !Array.isArray(prepared.inputArtifacts)
    || prepared.inputPlanSha256 !== hash(JSON.stringify({ mode: prepared.mode, inputs: prepared.inputs }))) throw new VideoSubmissionError("VIDEO_SUBMISSION_RECOVERY_CONTRACT_INVALID");
  if (existsSync(join(directory, "terminal.json"))) {
    const terminal = readJson<{ preparedSha256?: string; taskId?: string; status?: string; httpStatus?: number; errorCode?: string }>(join(directory, "terminal.json"));
    if (terminal.preparedSha256 !== hash(readFileSync(preparedFile))) throw new VideoSubmissionError("VIDEO_SUBMISSION_TERMINAL_INVALID");
    throw new VideoSubmissionError(`VIDEO_SUBMISSION_TERMINAL: ${terminal.status ?? "unknown"}; HTTP ${terminal.httpStatus ?? "n/a"}; ${terminal.errorCode ?? "unknown"}; not resubmitted`, typeof terminal.taskId === "string" ? terminal.taskId : null);
  }
  if (!existsSync(join(directory, "ack.json"))) {
    if (existsSync(join(directory, "dispatch-started.json"))) throw new VideoSubmissionError("VIDEO_SUBMISSION_OUTCOME_UNKNOWN: existing dispatch has no ACK; no automatic POST or paid preparation");
    return null; // No dispatch was ever recorded; normal construction may finish this exact prepared contract.
  }
  return { projectId: prepared.projectId, stage: prepared.stage, shotId: prepared.shotId, sourceHash: prepared.sourceHash, target: prepared.target,
    inputArtifacts: prepared.inputArtifacts,
    request: { body: { model: prepared.model, duration: prepared.seconds }, mode: prepared.mode as VideoSubmissionRequest["mode"],
      promptSha256: prepared.promptSha256, wireRequestSha256: prepared.wireRequestSha256, inputPlanSha256: prepared.inputPlanSha256, inputs: prepared.inputs } };
}
/** Dependencies are injectable for isolated offline tests. Authorization is only ever passed to fetch. */
export async function runVideoSubmission(scope: VideoSubmissionScope, options: {
  baseUrl: string; authorization: string; fetch?: typeof fetch; now?: () => number; sleep?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number; pollTimeoutMs?: number; recoveryOnly?: boolean;
}): Promise<VideoSubmissionResult> {
  if (typeof options.authorization !== "string" || !options.authorization.trim()) throw new VideoSubmissionError("VIDEO_SUBMISSION_AUTHORIZATION_REQUIRED");
  const fetcher = options.fetch ?? fetch, now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  const at = (): string => new Date(now()).toISOString();
  if (!scope.projectId || !scope.shotId || !/^[a-f0-9]{64}$/.test(scope.sourceHash)) throw new VideoSubmissionError("VIDEO_SUBMISSION_SCOPE_INVALID");
  if (!options.recoveryOnly && hash(JSON.stringify(scope.request.body)) !== scope.request.wireRequestSha256) throw new VideoSubmissionError("VIDEO_SUBMISSION_REQUEST_CHANGED");
  if (hash(JSON.stringify({ mode: scope.request.mode, inputs: scope.request.inputs })) !== scope.request.inputPlanSha256) throw new VideoSubmissionError("VIDEO_SUBMISSION_INPUT_PLAN_CHANGED");
  if (!options.recoveryOnly) {
    const content = scope.request.body.content as Array<{ type?: string; text?: unknown }> | undefined;
    if (!Array.isArray(content) || content[0]?.type !== "text" || typeof content[0].text !== "string"
      || hash(content[0].text) !== scope.request.promptSha256) throw new VideoSubmissionError("VIDEO_SUBMISSION_PROMPT_CHANGED");
  }
  if (!scope.inputArtifacts.length || scope.inputArtifacts.some((item) => !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 1)) throw new VideoSubmissionError("VIDEO_SUBMISSION_INPUT_MANIFEST_INVALID");
  for (const input of scope.request.inputs) if (input.artifact) {
    const actual = scope.inputArtifacts.find((item) => resolve(item.path) === resolve(input.artifact!.path));
    if (!actual || actual.sha256 !== input.artifact.sha256 || actual.bytes !== input.artifact.bytes) throw new VideoSubmissionError("VIDEO_SUBMISSION_INPUT_PLAN_MISMATCH");
  }
  verifyVideoSubmissionArtifacts(scope.inputArtifacts);
  privateDirectory(scope.directory);
  const directory = submissionDirectory(scope); privateDirectory(directory);
  const preparedFile = join(directory, "prepared.json"), dispatchFile = join(directory, "dispatch-started.json"), ackFile = join(directory, "ack.json"), terminalFile = join(directory, "terminal.json");
  const contract = {
    projectId: scope.projectId, stage: scope.stage, shotId: scope.shotId, sourceHash: scope.sourceHash, target: resolve(scope.target),
    model: scope.request.body.model, seconds: scope.request.body.duration, mode: scope.request.mode,
    promptSha256: scope.request.promptSha256, wireRequestSha256: scope.request.wireRequestSha256,
    inputPlanSha256: scope.request.inputPlanSha256, inputs: scope.request.inputs, inputArtifacts: scope.inputArtifacts,
  };
  const newPrepared: Prepared = { schemaVersion: "workloom.video-submission/v1", clientSubmissionId: randomUUID(), createdAt: at(), ...contract };
  if (!existsSync(preparedFile)) {
    if (options.recoveryOnly) throw new VideoSubmissionError("VIDEO_SUBMISSION_RECOVERY_PREPARED_REQUIRED");
    try { exclusiveJson(preparedFile, newPrepared, directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const prepared = readJson<Prepared>(preparedFile);
  const { schemaVersion, clientSubmissionId, createdAt, ...existingContract } = prepared;
  if (schemaVersion !== newPrepared.schemaVersion || !clientSubmissionId || !Number.isFinite(Date.parse(createdAt))
    || JSON.stringify(existingContract) !== JSON.stringify(contract)) throw new VideoSubmissionError(`VIDEO_SUBMISSION_CONTRACT_CHANGED: ${preparedFile}; existing dispatch must be resolved before a different request`);
  const preparedSha256 = hash(readFileSync(preparedFile));
  const event = (status: string, detail: Record<string, unknown> = {}): void => {
    try { exclusiveJson(join(directory, `event-${String(now())}-${randomUUID()}.json`), { at: at(), status, preparedSha256, ...detail }, directory); }
    catch (error) { throw new VideoSubmissionError(`VIDEO_TASK_EVENT_WRITE_FAILED: ${error instanceof Error ? error.message : String(error)}`, typeof detail.taskId === "string" ? detail.taskId : null); }
  };
  let ack: Ack | null = existsSync(ackFile) ? readJson<Ack>(ackFile) : null;
  const recovered = Boolean(ack);
  if (ack && (ack.schemaVersion !== "workloom.video-submission-ack/v1" || ack.preparedSha256 !== preparedSha256 || !/^[A-Za-z0-9._:-]{1,256}$/.test(ack.taskId))) throw new VideoSubmissionError(`VIDEO_SUBMISSION_ACK_INVALID: ${ackFile}`);
  if (existsSync(terminalFile)) {
    const terminal = readJson<{ preparedSha256?: string; taskId?: string; status?: string }>(terminalFile);
    if (terminal.preparedSha256 !== preparedSha256) throw new VideoSubmissionError("VIDEO_SUBMISSION_TERMINAL_INVALID", ack?.taskId ?? null);
    throw new VideoSubmissionError(`VIDEO_SUBMISSION_TERMINAL: ${terminal.status ?? "unknown"}; not resubmitted`, ack?.taskId ?? null);
  }
  if (!ack) {
    if (options.recoveryOnly) throw new VideoSubmissionError("VIDEO_SUBMISSION_RECOVERY_ACK_REQUIRED: GET-only recovery cannot POST");
    if (existsSync(dispatchFile)) throw new VideoSubmissionError(`VIDEO_SUBMISSION_OUTCOME_UNKNOWN: ${dispatchFile}; no automatic POST retry`);
    verifyVideoSubmissionArtifacts(scope.inputArtifacts);
    try { exclusiveJson(dispatchFile, { preparedSha256, clientSubmissionId: prepared.clientSubmissionId, dispatchedAt: at() }, directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new VideoSubmissionError("VIDEO_SUBMISSION_ALREADY_DISPATCHING; no automatic POST retry"); throw error; }
    let response: Response, text: string;
    try {
      response = await fetcher(`${options.baseUrl.replace(/\/$/, "")}/contents/generations/tasks`, {
        method: "POST", headers: { "content-type": "application/json", authorization: options.authorization },
        body: JSON.stringify(scope.request.body), signal: AbortSignal.timeout(120_000),
      });
      text = await response.text();
    } catch (error) { event("submission-outcome-unknown", { reason: error instanceof Error ? error.name : "transport-error" }); throw new VideoSubmissionError("VIDEO_SUBMISSION_OUTCOME_UNKNOWN: POST transport/response lost; no automatic POST retry"); }
    if (!response.ok) {
      let parsedError: unknown; try { parsedError = JSON.parse(text); } catch { parsedError = null; }
      const error = safeProviderError(parsedError, options.authorization);
      exclusiveJson(terminalFile, { preparedSha256, at: at(), status: "submit-rejected", httpStatus: response.status, errorCode: error.code, message: error.message }, directory);
      throw new VideoSubmissionError(`VIDEO_SUBMISSION_REJECTED: HTTP ${response.status}; ${error.code}: ${error.message}`);
    }
    let json: { id?: unknown; data?: { id?: unknown } };
    try { json = JSON.parse(text) as typeof json; }
    catch { event("submission-outcome-unknown", { reason: "invalid-json", httpStatus: response.status }); throw new VideoSubmissionError("VIDEO_SUBMISSION_OUTCOME_UNKNOWN: successful POST returned invalid JSON; no automatic POST retry"); }
    const id = json.id ?? json.data?.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(id)) { event("submission-outcome-unknown", { reason: "missing-task-id" }); throw new VideoSubmissionError("VIDEO_SUBMISSION_OUTCOME_UNKNOWN: POST has no valid taskId; no automatic POST retry"); }
    ack = { schemaVersion: "workloom.video-submission-ack/v1", taskId: id, preparedSha256, acknowledgedAt: at(), httpStatus: response.status,
      requestId: [response.headers.get("x-request-id"), response.headers.get("x-tt-logid")].find((value) => value && /^[A-Za-z0-9._:-]{1,256}$/.test(value)) ?? null };
    try { exclusiveJson(ackFile, ack, directory); }
    catch (error) { throw new VideoSubmissionError(`VIDEO_SUBMISSION_ACK_WRITE_FAILED: preserve taskId and repair journal; ${error instanceof Error ? error.message : String(error)}`, id); }
  }
  // ACK is durably readable before the very first GET, including after a cold restart.
  const taskId = ack.taskId;
  const deadline = now() + (options.pollTimeoutMs ?? 20 * 60_000);
  while (now() < deadline) {
    let response: Response, text: string;
    try {
      response = await fetcher(`${options.baseUrl.replace(/\/$/, "")}/contents/generations/tasks/${encodeURIComponent(taskId)}`, { headers: { authorization: options.authorization }, signal: AbortSignal.timeout(60_000) });
      text = await response.text();
    } catch (error) { event("unknown", { taskId, reason: error instanceof Error ? error.name : "poll-transport-error" }); await sleep(options.pollIntervalMs ?? 10_000); continue; }
    if (!response.ok) {
      event("unknown", { taskId, httpStatus: response.status });
      if (response.status !== 429 && response.status < 500) throw new VideoSubmissionError(`VIDEO_TASK_QUERY_FAILED: HTTP ${response.status}; resume this task only`, taskId);
      await sleep(options.pollIntervalMs ?? 10_000); continue;
    }
    let state: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(text); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object"); state = parsed as Record<string, unknown>; }
    catch { event("unknown", { taskId, reason: "invalid-query-json" }); await sleep(options.pollIntervalMs ?? 10_000); continue; }
    const status = String(state.status ?? "unknown");
    const providerError = state.error && typeof state.error === "object" ? safeProviderError(state, options.authorization) : null;
    const usage = state.usage && typeof state.usage === "object" ? Object.fromEntries(Object.entries(state.usage).filter(([key, value]) => ["completion_tokens", "total_tokens", "input_tokens", "output_tokens", "generated_frames", "video_duration", "video_tokens", "audio_tokens"].includes(key) && typeof value === "number" && Number.isFinite(value))) : null;
    event(["queued", "running", "succeeded", "success", "failed", "expired", "cancelled", "canceled"].includes(status) ? status : "unknown", { taskId, ...(providerError ? { errorCode: providerError.code } : {}), ...(usage ? { usage } : {}) });
    if (["failed", "expired", "cancelled", "canceled"].includes(status)) {
      try { exclusiveJson(terminalFile, { preparedSha256, taskId, at: at(), status, errorCode: providerError?.code ?? null, message: providerError?.message ?? null }, directory); }
      catch (error) { throw new VideoSubmissionError(`VIDEO_TASK_TERMINAL_WRITE_FAILED: ${error instanceof Error ? error.message : String(error)}`, taskId); }
      throw new VideoSubmissionError(`VIDEO_TASK_TERMINAL: ${status}; ${providerError ? `${providerError.code}: ${providerError.message}` : "provider terminal failure"}; not resubmitted`, taskId);
    }
    if (status === "succeeded" || status === "success") {
      const content = state.content && typeof state.content === "object" ? state.content as Record<string, unknown> : {};
      const url = typeof content.video_url === "string" ? content.video_url : "";
      if (!/^https?:\/\//.test(url)) throw new VideoSubmissionError("VIDEO_TASK_VIDEO_URL_MISSING: succeeded task retained for query/download recovery", taskId);
      return { taskId, url, lastFrame: typeof content.last_frame_url === "string" ? content.last_frame_url : null,
        receipt: { preparedFile, preparedSha256, ackFile, wireRequestSha256: scope.request.wireRequestSha256, inputPlanSha256: scope.request.inputPlanSha256, recovered } };
    }
    await sleep(options.pollIntervalMs ?? 10_000);
  }
  event("pending-local-deadline", { taskId });
  throw new VideoSubmissionError("VIDEO_TASK_PENDING: local polling deadline reached; resume this task only", taskId);
}
