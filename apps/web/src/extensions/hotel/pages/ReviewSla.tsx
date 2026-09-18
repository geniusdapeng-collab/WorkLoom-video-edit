/** p15 差评 SLA：差评必审（R6）执行情况、响应留痕、待批队列 */
import { trpc } from "../../../lib/trpc";
import { ConsoleShell, DataTable, Metric, MetricGrid, Panel, useConsoleData } from "../console";

interface Payload {
  source: string;
  pendingApprovals: number;
  replies: Array<{ action: string; rating: number | null; rules: string[]; at: string }>;
  findings: Array<{ summary: string; at: string }>;
}

export default function ReviewSla() {
  const state = useConsoleData<Payload>(() => trpc.acquisition.reviewSla.query() as unknown as Promise<Payload>);
  const data = state.data;
  const badReviews = (data?.replies ?? []).filter((row) => row.rating !== null && row.rating <= 3).length;
  return (
    <ConsoleShell title="差评 SLA" desc="差评（≤3 分）必审挂起、回复留痕与评价异常——口碑是酒店获客的复利"
      source={data?.source} state={state}>
      <MetricGrid>
        <Metric label="评价事件" value={data?.replies.length ?? 0} hint="拉取/回复/围栏命中" />
        <Metric label="差评（≤3 分）" value={badReviews} hint="必审挂起（R6）" />
        <Metric label="待批评价类" value={data?.pendingApprovals ?? 0} hint="等人工确认后发布" />
        <Metric label="评价扫描异常" value={data?.findings.length ?? 0} />
      </MetricGrid>
      <Panel title="评价处理留痕">
        <DataTable
          columns={[
            { key: "action", title: "动作", render: (row) => row.action },
            { key: "rating", title: "评分", render: (row) => (row.rating === null ? "—" : `${row.rating} 分`) },
            { key: "rules", title: "围栏", render: (row) => (row.rules.length ? row.rules.join("、") : "无命中") },
            { key: "at", title: "时间", render: (row) => row.at.slice(0, 16).replace("T", " ") },
          ]}
          rows={data?.replies ?? []}
          empty="暂无评价处理留痕。"
        />
      </Panel>
      <Panel title="评价扫描发现">
        <DataTable
          columns={[
            { key: "summary", title: "发现", render: (row) => row.summary },
            { key: "at", title: "时间", render: (row) => row.at.slice(0, 16).replace("T", " ") },
          ]}
          rows={data?.findings ?? []}
          empty="评价巡检未发现异常。"
        />
      </Panel>
    </ConsoleShell>
  );
}
