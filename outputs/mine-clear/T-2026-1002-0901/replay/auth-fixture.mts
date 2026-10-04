import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const args=process.argv.slice(2);
if(!args.includes('--repo')) throw new Error('--repo required');
const repo=resolve(args[args.indexOf('--repo')+1]);
const url=new URL(process.env.DATABASE_URL||'');
if(url.pathname!=='/growth_audit'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Loopback growth_audit database required');
const db=await import(pathToFileURL(join(repo,'packages/db/src/client.ts')).href);
const owner=db.getOwnerPool();
const id=`audit-auth-${randomUUID()}`;
try {
  await owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,'隔离认证审计','community')",[id]);
  await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry,stage,is_example) VALUES($1,$1,'隔离认证审计',$1,'general','production',false)",[id]);
  await owner.query("INSERT INTO profiles(workspace_id,tenant_id,industry,archive) VALUES($1,$1,'general',$2)",[id,JSON.stringify({dataMode:'real',auditOnly:true})]);
  await owner.query("INSERT INTO members(id,workspace_id,member_no,name,role) VALUES($1,$2,'MEM-AUTH-AUDIT','隔离认证审计','owner')",[`${id}-owner`,id]);
  const fixture={workspaceSlug:id,workspaceId:id,memberNo:'MEM-AUTH-AUDIT',isExample:false,dataMode:'real',auditOnly:true};
  await writeFile(join(dirname(fileURLToPath(import.meta.url)),'auth-nonexample-input.json'),JSON.stringify(fixture,null,2));
  console.log(JSON.stringify({created:true,isExample:false,dataMode:'real',auditOnly:true}));
} finally { await db.closeAllPools(); }
