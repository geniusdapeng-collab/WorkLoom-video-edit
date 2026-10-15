/** Reserve evidenced short shots before auto body planning; compile on the original requested duration. */
import { planAutoTimeline, type AutoPlanResult } from './auto-plan.js';
import { compileRhythmDirection, assertRhythmStory, type RhythmStory, type RhythmAnalysis, type RhythmMusic, type DirectedTimeline } from './rhythm-director.js';
import { validateEditTimeline } from './timeline.js';

/** Shorten only unprotected tails. Complete protected intervals remain intact and at 1x. */
function fitBodyBudget(plan: AutoPlanResult, seconds: number, analyses: RhythmAnalysis[], minLanding: number): void {
  const timeline=plan.timeline,fps=timeline.target.fps;
  let excess=timeline.segments.reduce((sum,s)=>sum+s.durationSeconds,0)-seconds;
  for(let index=timeline.segments.length-1;index>=0&&excess>1e-6;index--){
    const segment=timeline.segments[index]!,source=timeline.sources.find(s=>s.sourceId===segment.sourceId)!;
    const analysis=analyses.find(a=>a.asset?.sha256===source.sha256);
    const trusted=analysis?.asset?.rights?.status==='cleared'&&analysis.asset.rights.declaredUsage?.includes('timeline-source');
    const ranges=trusted?[
      ...(analysis.probe?.speech?.sentences??[]).map(p=>({start:p.start!,end:p.end!,required:false})),
      ...(analysis.probe?.speech?.words??[]).map(p=>({start:p.start!,end:p.end!,required:false})),
      ...(analysis.shots??[]).flatMap(shot=>[
        ...(shot.content?.actions??[]).map(p=>({start:p.start!,end:p.end!,required:false})),
        ...(shot.editing?.rhythm?.doNotCut??[]).map(p=>({start:p.inSeconds,end:p.outSeconds,required:false})),
        ...(shot.editing?.rhythm?.mustKeep??[]).map(p=>({start:p.inSeconds,end:p.outSeconds,required:true})),
      ]),
    ].filter(p=>Number.isFinite(p.start)&&Number.isFinite(p.end)&&p.end>p.start):[];
    const minimum=index===timeline.segments.length-1?minLanding:1;
    const lower=ranges.filter(p=>p.required&&p.start>=segment.sourceIn&&p.end<=segment.sourceOut)
      .reduce((value,p)=>Math.max(value,p.end),segment.sourceIn+Math.min(minimum,segment.durationSeconds));
    const ideal=Math.max(lower,segment.sourceOut-excess);
    // Rounding up keeps the tail at least as long as the requested budget; final tolerance is one frame.
    const ends=[ideal,...ranges.map(p=>p.end),segment.sourceOut].map(n=>Math.ceil((n-1e-8)*fps)/fps)
      .filter(n=>n>=ideal-1e-6&&n<=segment.sourceOut+1e-6
        &&!ranges.some(p=>n>p.start+1e-6&&n<p.end-1e-6&&p.end>segment.sourceIn))
      .sort((a,b)=>a-b);
    const end=ends[0];if(end===undefined)continue;
    const removed=segment.sourceOut-end;if(removed<=1e-6)continue;
    segment.sourceOut=Number(end.toFixed(6));segment.durationSeconds=Number((end-segment.sourceIn).toFixed(6));
    const selected=plan.selected.find(s=>s.segmentId===segment.segmentId);
    if(selected){selected.sourceOut=segment.sourceOut;selected.durationSeconds=segment.durationSeconds;selected.reason+='；按原目标时长收尾，保留完整语音和动作';}
    excess-=removed;
  }
}

export function planAutoRhythm(input: Parameters<typeof planAutoTimeline>[0], options: {
  story?: RhythmStory; analyses?: RhythmAnalysis[]; music?: RhythmMusic; bgmNeeded?: boolean;
} = {}): AutoPlanResult & { timeline: DirectedTimeline; reservedSeconds: number } {
  assertRhythmStory(options.story===undefined?{}:options.story);
  const story=options.story??{},request=story.rhythm??{},mode=request.mode??'auto';
  const ends=(['opening','ending'] as const).filter(end=>mode==='bookends'||mode===end||mode==='auto'&&request[end]
    &&request[end]!.energy>=0.6&&(end==='opening'?['hook','preview','action']:['recap','payoff','action']).includes(request[end]!.purpose));
  const count=request.clipCount??3,clipSeconds=request.clipSeconds??0.8;
  const reserved:Record<string,string[]>={},selected=new Set<string>();
  let reservedEnds=0;
  for(const end of ends){
    const candidates=input.sources.flatMap(source=>{
      const analysis=options.analyses?.find(a=>a.asset?.sha256===source.sha256);
      if(analysis?.asset?.rights?.status!=='cleared'||!analysis.asset.rights.declaredUsage?.includes('timeline-source'))return [];
      return (analysis.shots??[]).filter(shot=>shot.shotId&&shot.editing?.rhythm?.eligibleFor?.includes(end)
        &&shot.editing.rhythm.speechReviewed===true&&shot.editing.rhythm.actionReviewed===true
        &&(shot.confidence??0)>=0.7&&shot.quality?.usable!==false&&shot.evidence?.length
        &&shot.editing.rhythm.safeRanges?.some(r=>r.outSeconds-r.inSeconds>=clipSeconds)
        &&!shot.editing.rhythm.mustKeep?.length
        &&!selected.has(source.sourceId+':'+shot.shotId)).map(shot=>({sourceId:source.sourceId,shotId:shot.shotId!,score:shot.quality?.score??0.5}));
    }).sort((a,b)=>b.score-a.score||a.shotId.localeCompare(b.shotId));
    if(candidates.length<count)continue;
    for(const shot of candidates.slice(0,count)){
      (reserved[shot.sourceId]??=[]).push(shot.shotId);selected.add(shot.sourceId+':'+shot.shotId);
    }
    reservedEnds++;
  }
  const reservedSeconds=reservedEnds*count*clipSeconds;
  const band=request.durationBand??{minSeconds:input.target.durationSeconds*0.95,maxSeconds:input.target.durationSeconds*1.05};
  const build=(reserve:boolean)=>{
    const plan=planAutoTimeline({...input,target:{...input.target,durationSeconds:Math.max(1.5,input.target.durationSeconds-(reserve?reservedSeconds:0))},
      ...(reserve?{reservedShotIds:reserved}:{})});
    if(!plan.timeline.segments.length)throw new Error('RHYTHM_DIRECTION_UNAVAILABLE: 预留短镜后没有完整正文');
    fitBodyBudget(plan,input.target.durationSeconds-(reserve?reservedSeconds:0),options.analyses??[],request.minLandingSeconds??1.5);
    plan.timeline.target={...plan.timeline.target,durationSeconds:input.target.durationSeconds,durationBand:band};
    plan.timeline.audioDesign.bgm={needed:options.bgmNeeded??true,style:null,energyCurve:null};
    // The inferred profile is advice; it is not a request to force every shot short.
    const timeline=compileRhythmDirection({timeline:plan.timeline,story,analyses:options.analyses??[],...(options.music?{music:options.music}:{})});
    const validation=validateEditTimeline(timeline);
    if(!validation.ok)throw new Error('RHYTHM_DIRECTION_INPUT: '+validation.checks.filter(c=>c.hard&&!c.pass).map(c=>c.detail).join('；'));
    timeline.validation={continuous:true,noSourceOverlap:true,totalDurationSeconds:validation.totalDurationSeconds,generatedBy:'edit:auto/rhythm',checks:validation.checks};
    return {...plan,timeline,targetSeconds:input.target.durationSeconds,plannedSeconds:timeline.rhythmDirection.expectedOutputSeconds,
      notes:[...plan.notes,'selected 记录正文选镜；新增首尾片段见 rhythmDirection.selections，plannedSeconds 为转场后的全片时长'],reservedSeconds:reserve?reservedSeconds:0};
  };
  if(reservedSeconds>0){
    try {
      const result=build(true);
      if(result.timeline.rhythmDirection.mode!=='natural'||mode!=='auto')return result;
    } catch(error) {
      // Only availability may fall back. Invalid evidence and damaged protection data remain errors.
      if(mode!=='auto'||!(error instanceof Error)||!error.message.startsWith('RHYTHM_DIRECTION_UNAVAILABLE:'))throw error;
    }
  }
  return build(false);
}
