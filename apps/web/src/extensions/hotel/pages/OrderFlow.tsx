/** p13 订单流：从线索到成交的全链穿透（含 OTA 佣金节省对照） */
import { trpc } from "../../../lib/trpc";
import { ConsoleShell, DataTable, Metric, MetricGrid, Panel, useConsoleData, yuan } from "../console";

interface Payload {
  source: string;
  totals: { orders: number; amountFen: number; commissionSavedFen: number };
  orders: Array<{ id: string; roomType: string; checkIn: string | null; checkOut: string | null; amountFen: number; status: string }>;
  chain: Array<{ action: string; n: number }>;
}

export default function OrderFlow() {
  const state = useConsoleData<Payload>(() => trpc.acquisition.orderFlow.query() as unknown as Promise<Payload>);
  const data = state.data;
  return (
    <ConsoleShell title="订单流与全链穿透" desc="线索→留资→成交→佣金节省：每一单都能追到来源链，才能知道钱花在哪一环"
      source={data?.source} state={state}>
      <MetricGrid>
        <Metric label="订单数" value={data?.totals.orders ?? 0} />
        <Metric label="订单金额" value={data ? yuan(data.totals.amountFen) : "—"} />
        <Metric label="OTA 佣金节省" value={data ? yuan(data.totals.commissionSavedFen) : "—"} hint="直连成交对照" />
        <Metric label="转化链事件种类" value={data?.chain.length ?? 0} hint="lead/conversion/deal/booking" />
      </MetricGrid>
      <Panel title="转化链事件（近 30 天）">
        <DataTable
          columns={[
            { key: "action", title: "动作", render: (row) => row.action },
            { key: "n", title: "次数", render: (row) => row.n },
          ]}
          rows={data?.chain ?? []}
          empty="近 30 天没有线索/成交类事件。"
        />
      </Panel>
      <Panel title="订单台账">
        <DataTable
          columns={[
            { key: "id", title: "订单号", render: (row) => row.id },
            { key: "room", title: "房型", render: (row) => row.roomType },
            { key: "stay", title: "入住 / 离店", render: (row) => `${row.checkIn ?? "—"} → ${row.checkOut ?? "—"}` },
            { key: "amount", title: "金额", render: (row) => yuan(row.amountFen) },
            { key: "status", title: "状态", render: (row) => row.status },
          ]}
          rows={data?.orders ?? []}
          empty="暂无订单台账数据。"
        />
      </Panel>
    </ConsoleShell>
  );
}
