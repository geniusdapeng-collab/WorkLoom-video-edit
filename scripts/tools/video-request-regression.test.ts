import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeShotIntent, shotIntentHash } from "../../packages/video-studio/src/shot-intent.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Card = Record<string, unknown>;
function runChain(shots: Card[], options: { stages?: string; args?: string[]; dir?: string } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "video-request-regression-"));
  if (!options.dir) temporary.push(dir);
  const shotsFile = join(dir, "shots.json");
  writeFileSync(shotsFile, JSON.stringify({ title: "摄影增强回归", shots }));
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/tools/full-chain-film.mts",
    "--shots", shotsFile, "--project", "regression", "--work-dir", dir, "--out", join(dir, "out"),
    "--keys-file", join(dir, "no-credentials.env"), "--library", join(dir, "no-characters"),
    "--platform", "youtube", "--stages", options.stages ?? "cine-kb,micromotion", "--dry-run", ...(options.args ?? [])
  ], { cwd: root, encoding: "utf8", timeout: 30_000, env: { ...process.env, ARK_API_KEY: "", LLM_API_KEY: "" } });
  return {
    dir, result, diagnostic: `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
    read: (file: string) => JSON.parse(readFileSync(join(dir, file), "utf8")),
    rows: () => readFileSync(join(dir, "logs/stages.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)),
  };
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
