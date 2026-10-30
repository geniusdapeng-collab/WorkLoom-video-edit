import { describe, expect, it, vi } from "vitest";
import { reviewMarketingSupportWithRetry } from "./marketing-review-retry.js";

function options() {
  return {
    stage: "script" as const,
    projectId: "P1",
    artifacts: [{ path: "/tmp/evidence.json", kind: "json" as const }],
    deterministic: [{ id: "claims-source-bound", pass: true, hard: true, detail: "ok" }],
    requiredCheckIds: ["claims-source-bound"],
    rubric: ["完整来源"],
  };
}

describe("marketing support review retry", () => {
  it("retries one malformed reviewer response without weakening the next contract", async () => {
    const review = vi.fn()
      .mockResolvedValueOnce({ stage: "script", status: "unverified", approved: false, score: 0,
        hardFailures: [], issues: ["评审结果结构非法"], suggestions: [], rerun: true,
        via: "fallback", model: "deepseek-flash", ms: 1, reason: "评审结果结构非法", degraded: true })
      .mockResolvedValueOnce({ stage: "script", status: "passed", approved: true, score: 91,
        hardFailures: [], issues: [], suggestions: [], rerun: false,
        via: "llm", model: "deepseek-flash", ms: 1, reason: "通过", degraded: false });
    const result = await reviewMarketingSupportWithRetry(review as never, options());
    expect(result.attempts).toBe(2);
    expect(result.verdict.approved).toBe(true);
    expect(review).toHaveBeenCalledTimes(2);
    expect(review.mock.calls[1]![0].rubric.join(" ")).toContain("上一轮评审响应");
  });

  it("does not retry a real content rejection", async () => {
    const verdict = { stage: "script", status: "failed", approved: false, score: 42,
      hardFailures: [], issues: ["来源不支持"], suggestions: [], rerun: true,
      via: "llm", model: "deepseek-flash", ms: 1, reason: "来源不支持", degraded: false };
    const review = vi.fn().mockResolvedValue(verdict);
    expect(await reviewMarketingSupportWithRetry(review as never, options()))
      .toEqual({ verdict, attempts: 1 });
    expect(review).toHaveBeenCalledTimes(1);
  });
});
