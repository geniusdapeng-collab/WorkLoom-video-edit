import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const repoFlag = process.argv.indexOf('--repo');
if (repoFlag < 0 || !process.argv[repoFlag + 1] || process.argv[repoFlag + 1]!.startsWith('--')) throw new Error('--repo requires an explicit repository directory');
const repo = resolve(process.argv[repoFlag + 1]!);
const mode = process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1] : 'success';
if (!['success', 'missing-output', 'deadline'].includes(mode!)) throw new Error('Unknown film acceptance case');
for (const name of ['DATABASE_URL', 'DATABASE_APP_URL', 'DATABASE_GATEWAY_URL']) {
  const url = new URL(process.env[name] || '');
  if (url.pathname !== '/growth_audit' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Isolated loopback database required');
}
for (const key of Object.keys(process.env)) if (/(?:API_KEY|KEY_SECRET|SIGNING_SECRET|LIVE_ENV)/u.test(key)) delete process.env[key];
process.env.LLM_PROVIDER = 'mock';
process.env.FILM_JOB_DEADLINE_MS = mode === 'deadline' ? '1' : '100000';
process.env.HR_WORK_DIR = join(dirname(fileURLToPath(import.meta.url)), 'film-fixtures');
const db = await import(pathToFileURL(join(repo, 'packages/db/src/client.ts')).href);
const { filmRouter } = await import(pathToFileURL(join(repo, 'apps/server/src/video/film-router.ts')).href);
const checks: unknown[] = [];
try {
  const owner = db.getOwnerPool();
  const member = (await owner.query(`SELECT m.*, w.tenant_id, t.plan FROM members m JOIN workspaces w ON w.id=m.workspace_id JOIN tenants t ON t.id=w.tenant_id WHERE m.workspace_id='ws-yunqi' AND m.member_no='MEM-001'`)).rows[0];
  if (!member) throw new Error('Isolated seed owner missing');
  const identity = { kind: 'member', memberId: member.id, memberNo: member.member_no, name: member.name, role: member.role, tenantId: member.tenant_id, workspaceId: member.workspace_id, plan: member.plan };
  const caller = filmRouter.createCaller({ identity, session: identity, partnerIdentity: null, headers: new Headers() });
  const projectId = `m6-film-${randomUUID()}`;
  await owner.query("INSERT INTO video_projects(id,workspace_id,title,kind,created_by) VALUES($1,'ws-yunqi','隔离影片工位回归','narrative','MEM-001')", [projectId]);
  const document = { projectId, title: '办公室讲解', eraProfile: { storyDate: '2026-10-02' }, shots: [{ shotId: 'SC-01', duration: 5, scene: '现代办公室内，窗边办公桌', sceneType: 'interior', camera: '固定机位，中景', composition: '讲解者位于画面中央', lighting: '窗边柔光', action: '讲解者看向镜头，抬手指示图表', character: '陈卓' }] };
  const receipt = await caller.start({ projectId, document, stages: mode === 'missing-output' ? ['compose'] : ['cine-kb', 'continuity'], options: { platform: 'YouTube' }, maxBudgetCny: 1 });
  let status: any;
  const deadline = Date.now() + 120_000;
  do { await new Promise(r => setTimeout(r, 100)); status = await caller.status({ jobId: receipt.jobId }); }
  while (status.status === 'running' && Date.now() < deadline);
  const attemptDir = join(process.env.HR_WORK_DIR, 'archive', 'ws-yunqi', projectId, 'stages', 'film', `attempt-${receipt.attempt}`);
  const log = await readFile(join(attemptDir, 'worker.log'), 'utf8').catch(() => '');
  if (mode === 'deadline') checks.push({ name: 'Hard deadline stops the worker and cannot become a successful exit', healthy: status.status === 'failed' && status.errorClass === 'JOB_DEADLINE_EXCEEDED', status: status.status, error: status.errorClass });
  else if (mode === 'missing-output') checks.push({ name: 'Composition without upstream clips cannot report a successful job', healthy: status.status === 'failed' && status.errorClass === 'WORKER_EXIT_NONZERO', status: status.status, error: status.errorClass, log: log.slice(-2000) });
  else checks.push({ name: 'Public film start/status executes registered local stage with frozen source', healthy: status.status === 'finished', status: status.status, error: status.errorClass, log: log.slice(-4000), components: status.components });
  if (mode === 'success' && status.status === 'finished') {
    const result = JSON.parse(await readFile(join(attemptDir, 'film-result.json'), 'utf8'));
    checks.push({ name: 'Result is bound to the job, run and frozen input', healthy: result.jobId === receipt.jobId && result.inputSha256 === receipt.inputSha256 && result.complete === true && result.artifacts.length > 0 });
    checks.push({ name: 'Registered component capability reaches the parent review ledger', healthy: status.components.some((row: any) => row.component === 'review' && row.state === 'accepted') });
    let invalidRejected = false;
    try { await caller.start({ projectId, document, stages: ['storyboard'], options: {}, maxBudgetCny: 1 }); } catch { invalidRejected = true; }
    checks.push({ name: 'Unknown stage fails before spawning', healthy: invalidRejected });
    let arbitraryOptionRejected = false;
    try { await caller.start({ projectId, document, stages: ['cine-kb'], options: { 'keys-file': '/tmp/private.env' }, maxBudgetCny: 1 }); } catch { arbitraryOptionRejected = true; }
    checks.push({ name: 'Options cannot read a secret file or replace job paths', healthy: arbitraryOptionRejected });
  }
} finally { await db.closeAllPools(); }
const result = { case: mode, provider_mode: 'isolated, no provider credentials or calls; local stage only', passed: checks.length > 0 && checks.every((c: any) => c.healthy), checks };
await writeFile(join(dirname(fileURLToPath(import.meta.url)), `film-public-${mode}-results.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (!result.passed) process.exitCode = 1;
