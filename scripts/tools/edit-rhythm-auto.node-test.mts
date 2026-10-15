import test from 'node:test';
import assert from 'node:assert/strict';
import { planAutoRhythm } from '../../packages/video-studio/src/edit/rhythm-auto.js';
const stamp=(t:number)=>`00:00:${String(t).padStart(2,'0')}.000`;
function fixture() {
  const sources=['a','b'].map((letter,i)=>{
    const sha256=letter.repeat(64),analysis={asset:{sha256,durationSeconds:8,rights:{status:'cleared',declaredUsage:['timeline-source']}},
      shots:[{shotId:'body',inTimecode:stamp(0),outTimecode:stamp(8),quality:{score:0.9}}],probe:{speech:{sentences:[] as Array<{start:number;end:number;text:string}>}}};
    return {sourceId:'src'+i,sha256,path:'/fixture/'+i+'.mp4',fps:30,durationSeconds:8,analysis};
  });
  return {timelineId:'budget',sources,target:{durationSeconds:14,aspectRatio:'16:9',fps:30,platform:'test'}};
}
test('auto fits a feasible original target without extending its band',()=>{
  const x=fixture(),y=planAutoRhythm(x,{story:{rhythm:{mode:'natural'}},analyses:x.sources.map(s=>s.analysis)});
  assert.equal(y.plannedSeconds,14);assert.equal(y.targetSeconds,14);assert.equal(y.timeline.rhythmDirection.expectedOutputSeconds,14);
  assert.deepEqual(y.timeline.segments.map(s=>s.durationSeconds),[8,6]);
});
test('budget fitting keeps an entire final sentence and shortens silent body instead',()=>{
  const x=fixture();x.sources[1]!.analysis.probe.speech.sentences=[{start:0,end:8,text:'完整句子'}];
  const y=planAutoRhythm(x,{story:{rhythm:{mode:'natural'}},analyses:x.sources.map(s=>s.analysis)});
  assert.deepEqual(y.timeline.segments.map(s=>s.durationSeconds),[6,8]);
});
test('impossible protected budget fails rather than cutting a sentence',()=>{
  const x=fixture();for(const s of x.sources)s.analysis.probe.speech.sentences=[{start:0,end:8,text:'完整句子'}];
  assert.throws(()=>planAutoRhythm(x,{story:{rhythm:{mode:'natural'}},analyses:x.sources.map(s=>s.analysis)}),/RHYTHM_DIRECTION_UNAVAILABLE/);
});
function bookends(mustKeep=false) {
  const sha256='a'.repeat(64),ranges=mustKeep?[[0,8],[10,13],[15,18],[20,26],[28,31]]:Array.from({length:8},(_,i)=>[i*5,i*5+3]);
  const analysis={asset:{sha256,durationSeconds:75,rights:{status:'cleared',declaredUsage:['timeline-source']}},shots:ranges.map(([start,end],i)=>({shotId:'shot'+i,inTimecode:stamp(start!),outTimecode:stamp(end!),confidence:0.95,evidence:[{t:start}],quality:{score:1-i*0.01,usable:true},editing:{rhythm:{eligibleFor:['opening','ending'],speechReviewed:true,actionReviewed:true,safeRanges:[{inSeconds:start!,outSeconds:mustKeep&&i===0?1:end!,reason:'安全视觉'}],mustKeep:mustKeep&&i===0?[{inSeconds:5,outSeconds:8,kind:'action' as const,reason:'必须完整动作'}]:[]}}}))};
  const input={timelineId:'bookends',sources:[{sourceId:'src',sha256,path:'/fixture/source.mp4',fps:30,durationSeconds:75,analysis}],target:{durationSeconds:mustKeep?14:11,aspectRatio:'16:9',fps:30,platform:'test'}};
  return {input,analysis};
}
test('reservation never removes a shot containing a required disjoint action',()=>{
  const {input,analysis}=bookends(true);
  const y=planAutoRhythm(input,{analyses:[analysis],story:{rhythm:{mode:'auto',opening:{purpose:'hook',energy:0.9,reason:'进入故事'}}}});
  assert(y.timeline.segments.some(s=>s.sourceIn<=5&&s.sourceOut>=8));
});
test('auto summary uses complete compiled film clock and original target',()=>{
  const {input,analysis}=bookends();
  const y=planAutoRhythm(input,{analyses:[analysis],story:{rhythm:{mode:'auto',opening:{purpose:'hook',energy:0.9,reason:'开场'},ending:{purpose:'recap',energy:0.9,reason:'回收'},durationBand:{minSeconds:6,maxSeconds:11}}}});
  assert.equal(y.timeline.rhythmDirection.mode,'bookends');assert.equal(y.plannedSeconds,y.timeline.rhythmDirection.expectedOutputSeconds);assert.equal(y.targetSeconds,11);
});
