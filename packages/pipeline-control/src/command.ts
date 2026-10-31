import { sha256Json } from "./canonical.js";
import type { PipelineCommand } from "./types.js";

export function commandRequestHash(command: PipelineCommand): string {
  if (!command.commandId.trim() || !command.idempotencyKey.trim()) throw new Error("commandId 与 idempotencyKey 必填");
  if (!Number.isSafeInteger(command.expectedRunRevision) || command.expectedRunRevision < 1) {
    throw new Error("expectedRunRevision 必须是正整数");
  }
  if (command.expectedStageRevision !== undefined
    && (!Number.isSafeInteger(command.expectedStageRevision) || command.expectedStageRevision < 1)) {
    throw new Error("expectedStageRevision 必须是正整数");
  }
  return sha256Json({
    actor: command.actor,
    expectedRunRevision: command.expectedRunRevision,
    expectedStageRevision: command.expectedStageRevision ?? null,
    payload: command.payload,
  });
}

export function assertCommandReplay(
  stored: { idempotencyKey: string; requestHash: string },
  incoming: PipelineCommand,
): void {
  const hash = commandRequestHash(incoming);
  if (stored.idempotencyKey !== incoming.idempotencyKey || stored.requestHash !== hash) {
    throw new Error("IDEMPOTENCY_CONFLICT: 相同命令键已绑定不同请求");
  }
}
