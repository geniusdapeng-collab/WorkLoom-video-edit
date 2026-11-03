/** Native Film continuation for the existing Studio workflow receipt. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AI_PRODUCTION_DEFAULT_STAGES } from "./ai-production-defaults.ts";
import { normalizePrdProductionProfile } from "../../../packages/video-studio/src/prd-authority.ts";
import { admitFilmBudget, FilmContinuationError, filmRuntimeEnv } from "./codex-video-film-admission.mjs";
export { FilmContinuationError };

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const MAX_BYTES = 8 * 1024 * 1024;
const SCHEMA = "workloom.codex-video-film-continuation/v1";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const requireMatch = (value, code) => { if (!value) throw new FilmContinuationError(code); };
const safeId = (value) => typeof value === "string" && ID.test(value) && !value.includes("..");
function inside(parent, path) {
  const rel = relative(parent, path);
  return Boolean(rel && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

function readRegular(file, maxBytes = MAX_BYTES) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    requireMatch(info.isFile() && info.nlink === 1 && info.size > 0 && info.size <= maxBytes, "FILM_FILE_INVALID");
    const bytes = readFileSync(fd);
    requireMatch(bytes.length <= maxBytes, "FILM_FILE_INVALID");
    return bytes;
  } finally { closeSync(fd); }
}

function freezeFile(file, bytes) {
  const fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); }
  finally { closeSync(fd); }
  const directory = openSync(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function prepareFile(file, bytes) {
  if (existsSync(file)) requireMatch(readRegular(file).equals(bytes), "FILM_PREPARED_INPUT_CHANGED");
  else freezeFile(file, bytes);
}

function verifiedArchiveFile(root, ref, expectedRef, digest) {
  requireMatch(ref === expectedRef && HASH.test(digest ?? ""), "ARCHIVE_REFERENCE_INVALID");
  const file = join(root, ref);
  requireMatch(realpathSync(file) === file, "ARCHIVE_PATH_NOT_CANONICAL");
  const bytes = readRegular(file);
  requireMatch(hash(bytes) === digest, "ARCHIVE_DIGEST_MISMATCH");
  return { bytes, data: JSON.parse(bytes) };
}

export function verifyStudioHandoff({ archive, production, studio, studioRoot, requestedDuration, archiveReceipt }) {
  requireMatch(archive?.archiveExists === true && archive.projectId === studio.projectId
    && !archive.pendingApprovalId && production?.projectId === studio.projectId && safeId(production.sourceStageRunId)
    && Array.isArray(archive.stages), "CURRENT_PREPRODUCTION_NOT_VERIFIED");
  const root = realpathSync(archive.archiveRoot);
  requireMatch(inside(join(realpathSync(studioRoot), "archive"), root)
    && root.split(sep).at(-1) === studio.projectId, "ARCHIVE_OUT_OF_JOB_SCOPE");
  const current = archive.stages.filter((row) => row.stageId === "preproduction").sort((a, b) => b.attempt - a.attempt);
  const stage = current[0];
  requireMatch(stage?.status === "done" && stage.runId === studio.runId && Number.isSafeInteger(stage.attempt)
    && stage.attempt > 0 && stage.attempt !== current[1]?.attempt && stage.attempt === production.sourceAttempt
    && stage.attempt === archiveReceipt.attempt && stage.outputRef === archiveReceipt.outputRef
    && stage.outputSha256 === archiveReceipt.outputSha256, "STALE_OR_UNAPPROVED_PREPRODUCTION");
  const stem = "stages/preproduction/attempt-" + stage.attempt;
  const { data: output } = verifiedArchiveFile(root, stage.outputRef, stem + ".output.json", stage.outputSha256);
  const authority = output?.productionEvidence;
  requireMatch(output?.success === true && output.degraded !== true && output.promptsSha256 === production.promptsSha256
    && HASH.test(production.promptsSha256 ?? "") && authority?.schemaVersion === "workloom.preproduction-authority/v1"
    && authority.issuer === "workloom.studio-worker" && authority.projectId === studio.projectId
    && authority.runId === studio.runId && authority.attempt === stage.attempt && authority.pipelineKind === studio.pipeline
    && safeId(authority.workspaceId) && root === join(studioRoot, "archive", authority.workspaceId, studio.projectId),
  "PREPRODUCTION_PROOF_MISMATCH");
  const { data: shotlist, bytes } = verifiedArchiveFile(root, output.cliShotlistRef, stem + ".shotlist.json", output.cliShotlistSha256);
  const source = shotlist?.source;
  requireMatch(shotlist?.schemaVersion === "workloom.preproduction-cli-handoff/v1"
    && shotlist.projectId === studio.projectId && source?.kind === "system-preproduction" && source.issuer === authority.issuer
    && source.projectId === studio.projectId && source.runId === studio.runId && source.attempt === stage.attempt
    && source.workspaceId === authority.workspaceId && source.tenantId === authority.tenantId
    && Array.isArray(shotlist.shots) && shotlist.shots.length > 0
    && Array.isArray(production.shots) && shotlist.shots.length === production.shots.length, "SYSTEM_SHOTLIST_REQUIRED");
  let total = 0;
  for (let i = 0; i < shotlist.shots.length; i++) {
    const shot = shotlist.shots[i];
    const currentShot = production.shots[i];
    const prompt = shot.prompt;
    requireMatch((shot.shotId ?? shot.shot_id) === currentShot.shotId && typeof prompt === "string"
      && prompt === currentShot.prompt && hash(prompt) === currentShot.promptSha256
      && typeof shot.duration === "number" && shot.duration === currentShot.durationSec && shot.duration > 0,
    "SHOTLIST_NOT_CURRENT");
    total += shot.duration;
  }
  requireMatch(requestedDuration === undefined || Math.abs(total - requestedDuration) <= 1, "SYSTEM_DURATION_MISMATCH");
  const metadata = shotlist.metadata;
  requireMatch(object(metadata) && typeof metadata.platform === "string" && metadata.platform.trim(), "SYSTEM_PLATFORM_MISSING");
  const casting = metadata.builtinCharacterSelection;
  requireMatch(casting?.schemaVersion === "workloom.video-character-selection/v1"
    && ["none", "builtin", "custom", "mixed"].includes(casting.mode) && Array.isArray(casting.characters)
    && Array.isArray(shotlist.characters) && casting.characters.length === shotlist.characters.length
    && casting.characters.every((character, index) => safeId(character.id) && character.id === shotlist.characters[index]?.id),
  "SYSTEM_CAST_SOURCE_INVALID");
  return { bytes, shotDurations: shotlist.shots.map((shot) => shot.duration), platform: metadata.platform, aspect: shotlist.aspect ?? metadata.platformSelection?.aspectRatio,
    brief: metadata.brief ?? {}, usePortraitRefs: casting.mode === "builtin" || casting.mode === "mixed", source: { runId: studio.runId, attempt: stage.attempt, stageRunId: production.sourceStageRunId,
      outputSha256: stage.outputSha256, promptsSha256: production.promptsSha256, shotlistSha256: output.cliShotlistSha256, durationSeconds: total } };
}

function filmOptions(handoff) {
  const profile = normalizePrdProductionProfile({ brief: handoff.brief });
  const aspect = profile.aspectRatio ?? handoff.aspect;
  requireMatch(["16:9", "9:16", "1:1", "4:3"].includes(aspect) && safeId(handoff.platform), "SYSTEM_DELIVERY_PROFILE_INVALID");
  const resolution = profile.resolution === "4K" ? "2160p" : profile.resolution ?? "1080p";
  const subtitleMode = profile.subtitleMode === "burned" ? "burn" : profile.subtitleMode ?? "burn";
  requireMatch(!(profile.titleCard === true && (subtitleMode === "none" || subtitleMode === "sidecar" || profile.openWithCover === true))
    && !(profile.coverDelivery === "none" && profile.openWithCover === true), "SYSTEM_DELIVERY_PROFILE_UNSUPPORTED");
  const stages = AI_PRODUCTION_DEFAULT_STAGES.filter((stage) =>
    (stage !== "subtitle" || subtitleMode !== "none")
    && (stage !== "mux" || ["both", "sidecar"].includes(subtitleMode))
    && (stage !== "cover" || profile.coverDelivery !== "none" || profile.openWithCover === true));
  const persistent = profile.persistentSubtitleText;
  requireMatch(!persistent?.startsWith("--"), "SYSTEM_DELIVERY_PROFILE_INVALID");
  return {
    resolution, aspect, frameRate: profile.frameRate ?? 30, durationToleranceFrames: profile.durationToleranceFrames ?? null,
    options: ["--stages", stages.join(","), "--aspect", aspect, "--resolution", resolution,
      ...(profile.frameRate ? ["--fps", String(profile.frameRate)] : []),
      ...(subtitleMode !== "none" ? ["--subtitle-mode", subtitleMode] : []),
      ...(persistent ? ["--subtitle-persistent-text", persistent] : []),
      ...(profile.titleCard === false ? ["--no-title-card"] : []),
      ...(profile.openWithCover === false ? ["--no-open-with-cover"] : []),
      ...(profile.coverIntroSeconds === undefined ? [] : ["--cover-intro-seconds", String(profile.coverIntroSeconds)]),
      ...(profile.nativeAudio === undefined ? [] : ["--native-audio", profile.nativeAudio ? "1" : "0"])],
  };
}

function child({ command, args, root, env, logFile, input }) {
  return new Promise((done, reject) => {
    const log = logFile ? openSync(logFile, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600) : "ignore";
    let proc;
    try {
      proc = spawn(process.execPath, [...command, ...args], { cwd: root, env,
        stdio: [input ? "pipe" : "ignore", input ? "pipe" : log, log],
        ...(input ? { timeout: 300_000 } : {}) });
    } finally { if (typeof log === "number") closeSync(log); }
    const stdout = [];
    let size = 0;
    proc.once("error", reject);
    if (input) {
      proc.stdin.on("error", reject);
      proc.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size <= MAX_BYTES) stdout.push(chunk);
        else proc.kill();
      });
      proc.stdin.end(JSON.stringify(input));
    }
    proc.once("close", (code, signal) => done({ code, signal, stdout: Buffer.concat(stdout).toString("utf8") }));
  });
}

function nativeFilm({ args, root, env, logFile }) {
  return child({ command: ["--import", "tsx", "scripts/tools/full-chain-film.mts"], args, root, env, logFile });
}

async function nativeQuality({ root, env, projectId, outDir }) {
  const proc = await child({ command: ["scripts/workloom-agent.mjs"], root, env,
    args: ["invoke", "growth.video.post.quality", "--input-file", "-"], input: { projectId, outDir, kind: "generation" } });
  requireMatch(proc.code === 0, "DELIVERY_INSPECTION_FAILED");
  return JSON.parse(proc.stdout).result;
}

function paths(receiptPath, resolution) {
  const job = realpathSync(dirname(receiptPath));
  const work = join(job, "film-work");
  const delivery = join(job, "delivery");
  return { job, work, delivery, logFile: join(job, "film.log"), journal: join(job, "film-continuation.json"),
    outDir: resolution === "2160p" ? "delivery/uhd" : "delivery" };
}

function childEnv(env, job) {
  return { ...filmRuntimeEnv(env), WORKLOOM_VIDEO_ARTIFACT_ROOT: job };
}

async function inspect(journal, { root, env, logFile, job, delivery, quality }) {
  const report = await quality({ root, env, logFile, projectId: journal.projectId, outDir: journal.outDir });
  requireMatch(report?.complete === true && report.technicalQuality === "passed" && report.projectId === journal.projectId
    && HASH.test(report.manifestSha256 ?? "") && typeof report.manifestPath === "string", "DELIVERY_EVIDENCE_UNVERIFIED");
  const file = resolve(job, report.manifestPath);
  requireMatch(inside(delivery, file) && realpathSync(file) === file, "DELIVERY_PATH_OUT_OF_SCOPE");
  const bytes = readRegular(file);
  requireMatch(hash(bytes) === report.manifestSha256 && JSON.parse(bytes).sourceShotlistSha256 === journal.shotlistSha256,
    "DELIVERY_SOURCE_CHANGED");
  const duration = report.report?.assets?.find((asset) => asset.id === "master")?.probe?.videoDuration;
  const tolerance = journal.durationToleranceFrames === null ? 1 : (journal.durationToleranceFrames + 0.01) / journal.frameRate;
  requireMatch(Number.isFinite(duration) && Math.abs(duration - journal.targetDuration) <= tolerance, "DELIVERY_DURATION_OUT_OF_CONTRACT");
  return { manifestPath: relative(job, file), manifestSha256: report.manifestSha256, technicalQuality: "passed", durationSeconds: duration };
}

export async function readFilmContinuation({ receipt, receiptPath, root, env = process.env, quality = nativeQuality }) {
  const run = paths(receiptPath);
  if (!existsSync(run.journal)) return null;
  const journal = JSON.parse(readRegular(run.journal, 65_536));
  requireMatch(journal?.schemaVersion === SCHEMA && journal.projectId === receipt.projectId && journal.runId === receipt.runId
    && journal.requestSha256 === receipt.requestSha256 && HASH.test(journal.shotlistSha256 ?? "")
    && /^[a-f0-9]{40}$/u.test(journal.sourceCommit ?? "")
    && ["delivery", "delivery/uhd"].includes(journal.outDir) && journal.targetDuration === receipt.durationSeconds
    && Number.isFinite(journal.targetDuration) && [24, 25, 30, 60].includes(journal.frameRate)
    && [null, 0, 1].includes(journal.durationToleranceFrames), "FILM_RECEIPT_MISMATCH");
  try {
    const delivery = await inspect(journal, { ...run, root, env: childEnv(env, run.job), quality });
    return { ...journal, state: "finished", delivered: true, delivery };
  } catch (error) {
    const stopped = join(run.job, "film-process-result.json");
    const worker = existsSync(stopped) ? JSON.parse(readRegular(stopped, 4096)) : null;
    return { ...journal, state: !worker ? "film_dispatch_unknown" : worker.exitCode === 0 ? "delivery_unverified" : "film_interrupted",
      delivered: false, delivery: null,
      errorCode: error instanceof FilmContinuationError ? error.code : "DELIVERY_INSPECTION_FAILED" };
  }
}

export async function continueNativeFilm({ receipt, receiptPath, archiveReceipt, archive, production, service,
  sourceCommit, root, refreshSource, env = process.env, admission = admitFilmBudget, film = nativeFilm, quality = nativeQuality }) {
  const prior = await readFilmContinuation({ receipt, receiptPath, root, env, quality });
  if (prior) return prior;
  const job = realpathSync(dirname(receiptPath));
  const sourceRoot = realpathSync(root);
  requireMatch(job !== sourceRoot && !inside(sourceRoot, job), "FILM_PRIVATE_JOB_OUTSIDE_CHECKOUT_REQUIRED");
  const studioRoot = join(job, "studio");
  requireMatch(service?.sourceCommit === sourceCommit && /^[a-f0-9]{40}$/u.test(sourceCommit ?? "")
    && service.videoStudio?.deferRender === true && service.videoStudio.workDirSha256 === hash(studioRoot)
    && realpathSync(studioRoot) === studioRoot && lstatSync(studioRoot).isDirectory(), "EDIT_STUDIO_HANDOFF_CONFIGURATION_MISMATCH");
  const handoff = verifyStudioHandoff({ archive, production, studio: receipt, studioRoot,
    requestedDuration: receipt.durationSeconds, archiveReceipt });
  requireMatch(Number.isFinite(receipt.durationSeconds) && receipt.durationSeconds >= 5 && receipt.durationSeconds <= 180
    && Number(handoff.brief.duration) === receipt.durationSeconds, "STUDIO_DURATION_CONTRACT_MISMATCH");
  const { options, resolution, aspect, frameRate, durationToleranceFrames } = filmOptions(handoff);
  const run = paths(receiptPath, resolution);
  const lock = join(run.job, ".film-continuation.lock");
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === "EEXIST") throw new FilmContinuationError("FILM_ALREADY_RUNNING"); throw error; }
  try {
    requireMatch(!existsSync(run.journal) && !existsSync(run.work) && !existsSync(run.delivery), "FILM_JOB_ALREADY_USED");
    const budget = await admission({ env, shotDurations: handoff.shotDurations, aspect, resolution });
    if (refreshSource) {
      const current = await refreshSource();
      const fresh = verifyStudioHandoff({ ...current, studio: receipt, studioRoot,
        requestedDuration: receipt.durationSeconds, archiveReceipt });
      requireMatch(JSON.stringify(fresh.source) === JSON.stringify(handoff.source), "STUDIO_SOURCE_CHANGED_BEFORE_FILM");
    }
    const shotlist = join(run.job, "system-shotlist.json");
    const brief = join(run.job, "film-brief.json");
    prepareFile(shotlist, handoff.bytes);
    prepareFile(brief, bytesOf(handoff.brief));
    const journal = { schemaVersion: SCHEMA, projectId: receipt.projectId, runId: receipt.runId,
      requestSha256: receipt.requestSha256, outDir: run.outDir, sourceCommit,
      targetDuration: receipt.durationSeconds, frameRate, durationToleranceFrames, budget: budget.evidence,
      ...handoff.source, startedAt: new Date().toISOString() };
    freezeFile(run.journal, bytesOf(journal));
    const args = ["--shots", shotlist, "--brief", brief, "--project", receipt.projectId, "--route-kind", receipt.pipeline,
      "--platform", handoff.platform, "--work-dir", run.work, "--out", run.delivery, "--strict-source-cast",
      ...(handoff.usePortraitRefs ? ["--use-portrait-refs"] : []), ...options];
    const result = await film({ args, root, env: { ...childEnv(env, run.job), ...budget.environment }, logFile: run.logFile });
    freezeFile(join(run.job, "film-process-result.json"), bytesOf({ exitCode: result.code, signal: result.signal ?? null }));
    return readFilmContinuation({ receipt, receiptPath, root, env, quality });
  } finally { rmSync(lock, { recursive: true }); }
}
