import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { callTool, parseAssEvents, plan, renderSticker } from '../../bundles/ai-video/connectors/subtitle-bridge/core.mjs';

const ROOT = resolve(import.meta.dirname, '../..'), CLI = join(ROOT, 'scripts/tools/full-chain-film.mts');
const FFMPEG = process.env.WL_FFMPEG || process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.WL_FFPROBE || process.env.FFPROBE_PATH || 'ffprobe';
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const invoke = (args, env = {}) => spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
  cwd: ROOT, env: { ...process.env, WL_FFMPEG: FFMPEG, WL_FFPROBE: FFPROBE,
    PATH: `${dirname(process.execPath)}:${process.env.PATH || ''}`, ...env },
  encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
});
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const walk = dir => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const file = join(dir, entry.name); return entry.isDirectory() ? walk(file) : [file];
}) : [];

test('persistent fullchain rejects missing, duplicate, malformed and title/intro conflicts before any output or source read', t => {
  const root = mkdtempSync(join(tmpdir(), 'persistent-early-guard-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const out = join(root, 'output'), work = join(root, 'work');
  for (const [extra, expected] of [
    [['--subtitle-persistent-text'], /PERSISTENT_SUBTITLE_TEXT_REQUIRED/],
    [['--subtitle-persistent-text=文字'], /PERSISTENT_SUBTITLE_TEXT_REQUIRED/],
    [['--subtitle-persistent-text', ' '], /bad_request|持续字幕/],
    [['--subtitle-persistent-text', 'x\ny'], /bad_request|持续字幕/],
    [['--subtitle-persistent-text', 'x'.repeat(121)], /bad_request|持续字幕/],
    [['--subtitle-persistent-text', '文字', '--subtitle-persistent-text', '重复'], /PERSISTENT_SUBTITLE_OPTION_DUPLICATE/],
    [['--subtitle-persistent-text', '文字'], /PERSISTENT_SUBTITLE_TITLE_CONFLICT/],
    [['--subtitle-persistent-text', '文字', '--no-title-card', '--no-open-with-cover', '--opening-title', '装饰'], /PERSISTENT_SUBTITLE_TITLE_CONFLICT/],
    [['--subtitle-persistent-style-json'], /PERSISTENT_SUBTITLE_STYLE_REQUIRED/],
    [['--subtitle-persistent-style-json', '{"outlinePx":2,"sideMarginPx":65}'], /持续字幕样式/],
    [['--subtitle-persistent-text', '文字', '--subtitle-persistent-style-json', '{"outlinePx":2,"sideMarginPx":65,"alignment":2}'], /持续字幕样式/],
    [['--subtitle-persistent-text', '文字', '--subtitle-persistent-anchor', 'bottom-center', '--subtitle-persistent-style-json', '{"outlinePx":2,"sideMarginPx":65}'], /不能与底部版式共用/],
    [['--subtitle-persistent-text', '文字', '--subtitle-persistent-anchor', 'bottom-center', '--subtitle-persistent-style-json', '{"fontSizePx":58.5}'], /持续字幕样式/],
    [['--subtitle-persistent-text', '文字', '--subtitle-persistent-anchor', 'bottom-center', '--subtitle-persistent-style-json', '{"fontSizePx":58,"alignment":2}'], /持续字幕样式/],
    [['--subtitle-persistent-text', '文字', '--subtitle-persistent-style-json', '{"fontSizePx":58}'], /持续字幕样式/],
  ]) {
    const result = invoke(['--shots', join(root, 'unread-source.json'), '--out', out, '--work-dir', work, ...extra]);
    assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, expected);
    assert.equal(existsSync(work), false); assert.equal(existsSync(out), false);
  }
});

test('persistent text may coexist with a silent cover intro; only the title-card conflict remains', t => {
  const root = mkdtempSync(join(tmpdir(), 'persistent-cover-intro-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = invoke(['--shots', join(root, 'missing-source.json'), '--out', join(root, 'out'), '--work-dir', join(root, 'work'),
    '--subtitle-persistent-text', '文字', '--no-title-card']);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /PERSISTENT_SUBTITLE_INTRO_CONFLICT/);
});

test('persistent fullchain requires its subtitle consumer before creating work or output directories', t => {
  const root = mkdtempSync(join(tmpdir(), 'persistent-stage-guard-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const shots = join(root, 'shots.json'), work = join(root, 'work'), out = join(root, 'out');
  writeFileSync(shots, JSON.stringify({ title: '真实需求', durationSeconds: 1, aspect: '9:16', resolution: '720p',
    shots: [{ shotId: 'S1', duration: 1, dialogue: [] }] }));
  const original = sha(shots);
  const result = invoke(['--shots', shots, '--out', out, '--work-dir', work, '--stages', 'compose,master',
    '--subtitle-persistent-text', '持续文字', '--no-title-card', '--no-open-with-cover']);
  assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /PERSISTENT_SUBTITLE_STAGE_REQUIRED/);
  assert.equal(existsSync(work), false); assert.equal(existsSync(out), false); assert.equal(sha(shots), original);
});

function fixture(t, { dialogue = [{ speaker: '原片人物', text: '保留原片全部台词' }], hasPriorHistory = true, resolution = '720p', duration = 1.4, colour = 'black' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'persistent 正式全链-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = 'PERSISTENT-OFFLINE', work = join(root, 'work'), out = join(root, 'out');
  const logs = join(work, 'logs', project), clips = join(work, 'clips', project);
  for (const dir of [logs, clips]) mkdirSync(dir, { recursive: true });
  const clip = join(clips, 'S1.mp4'), prompt = join(root, 'issued-prompt.txt'), shots = join(root, 'shots.json'), keys = join(root, 'empty.env');
  const dimensions = resolution === '1080p' ? '1080x1920' : '360x640';
  const media = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-n', '-f', 'lavfi', '-i', `color=c=${colour}:s=${dimensions}:r=25:d=${duration}`,
    '-f', 'lavfi', '-i', `sine=frequency=417:sample_rate=48000:duration=${duration}`, '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip], { encoding: 'utf8', timeout: 30000 });
  assert.equal(media.status, 0, media.stderr);
  writeFileSync(prompt, 'Already issued provider prompt; immutable in all postprocessing tests.'); writeFileSync(keys, '');
  writeFileSync(shots, JSON.stringify({ title: '完整作品', durationSeconds: duration, aspect: '9:16', resolution,
    eraProfile: { storyDate: '2026-10-07' }, shots: [{ shotId: 'S1', duration,
      dialogue, motion: '既有动作', scene: '既有场景' }] }));
  const network = join(root, 'network.log'), preloader = join(root, 'deny-network.cjs'); writeFileSync(network, '');
  writeFileSync(preloader, `const fs=require('node:fs');const deny=k=>{fs.appendFileSync(${JSON.stringify(network)},k+'\\n');throw new Error('OFFLINE_NETWORK_FORBIDDEN:'+k)};globalThis.fetch=()=>deny('fetch');for(const n of ['node:http','node:https']){const m=require(n);m.request=()=>deny(n+'.request');m.get=()=>deny(n+'.get')};
    if(process.env.WORKLOOM_TEST_TAMPER_PERSISTENT_PROOF==='1'){const write=fs.writeFileSync;fs.writeFileSync=function(file,data,...options){if(String(file).includes('processor-')&&String(file).endsWith('.json')){const doc=JSON.parse(String(data));const proof=doc.manifest?.persistentText??doc.persistentText;if(proof){proof.assText='not the requested text';data=JSON.stringify(doc)}}return write.call(this,file,data,...options)}}`);
  const env = { NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(preloader)}`,
    WORKLOOM_BGM_DISCOVER: '0', WORKLOOM_COLOR_CACHE_DIR: join(root, 'color-cache'), WORKLOOM_SUBTITLE_CACHE_DIR: join(root, 'subtitle-cache') };
  const setupCode = `import fs from 'node:fs';import path from 'node:path';
    import {loadOrCreateFilmAuthorContext} from './packages/video-studio/src/film-contracts.ts';
    import {createLineageReceipt,productionHash} from './packages/video-studio/src/production-lineage.ts';
    const x=JSON.parse(process.argv[1]),doc=JSON.parse(fs.readFileSync(x.shots));
    const author=loadOrCreateFilmAuthorContext({path:path.join(x.logs,'project-context.json'),projectId:x.project,eraProfile:doc.eraProfile});
    const {shots,durationSeconds,...common}=doc;const sourceHash=productionHash({source:{...common,shot:shots[0]},brief:null,sceneBible:null,eraProfile:author.eraProfile,aspect:'9:16',resolution:doc.resolution,fps:30});
    const lineage=createLineageReceipt({projectId:x.project,sourceHash,runId:'issued-source-run',stage:'shot',shotId:'S1',recipe:{component:'issued-source'},status:'failed',inputs:[x.prompt],outputs:[x.clip]});
    fs.writeFileSync(path.join(x.logs,'stages.jsonl'),JSON.stringify({at:'2026-10-01T00:00:00.000Z',stage:'shot',shotId:'S1',invoked:true,ok:false,cached:false,degraded:false,artifact:x.clip,verdict:{approved:false,reason:'historical quality judgment'},evidence:{taskId:'issued-task-offline-fixture',qualityScore:1},lineage})+'\\n');`;
  const history = join(logs, 'stages.jsonl');
  if (hasPriorHistory) {
    const setup = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', setupCode,
      JSON.stringify({ shots, logs, project, prompt, clip })], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
    assert.equal(setup.status, 0, setup.stderr);
  } else writeFileSync(history, '');
  return { root, work, out, logs, project, clip, prompt, shots, keys, network, env, history, resolution,
    originals: [clip, prompt, shots].map(file => ({ file, sha256: sha(file) })), oldHistory: readFileSync(history) };
}
function run(f, text, env = {}, { stages = "compose,subtitle,master", postOnly = false, anchor, style } = {}) {
  return invoke(['--shots', f.shots, '--project', f.project, '--work-dir', f.work, '--out', f.out, '--keys-file', f.keys,
    '--resolution', f.resolution, '--route-kind', 'narrative', '--stages', stages, '--xfade', '0', '--cut-transition', '',
    '--subtitle-mode', 'both', '--no-open-with-cover', '--no-title-card', '--no-danmaku', '--no-bgm',
    ...(postOnly ? ['--assembly-mode', 'post-only', '--assembly-reason', '已有原片完成本地后期'] : []),
    ...(text === null ? [] : ['--subtitle-persistent-text', text]),
    ...(anchor === undefined ? [] : ['--subtitle-persistent-anchor', anchor]),
    ...(style === undefined ? [] : ['--subtitle-persistent-style-json', JSON.stringify(style)])], { ...f.env, ...env });
}
function originals(f) {
  for (const item of f.originals) assert.equal(sha(item.file), item.sha256, item.file);
  assert.ok(readFileSync(f.history).subarray(0, f.oldHistory.length).equals(f.oldHistory));
  assert.equal(readFileSync(f.network, 'utf8'), '');
  assert.equal(walk(f.root).filter(file => /(?:asr|tts|voiced)(?:[.-]|\/)/i.test(file)).length, 0);
}

test('persistent fullchain publishes real burn and complete ASS, binds actual clock, and invalidates changed text lineage without model calls', { timeout: 180000 }, t => {
  const f = fixture(t), baseline = run(f, null);
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr); originals(f);
  const defaultSrt = readFileSync(join(f.work, 'post', f.project, 'subtitle.srt'));
  const defaultSidecarDir = join(f.work, 'post', f.project, 'subtitles');
  const defaultSidecars = ['.zh.srt', '.vtt'].map(suffix => ({ suffix, bytes: readFileSync(join(defaultSidecarDir, f.project + suffix)) }));
  const first = run(f, '赛道专用 不可上路');
  assert.equal(first.status, 0, first.stdout + first.stderr); originals(f);
  const pointer = readJson(join(f.out, 'current.json')), manifest = readJson(pointer.manifest);
  const proof = manifest.subtitles.persistentText;
  assert.equal(proof.text, '赛道专用 不可上路'); assert.equal(proof.startSeconds, 0); assert.equal(proof.readback, true);
  assert.equal(manifest.subtitles.portableSidecars, 'dialogue-only'); assert.ok(existsSync(manifest.deliverable.path));
  const ass = readFileSync(manifest.subtitles.compositionAss, 'utf8'), event = parseAssEvents(ass).filter(event => event.style === 'Title');
  assert.equal(event.length, 1); assert.equal(event[0].text, proof.assText); assert.equal(event[0].end, proof.end);
  assert.equal(sha(manifest.subtitles.compositionAss), proof.assSha256);
  assert.ok(proof.endSeconds >= proof.videoDuration && proof.endSeconds <= proof.videoDuration + .01 + 1e-9);
  assert.deepEqual(readFileSync(join(f.work, 'post', f.project, 'subtitle.srt')), defaultSrt);
  for (const sidecar of defaultSidecars) assert.deepEqual(readFileSync(join(dirname(manifest.subtitles.compositionAss), f.project + sidecar.suffix)), sidecar.bytes);
  const rows = () => readFileSync(f.history, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const firstRow = rows().filter(row => row.stage === 'subtitle' && row.evidence?.mode === 'burn').at(-1);
  assert.equal(firstRow.evidence.persistentMatchesSidecar, true);
  const second = run(f, '另一条持续文字'); assert.equal(second.status, 0, second.stdout + second.stderr); originals(f);
  const current = readJson(readJson(join(f.out, 'current.json')).manifest);
  assert.equal(current.subtitles.persistentText.text, '另一条持续文字');
  const secondRow = rows().filter(row => row.stage === 'subtitle' && row.evidence?.mode === 'burn').at(-1);
  assert.notEqual(secondRow.lineage.recipeHash, firstRow.lineage.recipeHash);
  assert.notEqual(secondRow.evidence.persistentText.compositionSha256, proof.compositionSha256);
  assert.equal(secondRow.cached, false);
});

test('persistent renderer failure or altered proof cannot publish a completion pointer or mutate source material', { timeout: 120000 }, t => {
  const f = fixture(t), impossible = join(f.root, 'missing-renderer');
  const result = run(f, '赛道专用 不可上路', { WORKLOOM_SUBTITLE_FFMPEG_PATH: impossible });
  assert.notEqual(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout + result.stderr, /SUBTITLE_SIDECAR_FAILED|ffmpeg|ENOENT/i);
  assert.equal(existsSync(join(f.out, 'current.json')), false); originals(f);
  const tampered = run(f, '赛道专用 不可上路', { WORKLOOM_TEST_TAMPER_PERSISTENT_PROOF: '1' });
  assert.notEqual(tampered.status, 0, tampered.stdout + tampered.stderr);
  assert.match(tampered.stdout + tampered.stderr, /SUBTITLE_SIDECAR_FAILED|persistent text readback/i);
  assert.equal(existsSync(join(f.out, 'current.json')), false); originals(f);
});

test('Film post-only burns and publishes exact persistent text with no dialogue, stale sidecars or provider calls', { timeout: 180000 }, t => {
  const f = fixture(t, { dialogue: [], hasPriorHistory: false });
  const staleDir = join(f.work, 'post', f.project, 'subtitles');
  mkdirSync(staleDir, { recursive: true });
  const stale = ['.zh.srt', '.en.srt', '.vtt', '.zh.ass'].map(suffix => join(staleDir, f.project + suffix));
  stale.push(join(f.work, 'post', f.project, 'subtitle.srt'));
  for (const file of stale) writeFileSync(file, 'historical dialogue should never be picked up');
  const text = 'AI剧情演绎｜封闭赛道';
  const result = run(f, text, {}, { postOnly: true });
  assert.equal(result.status, 0, result.stdout + result.stderr); originals(f);
  const pointer = readJson(join(f.out, 'current.json')), manifest = readJson(pointer.manifest);
  const assFile = manifest.subtitles.compositionAss, proof = manifest.subtitles.persistentText;
  assert.equal(manifest.subtitles.portableSidecars, 'not-applicable-no-dialogue');
  assert.equal(proof.text, text); assert.equal(proof.readback, true);
  assert.equal(proof.style.alignment, 8);
  assert.equal(proof.layout.safeArea, 'top-12-to-40-percent');
  assert.equal(proof.startSeconds, 0); assert.ok(proof.endSeconds >= proof.videoDuration && proof.endSeconds <= proof.videoDuration + .01 + 1e-9);
  const events = parseAssEvents(readFileSync(assFile, 'utf8'));
  assert.equal(events.length, 1); assert.equal(events[0].style, 'Title'); assert.equal(events[0].text, text);
  assert.equal(sha(assFile), proof.assSha256);
  assert.ok(manifest.assets.some(asset => asset.path === assFile));
  assert.ok(!manifest.assets.some(asset => /\.(srt|vtt)$/i.test(asset.path)));
  const sidecar = readJson(join(dirname(assFile), `${f.project}.subtitle-manifest.json`));
  assert.equal(sidecar.timeline.cues, 0); assert.equal(sidecar.timeline.readback.srt, null);
  assert.deepEqual(sidecar.files.map(file => file.format), ['ass']);
  const rows = readFileSync(f.history, 'utf8').trim().split('\n').map(JSON.parse);
  const burn = rows.filter(row => row.stage === 'subtitle' && row.evidence?.mode === 'burn').at(-1);
  assert.equal(burn.evidence.persistentMatchesSidecar, true);
  assert.equal(burn.evidence.srt, null);
  assert.ok(rows.some(row => row.stepKey === 'g-post-only-assembly' && row.degraded && row.evidence?.blocked?.includes('S1')));
  assert.ok(rows.some(row => row.stage === 'master' && row.ok));
  for (const file of stale) assert.equal(readFileSync(file, 'utf8'), 'historical dialogue should never be picked up');
  const actual = spawnSync(FFPROBE, ['-v', 'error', '-show_streams', '-of', 'json', manifest.deliverable.path], { encoding: 'utf8' });
  assert.equal(actual.status, 0, actual.stderr);
  const streams = JSON.parse(actual.stdout).streams;
  assert.ok(streams.some(stream => stream.codec_type === 'audio'));
  assert.ok(!streams.some(stream => stream.codec_type === 'subtitle'));
  // The input video is solid black. At the first, middle and last video frame,
  // the top safe-area crop must contain actual bright rendered text pixels.
  const v = streams.find(stream => stream.codec_type === 'video');
  for (const at of [0, Number(v.duration) / 2, Number(v.duration) - 1 / 30]) {
    const frame = spawnSync(FFMPEG, ['-v', 'error', '-ss', at.toFixed(6), '-i', manifest.deliverable.path,
      '-frames:v', '1', '-vf', 'crop=iw:ih*0.25:0:ih*0.12,format=gray', '-f', 'rawvideo', 'pipe:1'],
    { timeout: 20000, maxBuffer: 2_000_000 });
    assert.equal(frame.status, 0, frame.stderr.toString());
    assert.ok(frame.stdout.some(pixel => pixel >= 235), `persistent burn has no bright pixels at ${at}`);
  }
});

test('Film post-only burns and exports one bottom-centered persistent plan at the approved 1080p style bounds', { timeout: 180000 }, t => {
  const f = fixture(t, { dialogue: [], hasPriorHistory: false, resolution: '1080p' });
  const text = 'AI剧情演绎｜封闭赛道';
  const result = run(f, text, {}, { postOnly: true, anchor: 'bottom-center' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  originals(f);
  const manifest = readJson(readJson(join(f.out, 'current.json')).manifest);
  const { compositionAss, persistentText: proof } = manifest.subtitles;
  assert.equal(proof.layout.anchor, 'bottom-center');
  assert.equal(proof.layout.platform, '抖音/快手');
  assert.equal(proof.style.alignment, 2);
  assert.equal(proof.style.borderStyle, 1);
  assert.equal(proof.style.primaryColour, '&H00FFFFFF');
  assert.equal(proof.style.outlineColour, '&H00000000');
  assert.ok(proof.style.fontSize >= Math.ceil(1080 * 0.04));
  assert.ok(proof.style.marginL >= Math.ceil(1080 * 0.08) && proof.style.marginR >= Math.ceil(1080 * 0.08));
  assert.ok(proof.style.outline >= Math.ceil(proof.layout.ink.inkHeight * 0.12));
  const { x, y, w, h } = proof.layout.rect;
  assert.ok(x >= .08 && x + w <= .92 && Math.abs(x + w / 2 - .5) < .01);
  assert.ok(y >= .60 && y + h <= .88);
  assert.deepEqual(proof.layout.occlusionHits, []);
  assert.equal(sha(compositionAss), proof.assSha256);
  const sidecar = readJson(join(dirname(compositionAss), `${f.project}.subtitle-manifest.json`));
  assert.equal(sidecar.persistentText.compositionSha256, proof.compositionSha256);
  assert.equal(sidecar.persistentText.assSha256, proof.assSha256);
  assert.deepEqual(sidecar.layout.occlusionZones.map(zone => zone.id), ['right-rail', 'bottom-caption', 'top-follow']);
  assert.deepEqual(sidecar.files.map(file => file.format), ['ass']);
  const burn = readFileSync(f.history, 'utf8').trim().split('\n').map(JSON.parse)
    .filter(row => row.stage === 'subtitle' && row.evidence?.mode === 'burn').at(-1);
  assert.equal(burn.evidence.persistentMatchesSidecar, true);
  const streams = JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-show_streams', '-of', 'json', manifest.deliverable.path],
    { encoding: 'utf8' }).stdout).streams;
  const video = streams.find(stream => stream.codec_type === 'video');
  assert.deepEqual([video.width, video.height], [1080, 1920]);
  assert.ok(streams.some(stream => stream.codec_type === 'audio'));
  for (const at of [0, Number(video.duration) / 2, Number(video.duration) - 1 / 30]) {
    const frame = spawnSync(FFMPEG, ['-v', 'error', '-ss', at.toFixed(6), '-i', manifest.deliverable.path,
      '-frames:v', '1', '-vf', 'crop=iw:ih*0.22:0:ih*0.64,format=gray', '-f', 'rawvideo', 'pipe:1'],
    { timeout: 20000, maxBuffer: 2_000_000 });
    assert.equal(frame.status, 0, frame.stderr.toString());
    assert.ok(frame.stdout.some(pixel => pixel >= 235), `bottom persistent burn has no bright pixels at ${at}`);
  }
});

test('Film refuses invalid persistent anchors or conflicting lower text before publishing', { timeout: 120000 }, t => {
  const f = fixture(t, { hasPriorHistory: false });
  for (const [text, anchor, expected] of [
    [null, 'bottom-center', /持续字幕锚点需要持续文字/u],
    ['文字', 'bottom-right', /持续字幕锚点仅支持/u],
    ['文字', 'bottom-center', /PERSISTENT_BOTTOM_ANCHOR_REQUIRES_PERSISTENT_ONLY/u],
  ]) {
    const result = run(f, text, {}, { postOnly: true, anchor });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, expected);
    assert.equal(existsSync(join(f.out, 'current.json')), false);
    originals(f);
  }
});

test('native Film lower persistent font has exact source-sized glyphs and a visibly translucent black backdrop', { timeout: 180000 }, t => {
  const f = fixture(t, { dialogue: [], hasPriorHistory: false, resolution: '1080p', colour: '0x8080c0' });
  const result = run(f, 'AI剧情演绎｜封闭赛道', {}, { postOnly: true, anchor: 'bottom-center', style: { fontSizePx: 58 } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  originals(f);
  const manifest = readJson(readJson(join(f.out, 'current.json')).manifest);
  const proof = manifest.subtitles.persistentText;
  assert.equal(proof.style.fontSize, 58);
  assert.equal(proof.style.alignment, 2);
  assert.equal(proof.style.borderStyle, 3);
  assert.equal(proof.style.primaryColour, '&H00FFFFFF');
  assert.equal(proof.style.outlineColour, '&H80000000');
  assert.equal(proof.style.backColour, '&H80000000');
  assert.equal(proof.layout.anchor, 'bottom-center');
  assert.equal(proof.layout.platform, '抖音/快手');
  assert.deepEqual(proof.layout.occlusionHits, []);
  assert.ok(proof.style.marginL >= Math.ceil(1080 * .06) && proof.style.marginR >= Math.ceil(1080 * .06));
  const { x, y, w, h } = proof.layout.rect;
  assert.ok(x >= .08 && x + w <= .92 && y >= .60 && y + h <= .88);
  const ass = manifest.subtitles.compositionAss;
  assert.equal(sha(ass), proof.assSha256);
  assert.equal(parseAssEvents(readFileSync(ass, 'utf8')).length, 1);
  const sidecar = readJson(join(dirname(ass), `${f.project}.subtitle-manifest.json`));
  assert.equal(sidecar.persistentText.compositionSha256, proof.compositionSha256);
  assert.equal(sidecar.persistentText.assSha256, proof.assSha256);
  const crop = `crop=${Math.ceil(w * 1080)}:${Math.ceil(h * 1920)}:${Math.floor(x * 1080)}:${Math.floor(y * 1920)}:exact=1,format=rgb24`;
  const frame = spawnSync(FFMPEG, ['-v', 'error', '-i', manifest.deliverable.path, '-frames:v', '1', '-vf', crop,
    '-f', 'rawvideo', 'pipe:1'], { timeout: 20000, maxBuffer: 2_000_000 });
  assert.equal(frame.status, 0, frame.stderr.toString());
  let transmitted = 0, white = 0;
  for (let index = 0; index < frame.stdout.length; index += 3) {
    const [r, g, b] = frame.stdout.subarray(index, index + 3);
    if (r >= 48 && r <= 85 && g >= 48 && g <= 85 && b >= 72 && b <= 120) transmitted++;
    if (r >= 230 && g >= 230 && b >= 230) white++;
  }
  assert.ok(transmitted > 500, `translucent backdrop transmission missing (${transmitted})`);
  assert.ok(white > 100, `visible white glyphs missing (${white})`);
});

test('native lower font option stays bounded by the actual portrait and measured platform exclusions', { timeout: 120000 }, async t => {
  const f = fixture(t, { dialogue: [], hasPriorHistory: false, resolution: '1080p' });
  const fontsDir = join(ROOT, 'bundles/ai-video/library/fonts'), bins = { ffmpeg: FFMPEG, ffprobe: FFPROBE };
  const input = { input_path: f.clip, output_dir: join(f.root, 'lower-tool'), platform: '抖音',
    persistent_text: 'AI剧情演绎｜封闭赛道', persistent_anchor: 'bottom-center', persistent_style: { fontSizePx: 58 } };
  const env = { ...process.env, WORKLOOM_SUBTITLE_ALLOWED_ROOTS: f.root, WORKLOOM_SUBTITLE_FONTS_DIR: fontsDir };
  const actual = await callTool('subtitlewrite.plan', input, { bins, env });
  assert.equal(actual.result.plan.persistentText.style.fontSize, 58);
  assert.equal(actual.result.plan.persistentText.style.borderStyle, 3);
  assert.equal(actual.result.plan.persistentText.layout.contrast, 'white-on-translucent-black-backdrop');
  for (const fontSizePx of [12, 116]) {
    await assert.rejects(plan({ input: f.clip, platform: '抖音', persistentText: input.persistent_text,
      persistentAnchor: 'bottom-center', persistentStyle: { fontSizePx }, fontsDir, bins,
      outputDir: join(f.root, `invalid-${fontSizePx}`) }), /实际画高的 2%–6%/u);
  }
  const catalog = readJson(join(ROOT, 'bundles/ai-video/library/font-catalog/font_db.json'));
  catalog.layout_policy['抖音/快手'].occlusion_zones.push({ id: 'fixture-lower-cover', x: .15, y: .75, w: .7, h: .13 });
  await assert.rejects(plan({ input: f.clip, persistentText: input.persistent_text,
    persistentAnchor: 'bottom-center', persistentStyle: { fontSizePx: 58 }, platform: '抖音',
    catalog, fontsDir, bins, outputDir: join(f.root, 'blocked-lower') }), /未能.*底部居中安全区/u);
  originals(f);
});

test('Film publishes one bounded two-pixel persistent style and exact same ASS for burn and sidecar', { timeout: 180000 }, t => {
  const f = fixture(t, { dialogue: [], hasPriorHistory: false, resolution: '1080p' });
  const style = { outlinePx: 2, sideMarginPx: 65 };
  const result = run(f, 'AI剧情演绎｜封闭赛道', {}, { postOnly: true, style });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  originals(f);
  const manifest = readJson(readJson(join(f.out, 'current.json')).manifest);
  const { compositionAss, persistentText: proof } = manifest.subtitles;
  assert.equal(proof.layout.anchor, 'top-center');
  assert.equal(proof.layout.platform, '抖音/快手');
  assert.deepEqual(proof.layout.occlusionHits, []);
  assert.equal(proof.style.outline, 2);
  assert.equal(proof.style.borderStyle, 1);
  assert.equal(proof.style.marginL, 65);
  assert.equal(proof.style.marginR, 65);
  assert.ok(proof.style.fontSize >= 44);
  assert.ok(proof.layout.rect.x >= 65 / 1080 && proof.layout.rect.x + proof.layout.rect.w <= 1 - 65 / 1080);
  assert.equal(sha(compositionAss), proof.assSha256);
  const sidecar = readJson(join(dirname(compositionAss), `${f.project}.subtitle-manifest.json`));
  assert.equal(sidecar.persistentText.assSha256, proof.assSha256);
  assert.equal(sidecar.persistentText.compositionSha256, proof.compositionSha256);
  assert.deepEqual(sidecar.layout.occlusionZones.map(zone => zone.id), ['right-rail', 'bottom-caption', 'top-follow']);
  const rows = readFileSync(f.history, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.find(row => row.stage === 'subtitle' && row.evidence?.mode === 'burn').evidence.persistentMatchesSidecar, true);
});

test('native sticker preserves an explicit two-pixel outline and full static font size at its first event frame', { timeout: 120000 }, async t => {
  const f = fixture(t, { dialogue: [], hasPriorHistory: false, resolution: '1080p', duration: 2.4 });
  const report = await renderSticker({ input: f.clip, output: join(f.root, 'title.mp4'), platform: '抖音/快手',
    evidenceDir: join(f.root, 'title'), stickers: [{ text: '张雪机车 820RR-RC', start: .4, end: 2.4,
      x: .47, y: .4, preset: '国风', scale: .72, outlinePx: 2, staticSize: true }] });
  originals(f);
  const text = readFileSync(report.assPath, 'utf8'), style = text.split('\n').find(line => line.startsWith('Style: ')).split(',');
  assert.equal(Number(style[2]), 54);
  assert.equal(Number(style[15]), 1);
  assert.equal(Number(style[16]), 2);
  assert.doesNotMatch(parseAssEvents(text)[0].text, /\\(?:fsc[xy]|t\()/u);
  assert.equal(sha(report.assPath), report.assSha256);
  assert.equal(report.checks.timeline_within_video, true);
  assert.deepEqual(report.placements[0].typography, { fontSizePx: 54, outlinePx: 2, staticSize: true });
  const frame = spawnSync(FFMPEG, ['-v', 'error', '-ss', '0.4', '-i', report.output.path,
    '-frames:v', '1', '-vf', 'crop=iw:ih*0.15:0:ih*0.32,format=gray', '-f', 'rawvideo', 'pipe:1'],
  { timeout: 20000, maxBuffer: 2_000_000 });
  assert.equal(frame.status, 0, frame.stderr.toString());
  assert.ok(frame.stdout.some(pixel => pixel >= 220));
});

test('native tool binds explicit top typography to its real platform and rejects bad options before writing', { timeout: 120000 }, async t => {
  const f = fixture(t, { dialogue: [], hasPriorHistory: false, resolution: '1080p' });
  const fontsDir = join(ROOT, 'bundles/ai-video/library/fonts');
  const bins = { ffmpeg: FFMPEG, ffprobe: FFPROBE };
  const env = { ...process.env, WORKLOOM_SUBTITLE_ALLOWED_ROOTS: f.root, WORKLOOM_SUBTITLE_FONTS_DIR: fontsDir };
  const input = { input_path: f.clip, output_dir: join(f.root, 'tool-top'), platform: '抖音',
    persistent_text: 'AI剧情演绎｜封闭赛道', persistent_style: { outlinePx: 2, sideMarginPx: 65 } };
  const result = await callTool('subtitlewrite.plan', input, { bins, env });
  assert.equal(result.result.plan.platform, '抖音/快手');
  assert.equal(result.result.plan.styles.find(style => style.name === 'Title').outline, 2);
  const blocked = join(f.root, 'blocked-style');
  await assert.rejects(callTool('subtitlewrite.plan', { ...input, output_dir: blocked,
    persistent_style: { outlinePx: 13, sideMarginPx: 65 } }, { bins, env }), /持续字幕样式/u);
  assert.equal(existsSync(blocked), false);
  const catalog = readJson(join(ROOT, 'bundles/ai-video/library/font-catalog/font_db.json'));
  catalog.layout_policy['抖音/快手'].occlusion_zones.push({ id: 'fixture-center-top', x: .35, y: .12, w: .30, h: .1 });
  await assert.rejects(plan({ input: f.clip, persistentText: input.persistent_text, persistentStyle: input.persistent_style,
    platform: '抖音', catalog, fontsDir, bins, outputDir: join(f.root, 'blocked-top-zone') }), /未能.*放入顶部安全区/u);
  originals(f);
});

test('native plan accepts the bottom anchor but rejects a real ink collision with a platform exclusion', { timeout: 120000 }, async t => {
  const f = fixture(t, { dialogue: [], hasPriorHistory: false });
  const fontsDir = join(ROOT, 'bundles/ai-video/library/fonts');
  const bins = { ffmpeg: FFMPEG, ffprobe: FFPROBE };
  const input = { input_path: f.clip, output_dir: join(f.root, 'tool-plan'), platform: '抖音',
    persistent_text: 'AI剧情演绎｜封闭赛道', persistent_anchor: 'bottom-center' };
  const tool = await callTool('subtitlewrite.plan', input, { bins,
    env: { ...process.env, WORKLOOM_SUBTITLE_ALLOWED_ROOTS: f.root, WORKLOOM_SUBTITLE_FONTS_DIR: fontsDir } });
  assert.equal(tool.result.plan.styles.find(style => style.name === 'Title').alignment, 2);
  assert.equal(tool.result.plan.platform, '抖音/快手');
  assert.ok(tool.result.checks.some(check => check.kind === 'persistent_text_layout' && check.ok));
  const catalog = readJson(join(ROOT, 'bundles/ai-video/library/font-catalog/font_db.json'));
  catalog.layout_policy['抖音/快手'].occlusion_zones.push({ id: 'fixture-center-bottom', x: .35, y: .60, w: .30, h: .28 });
  await assert.rejects(plan({ input: f.clip, persistentText: input.persistent_text, persistentAnchor: 'bottom-center',
    platform: '抖音', catalog, fontsDir, bins, outputDir: join(f.root, 'blocked-plan') }), /未能.*放入底部居中安全区/u);
  originals(f);
});

test('Film rejects an explicitly requested dialogue soft mux when only persistent text is present', { timeout: 120000 }, t => {
  const f = fixture(t, { dialogue: [], hasPriorHistory: false });
  const result = run(f, 'AI剧情演绎｜封闭赛道', {}, { stages: 'compose,subtitle,mux,master', postOnly: true });
  assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /PERSISTENT_ONLY_MUX_UNSUPPORTED/);
  assert.equal(existsSync(f.out), false); originals(f);
});
