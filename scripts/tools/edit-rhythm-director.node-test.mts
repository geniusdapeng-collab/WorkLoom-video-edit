import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRhythmDirection, assertRhythmDirection, timelineRhythmDigest, mapRhythmCaptionCues } from '../../packages/video-studio/src/edit/rhythm-director.js';
import type { EditTimeline } from '../../packages/video-studio/src/edit/timeline.js';
const sha = 'a'.repeat(64);
export function fixture() {
  const timeline: EditTimeline = { schemaVersion:'workloom.video-edit/edit-timeline/v2',timelineId:'story',target:{durationSeconds:11,aspectRatio:'16:9',fps:30,platform:'test'},
    sources:[{sourceId:'src',sha256:sha,path:'/test/source.mp4',fps:30,durationSeconds:90,hasAudio:true}],
    segments:[{seq:0,segmentId:'body',sourceId:'src',sourceIn:60,sourceOut:64,durationSeconds:4,motive:'完整正文'}, {seq:1,segmentId:'landing',sourceId:'src',sourceIn:70,sourceOut:72,durationSeconds:2,motive:'结尾落版'}],
    audioDesign:{originalAudioPolicy:'keep',bgm:{needed:false}} };
  const analyses = [{asset:{sha256:sha,rights:{status:'cleared',declaredUsage:['timeline-source']}},shots:Array.from({length:8},(_,i)=>({shotId:'shot'+i,inTimecode:'00:00:'+String(i*5).padStart(2,'0')+'.000',outTimecode:'00:00:'+String(i*5+3).padStart(2,'0')+'.000',confidence:0.95,evidence:[{t:i*5}],quality:{score:0.8,usable:true},content:{speechText:null,actions:[]},editing:{rhythm:{eligibleFor:['opening','ending'],speechReviewed:true,actionReviewed:true,safeRanges:[{inSeconds:i*5,outSeconds:i*5+3,reason:'完整可用视觉信息'}],doNotCut:[],mustKeep:[]}}}))}];
  const story = {rhythm:{mode:'auto',opening:{purpose:'hook',energy:0.8,reason:'迅速展示地点'},ending:{purpose:'recap',energy:0.8,reason:'回收视觉高光'},durationBand:{minSeconds:6,maxSeconds:11}}};
  return {timeline,analyses,story};
}
test('auto chooses bookends; body, source 1x and final landing survive',()=>{const x=fixture();const y=compileRhythmDirection(x);assert.equal(y.rhythmDirection.mode,'bookends');assert.equal(y.segments.length,8);assert.deepEqual(y.segments.filter(s=>['body','landing'].includes(s.segmentId)).map(s=>[s.sourceIn,s.sourceOut]),[[60,64],[70,72]]);assert.equal(y.segments.at(-1)?.segmentId,'landing');assertRhythmDirection(y);assert.equal(x.timeline.segments.length,2);});
test('auto opening only when ending reflects',()=>{const x=fixture();x.story.rhythm.ending.purpose='reflection';const y=compileRhythmDirection(x);assert.equal(y.rhythmDirection.mode,'opening');});
test('auto ending only when opening is dialogue',()=>{const x=fixture();x.story.rhythm.opening.purpose='dialogue';assert.equal(compileRhythmDirection(x).rhythmDirection.mode,'ending');});
test('unknown semantic evidence gives natural decision with reasons',()=>{const x=fixture();x.analyses=[];const y=compileRhythmDirection(x);assert.equal(y.rhythmDirection.mode,'natural');assert.deepEqual(y.segments,x.timeline.segments);assert(y.rhythmDirection.reasons.length>0);});
test('explicit natural wins even with energetic story and material',()=>{const x=fixture();x.story.rhythm.mode='natural';assert.equal(compileRhythmDirection(x).rhythmDirection.mode,'natural');});
test('forced mode fails when insufficient safe ranges',()=>{const x=fixture();x.story.rhythm.mode='bookends';x.analyses=[];assert.throws(()=>compileRhythmDirection(x),/RHYTHM_DIRECTION_UNAVAILABLE/);});
test('duration budget never silently expands',()=>{const x=fixture();x.story.rhythm.durationBand.maxSeconds=7;assert.equal(compileRhythmDirection(x).rhythmDirection.mode,'natural');x.story.rhythm.mode='bookends';assert.throws(()=>compileRhythmDirection(x),/RHYTHM_DIRECTION_UNAVAILABLE/);});
test('speech or action not reviewed excludes candidates',()=>{const x=fixture();for(const shot of x.analyses[0]!.shots)shot.editing.rhythm.speechReviewed=false;assert.equal(compileRhythmDirection(x).rhythmDirection.mode,'natural');});
test('hash mismatch, uncertain rights do not become safe material',()=>{const x=fixture();x.analyses[0]!.asset.sha256='b'.repeat(64);assert.equal(compileRhythmDirection(x).rhythmDirection.mode,'natural');x.analyses[0]!.asset.sha256=sha;x.analyses[0]!.asset.rights.status='unknown';assert.equal(compileRhythmDirection(x).rhythmDirection.mode,'natural');});
test('decision invalidates reordered or trimmed actual timeline',()=>{const y=compileRhythmDirection(fixture());[y.segments[0],y.segments[1]]=[y.segments[1]!,y.segments[0]!];assert.throws(()=>assertRhythmDirection(y),/RHYTHM_DIRECTION_CHANGED/);});
test('both ends require local fast segments; fast middle cannot qualify',()=>{const y=compileRhythmDirection(fixture());const first=y.segments.shift()!;y.segments.splice(4,0,first);assert.throws(()=>assertRhythmDirection(y),/RHYTHM_DIRECTION_CHANGED/);});
test('subtitle content hash remains stable on path relocation; timeline changes do not',()=>{const y=compileRhythmDirection(fixture());const old=timelineRhythmDigest(y);y.sources[0]!.path='/relocated/source.mp4';assert.equal(timelineRhythmDigest(y),old);y.segments[0]!.sourceOut+=0.1;assert.notEqual(timelineRhythmDigest(y),old);});
test('caption clock subtracts actual overlap and keeps text',()=>{const x=fixture();x.story.rhythm.mode='natural';x.story.rhythm.durationBand.minSeconds=5;x.timeline.segments[1]!.transitionIn={type:'dissolve',durationSeconds:0.5};const y=compileRhythmDirection(x);const mapped=mapRhythmCaptionCues(y,[{start:4,end:6,text:'落版',segmentId:'landing'}]);assert.equal(mapped[0]!.start,3.5);assert.equal(mapped[0]!.end,5.5);assert.equal(mapped[0]!.text,'落版');});
test('existing speed in natural keeps its timeline without claiming a 1x plan',()=>{const x=fixture();x.timeline.segments[0]!.speed=2;x.timeline.segments[0]!.durationSeconds=2;x.story.rhythm.durationBand.minSeconds=4;const y=compileRhythmDirection(x);assert.equal(y.rhythmDirection.mode,'natural');assert.equal(y.rhythmPlan,null);assertRhythmDirection(y);});
test('malformed transcript cannot silently turn into no speech',()=>{const x=fixture();Object.assign(x.analyses[0]!,{probe:{speech:{sentences:[{start:4,end:2,text:'完整台词'}]}}});assert.throws(()=>compileRhythmDirection(x),/RHYTHM_DIRECTION_INPUT/);});
test('partial protected sentence in original body fails before insertions',()=>{const x=fixture();Object.assign(x.analyses[0]!,{probe:{speech:{sentences:[{start:59,end:62,text:'完整台词'}]}}});assert.throws(()=>compileRhythmDirection(x),/RHYTHM_PROTECTED_CONTENT/);});
test('forced ends cannot steal source ranges already in body',()=>{const x=fixture();x.story.rhythm.mode='bookends';for(const shot of x.analyses[0]!.shots){shot.inTimecode='00:01:00.000';shot.outTimecode='00:01:04.000';shot.evidence=[{t:60}];shot.editing.rhythm.safeRanges=[{inSeconds:60,outSeconds:64,reason:'已在正文'}];}assert.throws(()=>compileRhythmDirection(x),/RHYTHM_DIRECTION_UNAVAILABLE/);});
test('unsafe duplicate analyses fail rather than picking arbitrarily',()=>{const x=fixture();x.analyses.push(x.analyses[0]!);assert.throws(()=>compileRhythmDirection(x),/RHYTHM_DIRECTION_INPUT/);});

import { planAutoCaptions } from '../../packages/video-studio/src/edit/auto-plan.js';
import { analyzeCaption } from '../../packages/video-studio/src/edit/caption.js';
test('auto captions from sentence-only ASR pass their own verbatim check',()=>{const x=fixture();const timeline=compileRhythmDirection(x);const plan=planAutoCaptions({timeline,sources:[{sourceId:'src',analysis:{probe:{speech:{sentences:[{start:60,end:64,text:'走进山里看看风景'},{start:70,end:72,text:'记住此刻'}]}}}}]});const result=analyzeCaption({timeline,caption:plan.captionDoc,transcript:plan.transcript,mode:'talk',allowSilentShots:true});assert.equal(result.ok,true,JSON.stringify(result.issues));});
test('auto multi-source captions isolate equal source timestamps',()=>{const x=fixture();x.timeline.sources.push({...x.timeline.sources[0],sourceId:'second',sha256:'b'.repeat(64)});x.timeline.segments[1]={...x.timeline.segments[1],sourceId:'second',sourceIn:60,sourceOut:62};const plan=planAutoCaptions({timeline:x.timeline,sources:[{sourceId:'src',analysis:{probe:{speech:{sentences:[{start:60,end:64,text:'走进山里看看风景'}]}}}},{sourceId:'second',analysis:{probe:{speech:{sentences:[{start:60,end:62,text:'记住此刻'}]}}}}]});const result=analyzeCaption({timeline:x.timeline,caption:plan.captionDoc,transcript:plan.transcript,mode:'talk',allowSilentShots:true});assert.equal(result.ok,true,JSON.stringify(result.issues));});

test('word-only speech cannot certify an unfinished sentence as a short candidate',()=>{const x=fixture();Object.assign(x.analyses[0],{probe:{speech:{words:[{start:0,end:2,text:'完整台词'}]}}});const y=compileRhythmDirection(x);assert.equal(y.rhythmDirection.mode,'bookends');assert(y.rhythmDirection.selections.every(s=>s.sourceIn>=3));});
test('invalid word timestamps are not treated as silence',()=>{const x=fixture();Object.assign(x.analyses[0],{probe:{speech:{words:[{start:2,end:0,text:'台词'}]}}});assert.throws(()=>compileRhythmDirection(x),/RHYTHM_DIRECTION_INPUT/);});

test('action source clock must intersect its enclosing shot',()=>{
 const x=fixture();Object.assign(x.analyses[0]!.shots[1]!.content,{actions:[{start:1,end:2,what:'误用镜头内偏移'}]});
 assert.throws(()=>compileRhythmDirection(x),/RHYTHM_DIRECTION_INPUT/);
});
test('action may cross shot boundary and remains protected in source clock',()=>{
 const x=fixture();Object.assign(x.analyses[0]!.shots[1]!.content,{actions:[{start:4,end:7,what:'跨镜头完整动作'}]});
 const y=compileRhythmDirection(x);assert.equal(y.rhythmDirection.mode,'bookends');
 assert(y.rhythmDirection.selections.filter(s=>s.shotId==='shot1').every(s=>s.sourceIn>=7));
 assert(y.rhythmDirection.protections.some(p=>p.kind==='action'&&p.inSeconds===4&&p.outSeconds===7));
});

for (const [name,patch] of Object.entries({
  'null mode':{mode:null},'string beat flag':{beatSync:'true'},'null count':{clipCount:null},
  'null clip duration':{clipSeconds:null},'null landing':{minLandingSeconds:null},'null band':{durationBand:null},
  'null end intent':{opening:null},'invalid end purpose':{opening:{purpose:'typo',energy:0.8,reason:'输入错误'}},
  'string energy':{ending:{purpose:'recap',energy:'0.8',reason:'输入错误'}},'null music':{music:null},
  'string repeat flag':{music:{repeat:'true'}},'empty track':{music:{trackId:''}},
  'string music entry':{music:{entrySeconds:'1'}},'negative section':{music:{sectionStartSeconds:-1}},
  'reversed section':{music:{sectionStartSeconds:3,sectionEndSeconds:2}},'unknown rhythm key':{beatSynch:true},
})) test('malformed request rejects '+name,()=>{
  const input=fixture();Object.assign(input.story.rhythm,patch);
  assert.throws(()=>compileRhythmDirection(input),/RHYTHM_DIRECTION_INPUT/);
});
test('null or array story rhythm cannot silently become defaults',()=>{
  for(const story of [null,[],{rhythm:null},{rhythm:[]}])assert.throws(()=>compileRhythmDirection({...fixture(),story:story as any}),/RHYTHM_DIRECTION_INPUT/);
});
