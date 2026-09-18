/**
 * 页面出口（统一"返回/退出"控件）。
 *
 * 为什么要有它：左侧导航只在工作台主壳里常驻，裸页（/dev、/onboarding、/login 等）
 * 与二级页（钻取详情、行业扩展页）如果没有自己的出口，用户会被困在页面里——
 * 这不是美观问题，是可用性事故。约定：所有裸页与二级页必须渲染本控件
 * （回归测试 PageExitAffordance.test.ts 会逐个页面校验）。
 */
import { useNavigate } from "react-router";

export function PageExitLink(input: {
  /** 目标路由；缺省返回工作台首页 */
  to?: string;
  /** 文案，默认"返回工作台" */
  label?: string;
  /** 优先用浏览器返回（保留来源页上下文），失败/直达时回落 to */
  preferHistory?: boolean;
  className?: string;
}) {
  const navigate = useNavigate();
  const { to = "/", label = "返回工作台", preferHistory = false } = input;
  const go = () => {
    if (preferHistory && window.history.length > 1) navigate(-1);
    else navigate(to);
  };
  return (
    <button
      type="button"
      onClick={go}
      data-page-exit="true"
      className={input.className ?? "cursor-pointer rounded-lg border border-line px-3 py-1.5 text-caption text-ink3 hover:border-holo/40 hover:text-ink2"}
    >
      ← {label}
    </button>
  );
}
