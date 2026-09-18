/** p10 断点流：哪一步断了、为什么断、积压多少——获客闭环的"复盘入口" */
import { trpc } from "../../../lib/trpc";
import { ConsoleShell, DataTable, Metric, MetricGrid, Panel, useConsoleData } from "../console";

interface Payload {
  source: string;
  byStatus: Array<{ status: string; n: number }>;
  roots: Array<{ action: string; n: number }>;
  items: Array<{ id: string; title: string; mode: string; status: string; error: string | null; currentAction: string | null; updatedAt: string }>;
}

export default function Breakpoints() {
  const state = useConsoleData<Payload>(() => trpc.acquisition.breakpoints.query() as unknown as Promise<Payload>);
  const data = state.data;
  const failed = data?.byStatus.find((row) => row.status === "failed")?.n ?? 0;
  const paused = data?.byStatus.find((row) => row.status === "paused")?.n ?? 0;
  return (
    <ConsoleShell title="断点流与根因" desc="暂停/失败的经营任务、根因事件分布——断裂的环节先补，再谈增长"
      source={data?.source} state={state}>
      <MetricGrid>
        <Metric label="熔断暂停" value={paused} hint="围栏 block：需人工处置" />
        <Metric label="执行失败" value={failed} hint="工具/连接器失败" />
        <Metric label="根因事件种类" value={data?.roots.length ?? 0} hint="近 14 天" />
      </MetricGrid>
      <Panel title="根因分布（事件账本）">
        <DataTable
          columns={[
            { key: "action", title: "事件动作", render: (row) => row.action },
            { key: "n", title: "次数", render: (row) => row.n },
          ]}
          rows={data?.roots ?? []}
          empty="近 14 天没有失败/熔断类事件——闭环没有断点。"
        />
      </Panel>
      <Panel title="待处置任务">
        <DataTable
          columns={[
            { key: "title", title: "任务", render: (row) => row.title },
            { key: "status", title: "状态", render: (row) => row.status },
            { key: "action", title: "断点", render: (row) => row.currentAction ?? "—" },
            { key: "error", title: "原因", render: (row) => row.error ?? "—" },
            { key: "at", title: "更新", render: (row) => row.updatedAt.slice(0, 16).replace("T", " ") },
          ]}
          rows={data?.items ?? []}
          empty="没有暂停或失败的任务。"
        />
      </Panel>
    </ConsoleShell>
  );
}
