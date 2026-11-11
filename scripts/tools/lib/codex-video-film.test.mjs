import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { continueNativeFilm, readFilmContinuation, verifyStudioHandoff } from "./codex-video-film.mjs";
import { admitFilmBudget } from "./codex-video-film-admission.mjs";
import { startProviderBudgetGateway } from "./provider-budget-gateway.ts";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const put = (file, value) => writeFileSync(file, JSON.stringify(value));
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const sourceCommit = "c".repeat(40);
const projectId = "VID-native";
const runId = "run-1";
const fileHash = (file) => hash(readFileSync(file));
const profile = { resolution: "1080p", frameRate: 25, subtitleMode: "both", nativeAudio: true,
  openWithCover: false, titleCard: false, durationToleranceFrames: 1,
  sidecarPolicy: "dialogue-and-composite-ass", persistentSubtitleText: "须保持完整的原始持续字幕" };

function fixture(t, options = {}) {
  const job = realpathSync(mkdtempSync(join(tmpdir(), "edit-film-continuation-")));
  t.after(() => rmSync(job, { recursive: true, force: true }));
  const studioRoot = join(job, "studio");
  const archiveRoot = join(studioRoot, "archive", "WS-1", projectId);
  const stageRoot = join(archiveRoot, "stages", "preproduction");
  mkdirSync(stageRoot, { recursive: true });
  const pipeline = options.pipeline ?? "narrative";
  const receipt = { projectId, runId, pipeline, requestSha256: hash("original request"), durationSeconds: 18 };
  const source = { kind: "system-preproduction", issuer: "workloom.studio-worker", projectId, runId, attempt: 2, workspaceId: "WS-1", tenantId: "TN-1" };
  const shots = [
    { shotId: "s1", duration: 9, prompt: "当前运行原件一" },
    { shotId: "s2", duration: 9, prompt: "当前运行原件二" },
  ];
  const shotlistPath = join(stageRoot, "attempt-2.shotlist.json");
  put(shotlistPath, { schemaVersion: "workloom.preproduction-cli-handoff/v1", projectId, source, shots, characters: [],
    metadata: { platform: "douyin", platformSelection: { aspectRatio: "9:16" }, builtinCharacterSelection: {
      schemaVersion: "workloom.video-character-selection/v1", mode: "none", characters: [] },
      brief: { duration: 18, ...(options.profile ? { productionRequirements: profile } : {}) } }, draft: true });
  const promptsSha256 = hash("fixture prompt bytes");
  const outputPath = join(stageRoot, "attempt-2.output.json");
  put(outputPath, { success: true, promptsSha256, cliShotlistRef: relative(archiveRoot, shotlistPath), cliShotlistSha256: fileHash(shotlistPath),
    productionEvidence: { ...source, schemaVersion: "workloom.preproduction-authority/v1", pipelineKind: pipeline } });
  const archiveReceipt = { attempt: 2, outputRef: relative(archiveRoot, outputPath), outputSha256: fileHash(outputPath) };
  const archive = { archiveExists: true, archiveRoot, projectId, stages: [{ ...archiveReceipt, stageId: "preproduction", status: "done", runId }] };
  const production = { projectId, sourceStageRunId: "STAGE-2", sourceAttempt: 2, promptsSha256,
    shots: shots.map(({ shotId, duration, prompt }) => ({ shotId, durationSec: duration, prompt, promptSha256: hash(prompt) })) };
  const service = { sourceCommit, videoStudio: { deferRender: true, workDirSha256: hash(studioRoot) } };
  const receiptPath = join(job, "studio-start.json");
  put(receiptPath, receipt);
  const manifest = join(job, "delivery", projectId + "-delivery-manifest.json");
  const args = [];
  const input = { receipt, receiptPath, archiveReceipt, archive, production, service, sourceCommit, root: repo,
    env: { WORKLOOM_ACCESS_TOKEN: "fixture-member-secret", GH_TOKEN: "fixture-owner-secret", FILM_WORKER_MODE: "worker",
      VOLCENGINE_ARK_API_KEY: "not-the-budget-token", DEEPSEEK_API_KEY: "not-the-budget-token" },
    admission: async () => ({ evidence: { task: "fixture-budget" },
      environment: { WORKLOOM_FILM_BUDGET_RELAY: "1", VOLCENGINE_ARK_API_KEY: "fixture-loopback-relay" } }),
    film: async ({ args: argv, env }) => {
      args.push(argv);
      assert.equal(env.WORKLOOM_ACCESS_TOKEN, undefined);
      assert.equal(env.GH_TOKEN, undefined);
      assert.equal(env.FILM_WORKER_MODE, undefined);
      assert.equal(env.DEEPSEEK_API_KEY, undefined);
      assert.equal(env.VOLCENGINE_ARK_API_KEY, "fixture-loopback-relay");
      assert.equal(env.WORKLOOM_VIDEO_ARTIFACT_ROOT, job);
      assert.equal(fileHash(argv[argv.indexOf("--shots") + 1]), fileHash(shotlistPath));
      assert.equal(JSON.parse(readFileSync(join(job, "film-continuation.json"))).shotlistSha256, fileHash(shotlistPath));
      if (options.loseWorker) throw new Error("worker exited with unknown acknowledgement");
      mkdirSync(dirname(manifest));
      put(manifest, { projectId, sourceShotlistSha256: fileHash(shotlistPath) });
      return { code: 0, signal: null };
    },
    quality: async ({ projectId: id, outDir }) => {
      assert.equal(id, projectId);
      assert.equal(outDir, "delivery");
      return { complete: true, projectId, technicalQuality: "passed", manifestPath: relative(job, manifest),
        manifestSha256: fileHash(manifest), report: { assets: [{ id: "master", probe: { videoDuration: options.duration ?? 18 } }] } };
    } };
  return { input, args, manifest, outputPath, shotlistPath };
}

test("same-run native narrative continuation binds manifest, duration and canonical default stages", async (t) => {
  const f = fixture(t);
  const done = await continueNativeFilm(f.input);
  assert.equal(done.state, "finished");
  assert.equal(done.delivered, true);
  assert.equal(done.delivery.durationSeconds, 18);
  assert.equal(done.shotlistSha256, fileHash(f.shotlistPath));
  assert.equal(f.args.length, 1);
  assert.ok(!f.args[0].some((value) => /(?:^|,)mux(?:,|$)/.test(value)));
  assert.ok(f.args[0].includes("--strict-source-cast"));
  assert.deepEqual(await continueNativeFilm(f.input), done);
  assert.equal(f.args.length, 1);
});

test("marketing continuation honors frozen 25 fps, native audio and both subtitle forms", async (t) => {
  const f = fixture(t, { pipeline: "marketing", profile: true, duration: 18.04 });
  const done = await continueNativeFilm(f.input);
  assert.equal(done.state, "finished");
  const argv = f.args[0];
  for (const [key, value] of [["--route-kind", "marketing"], ["--fps", "25"], ["--native-audio", "1"],
    ["--subtitle-mode", "both"], ["--subtitle-persistent-text", profile.persistentSubtitleText]]) {
    assert.equal(argv[argv.indexOf(key) + 1], value);
  }
  assert.match(argv[argv.indexOf("--stages") + 1], /,mux,master$/);
  assert.ok(argv.includes("--no-open-with-cover"));
  assert.ok(argv.includes("--no-title-card"));
});

for (const [name, alter, reason] of [
  ["wrong configured Studio archive root", f => { f.input.service.videoStudio.workDirSha256 = hash("different root"); }, /EDIT_STUDIO_HANDOFF_CONFIGURATION_MISMATCH/u],
  ["vendor still configured to render", f => { f.input.service.videoStudio.deferRender = false; }, /EDIT_STUDIO_HANDOFF_CONFIGURATION_MISMATCH/u],
  ["wrong source SHA", f => { f.input.service.sourceCommit = "a".repeat(40); }, /EDIT_STUDIO_HANDOFF_CONFIGURATION_MISMATCH/u],
  ["stale stage", f => { f.input.production.sourceAttempt = 3; }, /STALE_OR_UNAPPROVED_PREPRODUCTION/u],
  ["changed shotlist bytes", f => { put(f.shotlistPath, {}); }, /ARCHIVE_DIGEST_MISMATCH/u],
  ["changed current prompt", f => { f.input.production.shots[0].prompt = "manual"; }, /SHOTLIST_NOT_CURRENT/u],
]) {
  test("no Film call with " + name, async (t) => {
    const f = fixture(t);
    alter(f);
    await assert.rejects(continueNativeFilm(f.input), reason);
    assert.deepEqual(f.args, []);
  });
}

test("worker loss preserves unknown dispatch and never launches another worker", async (t) => {
  const f = fixture(t, { loseWorker: true });
  await assert.rejects(continueNativeFilm(f.input), /unknown acknowledgement/u);
  assert.equal((await continueNativeFilm(f.input)).state, "film_dispatch_unknown");
  assert.equal(f.args.length, 1);
});

test("current wrong duration or wrong source manifest can never be reported as delivered", async (t) => {
  const f = fixture(t, { duration: 18.08, profile: true });
  const rejected = await continueNativeFilm(f.input);
  assert.equal(rejected.state, "delivery_unverified");
  assert.equal(rejected.errorCode, "DELIVERY_DURATION_OUT_OF_CONTRACT");
  put(f.manifest, { projectId, sourceShotlistSha256: hash("old job") });
  const journalPath = join(dirname(f.input.receiptPath), "film-continuation.json");
  const journal = JSON.parse(readFileSync(journalPath));
  put(journalPath, { ...journal, state: "finished", delivered: true, delivery: { technicalQuality: "passed" } });
  const readback = await readFilmContinuation(f.input);
  assert.equal(readback.state, "delivery_unverified");
  assert.equal(readback.delivered, false);
  assert.equal(readback.delivery, null);
  assert.equal(readback.errorCode, "DELIVERY_SOURCE_CHANGED");
  put(journalPath, { ...journal, targetDuration: 19 });
  await assert.rejects(readFilmContinuation(f.input), /FILM_RECEIPT_MISMATCH/u);
  assert.equal(f.args.length, 1);
});

test("parallel continuation is constrained to one Film invocation", async (t) => {
  const f = fixture(t);
  const first = await Promise.allSettled([continueNativeFilm(f.input), continueNativeFilm(f.input)]);
  assert.equal(f.args.length, 1);
  assert.ok(first.some((entry) => entry.status === "fulfilled" && entry.value.state === "finished"));
  assert.ok(first.every((entry) => entry.status === "fulfilled" || /FILM_ALREADY_RUNNING/.test(entry.reason.message)));
});

test("no Film launch or dispatch marker without explicit budget authorization", async (t) => {
  const f = fixture(t);
  delete f.input.admission;
  await assert.rejects(continueNativeFilm(f.input), /FILM_BUDGET_AUTHORIZATION_REQUIRED/u);
  assert.equal(f.args.length, 0);
  assert.equal(await readFilmContinuation(f.input), null);
});

test("actual task budget relay verifies allowed cap, task, model and complete shot scope without provider POST", async (t) => {
  const f = fixture(t);
  const clientToken = "local_budget_test_only_".padEnd(48, "x");
  let upstreamCalls = 0;
  const gateway = await startProviderBudgetGateway({ port: 0, task: "fixture-budget",
    journalPath: join(dirname(f.input.receiptPath), "budget.jsonl"), clientToken,
    deepSeekApiKey: "fixture-deepseek-no-external-credential", arkApiKey: "fixture-ark-no-external-credential", profile: "workflow",
    scope: { video: { seconds: 12, ratio: "9:16", resolution: "1080p" } },
    fetchImpl: async () => { upstreamCalls++; throw new Error("test prohibits external calls"); },
  });
  t.after(() => gateway.close());
  const args = { env: { LLM_BASE_URL: gateway.baseUrl, ARK_BASE_URL: gateway.baseUrl + "/api/v3",
    WORKLOOM_BUDGET_GATEWAY_TOKEN: clientToken, WORKLOOM_BUDGET_TASK_ID: "fixture-budget" },
  shotDurations: [12, 12], aspect: "9:16", resolution: "1080p" };
  const result = await admitFilmBudget(args);
  assert.equal(result.evidence.estimateCapMicroCny, null);
  assert.equal(result.evidence.approvedMicroCny, null);
  assert.equal(result.environment.ARK_BASE_URL, gateway.baseUrl + "/api/v3");
  assert.ok(!JSON.stringify(result.evidence).includes(clientToken));
  await assert.rejects(admitFilmBudget({ ...args, shotDurations: [10, 14] }), /FILM_BUDGET_SCOPE_INSUFFICIENT/u);
  await assert.rejects(admitFilmBudget({ ...args, env: { ...args.env, WORKLOOM_BUDGET_APPROVED_MICRO_CNY: "invalid" } }),
    /FILM_BUDGET_AUTHORIZATION_REQUIRED/u);
  await assert.rejects(admitFilmBudget({ ...args, env: { ...args.env, WORKLOOM_BUDGET_TASK_ID: "other-job" } }),
    /FILM_BUDGET_RECEIPT_INVALID/u);
  assert.equal(upstreamCalls, 0);
});

test("actual task budget relay admits approved non-uniform shots only when their exact total matches scope", async (t) => {
  const f = fixture(t);
  const clientToken = "local_budget_nonuniform_".padEnd(48, "x");
  let upstreamCalls = 0;
  const gateway = await startProviderBudgetGateway({ port: 0, task: "fixture-budget",
    journalPath: join(dirname(f.input.receiptPath), "budget-nonuniform.jsonl"), clientToken,
    deepSeekApiKey: "fixture-deepseek-no-external-credential", arkApiKey: "fixture-ark-no-external-credential", profile: "workflow",
    scope: { video: { seconds: 30, allowedSeconds: [4, 5, 8], totalSeconds: 17, ratio: "9:16", resolution: "1080p" } },
    fetchImpl: async () => { upstreamCalls++; throw new Error("test prohibits external calls"); },
  });
  t.after(() => gateway.close());
  const args = { env: { LLM_BASE_URL: gateway.baseUrl, ARK_BASE_URL: gateway.baseUrl + "/api/v3",
    WORKLOOM_BUDGET_GATEWAY_TOKEN: clientToken, WORKLOOM_BUDGET_TASK_ID: "fixture-budget" },
  shotDurations: [4, 5, 8], aspect: "9:16", resolution: "1080p" };
  const result = await admitFilmBudget(args);
  assert.deepEqual(result.evidence.videoScope, {
    seconds: 30, allowedSeconds: [4, 5, 8], totalSeconds: 17, ratio: "9:16", resolution: "1080p",
  });
  await assert.rejects(admitFilmBudget({ ...args, shotDurations: [4, 4, 8] }), /FILM_BUDGET_SCOPE_INSUFFICIENT/u);
  await assert.rejects(admitFilmBudget({ ...args, shotDurations: [4, 6, 7] }), /FILM_BUDGET_SCOPE_INSUFFICIENT/u);
  assert.equal(upstreamCalls, 0);
});

test("a Studio source that changes while budget is admitted cannot launch Film", async (t) => {
  const f = fixture(t);
  f.input.refreshSource = async () => ({ archive: f.input.archive, production: { ...f.input.production, sourceAttempt: 3 } });
  await assert.rejects(continueNativeFilm(f.input), /STALE_OR_UNAPPROVED_PREPRODUCTION/u);
  assert.equal(f.args.length, 0);
  assert.equal(await readFilmContinuation(f.input), null);
});

function repairFixture(t) {
  const f = fixture(t, { pipeline: "marketing" });
  const scope = { tenantId: "TN-1", workspaceId: "WS-1", projectId, runId, attempt: 2 };
  const identity = { scope: { ...scope, runId: "historical-run", attempt: 1 }, stageRunId: "STAGE-1",
    inputRef: "stages/preproduction/attempt-1.input.json", inputSha256: hash("original input"),
    outputRef: "stages/preproduction/attempt-1.output.json", outputSha256: hash("original output") };
  const adoptionPath = join(dirname(f.outputPath), "attempt-2.approved-source-adoption.json");
  const planDigest = hash("verified service plan");
  const adoption = { schemaVersion: "workloom.approved-source-adoption/v1", mode: "approved-source-prompt-repair", planDigest,
    source: identity, currentDraftSource: identity, rootApprovalSource: identity, target: scope };
  const update = (mutate = () => {}) => {
    mutate(adoption);
    put(adoptionPath, adoption);
    const descriptor = { mode: adoption.mode, planDigest, adoptionRef: relative(f.input.archive.archiveRoot, adoptionPath),
      adoptionSha256: fileHash(adoptionPath) };
    f.input.production.approvedSourceRepair = descriptor;
    const sheet = JSON.parse(readFileSync(f.shotlistPath));
    sheet.source = { ...sheet.source, kind: descriptor.mode, adoption: { ref: descriptor.adoptionRef, sha256: descriptor.adoptionSha256 } };
    sheet.retainedApprovedSource = sheet.source.adoption;
    put(f.shotlistPath, sheet);
    const output = JSON.parse(readFileSync(f.outputPath));
    output.mode = descriptor.mode;
    output.productionEvidence.approvedSourceRepair = descriptor;
    output.cliShotlistSha256 = fileHash(f.shotlistPath);
    put(f.outputPath, output);
    f.input.archiveReceipt.outputSha256 = fileHash(f.outputPath);
    f.input.archive.stages[0].outputSha256 = fileHash(f.outputPath);
  };
  update();
  return { ...f, adoptionPath, adoption, update };
}

function verifyFixture(f) {
  return verifyStudioHandoff({ ...f.input, studio: f.input.receipt,
    studioRoot: join(dirname(f.input.receiptPath), "studio"), requestedDuration: 18 });
}

test("approved-source handoff binds live descriptor, archived adoption and current target without Film dispatch", t => {
  const f = repairFixture(t);
  assert.deepEqual(verifyFixture(f).source.approvedSourceRepair, f.input.production.approvedSourceRepair);
  assert.equal(f.args.length, 0);
});

for (const [name, alter] of [
  ["descriptor absent on live service", f => { delete f.input.production.approvedSourceRepair; }],
  ["descriptor drift", f => { f.input.production.approvedSourceRepair = { ...f.input.production.approvedSourceRepair, planDigest: hash("changed") }; }],
  ["adoption byte change", f => { put(f.adoptionPath, {}); }],
  ["target run change even with new digest", f => f.update(adoption => { adoption.target.runId = "other-run"; })],
  ["historical tenant change even with new digest", f => f.update(adoption => { adoption.source.scope.tenantId = "TN-other"; })],
  ["historical source after target", f => f.update(adoption => { adoption.source.scope.attempt = 3; })],
]) {
  test("adopted-source handoff rejects " + name, t => {
    const f = repairFixture(t);
    alter(f);
    assert.throws(() => verifyFixture(f));
    assert.equal(f.args.length, 0);
  });
}

test("an adopted source that changes during admission cannot dispatch Film", async t => {
  const f = repairFixture(t);
  f.input.refreshSource = async () => {
    f.update(adoption => { adoption.planDigest = hash("changed plan"); });
    return { archive: f.input.archive, production: f.input.production };
  };
  await assert.rejects(continueNativeFilm(f.input), /APPROVED_SOURCE_HANDOFF_UNVERIFIED/u);
  assert.equal(f.args.length, 0);
  assert.equal(await readFilmContinuation(f.input), null);
});


test("a valid new adoption digest during admission is detected by the source refresh comparison", async t => {
  const f = repairFixture(t);
  f.input.refreshSource = async () => {
    f.update(adoption => { adoption.boundary = "changed archived bytes"; });
    return { archive: f.input.archive, production: f.input.production };
  };
  await assert.rejects(continueNativeFilm(f.input), /STUDIO_SOURCE_CHANGED_BEFORE_FILM/u);
  assert.equal(f.args.length, 0);
  assert.equal(await readFilmContinuation(f.input), null);
});

test("an explicitly configured private shared Studio root can serve the same native per-job Film contract", async t => {
  const f = fixture(t), shared = realpathSync(mkdtempSync(join(tmpdir(), "edit-shared-studio-")));
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  cpSync(join(dirname(f.input.receiptPath), "studio"), shared, { recursive: true });
  f.input.archive.archiveRoot = join(shared, "archive", "WS-1", projectId);
  f.input.service.videoStudio.workDirSha256 = hash(shared);
  f.input.env.WORKLOOM_EDIT_STUDIO_ROOT = shared;
  assert.equal((await continueNativeFilm(f.input)).state, "finished");
  assert.equal(f.args.length, 1);
});

for (const kind of ["missing", "relative", "shared", "symlink", "wrong-service"]) {
  test("configured shared Studio " + kind + " fails before Film dispatch", async t => {
    const f = fixture(t), shared = realpathSync(mkdtempSync(join(tmpdir(), "edit-shared-studio-negative-")));
    t.after(() => rmSync(shared, { recursive: true, force: true }));
    let configured = shared;
    if (kind === "missing") configured = join(shared, "absent");
    if (kind === "relative") configured = "relative-studio";
    if (kind === "shared") chmodSync(shared, 0o755);
    if (kind === "symlink") { configured = join(shared, "linked"); symlinkSync(join(dirname(f.input.receiptPath), "studio"), configured); }
    f.input.env.WORKLOOM_EDIT_STUDIO_ROOT = configured;
    await assert.rejects(continueNativeFilm(f.input), kind === "wrong-service" ? /EDIT_STUDIO_HANDOFF_CONFIGURATION_MISMATCH/u : /EDIT_STUDIO_ROOT_INVALID/u);
    assert.equal(f.args.length, 0);
  });
}
