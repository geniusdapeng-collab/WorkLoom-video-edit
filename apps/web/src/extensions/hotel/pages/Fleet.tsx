/** p18 多店驾驶舱：同租户各店的编制/事件/订单对比（连锁经营视角） */
import { trpc } from "../../../lib/trpc";
import { ConsoleShell, DataTable, Metric, MetricGrid, Panel, useConsoleData, yuan } from "../console";

interface Payload {
  source: string;
  stores: Array<{ id: string; name: string; slug: string; industry: string; stage: string | null; agents: number; events: number; threads: number; amountFen: number }>;
}

export default function Fleet() {
  const state = useConsoleData<Payload>(() => trpc.acquisition.fleet.query() as unknown as Promise<Payload>);
  const data = state.data;
  const stores = data?.stores ?? [];
  const totalAmount = stores.reduce((sum, store) => sum + store.amountFen, 0);
  const totalAgents = stores.reduce((sum, store) => sum + store.agents, 0);
  return (
    <ConsoleShell title="多店驾驶舱" desc="同租户多店的编制规模、经营事件与订单对照——单店打法是样板，多店复制才是生意"
      source={data?.source} state={state}>
      <MetricGrid>
        <Metric label="在管门店" value={stores.length} />
        <Metric label="数字员工合计" value={totalAgents} />
        <Metric label="订单金额合计" value={yuan(totalAmount)} />
        <Metric label="最大门店事件量" value={stores.reduce((max, store) => Math.max(max, store.events), 0)} />
      </MetricGrid>
      <Panel title="门店对比">
        <DataTable
          columns={[
            { key: "name", title: "门店", render: (row) => `${row.name}（${row.slug}）` },
            { key: "industry", title: "行业包", render: (row) => row.industry },
            { key: "stage", title: "阶段", render: (row) => row.stage ?? "—" },
            { key: "agents", title: "员工", render: (row) => row.agents },
            { key: "events", title: "事件", render: (row) => row.events },
            { key: "threads", title: "任务", render: (row) => row.threads },
            { key: "amount", title: "订单金额", render: (row) => yuan(row.amountFen) },
          ]}
          rows={stores}
          empty="该租户下还没有工作区。"
        />
      </Panel>
    </ConsoleShell>
  );
}
