import { splitShotAssertions } from "@hyperreality/video-studio";
import type { SemanticQualityCheck } from "./prompt-quality-gate.js";

const DISMOUNT = /跨下(?:车|摩托)|完全下车|离开车座|下车/u;
const TURN = /转身|转向领奖台/u;
const ASCEND_HIGHEST = /(?:登上?|踏上?|迈上?|走上|跨上|上到)[^，。；、]{0,23}最高(?:一)?级/u;
const TAKE_TROPHY = /(?:取(?:起|下)?|拿(?:起|下)?|拾起|捧起)[^，。；、]{0,18}(?:奖杯|杯)/u;
const REMOVE_HELMET = /(?:抬(?:起|离)?|摘(?:下)?)(?:全|头)?盔|托起(?:全|头)?盔[^；。]{0,8}(?:抬|拔出)/u;
const HELMET_HELD = /(?:[左右]手(?:把|将)?(?:头盔|全盔|盔)夹在(?:腋下|肘侧|肘弯|臂弯)|(?:[左右]手|单手|双手(?:仍|一直))(?:仍|一直)?紧?(?:握住|握着|持着|拿着|提着|托着|抓住)(?:头盔|全盔|盔)|(?:头盔|全盔|盔)(?:落到|留在|夹在|仍在|握在|仍由)[左右]手)/u;
const HELMET_RELEASED = /(?:(?:头盔|全盔|盔)被?(?:放稳|稳放|(?:稳稳)?放(?:在|到)|搁在|置于|挂到|挂在)|(?:放稳|稳放|放下|搁下)(?:头盔|全盔|盔)|(?:头盔|全盔|盔)[^；。]{0,16}(?:夹稳|稳夹|固定)[^；。]{0,16}(?:臂弯|肘弯|腋下)[^。]{0,15}(?:(?:空出|腾出)双手|双手(?:空出|腾空)))/u;
const BOTH_HANDS_ON_TROPHY = /双手[^。；]{0,18}(?:奖杯|举杯|捧杯|托杯|取杯)|(?:奖杯|取杯)；双手(?:托底|托起|举起|捧起)/u;
const DIRECT_NEGATION = /(?:未(?:曾|能)?|不(?:会|应|准备|计划|安排|再|想)?|无须)(?=\s*(?:完全|直接|马上|立刻|立即)?(?:(?:把|将)(?:头盔|全盔|盔))?(?:跨下|下车|转身|登上|踏上|(?:取|拿)(?=[^，。；、]{0,12}杯)|摘盔|抬盔|持着|握住|拿着|放下|放稳|交给|举杯))/gu;
const MOTION_CHAIN = [REMOVE_HELMET, DISMOUNT, ASCEND_HIGHEST, TAKE_TROPHY];
const UNRESOLVED_OPTION = /或者|或(?:把|将|左手|右手|双手|放|夹|挂|置|仍|可|许)|任选|择一/u;
const SINGLE_HAND_POSES = ([["左", "右"], ["右", "左"]] as const).map(([helmet, trophy]) => ({ trophy,
  pattern: new RegExp(`(?:${helmet}手(?:持|握|提|拿)着?(?:全盔|头盔|盔)|${helmet}手(?:把|将)(?:全盔|头盔|盔)夹在(?:肘侧|肘弯|臂弯|腋下)|(?:全盔|头盔|盔)(?:稳夹|夹稳|固定)在${helmet}(?:肘侧|肘弯|臂弯|腋下))[^。]{0,90}${trophy}手(?:(?:举|托|捧)起?(?:奖杯|杯)|取起?[^；。]{0,9}(?:奖杯|杯)[^；。]{0,5}举)`, "u"),
}));
const TIMELINE_DENSITY = "TIMELINE_ACTION_DENSITY_EXCEEDS_DURATION";
const HELMET_HANDOFF = "HELMET_HANDOFF_CONFLICTS_WITH_TROPHY";

function affirmativeMotion(value: unknown): string {
  if (typeof value !== "string") return "";
  return splitShotAssertions(value.replace(DIRECT_NEGATION, "禁止")).positive;
}

function orderedMotion(text: string, steps: readonly RegExp[]): boolean {
  for (const step of steps) {
    const match = step.exec(text);
    if (!match) return false;
    text = text.slice(match.index + match[0].length);
  }
  return true;
}

function localWindows(value: string) {
  const ranges = [...value.matchAll(/(?<![\w:])T?(\d{1,2}):([0-5]\d(?:\.\d+)?)\s*(?:[-–—~～]|至|到)\s*T?(\d{1,2}):([0-5]\d(?:\.\d+)?)(?![\d.])/gu)];
  return ranges.map((range, index) => ({
    from: Number(range[1]) * 60 + Number(range[2]), to: Number(range[3]) * 60 + Number(range[4]),
    text: value.slice(range.index + range[0].length, ranges[index + 1]?.index).split(/(?:目的|意图)\s*[:：]/u, 1)[0]!,
  }));
}

const RIVAL_ORDINAL = /第([一二])辆(?:对手|对方)车?/gu;
const NOSE_ENDS_PASS = /(?:车头|前轮)[^。；\n]{0,18}(?:越过|超过|领先于)[^。；\n]{0,12}(?:对手|对方)(?:的|车)?(?:车头|前轮)\s*(?:(?:后|；\s*(?:随后|随即))\s*回正|；?\s*(?:就|即|形成|取得|标志|完成)[^。；\n]{0,24}?(?:领先|超越|超车))/gu;
const WHOLE_PASS = /(?:^|[。；，,:：]|随后|之后|才|并)\s*(?:(?:她|主车|主体)的?)?(?:(?:整车|全车|车尾)[^。；，,\n]{0,12}(?:越过|超过|脱离)|(?:拉开|领先)(?:了)?(?:一个|一整个)车身)/u;

/** A nose crossing that concludes one named rival's pass cannot borrow a different rival's clearance. */
export function distinctRivalPassEndsAtNose(
  frozenBrief: unknown, value: string, field: "action" | "timeline", duration: number,
): boolean | undefined {
  const approved = affirmativeMotion(frozenBrief);
  if (!/(?:两|二|2)次超(?:车|越)[^。；]{0,20}(?:两|二|2)辆不同(?:的)?对手车/u.test(approved)
    || !/(?:每次|均)(?:由|从)(?:对手)?车后(?:方)?(?:到|至)完全领先/u.test(approved)) return undefined;
  const windows = field === "timeline"
    ? localWindows(value).filter(({ from, to }) => from >= 0 && to > from && to <= duration).map(window => window.text)
    : [value];
  return windows.some((window) => {
    // The shared assertion splitter normalizes commas to semicolons. Preserve
    // original sentence boundaries so an implied rival stays within its event.
    const text = window.split(/[。；\n]/u).map(affirmativeMotion).join("。");
    return [...text.matchAll(NOSE_ENDS_PASS)].some((nose) => {
      const end = nose.index + nose[0].length;
      const context = text.slice(0, end).split("。").at(-1)!;
      const rival = [...context.matchAll(RIVAL_ORDINAL)].at(-1)?.[1];
      if (!rival) return false;
      const after = text.slice(end);
      const nextRival = [...after.matchAll(RIVAL_ORDINAL)].find((match) => match[1] !== rival);
      return !WHOLE_PASS.test(after.slice(0, nextRival?.index));
    });
  });
}

function handoff(value: unknown): "held" | "free" | undefined {
  const text = affirmativeMotion(value);
  const trophy = BOTH_HANDS_ON_TROPHY.exec(text);
  if (!trophy) return undefined;
  const before = text.slice(0, trophy.index);
  const last = (pattern: RegExp) => [...before.matchAll(new RegExp(pattern.source, "gu"))].at(-1)?.index ?? -1;
  const held = last(HELMET_HELD), released = last(HELMET_RELEASED);
  if (released > held && !UNRESOLVED_OPTION.test(before.slice(released))) return "free";
  if (held >= 0) return "held";
  return undefined;
}

function timedAction(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const windows = localWindows(value);
  return windows.length ? windows.map(row => row.text).join("；") : value;
}

function trophyHandWithHelmetSupport(value: unknown): "左" | "右" | undefined {
  const text = affirmativeMotion(value);
  const matches = SINGLE_HAND_POSES.filter(({ pattern }) => {
    const match = pattern.exec(text);
    return !!match && !UNRESOLVED_OPTION.test(match[0]);
  });
  return matches.length === 1 ? matches[0]!.trophy : undefined;
}

export function isApprovedMotionFinding(check: SemanticQualityCheck): boolean {
  return check.failureCode === TIMELINE_DENSITY || check.failureCode === HELMET_HANDOFF;
}

/** Only the same actor's already approved helmet-to-podium action chain authorizes these diagnoses. */
export function approvedMotionObligations(input: {
  frozenBrief: unknown; approvedActions: readonly { actorId?: unknown; description?: unknown }[];
  action: unknown; timeline: unknown; duration: number;
}): SemanticQualityCheck[] {
  const people = input.approvedActions.filter(row => typeof row?.actorId === "string" && row.actorId && !row.actorId.startsWith("$"));
  if (new Set(people.map(row => row.actorId)).size !== 1) return [];
  if (!orderedMotion(affirmativeMotion(input.frozenBrief), MOTION_CHAIN)
    || !orderedMotion(people.map(row => affirmativeMotion(row.description)).join("；"), MOTION_CHAIN)) return [];

  const findings: SemanticQualityCheck[] = [];
  // Restrict the fixed short-window rule to this explicitly ordered four-action chain.
  const dense = typeof input.timeline === "string" && localWindows(input.timeline).find(({ from, to, text }) =>
    to > from && to <= input.duration && to - from < 2 && orderedMotion(affirmativeMotion(text), [DISMOUNT, TURN, ASCEND_HIGHEST, TAKE_TROPHY]));
  if (dense) findings.push({ id: "SQ3_CAMERA_FEASIBLE", pass: false, field: "timeline", failureCode: TIMELINE_DENSITY,
    evidence: `时间轴 ${dense.from}–${dense.to} 秒内连续要求下车、转身、登最高一级并取杯。`,
    repair: "在本镜原有总时长内为完全下车、转身、登上最高一级、自取奖杯留出可拍时间；调整其他非必要停顿，不省略已审动作，不移动切点。" });

  const action = handoff(input.action), timeline = handoff(timedAction(input.timeline));
  for (const [field, state] of [["action", action], ["timeline", timeline]] as const) {
    if (state === "held") findings.push({ id: "SQ2_SCENE_PROPS", pass: false, field, failureCode: HELMET_HANDOFF,
      evidence: "本字段明确写了摘下后仍持盔，接着双手举杯，未交代盔如何稳妥安置或双手如何腾出。",
      repair: "写清从持盔到双手取杯之前的可拍交接，并与另一字段及本镜已审动作顺序一致；不增加角色、段落或总时长。" });
  }
  return findings;
}

/** Keep the exact local clock and the timed, ordered action chain when a diagnosed timeline is rewritten. */
function approvedMotionTimelineRetained(value: unknown, duration: number): boolean {
  if (typeof value !== "string") return false;
  const ranges = localWindows(value);
  return ranges.length > 0 && ranges[0]!.from === 0 && ranges.at(-1)!.to === duration
    && ranges.every(({ from, to }, index) => to > from && (index === 0 || from === ranges[index - 1]!.to))
    && orderedMotion(ranges.map(row => affirmativeMotion(row.text)).join("；"), MOTION_CHAIN);
}

export function approvedMotionRepairDrift(input: {
  findings: readonly SemanticQualityCheck[]; action: unknown; timeline: unknown; duration: number;
  revisedTimeline: boolean; revisedAction: boolean;
}): string | undefined {
  if (input.revisedTimeline && !approvedMotionTimelineRetained(input.timeline, input.duration)) return "APPROVED_MOTION_TIMELINE_REPAIR_DRIFT";
  if (input.revisedAction && !orderedMotion(affirmativeMotion(input.action), MOTION_CHAIN)) return "APPROVED_MOTION_ACTION_REPAIR_DRIFT";
  const timeline = timedAction(input.timeline);
  const actionTrophyHand = trophyHandWithHelmetSupport(input.action), timelineTrophyHand = trophyHandWithHelmetSupport(timeline);
  const missingHandoff = input.findings.some(check => {
    if (check.failureCode !== HELMET_HANDOFF) return false;
    const field = check.field === "action" ? input.action : timeline;
    return handoff(field) !== "free" && !(check.field === "action" ? actionTrophyHand : timelineTrophyHand);
  });
  return missingHandoff || (actionTrophyHand && timelineTrophyHand && actionTrophyHand !== timelineTrophyHand)
    ? "APPROVED_MOTION_HELMET_REPAIR_DRIFT" : undefined;
}
