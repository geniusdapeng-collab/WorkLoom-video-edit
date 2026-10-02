import { describe, expect, it } from "vitest";
import { filmWorkerEnvironment } from "./film-worker.js";
describe("film worker child environment", () => {
  it("keeps public local tools while dropping every account, database, model and signing credential", () => {
    const env = filmWorkerEnvironment({ PATH: "/local/bin", WL_FFMPEG: "/local/ffmpeg", SEEDANCE_MODEL: "test-model", LLM_API_KEY: "test-secret", JWT_SECRET: "test-secret", CNB_TOKEN: "test-secret", DATABASE_URL: "test-secret", CUSTOMER_OAUTH_TOKEN: "test-secret", NODE_OPTIONS: "--import arbitrary" });
    expect(env).toEqual({ PATH: "/local/bin", WL_FFMPEG: "/local/ffmpeg", SEEDANCE_MODEL: "test-model" });
  });
});
