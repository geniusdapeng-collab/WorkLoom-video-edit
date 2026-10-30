import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repo = resolve(import.meta.dirname, "../..");

test("an absent optional workbench library is not reported as a path-jail failure", () => {
  const home = mkdtempSync(join(tmpdir(), "workloom-video-doctor-"));
  try {
    const run = spawnSync(process.execPath, [
      "--import", "tsx",
      "scripts/tools/video-doctor.mts",
      "--json",
    ], {
      cwd: repo,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: home,
        WORKLOOM_KEYS_FILE: join(home, "missing-live.env"),
        WORKLOOM_BGM_HOME: join(home, ".workloom-bgm"),
        WORKLOOM_BGM_DISCOVER: "0",
      },
    });
    const report = JSON.parse(run.stdout);
    const jail = report.checks.find((item) => item.id === "bgm-library-jail");
    assert.equal(jail?.level, "pass", JSON.stringify({ status: run.status, jail, stderr: run.stderr }));
    assert.match(jail.detail, /可用曲库根/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
