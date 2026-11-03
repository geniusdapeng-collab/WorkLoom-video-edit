#!/usr/bin/env node
/** Read-only setup check for a GitHub checkout of WorkLoom Video Edit. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEditLoopbackApi, withVerifiedEditService } from "./lib/edit-service-session.mjs";

const PRODUCT = "workloom-ai-video-edit";
const REPOSITORY = "geniusdapeng-collab/WorkLoom-video-edit";
const ROOT = resolve(import.meta.dirname, "../..");
const shaPattern = /^[a-f\d]{40}$/;
const USAGE = "Usage: node scripts/tools/codex-video-preflight.mjs [--api http://127.0.0.1:PORT]";

export function parsePreflightArgs(args) {
  if (args.length === 0) return {};
  if (args.length === 1 && args[0] === "--help") return { help: true };
  if (args.length !== 2 || args[0] !== "--api") throw new Error("INVALID_ARGUMENTS");
  return { api: parseEditLoopbackApi(args[1]) };
}

function processResult(file, args, root, input) {
  return spawnSync(file, args, {
    cwd: root, encoding: "utf8", input, timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", WORKLOOM_DEV_AUTO_LOGIN: "0" },
  });
}

function git(root, ...args) {
  const proc = processResult("git", args, root);
  return proc.status === 0 ? proc.stdout.trim() : null;
}

function runNode(root, args, input) {
  const proc = processResult(process.execPath, args, root, input);
  // Raw child output may contain file paths, URL credentials, or upstream errors.
  // Only return well-formed JSON and never forward child stderr.
  let data = null;
  try { data = JSON.parse(proc.stdout); } catch { /* Retain the failed status without copying untrusted output. */ }
  return { exit: proc.status ?? 1, data };
}

const remoteMatches = (origin) => origin === `https://github.com/${REPOSITORY}.git`
  || origin === `https://github.com/${REPOSITORY}`
  || origin === `git@github.com:${REPOSITORY}.git`
  || origin === `ssh://git@github.com/${REPOSITORY}.git`;

export async function checkLoopbackHealth(api) {
  try {
    const response = await fetch(`${api}/health`, { redirect: "error", signal: AbortSignal.timeout(5000) });
    const health = await response.json();
    return response.ok && health?.ok === true && health?.service === "workloom-im-server" ? "responded" : "unverified";
  } catch { return "unavailable"; }
}

async function preflight({ api }) {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, "product.manifest.json"), "utf8"));
  const actualSha = git(ROOT, "rev-parse", "--verify", "HEAD");
  const originMain = git(ROOT, "rev-parse", "--verify", "refs/remotes/origin/main");
  const matchingOrigin = remoteMatches(git(ROOT, "remote", "get-url", "origin"));
  const dirty = git(ROOT, "status", "--porcelain");
  const exactEdit = manifest.productId === PRODUCT && matchingOrigin && shaPattern.test(actualSha ?? "");
  const repo = { productId: manifest.productId === PRODUCT ? PRODUCT : null, githubRepository: matchingOrigin ? REPOSITORY : null,
    sha: shaPattern.test(actualSha ?? "") ? actualSha : null, fetchedOriginMainSha: shaPattern.test(originMain ?? "") ? originMain : null,
    clean: dirty === "", matchesFetchedOriginMain: actualSha !== null && actualSha === originMain, fetchedRemotelyByThisCommand: false };
  const runtime = { nodeMajor: Number(process.versions.node.split(".")[0]), repoReady: false, doctor: null };
  const service = { health: "not-requested", catalog: "not-requested", videoModels: 0, serviceIdentityVerified: false };
  if (exactEdit && runtime.nodeMajor >= 24) {
    const readiness = runNode(ROOT, ["scripts/workloom-agent.mjs", "invoke", "growth.repo.readiness"]);
    runtime.repoReady = readiness.exit === 0 && readiness.data?.result?.ready === true;
    const doctor = runNode(ROOT, ["--import", "tsx", "scripts/tools/video-doctor.mts", "--json"]);
    const counts = doctor.data?.summary;
    runtime.doctor = counts && ["pass", "warn", "fail"].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)
      ? { pass: counts.pass, warn: counts.warn, fail: counts.fail, failedCheckIds: (doctor.data.checks ?? [])
        .filter(item => item?.level === "fail" && /^[a-z0-9-]+$/.test(item.id)).map(item => item.id) }
      : null;
    if (api) {
      service.health = await checkLoopbackHealth(api);
      if (service.health === "responded") {
        const token = process.env.WORKLOOM_ACCESS_TOKEN;
        try {
          await withVerifiedEditService(api, token, async call => {
            service.serviceIdentityVerified = true;
            if (!token?.trim()) { service.catalog = "member-token-required"; return; }
            const catalog = await call("video.gen.catalog", { kind: "video", limit: 60 });
            service.catalog = Array.isArray(catalog?.models) ? "responded" : "unavailable";
            service.videoModels = service.catalog === "responded" ? catalog.models.length : 0;
          });
        } catch (error) {
          service.catalog = !service.serviceIdentityVerified ? "product-unverified"
            : error?.code === "MEMBER_TOKEN_REQUIRED" ? "member-token-required" : "unavailable";
        }
      }
    }
  }
  const ready = exactEdit && runtime.repoReady && runtime.doctor?.fail === 0
    && (!api || (service.serviceIdentityVerified && service.catalog === "responded" && service.videoModels > 0));
  return { schemaVersion: "workloom.codex-video-preflight/v1", ready: Boolean(ready), repo, runtime, service,
    productionAuthorization: "not-evaluated", paidCalls: 0, writeOperations: 0 };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const args = parsePreflightArgs(process.argv.slice(2));
    if (args.help) console.log(USAGE);
    else {
      const output = await preflight(args);
      console.log(JSON.stringify(output, null, 2));
      if (!output.ready) process.exitCode = 1;
    }
  } catch (error) {
    const safe = ["INVALID_ARGUMENTS", "API_NOT_LOOPBACK"].includes(error?.message) ? error.message : "PREFLIGHT_FAILED";
    console.error(JSON.stringify({ code: safe, usage: USAGE }));
    process.exitCode = 2;
  }
}
