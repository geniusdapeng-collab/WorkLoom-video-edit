/**
 * 网关客户端单测：重试/退避/超时/鉴权/密钥安全（全部用假 fetch，不发外呼）。
 */
import { describe, expect, it } from "vitest";
import { JevClient, JevError } from "./client.js";
import { createMockFetch } from "./mock-gateway.js";
import type { JevRequest } from "./types.js";

const REQUEST: JevRequest = {
  state: { comment: "想问一下你们房间多少钱一晚" },
  questions: {
    intent: {
      type: "choice",
      instructions: "Choose one",
      criteria: { inquiry: "asks", complaint: "unhappy", booking_intent: "books", smalltalk: "chat", spam: "ads" },
    },
  },
};

const noSleep = async (): Promise<void> => undefined;

describe("JevClient", () => {
  it("成功调用：协议头 + 回答解析（走本地模拟 fetch）", async () => {
    const { fetchImpl } = createMockFetch();
    const client = new JevClient({ apiKey: "test-key", baseUrl: "https://example.test", fetchImpl });
    const result = await client.evaluate(REQUEST);
    expect(result.byId["intent"]?.choice).toBe("inquiry");
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.model).toBe("typesafe-ai/jev");
  });

  it("协议头按 evaluation v4 发送", async () => {
    const seen: Record<string, string> = {};
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      for (const [key, value] of Object.entries(init?.headers ?? {})) seen[key.toLowerCase()] = String(value);
      return new Response(JSON.stringify({ model: "typesafe-ai/jev", answers: { intent: { type: "choice", choice: "inquiry", probabilities: { inquiry: 1, complaint: 0, booking_intent: 0, smalltalk: 0, spam: 0 } } }, usage: {} }), { status: 200 });
    }) as typeof fetch;
    const client = new JevClient({ apiKey: "test-key", baseUrl: "https://example.test", fetchImpl });
    await client.evaluate(REQUEST);
    expect(seen["ai-gateway-protocol-version"]).toBe("0.0.1");
    expect(seen["ai-evaluation-model-specification-version"]).toBe("4");
    expect(seen["ai-model-id"]).toBe("typesafe-ai/jev");
  });

  it("429 后重试直至成功", async () => {
    const { fetchImpl, calls } = createMockFetch({ failFirstRequests: 2, failStatuses: [429] });
    const client = new JevClient({
      apiKey: "k",
      baseUrl: "https://example.test",
      fetchImpl,
      maxAttempts: 3,
      sleepImpl: noSleep,
    });
    const result = await client.evaluate(REQUEST);
    expect(result.byId["intent"]?.choice).toBe("inquiry");
    expect(calls()).toBe(3);
  });

  it("持续 429 时抛出 rate_limited（可重试语义）", async () => {
    const { fetchImpl } = createMockFetch({ failFirstRequests: 99, failStatuses: [429] });
    const client = new JevClient({
      apiKey: "k",
      baseUrl: "https://example.test",
      fetchImpl,
      maxAttempts: 2,
      sleepImpl: noSleep,
    });
    await expect(client.evaluate(REQUEST)).rejects.toMatchObject({ code: "rate_limited", retryable: true });
  });

  it("529 过载同样按可重试处理", async () => {
    const { fetchImpl } = createMockFetch({ failFirstRequests: 1, failStatuses: [529] });
    const client = new JevClient({ apiKey: "k", baseUrl: "https://example.test", fetchImpl, maxAttempts: 2, sleepImpl: noSleep });
    const result = await client.evaluate(REQUEST);
    expect(result.byId["intent"]?.choice).toBe("inquiry");
  });

  it("401 立即失败且标记鉴权错误（不重试）", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 });
    }) as typeof fetch;
    const client = new JevClient({ apiKey: "k", baseUrl: "https://example.test", fetchImpl, maxAttempts: 3, sleepImpl: noSleep });
    await expect(client.evaluate(REQUEST)).rejects.toMatchObject({ code: "auth", retryable: false });
    expect(calls).toBe(1);
  });

  it("超时（Abort）归类为 timeout", async () => {
    const hangingFetch = ((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as typeof fetch;
    const client = new JevClient({
      apiKey: "k",
      baseUrl: "https://example.test",
      fetchImpl: hangingFetch,
      timeoutMs: 20,
      maxAttempts: 1,
      sleepImpl: noSleep,
    });
    await expect(client.evaluate(REQUEST)).rejects.toMatchObject({ code: "timeout", retryable: true });
  });

  it("非 JSON 响应归类为 invalid_response", async () => {
    const fetchImpl = (async () => new Response("<html>oops</html>", { status: 200 })) as typeof fetch;
    const client = new JevClient({ apiKey: "k", baseUrl: "https://example.test", fetchImpl });
    await expect(client.evaluate(REQUEST)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("缺少 key 且非本地地址时直接报 missing_key（不发请求）", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const client = new JevClient({ baseUrl: "https://ai-gateway.vercel.sh", fetchImpl });
    await expect(client.evaluate(REQUEST)).rejects.toMatchObject({ code: "missing_key" });
    expect(calls).toBe(0);
  });

  it("错误信息里不出现 API key", async () => {
    const fetchImpl = (async () => {
      throw new Error("socket hang up");
    }) as typeof fetch;
    const client = new JevClient({
      apiKey: "sk-super-secret-value",
      baseUrl: "https://example.test",
      fetchImpl,
      maxAttempts: 1,
      sleepImpl: noSleep,
    });
    try {
      await client.evaluate(REQUEST);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(JevError);
      expect(String((error as Error).message)).not.toContain("sk-super-secret-value");
    }
  });
});
