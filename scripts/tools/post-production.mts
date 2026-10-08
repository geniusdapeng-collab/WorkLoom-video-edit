#!/usr/bin/env tsx
/**
 * post-production.mts —— 后期环节的宿主侧接线（2026-09-22）
 *
 * 为什么需要：`deferRender` 之后 vendor Layer 3 不再提交渲染，vendor 的后期引擎因此拿不到
 * `shot-<id>.mp4`，文件引用检查固定失败（真机 2026-09-22：4 个版本全部 "视频文件不存在 (shot-S1.mp4)"）。
 * 本工具把**宿主渲染出来的真实成片路径**回填成 `renderResult.results`（含绝对 videoPath），
 * 再调 vendor 的 `PostProductionEngine.postProduce`，让"后期合成"这一步真正产出：
 * 字幕轨（身份卡）、音乐轨、四个版本（standard/clean/subtitled/raw）的 HTML 与 config，
 * 以及真实文件和引用的处理回执。该入口生成合成工程，没有渲染 MP4 或执行品质评审。
 *
 * 用法：
 *   pnpm exec tsx scripts/tools/post-production.mts \
 *     --run apps/server/output/<ts>_<title> --render-summary <runDir>/render-summary.json [--json]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fingerprintArtifact, productionHash, type ArtifactFingerprint } from "../../packages/video-studio/src/production-lineage.js";
import { acceptRenderedShot, RENDERED_SHOT_ACCEPTANCE_POLICY, type RenderedShotAcceptance } from "../../packages/video-studio/src/rendered-shot-acceptance.js";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const flag = (name: string) => process.argv.includes(name);

function newestRunDir(): string {
  const base = join(REPO_ROOT, "apps/server/output");
  const dirs = readdirSync(base).map((n) => join(base, n)).filter((p) => statSync(p).isDirectory());
  dirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!dirs[0]) throw new Error("apps/server/output 下没有运行产物");
  return dirs[0];
}

const runDir = arg("--run") ? resolve(REPO_ROOT, arg("--run")) : newestRunDir();
const resultPath = join(runDir, "result.json");
if (!existsSync(resultPath)) throw new Error(`缺少 result.json：${resultPath}`);
const result = JSON.parse(readFileSync(resultPath, "utf8")) as {
  stages?: Record<string, unknown>;
};

const summaryPath = arg("--render-summary")
  ? resolve(REPO_ROOT, arg("--render-summary"))
  : join(runDir, "render-summary.json");
if (!existsSync(summaryPath)) throw new Error(`缺少出片汇总（先跑 render-project.mts）：${summaryPath}`);
const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
  mode?: string; projectId?: string; status?: string; sourceStageRunId?: string; sourceAttempt?: number;
  shots?: Array<{ shotId: string; localPath?: string | null; status?: string; assetId?: string | null; seconds?: number;
    taskId?: string; jobId?: string; mock?: boolean; error?: string; promptSha256?: string; sourceStageRunId?: string; sourceAttempt?: number }>;
};
if (summary.mode !== "service-production" || summary.status !== "done" || !summary.projectId?.trim()
  || !summary.sourceStageRunId?.trim() || !Number.isInteger(summary.sourceAttempt) || Number(summary.sourceAttempt) <= 0
  || !Array.isArray(summary.shots) || !summary.shots.length) throw new Error("POST_RENDER_SERVICE_RECEIPT_REQUIRED");
const ids = new Set<string>();
for (const shot of summary.shots) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(shot.shotId) || shot.shotId.includes("..") || ids.has(shot.shotId)
    || shot.status !== "done" || shot.mock !== false || shot.error || !shot.taskId?.trim() || !shot.jobId?.trim()
    || !shot.assetId?.trim() || !/^[a-f0-9]{64}$/.test(shot.promptSha256 ?? "")
    || shot.sourceStageRunId !== summary.sourceStageRunId || shot.sourceAttempt !== summary.sourceAttempt) {
    throw new Error(`POST_RENDER_SHOT_RECEIPT_INVALID: ${shot.shotId}`);
  }
  ids.add(shot.shotId);
}
const productionEngine = (result.stages?.productionEngine ?? {}) as Record<string, unknown>;
const sourceShots = productionEngine.shots as Array<Record<string, unknown>> | undefined;
if (!Array.isArray(sourceShots) || !sourceShots.length || sourceShots.length !== summary.shots.length) {
  throw new Error("POST_RENDER_SHOT_SCOPE_MISMATCH");
}
const sourceIds = new Set<string>();
for (const shot of sourceShots) {
  const shotId = shot?.shotId;
  if (typeof shotId !== "string" || !ids.has(shotId) || sourceIds.has(shotId)) {
    throw new Error("POST_RENDER_SHOT_SCOPE_MISMATCH");
  }
  sourceIds.add(shotId);
}
const outDir = resolve(REPO_ROOT, arg("--out", join(runDir.replace(REPO_ROOT + "/", ""), "post")));
const sourceScope = { projectId: summary.projectId, sourceStageRunId: summary.sourceStageRunId, sourceAttempt: summary.sourceAttempt };
const sourceReceiptPath = join(runDir, `rendered-source-acceptance-${productionHash(sourceScope)}.json`);
const summaryArtifact = fingerprintArtifact(summaryPath);
const persistedReport = join(outDir, "post-report.json");
const readPersisted = (file: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("POST_RENDER_PERSISTED_SOURCE_MISMATCH");
  return value as Record<string, unknown>;
};
const sameArtifact = (expected: ArtifactFingerprint | undefined, actual: ArtifactFingerprint): boolean => Boolean(expected)
  && expected!.path === actual.path && expected!.realpath === actual.realpath
  && expected!.sha256 === actual.sha256 && expected!.bytes === actual.bytes;
const persisted = existsSync(sourceReceiptPath) ? readPersisted(sourceReceiptPath)
  : existsSync(persistedReport) ? readPersisted(persistedReport) : null;
if (persisted && (!Array.isArray(persisted.sourceReceipts) || persisted.sourceReceipts.length !== summary.shots.length
  || (existsSync(sourceReceiptPath) && (persisted.schemaVersion !== "workloom.vendor-rendered-source/v1"
    || !persisted.scope || typeof persisted.scope !== "object" || Array.isArray(persisted.scope)
    || productionHash(persisted.scope) !== productionHash(sourceScope)
    || !sameArtifact(persisted.summary as ArtifactFingerprint, summaryArtifact))))) {
  throw new Error("POST_RENDER_PERSISTED_SOURCE_MISMATCH");
}
const mediaRoot = process.env.WORKLOOM_MEDIA_DIR?.trim() || join(REPO_ROOT, "var/media");
const rendered = summary.shots.map((shot) => {
  const localPath = shot.localPath ? resolve(mediaRoot, shot.localPath) : null;
  if (!localPath) throw new Error(`POST_RENDER_FILE_MISSING: ${shot.shotId}`);
  const sourceHash = productionHash({ projectId: summary.projectId, sourceStageRunId: summary.sourceStageRunId,
    sourceAttempt: summary.sourceAttempt, shotId: shot.shotId, promptSha256: shot.promptSha256 });
  let receipt: RenderedShotAcceptance;
  if (persisted) {
    const matches = (persisted.sourceReceipts as RenderedShotAcceptance[]).filter((item) => item?.shotId === shot.shotId);
    const issued = matches[0];
    if (matches.length !== 1 || issued?.policy !== RENDERED_SHOT_ACCEPTANCE_POLICY
      || issued.projectId !== summary.projectId || issued.sourceHash !== sourceHash || issued.taskId !== shot.taskId
      || issued.providerStatus !== "succeeded" || !["provider-success", "historical-provider-success"].includes(issued.source)
      || !sameArtifact(issued.artifact, fingerprintArtifact(localPath))
      || !Array.isArray(issued.sourceInputs) || !issued.sourceInputs.length
      || !issued.sourceInputs.some((input) => sameArtifact(input, summaryArtifact))
      || !issued.sourceInputs.every((input) => sameArtifact(input, fingerprintArtifact(input.path)))) {
      throw new Error(`POST_RENDER_PERSISTED_SOURCE_MISMATCH: ${shot.shotId}`);
    }
    receipt = structuredClone(issued);
  } else {
    receipt = acceptRenderedShot({ projectId: summary.projectId!, shotId: shot.shotId, sourceHash,
      file: localPath, taskId: shot.taskId!, providerStatus: "succeeded", sourceInputs: [summaryArtifact] });
  }
  const media = JSON.parse(execFileSync(process.env.WL_FFPROBE ?? "ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", localPath],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })) as { streams?: Array<{ codec_type?: string }>; format?: { duration?: string } };
  const duration = Number(media.format?.duration);
  if (!(duration > 0) || !media.streams?.some((stream) => stream.codec_type === "video")) throw new Error(`POST_RENDER_MEDIA_UNREADABLE: ${shot.shotId}`);
  return { shotId: shot.shotId, success: true, status: "done", mock: false, taskId: shot.taskId,
    videoPath: localPath, videoUrl: localPath, assetId: shot.assetId, duration, renderedShotAcceptance: receipt };
});

const renderByShot = new Map(rendered.map((r) => [r.shotId, r]));
const assertCurrentSources = (): void => {
  for (const row of rendered) {
    const receipt = row.renderedShotAcceptance;
    for (const source of [receipt.artifact, ...receipt.sourceInputs]) {
      if (!sameArtifact(source, fingerprintArtifact(source.path))) throw new Error(`POST_RENDER_PERSISTED_SOURCE_MISMATCH: ${row.shotId}`);
    }
  }
};
assertCurrentSources();
const sourceReceipt = { schemaVersion: "workloom.vendor-rendered-source/v1", scope: sourceScope,
  summary: summaryArtifact, sourceReceipts: rendered.map((row) => row.renderedShotAcceptance) };
if (!existsSync(sourceReceiptPath)) {
  try { writeFileSync(sourceReceiptPath, `${JSON.stringify(sourceReceipt, null, 2)}\n`, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (productionHash(readPersisted(sourceReceiptPath)) !== productionHash(sourceReceipt)) throw new Error("POST_RENDER_PERSISTED_SOURCE_MISMATCH");
  }
}
mkdirSync(outDir, { recursive: true });

const vendorRequire = createRequire(join(REPO_ROOT, "package.json"));
const enginePath = join(
  REPO_ROOT,
  "vendor/supermickey/hyperreality-system/engines/post-production-engine/post-production-engine.js"
);
const { PostProductionEngine } = vendorRequire(enginePath) as {
  PostProductionEngine: new (options?: Record<string, unknown>) => {
    postProduce(
      productionResult: Record<string, unknown>,
      scriptResult: Record<string, unknown>,
      renderResult: Record<string, unknown>
    ): Promise<Record<string, unknown>>;
  };
};

/**
 * vendor 的文件引用检查读的是版本 shots 的 `videoSrc/videoPath`（不是 HTML 里的 src），
 * 因此必须把宿主渲染出的**绝对路径**合进镜头卡，否则永远报 "视频文件不存在 (shot-SX.mp4)"。
 */
const shotsWithRenderPaths = sourceShots.map((shot) => {
  const hit = renderByShot.get(String(shot.shotId));
  return { ...shot, videoSrc: hit!.videoPath, videoPath: hit!.videoPath, renderedDuration: hit!.duration };
});
const productionResult = {
  shots: shotsWithRenderPaths,
  prompts: productionEngine.prompts ?? [],
  _creativeIntensity: result.stages?.creativeIntensity ?? null
};
const scriptResult = (result.stages?.scriptEngine ?? {}) as Record<string, unknown>;

const engine = new PostProductionEngine({ outputDir: outDir, versions: ["standard", "clean", "subtitled", "raw"] });
console.log(`后期合成（vendor PostProductionEngine）→ ${outDir}`);
console.log(`   镜头成片：${rendered.map((r) => `${r.shotId}=${r.videoPath}`).join(" ")}`);
const post = await engine.postProduce(productionResult, scriptResult, { results: rendered });
assertCurrentSources();

post.artifactKind = "hyperframes-composition";
post.mediaRendered = false;
post.qualityReviewed = false;
post.sourceReceipts = rendered.map((row) => row.renderedShotAcceptance);
if (!post.success) process.exitCode = 6;
const reportPath = join(outDir, "post-report.json");
writeFileSync(reportPath, `${JSON.stringify(post, null, 2)}\n`, "utf8");
const mdPath = join(outDir, "post-report.md");
const versions = (post.versions ?? {}) as Record<string, { htmlPath?: string; shots?: unknown[] }>;
const stageInfo = (post.stages ?? {}) as Record<string, Record<string, unknown>>;
const processing = stageInfo.processing ?? {};
const md = [
  "# 后期合成报告（宿主渲染回填）",
  "",
  `- 产物目录：\`${outDir.replace(REPO_ROOT + "/", "")}\``,
  `- 合成工程：${post.success ? "✅ 已生成" : "❌ 失败"}；此入口只写 HTML/config，尚未渲染 MP4`,
  "- 原片成功任务与当前文件已绑定；未复核身份、动作、口型或声音品质",
  `- 版本：${Object.keys(versions).join("、") || "—"}`,
  `- 字幕轨：${String(stageInfo.subtitles?.count ?? "—")} 条；音乐轨：${String(stageInfo.music?.count ?? "—")} 条；剪辑：${String(stageInfo.assembly?.timing ?? "—")}ms`,
  `- 文件及引用处理检查：${processing.passed === true ? "pass" : `fail（${((processing.issues as string[]) ?? []).slice(0, 3).join("；")}）`}`,
  "",
  "| 版本 | HTML | 镜头数 |",
  "|---|---|---:|",
  ...Object.entries(versions).map(([name, v]) => `| ${name} | ${v.htmlPath ?? "—"} | ${v.shots?.length ?? 0} |`),
  ""
].join("\n");
writeFileSync(mdPath, md, "utf8");

console.log(md);
if (flag("--json")) console.log(JSON.stringify({ outDir, report: reportPath, post }, null, 2));
else console.log(`后期报告：${reportPath.replace(REPO_ROOT + "/", "")} / ${mdPath.replace(REPO_ROOT + "/", "")}`);
