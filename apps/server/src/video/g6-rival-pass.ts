import { splitShotAssertions } from "@hyperreality/video-studio";

const TWO_DISTINCT_RIVALS = /(?:两|二|2)次超(?:车|越)[^；。]{0,20}(?:两|二|2)辆不同(?:的)?对手车/u;
const START_AND_CLEAR = /从(?:对手)?(?:车后(?:方)?|后方)(?:到|至)完全领先/u;
const SECOND_RIVAL = /第二辆(?:不同(?:的)?)?对手车/u;
const RIVAL = /第([一二])辆(?:不同(?:的)?)?对手车/gu;
const FIRST_STAYS_BEHIND = /第一辆(?:已超(?:车|越)(?:的)?|对手)车?(?:继续)?(?:留在|保持在|仍在)后(?:方)?/u;
const HALF_BIKE_ADVANCE = /并排[^；。]{0,12}(?:前移|推进)[^；。]{0,6}半个车身/u;
const FINISH_LINE = /(?:压过|越过|通过)[^；。]{0,14}终点线/u;
const FROM_BEHIND_SECOND = /(?<!并非|不是|未|不)(?:从|追到|贴住|跟在|切入|(?:她|主车|主体)在)第二辆(?:对手)?车?(?:的)?(?:后方|车后|车尾|后轮|后(?=追近|加速|切出|切入))/u;
const CLEAR_SECOND = /(?:^|[。；]|随后|之后|才|并)\s*(?:(?:主车|她|主体)的?)?(?:(?:整车|全车|车尾|车身)(?:已|已经|完整|完全)?(?:越过|超越|超过|脱离|领先于)|(?:整车|全车|车身)完全领先)(?!\s*(?:第一辆|前一辆|其他对手))/u;

function productionText(value: unknown): string {
  if (typeof value !== "string") return "";
  return splitShotAssertions(value).positive.split("；")
    .filter(clause => !/^(?:目的|意图)\s*(?:是|[:：])/u.test(clause.trim())).join("；");
}

/** Diagnose the explicit half-bike-to-finish shortcut only when the current G4 places the second pass in this shot. */
export function approvedSecondPassEndsHalfway(input: {
  frozenBrief: unknown;
  purpose: unknown;
  visualRequirements: readonly unknown[];
  fieldValue: unknown;
}): boolean {
  const frozen = productionText(input.frozenBrief), purpose = productionText(input.purpose);
  if (!TWO_DISTINCT_RIVALS.test(frozen) || !START_AND_CLEAR.test(frozen)
    || !SECOND_RIVAL.test(purpose) || !START_AND_CLEAR.test(purpose) || !/终点线/u.test(purpose)
    || !input.visualRequirements.some((value) => {
      const requirement = productionText(value);
      return SECOND_RIVAL.test(requirement) && START_AND_CLEAR.test(requirement) && FIRST_STAYS_BEHIND.test(requirement);
    })) return false;
  const text = productionText(input.fieldValue);
  const half = HALF_BIKE_ADVANCE.exec(text);
  if (!half) return false;
  const beforeHalf = text.slice(0, half.index);
  const target = [...beforeHalf.replace(FIRST_STAYS_BEHIND, "").matchAll(RIVAL)].at(-1)?.[1];
  if (target !== "二") return false;
  const afterHalf = text.slice(half.index + half[0].length);
  const finish = FINISH_LINE.exec(afterHalf);
  if (!finish) return false;
  return !FROM_BEHIND_SECOND.test(beforeHalf) || !CLEAR_SECOND.test(afterHalf.slice(0, finish.index));
}
