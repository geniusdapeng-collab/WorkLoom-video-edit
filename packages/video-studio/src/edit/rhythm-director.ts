/** Story-aware bookends. Pure decisions bind real source ranges; media I/O belongs to the CLI. */
import { createHash } from 'node:crypto';
import { computeMasterTimeline, validateEditTimeline, type EditTimeline, type EditTimelineSegment } from './timeline.js';
import { parseTimecode } from './timecode.js';
import { planTransitions } from './transitions.js';
import { auditRhythmPlan, type RhythmPlanInput } from '../rhythm-plan.js';

export const RHYTHM_DIRECTION_SCHEMA = 'workloom.video-edit/rhythm-direction/v1';
export type DirectionMode = 'auto' | 'bookends' | 'opening' | 'ending' | 'natural';
export type RhythmEnd = 'opening' | 'ending';
export interface ProtectedInterval { inSeconds: number; outSeconds: number; kind: 'speech' | 'action'; reason: string }
export interface SafeRhythmRange { inSeconds: number; outSeconds: number; reason: string }
export interface RhythmShotFacts {
  eligibleFor: RhythmEnd[]; speechReviewed: boolean; actionReviewed: boolean;
  safeRanges: SafeRhythmRange[]; doNotCut?: ProtectedInterval[]; mustKeep?: ProtectedInterval[];
}
export interface RhythmAnalysis {
  asset?: { sha256?: string; rights?: { status?: string; declaredUsage?: string[] } };
  probe?: { speech?: { sentences?: Array<{start?:number;end?:number;text?:string}>; words?: Array<{start?:number;end?:number;text?:string}> } };
  shots?: Array<{ shotId?: string; inTimecode?: string; outTimecode?: string; confidence?: number;
    evidence?: Array<{ t?: number; why?: string | null }>; quality?: { usable?: boolean | null; score?: number | null };
    content?: { speechText?: string | null; actions?: Array<{ start?: number | null; end?: number | null; what?: string }> };
    editing?: { rhythm?: RhythmShotFacts } }>;
}
export interface RhythmStory {
  rhythm?: { mode?: DirectionMode; opening?: { purpose: string; energy: number; reason: string };
    ending?: { purpose: string; energy: number; reason: string }; durationBand?: { minSeconds: number; maxSeconds: number };
    clipCount?: number; clipSeconds?: number; minLandingSeconds?: number; beatSync?: boolean;
    music?: { trackId?: string; sectionStartSeconds?: number; sectionEndSeconds?: number; entrySeconds?: number; repeat?: boolean } };
}
export interface RhythmMusic {
  schemaVersion: 'workloom.video-edit/rhythm-music/v1'; path: string; sha256: string; trackId: string;
  durationSeconds: number; onsetTimesSeconds: number[]; method: string;
  source: { path: string; sha256: string; trackId: string; license: string; sectionStartSeconds: number;
    sectionEndSeconds: number; entrySeconds: number; repeat: boolean };
}
export interface RhythmClockEntry { segmentId: string; startSeconds: number; endSeconds: number; overlapSeconds: number; concatStartSeconds: number; concatEndSeconds: number }
export interface RhythmDirection {
  schemaVersion: typeof RHYTHM_DIRECTION_SCHEMA; requestedMode: DirectionMode; mode: Exclude<DirectionMode,'auto'>;
  reasons: string[]; originalTimelineSha256: string; timelineSha256: string; storySha256: string; analysesSha256: string;
  originalSegmentIds: string[]; selections: Array<{ segmentId: string; sourceId: string; shotId: string; end: RhythmEnd; sourceIn: number; sourceOut: number; reason: string }>;
  protections: Array<ProtectedInterval & { sourceId: string; mustKeep: boolean }>;
  durationBand: { minSeconds: number; maxSeconds: number }; clipCount: number; minLandingSeconds: number;
  regions: Array<{ end: RhythmEnd; segmentIds: string[]; startSeconds: number; endSeconds: number; cutTimesSeconds: number[] }>;
  clock: RhythmClockEntry[]; expectedOutputSeconds: number; transitionMode: 'declared';
  beatSync: boolean; music: RhythmMusic | null; artisticQuality: 'unverified';
}
export type DirectedTimeline = EditTimeline & { rhythmDirection: RhythmDirection; rhythmPlan: RhythmPlanInput | null };
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const round = (n: number): number => Number(n.toFixed(6));
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const text = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0;
function fail(code: string, message: string): never { throw new Error(code + ': ' + message); }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Validate JSON callers before defaults or media I/O can conceal malformed requests. */
export function assertRhythmStory(story: unknown): asserts story is RhythmStory {
  const object = (value: unknown, label: string, keys?: string[]): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('RHYTHM_DIRECTION_INPUT', label+' 必须为对象');
    const record=value as Record<string, unknown>;
    if (keys && Object.keys(record).some(key=>!keys.includes(key))) fail('RHYTHM_DIRECTION_INPUT', label+' 含未知字段');
    return record;
  };
  const number = (record: Record<string, unknown>, key: string, min: number, max: number, integer=false) => {
    const value=record[key];
    if (value!==undefined && (!finite(value)||value<min||value>max||integer&&!Number.isInteger(value))) fail('RHYTHM_DIRECTION_INPUT', key+' 数值非法');
  };
  const root=object(story,'story');
  if (root.rhythm===undefined) return;
  const request=object(root.rhythm,'rhythm',['mode','opening','ending','durationBand','clipCount','clipSeconds','minLandingSeconds','beatSync','music']);
  if (request.mode!==undefined && !['auto','bookends','opening','ending','natural'].includes(request.mode as string)) fail('RHYTHM_DIRECTION_INPUT','mode 非法');
  if (request.beatSync!==undefined && typeof request.beatSync!=='boolean') fail('RHYTHM_DIRECTION_INPUT','beatSync 必须为布尔值');
  number(request,'clipCount',2,12,true);number(request,'clipSeconds',0.4,1.2);number(request,'minLandingSeconds',1.5,20);
  for (const end of ['opening','ending']) if (request[end]!==undefined) {
    const intent=object(request[end],end,['purpose','energy','reason']);
    if (!['hook','preview','action','recap','payoff','dialogue','reflection','natural'].includes(intent.purpose as string)
      ||!finite(intent.energy)||intent.energy<0||intent.energy>1||!text(intent.reason)) fail('RHYTHM_DIRECTION_INPUT',end+' 故事目的/能量/理由非法');
  }
  if (request.durationBand!==undefined) {
    const band=object(request.durationBand,'durationBand',['minSeconds','maxSeconds']);
    if (!finite(band.minSeconds)||!finite(band.maxSeconds)||band.minSeconds<=0||band.maxSeconds<band.minSeconds||band.maxSeconds>1800) fail('RHYTHM_DIRECTION_INPUT','时长带非法');
  }
  if (request.music!==undefined) {
    const music=object(request.music,'music',['trackId','sectionStartSeconds','sectionEndSeconds','entrySeconds','repeat']);
    if (music.trackId!==undefined&&!text(music.trackId)) fail('RHYTHM_DIRECTION_INPUT','trackId 不能为空');
    if (music.repeat!==undefined&&typeof music.repeat!=='boolean') fail('RHYTHM_DIRECTION_INPUT','repeat 必须为布尔值');
    number(music,'sectionStartSeconds',0,Number.MAX_VALUE);number(music,'sectionEndSeconds',0,Number.MAX_VALUE);number(music,'entrySeconds',0,Number.MAX_VALUE);
    if (music.sectionEndSeconds!==undefined&&(music.sectionEndSeconds as number)<=(music.sectionStartSeconds as number??0)) fail('RHYTHM_DIRECTION_INPUT','音乐选段必须正向且非空');
  }
}

/** Paths can move; source bytes, output target and complete edits must not change after compilation. */
export function timelineRhythmDigest(timeline: EditTimeline): string {
  const value = clone(timeline) as EditTimeline & { rhythmDirection?: unknown; rhythmPlan?: unknown };
  delete value.rhythmDirection; delete value.rhythmPlan; delete value.validation;
  value.sources = value.sources.map(({ path: _path, ...source }) => ({ ...source, path: '' }));
  return hash(value);
}
export function rhythmOutputClock(timeline: EditTimeline): RhythmClockEntry[] {
  const transitions = planTransitions({ segments: timeline.segments, mode: 'declared', pacing: timeline.pacing, fps: timeline.target.fps });
  const overlaps = new Map(transitions.cuts.map(c => [c.incomingSegmentId,c.durationSeconds]));
  let cursor = 0, concat = 0;
  return timeline.segments.map(s => {
    const overlap = overlaps.get(s.segmentId) ?? 0;
    const start = round(cursor - overlap), duration = (s.sourceOut-s.sourceIn)/(s.speed??1);
    const item = { segmentId:s.segmentId, startSeconds:start, endSeconds:round(start+duration), overlapSeconds:overlap,
      concatStartSeconds:concat, concatEndSeconds:round(concat+duration) };
    cursor=item.endSeconds; concat=item.concatEndSeconds; return item;
  });
}
function intervalValid(r: SafeRhythmRange, limit: number): boolean {
  return !!r && finite(r.inSeconds) && finite(r.outSeconds) && r.inSeconds>=0 && r.outSeconds>r.inSeconds && r.outSeconds<=limit+0.001 && text(r.reason);
}
function protectedValid(r: ProtectedInterval, limit: number): boolean { return intervalValid(r,limit) && ['speech','action'].includes(r.kind); }
function partiallyCuts(start: number, end: number, range: ProtectedInterval): boolean {
  const overlaps = end > range.inSeconds+0.001 && start < range.outSeconds-0.001;
  return overlaps && (start>range.inSeconds+0.001 || end<range.outSeconds-0.001);
}
function assertProtections(timeline: EditTimeline, protections: RhythmDirection['protections']): void {
  for (const p of protections) {
    const segments = timeline.segments.filter(s=>s.sourceId===p.sourceId);
    if (segments.some(s=>partiallyCuts(s.sourceIn,s.sourceOut,p))) fail('RHYTHM_PROTECTED_CONTENT', p.sourceId + ' ' + p.kind + ' ' + p.reason);
    if (p.mustKeep && !segments.some(s=>s.sourceIn<=p.inSeconds+0.001 && s.sourceOut>=p.outSeconds-0.001 && (s.speed??1)===1)) {
      fail('RHYTHM_PROTECTED_CONTENT','必须保留完整区间 ' + p.sourceId + ' ' + p.reason);
    }
  }
}
interface Candidate { sourceId: string; shotId: string; range: SafeRhythmRange; eligibleFor: RhythmEnd[]; score: number; protections: ProtectedInterval[] }
function gather(timeline: EditTimeline, analyses: RhythmAnalysis[]) {
  const candidates: Candidate[] = [], protections: RhythmDirection['protections'] = [], reasons: string[] = [];
  for (const source of timeline.sources) {
    const matches = analyses.filter(a=>a.asset?.sha256===source.sha256);
    if (matches.length>1) fail('RHYTHM_DIRECTION_INPUT','同一素材存在多份理解结果：' + source.sourceId);
    const analysis = matches[0];
    if (!analysis) { reasons.push(source.sourceId+' 没有绑定当前字节的理解结果'); continue; }
    if (analysis.asset?.rights?.status!=='cleared' || !analysis.asset.rights.declaredUsage?.includes('timeline-source')) { reasons.push(source.sourceId+' 未获时间轴使用许可'); continue; }
    const sentences=analysis.probe?.speech?.sentences??[], words=analysis.probe?.speech?.words??[];
    for(const intervals of [sentences,words])if(!Array.isArray(intervals)||intervals.some(s=>!s||!finite(s.start)||!finite(s.end)||s.start<0||s.end<=s.start||finite(source.durationSeconds)&&s.end>source.durationSeconds+0.001)) fail('RHYTHM_DIRECTION_INPUT','语音区间非法：'+source.sourceId);
    const sourceSpeech: ProtectedInterval[] = sentences.map(s=>({inSeconds:s.start!,outSeconds:s.end!,kind:'speech',reason:s.text||'完整台词'}));
    const wordProtections: ProtectedInterval[]=words.map(w=>({inSeconds:w.start!,outSeconds:w.end!,kind:'speech',reason:w.text||'完整词语'}));
    protections.push(...[...sourceSpeech,...wordProtections].map(p=>({...p,sourceId:source.sourceId,mustKeep:false})));
    for (const shot of analysis.shots??[]) {
      const facts = shot.editing?.rhythm;
      if (!facts) continue;
      if (!text(shot.shotId) || !Array.isArray(facts.safeRanges) || !Array.isArray(facts.eligibleFor) || facts.eligibleFor.some(e=>!['opening','ending'].includes(e))) fail('RHYTHM_DIRECTION_INPUT','镜头节奏字段非法');
      let shotIn: number, shotOut: number;
      try { shotIn=parseTimecode(shot.inTimecode!); shotOut=parseTimecode(shot.outTimecode!); } catch { fail('RHYTHM_DIRECTION_INPUT','镜头源时间码缺失或非法：'+shot.shotId); }
      const limit=source.durationSeconds??shotOut!;
      if (shotIn!>=shotOut! || shotOut!>limit+0.001) fail('RHYTHM_DIRECTION_INPUT','镜头越出素材：'+shot.shotId);
      if (facts.doNotCut!==undefined&&!Array.isArray(facts.doNotCut)||facts.mustKeep!==undefined&&!Array.isArray(facts.mustKeep)) fail('RHYTHM_DIRECTION_INPUT','保护区间必须为数组');
      const blocks=[...sourceSpeech.filter(p=>p.outSeconds>shotIn!&&p.inSeconds<shotOut!),...(facts.doNotCut??[]),...(facts.mustKeep??[])];
      for(const range of blocks) if(!protectedValid(range,limit)) fail('RHYTHM_DIRECTION_INPUT','保护区间非法：'+shot.shotId);
      // Existing transcript/action observations remain protective even if the added hint omits them.
      const actions=shot.content?.actions??[];
      const incompleteAction=actions.some(a=>!finite(a.start)||!finite(a.end)||a.end!<=a.start!);
      for(const action of actions) if(finite(action.start)&&finite(action.end)&&action.end>action.start) {
        if(action.end<=shotIn!||action.start>=shotOut!)fail('RHYTHM_DIRECTION_INPUT','动作源时间必须与所属镜头相交：'+shot.shotId);
        blocks.push({inSeconds:action.start,outSeconds:action.end,kind:'action',reason:action.what||'完整动作'});
      }
      for(const range of blocks) if(!protectedValid(range,limit)) fail('RHYTHM_DIRECTION_INPUT','动作/语音区间越界：'+shot.shotId);
      protections.push(...blocks.map(p=>({...p,sourceId:source.sourceId,mustKeep:(facts.mustKeep??[]).includes(p)})));
      const unboundedWords=words.some(w=>w.end!>shotIn!&&w.start!<shotOut!&&!sourceSpeech.some(p=>p.inSeconds<=w.start!&&p.outSeconds>=w.end!));
      const voiceNeedsRange=text(shot.content?.speechText) && !blocks.some(p=>p.kind==='speech');
      if (facts.speechReviewed!==true || facts.actionReviewed!==true || incompleteAction || voiceNeedsRange || unboundedWords || !finite(shot.confidence)||shot.confidence<0.7
        || !shot.evidence?.some(e=>finite(e.t)&&e.t>=shotIn!&&e.t<=shotOut!) || shot.quality?.usable===false) {
        reasons.push(shot.shotId+' 的语音/动作/画面证据不足，不作快切候选'); continue;
      }
      for(const range of facts.safeRanges) {
        if(!intervalValid(range,limit)||range.inSeconds<shotIn!-0.001||range.outSeconds>shotOut!+0.001) fail('RHYTHM_DIRECTION_INPUT','安全区间超出镜头：'+shot.shotId);
        candidates.push({sourceId:source.sourceId,shotId:shot.shotId,range,eligibleFor:facts.eligibleFor,score:finite(shot.quality?.score)?shot.quality.score:0.5,protections:blocks});
      }
    }
  }
  if(candidates.length>1000) fail('RHYTHM_DIRECTION_INPUT','候选超过 1000 个，请按本片素材范围拆分');
  return {candidates:candidates.sort((a,b)=>b.score-a.score||a.shotId.localeCompare(b.shotId)||a.range.inSeconds-b.range.inSeconds),protections,reasons};
}
function validateMusic(music: RhythmMusic | undefined): music is RhythmMusic {
  return !!music && music.schemaVersion==='workloom.video-edit/rhythm-music/v1' && /^[a-f0-9]{64}$/.test(music.sha256) && text(music.path)&&text(music.method)
    && finite(music.durationSeconds)&&music.durationSeconds>0 && Array.isArray(music.onsetTimesSeconds)&&music.onsetTimesSeconds.length>0
    && music.onsetTimesSeconds.every((t,i,a)=>finite(t)&&t>=0&&t<music.durationSeconds&&(i===0||t>a[i-1]!));
}
/** Keep a complete draft body. Choose only unused, evidenced short ranges; no implicit speed changes. */
export function compileRhythmDirection({timeline,story={},analyses=[],music}: {timeline: EditTimeline; story?: RhythmStory; analyses?: RhythmAnalysis[]; music?: RhythmMusic}): DirectedTimeline {
  assertRhythmStory(story);
  if (!timeline || !Array.isArray(timeline.segments) || !timeline.segments.length || !Array.isArray(timeline.sources) || !timeline.sources.length) fail('RHYTHM_DIRECTION_INPUT','需要非空故事时间轴与素材');
  if ((timeline as Partial<DirectedTimeline>).rhythmDirection) fail('RHYTHM_DIRECTION_INPUT','已编译时间轴请从原草稿创建新版本');
  const request=story.rhythm??{}, mode=request.mode??'auto', fps=timeline.target?.fps;
  if(!['auto','bookends','opening','ending','natural'].includes(mode) || !finite(fps)||fps<=0||fps>120) fail('RHYTHM_DIRECTION_INPUT','模式或帧率非法');
  if (new Set(timeline.segments.map(s=>s.segmentId)).size!==timeline.segments.length) fail('RHYTHM_DIRECTION_INPUT','片段编号重复');
  const target=timeline.target.durationSeconds;
  if(!finite(target)||target<=0||target>1800) fail('RHYTHM_DIRECTION_INPUT','请求时长必须在 0–1800 秒内');
  const band=request.durationBand??(timeline.target as EditTimeline['target'] & {durationBand?:RhythmDirection['durationBand']}).durationBand??{minSeconds:round(target*0.95),maxSeconds:round(target*1.05)};
  if(!finite(band.minSeconds)||!finite(band.maxSeconds)||band.minSeconds<=0||band.maxSeconds<band.minSeconds||band.maxSeconds>1800) fail('RHYTHM_DIRECTION_INPUT','时长带非法');
  const count=request.clipCount??3, clipSeconds=request.clipSeconds??0.8, landing=request.minLandingSeconds??1.5;
  /**
   * 短切数量上限 6 → 12（T-2026-1017 产品所有者口径：0.5s 一刀、多排几个镜头，让开场"咔咔咔"起来）。
   * 单刀时长仍是 0.4–1.2s（帧对齐），12 刀 × 0.5s = 6s 上限，不会把开场撑爆。
   */
  if(!Number.isInteger(count)||count<2||count>12||!finite(clipSeconds)||clipSeconds<0.4||clipSeconds>1.2||!finite(landing)||landing<1.5||landing>20) fail('RHYTHM_DIRECTION_INPUT','短镜头数量/长度或落版停留非法');
  if (timeline.segments.length>2000 || timeline.sources.length>1000 || !Array.isArray(analyses) || timeline.segments.some(s=>!finite(s.sourceIn)||s.sourceIn<0||!finite(s.sourceOut)||s.sourceOut<=s.sourceIn||!finite(s.durationSeconds)||s.durationSeconds<=0)) fail('RHYTHM_DIRECTION_INPUT','源区间或项目容量非法');
  const draftValidation=validateEditTimeline({...timeline,target:{...timeline.target,durationBand:undefined,durationSeconds:timeline.segments.reduce((sum,s)=>sum+s.durationSeconds,0)}});
  const draftFailures=draftValidation.checks.filter(c=>c.hard&&!c.pass);
  if(draftFailures.length) fail('RHYTHM_DIRECTION_INPUT',draftFailures.map(c=>c.id+': '+c.detail).join('；'));
  const data=gather(timeline,analyses), reasons=[...data.reasons];
  assertProtections(timeline,data.protections);
  const beats=request.beatSync===true;
  const musicWanted=timeline.audioDesign.bgm?.needed!==false;
  const possibleMusic=!beats||musicWanted&&validateMusic(music);
  if(beats&&!possibleMusic) reasons.push(musicWanted?'没有当前实际音乐的瞬态测量':'用户禁止配乐，不能承诺音乐卡点');
  const endWanted=(end:RhythmEnd) => {
    if(mode==='natural') return false;
    if(mode!=='auto') return mode==='bookends'||mode===end;
    const intent=request[end];
    if(!intent||!finite(intent.energy)||intent.energy<0||intent.energy>1||!text(intent.reason)) { reasons.push(end+' 缺少故事目的和能量依据'); return false; }
    const applicable=(end==='opening'?['hook','preview','action']:['recap','payoff','action']).includes(intent.purpose)&&intent.energy>=0.6;
    if(!applicable) reasons.push(end+' 的故事目标适合自然节奏：'+intent.reason);
    return applicable;
  };
  let opening=endWanted('opening'), ending=endWanted('ending');
  const original=clone(timeline), body=original.segments;
  if(timeline.sourceGapPolicy==='single-take-talking-head'||body.some(s=>(s.speed??1)!==1)) {
    reasons.push('口播单条顺序或现有变速不允许插入蒙太奇'); opening=false; ending=false;
  }
  const last=body.at(-1)!;
  if(last.durationSeconds<landing) { reasons.push('最后镜头不足所需落版停留'); opening=false; ending=false; }
  if(!possibleMusic) {opening=false;ending=false;}
  // A declared crossfade at an insertion boundary is intent, not something to erase silently.
  const nonHard=(s:EditTimelineSegment)=>s.transitionIn&&!['cut','match_cut','jump_cut'].includes(s.transitionIn.type);
  if(opening&&nonHard(body[0]!)) {opening=false;reasons.push('首个正文镜头声明非硬切，保留该意图');}
  if(ending&&nonHard(last)) {ending=false;reasons.push('落版入口声明非硬切，保留该意图');}
  const requestedEnds={opening,ending};
  const attempt=(useOpening:boolean,useEnding:boolean) => {
    const used=body.map(s=>({sourceId:s.sourceId,inSeconds:s.sourceIn,outSeconds:s.sourceOut}));
    const selected:RhythmDirection['selections']=[];
    const make=(end:RhythmEnd,startClock:number):EditTimelineSegment[]|null=>{
      const result:EditTimelineSegment[]=[];let cursor=startClock;
      /** 帧对齐可表示区间：0.4s 与 1.2s 都要落在整数帧上（24fps 下 1.2×24=28.8 → 夹到 28 帧=1.1667s）。 */
      const minFrames=Math.max(1,Math.ceil((0.4-1e-9)*fps));
      const maxFrames=Math.max(minFrames,Math.floor((1.2+1e-9)*fps));
      for(let i=0;i<count;i++) {
        const desired=beats?music!.onsetTimesSeconds.filter(t=>t-cursor>=0.4-0.001&&t-cursor<=1.2+0.001).sort((a,b)=>Math.abs(a-cursor-clipSeconds)-Math.abs(b-cursor-clipSeconds))[0]:cursor+clipSeconds;
        if(desired===undefined)return null;
        /**
         * 帧对齐 bug 修复（T-2026-1017）：旧实现 `Math.round(seconds*fps)` 后直接拿 duration 与
         * `>1.2` 比较——24fps 下请求 1.2s 会取整成 29 帧（1.2083s）而被判非法，整段首尾快切
         * 静默降级为 natural（用户侧只看到"没有快切"，日志里也只有一个原因串）。
         * 现在先把请求帧数夹进 [ceil(0.4fps), floor(1.2fps)]，再换算 duration。
         */
        const frames=Math.min(maxFrames,Math.max(minFrames,Math.round((desired-cursor)*fps))), duration=frames/fps;
        if(duration<0.4-0.001||duration>1.2+0.001)return null;
        let pick:{candidate:Candidate;start:number}|undefined;
        for(const candidate of data.candidates) {
          if(!candidate.eligibleFor.includes(end)||selected.some(s=>s.sourceId===candidate.sourceId&&s.shotId===candidate.shotId))continue;
          // Search frame-aligned safe starts, including after occupied ranges; bounded by each source.
          const starts=[candidate.range.inSeconds,...used.filter(s=>s.sourceId===candidate.sourceId).map(s=>s.outSeconds+1),...candidate.protections.map(p=>p.outSeconds)];
          for(const raw of starts.sort((a,b)=>a-b)) {
            const start=Math.ceil((raw-1e-8)*fps)/fps,endAt=start+duration;
            if(start<candidate.range.inSeconds-1e-7||endAt>candidate.range.outSeconds+1e-7)continue;
            if(used.some(s=>s.sourceId===candidate.sourceId&&!(endAt<=s.inSeconds-1+1e-7||start>=s.outSeconds+1-1e-7)))continue;
            if(candidate.protections.some(p=>partiallyCuts(start,endAt,p)))continue;
            pick={candidate,start};break;
          }
          if(pick)break;
        }
        if(!pick)return null;
        const {candidate,start}=pick,id='rhythm-'+end+'-'+String(i+1).padStart(2,'0');
        if(body.some(s=>s.segmentId===id)) fail('RHYTHM_DIRECTION_INPUT','保留编号冲突：'+id);
        const endAt=round(start+duration);
        const s:EditTimelineSegment={seq:0,segmentId:id,groupId:'rhythm-'+end,sourceId:candidate.sourceId,sourceIn:round(start),sourceOut:endAt,durationSeconds:round(duration),speed:1,
          motive:candidate.range.reason,highlightRef:candidate.shotId,transitionIn:{type:'cut'},audio:{mode:'original'}};
        result.push(s);used.push({sourceId:candidate.sourceId,inSeconds:start,outSeconds:endAt});
        selected.push({segmentId:id,sourceId:s.sourceId,shotId:candidate.shotId,end,sourceIn:s.sourceIn,sourceOut:s.sourceOut,reason:candidate.range.reason});cursor=round(cursor+duration);
      }
      return result;
    };
    const intro=useOpening?make('opening',0):[];if(!intro)return null;
    const partial={...original,segments:[...intro,...body.slice(0,-1)]};
    const endStart=rhythmOutputClock(partial).at(-1)?.endSeconds??0;
    const outro=useEnding?make('ending',endStart):[];if(!outro)return null;
    const segments=[...intro,...body.slice(0,-1),...outro,last].map((s,seq)=>({...s,seq}));
    if(!useOpening&&!useEnding)return {timeline:clone(original),selected:[],clock:rhythmOutputClock(original)};
    const master=computeMasterTimeline(segments);segments.forEach((s,i)=>{s.masterIn=master[i]!.masterIn;s.masterOut=master[i]!.masterOut;});
    const next={...original,segments};return {timeline:next,selected,clock:rhythmOutputClock(next)};
  };
  const combos:Array<[boolean,boolean]> = mode==='auto'
    ? [[opening,ending],...(opening&&ending?[[true,false],[false,true]] as Array<[boolean,boolean]>:[]),[false,false]]
    : [[opening,ending]];
  let compiled:ReturnType<typeof attempt>=null;
  for(const [o,e] of combos) {
    if(mode!=='auto'&&mode!=='natural'&&(!(o||e)||mode==='bookends'&&!(o&&e)||mode==='opening'&&!o||mode==='ending'&&!e))continue;
    const candidate=attempt(o,e);if(!candidate){reasons.push((o&&e?'首尾':o?'开头':'结尾')+' 缺少足够不复用的安全短镜头或实际音乐落点');continue;}
    const duration=candidate.clock.at(-1)?.endSeconds??0;
    if(duration>band.maxSeconds+1/fps||duration<band.minSeconds-1/fps){reasons.push('该选择时长 '+duration+'s 不在请求带 '+band.minSeconds+'–'+band.maxSeconds+'s');continue;}
    if(beats&&(o||e)&&music!.durationSeconds<duration+0.5){reasons.push('测量音乐长度不足以锁定后期播放区间');continue;}
    compiled=candidate;break;
  }
  if(!compiled) fail('RHYTHM_DIRECTION_UNAVAILABLE',reasons.slice(-5).join('；')||'无法满足当前素材、保护与时长要求');
  const has=(end:RhythmEnd)=>compiled!.selected.some(s=>s.end===end);
  const selectedMode=has('opening')?(has('ending')?'bookends':'opening'):(has('ending')?'ending':'natural');
  if(mode==='auto'&&requestedEnds.opening&&requestedEnds.ending&&selectedMode!=='bookends')reasons.push('自动模式按实际素材与时长退为 '+selectedMode);
  reasons.push(selectedMode==='natural'?'保留原故事顺序与节奏':'按故事目的选取 '+selectedMode+'，正文与最终落版保留');
  const result=compiled.timeline as DirectedTimeline;
  (result.target as EditTimeline['target'] & {durationBand:RhythmDirection['durationBand']}).durationBand=clone(band);
  const regions:RhythmDirection['regions']=(['opening','ending'] as const).filter(has).map(end=>{
    const ids=compiled!.selected.filter(s=>s.end===end).map(s=>s.segmentId),entries=compiled!.clock.filter(c=>ids.includes(c.segmentId));
    return {end,segmentIds:ids,startSeconds:entries[0]!.startSeconds,endSeconds:entries.at(-1)!.endSeconds,cutTimesSeconds:entries.map(c=>c.endSeconds)};
  });
  result.rhythmDirection={schemaVersion:RHYTHM_DIRECTION_SCHEMA,requestedMode:mode,mode:selectedMode,reasons,originalTimelineSha256:timelineRhythmDigest(timeline),timelineSha256:timelineRhythmDigest(result),
    storySha256:hash(story),analysesSha256:hash(analyses),originalSegmentIds:body.map(s=>s.segmentId),selections:compiled.selected,protections:data.protections,durationBand:clone(band),
    clipCount:count,minLandingSeconds:landing,regions,clock:compiled.clock,expectedOutputSeconds:compiled.clock.at(-1)!.endSeconds,transitionMode:'declared',
    beatSync:beats&&selectedMode!=='natural',music:musicWanted&&music?clone(music):null,artisticQuality:'unverified'};
  const fastIds=new Set(compiled.selected.map(s=>s.segmentId));
  result.rhythmPlan=result.segments.some(s=>(s.speed??1)!==1)?null:{profile:selectedMode==='natural'?'natural':'fast-cut',segments:result.segments.map(s=>({id:s.segmentId,sourceId:s.sourceId,inSeconds:s.sourceIn,outSeconds:s.sourceOut,
    durationSeconds:s.durationSeconds,role:fastIds.has(s.segmentId)?'fast':s.segmentId===last.segmentId?'breath':'story',cutReason:s.motive||'保留故事正文'}))};
  assertRhythmDirection(result);return result;
}

/** Validate content binding and each requested end, not merely one fast shot anywhere in the film. */
export function assertRhythmDirection(timeline: EditTimeline): RhythmDirection | null {
  const value=(timeline as Partial<DirectedTimeline>).rhythmDirection;
  if(!value)return null;
  if(value.schemaVersion!==RHYTHM_DIRECTION_SCHEMA || timelineRhythmDigest(timeline)!==value.timelineSha256) fail('RHYTHM_DIRECTION_CHANGED','时间轴在节奏编译后已变化，请从草稿重编译字幕和成片');
  const clock=rhythmOutputClock(timeline);
  if(hash(clock)!==hash(value.clock)||Math.abs((clock.at(-1)?.endSeconds??0)-value.expectedOutputSeconds)>0.001)fail('RHYTHM_DIRECTION_CHANGED','最终输出时钟变化');
  const total=value.expectedOutputSeconds;
  if(total<value.durationBand.minSeconds-1/timeline.target.fps||total>value.durationBand.maxSeconds+1/timeline.target.fps)fail('RHYTHM_DIRECTION_CHANGED','不满足请求时长带');
  const original=timeline.segments.filter(s=>value.originalSegmentIds.includes(s.segmentId)).map(s=>s.segmentId);
  if(hash(original)!==hash(value.originalSegmentIds)) fail('RHYTHM_DIRECTION_CHANGED','正文被删除或重排');
  if(value.mode!=='natural') {
    if(timeline.segments.some(s=>(s.speed??1)!==1))fail('RHYTHM_DIRECTION_CHANGED','首尾快切必须 1x');
    if(timeline.segments.at(-1)?.segmentId!==value.originalSegmentIds.at(-1)||timeline.segments.at(-1)!.durationSeconds<value.minLandingSeconds)fail('RHYTHM_DIRECTION_CHANGED','最终落版不足');
  }
  for(const end of ['opening','ending'] as const) {
    const required=value.mode==='bookends'||value.mode===end, region=value.regions.find(r=>r.end===end);
    if(required!==Boolean(region))fail('RHYTHM_DIRECTION_CHANGED','分区缺失或多余');
    if(!region)continue;
    const expectedStart=end==='opening'?0:timeline.segments.length-1-value.clipCount;
    const segments=timeline.segments.slice(expectedStart,expectedStart+value.clipCount);
    if(segments.length!==value.clipCount||hash(segments.map(s=>s.segmentId))!==hash(region.segmentIds)
      ||segments.some(s=>s.durationSeconds<0.4-0.001||s.durationSeconds>1.2+0.001))fail('RHYTHM_DIRECTION_CHANGED',end+' 没有真实连续快切');
    if(region.cutTimesSeconds.some(t=>!clock.some(c=>Math.abs(c.endSeconds-t)<0.001)))fail('RHYTHM_DIRECTION_CHANGED','切点与时钟不符');
  }
  assertProtections(timeline,value.protections);
  if(value.beatSync) {
    if(!validateMusic(value.music??undefined))fail('RHYTHM_MUSIC_CHANGED','缺实际音乐测量');
    for(const t of value.regions.flatMap(r=>r.cutTimesSeconds))if(!value.music!.onsetTimesSeconds.some(beat=>Math.abs(beat-t)<=1/timeline.target.fps+0.012))fail('RHYTHM_MUSIC_CHANGED','真实落点不对齐：'+t);
  }
  const declared=(timeline as Partial<DirectedTimeline>).rhythmPlan;
  if(value.mode==='natural'&&timeline.segments.some(s=>(s.speed??1)!==1)&&declared===null)return value;
  if(!declared||!auditRhythmPlan(declared).pass||declared.segments.length!==timeline.segments.length||declared.segments.some((s,i)=>s.id!==timeline.segments[i]!.segmentId||s.sourceId!==timeline.segments[i]!.sourceId||s.inSeconds!==timeline.segments[i]!.sourceIn||s.outSeconds!==timeline.segments[i]!.sourceOut))fail('RHYTHM_DIRECTION_CHANGED','逐片段节奏合同与时间轴不符');
  return value;
}

/** Captions are authored on the compiled concat clock, then mapped onto actual overlap time. */
export function mapRhythmCaptionCues<T extends {start:number;end:number;segmentId?:string}>(timeline: EditTimeline,cues:T[]):T[] {
  const direction=assertRhythmDirection(timeline);if(!direction)return cues;
  const map=(t:number)=>{
    const entry=[...direction.clock].reverse().find(c=>t+1e-6>=c.concatStartSeconds)??direction.clock[0]!;
    return round(Math.max(0,t-(entry.concatStartSeconds-entry.startSeconds)));
  };
  return cues.map(c=>{const start=map(c.start),end=Math.min(map(c.end),direction.expectedOutputSeconds);if(start<0||end<=start||c.end>direction.clock.at(-1)!.concatEndSeconds+0.05)fail('RHYTHM_SUBTITLE_CHANGED','字幕区间与最终时钟不符');return {...c,start,end};});
}
