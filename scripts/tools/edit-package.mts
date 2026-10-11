#!/usr/bin/env tsx
/**
 * edit-package —— 交付包"中文名"整理器（命名规范落地，2026-10-11 产品所有者口径）。
 *
 * 背景：交付目录里的机器名（`warm-story.burned.cover.mp4`、`v9-warm-story-1080p.mp4`）
 * 用户看不懂、也不知道该点开哪一条。本工具在交付目录下生成 `交付/` 子目录：
 *   · 每个文件用规范中文名（片名 · 版本名 · 核心特点 · 分辨率 · 版本号）**硬链接**一份（零拷贝）；
 *   · 分辨率一律 ffprobe 实测（4K 就是 4K，1080p 预览就写「1080P · 预览」，不用交付分辨率冒充）；
 *   · 生成 `交付说明.md`（推荐直接发布的带字幕版排最前）与 `交付清单.json`（机器可读）。
 * 原机器名文件保持不动（清单/返修入口仍按原路径），两种命名并存、指向同一份字节。
 *
 * 用法：
 *   pnpm edit:package -- --delivery <交付目录> [--previews <预览目录>] [--version V10]
 *     [--title "片名"] [--platform 视频号] [--out <输出目录>]
 */
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, copyFileSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  buildArtifactName, buildDeliveryIndexMarkdown, resolutionBadge, variantDisplayName, VARIANT_DISPLAY_NAME,
  type DisplayArtifact, type PixelSize,
} from "../../packages/video-studio/src/edit/naming.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const FFPROBE = process.env.WL_FFPROBE ?? "ffprobe";

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

function probeSize(file: string): PixelSize | null {
  try {
    const out = execFileSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8" }).trim();
    const [width, height] = out.split(",").map((value) => Number(value.trim()));
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

/** 硬链接优先（同卷零拷贝）；跨卷或文件系统不支持时回退到复制。 */
function materialize(source: string, target: string): "hardlink" | "copy" {
  try {
    if (existsSync(target)) return "hardlink";
    linkSync(source, target);
    return "hardlink";
  } catch {
    copyFileSync(source, target);
    return "copy";
  }
}

interface Candidate {
  source: string;
  role: DisplayArtifact["role"];
  variantId?: string;
  feature: string;
  preview?: boolean;
}

function variantNames(delivery: string): Map<string, string> {
  const names = new Map<string, string>();
  const overrideDir = join(delivery, "work", "variant-overrides");
  if (existsSync(overrideDir)) {
    for (const file of readdirSync(overrideDir)) {
      if (!file.endsWith(".json") || file === "index.json") continue;
      try {
        const doc = JSON.parse(readFileSync(join(overrideDir, file), "utf8")) as { id?: string; name?: string };
        if (doc.id) names.set(doc.id, doc.name ? String(doc.name) : variantDisplayName(doc.id));
      } catch { /* 覆盖配方不可读时用统一词表兜底 */ }
    }
  }
  return names;
}

function collect(delivery: string, previews: string | null): Candidate[] {
  const candidates: Candidate[] = [];
  const push = (source: string, role: Candidate["role"], feature: string, variantId?: string, preview = false) => {
    if (existsSync(source)) candidates.push({ source, role, feature, variantId, preview });
  };

  push(join(delivery, "master", "master-clean.mp4"), "master", "干净母版无字幕");
  const variantsDir = join(delivery, "variants");
  if (existsSync(variantsDir)) {
    for (const variantId of readdirSync(variantsDir).sort()) {
      const dir = join(variantsDir, variantId);
      if (!statSync(dir).isDirectory()) continue;
      push(join(dir, `${variantId}.burned.cover.mp4`), "burned", "带字幕", variantId);
      push(join(dir, `${variantId}.softsub.cover.mp4`), "softsub", "软字幕轨", variantId);
      push(join(dir, `${variantId}.cover.mp4`), "variant", "无字幕", variantId);
      push(join(dir, `${variantId}.danmaku.mp4`), "danmaku", "弹幕版", variantId);
      push(join(dir, "cover.png"), "cover", "封面", variantId);
    }
  }
  const subtitleDir = join(delivery, "subtitles");
  if (existsSync(subtitleDir)) {
    /** 只收交付字幕（srt/ass/vtt），排除 subtitle-plan.ass / 测量样本等中间产物。 */
    for (const file of readdirSync(subtitleDir).sort()) {
      if (!/\.(srt|ass|vtt)$/iu.test(file)) continue;
      if (/^(subtitle-plan|measure-sample)/iu.test(file)) continue;
      push(join(subtitleDir, file), "subtitle", "字幕文件");
    }
  }
  if (previews && existsSync(previews)) {
    const knownVariants = Object.keys(VARIANT_DISPLAY_NAME);
    for (const file of readdirSync(previews).sort()) {
      const variantId = knownVariants.find((id) => file.startsWith(id));
      if (/\.(mp4|mov|m4v)$/iu.test(file)) {
        /** 预览件说明"预览的是哪种形态"：烧字成片 → 带字幕；弹幕版 → 弹幕版。 */
        const feature = /danmaku/iu.test(file) ? "弹幕版" : "带字幕";
        push(join(previews, file), "preview", feature, variantId, true);
      }
      else if (/\.(jpg|jpeg|png)$/iu.test(file)) push(join(previews, file), "other", "对比图", undefined, true);
    }
  }
  return candidates;
}

function main(): void {
  const deliveryArg = arg("--delivery");
  if (!deliveryArg) throw new Error("用法：pnpm edit:package -- --delivery <交付目录> [--previews <预览目录>] [--version V10] [--title 片名]");
  const delivery = abs(deliveryArg);
  if (!existsSync(delivery)) throw new Error(`交付目录不存在：${delivery}`);
  const previews = arg("--previews") ? abs(arg("--previews")) : null;
  const title = arg("--title", "未命名");
  const version = arg("--version", basename(delivery).replace(/^delivery-?/iu, "").toUpperCase() || null) || null;
  const platform = arg("--platform", "视频号");
  const outDir = abs(arg("--out", join(delivery, "交付")));
  mkdirSync(outDir, { recursive: true });

  const names = variantNames(delivery);
  const candidates = collect(delivery, previews);
  if (!candidates.length) throw new Error(`没有可整理的文件：${delivery}`);

  const artifacts: DisplayArtifact[] = [];
  const manifestRows: Array<Record<string, unknown>> = [];
  for (const candidate of candidates) {
    const ext = candidate.source.split(".").pop() ?? "bin";
    /** 视频与图片都按实测标注分辨率（封面 PNG 也要写 4K，不能是"未知分辨率"）。 */
    const resolution = /\.(mp4|mov|m4v|png|jpe?g|webp)$/iu.test(candidate.source) ? probeSize(candidate.source) : null;
    const displayName = buildArtifactName({
      title,
      variantName: candidate.variantId ? (names.get(candidate.variantId) ?? variantDisplayName(candidate.variantId)) : null,
      feature: candidate.feature,
      resolution,
      /** 字幕文件这类没有像素尺寸的产物不写"未知分辨率"。 */
      omitUnknownResolution: candidate.role === "subtitle",
      version,
      preview: candidate.preview,
      ext,
    });
    const target = join(outDir, displayName);
    const mode = materialize(candidate.source, target);
    artifacts.push({ source: candidate.source, displayName, role: candidate.role, variantId: candidate.variantId });
    manifestRows.push({
      displayName,
      role: candidate.role,
      variantId: candidate.variantId ?? null,
      source: candidate.source,
      resolution,
      resolutionBadge: resolution ? resolutionBadge(resolution) : null,
      materialized: mode,
    });
  }

  const masterSize = probeSize(join(delivery, "master", "master-clean.mp4")) ?? null;
  /** 清理上一轮命名残留（只删本工具pattern命名的旧文件，不动别的）。 */
  const currentNames = new Set(artifacts.map((artifact) => artifact.displayName));
  for (const file of readdirSync(outDir)) {
    if (!/·V[^·]*\./u.test(file) && !/·未知分辨率/u.test(file)) continue;
    if (currentNames.has(file)) continue;
    try { rmSync(join(outDir, file), { force: true }); } catch { /* 清理失败不阻塞交付 */ }
  }
  const indexMarkdown = buildDeliveryIndexMarkdown({ title, version, platform, resolution: masterSize, artifacts });
  writeFileSync(join(outDir, "交付说明.md"), indexMarkdown, "utf8");
  writeFileSync(join(outDir, "交付清单.json"), `${JSON.stringify({
    schema: "workloom.video-edit/display-set/v1",
    title, version, platform,
    deliveryResolution: masterSize,
    namingRule: "片名·版本名·核心特点·分辨率·版本号（分辨率按产出文件实测；预览件额外标注「预览」）",
    artifacts: manifestRows,
    generatedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");

  const manifestPath = join(delivery, "delivery-manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      manifest.displaySet = { dir: outDir, index: join(outDir, "交付说明.md"), artifacts: manifestRows };
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    } catch (err) {
      console.warn(`⚠ 交付清单未写入 displaySet：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`✓ 交付中文名整理完成：${artifacts.length} 个文件 → ${outDir}`);
  console.log(`  交付说明：${join(outDir, "交付说明.md")}`);
  for (const row of manifestRows.slice(0, 12)) console.log(`  - ${String(row.displayName)}（${String(row.materialized)}）`);
}

main();
