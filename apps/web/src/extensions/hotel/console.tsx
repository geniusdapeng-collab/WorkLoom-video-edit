/**
 * 获客控制台页面套件（行业扩展页 p10–p20 共用）：
 * 统一的加载/错误/空态与"数据来源"标注——每个指标都要能回答"这个数从哪来"。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ensureDemoLogin } from "../../lib/trpc";
import { PageExitLink } from "../../shell/PageExitLink";

export interface ConsoleState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** 统一取数：首进自动登录 → 调端点 → 逐次可手动刷新；失败给出可读错误而不是空白页 */
export function useConsoleData<T>(loader: () => Promise<T>): ConsoleState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // loader 每次渲染都是新函数：用 ref 存引用、用自增版本触发取数，避免依赖身份导致的取数风暴
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        await ensureDemoLogin();
        const next = await loaderRef.current();
        if (!cancelled) { setData(next); setError(null); }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "取数失败，请稍后重试");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [version]);
  return { data, error, loading, reload: () => setVersion((value) => value + 1) };
}

export function ConsoleShell(input: {
  title: string; desc: string; source?: string; state: { loading: boolean; error: string | null; reload: () => void };
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-5xl p-4">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          {/* 控制台是二级页（从工作台/导航钻取进来）：每个页面都必须有明确出口 */}
          <PageExitLink label="返回工作台" className="mb-2 cursor-pointer rounded-lg border border-line px-3 py-1.5 text-body text-ink3 hover:border-holo/40 hover:text-ink2" />
          <h1 className="text-xl font-bold text-ink">{input.title}</h1>
          <p className="mt-1 text-body text-ink3">{input.desc}</p>
        </div>
        <button type="button" onClick={input.state.reload}
          className="rounded border border-line px-3 py-1 text-body text-ink2 hover:border-holo/60 hover:text-holo">
          {input.state.loading ? "读取中…" : "刷新"}
        </button>
      </header>
      {input.source && (
        <div className="mb-3 text-body text-ink3">数据来源：{input.source}</div>
      )}
      {input.state.error && (
        <div className="mb-3 rounded border border-warn/50 bg-warn/10 p-3 text-body text-warn">
          读取失败：{input.state.error}
        </div>
      )}
      {input.state.loading && !input.state.error && (
        <div className="rounded border border-line bg-card p-6 text-body text-ink3">正在读取经营数据…</div>
      )}
      {!input.state.loading && !input.state.error && input.children}
    </div>
  );
}

export function MetricGrid({ children }: { children: ReactNode }) {
  return <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">{children}</div>;
}

export function Metric({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-card p-3">
      <div className="text-body text-ink3">{label}</div>
      <div className="mt-1 text-lg font-semibold text-ink">{value}</div>
      {hint && <div className="mt-1 text-body text-ink3">{hint}</div>}
    </div>
  );
}

export function Panel({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mb-4 rounded-xl border border-line bg-card p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <div className="text-body tracking-[.18em] text-ink3">{title}</div>
        {hint && <div className="text-body text-ink3">{hint}</div>}
      </div>
      {children}
    </section>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className="rounded border border-dashed border-line p-4 text-body text-ink3">{text}</div>;
}

export interface Column<T> { key: string; title: string; render: (row: T) => ReactNode }

export function DataTable<T>({ columns, rows, empty }: { columns: Array<Column<T>>; rows: T[]; empty: string }) {
  if (rows.length === 0) return <Empty text={empty} />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-body">
        <thead>
          <tr className="text-ink3">
            {columns.map((column) => <th key={column.key} className="whitespace-nowrap px-2 py-1 font-normal">{column.title}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-t border-line/60 text-ink2">
              {columns.map((column) => <td key={column.key} className="px-2 py-1 align-top">{column.render(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 分/元换算（金额一律以分为最小单位存储，展示才转元） */
export function yuan(fen: number): string {
  return `¥${(fen / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
