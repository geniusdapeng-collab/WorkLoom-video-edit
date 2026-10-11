#!/usr/bin/env tsx
/**
 * edit-creative-check —— 创作环节检查器（机器校验"方案是否真的不一样、素材是否真的存在"）。
 *
 * 为什么需要它：`creative-ideation` / `narrative-structure` 的硬纪律此前全靠模型自觉——
 * 七份"换壳方案"、引用不存在的镜头、评审不给扣分理由，都能一路进到剪辑。
 * 本执行器把事实类规则变成硬闸（详见 packages/video-studio/src/edit/creative-check.ts）：
 *   · 候选两两至少 3 维不同（禁止换壳）；
 *   · candidateShotIds / highlightRefs / keyframeRefs / materialRefs 必须命中素材索引；
 *   · 四视角评审覆盖全部候选；生成阶段出现自评字段即阻断。
 * 素材索引来自 `--analysis`（edit:probe / 理解产物）或显式 `--material`。
 *
 * 用法：
 *   pnpm edit:creative-check -- --creative creative-set.json [--analysis a.json]… \
 *     [--material material.json] [--out creative-report.json] [--json]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { checkCreativeSet, type MaterialIndexLike } from "../../packages/video-studio/src/edit/index.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const flag = (name: string) => process.argv.includes(name);
function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

function readJson(file: string, label: string): Record<string, unknown> {
  if (!existsSync(file)) throw new Error(`${label}不存在：${file}`);
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${label}不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
}

function main(): void {
  const creativePath = arg("--creative");
  if (!creativePath) throw new Error("用法：pnpm edit:creative-check -- --creative <creative-set.json> [--analysis <probe.json>]…");
  const creativeFile = abs(creativePath);
  const raw = readJson(creativeFile, "创意方案集");
  /**
   * 兼容两种产物形态：① 完整文档 { creativeSet, storyPlan }；② 只有 creativeSet 内容的对象。
   * 缺 storyPlan 时只检查创意集，并在报告里如实标注（不报"已全量校验"）。
   */
  const doc = raw.creativeSet || raw.storyPlan
    ? raw
    : { creativeSet: raw } as Record<string, unknown>;

  /** 素材索引：显式 --material 优先；否则从 --analysis 的 shots/highlights/keyframes 汇总。 */
  let material: MaterialIndexLike | null = null;
  const materialPath = arg("--material");
  if (materialPath) {
    material = readJson(abs(materialPath), "素材索引") as MaterialIndexLike;
  } else {
    const shotIds = new Set<string>();
    const highlightIds = new Set<string>();
    const keyframeIds = new Set<string>();
    let docs = 0;
    for (let index = 0; index < process.argv.length; index += 1) {
      if (process.argv[index] !== "--analysis" || !process.argv[index + 1]) continue;
      const file = abs(process.argv[index + 1]!);
      const analysis = readJson(file, "素材解析结果");
      docs += 1;
      for (const shot of (analysis.shots as Array<Record<string, unknown>> | undefined) ?? []) {
        if (typeof shot.shotId === "string") shotIds.add(shot.shotId);
      }
      for (const highlight of (analysis.highlights as Array<Record<string, unknown>> | undefined) ?? []) {
        if (typeof highlight.highlightId === "string") highlightIds.add(highlight.highlightId);
      }
      for (const keyframe of (analysis.keyframes as Array<Record<string, unknown>> | undefined) ?? []) {
        if (typeof keyframe.keyframeId === "string") keyframeIds.add(keyframe.keyframeId);
      }
    }
    material = docs > 0 ? { shotIds: [...shotIds], highlightIds: [...highlightIds], keyframeIds: [...keyframeIds] } : null;
  }

  const result = checkCreativeSet({ doc: doc as never, material });
  const report = {
    schema: "workloom.video-edit/creative-check/v1",
    creative: creativeFile,
    materialProvided: material !== null,
    materialSize: material
      ? { shots: material.shotIds?.length ?? 0, highlights: material.highlightIds?.length ?? 0, keyframes: material.keyframeIds?.length ?? 0 }
      : null,
    ok: result.ok,
    metrics: result.metrics,
    issues: result.issues,
    note: material
      ? "素材引用已按索引校验（未命中即硬失败）"
      : "未提供素材索引（--analysis/--material）：素材引用只做存在性提示，未校验",
    generatedAt: new Date().toISOString(),
  };
  const outPath = arg("--out");
  if (outPath) {
    const target = abs(outPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (flag("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`✓ 创作检查：候选 ${result.metrics.candidateCount} 个｜最小差异维度 ${result.metrics.minDifferentDims ?? "?"}｜素材引用 ${result.metrics.referencesChecked} 处（缺 ${result.metrics.referencesMissing}）｜评审覆盖 ${result.metrics.reviewCoverage}`);
    for (const issue of result.issues) {
      console.log(`  ${issue.severity === "hard" ? "✗" : "!"} [${issue.severity === "hard" ? "硬" : "咨询"}] ${issue.id}：${issue.detail}`);
    }
    if (outPath) console.log(`  报告：${abs(outPath)}`);
  }
  if (!result.ok) process.exit(1);
}

try {
  main();
} catch (err) {
  console.error(`✗ edit-creative-check 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
