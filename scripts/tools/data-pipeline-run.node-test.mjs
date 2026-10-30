import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repo = resolve(import.meta.dirname, "../..");

function dryRun(route, intent, extraArgs = []) {
  return runPipeline([
    "--intent", intent,
    "--route", route,
    "--project", "VID-DATA-PIPELINE-TEST",
    "--no-portraits",
    "--dry-run",
    "--json",
    ...extraArgs,
  ]);
}

function runPipeline(extraArgs) {
  const root = mkdtempSync(join(tmpdir(), "workloom-data-pipeline-"));
  const out = join(root, "out");
  const result = spawnSync(process.execPath, [
    "--import", "tsx",
    "scripts/tools/data-pipeline-run.mts",
    "--work-dir", join(root, "work"),
    "--out", out,
    ...extraArgs,
  ], {
    cwd: repo,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      LLM_API_KEY: "test-only",
      LLM_BASE_URL: "http://127.0.0.1:9",
      LLM_MODEL: "deepseek-flash",
      HR_PORTRAIT_ENABLED: "0",
    },
  });
  return { root, out, result };
}

test("narrative dry-run emits the exact host character contract before Studio", () => {
  const run = dryRun("narrative", "拍一条 20 秒的城市人文短片，讲桥、船与河岸生活");
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    const preflight = JSON.parse(readFileSync(join(run.out, "preflight.json"), "utf8"));
    assert.equal(preflight.pipelineRoute, "narrative");
    assert.equal(preflight.themeInputMode, "narrative");
    assert.equal(preflight.metadata.builtinCharacterSelection.schemaVersion, "workloom.video-character-selection/v1");
    assert.equal(preflight.metadata.builtinCharacterSelection.mode, "builtin");
    assert.ok(Array.isArray(preflight.metadata.characters));
    assert.equal(preflight.metadata.characters.length, 1);
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("invalid explicit route fails closed instead of silently becoming auto", () => {
  const run = dryRun("not-a-pipeline", "拍一条短片");
  try {
    assert.notEqual(run.result.status, 0);
    assert.match(run.result.stderr + run.result.stdout, /--route 只支持/);
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("invalid production profile values fail before routing or rendering", () => {
  const cases = [
    { args: ["--duration", "not-a-number"], message: /--duration/ },
    { args: ["--duration", "4"], message: /--duration/ },
    { args: ["--duration", "181"], message: /--duration/ },
    { args: ["--aspect", "banana"], message: /--aspect/ },
  ];
  for (const item of cases) {
    const run = dryRun("narrative", "拍一条 30 秒无人物空镜短片", item.args);
    try {
      assert.notEqual(run.result.status, 0, `${item.args.join(" ")} unexpectedly succeeded`);
      assert.match(run.result.stderr + run.result.stdout, item.message);
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  }
});

test("empty, overlong and control-character intents fail before vendor startup", () => {
  const cases = [
    { intent: "   ", message: /intent|意图/ },
    { intent: "河".repeat(2001), message: /2000|过长/ },
    { intent: "河面\u0001反光", message: /控制字符|intent|意图/ },
  ];
  for (const item of cases) {
    const run = dryRun("narrative", item.intent);
    try {
      assert.notEqual(run.result.status, 0);
      assert.match(run.result.stderr + run.result.stdout, item.message);
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  }
});

test("unsafe project IDs, unknown platforms, duplicate arguments and invalid modes fail closed", () => {
  const cases = [
    {
      args: ["--intent", "拍一条 30 秒短片", "--route", "narrative", "--duration", "30", "--aspect", "9:16",
        "--platform", "抖音", "--project", "../escape", "--no-portraits", "--dry-run"],
      message: /project/i,
    },
    {
      args: ["--intent", "拍一条 30 秒短片", "--route", "narrative", "--duration", "30", "--aspect", "9:16",
        "--platform", "unknown-platform", "--project", "VID-TEST", "--no-portraits", "--dry-run"],
      message: /platform/i,
    },
    {
      args: ["--intent", "拍一条 30 秒短片", "--route", "narrative", "--route", "marketing",
        "--duration", "30", "--aspect", "9:16", "--platform", "抖音", "--project", "VID-TEST",
        "--no-portraits", "--dry-run"],
      message: /duplicate|重复|--route/i,
    },
    {
      args: ["--intent", "拍一条 30 秒短片", "--route", "narrative", "--duration", "30", "--aspect", "9:16",
        "--platform", "抖音", "--project", "VID-TEST", "--producer", "none", "--no-portraits", "--dry-run"],
      message: /producer/i,
    },
    {
      args: ["--intent", "拍一条 30 秒短片", "--route", "marketing", "--product", "测试商品",
        "--prime-search", "stress/data-pipeline/fixtures/missing.json", "--project", "VID-TEST",
        "--no-portraits", "--dry-run"],
      message: /prime-search|ENOENT|不存在/i,
    },
    {
      args: ["--intent", "拍一条 30 秒短片", "--route", "marketing", "--product", "测试商品",
        "--prime-search", "stress/data-pipeline/fixtures/broken.json", "--project", "VID-TEST",
        "--no-portraits", "--dry-run"],
      message: /prime-search|JSON/i,
    },
  ];
  for (const item of cases) {
    const run = runPipeline(item.args);
    try {
      assert.equal(run.result.status, 2, `${item.args.join(" ")} should be a usage failure`);
      assert.match(run.result.stderr + run.result.stdout, item.message);
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  }
});
