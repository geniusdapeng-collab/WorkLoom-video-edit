import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = join(ROOT, 'scripts/tools/full-chain-film.mts');
const FFMPEG = process.env.WL_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.WL_FFPROBE || 'ffprobe';
const hash = (data) => createHash('sha256').update(data).digest('hex');
const fileHash = (file) => hash(readFileSync(file));
const media = (args) => {
  const result = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
};
function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const file = join(dir, entry.name); return entry.isDirectory() ? walk(file) : [file];
}); }
function preserve(f, result, name) {
  if (!process.env.WORKLOOM_TEST_EVIDENCE_DIR) return;
  const evidenceRoot = resolve(process.env.WORKLOOM_TEST_EVIDENCE_DIR);
  mkdirSync(evidenceRoot, { recursive: true });
  // Both original CI entries import these real CLI cases. Each process keeps its
  // own immutable archive instead of removing a concurrently captured case.
  const destination = mkdtempSync(join(evidenceRoot, `${name}-`));
  const inventory = (root) => walk(root).map((path) => ({ path: path.slice(root.length + 1),
    bytes: readFileSync(path).length, sha256: fileHash(path) })).sort((a, b) => a.path.localeCompare(b.path));
  const sourceFiles = inventory(f.root);
  cpSync(f.root, destination, { recursive: true });
  const archivedFiles = inventory(destination);
  assert.deepEqual(archivedFiles, sourceFiles, '实际CLI证据归档须完整保存每个源文件和输出字节');
  writeFileSync(join(destination, 'cli-result.json'), JSON.stringify({ status: result.status, signal: result.signal,
    error: result.error?.message ?? null, actualArgv: f.lastArgs, sourceCliSha256: fileHash(CLI),
    sourceFiles, files: archivedFiles }, null, 2));
}
function fixture(t, { audio = false, seconds = 1.1, nominal = 30, dialogue = '原片台词，不触发语音复核' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'growth 正式后期 中文 空格-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = 'OFFLINE-P1', work = join(root, 'work'), out = join(root, 'out');
  const logs = join(work, 'logs', project), clips = join(work, 'clips', project);
  const library = join(root, 'tracks');
  [logs, clips, library].forEach((dir) => mkdirSync(dir, { recursive: true }));
  const clip = join(clips, 'S1.mp4'), bed = join(library, 'bed.wav'), prompt = join(root, 'original-prompt.txt');
  media(['-f', 'lavfi', '-i', `color=c=black:s=64x96:r=17:d=${seconds}`,
    ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=411:sample_rate=48000:duration=${seconds}`] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac', '-shortest'] : ['-an']), clip]);
  media(['-f', 'lavfi', '-i', 'sine=frequency=701:sample_rate=48000:duration=0.6', '-c:a', 'pcm_s16le', bed]);
  writeFileSync(prompt, 'Original issued provider prompt. Do not overwrite during post.');
  writeFileSync(join(library, 'tracks.json'), JSON.stringify({ tracks: [{ id: 'own-fixture', file: 'bed.wav', title: '旅行 测试',
    genre: '旅行 游戏 电子 史诗 旅拍 生活 轻快 卡点', mood: '温润治愈 律动兴奋 宏大推进 安静舒缓 温暖自在 松弛平和 明快愉悦',
    bpm: 120, durationSec: 90, license: 'workloom-self-generated' }] }));
  const shots = join(root, 'shots.json');
  writeFileSync(shots, JSON.stringify({ title: '完整作品', durationSeconds: nominal, aspect: '9:16', resolution: '720p',
    eraProfile: { storyDate: '2026-10-07' }, shots: [{ shotId: 'S1', duration: nominal, dialogue: [{speaker:'原片人物',text:dialogue}],
      motion: '旧稿动作意图', scene: '旧稿场景', wardrobe: '旧稿衣服' }] }));
  const keys = join(root, 'empty.env'); writeFileSync(keys, '');
  const danmaku = join(root, 'danmaku.json'); writeFileSync(danmaku, JSON.stringify([{ text: '完整作品', at: 0.1, mode: 'top' }]));
  const network = join(root, 'network.log'); writeFileSync(network, '');
  const preloader = join(root, 'deny-network.cjs');
  writeFileSync(preloader, `const fs=require('node:fs');const log=process.env.WORKLOOM_TEST_NETWORK_LOG;const deny=k=>{fs.appendFileSync(log,k+'\\n');throw new Error('OFFLINE_NETWORK_FORBIDDEN:'+k)};globalThis.fetch=()=>deny('fetch');for(const n of ['node:http','node:https']){const m=require(n);m.request=()=>deny(n+'.request');m.get=()=>deny(n+'.get')};const net=require('node:net');for(const n of ['connect','createConnection']){const orig=net[n];net[n]=function(...a){const p=typeof a[0]==='string'?a[0]:a[0]?.path;if(p&&p.startsWith('/'))return orig.apply(this,a);return deny('net.'+n)}};`);
  const env = { ...process.env, WL_FFMPEG: FFMPEG, WL_FFPROBE: FFPROBE,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(preloader)}`,
    WORKLOOM_TEST_NETWORK_LOG: network, WORKLOOM_BGM_DISCOVER: '0', WORKLOOM_BGM_LIBRARY_DIR: library,
    WORKLOOM_BGM_HOME: join(root, 'empty-home'), WORKLOOM_COLOR_CACHE_DIR: join(root, 'color-cache'),
    WORKLOOM_SUBTITLE_CACHE_DIR: join(root, 'subtitle-cache'),
    PATH: `${dirname(process.execPath)}:${process.env.PATH || ''}` };
  const lineageFixture = `import fs from 'node:fs';import path from 'node:path';
    import {loadOrCreateFilmAuthorContext} from './packages/video-studio/src/film-contracts.ts';
    import {createLineageReceipt,productionHash} from './packages/video-studio/src/production-lineage.ts';
    const x=JSON.parse(process.argv[1]);const doc=JSON.parse(fs.readFileSync(x.shots));
    const author=loadOrCreateFilmAuthorContext({path:path.join(x.logs,'project-context.json'),projectId:x.project,eraProfile:doc.eraProfile});
    const {shots,durationSeconds,...common}=doc;const sourceHash=productionHash({source:{...common,shot:shots[0]},brief:null,sceneBible:null,
      eraProfile:author.eraProfile,aspect:'9:16',resolution:'720p',fps:30});
    const lineage=createLineageReceipt({projectId:x.project,sourceHash,runId:'actual-old-run',stage:'shot',shotId:'S1',recipe:{component:'old-quality-policy'},
      status:'failed',inputs:[x.prompt],outputs:[x.clip]});
    fs.writeFileSync(path.join(x.logs,'stages.jsonl'),JSON.stringify({at:'2026-10-01T00:00:00.000Z',stage:'shot',shotId:'S1',invoked:true,ok:false,cached:false,degraded:false,
      artifact:x.clip,verdict:{approved:false,reason:'old visual/clothing/lip judgment'},evidence:{taskId:'fixture-issued-real-task',qualityScore:1},lineage})+'\\n');`;
  const setup = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', lineageFixture,
    JSON.stringify({ project, shots, logs, prompt, clip })], { cwd: ROOT, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(setup.status, 0, setup.stderr);
  const history = join(logs, 'stages.jsonl');
  return { root, work, out, logs, clips, clip, bed, prompt, project, shots, keys, danmaku, network, env, history,
    oldHistory: readFileSync(history), oldClip: fileHash(clip), oldPrompt: fileHash(prompt) };
}
function run(f, args = [], stages = 'compose,master') {
  f.lastArgs = ['--import', 'tsx', CLI, '--shots', f.shots, '--project', f.project,
    '--work-dir', f.work, '--out', f.out, '--keys-file', f.keys, '--resolution', '720p', '--route-kind', 'narrative',
    '--allow-reframe', '--reframe-reason', 'explicit test fixture exports original 2:3 into requested 9:16',
    '--stages', stages, '--xfade', '0', '--cut-transition', '', '--review-policy', 'blocking',
    '--bgm-track', f.bed, '--danmaku', f.danmaku, '--no-open-with-cover', '--no-cover-kb', '--cover-hero', 'scenery',
    '--no-title-card', ...args];
  const result = spawnSync(process.execPath, f.lastArgs, { cwd: ROOT, env: f.env, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(join(f.root, 'stdout.log'), result.stdout || ''); writeFileSync(join(f.root, 'stderr.log'), result.stderr || '');
  return result;
}
function rows(f) { return readFileSync(f.history, 'utf8').trim().split('\n').map((line) => JSON.parse(line)); }
function assertOriginal(f) {
  assert.equal(fileHash(f.clip), f.oldClip); assert.equal(fileHash(f.prompt), f.oldPrompt);
  assert.ok(readFileSync(f.history).subarray(0, f.oldHistory.length).equals(f.oldHistory), 'prior quality failure must remain byte exact');
  assert.equal(readFileSync(f.network, 'utf8'), '', 'production CLI/post tools must not attempt external requests');
  assert.equal(walk(f.work).filter((path) => /(?:voiced|asr|tts)(?:[.-]|\/)/i.test(path)).length, 0);
}

test('真实全链CLI接收黑屏、无音轨、17FPS、旧品质失败与30秒名义稿：正式后期和3变体完成，旧字节/原记录不改，外呼0', { timeout: 150000 }, (t) => {
  const f = fixture(t); const result = run(f, ['--subtitle-mode', 'both'], 'videos,voice,compose,color,subtitle,danmaku,bgm,sfx,cover,mux,master,deliver');
  preserve(f, result, 'full-post-black-silent');
  assert.equal(result.status, 0, result.stdout + result.stderr); assertOriginal(f);
  for (const stage of ['shot', 'voice', 'compose', 'color', 'subtitle', 'danmaku', 'bgm', 'sfx', 'cover', 'mux', 'master', 'deliver']) {
    const row = rows(f).filter((entry) => entry.stage === stage).at(-1);
    assert.ok(row?.ok, `${stage} needs an actual passed processing receipt`);
    if (row.verdict) assert.equal(row.verdict.score, null);
  }
  const pointer = JSON.parse(readFileSync(join(f.out, 'current.json')));
  const manifest = JSON.parse(readFileSync(pointer.manifest));
  assert.equal(manifest.qualityReviewed, false); assert.equal(manifest.distinctness, null); assert.deepEqual(manifest.samples, []);
  assert.equal(manifest.variants.length, 3);
  for (const item of [manifest.deliverable, ...manifest.variants]) { assert.ok(existsSync(item.path)); assert.equal(fileHash(item.path), item.sha256); }
});

test('真实CLI原声镜头复用保留，后期仅compose/master也能正式产出，不触发自动配音', { timeout: 60000 }, (t) => {
  const f = fixture(t, { audio: true }); const result = run(f);
  preserve(f, result, 'native-audio'); assert.equal(result.status, 0, result.stdout + result.stderr); assertOriginal(f);
  const actual = rows(f).findLast((entry) => entry.stage === 'master'); assert.ok(actual?.ok);
  const streams = JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-show_streams', '-of', 'json', actual.artifact], { encoding: 'utf8' }).stdout);
  assert.ok(streams.streams.some((stream) => stream.codec_type === 'audio'));
});

test('真实CLI自产字幕保留三行以后全部台词，不按隐式两行上限删字', { timeout: 60000 }, (t) => {
  const dialogue = '第一段完整台词要按原文保存并清楚显示，第二段继续保留完整思想和用户已经交付的文字，第三段包含结尾承诺还有第四段最后的行动说明';
  const f = fixture(t, { dialogue, seconds: 2.4 });
  const result = run(f, ['--subtitle-mode', 'sidecar'], 'compose,subtitle,master');
  preserve(f, result, 'full-subtitle-text');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertOriginal(f);
  const expected = dialogue.replace(/[，。！？；、,.!?;:："“”'‘’（）()【】《》—…·]/g, '');
  for (const source of [join(f.work, 'post', f.project, 'subtitle.srt'), join(f.work, 'post', f.project, 'subtitles', `${f.project}.zh.srt`)]) {
    const text = readFileSync(source, 'utf8').split('\n').filter((line) => line && !/^\d+$/.test(line) && !line.includes('-->')).join('');
    assert.equal(text, expected, '自产与旁挂字幕必须保存完整台词');
  }
});

for (const [name, mutate, pattern] of [
  ['empty-registry', (f) => { const doc=JSON.parse(readFileSync(f.shots));doc.shots=[];writeFileSync(f.shots,JSON.stringify(doc)); }, /SHOT_REGISTRY_REQUIRED/],
  ['duplicate-id', (f) => { const doc=JSON.parse(readFileSync(f.shots));doc.shots.push(doc.shots[0]);writeFileSync(f.shots,JSON.stringify(doc)); }, /SHOT_REGISTRY_INVALID/],
  ['unsafe-id', (f) => { const doc=JSON.parse(readFileSync(f.shots));doc.shots[0].shotId='../escape';writeFileSync(f.shots,JSON.stringify(doc)); }, /SHOT_REGISTRY_INVALID/],
  ['source-contract-changed', (f) => { const doc=JSON.parse(readFileSync(f.shots));doc.shots[0].scene='changed after supplier';writeFileSync(f.shots,JSON.stringify(doc)); }, /RENDERED_SOURCE_PROVENANCE_MISSING|COMPOSE_INPUT_FAILED/],
  ['original-input-changed', (f) => writeFileSync(f.prompt,'tampered'), /RENDERED_SOURCE_PROVENANCE_MISSING|COMPOSE_INPUT_FAILED/],
  ['output-changed', (f) => writeFileSync(f.clip,'tampered nonmedia'), /RENDERED_SOURCE_PROVENANCE_MISSING|COMPOSE_INPUT_FAILED/],
  ['provider-failed', (f) => { const row=rows(f)[0];row.evidence.providerStatus='failed';writeFileSync(f.history,JSON.stringify(row)+'\n'); }, /RENDERED_SOURCE_PROVENANCE_MISSING|COMPOSE_INPUT_FAILED/],
  ['missing-task', (f) => { const row=rows(f)[0];delete row.evidence.taskId;writeFileSync(f.history,JSON.stringify(row)+'\n'); }, /RENDERED_SOURCE_PROVENANCE_MISSING|COMPOSE_INPUT_FAILED/],
  ['missing-lineage', (f) => { const row=rows(f)[0];delete row.lineage;writeFileSync(f.history,JSON.stringify(row)+'\n'); }, /RENDERED_SOURCE_PROVENANCE_MISSING|COMPOSE_INPUT_FAILED/],
  ['missing-source', (f) => rmSync(f.clip), /COMPOSE_INPUT_FAILED/],
]) test(`真实CLI失败关闭：${name}，不自动重渲、不交付、不外呼`, { timeout: 45000 }, (t) => {
  const f = fixture(t); mutate(f); const result = run(f); preserve(f, result, name);
  assert.notEqual(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout + result.stderr, pattern);
  assert.equal(readFileSync(f.network, 'utf8'), ''); assert.equal(existsSync(join(f.out, `${f.project}-delivery-manifest.json`)), false);
});

test('真实CLI处理工具失败会显式停止且不复用旧母版冒充新完成', { timeout: 45000 }, (t) => {
  const f = fixture(t); const bad = join(f.root, 'fail-ffmpeg');
  writeFileSync(bad, '#!/bin/sh\nprintf "fixture actual encoder failed\\n" >&2\nexit 39\n'); chmodSync(bad, 0o755);
  f.env.WL_FFMPEG = bad;
  const post = join(f.work, 'post', f.project); mkdirSync(post, { recursive: true });
  const stale = join(post, 'master-raw.mp4'); writeFileSync(stale, 'stale output');
  const result = run(f); preserve(f, result, 'encoder-failure');
  assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /COMPOSE_PROCESSING_FAILED|fixture actual encoder failed/);
  assert.equal(readFileSync(f.network, 'utf8'), ''); assert.equal(existsSync(join(f.out, `${f.project}-delivery-manifest.json`)), false);
});

test('真实CLI普通UHD本地导出画布，不默认启动增强模型；源片仍保留', { timeout: 90000 }, (t) => {
  const f=fixture(t);const result=run(f,['--quality','uhd']);preserve(f,result,'uhd-local-export');
  assert.equal(result.status,0,result.stdout+result.stderr);assertOriginal(f);
  assert.equal(rows(f).filter((row)=>row.stage==='enhance').length,0);
  const master=rows(f).findLast((row)=>row.stage==='master');assert.ok(master?.ok);
  const info=JSON.parse(spawnSync(FFPROBE,['-v','error','-show_streams','-of','json',master.artifact],{encoding:'utf8'}).stdout);
  const video=info.streams.find((stream)=>stream.codec_type==='video');assert.equal(video.width,2160);assert.equal(video.height,3840);
});

test('真实CLI成功任务的当前字节不能解码时是实际处理失败，不启动重渲或声音替换', { timeout: 45000 }, (t) => {
  const f=fixture(t);writeFileSync(f.clip,'actual supplier file that is not video');
  const row=rows(f)[0];row.lineage.outputs[0]={...row.lineage.outputs[0],sha256:fileHash(f.clip),bytes:readFileSync(f.clip).length};
  writeFileSync(f.history,JSON.stringify(row)+'\n');const result=run(f);preserve(f,result,'corrupt-matching-receipt');
  assert.notEqual(result.status,0);assert.match(result.stdout+result.stderr,/COMPOSE_SOURCE_TIMELINE_UNREADABLE|COMPOSE_PROCESSING_FAILED/);
  assert.equal(readFileSync(f.network,'utf8'),'');assert.equal(existsSync(join(f.out,`${f.project}-delivery-manifest.json`)),false);
});

for (const [name,stages,needle,pattern] of [
  ['color-failure','compose,color,master','master-graded.mp4',/COLOR_UNVERIFIED/],
  ['burn-failure','compose,subtitle,master','master-subtitled.mp4',/SUBTITLE_BURN_FAILED/],
  ['danmaku-failure','compose,danmaku,master','master-danmaku.mp4',/DANMAKU_PROCESSING_FAILED/],
  ['bgm-failure','compose,bgm,master','bed-music.wav',/BGM_PROCESSING_FAILED/],
  ['cover-failure','compose,cover,master','-cover.png',/fixture stage processing failed/],
  ['mux-failure','compose,subtitle,mux,master','-softsub.mp4',/MUX|fixture stage processing failed|请求未完成/],
  ['variant-failure','compose,master,deliver','-variant-cool-tech.mp4',/VARIANT_COLOR_FAILED/],
]) test(`真实CLI正式后期执行失败：${name}，返回非零、不伪装交付`,{timeout:90000},(t)=>{
  const f=fixture(t);const wrapper=join(f.root,'actual-tool-failure.cjs');
  const actual=spawnSync('which',[FFMPEG],{encoding:'utf8'}).stdout.trim()||FFMPEG;
  writeFileSync(wrapper,`#!${process.execPath}\nconst cp=require('node:child_process');const args=process.argv.slice(2);if(args.some(a=>a.includes(${JSON.stringify(needle)}))){process.stderr.write('fixture stage processing failed\\n');process.exit(43)}const r=cp.spawnSync(${JSON.stringify(actual)},args,{stdio:'inherit'});if(r.error){process.stderr.write(r.error.message);process.exit(44)}process.exit(r.status??45);\n`);chmodSync(wrapper,0o755);f.env.WL_FFMPEG=wrapper;
  const result=run(f,['--subtitle-mode',name==='burn-failure'?'burn':'sidecar'],stages);preserve(f,result,name);
  assert.notEqual(result.status,0,result.stdout+result.stderr);assert.match(result.stdout+result.stderr,pattern);
  assert.equal(readFileSync(f.network,'utf8'),'');assert.equal(existsSync(join(f.out,`${f.project}-delivery-manifest.json`)),false);
});

test('真实CLI新增镜头未满足提交前授权/资产条件时仍停止，已完成镜头不会自动复渲',{timeout:45000},(t)=>{
  const f=fixture(t);const doc=JSON.parse(readFileSync(f.shots));
  doc.shots.push({shotId:'S2',duration:5,character:'未授权真人',dialogue:[]});writeFileSync(f.shots,JSON.stringify(doc));
  const result=run(f,[],'videos,compose,master');preserve(f,result,'unauthorized-new-submit');
  assert.notEqual(result.status,0);assert.equal(readFileSync(f.network,'utf8'),'');
  assert.equal(fileHash(f.clip),f.oldClip);assert.equal(existsSync(join(f.out,`${f.project}-delivery-manifest.json`)),false);
});

const vendorRequire = createRequire(join(ROOT,'package.json'));
const {PostProductionEngine} = vendorRequire(join(ROOT,'vendor/supermickey/hyperreality-system/engines/post-production-engine/post-production-engine.js'));
const {PostProductionPipeline} = await import(join(ROOT,'vendor/supermickey/systems/post-production-pipeline.js'));

test('旧vendor后期引擎：成功任务黑屏静音按实际片长生成工程，原声标志保留，诚实声明尚未渲染MP4',{timeout:45000},async(t)=>{
  const f=fixture(t);const engine=new PostProductionEngine({outputDir:join(f.root,'vendor-engine')});
  const result=await engine.postProduce({shots:[{shotId:'S1',duration:30}]},{blueprint:{}},{results:[{shotId:'S1',success:true,status:'done',taskId:'actual-issued-task',mock:false,videoPath:f.clip}]});
  assert.equal(result.success,true);assert.equal(result.artifactKind,'hyperframes-composition');assert.equal(result.mediaRendered,false);assert.equal(result.qualityReviewed,false);
  for(const version of Object.values(result.versions)){
    const html=readFileSync(version.htmlPath,'utf8');assert.doesNotMatch(html,/<video[^>]*\bmuted\b|src="[^"]+" muted/u);
    assert.match(html,/data-duration="1\./u);assert.equal(existsSync(join(dirname(version.htmlPath),'output.mp4')),false);
  }
  assertOriginal(f);
});

async function acceptedVendorFixture(t) {
  const f = fixture(t);
  const engine = new PostProductionEngine({ outputDir: join(f.root, 'vendor-bound'), versions: ['raw'] });
  const production = { shots: [{ shotId: 'S1', duration: 30 }] }, script = { blueprint: {} };
  const entry = { shotId: 'S1', success: true, status: 'done', taskId: 'actual-issued-task', mock: false, videoPath: f.clip };
  const registry = { results: [entry] };
  const first = await engine.postProduce(production, script, registry);
  assert.equal(first.success, true, JSON.stringify(first.errors));
  assert.equal(entry.currentBytes.sha256, f.oldClip);
  return { f, engine, production, script, entry, registry };
}

test('vendor已持久来源：同一成功任务当前字节不变可以复放，既有绑定保持',{timeout:45000},async(t)=>{
  const { f, engine, production, script, entry, registry } = await acceptedVendorFixture(t);
  const binding = structuredClone(entry.currentBytes);
  const result = await engine.postProduce(production, script, registry);
  assert.equal(result.success, true, JSON.stringify(result.errors));
  assert.deepEqual(entry.currentBytes, binding);
  assertOriginal(f);
});

test('vendor已持久来源：同一路径换成有效同画布视频必须失败，旧任务字节绑定不能覆写',{timeout:45000},async(t)=>{
  const { f, engine, production, script, entry, registry } = await acceptedVendorFixture(t);
  const binding = structuredClone(entry.currentBytes);
  media(['-f','lavfi','-i','color=c=blue:s=64x96:r=17:d=1.1','-an','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',f.clip]);
  const replacement = fileHash(f.clip);
  assert.notEqual(replacement, binding.sha256);
  const result = await engine.postProduce(production, script, registry);
  assert.equal(result.success, false);
  assert.match(JSON.stringify(result.errors), /POST_RENDER_CURRENT_BYTES_MISMATCH/);
  assert.deepEqual(result.versions, {});
  assert.deepEqual(entry.currentBytes, binding);
  assert.equal(fileHash(f.clip), replacement);
  assert.equal(readFileSync(f.network, 'utf8'), '');
});

test('vendor已持久来源：旧任务号不能换成另一个成功任务冒用同一文件',{timeout:45000},async(t)=>{
  const { f, engine, production, script, entry, registry } = await acceptedVendorFixture(t);
  const binding = structuredClone(entry.currentBytes);
  entry.taskId = 'another-successful-task';
  const result = await engine.postProduce(production, script, registry);
  assert.equal(result.success, false);
  assert.match(JSON.stringify(result.errors), /POST_RENDER_CURRENT_BYTES_MISMATCH/);
  assert.deepEqual(entry.currentBytes, binding);
  assertOriginal(f);
});

test('vendor已持久来源：显式空、残缺及路径、大小、镜号不符绑定不得降级为首次接受',{timeout:45000},async(t)=>{
  const { f, engine, production, script, entry, registry } = await acceptedVendorFixture(t);
  const binding = structuredClone(entry.currentBytes);
  for (const invalid of [null, {}, { ...binding, path: join(f.root, 'other.mp4') },
    { ...binding, bytes: binding.bytes + 1 }, { ...binding, sha256: 'not-a-sha' },
    { ...binding, shotId: 'S2' }, { ...binding, taskId: 'another-task' }]) {
    entry.currentBytes = structuredClone(invalid);
    const result = await engine.postProduce(production, script, registry);
    assert.equal(result.success, false, JSON.stringify({ invalid, result }));
    assert.match(JSON.stringify(result.errors), /POST_RENDER_CURRENT_BYTES_MISMATCH/);
    assert.deepEqual(result.versions, {});
    assert.deepEqual(entry.currentBytes, invalid);
  }
  assertOriginal(f);
});

for(const [name,entry] of [['provider-failed',{success:false,status:'failed',taskId:'task'}],['running',{success:true,status:'running',taskId:'task'}],
  ['simulated',{success:true,status:'done',taskId:'SIMULATED-task'}],['missing-task',{success:true,status:'done'}]])
  test(`旧vendor后期真实供应商失败关闭：${name}`,{timeout:45000},async(t)=>{
    const f=fixture(t);const engine=new PostProductionEngine({outputDir:join(f.root,'vendor-failed')});
    const result=await engine.postProduce({shots:[{shotId:'S1',duration:30}]},{blueprint:{}},{results:[{shotId:'S1',videoPath:f.clip,...entry}]});
    assert.equal(result.success,false);assert.match(JSON.stringify(result.errors),/POST_RENDER_PROVIDER_SUCCESS_REQUIRED/);assert.deepEqual(result.versions,{});assertOriginal(f);
  });

test('旧vendor本地合成：静音低分辨率镜头实作规范化与MP4导出，显式标题另存原片只读',{timeout:60000},async(t)=>{
  const f=fixture(t);const pipeline=new PostProductionPipeline({outputWidth:320,outputHeight:180,titleFont:join(ROOT,'bundles/ai-video/library/fonts/en/Inter-Variable.ttf')});
  const result=await pipeline.produce([{id:'S1',duration:30,isOpening:true}],{shotsDir:f.clips,finalDir:join(f.root,'vendor-mp4'),title:'独立成片',titleConfig:{mainTitle:"Actual : 'title'",producer:'fixture'}});
  assert.equal(result.success,true);assert.equal(result.artifactKind,'rendered-media');assert.equal(result.qualityReviewed,false);assert.equal(result.qualityScore,null);
  assert.equal(fileHash(result.cleanFile),result.sha256);assert.equal(result.resolution,'320x180');assert.equal(fileHash(f.clip),f.oldClip);
});

test('旧vendor本地合成不吞缺片/解码故障或提交失败，也不据名义30秒拒绝真实素材',{timeout:45000},async(t)=>{
  const f=fixture(t);const pipeline=new PostProductionPipeline({outputWidth:320,outputHeight:180});
  await assert.rejects(pipeline.produce([{id:'S2',duration:30}],{shotsDir:f.clips,finalDir:join(f.root,'missing')}));
  await assert.rejects(pipeline.produce([{id:'S1',providerStatus:'failed'}],{shotsDir:f.clips,finalDir:join(f.root,'provider')}),/POST_PROVIDER_FAILED/);
  assert.equal(fileHash(f.clip),f.oldClip);
});

test('真实宿主post-production入口服务任务完整才接收，HTML工程报告不能冒充MP4',{timeout:60000},(t)=>{
  const f=fixture(t);const runDir=join(f.root,'host');mkdirSync(runDir);
  writeFileSync(join(runDir,'result.json'),JSON.stringify({stages:{productionEngine:{shots:[{shotId:'S1',duration:30}]},scriptEngine:{blueprint:{}}}}));
  const summary=join(runDir,'render-summary.json');writeFileSync(summary,JSON.stringify({mode:'service-production',projectId:f.project,status:'done',sourceStageRunId:'pre-run',sourceAttempt:1,
    shots:[{shotId:'S1',status:'done',mock:false,taskId:'actual-issued-task',jobId:'actual-job',assetId:'actual-asset',localPath:f.clip,promptSha256:fileHash(f.prompt),sourceStageRunId:'pre-run',sourceAttempt:1,seconds:30}]}));
  const args=['--import','tsx',join(ROOT,'scripts/tools/post-production.mts'),'--run',runDir,'--render-summary',summary,'--out',join(f.root,'host-post')];
  const result=spawnSync(process.execPath,args,{cwd:ROOT,env:f.env,encoding:'utf8',timeout:45000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const report=JSON.parse(readFileSync(join(f.root,'host-post','post-report.json')));assert.equal(report.success,true);assert.equal(report.mediaRendered,false);assert.equal(report.qualityReviewed,false);
  assert.match(readFileSync(join(f.root,'host-post','post-report.md'),'utf8'), /文件及引用处理检查：pass/);
  assert.equal(report.sourceReceipts[0].artifact.sha256,f.oldClip);assertOriginal(f);
  const doc=JSON.parse(readFileSync(summary));doc.shots[0].status='failed';writeFileSync(summary,JSON.stringify(doc));
  const failed=spawnSync(process.execPath,args,{cwd:ROOT,env:f.env,encoding:'utf8',timeout:45000});assert.notEqual(failed.status,0);assert.match(failed.stderr,/POST_RENDER_SHOT_RECEIPT_INVALID/);
  assert.equal(fileHash(f.clip),f.oldClip);assert.equal(readFileSync(f.network,'utf8'),'');
});

function hostBoundFixture(t) {
  const f = fixture(t), runDir = join(f.root, 'host-bound');
  mkdirSync(runDir);
  writeFileSync(join(runDir, 'result.json'), JSON.stringify({ stages: {
    productionEngine: { shots: [{ shotId: 'S1', duration: 30 }] }, scriptEngine: { blueprint: {} },
  } }));
  const summary = join(runDir, 'render-summary.json');
  writeFileSync(summary, JSON.stringify({ mode: 'service-production', projectId: f.project, status: 'done',
    sourceStageRunId: 'pre-run', sourceAttempt: 1, shots: [{ shotId: 'S1', status: 'done', mock: false,
      taskId: 'actual-issued-task', jobId: 'actual-job', assetId: 'actual-asset', localPath: f.clip,
      promptSha256: fileHash(f.prompt), sourceStageRunId: 'pre-run', sourceAttempt: 1, seconds: 30 }] }));
  const out = join(f.root, 'host-bound-post');
  const invoke = (destination = out) => spawnSync(process.execPath, ['--import', 'tsx',
    join(ROOT, 'scripts/tools/post-production.mts'), '--run', runDir, '--render-summary', summary, '--out', destination],
  { cwd: ROOT, env: f.env, encoding: 'utf8', timeout: 45000 });
  const first = invoke();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const report = join(out, 'post-report.json');
  const receiptName = readdirSync(runDir).find((name) => /^rendered-source-acceptance-[a-f0-9]{64}\.json$/.test(name));
  assert.ok(receiptName, '真实首次接受须固定在run作用域，不依赖输出目录');
  const receiptFile = join(runDir, receiptName);
  return { f, runDir, summary, out, report, receiptFile, invoke };
}

test('真实宿主持久来源：同summary同任务字节保持可复放，新输出目录也沿用原接受',{timeout:60000},(t)=>{
  const x = hostBoundFixture(t), old = JSON.parse(readFileSync(x.report)).sourceReceipts;
  const result = x.invoke(join(x.f.root, 'another-engineering-output'));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const current = JSON.parse(readFileSync(join(x.f.root, 'another-engineering-output', 'post-report.json')));
  assert.deepEqual(current.sourceReceipts, old);
  assertOriginal(x.f);
});

test('真实宿主持久来源：同summary同任务替换有效视频不能重新铸造接受，旧报告与新目录保持',{timeout:60000},(t)=>{
  const x = hostBoundFixture(t), oldReport = readFileSync(x.report), oldSummary = fileHash(x.summary);
  media(['-f','lavfi','-i','color=c=blue:s=64x96:r=17:d=1.1','-an','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',x.f.clip]);
  const replacement = fileHash(x.f.clip);
  for (const destination of [x.out, join(x.f.root, 'bypass-output')]) {
    const result = x.invoke(destination);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /POST_RENDER_PERSISTED_SOURCE_MISMATCH/);
    assert.deepEqual(readFileSync(x.report), oldReport);
  }
  assert.equal(existsSync(join(x.f.root, 'bypass-output')), false);
  assert.equal(fileHash(x.summary), oldSummary);
  assert.equal(fileHash(x.f.clip), replacement);
  assert.equal(readFileSync(x.f.network, 'utf8'), '');
});

test('真实宿主持久来源：残缺或篡改已有回执明确失败，不覆盖旧报告或刷新为当前字节',{timeout:60000},(t)=>{
  const x = hostBoundFixture(t), original = JSON.parse(readFileSync(x.receiptFile)), report = readFileSync(x.report);
  for (const invalid of [null, {}, { ...original, sourceReceipts: [] }, { ...original, scope: {} },
    { ...original, sourceReceipts: [{ ...original.sourceReceipts[0], taskId: 'another-task' }] },
    { ...original, sourceReceipts: [{ ...original.sourceReceipts[0], artifact: { ...original.sourceReceipts[0].artifact, bytes: 1 } }] }]) {
    const bytes = Buffer.from(JSON.stringify(invalid));
    writeFileSync(x.receiptFile, bytes);
    const result = x.invoke();
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /POST_RENDER_PERSISTED_SOURCE_MISMATCH/);
    assert.deepEqual(readFileSync(x.receiptFile), bytes);
    assert.deepEqual(readFileSync(x.report), report);
  }
  assertOriginal(x.f);
});

test('真实宿主持久来源：已有历史post-report也要对当前字节，不能在固定回执缺失时重新铸造',{timeout:60000},(t)=>{
  const x = hostBoundFixture(t), report = readFileSync(x.report);
  rmSync(x.receiptFile);
  media(['-f','lavfi','-i','color=c=blue:s=64x96:r=17:d=1.1','-an','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',x.f.clip]);
  const current = fileHash(x.f.clip), result = x.invoke();
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /POST_RENDER_PERSISTED_SOURCE_MISMATCH/);
  assert.deepEqual(readFileSync(x.report), report);
  assert.equal(existsSync(x.receiptFile), false);
  assert.equal(fileHash(x.f.clip), current);
  assert.equal(readFileSync(x.f.network, 'utf8'), '');
});

test('真实宿主原制作镜号重复或缺项不能与完成任务数组按数量匹配',{timeout:60000},(t)=>{
  for (const [name, sourceIds] of [['duplicate', ['S1', 'S1']], ['missing', ['S1', 'S3']]]) {
    const f = fixture(t), runDir = join(f.root, `host-scope-${name}`), out = join(f.root, 'host-scope-output');
    mkdirSync(runDir);
    writeFileSync(join(runDir, 'result.json'), JSON.stringify({ stages: {
      productionEngine: { shots: sourceIds.map((shotId) => ({ shotId, duration: 30 })) }, scriptEngine: { blueprint: {} },
    } }));
    const summary = join(runDir, 'render-summary.json');
    writeFileSync(summary, JSON.stringify({ mode: 'service-production', projectId: f.project, status: 'done',
      sourceStageRunId: 'pre-run', sourceAttempt: 1, shots: ['S1', 'S2'].map((shotId) => ({ shotId,
        status: 'done', mock: false, taskId: `actual-issued-${shotId}`, jobId: `job-${shotId}`, assetId: `asset-${shotId}`,
        localPath: f.clip, promptSha256: fileHash(f.prompt), sourceStageRunId: 'pre-run', sourceAttempt: 1, seconds: 30,
      })) }));
    f.lastArgs = ['--import', 'tsx', join(ROOT, 'scripts/tools/post-production.mts'), '--run', runDir,
      '--render-summary', summary, '--out', out];
    const result = spawnSync(process.execPath, f.lastArgs, { cwd: ROOT, env: f.env, encoding: 'utf8', timeout: 45000 });
    writeFileSync(join(f.root, 'stdout.log'), result.stdout || ''); writeFileSync(join(f.root, 'stderr.log'), result.stderr || '');
    preserve(f, result, `host-original-scope-${name}`);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /POST_RENDER_SHOT_SCOPE_MISMATCH/);
    assert.equal(existsSync(out), false);
    assert.equal(readdirSync(runDir).some((entry) => entry.startsWith('rendered-source-acceptance-')), false);
    assertOriginal(f);
  }
});
