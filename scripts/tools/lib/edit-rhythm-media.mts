/** Local media evidence for on-demand bookends. No models, network, source writes or extrapolated beats. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertRhythmDirection, assertRhythmStory, timelineRhythmDigest, type RhythmMusic, type RhythmStory, type RhythmDirection } from '../../../packages/video-studio/src/edit/rhythm-director.js';
import { auditRhythmPlan, type RhythmPlanInput, type RhythmProfile } from '../../../packages/video-studio/src/rhythm-plan.js';
import type { EditTimeline } from '../../../packages/video-studio/src/edit/timeline.js';
import { rhythmFileSha256, rhythmMediaFacts } from '../rhythm-edit.mts';

const RATE=8000, METHOD='decoded-mono-rms-positive-flux/10ms-v1';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json=(file:string)=>JSON.parse(readFileSync(file,'utf8'));
const write=(file:string,value:unknown)=>writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const message=(e:unknown)=>e instanceof Error?e.message:String(e);
export function rhythmRun(bin:string,args:string[],maxBuffer=64*1024*1024):Buffer {
  try{return execFileSync(bin,args,{maxBuffer,timeout:600_000,stdio:['ignore','pipe','pipe']});}
  catch(e){const failure=e as {stderr?:Buffer;message?:string};throw new Error('RHYTHM_MEDIA_PROCESS_FAILED: '+bin+' '+(failure.stderr?.toString()||failure.message||'').split('\n').slice(-8).join(' | '));}
}
function audioDuration(file:string,ffprobe:string):number {
  const probe=JSON.parse(rhythmRun(ffprobe,['-v','error','-show_format','-show_streams','-of','json',file]).toString());
  const audio=probe.streams?.find((s:{codec_type?:string})=>s.codec_type==='audio');
  const duration=Number(audio?.duration??probe.format?.duration);
  if(!audio||!finite(duration)||duration<=0)throw new Error('RHYTHM_MUSIC_UNREADABLE');return duration;
}
export function decodeRhythmAudio(file:string,ffmpeg:string,seconds:number,start=0):Float32Array {
  if(!finite(seconds)||seconds<=0||seconds>1801||!finite(start)||start<0)throw new Error('RHYTHM_AUDIO_RANGE');
  const raw=rhythmRun(ffmpeg,['-v','error','-xerror','-nostdin','-ss',String(start),'-i',file,'-t',String(seconds),'-map','0:a:0','-vn','-ac','1','-ar',String(RATE),'-f','f32le','pipe:1']);
  if(raw.length<4||raw.length%4)throw new Error('RHYTHM_AUDIO_DECODE_EMPTY');
  const samples=new Float32Array(raw.length/4);for(let i=0;i<samples.length;i++)samples[i]=raw.readFloatLE(i*4);return samples;
}
/** Detect actual transients. No BPM grid synthesis: every reported point has decoded energy evidence. */
export function detectRhythmOnsets(samples:Float32Array,rate=RATE):number[] {
  if(!finite(rate)||rate<=0||samples.some(n=>!Number.isFinite(n)))throw new Error('RHYTHM_PCM_INVALID');
  const hop=Math.max(1,Math.round(rate*0.01)), energies:number[]=[];
  for(let i=0;i+hop<=samples.length;i+=hop){let sum=0;for(let j=0;j<hop;j++)sum+=samples[i+j]!**2;energies.push(Math.sqrt(sum/hop));}
  if(energies.length<3)return [];
  const flux=energies.map((n,i)=>Math.max(0,n-(energies[i-1]??0))), maximum=flux.reduce((max,n)=>Math.max(max,n),0);
  if(maximum<0.0002)return [];
  const positive=flux.filter(n=>n>0).sort((a,b)=>a-b),median=positive[Math.floor(positive.length/2)]??0;
  // Repeated equally strong attacks have median == maximum; an uncapped noise floor would erase every real pulse.
  const threshold=Math.max(0.0002,maximum*0.12,Math.min(median*2.5,maximum*0.5)),peaks:Array<{time:number;strength:number}>=[];
  for(let i=0;i<flux.length;i++)if(flux[i]!>=threshold&&flux[i]!>=(flux[i-1]??0)&&flux[i]!>(flux[i+1]??0)){
    const peak={time:Number((i*hop/rate).toFixed(6)),strength:flux[i]!},previous=peaks.at(-1);
    if(previous&&peak.time-previous.time<0.22){if(peak.strength>previous.strength)peaks[peaks.length-1]=peak;}
    else peaks.push(peak);
  }
  return peaks.map(p=>p.time);
}

/** Fix the actual song, section, repeat and entry BEFORE compiling any beat-aligned cuts. */
export async function prepareRhythmMusic({story,timeline,outDir,ffmpeg='ffmpeg',ffprobe='ffprobe',env=process.env}: {
  story:RhythmStory;timeline:EditTimeline;outDir:string;ffmpeg?:string;ffprobe?:string;env?:NodeJS.ProcessEnv;
}):Promise<RhythmMusic|null> {
  assertRhythmStory(story);
  if(timeline.audioDesign.bgm?.needed===false)return null;
  const request=story.rhythm?.music??{};
  const bgm=timeline.audioDesign.bgm as {libraryTrackId?:string;trackId?:string}|undefined;
  const ids=[request.trackId,bgm?.libraryTrackId,bgm?.trackId].filter((id):id is string=>typeof id==='string'&&id.length>0);
  if(new Set(ids).size>1)throw new Error('RHYTHM_MUSIC_INTENT_CONFLICT: 曲目指定不一致');
  const selectedId=ids[0];
  const explicitMusic=Object.keys(request).length>0||Boolean(selectedId);
  if(!explicitMusic&&(story.rhythm?.beatSync!==true||story.rhythm.mode==='natural'))return null;
  const core=await import('../../../bundles/ai-video/connectors/post-bridge/core.mjs') as unknown as {
    selectTrackForVariant:(pack:unknown,options:unknown)=>{picked:{id:string;path:string;license:string;title?:string;attribution?:unknown;commercialOk?:boolean}} };
  const selected=core.selectTrackForVariant({bgm:selectedId?{trackId:selectedId}:{style:'electronic-pulse'}},{env,hints:{filmSeconds:timeline.target.durationSeconds,targetBpm:120}}).picked;
  if(!selected?.path||!existsSync(selected.path)||selected.commercialOk===false)throw new Error('RHYTHM_MUSIC_UNAVAILABLE: 没有可用且许可通过的本地曲目');
  const source=realpathSync(selected.path), sourceHash=await rhythmFileSha256(source),duration=audioDuration(source,ffprobe);
  const start=request.sectionStartSeconds??0,end=request.sectionEndSeconds??duration,entry=request.entrySeconds??0;
  const maximum=story.rhythm?.durationBand?.maxSeconds??(timeline.target as {durationBand?:{maxSeconds:number}}).durationBand?.maxSeconds??timeline.target.durationSeconds*1.05;
  const outputSeconds=Number((maximum+0.75).toFixed(6));
  if(!finite(start)||!finite(end)||!finite(entry)||start<0||end<=start||end>duration+0.02||entry<0||entry>=maximum||outputSeconds>1801)throw new Error('RHYTHM_MUSIC_RANGE: 选段/入场/时长非法');
  if(request.repeat!==true&&end-start+entry<outputSeconds-0.02)throw new Error('RHYTHM_MUSIC_TOO_SHORT: 明确允许循环或选择更长区间');
  mkdirSync(outDir,{recursive:true});const work=mkdtempSync(join(outDir,'music-'));
  const section=join(work,'section.wav'),bed=join(work,'bed.wav');
  try{
    rhythmRun(ffmpeg,['-v','error','-xerror','-nostdin','-n','-i',source,'-map','0:a:0','-af','atrim=start='+start+':end='+end+',asetpts=PTS-STARTPTS','-ar','48000','-ac','2','-c:a','pcm_s16le',section]);
    const args=['-v','error','-xerror','-nostdin','-n',...(request.repeat===true?['-stream_loop','-1']:[]),'-i',section,'-map','0:a:0'];
    args.push('-af','adelay='+Math.round(entry*1000)+':all=1,atrim=duration='+outputSeconds+',asetpts=PTS-STARTPTS','-t',String(outputSeconds),'-ar','48000','-ac','2','-c:a','pcm_s16le',bed);
    rhythmRun(ffmpeg,args);
    const measuredDuration=audioDuration(bed,ffprobe);
    if(Math.abs(measuredDuration-outputSeconds)>0.02)throw new Error('RHYTHM_MUSIC_RANGE_NOT_RENDERED');
    const sha256=await rhythmFileSha256(bed),onsets=detectRhythmOnsets(decodeRhythmAudio(bed,ffmpeg,measuredDuration));
    if(await rhythmFileSha256(source)!==sourceHash)throw new Error('RHYTHM_MUSIC_SOURCE_CHANGED');
    const result:RhythmMusic={schemaVersion:'workloom.video-edit/rhythm-music/v1',path:bed,sha256,trackId:'rhythm-bed-'+sha256.slice(0,24),durationSeconds:measuredDuration,onsetTimesSeconds:onsets,method:METHOD,
      source:{path:source,sha256:sourceHash,trackId:selected.id,license:selected.license,sectionStartSeconds:start,sectionEndSeconds:end,entrySeconds:entry,repeat:request.repeat===true}};
    write(join(work,'source-attribution.json'),{track:selected,sourceHash,derivedBed:sha256});write(join(work,'measurement.json'),result);return result;
  }catch(error){write(join(work,'failed.json'),{status:'failed',message:message(error)});throw error;}
}
export async function verifyRhythmMusic(music:RhythmMusic,ffmpeg='ffmpeg',ffprobe='ffprobe'):Promise<void> {
  if(await rhythmFileSha256(music.path)!==music.sha256||await rhythmFileSha256(music.source.path)!==music.source.sha256)throw new Error('RHYTHM_MUSIC_CHANGED: 曲目或播放床字节变化');
  if(music.method!==METHOD||Math.abs(audioDuration(music.path,ffprobe)-music.durationSeconds)>0.02)throw new Error('RHYTHM_MUSIC_CHANGED: 测量方法/时长变化');
  const onsets=detectRhythmOnsets(decodeRhythmAudio(music.path,ffmpeg,music.durationSeconds));
  if(digest(onsets)!==digest(music.onsetTimesSeconds))throw new Error('RHYTHM_MUSIC_CHANGED: 瞬态落点没有对应当前解码结果');
}
export async function verifyRhythmSubtitle(timeline:EditTimeline,file:string):Promise<void> {
  const direction=assertRhythmDirection(timeline);if(!direction)return;
  const sidecar=file+'.rhythm.json';
  if(!existsSync(sidecar))throw new Error('RHYTHM_SUBTITLE_CHANGED: 请基于已编译时间轴运行 edit:subtitle');
  const proof=json(sidecar);
  if(proof.schemaVersion!=='workloom.video-edit/rhythm-subtitle/v1'||proof.timelineSha256!==timelineRhythmDigest(timeline)||proof.srtSha256!==await rhythmFileSha256(file)||proof.clock!=='concat'||!Array.isArray(proof.expectedFinalCues))throw new Error('RHYTHM_SUBTITLE_CHANGED: 字幕或时间轴已变化');
}
export async function preflightRhythmTimeline({timeline,declared,profile,ffprobe='ffprobe'}:{timeline:EditTimeline;declared:RhythmPlanInput|null;profile:RhythmProfile;ffprobe?:string}) {
  const direction=assertRhythmDirection(timeline);
  if(profile!=='natural'&&!declared)throw new Error('RHYTHM_EXPLICIT_PLAN_REQUIRED: 显式快剪/电影节奏需要源区间计划');
  if(declared&&(declared.profile&&declared.profile!==profile||declared.segments.length!==timeline.segments.length||declared.segments.some((s,i)=>s.id!==timeline.segments[i]!.segmentId||s.sourceId!==timeline.segments[i]!.sourceId||s.inSeconds!==timeline.segments[i]!.sourceIn||s.outSeconds!==timeline.segments[i]!.sourceOut)))throw new Error('RHYTHM_TIMELINE_PLAN_CONFLICT');
  const sources=await Promise.all(timeline.sources.map(async source=>{
    if(await rhythmFileSha256(source.path)!==source.sha256)throw new Error('RHYTHM_SOURCE_HASH_CHANGED: '+source.sourceId);
    const media=rhythmMediaFacts(source.path,ffprobe);return {...source,media};
  }));
  if(declared){const audit=auditRhythmPlan(declared,{sourceDurationsSeconds:Object.fromEntries(sources.map(s=>[s.sourceId,s.media.videoSeconds]))});if(!audit.pass)throw new Error('RHYTHM_PREFLIGHT_FAILED: '+audit.issues.filter(i=>i.severity==='error').map(i=>i.code).join(', '));}
  for(const segment of timeline.segments){const source=sources.find(s=>s.sourceId===segment.sourceId);if(!source||segment.sourceOut>source.media.videoSeconds+1/timeline.target.fps)throw new Error('RHYTHM_SOURCE_RANGE_INVALID: '+segment.segmentId);}
  return {direction,sources};
}

/** Resolve the closest existing ancestor too: a new child can still traverse a symlink. */
export function resolveRhythmPhysicalPath(file:string):string {
  let ancestor=resolve(file);const tail:string[]=[];
  while(!existsSync(ancestor)){
    const parent=dirname(ancestor);if(parent===ancestor)throw new Error('RHYTHM_PATH_UNRESOLVED');
    tail.unshift(relative(parent,ancestor));ancestor=parent;
  }
  return resolve(realpathSync(ancestor),...tail);
}
/** A music library is read-only input: neither it, an ancestor nor a child is an output workspace. */
export function assertRhythmOutputOutsideMusicLibraries(outDir:string,roots:string[]):void {
  const output=resolveRhythmPhysicalPath(outDir);
  for(const root of roots.filter(Boolean)){
    const library=resolveRhythmPhysicalPath(root);
    if(inside(output,library)||inside(library,output))throw new Error('RHYTHM_OUTPUT_MUSIC_ALIAS: 输出或清理目录不能与输入曲库重叠：'+root);
  }
}
/** One input-library inventory for all three editing entry points. */
export function rhythmMusicLibraryRoots(repoRoot:string,pack?:string,env=process.env):string[] {
  return [pack,join(homedir(),'Downloads/1200可商用纯音乐'),join(homedir(),'.workloom-bgm'),
    env.WORKLOOM_BGM_HOME,env.WORKLOOM_BGM_LIBRARY_DIR,
    join(repoRoot,'bundles/ai-video/library/bgm-library'),join(repoRoot,'bundles/ai-video/library/bgm-library-curated')]
    .filter((file):file is string=>Boolean(file)).map(file=>resolve(repoRoot,file));
}
/** Reject before mkdir/probe: generated artifacts never overwrite supplied input or a previous run. */
export function assertRhythmFreshWorkspace(outDir:string,inputFiles:string[]):void {
  const output=resolveRhythmPhysicalPath(outDir);
  for(const input of inputFiles)if(inside(output,resolveRhythmPhysicalPath(input)))throw new Error('RHYTHM_OUTPUT_INPUT_ALIAS: 输出目录包含输入文件，请指定独立目录');
  if(existsSync(outDir)&&(!statSync(outDir).isDirectory()||readdirSync(outDir).length>0))throw new Error('RHYTHM_OUTPUT_NOT_EMPTY: 请使用新的空输出目录，已有产物保留');
}
/** An exclusive attempt claim closes the gap between the empty-directory check and artifact writes. */
export function claimRhythmWorkspace(outDir:string):void {
  mkdirSync(outDir,{recursive:true});
  try{write(join(outDir,'.rhythm-attempt.json'),{schemaVersion:'workloom.video-edit/output-attempt/v1',pid:process.pid});}
  catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('RHYTHM_OUTPUT_CLAIMED: 输出目录已被另一任务占用，请使用新版本目录');throw error;}
}
/**
 * Rhythm overrides may enable/disable the project music bed, but they must never reopen a
 * variant whose recipe explicitly declares `bgm.enabled=false` (for example natural-clean).
 */
export function rhythmBgmOverride(bgm:Record<string,unknown>={}, {noMusic=false,music=null}:{noMusic?:boolean;music?:{trackId:string}|null}={}):Record<string,unknown>{
  const explicitlyDisabled=bgm.enabled===false;
  const result={...bgm,enabled:explicitlyDisabled?false:!noMusic};
  if(music&&!noMusic&&!explicitlyDisabled){
    Object.assign(result,{trackId:music.trackId,section:'full',bpmStrategy:'recipe',fadeInSec:0,fadeOutSec:0});
    for(const key of ['sectionStartSec','sectionEndSec','mood','genre'])delete result[key];
  }
  return result;
}
/** Apply AFTER existing recipe options, before the first post-core import. Original libraries stay read-only. */
export function installRhythmPostOverrides({timeline,repoRoot,outDir,env=process.env}:{timeline:EditTimeline;repoRoot:string;outDir:string;env?:NodeJS.ProcessEnv}):void {
  const direction=assertRhythmDirection(timeline), music=direction?.music, noMusic=timeline.audioDesign.bgm?.needed===false;
  if(!direction&&!noMusic)return;
  const base=join(repoRoot,'bundles/ai-video/library/style-variants'),folder=env.WORKLOOM_POST_VARIANT_DIR??join(outDir,'work','variant-overrides');
  const owned=realpathSync(outDir),candidate=resolveRhythmPhysicalPath(folder);
  if(!inside(owned,candidate)||candidate===owned)throw new Error('RHYTHM_OVERRIDE_PATH_ESCAPE: 配方覆盖必须属于本次输出目录');
  mkdirSync(folder,{recursive:true});const index=json(join(base,'index.json')) as {variants:Array<{id:string;file:string}>};
  for(const entry of index.variants){const target=join(folder,entry.file);
    if(!inside(owned,resolveRhythmPhysicalPath(target)))throw new Error('RHYTHM_OVERRIDE_PATH_ESCAPE: 配方文件逃逸输出目录');
    const pack=json(existsSync(target)?target:join(base,entry.file));
    pack.bgm=rhythmBgmOverride(pack.bgm??{},{noMusic,music});
    // The compiled clock owns overlap duration; a look may not quietly move cuts or subtitles.
    if(direction)pack.transitions={...(pack.transitions??{}),scale:1,intentMap:{}};
    writeFileSync(target,JSON.stringify(pack,null,2)+'\n');
  }
  if(!inside(owned,resolveRhythmPhysicalPath(join(folder,'index.json'))))throw new Error('RHYTHM_OVERRIDE_PATH_ESCAPE: 配方索引逃逸输出目录');
  if(!existsSync(join(folder,'index.json')))write(join(folder,'index.json'),index);env.WORKLOOM_POST_VARIANT_DIR=folder;
  if(music&&!noMusic){const library=join(outDir,'work','rhythm-music-library');mkdirSync(library,{recursive:true});
    const attributionFile=join(dirname(music.path),'source-attribution.json');
    write(join(library,'tracks.json'),{schemaVersion:'workloom.bgm-library/v1',tracks:[{id:music.trackId,file:music.path,title:'本片固定节奏音乐床',license:music.source.license,
      durationSec:music.durationSeconds,source:music.source.path,attribution:existsSync(attributionFile)?json(attributionFile).track?.attribution:null}]});
    write(join(library,'source-attribution.json'),{...music.source,preparedBedSha256:music.sha256,original:existsSync(attributionFile)?json(attributionFile):null});
    env.WORKLOOM_BGM_LIBRARY_DIR=library;
    env.WORKLOOM_BGM_ALLOWED_ROOTS=[env.WORKLOOM_BGM_ALLOWED_ROOTS,dirname(music.path),dirname(music.source.path)].filter(Boolean).join(':');
  }
}
export function rhythmPathIsWithin(root:string,file:string,flavor:{relative:typeof relative;isAbsolute:typeof isAbsolute;sep:string}={relative,isAbsolute,sep}):boolean {
  const rel=flavor.relative(root,file);return rel===''||rel!=='..'&&!rel.startsWith('..'+flavor.sep)&&!flavor.isAbsolute(rel);
}
const inside=rhythmPathIsWithin;
function mediaPath(root:string,file:string):string{const target=realpathSync(resolve(root,file));if(!inside(realpathSync(root),target))throw new Error('RHYTHM_OUTPUT_PATH_ESCAPE');return target;}
function observedCuts(file:string,region:RhythmDirection['regions'][number],fps:number,ffmpeg:string):number[] {
  const start=Math.max(0,Math.round((region.startSeconds-3/fps)*fps)/fps),seconds=region.endSeconds-start+3/fps;
  const frameBytes=64*36*3,raw=rhythmRun(ffmpeg,['-v','error','-xerror','-nostdin','-ss',String(start),'-i',file,'-t',String(seconds),'-map','0:v:0','-vf','fps='+fps+',scale=64:36,format=rgb24','-an','-f','rawvideo','pipe:1'],32*1024*1024);
  if(raw.length<frameBytes*2||raw.length%frameBytes)throw new Error('RHYTHM_OUTPUT_DECODE_EMPTY');
  const cuts:number[]=[];for(let frame=1;frame<raw.length/frameBytes;frame++){let change=0;for(let p=0;p<frameBytes;p++)change+=Math.abs(raw[frame*frameBytes+p]!-raw[(frame-1)*frameBytes+p]!);if(change/frameBytes>=6)cuts.push(Number((start+frame/fps).toFixed(6)));}return cuts;
}
/** Tie the executed cut list to current trimmed clips, normalization receipts and final master frames. */
export async function verifyRhythmExecution({timeline,outDir,manifest,ffmpeg='ffmpeg'}:{timeline:EditTimeline;outDir:string;manifest:Record<string,any>;ffmpeg?:string}) {
  const direction=assertRhythmDirection(timeline);if(!direction)throw new Error('RHYTHM_DIRECTION_REQUIRED');
  const inputFile=mediaPath(outDir,'rhythm-render-inputs.json'),inputs=json(inputFile);
  const expectedRanges=timeline.segments.map(s=>({segmentId:s.segmentId,sourceId:s.sourceId,sourceIn:s.sourceIn,sourceOut:s.sourceOut,speed:s.speed??1}));
  const clips=inputs.currentInputs?.actualClips;
  if(inputs.schemaVersion!=='workloom.video-edit/rhythm-render-inputs/v1'||inputs.timelineSha256!==direction.timelineSha256
    ||digest(inputs.ranges)!==digest(expectedRanges)||!inputs.currentInputs?.passed||!Array.isArray(clips)||clips.length!==timeline.segments.length)throw new Error('RHYTHM_EXECUTION_MISSING: 裁切执行记录与时间轴不符');
  for(const [i,clip] of clips.entries())if(clip.shotId!==timeline.segments[i]!.segmentId||await rhythmFileSha256(mediaPath(outDir,clip.path))!==clip.sha256)throw new Error('RHYTHM_EXECUTION_CHANGED: 裁切结果变化');
  const scopes=['master',...(manifest.variants??[]).map((v:{id:string})=>v.id)],executions=[];
  for(const scope of scopes){
    const matches=(manifest.processing??[]).filter((p:{stage:string;id:string})=>p.stage==='transitions'&&p.id===scope);
    if(matches.length!==1)throw new Error('RHYTHM_EXECUTION_MISSING: '+scope+' 缺唯一逐刀回执');
    const binding=matches[0],file=mediaPath(outDir,binding.path);
    if(await rhythmFileSha256(file)!==binding.sha256)throw new Error('RHYTHM_EXECUTION_CHANGED: 逐刀回执变化');
    const proof=json(file),cuts=proof.execution?.cuts;
    if(proof.schemaVersion!=='workloom.post-processing/v1'||proof.engine!=='workloom.local-post'||proof.status!=='completed'||proof.execution?.exitCode!==0
      ||proof.execution?.shotCount!==clips.length||!Array.isArray(cuts)||cuts.length!==clips.length-1||proof.inputs?.length!==clips.length)throw new Error('RHYTHM_EXECUTION_MISSING: 逐刀执行覆盖不完整');
    const normalised=[];
    for(const [i,input] of proof.inputs.entries()){
      const path=mediaPath(outDir,input.path),receipt=json(path+'.json');
      if(await rhythmFileSha256(path)!==input.sha256||receipt.outputSha256!==input.sha256||receipt.sourceSha256!==clips[i].sha256)throw new Error('RHYTHM_EXECUTION_CHANGED: 归一化来源与真实裁片不符');
      normalised.push({path,sha256:input.sha256,sourceSha256:receipt.sourceSha256});
    }
    for(const [i,cut] of cuts.entries()){
      const next=direction.clock[i+1]!;
      if(cut.fromShotId!==timeline.segments[i]!.segmentId||cut.toShotId!==next.segmentId||!finite(cut.at)||Math.abs(cut.at-next.startSeconds)>1/timeline.target.fps+0.01
        ||!finite(cut.duration)||Math.abs(cut.duration-next.overlapSeconds)>1/timeline.target.fps+0.01)throw new Error('RHYTHM_EXECUTION_CLOCK_CHANGED: '+scope+' 第 '+i+' 刀');
      if(direction.regions.some(r=>r.cutTimesSeconds.some(t=>Math.abs(t-cut.at)<0.001))&&(cut.type!=='hard'||cut.duration!==0))throw new Error('RHYTHM_EXECUTION_CLOCK_CHANGED: 快切边界被非硬切覆盖');
    }
    for(const output of proof.outputs??[])if(await rhythmFileSha256(mediaPath(outDir,output.path))!==output.sha256)throw new Error('RHYTHM_EXECUTION_CHANGED: 合成字节变化');
    const frameComparisons=[];
    if(scope==='master'){
      if(proof.outputs?.[0]?.sha256!==manifest.master?.sha256)throw new Error('RHYTHM_EXECUTION_CHANGED: 成片母版脱离实际拼接');
      const master=mediaPath(outDir,manifest.master.path);
      const frame=(file:string,at:number)=>rhythmRun(ffmpeg,['-v','error','-xerror','-nostdin','-ss',String(at),'-i',file,'-frames:v','1','-vf','scale=64:36,format=rgb24','-an','-f','rawvideo','pipe:1']);
      for(const selection of direction.selections){
        const i=timeline.segments.findIndex(s=>s.segmentId===selection.segmentId),clock=direction.clock[i]!,duration=clock.endSeconds-clock.startSeconds;
        for(const offset of [2/timeline.target.fps,Math.max(2/timeline.target.fps,duration-3/timeline.target.fps)]){
          const sourceFrame=frame(normalised[i]!.path,offset),outputFrame=frame(master,clock.startSeconds+offset);
          if(sourceFrame.length!==64*36*3||outputFrame.length!==sourceFrame.length)throw new Error('RHYTHM_OUTPUT_DECODE_EMPTY');
          let error=0;for(let pixel=0;pixel<sourceFrame.length;pixel++)error+=Math.abs(sourceFrame[pixel]!-outputFrame[pixel]!);
          const meanAbsError=error/sourceFrame.length;
          if(meanAbsError>12)throw new Error('RHYTHM_OUTPUT_SOURCE_MISMATCH: '+selection.segmentId+' 最终画面不对应当前源片段');
          frameComparisons.push({segmentId:selection.segmentId,sourceOffsetSeconds:offset,outputSeconds:clock.startSeconds+offset,meanAbsError});
        }
      }
    }
    executions.push({scope,proofPath:binding.path,proofSha256:binding.sha256,normalised,cuts,frameComparisons});
  }
  return {inputReceiptSha256:await rhythmFileSha256(inputFile),executions,method:'current-trim-bytes/normalization/typed-cut-clock/master-frame-correspondence'};
}
function srtCues(file:string):Array<{start:number;end:number;text:string}> {
  const clock=(value:string)=>{const m=/^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/.exec(value);if(!m)throw new Error('RHYTHM_SUBTITLE_CHANGED: 非法时间');return Number(m[1])*3600+Number(m[2])*60+Number(m[3])+Number(m[4])/1000;};
  return readFileSync(file,'utf8').replace(/\r/g,'').trim().split(/\n\s*\n/).filter(Boolean).map(block=>{
    const lines=block.split('\n'),i=lines.findIndex(l=>l.includes('-->')),parts=lines[i]?.split(/\s+-->\s+/);
    if(!parts||parts.length!==2)throw new Error('RHYTHM_SUBTITLE_CHANGED: 非法字幕');
    return {start:clock(parts[0]!),end:clock(parts[1]!),text:lines.slice(i+1).join('\n')};
  });
}

/** Check delivered files, not just the plan. Image change is a heuristic and is labelled as such. */
export async function inspectRhythmOutputs({timeline,outDir,manifest,ffmpeg='ffmpeg',ffprobe='ffprobe',subtitlePath=null,overwrite=false}:{timeline:EditTimeline;outDir:string;manifest:Record<string,any>;ffmpeg?:string;ffprobe?:string;subtitlePath?:string|null;overwrite?:boolean}) {
  // All recorded relative paths share the same physical root as mediaPath and the release gate.
  outDir=realpathSync(outDir);
  const direction=assertRhythmDirection(timeline);if(!direction)throw new Error('RHYTHM_DIRECTION_REQUIRED');
  const expected:Array<{id:string;path:string;sha256:string;variantId?:string}>=[];
  if(manifest.master?.path)expected.push({id:'master',...manifest.master});
  for(const v of manifest.variants??[])for(const form of ['video','burned','softsub'])if(v[form]?.path)expected.push({id:v.id+':'+form,...v[form],variantId:v.id});
  for(const [i,form] of (manifest.danmaku?.forms??[]).entries())expected.push({id:'danmaku:'+i,path:form.output??form.path,sha256:form.sha256,variantId:form.variantId});
  /** 封面烧封形态是派生件：时长=片头+正片，仍核字节与可解码，但不套正片等时长判据。 */
  for(const [i,form] of (manifest.coverIntro?.forms??[]).entries())expected.push({id:'cover:'+i,path:form.output??form.path,sha256:form.sha256,variantId:form.variantId,derived:true});
  if(!expected.length)throw new Error('RHYTHM_OUTPUT_MISMATCH: 没有实际交付媒体');
  const outputs:Record<string,unknown>[]=[],failures:string[]=[];
  let executionEvidence:unknown=null,subtitleEvidence:unknown=null;
  try{executionEvidence=await verifyRhythmExecution({timeline,outDir,manifest,ffmpeg});}catch(error){failures.push(message(error));}
  if(direction.music)await verifyRhythmMusic(direction.music,ffmpeg,ffprobe);
  if(subtitlePath){
    try{
      await verifyRhythmSubtitle(timeline,subtitlePath);
      const expectedCues=json(subtitlePath+'.rhythm.json').expectedFinalCues as Array<{start:number;end:number;text:string}>;
      const files=(manifest.subtitles?.files??[]).filter((f:{format?:string;lang?:string;path:string})=>(f.format==='srt'||f.path.endsWith('.srt'))&&(!f.lang||['zh','chi','zho'].includes(f.lang)));
      if(!files.length)throw new Error('RHYTHM_SUBTITLE_CHANGED: 缺最终旁挂字幕');
      for(const file of files){const cues=srtCues(mediaPath(outDir,file.path));if(cues.length!==expectedCues.length||cues.some((c,i)=>Math.abs(c.start-expectedCues[i]!.start)>0.025||Math.abs(c.end-expectedCues[i]!.end)>0.025||c.text!==expectedCues[i]!.text))throw new Error('RHYTHM_SUBTITLE_CHANGED: 实际字幕偏离最终时钟');}
      subtitleEvidence={clock:'concat-to-final-once',sourceSha256:await rhythmFileSha256(subtitlePath),cueCount:expectedCues.length,files};
    }catch(error){failures.push(message(error));}
  }
  for(const item of expected){
    try{
      const file=mediaPath(outDir,item.path),before=await rhythmFileSha256(file),media=rhythmMediaFacts(file,ffprobe);
      if(before!==item.sha256||Math.abs(media.fps-timeline.target.fps)>0.01||(!item.derived&&Math.abs(media.videoSeconds-direction.expectedOutputSeconds)>1/media.fps+0.015))throw new Error('最终帧率/时长/字节与节奏合同不符');
      rhythmRun(ffmpeg,['-v','error','-xerror','-nostdin','-i',file,'-map','0:v:0','-map','0:a?','-f','null','-']);
      const regions=direction.regions.map(region=>{const actual=observedCuts(file,region,media.fps,ffmpeg);const cuts=region.cutTimesSeconds.map(time=>({expectedSeconds:time,observedSeconds:actual.reduce<number|null>((best,t)=>best===null||Math.abs(t-time)<Math.abs(best-time)?t:best,null)}));
        return {...region,cuts,advisoryOnly:true,measurement:'decoded-rgb-frame-difference/64x36/threshold6; heuristic'};});
      let musicEvidence:unknown={status:'not_applicable',reason:item.variantId?'未要求音乐卡点':'干净画面母版'};
      if(direction.music&&item.variantId){
        const audioFile=join(outDir,'variants',item.variantId,'audio.json'),audio=json(audioFile),retained=audio.retainedTracks?.find((t:{role:string})=>t.role==='music');
        if(audio.failed||audio.track?.sourceSha256!==direction.music.sha256||!retained||retained.sha256!==direction.music.sha256||await rhythmFileSha256(mediaPath(outDir,retained.path))!==retained.sha256)throw new Error('实际播放音乐已换曲、选段或循环，与测量不符');
        const onsets=detectRhythmOnsets(decodeRhythmAudio(file,ffmpeg,media.videoSeconds)),cuts=direction.regions.flatMap(r=>r.cutTimesSeconds);
        const matched=cuts.map(c=>({cutSeconds:c,nearestOnset:onsets.reduce<number|null>((best,t)=>best===null||Math.abs(t-c)<Math.abs(best-c)?t:best,null)}));
        if(direction.beatSync&&matched.some(m=>m.nearestOnset===null||Math.abs(m.nearestOnset-m.cutSeconds)>0.09))throw new Error('最终混音未测到对应音乐瞬态；调整配乐电平/素材或取消卡点要求');
        musicEvidence={status:direction.beatSync?'measured':'track_verified',musicSha256:retained.sha256,retainedPath:relative(outDir,mediaPath(outDir,retained.path)),audioReportSha256:await rhythmFileSha256(audioFile),matched:direction.beatSync?matched:[],method:METHOD};
      }
      if(await rhythmFileSha256(file)!==before)throw new Error('成片在检查时改变');
      outputs.push({id:item.id,path:relative(outDir,file),sha256:before,passed:true,media,regions,music:musicEvidence});
    }catch(error){const errorText=message(error);outputs.push({id:item.id,path:item.path,passed:false,error:errorText});failures.push(item.id+': '+errorText);}
  }
  for(const source of timeline.sources)if(await rhythmFileSha256(source.path)!==source.sha256)failures.push('源素材改变：'+source.sourceId);
  const report={schemaVersion:'workloom.video-edit/rhythm-output-inspection/v1',passed:failures.length===0,timelineSha256:direction.timelineSha256,decisionSha256:digest(direction),
    direction,executionEvidence,subtitleEvidence,sources:timeline.sources.map(source=>({sourceId:source.sourceId,path:realpathSync(source.path),sha256:source.sha256})),outputs,failures,paidCalls:0,sourcePreserved:failures.every(f=>!f.startsWith('源素材改变')),artisticQuality:'unverified'};
  const file=join(outDir,'rhythm-direction-inspection.json');
  /** 封面/后续步骤按当前交付形态重算回执时允许覆盖同一份检查报告（overwrite=true）。 */
  if(overwrite)writeFileSync(file,JSON.stringify(report,null,2)+'\n');else write(file,report);
  return {report,binding:{path:relative(outDir,file),sha256:await rhythmFileSha256(file),timelineSha256:direction.timelineSha256,passed:report.passed}};
}
