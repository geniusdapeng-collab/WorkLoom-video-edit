# Jev 决策模型 · growth 影子评估（试点）

> 位置：`apps/server/src/industry/geo-growth/jev/`（行业侧，`base-sync` 排除路径，不改基座契约）
> 通道：**Vercel AI Gateway**（`typesafe-ai/jev`，evaluation 协议 v4）
> 状态：影子评估（shadow）——只产出报告，**不写业务库、不发外发通道、不替代任何围栏**

## 1. 为什么做、边界是什么

**做**：把 growth 里最高频的三个「判断类」环节交给决策模型（Jev）做影子对照，用真实业务样本量出
「准确率 / 校准 / 成本 / 延迟 / 可自动比例」五个数，再决定是否值得进基座或进生产链路。

| 场景 | 对应现有位点 | 说明 |
|---|---|---|
| `comment-classify` | `bundles/geo-growth/model-policy.yml` 的 `comment-classify`（L1、谷时批量） | 社媒评论/私信初筛：意图 + 是否线索 + 是否需人工 |
| `lead-qualify` | 同上的 `lead-qualify`（L2） | 线索意向强度（有序档位）+ 预算/时间/决策人三个事实问题 |
| `fact-precheck` | 围栏 `G-GEO2`（事实红线一票否决）的人工前置 | 草稿前提是否在官方口径内 / 是否编造具体信息 / 是否品牌表态 |

**不做（硬边界）**：

- `fact-precheck` 的结论**不满足**围栏 `G-GEO2` 的 `context.fact_check_passed` 条件——它只是影子预检；
- 任何真实动作（外发、回复、发布、改库）仍走「先围栏后动作」；本模块输出的 `route=auto` 只代表
  "这条在影子里可以自动"，**不是执行授权**；
- 品牌实体逐字一致性、数字/日期比较一律留在代码里（官方 jaggedness 明确模型在这些点上不可靠）；
- 客户原始数据不落库、不进仓库、不进日志：数据集必须事先脱敏，日志只打印 id/决策/置信度。

## 2. 快速开始

```bash
# ① 离线全链路（本地模拟网关，无 key、无外呼）：先确认协议与报告口径
pnpm tsx apps/server/src/industry/geo-growth/jev/cli.ts --scene comment-classify --exam --mock

# ② 用真实业务样本跑影子（数据集必须脱敏；JSONL：{id, text, expected?, context?, officialClaims?}）
pnpm tsx apps/server/src/industry/geo-growth/jev/cli.ts --scene comment-classify --dataset ./local-comments.jsonl

# ③ 首次接真 key：先抓原始响应，钉死解析口径
AI_GATEWAY_API_KEY=<key> pnpm tsx apps/server/src/industry/geo-growth/jev/cli.ts \
  --scene comment-classify --dataset ./local-comments.jsonl --limit 3 --capture-raw
```

### 2.1 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `AI_GATEWAY_API_KEY` | 无 | **必需**（真实网关）。在 Vercel 控制台 → AI Gateway → API Keys 创建；只进本机 `.env`/环境，绝不进仓库 |
| `JEV_BASE_URL` | `https://ai-gateway.vercel.sh` | 网关根地址 |
| `JEV_MODEL` | `typesafe-ai/jev` | 模型 id（同页还可跑 `inception/mercury-2.5` 作文本 helper） |
| `JEV_TIMEOUT_MS` | `20000` | 单次请求硬超时 |

CLI 参数：`--scene` `--dataset` `--exam` `--out` `--limit` `--concurrency` `--max-cost-usd`
`--mock` `--capture-raw` `--model` `--base-url` `--timeout-ms`（`--help` 查看全部）。

## 3. 输出与判读

输出目录（默认 `data/jev-shadow/<scene>-<时间戳>/`——`data/` 是本仓已 gitignore 的本地证据目录，评估产物不进仓库）：

| 文件 | 内容 |
|---|---|
| `report.json` | 汇总：`accuracy` / `macroF1` / `ece` + `eceBins` / `costUsd` / `latency{p50,p95,max}` / `routes{auto,review,human}` / `autoRate` / `errors` |
| `outcomes.jsonl` | 每行：决策、置信度、路由、依据、token、延迟、是否正确 |
| `raw.json`（`--capture-raw`） | 原始响应，用于钉解析口径与排查 |

判读纪律：

1. **先看校准再看准确率**：`report.ece` 与 `eceBins` 决定自动档阈值。第三方早期实测显示高置信桶
   （≥0.9）与中低置信桶（0.3–0.7）差距极大，**不要用单一准确率数字决定全量自动**。
2. **派生置信度不得自动**：网关未回传 confidence 时，本模块派生并标记，`gating.ts` 会强制降级到人审。
3. **成本口径**：$0.042/1M 输入 token、输出免费；`--max-cost-usd` 是熔断线，不是预算建议。
4. **对照才有意义**：与既有 L1 档模型在**同一数据集**上的结果对照；只跑 Jev 单边不构成结论。

## 4. 试点→生产的分层路径（协议 §1.4：合并在人）

```
① 影子评估（本模块，现在）        → 产出五项指标 + exam 卷面成绩
② 灰度（需人审）                  → 只对 comment-classify 开一条影子账本通道，人审率不降不得扩大
③ 基座提案（L2→L1→L0）            → 若值得，向 workloom-im 提「DecisionProvider」提案：
                                     model-router 新增决策模型档位 + 出站脱敏网关直连 + 考试院卷面
```

**为什么现在不进 model-router**：基座提供方契约是 OpenAI 兼容 chat（`messages → text`），而 Jev 是
evaluation 协议（`state + typed questions → typed answers`，官方明确不支持 OpenAI 兼容端点）。
硬塞会破坏"出站必经脱敏网关"的既有语义，因此先行业侧验证，再走提案。

## 5. 合规与安全

- **数据出站**：Vercel AI Gateway 目录中 `typesafe-ai/jev` 标注 `zdr: all`（零数据留存）与
  `no_training: all`（不用于训练）；接入前仍需按 WorkLoom 不变量走脱敏与出站声明。
- **秘密管理**：key 只从环境变量读取；`client.ts` 的错误消息只包含状态码与主机名，测试覆盖"key 不出现在错误里"。
- **失败语义**：4xx 中 401/403 立即失败（非重试）；429/5xx/超时按退避重试（只读调用，安全）；
  非法回答（未知选项、越界分数、概率异常）整体拒绝，**绝不猜测**。
- **预算熔断**：单次运行 `--max-cost-usd` 达到即停止调度新行，剩余行标记预算超限（不静默跳过）。

### 5.1 生产运行建议（影子期）

```bash
# 每日谷时跑一轮（示例：每周一 09:10，与 visibility-watch 周频采集同窗）
10 9 * * 1  cd <repo> && AI_GATEWAY_API_KEY=<key> pnpm tsx \
  apps/server/src/industry/geo-growth/jev/cli.ts \
  --scene comment-classify --dataset data/jev-shadow/input/comments.jsonl \
  --concurrency 2 --max-cost-usd 1 \
  --out data/jev-shadow/runs/$(date +\%Y\%m\%d)
```

- **监控口径**：`report.json` 的 `failed`（网关不可用）、`routes.auto/human`（分流漂移）、`costUsd`（预算）、`ece`（校准恶化）、`accuracy`（若带标签）。
- **告警阈值（建议起步值）**：`failed > 5%` 或 `ece > 0.15` 或 `accuracy` 环比下降 `>5pp` 即暂停自动档并回退全人审。
- **回退**：删掉定时任务即可；本模块只写 `data/**`，无业务副作用。
- **升级到灰度**：连续 2 周满足「准确率不低于现行 L1 档、`ece ≤ 0.12`、自动档样本 ≥500 条」后，再按第 4 节走基座提案。

## 6. 已知不确定性与首次接真 key 的必做动作

1. **网关响应形状**：本模块按 TypeSafe 官方文档 + 社区实现（PR #15/#28）兼容解析
   （`answers` 支持多层级、置信度支持 `providerMetadata.typesafe.confidence`）。
   首次接真 key 请务必 `--capture-raw --limit 3`，确认形状后如与解析不一致，改 `protocol.ts` 并补测试。
2. **中文准确率**：官方明确英文最佳、CJK "handled but not equally well"。本模块 instructions 全英文、
   state 为中文原文；**必须用考卷 + 真实样本实测**后才能定自动档阈值。
3. **限流**：官方限流动态调整（当前 250k tok/s、1200 RPM），网关侧另有免费档限流；批量跑请从
   `--concurrency 2` 起，观察 429 比例。

## 7. 测试

> 附：**NanoJev 评估结论（2026-09-19，暂不采用）**——社区开源平替
> [NanoJev](https://github.com/TianyuCodings/NanoJev)（MIT，Qwen3-0.6B + 决策头，契约与我们同构）曾在
> PR #57 接入本地通道，因其推理代码**硬依赖 CUDA**（`predict_toy_decisions.py` 显式检查 `torch.cuda`）、
> 且权重面向迷宫/贪吃蛇等游戏任务（非通用 Jev），在无 CUDA 的机器上不具可用性 → **已于 PR #58 完整回滚**。
> 将来若具备 CUDA 环境且需要"零调用成本的本地决策模型"，可重新评估（含其训练管线与 HF 数据集），
> 但须先用自己的标注数据微调并过考卷，再考虑进入判断链路。

```bash
# 本模块 39 个离线用例（协议/重试/超时/密钥安全/分流/指标/端到端）
node_modules/.bin/vitest run apps/server/src/industry/geo-growth/jev

# 类型检查（仓库 strict + noUncheckedIndexedAccess 口径）
node_modules/.bin/tsc --noEmit --strict --noUncheckedIndexedAccess --target ES2022 --module ESNext \
  --moduleResolution Bundler --lib ES2022 --types node --skipLibCheck --esModuleInterop \
  apps/server/src/industry/geo-growth/jev/*.ts
```

测试全部离线（本地模拟网关 `127.0.0.1`），不需要 key、不产生外呼。
