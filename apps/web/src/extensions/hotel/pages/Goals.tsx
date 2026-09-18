/** p12 目标仪表盘：年度/月度目标 + 偏差跟踪 + 补救举措（获客目标要落到节拍上） */
import { trpc } from "../../../lib/trpc";
import { ConsoleShell, DataTable, Metric, MetricGrid, Panel, useConsoleData } from "../console";

interface Payload {
  source: string;
  goals: Record<string, unknown> | null;
  tracking: Array<{ after: Record<string, unknown>; at: string }>;
  initiatives: Array<{ action: string; n: number }>;
}

export default function Goals() {
  const state = useConsoleData<Payload>(() => trpc.acquisition.goals.query() as unknown as Promise<Payload>);
  const data = state.data;
  const year = (data?.goals?.year ?? null) as Record<string, unknown> | null;
  const month = Object.entries(data?.goals ?? {}).find(([key]) => key.startsWith("month_")) ?? null;
  const latest = data?.tracking[0]?.after ?? null;
  const deviation = typeof latest?.deviation_pt === "number" ? latest.deviation_pt : null;
  return (
    <ConsoleShell title="目标与偏差" desc="年度/月度经营目标、周度偏差回写与补救举措——目标不动，节奏就散"
      source={data?.source} state={state}>
      <MetricGrid>
        <Metric label="年度营收目标" value={year?.revenue ? `¥${Number(year.revenue).toLocaleString("zh-CN")}` : "未设置"} />
        <Metric label="年度 OCC 目标" value={year?.occ ? `${(Number(year.occ) * 100).toFixed(0)}%` : "—"} hint="入住率" />
        <Metric label="月度目标" value={month ? `${month[0].replace("month_", "")}` : "未设置"} hint={String((month?.[1] as Record<string, unknown> | undefined)?.note ?? "")} />
        <Metric label="最新偏差" value={deviation === null ? "暂无 tracking" : `${deviation} pt`}
          hint={deviation === null ? "等待周度回写" : deviation < 0 ? "落后目标，需补救" : "超目标"} />
      </MetricGrid>
      <Panel title="目标锚点（一店一档）" hint={String(data?.goals?.tracking ?? "")}>
        <DataTable
          columns={[
            { key: "key", title: "指标", render: (row) => row.key },
            { key: "value", title: "目标", render: (row) => row.value },
          ]}
          rows={year ? Object.entries(year).map(([key, value]) => ({ key, value: String(value) })) : []}
          empty="尚未在「一店一档」声明年度目标。"
        />
      </Panel>
      <Panel title="偏差跟踪（goal.tracking）">
        <DataTable
          columns={[
            { key: "metric", title: "指标", render: (row) => String(row.after.metric ?? "—") },
            { key: "target", title: "目标", render: (row) => String(row.after.target ?? "—") },
            { key: "actual", title: "实际", render: (row) => String(row.after.actual ?? "—") },
            { key: "deviation", title: "偏差(pt)", render: (row) => String(row.after.deviation_pt ?? "—") },
            { key: "at", title: "回写时间", render: (row) => row.at.slice(0, 16).replace("T", " ") },
          ]}
          rows={data?.tracking ?? []}
          empty="还没有周度偏差回写（goal.tracking）。"
        />
      </Panel>
      <Panel title="补救举措（initiative.*）">
        <DataTable
          columns={[
            { key: "action", title: "动作", render: (row) => row.action },
            { key: "n", title: "次数", render: (row) => row.n },
          ]}
          rows={data?.initiatives ?? []}
          empty="近 30 天没有触发补救举措。"
        />
      </Panel>
    </ConsoleShell>
  );
}
