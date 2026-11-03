/** Connect the native Film CLI to the existing per-job provider budget relay. */
import { request as requestHttp } from "node:http";
export class FilmContinuationError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function check(condition, code) {
  if (!condition) throw new FilmContinuationError(code);
}

async function budgetStatus(origin, token) {
  try {
    const response = await new Promise((done, reject) => {
      const request = requestHttp(new URL("/budget/status", origin), { agent: false,
        headers: { authorization: "Bearer " + token, accept: "application/json" },
        signal: AbortSignal.timeout(5_000) }, done);
      request.once("error", reject);
      request.end();
    });
    if (response.statusCode !== 200) {
      response.destroy();
      throw new FilmContinuationError("FILM_BUDGET_AUTHORIZATION_UNVERIFIED");
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      check(size <= 1024 * 1024, "FILM_BUDGET_RECEIPT_INVALID");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks, size));
  } catch (error) {
    throw error instanceof FilmContinuationError ? error : new FilmContinuationError("FILM_BUDGET_RECEIPT_UNAVAILABLE");
  }
}

export async function admitFilmBudget({ env, shotDurations, aspect, resolution, status = budgetStatus }) {
  const origin = env.LLM_BASE_URL;
  const token = env.WORKLOOM_BUDGET_GATEWAY_TOKEN;
  const task = env.WORKLOOM_BUDGET_TASK_ID;
  const approved = env.WORKLOOM_BUDGET_APPROVED_MICRO_CNY;
  const approvedMicroCny = /^\d+$/u.test(approved ?? "") ? Number(approved) : NaN;
  check(/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/u.test(origin ?? "")
    && Number(origin.split(":").at(-1)) >= 1024 && Number(origin.split(":").at(-1)) <= 65535
    && env.ARK_BASE_URL === origin + "/api/v3" && /^[A-Za-z0-9_-]{32,256}$/u.test(token ?? "")
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(task ?? "") && Number.isSafeInteger(approvedMicroCny)
    && approvedMicroCny > 0, "FILM_BUDGET_AUTHORIZATION_REQUIRED");
  const readback = await status(origin, token);
  check(readback?.schema === "workloom.provider-budget-wal/v1" && readback.task === task
    && readback.profile === "workflow" && readback.state === "live" && readback.live === true
    && readback.frozen === null && readback.held === false && readback.deadlineAt > Date.now(),
  "FILM_BUDGET_RECEIPT_INVALID");
  const { ARK_IMAGE_PATH, ARK_VIDEO_PATH, DEEPSEEK_CHAT_PATH, DEEPSEEK_MODEL,
    SEEDANCE_MODEL, SEEDREAM_MODEL, WORKFLOW_TASK_CAPS: caps } = await import("./provider-budget-policy.ts");
  const bound = caps.mediaMicroCny + caps.llmEstimatedMaxMicroCny;
  check(Object.entries(caps).every(([key, value]) => readback.caps?.[key] === value)
    && approvedMicroCny >= bound, "FILM_BUDGET_APPROVED_CAP_INSUFFICIENT");
  for (const [phase, model, path] of [
    ["llm", DEEPSEEK_MODEL, DEEPSEEK_CHAT_PATH], ["image", SEEDREAM_MODEL, ARK_IMAGE_PATH], ["video", SEEDANCE_MODEL, ARK_VIDEO_PATH],
  ]) {
    const relay = readback.phaseRelays?.[phase];
    check(relay?.configured === true && relay.model === model && relay.path === path, "FILM_BUDGET_RELAY_MISMATCH");
  }
  const videoScope = readback.scope?.video;
  const used = readback.usage;
  check(videoScope?.ratio === aspect && videoScope.resolution === (resolution === "2160p" ? "1080p" : resolution)
    && Number.isSafeInteger(videoScope.seconds) && shotDurations.every((duration) => duration === videoScope.seconds)
    && Number.isSafeInteger(used?.videoCalls) && used.videoCalls >= 0 && used.videoCalls + shotDurations.length <= caps.videoCalls
    && Number.isSafeInteger(used.videoSeconds) && used.videoSeconds >= 0
    && used.videoSeconds + shotDurations.length * videoScope.seconds <= caps.totalVideoSeconds
    && Number.isSafeInteger(used.imageCalls) && used.imageCalls >= 0 && used.imageCalls < caps.imageCalls
    && Number.isSafeInteger(used.llmCalls) && used.llmCalls >= 0 && used.llmCalls < caps.llmCalls, "FILM_BUDGET_SCOPE_INSUFFICIENT");
  return {
    evidence: { task, profile: "workflow", deadlineAt: readback.deadlineAt, estimateCapMicroCny: bound,
      approvedMicroCny, videoScope: { seconds: videoScope.seconds, ratio: videoScope.ratio, resolution: videoScope.resolution } },
    environment: { WORKLOOM_FILM_BUDGET_RELAY: "1", LLM_PROVIDER: "deepseek", LLM_MODEL: DEEPSEEK_MODEL,
      LLM_BASE_URL: origin, LLM_API_KEY: token, ARK_BASE_URL: env.ARK_BASE_URL,
      VOLCENGINE_ARK_API_KEY: token, SEEDREAM_MODEL, SEEDANCE_MODEL },
  };
}

export function filmRuntimeEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    /^(?:PATH|HOME|USERPROFILE|TMPDIR|TMP|TEMP|LANG|LC_[A-Z_]+|SYSTEMROOT|COMSPEC|WL_FFMPEG|WL_FFPROBE|FFMPEG_PATH|FFPROBE_PATH|WORKLOOM_(?:COLOR|BGM)_HOME)$/u.test(key)
    || /^WORKLOOM_(?:BGM|SUBTITLE|POST|ENHANCE)_FF(?:MPEG|PROBE)_PATH$/u.test(key)));
}
