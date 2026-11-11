import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = resolve(fileURLToPath(import.meta.url), "..");
const repoRoot = resolve(here, "../../..");

function runInChild(script: string): Record<string, unknown> {
  const directory = mkdtempSync(join(tmpdir(), "wl-fieldquality-"));
  const file = join(directory, "probe.mts");
  writeFileSync(file, script, "utf8");
  const tsx = readdirSync(join(repoRoot, "node_modules/.pnpm"))
    .filter(name => name.startsWith("tsx@"))
    .map(name => join(repoRoot, "node_modules/.pnpm", name, "node_modules/tsx/dist/cli.mjs"))
    .filter(existsSync).sort().pop();
  if (!tsx) throw new Error("tsx unavailable");
  const output = execFileSync(process.execPath, [tsx, file], {
    cwd: repoRoot, encoding: "utf8", timeout: 30_000,
  });
  const line = output.trim().split("\n").filter(value => value.startsWith("RESULT ")).pop();
  if (!line) throw new Error("child result missing");
  return JSON.parse(line.slice("RESULT ".length)) as Record<string, unknown>;
}

describe("FieldQuality thrown-shot compatibility", () => {
  it("turns a thrown per-shot check into a visible failed report instead of crashing runAll", () => {
    const result = runInChild(`
import { createRequire } from "node:module";
import { installVendorFieldQualityBridge } from ${JSON.stringify(resolve(here, "vendor-compat.ts"))};
const require = createRequire(${JSON.stringify(join(repoRoot, "package.json"))});
const { FieldQualityPipeline } = require(${JSON.stringify(join(repoRoot,
      "vendor/supermickey/hyperreality-system/engines/field-quality/field-quality-pipeline.js"))});
const original = FieldQualityPipeline.prototype.run;
FieldQualityPipeline.prototype.run = async () => { throw new Error("synthetic intervals failure"); };
const lines = [];
const uninstall = installVendorFieldQualityBridge({ log: value => lines.push(value) });
let error = null, summary = null;
try {
  const pipeline = new FieldQualityPipeline({ maxRounds: 1 });
  const output = await pipeline.runAll([{ shotId: "S1", sceneType: "opening", duration: 5 }]);
  summary = output.summary;
} catch (failure) {
  error = failure.message;
} finally {
  uninstall();
  FieldQualityPipeline.prototype.run = original;
}
console.log("RESULT " + JSON.stringify({ error, summary, hasStack: lines.some(line => line.includes("synthetic intervals failure") && line.includes("栈")) }));
`);
    expect(result.error).toBeNull();
    expect(result.summary).toMatchObject({ totalShots: 1, passed: 0, failed: 1 });
    expect(result.hasStack).toBe(true);
  }, 60_000);
});
