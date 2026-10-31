# T-2026-1030-9010 下游视频消费仓回扫

## 覆盖率声明

- 回扫仓库总数：5；精读：2；定向精读：1；机检：2；未读：0。
- 精读：`workloom`、`WorkLoom-growth` 的 `VideoStudio.deferRender` 与营销事实入口。
- 定向精读：`hyperreality-system` 的 GitHub `main` 视频工作室内核与营销路径。
- 机检：`workloom-growthtest`、`workloom-growthmatrix` 的 GitHub `main` 同源代码指纹。

## 证据分级

- **A**：`workloom` 与 `WorkLoom-growth` 的本轮代码修改、测试和 TypeScript 运行结果。
- **B**：五个仓 GitHub `main` 的 `git fetch`、`git grep` 与文件树机检。
- **D**：后续发布时序与剩余正向压测判断。

## 回扫矩阵

| 仓 | GitHub main | 同源缺口 | 处置 | 证据 |
|---|---|---|---|---|
| `WorkLoom-video-edit` | `463ae7a`（任务起点） | `deferRender` 未跳过后处理；可选品牌未与显式查询对账 | 本任务修复 | MC-021、MC-022；`deferRender` 与品牌回归测试 |
| `workloom` | `f608da6` | 两处同源缺口均存在 | 修复于 `10d6740` | 3 个相关测试文件 58/58；`apps/server`、`packages/video-studio` TypeScript 检查通过 |
| `WorkLoom-growth` | `59d5010` | `deferRender` 同源缺口存在；未发现本轮营销事实入口 | 修复于 `d19d272` | `studio.test.ts` 23/23；`packages/video-studio` TypeScript 检查通过 |
| `hyperreality-system` | `08df432` | GitHub main 的 `packages/video-studio` 无 `deferRender`/`skipPostProduction` 接缝，也未发现本任务同源 `marketing-facts`/`marketing-authority` 路径 | not applicable | B：`git grep` 0 命中；文件树无对应营销事实实现 |
| `workloom-growthtest` | `6484e4f` | `deferRender` 同源缺口存在 | 不修改：隔离副本 `none-in-none-out` | B：`studio.ts` 仅设置 `skipRender` |
| `workloom-growthmatrix` | `20163c6` | `deferRender` 同源缺口存在 | 不修改：隔离副本 `none-in-none-out` | B：`studio.ts` 仅设置 `skipRender` |

## 根因与修复

### 1. 预渲染停止点

vendor 同时支持 `skipRender` 与 `skipPostProduction`。宿主只设置 `skipRender` 时，后期仍读取不存在的
`shot-*.mp4`，最终以 `POST_RENDER_PROVIDER_SUCCESS_REQUIRED` 把已通过 G1-G7 的预生产标记为失败。

受控仓修复统一为：

```text
deferRender=true
→ createOptions.skipRender=true
→ createOptions.skipPostProduction=true
```

普通非 `deferRender` 运行不设置 `skipPostProduction`，既有完整制片路径保持原行为。

### 2. 可选品牌与显式查询冲突

官方页面可能把项目所属基金会、发行方或赞助方放在商品名附近。模型将
`Open Home Foundation` 填成 Home Assistant 的品牌后，语义审核会且应当拒绝。

`workloom` 与主仓均在事实绑定层仅移除冲突的可选 `identity.brand` 及其 citation；
商品名、规格、卖点、原始来源和其他主张不变。显式品牌一致时不移除。

## 验证命令

```bash
# workloom
vitest run packages/video-studio/src/studio.test.ts \
  apps/server/src/video/marketing-facts.test.ts \
  apps/server/src/video/marketing-authority.test.ts
tsc -p packages/video-studio/tsconfig.json --noEmit
tsc -p apps/server/tsconfig.json --noEmit

# WorkLoom-growth
vitest run packages/video-studio/src/studio.test.ts
tsc -p packages/video-studio/tsconfig.json --noEmit
```

## 边界

- `workloom-growthtest` / `workloom-growthmatrix` 是 `none-in-none-out` 隔离副本。本轮只读确认缺口，
  未推送代码、未建立 PR、未修改分支保护或同步登记。
- 若产品所有者后续要求解除隔离，应先另开纳管任务卡，再在各自仓内复现、修复和验收。
- `hyperreality-system` 的 not-applicable 结论只针对本轮同源代码接缝，不代表其全部视频管线已经验收。
