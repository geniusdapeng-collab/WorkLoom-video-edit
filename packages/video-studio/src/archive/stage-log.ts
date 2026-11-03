/**
 * archive/stage-log.ts —— 一次性环节记账（渲染提交/渲染轮询/后期/交付段用；T-2026-0926-0002）
 *
 * 与 `StageRunner` 的分工：
 *   - `StageRunner`：**包住一段执行**（预生产），5 写盘点 + 异常固化 + 原样上抛；
 *   - 本模块：**事后记一次结果**（轮询回填、提交动作），调用点已经有结果/错误，只需落盘 + 入台账。
 *
 * 口径：
 *   - 每次"状态迁移"= 新 attempt（append-only，历史不丢）；重复轮询同一 job 不重复记账；
 *   - `status='skipped'`（例如幂等命中旧 job）**只写档案事件，不新开 attempt**——避免把"没做事"
 *     记成一次执行，污染监控的失败率/成本统计（规格书 §6.3 改动 A 的口径澄清）；
 *   - 台账不可用时只 `console.error`，主流程语义零变化（旁路不阻断）。
 */
import type { ArchiveStore } from "./store.js";
import { newStageRunId, type StageLedgerWriter, type StageStatus } from "./stage-runner.js";

export interface StageLogInput {
  stageId: string;
  status: Extract<StageStatus, "done" | "failed" | "skipped">;
  /** 入参快照（可空；有值时写 attempt-<n>.input.json 并进 input_ref） */
  input?: Record<string, unknown> | null;
  /** 产物/指针（可空；有值时先落盘再翻状态） */
  output?: Record<string, unknown> | null;
  errorClass?: string | null;
  errorMsg?: string | null;
  cost?: Record<string, unknown>;
  runId?: string | null;
  /** skipped 时的原因（进事件流，便于审计"为什么没做事"） */
  skipReason?: string | null;
}

export interface StageLogResult {
  /** null = 本次没有开新 attempt（skipped 或台账不可用） */
  attempt: number | null;
  outputRef: string | null;
  outputSha256: string | null;
  error: string | null;
}

/**
 * 记一次环节结果。返回 `error` 表示档案侧没记全（调用方可忽略——旁路不阻断）。
 */
export async function logStageOutcome(
  store: ArchiveStore,
  ledger: StageLedgerWriter,
  input: StageLogInput,
): Promise<StageLogResult> {
  const startedAt = Date.now();
  const dir = `stages/${input.stageId}`;
  const result: StageLogResult = { attempt: null, outputRef: null, outputSha256: null, error: null };

  if (input.status === "skipped") {
    // 不新开 attempt：只留事件（口径见文件头）
    try {
      await store.appendJsonl("events.jsonl", {
        kind: "stage.skipped",
        stageId: input.stageId,
        reason: input.skipReason ?? null,
        ...(input.output ?? {}),
      });
    } catch (err) {
      result.error = (err as Error).message;
      console.error(`[archive] skipped 事件写入失败(${input.stageId}): ${result.error}`);
    }
    return result;
  }

  const recordError = (operation: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    result.error ??= message;
    console.error(`[archive] ${operation}(${input.stageId}): ${message}`);
  };

  let claim: Awaited<ReturnType<StageLedgerWriter["claimRun"]>>;
  try {
    claim = await ledger.claimRun({
      id: newStageRunId(),
      projectId: store.projectId,
      stageId: input.stageId,
      inputRefTemplate: `${dir}/attempt-{attempt}.input.json`,
      runId: input.runId ?? null,
    });
    if (!Number.isSafeInteger(claim.attempt) || claim.attempt < 1 || claim.inputRef !== `${dir}/attempt-${claim.attempt}.input.json`) {
      throw new Error("STAGE_CLAIM_INVALID: 未返回本次环节的有效认领回执");
    }
  } catch (err) {
    recordError("台账认领失败", err);
    return result;
  }

  const { attempt, inputRef } = claim;
  result.attempt = attempt;
  if (input.input) {
    try {
      await store.writeJsonAtomic(inputRef, {
        stageId: input.stageId,
        attempt,
        input: input.input,
        startedAt: new Date().toISOString(),
      });
    } catch (err) {
      recordError("输入快照写入失败", err);
    }
  }

  if (input.output) {
    const ref = `${dir}/attempt-${attempt}.output.json`;
    try {
      const written = await store.writeJsonAtomic(ref, input.output);
      result.outputRef = ref;
      result.outputSha256 = written.sha256;
    } catch (err) {
      recordError("产物写入失败", err);
    }
  }

  // The supplier action can already have happened. Preserve any saved output
  // and require reconciliation when its archive receipt cannot be confirmed.
  let status: StageStatus = result.error !== null ? "interrupted" : input.status;
  let errorClass = result.error !== null ? "RECEIPT_UNVERIFIED" : input.errorClass ?? null;
  try {
    await ledger.finishRun({
      projectId: store.projectId,
      stageId: input.stageId,
      attempt,
      status,
      outputRef: result.outputRef,
      outputSha256: result.outputSha256,
      errorClass,
      errorMsg: (result.error ?? input.errorMsg)?.slice(0, 500) ?? null,
      durationMs: Date.now() - startedAt,
      cost: input.cost,
    });
  } catch (err) {
    recordError("台账终结写失败", err);
    status = "interrupted";
    errorClass = "RECEIPT_UNVERIFIED";
  }
  try {
    await store.appendJsonl("events.jsonl", {
      kind: `stage.${status}`, stageId: input.stageId, attempt,
      ...(errorClass ? { errorClass } : {}),
    });
  } catch (err) {
    recordError("事件写入失败", err);
  }
  try {
    await store.updateLedger(input.stageId, {
      attempt,
      status,
      finishedAt: new Date().toISOString(),
    });
  } catch (err) {
    recordError("manifest 账本更新失败", err);
  }

  return result;
}
