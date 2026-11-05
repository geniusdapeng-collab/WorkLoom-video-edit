import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "../../../lib/trpc";

type RepairPlan = Awaited<ReturnType<typeof trpc.video.studio.promptRepairPlan.query>>;
type RepairRequest = Parameters<typeof trpc.video.studio.repairPrompts.mutate>[0];
type RunStatus = NonNullable<Awaited<ReturnType<typeof trpc.video.studio.status.query>>>;

const TERMINAL = new Set(["finished", "done", "completed", "failed", "interrupted", "cancelled", "aborted"]);
const buttonClass = "min-h-11 rounded-md border border-line px-3 py-2 text-caption text-ink2 transition-colors hover:border-gline hover:text-gold active:bg-gold/10 disabled:cursor-not-allowed disabled:opacity-40";

/** The parent keys this card by authoritative identity and project, clearing every old readback on scope changes. */
export function PromptRepairCard({ projectId, canRepair, onCompleted }: {
  projectId: string;
  canRepair: boolean;
  onCompleted: () => void | Promise<void>;
}) {
  const [plan, setPlan] = useState<RepairPlan | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [request, setRequest] = useState<RepairRequest | null>(null);
  const [requestUnknown, setRequestUnknown] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<RunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [readRevision, setReadRevision] = useState(0);
  const [now, setNow] = useState(Date.now);
  const alive = useRef(true);
  const checkRevision = useRef(0);
  const completedRun = useRef<string | null>(null);
  const completion = useRef(onCompleted);
  completion.current = onCompleted;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (plan?.kind !== "ready" || runId) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [plan, runId]);

  const check = useCallback(async () => {
    if (checking || starting || runId || requestUnknown) return;
    const revision = ++checkRevision.current;
    setChecking(true);
    setError(null);
    setMessage(null);
    setPlan(null);
    try {
      const result = await trpc.video.studio.promptRepairPlan.query({ projectId });
      if (alive.current && revision === checkRevision.current) {
        setPlan(result);
        setNow(Date.now());
      }
    } catch (cause) {
      if (alive.current && revision === checkRevision.current) {
        setError(`材料检查未完成：${cause instanceof Error ? cause.message : String(cause)}`);
      }
    } finally {
      if (alive.current && revision === checkRevision.current) setChecking(false);
    }
  }, [checking, starting, runId, requestUnknown, projectId]);

  const expiresAt = plan?.kind === "ready" ? Date.parse(plan.sourceExpiresAt) : Number.NaN;
  const expired = plan?.kind === "ready" && (!Number.isFinite(expiresAt) || expiresAt <= now);
  const start = useCallback(async () => {
    if (starting || checking || !canRepair || runId) return;
    const currentTime = Date.now();
    setNow(currentTime);
    const currentPlan = plan?.kind === "ready" && Number.isFinite(Date.parse(plan.sourceExpiresAt))
      && Date.parse(plan.sourceExpiresAt) > currentTime;
    const input = requestUnknown && request ? request : currentPlan && plan?.kind === "ready" ? {
      projectId,
      expectedLatestAttempt: plan.expectedLatestAttempt,
      planDigest: plan.planDigest,
    } : null;
    if (!input) return;
    setStarting(true);
    setRequest(input);
    setError(null);
    setMessage(null);
    try {
      const result = await trpc.video.studio.repairPrompts.mutate(input);
      if (!alive.current) return;
      setRequestUnknown(false);
      if (result.kind === "started") {
        setRunId(result.runId);
        setMessage("已接入这一次修复。沿用已审材料，接下来只修问题字段并重新审核。");
      } else {
        setPlan(null);
        setRequest(null);
        setMessage(result.message);
      }
    } catch (cause) {
      if (!alive.current) return;
      // Preserve the exact request: the server binds its digest to one durable repair operation.
      setRequestUnknown(true);
      setError(`尚未核实修复请求的回执：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      if (alive.current) setStarting(false);
    }
  }, [starting, checking, canRepair, runId, requestUnknown, request, plan, projectId]);

  useEffect(() => {
    if (!runId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const current = await trpc.video.studio.status.query({ runId });
        if (!active) return;
        if (!current || current.runId !== runId || current.projectId !== projectId) {
          setError("暂未读到属于当前项目的修复记录。请核对同一请求回执，不要另起一轮。");
          return;
        }
        setRun(current);
        setError(null);
        if (current.status === "finished" || current.status === "done" || current.status === "completed") {
          if (completedRun.current !== runId) {
            try {
              await completion.current();
              completedRun.current = runId;
            } catch (cause) {
              if (active) setError(`修复已经完成，但镜头列表未刷新：${cause instanceof Error ? cause.message : String(cause)}`);
            }
          }
          return;
        }
        if (TERMINAL.has(current.status)) return;
        timer = setTimeout(() => void read(), 2_000);
      } catch (cause) {
        if (active) setError(`修复进度读取失败：${cause instanceof Error ? cause.message : String(cause)}`);
      }
    };
    void read();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [runId, projectId, readRevision]);

  const finished = run?.status === "finished" || run?.status === "done" || run?.status === "completed";
  const failed = !!run && TERMINAL.has(run.status) && !finished;
  const runError = run && "error" in run && typeof run.error === "string" ? run.error : null;

  return (
    <section aria-label="从失败处接着修" className="mb-4 min-w-0 space-y-3 rounded-lg border border-gline bg-card p-4">
      <div>
        <h2 className="text-body font-semibold text-ink">从失败处接着修</h2>
        <p className="mt-1 text-caption leading-relaxed text-ink3">保留已经审过的需求、策划和人物图片，只修复有明确问题的提示词，再重新审核。</p>
      </div>
      {!runId && !requestUnknown && <button type="button" className={buttonClass} disabled={checking || starting} onClick={() => void check()}>
        {checking ? "正在核对原始材料…" : plan ? "重新检查材料" : "检查能否接着修"}
      </button>}
      {checking && <p role="status" className="text-caption text-ink3">这一步只读取材料，不调用模型。</p>}
      {plan?.kind === "unavailable" && <p role="status" className="break-words text-caption text-ink3">{plan.message}</p>}
      {plan?.kind === "ready" && !runId && <div className="space-y-2 text-caption text-ink2">
        <p>保留此前已通过的需求与策划，接着修第 {plan.expectedLatestAttempt} 轮草稿；保留 {plan.retainedShotCount} 个镜头的现有内容。</p>
        <p className="break-words text-ink3">原始资料有效至 {Number.isFinite(expiresAt) ? new Date(plan.sourceExpiresAt).toLocaleString("zh-CN", { hour12: false }) : "无法核实"}；执行时服务还会重新核验。</p>
        <ul className="list-disc space-y-1 pl-5">
          {plan.authoringFields.map((field, index) => <li key={`${field.shotId}:${field.field}:${index}`} className="break-words">
            <span className="font-medium">{field.shotId}</span> · {field.reason}
          </li>)}
        </ul>
        {plan.warnings.map((warning, index) => <p key={index} className="break-words text-warn">{warning}</p>)}
        {expired && <p role="alert" className="text-alert">原始资料已到期，请重新核实资料。系统不会自动从头重跑。</p>}
        {!requestUnknown && <>
          <p className="text-ink3">修复会调用已配置的 AI，并遵守当前运行预算。视频生成需要后续单独确认。</p>
          <button type="button" className={`${buttonClass} border-gold/50 text-gold`} disabled={!canRepair || checking || starting || expired} onClick={() => void start()}>
            {starting ? "正在登记修复请求…" : "修复提示词并重新审核"}
          </button>
          {!canRepair && <p className="text-ink3">当前身份可以查看材料，没有发起修复的权限。</p>}
        </>}
      </div>}
      {requestUnknown && !runId && <div className="space-y-2">
        <p className="text-caption text-ink3">系统没有自动再次执行。接回时使用刚才同一份请求，不会新建第二轮。</p>
        <button type="button" className={buttonClass} disabled={starting || !canRepair} onClick={() => void start()}>
          {starting ? "正在接回原请求…" : "接回同一修复请求"}
        </button>
      </div>}
      {message && <p role="status" className="break-words text-caption text-ink2">{message}</p>}
      {runId && <div className="space-y-2 text-caption">
        <p role="status" className={failed ? "text-alert" : finished ? "text-go" : "text-ink2"}>
          {finished ? "提示词修复及前期审核已完成。可以查看当前服务镜头，视频尚未生成。" : failed ? "本次修复已停止，原始材料和失败记录保留。" : "正在修复并重新审核，请等待本次结果。"}
        </p>
        {runError && <p role="alert" className="break-words text-alert">{runError}</p>}
        <button type="button" className={buttonClass} onClick={() => setReadRevision(value => value + 1)}>刷新这次修复进度</button>
      </div>}
      {error && <p role="alert" className="break-words text-caption text-alert">{error}</p>}
    </section>
  );
}
