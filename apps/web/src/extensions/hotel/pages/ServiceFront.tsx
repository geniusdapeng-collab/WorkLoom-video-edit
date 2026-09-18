/** p16 语音前台与 FAQ 自生长：知识库规模、电话记录、C 端工单结构 */
import { trpc } from "../../../lib/trpc";
import { ConsoleShell, DataTable, Metric, MetricGrid, Panel, useConsoleData } from "../console";

interface Payload {
  source: string;
  kb: { collections: number; documents: number; chunks: number };
  recentDocs: Array<{ title: string; status: string; at: string }>;
  calls: Array<{ intent: string; at: string }>;
  tickets: Array<{ kind: string; n: number }>;
}

export default function ServiceFront() {
  const state = useConsoleData<Payload>(() => trpc.acquisition.serviceFront.query() as unknown as Promise<Payload>);
  const data = state.data;
  return (
    <ConsoleShell title="语音前台与 FAQ 自生长" desc="重复咨询靠知识库自动应答，电话与四路询盘按意图归档——承接能力决定留资率"
      source={data?.source} state={state}>
      <MetricGrid>
        <Metric label="知识库集合" value={data?.kb.collections ?? 0} />
        <Metric label="知识条目" value={data?.kb.documents ?? 0} hint={`切片 ${data?.kb.chunks ?? 0} 块`} />
        <Metric label="电话记录" value={data?.calls.length ?? 0} hint="phone_call.log" />
        <Metric label="C 端工单类型" value={data?.tickets.length ?? 0} />
      </MetricGrid>
      <Panel title="知识库最近更新">
        <DataTable
          columns={[
            { key: "title", title: "文档", render: (row) => row.title },
            { key: "status", title: "状态", render: (row) => row.status },
            { key: "at", title: "入库时间", render: (row) => row.at.slice(0, 16).replace("T", " ") },
          ]}
          rows={data?.recentDocs ?? []}
          empty="知识库还没有文档。"
        />
      </Panel>
      <Panel title="电话意图归档">
        <DataTable
          columns={[
            { key: "intent", title: "意图", render: (row) => row.intent },
            { key: "at", title: "时间", render: (row) => row.at.slice(0, 16).replace("T", " ") },
          ]}
          rows={data?.calls ?? []}
          empty="尚无电话记录（语音通道落地前由前台人工接听、助手归档）。"
        />
      </Panel>
      <Panel title="C 端工单结构">
        <DataTable
          columns={[
            { key: "kind", title: "类型", render: (row) => row.kind },
            { key: "n", title: "数量", render: (row) => row.n },
          ]}
          rows={data?.tickets ?? []}
          empty="暂无 C 端工单。"
        />
      </Panel>
    </ConsoleShell>
  );
}
