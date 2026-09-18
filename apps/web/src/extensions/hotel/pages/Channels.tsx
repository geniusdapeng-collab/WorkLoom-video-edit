/** p14 渠道巡检与内容留痕：渠道清单、巡检异常、内容生产/发布节奏 */
import { trpc } from "../../../lib/trpc";
import { ConsoleShell, DataTable, Metric, MetricGrid, Panel, useConsoleData } from "../console";

interface Payload {
  source: string;
  channels: Array<{ name?: string; kind?: string; channel_new?: boolean }>;
  audience: Record<string, unknown> | null;
  anomalies: Array<{ summary: string; source: string; at: string }>;
  content: Array<{ action: string; n: number }>;
  publishes: Array<{ platform: string; n: number }>;
}

export default function Channels() {
  const state = useConsoleData<Payload>(() => trpc.acquisition.channels.query() as unknown as Promise<Payload>);
  const data = state.data;
  const newChannels = (data?.channels ?? []).filter((channel) => channel.channel_new).length;
  return (
    <ConsoleShell title="渠道巡检与内容留痕" desc="OTA/社媒/直连三类渠道的经营状态、异常发现与内容发布节奏——触达要按渠道算账"
      source={data?.source} state={state}>
      <MetricGrid>
        <Metric label="在营渠道" value={data?.channels.length ?? 0} />
        <Metric label="新渠道" value={newChannels} hint="首发必审（G9）" />
        <Metric label="巡检异常" value={data?.anomalies.length ?? 0} hint="近 30 条滚动" />
        <Metric label="内容事件" value={data?.content.reduce((sum, row) => sum + row.n, 0) ?? 0} hint="近 30 天草稿/发布" />
      </MetricGrid>
      <Panel title="渠道清单（一店一档）">
        <DataTable
          columns={[
            { key: "name", title: "渠道", render: (row) => row.name ?? "—" },
            { key: "kind", title: "类型", render: (row) => row.kind ?? "—" },
            { key: "new", title: "新渠道", render: (row) => (row.channel_new ? "是（首发必审）" : "否") },
          ]}
          rows={data?.channels ?? []}
          empty="一店一档尚未声明渠道清单。"
        />
      </Panel>
      <Panel title="内容生产与发布">
        <div className="grid gap-3 md:grid-cols-2">
          <DataTable
            columns={[
              { key: "action", title: "内容动作", render: (row) => row.action },
              { key: "n", title: "次数", render: (row) => row.n },
            ]}
            rows={data?.content ?? []}
            empty="近 30 天没有内容生产/发布事件。"
          />
          <DataTable
            columns={[
              { key: "platform", title: "发布平台", render: (row) => row.platform },
              { key: "n", title: "发布数", render: (row) => row.n },
            ]}
            rows={data?.publishes ?? []}
            empty="暂无发布留痕（发布动作必审 G9）。"
          />
        </div>
      </Panel>
      <Panel title="巡检发现（渠道/房态/评价）">
        <DataTable
          columns={[
            { key: "summary", title: "发现", render: (row) => row.summary },
            { key: "source", title: "来源", render: (row) => row.source },
            { key: "at", title: "时间", render: (row) => row.at.slice(0, 16).replace("T", " ") },
          ]}
          rows={data?.anomalies ?? []}
          empty="巡检未发现异常。"
        />
      </Panel>
    </ConsoleShell>
  );
}
