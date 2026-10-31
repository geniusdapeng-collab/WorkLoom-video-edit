import type { ProducerGateOptions, ProducerVerdict } from "@hyperreality/video-studio";

export type MarketingReviewer = (options: ProducerGateOptions) => Promise<ProducerVerdict>;

function retryable(verdict: ProducerVerdict): boolean {
  if (verdict.approved || verdict.status !== "unverified" || verdict.degraded !== true) return false;
  const text = [verdict.reason, ...verdict.hardFailures, ...verdict.issues].join(" ");
  return /评审结果结构非法|JSON|json|超时|timeout|timed out|HTTP\s*5\d\d|fetch failed|ECONN|EAI_AGAIN|socket/i.test(text);
}

/**
 * Malformed/transient reviewer output gets exactly one deterministic retry.
 * A substantive rejection is never retried or weakened.
 */
export async function reviewMarketingSupportWithRetry(
  review: MarketingReviewer,
  options: ProducerGateOptions,
  maxAttempts = 2,
): Promise<{ verdict: ProducerVerdict; attempts: number }> {
  const budget = Number.isSafeInteger(maxAttempts) && maxAttempts > 0 ? Math.min(maxAttempts, 2) : 1;
  let verdict: ProducerVerdict | undefined;
  for (let attempt = 1; attempt <= budget; attempt += 1) {
    const rubric = attempt === 1
      ? options.rubric
      : [
          ...(options.rubric ?? []),
          "上一轮评审响应没有满足固定结构。本次必须只输出合法 JSON 对象，字段严格为 approved、score、issues、suggestions、reason；不得借助上一轮回答或放宽任何证据标准。",
        ];
    verdict = await review({ ...options, rubric });
    if (!retryable(verdict)) return { verdict, attempts: attempt };
  }
  return { verdict: verdict!, attempts: budget };
}
