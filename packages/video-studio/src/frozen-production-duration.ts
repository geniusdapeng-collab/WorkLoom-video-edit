import type { FrozenSegmentContract, RequirementRecord } from "./requirement-contract.js";

const timingFailure = (stage: string, message: string): never => {
  throw new Error(`FROZEN_PRODUCTION_TIMING_UNVERIFIED: ${stage}: ${message}`);
};

/** Keep the native screenplay format and replace only instructions that contradict the frozen cuts. */
export function bindFrozenScreenplayPrompt(original: string, contract: FrozenSegmentContract): string {
  const replacements: ReadonlyArray<readonly [RegExp, string]> = [
    [/^5\. 场景时长分配：根据内容重要性、台词长度、视觉复杂度三维度分配$/gm,
      "5. 每个场景使用下方冻结分段合同中的精确 timing；不按内容或台词重分配时长。"],
    [/^3\. 场景数量建议 5-7 个，总时长严格等于 .+ 秒$/gm,
      `3. structure.scenes 必须恰好有 ${contract.count} 项，按下方区间顺序与之一一对应。`],
    [/^5\. 场景时长分配需严格计算，总和必须精确等于.+秒$/gm,
      `5. 每段 ${contract.secondsPerSegment} 秒，硬切衔接，合计 ${contract.totalSeconds} 秒；不可调整、拆分或合并。`],
    [/^□ 删掉任何一个场景，故事都会残缺吗？有删了无所谓的场景就合并。$/gm,
      "□ 每个固定场景是否都保留了该段必需的可见动作和终态？"],
    [/^□ climax 场景时长是否全场最长？$/gm, "□ 高潮是否仅用镜内动作和节奏强化，且没有延长本段？"],
    [/^□ 高潮与结尾之间是否有一个让观众喘气的留白场景？$/gm, "□ 必要的节奏回落是否留在合同允许的现有段内？"],
  ];
  let result = original;
  for (const [marker, replacement] of replacements) {
    if ([...result.matchAll(marker)].length !== 1) timingFailure("script-generator.prompt", "原生时长指令边界发生变化");
    result = result.replace(marker, () => replacement);
  }
  const intervals = contract.intervals.map(({ startSec, endSec, brief }) => ({
    timing: { start: startSec, duration: contract.secondsPerSegment, end: endSec },
    brief,
  }));
  return result + "\n\n## 冻结分段合同（本次已审的硬切与客户执行要求）\n"
    + JSON.stringify(intervals) + "\n逐项使用原 timing；用场景、动作、镜内机位和声场满足区间要求。"
    + "保持区间内动作顺序和跨段起止状态；不得用过场或额外生成段替代。";
}

/** Validate the duration the native consumer will use. Do not repair authored action timing by changing the envelope. */
export function assertFrozenProductionTiming(
  value: unknown,
  contract: FrozenSegmentContract,
  stage: string,
  requireBoundaries: boolean,
): void {
  if (!Array.isArray(value) || value.length !== contract.count) {
    return timingFailure(stage, `须有 ${contract.count} 个按序的正式镜头或剧本场景`);
  }
  const ids = new Set<string>();
  value.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return timingFailure(stage, `区间 ${index + 1} 不是结构化记录`);
    const row = raw as RequirementRecord;
    const id = row.shotId ?? row.shot_id ?? row.scene_id ?? row.sceneId;
    if (typeof id !== "string" || !id.trim() || ids.has(id)) return timingFailure(stage, `区间 ${index + 1} 的镜头 ID 缺失或重复`);
    ids.add(id);
    if (row.timing !== undefined && (!row.timing || typeof row.timing !== "object" || Array.isArray(row.timing))) {
      return timingFailure(stage, `区间 ${index + 1} timing 不是结构化时间`);
    }
    const timing = row.timing as RequirementRecord | undefined;
    const durations = [row.duration, row.duration_sec, timing?.duration].filter(duration => duration !== undefined);
    const expected = contract.intervals[index]!;
    if (!durations.length || durations.some(duration => duration !== contract.secondsPerSegment)
      || ((requireBoundaries || timing?.start !== undefined) && timing?.start !== expected.startSec)
      || ((requireBoundaries || timing?.end !== undefined) && timing?.end !== expected.endSec)) {
      return timingFailure(stage, `区间 ${index + 1} 必须是 ${expected.startSec}–${expected.endSec} 秒（${contract.secondsPerSegment} 秒），不得重新分配`);
    }
  });
}
