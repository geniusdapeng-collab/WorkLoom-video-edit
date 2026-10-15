#!/usr/bin/env tsx
/** Compile understood source ranges + story purpose before subtitles and any media editing. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { compileRhythmDirection, type RhythmAnalysis, type RhythmStory } from '../../packages/video-studio/src/edit/rhythm-director.js';
import { resolveTimelineSourcePaths, validateEditTimeline, type EditTimeline } from '../../packages/video-studio/src/edit/timeline.js';
import { prepareRhythmMusic, preflightRhythmTimeline, rhythmMusicLibraryRoots, assertRhythmOutputOutsideMusicLibraries, assertRhythmFreshWorkspace, claimRhythmWorkspace } from './lib/edit-rhythm-media.mts';

const ROOT=resolve(import.meta.dirname,'../..');
const abs=(file:string)=>isAbsolute(file)?file:resolve(ROOT,file);
const arg=(key:string)=>{const i=process.argv.indexOf(key);return i>=0?process.argv[i+1]:undefined;};
const read=(file:string)=>JSON.parse(readFileSync(file,'utf8'));
async function main() {
  const input=arg('--timeline'),output=arg('--out');
  if(!input||!output)throw new Error('用法：pnpm edit:rhythm -- --timeline draft.json [--story story.json] [--analysis understood.json]… --out compiled.json');
  const source=abs(input),target=abs(output);
  const libraries=rhythmMusicLibraryRoots(ROOT,arg('--bgm-pack')?abs(arg('--bgm-pack')!):undefined);
  assertRhythmOutputOutsideMusicLibraries(target,libraries);
  assertRhythmOutputOutsideMusicLibraries(target+'.assets',libraries);
  if(existsSync(target))throw new Error('RHYTHM_OUTPUT_EXISTS: 使用新的时间轴版本，原文件不覆盖');
  const timeline=resolveTimelineSourcePaths(read(source) as EditTimeline,dirname(source));
  const story:RhythmStory=arg('--story')?read(abs(arg('--story')!)):{};
  const analyses:RhythmAnalysis[]=[];
  const inputFiles=[source,...timeline.sources.map(s=>s.path),...(arg('--story')?[abs(arg('--story')!)]:[])];
  for(let i=0;i<process.argv.length;i++)if(process.argv[i]==='--analysis'){
    const file=process.argv[++i];if(!file||file.startsWith('--'))throw new Error('RHYTHM_DIRECTION_INPUT: --analysis 缺文件');
    inputFiles.push(abs(file));analyses.push(read(abs(file)) as RhythmAnalysis);
  }
  assertRhythmFreshWorkspace(target+'.assets',inputFiles);
  const ffmpeg=process.env.WL_FFMPEG??'ffmpeg',ffprobe=process.env.WL_FFPROBE??'ffprobe';
  // Validate the current bytes and source ranges before creating any music or timeline artifact.
  await preflightRhythmTimeline({timeline,declared:null,profile:'natural',ffprobe});
  claimRhythmWorkspace(target+'.assets');
  const music=await prepareRhythmMusic({story,timeline,outDir:target+'.assets',ffmpeg,ffprobe});
  const compiled=compileRhythmDirection({timeline,story,analyses,...(music?{music}:{})});
  const validation=validateEditTimeline(compiled);
  if(!validation.ok)throw new Error('RHYTHM_DIRECTION_INPUT: '+validation.checks.filter(c=>c.hard&&!c.pass).map(c=>c.detail).join('；'));
  compiled.validation={continuous:true,noSourceOverlap:true,totalDurationSeconds:validation.totalDurationSeconds,generatedBy:'edit:rhythm',checks:validation.checks};
  await preflightRhythmTimeline({timeline:compiled,declared:compiled.rhythmPlan,profile:compiled.rhythmPlan?.profile??'natural',ffprobe});
  mkdirSync(dirname(target),{recursive:true});
  writeFileSync(target,JSON.stringify(compiled,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({ok:true,timeline:target,mode:compiled.rhythmDirection.mode,reasons:compiled.rhythmDirection.reasons,
    regions:compiled.rhythmDirection.regions,outputSeconds:compiled.rhythmDirection.expectedOutputSeconds,paidCalls:0},null,2));
}
main().catch(error=>{console.error('✗ edit-rhythm 失败：'+(error instanceof Error?error.message:String(error)));process.exitCode=1;});
