import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { EDIT_WORKFLOW_CAPABILITIES, invokeEditWorkflow, runEditAgentWorker, selectEditAgentEnvironment } from './lib/edit-agent-workflow.mjs';

const root = resolve(import.meta.dirname, '../..');
const start = { kind: 'routed', projectId: 'VID-agent', runId: 'RUN-agent', pipeline: 'marketing' };
const product = { schemaVersion: 'workloom.service-product/v1', productId: 'workloom-ai-video-edit', repository: 'workloom-ai/WorkLoom-video-edit' };
const auth = { textGeneration: true };
async function fixture(t, options = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'edit-agent-tests-'))), jobs = join(base, 'jobs'), studio = join(base, 'studio');
  mkdirSync(jobs, { mode: 0o700 }); mkdirSync(studio, { mode: 0o700 });
  const requests = [];
  let current = 'running', pendingApprovalId = null;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health/product') { res.end(JSON.stringify(options.product ?? { ...product,
      videoStudio: { deferRender: true, workDirSha256: createHash('sha256').update(studio).digest('hex') } })); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = req.method === 'POST' ? JSON.parse(Buffer.concat(chunks).toString()) : JSON.parse(url.searchParams.get('input') ?? '{}');
    requests.push({ path: url.pathname, method: req.method, input });
    if (req.headers.authorization !== 'Bearer ' + env.WORKLOOM_ACCESS_TOKEN) { res.writeHead(401).end(); return; }
    if (options.unknown && ['/trpc/video.studio.start', '/trpc/video.studio.repairPrompts'].includes(url.pathname)) { req.socket.destroy(); return; }
    let data;
    if (url.pathname === '/trpc/video.studio.start') {
      if (options.delayStart) await new Promise(done => setTimeout(done, options.delayStart));
      data = start;
    }
    else if (url.pathname === '/trpc/video.studio.status') data = { ...start, status: current, currentGate: 'G3_REQUIREMENTS', pendingApprovalId: pendingApprovalId ?? (current === 'awaiting_approval' ? 'APP-real' : null) };
    else if (url.pathname === '/trpc/video.studio.archive') data = { projectId: 'VID-agent', archiveExists: true, pendingApprovalId: null,
      stages: [{ stageId: 'preproduction', attempt: 9, status: 'done', runId: options.badArchiveRun ? 'RUN-other' : start.runId,
        outputRef: 'stages/preproduction/attempt-9.output.json', outputSha256: 'a'.repeat(64) }] };
    else if (url.pathname === '/trpc/video.production.shots') data = { projectId: 'VID-agent', sourceAttempt: 9, shots: [{ durationSec: 17 }] };
    else if (url.pathname === '/trpc/video.studio.promptRepairPlan') data = { kind: 'ready', projectId: 'VID-agent', planDigest: 'd'.repeat(64), expectedLatestAttempt: 8 };
    else if (url.pathname === '/trpc/video.studio.repairPrompts') {
      if (options.delayRepair) await new Promise(done => setTimeout(done, options.delayRepair));
      data = { kind: 'started', runId: start.runId, sourceAttempt: 8 };
    }
    else if (url.pathname === '/trpc/video.gen.catalog') data = { models: [] };
    else { res.writeHead(404).end(); return; }
    res.end(JSON.stringify({ result: { data } }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const env = { ...process.env, WORKLOOM_BASE_URL: 'http://127.0.0.1:' + server.address().port,
    WORKLOOM_EDIT_JOBS_ROOT: jobs, WORKLOOM_EDIT_STUDIO_ROOT: studio, WORKLOOM_ACCESS_TOKEN: 'fixture-' + randomUUID() };
  delete env.WORKLOOM_DESKTOP_LOGIN_KEY;
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); rmSync(base, { recursive: true, force: true }); });
  return { base, jobs, env, requests, current: (value, approval = null) => { current = value; pendingApprovalId = approval; }, call: (id, input) => invokeEditWorkflow('edit.video.workflow.' + id, input, { env, root }) };
}
async function eventually(work) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { const result = await work(); if (result) return result; await new Promise(done => setTimeout(done, 50)); }
  throw new Error('native fixture did not settle');
}
function files(directory) { return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]); }

test('reviewed descriptors expose exactly the seven fixed, typed Edit operations', () => {
  assert.deepEqual(EDIT_WORKFLOW_CAPABILITIES.map(item => item.id).sort(), ['edit.agent.doctor', ...['plan', 'start', 'status', 'continue', 'repair_plan', 'repair'].map(name => 'edit.video.workflow.' + name)].sort());
  for (const item of EDIT_WORKFLOW_CAPABILITIES) assert.equal(item.inputSchema.additionalProperties, false);
  assert.equal(EDIT_WORKFLOW_CAPABILITIES.find(item => item.id.endsWith('.continue')).operation, 'execute');
});
test('native phases receive only their runtime, member/bootstrap and per-job relay environment', () => {
  const env = { PATH: '/fixture/bin', HOME: '/fixture/home', LANG: 'zh_CN.UTF-8', NODE_OPTIONS: '--require /unrelated', GH_TOKEN: 'github-sentinel',
    GITHUB_TOKEN: 'other-owner-sentinel', UNRELATED_DATABASE_PASSWORD: 'database-sentinel', DATABASE_URL: 'database-url-sentinel', NODE_PATH: '/ambient/modules',
    DEEPSEEK_API_KEY: 'raw-upstream-text-sentinel', VOLCENGINE_ARK_API_KEY: 'raw-upstream-media-sentinel', WORKLOOM_KEYS_FILE: '/raw/upstream.env',
    WORKLOOM_ACCESS_TOKEN: 'member-sentinel', WORKLOOM_DESKTOP_LOGIN_KEY: 'bootstrap-sentinel', WORKLOOM_BASE_URL: 'http://127.0.0.1:12345',
    WORKLOOM_EDIT_JOBS_ROOT: '/fixture/jobs', WORKLOOM_EDIT_STUDIO_ROOT: '/fixture/studio', WORKLOOM_BUDGET_GATEWAY_TOKEN: 'relay-sentinel',
    WORKLOOM_BUDGET_TASK_ID: 'task-sentinel', WORKLOOM_BUDGET_APPROVED_MICRO_CNY: '12', LLM_BASE_URL: 'http://127.0.0.1:23456', ARK_BASE_URL: 'http://127.0.0.1:23456/api/v3' };
  for (const phase of ['plan', 'start', 'status', 'repair', 'continue']) {
    const selected = selectEditAgentEnvironment(env, phase);
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'UNRELATED_DATABASE_PASSWORD', 'DATABASE_URL', 'NODE_OPTIONS', 'NODE_PATH', 'DEEPSEEK_API_KEY', 'VOLCENGINE_ARK_API_KEY', 'WORKLOOM_KEYS_FILE']) assert.equal(selected[key], undefined, phase + ': ' + key);
    assert.equal(selected.PATH, env.PATH); assert.equal(selected.WORKLOOM_DEV_AUTO_LOGIN, '0');
    assert.equal(selected.WORKLOOM_ACCESS_TOKEN, phase === 'plan' ? undefined : env.WORKLOOM_ACCESS_TOKEN);
    assert.equal(selected.WORKLOOM_BUDGET_GATEWAY_TOKEN, phase === 'continue' ? env.WORKLOOM_BUDGET_GATEWAY_TOKEN : undefined);
  }
});
test('plan preserves multiline original speech and complete brief; no scene allocation is added', async t => {
  const f = await fixture(t);
  const intent = '总时长30秒的赛车广告。\n保留完整原话和商品声音。\n前8秒开场，中间12秒，最后10秒。';
  const brief = { duration: 30, requirements: '禁止补造参数\n保留环境音', character: { id: 'owner-character' },
    characters: [{ id: 'owner-character', voice: { policy: 'original' } }], sound: { mode: 'native' } };
  const result = await f.call('plan', { intent, brief });
  assert.equal(result.state, 'plan'); assert.equal(result.input.intent, intent); assert.deepEqual(result.input.metadata.brief, brief);
  assert.equal(Object.hasOwn(result.input.metadata.brief, 'segmentContract'), false); assert.equal(result.delivered, false);
  assert.deepEqual(f.requests, []); assert.deepEqual(readdirSync(f.jobs), []);
});
test('a clear full-clip duration cannot be overwritten by a conflicting brief when tail timings also occur', async t => {
  const f = await fixture(t), intent = '制作30秒广告，片尾3秒展示店名';
  await assert.rejects(f.call('plan', { intent, brief: { duration: 17 } }), { code: 'DURATION_CONFLICT' });
  const accepted = await f.call('plan', { intent, brief: { duration: 30 } });
  assert.equal(accepted.input.metadata.brief.duration, 30); assert.equal(accepted.input.intent, intent);
  const local = await f.call('plan', { intent: '开场8秒，中间12秒，结尾10秒', brief: { duration: 30 } });
  assert.equal(local.input.metadata.brief.duration, 30);
  assert.equal((await f.call('plan', { intent: '片尾3秒展示店名', brief: { duration: 17 } })).input.metadata.brief.duration, 17);
  for (const [text, seconds] of [['制作半分钟广告\n片尾三秒展示店名', 30], ['制作一分钟宣传片\n片尾三秒展示店名', 60], ['总时长三十秒\n开场八秒，结尾三秒', 30], ['制作３０秒广告\n片尾３秒展示店名', 30]]) {
    assert.equal((await f.call('plan', { intent: text, brief: { duration: seconds } })).input.intent, text);
    await assert.rejects(f.call('plan', { intent: text, brief: { duration: 17 } }), { code: 'DURATION_CONFLICT' });
  }
  await assert.rejects(f.call('plan', { intent: '17秒或30秒广告', brief: { duration: 30 } }), { code: 'DURATION_AMBIGUOUS' });
});
test('start returns a stable job promptly, concurrent same-key input submits once, later input conflicts', async t => {
  const f = await fixture(t), input = { idempotencyKey: 'same-request-' + randomUUID(), intent: '做17秒商品广告', authorization: auth };
  const [a, b] = await Promise.all([f.call('start', input), f.call('start', input)]);
  assert.equal(a.jobId, b.jobId); assert.match(a.jobId, /^JOB-[a-f0-9]{64}$/);
  assert.ok([a, b].some(result => result.state === 'pending')); assert.equal(a.delivered, false);
  await eventually(() => existsSync(join(f.jobs, a.jobId, 'start-result.json')));
  const completedWorker = JSON.parse(readFileSync(join(f.jobs, a.jobId, 'start-worker.json'), 'utf8'));
  await eventually(() => { try { process.kill(completedWorker.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
  const status = await f.call('status', { jobId: a.jobId }); assert.equal(status.state, 'preproduction_running');
  assert.equal(f.requests.filter(req => req.path.endsWith('.start')).length, 1);
  await assert.rejects(f.call('start', { ...input, intent: '做18秒商品广告' }), { code: 'EDIT_IDEMPOTENCY_CONFLICT' });
  f.current('awaiting_approval'); assert.equal((await f.call('status', { jobId: a.jobId })).state, 'awaiting_approval');
  const continued = await f.call('continue', { jobId: a.jobId, authorization: { mediaGeneration: true } });
  assert.equal(continued.state, 'awaiting_approval'); assert.equal(existsSync(join(f.jobs, a.jobId, 'continue-dispatch.json')), false);
  assert.equal(f.requests.filter(req => req.path.endsWith('.start')).length, 1);
  for (const file of files(f.jobs)) { assert.equal(statSync(file).mode & 0o777, 0o600); assert.equal(readFileSync(file, 'utf8').includes(f.env.WORKLOOM_ACCESS_TOKEN), false); }
});
test('lost native start ACK retains original unknown receipt and repeated calls never submit again', async t => {
  const f = await fixture(t, { unknown: true }), input = { idempotencyKey: randomUUID(), intent: '做17秒商品广告', authorization: auth };
  const first = await f.call('start', input);
  await eventually(() => existsSync(join(f.jobs, first.jobId, 'start-result.json')));
  assert.equal((await f.call('status', { jobId: first.jobId })).state, 'start_unknown');
  assert.equal((await f.call('start', input)).state, 'start_unknown');
  assert.equal(f.requests.filter(req => req.path.endsWith('.start')).length, 1);
  await runEditAgentWorker(first.jobId, 'start', { env: f.env, root });
  assert.equal(f.requests.filter(req => req.path.endsWith('.start')).length, 1);
});
test('repair uses read-only native plan then exactly strict native three-field request and retained run status', async t => {
  const f = await fixture(t);
  const preview = await f.call('repair_plan', { projectId: 'VID-agent' }); assert.equal(preview.plan.kind, 'ready');
  const input = { idempotencyKey: randomUUID(), projectId: 'VID-agent', expectedLatestAttempt: 8, planDigest: 'd'.repeat(64), authorization: auth };
  const first = await f.call('repair', input);
  await eventually(() => existsSync(join(f.jobs, first.jobId, 'repair-result.json')));
  assert.equal((await f.call('status', { jobId: first.jobId })).state, 'preproduction_running');
  assert.equal((await f.call('repair', input)).jobId, first.jobId);
  const posts = f.requests.filter(req => req.path.endsWith('.repairPrompts'));
  assert.equal(posts.length, 1); assert.deepEqual(posts[0].input, { projectId: 'VID-agent', expectedLatestAttempt: 8, planDigest: 'd'.repeat(64) });
  assert.equal(f.requests.filter(req => req.path.endsWith('.promptRepairPlan'))[0].method, 'GET');
});
test('lost repair ACK is durable unknown and reconnect cannot resubmit', async t => {
  const f = await fixture(t, { unknown: true });
  const input = { idempotencyKey: randomUUID(), projectId: 'VID-agent', expectedLatestAttempt: 8, planDigest: 'd'.repeat(64), authorization: auth };
  const first = await f.call('repair', input);
  await eventually(() => existsSync(join(f.jobs, first.jobId, 'repair-result.json')));
  assert.equal((await f.call('repair', input)).state, 'outcome_unknown');
  assert.equal(f.requests.filter(req => req.path.endsWith('.repairPrompts')).length, 1);
});
test('finished repair with a pending approval remains awaiting approval and cannot dispatch Film', async t => {
  const f = await fixture(t), input = { idempotencyKey: randomUUID(), projectId: 'VID-agent', expectedLatestAttempt: 8, planDigest: 'd'.repeat(64), authorization: auth };
  const first = await f.call('repair', input);
  await eventually(() => existsSync(join(f.jobs, first.jobId, 'repair-result.json')));
  f.current('finished', 'APP-still-pending');
  const current = await f.call('status', { jobId: first.jobId });
  assert.equal(current.state, 'awaiting_approval'); assert.equal(current.pendingApprovalId, 'APP-still-pending');
  assert.equal(existsSync(join(f.jobs, first.jobId, 'studio-start.json')), false);
  assert.equal((await f.call('continue', { jobId: first.jobId, authorization: { mediaGeneration: true } })).state, 'awaiting_approval');
  assert.equal(existsSync(join(f.jobs, first.jobId, 'continue-dispatch.json')), false);
});
test('finished repair binds a native same-job receipt, and concurrent Film requests retain native revision gates', async t => {
  const f = await fixture(t), input = { idempotencyKey: randomUUID(), projectId: 'VID-agent', expectedLatestAttempt: 8, planDigest: 'd'.repeat(64), authorization: auth };
  const first = await f.call('repair', input);
  await eventually(() => existsSync(join(f.jobs, first.jobId, 'repair-result.json')));
  f.current('finished');
  const current = await f.call('status', { jobId: first.jobId }); assert.equal(current.state, 'preproduction_archived');
  const receipt = JSON.parse(readFileSync(join(f.jobs, first.jobId, 'studio-start.json'), 'utf8'));
  assert.equal(receipt.runId, start.runId); assert.equal(receipt.projectId, 'VID-agent'); assert.equal(receipt.durationSeconds, 17);
  const request = { jobId: first.jobId, authorization: { mediaGeneration: true } };
  const both = await Promise.all([f.call('continue', request), f.call('continue', request)]);
  assert.ok(both.every(result => ['pending', 'film_starting', 'film_dispatch_unknown', 'continuation_blocked'].includes(result.state)));
  await eventually(() => existsSync(join(f.jobs, first.jobId, 'continue-result.json')));
  assert.equal(readdirSync(join(f.jobs, first.jobId)).filter(file => file === 'continue-worker.json').length, 1);
  const blocked = await f.call('status', { jobId: first.jobId }); assert.equal(blocked.state, 'continuation_blocked'); assert.equal(blocked.delivered, false);
  assert.match(blocked.code, /^EDIT_(?:CLEAN_SOURCE_COMMIT_REQUIRED|SERVICE_REVISION_MISMATCH)$/u);
  assert.equal(existsSync(join(f.jobs, first.jobId, 'film-continuation.json')), false);
  assert.equal(f.requests.filter(req => req.path.endsWith('.repairPrompts')).length, 1);
  assert.ok(f.requests.every(req => !/render|generations|images/u.test(req.path)));
});
test('repair finished status cannot adopt another run archive or manufacture a native receipt', async t => {
  const f = await fixture(t, { badArchiveRun: true });
  const first = await f.call('repair', { idempotencyKey: randomUUID(), projectId: 'VID-agent', expectedLatestAttempt: 8, planDigest: 'd'.repeat(64), authorization: auth });
  await eventually(() => existsSync(join(f.jobs, first.jobId, 'repair-result.json'))); f.current('finished');
  await assert.rejects(f.call('status', { jobId: first.jobId }), { code: 'EDIT_REPAIR_HANDOFF_UNVERIFIED' });
  assert.equal(existsSync(join(f.jobs, first.jobId, 'studio-start.json')), false);
});
test('a detached start returns while the original native POST is still waiting for its ACK', async t => {
  const f = await fixture(t, { delayStart: 1_500 });
  const first = await f.call('start', { idempotencyKey: randomUUID(), intent: '做17秒商品广告', authorization: auth });
  assert.equal(first.state, 'pending');
  assert.equal(existsSync(join(f.jobs, first.jobId, 'start-result.json')), false);
  await eventually(() => f.requests.some(req => req.path.endsWith('.start')));
  assert.equal(existsSync(join(f.jobs, first.jobId, 'start-result.json')), false);
  await eventually(() => existsSync(join(f.jobs, first.jobId, 'start-result.json')));
  assert.equal((await f.call('status', { jobId: first.jobId })).state, 'preproduction_running');
});
test('spawn failure records an immutable unknown result and same-key reconnect cannot dispatch', async t => {
  const f = await fixture(t), input = { idempotencyKey: randomUUID(), projectId: 'VID-agent', expectedLatestAttempt: 8, planDigest: 'd'.repeat(64), authorization: auth };
  const executable = process.execPath;
  let first;
  try { process.execPath = join(f.base, 'nonexistent-node'); first = await f.call('repair', input); }
  finally { process.execPath = executable; }
  await eventually(() => existsSync(join(f.jobs, first.jobId, 'repair-result.json')));
  const state = await f.call('status', { jobId: first.jobId });
  assert.equal(state.state, 'dispatch_unknown'); assert.equal(state.code, 'EDIT_WORKER_SPAWN_FAILED');
  assert.equal((await f.call('repair', input)).state, 'dispatch_unknown'); assert.deepEqual(f.requests, []);
});
test('worker killed while awaiting the only native repair ACK becomes outcome_unknown and never replays', async t => {
  const f = await fixture(t, { delayRepair: 2000 });
  const input = { idempotencyKey: randomUUID(), projectId: 'VID-agent', expectedLatestAttempt: 8, planDigest: 'd'.repeat(64), authorization: auth };
  const first = await f.call('repair', input), directory = join(f.jobs, first.jobId);
  await eventually(() => f.requests.some(req => req.path.endsWith('.repairPrompts')) && existsSync(join(directory, 'repair-worker.json')));
  const worker = JSON.parse(readFileSync(join(directory, 'repair-worker.json'), 'utf8')); process.kill(worker.pid, 'SIGKILL');
  await eventually(() => { try { process.kill(worker.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
  const unknown = await f.call('status', { jobId: first.jobId });
  assert.equal(unknown.state, 'outcome_unknown'); assert.equal(unknown.code, 'EDIT_WORKER_EXITED_WITHOUT_RECEIPT');
  assert.equal((await f.call('repair', input)).state, 'outcome_unknown');
  assert.equal(f.requests.filter(req => req.path.endsWith('.repairPrompts')).length, 1);
});
test('missing worker module leaves explicit dispatch_unknown rather than permanent pending', async t => {
  const f = await fixture(t), isolatedSource = join(f.base, 'empty-source'); mkdirSync(isolatedSource, { mode: 0o700 });
  const input = { idempotencyKey: randomUUID(), projectId: 'VID-agent', expectedLatestAttempt: 8, planDigest: 'd'.repeat(64), authorization: auth };
  const first = await invokeEditWorkflow('edit.video.workflow.repair', input, { env: f.env, root: isolatedSource });
  const directory = join(f.jobs, first.jobId);
  await eventually(() => existsSync(join(directory, 'repair-spawn.json')));
  const spawned = JSON.parse(readFileSync(join(directory, 'repair-spawn.json'), 'utf8'));
  await eventually(() => { try { process.kill(spawned.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
  const unknown = await invokeEditWorkflow('edit.video.workflow.status', { jobId: first.jobId }, { env: f.env, root: isolatedSource });
  assert.equal(unknown.state, 'dispatch_unknown'); assert.equal(unknown.code, 'EDIT_WORKER_ACK_MISSING');
  assert.equal((await invokeEditWorkflow('edit.video.workflow.repair', input, { env: f.env, root: isolatedSource })).state, 'dispatch_unknown');
  assert.deepEqual(f.requests, []);
});
test('authorization, setup, path injection, credential input and unknown operations fail before side effects', async t => {
  const f = await fixture(t), input = { idempotencyKey: randomUUID(), intent: '做17秒商品广告', authorization: auth };
  for (const forbidden of [{ ...input, authorization: { textGeneration: false } }, { ...input, api: f.env.WORKLOOM_BASE_URL },
    { ...input, path: '/tmp/elsewhere' }, { ...input, intent: '做17秒视频' + f.env.WORKLOOM_ACCESS_TOKEN }]) await assert.rejects(f.call('start', forbidden));
  await assert.rejects(invokeEditWorkflow('edit.video.workflow.start', input, { root, env: { ...f.env, WORKLOOM_ACCESS_TOKEN: '' } }), { code: 'MEMBER_TOKEN_REQUIRED' });
  await assert.rejects(invokeEditWorkflow('edit.video.workflow.start', input, { root, env: { ...f.env, WORKLOOM_EDIT_STUDIO_ROOT: undefined } }), { code: 'EDIT_STUDIO_ROOT_REQUIRED' });
  await assert.rejects(invokeEditWorkflow('edit.video.workflow.start', input, { root, env: { ...f.env, WORKLOOM_EDIT_JOBS_ROOT: root } }), { code: 'EDIT_JOBS_ROOT_REQUIRED' });
  const link = join(f.base, 'linked'); symlinkSync(f.jobs, link);
  await assert.rejects(invokeEditWorkflow('edit.video.workflow.start', input, { root, env: { ...f.env, WORKLOOM_EDIT_JOBS_ROOT: link } }), { code: 'EDIT_JOBS_ROOT_REQUIRED' });
  await assert.rejects(f.call('status', { jobId: '../elsewhere' }), { code: 'EDIT_JOB_ID_INVALID' });
  await assert.rejects(invokeEditWorkflow('edit.video.workflow.shell', {}, { root, env: f.env }), { code: 'EDIT_CAPABILITY_NOT_FOUND' });
  assert.deepEqual(f.requests, []); assert.deepEqual(readdirSync(f.jobs), []);
});
test('all named configured secrets are rejected in the original input before planning or persistence', async t => {
  const f = await fixture(t);
  for (const name of ['LLM_API_KEY', 'ARK_API_KEY', 'JWT_SECRET', 'DATABASE_PASSWORD', 'DATABASE_URL', 'UNRELATED_ACCESS_TOKEN']) {
    const sentinel = name + '-never-send-"\\\n' + randomUUID(), env = { ...f.env, [name]: sentinel };
    const input = { intent: '做17秒视频，原话中误带' + sentinel };
    await assert.rejects(invokeEditWorkflow('edit.video.workflow.plan', input, { root, env }), { code: 'EDIT_RESPONSE_CONTAINS_CREDENTIAL' });
    await assert.rejects(invokeEditWorkflow('edit.video.workflow.start', { ...input, idempotencyKey: randomUUID(), authorization: auth }, { root, env }), { code: 'EDIT_RESPONSE_CONTAINS_CREDENTIAL' });
  }
  assert.deepEqual(readdirSync(f.jobs), []); assert.deepEqual(f.requests, []);
});
test('doctor distinguishes discovery/connection/auth from media authorization without provider calls', async t => {
  const f = await fixture(t);
  const result = await invokeEditWorkflow('edit.agent.doctor', {}, { root, env: f.env });
  assert.equal(result.discovery.ready, true); assert.equal(result.connection.ready, true); assert.equal(result.auth.ready, true);
  assert.equal(result.production.ready, false); assert.equal(result.paidCalls, 0); assert.equal(result.writeOperations, 0);
  const noAuth = await invokeEditWorkflow('edit.agent.doctor', {}, { root, env: { ...f.env, WORKLOOM_ACCESS_TOKEN: '' } });
  assert.equal(noAuth.discovery.ready, true); assert.equal(noAuth.connection.ready, true); assert.equal(noAuth.auth.ready, false);
  assert.equal(noAuth.auth.code, 'MEMBER_TOKEN_REQUIRED'); assert.deepEqual(readdirSync(f.jobs), []);
  const missingStudio = await invokeEditWorkflow('edit.agent.doctor', {}, { root, env: { ...f.env, WORKLOOM_EDIT_STUDIO_ROOT: undefined } });
  assert.equal(missingStudio.configuration.ready, false); assert.equal(missingStudio.configuration.sharedStudioRoot.code, 'EDIT_STUDIO_ROOT_REQUIRED');
});
