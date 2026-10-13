/**
 * 交付形态口径（默认烧录字幕 + 封面），`edit:post` / `edit:cover` 共用。
 *
 * 背景（2026-10-12 客户实测事故）：
 *   交付包里的「软字幕轨」形态在 macOS 上默认不显示字幕——AVFoundation 的自动选择
 *   实测为「无」（Quick Look / QuickTime 预览都不会自动打开字幕轨），用户把文件发给
 *   别人时，对方看到的成片「没有字幕」，与文件名不符。
 *
 * 产品口径（本次改为默认）：
 *   · 只要提供了字幕文件，`edit:post` **默认烧字**——成片自带字幕，任何播放器/预览器
 *     都能直接看到；需要纯软字幕轨（剪辑、平台字幕轨）时显式 `--no-burn-subtitles`；
 *   · `edit:cover` 烧封封面片头后，**推荐发布件** = 「烧字 + 封面烧封」形态
 *     （`variants/<id>/<id>.burned.cover.mp4`）：字幕与封面都已烧录，分享/上传首选。
 */

export interface BurnSubtitlesInput {
  /** 是否提供了字幕文件（`--subtitle`） */
  subtitleProvided: boolean;
  /** 显式 `--burn-subtitles`（2026-10-12 起为默认行为，保留该开关做兼容） */
  burnFlag?: boolean;
  /** 显式 `--no-burn-subtitles`：退回「只出软字幕轨」（编辑/平台字幕轨场景） */
  noBurnFlag?: boolean;
}

/**
 * 是否产出「烧字」形态。
 * 规则：有字幕就烧；`--no-burn-subtitles` 显式关掉；没有字幕文件时天然为 false。
 */
export function resolveBurnSubtitles(input: BurnSubtitlesInput): boolean {
  if (!input.subtitleProvided) return false;
  if (input.noBurnFlag) return false;
  return true;
}

/**
 * 推荐发布件路径（相对交付目录）：字幕 + 封面均已烧录，任何播放器直接可见。
 * @param coverIntro 是否执行了封面烧封（`edit:cover --burn-intro > 0`）
 */
export function recommendedPublishFile(variantId: string, coverIntro = true): string {
  return coverIntro
    ? `variants/${variantId}/${variantId}.burned.cover.mp4`
    : `variants/${variantId}/${variantId}.burned.mp4`;
}

/** 分享/上传口径的说明文本（回执、清单与终端摘要共用同一句，避免多处口径漂移）。 */
export const PUBLISH_NOTE =
  "推荐发布件＝「烧字 + 封面烧封」：字幕与封面均已烧录进画面，任何播放器/预览器直接可见；"
  + "软字幕轨形态仅供剪辑或平台字幕轨使用（多数预览器默认不显示字幕轨）。";

/**
 * 弹幕形态（2026-10-13）：弹幕是**发布形态层**，与字幕/封面同构——后缀按形态顺序叠加，
 * 文件永远指向同一条时间轴上的同一份字节血缘：
 *   · 只烧弹幕（无字幕或无烧字）：`<id>.danmaku.mp4`
 *   · 烧字 + 弹幕：`<id>.burned.danmaku.mp4`
 *   · 再烧封面片头：`…danmaku.cover.mp4`
 * 背景：审计 F5——弹幕能力此前只在独立工位（`edit:danmaku`）可用，交付链路不产出弹幕形态，
 * 客户拿到的"完整成片"里看不到弹幕；现在由 `edit:post --danmaku` 直接产出、`edit:cover` 继续叠封面。
 */
export function danmakuFormFile(variantId: string, { burnedSubtitles = true, coverIntro = false } = {}): string {
  const base = burnedSubtitles ? `${variantId}.burned` : variantId;
  return `variants/${variantId}/${base}.danmaku${coverIntro ? ".cover" : ""}.mp4`;
}

/** 弹幕版的推荐发布件（烧字 + 弹幕 [+ 封面]）。 */
export function recommendedDanmakuFile(variantId: string, coverIntro = true): string {
  return danmakuFormFile(variantId, { burnedSubtitles: true, coverIntro });
}

/** 弹幕形态的分享口径说明（与 PUBLISH_NOTE 同构，避免多处口径漂移）。 */
export const DANMAKU_PUBLISH_NOTE =
  "弹幕版＝在「烧字（+封面烧封）」形态上再烧一层弹幕：发布/分享直接可见；"
  + "不带弹幕的原形态保留，便于二次剪辑或换弹幕内容。";
