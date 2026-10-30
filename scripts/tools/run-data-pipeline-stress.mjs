#!/usr/bin/env node
/**
 * Run the 40-case pre-render pressure matrix.
 *
 * Positive cases execute the real data pipeline through the last prompt gate
 * with `deferRender=true`. Negative cases stop at routing/preflight and use a
 * dead model endpoint so malformed input cannot incur production model cost.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
const casesFile = join(root, "stress/data-pipeline/cases.json");
const outputRoot = join(root, "outputs/mine-clear/T-2026-1030-9010");
const runsRoot = join(root, "work/stress/T-2026-1030-9010/cases");
const resultFile = join(outputRoot, "stress-results.json");
const cases = JSON.parse(readFileSync(casesFile, "utf8"));

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const only = new Set(value("--ids").split(",").map((id) => id.trim()).filter(Boolean));
const includePositive = !flag("--negative-only") && !flag("--negative-dry-only");
const includeNegative = !flag("--positive-only");
const resume = !flag("--no-resume");

mkdirSync(outputRoot, { recursive: true });
mkdirSync(runsRoot, { recursive: true });
const report = existsSync(resultFile)
  ? JSON.parse(readFileSync(resultFile, "utf8"))
  : {
      schemaVersion: "workloom.video-pipeline-stress-result/v1",
      taskId: cases.taskId,
      renderSubmissionAllowed: false,
      startedAt: new Date().toISOString(),
      results: [],
    };
const resultById = new Map(report.results.map((item) => [item.id, item]));

function persist() {
  report.updatedAt = new Date().toISOString();
  writeFileSync(resultFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function childEnv(extra = {}) {
  return {
    ...process.env,
    ...extra,
    PII_SALT: process.env.PII_SALT || "stress-local-preview-20261030",
    HR_PORTRAIT_ENABLED: "0",
  };
}

function run(command, commandArgs, options) {
  const startedAt = new Date();
  const result = spawnSync(command, commandArgs, options);
  return {
    result,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt.getTime(),
  };
}

function hasArg(commandArgs, name) {
  return commandArgs.includes(name);
}

function expandValue(value) {
  const repeated = /^@repeat:(.*):(\d+)$/s.exec(value);
  if (repeated) return repeated[1].repeat(Number(repeated[2]));
  return value.replace(/@char:(\d+)/g, (_match, code) => String.fromCharCode(Number(code)));
}

function negative(item) {
  if (only.size && !only.has(item.id)) return null;
  if (!includeNegative) return null;
  const dir = join(runsRoot, item.id);
  mkdirSync(dir, { recursive: true });
  const logFile = join(dir, "dry-run.log");
  const commandArgs = [
    "--import", "tsx", "scripts/tools/data-pipeline-run.mts",
    ...(item.dryRun === false ? [] : ["--dry-run"]),
    ...item.args.map(expandValue),
    "--work-dir", join(dir, "work"),
    "--out", join(dir, "out"),
    ...(hasArg(item.args, "--project") ? [] : ["--project", `VID-STRESS-${item.id}`]),
    ...(hasArg(item.args, "--no-portraits") ? [] : ["--no-portraits"]),
  ];
  const execution = run(process.execPath, commandArgs, {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 30 * 1024 * 1024,
    env: childEnv({
      LLM_API_KEY: "pressure-test-dead-endpoint",
      LLM_BASE_URL: "http://127.0.0.1:9",
      LLM_MODEL: "deepseek-flash",
    }),
  });
  writeFileSync(logFile, `${execution.result.stdout ?? ""}${execution.result.stderr ?? ""}`, "utf8");
  const output = `${execution.result.stdout ?? ""}${execution.result.stderr ?? ""}`;
  const expectedExit = Array.isArray(item.expect.exit) ? item.expect.exit : [item.expect.exit];
  const messageOk = new RegExp(item.expect.message, "i").test(output);
  const pass = expectedExit.includes(execution.result.status) && messageOk;
  return {
    id: item.id,
    kind: "negative",
    name: item.name,
    pass,
    exitCode: execution.result.status,
    expectedExit,
    messageOk,
    elapsedMs: execution.elapsedMs,
    logFile: logFile.slice(root.length + 1),
    command: [process.execPath, ...commandArgs],
  };
}

function prepareFixture(item, dir) {
  if (item.pipeline !== "marketing") return undefined;
  const fixture = join(dir, "search-fixture.json");
  const execution = run(process.execPath, [
    "scripts/tools/prepare-search-fixture.cjs",
    "--product", item.product,
    "--brand", item.brand,
    "--category", item.category,
    "--url", `https://github.com/${item.repo}`,
    "--title", `${item.product} — official public repository`,
    "--snippet", `Official public source for ${item.product}: https://github.com/${item.repo}`,
    "--out", fixture,
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: childEnv(),
  });
  if (execution.result.status !== 0) {
    throw new Error(`fixture failed for ${item.id}: ${execution.result.stderr || execution.result.stdout}`);
  }
  return fixture;
}

function positive(item) {
  if (only.size && !only.has(item.id)) return null;
  if (!includePositive) return null;
  const dir = join(runsRoot, item.id);
  const out = join(dir, "out");
  const summaryFile = join(out, "data-pipeline-summary.json");
  if (resume && existsSync(summaryFile)) {
    try {
      const existing = JSON.parse(readFileSync(summaryFile, "utf8"));
      if (existing.success === true && existing.renderSubmitted === false) {
        return {
          id: item.id,
          kind: "positive",
          pipeline: item.pipeline,
          domain: item.domain,
          pass: true,
          resumed: true,
          summaryFile: summaryFile.slice(root.length + 1),
          shots: existing.shots,
          prompts: existing.prompts,
        };
      }
    } catch {
      // A corrupt result is rerun below and preserved in the command log.
    }
  }
  mkdirSync(dir, { recursive: true });
  let fixture;
  try {
    fixture = prepareFixture(item, dir);
  } catch (error) {
    return { id: item.id, kind: "positive", pipeline: item.pipeline, domain: item.domain, pass: false, error: String(error) };
  }
  const logFile = join(dir, "pipeline.log");
  const commandArgs = [
    "--import", "tsx", "scripts/tools/data-pipeline-run.mts",
    "--intent", item.intent,
    "--route", item.pipeline,
    "--duration", String(item.duration),
    "--aspect", item.aspect,
    "--platform", item.platform,
    "--project", `VID-STRESS-${item.id}`,
    "--work-dir", join(dir, "work"),
    "--out", out,
    "--no-portraits",
    "--producer", "review",
    ...(item.pipeline === "marketing" ? [
      "--product", item.product,
      "--brand", item.brand,
      "--category", item.category,
      "--selling-points", `以本次官方仓库 ${item.repo} 可核实事实为准`,
      "--goal", item.goal,
      "--prime-search", fixture,
    ] : []),
    "--json",
  ];
  const execution = run(process.execPath, commandArgs, {
    cwd: root,
    encoding: "utf8",
    timeout: 45 * 60_000,
    maxBuffer: 80 * 1024 * 1024,
    env: childEnv(),
  });
  writeFileSync(logFile, `${execution.result.stdout ?? ""}${execution.result.stderr ?? ""}`, "utf8");
  let summary = null;
  if (existsSync(summaryFile)) {
    try { summary = JSON.parse(readFileSync(summaryFile, "utf8")); } catch { /* failure below */ }
  }
  const pass = execution.result.status === 0
    && summary?.success === true
    && summary?.renderSubmitted === false
    && Number(summary?.shots) > 0
    && Number(summary?.prompts) > 0
    && (item.pipeline !== "marketing" || Boolean(summary?.marketingFacts?.finalFactsSha256));
  return {
    id: item.id,
    kind: "positive",
    pipeline: item.pipeline,
    domain: item.domain,
    pass,
    exitCode: execution.result.status,
    elapsedMs: execution.elapsedMs,
    shots: summary?.shots ?? 0,
    prompts: summary?.prompts ?? 0,
    renderSubmitted: summary?.renderSubmitted ?? null,
    marketingFacts: summary?.marketingFacts ?? null,
    gates: summary?.gates ?? [],
    errors: summary?.errors ?? [],
    summaryFile: summaryFile.slice(root.length + 1),
    logFile: logFile.slice(root.length + 1),
    command: [process.execPath, ...commandArgs],
  };
}

for (const item of cases.negative) {
  const result = negative(item);
  if (!result) continue;
  resultById.set(item.id, result);
  report.results = [...resultById.values()];
  persist();
  console.log(`${result.pass ? "PASS" : "FAIL"} ${result.id} ${result.name} exit=${result.exitCode}`);
}
for (const item of cases.positive) {
  const result = positive(item);
  if (!result) continue;
  resultById.set(item.id, result);
  report.results = [...resultById.values()];
  persist();
  console.log(`${result.pass ? "PASS" : "FAIL"} ${result.id} ${result.pipeline}/${result.domain}${result.elapsedMs ? ` ${Math.round(result.elapsedMs / 1000)}s` : ""}`);
}
report.completedAt = new Date().toISOString();
report.summary = {
  total: report.results.length,
  passed: report.results.filter((item) => item.pass).length,
  failed: report.results.filter((item) => !item.pass).length,
  renderSubmissions: report.results.filter((item) => item.renderSubmitted === true).length,
};
persist();
process.exit(report.summary.failed === 0 ? 0 : 1);
