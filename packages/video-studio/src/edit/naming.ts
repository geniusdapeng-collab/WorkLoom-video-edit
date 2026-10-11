/**
 * edit/naming.ts —— 交付文件命名规范（唯一事实源，2026-10-11 产品所有者口径）。
 *
 * 为什么单独一层：文件名是用户拿到交付包后**第一眼看到的东西**。旧命名（`v9-warm-story-1080p.mp4`、
 * `warm-story.burned.cover.mp4`）有三个问题：
 *   ① 英文 + 机器词（burned/cover/softsub），用户看不懂哪条是"能直接发"的；
 *   ② 分辨率写死在文件名里，与实测值脱钩（4K 交付却看到 1080 字样）；
 *   ③ 同一交付里多个版本共用同一套命名，无法一眼区分。
 * 本模块把"中文名 = 片名 · 版本名 · 核心特点 · 分辨率 · 版本号"固化成可复算的纯函数，
 * 所有产出文件（成片/母版/字幕/封面/预览/弹幕）都从这里取名。
 *
 * 规范（`·` 分隔，无空格）：
 *   {片名}·{版本名}·{核心特点}·{分辨率}[·预览]·{版本号}.{扩展名}
 * 示例：
 *   别人挤景区我回村摘苹果·暖调故事版·带字幕·4K·V10.mp4
 *   别人挤景区我回村摘苹果·暖调故事版·带字幕·1080P·预览·V10.mp4
 *   别人挤景区我回村摘苹果·干净母版·无字幕·4K·V10.mp4
 *   别人挤景区我回村摘苹果·分段调色版·双色分段封面·4K·V10.png
 */

export interface PixelSize {
  width: number;
  height: number;
}

/** 核心特点标签：优先用交付形态（带字幕/软字幕轨/无字幕），变体自身特点可并入版本名。 */
export type FeatureTag =
  | "带字幕"
  | "软字幕轨"
  | "无字幕"
  | "干净母版"
  | "弹幕版"
  | "封面"
  | "字幕文件"
  | "字幕"
  | (string & {});

/**
 * 分辨率徽标：按短边换算，取"用户口语里真正会说的档位"。
 * 2160→4K、1440→2K、1080→1080P、720→720P、480→480P，其余原样标 WxH。
 */
export function resolutionBadge(size: PixelSize): string {
  const width = Number(size?.width ?? 0);
  const height = Number(size?.height ?? 0);
  if (!(width > 0) || !(height > 0)) return "未知分辨率";
  const short = Math.min(width, height);
  if (short >= 2160) return "4K";
  if (short >= 1440) return "2K";
  if (short >= 1080) return "1080P";
  if (short >= 720) return "720P";
  if (short >= 480) return "480P";
  return `${width}x${height}`;
}

/**
 * 文件名片段清洗：去掉路径分隔符/保留字符/换行与空白（全角空格一并去掉），
 * 并去掉中文标点与分隔符「·」——避免在中文名里出现 `，。！` 之类的杂质、也避免与段分隔符撞车。
 */
export function sanitizeNamePart(value: string): string {
  return String(value ?? "")
    .replace(/[\\/:*?"<>|\n\r\t]/gu, "")
    .replace(/[，。！？；：、·「」『』《》〈〉（）()\[\]【】“”‘’…—～~!,.?;:'"`]/gu, "")
    .replace(/[\s\u3000]+/gu, "")
    .trim();
}

export interface ArtifactNameInput {
  /** 片名/标题（中文） */
  title: string;
  /** 版本名（变体名），如「暖调故事版」；母版等无变体时留空 */
  variantName?: string | null;
  /** 核心特点（交付形态），如「带字幕」 */
  feature: FeatureTag;
  /** 实测分辨率；未知时传 null 并会标为「未知分辨率」 */
  resolution?: PixelSize | null;
  /** 版本号，如「V10」；缺省不写入 */
  version?: string | null;
  /** 是否为预览件（降规格/聊天内播放用），会加「预览」段 */
  preview?: boolean;
  /**
   * 无分辨率信息时是否省略「分辨率」段（默认 false → 写「未知分辨率」）。
   * 字幕/清单这类本来就没有像素尺寸的产物用 true，避免出现"字幕文件·未知分辨率"这种噪音。
   */
  omitUnknownResolution?: boolean;
  /** 扩展名（含或不含点） */
  ext: string;
  /**
   * 片名太长时的裁剪上限（字符）。默认 24——平台场景下过长的文件名在列表里会被截断，
   * 保留前 24 字仍能认出片名与变体。
   */
  titleMaxChars?: number;
}

export function buildArtifactName(input: ArtifactNameInput): string {
  const ext = String(input.ext ?? "").replace(/^\./u, "").toLowerCase();
  if (!ext) throw new Error("buildArtifactName 需要扩展名");
  const limit = Number.isFinite(input.titleMaxChars) ? Number(input.titleMaxChars) : 24;
  const title = sanitizeNamePart(input.title).slice(0, Math.max(1, limit)) || "未命名";
  const variant = sanitizeNamePart(String(input.variantName ?? ""));
  const feature = sanitizeNamePart(String(input.feature ?? "")) || "成片";
  const badge = input.resolution ? resolutionBadge(input.resolution) : (input.omitUnknownResolution ? "" : "未知分辨率");
  const version = sanitizeNamePart(String(input.version ?? ""));
  const parts = [title, variant, feature, badge, input.preview ? "预览" : "", version].filter(Boolean);
  return `${parts.join("·")}.${ext}`;
}

/** 变体默认「版本名」（与 style-variants 的 name 字段一致，缺省给出人话兜底）。 */
export const VARIANT_DISPLAY_NAME: Record<string, string> = {
  "warm-story": "暖调故事版",
  "clean-tech": "干净科技版",
  "bold-promo": "强推促销版",
  "segmented-story": "分段调色版",
};

export function variantDisplayName(variantId: string, fallbackName?: string | null): string {
  return String(VARIANT_DISPLAY_NAME[variantId] ?? fallbackName ?? variantId);
}

export interface DisplayArtifact {
  /** 源文件绝对路径（不移动、不改名） */
  source: string;
  /** 规范中文名 */
  displayName: string;
  /** 机器可读的角色，供交付说明与清单使用 */
  role: "master" | "variant" | "softsub" | "burned" | "cover" | "subtitle" | "danmaku" | "preview" | "other";
  variantId?: string;
}

/** 交付说明（Markdown）：把规范命名的文件集写成一张用户能直接照着用的清单。 */
export function buildDeliveryIndexMarkdown(options: {
  title: string;
  version?: string | null;
  platform?: string | null;
  resolution?: PixelSize | null;
  artifacts: DisplayArtifact[];
  generatedAt?: string;
}): string {
  const { title, version, platform, resolution, artifacts } = options;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const lines: string[] = [];
  lines.push(`# 交付说明 · ${title}`);
  lines.push("");
  lines.push(`- 版本：${version || "未标注"}`);
  lines.push(`- 平台：${platform || "未标注"}`);
  lines.push(`- 分辨率：${resolution ? `${resolution.width}×${resolution.height}（${resolutionBadge(resolution)}）` : "未知"}`);
  lines.push(`- 生成时间：${generatedAt}`);
  lines.push("");
  const order: Array<{ role: DisplayArtifact["role"]; heading: string }> = [
    { role: "burned", heading: "推荐直接发布：带字幕成片" },
    { role: "softsub", heading: "软字幕轨成片（播放器可开关字幕）" },
    { role: "master", heading: "干净母版（不含烧录字幕）" },
    { role: "variant", heading: "无字幕画面版" },
    { role: "danmaku", heading: "弹幕版" },
    { role: "cover", heading: "封面" },
    { role: "subtitle", heading: "字幕文件" },
    { role: "preview", heading: "预览" },
    { role: "other", heading: "其他" },
  ];
  for (const { role, heading } of order) {
    const rows = artifacts.filter((artifact) => artifact.role === role);
    if (!rows.length) continue;
    lines.push(`## ${heading}`);
    lines.push("");
    for (const row of rows) lines.push(`- \`${row.displayName}\``);
    lines.push("");
  }
  lines.push("> 文件名规范：片名 · 版本名 · 核心特点 · 分辨率 · 版本号；分辨率一律按产出文件实测标注。");
  lines.push("");
  return lines.join("\n");
}
