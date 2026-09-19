import { clientIdentifierText } from "@workloom/ui";

/**
 * EventIdChip #E 事件编号（设计规范 §10：等宽青色，点击展开决策链路 F1.12）
 * 数据/编号/回执一律全息青（§2.2）；编号禁止换行（§3 mono 规则，tokens.css 全局）。
 *
 * 传了 onClick 才渲染 `<button>`；不传（当前全部调用点都是外层按钮的行内编号）
 * 渲染 `<span>`——HTML 不允许按钮嵌套，旧实现会在 70 个岗位档案的事件流上
 * 触发 React hydration 报错「<button> cannot contain a nested <button>」。
 */
export function EventIdChip({ id, onClick }: { id: string; onClick?: () => void }) {
  const label = clientIdentifierText(id);
  const className = "max-w-full break-all rounded border border-holo/30 bg-holo/5 px-1.5 py-0.5 font-mono text-body text-holo";
  if (!onClick) {
    return (
      <span title="事件编号" aria-label={`事件${label}`} className={className}>
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title="点击展开决策链路"
      aria-label={`查看事件${label}的决策链路`}
      className={`${className} cursor-pointer transition-colors hover:border-holo/60`}
    >
      {label}
    </button>
  );
}
