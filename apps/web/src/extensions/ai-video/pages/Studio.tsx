/**
 * 生成工作室（T-2026-0921-0002）
 *
 * 把"看不见的出片过程"变成可见操作台：
 *   ① 选模型（目录驱动，标注档位/供应商/是否接入）→ 选参数（时长/画幅/清晰度/音轨/首帧）
 *   ② 提交前看到报价（USD/CNY）与本月已花（超上限直接拒绝，提示换档或调额）
 *   ③ 提交后进队列：状态、供应商、成本、mock/真实标识一眼可辨
 *   ④ 成片：入库后可播放/下载（签名 URL）；未入库标注"供应商 7 天保留"
 *   ⑤ 发布：生成发布任务（G9 公网发布必审）→ 执行（本机 dry-run 明确标注，不冒充真实发布）
 *
 * 状态源：video.gen.catalog / video.gen.estimate / video.render.submit / video.render.poll /
 *        video.gen.jobs / video.publish.createTask / video.publish.run
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ensureDemoLogin, trpc } from "../../../lib/trpc";
import { Bridge } from "../../../shell/Bridge";
import { useNavigationAccess } from "../../../shell/NavigationAccess";
import { BannerAlert, EmptyState, Skeleton } from "../../../components/hud";

interface ModelEntry {
  id: string;
  name: string;
  provider: string;
  kind: string;
  modes: string[];
  tier: string;
  availability: string;
  available: boolean;
  unavailableReason?: string;
  effectiveProviderModel: string;
  limits?: { durationSec?: { min: number; max: number; default?: number }; resolutions?: string[]; aspectRatios?: string[] } | null;
  pricing?: { unit: string; usd: number | null; promo?: boolean; asOf: string; note?: string } | null;
  notes?: string | null;
}

interface JobRow {
  id: string;
  project_id: string;
  script_key: string | null;
  task_id: string | null;
  status: string;
  provider: string | null;
  provider_model: string | null;
  est_cny: number | null;
  actual_cny: number | null;
  mock: boolean;
  asset_id: string | null;
  local_path: string | null;
  playUrl: string | null;
  playUrlKind: "library" | "provider" | null;
  result_url: string | null;
  created_at: string;
}

interface ScriptRow {
  id: string; project_id: string; shot_id: string; script_key: string; version: number; status: string; md: string;
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  submitted: { label: "已提交", cls: "border-holo/45 text-holo" },
  rendering: { label: "生成中", cls: "border-holo/45 text-holo" },
  done: { label: "已完成", cls: "border-go/45 text-go" },
  failed: { label: "失败", cls: "border-alert/55 text-alert" },
};

const PLATFORMS = [
  { id: "douyin", label: "抖音" },
  { id: "xiaohongshu", label: "小红书" },
  { id: "bilibili", label: "B站" },
  { id: "youtube", label: "YouTube" },
] as const;

type G8Status = Awaited<ReturnType<typeof trpc.video.production.g8Status.query>>;
type G8Readback = { key: string; status: G8Status; error?: never } | { key: string; status?: never; error: string };

const G8_LABELS = {
  pending: "待人工授权",
  approved: "已授权 · 等待提交",
  submitted: "生成任务已受理",
  outcome_unknown: "提交结果待核对",
  consumed: "授权已使用",
  expired: "授权已过期",
  stale: "镜头或生成请求已更新",
  rejected: "授权已终止",
} satisfies Record<NonNullable<G8Status["ticket"]>["status"], string>;

export default function Studio() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const projectId = params.get("project") ?? "vp-demo-001";
  const shotHint = params.get("shot");
  const modeHint = params.get("mode");
  const { identityKey, scope, status: accessStatus, canAction } = useNavigationAccess();
  /** 商品档案页「用此商品开拍」带过来的商品名（媒资库 → 生产页的上下文传递） */
  const productHint = params.get("product");

  const [ready, setReady] = useState(false);
  const [banner, setBanner] = useState<{ level: "alert" | "warn" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [scripts, setScripts] = useState<ScriptRow[]>([]);
  const [shots, setShots] = useState<Array<{ shotId: string; durationSec: number; prompt: string; promptSha256: string }>>([]);
  const [shotId, setShotId] = useState("");
  const [verifiedSourceKey, setVerifiedSourceKey] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobRow[]>([]);

  const [modelId, setModelId] = useState<string>("");
  const [durationSec, setDurationSec] = useState(5);
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [resolution, setResolution] = useState("720p");
  const [generateAudio, setGenerateAudio] = useState(true);
  const [firstFrameUrl, setFirstFrameUrl] = useState("");
  const mode = modeHint === "batch" || modeHint === "auto" ? modeHint : "manual";
  const [g8Readback, setG8Readback] = useState<G8Readback | null>(null);
  const [g8Refresh, setG8Refresh] = useState(0);
  const [estimate, setEstimate] = useState<{
    usd: number | null; cny: number | null; unit: string; units: number;
    allowed: boolean; reason: string | null; spentMonthCny: number; caps: { dailyCapCny: number | null; monthlyCapCny: number | null };
  } | null>(null);

  const [publishPlatform, setPublishPlatform] = useState<string>("douyin");
  const [publishAccount, setPublishAccount] = useState("acc-demo-01");
  const [publishCaption, setPublishCaption] = useState("");
  const [publishJobId, setPublishJobId] = useState<string | null>(null);

  const sourceKey = JSON.stringify([accessStatus, scope?.tenantId, identityKey, projectId, shotHint]);
  const currentSourceKey = useRef(sourceKey);
  currentSourceKey.current = sourceKey;
  const visibleShots = verifiedSourceKey === sourceKey ? shots : [];
  const selectedShot = visibleShots.find(shot => shot.shotId === shotId) ?? null;
  const g8Key = JSON.stringify([sourceKey, selectedShot?.shotId]);
  const canRender = accessStatus === "ready" && canAction("workspace.write");
  const canApprove = accessStatus === "ready" && canAction("approval.decide");
  const currentG8Key = useRef(g8Key);
  currentG8Key.current = g8Key;
  const g8 = g8Readback?.key === g8Key ? g8Readback : null;
  const contract = g8?.status?.contract;
  const ticket = g8?.status?.ticket;
  const locked = !g8?.status || !!contract;
  const effectiveModelId = contract?.modelId ?? modelId;
  const model = useMemo(() => models.find(m => m.id === effectiveModelId) ?? null, [models, effectiveModelId]);
  const canRequest = !!g8?.status && (!ticket || ["expired", "stale", "rejected"].includes(ticket.status));
  const refreshG8 = useCallback(() => {
    setG8Readback(null);
    setG8Refresh(value => value + 1);
  }, []);
  useEffect(() => {
    if (!selectedShot) return;
    let active = true;
    void trpc.video.production.g8Status.query({ projectId, shotId: selectedShot.shotId }).then(
      status => { if (active) setG8Readback({ key: g8Key, status }); },
      error => { if (active) setG8Readback({ key: g8Key, error: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { active = false; };
  }, [g8Key, g8Refresh, projectId, selectedShot]);

  const loadCatalog = useCallback(async () => {
    const r = await trpc.video.gen.catalog.query({ kind: "video" }) as unknown as { models: ModelEntry[] };
    setModels(r.models);
    setModelId((cur) => cur || r.models[0]?.id || "");
  }, []);

  const loadScripts = useCallback(async () => {
    const [drafts, production] = await Promise.allSettled([
      trpc.video.cms.listScripts.query({ projectId }), trpc.video.production.shots.query({ projectId }),
    ]);
    if (currentSourceKey.current !== sourceKey) return;
    setScripts(drafts.status === "fulfilled" ? drafts.value as unknown as ScriptRow[] : []);
    if (production.status === "fulfilled") {
      const current = production.value.shots;
      const requested = current.find(shot => shot.shotId === shotHint);
      setShots(current);
      setShotId(cur => shotHint ? requested?.shotId ?? "" : current.find(shot => shot.shotId === cur)?.shotId ?? current[0]?.shotId ?? "");
      setSourceError(shotHint && !requested ? `链接中的镜头 ${shotHint} 已不在当前预生产结果中，请重新选择。` : null);
    } else {
      setShots([]);
      setShotId("");
      setSourceError(production.reason instanceof Error ? production.reason.message : String(production.reason));
    }
    setVerifiedSourceKey(sourceKey);
  }, [projectId, shotHint, sourceKey]);

  const loadJobs = useCallback(async (silent = false) => {
    if (!silent) setReady(false);
    try {
      await ensureDemoLogin();
      /** 队列看"最近 30 条"（跨项目）：出片是稀缺事件，按项目过滤会让人以为没出片；项目号在卡片上标注 */
      const rows = await trpc.video.gen.jobs.query({ limit: 30 }) as unknown as JobRow[];
      setJobs(rows);
    } catch (e) {
      setBanner({ level: "alert", text: `任务队列加载失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setReady(true);
    }
  }, [projectId]);

  useEffect(() => {
    if (accessStatus !== "ready") return;
    void (async () => {
      try {
        await ensureDemoLogin();
        await Promise.all([loadCatalog(), loadScripts()]);
      } catch (e) {
        setBanner({ level: "alert", text: `模型目录加载失败：${e instanceof Error ? e.message : String(e)}` });
      }
    })();
    void loadJobs();
    const t = setInterval(() => void loadJobs(true), 10_000);
    return () => clearInterval(t);
  }, [accessStatus, loadCatalog, loadScripts, loadJobs]);

  /** 报价：模型/时长变化即刷新（含上限闸预览） */
  useEffect(() => {
    if (!effectiveModelId) return;
    setEstimate(null);
    let alive = true;
    void (async () => {
      try {
        const r = await trpc.video.gen.estimate.query({ modelId: effectiveModelId, seconds: durationSec }) as unknown as {
          estimate: { usd: number | null; cny: number | null; unit: string; units: number };
          spend: { monthCny: number; caps: { dailyCapCny: number | null; monthlyCapCny: number | null } };
          allowed: boolean; reason: string | null;
        };
        if (!alive) return;
        setEstimate({
          usd: r.estimate.usd, cny: r.estimate.cny, unit: r.estimate.unit, units: r.estimate.units,
          allowed: r.allowed, reason: r.reason, spentMonthCny: r.spend.monthCny, caps: r.spend.caps,
        });
      } catch {
        if (alive) setEstimate(null);
      }
    })();
    return () => { alive = false; };
  }, [effectiveModelId, durationSec]);

  useEffect(() => { if (selectedShot) setDurationSec(selectedShot.durationSec); }, [selectedShot]);

  const submit = useCallback(async (resume: boolean) => {
    if (busy || !canRender || !selectedShot || !effectiveModelId || !g8?.status) return;
    if (resume ? ticket?.status !== "approved" : !canRequest) return;
    setBanner(null);
    setBusy(resume ? "submit" : "qualify");
    try {
      let request: Parameters<typeof trpc.video.render.submit.mutate>[0];
      if (resume && ticket) {
        request = { g8ApprovalId: ticket.approvalId, allowOverage: ticket.allowOverage };
      } else {
        const firstFrame = firstFrameUrl.trim();
        if (!contract && firstFrame && !/^(https?:\/\/|asset:\/\/)/.test(firstFrame)) {
          throw new Error("首帧地址须使用 https、http 或已授权的 asset:// 素材地址。");
        }
        const qualification = await trpc.video.production.qualifyShotReceipt.mutate({
          projectId, shotId: selectedShot.shotId, modelId: effectiveModelId, mode,
          params: contract ? {} : { durationSec: selectedShot.durationSec, aspectRatio, resolution, generateAudio,
            ...(firstFrame ? { firstFrameUrl: firstFrame } : {}) },
        });
        if (currentG8Key.current !== g8Key) return;
        request = { qualificationToken: qualification.qualificationToken };
        setBusy("submit");
      }
      const result = await trpc.video.render.submit.mutate(request);
      if (currentG8Key.current !== g8Key) return;
      setBanner({
        level: "info",
        text: result.deduped
          ? `该请求与已有任务重复（幂等命中）：${result.jobId}，未重复扣费。`
          : `${result.mock ? "演示提交（未消耗额度）" : "真实渲染已提交"}：${result.provider} · ${result.durationSec}s${result.clamped ? "（已按模型上限夹紧）" : ""} · 预估 ${result.estUsd === null ? "未核价" : `$${result.estUsd} / ¥${result.estCny}`}`,
      });
      await loadJobs(true);
    } catch (error) {
      if (currentG8Key.current !== g8Key) return;
      const message = error instanceof Error ? error.message : String(error);
      if (!contract || resume || !message.startsWith("G8_HUMAN_APPROVAL_REQUIRED")) {
        setBanner({ level: "alert", text: `提交未完成：${message}` });
      }
    } finally {
      if (currentG8Key.current === g8Key && contract) refreshG8();
      setBusy(null);
    }
  }, [busy, canRender, selectedShot, effectiveModelId, g8, ticket, canRequest, contract, firstFrameUrl, projectId, mode,
    aspectRatio, resolution, generateAudio, g8Key, loadJobs, refreshG8]);

  const approveG8 = useCallback(async () => {
    if (busy || ticket?.status !== "pending" || !canApprove) return;
    setBusy("approve");
    setBanner(null);
    try {
      await trpc.approvals.decide.mutate({ approvalId: ticket.approvalId, gesture: "approve" });
    } catch (error) {
      if (currentG8Key.current === g8Key) {
        setBanner({ level: "alert", text: `授权操作未完成：${error instanceof Error ? error.message : String(error)}` });
      }
    } finally {
      if (currentG8Key.current === g8Key) refreshG8();
      setBusy(null);
    }
  }, [busy, ticket, canApprove, g8Key, refreshG8]);

  const pollNow = useCallback(async () => {
    setBusy("poll");
    try {
      const r = await trpc.video.render.poll.mutate({ limit: 10 }) as unknown as {
        checked: number; done: number; failed: number; running: number; ingested: number;
      };
      setBanner({ level: "info", text: `轮询完成：检查 ${r.checked} · 完成 ${r.done} · 入库 ${r.ingested} · 进行中 ${r.running} · 失败 ${r.failed}` });
      await loadJobs(true);
    } catch (e) {
      setBanner({ level: "alert", text: `轮询失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
    }
  }, [loadJobs]);

  const publish = useCallback(async () => {
    const job = jobs.find((j) => j.id === publishJobId) ?? jobs.find((j) => j.status === "done" && j.playUrlKind === "library");
    if (!job) {
      setBanner({ level: "warn", text: "还没有已入库的成片可发布（先完成生成并入库）" });
      return;
    }
    setBusy("publish");
    try {
      const created = await trpc.video.publish.createTask.mutate({
        platform: publishPlatform as "douyin" | "tiktok" | "xiaohongshu" | "shipinhao" | "bilibili" | "youtube",
        accountId: publishAccount,
        assetId: job.asset_id ?? undefined,
        videoPath: job.local_path ?? job.playUrl ?? job.result_url ?? "",
        caption: publishCaption || `WorkLoom 生成 · ${job.script_key ?? job.id}`,
        tags: ["WorkLoom", "AI视频"],
      }) as unknown as { taskId: string; level: string };
      const run = await trpc.video.publish.run.mutate({ taskId: created.taskId }) as unknown as {
        kind: string; level?: string; driver: string; overrideUsed: boolean; receipt?: { synced?: boolean };
      };
      setBanner({
        level: "info",
        text: `发布任务 ${created.taskId}：G9 预检 ${created.level} → 执行结果 ${run.kind}（驱动 ${run.driver}${run.overrideUsed ? " · 测试放行" : ""}；回执 synced=${String(run.receipt?.synced ?? false)}）。真实平台上传需在桌面端登录态下执行。`,
      });
    } catch (e) {
      setBanner({ level: "alert", text: `发布流程失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
    }
  }, [jobs, publishJobId, publishPlatform, publishAccount, publishCaption]);

  const g8Actions = (
    <div className="mb-3 max-w-lg">
      {selectedShot && !g8 && <p role="status" className="mb-2 text-caption text-ink3">正在读取付费授权状态…</p>}
      {g8?.error && <p role="alert" className="mb-2 break-words text-caption text-alert">付费授权状态读取失败：{g8.error}</p>}
      {ticket && (
        <section aria-label="G8 付费渲染授权" className="mb-2 space-y-1 rounded-lg border border-gline bg-card p-3 text-caption text-ink2">
          <div role="status" className="font-bold text-gold">{G8_LABELS[ticket.status]}</div>
          <div className="break-all font-mono text-micro">{ticket.approvalId}</div>
          <div>{ticket.shotId} · {ticket.modelId} · {ticket.durationSec}s · 预估 ¥{ticket.estimatedCny}</div>
          <div className="text-micro text-ink3">授权有效至 {new Date(ticket.expiresAt).toLocaleString()}</div>
          <div className="break-all text-micro text-ink3">请求 {ticket.requestHash.slice(0, 12)} · {ticket.allowOverage ? "申请超额" : "遵守额度上限"}</div>
          {ticket.jobId && <div className="break-all font-mono text-micro">任务 {ticket.jobId}</div>}
          {ticket.status === "pending" && (canApprove ? (
            <button type="button" disabled={busy !== null} onClick={() => void approveG8()}
              className="min-h-11 w-full rounded-md border border-gold/50 px-3 py-1.5 font-bold text-gold disabled:opacity-40">
              {busy === "approve" ? "正在记录授权…" : "批准本次付费渲染"}
            </button>
          ) : <div className="text-ink3">请具备审批权限的成员在同一工作区打开此镜头。</div>)}
          {ticket.status === "approved" && canRender && (
            <button type="button" disabled={busy !== null} onClick={() => void submit(true)}
              className="min-h-11 w-full rounded-md gold-grad px-3 py-2 font-bold text-ongold disabled:opacity-40">
              {busy === "submit" ? "正在提交生成…" : "提交已授权的付费渲染"}
            </button>
          )}
          {ticket.status === "outcome_unknown" && <div className="text-ink3">请刷新任务状态并核对现有回执。</div>}
        </section>
      )}
      {selectedShot && (contract || g8?.error) && (
        <button type="button" disabled={busy !== null || !g8} onClick={refreshG8}
          className="mb-1.5 min-h-11 w-full rounded-md border border-line px-3 py-1.5 text-caption text-ink3 hover:text-ink2 disabled:opacity-40">
          刷新付费授权状态
        </button>
      )}
      {contract && canRequest && (
        <button
          type="button"
          disabled={busy !== null || !canRender || !effectiveModelId || !selectedShot || estimate?.allowed === false}
          onClick={() => void submit(false)}
          className="min-h-11 w-full cursor-pointer rounded-md gold-grad px-3 py-2 text-caption font-bold text-ongold disabled:opacity-40"
        >
          {busy === "qualify" ? "正在审核完整生成请求…" : busy === "submit" ? "正在处理生成请求…" : "审核并申请付费授权"}
        </button>
      )}
    </div>
  );

  /* ---------- 左栏：模型 + 参数 + 报价 + 提交 ---------- */
  const left = (
    <>
      <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">生成工作室</div>
      {(model || contract) ? (
        <div className="mb-2 rounded-lg border border-line bg-card p-3">
          <div className="text-micro text-ink3">模型</div>
          <select
            value={effectiveModelId}
            disabled={busy !== null || locked}
            onChange={(e) => setModelId(e.target.value)}
            className="mt-1 w-full cursor-pointer rounded-md border border-line bg-bg900 px-2 py-1.5 text-caption text-ink2"
          >
            {contract && !model && <option value={contract.modelId}>{contract.modelId}</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {m.tier} · {m.provider}
              </option>
            ))}
          </select>
          <div className="mt-1.5 text-micro text-ink3">
            {model ? `${model.provider} / ${model.effectiveProviderModel}` : contract?.modelId}
          </div>
          {model?.notes && <div className="mt-1 text-micro text-ink3">注：{model.notes}</div>}
        </div>
      ) : (
        <Skeleton />
      )}

      <div className="mb-2 rounded-lg border border-line bg-card p-3">
        <label className="mb-2 block text-micro text-ink3">预生产镜头
          <select aria-label="预生产镜头" value={shotId} disabled={busy !== null || visibleShots.length === 0} onChange={event => setShotId(event.target.value)} className="mt-1 w-full rounded-md border border-line bg-bg900 px-2 py-1.5 text-caption text-ink2 disabled:opacity-40">
            {!selectedShot && <option value="">{visibleShots.length ? "请选择当前镜头" : "暂无已验证镜头"}</option>}
            {visibleShots.map(shot => <option key={shot.shotId} value={shot.shotId}>{shot.shotId} · {shot.durationSec} 秒</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-micro text-ink3">
            镜头计划（秒）
            <input
              type="number"
              min={model?.limits?.durationSec?.min ?? 4}
              max={model?.limits?.durationSec?.max ?? 15}
              value={durationSec}
              readOnly
              aria-label="镜头计划秒数"
              className="mt-1 w-full rounded-md border border-line bg-bg900 px-2 py-1 text-caption text-ink2"
            />
          </label>
          <label className="text-micro text-ink3">
            画幅
            <select
              value={contract?.aspectRatio ?? aspectRatio}
              disabled={busy !== null || locked}
              onChange={(e) => setAspectRatio(e.target.value)}
              className="mt-1 w-full cursor-pointer rounded-md border border-line bg-bg900 px-2 py-1 text-caption text-ink2"
            >
              {(contract ? [contract.aspectRatio] : model?.limits?.aspectRatios ?? ["16:9", "9:16", "1:1"]).map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label className="text-micro text-ink3">
            清晰度
            <select
              value={contract?.resolution ?? resolution}
              disabled={busy !== null || locked}
              onChange={(e) => setResolution(e.target.value)}
              className="mt-1 w-full cursor-pointer rounded-md border border-line bg-bg900 px-2 py-1 text-caption text-ink2"
            >
              {(contract ? [contract.resolution] : model?.limits?.resolutions ?? ["480p", "720p", "1080p"]).map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label className="mt-4 flex items-center gap-2 text-micro text-ink3">
            <input type="checkbox" disabled={busy !== null || locked} checked={contract?.generateAudio ?? generateAudio} onChange={(e) => setGenerateAudio(e.target.checked)} />
            生成音轨
          </label>
        </div>
        {!contract && <label className="mt-2 block text-micro text-ink3">
          首帧图 URL（可选）
          <input
            value={firstFrameUrl}
            disabled={busy !== null || locked}
            onChange={(e) => setFirstFrameUrl(e.target.value)}
            placeholder="https://…/frame.jpg"
            className="mt-1 w-full rounded-md border border-line bg-bg900 px-2 py-1 text-caption text-ink2"
          />
        </label>}
        <div className="mt-2 text-micro text-ink3">
          {selectedShot ? "镜头时长和正文取自预生产。正式生成的模型、画幅、清晰度、音轨和素材由服务请求锁定。" : "完成预生产后刷新本页，服务镜头会出现在这里。"}
        </div>
      </div>

      <div className="mb-2 rounded-lg border border-gline bg-gold/5 p-3">
        <div className="text-micro text-ink3">预估成本</div>
        <div className="mt-0.5 text-body text-gold">
          {estimate
            ? (estimate.usd === null ? "未核价（以供应商账单为准）" : `$${estimate.usd} ≈ ¥${estimate.cny}`)
            : "—"}
          {estimate?.usd !== null && estimate?.usd !== undefined && model?.pricing?.promo && (
            <span className="ml-1 text-micro text-ink3">促销价</span>
          )}
        </div>
        <div className="mt-1 text-micro text-ink3">
          本月已花 ¥{estimate?.spentMonthCny ?? 0}
          {estimate?.caps.monthlyCapCny ? ` / 上限 ¥${estimate.caps.monthlyCapCny}` : "（未设上限）"}
        </div>
        {estimate && !estimate.allowed && (
          <div className="mt-1 text-micro text-alert">{estimate.reason}</div>
        )}
      </div>

      {g8?.status && !contract && canRequest && (
        <button
          type="button"
          disabled={busy !== null || !canRender || !effectiveModelId || !selectedShot || estimate?.allowed === false}
          onClick={() => void submit(false)}
          className="w-full cursor-pointer rounded-md gold-grad px-3 py-2 text-caption font-bold text-ongold disabled:opacity-40"
        >
          {busy === "qualify" ? "正在审核完整生成请求…" : busy === "submit" ? "正在处理生成请求…" : "▶ 审核并生成当前镜头"}
        </button>
      )}
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => void pollNow()}
        className="mt-1.5 w-full cursor-pointer rounded-md border border-line px-3 py-1.5 text-caption text-ink3 hover:border-holo/40 hover:text-ink2 disabled:opacity-40"
      >
        ⟳ 立即刷新任务状态（轮询 + 入库）
      </button>
      <button
        type="button"
        onClick={() => nav("/ai-video/assets?project=" + encodeURIComponent(projectId))}
        className="mt-1.5 w-full cursor-pointer rounded-lg border border-line px-3 py-2 text-caption text-ink3 hover:border-holo/40 hover:text-ink2"
      >
        ← 返回片库 / 脚本 CMS
      </button>
    </>
  );

  /* ---------- 右栏：任务队列 + 发布 ---------- */
  const right = (
    <>
      <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">任务队列</div>
      {ready && jobs.length === 0 && (
        <EmptyState icon="🎬" title="暂无生成任务" hint="在生成工作室审核镜头、确认费用并提交。生成完成后，任务可在这里刷新入库。" />
      )}
      {jobs.map((j) => {
        const meta = STATUS_META[j.status] ?? { label: j.status, cls: "border-line text-ink3" };
        return (
          <div key={j.id} className="mb-1.5 rounded-lg border border-line bg-card px-3 py-2.5">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] text-ink3">{j.id}</span>
              <span className="flex items-center gap-1">
                {j.mock && <span className="rounded border border-line px-1.5 py-0.5 text-micro text-ink3">演示</span>}
                <span className={`rounded border px-1.5 py-0.5 text-micro ${meta.cls}`}>{meta.label}</span>
              </span>
            </div>
            <div className="mt-1 break-all text-caption text-ink2">
              {j.provider ?? "-"} · {j.provider_model ?? "-"}
            </div>
            <div className="mt-0.5 text-micro text-ink3">项目 {j.project_id}{j.script_key ? ` · ${j.script_key}` : ""}</div>
            <div className="mt-0.5 font-mono text-micro text-ink3">
              {j.est_cny !== null && `预估 ¥${j.est_cny}`}
              {j.actual_cny !== null && ` · 实际 ¥${j.actual_cny}`}
              {!j.actual_cny && j.status === "done" && " · 未核价"}
            </div>
            {j.playUrl && (
              <video
                src={j.playUrl}
                controls
                preload="metadata"
                className="mt-1.5 w-full rounded-md border border-line"
              />
            )}
            <div className="mt-1 flex items-center justify-between text-micro text-ink3">
              <span>
                {j.playUrlKind === "library" ? "已入库（自有媒体库）" : j.playUrlKind === "provider" ? "供应商链接（7 天保留）" : "待生成"}
              </span>
              <span className="flex gap-1.5">
                {j.playUrl && (
                  <a href={j.playUrl} target="_blank" rel="noreferrer" className="cursor-pointer text-holo hover:underline">播放/下载</a>
                )}
                {j.status === "done" && (
                  <button
                    type="button"
                    onClick={() => setPublishJobId(j.id)}
                    className={`cursor-pointer hover:underline ${publishJobId === j.id ? "text-goldhi" : "text-gold"}`}
                  >
                    选为发布对象
                  </button>
                )}
              </span>
            </div>
          </div>
        );
      })}

      <div className="mt-3 rounded-lg border border-line bg-card p-3">
        <div className="text-micro text-ink3">发布（公网发布必审 · G9）</div>
        <div className="mt-1.5 grid grid-cols-2 gap-2">
          <select
            value={publishPlatform}
            onChange={(e) => setPublishPlatform(e.target.value)}
            className="cursor-pointer rounded-md border border-line bg-bg900 px-2 py-1 text-caption text-ink2"
          >
            {PLATFORMS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <input
            value={publishAccount}
            onChange={(e) => setPublishAccount(e.target.value)}
            placeholder="账号 ID"
            className="rounded-md border border-line bg-bg900 px-2 py-1 text-caption text-ink2"
          />
        </div>
        <input
          value={publishCaption}
          onChange={(e) => setPublishCaption(e.target.value)}
          placeholder="发布文案（可留空自动生成）"
          className="mt-2 w-full rounded-md border border-line bg-bg900 px-2 py-1 text-caption text-ink2"
        />
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void publish()}
          className="mt-2 w-full cursor-pointer rounded-md border border-gold/50 px-3 py-1.5 text-caption font-bold text-gold hover:bg-gold/10 disabled:opacity-40"
        >
          ⇪ 入队并执行发布（本机 dry-run）
        </button>
        <div className="mt-1.5 text-micro leading-relaxed text-ink3">
          真实上传需要桌面端 Playwright 驱动 + 你本人登录态；服务端 dry-run 只验证机制并留痕（回执 synced=false）。
        </div>
      </div>
    </>
  );

  return (
    <Bridge left={left} right={right}>
      <div className="px-1 max-[820px]:pl-6">
        {productHint ? (
          <div className="mb-3 rounded-lg border border-line bg-card px-3 py-2 text-caption text-ink2">
            本次开拍商品：<span className="font-bold text-ink">{productHint}</span>
            <span className="text-ink3">（来自商品档案；立项/下单时引用该商品，情报环节会复用这份 dossier）</span>
          </div>
        ) : null}
        <div className="mb-3 flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div>
            <div className="break-words text-title text-ink">生成工作室 · {projectId}</div>
            <div className="mt-0.5 text-caption text-ink3">
              选择服务镜头 → 审核请求 → 确认付费授权 → 提交生成 → 入库
            </div>
          </div>
          <span className="rounded border border-line px-2 py-1 text-micro text-ink3">
            可用模型 {models.length} 个
          </span>
        </div>

        {verifiedSourceKey === sourceKey && sourceError && <div className="mb-3"><BannerAlert level="warn">当前项目尚无可验证的服务镜头：{sourceError}</BannerAlert></div>}
        {banner && (
          <BannerAlert level={banner.level} actionLabel="知道了" onAction={() => setBanner(null)}>
            {banner.text}
          </BannerAlert>
        )}

        {selectedShot && (!g8 || g8.error || contract) && g8Actions}

        {!ready ? (
          <div className="space-y-2"><Skeleton count={4} height={56} /></div>
        ) : (
          <div className="rounded-lg border border-line bg-bg900/40 p-3">
            {selectedShot && <details className="mb-3"><summary className="cursor-pointer text-caption text-ink2">查看当前镜头完整内容 · {selectedShot.shotId}</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-caption leading-relaxed text-ink3">{selectedShot.prompt}</pre></details>}
            <div className="text-caption text-ink2">
              当前项目已有 {visibleShots.length} 个服务镜头、{scripts.length} 个工作稿版本、{jobs.length} 个生成任务。
            </div>
            <div className="mt-2 text-micro leading-relaxed text-ink3">
              · 服务审核完整生成请求。正式付费渲染须经人工授权，再单独提交，费用上限仍生效。
              · 生成完成后点「立即刷新任务状态」触发轮询回填 + 成片入库（供应商只保留 7 天，入库后才算真交付）；
              · 真实渲染会消耗供应商额度，界面上的"演示/促销价/未核价"标识以数据为准，不粉饰。
            </div>
          </div>
        )}
      </div>
    </Bridge>
  );
}
