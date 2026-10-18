import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, rmSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, win32, posix } from 'node:path';
import { installRhythmPostOverrides, rhythmBgmOverride, detectRhythmOnsets, prepareRhythmMusic, verifyRhythmMusic, verifyRhythmSubtitle, preflightRhythmTimeline, verifyRhythmExecution, rhythmPathIsWithin } from './lib/edit-rhythm-media.mts';
import { rhythmFileSha256 } from './rhythm-edit.mts';
import { compileRhythmDirection } from '../../packages/video-studio/src/edit/rhythm-director.js';
import { planAutoCaptions } from '../../packages/video-studio/src/edit/auto-plan.js';
import { inspectDeliveryManifest } from '../../bundles/ai-video/connectors/post-bridge/quality-gate.mjs';
import type { EditTimeline } from '../../packages/video-studio/src/edit/timeline.js';
import { validateEditTimeline } from '../../packages/video-studio/src/edit/timeline.js';
const root=resolve(import.meta.dirname,'../..');
test('override path through a symlinked ancestor cannot write outside owned output',t=>{
 const dir=mkdtempSync(join(tmpdir(),'rhythm path 中文-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const out=join(dir,'out'),outside=join(dir,'outside');mkdirSync(out);mkdirSync(outside);symlinkSync(outside,join(out,'alias'),'dir');
 const timeline={audioDesign:{bgm:{needed:false}}} as EditTimeline;
 assert.throws(()=>installRhythmPostOverrides({timeline,repoRoot:root,outDir:out,env:{WORKLOOM_POST_VARIANT_DIR:join(out,'alias','new')}}),/RHYTHM_OVERRIDE_PATH_ESCAPE/);
 assert.equal(existsSync(join(outside,'new')),false);
});
test('rhythm music overrides preserve an explicitly disabled variant and project-level no-music',()=>{
 assert.deepEqual(rhythmBgmOverride({enabled:false,policy:'preserve-program'},{noMusic:false,music:{trackId:'fixed-bed'}}),{enabled:false,policy:'preserve-program'});
 assert.deepEqual(rhythmBgmOverride({enabled:true,policy:'keep-dialogue'},{noMusic:true,music:null}),{enabled:false,policy:'keep-dialogue'});
 assert.deepEqual(rhythmBgmOverride({enabled:true,policy:'keep-dialogue',mood:'old'},{noMusic:false,music:{trackId:'fixed-bed'}}),{enabled:true,policy:'keep-dialogue',trackId:'fixed-bed',section:'full',bpmStrategy:'recipe',fadeInSec:0,fadeOutSec:0});
});

test('equal-strength real PCM pulses remain detected without a synthetic beat grid',()=>{
 const rate=8000,pcm=new Float32Array(rate*4),expected=[0.4,1.2,2,2.8];
 for(const at of expected)pcm.fill(0.5,Math.round(at*rate),Math.round((at+0.03)*rate));
 assert.deepEqual(detectRhythmOnsets(pcm),expected);
});
test('30-minute PCM, silence and malformed samples have bounded truthful behavior',()=>{
 const pcm=new Float32Array(8000*1800);pcm.fill(0.5,8000,8240);pcm.fill(0.5,8000*1799,8000*1799+240);
 assert.deepEqual(detectRhythmOnsets(pcm),[1,1799]);assert.deepEqual(detectRhythmOnsets(new Float32Array(8000)),[]);
 assert.throws(()=>detectRhythmOnsets(new Float32Array([NaN])),/RHYTHM_PCM_INVALID/);
});
test('path containment uses actual Windows and POSIX separators',()=>{
 for(const flavor of [win32,posix]){
  const root=flavor===win32?'C:\\work\\delivery':'/work/delivery';
  assert.equal(rhythmPathIsWithin(root,root,flavor),true);
  assert.equal(rhythmPathIsWithin(root,flavor.join(root,'work','new'),flavor),true);
  assert.equal(rhythmPathIsWithin(root,flavor.join(root,'..','library'),flavor),false);
  assert.equal(rhythmPathIsWithin(root,flavor.dirname(root),flavor),false);
 }
 assert.equal(rhythmPathIsWithin('C:\\work','D:\\work',win32),false);
 assert.equal(rhythmPathIsWithin('\\\\host\\share\\work','\\\\host\\share\\other',win32),false);
});

const write=(file:string,value:unknown)=>writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const read=(file:string)=>JSON.parse(readFileSync(file,'utf8'));
const ffmpeg=process.env.WL_FFMPEG??'ffmpeg',ffprobe=process.env.WL_FFPROBE??'ffprobe';
function run(file:string,args:string[],env:NodeJS.ProcessEnv=process.env){return spawnSync(file,args,{cwd:root,env,encoding:'utf8',timeout:600_000,maxBuffer:16*1024*1024});}
function cli(name:string,args:string[],env:NodeJS.ProcessEnv){return run(process.execPath,['--import','tsx',join(root,'scripts/tools',name),...args],env);}
function pulseWave(file:string){
 const rate=48000,count=rate*16,data=Buffer.alloc(44+count*2);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(rate,24);data.writeUInt32LE(rate*2,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(count*2,40);
 for(let i=0;i<count;i++){const phase=i%Math.round(rate*0.4),amp=phase<rate*0.04?Math.sin(2*Math.PI*880*i/rate)*0.8:0;data.writeInt16LE(Math.round(amp*32767),44+i*2);}writeFileSync(file,data);
}

test('clean and ordinary output cannot overlap an explicit or environment music library',async()=>{
 const base=mkdtempSync(join(tmpdir(),'rhythm owned fake library-'));
 try{
  const source=join(base,'source.mp4'),timelineFile=join(base,'timeline.json');
  const generated=run(ffmpeg,['-v','error','-nostdin','-n','-f','lavfi','-i','color=size=160x90:rate=30:duration=1','-c:v','libx264','-preset','ultrafast',source]);
  assert.equal(generated.status,0,generated.stderr);
  // The real input stays outside every fake library. A deliberate downscale error stops old code after its unsafe clean.
  write(timelineFile,{schemaVersion:'workloom.video-edit/edit-timeline/v2',timelineId:'library-clean-guard',target:{durationSeconds:1,aspectRatio:'16:9',fps:30,platform:'test'},sources:[{sourceId:'src',path:source,sha256:await rhythmFileSha256(source),fps:30,durationSeconds:1,hasAudio:false}],segments:[{seq:0,segmentId:'one',sourceId:'src',sourceIn:0,sourceOut:1,durationSeconds:1,speed:1,motive:'safe fixture'}],audioDesign:{originalAudioPolicy:'keep',bgm:{needed:false}}});
  for(const kind of ['same','ancestor','descendant','alias','new-alias-child','env-library','env-home','ordinary'] as const){
   const area=join(base,kind),library=join(area,'library'),marker=join(library,'keep.wav');mkdirSync(library,{recursive:true});writeFileSync(marker,'owned fixture: preserve every byte');
   let output=library;const env={...process.env,WORKLOOM_BGM_DISCOVER:'0'};delete env.WORKLOOM_POST_VARIANT_DIR;
   let pack=library;
   if(kind==='ancestor')output=area;
   if(kind==='descendant'){output=join(library,'existing');mkdirSync(output);writeFileSync(join(output,'keep.txt'),'keep nested');}
   if(kind==='alias'||kind==='new-alias-child'){const alias=join(area,'alias');symlinkSync(library,alias,'dir');output=kind==='alias'?alias:join(alias,'new-output');}
   if(kind==='env-library'){env.WORKLOOM_BGM_LIBRARY_DIR=library;pack=join(area,'other-pack');}
   if(kind==='env-home'){env.WORKLOOM_BGM_HOME=area;pack=join(base,'other-pack');}
   const before=readdirSync(library).sort();const result=cli('edit-post.mts',['--timeline',timelineFile,'--out-dir',output,'--bgm-pack',pack,...(kind==='ordinary'?[]:['--clean']),'--width','1','--height','1'],env);
   assert.equal(existsSync(marker),true,kind+': input music was deleted before output rejection');
   assert.notEqual(result.status,0,kind);assert.match(result.stderr,/RHYTHM_OUTPUT_MUSIC_ALIAS/,kind+': '+result.stderr);
   assert.equal(readFileSync(marker,'utf8'),'owned fixture: preserve every byte',kind);assert.deepEqual(readdirSync(library).sort(),before,kind);
   if(kind==='descendant')assert.equal(readFileSync(join(output,'keep.txt'),'utf8'),'keep nested');
  }
 }finally{rmSync(base,{recursive:true,force:true});}
});

test('auto and rhythm reject protected or occupied outputs before creating artifacts',()=>{
 const base=mkdtempSync(join(tmpdir(),'rhythm early guard 中文-'));
 try{
  const source=join(base,'source.mp4');writeFileSync(source,'owned invalid video');
  for(const kind of ['library','alias-child','pack','occupied','source','story','analysis','fresh'] as const){
   const area=join(base,kind);mkdirSync(area);let output=join(area,'output');
   const library=join(area,'library');mkdirSync(library);writeFileSync(join(library,'keep.wav'),'owned music');
   const env={...process.env,WORKLOOM_BGM_DISCOVER:'0',WORKLOOM_BGM_LIBRARY_DIR:library,WORKLOOM_BGM_HOME:join(area,'empty-home'),WL_FFPROBE:join(base,'missing-ffprobe')};
   const args=['--inputs',source];
   if(kind==='library')output=library;
   if(kind==='alias-child'){symlinkSync(library,join(area,'alias'),'dir');output=join(area,'alias','new-output');}
   if(kind==='pack'){output=join(area,'pack');mkdirSync(output);writeFileSync(join(output,'keep.wav'),'owned music');args.push('--bgm-pack',output);}
   if(kind==='occupied'){mkdirSync(output);writeFileSync(join(output,'auto.timeline.json'),'previous delivery');}
   if(kind==='source'){output=join(area,'input-output');mkdirSync(output);writeFileSync(join(output,'inside.mp4'),'owned invalid video');args[1]=join(output,'inside.mp4');}
   if(kind==='story'||kind==='analysis'){mkdirSync(output);const file=join(output,kind+'.json');write(file,{});args.push('--'+kind,file);}
   const before=existsSync(output)?readdirSync(output).sort():null;
   const result=cli('edit-auto.mts',[...args,'--out-dir',output,'--skip-post','--skip-assemble'],env);
   assert.notEqual(result.status,0,kind);
   if(kind==='fresh')assert.match(result.stderr,/edit-probe.mts 失败/,result.stderr);
   else{
    assert.equal(existsSync(join(output,'analysis')),false,kind+': artifact written before rejection');
    assert.equal(existsSync(join(output,'work')),false,kind+': work directory written before rejection');
    assert.deepEqual(existsSync(output)?readdirSync(output).sort():null,before,kind);
    assert.match(result.stderr,kind==='library'||kind==='alias-child'||kind==='pack'?/RHYTHM_OUTPUT_MUSIC_ALIAS/:kind==='occupied'?/RHYTHM_OUTPUT_NOT_EMPTY/:/RHYTHM_OUTPUT_INPUT_ALIAS/,result.stderr);
   }
   assert.equal(readFileSync(source,'utf8'),'owned invalid video');assert.equal(readFileSync(join(library,'keep.wav'),'utf8'),'owned music');
   if(kind==='occupied')assert.equal(readFileSync(join(output,'auto.timeline.json'),'utf8'),'previous delivery');
  }
  // An invalid draft is sufficient: both target and sidecar workspace must reject before probing it.
  const library=join(base,'rhythm-library');mkdirSync(library);const draft=join(base,'draft.json');write(draft,{});
  const env={...process.env,WORKLOOM_BGM_LIBRARY_DIR:library,WORKLOOM_BGM_HOME:join(base,'empty-home')};
  for(const alias of [false,true]){
   const target=alias?join(base,'compiled.json'):join(library,'compiled.json');
   if(alias)symlinkSync(library,target+'.assets','dir');
   const result=cli('edit-rhythm.mts',['--timeline',draft,'--out',target],env);
   assert.notEqual(result.status,0);assert.match(result.stderr,/RHYTHM_OUTPUT_MUSIC_ALIAS/,result.stderr);assert.deepEqual(readdirSync(library),[]);
  }
 }finally{rmSync(base,{recursive:true,force:true});}
});

test('concurrent auto attempts allow only one process to enter probing',async()=>{
 const base=mkdtempSync(join(tmpdir(),'rhythm concurrent-'));
 try{
  const source=join(base,'source.mp4'),out=join(base,'out');writeFileSync(source,'owned invalid video');
  const env={...process.env,WORKLOOM_BGM_LIBRARY_DIR:join(base,'library'),WORKLOOM_BGM_HOME:join(base,'home'),WL_FFPROBE:join(base,'missing-ffprobe')};
  const launch=()=>new Promise<{code:number|null;stderr:string}>((done,reject)=>{
   const child=spawn(process.execPath,['--import','tsx',join(root,'scripts/tools/edit-auto.mts'),'--inputs',source,'--out-dir',out,'--skip-post'],{cwd:root,env,stdio:['ignore','ignore','pipe']});
   let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk.toString();});child.on('error',reject);child.on('close',code=>done({code,stderr}));
  });
  const results=await Promise.all(Array.from({length:4},launch));
  assert(results.every(r=>r.code!==0));assert.equal(results.filter(r=>/edit-probe.mts 失败/.test(r.stderr)).length,1,JSON.stringify(results));
  assert.equal(results.filter(r=>/RHYTHM_OUTPUT_(NOT_EMPTY|CLAIMED)/.test(r.stderr)).length,3,JSON.stringify(results));
  assert.equal(readFileSync(source,'utf8'),'owned invalid video');
 }finally{rmSync(base,{recursive:true,force:true});}
});

test('fractional output frame rates keep every compiled cut on its final clock', {timeout:600_000},async t=>{
 const base=mkdtempSync(join(tmpdir(),'rhythm fractional clock-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
 const source=join(base,'source-30fps.mp4');
 const generated=run(ffmpeg,['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=320x180:rate=30:duration=25','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=25','-c:v','libx264','-preset','ultrafast','-crf','16','-pix_fmt','yuv420p','-c:a','aac',source]);
 assert.equal(generated.status,0,generated.stderr);const sha256=await rhythmFileSha256(source);
 const env={...process.env,WORKLOOM_BGM_DISCOVER:'0',WORKLOOM_BGM_LIBRARY_DIR:join(base,'empty-library'),WORKLOOM_BGM_HOME:join(base,'empty-home')};delete env.WORKLOOM_POST_VARIANT_DIR;
 for(const fps of [29.97,23.976]){
  const area=join(base,String(fps));mkdirSync(area);
  const draft:EditTimeline={schemaVersion:'workloom.video-edit/edit-timeline/v2',timelineId:'fractional-'+fps,target:{durationSeconds:11,aspectRatio:'16:9',fps,platform:'test'},sources:[{sourceId:'src',path:source,sha256,fps:30,durationSeconds:25,hasAudio:true}],segments:[{seq:0,segmentId:'body',sourceId:'src',sourceIn:16,sourceOut:20,durationSeconds:4,motive:'complete body'},{seq:1,segmentId:'landing',sourceId:'src',sourceIn:23,sourceOut:25,durationSeconds:2,motive:'complete landing'}],audioDesign:{originalAudioPolicy:'keep',bgm:{needed:false}}};
  const clock=(n:number)=>`00:00:${String(Math.floor(n)).padStart(2,'0')}.${String(Math.round(n%1*1000)).padStart(3,'0')}`;
  const analysis={asset:{sha256,rights:{status:'cleared',declaredUsage:['timeline-source']}},probe:{speech:{sentences:[]}},shots:Array.from({length:6},(_,i)=>({shotId:'safe'+i,inTimecode:clock(i*2.4),outTimecode:clock(i*2.4+1.4),confidence:0.95,evidence:[{t:Number((i*2.4).toFixed(6))}],quality:{score:0.9,usable:true},editing:{rhythm:{eligibleFor:['opening','ending'],speechReviewed:true,actionReviewed:true,safeRanges:[{inSeconds:i*2.4,outSeconds:i*2.4+1.4,reason:'owned complete visual interval'}]}}}))};
  const compiled=compileRhythmDirection({timeline:draft,story:{rhythm:{mode:'bookends',beatSync:false,durationBand:{minSeconds:6,maxSeconds:11}}},analyses:[analysis]});
  const timelineFile=join(area,'timeline.json');write(timelineFile,compiled);const output=join(area,'delivery');
  const result=cli('edit-post.mts',['--timeline',timelineFile,'--out-dir',output,'--variants','warm-story,clean-tech','--bgm-pack',join(base,'empty-pack')],env);
  writeFileSync(join(area,'post.log'),result.stdout+result.stderr);assert.equal(result.status,0,result.stderr+result.stdout);
  const inspection=read(join(output,'rhythm-direction-inspection.json'));
  assert.equal(inspection.passed,true,JSON.stringify(inspection.failures));assert.equal(inspection.executionEvidence.executions.length,3);
  for(const scope of inspection.executionEvidence.executions)for(const [i,cut] of scope.cuts.entries())assert(Math.abs(cut.at-compiled.rhythmDirection.clock[i+1]!.startSeconds)<=1/fps+0.01,scope.scope+' cut '+i);
  for(const media of inspection.outputs){assert.equal(media.passed,true);assert(Math.abs(media.media.fps-fps)<0.01);assert(Math.abs(media.media.videoSeconds-compiled.rhythmDirection.expectedOutputSeconds)<=1/fps+0.015);}
  assert.equal(await rhythmFileSha256(source),sha256);
 }
});

test('real compiled cuts, fixed music, overlap subtitles and release freshness stay bound', {timeout:600_000},async t=>{
 const base=process.env.WORKLOOM_RHYTHM_TEST_OUT?resolve(process.env.WORKLOOM_RHYTHM_TEST_OUT):mkdtempSync(join(tmpdir(),'rhythm actual 中文-'));
 mkdirSync(base,{recursive:true});assert.equal(readdirSync(base).length,0,'test output must be new');
 if(!process.env.WORKLOOM_RHYTHM_TEST_OUT)t.after(()=>rmSync(base,{recursive:true,force:true}));
 const source=join(base,'source.mp4'),library=join(base,'music');mkdirSync(library);
 // Low visual contrast is deliberate: genuine cuts must not depend on a large pixel-change heuristic.
 const generated=run(ffmpeg,['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=320x180:rate=30:duration=25','-vf','eq=contrast=0.12:saturation=0.1','-c:v','libx264','-preset','ultrafast','-crf','16','-pix_fmt','yuv420p',source]);
 assert.equal(generated.status,0,generated.stderr);const sha256=await rhythmFileSha256(source);
 pulseWave(join(library,'pulse.wav'));write(join(library,'tracks.json'),{tracks:[{id:'fixture-pulses',title:'Self-generated pulses',file:'pulse.wav',style:'electronic-pulse',license:'workloom-self-generated',durationSec:16,source:'offline-fixture'}]});
 const env={...process.env,WORKLOOM_BGM_DISCOVER:'0',WORKLOOM_BGM_LIBRARY_DIR:library,WORKLOOM_BGM_HOME:join(base,'empty-home'),WORKLOOM_BGM_ALLOWED_ROOTS:base};
 delete env.WORKLOOM_POST_VARIANT_DIR;
 const segments=[[15,17],[19,21],[23,25]].map(([start,end],i)=>({seq:i,segmentId:'body'+i,sourceId:'src',sourceIn:start!,sourceOut:end!,durationSeconds:end!-start!,speed:1,motive:'完整正文与落版',...(i===1?{transitionIn:{type:'dissolve' as const,durationSeconds:0.4}}:{})}));
 const draft:EditTimeline={schemaVersion:'workloom.video-edit/edit-timeline/v2',timelineId:'real-rhythm',target:{durationSeconds:11,aspectRatio:'16:9',fps:30,platform:'test'},sources:[{sourceId:'src',path:source,sha256,fps:30,durationSeconds:25,hasAudio:false}],segments,audioDesign:{originalAudioPolicy:'keep',bgm:{needed:true,libraryTrackId:'fixture-pulses'}}};
 const clock=(n:number)=>`00:00:${String(Math.floor(n)).padStart(2,'0')}.${String(Math.round(n%1*1000)).padStart(3,'0')}`;
 const analysis={asset:{sha256,rights:{status:'cleared',declaredUsage:['timeline-source']}},probe:{speech:{sentences:[{start:15,end:17,text:'走进山里'},{start:19,end:21,text:'看看风景'},{start:23,end:25,text:'记住此刻'}]}},shots:Array.from({length:6},(_,i)=>({shotId:'safe'+i,inTimecode:clock(i*2.4),outTimecode:clock(i*2.4+1.4),confidence:0.95,evidence:[{t:Number((i*2.4).toFixed(6))}],quality:{score:0.9,usable:true},editing:{rhythm:{eligibleFor:['opening','ending'],speechReviewed:true,actionReviewed:true,safeRanges:[{inSeconds:i*2.4,outSeconds:i*2.4+1.4,reason:'自有夹具完整视觉区间'}]}}}))};
 const story={rhythm:{mode:'bookends' as const,beatSync:true,durationBand:{minSeconds:10,maxSeconds:11},music:{trackId:'fixture-pulses',sectionStartSeconds:0.4,sectionEndSeconds:8.4,repeat:true,entrySeconds:0}}};
 const music=await prepareRhythmMusic({story,timeline:draft,outDir:join(base,'prepared'),ffmpeg,ffprobe,env});assert(music);await verifyRhythmMusic(music,ffmpeg,ffprobe);assert(music.onsetTimesSeconds.length>20);
 const compiled=compileRhythmDirection({timeline:draft,story,analyses:[analysis],music});assert.equal(compiled.rhythmDirection.mode,'bookends');assert.equal(compiled.rhythmDirection.expectedOutputSeconds,10.4);
 compiled.validation={continuous:true,noSourceOverlap:true,totalDurationSeconds:validateEditTimeline(compiled).totalDurationSeconds,generatedBy:'actual-media-regression'};
 const timelineFile=join(base,'timeline.json');write(timelineFile,compiled);
 const prepared=planAutoCaptions({timeline:compiled,sources:[{sourceId:'src',analysis}]});write(join(base,'captions.json'),prepared.captionDoc);write(join(base,'transcript.json'),prepared.transcript);
 const srt=join(base,'film.srt');let result=cli('edit-subtitle.mts',['--timeline',timelineFile,'--caption',join(base,'captions.json'),'--transcript',join(base,'transcript.json'),'--talk','--allow-silent-shots','--out',srt],env);
 writeFileSync(join(base,'subtitle.log'),result.stdout+result.stderr);assert.equal(result.status,0,result.stderr+result.stdout);await verifyRhythmSubtitle(compiled,srt);
 // Exercise a supported directory alias on every OS, including macOS /var -> /private/var.
 const output=join(base,'delivery'),physicalOutput=join(base,'actual','nested','delivery');mkdirSync(physicalOutput,{recursive:true});symlinkSync(physicalOutput,output,'dir');
 result=cli('edit-post.mts',['--timeline',timelineFile,'--out-dir',output,'--variants','warm-story,clean-tech','--subtitle',srt,'--bgm-pack',join(base,'empty-pack')],env);
 writeFileSync(join(base,'post.log'),result.stdout+result.stderr);assert.equal(result.status,0,result.stderr+result.stdout);
 const manifest=read(join(output,'delivery-manifest.json')),inspection=read(join(output,'rhythm-direction-inspection.json'));
 assert.equal(inspection.passed,true,JSON.stringify(inspection.failures));assert.equal(inspection.outputs.length,7);assert.equal(inspection.subtitleEvidence.cueCount,3);
 assert.equal(inspection.executionEvidence.executions.length,3);assert.equal(inspection.executionEvidence.executions[0].frameComparisons.length,12);
 assert(inspection.outputs.filter((o:{id:string})=>o.id!=='master').every((o:{music:{status:string}})=>o.music.status==='measured'));
 const bins={ffmpeg,ffprobe};const release=await inspectDeliveryManifest({root:output,manifest,bins,phase:'release'});write(join(base,'release.json'),release);assert.equal(release.passed,true,JSON.stringify(release.checks.filter((c:{hard:boolean;ok:boolean})=>c.hard&&!c.ok)));
 const original=readFileSync(source);try{appendFileSync(source,'changed source');const changed=await inspectDeliveryManifest({root:output,manifest,bins,phase:'release'});write(join(base,'changed-source.json'),changed);assert.equal(changed.passed,false);assert(changed.checks.some((c:{kind:string;ok:boolean})=>c.kind==='chain:rhythm-direction'&&!c.ok));}finally{writeFileSync(source,original);}
 const without={...manifest};delete without.rhythmDirection;const pending=await inspectDeliveryManifest({root:output,manifest:without,bins,phase:'release'});assert.equal(pending.passed,false);
 const fake={...manifest,master:{...manifest.master,sha256:'f'.repeat(64)}};await assert.rejects(()=>verifyRhythmExecution({timeline:compiled,outDir:output,manifest:fake,ffmpeg}),/RHYTHM_EXECUTION_CHANGED/);
 const originalSrt=readFileSync(srt);try{appendFileSync(srt,'changed');await assert.rejects(()=>verifyRhythmSubtitle(compiled,srt),/RHYTHM_SUBTITLE_CHANGED/);}finally{writeFileSync(srt,originalSrt);}
 await t.test('no-BGM, explicit non-beat music and music intent conflicts',async()=>{
  const disabled=structuredClone(draft);disabled.audioDesign.bgm={needed:false,libraryTrackId:'ignored'};
  assert.equal(await prepareRhythmMusic({story,timeline:disabled,outDir:join(base,'must-not-create'),ffmpeg:'forbidden',ffprobe:'forbidden',env}),null);assert.equal(existsSync(join(base,'must-not-create')),false);
  for(const [mode,beatSync] of [['natural',true],['auto',false]] as const){const s={rhythm:{...story.rhythm,mode,beatSync}};const m=await prepareRhythmMusic({story:s,timeline:draft,outDir:join(base,'explicit-'+mode),ffmpeg,ffprobe,env});assert.equal(m?.source.trackId,'fixture-pulses');}
  const delayed=await prepareRhythmMusic({story:{rhythm:{...story.rhythm,music:{...story.rhythm.music,entrySeconds:0.2}}},timeline:draft,outDir:join(base,'delayed'),ffmpeg,ffprobe,env});assert(delayed);assert(Math.abs(delayed.onsetTimesSeconds[0]!-0.2)<0.02);assert.equal(delayed.source.sectionStartSeconds,0.4);assert.equal(delayed.source.repeat,true);
  await assert.rejects(()=>prepareRhythmMusic({story:{rhythm:{...story.rhythm,music:{...story.rhythm.music,repeat:false}}},timeline:draft,outDir:join(base,'short'),ffmpeg,ffprobe,env}),/RHYTHM_MUSIC_TOO_SHORT/);
  await assert.rejects(()=>prepareRhythmMusic({story:{rhythm:{music:{trackId:'other'}}},timeline:draft,outDir:join(base,'conflict'),env}),/RHYTHM_MUSIC_INTENT_CONFLICT/);
 });
 await t.test('hash drift, absent explicit plan and symlinked work reject before any output write',async()=>{
  const stale=structuredClone(compiled);stale.sources[0]!.sha256='f'.repeat(64);delete (stale as any).rhythmDirection;
  await assert.rejects(()=>preflightRhythmTimeline({timeline:stale,declared:stale.rhythmPlan,profile:'fast-cut',ffprobe}),/RHYTHM_SOURCE_HASH_CHANGED/);
  await assert.rejects(()=>preflightRhythmTimeline({timeline:draft,declared:null,profile:'fast-cut',ffprobe}),/RHYTHM_EXPLICIT_PLAN_REQUIRED/);
  const guarded=join(base,'guarded'),outside=join(base,'outside');mkdirSync(guarded);mkdirSync(outside);symlinkSync(outside,join(guarded,'work'),'dir');
  const rejected=cli('edit-post.mts',['--timeline',timelineFile,'--out-dir',guarded,'--variants','warm-story,clean-tech'],env);assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/RHYTHM_OUTPUT_NOT_EMPTY/);assert.deepEqual(readdirSync(outside),[]);
 });
 assert.equal(await rhythmFileSha256(source),sha256);
 write(join(base,'result.json'),{passed:true,sourceSha256:sha256,outputSeconds:10.4,outputCount:7,actualFrameChecks:12,music:'decoded actual mix',captionClock:'concat-to-final-once',sourceRestored:true,paidCalls:0});
});
