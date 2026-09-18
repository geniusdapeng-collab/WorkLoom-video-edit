/** p17 入退与派单：C 端工单（送物/报修/投诉）时效、布草耗材事件 */
import { trpc } from "../../../lib/trpc";
import { ConsoleShell, DataTable, Metric, MetricGrid, Panel, useConsoleData } from "../console";

interface Payload {
  source: string;
  counts: { open: number; overdue: number; closed: number };
  tickets: Array<{ id: string; kind: string; title: string; status: string; slaDueAt: string | null; at: string }>;
  linen: Array<{ action: string; n: number }>;
}

const STATUS_TEXT: Record<string, string> = {
  created: "待确认", assigned: "已受理", processing: "处理中", done: "已完成", closed: "已关闭",
};

export default function Housekeeping() {
  const state = useConsoleData<Payload>(() => trpc.acquisition.housekeeping.query() as unknown as Promise<Payload>);
  const data = state.data;
  return (
    <ConsoleShell title="入退与派单" desc="送物/报修/清洁的响应时效与布草耗材留痕——履约慢一步，口碑掉一层"
      source={data?.source} state={state}>
      <MetricGrid>
        <Metric label="进行中" value={data?.counts.open ?? 0} />
        <Metric label="超 SLA" value={data?.counts.overdue ?? 0} hint="需优先处置" />
        <Metric label="已闭环" value={data?.counts.closed ?? 0} />
        <Metric label="布草/耗材事件" value={data?.linen.reduce((sum, row) => sum + row.n, 0) ?? 0} hint="近 30 天" />
      </MetricGrid>
      <Panel title="工单台账">
        <DataTable
          columns={[
            { key: "id", title: "工单", render: (row) => row.id },
            { key: "kind", title: "类型", render: (row) => row.kind },
            { key: "title", title: "内容", render: (row) => row.title },
            { key: "status", title: "状态", render: (row) => STATUS_TEXT[row.status] ?? row.status },
            { key: "sla", title: "SLA 截止", render: (row) => (row.slaDueAt ? row.slaDueAt.slice(0, 16).replace("T", " ") : "—") },
          ]}
          rows={data?.tickets ?? []}
          empty="暂无工单。"
        />
      </Panel>
      <Panel title="布草 / 耗材 / 查房事件">
        <DataTable
          columns={[
            { key: "action", title: "动作", render: (row) => row.action },
            { key: "n", title: "次数", render: (row) => row.n },
          ]}
          rows={data?.linen ?? []}
          empty="近 30 天没有布草/耗材/查房事件。"
        />
      </Panel>
    </ConsoleShell>
  );
}
