/**
 * 硬闸口径规则内核（纯函数，无副作用）：T-2026-0930-0015。
 *
 * 纪律（产品所有者 2026-09-30 口径）：**硬闸只允许"事实类"**——
 * 产物存在 / 时长 / 分辨率 / 音轨 / 音画对齐 / 字幕文件 / 命名 / 授权与素材用途 / 生成溯源。
 * "够不够好看、够不够热闹、片型配比、造型主色"这类**创作与审美口径**不得作出厂否决票：
 * 真机事故就是"渲出来 → 判不合格 → 再渲"，把客户的模型额度烧光还没出片。
 *
 * 本文件只做一件事：在 CI 里拦住"把创作口径写成 hard: true"的改动。
 */

/** 创作/审美口径的检查 id 清单（命中且 hard: true 即违规） */
export const CREATIVE_CHECK_IDS = [
  "motion-richness",
  "speed-ramp",
  "motion-budget",
  "scene-policy",
  "scene-policy-prompt",
  "character-consistency",
  "style-variant",
  "aesthetic",
  "beauty",
];

const HARD_TRUE_RE = /hard:\s*true/;
const ID_RE = /id:\s*[`"']([A-Za-z0-9_:${}.-]+)[`"']/g;
/** 检查对象在源码里的宽度：id 之后多少行内出现 hard: true 视为同一条检查 */
const CHECK_WINDOW_LINES = 12;

/**
 * 扫描一个源码文件，返回违规清单。
 * @param {string} source 文件全文
 * @param {{ file?: string }} [options]
 * @returns {Array<{ file: string; line: number; id: string; detail: string }>}
 */
export function scanHardGatePolicy(source, options = {}) {
  const file = options.file ?? "(source)";
  const lines = String(source).split("\n");
  const violations = [];
  for (let index = 0; index < lines.length; index += 1) {
    /** 以 `hard: true` 为锚点向前看：一条检查对象里 id 在 hard 之前，向后扫会重复计数 */
    if (!HARD_TRUE_RE.test(lines[index])) continue;
    const text = lines.slice(Math.max(0, index - CHECK_WINDOW_LINES), index + 1).join("\n");
    ID_RE.lastIndex = 0;
    let match;
    /**
     * 归因规则：只看**紧邻 hard 之前的那一条 id**。
     * 反例（误报来源）：多行检查对象 `{ id: "duration", pass: ...,  \n hard: true }` 的 hard 行
     * 往前 12 行会先扫到上一条 `scene-policy`——若按"窗口内出现过"归因就会误伤。
     */
    let lastId = null;
    while ((match = ID_RE.exec(text)) !== null) {
      lastId = match[1];
    }
    const hitId = lastId && CREATIVE_CHECK_IDS.includes(lastId.split(":")[0]) ? lastId : null;
    if (!hitId) continue;
    violations.push({
      file,
      line: index + 1,
      id: hitId,
      detail: `检查「${hitId}」被标成 hard: true（创作/审美口径不得作出厂否决票）`
    });
  }
  return violations;
}

/** 违规说明（给 CI 日志用） */
export function describeViolations(violations) {
  if (violations.length === 0) return "";
  return [
    "创作口径硬闸违规（T-2026-0930-0015）：硬闸只允许事实类",
    "（产物存在/时长/分辨率/音轨/音画对齐/字幕文件/命名/授权与素材用途/生成溯源）。",
    ...violations.map((entry) => `  · ${entry.file}:${entry.line} — ${entry.detail}`),
    "修法：把该项改成 hard: false（降为咨询项，质量交客户验收），或在事前闸里拦（红线 linter / 合同字段 / 就绪度门）。"
  ].join("\n");
}
