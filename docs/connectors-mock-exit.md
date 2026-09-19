# 连接器接入与 mock 退出标准（G7）

> 依据《GROWTH 深度产品方案》§9 G7：首批 2 个真实连接器（广告投放网关 / 抖音开放平台）。
> 就绪检查：`pnpm connectors:check`；实现：`packages/base/connectors/`（fail-closed，缺凭证不回退 mock）。

## 1. 凭证（只进环境变量/秘密存储）

| 连接器 | 环境变量 | 用途 |
|---|---|---|
| ads-gateway | `ADS_GATEWAY_URL` · `ADS_GATEWAY_TOKEN` | Meta / 千川 投放指标（增量 ROI 事实源） |
| social-douyin | `DOUYIN_OPEN_URL` · `DOUYIN_ACCESS_TOKEN` · `DOUYIN_OPEN_ID` | 内容指标与评论拉取（选题/评论分流事实源） |

## 2. Mock 退出标准（逐条满足才允许对外宣称"真实连接"）

1. **来源标记**：事件账本中每条数据带 `params.connector = <id>` 与 `mode = live`；mock 数据必须显式标 `mode = mock`，两者在战报与归因中分列。
2. **对照验证**：切换后首个 7 天窗口内，live 与 mock（或人工抽录）双跑对照，关键指标差异 <5% 或差异原因可解释。
3. **失败关闭**：连接器不可用/限流/凭证过期 → 该链路标记"未核实"，不得以旧数据或 mock 顶上。
4. **速率与重试**：429/5xx 自动重试（默认 2 次，指数退避）；超时默认 10s；速率上限在 `registry.ts` 声明。
5. **回滚**：保留开关可整体回退到 mock；回退动作与原因入账本。

## 3. 当前状态

- 代码与契约测试已交付（缺凭证 fail-closed、429 重试、4xx 不重试、就绪报告）；
- 真实会话需客户/平台侧账号授权后注入上述环境变量（本机当前未配置）。
