/**
 * QuestlineStages · 首日上岗五关的分关视图（从引导壳中拆出，便于逐关审查）
 *
 * 约束：只负责渲染与回调，不做 tRPC 调用、不写进度、不改事实——
 * 所有副作用都留在 QuestlineOverlay 与 useQuestline 里。
 */
import { Icon } from "@workloom/ui";
import type { QuestLevel, QuestStageId } from "../../onboarding/questline";
import type { TaskCardDef } from "../../onboarding/questline.config";
import { useQuestlineContent } from "../../onboarding/QuestlineContent";

/** 待拍板事项视图（来自 P0 的真实审批队列，不是编造的示例） */
export interface PendingApprovalView {
  approvalId: string;
  title: string;
  rationale?: string;
  actionLabel?: string;
}

/** 任务线程视图（真实事实：status/progress 来自服务端） */
export interface ThreadView {
  id: string;
  title: string;
  status: string;
  progress_done: number;
  progress_total: number;
}

/** 驳回原因兜底：内容包未声明时用酒店枚举（bundles/hotel/feedback-enums.yml） */
export const REJECT_REASONS: Array<{ code: string; label: string }> = [
  { code: "price.too_high", label: "涨幅过大" },
  { code: "data.stale", label: "依据不足" },
  { code: "other", label: "其他（我补一句）" },
];

export function StageActions({
  stage,
  busy,
  thread,
  litCore,
  goalReady,
  hasPendingApproval,
  onPrimary,
  onSkip,
  onOpenThread,
  primaryLabel,
  disabled,
}: {
  stage: QuestStageId;
  busy: boolean;
  thread: ThreadView | null;
  litCore: number;
  goalReady: boolean;
  hasPendingApproval: boolean;
  onPrimary?: (() => void) | undefined;
  onSkip: () => void;
  onOpenThread: (id: string) => void;
  primaryLabel?: string | undefined;
  disabled: boolean;
}) {
  const skipButton = (
    <button
      type="button"
      onClick={onSkip}
      className="min-h-9 rounded-lg border border-line px-3 text-body text-ink3 hover:border-gline hover:text-ink"
    >
      {stage === "approve" && !hasPendingApproval ? "暂无可拍板，跳过" : "这关先跳过"}
    </button>
  );

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {stage === "approve" && <span className="break-words text-body text-ink3">批准 / 修改 / 驳回请在卡片上操作</span>}
      {stage === "dispatch" && thread && (
        <>
          <span className="break-words text-body text-go">
            已派单 · {thread.title.slice(0, 16)} · {thread.progress_done}/{thread.progress_total}
          </span>
          <button
            type="button"
            onClick={() => onOpenThread(thread.id)}
            className="min-h-9 rounded-lg border border-holo/50 px-3 text-body text-holo hover:bg-holo/10"
          >
            看它跑
          </button>
        </>
      )}
      {stage === "meet" && (
        <span className="break-words text-body text-ink3">
          {litCore >= 3 ? "三位当家人都认识了" : "点「认识他」点亮卡片，或直接跳过"}
        </span>
      )}
      <span className="flex-1" />
      {skipButton}
      {onPrimary && (
        <button
          type="button"
          disabled={busy || disabled}
          onClick={onPrimary}
          className="min-h-9 rounded-lg border border-gline bg-gold/15 px-4 text-body font-bold text-gold hover:bg-gold/25 disabled:opacity-40"
        >
          {busy ? "处理中…" : primaryLabel ?? "继续"}
        </button>
      )}
      {stage === "goal" && !goalReady && (
        <span className="break-words text-body text-ink3">先选一个目标</span>
      )}
    </div>
  );
}

export function GoalStage({
  goalId,
  onPick,
  free,
  onFree,
}: {
  goalId: string | null;
  onPick: (id: string) => void;
  free: string;
  onFree: (value: string) => void;
}) {
  const content = useQuestlineContent();
  const picked = goalId ? content.goals.find((item) => item.id === goalId) : undefined;
  return (
    <div className="min-w-0 space-y-3">
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
        {content.goals.map((goal) => {
          const active = goal.id === goalId;
          return (
            <button
              key={goal.id}
              type="button"
              onClick={() => onPick(goal.id)}
              data-goal-card={goal.id}
              className={`min-w-0 rounded-xl border px-3 py-3 text-left ${active ? "border-gold/70 bg-gold/10" : "border-line bg-bg900/60 hover:border-gline"}`}
            >
              <div className="break-words text-body font-bold text-ink">{goal.title}</div>
              <div className="mt-1 break-words text-body text-ink3">{goal.metric}</div>
              <div className="mt-2 break-words text-body text-ink3">
                负责人 {goal.ownerTitle} · {goal.steps} 步 · 需要您拍板 {goal.approvals} 次
              </div>
            </button>
          );
        })}
      </div>
      {picked && (
        <div className="min-w-0 rounded-xl border border-gline/60 bg-gold/5 px-3 py-3" data-goal-preview="true">
          <div className="text-body font-bold text-goldhi">目标卡 · {picked.title}</div>
          <div className="mt-1 break-words text-body text-ink2">衡量口径：{picked.metric}</div>
          <div className="mt-1 break-words text-body text-ink2">负责人：{picked.ownerTitle} · 首个产出：{picked.artifact}</div>
          <div className="mt-1 break-words text-body text-ink3">
            预估 {picked.steps} 步，中途会找您拍板 {picked.approvals} 次；不涉及外发与资金的动作自动完成。
          </div>
        </div>
      )}
      <label className="block min-w-0 text-body text-ink3">
        也可以直接跟我说一句
        <input
          value={free}
          onChange={(event) => onFree(event.target.value)}
          placeholder="例：这周把差评回复时间压到 2 小时以内"
          className="mt-1 w-full min-w-0 rounded-lg border border-line bg-bg900 px-3 py-2 text-body text-ink outline-none placeholder:text-ink3 focus:border-gline"
        />
      </label>
    </div>
  );
}

export function DispatchStage({
  thread,
  dispatchedTaskId,
  canDispatch,
  onDispatch,
  busy,
}: {
  thread: ThreadView | null;
  dispatchedTaskId: string | null;
  canDispatch: boolean;
  onDispatch: (task: TaskCardDef) => void;
  busy: boolean;
}) {
  const content = useQuestlineContent();
  return (
    <div className="min-w-0 space-y-3">
      <div className="break-words rounded-lg border border-line bg-bg900/50 px-3 py-2 text-body text-ink3">
        派活走的是真实任务通道：派出去就有一条可查的任务线程，进度来自服务端，不伪造。
        {!canDispatch && (
          <span className="text-warn">
            {" "}当前角色没有派活权限。
            {/* m6：别让客户卡在这——直接给出身份切换出口 */}
            <a href="/login" className="ml-1 underline text-warn">切换到店主/店长身份 →</a>
          </span>
        )}
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
        {content.tasks.map((task) => {
          const done = dispatchedTaskId === task.id;
          return (
            <div
              key={task.id}
              data-task-card={task.id}
              className={`min-w-0 rounded-xl border px-3 py-3 ${done ? "border-go/50 bg-go/5" : "border-line bg-bg900/60"}`}
            >
              <div className="break-words text-body font-bold text-ink">{task.title}</div>
              <dl className="mt-2 space-y-0.5 text-body text-ink3">
                <div>谁做：{task.ownerTitle}</div>
                <div>几步：{task.steps} 步 · {task.eta}（预估）</div>
                <div>产出：{task.artifact}</div>
                <div>要您拍板：{task.approvals} 次 · 约 {task.credits} 积分（预估）</div>
              </dl>
              {/* M5：步数/时长/积分是行业包的演示预估，不是承诺；真实计量以任务线程为准 */}
              <div className="mt-1.5 break-words text-body text-ink3">
                预估口径来自行业包演示配置；实际耗时与积分以任务线程里的模型计量为准。
              </div>
              <button
                type="button"
                disabled={busy || done || !canDispatch}
                onClick={() => onDispatch(task)}
                className={`mt-3 w-full rounded-lg border px-3 py-1.5 text-body font-bold ${
                  done
                    ? "border-go/50 text-go"
                    : "border-gline/70 bg-gold/10 text-gold hover:bg-gold/20 disabled:opacity-40"
                }`}
              >
                {done ? "已派出 ✓" : busy ? "派出中…" : "派给他"}
              </button>
            </div>
          );
        })}
      </div>
      {thread && (
        <div className="min-w-0 rounded-xl border border-holo/40 bg-holo/5 px-3 py-2 text-body text-ink2">
          任务线程 <span className="font-mono text-holo">{thread.id}</span> · 当前状态 {thread.status} ·
          进度 {thread.progress_done}/{thread.progress_total}（下一步进入"拍板"关）
        </div>
      )}
    </div>
  );
}

export function ApproveStage({
  pending,
  canApprove,
  mode,
  onMode,
  rejectCode,
  onRejectCode,
  rejectNote,
  onRejectNote,
  editNote,
  onEditNote,
  busy,
  onDecide,
  onSkip,
}: {
  pending: PendingApprovalView | null;
  canApprove: boolean;
  mode: "normal" | "reject" | "edit";
  onMode: (mode: "normal" | "reject" | "edit") => void;
  rejectCode: string;
  onRejectCode: (code: string) => void;
  rejectNote: string;
  onRejectNote: (note: string) => void;
  editNote: string;
  onEditNote: (note: string) => void;
  busy: boolean;
  onDecide: (gesture: "approve" | "edit" | "reject") => void;
  onSkip: () => void;
}) {
  const content = useQuestlineContent();
  if (!pending) {
    return (
      <div className="min-w-0 rounded-xl border border-line bg-bg900/60 px-3 py-3">
        <div className="break-words text-body text-ink2">现在没有待您拍板的事项。</div>
        <div className="mt-1 break-words text-body text-ink3">
          这是真实状态：没有挂起事项时，我不会为了凑一关而编一条审批出来。
        </div>
        <button
          type="button"
          onClick={onSkip}
          className="mt-2 rounded-lg border border-line px-3 py-1.5 text-body text-ink2 hover:border-gline"
        >
          跳过这一关，直接看结果
        </button>
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-3" data-approval-card={pending.approvalId}>
      <div className="min-w-0 rounded-xl border border-amber-400/50 bg-amber-400/5 px-3 py-3">
        <div className="text-body tracking-widest text-amber-300">请您决策 · 1 件</div>
        <div className="mt-1 break-words text-body font-bold text-ink">{pending.title}</div>
        {pending.rationale && pending.rationale !== "负责人意见待确认" && (
          <div className="mt-1 break-words text-body text-holo">负责人意见：{pending.rationale}</div>
        )}
        <div className="mt-2 break-words text-body text-ink3">
          命中航道：{pending.actionLabel ?? "高风险动作需人工拍板"}。批准后动作立即生效并写入账本；驳回必须选原因。
        </div>
        {!canApprove && (
          <div className="mt-1 break-words text-body text-warn">
            当前角色没有审批权限。
            <a href="/login" className="ml-1 underline">切换到店主/店长身份 →</a>
          </div>
        )}
      </div>

      {mode === "reject" && (
        <div className="min-w-0 rounded-xl border border-warn/50 bg-warn/5 px-3 py-3">
          <div className="text-body text-warn">驳回原因（受控枚举，会用于校准偏好）</div>
          <div className="mt-2 flex min-w-0 flex-wrap gap-2">
            {(content.rejectReasons.length > 0 ? content.rejectReasons : REJECT_REASONS).map((reason) => (
              <button
                key={reason.code}
                type="button"
                onClick={() => onRejectCode(reason.code)}
                className={`rounded-full border px-3 py-1 text-body ${
                  rejectCode === reason.code ? "border-warn/70 bg-warn/15 text-warn" : "border-line text-ink3"
                }`}
              >
                {reason.label}
              </button>
            ))}
          </div>
          <input
            value={rejectNote}
            onChange={(event) => onRejectNote(event.target.value)}
            placeholder={rejectCode === "other" ? "补一句原因（必填）" : "补充说明（可选）"}
            className="mt-2 w-full min-w-0 rounded-lg border border-line bg-bg900 px-3 py-2 text-body text-ink outline-none focus:border-gline"
          />
        </div>
      )}

      {mode === "edit" && (
        <div className="min-w-0 rounded-xl border border-holo/50 bg-holo/5 px-3 py-3">
          <div className="text-body text-holo">修改后采纳：写一句要改什么</div>
          <input
            value={editNote}
            onChange={(event) => onEditNote(event.target.value)}
            placeholder="例：涨幅压到 5% 以内，其余照办"
            className="mt-2 w-full min-w-0 rounded-lg border border-line bg-bg900 px-3 py-2 text-body text-ink outline-none focus:border-gline"
          />
        </div>
      )}

      <div className="flex min-w-0 flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !canApprove}
          onClick={() => onDecide("approve")}
          className="min-h-9 rounded-lg border border-go/60 bg-go/10 px-4 text-body font-bold text-go hover:bg-go/20 disabled:opacity-40"
        >
          <Icon name="check" size={13} className="inline" /> 批准
        </button>
        <button
          type="button"
          disabled={busy || !canApprove}
          onClick={() => onMode(mode === "edit" ? "normal" : "edit")}
          className="min-h-9 rounded-lg border border-holo/60 bg-holo/10 px-4 text-body font-bold text-holo hover:bg-holo/20 disabled:opacity-40"
        >
          <Icon name="edit" size={13} className="inline" /> 修改后采纳
        </button>
        <button
          type="button"
          disabled={busy || !canApprove}
          onClick={() => onMode(mode === "reject" ? "normal" : "reject")}
          className="min-h-9 rounded-lg border border-warn/60 bg-warn/10 px-4 text-body font-bold text-warn hover:bg-warn/20 disabled:opacity-40"
        >
          <Icon name="error" size={13} className="inline" /> 驳回
        </button>
        {mode === "reject" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide("reject")}
            className="min-h-9 rounded-lg border border-warn/70 bg-warn/20 px-4 text-body font-bold text-warn disabled:opacity-40"
          >
            确认驳回
          </button>
        )}
        {mode === "edit" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide("edit")}
            className="min-h-9 rounded-lg border border-holo/70 bg-holo/20 px-4 text-body font-bold text-holo disabled:opacity-40"
          >
            确认修改
          </button>
        )}
      </div>
    </div>
  );
}

export function ReviewStage({
  thread,
  achievements,
  xp,
  level,
}: {
  thread: ThreadView | null;
  achievements: string[];
  xp: number;
  level: QuestLevel;
}) {
  const content = useQuestlineContent();
  const delivered = thread?.status === "completed";
  return (
    <div className="min-w-0 space-y-3">
      <div className={`min-w-0 rounded-xl border px-3 py-3 ${delivered ? "border-go/50 bg-go/5" : "border-line bg-bg900/60"}`}>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Icon name={delivered ? "check" : "play"} size={15} className={delivered ? "text-go" : "text-holo"} />
          <span className="break-words text-body font-bold text-ink">
            {delivered ? "交付完成 · 变更报告" : thread ? "任务正在跑" : "这一步等任务跑完再看"}
          </span>
          {thread && (
            <span className="font-mono text-body text-ink3">
              {thread.progress_done}/{thread.progress_total}
            </span>
          )}
        </div>
        <div className="mt-1 break-words text-body leading-relaxed text-ink2">
          {delivered
            ? "产出与凭证都在任务线程里：改了什么、依据是什么、谁批的，逐条可查。"
            : thread
              ? "没有回执的事我不会说已完成。进度来自服务端，刷新和断线都不会把它变快。"
              : "如果您是在别处派的任务，可以到任务中心查看进度；这里不会替它宣称完成。"}
        </div>
        <div className="mt-2 flex min-w-0 flex-wrap gap-2">
          {thread && (
            <a
              href={`/tasks/${thread.id}`}
              className="min-h-9 rounded-lg border border-holo/50 px-3 py-1.5 text-body text-holo no-underline hover:bg-holo/10"
            >
              打开任务线程看产出
            </a>
          )}
          <a
            href="/reports"
            className="min-h-9 rounded-lg border border-line px-3 py-1.5 text-body text-ink2 no-underline hover:border-gline"
          >
            看今天的战报
          </a>
        </div>
      </div>

      <div className="min-w-0 rounded-xl border border-gold/50 bg-gold/5 px-3 py-3">
        <div className="text-body font-bold text-goldhi">您的成绩单</div>
        <div className="mt-1 break-words text-body text-ink2">
          董事长等级 {level.level} · {level.rank} · 累计 {xp} XP
          <span className="text-ink3">（裁决×3 + 派遣×2 + 沉淀×5，与团队页同一口径）</span>
        </div>
        <div className="mt-2 grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-5">
          {content.achievements.map((achievement) => {
            const unlocked = achievements.includes(achievement.id);
            return (
              <div
                key={achievement.id}
                data-achievement={achievement.id}
                data-unlocked={unlocked ? "true" : "false"}
                className={`min-w-0 rounded-lg border px-2 py-2 text-center ${unlocked ? "border-gold/70 bg-gold/10" : "border-line bg-bg900/50 opacity-60"}`}
              >
                <Icon name={achievement.icon} size={18} className={unlocked ? "text-gold" : "text-ink3"} />
                <div className={`mt-1 break-words text-body font-bold ${unlocked ? "text-goldhi" : "text-ink3"}`}>
                  {achievement.title}
                </div>
                <div className="break-words text-body text-ink3">{achievement.hint}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function CompletionPanel({ onNext }: { onNext: (to: string, id: string) => void }) {
  const content = useQuestlineContent();
  return (
    <div className="min-w-0 text-center" data-questline-complete="true">
      <h2 className="break-words text-h1 font-black text-goldhi">首日上岗完成</h2>
      <p className="mx-auto mt-1 max-w-xl break-words text-body leading-relaxed text-ink2">
        您已经认识了团队、定了目标、派了第一单、拍了第一次板。接下来这三件事，随时可以做：
      </p>
      <div className="mt-3 grid min-w-0 grid-cols-1 gap-2 text-left sm:grid-cols-3">
        {content.nextSteps.map((step) => (
          <button
            key={step.id}
            type="button"
            onClick={() => onNext(step.to, step.id)}
            className="min-w-0 rounded-xl border border-gline/60 bg-bg900/60 px-3 py-3 text-left hover:border-gold/70 hover:bg-gold/10"
            data-next-step={step.id}
          >
            <div className="break-words text-body font-bold text-goldhi">{step.title}</div>
            <div className="mt-1 break-words text-body text-ink3">{step.desc}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
