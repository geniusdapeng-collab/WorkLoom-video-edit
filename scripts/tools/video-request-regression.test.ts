import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript-governance";
import { normalizeShotIntent, shotIntentHash } from "../../packages/video-studio/src/shot-intent.js";
import { buildVideoSubmissionRequest } from "../../packages/video-studio/src/video-submission-request.js";
import { runVideoSubmission, verifyVideoSubmissionArtifacts } from "../../packages/video-studio/src/video-submission-task.js";
import { captureLineageInputs, fingerprintArtifact } from "../../packages/video-studio/src/production-lineage.js";
import { acceptRenderedShot } from "../../packages/video-studio/src/rendered-shot-acceptance.js";
import { applyPromptPatches } from "../../packages/video-studio/src/plausibility-review.js";
import { loadCharacterEntry, readPortraitArtifact, resolveShotCast } from "../../packages/video-studio/src/character-archive.js";
import {
  CONSERVATIVE_BULLET_TIME_CAPABILITIES,
  bulletTimeReferenceClause,
  bulletTimeReferencePlan,
  inspectBulletTimeMotion,
  validateBulletTimePrompt,
} from "../../packages/video-studio/src/bullet-time.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ffmpeg = process.env.WL_FFMPEG ?? "ffmpeg";
const ffprobe = process.env.WL_FFPROBE ?? "ffprobe";
const temporary: string[] = [];
const mediaSha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Card = Record<string, unknown>;
function runChain(shots: Card[], options: { stages?: string; args?: string[]; dir?: string; dryRun?: boolean; project?: string; source?: Card; env?: Record<string, string> } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "video-request-regression-"));
  if (!options.dir) temporary.push(dir);
  const shotsFile = join(dir, "shots.json");
  writeFileSync(shotsFile, JSON.stringify({ title: "摄影增强回归", ...options.source, shots }));
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/tools/full-chain-film.mts",
    "--shots", shotsFile, "--project", options.project ?? "regression", "--work-dir", dir, "--out", join(dir, "out"),
    "--keys-file", join(dir, "no-credentials.env"), "--library", join(dir, "no-characters"),
    /** 出片入口要求分流结论（T-2026-0930-0015）：回归夹具是叙事片，显式声明即可（不猜商品） */
    "--route-kind", "narrative",
    "--platform", "youtube", "--stages", options.stages ?? "cine-kb,micromotion", ...(options.dryRun === false ? [] : ["--dry-run"]), ...(options.args ?? [])
  ], { cwd: root, encoding: "utf8", timeout: 30_000, env: { ...process.env, ARK_API_KEY: "", LLM_API_KEY: "", ...options.env } });
  return {
    dir, result, diagnostic: `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
    read: (file: string) => JSON.parse(readFileSync(join(dir, file), "utf8")),
    rows: () => readFileSync(join(dir, "logs", options.project ?? "regression", "stages.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)),
  };
}

/** Real local media and one declared output-write fault; neither implies provider or quality approval. */
function currentOriginalAndComposeFault(dir: string) {
  const source = join(dir, "clips/regression/EMPTY.mp4"), master = join(dir, "post/regression/master-raw.mp4");
  mkdirSync(dirname(source), { recursive: true });
  const made = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "testsrc2=s=64x96:r=24:d=1",
    "-f", "lavfi", "-i", "sine=frequency=733:sample_rate=48000:duration=1", "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", source],
    { encoding: "utf8", timeout: 15_000 });
  expect(made.status, `${made.error ?? ""}\n${made.stderr}`).toBe(0);
  const measured = spawnSync(ffprobe, ["-v", "error", "-show_streams", "-of", "json", source], { encoding: "utf8", timeout: 15_000 });
  expect(measured.status, `${measured.error ?? ""}\n${measured.stderr}`).toBe(0);
  const video = JSON.parse(measured.stdout).streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
  expect(video).toMatchObject({ width: 64, height: 96, avg_frame_rate: "24/1", nb_frames: "24" });
  expect(Number(video.duration)).toBe(1);
  const sourceSha256 = createHash("sha256").update(readFileSync(source)).digest("hex");
  const faultLog = join(dir, "compose-output-fault.json"), fault = join(dir, "fixture-ffmpeg.mjs");
  writeFileSync(fault, `#!${process.execPath}
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes(process.env.WORKLOOM_TEST_COMPOSE_TARGET)) {
  writeFileSync(process.env.WORKLOOM_TEST_COMPOSE_FAULT_LOG, JSON.stringify({ fixture: "compose-output-fault", target: process.env.WORKLOOM_TEST_COMPOSE_TARGET, argv: args }));
  process.stderr.write("FIXTURE_COMPOSE_NO_OUTPUT" + String.fromCharCode(10)); process.exit(73);
}
const result = spawnSync(process.env.WORKLOOM_TEST_REAL_FFMPEG, args, { stdio: "inherit" });
if (result.error) { process.stderr.write(String(result.error.message)); process.exit(74); }
process.exit(result.status ?? 75);
`);
  chmodSync(fault, 0o700);
  return { source, master, sourceSha256, faultLog, env: { WL_FFMPEG: fault, WL_FFPROBE: ffprobe,
    WORKLOOM_TEST_REAL_FFMPEG: ffmpeg, WORKLOOM_TEST_COMPOSE_TARGET: master, WORKLOOM_TEST_COMPOSE_FAULT_LOG: faultLog } };
}

/** Run the entire current master region in its real async context; absence must stop before inspection or output. */
function currentMissingMaster(dir: string): Promise<void> {
  const file = join(root, "scripts/tools/full-chain-film.mts"), source = readFileSync(file, "utf8");
  const start = source.indexOf("/* ---------- ⑪"), end = source.indexOf("/* ---------- ⑫", start);
  if (start < 0 || end <= start) throw new Error("CURRENT_MASTER_FIXTURE_INVALID: actual master region missing");
  const code = ts.transpileModule(`(async () => {\n${source.slice(start, end)}\n})()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const records: unknown[] = [], scored = join(dir, "post/regression/master-raw.mp4"), deliverablePath = join(dir, "out/regression-30s-final.mp4");
  return (runInNewContext(code, { STAGES: new Set(["master"]), DRY_RUN: false, scored, deliverablePath, existsSync,
    masterGenerationQuality: null, record: (row: unknown) => records.push(row),
    inspectCurrentGeneration: async () => { throw new Error("UNEXPECTED_INSPECTION_WITHOUT_MASTER"); },
  }, { timeout: 1000 }) as Promise<void>).finally(() => {
    expect(records).toEqual([]); expect(readFileSync(file, "utf8")).toBe(source);
  });
}

const emptyShot = { shotId: "EMPTY", duration: 10, scene: "无人的办公室空镜", depth_of_field: "原定深景深" };
const windowShot = { shotId: "PERSON", duration: 10, scene: "人物站在木质窗边的白天室内", action: "看着远处", character: "演员甲", lighting: "右侧窗光" };

describe("全链路镜头增强真实消费", () => {
  it("无人物与商品定妆照的镜头可使用场地参考回退，不访问块外变量", () => {
    const dir = mkdtempSync(join(tmpdir(), "video-render-fallback-")); temporary.push(dir);
    const shotsFile = join(dir, "shots.json");
    writeFileSync(shotsFile, JSON.stringify([{ shotId: "NC-01", duration: 10, scene: "无人的庭院空镜" }]));
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/tools/render-project.mts",
      "--shots", shotsFile, "--project", "regression-empty", "--total-seconds", "10",
      "--dry-run", "--allow-spec-fail"
    ], { cwd: root, encoding: "utf8", timeout: 30_000 });
    expect(result.status, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).not.toContain("ReferenceError");
    expect(JSON.parse(readFileSync(join(dir, "render-summary.json"), "utf8")).shots).toHaveLength(1);
  }, 40_000);

  it("KB之后的微动作读取当前卡片，保留景深与灯光增强", () => {
    const run = runChain([windowShot]);
    expect(run.result.status, run.diagnostic).toBe(0);
    const kb = run.read("shotlist-enriched-regression.json").shots[0];
    const consumed = run.read("shotlist-current-regression.json").shots[0];
    expect(kb.depth_of_field).toBeTruthy();
    expect(consumed.depth_of_field).toBe(kb.depth_of_field);
    expect(consumed.lighting).toEqual(kb.lighting);
    expect(consumed.action).toContain("【微动作】");
    const trace = run.read("micromotion-regression.json").traces[0];
    expect(trace.status).toBe("passed");
    expect(trace.applied.length).toBeGreaterThan(0);
    expect(trace.applied.length).toBeLessThan(4);
    expect(trace.outputHash).toBe(shotIntentHash(consumed.action));
    expect(trace.sourceHash).toBe(normalizeShotIntent(windowShot).sourceHash);
  }, 40_000);

  it("空镜和商品均可不适用：不注入人物、不伪报写入，KB项目聚合允许全 N/A", () => {
    const product = { shotId: "WATCH", duration: 10, scene: "手表产品特写", depth_of_field: "表盘刻度清晰" };
    const run = runChain([emptyShot, product]);
    expect(run.result.status, run.diagnostic).toBe(0);
    expect(run.read("shotlist-current-regression.json").shots).toEqual([emptyShot, product]);
    const kb = run.read("shotlist-enriched-regression.json");
    expect(kb.status).toBe("not_applicable");
    expect(kb.cineKbApplied).toBe(false);
    const micro = run.read("micromotion-regression.json");
    expect(micro.traces.map((trace: Card) => trace.status)).toEqual(["not_applicable", "not_applicable"]);
    expect(micro.traces.every((trace: { applied: unknown[] }) => trace.applied.length === 0)).toBe(true);
    for (const stage of ["cine-kb", "micromotion"]) {
      expect(run.rows().findLast((row: Card) => row.stage === stage)).toMatchObject({ ok: true, evidence: { status: "not_applicable" } });
    }
  }, 40_000);

  it("蹲姿不笑与睡眠只添加适用通道，保留台词/时长/否定原文并核对完整输出", () => {
    const crouch = { shotId: "CROUCH", duration: 8, scene: "女人蹲在庭院中", action: "保持蹲姿，不要起身，不笑", composition: "中景", dialogue: [{ speaker: "演员甲", text: "我保持这个姿势。" }] };
    const sleep = { shotId: "SLEEP", duration: 6, scene: "女人躺在床上熟睡", action: "保持睡眠，闭着眼睛", composition: "中景" };
    const run = runChain([crouch, sleep]);
    expect(run.result.status, run.diagnostic).toBe(0);
    const current = run.read("shotlist-current-regression.json").shots;
    const micro = run.read("micromotion-regression.json");
    for (const [index, original] of [crouch, sleep].entries()) {
      const trace = micro.traces[index];
      expect(trace.status).toBe("passed");
      expect(trace.applied.length).toBeLessThan(4);
      expect(current[index].action.startsWith(original.action)).toBe(true);
      expect(current[index].action.endsWith("【微动作】" + trace.applied.map((entry: { clause: string }) => entry.clause).join("；"))).toBe(true);
      expect(trace.outputHash).toBe(shotIntentHash(current[index].action));
      expect(trace.sourceHash).toBe(normalizeShotIntent(original).sourceHash);
      expect(current[index].duration).toBe(original.duration);
    }
    expect(current[0].dialogue).toEqual(crouch.dialogue);
    expect(micro.traces[0].text).not.toMatch(/笑意|站起|起身|台词节拍/);
    expect(micro.traces[1].applied.map((entry: { id: string }) => entry.id)).not.toContain("eyes");
    expect(micro.traces[1].text).not.toMatch(/眨眼|睁眼|笑意/);
  }, 40_000);

  it.each([
    { label: "未知主体", card: { shotId: "UNKNOWN", duration: 10 } },
    { label: "没有来源的旧标记", card: { ...windowShot, action: "站着；【微动作】人工添加的旧动作" } },
  ])("$label 不能靠 skipped 或单标记伪过微动作门", ({ card }) => {
    const run = runChain([card], { stages: "micromotion" });
    expect(run.result.status, run.diagnostic).not.toBe(0);
    expect(run.read("micromotion-regression.json").traces[0].status).toBe("unverified");
    expect(run.rows().findLast((row: Card) => row.stage === "micromotion")).toMatchObject({ ok: false, evidence: { status: "unverified" } });
    expect(existsSync(join(run.dir, "shotlist-current-regression.json"))).toBe(false);
  }, 40_000);

  it("KB第一镜未验证、最后一镜成功时，项目仍失败且停止下游", () => {
    const run = runChain([{ shotId: "UNKNOWN", duration: 10 }, windowShot]);
    expect(run.result.status, run.diagnostic).not.toBe(0);
    const rows = run.rows().filter((row: Card) => row.stage === "cine-kb");
    expect(rows.map((row: { evidence: Card }) => row.evidence.status)).toEqual(["unverified", "passed", "unverified"]);
    expect(rows.at(-1)).toMatchObject({ shotId: null, ok: false });
    expect(run.read("shotlist-enriched-regression.json").status).toBe("unverified");
    expect(run.rows().some((row: Card) => row.stage === "micromotion")).toBe(false);
  }, 40_000);

  it("KB部分字段超预算不能用其余成功写入掩盖", () => {
    const run = runChain([{ ...windowShot, lighting: `右侧窗光；${"原始灯光说明".repeat(80)}` }]);
    expect(run.result.status, run.diagnostic).not.toBe(0);
    const row = run.rows().find((entry: Card) => entry.stage === "cine-kb" && entry.shotId === windowShot.shotId);
    expect(row).toMatchObject({ ok: false, evidence: { status: "unverified" } });
    expect(row.evidence.injectedFields).not.toContain("lighting");
    expect(run.read("shotlist-enriched-regression.json").shots[0].lighting).toBe(`右侧窗光；${"原始灯光说明".repeat(80)}`);
  }, 40_000);

  it("请求的KB目录缺失会记录未验证并停止，而非跳过后继续微动作", () => {
    const run = runChain([windowShot], { args: ["--kb-dir", join(tmpdir(), "workloom-no-kb", "missing")] });
    expect(run.result.status, run.diagnostic).not.toBe(0);
    expect(run.rows().findLast((row: Card) => row.stage === "cine-kb")).toMatchObject({ ok: false, evidence: { status: "unverified" } });
    expect(run.rows().some((row: Card) => row.stage === "micromotion")).toBe(false);
  }, 40_000);

  it("当前镜头JSON重新作为输入时保持幂等，trace仍核到实际消费卡片", () => {
    const first = runChain([emptyShot, windowShot]);
    expect(first.result.status, first.diagnostic).toBe(0);
    const original = first.read("shotlist-current-regression.json").shots;
    const second = runChain(original, { dir: first.dir });
    expect(second.result.status, second.diagnostic).toBe(0);
    expect(second.read("shotlist-current-regression.json").shots).toEqual(original);
    const trace = second.read("micromotion-regression.json").traces[1];
    expect(trace.charDelta).toBe(0);
    expect(trace.skipped).toContain("幂等");
    expect(trace.outputHash).toBe(shotIntentHash(original[1].action));
  }, 40_000);

  it("G7复核合法N/A与真实两通道写入，记录当前证据而非历史成功或marker计数", () => {
    const run = runChain([emptyShot, windowShot], { stages: "micromotion,videos", args: ["--accept-env-defects"] });
    // These fixtures intentionally have no approved prompts/plates, so G7 still blocks rendering.
    expect(run.result.status, run.diagnostic).toBe(5);
    const gate = run.rows().find((row: Card) => row.stepKey === "g7-preproduction");
    expect(gate.checks.find((check: Card) => check.id === "micromotion-applied")).toMatchObject({ pass: true, hard: true });
    expect(gate.evidence.micromotionEvidence.map((entry: Card) => entry.status)).toEqual(["not_applicable", "passed"]);
    expect(gate.evidence.micromotionEvidence.every((entry: Card) => entry.verified === true)).toBe(true);
    expect(gate.evidence.micromotionEvidence[1].outputHash).toBe(shotIntentHash(run.read("shotlist-current-regression.json").shots[1].action));
  }, 40_000);
});


describe("全链路当前血缘与返修范围", () => {
  it.each(["compose", "color", "bgm", "master", "deliver", "revise"])("单镜范围不能误进整片 %s", (stage) => {
    const run = runChain([emptyShot], { stages: stage, args: ["--only", "EMPTY"] });
    expect(run.result.status, run.diagnostic).not.toBe(0);
    expect(run.diagnostic).toContain("SELECTED_SHOTS_POST_SCOPE");
  }, 40_000);
  it("未知阶段和未知镜号在执行前拒绝", () => {
    for (const options of [{ stages: "typo" }, { stages: "micromotion", args: ["--only", "GHOST"] }]) {
      const run = runChain([emptyShot], options);
      expect(run.result.status, run.diagnostic).not.toBe(0);
      expect(run.diagnostic).toMatch(/UNKNOWN_STAGE|SHOT_SCOPE_UNKNOWN/);
    }
  }, 40_000);
  it("镜号重复和路径字符不能混入同一产物目录", () => {
    for (const shots of [[emptyShot, emptyShot], [{ ...emptyShot, shotId: "../other" }]]) {
      const run = runChain(shots);
      expect(run.result.status, run.diagnostic).not.toBe(0);
      expect(run.diagnostic).toContain("SHOT_REGISTRY_INVALID");
    }
  }, 40_000);
  it("尚未生成镜头的生产执行不能用豁免开关把缺测变合格", () => {
    const run = runChain([emptyShot], { stages: "videos", dryRun: false, args: ["--accept-rejected", "G7"] });
    expect(run.result.status, run.diagnostic).not.toBe(0);
    expect(run.diagnostic).toContain("PRODUCTION_BYPASS_REJECTED");
  }, 40_000);
  it("只有旧成功日志、本次合成不产出母版时不能报告请求完成", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "video-current-proof-"))); temporary.push(dir);
    mkdirSync(join(dir, "logs/regression"), { recursive: true });
    const oldRow = JSON.stringify({ stage: "master", ok: true, shotId: null });
    writeFileSync(join(dir, "logs/regression/stages.jsonl"), oldRow + "\n");
    const media = currentOriginalAndComposeFault(dir), shot = { ...emptyShot, duration: 1 }, document = { durationSeconds: 1 };
    const run = runChain([shot], { dir, stages: "master", dryRun: false, source: document, env: media.env,
      args: ["--assembly-mode", "post-only", "--assembly-reason", "Declared local media fixture; no provider or quality authority"] });
    expect(run.result.status, run.diagnostic).toBe(1);
    expect(run.diagnostic, run.diagnostic).toContain("COMPOSE_PROCESSING_FAILED");
    const fault = JSON.parse(readFileSync(media.faultLog, "utf8"));
    expect(fault).toMatchObject({ fixture: "compose-output-fault", target: media.master });
    expect(fault.argv.at(-1)).toBe(media.master);
    expect(createHash("sha256").update(readFileSync(media.source)).digest("hex")).toBe(media.sourceSha256);
    expect(readFileSync(join(dir, "logs/regression/stages.jsonl"), "utf8").split("\n")[0]).toBe(oldRow);
    const rows = run.rows();
    expect(rows.filter((row: Card) => row.stage === "compose")).toHaveLength(1);
    expect(rows.find((row: Card) => row.stage === "compose")).toMatchObject({ invoked: true, ok: false });
    expect(rows.slice(1).some((row: Card) => ["master", "deliver"].includes(String(row.stage)) && row.ok === true)).toBe(false);
    expect(existsSync(media.master)).toBe(false);
    expect(existsSync(join(dir, "out"))).toBe(false);
  }, 40_000);
  it("当前母版出口不能用旧成功日志放行缺失的本次文件", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "video-missing-master-entry-"))); temporary.push(dir);
    mkdirSync(join(dir, "logs/regression"), { recursive: true });
    const old = JSON.stringify({ stage: "master", ok: true, shotId: null }) + "\n";
    writeFileSync(join(dir, "logs/regression/stages.jsonl"), old);
    await expect(currentMissingMaster(dir)).rejects.toThrow(/MASTER_POST_OUTPUT_MISSING/);
    expect(readFileSync(join(dir, "logs/regression/stages.jsonl"), "utf8")).toBe(old);
    expect(existsSync(join(dir, "out/regression-30s-final.mp4"))).toBe(false);
  });
  it("不同项目在同一work目录独立记账且当前输入输出含实际指纹", () => {
    const first = runChain([emptyShot], { stages: "micromotion", project: "project-a" });
    expect(first.result.status, first.diagnostic).toBe(0);
    const before = readFileSync(join(first.dir, "logs/project-a/stages.jsonl"), "utf8");
    const second = runChain([windowShot], { dir: first.dir, stages: "micromotion", project: "project-b" });
    expect(second.result.status, second.diagnostic).toBe(0);
    expect(readFileSync(join(first.dir, "logs/project-a/stages.jsonl"), "utf8")).toBe(before);
    const row = second.rows().find((entry: Card) => entry.stage === "micromotion");
    expect(row.lineage.projectId).toBe("project-b");
    expect(row.lineage.outputs[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  }, 40_000);
  it("修复另一镜输入不会使未选镜头自己的源指纹改变", () => {
    const first = runChain([emptyShot, windowShot], { stages: "cine-kb" });
    expect(first.result.status, first.diagnostic).toBe(0);
    const firstRow = first.rows().find((entry: Card) => entry.stage === "cine-kb" && entry.shotId === "EMPTY");
    const second = runChain([emptyShot, { ...windowShot, dialogue: [{ text: "仅改这一镜" }] }], { dir: first.dir, stages: "cine-kb", args: ["--only", "PERSON"] });
    expect(second.result.status, second.diagnostic).toBe(0);
    const existing = second.rows().find((entry: Card) => entry.stage === "cine-kb" && entry.shotId === "EMPTY");
    expect(existing.lineage).toEqual(firstRow.lineage);
    expect(existing.lineage.inputs.map((entry: Card) => entry.path)).not.toContain(join(first.dir, "shots.json"));
    const aggregate = second.rows().findLast((entry: Card) => entry.stage === "cine-kb" && entry.shotId === null);
    expect(aggregate.lineage.sourceHash).not.toBe(first.rows().find((entry: Card) => entry.stage === "cine-kb" && entry.shotId === null).lineage.sourceHash);
  }, 40_000);
  it("UHD 仍可复用 HD 的前期镜头源回执，后期增强单独按整份分镜绑定", () => {
    const first = runChain([emptyShot, windowShot], { stages: "cine-kb", args: ["--quality", "hd", "--only", "EMPTY"] });
    expect(first.result.status, first.diagnostic).toBe(0);
    const before = first.rows().findLast((entry: Card) => entry.stage === "cine-kb" && entry.shotId === "EMPTY");
    const second = runChain([emptyShot, { ...windowShot, dialogue: [{ text: "另一镜新台词" }] }], {
      dir: first.dir, stages: "cine-kb", args: ["--quality", "uhd", "--only", "EMPTY"],
    });
    expect(second.result.status, second.diagnostic).toBe(0);
    const after = second.rows().findLast((entry: Card) => entry.stage === "cine-kb" && entry.shotId === "EMPTY");
    expect(after.lineage.projectId).toBe(before.lineage.projectId);
    expect(after.lineage.sourceHash).toBe(before.lineage.sourceHash);
    expect(after.lineage.recipeHash).toBe(before.lineage.recipeHash);
  }, 40_000);
});

describe("成片硬切 CFR 接缝", () => {
  const available = [ffmpeg, ffprobe].every((bin) => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0);

  it.skipIf(!available)("视频直拷拼接的每个接缝保持整帧间隔，音画同步按同一时长计算", () => {
    const dir = mkdtempSync(join(tmpdir(), "compose-cfr-")); temporary.push(dir);
    const clips: string[] = [];
    for (const [index, color] of ["red", "green", "blue"].entries()) {
      const file = join(dir, `source-${index}.mp4`);
      const made = spawnSync(ffmpeg, [
        "-hide_banner", "-v", "error", "-y",
        "-f", "lavfi", "-i", `color=c=${color}:s=64x96:r=8:d=1`,
        "-f", "lavfi", "-i", `anoisesrc=color=white:seed=${index + 7}:r=48000:d=1`,
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "ultrafast",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", file,
      ], { encoding: "utf8", timeout: 15_000 });
      expect(made.status, `${made.error ?? ""}\n${made.stderr}`).toBe(0);
      clips.push(file);
    }
    const sourceSha256 = clips.map(mediaSha256);
    const master = join(dir, "master.mp4");
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/tools/compose-film.mts",
      "--clips", clips.join(","), "--out", master, "--width", "64", "--height", "96",
      "--fps", "8", "--fade", "0", "--color", "none", "--keep-temp",
    ], {
      cwd: root, encoding: "utf8", timeout: 90_000,
      env: { ...process.env, TMPDIR: dir, WL_FFMPEG: ffmpeg, WL_FFPROBE: ffprobe },
    });
    expect(result.status, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`).toBe(0);
    const work = join(dir, readdirSync(dir).find((name) => name.startsWith("wl-compose-")) ?? "missing");
    expect(readFileSync(join(work, "concat.txt"), "utf8").match(/^duration 1\.000000$/gm)).toHaveLength(3);
    for (const file of [join(work, "video-only.mp4"), join(work, "raw.mp4"), master]) {
      const read = spawnSync(ffprobe, [
        "-v", "error", "-select_streams", "v:0", "-show_packets",
        "-show_entries", "stream=r_frame_rate,nb_frames:packet=pts_time", "-of", "json", file,
      ], { encoding: "utf8", timeout: 15_000 });
      expect(read.status, `${read.error ?? ""}\n${read.stderr}`).toBe(0);
      const doc = JSON.parse(read.stdout) as {
        streams: Array<{ r_frame_rate: string; nb_frames: string }>;
        packets: Array<{ pts_time: string }>;
      };
      const pts = doc.packets.map((packet) => Number(packet.pts_time)).sort((a, b) => a - b);
      expect(Number(doc.streams[0]!.nb_frames), file).toBe(24);
      expect(doc.streams[0]!.r_frame_rate, file).toBe("8/1");
      expect(pts, file).toHaveLength(24);
      for (let index = 1; index < pts.length; index += 1) {
        expect(pts[index]! - pts[index - 1]!, `${file}: frame ${index}`).toBeCloseTo(0.125, 4);
      }
    }
    const sync = JSON.parse(readFileSync(join(dir, "master.av-sync.json"), "utf8"));
    expect(sync.schemaVersion).toBe("workloom.compose-timeline/v1");
    expect(sync.timelineSeconds).toEqual([1, 1, 1]);
    expect(sync.retimeFactor).toBe(1);
    expect(sync.outputSha256).toBe(mediaSha256(master));
    expect(sync.acousticComparison).toBe("not_performed");
    const clock = spawnSync(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", master], { encoding: "utf8" });
    expect(clock.status, clock.stderr).toBe(0);
    const clockDoc = JSON.parse(clock.stdout);
    const video = clockDoc.streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
    const audio = clockDoc.streams.find((stream: { codec_type: string }) => stream.codec_type === "audio");
    expect(sync.outputDurationSec).toBe(Number(clockDoc.format.duration));
    expect(sync.outputVideoDurationSec).toBe(Number(video.duration));
    expect(sync.outputAudioDurationSec).toBe(Number(audio.duration));
    expect(Number(video.duration)).toBe(3);
    expect(audio.sample_rate).toBe("48000"); expect(audio.channels).toBe(2);
    expect(Math.abs(Number(audio.duration) - 3)).toBeLessThanOrEqual(1024 / 48000);
    expect(clips.map(mediaSha256)).toEqual(sourceSha256);
  }, 100_000);

  it.skipIf(!available)("--transition-at 3 只在第三镜入点转场，音画起点与刀数同源", () => {
    const dir = mkdtempSync(join(tmpdir(), "compose-transition-entry-")); temporary.push(dir);
    const clips: string[] = [];
    for (const [index, color] of ["red", "green", "blue"].entries()) {
      const file = join(dir, `source-${index}.mp4`);
      const made = spawnSync(ffmpeg, [
        "-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=64x96:r=8:d=1`,
        "-f", "lavfi", "-i", `anoisesrc=color=white:seed=${index + 31}:r=48000:d=1`,
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "ultrafast",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", file,
      ], { encoding: "utf8", timeout: 15_000 });
      expect(made.status, `${made.error ?? ""}\n${made.stderr}`).toBe(0);
      clips.push(file);
    }
    const sourceSha256 = clips.map(mediaSha256);
    const master = join(dir, "master.mp4");
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/tools/compose-film.mts",
      "--clips", clips.join(","), "--out", master, "--width", "64", "--height", "96", "--fps", "8",
      "--fade", "0", "--color", "none", "--transition", "fade", "--transition-duration", "0.25",
      "--transition-at", "3",
    ], { cwd: root, encoding: "utf8", timeout: 90_000, env: { ...process.env, WL_FFMPEG: ffmpeg, WL_FFPROBE: ffprobe } });
    expect(result.status, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("× 1 刀");
    const duration = spawnSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", master], { encoding: "utf8" });
    expect(Math.abs(Number(duration.stdout.trim()) - 2.75)).toBeLessThanOrEqual(0.13); // ≤1 frame @8fps
    const report = JSON.parse(readFileSync(join(dir, "master.av-sync.json"), "utf8"));
    expect(report.outputSha256).toBe(mediaSha256(master));
    expect(report.clipCount).toBe(3);
    expect(report.schemaVersion).toBe("workloom.compose-timeline/v1");
    expect(report.timelineSeconds).toEqual([1, 1, 1]);
    expect(report.outputDurationSec).toBeCloseTo(Number(duration.stdout.trim()), 6);
    expect(report.acousticComparison).toBe("not_performed");
    const clock = spawnSync(ffprobe, ["-v", "error", "-show_streams", "-of", "json", master], { encoding: "utf8" });
    expect(clock.status, clock.stderr).toBe(0);
    const streams = JSON.parse(clock.stdout).streams as Array<{ codec_type: string; duration: string; sample_rate?: string }>;
    const video = streams.find((stream) => stream.codec_type === "video")!;
    const audio = streams.find((stream) => stream.codec_type === "audio")!;
    expect(report.outputVideoDurationSec).toBe(Number(video.duration));
    expect(report.outputAudioDurationSec).toBe(Number(audio.duration));
    expect(audio.sample_rate).toBe("48000");
    expect(Math.abs(Number(audio.duration) - Number(video.duration))).toBeLessThanOrEqual(1024 / 48000);
    expect(clips.map(mediaSha256)).toEqual(sourceSha256);
    const pixel = (at: number) => {
      const frame = spawnSync(ffmpeg, ["-v", "error", "-ss", String(at), "-i", master, "-frames:v", "1",
        "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer" });
      expect(frame.status, `${frame.error ?? ""}\n${String(frame.stderr)}`).toBe(0);
      expect(frame.stdout.length).toBe(3);
      return [...frame.stdout.subarray(0, 3)] as [number, number, number];
    };
    const firstCut = pixel(1.125), beforeThirdEntry = pixel(1.625), thirdShot = pixel(2.125);
    expect(firstCut[1]).toBeGreaterThan(firstCut[2]); // second shot, not a blend into blue
    expect(beforeThirdEntry[1]).toBeGreaterThan(beforeThirdEntry[2]); // old index error cuts to blue here
    expect(thirdShot[2]).toBeGreaterThan(thirdShot[1]);
  }, 100_000);
});


describe("全链路冻结年代与原合同接线", () => {
  it.each([
    { sourceResolution: "720p", args: [], expectedSource: "720p", expectedOutput: "720p", quality: "hd" },
    { sourceResolution: "2160p", args: [], expectedSource: "1080p", expectedOutput: "2160p", quality: "uhd" },
    { sourceResolution: "720p", args: ["--resolution", "1080p"], expectedSource: "1080p", expectedOutput: "1080p", quality: "hd" },
  ])("源规格 $sourceResolution 与明确覆盖保留4K源片/交付档边界", ({ sourceResolution, args, expectedSource, expectedOutput, quality }) => {
    const run = runChain([emptyShot], { stages: "plates", source: { aspect: "16:9", resolution: sourceResolution }, args: ["--accept-env-defects", ...args] });
    expect(run.result.status, run.diagnostic).toBe(0);
    const prompt = run.rows().find((r: Card) => r.stage === "keyframe").evidence.prompt;
    expect(prompt).toContain("16:9 横幅");
    expect(prompt).toContain(expectedSource);
    expect(run.diagnostic).toContain(`源 ${expectedSource} → 交付 ${expectedOutput}`);
    expect(run.diagnostic).toContain(`(${quality === "uhd" ? "3840x2160" : expectedOutput === "720p" ? "1280x720" : "1920x1080"})`);
    if (quality === "uhd") expect(prompt).not.toContain("2160p");
  }, 40_000);
  it("新项目默认当天且续跑保存同一日期，源合同记录进入血缘", () => {
    const first = runChain([emptyShot], { stages: "micromotion" });
    expect(first.result.status, first.diagnostic).toBe(0);
    const context = first.read("logs/regression/project-context.json");
    expect(context.eraProfile.storyDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const next = runChain([emptyShot], { stages: "micromotion", dir: first.dir });
    expect(next.result.status, next.diagnostic).toBe(0);
    expect(next.read("logs/regression/project-context.json")).toEqual(context);
    expect(next.rows().findLast((r: Card) => r.stage === "micromotion").lineage.inputs.some((input: Card) => typeof input.path === "string" && input.path.endsWith("project-context.json"))).toBe(true);
  }, 40_000);
  it("片级历史日期与局部闪回进入实际关键帧prompt，并继承源横幅", () => {
    const shot = { shotId: "PAIR", duration: 8, scene: "两个女人在海边岩石上相对站立", action: "两人不笑，保持站姿", composition: "双人中景", lighting: "2200K 暖烛光，日落余光", depth_of_field: "两人与海岸同时清晰", eraProfile: { storyDate: "1995-08-02" }, environmentProfile: { setting: "exterior", condition: "natural" } };
    const run = runChain([shot], { stages: "plates", source: { eraProfile: { storyDate: "2025-01-01" }, aspect: "16:9" }, args: ["--accept-env-defects"] });
    expect(run.result.status, run.diagnostic).toBe(0);
    const prompt = run.rows().find((r: Card) => r.stage === "keyframe").evidence.prompt;
    expect(prompt).toContain("16:9 横幅"); expect(prompt).toContain("人数 2");
    expect(prompt).toContain("1995-08-02"); expect(prompt).toContain("2200K 暖烛光");
    expect(prompt).toContain("两人与海岸同时清晰"); expect(prompt).not.toContain("5600K");
    expect(run.read("logs/regression/project-context.json").eraProfile.storyDate).toBe("2025-01-01");
  }, 40_000);
  it("外部场景圣经年代默认继承，逐镜未来设备被报告", () => {
    const dir = mkdtempSync(join(tmpdir(), "film-bible-era-")); temporary.push(dir);
    const bible = { spaceId: "coast", space: { city: "上海", building: "海边岩岸", orientation: "朝海", timeOfDay: "傍晚" }, materials: [], practicalLights: [{ type: "日落天光", direction: "西侧" }], traces: [], environmentProfile: { setting: "exterior", condition: "natural" }, eraProfile: { storyDate: "2024-01-01" } };
    const biblePath = join(dir, "bible.json"); writeFileSync(biblePath, JSON.stringify(bible));
    const shot = { ...emptyShot, scene: "无人的海边空镜，岩石上静置手机", devices: [{ category: "phone", model: "iPhone 16 Pro" }] };
    const run = runChain([shot], { dir, stages: "micromotion", args: ["--scene-bible", biblePath] });
    expect(run.result.status, run.diagnostic).toBe(0);
    const report = run.read("env-realism-report-regression.json");
    expect(report.eraProfile.storyDate).toBe("2024-01-01");
    expect(report.summary.device.hard).toBeGreaterThan(0);
    expect(JSON.stringify(report.defects)).toContain("2024-01-01");
  }, 40_000);
  it("已经冻结后改源年代明确拒绝，不能默默盖写", () => {
    const first = runChain([emptyShot], { stages: "micromotion", source: { eraProfile: { storyDate: "2024-01-01" } } });
    expect(first.result.status, first.diagnostic).toBe(0);
    const second = runChain([emptyShot], { stages: "micromotion", dir: first.dir, source: { eraProfile: { storyDate: "2025-01-01" } } });
    expect(second.result.status).not.toBe(0); expect(second.diagnostic).toContain("FILM_ERA_CONFLICT");
    expect(second.read("logs/regression/project-context.json").eraProfile.storyDate).toBe("2024-01-01");
  }, 40_000);
});


/** Execute the current parsed CLI statements, not a second implementation. Every external result is an explicit isolated fixture. */
function currentCliParts() {
  const file = join(root, "scripts/tools/full-chain-film.mts"), source = readFileSync(file, "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const fn = (name: string) => {
    const declaration = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!declaration) throw new Error(`CURRENT_CLI_FUNCTION_MISSING:${name}`);
    return declaration.getText(parsed);
  };
  const stage = (name: string) => {
    const statement = parsed.statements.find((node) => ts.isIfStatement(node) && node.expression.getText(parsed) === `STAGES.has("${name}")`);
    if (!statement || !ts.isIfStatement(statement) || !ts.isBlock(statement.thenStatement)) throw new Error(`CURRENT_CLI_STAGE_MISSING:${name}`);
    return statement;
  };
  const material = stage("material-gen").getText(parsed);
  const videos = stage("videos");
  const loop = (videos.thenStatement as ts.Block).statements.find(ts.isForOfStatement);
  if (!loop) throw new Error("CURRENT_CLI_VIDEO_LOOP_MISSING");
  return { fn, material, videos: loop.getText(parsed) };
}
function evaluateCurrent(code: string, context: Record<string, unknown>): unknown {
  const javascript = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return runInNewContext(javascript, context, { timeout: 2000 });
}
const fixtureSha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

function currentSubmissionFixture(kind: "material" | "normal" | "asset", verdict: "pass" | "block" | "unverified" = "pass", providerStatus = "succeeded", canonicalPrompt = "") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "seedance-current-cli-"))); temporary.push(dir);
  const promptDir = join(dir, "prompts"), plateDir = join(dir, "plates"), clips = join(dir, "clips");
  for (const path of [promptDir, plateDir, clips]) mkdirSync(path);
  const photo = join(dir, "product.png"); writeFileSync(photo, Buffer.alloc(60_001, 4));
  const sidePhoto = join(dir, "product-side.png"); writeFileSync(sidePhoto, Buffer.alloc(60_002, 3));
  const front = join(dir, "front.png"), closeup = join(dir, "closeup.png");
  writeFileSync(front, Buffer.alloc(60_003, 5)); writeFileSync(closeup, Buffer.alloc(60_005, 6));
  const images = [front, closeup].map((path, index) => ({ url: `data:image/png;base64,${readFileSync(path).toString("base64")}`, purpose: index ? "portrait-closeup" : "portrait-front",
    characterId: "fictional-adult", characterVersion: 2, angle: index ? "closeup" : "front", artifact: { path, sha256: mediaSha256(path), bytes: readFileSync(path).length, mime: "image/png" } }));
  const shot = { shotId: "S1", duration: 13, character: "原创成年人物", ...(canonicalPrompt ? { prompt: canonicalPrompt } : {}),
    ...(kind === "material" ? { photo, productRef: { category: "vehicle", displayName: "演示摩托车", photos: [
      { path: photo, angle: "side" }, { path: sidePhoto, angle: "three-quarter" },
    ] } } : {}),
    ...(kind === "asset" ? { assetRef: "asset://authorized-fixture-id" } : {}) };
  writeFileSync(join(plateDir, "S1-plate.png"), Buffer.alloc(60_007, 7));
  writeFileSync(join(promptDir, "S1.txt"), `【约束】9:16 ${"正式原始镜头提示词，保持完整叙事与原生声音。".repeat(75)}`);
  const rows: Card[] = [], gates: Card[] = [], paidBodies: Card[] = [], snapshots = new Map(), accepted: Card[] = [], reviews: Card[] = [];
  let posts = 0, gets = 0;
  const sourceHash = fixtureSha("formal fixture source");
  const env: Card = { SEEDANCE_GENERATE_AUDIO: "1", LLM_PROVIDER: "isolated-fixture" };
  const parts = currentCliParts();
  const context: Record<string, unknown> = {
    Buffer, Date, Promise, Error, Set, Map, Number, String, Object, Array, JSON, Math, createHash, randomUUID: () => `fixture-${Math.random().toString(36).slice(2)}`,
    readFileSync, writeFileSync, existsSync, statSync, mkdirSync, openSync, closeSync, fsyncSync, linkSync, copyFileSync, rmSync, fsConstants,
    basename: (path: string) => path.split("/").at(-1), dirname, join, resolve, fingerprintArtifact,
    WORK_DIR: dir, PROJECT: "ISOLATED-CURRENT", RUN_ID: "fixture-run", PROMPT_DIR: promptDir, PLATE_DIR: plateDir, CLIP_DIR: clips,
    SOURCE_SIZE: { width: 64, height: 96 }, ASPECT: "9:16", SOURCE_RESOLUTION: "720p", OUTPUT_RESOLUTION: "720p", FPS: 24,
    VIDEO_MODEL: "doubao-seedance-2-5-260628", ENV: env, ARK_KEY: "isolated-fixture-secret", ARK_BASE: "https://invalid.test/api/v3", WORKER_RUNTIME: null,
    BULLET_TIME_CAPABILITIES: { ...CONSERVATIVE_BULLET_TIME_CAPABILITIES, maxReferenceImages: 30 },
    bulletTimeReferencePlan, bulletTimeReferenceClause, inspectBulletTimeMotion, validateBulletTimePrompt,
    STAGES: new Set([kind === "material" ? "material-gen" : "videos"]), FIRST_PASS_ORDER: [shot], DRY_RUN: false, RESUME: false,
    MATERIAL_POST_ONLY: false, MATERIAL_SPEED_RAMP: false, MATERIAL_POST_CAMERA_MOVE: false, MAX_ATTEMPTS: 3, ACCEPT_REJECTED: [],
    FILM_SPEECH_LANGUAGE: "zh-CN", REALISM_CLAUSE: "实拍质感", REALISM_NEGATIVE_TERMS: "不改身份", MATERIAL_POLICY_VERSION: "fixture-policy", PLAUSIBILITY_POLICY_VERSION: "fixture-plausibility",
    shotlist: { title: "正式隔离镜头", durationSeconds: 13 }, totalSeconds: 13, lead: { name: "原创成年人物", appearanceText: "成年虚构人物" },
    policyBrief: null, sourceCharacter: { id: "fictional-adult", name: "原创成年人物" },
    sourceDocument: { character: { id: "fictional-adult", name: "原创成年人物" }, shots: [shot] },
    usePortraitRefs: true, portraitReferenceClause: "【人物参考】图1图2是同一虚构成年人，图3是商品。", REVISION_CONTEXT: "",
    productLibrary: { archives: [] }, selectProductArchive: () => ({ archive: null }), arg: (_name: string, fallback = "") => fallback, flag: () => false,
    isMaterialShot: () => kind === "material", isProductMaterialShot: (value: Card) => Boolean(value.productRef),
    isAssetShot: () => kind === "asset", isAssetRefLocal: (path: string) => path.startsWith("asset://"), assetRefOf: () => "asset://authorized-fixture-id",
    hasRenderedSource: () => false, pendingShots: () => [shot], shots: [shot], abs: (path: string) => path,
    readMaterialSpec: () => ({ photo, usage: "generation-reference", focus: { x: 0.5, y: 0.5 } }),
    run: (_binary: string, args: string[]) => writeFileSync(args.at(-1)!, Buffer.alloc(60_009, 8)), FFMPEG: "isolated-no-process",
    buildMaterialScenePrompt: () => `实景依据 构建一段 不得复刻参考图的构图 贴图式运动 画面全程静止 9:16 ${"完整商品场景说明。".repeat(65)}`,
    buildCinematicContract: () => ({}), appendCinematicContract: (text: string) => text,
    dialogueLines: () => [], noSpeechClause: () => "无对白", speechNegativeTerms: () => "禁止额外台词",
    portraitVideoInputs: () => kind === "asset" ? { images: [], paths: [] } : { images, paths: [front, closeup] }, leadVisibleInShot: () => kind !== "asset",
    refsForShot: () => kind === "asset" ? ["asset://authorized-fixture-id"] : [front, closeup],
    loadHostedUrl: () => { throw new Error("PORTRAIT_MUST_NOT_USE_HOSTED_FIRST_FRAME"); }, dataUrl: () => { throw new Error("PORTRAIT_MUST_NOT_USE_PLATE_FIRST_FRAME"); },
    localReviewRefsEarly: (list: string[]) => list.filter(existsSync), resolveProducerLlm: () => ({ model: "isolated-review-fixture" }),
    reviewPlausibility: async (input: Card) => { reviews.push(input); return { verdict, findings: [], promptPatches: verdict === "pass" && kind === "material" ? [{ shotId: "S1", clauses: ["真正提交应包含这条最终常识补丁。"] }] : [], reason: "isolated review result", model: "isolated-review-fixture", ms: 0 }; },
    applyPromptPatches,
    rememberInputs: (stage: string, paths: string[], id: string | null = null) => { const snapshot = captureLineageInputs(paths.filter((path) => !path.startsWith("asset://"))); if (snapshot.errors.length) throw new Error(snapshot.errors.join(";")); snapshots.set(`${stage}:${id ?? ""}`, snapshot); },
    lineageInputSnapshots: snapshots,
    recordGate: (input: Card) => { gates.push(input); const checks = input.checks as Array<{ pass: boolean; hard?: boolean }>; return { approved: checks.every((check) => check.hard === false || check.pass), reason: "isolated deterministic gate" }; },
    record: (row: Card) => { rows.push(row); return row; }, log: () => {}, sha256FileSync: mediaSha256,
    buildVideoSubmissionRequest, verifyVideoSubmissionArtifacts,
    runVideoSubmission: (scope: Parameters<typeof runVideoSubmission>[0], options: Parameters<typeof runVideoSubmission>[1]) => runVideoSubmission(scope, { ...options, pollIntervalMs: 1, pollTimeoutMs: 20,
      fetch: (async (_url, init) => { if (init?.method === "POST") { posts++; paidBodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ id: "task-current-fixture" })); } gets++; return new Response(JSON.stringify({ status: providerStatus, content: { video_url: "https://invalid.test/current.mp4" }, error: providerStatus === "failed" ? { code: "FixtureProviderFailed" } : undefined })); }) as typeof fetch }),
    sourceHashFor: () => sourceHash,
    download: async (_url: string, path: string) => { writeFileSync(path, Buffer.alloc(70_001, 9)); return path; },
    renderedScope: () => ({ projectId: "ISOLATED-CURRENT", shotId: "S1", sourceHash }), acceptRenderedShot,
    recordRenderedSource: (_id: string, _file: string, receipt: Card, options: Card) => accepted.push({ receipt, options }),
    readStageHistory: () => [], findRenderedShotAcceptance: () => null,
    preflightSubmitGuard: (input: Card) => { if (kind === "material") expect(input.prompt).toContain("真正提交应包含这条最终常识补丁"); },
    retryInstruction: () => { throw new Error("PAID_POST_MUST_NOT_RETRY"); }, motionPolicyForShot: () => ({ intent: "ordinary" }),
    applySpeedRamp: () => { throw new Error("UNREQUESTED_RETIME"); }, applyCameraMovePunchCut: () => { throw new Error("UNREQUESTED_CAMERA_MOVE"); },
  };
  const functions = ["videoImage", "submissionReceiptArtifacts", "videoPlan", "arkVideo", "downloadSubmittedVideo", "finishMaterialClip", "portraitReferenceClauseFor", "shotAuthoredText", "correctFilmPlausibilityConflicts", "renderSecondsFor", "plausibilityArchiveFor", "productReferencePaths", "buildCurrentMaterialPrompt", "plausibilityContextFor", "runPlausibilityGate"].map(parts.fn).join("\n");
  const execute = () => evaluateCurrent(`(async()=>{${functions}\n${kind === "material" ? parts.material : parts.videos}\n})()`, context) as Promise<void>;
  return { dir, execute, context, gates, paidBodies, rows, accepted, reviews, get posts() { return posts; }, get gets() { return gets; }, images, productRefs: [photo, sidePhoto], front, closeup };
}

describe("Seedance2.5当前真实CLI请求调用点（隔离假评审与假供应商，不代表生产通过）", () => {
  it("提交前体检允许明确单轴后拉收至静止，仍拦截同时定格与推近", () => {
    const fn = currentCliParts().fn("preflightSubmitGuard");
    const context = {
      createHash, BULLET_TIME_CAPABILITIES: { ...CONSERVATIVE_BULLET_TIME_CAPABILITIES, maxReferenceImages: 30 },
      inspectBulletTimeMotion: () => ({ motionException: false }),
      recordGate: (input: Card) => ({ approved: (input.checks as Array<{ pass: boolean; hard?: boolean }>)
        .every((check) => check.hard === false || check.pass) }), log: () => {},
    };
    const endingPrompt = "【运镜】极缓慢单轴后拉，不摇、不移；T00:03–T00:04 后拉收至静止，落幅定格。";
    expect(() => evaluateCurrent(`${fn}; preflightSubmitGuard({shotId:"ending",stage:"videos",prompt:${JSON.stringify(endingPrompt)},fps:30,attempt:1,prevFingerprint:null,shot:{}})`, context)).not.toThrow();
    const storyPacingPrompt = "后追随稳住被压局势，出弯时把车身拉直并保持线路。";
    expect(() => evaluateCurrent(`${fn}; preflightSubmitGuard({shotId:"scene-1",stage:"videos",prompt:${JSON.stringify(storyPacingPrompt)},fps:30,attempt:1,prevFingerprint:null,shot:{}})`, context)).not.toThrow();
    const conflictPrompt = "固定机位让终点定格，同时继续推近。";
    expect(() => evaluateCurrent(`${fn}; preflightSubmitGuard({shotId:"bad",stage:"videos",prompt:${JSON.stringify(conflictPrompt)},fps:30,attempt:1,prevFingerprint:null,shot:{}})`, context)).toThrow("落幅必漂");
  });
  it("嵌套 authored 镜头字段进入常识审核时仍保留人物、w2、服装和真实商品绑定", () => {
    const shot = {
      shotId: "S1", duration: 5, scene: "以场景圣经升级后的赛道说明为准",
      fields: {
        scene: "原始赛道说明",
        action: "李英子压低身体外线出弯",
        character: "李英子（young-rider-01），20岁成年虚构女性",
        costume: "w2哑光全覆保护赛车服",
      },
    };
    const archive = {
      id: "zxmoto-820rr-rc", displayName: "张雪 820RR-RC 赛道版", brand: "张雪机车", category: "赛道摩托车",
      source: { kind: "customer-upload", reviewStatus: "approved" }, specs: { parameters: [] }, photos: [],
    };
    const context = {
      policyBrief: { productId: "zxmoto-820rr-rc" }, productLibrary: { archives: [archive] },
      selectProductArchive: () => ({ archive }), PROJECT: "ISOLATED-CURRENT", RUN_ID: "fixture-run",
      shotlist: { platform: "douyin", durationSeconds: 5 }, totalSeconds: 5,
      FILM_SPEECH_LANGUAGE: "zh-CN", ASPECT: "9:16", OUTPUT_RESOLUTION: "1080p",
      lead: null, PROMPT_DIR: join(tmpdir(), "no-current-prompts"), existsSync: () => false, join,
      isMaterialShot: () => false, arg: (_name: string, fallback = "") => fallback,
    };
    const functions = ["shotAuthoredText", "plausibilityArchiveFor", "plausibilityContextFor"].map(currentCliParts().fn).join("\n");
    const projected = evaluateCurrent(`${functions}; plausibilityContextFor("pre-render", [${JSON.stringify(shot)}])`, context) as {
      shots: Array<Card>;
    };
    expect(projected.shots[0]).toMatchObject({
      scene: "以场景圣经升级后的赛道说明为准",
      action: "李英子压低身体外线出弯",
      character: "李英子（young-rider-01），20岁成年虚构女性",
      wardrobeId: "w2",
      costume: "w2哑光全覆保护赛车服",
      product: "zxmoto-820rr-rc",
    });
  });
  it("常识审核优先读取最终编号字段，不让已修复提示词被 stale 坐姿或穿横条字段推翻", () => {
    const dir = mkdtempSync(join(tmpdir(), "current-prompt-fields-")); temporary.push(dir);
    const promptFile = join(dir, "S1.txt");
    writeFileSync(promptFile, [
      "05.【场景】冲线横条下缘高于全盔至少0.5米。",
      "08.【角色】李英子已下车站在车侧，双脚落地承重。",
      "09.【动作】骑手与赛车从横条下方通过；视线抬起并对向镜头。",
      "10.【台词】无台词。",
      "20.【服装】w2哑光全覆保护赛车服。",
      "21.【道具】同一根黑色发圈保持扎紧。",
    ].join("\n"));
    const shot = {
      shotId: "S1", duration: 5,
      scene: "stale scene", action: "车头穿过横条",
      fields: {
        character: "李英子坐在已完全停稳的车上",
        costume: "w1旧服装",
      },
    };
    const context = {
      policyBrief: null, productLibrary: { archives: [] }, selectProductArchive: () => ({ archive: null }),
      PROJECT: "ISOLATED-CURRENT", RUN_ID: "fixture-run", PROMPT_DIR: dir,
      shotlist: { platform: "douyin", durationSeconds: 5 }, totalSeconds: 5,
      FILM_SPEECH_LANGUAGE: "zh-CN", ASPECT: "9:16", OUTPUT_RESOLUTION: "1080p",
      lead: null, existsSync, readFileSync, join, isMaterialShot: () => false,
      arg: (_name: string, fallback = "") => fallback,
    };
    const functions = ["shotAuthoredText", "plausibilityArchiveFor", "plausibilityContextFor"].map(currentCliParts().fn).join("\n");
    const projected = evaluateCurrent(`${functions}; plausibilityContextFor("pre-render", [${JSON.stringify(shot)}])`, context) as {
      shots: Array<Card>;
    };
    expect(projected.shots[0]).toMatchObject({
      scene: "冲线横条下缘高于全盔至少0.5米。",
      character: "李英子已下车站在车侧，双脚落地承重。",
      action: "骑手与赛车从横条下方通过；视线抬起并对向镜头。",
      wardrobeId: "w2",
      costume: "w2哑光全覆保护赛车服。",
      props: "同一根黑色发圈保持扎紧。",
      dialogueFree: true,
    });
  });
  it("opening最终提示词移除盔壳后下方开口并补写盔壳完整负面约束", () => {
    const source = [
      "08.【角色】李英子戴全盔，黑色高马尾压束在头盔内。",
      "11.【负面约束】禁止主角分身。",
      "21.【道具】哑光全盔面罩闭合，后下方开口只露马尾发尾与同一黑色发圈。",
      "24.【化妆】后下方开口处可见黑色发圈扎紧的马尾。",
    ].join("\n");
    const shot = {
      shotId: "opening", sceneId: "opening", duration: 4,
      fields: {
        character: "李英子戴哑光全盔面罩闭合不露脸",
        action: "保持车身稳定",
        scene: "封闭赛道",
      },
    };
    const functions = ["shotAuthoredText", "correctFilmPlausibilityConflicts"].map(currentCliParts().fn).join("\n");
    const corrected = evaluateCurrent(`${functions}; correctFilmPlausibilityConflicts(${JSON.stringify(source)}, ${JSON.stringify(shot)})`, { String }) as {
      prompt: string;
      corrections: string[];
    };
    expect(corrected.prompt).not.toContain("后下方开口");
    expect(corrected.prompt.match(/全盔后缘与骑行服领口之间/g)).toHaveLength(2);
    expect(corrected.prompt).toContain("禁止盔壳开孔");
    expect(corrected.prompt).toContain("黑色低束马尾");
    expect(corrected.prompt).not.toContain("高马尾");
    expect(corrected.corrections).toEqual(expect.arrayContaining(["helmet-seam-without-shell-hole", "helmet-shell-negative"]));
  });
  it("素材镜按镜头声明的支撑方式归一停车状态，不把起车架擅改为侧撑", () => {
    const prompt = "08.【动作】车身停稳后，她左手抬起摘盔。\n19.【角色约束】只出现李英子一人。";
    const shot = { shotId: "scene-4", sceneId: "scene-4", duration: 4, supportMode: "maintenance-stand",
      fields: { scene: "安全区，车辆已停稳", character: "李英子站在车侧摘盔", action: "车身停稳后，她左手抬起摘盔" } };
    const functions = ["shotAuthoredText", "correctFilmPlausibilityConflicts"].map(currentCliParts().fn).join("\n");
    const corrected = evaluateCurrent(`${functions}; correctFilmPlausibilityConflicts(${JSON.stringify(prompt)}, ${JSON.stringify(shot)})`, { String }) as {
      prompt: string;
      corrections: string[];
    };
    expect(corrected.prompt).toContain("后轮起车架稳固承托");
    expect(corrected.prompt).not.toContain("车辆由侧撑尖");
    expect(corrected.corrections).toContain("stopped-vehicle-maintenance-stand");
  });
  it("商品人物镜实际material分支提交人物双角度+商品多角度reference，补丁最终prompt与G-MAT1摘要一致", async () => {
    const f = currentSubmissionFixture("material"); await f.execute();
    expect(f.posts).toBe(1); expect(f.gets).toBe(1); const body = f.paidBodies[0]!;
    expect(body.duration).toBe(13); expect(body).not.toHaveProperty("seed"); expect(body.omni_reference_task_type).toBe("reference");
    const content = body.content as Array<Card>; expect(content[0]!.text).toContain("真正提交应包含这条最终常识补丁");
    expect(content.slice(1).map((part) => part.role)).toEqual(["reference_image", "reference_image", "reference_image", "reference_image"]);
    expect((content[1]!.image_url as Card).url).toBe(f.images[0]!.url); expect((content[2]!.image_url as Card).url).toBe(f.images[1]!.url);
    const gate = f.gates.find((entry) => entry.stepKey === "material-generate")!; const evidence = gate.evidence as Card;
    expect(evidence.videoInputMode).toBe("reference-image"); expect(evidence.wireRequestSha256).toBe(fixtureSha(JSON.stringify(body)));
    expect(evidence.promptSha256).toBe(fixtureSha(String(content[0]!.text)));
    expect((gate.checks as Array<Card>).find((check) => check.id === "product-reference-inputs")).toMatchObject({ pass: true });
    expect(evidence.productReferenceFiles).toEqual(f.productRefs);
    expect((f.reviews[0]!.images as Array<Card>)[0]!.path).toBe(join(f.dir, "plates/S1-material.jpg"));
    expect(f.accepted.length).toBe(2); expect(JSON.stringify(f.accepted)).toContain("ack.json");
  });
  it("material分支优先复用完整25字段标准提示词，不退回稀疏字段重拼", async () => {
    const canonical = `${Array.from({ length: 25 }, (_, index) => `${String(index + 1).padStart(2, "0")}.【字段${index + 1}】完整镜头卡内容`).join("\n")}\n${"保持人物、动作、构图、时间轴与一致性。".repeat(30)}\n【素材契约】9:16；实景依据；构建一段视频；不得复刻参考图的构图；禁止贴图式运动与画面全程静止。`;
    const f = currentSubmissionFixture("material", "pass", "succeeded", canonical);
    await f.execute();
    if (f.posts !== 1) throw new Error(JSON.stringify({ gates: f.gates, rows: f.rows }, null, 2));
    const body = f.paidBodies[0]!;
    const prompt = String((body.content as Array<Card>)[0]!.text);
    expect(prompt).toContain("01.【字段1】完整镜头卡内容");
    expect(prompt).toContain("25.【字段25】完整镜头卡内容");
    expect(prompt).toContain("【素材参考任务】");
    expect(prompt).toContain("【参考资产集合】");
  });
  it.each(["block", "unverified"] as const)("material常识%s在付费前停止，0视频POST", async (verdict) => {
    const f = currentSubmissionFixture("material", verdict); await expect(f.execute()).rejects.toThrow("PLAUSIBILITY_BLOCKED"); expect(f.posts).toBe(0);
  });
  it("普通人物镜实际G8+arkVideo只传front/closeup，不夹13为12、不带首帧或seed", async () => {
    const f = currentSubmissionFixture("normal"); await f.execute(); const body = f.paidBodies[0]!;
    expect(f.posts).toBe(1); expect(body.duration).toBe(13); expect(body).not.toHaveProperty("seed");
    expect((body.content as Array<Card>).slice(1).map((part) => part.role)).toEqual(["reference_image", "reference_image"]);
    const gate = f.gates.find((entry) => entry.stepKey === "g8-render-submit")!; const evidence = gate.evidence as Card;
    expect(evidence.plateUsage).toBe("preproduction-only"); expect(evidence.wireRequestSha256).toBe(fixtureSha(JSON.stringify(body)));
    expect(f.accepted).toHaveLength(1);
  });
  it("普通镜MAX_ATTEMPTS=3遇供应商终态失败也只POST一次，保留真实task", async () => {
    const f = currentSubmissionFixture("normal", "pass", "failed"); await expect(f.execute()).rejects.toThrow("VIDEO_SHOT_NOT_COMPLETED");
    expect(f.posts).toBe(1); expect(JSON.stringify(f.rows)).toContain("task-current-fixture"); expect(f.accepted).toHaveLength(0);
  });
  it("真人授权素材仍只传原asset引用，不被合成人物或首帧替换", async () => {
    const f = currentSubmissionFixture("asset"); await f.execute();
    const content = f.paidBodies[0]!.content as Array<Card>;
    expect(content.slice(1)).toEqual([{ type: "image_url", image_url: { url: "asset://authorized-fixture-id" }, role: "reference_image" }]);
  });
  it("原卡出镜判断不从旁白speaker或全片lead补人，识别显式appearance并拒绝冲突", () => {
    const fn = currentCliParts().fn("leadVisibleInShot");
    const source = { character: { id: "fictional-adult", appearanceInShots: ["visible", "nested-off", "nested-other"] }, shots: [
      { shotId: "voice", character: "无人", dialogue: [{ speaker: "李英子", text: "画外台词" }] },
      { shotId: "visible", character: "李英子" }, { shotId: "conflict", character: "李英子", cast: ["another-person"] },
      { shotId: "plural", characters: ["fictional-adult"] }, { shotId: "off", cast: [{ id: "fictional-adult", onScreen: false }] },
      { shotId: "negative", character: "不要李英子出镜" }, { shotId: "narrator", character: "李英子：画外旁白不出镜" },
      { shotId: "nested-off", fields: { cast: [{ id: "fictional-adult", onScreen: false }] } },
      { shotId: "nested-other", fields: { characterId: "another-person" } },
    ] };
    const identity = { id: "fictional-adult", name: "李英子", version: 2 };
    const context = { sourceDocument: source,
      sourceCharacter: { ...identity, appearanceInShots: ["visible", "nested-off", "nested-other"] }, usePortraitRefs: true, lead: identity,
      characters: new Map([[identity.id, identity]]), characterRegistry: { aliases: [] }, strictSourceCast: false, isAssetShot: () => false,
      normalizeShotIntent, resolveShotCast };
    expect(evaluateCurrent(`${fn}; leadVisibleInShot({shotId:"voice"})`, context)).toBe(false);
    expect(evaluateCurrent(`${fn}; leadVisibleInShot({shotId:"visible"})`, context)).toBe(true);
    expect(evaluateCurrent(`${fn}; leadVisibleInShot({shotId:"plural"})`, context)).toBe(true);
    for (const shotId of ["off", "negative", "narrator"]) expect(evaluateCurrent(`${fn}; leadVisibleInShot({shotId:${JSON.stringify(shotId)}})`, context)).toBe(false);
    expect(() => evaluateCurrent(`${fn}; leadVisibleInShot({shotId:"nested-off"})`, context)).toThrow("VISIBILITY_CONFLICT");
    expect(() => evaluateCurrent(`${fn}; leadVisibleInShot({shotId:"nested-other"})`, context)).toThrow("CAST_UNVERIFIED");
    expect(() => evaluateCurrent(`${fn}; leadVisibleInShot({shotId:"conflict"})`, context)).toThrow(/CAST_UNSUPPORTED|CAST_UNVERIFIED/);
  });
});


function portraitOriginalFixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "current-portrait-originals-"))); temporary.push(dir);
  for (const relative of ["portraits/v2", "portrait-sets", "provenance/v2", "reviews"]) mkdirSync(join(dir, relative), { recursive: true });
  const angles = ["front", "threeQuarter", "closeup", "side", "back", "actionPose", "emotionCloseup", "handDetail"];
  const artifacts = angles.map((angle, index) => {
    const file = `portraits/v2/fictional-adult-${angle}.png`; writeFileSync(join(dir, file), Buffer.alloc(60_001 + index, index + 1));
    return { angle, file, sha256: mediaSha256(join(dir, file)) };
  });
  const set = { version: 2, dir: "portraits/v2", angles, source: "pure-t2i", active: true, status: "ready" };
  const profile = { schemaVersion: "workloom.character-profile/v1", id: "fictional-adult", name: "李英子", kind: "generated", portraitSets: [set] };
  writeFileSync(join(dir, "profile.json"), JSON.stringify(profile)); writeFileSync(join(dir, "portrait-sets/v2.json"), JSON.stringify(set));
  writeFileSync(join(dir, "provenance/v2.json"), "{}"); writeFileSync(join(dir, "reviews/fixture-authorized.json"), "{}");
  for (const angle of ["front", "closeup"]) {
    const artifact = artifacts.find((item) => item.angle === angle)!;
    const body = { model: "isolated-original-t2i", prompt: `同一原创成年角色 ${angle}`, watermark: true };
    const hash = fixtureSha(JSON.stringify(body));
    writeFileSync(join(dir, `provenance/v2/${angle}.provenance.json`), JSON.stringify({ characterId: profile.id, angle, source: "original-pure-text-to-image",
      request: { body, bodySha256: hash, imageFieldPresent: false }, output: { sha256: artifact.sha256, bytes: readFileSync(join(dir, artifact.file)).length, modified: false } }));
    writeFileSync(join(dir, `provenance/v2/${angle}.dispatch.json`), JSON.stringify({ request: body, requestSha256: hash, imageInputPresent: false }));
  }
  const current = loadCharacterEntry(dir)!;
  const lead = { id: profile.id, name: profile.name, version: 2, dir, files: current.files };
  const context = { Buffer, Set, Map, Number, String, Object, Array, JSON, createHash, existsSync, readFileSync, fingerprintArtifact,
    sourceDocument: { character: { id: profile.id }, shots: [{ shotId: "S1", character: profile.name }] },
    sourceCharacter: { id: profile.id, name: profile.name },
    lead, characters: new Map([[lead.id, lead]]), characterRegistry: { aliases: [] }, strictSourceCast: false, usePortraitRefs: true,
    BULLET_TIME_CAPABILITIES: { ...CONSERVATIVE_BULLET_TIME_CAPABILITIES, maxReferenceImages: 30 },
    bulletTimeReferencePlan, bulletTimeReferenceClause,
    isAssetShot: () => false, isAssetRefLocal: (file: string) => file.startsWith("asset://"), WORKER_RUNTIME: null,
    portraitReferenceAuthorization: { characterId: lead.id, version: 2, artifacts },
    portraitReferenceAuthorizationPaths: [join(dir, "profile.json"), join(dir, "reviews/fixture-authorized.json"), ...artifacts.map((item) => join(dir, item.file))],
    loadCharacterEntry, readPortraitArtifact, resolveShotCast, normalizeShotIntent, arg: () => "2", resolve, join, basename: (path: string) => path.split("/").at(-1),
  };
  const parts = currentCliParts();
  const execute = () => evaluateCurrent(`${parts.fn("videoImage")}\n${parts.fn("leadVisibleInShot")}\n${parts.fn("portraitVideoInputs")}\nportraitVideoInputs({shotId:"S1"})`, context) as { images: Array<{ url: string; artifact: { path: string; sha256: string; bytes: number } }>; paths: string[] };
  return { dir, execute, context, artifacts, profile };
}

describe("当前CLI原图版本与纯文生图证据绑定（合成fixture，不代表实际角色审批）", () => {
  it("front/closeup以当前原始Buffer编码，路径/version/SHA/字节与冻结授权和dispatch一致", () => {
    const f = portraitOriginalFixture(); const result = f.execute(); expect(result.images).toHaveLength(2);
    for (const [index, angle] of ["front", "closeup"].entries()) {
      const image = result.images[index]!; const expected = f.artifacts.find((item) => item.angle === angle)!;
      const bytes = Buffer.from(image.url.split(",")[1]!, "base64");
      expect(fixtureSha(bytes)).toBe(expected.sha256); expect(bytes.equals(readFileSync(image.artifact.path))).toBe(true);
      expect(result.paths).toContain(join(f.dir, `provenance/v2/${angle}.dispatch.json`));
    }
  });
  it.each(["image-field", "body-hash", "output-hash", "dispatch-input"])("纯文生图来源%s不符在构造请求前拒绝", (fault) => {
    const f = portraitOriginalFixture(), file = join(f.dir, "provenance/v2/front.provenance.json");
    const provenance = JSON.parse(readFileSync(file, "utf8"));
    if (fault === "image-field") provenance.request.body.image = "data:image/png;base64,ZmFrZQ==";
    if (fault === "body-hash") provenance.request.bodySha256 = fixtureSha("wrong body");
    if (fault === "output-hash") provenance.output.sha256 = fixtureSha("another image");
    if (fault === "dispatch-input") { const dispatchFile = join(f.dir, "provenance/v2/front.dispatch.json"), dispatch = JSON.parse(readFileSync(dispatchFile, "utf8")); dispatch.imageInputPresent = true; writeFileSync(dispatchFile, JSON.stringify(dispatch)); }
    writeFileSync(file, JSON.stringify(provenance)); expect(f.execute).toThrow("ORIGINAL_UNVERIFIED");
  });
  it("同大小换图与当前版本漂移不能以旧授权送出", () => {
    const f = portraitOriginalFixture(); const front = join(f.dir, f.artifacts[0]!.file); writeFileSync(front, Buffer.alloc(readFileSync(front).length, 99)); expect(f.execute).toThrow("BYTES_CHANGED");
    const other = portraitOriginalFixture(); other.profile.portraitSets[0]!.version = 1; writeFileSync(join(other.dir, "profile.json"), JSON.stringify(other.profile)); expect(other.execute).toThrow("VERSION_INVALID");
  });
});
