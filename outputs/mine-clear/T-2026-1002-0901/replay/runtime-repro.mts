/**
 * Run through repository tsx, with its isolated .env already loaded.
 * pnpm exec tsx --env-file=.env /absolute/path/runtime-repro.mts --repo /absolute/path/repo
 * Optional --assert makes existing defects exit 1; default records observations.
 * Refuses a database whose name is not growth_audit. Network/provider calls are unused.
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
if (!args.includes('--repo') || !args[args.indexOf('--repo') + 1]) throw new Error('--repo absolute source checkout required');
const repo = resolve(args[args.indexOf('--repo') + 1]);
const selected = args.includes('--case') ? args[args.indexOf('--case') + 1] : null;
for (const key of ['DATABASE_URL','DATABASE_APP_URL','DATABASE_GATEWAY_URL']) {
  const url = new URL(process.env[key] || '');
  if (url.pathname !== '/growth_audit' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Loopback isolated growth_audit database required');
}
const root = dirname(fileURLToPath(import.meta.url));
process.env.WORKLOOM_TOOL_EXECUTOR_MODULE = join(root, 'local-counter.mjs');
process.env.WORKLOOM_TOOL_EXECUTOR_MODULES = '';
process.env.WORKLOOM_BRIDGE_TOKEN = 'audit-placeholder-no-account';
process.env.LLM_PROVIDER = 'mock';
process.env.LLM_API_KEY = '';
process.env.LLM_BASE_URL = '';
process.env.HR_PORTRAIT_ENABLED = '0';
process.env.TOOL_UNVERIFIED_RATE = '0';
const imp = (file: string) => import(pathToFileURL(join(repo, file)).href);
const db = await imp('packages/db/src/client.ts');
const { runQuest } = await imp('packages/runtime/src/loop.ts');
const { runQuestForThread } = await imp('apps/server/src/runtime/thread-runner.ts');
const { sweepQueuedThreads } = await imp('apps/server/src/runtime/scheduler.ts');
const { decide } = await imp('packages/base/review-console/approvals.ts');
const owner = db.getOwnerPool(), app = db.getAppPool(), gateway = db.getGatewayPool();
const runId = `${Date.now().toString(36)}-${Math.floor(Math.random()*1e6)}`;
const results: any[] = [];
const counter = () => (globalThis as any).__growthAuditCounter = { calls: [], before: null, barrier: null };
const step = (context: Record<string,unknown> = {}, params: Record<string,unknown> = { amount: 1 }) =>
  ({ stepId:'s1', action:'audit.write', objectType:'audit_resource', tool:'audit.write', params, context, label:'本地计数动作' });
async function fixture(label: string, level = 'auto', highRisk = false, bindings = true) {
  const scope = { tenantId:`audit-t-${runId}-${label}`, workspaceId:`audit-w-${runId}-${label}` };
  const presetKey = 'audit-operator', agentId = `audit-a-${runId}-${label}`, ruleId = `AUDIT-${label}`;
  await owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,'审计隔离夹具','community')",[scope.tenantId]);
  await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry,stage) VALUES($1,$2,'审计隔离夹具',$1,'general','production')",[scope.workspaceId,scope.tenantId]);
  await owner.query("INSERT INTO profiles(workspace_id,tenant_id,industry,archive) VALUES($1,$2,'general',$3)",[scope.workspaceId,scope.tenantId,JSON.stringify({dataMode:'real',auditOnly:true})]);
  await owner.query("INSERT INTO agents(id,workspace_id,preset_key,name,version,kind,fence_bindings,meta) VALUES($1,$2,$3,'审计计数岗位','audit-v1','worker',$4,$5)",[agentId,scope.workspaceId,presetKey,JSON.stringify(bindings?[ruleId]:[]),JSON.stringify({high_risk:highRisk,tools:[{name:'audit.write',access:'write',desc:'本地计数动作'}]})]);
  await owner.query("INSERT INTO fence_rules(id,rule_id,version,workspace_id,name,level,match_spec,action,status,created_by) VALUES($1,$2,'audit-v1',$3,'审计规则',$4,$5,$6,'active','audit')",[`${ruleId}-${runId}`,ruleId,scope.workspaceId,level,JSON.stringify({object_types:['audit_resource'],actions:['audit.write'],when:'true'}),JSON.stringify({result:level})]);
  const newThread = async (label2: string, plan: unknown = null, status='queued') => {
    const id = `audit-th-${runId}-${label}-${label2}`;
    await owner.query("INSERT INTO threads(id,tenant_id,workspace_id,title,mode,status,created_by,agent_id,plan,plan_version) VALUES($1,$2,$3,$4,'quest',$5,'MEM-AUDIT',$6,$7,$8)",[id,scope.tenantId,scope.workspaceId,label2,status,agentId,plan===null?null:JSON.stringify(plan),plan===null?0:1]);
    return id;
  };
  const direct = (threadId:string, steps:any[], more:Record<string,unknown>={}) => runQuest(app,gateway,scope,{threadId,goal:'本地计数动作',presetKey,fallbackPlanner:()=>steps,
    toolExecutor:async(name:string,params:any)=>{ const mod=await import(pathToFileURL(join(root,'local-counter.mjs')).href); return mod.createToolExecutorForScope(scope)(name,params); },...more});
  const runner = (threadId:string) => runQuestForThread(scope,{threadId,goal:'本地计数动作',presetRef:presetKey});
  const status = async (threadId:string) => (await owner.query('SELECT status FROM threads WHERE id=$1',[threadId])).rows[0]?.status;
  return {scope,presetKey,agentId,newThread,direct,runner,status};
}
async function record(id:string, fn:()=>Promise<any>) {
  if (selected && selected !== id) return;
  try { const observation=await fn(); results.push({id,...observation}); console.log(JSON.stringify(results.at(-1))); }
  catch(error) { results.push({id,harnessError:error instanceof Error?error.stack:String(error)}); console.error(JSON.stringify(results.at(-1))); }
}

try {
  await record('QUEUE-10', async()=>{
    // Suppress unrelated queued seed/test jobs only in this isolated database.
    await owner.query("UPDATE threads SET status='paused' WHERE status='queued' AND id LIKE 'audit-th-%'");
    const f=await fixture('queue');
    for(let n=0;n<10;n++) await f.newThread(`q${n}`);
    const first=await sweepQueuedThreads({batch:3}), second=await sweepQueuedThreads({batch:3});
    const queued=Number((await owner.query("SELECT count(*) AS n FROM threads WHERE workspace_id=$1 AND status='queued'",[f.scope.workspaceId])).rows[0].n);
    await owner.query("UPDATE threads SET status='paused' WHERE workspace_id=$1",[f.scope.workspaceId]);
    return {expected:'Queue advances with 0 running and 10 queued',actual:{first,second,queued},healthy:queued<10};
  });
  await record('BLOCK-FLAG',async()=>{
    const f=await fixture('block','block'); const state=counter();
    const control=await f.newThread('control'), flagged=await f.newThread('flagged');
    const a=await f.direct(control,[step()]);
    const b=await f.direct(flagged,[step({params_incomplete:true})]);
    if(b.pendingApprovalId) await decide(app,gateway,f.scope,{memberNo:'MEM-AUDIT',role:'owner'},b.pendingApprovalId,{type:'approve'});
    const c=await f.direct(flagged,[step({params_incomplete:true})]);
    return {expected:'Unconditional block remains blocked regardless of context flags or approval',actual:{control:a.status,flagged:b.status,afterApproval:c.status,calls:state.calls},healthy:state.calls.length===0};
  });
  await record('PENDING-CONCURRENCY',async()=>{
    const f=await fixture('concurrency','auto',true); const state=counter();
    const tid=await f.newThread('concurrency',[step()]); const pending=await f.direct(tid,[step()]);
    await decide(app,gateway,f.scope,{memberNo:'MEM-AUDIT',role:'owner'},pending.pendingApprovalId,{type:'approve'});
    // Delay the first actual status read until both CAS attempts have observed pending_review.
    const connect=app.connect.bind(app); let reads=0, releaseReads:any;
    const readBarrier=new Promise<void>(r=>releaseReads=r);
    app.connect=async()=>{const client=await connect(); const query=client.query.bind(client);
      client.query=async(sql:any,values?:any[])=>{const result=await query(sql,values);
        if(typeof sql==='string'&&sql.includes('SELECT status FROM threads')&&values?.[0]===tid){reads++; if(reads===2)releaseReads(); await readBarrier;}
        return result;};
      const release=client.release.bind(client);client.release=(...x:any[])=>{client.query=query;client.release=release;return release(...x);};return client;};
    let executed=0, releaseTools:any; const toolBarrier=new Promise<void>(r=>releaseTools=r);
    state.barrier=async()=>{if(++executed===2) releaseTools();await toolBarrier;};
    const timeout=setTimeout(()=>{releaseReads();releaseTools();},4000);
    let runs:any[];
    try { runs=await Promise.allSettled([f.runner(tid),f.runner(tid)]); }
    finally {clearTimeout(timeout);app.connect=connect;}
    const approval=(await owner.query('SELECT status,consumed_at FROM approvals WHERE approval_id=$1',[pending.pendingApprovalId])).rows[0];
    return {expected:'One approved high risk step invokes the executor at most once',actual:{statusReads:reads,calls:state.calls,runs:runs.map(r=>r.status==='fulfilled'?{status:r.status,value:r.value.status}:{status:r.status,error:String(r.reason)}),approval,threadStatus:await f.status(tid)},healthy:state.calls.length<=1};
  });
  await record('EDIT-PARAMS',async()=>{
    const f=await fixture('edit','review');const state=counter();const tid=await f.newThread('edit',[step()]);
    const pending=await f.direct(tid,[step()]);
    await decide(app,gateway,f.scope,{memberNo:'MEM-AUDIT',role:'owner'},pending.pendingApprovalId,{type:'edit',editedAfter:{amount:2},editKind:'correction'});
    const result=await f.direct(tid,[step()]);
    return {expected:'Edited amount=2 is what the tool executes',actual:{status:result.status,requested:{amount:2},calls:state.calls},healthy:state.calls.length===1&&state.calls[0].params.amount===2};
  });
  await record('EDIT-HIGH-RISK',async()=>{
    const f=await fixture('edit-high','auto',true);const state=counter();const tid=await f.newThread('edit-high',[step()]);
    const pending=await f.direct(tid,[step()]);
    await decide(app,gateway,f.scope,{memberNo:'MEM-AUDIT',role:'owner'},pending.pendingApprovalId,{type:'edit',editedAfter:{amount:2},editKind:'correction'});
    let result:any,error:any;try{result=await f.direct(tid,[step()]);}catch(e){error=String(e);}
    return {expected:'Edited approval is handled consistently before any side effect',actual:{result:result?.status,error,calls:state.calls,threadStatus:await f.status(tid)},healthy:!error&&state.calls.length===1&&state.calls[0].params.amount===2};
  });
  await record('RELEVANCE-REPLAY',async()=>{
    const f=await fixture('relevance');const state=counter();const tid=await f.newThread('提高入住率');
    const first=await f.direct(tid,[step({}, {})],{goal:'提高入住率'});
    const stored=(await owner.query('SELECT plan FROM threads WHERE id=$1',[tid])).rows[0].plan;
    const second=await f.direct(tid,[step({}, {})],{goal:'提高入住率'});
    return {expected:'Unapproved plan_unverified persists and still requires human approval on replay',actual:{first:first.status,stored,second:second.status,calls:state.calls},healthy:state.calls.length===0};
  });
  await record('REJECT-TERMINAL',async()=>{
    const f=await fixture('reject','review');const state=counter();const tid=await f.newThread('reject',[step()]);
    const pending=await f.direct(tid,[step()]);
    await decide(app,gateway,f.scope,{memberNo:'MEM-AUDIT',role:'owner'},pending.pendingApprovalId,{type:'reject',reasonEnum:`audit_reject_${runId}`,reasonText:'本地隔离审计驳回'});
    const before=await f.status(tid), after=await f.runner(tid);
    return {expected:'Rejected cancelled thread remains terminated unless explicit restart policy is invoked',actual:{before,after:after.status,storedStatus:await f.status(tid),calls:state.calls},healthy:(await f.status(tid))==='cancelled'};
  });
  await record('PERMISSION-BEFORE-ACTION',async()=>{
    const f=await fixture('permission','auto',false,false);const state=counter();const tid=await f.newThread('permission',[step()]);
    let error:any;try{await f.direct(tid,[step()]);}catch(e){error=String(e);}
    return {expected:'An agent with no fence bindings cannot execute a write tool',actual:{error,calls:state.calls,threadStatus:await f.status(tid)},healthy:state.calls.length===0};
  });
  await record('REJECT-WORKSPACE-COLLISION',async()=>{
    const left=await fixture('reject-left','review'), right=await fixture('reject-right','review');
    const reasonEnum=`audit_collision_${runId}`;
    const observations:any[]=[];
    for (const f of [left,right]) {
      const tid=await f.newThread('reject',[step()]);
      const pending=await f.direct(tid,[step()]);
      let error:any;
      try { await decide(app,gateway,f.scope,{memberNo:'MEM-AUDIT',role:'owner'},pending.pendingApprovalId,{type:'reject',reasonEnum,reasonText:'跨工作区相同枚举隔离审计'}); }
      catch (e:any) { error={message:e.message,code:e.code}; }
      const approval=(await owner.query('SELECT status FROM approvals WHERE approval_id=$1',[pending.pendingApprovalId])).rows[0];
      observations.push({workspaceId:f.scope.workspaceId,error,approvalStatus:approval.status,threadStatus:await f.status(tid)});
    }
    return {expected:'Two workspaces reject with the same enum independently, with both approvals rejected and both threads cancelled',actual:observations,healthy:observations.every(x=>!x.error&&x.approvalStatus==='rejected'&&x.threadStatus==='cancelled')};
  });
} finally {await db.closeAllPools();}
const summary={baseline:'42ead347c65a5cc343bcd290702d53a7fcdb1687',environment:'isolated PostgreSQL; local counter connector; no external actions',runId,results};
await writeFile(join(root,'runtime-repro-results.json'),JSON.stringify(summary,null,2));
if(results.length===0) throw new Error(`Unknown case ${selected}`);
if(results.some(r=>r.harnessError)) process.exitCode=2;
else if(args.includes('--assert')&&results.some(r=>!r.healthy)) process.exitCode=1;
