/** Reviewed Edit workflow bridge. Only fixed native operations may cross this boundary. */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseEditLoopbackApi, withVerifiedEditService } from './edit-service-session.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');
const SCHEMA = 'workloom.edit-agent-workflow/v1';
const JOB_SCHEMA = 'workloom.edit-agent-job/v1';
const JOB = /^JOB-[a-f0-9]{64}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const LIMIT = 96 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const inside = (root, file) => { const rel = relative(root, file); return rel === '' || rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
const canonical = value => JSON.stringify(value, (_, item) => object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export class EditAgentError extends Error { constructor(code) { super(code); this.code = code; } }
const check = (condition, code) => { if (!condition) throw new EditAgentError(code); };
function keys(input, allowed, required = []) {
  check(object(input) && Object.keys(input).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(input, key)), 'EDIT_INPUT_INVALID');
  return input;
}
const stringId = value => typeof value === 'string' && ID.test(value) && !value.includes('..');
function authorization(input, phase) { keys(input, [phase], [phase]); check(input[phase] === true, 'EDIT_AUTHORIZATION_REQUIRED'); }
function envelope(id, state, data = {}) { return { schemaVersion: SCHEMA, capabilityId: id, state, delivered: false, ...data }; }
function safeOutput(value, env) {
  const text = JSON.stringify(value);
  for (const [name, secret] of Object.entries(env)) {
    if (!/(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|LOGIN[_-]?KEY|CREDENTIAL)(?:$|_)/iu.test(name)
      && !/^(?:DATABASE_URL|REDIS_URL|MONGODB_URI|PGPASSWORD)$/u.test(name)) continue;
    check(typeof secret !== 'string' || secret.length === 0
      || !text.includes(secret) && !text.includes(JSON.stringify(secret).slice(1, -1)), 'EDIT_RESPONSE_CONTAINS_CREDENTIAL');
  }
  return value;
}
function authPresent(env) {
  check(typeof env.WORKLOOM_ACCESS_TOKEN === 'string' && /^[A-Za-z0-9._~+\/=-]{16,8192}$/u.test(env.WORKLOOM_ACCESS_TOKEN)
    || !env.WORKLOOM_ACCESS_TOKEN && /^[a-f0-9]{64}$/u.test(env.WORKLOOM_DESKTOP_LOGIN_KEY ?? ''), 'MEMBER_TOKEN_REQUIRED');
}
/** Workers inherit only the configuration needed for their phase, never the office client's ambient credentials. */
export function selectEditAgentEnvironment(env, phase) {
  const runtime = /^(?:PATH|HOME|USERPROFILE|TMPDIR|TMP|TEMP|LANG|LC_[A-Z_]+|SYSTEMROOT|COMSPEC|WL_FFMPEG|WL_FFPROBE|FFMPEG_PATH|FFPROBE_PATH|WORKLOOM_(?:COLOR|BGM)_HOME|WORKLOOM_(?:BGM|SUBTITLE|POST|ENHANCE)_FF(?:MPEG|PROBE)_PATH)$/u;
  const shared = new Set(['WORKLOOM_ACCESS_TOKEN', 'WORKLOOM_DESKTOP_LOGIN_KEY', 'WORKLOOM_BASE_URL', 'WORKLOOM_EDIT_JOBS_ROOT', 'WORKLOOM_EDIT_STUDIO_ROOT']);
  const budget = new Set(['WORKLOOM_BUDGET_GATEWAY_TOKEN', 'WORKLOOM_BUDGET_TASK_ID', 'WORKLOOM_BUDGET_APPROVED_MICRO_CNY', 'LLM_BASE_URL', 'ARK_BASE_URL']);
  return { ...Object.fromEntries(Object.entries(env).filter(([name, value]) => typeof value === 'string'
    && (runtime.test(name) || phase !== 'plan' && shared.has(name) || phase === 'continue' && budget.has(name)))), WORKLOOM_DEV_AUTO_LOGIN: '0' };
}
function apiFor(env) { check(typeof env.WORKLOOM_BASE_URL === 'string', 'EDIT_API_CONFIGURATION_REQUIRED'); return parseEditLoopbackApi(env.WORKLOOM_BASE_URL); }
function privateDirectory(file, sourceRoot, code) {
  check(typeof file === 'string' && isAbsolute(file) && resolve(file) === file, code);
  let info, canonicalPath; try { info = lstatSync(file); canonicalPath = realpathSync(file); } catch { throw new EditAgentError(code); }
  check(info.isDirectory() && !info.isSymbolicLink() && canonicalPath === file && info.uid === process.getuid?.()
    && (info.mode & 0o777) === 0o700 && !inside(realpathSync(sourceRoot), file), code);
  return file;
}
function jobsRoot(env, root) { return privateDirectory(env.WORKLOOM_EDIT_JOBS_ROOT, root, 'EDIT_JOBS_ROOT_REQUIRED'); }
function studioRootFor(env, root) {
  check(env.WORKLOOM_EDIT_STUDIO_ROOT !== undefined, 'EDIT_STUDIO_ROOT_REQUIRED');
  return privateDirectory(env.WORKLOOM_EDIT_STUDIO_ROOT, root, 'EDIT_STUDIO_ROOT_INVALID');
}
function read(file, max = LIMIT) {
  let fd; try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    check(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= max && stat.uid === process.getuid?.()
      && (stat.mode & 0o077) === 0, 'EDIT_JOB_INVALID');
    const bytes = readFileSync(fd); check(bytes.length <= max, 'EDIT_JOB_INVALID');
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  } catch (error) { throw error instanceof EditAgentError ? error : new EditAgentError('EDIT_JOB_INVALID'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function write(file, value) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(resolve(file, '..'), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
function jobDirectory(jobId, env, root) {
  check(JOB.test(jobId ?? ''), 'EDIT_JOB_ID_INVALID');
  const base = jobsRoot(env, root), directory = join(base, jobId);
  check(existsSync(directory), 'EDIT_JOB_NOT_FOUND');
  privateDirectory(directory, root, 'EDIT_JOB_INVALID');
  return directory;
}
function binding(env) { return { api: apiFor(env), studioRoot: env.WORKLOOM_EDIT_STUDIO_ROOT ?? null }; }
function loadJob(jobId, env, root) {
  const directory = jobDirectory(jobId, env, root), job = read(join(directory, 'job.json'));
  check(job?.schemaVersion === JOB_SCHEMA && job.jobId === jobId && ['start', 'repair'].includes(job.action)
    && HASH.test(job.requestSha256 ?? '') && digest(canonical({ action: job.action, input: job.input, binding: job.binding })) === job.requestSha256,
  'EDIT_JOB_INVALID');
  check(typeof job.input?.idempotencyKey === 'string' && 'JOB-' + digest(job.input.idempotencyKey) === jobId, 'EDIT_JOB_INVALID');
  authorization(job.input.authorization, 'textGeneration');
  check(canonical(job.binding) === canonical(binding(env)), 'EDIT_JOB_CONFIGURATION_CHANGED');
  return { directory, job };
}
async function childJson(root, args, env, input) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...env, WORKLOOM_DEV_AUTO_LOGIN: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', overflow = false;
    const collect = stream => chunk => { if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > LIMIT * 2) { overflow = true; child.kill(); }
      else if (stream === 'stdout') stdout += chunk; else stderr += chunk; };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.on('error', () => reject(new EditAgentError('EDIT_NATIVE_UNAVAILABLE')));
    child.stdin.on('error', () => { overflow = true; }); child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
    child.on('close', code => {
      if (overflow) return reject(new EditAgentError('EDIT_NATIVE_RESPONSE_INVALID'));
      let data; try { data = JSON.parse(stdout || stderr); } catch { return reject(new EditAgentError('EDIT_NATIVE_RESPONSE_INVALID')); }
      try { safeOutput(data, env); } catch (error) { return reject(error); }
      if (code === 2 && data.code) return reject(new EditAgentError(/^[A-Z][A-Z0-9_]+$/u.test(data.code) ? data.code : 'EDIT_NATIVE_FAILED'));
      done(data);
    });
  });
}
const PLAN_CODE = "import {buildStudioInput} from './scripts/tools/codex-video-workflow.mjs'; let s='';for await(const c of process.stdin)s+=c;try{const v=JSON.parse(s);console.log(JSON.stringify(buildStudioInput(v.intent,v.brief)));}catch(e){console.log(JSON.stringify({code:e.code??'BRIEF_INVALID'}));process.exitCode=2;}";
async function plan(input, root, env) {
  keys(input, ['intent', 'brief'], ['intent']);
  check(Buffer.byteLength(JSON.stringify(input)) <= LIMIT, 'EDIT_INPUT_TOO_LARGE');
  return childJson(root, ['--import', 'tsx', '--input-type=module', '-e', PLAN_CODE], selectEditAgentEnvironment(env, 'plan'), input);
}
function native(root, args, env) { return childJson(root, ['--import', 'tsx', 'scripts/tools/codex-video-workflow.mjs', ...args],
  selectEditAgentEnvironment(env, args.includes('--continue') ? 'continue' : 'native')); }
function dispatch(directory, jobId, action, root, env) {
  const marker = join(directory, action + '-dispatch.json');
  try { write(marker, { action, jobId, state: 'dispatch_unknown', authorization: action === 'continue' ? { mediaGeneration: true } : { textGeneration: true }, at: new Date().toISOString() }); }
  catch (error) { if (error.code === 'EEXIST') return false; throw new EditAgentError('EDIT_JOB_WRITE_FAILED'); }
  try {
    const worker = spawn(process.execPath, [join(root, 'scripts/tools/edit-agent-worker.mjs'), '--job-id', jobId, '--action', action],
      { cwd: root, env: selectEditAgentEnvironment(env, action), detached: true, stdio: 'ignore' });
    worker.once('spawn', () => {
      try { write(join(directory, action + '-spawn.json'), { jobId, action, pid: worker.pid, at: new Date().toISOString() }); }
      catch { /* Missing acknowledgement is reported as dispatch_unknown, never replayed. */ }
    });
    worker.on('error', () => {
      try { write(join(directory, action + '-result.json'), { state: 'dispatch_unknown', code: 'EDIT_WORKER_SPAWN_FAILED' }); }
      catch { /* The durable dispatch marker still reports dispatch_unknown. */ }
    });
    worker.unref();
  } catch { throw new EditAgentError('EDIT_DISPATCH_UNKNOWN'); }
  return true;
}
function workerLiveness(record, jobId, action, root) {
  if (record?.jobId !== jobId || record.action !== action || !Number.isSafeInteger(record.pid) || record.pid <= 0) return 'unverified';
  try { process.kill(record.pid, 0); } catch (error) { return error.code === 'ESRCH' ? 'stopped' : 'unverified'; }
  if (process.platform !== 'darwin' && process.platform !== 'linux') return 'unverified';
  try {
    const command = execFileSync('/bin/ps', ['-ww', '-p', String(record.pid), '-o', 'uid=', '-o', 'command='],
      { encoding: 'utf8', timeout: 2000, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'ignore'] });
    const match = /^\s*(\d+)\s+(.+)\s*$/u.exec(command.trim());
    return match && Number(match[1]) === process.getuid?.() && match[2].includes(join(root, 'scripts/tools/edit-agent-worker.mjs'))
      && match[2].includes('--job-id ' + jobId) && match[2].includes('--action ' + action) ? 'running' : 'unverified';
  } catch { return 'unverified'; }
}
function lifecycle(directory, jobId, action, root) {
  const acknowledgement = join(directory, action + '-worker.json');
  if (existsSync(acknowledgement)) {
    const alive = workerLiveness(read(acknowledgement), jobId, action, root);
    return alive === 'running' ? { state: 'pending', code: null } : { state: 'outcome_unknown',
      code: alive === 'stopped' ? 'EDIT_WORKER_EXITED_WITHOUT_RECEIPT' : 'EDIT_WORKER_LIVENESS_UNVERIFIED' };
  }
  return { state: 'dispatch_unknown', code: 'EDIT_WORKER_ACK_MISSING' };
}
async function submit(action, input, env, root) {
  const allowed = action === 'start' ? ['idempotencyKey', 'intent', 'brief', 'authorization']
    : ['idempotencyKey', 'projectId', 'expectedLatestAttempt', 'planDigest', 'authorization'];
  keys(input, allowed, action === 'start' ? ['idempotencyKey', 'intent', 'authorization'] : allowed);
  check(typeof input.idempotencyKey === 'string' && input.idempotencyKey.length >= 8 && input.idempotencyKey.length <= 200, 'EDIT_IDEMPOTENCY_KEY_INVALID');
  authorization(input.authorization, 'textGeneration'); authPresent(env);
  studioRootFor(env, root);
  if (action === 'start') await plan({ intent: input.intent, ...(input.brief === undefined ? {} : { brief: input.brief }) }, root, env);
  else check(stringId(input.projectId) && Number.isSafeInteger(input.expectedLatestAttempt) && input.expectedLatestAttempt > 0 && HASH.test(input.planDigest ?? ''), 'EDIT_INPUT_INVALID');
  const id = 'edit.video.workflow.' + action, jobId = 'JOB-' + digest(input.idempotencyKey), base = jobsRoot(env, root), directory = join(base, jobId);
  const operation = { action, input, binding: binding(env) }, requestSha256 = digest(canonical(operation));
  try {
    mkdirSync(directory, { mode: 0o700 });
    write(join(directory, 'job.json'), { schemaVersion: JOB_SCHEMA, jobId, requestSha256, ...operation });
    const parent = openSync(base, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw new EditAgentError('EDIT_JOB_WRITE_FAILED');
    // A racing creator may not have fsynced its document yet. Never take ownership or replay it.
    for (let attempt = 0; attempt < 40 && !existsSync(join(directory, 'job.json')); attempt++) await new Promise(done => setTimeout(done, 25));
    check(existsSync(join(directory, 'job.json')), 'EDIT_JOB_INITIALIZING');
    const prior = loadJob(jobId, env, root); check(prior.job.requestSha256 === requestSha256, 'EDIT_IDEMPOTENCY_CONFLICT');
    return status(jobId, id, env, root);
  }
  dispatch(directory, jobId, action, root, env);
  return envelope(id, 'pending', { jobId, requestSha256, next: ['edit.video.workflow.status'] });
}
async function status(jobId, id, env, root) {
  const { directory, job } = loadJob(jobId, env, root), receipt = join(directory, 'studio-start.json');
  if (existsSync(receipt)) {
    const result = await native(root, ['--status', '--receipt', receipt], env);
    const continuation = join(directory, 'continue-result.json');
    if (result.state === 'preproduction_archived' && existsSync(join(directory, 'continue-dispatch.json'))) {
      if (existsSync(continuation)) {
        const outcome = read(continuation);
        return envelope(id, 'continuation_blocked', { jobId, code: outcome.code ?? outcome.errorCode ?? 'EDIT_CONTINUATION_REQUIRES_RECONCILIATION',
          next: ['Inspect the same job and its native admission error. The adapter will not submit another worker.'] });
      }
      const worker = lifecycle(directory, jobId, 'continue', root);
      return envelope(id, worker.state === 'pending' ? 'film_starting' : 'film_dispatch_unknown', { jobId, code: worker.code,
        next: ['Read the same job and original Film journal; never resubmit an unknown media operation.'] });
    }
    return safeOutput(envelope(id, result.state, { ...result, schemaVersion: SCHEMA, capabilityId: id, jobId }), env);
  }
  const resultFile = join(directory, job.action + '-result.json');
  if (existsSync(resultFile)) {
    const result = read(resultFile);
    if (result.state === 'repair_started') {
      authPresent(env);
      const actual = await withVerifiedEditService(apiFor(env), env.WORKLOOM_ACCESS_TOKEN, async call => {
        const current = await call('video.studio.status', { runId: result.runId });
        check(current?.runId === result.runId && current.projectId === job.input.projectId, 'STUDIO_STATUS_MISMATCH');
        if (current?.status === 'finished' && !current.pendingApprovalId) {
          const archive = await call('video.studio.archive', { projectId: job.input.projectId });
          const production = await call('video.production.shots', { projectId: job.input.projectId });
          const stage = archive?.stages?.filter(row => row.stageId === 'preproduction').sort((a, b) => b.attempt - a.attempt)[0];
          const seconds = Array.isArray(production?.shots) ? production.shots.reduce((sum, shot) => sum + shot.durationSec, 0) : NaN;
          check(archive?.projectId === job.input.projectId && archive.archiveExists === true && !archive.pendingApprovalId
            && stage?.status === 'done' && stage.runId === result.runId && stage.attempt === job.input.expectedLatestAttempt + 1
            && production?.projectId === job.input.projectId && production.sourceAttempt === stage.attempt
            && Number.isFinite(seconds) && seconds >= 5 && seconds <= 180, 'EDIT_REPAIR_HANDOFF_UNVERIFIED');
          const compatible = { schemaVersion: 'workloom.codex-video-workflow/v1', productId: 'workloom-ai-video-edit', state: 'studio_started',
            delivered: false, api: job.binding.api, requestSha256: job.requestSha256, durationSeconds: seconds,
            projectId: job.input.projectId, runId: result.runId, pipeline: 'marketing' };
          safeOutput(compatible, env);
          try { write(receipt, compatible); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        return current;
      }, { env });
      check(actual?.runId === result.runId && actual.projectId === job.input.projectId, 'STUDIO_STATUS_MISMATCH');
      if (existsSync(receipt)) return status(jobId, id, env, root);
      return safeOutput(envelope(id, actual.pendingApprovalId || actual.status === 'awaiting_approval' ? 'awaiting_approval' : actual.status === 'running' ? 'preproduction_running' : actual.status === 'finished' ? 'preproduction_source_unverified' : 'preproduction_failed',
        { jobId, projectId: actual.projectId, runId: actual.runId, studioStatus: actual.status, currentGate: actual.currentGate ?? null,
          pendingApprovalId: actual.pendingApprovalId ?? null, errorPresent: Boolean(actual.error), next: ['edit.video.workflow.status'] }), env);
    }
    check(['outcome_unknown', 'dispatch_unknown', 'busy', 'stale'].includes(result.state), 'EDIT_JOB_INVALID');
    return safeOutput(envelope(id, result.state, { jobId, code: result.code, kind: result.kind, next: ['Inspect the original job; do not resubmit unknown actions.'] }), env);
  }
  const worker = lifecycle(directory, jobId, job.action, root);
  return envelope(id, worker.state, { jobId, code: worker.code, next: ['Read the same job and native project; never resubmit an unknown action.'] });
}
async function doctor(env, root) {
  const discovery = { ready: Number(process.versions.node.split('.')[0]) >= 24 && existsSync(join(root, 'node_modules')),
    node: process.versions.node, code: null };
  if (!discovery.ready) discovery.code = 'EDIT_RUNTIME_SETUP_REQUIRED';
  let config = false, sharedStudioRoot = false, studioCode = 'EDIT_STUDIO_ROOT_REQUIRED';
  try { jobsRoot(env, root); config = true; } catch { config = false; }
  try { studioRootFor(env, root); sharedStudioRoot = true; studioCode = null; } catch (error) { studioCode = error.code ?? 'EDIT_STUDIO_ROOT_INVALID'; }
  const connection = { ready: false, code: 'EDIT_API_CONFIGURATION_REQUIRED' }, auth = { ready: false, code: 'EDIT_AUTH_NOT_EVALUATED' };
  try {
    await withVerifiedEditService(apiFor(env), env.WORKLOOM_ACCESS_TOKEN, async call => {
      connection.ready = true; connection.code = null;
      try { await call('video.gen.catalog', { kind: 'video', limit: 1 }); auth.ready = true; auth.code = null; }
      catch (error) { auth.code = error.code ?? 'STUDIO_ACCESS_DENIED'; }
    }, { env });
  } catch (error) { connection.code = error.code ?? 'STUDIO_PRODUCT_UNVERIFIED'; }
  return envelope('edit.agent.doctor', 'inspected', { discovery, configuration: { ready: config && sharedStudioRoot,
    code: !config ? 'EDIT_JOBS_ROOT_REQUIRED' : !sharedStudioRoot ? studioCode : null,
    jobsRoot: { ready: config, code: config ? null : 'EDIT_JOBS_ROOT_REQUIRED' }, sharedStudioRoot: { ready: sharedStudioRoot, code: studioCode } }, connection, auth,
    production: { ready: false, code: 'EDIT_PRODUCTION_AUTHORIZATION_NOT_EVALUATED', existingMediaScope: 'Native workflow budget currently requires uniform shot duration and existing per-task caps; no scene planning changes are made.' },
    paidCalls: 0, writeOperations: 0, next: ['Configure the named missing setup/auth items, then plan using the original intent and complete brief.', 'Production requires native current source, approvals and task budget admission.'] });
}
export async function invokeEditWorkflow(id, input = {}, { env = process.env, root = ROOT } = {}) {
  root = realpathSync(root);
  safeOutput(input, env);
  let result;
  switch (id) {
    case 'edit.video.workflow.plan': result = envelope(id, 'plan', { previewOnly: true, input: await plan(input, root, env), paidCalls: 0 }); break;
    case 'edit.video.workflow.start': result = await submit('start', input, env, root); break;
    case 'edit.video.workflow.repair': result = await submit('repair', input, env, root); break;
    case 'edit.video.workflow.status': keys(input, ['jobId'], ['jobId']); result = await status(input.jobId, id, env, root); break;
    case 'edit.video.workflow.continue': {
      keys(input, ['jobId', 'authorization'], ['jobId', 'authorization']); authorization(input.authorization, 'mediaGeneration'); authPresent(env);
      const { directory } = loadJob(input.jobId, env, root);
      const current = await status(input.jobId, id, env, root);
      if (current.state !== 'preproduction_archived') { result = current; break; }
      check(existsSync(join(directory, 'studio-start.json')), 'EDIT_NATIVE_RECEIPT_REQUIRED');
      dispatch(directory, input.jobId, 'continue', root, env);
      result = envelope(id, 'pending', { jobId: input.jobId, next: ['edit.video.workflow.status'] }); break;
    }
    case 'edit.video.workflow.repair_plan': keys(input, ['projectId'], ['projectId']); check(stringId(input.projectId), 'EDIT_INPUT_INVALID'); authPresent(env);
      result = envelope(id, 'repair_plan', { plan: await withVerifiedEditService(apiFor(env), env.WORKLOOM_ACCESS_TOKEN,
        call => call('video.studio.promptRepairPlan', input), { env }), paidCalls: 0 }); break;
    case 'edit.agent.doctor': keys(input, []); result = await doctor(env, root); break;
    default: throw new EditAgentError('EDIT_CAPABILITY_NOT_FOUND');
  }
  return safeOutput(result, env);
}

/** Worker reopens only its already-fsynced operation; no CLI input can supply an API/path/command. */
export async function runEditAgentWorker(jobId, action, { env = process.env, root = ROOT } = {}) {
  check(['start', 'repair', 'continue'].includes(action), 'EDIT_WORKER_ACTION_INVALID');
  root = realpathSync(root);
  const { directory, job } = loadJob(jobId, env, root), marker = read(join(directory, action + '-dispatch.json'));
  check(marker.action === action && marker.jobId === jobId, 'EDIT_JOB_INVALID');
  authorization(marker.authorization, action === 'continue' ? 'mediaGeneration' : 'textGeneration');
  const resultFile = join(directory, action + '-result.json');
  try { write(join(directory, action + '-worker.json'), { jobId, action, pid: process.pid, at: new Date().toISOString() }); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  try {
    let result;
    if (action === 'start') {
      const brief = join(directory, 'brief.json'); write(brief, job.input.brief ?? {});
      result = await native(root, ['--intent', job.input.intent, '--brief', brief, '--execute', '--api', job.binding.api,
        '--receipt', join(directory, 'studio-start.json')], env);
    } else if (action === 'continue') {
      result = await native(root, ['--continue', '--receipt', join(directory, 'studio-start.json')], env);
    } else {
      check(job.action === 'repair', 'EDIT_JOB_INVALID');
      const { projectId, expectedLatestAttempt, planDigest } = job.input;
      const nativeRequest = { projectId, expectedLatestAttempt, planDigest };
      write(join(directory, 'repair-request.json'), nativeRequest);
      const started = await withVerifiedEditService(job.binding.api, env.WORKLOOM_ACCESS_TOKEN,
        (call, service) => {
          const studioRoot = studioRootFor(env, root);
          check(service.videoStudio?.deferRender === true && service.videoStudio.workDirSha256 === digest(studioRoot), 'EDIT_STUDIO_HANDOFF_CONFIGURATION_MISMATCH');
          return call('video.studio.repairPrompts', nativeRequest);
        }, { env });
      check(['started', 'busy', 'stale'].includes(started?.kind), 'STUDIO_RESPONSE_INVALID');
      if (started.kind === 'started') check(stringId(started.runId) && started.sourceAttempt === expectedLatestAttempt, 'STUDIO_RESPONSE_INVALID');
      result = started.kind === 'started' ? { state: 'repair_started', runId: started.runId, projectId } : { state: started.kind, kind: started.kind };
    }
    safeOutput(result, env); write(resultFile, result);
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]+$/u.test(error?.code ?? '') ? error.code : 'EDIT_WORKER_OUTCOME_UNKNOWN';
    if (!existsSync(resultFile)) write(resultFile, { state: 'outcome_unknown', code });
  }
}
const string = { type: 'string', minLength: 1, maxLength: 200 };
const key = { type: 'string', minLength: 8, maxLength: 200 };
const job = { type: 'string', pattern: '^JOB-[a-f0-9]{64}$' };
const textAuth = { type: 'object', properties: { textGeneration: { type: 'boolean', enum: [true] } }, required: ['textGeneration'], additionalProperties: false };
const mediaAuth = { type: 'object', properties: { mediaGeneration: { type: 'boolean', enum: [true] } }, required: ['mediaGeneration'], additionalProperties: false };
const intent = { type: 'string', minLength: 1, maxLength: 2000 };
const fields = {
  plan: [{ intent, brief: { type: 'object' } }, ['intent'], 'preview'],
  start: [{ idempotencyKey: key, intent, brief: { type: 'object' }, authorization: textAuth }, ['idempotencyKey', 'intent', 'authorization'], 'execute'],
  status: [{ jobId: job }, ['jobId'], 'read'],
  continue: [{ jobId: job, authorization: mediaAuth }, ['jobId', 'authorization'], 'execute'],
  repair_plan: [{ projectId: string }, ['projectId'], 'read'],
  repair: [{ idempotencyKey: key, projectId: string, expectedLatestAttempt: { type: 'integer', minimum: 1 }, planDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' }, authorization: textAuth },
    ['idempotencyKey', 'projectId', 'expectedLatestAttempt', 'planDigest', 'authorization'], 'execute'],
};
export const EDIT_WORKFLOW_CAPABILITIES = Object.freeze([
  ...Object.entries(fields).map(([name, [properties, required, operation]]) => ({ id: 'edit.video.workflow.' + name, version: '1.0.0', title: 'Edit ' + name,
    description: name === 'start' || name === 'repair' ? 'Submit one authorized native text operation; retain jobId and query status. Unknown dispatches are never resubmitted.'
      : name === 'continue' ? 'Continue the same native job under explicit media authorization and existing source, approval and budget gates.'
      : 'Read the native Edit workflow ' + name + '; no automatic paid submission.',
    operation, risk: operation === 'execute' ? 'review' : 'low', dataMode: 'unverified', inputSchema: { type: 'object', properties, required, additionalProperties: false } })),
  { id: 'edit.agent.doctor', version: '1.0.0', title: 'Inspect Edit agent setup', description: 'Inspect discovery, connection and authentication separately from production authorization; no paid calls.',
    operation: 'preview', risk: 'low', dataMode: 'unverified', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
]);
