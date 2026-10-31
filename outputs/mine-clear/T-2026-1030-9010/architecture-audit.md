# WorkLoom Video 预生产架构审计

## 0. 结论

是架构问题，而不是单纯“模型不够强”或“提示词还不够长”。

当前链路能发现很多问题，但缺少把一次发现安全地转化为一次局部修复的能力：

- 一个 `preproduction` 外层阶段包住了主题、情报、G3、PRD、提示词、定妆照和 G7；
- G2/G3/G4 失败后没有“结构化 issue -> 精确修复 -> 同门复验 -> 下游失效 -> 续投”；
- 平台 PG 阶段账、档案 `manifest/events/stages`、CLI `stages.jsonl` 和门账本不是同一个状态机；
- YAML 描述的是期望拓扑，但运行时主要走 vendor 单体 `create()`，YAML 不是执行 DAG；
- 多套 retry/timeout/budget 各自为政，外层重跑经常重新调用上游模型；
- 宿主归一有时只改克隆对象，没有把新版本发布回 live run，导致“已修正”的合同仍被判变化。

因此“再跑几十次”只会重复采样本轮已经观测到的结构性故障。应先收敛运行模型，再继续 40 例压测。

## 1. 审计范围

精读或定向精读：

- `apps/server/src/video/studio-worker.ts`
- `apps/server/src/video/archive-resume.ts`
- `apps/server/src/video/film-ledger.ts`
- `apps/server/src/video/gate-ledger-bridge.ts`
- `scripts/tools/full-chain-film.mts`
- `packages/video-studio/src/studio.ts`
- `packages/video-studio/src/prd-authority-bridge.ts`
- `packages/video-studio/src/requirement-contract-bridge.ts`
- `packages/video-studio/src/requirement-contract.ts`
- `packages/video-studio/src/archive/stage-runner.ts`
- `packages/video-studio/src/archive/stage-log.ts`
- `packages/video-studio/src/archive/store.ts`
- `packages/video-studio/src/gate-ledger.ts`
- `bundles/ai-video/pipelines/marketing-film.yml`
- `bundles/ai-video/pipelines/narrative-film.yml`
- `docs/video-edit-architecture.md`
- `docs/pipeline-stages-and-gates-2026-09-24.md`

机检：

- 全仓搜索 YAML 加载器、retry、resume、checkpoint、stage ledger 消费点。
- 重点核实 YAML 是否被生产执行器读取，还是只被测试/审计引用。

未做：

- 未将 6,568 行 `full-chain-film.mts` 全文逐行纳入本轮架构报告，只精读了阶段账、G7 和恢复相关段落。
- 未审计全部 vendor agent 实现；以宿主 bridge、阶段注册表和实际运行证据为边界。

## 2. 当前实际运行模型

### 2.1 服务端

`studio-worker.ts` 建立 `StageRunner`，但实际只执行一个阶段：

```text
runner.run("preproduction", ...)
  -> prepareMarketingFacts / G1
  -> VideoStudio.runPreproduction
       -> vendor create()
       -> G2, G3, G4, G5, G6, G7
  -> prompt handoff
```

关键证据：

- `apps/server/src/video/studio-worker.ts:675` 创建 `StageRunner`。
- `apps/server/src/video/studio-worker.ts:1081` 只认领 `"preproduction"`。
- `apps/server/src/video/studio-worker.ts:1075` 的 `VM_PRODUCER_RETRY` 重新执行同一个 `runner.run("preproduction")`。

后果：数据库中的 `production_stage_runs` 只能看到外层 `preproduction`，看不到 G2/G3/G4/G6 各自的有效产物、失败原因和可复用前缀。

### 2.2 恢复入口

`archive-resume.ts` 按 stage 最新 attempt 找断点，但对预生产只返回：

```text
startRun(preproduction)
```

关键证据：

- `apps/server/src/video/archive-resume.ts:210`
- `apps/server/src/video/archive-resume.ts:226`
- `apps/server/src/video/archive-resume.ts:233`

源码注释明确承认 vendor checkpoint 在真实模型下常因指纹变化失效，可能全量重跑。

### 2.3 CLI

CLI 有更细的 `stages.jsonl`，但这是第二套账：

- `scripts/tools/full-chain-film.mts:553`
- `scripts/tools/full-chain-film.mts:1052`
- `scripts/tools/full-chain-film.mts:1095`

它支持 `--stages` 局部重跑和后段读取历史，但服务端没有读取同一份账本来恢复预生产子阶段。

### 2.4 工作/成本账

`FilmLedger` 自己维护 `film_jobs` 和 `film_component_requests`：

- `apps/server/src/video/film-ledger.ts:238`
- `apps/server/src/video/film-ledger.ts:259`

这比 `production_stage_runs` 更接近正确的 stage/component 粒度，但 Studio 预生产没有消费它。

### 2.5 YAML

`marketing-film.yml` 和 `narrative-film.yml` 声明了步骤、owner、outputs 和 gate。运行时没有生产加载器执行这些拓扑；搜索结果显示主要是测试、审计和 step_key 映射在读 YAML。

关键证据：

- `bundles/ai-video/pipelines/marketing-film.yml:7`
- `bundles/ai-video/pipelines/narrative-film.yml:7`
- `packages/video-studio/src/gate-ledger.ts` 只消费 step_key 映射，不执行 DAG。

结论：YAML 是规格文档，不是运行事实源。

## 3. 根因分层

| ID | 级别 | 问题 | 代码证据 | 实际后果 |
|---|---|---|---|---|
| A1 | P0 | 预生产恢复粒度太粗 | `studio-worker.ts:1081` | G4 失败重跑 G1-G3 |
| A2 | P0 | 无结构化修复协议 | `onApproval` 只返回 verdict；拒绝后 vendor 停 | 下轮没有携带具体 issue，仍靠重新采样 |
| A3 | P0 | 多账本、多状态机 | `production_stage_runs`、archive、`stages.jsonl`、`film_jobs` | 无法回答唯一有效产物和失效面 |
| A4 | P0 | 规范化结果未发布为 live revision | `requirement-contract.ts` 原实现只改 clone | 宿主修正后仍报 `REQUIREMENT_CONTRACT_CHANGED` |
| B1 | P1 | YAML 非执行 DAG | YAML 主要是文档 | 改拓扑不会影响运行 |
| B2 | P1 | Gate 主输入是 markdown | `studio.ts:296-323` | 结构字段隐藏于文本，审查随机且难做局部 patch |
| B3 | P1 | 生成、归一、验证、门审、提交没有分层 | vendor bridge + monkey patch | 修复动作与 hash/lineage 交叉，产生大量“合同变化” |
| B4 | P1 | 多个 retry 预算独立 | source retry、Scene/Risk retry、Producer retry、外层 retry | 费用/时延不可预测，重复调用 |
| B5 | P1 | 缺少逐阶段 artifact 引用 | StageRunner 只存整个结果摘要 | 子阶段产物只能依赖 vendor 内存/日志 |
| C1 | P2 | 可观测性部分丢失 | 实跑出现 `PipelineLogger: [object Promise]` | 失败结果与报告丢失 |
| C2 | P2 | 全局 vendor 单实例锁 | `run-coordinator.js` | 多项目无法并行，压测被迫串行 |

## 4. 本轮失败为何会“连续几十次”

以 M01 为例，实际闭环被拆成了多个互不衔接的控制面：

```text
source fetch timeout
  -> 只记录 outer preproduction failed
  -> 下一轮重新 source fetch + extraction
G1 request/summary mismatch
  -> 修正 cards/dossier
  -> 重跑 source + extraction + G1
G2 no-person violation
  -> 修正 theme
  -> 重跑 G1 path
G3 duration/audience issue
  -> 修正 discovery
  -> 重跑 G1/G2
G4 PRD external/person/delivery issue
  -> 修正 PRD
  -> 再次跑上游
post-approval suggestions bug
  -> G4 已通过仍触发 PRD regeneration
```

每次修复都可能是正确的，但执行框架没有保存“哪一版已通过、哪一版失效”。于是修复在架构上等价于“换一份输入，从最前面重新抽卡”。

## 5. 两个候选改造方案

### 方案 A：继续修单体 `runPreproduction`

做法：

- 继续增加 host normalizer；
- 增加更多 vendor monkey patch；
- 外层增加更多 retry；
- 在最终 Markdown 上继续补正则。

优点：

- 改动局部；
- 现有产品入口不动；
- 短期可继续修复个别 case。

缺点：

- 无法获得精确恢复；
- 状态仍是多份；
- 新 normalizer 会继续改变 hash/lineage；
- 模型新增一种错误就要再加一组补丁；
- 40 例压测不可复现为阶段级证据。

结论：只能止血，不能作为生产架构。

### 方案 B：保留 vendor 作为“生成适配器”，外层改成 Stage DAG

做法：

1. 预生产拆成至少以下节点：

   ```text
   route
   -> source_book
   -> facts_extract
   -> facts_validate
   -> g1
   -> theme_generate
   -> theme_normalize
   -> theme_validate
   -> g2
   -> discovery_generate
   -> discovery_normalize
   -> discovery_validate
   -> g3
   -> prd_generate
   -> prd_normalize
   -> prd_validate
   -> g4
   -> script -> prompts -> g6 -> g7
   ```

2. 每个节点只接受显式 input artifact，产生不可变 output artifact。
3. Gate 节点只读取上一步已归一、已验证的 artifact。
4. 拒绝 verdict 产生 `RepairPacket`，不是直接重跑整段。
5. 修复成功产生新 artifact revision，只把依赖它的后代标 stale。
6. 重试次数、时间、token、费用都绑定到 node revision。

优点：

- 可精确定位失败；
- G4 修复不重跑 G1-G3；
- 每个阶段可测试；
- 可将 vendor 封装为 generate adapter，避免一次性重写；
- 服务端与 CLI 共享同一状态契约。

缺点：

- 需要新增 DAG runner、artifact store、repair protocol；
- 旧 vendor 内部耦合需要逐步剥离；
- 过渡期要双写并做一致性校验。

结论：选择方案 B。第一阶段可把 vendor 的单体 create 拆出一个“检查点适配器”，再逐步把每个已暴露节点变成独立 node。

## 6. 目标状态模型

### 6.1 运行事实

建议新增统一 `PipelineRunState`：

```json
{
  "schemaVersion": "workloom.video-pipeline-run/v1",
  "runId": "RUN-...",
  "projectId": "VID-...",
  "pipelineKind": "marketing",
  "topologyHash": "<sha256>",
  "status": "running",
  "nodes": {
    "g3": {
      "state": "approved",
      "revision": 3,
      "artifact": {
        "ref": "artifacts/g3/r3.json",
        "sha256": "<64hex>",
        "schema": "workloom.requirement-contract/v1"
      },
      "gate": {
        "verdict": "approved",
        "hardFailures": [],
        "blockingIssues": [],
        "advisories": []
      },
      "attempts": [],
      "budget": {
        "timeMsUsed": 0,
        "tokensUsed": 0,
        "cnyUsed": 0
      }
    }
  },
  "edges": [
    { "from": "g3", "to": "prd", "invalidation": "digest-changed" }
  ]
}
```

### 6.2 节点必须拆分五类动作

每个内容节点按同一顺序执行：

```text
generate
  -> normalize
  -> validate-schema
  -> gate
  -> commit
```

- `generate` 只生成候选，不允许直接进入下游；
- `normalize` 记录确定性 patch 列表和 input/output hash；
- `validate-schema` 只看结构；
- `gate` 分 hardFailures / blockingIssues / advisories；
- `commit` 才把 revision 设为 canonical。

这能避免当前 `PRD normalize` 在 contract hash 之后发生，导致“修了但又被判变”。

### 6.3 RepairPacket

```json
{
  "schemaVersion": "workloom.video-repair-packet/v1",
  "nodeId": "prd",
  "baseArtifactSha256": "<64hex>",
  "hardFailures": [],
  "blockingIssues": [
    {
      "id": "external-reference",
      "path": "$.referenceCases.filmReferences",
      "message": "客户未提供该影片",
      "allowedFix": "replace",
      "evidence": ["gate-event-id"]
    }
  ],
  "advisories": [],
  "forbiddenFix": ["不得降低 gate 阈值", "不得删除问题项"],
  "remainingBudget": {
    "attempts": 1,
    "tokens": 8000,
    "timeMs": 120000
  }
}
```

修复器只接收 packet + base artifact，不重新生成无关上游。

### 6.4 单一状态源

建议：

- 不可变 artifact 和追加事件是权威本体；
- PG `production_stage_runs` 是服务器查询投影；
- CLI `stages.jsonl` 可以保留，但必须是同一 event schema 的 append-only 视图；
- `film_jobs` 负责外部付费组件幂等与预算，不另定义内容阶段状态；
- 每个 artifact 的 nodeId/revision/parentHashes/owner/gate verdict 在所有入口一致。

迁移期可采用“文件 artifact 为源，PG 只投影”的方式，避免数据库不可用时 CLI 无法运行。

## 7. 迁移顺序

### Phase 0：立即止血

- 禁止默认整段 `preproduction` 自动重试；
- 保存失败 gate 的 `RepairPacket`；
- 将已批准且 suggestions 非空视为 advisory，不触发重写；
- 规范化结果必须回写 live run；
- 所有重试显示累计 time/token/attempt budget。

### Phase 1：Stage DAG runner

- 定义 `video-pipeline-topology/v1`；
- 从 YAML 读取 node/edge，而不是维护第二份拓扑；
- 先包装现有 `prepareMarketingFacts`、`VideoStudio.runPreproduction` 为 adapter node；
- 暴露 `g1/g2/g3/g4/g6/g7` 的 artifact 与 verdict。

### Phase 2：精确恢复与失效传播

- G4 失败只重跑 `prd_generate -> prd_normalize -> prd_validate -> g4`；
- G3 失败只重跑 discovery 链，不重跑 G1；
- G2 失败只重跑 theme 链，不重跑 G1；
- artifact digest 变化时，按 edge 自动将后代标 stale。

### Phase 3：Schema 和 Gate 分层

- hardFailures 只能来自确定性校验或宿主规则；
- LLM reviewer 只增加 blockingIssue/advisory，必须带 artifact path 和证据；
- 同一 issue 重试后必须证明修复覆盖了同一路径；
- 删除“整篇 markdown 正则判结构”的主路径。

### Phase 4：统一账本与可观测性

- Studio、CLI、download/post/revise 共用 event schema；
- 每个 node 记录 input/output SHA、parents、model、attempt、cost、duration；
- PipelineLogger 改成 awaited，禁止 `[object Promise]`；
- 恢复视图必须能回答：
  - 当前 canonical artifact 是谁；
  - 哪个 gate 阻止下游；
  - 哪个后代已 stale；
  - 下一次只需运行哪些 nodes。

## 8. 验收标准

架构升级完成至少满足：

1. 同一 case 的 G2 拒绝后，G1 结果 hash 与本轮 G1 相同，G1 模型调用次数为 0。
2. G3 拒绝后，G1/G2 artifact hash 不变，G3 修复产生新 revision。
3. G4 拒绝后，只产生 PRD 新 revision；G1-G3 模型调用为 0。
4. Gate approved + advisory 不产生任何下游 rewrite。
5. 每个 node 的 input/output SHA 可从统一状态回读。
6. CLI 与服务端对同一 artifact 得到同一门结果。
7. 预算闸按 node 记录并阻止超额调用。
8. 失败恢复不会清空 vendor checkpoint 证据。

## 9. 当前决策

采用方案 B 的增量路线：

- 保留 vendor 作为生成器；
- 新增宿主 Stage DAG 和 RepairPacket；
- 先把 G1-G4 拆成可恢复节点；
- 再迁移 G6/G7 与生产后期；
- 在拆分完成前，不再把“全流程重跑”当作修复验证。

## 10. 不解决的问题

本轮架构改造不负责：

- 自动判断创意是否艺术优秀；
- 替代客户业务确认；
- 自动执行真实渲染或发布；
- 自动修复所有模型语义错误；
- 把模型评分当作事实真值。

它的目标是让每次失败成为可定位、可局部修复、可复验、可失效传播的工程事件。
