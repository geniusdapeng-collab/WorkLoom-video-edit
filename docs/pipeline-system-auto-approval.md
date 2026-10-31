# 视频管线系统自动裁决（2026-10-31）

## 当前口径

视频管线的 G1–G8 以及 G9–G15 中登记的外部动作不再创建
`approvals` 行、`pending_review` 任务或等待人工点击。每个门先执行确定性检查，
再由版本化 `video-system-auto-approval` 策略统一裁决：

- `passed`：artifact、fact hash、budget、qualification、permission 与 fence
  全部满足，管线可继续。
- `repair`：只有可局部修复的确定性检查失败；必须产生新 revision 并重新过同一门。
- `blocked`：事实过期、预算/资格/权限缺失、显式 fence block、策略不覆盖或
  全局 kill switch 关闭。

`PIPELINE_SYSTEM_AUTO_APPROVAL` 默认 `enforce`。设为 `off` 时保护动作失败关闭，
不会退回人工审批。

## 持久化

- `packages/pipeline-control/src/auto-approval.ts` 定义策略、检查项、receipt
  和 evidence digest。
- `packages/video-pipeline/src/auto-approval.ts` 绑定
  `video-system-auto-approval@2026-10-31.1` 与覆盖门清单。
- `video_gate_decisions.reviewer` 保存
  `kind=system_auto_approval`、完整 receipt、policy version、检查结果与
  evidence digest。
- `video_gate_decisions.status=blocked` 持久化不可继续的终态；迁移
  `0060_video_system_auto_approval.sql` 收紧 receipt 绑定的 gate、outcome、
  artifact hash、fact hash 与 checks 结构。
- 每次裁决同时写 `gate.decided` 与 `system-auto-approval` outbox 事件。

## 关键边界

- 系统裁决不是平台签名，也不是人工批准；它只能消费当前 run、当前 gate、
  当前 artifact manifest 与当前 plan。
- artifact/fact hash 漂移、check-set 或 rubric 版本漂移都失败关闭。
- `block` 不得被降级为 `review` 或 `passed`。
- 只有确定性局部问题可返回 `repair`；未知结果、权限、预算、资格与事实问题
  直接 `blocked`。
- 自动通过不能绕过供应商网络结果、发布回读或交付字节核验。

## 回滚

设置 `PIPELINE_SYSTEM_AUTO_APPROVAL=off`。不要删除迁移，也不要恢复
`approvals`/`pending_review` 路径；关闭策略只会让受保护动作失败关闭。

## 可执行证据

- `packages/video-pipeline/src/test/system-auto-approval.test.ts`
- `apps/server/src/video/gate-policy.test.ts`
- `apps/server/src/video/studio-worker.test.ts`
- `apps/server/src/video/production-router.test.ts`
- `apps/server/src/video/pipeline/pipeline-repository.pg.test.ts`
- `packages/base/{asset-cms,publish-rpa,social-listening}/**/*.test.ts`
