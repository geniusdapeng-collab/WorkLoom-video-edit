/**
 * NanoJev 适配器单测（离线；不发外呼、不加载模型）。
 *
 * 覆盖的是"契约抹平"这一层的硬约束：
 *   ① 请求必须是 NanoJev 严格 schema（只允许 states[{id,state,questions}]）；
 *   ② boolean 读 p_true、choice 读 choice+probabilities、score 读 score+probabilities("0".."n-1")；
 *   ③ NanoJev 不返回 confidence → 一律派生并标记（分流更保守）；
 *   ④ 本地推理无 token 计费 → inputTokens=0（成本 $0）；
 *   ⑤ 400 立即失败不重试；500 可重试；超时归类为 timeout。
 */
import { describe, expect, it } from "vitest";
import { JevError } from "./client.js";
import { NanoJevClient, NANOJEV_DEFAULT_URL, parseNanoJevAnswers, toNanoJevRequest } from "./nanojev.js";
import type { JevQuestionSet, JevRequest } from "./types.js";

const QUESTIONS: JevQuestionSet = {
  intent: {
    type: "choice",
    instructions: "Pick one category",
    criteria: { inquiry: "asks a question", complaint: "expresses dissatisfaction" },
  },
  is_lead: { type: "boolean", instructions: "Is this a potential customer?" },
  strength: { type: "score", instructions: "How concrete is the intent?", criteria: ["none", "vague", "clear"] },
};

const REQUEST: JevRequest = { state: { comment: "想问一下价格" }, questions: QUESTIONS };

function nanojevBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "openjev-toy-inference-v1",
    checkpoint: { directory: "/models/variants/local_atomic_seed17", base_model: "Qwen/Qwen3-0.6B" },
    execution: { device: "cuda:0", network_model_calls: 0 },
    states: [
      {
        id: "s0",
        answers: {
          intent: { type: "choice", choice: "inquiry", value: "inquiry", probabilities: { inquiry: 0.88, complaint: 0.12 } },
          is_lead: { type: "boolean", p_true: 0.74, value: true, probabilities: { false: 0.26, true: 0.74 } },
          strength: { type: "score", score: 1.2, level: 1, value: 1.2, probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 } },
        },
      },
    ],
    ...overrides,
  };
}

describe("toNanoJevRequest", () => {
  it("严格按 NanoJev schema 包装（只允许 states 顶层键）", () => {
    const body = toNanoJevRequest(REQUEST);
    expect(Object.keys(body)).toEqual(["states"]);
    const state = (body.states as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(["id", "questions", "state"]);
    expect(state["id"]).toBe("s0");
    expect(state["state"]).toEqual({ comment: "想问一下价格" });
  });
});

describe("parseNanoJevAnswers", () => {
  it("解析 boolean/choice/score，并把置信度标记为派生", () => {
    const result = parseNanoJevAnswers(nanojevBody(), QUESTIONS, "nanojev-local", 123);
    expect(result.byId["intent"]?.choice).toBe("inquiry");
    expect(result.byId["intent"]?.probabilities?.["inquiry"]).toBeCloseTo(0.88);
    expect(result.byId["intent"]?.confidence).toBeCloseTo(0.88);
    expect(result.byId["intent"]?.confidenceDerived).toBe(true);
    expect(result.byId["is_lead"]?.probability).toBeCloseTo(0.74);
    expect(result.byId["strength"]?.score).toBeCloseTo(1.2);
    expect(result.byId["strength"]?.probabilities?.["2"]).toBeCloseTo(0.3);
    expect(result.inputTokens).toBe(0); // 本地推理：无 token 计费
    expect(result.latencyMs).toBe(123);
    expect(result.model).toContain("local_atomic_seed17");
  });

  it("概率和不严格为 1 时重新归一化并标记", () => {
    const body = nanojevBody({
      states: [
        {
          id: "s0",
          answers: {
            intent: { type: "choice", choice: "inquiry", probabilities: { inquiry: 0.9, complaint: 0.09 } },
            is_lead: { type: "boolean", p_true: 0.5 },
            strength: { type: "score", score: 1, probabilities: { "0": 0.2, "1": 0.7, "2": 0.09 } },
          },
        },
      ],
    });
    const result = parseNanoJevAnswers(body, QUESTIONS, "nanojev-local", 1);
    expect(result.byId["intent"]?.probabilitiesRenormalized).toBe(true);
    const sum = Object.values(result.byId["intent"]?.probabilities ?? {}).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it.each([
    ["缺少 states", {}],
    ["states 为空", { states: [] }],
    ["缺少 answers", { states: [{ id: "s0" }] }],
    [
      "choice 不在候选集内",
      {
        states: [
          {
            id: "s0",
            answers: {
              intent: { type: "choice", choice: "invented", probabilities: { inquiry: 1, complaint: 0 } },
              is_lead: { type: "boolean", p_true: 0.5 },
              strength: { type: "score", score: 1, probabilities: { "0": 0.2, "1": 0.8, "2": 0 } },
            },
          },
        ],
      },
    ],
    [
      "score 越界",
      {
        states: [
          {
            id: "s0",
            answers: {
              intent: { type: "choice", choice: "inquiry", probabilities: { inquiry: 1, complaint: 0 } },
              is_lead: { type: "boolean", p_true: 0.5 },
              strength: { type: "score", score: 9, probabilities: { "0": 0.2, "1": 0.8, "2": 0 } },
            },
          },
        ],
      },
    ],
  ])("非法响应被拒：%s", (_label, body) => {
    expect(() => parseNanoJevAnswers(body, QUESTIONS, "nanojev-local", 1)).toThrow(JevError);
  });
});

describe("NanoJevClient", () => {
  it("成功调用：POST /api/evaluate 且请求体为 NanoJev schema", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      seenUrl = String(input);
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(nanojevBody()), { status: 200 });
    }) as typeof fetch;
    const client = new NanoJevClient({ baseUrl: "http://127.0.0.1:8765", fetchImpl });
    const result = await client.evaluate(REQUEST);
    expect(seenUrl).toBe("http://127.0.0.1:8765/api/evaluate");
    expect(Object.keys(seenBody as object)).toEqual(["states"]);
    expect(result.byId["intent"]?.choice).toBe("inquiry");
    expect(client.modelId).toBe("nanojev-local");
  });

  it("默认指向本机 8765 端口", () => {
    const client = new NanoJevClient();
    expect(NANOJEV_DEFAULT_URL).toBe("http://127.0.0.1:8765");
    expect(client.host).toBe("127.0.0.1:8765");
  });

  it("400 立即失败（不重试）", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "输入必须为且仅为 {\"states\": [...]}" }), { status: 400 });
    }) as typeof fetch;
    const client = new NanoJevClient({ fetchImpl, maxAttempts: 3, sleepImpl: async () => undefined });
    await expect(client.evaluate(REQUEST)).rejects.toMatchObject({ code: "bad_request", retryable: false });
    expect(calls).toBe(1);
  });

  it("500 可重试一次后失败", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("boom", { status: 500 });
    }) as typeof fetch;
    const client = new NanoJevClient({ fetchImpl, maxAttempts: 2, sleepImpl: async () => undefined });
    await expect(client.evaluate(REQUEST)).rejects.toMatchObject({ code: "server", retryable: true });
    expect(calls).toBe(2);
  });

  it("超时归类为 timeout", async () => {
    const hangingFetch = ((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as typeof fetch;
    const client = new NanoJevClient({ fetchImpl: hangingFetch, timeoutMs: 20, maxAttempts: 1 });
    await expect(client.evaluate(REQUEST)).rejects.toMatchObject({ code: "timeout", retryable: true });
  });

  it("连接失败归类为 network", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const client = new NanoJevClient({ fetchImpl, maxAttempts: 1 });
    await expect(client.evaluate(REQUEST)).rejects.toMatchObject({ code: "network" });
  });
});
