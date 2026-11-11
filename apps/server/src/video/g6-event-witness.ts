import { createHash } from "node:crypto";
import { sha256Json, splitShotAssertions } from "@hyperreality/video-studio";
import type { SemanticQualityCheck } from "./prompt-quality-gate.js";
import { completeLocalClock, localWindows } from "./g6-motion-obligations.js";

type EventField = "action" | "timeline" | "camera_movement" | "character_constraint";
type Window = { from: number; to: number };

export interface EventSourceSpan {
  field: string;
  start: number;
  end: number;
  fieldSha256: string;
  fragmentSha256: string;
}

interface EventWitness {
  kind: string;
  side?: string;
  rival?: number;
  source: EventSourceSpan;
  window?: Window;
  cameraComplete?: boolean;
  cameraOnset?: boolean;
}

interface CameraRequirement {
  kind: string;
  complete: boolean;
  onset: boolean;
}

interface RivalRequirement {
  ordinal: number;
  finish: boolean;
  decelerate: boolean;
}

interface ProofScope {
  shotId: string;
  actorId: string;
  duration: number;
  planSha256: string;
  field: EventField;
  sources: EventSourceSpan[];
}

/** Host findings carry original source locations, never model-supplied obligations. */
export type G6EventWitnessProof = ProofScope & (
  | { family: "action-onsets"; required: EventWitness[] }
  | { family: "rival-chain"; rivals: RivalRequirement[]; retainedRivals: number[]; retainedActionEvents: EventWitness[] }
  | { family: "camera-window"; required: CameraRequirement[] }
  | { family: "rival-driver" }
);

interface TextPart {
  text: string;
  start: number;
  window?: Window;
}

interface CurrentScope {
  actorId: string;
  planSha256: string;
  racing: boolean;
  motorcycleRivals: boolean;
  approved: string;
  leadLabels: string[];
  sources: EventSourceSpan[];
  rivals: RivalRequirement[];
  retainedRivals: number[];
}

interface CheckInput {
  approvedProductionPlan: unknown;
  shotId: string;
  duration: number;
  action: unknown;
  timeline: unknown;
  cameraMovement: unknown;
  characterConstraint: unknown;
}

const ONSET_MISSING = "APPROVED_ACTION_EVENT_ONSET_MISSING";
const RIVAL_CHAIN_MISSING = "APPROVED_RIVAL_EVENT_CHAIN_MISSING";
const CAMERA_WINDOW_MISMATCH = "APPROVED_CAMERA_EVENT_WINDOW_MISMATCH";
const DRIVERLESS_RIVAL = "APPROVED_MOVING_RIVAL_DRIVERLESS";
const UNRESOLVED = /如果|假如|假设|或者|任选|择一|或(?:把|将|主车|先|后|由)/u;
const DIRECT_NEGATION = /并非|不是|尚未|未曾|未能|并未|还没|未被|不被|未(?=与|跟|和|达到|进入|形成|齐平|平齐|并排)|不(?:会|曾|能|可|得|应|必|用|需要|要求|再)?(?=(?:完全|已经|已|整车|全车|车尾|车身|把|将)?(?:越过|超越|超过|领先|拧|旋|踏|踩|夹|收|压|抬|摘|脱|下车|登|取|拿|继续|保持|留在|在后|并排|齐平|平齐))/u;
const OTHER_ACTOR = /^(?:第[一二三四五六七八九十\d]+辆(?:对手|对方)车(?:的)?(?:骑手|车手)?|对手(?:车手|骑手)?|对方(?:车手|骑手)?|匿名骑手)/u;
const ORDINAL_TEXT = "[一二三四五六七八九十百零两0-9]+";
const RIVAL_NAME = `第(${ORDINAL_TEXT})辆(?:(?:不同|虚构)(?:的)?)?(?:对手|对方)(?:摩托)?车`;
const RIVAL_PATTERN = new RegExp(RIVAL_NAME, "gu");
const RIVAL_REFERENCE = `第(${ORDINAL_TEXT})辆(?:(?:不同|虚构)(?:的)?)?(?:(?:对手|对方)(?:摩托)?车|车)?`;
const RIVAL_REFERENCE_PATTERN = new RegExp(RIVAL_REFERENCE, "gu");

// Each entry names a bounded physical event. Unknown verbs stay with the native reviewer.
const ONSET_EVENTS = [
  { kind: "throttle-open", pattern: /([左右])?手(?:腕)?(?:拧(?:动|开)?|旋(?:开|动)?|转动)[^。；，,\n]{0,6}油门/gu },
  { kind: "forefoot-support", pattern: /([左右双两])脚(?:的)?前掌(?:踏住|踩住|压住|踏在|踩在)[^。；，,\n]{0,6}脚踏/gu },
  { kind: "heel-clamp", pattern: /([左右双两])?(?:脚)?跟(?:夹紧|夹住|收紧)[^。；，,\n]{0,6}车身/gu },
  { kind: "shoulder-tuck", pattern: /收(?:起|拢)?([左右])?肩/gu },
  { kind: "head-lower", pattern: /(?:把)?头(?:部)?(?:压|收|低)[^。；，,\n]{0,7}风挡(?:的)?下沿/gu },
] as const;

const CAMERA_EVENTS = [
  { kind: "helmet-remove", pattern: /(?:抬(?:起)?|摘(?:下)?)(?:全|头)?盔|脱盔|全盔[^。；，,\n]{0,20}(?:抬起|脱下|摘下|抬离)/gu },
  { kind: "hair-toss", pattern: /甩(?:头|发)/gu },
  { kind: "dismount", pattern: /跨下(?:车|摩托)?|完全下车|离开车座/u },
  { kind: "podium-ascend", pattern: /登(?:上)?(?:领奖台|台)|踏上[^。；，,\n]{0,8}最高(?:一)?级/u },
  { kind: "trophy-take", pattern: /(?:取|拿|拾|捧)(?:起|下)?[^。；，,\n]{0,16}奖杯/u },
  { kind: "brake", pattern: /重刹|前叉(?:明显)?下压/u },
  { kind: "finish-stripe", pattern: /冲线(?:瞬间|时刻)|前轮(?:先)?压线|(?:压过|越过|通过)[^。；，,\n]{0,16}(?:终点线|方格(?:纹|线|旗))/u },
] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function span(field: string, body: string, start = 0, end = body.length): EventSourceSpan {
  return { field, start, end, fieldSha256: hash(body), fragmentSha256: hash(body.slice(start, end)) };
}

/** Keep original offsets while using the existing assertion polarity rules. */
function affirmativeParts(value: unknown, offset = 0): TextPart[] {
  if (typeof value !== "string") return [];
  return [...value.matchAll(/[^。；;，,\n]+/gu)].flatMap(sentence => {
    const separators = [...sentence[0].matchAll(/但是|然而|而是|但|\bbut\b|\binstead\b|并(?:且)?(?=保持|继续|不|禁|避)|且(?=保持|继续|不)/giu)];
    const boundaries = [0, ...separators.map(separator => separator.index + separator[0].length)];
    return boundaries.flatMap((start, index) => {
      const body = sentence[0].slice(start, separators[index]?.index);
      if (UNRESOLVED.test(body) || /^\s*(?:目的|意图)\s*(?:是|[:：])/u.test(body)) return [];
      const direct = DIRECT_NEGATION.exec(body);
      const affirmed = direct ? body.slice(0, direct.index) : body;
      let cursor = 0;
      return splitShotAssertions(affirmed).positive.split("；").filter(Boolean).map(text => {
        const location = affirmed.indexOf(text, cursor);
        cursor = location + text.length;
        return { text, start: offset + sentence.index + start + location };
      });
    });
  });
}

function fieldParts(value: unknown, timed: boolean): TextPart[] {
  if (typeof value !== "string") return [];
  if (!timed) return affirmativeParts(value);
  let cursor = 0;
  return localWindows(value).flatMap(window => {
    const start = value.indexOf(window.text, cursor);
    cursor = start + window.text.length;
    return affirmativeParts(window.text, start).map(part => ({ ...part, window: { from: window.from, to: window.to } }));
  });
}

function ordinal(value: string): number | undefined {
  const normalized = value.normalize("NFKC").replaceAll("两", "二");
  if (/^\d+$/u.test(normalized)) {
    const number = Number(normalized);
    return Number.isSafeInteger(number) && number > 0 ? number : undefined;
  }
  const digits = "零一二三四五六七八九";
  if (/^[一二三四五六七八九]$/u.test(normalized)) return digits.indexOf(normalized);
  const tens = /^([一二三四五六七八九]?)十([一二三四五六七八九]?)$/u.exec(normalized);
  return tens ? (tens[1] ? digits.indexOf(tens[1]) : 1) * 10 + (tens[2] ? digits.indexOf(tens[2]) : 0) : undefined;
}

function namedRivals(text: string): number[] {
  return [...text.matchAll(RIVAL_REFERENCE_PATTERN)].flatMap(match => {
    const number = ordinal(match[1]!);
    return number === undefined ? [] : [number];
  });
}

function activeRivals(value: unknown): number[] {
  return affirmativeParts(value).flatMap(part => {
    const mentions = [...part.text.matchAll(RIVAL_PATTERN)];
    return mentions.flatMap((mention, index) => {
      const before = part.text.slice(index ? mentions[index - 1]!.index + mentions[index - 1]![0].length : 0, mention.index);
      const after = part.text.slice(mention.index + mention[0].length, mentions[index + 1]?.index);
      const moving = /追近|追赶|贴追|超越|超车|连超|并排|车后|后方/u.test(before + after);
      const retained = /已超|已被超/u.test(before) || new RegExp(`^${RETAINED_POSITION}`, "u").test(after);
      const achievesBehind = /先(?:把|让)/u.test(before) && /(?:压到[^。；]{0,4}身后|留在后方)/u.test(after);
      const number = ordinal(mention[1]!);
      return ((moving && !retained) || achievesBehind) && number !== undefined ? [number] : [];
    });
  });
}

function retainedRivals(value: unknown): number[] {
  return affirmativeParts(value).flatMap(part => {
    const mentions = [...part.text.matchAll(RIVAL_REFERENCE_PATTERN)];
    return mentions.flatMap((mention, index) => {
      const after = part.text.slice(mention.index + mention[0].length, mentions[index + 1]?.index);
      const number = ordinal(mention[1]!);
      return new RegExp(`^${RETAINED_POSITION}`, "u").test(after) && number !== undefined ? [number] : [];
    });
  });
}

function currentScope(input: CheckInput): CurrentScope | undefined {
  const plan = record(input.approvedProductionPlan);
  if (!plan || typeof plan.g4ArtifactSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(plan.g4ArtifactSha256)
    || typeof plan.requirementContractHash !== "string" || !/^[a-f0-9]{64}$/u.test(plan.requirementContractHash)
    || !Array.isArray(plan.scenes)) return undefined;
  const scenes: unknown[] = plan.scenes;
  const matches = scenes.filter(value => record(value)?.shotId === input.shotId);
  if (matches.length !== 1) return undefined;
  const scene = record(matches[0]), approvedScene = record(scene?.approvedScene), verification = record(scene?.verificationPlan);
  const interval = record(scene?.interval);
  const actions = approvedScene?.actions;
  if (scene?.sceneId !== input.shotId || !interval || typeof interval.startSec !== "number" || !Number.isFinite(interval.startSec)
    || typeof interval.endSec !== "number" || !Number.isFinite(interval.endSec)
    || interval.startSec < 0 || interval.endSec - interval.startSec !== input.duration || input.duration <= 0
    || typeof interval.brief !== "string" || typeof approvedScene?.purpose !== "string" || !approvedScene.purpose.trim()
    || !Array.isArray(actions) || !Array.isArray(verification?.visualRequirements)) return undefined;
  const rows = actions.map((value: unknown) => record(value));
  if (rows.some(row => typeof row?.actorId !== "string" || !row.actorId || typeof row.description !== "string" || !row.description.trim())) return undefined;
  const people = rows.filter(row => !(row!.actorId as string).startsWith("$"));
  const actors = new Set(people.map(row => row!.actorId as string));
  if (actors.size !== 1) return undefined;
  const actorId = [...actors][0]!;
  const visualRequirements: unknown[] = verification.visualRequirements;
  // The current frozen interval is an authority too. Only its affirmative
  // active-rival statements join this shot's local event scope; global prose
  // about a later pass must not move its finish into the opening shot.
  const intervalAuthority = [...interval.brief.matchAll(/[^。；;\n]+/gu)]
    .filter(statement => activeRivals(statement[0]).length > 0).map(statement => statement[0]);
  const authority = [approvedScene.purpose, ...people.map(row => row!.description), ...visualRequirements, ...intervalAuthority];
  const approvedRaw = authority.filter((value): value is string => typeof value === "string").join("；");
  const approved = affirmativeParts(approvedRaw).map(part => part.text).join("；");
  const racing = /超车|超越|连超|贴身追近|竞速|重刹|压弯/u.test(approved) && /对手|对方|赛车|赛道|摩托/u.test(approved);
  const frozenRaw = scenes.map(value => record(record(value)?.interval)?.brief)
    .filter((value): value is string => typeof value === "string").join("；");
  const frozen = affirmativeParts(frozenRaw).map(part => part.text).join("；");
  const distinct = /(?:不同|分别)[^。；]{0,24}(?:对手|对方)(?:摩托)?车/u.test(frozen);
  const full = /(?:完整|完全)超(?:车|越)|(?:整车|全车)[^。；]{0,12}(?:越过|超越|领先)/u.test(frozen)
    || (/(?:车后|后方)/u.test(frozen) && /完全领先/u.test(frozen));
  const ordinals = [...new Set(authority.flatMap(activeRivals))];
  const retain = [...new Set([interval.brief, ...authority].flatMap(retainedRivals)
    .concat(retainedRivals(frozenRaw).filter(number => ordinals.includes(number))))];
  const leadLabels = ["主车", "主体", "主角", actorId, ...people.flatMap(row => {
    const prefix = /^([^，。；]{1,24}?)(?=从|在|压低|驶入|对|先|停稳|减速|双手|右手|左手|跨下|转身|登|取|拿)/u.exec(row!.description as string)?.[1]?.trim();
    return prefix && !namedRivals(prefix).length && !OTHER_ACTOR.test(prefix) && !/对手|对方|匿名/u.test(prefix) ? [prefix] : [];
  })];
  const finish = /(?:压过|越过|通过)[^。；]{0,20}(?:终点线|方格)/u.test(approved);
  const decelerate = finish && /收油|减速|降速/u.test(approved);
  const index = scenes.indexOf(matches[0]);
  const sources = [span(`approvedProductionPlan.scenes[${index}].approvedScene.purpose`, approvedScene.purpose),
    span(`approvedProductionPlan.scenes[${index}].interval.brief`, interval.brief)];
  for (const [position, row] of rows.entries()) {
    if (row && people.includes(row)) sources.push(span(`approvedProductionPlan.scenes[${index}].approvedScene.actions[${position}].description`, row.description as string));
  }
  for (const [position, value] of visualRequirements.entries()) {
    if (typeof value === "string" && (activeRivals(value).length || retainedRivals(value).length || /完整[^。；]{0,16}超(?:车|越)|完全领先/u.test(value)
      || CAMERA_EVENTS.some(event => new RegExp(event.pattern.source, "u").test(value)))) {
      sources.push(span(`approvedProductionPlan.scenes[${index}].verificationPlan.visualRequirements[${position}]`, value));
    }
  }
  if (distinct && full) {
    for (const [position, value] of scenes.entries()) {
      const brief = record(record(value)?.interval)?.brief;
      if (typeof brief === "string" && brief !== interval.brief
        && (/不同[^。；]{0,24}对手车|完全领先|完整超(?:车|越)/u.test(brief) || retainedRivals(brief).some(number => retain.includes(number)))) {
        sources.push(span(`approvedProductionPlan.scenes[${position}].interval.brief`, brief));
      }
    }
  }
  const props = Array.isArray(approvedScene.props) ? approvedScene.props : [];
  const vehicles = props.flatMap((prop: unknown) => [record(prop)?.name, record(prop)?.description])
    .flatMap(value => affirmativeParts(value).map(part => part.text)).join("；");
  const motorcycleRivals = /摩托|机车/u.test(approved + vehicles) && driverlessSpans(approvedRaw + "；" + frozenRaw).length === 0;
  for (const [position, value] of props.entries()) {
    for (const field of ["name", "description"] as const) {
      const body = record(value)?.[field];
      if (typeof body === "string" && /摩托|机车/u.test(body)) sources.push(span(`approvedProductionPlan.scenes[${index}].approvedScene.props[${position}].${field}`, body));
    }
  }
  return { actorId, planSha256: sha256Json(plan), racing, motorcycleRivals, approved, leadLabels, sources,
    rivals: racing && distinct && full ? ordinals.map(number => ({ ordinal: number, finish, decelerate })) : [],
    retainedRivals: racing && distinct && full ? retain : [] };
}

function onsetWitnesses(value: unknown, field: "action" | "timeline", leadLabels: readonly string[]): EventWitness[] {
  if (typeof value !== "string") return [];
  let leadContext = true;
  return fieldParts(value, field === "timeline").flatMap(part => {
    const inherited = leadContext;
    const candidates = ONSET_EVENTS.flatMap(event => [...part.text.matchAll(new RegExp(event.pattern.source, "gu"))]
      .map(match => ({ event, match }))).sort((left, right) => left.match.index - right.match.index);
    const witnesses = candidates.flatMap(({ event, match }) => {
      return leadContextAfter(part.text.slice(0, match.index), leadLabels, inherited) ? [{
        kind: event.kind, ...(match[1] ? { side: match[1].replace("两", "双") } : {}),
        source: span(field, value, part.start + match.index, part.start + match.index + match[0].length),
        ...(part.window ? { window: part.window } : {}),
      }] : [];
    }) as EventWitness[];
    leadContext = leadContextAfter(part.text, leadLabels, inherited);
    return witnesses;
  }).sort((left, right) => left.source.start - right.source.start);
}

function missingOnsets(required: readonly EventWitness[], actual: readonly EventWitness[]): EventWitness[] {
  let after = -1;
  return required.filter(event => {
    const witness = actual.find(candidate => candidate.source.start > after && candidate.kind === event.kind
      && (event.side === undefined || event.side === candidate.side));
    if (!witness) return true;
    after = witness.source.start;
    return false;
  });
}

const REAR_POSITION = new RegExp(`(?:从|位于|仍在|追到|跟在|贴在|起幅[^。；]{0,6})(?:(?:同一)?${RIVAL_REFERENCE}|(?:同一)?(?:对手|对方)车|前车)(?:的)?[正左右]?(?:后方|车后|车尾|尾流)`, "gu");
const ABREAST = /(?:同向)?并排|(?:车头|前轮)[^。；，,\n]{0,22}(?:齐平|平齐)|轮对轮|贴(?:住|着|近)(?:同一)?(?:对手|对方)车(?:身|侧)/gu;
const CLEARANCE_TARGET = `(?:(?:同一)?${RIVAL_REFERENCE}|(?:同一)?(?:对手|对方)(?:摩托)?车|该(?:辆)?(?:对手)?车|对手|对方)(?:的)?(?:前轮|车头)?`;
const WHOLE_CLEARANCE = new RegExp(`(?:(?:主车|主体|她|他)(?:的)?)?(?:(?:整车|全车|整个车身)(?:(?:已经|已|完整|完全|从侧面)\\s*)*(?:越过|超越|超过|完全领先(?:于)?)|车尾(?:(?:已经|已|完整|完全)\\s*)*(?:越过|超越|超过))(?:${CLEARANCE_TARGET})?`, "gu");
const RIVAL_SUBJECT = new RegExp(`(?:${RIVAL_REFERENCE}|(?:对手|对方)(?:摩托)?车)(?:的)?$`, "u");
const FINISH_CROSSING = /(?:压过|越过|通过|跨过)[^。；，,\n]{0,18}(?:终点线|方格(?:纹|线|旗纹)|涂装)/gu;
const FINAL_DECELERATION = /收油(?:门)?|减速|降速|逐级降挡|速度(?:自然)?收住/gu;
const RETAINED_POSITION = `(?:(?:已|已经)?超(?:车|越))?(?:继续|始终|仍然)?(?:保持在|留在|仍在|在|落到|退到|退至|处于)(?:画面|主车|主体)?(?:的)?后(?:方)?`;
const REMAINS_BEHIND = new RegExp(`(?:${RIVAL_REFERENCE}|${ORDINAL_TEXT}辆(?:被超越的)?(?:对手|对方)车|该(?:辆)?对手车|被超(?:越的)?车辆|对手车|对方车)${RETAINED_POSITION}`, "gu");
const RIVAL_RETURNS_AHEAD = new RegExp(`${RIVAL_REFERENCE}(?:又|再次|重新)?(?:追到|驶到|来到|回到|重返|位于|出现在)(?:主车|主体)?(?:的)?前方`, "gu");
const SUBJECT_BOUNDARY = /随后|之后|以后|然后|接着|同时|并且|后(?!方|轮|视镜)/u;

function leadClearance(match: string, before: string, leadContext: boolean, leadLabels: readonly string[]): boolean {
  const prefix = before.split(SUBJECT_BOUNDARY).at(-1)!.split(/再|并排|并(?:且)?|才|直到/u).at(-1)!.trim();
  const original = before.split(SUBJECT_BOUNDARY).at(-1)!.trim();
  const named = leadLabels.some(label => {
    const suffix = original.endsWith(`${label}的`) ? `${label}的` : original.endsWith(label) ? label : undefined;
    if (!suffix) return false;
    const preceding = original.slice(0, -suffix.length).trim();
    return !preceding || /(?:随后|之后|然后|接着|再|并排|并(?:且)?|才|直到)$/u.test(preceding);
  });
  if (RIVAL_SUBJECT.test(before)) return false;
  if (/^(?:主车|主体)/u.test(match)) return !/的$/u.test(prefix);
  return named || (leadContext && prefix.length === 0);
}

function explicitOtherSubject(text: string, leadLabels: readonly string[]): boolean {
  if (leadLabels.some(label => text.startsWith(label))) return false;
  if (OTHER_ACTOR.test(text)
    || /^[^。；，,\n]{1,20}?(?:骑手|车手)/u.test(text)
    || /^(?:另一|另外|其他|其它|陌生|未知|神秘)[^。；，,\n]{0,12}(?:摩托车|机车|赛车|车辆|汽车)/u.test(text)) return true;
  // An explicit subject before a finite physical predicate replaces an
  // inherited lead even when it has no rider-role suffix. Body parts and
  // camera descriptions keep their ordinary inherited-subject meaning.
  const head = /^([^。；，,\n]{1,16}?)(?=(?:先|正在|正)?(?:从(?:旁边|侧面|另一侧)|驶过|驶入|走过|上前|伸出|抬起|摘下|拧动|旋开))/u.exec(text)?.[1];
  return Boolean(head && !/^(?:她|他)$/u.test(head)
    && !/^(?:[左右双两])?(?:手腕?|脚(?:前掌|跟)?|前轮|车头|车尾|头(?:部)?|整车|全车)/u.test(head)
    && !/镜头|机位|中景|近景|全景|覆盖|跟随|跟住|容纳|侧跟|轻摇|稳框/u.test(head));
}

/** The nearest explicit actor before this event owns it. Body-part clauses
 * inherit their actor; a retained rival position is an object-state witness.
 * All three finite event families use the same bounded clause grammar. */
function leadContextAfter(text: string, leadLabels: readonly string[], inherited: boolean): boolean {
  let lead = inherited;
  for (const value of text.split(SUBJECT_BOUNDARY)) {
    const clause = value.trim();
    if (!clause || new RegExp(REMAINS_BEHIND.source, "u").exec(clause)?.index === 0) continue;
    if (leadLabels.some(label => clause.startsWith(label))) lead = true;
    else if (explicitOtherSubject(clause, leadLabels)) lead = false;
  }
  return lead;
}

function rivalWitnesses(value: unknown, field: "action" | "timeline", rivals: readonly RivalRequirement[],
  retained: readonly number[], leadLabels: readonly string[]): EventWitness[] {
  if (typeof value !== "string") return [];
  let current = rivals.length === 1 ? rivals[0]!.ordinal : undefined;
  let leadContext = true;
  let checkeredSurfaceSeen = false;
  const knownRivals = [...new Set([...rivals.map(requirement => requirement.ordinal), ...retained])];
  return fieldParts(value, field === "timeline").flatMap(part => {
    const inherited = leadContext;
    const mentions = [...part.text.matchAll(RIVAL_REFERENCE_PATTERN)];
    const patterns = [
      ["rear", REAR_POSITION], ["abreast", ABREAST], ["whole-clearance", WHOLE_CLEARANCE],
      ["finish", FINISH_CROSSING], ["decelerate", FINAL_DECELERATION],
      ["remains-behind", REMAINS_BEHIND], ["rival-ahead", RIVAL_RETURNS_AHEAD],
    ] as const;
    const candidates = patterns.flatMap(([kind, pattern]) => [...part.text.matchAll(new RegExp(pattern.source, "gu"))]
      .map(match => ({ kind, match }))).sort((left, right) => left.match.index - right.match.index);
    const witnesses = candidates.flatMap(({ kind, match }) => {
      const before = part.text.slice(0, match.index);
      const eventLead = leadContextAfter(before, leadLabels, inherited);
      if (kind === "whole-clearance") {
        if (!leadClearance(match[0], before, eventLead, leadLabels)
          || /^(?:主车|主体)/u.test(part.text.slice(match.index + match[0].length))) {
          return [];
        }
      }
      if ((kind === "rear" || kind === "abreast" || kind === "finish" || kind === "decelerate") && !eventLead
        && !leadLabels.some(label => before.trim().endsWith(label))) return [];
      if (kind === "finish" && /涂装$/u.test(match[0]) && !checkeredSurfaceSeen
        && !/方格(?:纹|线|旗纹)/u.test(before + match[0])) return [];
      const targets = namedRivals(match[0]);
      const previous = mentions.filter(mention => mention.index < match.index).at(-1);
      const rival = targets[0] ?? (previous ? ordinal(previous[1]!) : current);
      const group = kind === "remains-behind" ? new RegExp(`^(${ORDINAL_TEXT})辆`, "u").exec(match[0]) : null;
      const belongsTo = group ? (ordinal(group[1]!) === knownRivals.length ? knownRivals : []) : rival === undefined ? [] : [rival];
      const source = span(field, value, part.start + match.index, part.start + match.index + match[0].length);
      return (kind === "remains-behind" ? belongsTo : [rival]).map(number => ({ kind,
        ...(number === undefined ? {} : { rival: number }), source, ...(part.window ? { window: part.window } : {}) }));
    });
    leadContext = leadContextAfter(part.text, leadLabels, inherited);
    if (mentions.length) current = ordinal(mentions.at(-1)![1]!);
    checkeredSurfaceSeen ||= /方格(?:纹|线|旗纹)/u.test(part.text);
    return witnesses;
  }).sort((left, right) => left.source.start - right.source.start);
}

function rivalProblems(value: unknown, field: "action" | "timeline", duration: number, requirements: readonly RivalRequirement[],
  retained: readonly number[], leadLabels: readonly string[]): string[] {
  if (field === "timeline" && (typeof value !== "string" || !completeLocalClock(localWindows(value), duration))) return ["完整连续段内时钟"];
  const events = rivalWitnesses(value, field, requirements, retained, leadLabels);
  const problems = requirements.flatMap(requirement => {
    let after = -1;
    const states = ["rear", "abreast", "whole-clearance", ...(requirement.finish ? ["finish"] : []),
      ...(requirement.decelerate ? ["decelerate"] : [])];
    return states.flatMap(kind => {
      const event = events.find(row => row.kind === kind && row.source.start > after
        && (kind === "finish" || kind === "decelerate" || row.rival === requirement.ordinal));
      if (!event) return [`第${requirement.ordinal}辆/${kind}`];
      after = event.source.start;
      return [];
    });
  });
  for (const rival of retained) {
    const requiredPass = requirements.some(requirement => requirement.ordinal === rival);
    const clearance = events.find(event => event.kind === "whole-clearance" && event.rival === rival);
    const after = requiredPass ? clearance?.source.start ?? Infinity : -1;
    if (!events.some(event => event.kind === "remains-behind" && event.rival === rival && event.source.start > after)) {
      problems.push(`第${rival}辆/remains-behind`);
    }
    if (events.some(event => event.rival === rival && event.source.start > after
      && (event.kind === "rival-ahead" || event.kind === "rear"))) problems.push(`第${rival}辆/不再保持在后`);
  }
  return problems;
}

function cameraWitnesses(value: unknown, field: "action" | "timeline" | "camera_movement", leadLabels: readonly string[]): EventWitness[] {
  if (typeof value !== "string") return [];
  let leadContext = true;
  return fieldParts(value, field !== "action").flatMap(part => {
    const inherited = leadContext;
    const witnesses = CAMERA_EVENTS.flatMap(event => [...part.text.matchAll(new RegExp(event.pattern.source, "gu"))].flatMap(match =>
      leadContextAfter(part.text.slice(0, match.index), leadLabels, inherited) ? [{
        kind: event.kind, source: span(field, value, part.start + match.index, part.start + match.index + match[0].length),
        ...(part.window ? { window: part.window } : {}),
        ...(field === "camera_movement" ? {
          cameraComplete: /完整容纳|完整覆盖|覆盖/u.test(part.text),
          cameraOnset: /瞬间|起点|开始/u.test(part.text.slice(Math.max(0, match.index - 4), match.index + match[0].length + 4)),
        } : {}),
      }] : [])) as EventWitness[];
    leadContext = leadContextAfter(part.text, leadLabels, inherited);
    return witnesses;
  });
}

function cameraProblems(camera: unknown, timeline: unknown, duration: number, required: readonly CameraRequirement[],
  leadLabels: readonly string[]): string[] {
  if (typeof camera !== "string" || typeof timeline !== "string"
    || !completeLocalClock(localWindows(camera), duration) || !completeLocalClock(localWindows(timeline), duration)) return ["完整连续段内时钟"];
  const cameraEvents = cameraWitnesses(camera, "camera_movement", leadLabels), timelineEvents = cameraWitnesses(timeline, "timeline", leadLabels);
  return required.filter(({ kind, complete, onset }) => {
    const targets = new Map(timelineEvents.filter(event => event.kind === kind).map(event => [JSON.stringify(event.window), event.window!]));
    const views = new Map(cameraEvents.filter(event => event.kind === kind).map(event => [JSON.stringify(event.window), event.window!]));
    if (targets.size !== 1 || views.size !== 1) return true;
    const target = [...targets.values()][0]!, view = [...views.values()][0]!;
    const current = cameraEvents.filter(event => event.kind === kind);
    const coversWhole = complete || current.some(event => event.cameraComplete);
    const anchorsOnset = onset || current.some(event => event.cameraOnset);
    return view.to <= target.from || view.from >= target.to
      || (coversWhole && (view.from > target.from || view.to < target.to))
      || (anchorsOnset && view.from < target.from);
  }).map(requirement => requirement.kind);
}

function driverlessSpans(value: unknown): EventSourceSpan[] {
  if (typeof value !== "string") return [];
  return [...value.matchAll(/[^。；;，,\n]+/gu)].flatMap(part => {
    if (!/(?:对手|对方)(?:摩托)?车/u.test(part[0]) || UNRESOLVED.test(part[0])) return [];
    const markers = [...part[0].matchAll(/无人(?:驾驶|空车)?|无驾驶员|空车/gu)];
    // "无人" describes the vehicle here. Mask that noun without moving offsets
    // so the shared polarity splitter still sees actual prohibitions around it.
    const masked = part[0].replace(/无人(?:驾驶|空车)?|无驾驶员|空车/gu, match => "驾".repeat(match.length))
      .replace(/不可|不应|并非|不是|拒绝|防止|不允许/gu, match => "禁止" + " ".repeat(match.length - 2))
      .replace(/并且|而且|且/gu, match => "；" + " ".repeat(match.length - 1));
    const positive = affirmativeParts(masked, part.index);
    return markers.flatMap(match => {
      const start = part.index + match.index;
      if (!positive.some(segment => start >= segment.start && start + match[0].length <= segment.start + segment.text.length)) return [];
      return [span("character_constraint", value, start, start + match[0].length)];
    });
  });
}

function finding(input: CheckInput, scope: CurrentScope, field: EventField, family: G6EventWitnessProof["family"],
  code: string, evidence: string, repair: string, extra: Record<string, unknown>): SemanticQualityCheck {
  const value = field === "camera_movement" ? input.cameraMovement : field === "character_constraint" ? input.characterConstraint : input[field];
  const sources = [...scope.sources, ...(typeof value === "string" ? [span(field, value)] : [])];
  const proof = { shotId: input.shotId, actorId: scope.actorId, duration: input.duration, planSha256: scope.planSha256,
    field, family, sources, ...extra } as G6EventWitnessProof;
  return { id: field === "camera_movement" ? "SQ3_CAMERA_FEASIBLE" : field === "timeline" ? "SQ2_SCENE_PROPS" : "SQ1_SUBJECT_ACTION",
    pass: false, field, failureCode: code, evidence, repair, eventWitness: proof };
}

export function g6EventWitnessChecks(input: CheckInput): SemanticQualityCheck[] {
  const scope = currentScope(input);
  if (!scope) return [];
  const findings: SemanticQualityCheck[] = [];
  if (scope.racing) {
    const required = onsetWitnesses(input.action, "action", scope.leadLabels);
    const absent = missingOnsets(required, onsetWitnesses(input.timeline, "timeline", scope.leadLabels));
    const clock = typeof input.timeline === "string" && completeLocalClock(localWindows(input.timeline), input.duration);
    if (required.length && (absent.length || !clock)) findings.push(finding(input, scope, "timeline", "action-onsets", ONSET_MISSING,
      `同版 action 的起点事件未按序落实在完整时间轴中：${(absent.length ? absent : required).map(event => `${event.kind}@action[${event.source.start},${event.source.end})`).join("、")}。`,
      "用 T00:00–T00:xx 等显式区间从头到尾无缝覆盖本镜总时长，并按 action 原顺序补齐这些动作起点与过程；保留同一演员、身体侧别及已有超车、道具和切点。孤立时点、缺口、重叠或越界时间都不能替代时间轴。action 不得删去原事件来规避时间轴义务。", { required }));
    for (const field of ["action", "timeline"] as const) {
      const problems = rivalProblems(input[field], field, input.duration, scope.rivals, scope.retainedRivals, scope.leadLabels);
      if ((scope.rivals.length || scope.retainedRivals.length) && problems.length) findings.push(finding(input, scope, field, "rival-chain", RIVAL_CHAIN_MISSING,
        `当前冻结计划与本镜已审对手身份要求完整可见事件链，本字段缺少有序见证：${problems.join("、")}。`,
        "只在本字段按同一对手写清从后方追近、同向并排、主车车尾完整越过该对手前轮及保持领先；已超对手按冻结要求继续在后，不能重回前方或重新从其后超一次。有已审冲线时，整车越过之后才压过终点线，再收油减速。画外、车头交叉和完成标签不能代替整车过程。保持原时长、方向、对手身份与切点。",
        { rivals: scope.rivals, retainedRivals: scope.retainedRivals, retainedActionEvents: required }));
    }
    const driverless = driverlessSpans(input.characterConstraint);
    if (scope.motorcycleRivals && scope.rivals.length && driverless.length) findings.push(finding(input, scope, "character_constraint", "rival-driver", DRIVERLESS_RIVAL,
      `同版角色约束把正常移动对手车写为无人空车：${driverless.map(source => `character_constraint[${source.start},${source.end})`).join("、")}。`,
      "保留唯一命名主角及其现有引用；对手摩托车由匿名成年全盔骑手正常驾驶，不新增命名身份或主角副本。禁止无人空车，不改其它字段。",
      { sources: [...scope.sources, ...driverless] }));
  }
  const approvedKinds = new Set(cameraWitnesses(scope.approved, "action", scope.leadLabels).map(event => event.kind));
  const cameraEvents = cameraWitnesses(input.cameraMovement, "camera_movement", scope.leadLabels).filter(event => approvedKinds.has(event.kind));
  const requiredCamera = [...new Set(cameraEvents.map(event => event.kind))].map(kind => ({ kind,
    complete: cameraEvents.some(event => event.kind === kind && event.cameraComplete),
    onset: cameraEvents.some(event => event.kind === kind && event.cameraOnset),
  }));
  if (requiredCamera.length && cameraProblems(input.cameraMovement, input.timeline, input.duration, requiredCamera, scope.leadLabels).length) {
    findings.push(finding(input, scope, "camera_movement", "camera-window", CAMERA_WINDOW_MISMATCH,
      `当前运镜的已审事件窗口与同版时间轴不相容：${requiredCamera.map(event => event.kind).join("、")}。`,
      "保留已审机位与事件，按同一动作实际时间窗安排覆盖和跟随；完整覆盖不能漏掉事件起止，后续稳框可继续容纳下一动作，不提前跟随尚未开始的动作。保持本镜总时长和切点。",
      { required: requiredCamera, sources: [...scope.sources, ...cameraEvents.map(event => event.source),
        ...(typeof input.timeline === "string" ? [span("timeline", input.timeline)] : [])] }));
  }
  return findings;
}

/** Recheck the original host obligations before accepting the only field repair. */
export function g6EventWitnessRepairDrift(input: CheckInput, proofs: readonly G6EventWitnessProof[]): boolean {
  const scope = currentScope(input);
  return proofs.some(proof => {
    if (!scope || proof.shotId !== input.shotId || proof.actorId !== scope.actorId
      || proof.duration !== input.duration || proof.planSha256 !== scope.planSha256) return true;
    if (proof.family === "action-onsets") return missingOnsets(proof.required, onsetWitnesses(input.action, "action", scope.leadLabels)).length > 0
      || typeof input.timeline !== "string" || !completeLocalClock(localWindows(input.timeline), input.duration)
      || missingOnsets(proof.required, onsetWitnesses(input.timeline, "timeline", scope.leadLabels)).length > 0;
    if (proof.family === "rival-chain") return missingOnsets(proof.retainedActionEvents, onsetWitnesses(input.action, "action", scope.leadLabels)).length > 0
      || rivalProblems(input[proof.field as "action" | "timeline"], proof.field as "action" | "timeline", input.duration,
        proof.rivals, proof.retainedRivals, scope.leadLabels).length > 0;
    if (proof.family === "camera-window") return cameraProblems(input.cameraMovement, input.timeline, input.duration, proof.required, scope.leadLabels).length > 0;
    return driverlessSpans(input.characterConstraint).length > 0;
  });
}
