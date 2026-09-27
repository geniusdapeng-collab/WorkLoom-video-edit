import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

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
    const dir = mkdtempSync(join(tmpdir(), "video-request-regression-")); temporary.push(dir);
    const shotsFile = join(dir, "shots.json");
    writeFileSync(shotsFile, JSON.stringify({
      title: "摄影增强回归", durationSeconds: 10,
      shots: [{ shotId: "NC-01", duration: 10, scene: "人物站在木质窗边的白天室内", action: "看着远处", character: "演员甲", lighting: "右侧窗光" }]
    }));
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/tools/full-chain-film.mts",
      "--shots", shotsFile, "--project", "regression", "--work-dir", dir, "--out", join(dir, "out"),
      "--keys-file", join(dir, "no-credentials.env"), "--library", join(dir, "no-characters"),
      "--platform", "youtube", "--stages", "cine-kb,micromotion", "--dry-run"
    ], { cwd: root, encoding: "utf8", timeout: 30_000, env: { ...process.env, ARK_API_KEY: "", LLM_API_KEY: "" } });
    expect(result.status, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`).toBe(0);
    const kb = JSON.parse(readFileSync(join(dir, "shotlist-enriched-regression.json"), "utf8")).shots[0];
    const consumed = JSON.parse(readFileSync(join(dir, "shotlist-current-regression.json"), "utf8")).shots[0];
    expect(kb.depth_of_field).toBeTruthy();
    expect(consumed.depth_of_field).toBe(kb.depth_of_field);
    expect(consumed.lighting).toEqual(kb.lighting);
    expect(consumed.action).toContain("【微动作】");
  }, 40_000);
});
