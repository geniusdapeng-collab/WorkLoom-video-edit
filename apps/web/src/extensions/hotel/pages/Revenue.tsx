/** p19 收益问数：收入/客单、账号指标（播放→转化）、历史曲线与转化资产 */
import { trpc } from "../../../lib/trpc";
import { ConsoleShell, DataTable, Metric, MetricGrid, Panel, useConsoleData, yuan } from "../console";

interface Payload {
  source: string;
  orders: { orders: number; amountFen: number; avgFen: number };
  metrics: { plays: number; likes: number; comments: number; conversions: number };
  history: Record<string, { occ?: number; adr?: number; revpar?: number }> | null;
  conversion: { funnel_baseline?: Record<string, number>; ota_commission_saving_target?: number } | null;
}

export default function Revenue() {
  const state = useConsoleData<Payload>(() => trpc.acquisition.revenue.query() as unknown as Promise<Payload>);
  const data = state.data;
  const convertRate = data && data.metrics.plays > 0 ? (data.metrics.conversions / data.metrics.plays) * 100 : null;
  return (
    <ConsoleShell title="收益问数" desc="收入与客单、内容曝光到成交的转化率、历史经营曲线——获客的账要能对上经营结果"
      source={data?.source} state={state}>
      <MetricGrid>
        <Metric label="订单收入" value={data ? yuan(data.orders.amountFen) : "—"} hint={`${data?.orders.orders ?? 0} 单`} />
        <Metric label="平均客单" value={data ? yuan(data.orders.avgFen) : "—"} />
        <Metric label="内容曝光（30 天）" value={data?.metrics.plays.toLocaleString("zh-CN") ?? 0} />
        <Metric label="曝光→转化" value={convertRate === null ? "无曝光数据" : `${convertRate.toFixed(2)}%`}
          hint={`转化 ${data?.metrics.conversions ?? 0} 次`} />
      </MetricGrid>
      <Panel title="历史经营曲线（一店一档）">
        <DataTable
          columns={[
            { key: "month", title: "月份", render: (row) => row.month },
            { key: "occ", title: "OCC", render: (row) => (row.occ === undefined ? "—" : `${(row.occ * 100).toFixed(0)}%`) },
            { key: "adr", title: "ADR", render: (row) => (row.adr === undefined ? "—" : `¥${row.adr}`) },
            { key: "revpar", title: "RevPAR", render: (row) => (row.revpar === undefined ? "—" : `¥${row.revpar}`) },
          ]}
          rows={Object.entries(data?.history ?? {}).map(([month, value]) => ({ month, ...value }))}
          empty="一店一档尚无历史经营曲线。"
        />
      </Panel>
      <Panel title="六级漏斗基线（一店一档 conversion_assets）">
        <DataTable
          columns={[
            { key: "stage", title: "环节", render: (row) => row.stage },
            { key: "value", title: "基线值", render: (row) => row.value.toLocaleString("zh-CN") },
          ]}
          rows={Object.entries(data?.conversion?.funnel_baseline ?? {}).map(([stage, value]) => ({ stage, value }))}
          empty="一店一档尚未声明漏斗基线。"
        />
      </Panel>
    </ConsoleShell>
  );
}
