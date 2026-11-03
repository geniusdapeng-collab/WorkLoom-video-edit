/** Legacy task lookup failures cannot prove that a supplier task has failed. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { JimengProvider, KlingProvider, SeedanceProvider } from "./gen-pool.js";
const providers = () => [
  new SeedanceProvider({ apiKey: "fixture", baseUrl: "https://fixture.invalid" }),
  new KlingProvider({ apiKey: "fixture", baseUrl: "https://fixture.invalid" }),
  new JimengProvider({ apiKey: "fixture", baseUrl: "https://fixture.invalid" }),
];
afterEach(() => vi.unstubAllGlobals());
describe("legacy provider lookup outcomes", () => {
  it.each([404, 429, 503])("HTTP%s query failure leaves the issued task unverified", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("synthetic lookup failure", { status })));
    for (const provider of providers()) await expect(provider.poll("issued-task")).rejects.toThrow(/查询|lookup/);
  });
  it.each(["null", "[]", "{}", '{"data":{}}', "not-json"])("invalid lookup response %s is not a terminal outcome", async body => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    for (const provider of providers()) await expect(provider.poll("issued-task")).rejects.toThrow(/查询|响应|lookup/);
  });
  it("explicit supplier failure stays failed, while success retains the original media URL", async () => {
    for (const provider of providers()) {
      const failed = provider.providerId === "seedance" ? { status: "failed", error: { message: "supplier rejection" } }
        : { data: { task_status: "failed", task_status_msg: "supplier rejection", status: "failed", message: "supplier rejection" } };
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(failed))));
      expect(await provider.poll("issued-task")).toMatchObject({ status: "failed", error: "supplier rejection" });
      const succeeded = provider.providerId === "seedance" ? { status: "succeeded", content: { video_url: "https://fixture.invalid/issued.mp4" } }
        : { data: { task_status: "succeed", task_result: { videos: [{ url: "https://fixture.invalid/issued.mp4" }] }, status: "done", video_url: "https://fixture.invalid/issued.mp4" } };
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(succeeded))));
      expect(await provider.poll("issued-task")).toMatchObject({ status: "succeeded", uri: "https://fixture.invalid/issued.mp4" });
    }
  });
});
