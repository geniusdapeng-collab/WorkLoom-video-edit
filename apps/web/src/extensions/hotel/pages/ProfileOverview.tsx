/** p20 一店一档全景：融合档案模块、围栏、编制来源、技能装配——获客系统的"身份与边界" */
import { trpc } from "../../../lib/trpc";
import { ConsoleShell, DataTable, Metric, MetricGrid, Panel, useConsoleData } from "../console";

interface Payload {
  source: string;
  industry: string | null;
  modules: string[];
  forbidden: string[];
  journey: Record<string, unknown> | null;
  fence: { rules: number; baseline: number };
  roster: Array<{ bundle: string; n: number }>;
  skillsInstalled: number;
}

export default function ProfileOverview() {
  const state = useConsoleData<Payload>(() => trpc.acquisition.profileOverview.query() as unknown as Promise<Payload>);
  const data = state.data;
  return (
    <ConsoleShell title="一店一档全景" desc="融合档案（酒店经营 + 获客资产）、围栏并集、编制来源与技能装配——一店一档是这家店在系统里的全部身份"
      source={data?.source} state={state}>
      <MetricGrid>
        <Metric label="档案模块" value={data?.modules.length ?? 0} hint="一店一档字段组" />
        <Metric label="生效围栏" value={data?.fence.rules ?? 0} hint={`其中基线 ${data?.fence.baseline ?? 0} 条`} />
        <Metric label="在册员工" value={data?.roster.reduce((sum, row) => sum + row.n, 0) ?? 0} />
        <Metric label="已装技能" value={data?.skillsInstalled ?? 0} />
      </MetricGrid>
      <Panel title="编制来源（融合体口径）" hint="同名岗位按主包裁决，遮蔽留痕在 agents.meta">
        <DataTable
          columns={[
            { key: "bundle", title: "来源行业包", render: (row) => row.bundle },
            { key: "n", title: "岗位数", render: (row) => row.n },
          ]}
          rows={data?.roster ?? []}
          empty="尚未装配数字员工。"
        />
      </Panel>
      <Panel title="档案模块清单" hint={data?.journey ? `旅程：${JSON.stringify(data.journey)}` : undefined}>
        <div className="flex flex-wrap gap-2">
          {(data?.modules ?? []).map((module) => (
            <span key={module} className="rounded border border-line px-2 py-0.5 text-body text-ink2">{module}</span>
          ))}
          {(data?.modules ?? []).length === 0 && <span className="text-body text-ink3">一店一档尚未建档。</span>}
        </div>
      </Panel>
      <Panel title="禁用承诺（硬约束）">
        {(data?.forbidden ?? []).length === 0
          ? <span className="text-body text-ink3">未声明禁用承诺。</span>
          : (
            <ul className="list-disc pl-5 text-body text-ink2">
              {(data?.forbidden ?? []).map((item) => <li key={item}>{item}</li>)}
            </ul>
          )}
      </Panel>
    </ConsoleShell>
  );
}
