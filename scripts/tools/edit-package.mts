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
 *   pnpm edit:package -- --delivery <交付目录> --final-only --title "片名" [--out <输出目录>]
 *
 * `--final-only`（2026-10-18 产品所有者口径）：**只交一个最终成片**——
 * 每个风格版本只取「字幕 + 弹幕 + 封面」全部烧录的推荐发布件，按「片名-风格-分辨率.mp4」落到输出目录，
 * 不再把干净母版/软字幕轨/封面 PNG/清单等过程产物推给用户（它们仍留在交付目录内部供返修）。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, copyFileSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  buildArtifactName, buildDeliveryIndexMarkdown, resolutionBadge, variantDisplayName, VARIANT_DISPLAY_NAME,
  type DisplayArtifact, type PixelSize,
} from "../../packages/video-studio/src/edit/naming.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const FFPROBE = process.env.WL_FFPROBE ?? "ffprobe";
const FFMPEG = process.env.WL_FFMPEG ?? "ffmpeg";

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const flag = (name: string) => process.argv.includes(name);
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

/**
 * 最终成片选择：**每个风格版本**从推荐发布件里挑「元素最全」的一条。
 * 优先级：字幕+弹幕+封面 > 字幕+封面 > 字幕+弹幕 > 字幕 > 带弹幕 > 干净。
 * 返回每个变体一条，供 `--final-only` 交付「3 个风格版本、每个只有一条成片」。
 */
function pickFinalPerVariant(manifest: Record<string, unknown>): Array<{ file: string; variantId: string; forms: string }> {
  const recommended = ((manifest.publish as { recommended?: Array<{ variantId?: string; file?: string; forms?: string }> } | undefined)?.recommended ?? [])
    .filter((item) => typeof item.file === "string" && item.file.length > 0);
  const score = (forms: string): number => {
    const text = String(forms ?? "").toLowerCase();
    let value = 0;
    if (text.includes("burned")) value += 1;
    if (text.includes("danmaku")) value += 4;
    if (text.includes("cover")) value += 2;
    return value;
  };
  const variantIds = ((manifest.variants as Array<{ id?: string }> | undefined) ?? [])
    .map((variant) => String(variant.id ?? "")).filter(Boolean);
  const picks: Array<{ file: string; variantId: string; forms: string }> = [];
  for (const variantId of variantIds) {
    const options = recommended
      .filter((item) => String(item.variantId ?? "") === variantId)
      .map((item) => ({ file: String(item.file), variantId, forms: String(item.forms ?? ""), score: score(item.forms) }))
      .sort((a, b) => b.score - a.score);
    if (options[0]) { picks.push(options[0]); continue; }
    /** 封面还没跑时退回该变体的烧字版（字幕已烧录，仍是一条成片）。 */
    const variant = (manifest.variants as Array<{ id?: string; burned?: { path?: string } }> | undefined)?.find((entry) => entry.id === variantId);
    if (variant?.burned?.path) picks.push({ file: variant.burned.path, variantId, forms: "burned" });
  }
  return picks;
}

function probeSize(file: string): PixelSize | null {
  try {
    const out = execFileSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8" }).trim();
    const [width, height] = out.split(",").map((value) => Number(value.trim()));
    if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) throw new Error("实际媒体缺可核实的像素尺寸");
    return { width, height };
  } catch (error) {
    throw new Error(`无法回读媒体规格 ${file}：${error instanceof Error ? error.message : String(error)}`);
  }
}

const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
/** Existing names can only be replaced when owned by this tool's previous index. */
function materialize(source: string, target: string, owned: Set<string>): "hardlink" | "copy" | "reused" {
  if (resolve(source) === resolve(target)) throw new Error("整理输出不能覆盖源文件");
  const expected = digest(source);
  if (existsSync(target)) {
    if (digest(target) === expected) return "reused";
    if (!owned.has(basename(target))) throw new Error(`输出名称已被其他文件占用：${target}`);
    rmSync(target);
  }
  let mode: "hardlink" | "copy";
  try { linkSync(source, target); mode = "hardlink"; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EXDEV", "ENOTSUP", "EPERM", "EOPNOTSUPP"].includes(code ?? "")) throw error;
    copyFileSync(source, target); mode = "copy";
  }
  if (digest(source) !== expected || digest(target) !== expected) throw new Error("整理期间源或目标字节变化");
  return mode;
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

function collect(delivery: string, previews: string | null, manifest: Record<string, unknown>, root: string): Candidate[] {
  const candidates: Candidate[] = [];
  const item = (value: unknown) => value as { path?: string; output?: string; sha256?: string; variantId?: string; form?: string; sourceForm?: string; lang?: string; role?: string } | null;
  const push = (value: unknown, role: Candidate["role"], feature: string, variantId?: string) => {
    const asset = item(value); if (!asset?.path && !asset?.output) return;
    const source = resolve(root, asset.path ?? asset.output!);
    if (!existsSync(source)) throw new Error(`清单中的交付产物缺失：${source}`);
    candidates.push({ source, role, feature, variantId });
  };
  push(manifest.master, "master", "干净母版无字幕");
  const intros = (manifest.coverIntro as { forms?: unknown[] } | undefined)?.forms ?? [];
  const variants = (manifest.variants as Array<Record<string, unknown>> | undefined) ?? [];
  for (const variant of variants) {
    const id = String(variant.id);
    const introFor = (form: string) => intros.find((value) => { const row = item(value);
      return row?.variantId === id && (row.form === form || row.form === `.${form}` || row.sourceForm === form || row.sourceForm === `.${form}`); });
    push(introFor("burned") ?? variant.burned, "burned", "带字幕", id);
    push(introFor("softsub") ?? variant.softsub, "softsub", "软字幕轨", id);
    push(introFor("video") ?? introFor("clean") ?? variant.video, "variant", "无字幕", id);
    const danmaku = (manifest.danmaku as { forms?: unknown[] } | undefined)?.forms?.find((value) => item(value)?.variantId === id);
    push(introFor("danmaku") ?? danmaku, "danmaku", "弹幕版", id);
    push(variant.cover, "cover", "封面", id);
  }
  for (const value of (manifest.subtitles as { files?: unknown[] } | undefined)?.files ?? []) {
    const asset = item(value);
    if (asset?.role !== "subtitle") continue;
    push(asset, "subtitle", `字幕文件${asset.lang === "eng" ? "英文" : "中文"}`);
  }
  if (previews && existsSync(previews)) for (const file of readdirSync(previews).sort()) {
    const source = join(previews, file);
    const variantId = Object.keys(VARIANT_DISPLAY_NAME).find((id) => file.startsWith(id));
    if (/\.(mp4|mov|m4v)$/iu.test(file)) candidates.push({ source, role: "preview", feature: /danmaku/iu.test(file) ? "弹幕版" : "带字幕", variantId, preview: true });
    else if (/\.(jpg|jpeg|png)$/iu.test(file)) candidates.push({ source, role: "other", feature: "对比图", preview: true });
  }
  return candidates;
}

async function main(): Promise<void> {
  const deliveryArg = arg("--delivery");
  if (!deliveryArg) throw new Error("用法：pnpm edit:package -- --delivery <交付目录> [--previews <预览目录>] [--version V10] [--title 片名]");
  const delivery = abs(deliveryArg);
  if (!existsSync(delivery)) throw new Error(`交付目录不存在：${delivery}`);
  const previews = arg("--previews") ? abs(arg("--previews")) : null;
  const title = arg("--title", "未命名");
  const version = arg("--version", basename(delivery).replace(/^delivery-?/iu, "").toUpperCase()) || null;
  const platform = arg("--platform", "视频号");
  const outDir = abs(arg("--out", join(delivery, "交付")));
  const manifestPath = join(delivery, "delivery-manifest.json");
  if (!existsSync(manifestPath)) throw new Error("正式整理缺 delivery-manifest.json，粗剪不能当交付");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  const qa = await import("../../bundles/ai-video/connectors/post-bridge/quality-gate.mjs") as unknown as {
    inspectDeliveryManifest: (options: Record<string, unknown>) => Promise<{ passed: boolean; assets: Array<{ path: string; sha256: string; passed: boolean }> }>;
    assertPostQuality: (report: unknown) => void;
    writePostQuality: (root: string, report: unknown) => Promise<Record<string, unknown>>;
    resolveDeliveryRoot: (options: Record<string, unknown>) => Promise<string>;
  };
  const qualityRoot = await qa.resolveDeliveryRoot({ manifestDir: delivery, manifest });
  const report = await qa.inspectDeliveryManifest({ root: qualityRoot, manifest: { ...manifest, displaySet: undefined }, phase: "release",
    bins: { ffmpeg: process.env.WL_FFMPEG ?? "ffmpeg", ffprobe: FFPROBE } });
  manifest.postQuality = await qa.writePostQuality(qualityRoot, report);
  qa.assertPostQuality(report);
  /**
   * `--final-only`：每个风格版本只交一条最终成片（字幕+弹幕+封面全烧录的推荐件）。
   * 用户不需要在干净母版/软字幕轨/无字幕/封面 PNG 之间做选择；过程产物留在交付目录内部供返修。
   */
  if (flag("--final-only")) {
    const picks = pickFinalPerVariant(manifest);
    if (picks.length === 0) throw new Error("没有可交付的推荐发布件（manifest.publish.recommended 为空，且没有 burned 变体）");
    const finalOut = abs(arg("--out", join(delivery, "最终成片")));
    mkdirSync(finalOut, { recursive: true });
    const names = variantNames(delivery);
    const rows: Array<Record<string, unknown>> = [];
    for (const best of picks) {
      const source = resolve(qualityRoot, best.file);
      if (!existsSync(source)) throw new Error(`推荐发布件不存在：${source}`);
      const verified = report.assets.some((asset) => resolve(qualityRoot, asset.path) === source && asset.passed && asset.sha256 === digest(source));
      if (!verified) throw new Error(`推荐发布件未被当前技术质检核实：${source}`);
      const resolution = probeSize(source);
      if (!resolution) throw new Error("推荐发布件缺可核实的像素尺寸");
      /** 每个风格一条：片名-风格-分辨率.mp4（不带形态/版本后缀，避免用户选择）。 */
      const displayName = `${title}-${names.get(best.variantId) ?? variantDisplayName(best.variantId)}-${resolutionBadge(resolution)}.mp4`;
      const target = join(finalOut, displayName);
      const mode = materialize(source, target, new Set());
      rows.push({ final: target, displayName, source, sourceSha256: digest(source), variantId: best.variantId, forms: best.forms, resolution, materialized: mode, sha256: digest(target) });
      console.log(`✓ 最终成片：${target}`);
      console.log(`  来源：${best.variantId}（${best.forms}）｜${resolutionBadge(resolution)}｜sha256 ${digest(target).slice(0, 16)}…`);
    }
    writeFileSync(join(delivery, "final-delivery.json"), `${JSON.stringify({
      schemaVersion: "workloom.video-edit/final-delivery/v1",
      variants: rows,
      postQuality: manifest.postQuality,
      generatedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    return;
  }
  mkdirSync(outDir, { recursive: true });
  const previousIndex = join(outDir, "交付清单.json");
  const owned = new Set<string>();
  if (existsSync(previousIndex)) {
    const previous = JSON.parse(readFileSync(previousIndex, "utf8")) as { schema?: string; artifacts?: Array<{ displayName?: string }> };
    if (previous.schema !== "workloom.video-edit/display-set/v1") throw new Error("已有交付清单类型不符，拒绝覆盖");
    for (const item of previous.artifacts ?? []) if (item.displayName && basename(item.displayName) === item.displayName) owned.add(item.displayName);
  }

  const names = variantNames(delivery);
  const candidates = collect(delivery, previews, manifest, qualityRoot);
  if (!candidates.length) throw new Error(`没有可整理的文件：${delivery}`);

  const artifacts: DisplayArtifact[] = [];
  const manifestRows: Array<Record<string, unknown>> = [];
  for (const candidate of candidates) {
    if (!candidate.preview && !report.assets.some((asset) => resolve(qualityRoot, asset.path) === resolve(candidate.source)
      && asset.passed && asset.sha256 === digest(candidate.source))) throw new Error(`待整理文件未被当前技术质检核实：${candidate.source}`);
    const ext = candidate.source.split(".").pop() ?? "bin";
    /** 视频与图片都按实测标注分辨率（封面 PNG 也要写 4K，不能是"未知分辨率"）。 */
    const resolution = /\.(mp4|mov|m4v|png|jpe?g|webp)$/iu.test(candidate.source) ? probeSize(candidate.source) : null;
    if (candidate.preview && resolution) execFileSync(FFMPEG, ["-hide_banner", "-v", "error", "-xerror", "-i", candidate.source,
      "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"], { timeout: 1_800_000, maxBuffer: 4 * 1024 * 1024 });
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
    if (artifacts.some((artifact) => artifact.displayName === displayName)) throw new Error(`两个产物生成了相同交付名称：${displayName}`);
    const target = join(outDir, displayName);
    const mode = materialize(candidate.source, target, owned);
    artifacts.push({ source: candidate.source, displayName, role: candidate.role, variantId: candidate.variantId });
    manifestRows.push({
      displayName,
      role: candidate.role,
      variantId: candidate.variantId ?? null,
      source: candidate.source,
      path: target, preview: candidate.preview === true, sha256: digest(target), sourceSha256: digest(candidate.source),
      resolution,
      resolutionBadge: resolution ? resolutionBadge(resolution) : null,
      materialized: mode,
    });
  }

  const masterSource = candidates.find((candidate) => candidate.role === "master")?.source;
  const masterSize = masterSource ? probeSize(masterSource) : null;
  const currentNames = new Set(artifacts.map((artifact) => artifact.displayName));
  for (const file of owned) if (!currentNames.has(file)) rmSync(join(outDir, file), { force: true });
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

  for (const row of manifestRows) if (digest(String(row.path)) !== row.sha256 || digest(String(row.source)) !== row.sourceSha256) throw new Error("交付名称文件在发布清单前发生变化");
  manifest.displaySet = { dir: outDir, index: join(outDir, "交付说明.md"), artifacts: manifestRows,
    sourceQualityPassed: report.passed, copiedBytesVerified: true };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(`✓ 交付中文名整理完成：${artifacts.length} 个文件 → ${outDir}`);
  console.log(`  交付说明：${join(outDir, "交付说明.md")}`);
  for (const row of manifestRows.slice(0, 12)) console.log(`  - ${String(row.displayName)}（${String(row.materialized)}）`);
}

main().catch((error) => { console.error(`✗ edit-package 失败：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
