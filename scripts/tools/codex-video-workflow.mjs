#!/usr/bin/env node
/** Authenticated single-submit Studio entry and same-receipt Film continuation. */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { continueNativeFilm, FilmContinuationError, readFilmContinuation } from "./lib/codex-video-film.mjs";
import { fileURLToPath } from "node:url";
import { parseEditLoopbackApi, WorkflowError, withVerifiedEditService } from "./lib/edit-service-session.mjs";
import { normalizeExplicitBriefDuration, normalizePrdProductionProfile } from "../../packages/video-studio/src/prd-authority.ts";

const PRODUCT = "workloom-ai-video-edit";
const SCHEMA = "workloom.codex-video-workflow/v1";
const GUIDE = "docs/ai-video-workbench-guide.md";
const START = "video.studio.start";
const STATUS = "video.studio.status";
const ARCHIVE = "video.studio.archive";
const PRODUCTION_SHOTS = "video.production.shots";
const ROOT = resolve(import.meta.dirname, "../..");
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const shortText = ["title", "product", "category", "audience", "platform", "aspectRatio", "aspect_ratio", "description", "tone", "purpose"];
const briefFields = new Set([...shortText, "duration", "brand", "productionRequirements", "requirements", "character", "characters",
  "segmentContract", "account", "accountId", "voice", "sound", "audio", "dialogue", "constraints", "references", "assets",
  "productId", "scenePolicy", "language", "style", "targetAudience", "specialRequirements"]);
const USAGE = [
  "node --import tsx scripts/tools/codex-video-workflow.mjs --intent '<用户原话>' [--brief <JSON文件>]",
  "同一命令加 --execute --api http://127.0.0.1:PORT --receipt <私有目录中的绝对回执路径>",
  "node --import tsx scripts/tools/codex-video-workflow.mjs --status --receipt <同一回执绝对路径>",
  "node --import tsx scripts/tools/codex-video-workflow.mjs --continue --receipt <同一回执绝对路径>",
].join("\n");

function check(condition, code) { if (!condition) throw new WorkflowError(code); }
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const validId = value => typeof value === "string" && idPattern.test(value) && !value.includes("..");
const sha256 = value => createHash("sha256").update(value).digest("hex");
const envelope = (state, fields = {}) => ({ schemaVersion: SCHEMA, productId: PRODUCT, state, delivered: false, ...fields });

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    check(["--intent", "--brief", "--api", "--receipt", "--execute", "--status", "--continue"].includes(flag) && !Object.hasOwn(args, flag), "ARGUMENTS_INVALID");
    if (["--execute", "--status", "--continue"].includes(flag)) args[flag] = true;
    else {
      const value = argv[++i];
      check(typeof value === "string" && value.trim() && (flag === "--intent" || !value.startsWith("--")), "ARGUMENTS_INVALID");
      args[flag] = value;
    }
  }
  if (args["--api"]) {
    args["--api"] = parseEditLoopbackApi(args["--api"]);
  }
  if (args["--status"] || args["--continue"]) {
    check(!(args["--status"] && args["--continue"]) && !args["--execute"] && !args["--intent"]
      && !args["--brief"] && args["--receipt"], "ARGUMENTS_INVALID");
  } else {
    check(args["--intent"] && (!args["--execute"] || args["--api"] && args["--receipt"]), "ARGUMENTS_INVALID");
    check(args["--execute"] || !args["--receipt"], "ARGUMENTS_INVALID");
  }
  return args;
}

function readJsonFile(path, maxBytes, code, privateFile = false) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    check(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= maxBytes, code);
    if (privateFile) check((stat.mode & 0o077) === 0 && stat.uid === process.getuid?.(), code);
    const bytes = readFileSync(fd);
    check(bytes.length <= maxBytes, code);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { throw new WorkflowError(code); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function explicitSeconds(intent) {
  const text = intent.normalize("NFKC").replaceAll("半分钟", "0.5分钟");
  const number = String.raw`(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)`;
  const unit = String.raw`(?:秒(?:钟)?|seconds?\b|secs?\b|s\b|分钟|minutes?\b|mins?\b)`;
  const part = `${number}\\s*(?:${unit})?`;
  const range = new RegExp(`${part}\\s*(?:[-–—~～/]|至|到|或|\\bto\\b|\\bor\\b)\\s*${number}\\s*${unit}`, "iu");
  const compound = new RegExp(`${number}\\s*(?:分钟|分)\\s*${number}\\s*秒`, "u");
  const approximate = new RegExp(`(?:约|大概|大约|至少|至多|不超过|最多|少于|\\babout\\b|\\bat least\\b|\\bup to\\b)\\s*${number}\\s*${unit}|${number}\\s*${unit}\\s*(?:左右|以内|以上|以下)`, "iu");
  check(!range.test(text) && !compound.test(text) && !approximate.test(text), "DURATION_AMBIGUOUS");
  const matches = [...text.matchAll(new RegExp(`(?<![A-Za-z0-9_.])([-+]?${number})\\s*(${unit})`, "giu"))];
  const digits = "零一二三四五六七八九";
  const chinaNumber = raw => {
    const words = raw.replaceAll("〇", "零").replaceAll("两", "二");
    if (words.length === 1) return digits.indexOf(words);
    const tens = /^(?:([一二三四五六七八九])?十([一二三四五六七八九])?)$/u.exec(words);
    if (tens) return (tens[1] ? digits.indexOf(tens[1]) : 1) * 10 + (tens[2] ? digits.indexOf(tens[2]) : 0);
    const hundred = /^一百(?:(零[一二三四五六七八九])|([一二三四五六七八九])十([一二三四五六七八九])?)?$/u.exec(words);
    if (hundred) return 100 + (hundred[1] ? digits.indexOf(hundred[1][1])
      : hundred[2] ? digits.indexOf(hundred[2]) * 10 + (hundred[3] ? digits.indexOf(hundred[3]) : 0) : 0);
    throw new WorkflowError("DURATION_AMBIGUOUS");
  };
  const values = new Set(matches.map(([whole, raw, units]) => {
    const value = /^[+-]?\d/u.test(raw) ? Number(raw) : chinaNumber(raw);
    const seconds = value * (/^(?:分钟|min)/iu.test(units) ? 60 : 1);
    check(whole[0] !== "+" && Number.isFinite(seconds) && seconds >= 5 && seconds <= 180, "DURATION_INVALID");
    return seconds;
  }));
  check(values.size <= 1, "DURATION_AMBIGUOUS");
  return values.values().next().value;
}

export function buildStudioInput(intent, brief = {}) {
  check(typeof intent === "string" && intent.trim() && intent.length <= 2000 && !/[\0]/u.test(intent), "INTENT_INVALID");
  check(object(brief) && Buffer.byteLength(JSON.stringify(brief)) <= 64 * 1024
    && Object.keys(brief).every(key => briefFields.has(key)), "BRIEF_INVALID");
  const inspect = (value, depth = 0) => {
    check(depth <= 12, "BRIEF_INVALID");
    if (typeof value === "string") check(!value.includes("\0"), "BRIEF_INVALID");
    else if (Array.isArray(value)) { check(value.length <= 1000, "BRIEF_INVALID"); value.forEach(item => inspect(item, depth + 1)); }
    else if (object(value)) for (const [key, item] of Object.entries(value)) {
      check(!["__proto__", "constructor", "prototype"].includes(key), "BRIEF_INVALID"); inspect(item, depth + 1);
    }
    else check(value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value), "BRIEF_INVALID");
  };
  inspect(brief);
  for (const key of shortText) {
    if (Object.hasOwn(brief, key)) check(typeof brief[key] === "string" && brief[key].trim() && brief[key].length <= 16_384 && !brief[key].includes("\0"), "BRIEF_INVALID");
  }
  if (Object.hasOwn(brief, "brand")) check(object(brief.brand)
    && typeof brief.brand.name === "string" && brief.brand.name.trim() && brief.brand.name.length <= 200 && !brief.brand.name.includes("\0"), "BRIEF_INVALID");
  if (Object.hasOwn(brief, "productionRequirements")) {
    const requirements = brief.productionRequirements;
    check(object(requirements) && typeof requirements.resolution === "string" && typeof requirements.subtitleMode === "string", "BRIEF_INVALID");
  }
  let briefSeconds;
  try {
    check(!Object.hasOwn(brief, "duration") || brief.duration !== null, "BRIEF_INVALID");
    briefSeconds = normalizeExplicitBriefDuration(brief.duration);
    normalizePrdProductionProfile({ brief });
  } catch { throw new WorkflowError("BRIEF_INVALID"); }
  // A complete brief can contain per-scene timings, dialogue timings or product facts.
  // Only a stated total overrides that explicit header; never reinterpret every number as a new target.
  const durationText = intent.normalize("NFKC");
  const totals = [...durationText.matchAll(/(?:总时长|目标时长|视频时长|全片时长|total\s+duration)\s*[:：为是]?\s*([^\n，,。;；]{1,30})/giu)];
  const fullClip = [...durationText.matchAll(/(?:制作|生成|拍摄|做|拍)\s*(?:一[条支个部])?\s*((?:(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:秒钟?|seconds?\b|secs?\b|s\b|分钟|minutes?\b|mins?\b)|半分钟))\s*(?:的)?[^\n，,。;；\d]{0,12}?(?:广告|短片|视频|宣传片)/giu)];
  const targetExpressions = [...totals.map(match => match[1]), ...fullClip.map(match => match[0])];
  const timings = [...durationText.matchAll(/(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:秒钟?|seconds?\b|secs?\b|s\b|分钟|minutes?\b|mins?\b)/giu)];
  const onlyLocalTimings = timings.length > 0 && timings.every(match => /(?:开场|片头|开头|主体|中间|结尾|片尾|末尾|首镜|末镜|最后|最初|前|后|第[^\n，,。;；]{0,6}镜头?|镜头[^\n，,。;；]{0,6})\s*(?:保持|持续|展示)?\s*[:：]?\s*(?:约|大约)?\s*$/u.test(durationText.slice(Math.max(0, match.index - 16), match.index)));
  const rawSeconds = targetExpressions.length ? explicitSeconds(targetExpressions.join(" ")) : onlyLocalTimings ? undefined : explicitSeconds(intent);
  check(rawSeconds === undefined || briefSeconds === undefined || rawSeconds === briefSeconds, "DURATION_CONFLICT");
  const duration = rawSeconds ?? briefSeconds;
  check(duration !== undefined, "DURATION_REQUIRED");
  return { intent, route: "auto", metadata: { brief: { ...brief, duration } } };
}

function studioInput(intent, briefPath) {
  return buildStudioInput(intent, briefPath ? readJsonFile(briefPath, 64 * 1024, "BRIEF_INVALID") : {});
}

function privateReceiptPath(path) {
  check(isAbsolute(path) && resolve(path) === path, "RECEIPT_PATH_INVALID");
  let dir;
  try { dir = lstatSync(dirname(path)); } catch { throw new WorkflowError("RECEIPT_DIRECTORY_REQUIRED"); }
  check(dir.isDirectory() && (dir.mode & 0o077) === 0 && dir.uid === process.getuid?.(), "RECEIPT_DIRECTORY_NOT_PRIVATE");
  return path;
}

function writeExclusive(path, payload) {
  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, JSON.stringify(payload) + "\n");
    fsyncSync(fd);
  } catch (error) { throw new WorkflowError(error.code === "EEXIST" ? "RECEIPT_EXISTS" : "RECEIPT_WRITE_FAILED"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function syncReceiptDirectory(path) {
  const fd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function commitReceipt(path, receipt) {
  const next = `${path}.${randomUUID()}.pending`;
  try { writeExclusive(next, receipt); renameSync(next, path); syncReceiptDirectory(path); }
  catch { throw new WorkflowError("RECEIPT_WRITE_FAILED"); }
  finally { rmSync(next, { force: true }); }
}

function memberToken() {
  const token = process.env.WORKLOOM_ACCESS_TOKEN;
  check(typeof token === "string" && /^[A-Za-z0-9._~+\/=-]{16,8192}$/.test(token)
    || !token && /^[a-f0-9]{64}$/.test(process.env.WORKLOOM_DESKTOP_LOGIN_KEY ?? ""), "MEMBER_TOKEN_REQUIRED");
  return token;
}

function launchIdentity(data) {
  check(object(data), "STUDIO_RESPONSE_INVALID");
  if (data.kind === "clarify") {
    const missing = Array.isArray(data.missing) ? data.missing.filter(item => ["route", "product"].includes(item)) : [];
    return { state: "clarify", missing, next: ["按 Studio 正式分流补齐片型或商品。核对本次回执后另行提交明确的新输入。"] };
  }
  check(data.kind === "routed" && validId(data.projectId), "STUDIO_RESPONSE_INVALID");
  if (data.pipeline === "explainer") {
    check(data.runId === null && validId(data.shotbookId), "STUDIO_RESPONSE_INVALID");
    return { state: "explainer_handoff", projectId: data.projectId, pipeline: data.pipeline, shotbookId: data.shotbookId,
      next: ["video.explainer.saveScript", "video.explainer.shotbook", "video.explainer.submit", "video.explainer.finalize"] };
  }
  check(["narrative", "marketing"].includes(data.pipeline) && validId(data.runId), "STUDIO_RESPONSE_INVALID");
  return { state: "studio_started", projectId: data.projectId, runId: data.runId, pipeline: data.pipeline, next: [STATUS, ARCHIVE] };
}

async function launch(args) {
  const input = studioInput(args["--intent"], args["--brief"]);
  const request = JSON.stringify(input), requestSha256 = sha256(request);
  const durationSeconds = input.metadata.brief.duration;
  const configuredToken = process.env.WORKLOOM_ACCESS_TOKEN;
  check(!configuredToken || configuredToken.length < 16 || !request.includes(configuredToken), "CREDENTIAL_IN_INPUT");
  if (!args["--execute"]) return envelope("plan", { previewOnly: true, requestSha256, durationSeconds, officialEntry: START, input });
  const token = memberToken(), api = args["--api"], path = privateReceiptPath(args["--receipt"]);
  const marker = envelope("start_unknown", { api, requestSha256, durationSeconds,
    next: ["从正式 Studio 项目列表和归档核对是否已有登记。禁止因缺回执而重复提交。"] });
  return withVerifiedEditService(api, token, async (call, service) => {
    const configuredStudio = process.env.WORKLOOM_EDIT_STUDIO_ROOT;
    if (configuredStudio !== undefined) {
      let info;
      try { info = lstatSync(configuredStudio); } catch { throw new WorkflowError("EDIT_STUDIO_ROOT_INVALID"); }
      const rel = relative(ROOT, configuredStudio);
      check(isAbsolute(configuredStudio) && resolve(configuredStudio) === configuredStudio && realpathSync(configuredStudio) === configuredStudio && info.isDirectory()
        && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700 && info.uid === process.getuid?.()
        && (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)), "EDIT_STUDIO_ROOT_INVALID");
      check(service.videoStudio?.deferRender === true && service.videoStudio.workDirSha256 === sha256(configuredStudio),
        "EDIT_STUDIO_HANDOFF_CONFIGURATION_MISMATCH");
    }
    writeExclusive(path, marker);
    syncReceiptDirectory(path);
    let outcome;
    try {
      outcome = launchIdentity(await call(START, input));
      check(!token || !JSON.stringify(outcome).includes(token), "STUDIO_RESPONSE_INVALID");
    }
    catch (error) {
      const unknown = { ...marker, errorCode: error.code ?? "STUDIO_RESPONSE_UNKNOWN" };
      try { commitReceipt(path, unknown); } catch { /* The durable marker still prevents replay. */ }
      return unknown;
    }
    const receipt = { ...marker, ...outcome };
    try { commitReceipt(path, receipt); }
    catch { return { ...receipt, state: "receipt_persistence_failed", next: ["凭已返回的项目和运行 ID 核对 Studio，禁止重复提交。"] }; }
    return receipt;
  });
}

function matchingArchiveRecord(archive, receipt) {
  if (!object(archive) || archive.projectId !== receipt.projectId || archive.archiveExists !== true || !Array.isArray(archive.stages)) return null;
  let current = null;
  for (const row of archive.stages) {
    if (row?.stageId === "preproduction" && Number.isSafeInteger(row.attempt) && row.attempt > 0 && (!current || row.attempt >= current.attempt)) current = row;
  }
  if (!current || current.status !== "done" || current.runId !== receipt.runId || archive.pendingApprovalId
      || current.outputRef !== `stages/preproduction/attempt-${current.attempt}.output.json`
      || typeof current.outputSha256 !== "string" || !digestPattern.test(current.outputSha256)) return null;
  return { attempt: current.attempt, outputRef: current.outputRef, outputSha256: current.outputSha256 };
}

async function status(args) {
  const path = privateReceiptPath(args["--receipt"]);
  const receipt = readJsonFile(path, 64 * 1024, "RECEIPT_INVALID", true);
  check(object(receipt) && receipt.schemaVersion === SCHEMA && receipt.productId === PRODUCT && digestPattern.test(receipt.requestSha256 ?? ""), "RECEIPT_INVALID");
  let api;
  try { api = parseEditLoopbackApi(receipt.api); } catch { throw new WorkflowError("RECEIPT_INVALID"); }
  check(!args["--api"] || args["--api"] === api, "RECEIPT_API_MISMATCH");
  if (receipt.state === "start_unknown" || receipt.state === "clarify" || receipt.state === "explainer_handoff") {
    // Project/approval data from a receipt is never echoed wholesale.
    const next = receipt.state === "start_unknown" ? ["从正式 Studio 项目列表和归档核对，禁止重复提交。"]
      : receipt.state === "clarify" ? ["在正式 Studio 补齐片型或商品。"]
      : ["video.explainer.saveScript", "video.explainer.shotbook", "video.explainer.submit", "video.explainer.finalize"];
    const errorCode = receipt.state === "start_unknown" && typeof receipt.errorCode === "string" && /^STUDIO_[A-Z_]+$/.test(receipt.errorCode) ? receipt.errorCode : null;
    const explainer = receipt.state === "explainer_handoff" && validId(receipt.projectId) && validId(receipt.shotbookId)
      ? { projectId: receipt.projectId, shotbookId: receipt.shotbookId, pipeline: "explainer" } : {};
    return envelope(receipt.state, { requestSha256: receipt.requestSha256, ...(errorCode ? { errorCode } : {}), ...explainer, next });
  }
  check(receipt.state === "studio_started" && validId(receipt.projectId) && validId(receipt.runId)
    && ["marketing", "narrative"].includes(receipt.pipeline), "RECEIPT_INVALID");
  const job = { receipt, receiptPath: path, root: ROOT };
  const currentFilm = await readFilmContinuation(job);
  if (currentFilm) return filmEnvelope(receipt, currentFilm);
  const token = memberToken();
  // Resolve source identity before opening the short-lived, authenticated Studio connection.
  const sourceCommit = args["--continue"] ? cleanSourceCommit() : null;
  return withVerifiedEditService(api, token, async (call, service) => {
    let archive;
    const result = await readStudioStatus(receipt, token, call, value => { archive = value; });
    if (!args["--continue"] || result.state !== "preproduction_archived") return result;
    check(sourceCommit, "EDIT_CLEAN_SOURCE_COMMIT_REQUIRED");
    check(service.sourceCommit === sourceCommit, "EDIT_SERVICE_REVISION_MISMATCH");
    const project = { projectId: receipt.projectId };
    const production = await call(PRODUCTION_SHOTS, project);
    const refreshSource = async () => ({ archive: await call(ARCHIVE, project), production: await call(PRODUCTION_SHOTS, project) });
    const continued = await continueNativeFilm({ ...job, archiveReceipt: result.source, archive, production, service, sourceCommit, refreshSource });
    return filmEnvelope(receipt, continued);
  });
}

function cleanSourceCommit() {
  const git = (args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8", timeout: 5_000 });
  const head = git(["rev-parse", "HEAD"]), status = git(["status", "--porcelain", "--untracked-files=no"]);
  const sourceCommit = head.stdout?.trim();
  return head.status === 0 && status.status === 0 && !status.stdout.trim() && /^[a-f0-9]{40}$/u.test(sourceCommit ?? "")
    ? sourceCommit : null;
}

function filmEnvelope(receipt, result) {
  const { state, delivered, delivery, shotlistSha256, sourceCommit, errorCode } = result;
  const fields = { delivered, projectId: receipt.projectId, runId: receipt.runId, pipeline: receipt.pipeline,
    requestSha256: receipt.requestSha256, shotlistSha256, sourceCommit };
  return state === "finished" ? envelope(state, { ...fields, delivery }) : envelope(state, { ...fields, errorCode,
    next: ["从同一作业的 Film 日志和当前交付回读对账。继续查询不重复提交。"] });
}

async function readStudioStatus(receipt, token, call, observeArchive) {
  const identity = { projectId: receipt.projectId, runId: receipt.runId, pipeline: receipt.pipeline, requestSha256: receipt.requestSha256 };
  const readback = [ARCHIVE, "回读本工作区原项目和运行，勿重复启动。"];
  let actual;
  try { actual = await call(STATUS, { runId: receipt.runId }); }
  catch (error) { return envelope("status_unavailable", { ...identity, errorCode: error.code, next: readback }); }
  if (!object(actual) || actual.runId !== receipt.runId || actual.projectId !== receipt.projectId) {
    return envelope("status_unavailable", { ...identity, errorCode: actual === null ? "STUDIO_STATUS_NOT_FOUND" : "STUDIO_STATUS_MISMATCH", next: readback });
  }
  const studioStatus = ["running", "awaiting_approval", "finished", "failed", "aborted"].includes(actual.status) ? actual.status : "unrecognized";
  const stage = validId(actual.currentGate) && (!token || !actual.currentGate.includes(token)) ? actual.currentGate : null;
  const pendingApprovalId = validId(actual.pendingApprovalId) && (!token || !actual.pendingApprovalId.includes(token)) ? actual.pendingApprovalId : null;
  const current = { ...identity, studioStatus, currentGate: stage, pendingApprovalId, errorPresent: Boolean(actual.error) };
  if (studioStatus === "awaiting_approval" || actual.pendingApprovalId) {
    return envelope("awaiting_approval", { ...current, next: ["在本机产品页核对并处理当前正式审批，再用原回执回读。"] });
  }
  if (studioStatus !== "finished") return envelope(studioStatus === "running" ? "preproduction_running" : "status_unavailable", {
    ...current, next: studioStatus === "running" ? [STATUS] : [ARCHIVE, "在 Studio 查看原错误，使用正式恢复入口。"],
  });
  let archive;
  try { archive = await call(ARCHIVE, { projectId: receipt.projectId }); }
  catch (error) { return envelope("preproduction_source_unverified", { ...current, errorCode: error.code, next: readback }); }
  const source = matchingArchiveRecord(archive, receipt);
  if (!source || token && source.outputSha256.includes(token)) return envelope("preproduction_source_unverified", { ...current, next: [ARCHIVE, "核对同轮最新前期尝试和档案，不进入付费渲染。"] });
  observeArchive(archive);
  return envelope("preproduction_archived", { ...current, source,
    next: [PRODUCTION_SHOTS, "--continue --receipt <本次原回执>", "按 " + GUIDE + " 核对本轮渲染授权后继续。"] });
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) console.log(USAGE);
    else {
      const result = await (args["--status"] || args["--continue"] ? status(args) : launch(args));
      console.log(JSON.stringify(result, null, 2));
      if (["start_unknown", "receipt_persistence_failed", "status_unavailable", "preproduction_source_unverified", "film_dispatch_unknown", "film_interrupted", "delivery_unverified"].includes(result.state)) process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ code: error instanceof WorkflowError || error instanceof FilmContinuationError ? error.code : "WORKFLOW_FAILED", delivered: false }));
    process.exitCode = 2;
  }
}
