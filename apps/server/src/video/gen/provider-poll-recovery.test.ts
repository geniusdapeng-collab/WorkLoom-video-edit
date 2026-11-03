import { afterEach, describe, expect, it, vi } from "vitest";
import { ArkVideoProvider, HiggsfieldProvider, MuapiProvider } from "./providers.js";
afterEach(() => vi.unstubAllGlobals());
const providers = () => [
  new ArkVideoProvider({ apiKey: "fixture", baseUrl: "https://fixture.invalid" }),
  new HiggsfieldProvider({ keyId: "fixture", keySecret: "fixture", baseUrl: "https://fixture.invalid" }),
  new MuapiProvider({ apiKey: "fixture", baseUrl: "https://fixture.invalid" }),
];
describe("已接受任务的查询故障不冒充任务失败", () => {
  it.each([401, 404, 429, 503])("查询HTTP%s保留未核实，原任务仍可回查", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("fixture lookup failed", { status })));
    for (const provider of providers()) await expect(provider.poll("issued-task")).rejects.toThrow(/查询|HTTP/);
  });
  it.each(["null", "[]", "not-json"])("非任务响应%s保留查询失败", async body => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    for (const provider of providers()) await expect(provider.poll("issued-task")).rejects.toThrow(/查询|响应/);
  });
  it("供应商明确失败仍保留终态，成功产物保持默认接纳", async () => {
    for (const provider of providers()) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "failed", error: { message: "fixture rejection" } }))));
      expect((await provider.poll("issued-task")).status).toBe("failed");
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: provider.providerId === "higgsfield" ? "completed" : "succeeded", content: { video_url: "https://fixture.invalid/v.mp4" }, video: { url: "https://fixture.invalid/v.mp4" }, url: "https://fixture.invalid/v.mp4" }))));
      expect(await provider.poll("issued-task")).toMatchObject({ status: "succeeded", uri: "https://fixture.invalid/v.mp4" });
    }
  });
});
