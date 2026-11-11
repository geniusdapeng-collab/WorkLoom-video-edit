/**
 * prompt-redlines —— 花钱前的"提示词红线"linter（T-2026-0929-0008）
 *
 * 目标：**提高一次过率**。真机 2026-09-29 的每一次重渲，都对应一条可以提前写死在卡片里的红线：
 *   · 机器屏幕出现可读界面文字/LOGO（FP-02）
 *   · 身份证卡面出现可辨认字样与号码（FP-04，还涉及隐私）
 *   · 末帧多出"幻影道具"（同镜多出一张卡片）
 *   · timeline 说"定住"，运镜却继续推进（落幅漂移）
 *   · 卡片约束帧率与管线帧率不一致（24 vs 30）
 *   · 玻璃/落地窗镜头冒出"第二张脸"（镜像）
 * 这些都不是"审美问题"，而是**可枚举、可提前拦**的；拦在提交之前，一次就省一镜渲染。
 */
import { inspectBulletTimeMotion, type BulletTimeCapabilities } from "./bullet-time.js";

export const PROMPT_REDLINE_POLICY_VERSION = "workloom.prompt-redlines/v2" as const;

export interface RedlineIssue { id: string; detail: string; why: string; hard: boolean }

export interface RedlineShotLike {
  shotId?: string;
  scene?: unknown; sceneDescription?: unknown; action?: unknown; props?: unknown; negative?: unknown;
  composition?: unknown; camera_movement?: unknown; timeline?: unknown; constraint?: unknown;
  fields?: unknown; prompt?: unknown;
  [key: string]: unknown;
}


/**
 * 只保留"肯定画面描述"（与仓库其它审计同一纪律：先剥否定语境）。
 * 真机 2026-09-29：卡片写"屏幕背对镜头、不可见""画面不出现证件"时，
 * 旧版 linter 仍按关键词触发风险，反而把**已经规避了风险**的卡片拦下。
 */
function positiveOnly(value: string): string {
  return value
    .split(/[；。，、]/)
    .filter((clause) => clause.trim().length > 0)
    .filter((clause) => !/(不出现|不可见|不露|无需|不得|禁止|避免|无[^，。；]*|没有)/.test(clause))
    .join("；");
}
const text = (value: unknown): string => String(value ?? "");
const allText = (shot: RedlineShotLike, keys: string[]): string => {
  const nested = shot.fields && typeof shot.fields === "object" && !Array.isArray(shot.fields)
    ? shot.fields as Record<string, unknown>
    : {};
  return keys.flatMap((key) => [shot[key], nested[key]]).map(text).filter(Boolean).join("；");
};

export function auditShotRedlines(shot: RedlineShotLike, options: {
  fps?: number; aspect?: string; bulletTimeCapabilities?: BulletTimeCapabilities;
} = {}): RedlineIssue[] {
  const issues: RedlineIssue[] = [];
  const add = (id: string, detail: string, why: string, hard = true): void => { issues.push({ id, detail, why, hard }); };
  const visual = positiveOnly(allText(shot, ["scene", "sceneDescription", "composition", "action", "props", "prompt"]));
  const negative = allText(shot, ["negative"]);
  const camera = allText(shot, ["camera_movement"]);
  const timeline = allText(shot, ["timeline"]);

  // ① 屏幕文字：出现屏幕就必须写明"虚化/不可辨认/光晕"，并把文字与 LOGO 放进负面清单
  if (/屏幕|触控|显示|界面/.test(visual) && !/(背对|不可见|不朝镜头)/.test(allText(shot, ["sceneDescription","composition"]))) {
    if (!/(虚化|不可辨|光晕|过曝成色块|不出现任何可读)/.test(visual)) {
      add("screen-must-be-blurred", `${shot.shotId}：画面含屏幕，但没有写「界面虚化/不可辨认/只保留柔光光晕」`, "模型默认会把界面渲染成可读文字（FP-02 真机返修）");
    }
    if (!/无界面文字|无屏幕可读文字|无可读文字/.test(negative)) {
      add("screen-no-text-negative", `${shot.shotId}：负面清单缺「无界面文字/无屏幕可读文字」`, "屏幕文字是平台红线，必须在负面清单显式排除");
    }
    if (!/无图标|无LOGO|无品牌LOGO/.test(negative)) {
      add("screen-no-logo-negative", `${shot.shotId}：负面清单缺「无图标/无 LOGO」`, "FP-02 真机出现 LOGO 色块被判不合格");
    }
  }
  // ② 证件/单据文字：出现证件必须"不可辨认"，且负面显式排除字迹与号码（隐私红线）
  if (/身份证|证件|卡面|护照|票据|单据|合同|菜单|书页/.test(visual)) {
    if (!/(不可辨|背面朝上|无字迹|不出现任何可辨)/.test(visual)) {
      add("document-must-be-unreadable", `${shot.shotId}：画面含证件/单据类道具，但没有写「不可辨认/背面朝上/无字迹」`, "证件文字既是审核红线也涉及隐私（FP-04 真机返修）");
    }
    if (!/无证件文字|无可辨认号码|无号码/.test(negative)) {
      add("document-no-text-negative", `${shot.shotId}：负面清单缺「无证件文字/无可辨认号码」`, "隐私与审核红线必须显式排除");
    }
  }
  // ③ 卡片类道具：明确"只有一张/无多余"，避免幻影道具
  if (/房卡|卡片|身份证/.test(visual) && !/无多余卡片|无多余道具|只出现一张/.test(negative)) {
    add("prop-duplication", `${shot.shotId}：含卡片类道具但未约束数量`, "FP-04 真机末帧多出一枚卡片状物件（幻影道具）");
  }
  // ④ 运镜与时间轴一致性：timeline 说定住，运镜必须写定住
  if (/定住|稳住|定格/.test(timeline) && !/定住|稳住|定格/.test(camera)) {
    const bulletTime = inspectBulletTimeMotion(shot, options.bulletTimeCapabilities);
    if (bulletTime.enabled && bulletTime.motionException) {
      // A valid bullet-time contract separates subject time from camera time.
    } else if (bulletTime.enabled) {
      add("bullet-time-contract-invalid", `${shot.shotId}：声明子弹时间但合同不成立`, bulletTime.issues.map((issue) => `${issue.code}@${issue.path}`).join("；") || "主体时间和摄影机时间未分层");
    } else {
      add("camera-timeline-mismatch", `${shot.shotId}：时间轴要求「定住」，但【运镜】未写定住`, "FP-02 真机落幅继续推进 → 判「未到点定住」；合法子弹时间必须提供完整 bulletTime 合同");
    }
  }
  // ⑤ 帧率一致性：卡片约束 vs 管线帧率
  const fpsInCard = text((shot as Record<string, unknown>).constraint).match(/(\d{2})\s*fps/i);
  if (options.fps && fpsInCard && Number(fpsInCard[1]) !== options.fps) {
    add("fps-mismatch", `${shot.shotId}：卡片写 ${fpsInCard[1]}fps，管线按 ${options.fps}fps 出片`, "帧率不一致会被监制判「合同偏离」（真机返修）");
  }
  // ⑥ 玻璃/镜面：要求排除镜像第二张脸
  if (/落地窗|玻璃|镜面|倒影|反射/.test(visual) && !/无镜像|无第二张脸|不出现第二张清晰人脸|无第二张清晰人脸/.test(negative)) {
    add("mirror-second-face", `${shot.shotId}：画面含玻璃/镜面，但未排除镜像第二张脸`, "玻璃反射常生成第二张脸（AI 感与身份漂移的主要来源）", false);
  }
  // ⑦ 手部：只露手/手持道具的镜头必须排除多余手指
  if (/手|待提交|放置|取出|捏住/.test(visual) && !/无多余手指|无六指/.test(negative)) {
    add("hands-negative", `${shot.shotId}：含手部动作，但负面清单缺「无多余手指/六指」`, "手部畸变是最常见的返修项", false);
  }
  // ⑧ 竖屏横向结构：领奖台、舞台、联排台阶等横向分组结构若只用“三层/左右/两侧”
  // 一笔带过，模型常优先保住人物中近景而裁掉侧翼。这里要求把几何关系写成可执行约束。
  const declaredAspect = allText(shot, ["constraint"]).match(/(\d+)\s*:\s*(\d+)\s*画幅/);
  const fallbackAspect = String(options.aspect ?? "").match(/^(\d+)\s*:\s*(\d+)$/);
  const aspect = declaredAspect ?? fallbackAspect;
  const portrait = aspect && Number(aspect[1]) < Number(aspect[2]);
  const horizontalStructure = /领奖台|舞台|展台|台体|台阶|阶梯|主背板|背景墙|门架|龙门架|横梁|长廊|连廊|环形灯|灯光矩阵/.test(visual);
  const groupedStructure = /三层|多层|左右|两侧|左中右|联排|并列|横向|一整排/.test(visual);
  if (portrait && horizontalStructure && groupedStructure) {
    const lockedCamera = /(?:领奖台|舞台|展台|台体|结构)[^；。\n]{0,60}(?:三分之四|3\s*\/\s*4|斜侧|近侧斜侧|偏侧)[^；。\n]{0,30}(?:机位|视角|构图)|(?:三分之四|3\s*\/\s*4|斜侧|近侧斜侧|偏侧)[^；。\n]{0,30}(?:机位|视角|构图)[^；。\n]{0,60}(?:领奖台|舞台|展台|台体|结构)/.test(visual);
    const lockedBoundary = /(?:左右|两侧|左中右)[^；。\n]{0,60}(?:完整入画|可见边界|边缘完整|不被裁切|不裁切|不被遮挡|均清晰可辨|全部在画内)|(?:每块|三个|三块)[^；。\n]{0,30}(?:台体|台面)[^；。\n]{0,30}(?:可见|边界|不重叠)/.test(visual);
    const lockedRelativePosition = /(?:左|右|两侧)[^；。\n]{0,50}(?:低于|低台|矮台|次高)|(?:中央|中间)[^；。\n]{0,40}(?:最高|高台)/.test(visual);
    if (!(lockedCamera && lockedBoundary && lockedRelativePosition)) {
      add(
        "vertical-horizontal-structure-framing",
        `${shot.shotId}：${aspect[1]}:${aspect[2]} 竖屏含横向分组结构，但未同时锁定近侧三分之四机位、左右可见边界和子结构相对高度`,
        "竖屏会优先保留人物中近景并裁掉横向侧翼；仅写“三层/左右”无法保证模型把结构完整、按比例生成，必须把机位、可见边界和左中右相对位置写成同一组可执行约束",
      );
    }
  }
  return issues;
}

/** 整片红线汇总：hard 项必须清零才允许进入花钱阶段（fail-closed） */
export function auditFilmRedlines(shots: readonly RedlineShotLike[], options: {
  fps?: number; aspect?: string; bulletTimeCapabilities?: BulletTimeCapabilities;
} = {}): {
  policy: typeof PROMPT_REDLINE_POLICY_VERSION;
  hard: RedlineIssue[]; soft: RedlineIssue[]; perShot: Array<{ shotId: string; issues: RedlineIssue[] }>;
} {
  const perShot = shots.map((shot) => ({ shotId: String(shot.shotId ?? "?"), issues: auditShotRedlines(shot, options) }));
  const all = perShot.flatMap((entry) => entry.issues);
  return { policy: PROMPT_REDLINE_POLICY_VERSION, hard: all.filter((issue) => issue.hard), soft: all.filter((issue) => !issue.hard), perShot };
}
