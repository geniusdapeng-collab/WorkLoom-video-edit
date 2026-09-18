/** p11 价格健康：调价留痕、围栏命中、渠道倒挂/房态异常——价格竞争力是获客的地基 */
import { trpc } from "../../../lib/trpc";
import { ConsoleShell, DataTable, Metric, MetricGrid, Panel, useConsoleData } from "../console";

interface Payload {
  source: string;
  business: { floor_price?: number; price_bands?: Record<string, [number, number]> } | null;
  calendar: Record<string, unknown> | null;
  fenceHits: Array<{ ruleId: string; n: number }>;
  adjustments: Array<{ roomType: string | null; afterPrice: number | null; rules: string[]; at: string }>;
  parityAnomalies: Array<{ summary: string; at: string }>;
}

export default function PriceHealth() {
  const state = useConsoleData<Payload>(() => trpc.acquisition.priceHealth.query() as unknown as Promise<Payload>);
  const data = state.data;
  const bands = Object.entries(data?.business?.price_bands ?? {});
  return (
    <ConsoleShell title="价格健康" desc="调价是否在宪章报价带内、渠道是否倒挂、房态是否同步——先守住价格纪律再要流量"
      source={data?.source} state={state}>
      <MetricGrid>
        <Metric label="保底价" value={data?.business?.floor_price ? `¥${data.business.floor_price}` : "未建档"} hint="低于即熔断（R2）" />
        <Metric label="房型价带" value={bands.length} hint="一店一档声明" />
        <Metric label="围栏命中" value={data?.fenceHits.reduce((sum, row) => sum + row.n, 0) ?? 0} hint="近 30 天" />
        <Metric label="渠道异常" value={data?.parityAnomalies.length ?? 0} hint="倒挂/房态未同步" />
      </MetricGrid>
      <Panel title="价带现状（一店一档）">
        <DataTable
          columns={[
            { key: "room", title: "房型", render: (row) => row.room },
            { key: "band", title: "价带", render: (row) => `¥${row.lower} – ¥${row.upper}` },
            { key: "anchor", title: "锚点", render: (row) => `¥${Math.round((row.lower + row.upper) / 2)}` },
          ]}
          rows={bands.map(([room, band]) => ({ room, lower: band[0], upper: band[1] }))}
          empty="尚未建档房型价带（一店一档 business.price_bands）。"
        />
      </Panel>
      <Panel title="近期调价">
        <DataTable
          columns={[
            { key: "room", title: "房型", render: (row) => row.roomType ?? "未标注" },
            { key: "price", title: "调后价", render: (row) => (row.afterPrice === null ? "—" : `¥${row.afterPrice}`) },
            { key: "rules", title: "围栏判定", render: (row) => (row.rules.length ? row.rules.join("、") : "无规则命中") },
            { key: "at", title: "时间", render: (row) => row.at.slice(0, 16).replace("T", " ") },
          ]}
          rows={data?.adjustments ?? []}
          empty="暂无调价留痕。"
        />
      </Panel>
      <Panel title="渠道倒挂 / 房态异常">
        <DataTable
          columns={[
            { key: "summary", title: "异常", render: (row) => row.summary },
            { key: "at", title: "发现时间", render: (row) => row.at.slice(0, 16).replace("T", " ") },
          ]}
          rows={data?.parityAnomalies ?? []}
          empty="巡检未发现倒挂或房态异常。"
        />
      </Panel>
    </ConsoleShell>
  );
}
