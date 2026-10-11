/**
 * edit/output-resolution.ts —— 输出分辨率决策（纯函数层）。
 *
 * 产品口径（2026-10-11，产品所有者）：**默认跟随素材原生分辨率**——取与目标画幅一致、面积最大的
 * 素材档位；管线不得自行降低分辨率。显式 `--width/--height` 仍被尊重，但**低于素材原生档位时
 * 必须显式声明**（`--allow-downscale`，只应用于预览/低配发布），否则 fail closed。
 *
 * 为什么需要这一层（2026-10-11 事故复盘）：
 *   生产脚本沿用了上一轮的 `--width 1080 --height 1920`，把 4K 素材的交付悄悄降成 1080p。
 *   回执里虽然写着 `explicit`，但没有任何一处把"低于原生"变成**需要声明的动作**——口径只写在
 *   注释里，没有变成可断言的门禁。本层把该口径变成可复算判定：同输入 → 同结论，硬失败可断言。
 *
 * 边界：纯函数（不做 IO、不读系统时间）；素材像素尺寸由调用方（edit-post）探测后传入。
 */

export const OUTPUT_RESOLUTION_SCHEMA = "workloom.video-edit/output-resolution/v1";

/** 素材档位（调用方探测后的实际像素尺寸） */
export interface SourceSizeInput {
  sourceId?: string;
  width: number | null;
  height: number | null;
}

export interface OutputResolutionInput {
  /** 时间轴目标画幅（如 "9:16"）：优先挑与交付画幅一致的素材档位 */
  targetAspectRatio?: string | null;
  /** 素材档位（缺省/探测失败用 null） */
  sources: SourceSizeInput[];
  /** 显式覆盖（--width/--height）；两个都给才生效 */
  explicit?: { width?: string | number | null; height?: string | number | null } | null;
  /** 显式降分辨率许可（--allow-downscale） */
  allowDownscale?: boolean;
  /** 显式清晰度档（--quality，仅接受 hd / uhd） */
  quality?: string | null;
  /** 素材不可探测时的回退档位（默认 1920×1080） */
  fallback?: { width: number; height: number };
}

export interface OutputResolutionDecision {
  schemaVersion: typeof OUTPUT_RESOLUTION_SCHEMA;
  width: number;
  height: number;
  quality: "hd" | "uhd";
  /** 决策依据（写进日志与交付回执，便于复核"为什么是这个分辨率"） */
  policy: string;
  /** 与目标画幅一致、面积最大的素材档位（无则 null） */
  sourceBest: { sourceId?: string; width: number; height: number } | null;
  /** 相对素材原生档位的线性缩放比（<1 为降分辨率，>1 为上采样） */
  scaleVersusSource: number | null;
  /** 显式输出低于素材原生档位 */
  downscale: boolean;
  /** 降分辨率已被显式声明放行（--allow-downscale） */
  downscaleApproved: boolean;
  hardFailures: string[];
  advisories: string[];
}

const area = (width: number, height: number): number => width * height;

function parseAspectRatio(raw: string | null | undefined): number | null {
  const [a, b] = String(raw ?? "").split(":").map((value) => Number(value));
  return Number.isFinite(a) && Number.isFinite(b) && a! > 0 && b! > 0 ? a! / b! : null;
}

/** 显式分辨率解析：两个都给且为正数才算生效；只给一个视为缺省（附咨询项） */
function parseExplicit(explicit: OutputResolutionInput["explicit"]): {
  width: number | null;
  height: number | null;
  partial: boolean;
  invalid: boolean;
} {
  const rawWidth = explicit?.width ?? null;
  const rawHeight = explicit?.height ?? null;
  const hasWidth = rawWidth !== null && String(rawWidth).trim() !== "";
  const hasHeight = rawHeight !== null && String(rawHeight).trim() !== "";
  if (!hasWidth && !hasHeight) return { width: null, height: null, partial: false, invalid: false };
  if (hasWidth !== hasHeight) return { width: null, height: null, partial: true, invalid: false };
  const width = Number(rawWidth);
  const height = Number(rawHeight);
  const valid = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
  return { width: valid ? Math.round(width) : null, height: valid ? Math.round(height) : null, partial: false, invalid: !valid };
}

export function decideOutputResolution(input: OutputResolutionInput): OutputResolutionDecision {
  const fallback = input.fallback ?? { width: 1920, height: 1080 };
  const targetAspect = parseAspectRatio(input.targetAspectRatio);
  const usable = input.sources
    .filter((entry) => Number.isFinite(entry.width) && Number.isFinite(entry.height) && (entry.width ?? 0) > 0 && (entry.height ?? 0) > 0)
    .map((entry) => ({ sourceId: entry.sourceId, width: entry.width as number, height: entry.height as number }));
  const matching = targetAspect
    ? usable.filter((entry) => Math.abs(entry.width / entry.height - targetAspect) < 0.05)
    : usable;
  const pool = matching.length > 0 ? matching : usable;
  const best = [...pool].sort((a, b) => area(b.width, b.height) - area(a.width, a.height))[0] ?? null;

  const hardFailures: string[] = [];
  const advisories: string[] = [];
  const explicit = parseExplicit(input.explicit);

  let width: number;
  let height: number;
  let policy: string;
  let downscale = false;
  let downscaleApproved = false;
  let scaleVersusSource: number | null = null;

  if (explicit.invalid) hardFailures.push("显式分辨率非法：--width/--height 必须为正数");
  if (explicit.partial) advisories.push("只提供了 --width 或 --height 之一：按素材原生分辨率输出（显式覆盖需两个都给）");

  if (explicit.width && explicit.height) {
    width = explicit.width;
    height = explicit.height;
    policy = "explicit（调用方显式指定，尊重指定值）";
    if (best) {
      scaleVersusSource = Number(Math.sqrt(area(width, height) / area(best.width, best.height)).toFixed(3));
      if (scaleVersusSource < 0.999) {
        downscale = true;
        downscaleApproved = Boolean(input.allowDownscale);
        policy = `explicit-downscale（调用方显式指定；素材原生 ${best.width}×${best.height}）`;
        if (!downscaleApproved) {
          hardFailures.push(
            `显式输出 ${width}×${height} 低于素材原生 ${best.width}×${best.height}（缩放 ${scaleVersusSource}×）：` +
            "产品口径为默认跟随素材原生分辨率；确需降分辨率请显式加 --allow-downscale（仅用于预览/低配发布）",
          );
        }
      } else if (scaleVersusSource > 1.02) {
        advisories.push(
          `显式输出 ${width}×${height} 高于素材原生 ${best.width}×${best.height}（${scaleVersusSource}× 上采样，清晰度不会增加）`,
        );
      }
    }
  } else if (best) {
    width = best.width;
    height = best.height;
    policy = `source-max（${best.sourceId ?? "source"} ${best.width}×${best.height}）`;
  } else {
    width = fallback.width;
    height = fallback.height;
    policy = `fallback-${fallback.height}p（素材不可探测）`;
    advisories.push(`素材尺寸不可探测：回退 ${fallback.width}×${fallback.height}，分辨率口径无法核对`);
  }

  const qualityRaw = String(input.quality ?? "").trim();
  if (qualityRaw && qualityRaw !== "hd" && qualityRaw !== "uhd") {
    hardFailures.push(`--quality 只接受 hd / uhd（收到：${qualityRaw}）`);
  }
  const quality: "hd" | "uhd" = qualityRaw === "hd" || qualityRaw === "uhd"
    ? qualityRaw
    : Math.min(width, height) >= 2160 ? "uhd" : "hd";

  return {
    schemaVersion: OUTPUT_RESOLUTION_SCHEMA,
    width,
    height,
    quality,
    policy,
    sourceBest: best,
    scaleVersusSource,
    downscale,
    downscaleApproved,
    hardFailures,
    advisories,
  };
}
