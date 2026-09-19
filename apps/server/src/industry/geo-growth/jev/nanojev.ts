/**
 * NanoJev 本地决策模型适配器（实验通道；与 Jev 网关同构的 provider）
 *
 * NanoJev 是什么（2026-09-19 调研，MIT / 开源）：
 *   - Qwen3-0.6B + 决策头（choice / boolean / score），一次前向输出完整概率分布；
 *   - 官方服务 `scripts/serve_decisions.py` 暴露 `POST /api/evaluate`（127.0.0.1:8765 默认）；
 *   - 权重是**游戏/导航与合成事件**任务上训练的复刻模型，不是通用 Jev；
 *     用于中文业务判断前必须先在自有数据上微调并跑考卷（见 README §NanoJev）。
 *
 * 与网关契约的差异（本文件负责抹平）：
 *   - 请求：网关是 `{state, questions}`；NanoJev 是 `{states: [{id, state, questions}]}`（严格校验，只允许这些字段）；
 *   - 题型：NanoJev 只认 `boolean`（不认 `noul`），choice 2–255 项，score 2–10 档；
 *   - 响应：`{states: [{id, answers}]}`；boolean 用 `p_true`，choice 用 `choice` + `probabilities`，
 *     score 用 `score` + `probabilities`（键为 "0".."n-1"），**不含 confidence**（由最大概率派生并标记）；
 *   - 无 token 计费概念：本地推理，inputTokens 记为 0（`metrics.ts` 因此算出成本 $0）。
 *
 * 运行前提：NanoJev 推理代码要求 CUDA（`predict_toy_decisions.py` 显式检查 `torch.cuda`），
 * 本机 Apple Silicon 无法直接运行；可在 CNB GPU 开发环境或任何 CUDA 机器上启动后，
 * 通过 `--provider nanojev --nanojev-url http://<host>:8765` 指向它。
 */
import { JevError } from "./client.js";
import { normalizeProbabilities } from "./protocol.js";
import type { AnswerView, JevCallResult, JevQuestionSet, JevRequest, QuestionType } from "./types.js";

export const NANOJEV_DEFAULT_URL = "http://127.0.0.1:8765";
export const NANOJEV_SCHEMA = "openjev-toy-inference-v1";

export interface NanoJevClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  nowImpl?: () => number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** 把我们的单状态请求包成 NanoJev 的 `{states:[...]}`（严格 schema，不能带多余字段） */
export function toNanoJevRequest(request: JevRequest, stateId = "s0"): { states: unknown[] } {
  return { states: [{ id: stateId, state: request.state, questions: request.questions }] };
}

/** 解析 NanoJev 响应为统一的 AnswerView（复用网关侧的概率归一化与校验口径） */
export function parseNanoJevAnswers(
  body: unknown,
  questions: JevQuestionSet,
  model: string,
  latencyMs: number,
): JevCallResult {
  if (typeof body !== "object" || body === null) {
    throw new JevError("invalid_response", "NanoJev 响应不是对象");
  }
  const record = body as Record<string, unknown>;
  const states = record["states"];
  if (!Array.isArray(states) || states.length === 0) {
    throw new JevError("invalid_response", "NanoJev 响应缺少 states[0]");
  }
  const first = states[0] as Record<string, unknown>;
  const answers = first["answers"];
  if (typeof answers !== "object" || answers === null) {
    throw new JevError("invalid_response", "NanoJev 响应缺少 states[0].answers");
  }
  const answerMap = answers as Record<string, Record<string, unknown>>;
  const byId: Record<string, AnswerView> = {};

  for (const [id, question] of Object.entries(questions)) {
    const raw = answerMap[id];
    if (typeof raw !== "object" || raw === null) {
      throw new JevError("invalid_response", `NanoJev 缺少回答：${id}`);
    }
    const type = (raw["type"] ?? question.type) as QuestionType;
    if (type !== question.type) {
      throw new JevError("invalid_response", `NanoJev 回答类型不符：${id} 期望 ${question.type} 实际 ${String(type)}`);
    }

    if (question.type === "boolean") {
      const pTrue = raw["p_true"];
      if (!isFiniteNumber(pTrue) || pTrue < 0 || pTrue > 1) {
        throw new JevError("invalid_response", `NanoJev boolean 概率非法：${id}=${String(pTrue)}`);
      }
      byId[id] = {
        id,
        type,
        probability: pTrue,
        confidence: clamp01(Math.max(pTrue, 1 - pTrue)),
        confidenceDerived: true, // NanoJev 不返回 confidence，统一按派生处理（分流更保守）
        probabilitiesRenormalized: false,
      };
      continue;
    }

    if (question.type === "choice") {
      const allowed = Object.keys(question.criteria);
      let probabilities: Record<string, number>;
      let renormalized: boolean;
      try {
        ({ probabilities, renormalized } = normalizeProbabilities(raw["probabilities"], allowed));
      } catch (error) {
        throw new JevError("invalid_response", `NanoJev choice 概率非法：${id}（${error instanceof Error ? error.message : String(error)}）`);
      }
      const choice = raw["choice"];
      if (typeof choice !== "string" || !allowed.includes(choice)) {
        throw new JevError("invalid_response", `NanoJev choice 非法：${id}=${String(choice)}`);
      }
      const top = Math.max(...allowed.map((key) => probabilities[key] ?? 0));
      byId[id] = {
        id,
        type,
        choice,
        probabilities,
        confidence: clamp01(top),
        confidenceDerived: true,
        probabilitiesRenormalized: renormalized,
      };
      continue;
    }

    const levels = question.criteria.length;
    const allowed = Array.from({ length: levels }, (_, index) => String(index));
    const score = raw["score"];
    if (!isFiniteNumber(score) || score < 0 || score > levels - 1) {
      throw new JevError("invalid_response", `NanoJev score 越界：${id}=${String(score)}（0..${levels - 1}）`);
    }
    let probabilities: Record<string, number>;
    let renormalized: boolean;
    try {
      ({ probabilities, renormalized } = normalizeProbabilities(raw["probabilities"], allowed));
    } catch (error) {
      throw new JevError("invalid_response", `NanoJev score 概率非法：${id}（${error instanceof Error ? error.message : String(error)}）`);
    }
    const top = Math.max(...allowed.map((key) => probabilities[key] ?? 0));
    byId[id] = {
      id,
      type,
      score,
      probabilities,
      confidence: clamp01(top),
      confidenceDerived: true,
      probabilitiesRenormalized: renormalized,
    };
  }

  const checkpoint = record["checkpoint"];
  const checkpointName =
    typeof checkpoint === "object" && checkpoint !== null && typeof (checkpoint as Record<string, unknown>)["directory"] === "string"
      ? String((checkpoint as Record<string, unknown>)["directory"]).split("/").slice(-1)[0]
      : "unknown";
  return {
    byId,
    inputTokens: 0, // 本地推理无 token 计费；成本由 metrics 记为 0
    outputTokens: 0,
    latencyMs,
    model: `${model} (${checkpointName})`,
    raw: body,
  };
}

export class NanoJevClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly nowImpl: () => number;

  constructor(options: NanoJevClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? NANOJEV_DEFAULT_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 60_000; // 本地 0.6B 推理可能数秒起步，默认给足
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.nowImpl = options.nowImpl ?? (() => Date.now());
  }

  get modelId(): string {
    return "nanojev-local";
  }

  get host(): string {
    try {
      return new URL(this.baseUrl).host;
    } catch {
      return this.baseUrl;
    }
  }

  /** 与 JevClient.evaluate 同形：可直接替换进 runShadow */
  async evaluate(request: JevRequest, signal?: AbortSignal): Promise<JevCallResult> {
    const url = `${this.baseUrl}/api/evaluate`;
    const body = JSON.stringify(toNanoJevRequest(request));
    let lastError: JevError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const started = this.nowImpl();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const onOuterAbort = () => controller.abort();
      signal?.addEventListener("abort", onOuterAbort, { once: true });
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
          if (response.status === 400) {
            throw new JevError("bad_request", `NanoJev 拒绝请求（HTTP 400）：${text.slice(0, 200)}`);
          }
          throw new JevError("server", `NanoJev 返回 HTTP ${response.status}`, {
            status: response.status,
            retryable: response.status >= 500,
          });
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new JevError("invalid_response", "NanoJev 返回非 JSON 响应");
        }
        return parseNanoJevAnswers(parsed, request.questions, this.modelId, this.nowImpl() - started);
      } catch (error) {
        const normalized =
          error instanceof JevError
            ? error
            : error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
              ? new JevError("timeout", `NanoJev 超时（>${this.timeoutMs}ms）`, { retryable: true })
              : new JevError("network", `NanoJev 连接失败：${error instanceof Error ? error.message : String(error)}`, {
                  retryable: true,
                });
        if (normalized.code === "invalid_response" || normalized.code === "bad_request") throw normalized;
        if (normalized.retryable && attempt < this.maxAttempts) {
          lastError = normalized;
          await this.sleepImpl(500 * attempt);
          continue;
        }
        throw normalized;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onOuterAbort);
      }
    }
    throw lastError ?? new JevError("network", "NanoJev 不可用且无可返回结果");
  }
}
