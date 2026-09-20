/**
 * 模拟数据横幅（D24 落地向导入口）
 *
 * 事实源 = onboarding.status（数据模式 + LLM 装配）：
 *  - 数据为模拟种子 或 模型为内置 mock → 常显（宁可多提示，不可漏提示）
 *  - 两者均真实 → 自动熄灭
 * 挂载点：P0 经营主页顶栏下方 + Bridge 工作台顶栏下方（全覆盖所有页面）。
 */
import { useEffect, useState } from "react";
import { ensureDemoLogin, isLocalFull, trpc } from "../lib/trpc";
import { Icon } from "@workloom/ui";

export interface OnboardingStatus {
  dataMode: "simulated" | "real";
  persistedDataMode?: "simulated" | "real";
  formalActivationRecorded?: boolean;
  llm: { provider: string; model: string; baseUrl: string; real: boolean };
  workspace: { name: string; events: number; members: number; agents: number; memories: number };
  business?: { name: string; industry: string; note: string; configuredAt: string; source: string } | null;
  bundle?: { id: string | null; isExample: boolean };
  activationGate?: {
    canActivate: boolean;
    blockers: string[];
    checks: Array<{ key: string; label: string; ok: boolean; detail: string }>;
  };
}

export function SimBanner() {
  const [st, setSt] = useState<OnboardingStatus | null>(null);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        await ensureDemoLogin();
        const s = (await trpc.onboarding.status.query()) as OnboardingStatus;
        if (!stop) setSt(s);
      } catch {
        /* 服务未就绪时静默（横幅不阻塞任何页面） */
      }
    };
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);
  if (!st) return null;
  /**
   * 2026-09-20 产品所有者决定：**删除**「行业示例版」银带与「定制我的行业版」入口（不是开关隐藏，是清理代码）。
   * 示例装配事实改由经营主页头部「演示数据」小徽标承担披露，不再占整行、不再引导改装配。
   * 本机个人使用（LOCAL_FULL）姿态下，本组件整体不渲染。
   */
  if (isLocalFull()) return null;
  const simData = st.dataMode === "simulated";
  const mockLlm = !st.llm.real;
  if (!simData && !mockLlm) return null;
  return (
    <div className="relative z-30 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-500/50 bg-amber-100/80 px-4 py-2 text-body text-amber-800 backdrop-blur">
      <Icon name="warning" size={16} />
      <span className="min-w-0 flex-1 break-words">
        {st.persistedDataMode === "real" && (!st.formalActivationRecorded || (st.activationGate && !st.activationGate.canActivate)) && (
          <>原“正式”标记缺少当前服务端门禁凭据或已不满足门禁，已按<b>模拟运行态</b>展示。</>
        )}
        {simData && mockLlm && (
          <> 当前为<b>全模拟运行态</b>：经营数据尚未完成正式门禁，应答由内置确定性模型生成。</>
        )}
        {simData && !mockLlm && (
          <> 经营数据或装配仍未通过正式门禁（大模型已接真实）。</>
        )}
        {!simData && mockLlm && (
          <>大模型仍为<b>内置确定性应答</b>（数据已切真实模式）。</>
        )}
        {" "}请开始接入真实数据使用——点击右侧按钮进入「落地向导」，全程自动完成。
      </span>
      <a
        href="/onboarding"
        className="shrink-0 rounded border border-amber-500/60 bg-amber-200/60 px-3 py-1 font-bold text-amber-900 no-underline transition-colors hover:bg-amber-300/60"
      >
        接入真实数据 →
      </a>
    </div>
  );
}
