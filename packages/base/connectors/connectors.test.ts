/**
 * 连接器就绪层 · 契约单测（fail-closed / 重试 / 超时 / 解析）。
 * 夹具即契约：与 docs/connectors-mock-exit.md 的"mock 退出标准"一一对应。
 */
import { describe, expect, it } from "vitest";
import { connectorReadiness, fetchCampaignMetrics, fetchPostComments, fetchPostMetrics } from "./index.js";
import { ConnectorRequestError, ConnectorUnconfiguredError } from "./types.js";

const ENV_OK = {
  ADS_GATEWAY_URL: "https://ads.example.test",
  ADS_GATEWAY_TOKEN: "tok",
  DOUYIN_OPEN_URL: "https://open.douyin.example.test",
  DOUYIN_ACCESS_TOKEN: "tok",
  DOUYIN_OPEN_ID: "open-1",
} as unknown as NodeJS.ProcessEnv;

describe("连接器就绪层", () => {
  it("缺凭证 fail-closed：抛 ConnectorUnconfiguredError，绝不回退 mock", async () => {
    await expect(fetchCampaignMetrics({ from: "2026-09-01", to: "2026-09-07" }, { env: {} as NodeJS.ProcessEnv }))
      .rejects.toBeInstanceOf(ConnectorUnconfiguredError);
  });

  it("就绪状态报告：未配置为 unconfigured（含缺失项），配置齐全为 ready", () => {
    const none = connectorReadiness({ env: {} as NodeJS.ProcessEnv });
    expect(none.every((h) => h.state === "unconfigured")).toBe(true);
    expect(none[0]!.detail).toContain("ADS_GATEWAY_URL");
    expect(connectorReadiness({ env: ENV_OK }).every((h) => h.state === "ready")).toBe(true);
  });

  it("成功路径：解析投放指标与内容指标（fixture 契约）", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/posts/metrics")) {
        return new Response(JSON.stringify({ posts: [{ postId: "p1", title: "样例", plays: 12_000, likes: 320, comments: 18, inquiries: 3 }] }));
      }
      return new Response(JSON.stringify({ metrics: [{ campaignId: "c1", spendFen: 100_000, impressions: 10_000, clicks: 300, conversions: 12, roi: 2.4 }] }));
    }) as unknown as typeof fetch;
    const ads = await fetchCampaignMetrics({ from: "2026-09-01", to: "2026-09-07" }, { env: ENV_OK, fetchImpl });
    expect(ads.metrics[0]).toMatchObject({ campaignId: "c1", roi: 2.4 });
    const posts = await fetchPostMetrics({ from: "2026-09-01", to: "2026-09-07" }, { env: ENV_OK, fetchImpl });
    expect(posts.posts[0]).toMatchObject({ postId: "p1", inquiries: 3 });
  });

  it("429 自动重试后成功（重试次数可留痕）", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ comments: [{ commentId: "cm1", text: "怎么合作", createdAt: "2026-09-19" }] }));
    }) as unknown as typeof fetch;
    const r = await fetchPostComments("p1", { env: ENV_OK, fetchImpl, sleep: async () => {} });
    expect(r.comments[0]!.commentId).toBe("cm1");
    expect(r.attempts).toBe(2);
  });

  it("4xx 不重试：直接失败（避免把权限问题当网络抖动）", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("forbidden", { status: 403 });
    }) as unknown as typeof fetch;
    await expect(fetchCampaignMetrics({ from: "a", to: "b" }, { env: ENV_OK, fetchImpl })).rejects.toBeInstanceOf(ConnectorRequestError);
    expect(calls).toBe(1);
  });
});
