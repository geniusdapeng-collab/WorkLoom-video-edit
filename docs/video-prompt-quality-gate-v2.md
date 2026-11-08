# 视频提示词质量与渲染资格 v2

适用范围：`WorkLoom-video-edit` 的叙事片、营销片预生产链。实现日期：2026-11-01。

## 1. 灰度开关

```text
PROMPT_CONTRACT_V2=off
PROMPT_CONTRACT_V2=shadow
PROMPT_CONTRACT_V2=enforce
```

- `off`：保持历史路径。内容镜与片头镜仍按旧 25/25 口径解释；不读取新合同，不改变请求。
- `shadow`：G6/G7 生成字段合同、五问评审、修复尝试和差异报告，但不改写 vendor prompt，也不阻断旧提交路径。
- `enforce`：G6 使用 `workloom.video-shot-card/v2`，内容镜必须 25 字段，片头必须 30 字段；G7 重新编译并校验哈希；G8 真实付费提交必须同时具备预算、当前资格和一次性人工授权单。

`shadow` 只用于校准。未达到稳定门槛前不要直接全量 enforce；切换回 `off` 时保留所有合同、报告、修复计划和历史门事件。

实际运行策略可在以下位置只读核对，不包含模型密钥、地址或其它秘密：

- `GET /health/product` 的 `videoPolicy`；
- `video.studio.policy`；
- `video.studio.status` 的 `effectivePolicy`；

该投影同时披露 `PROMPT_CONTRACT_V2`、制片自动重试次数、修复协调器、控制面和当前真正支持的管线。非法重试值或未知控制面值 fail-closed，不把拼写错误静默解释为 `off`。

## 2. 字段合同

代码事实源：

- `packages/video-studio/src/prompt-contract.ts`
- `packages/video-studio/src/prompt-compiler.ts`
- `packages/video-studio/src/shot-spec.ts`

字段顺序与消费渠道由代码生成，不维护第二份手写清单：

- 内容镜：`workloom.video-shot-card/v2`，25 字段。
- 片头镜：同一 v2 策略，25 个基础字段 + 5 个片头专属字段，共 30 字段。
- 每个字段至少绑定 `prompt`；技术字段同时绑定 `request`；`portraits` 同时绑定 `asset`；`transition` 与片头专属字段附加 `downstream`；资格相关字段附加 `eligibility`。

合同记录 `fieldsSha256`、`promptSha256`、`requestSha256`、字段到提示词片段的 span、请求键、资产字节摘要与下游契约。

## 3. G6 五问

语义评审只接受以下固定二元结果，任何一项不是 `pass=true` 都不能形成 G6 passed：

| ID | 问题 |
|---|---|
| `SQ1_SUBJECT_ACTION` | 主体是谁、在做什么，是否一眼明确？ |
| `SQ2_SCENE_PROPS` | 场景与道具是否服务内容，而非堆砌？ |
| `SQ3_CAMERA_FEASIBLE` | 镜头和运动是否能在目标时长内完成？ |
| `SQ4_LIGHT_COLOR` | 光影、构图和色调是否统一？ |
| `SQ5_PURPOSE` | 这一镜是否有明确叙事作用或传播价值？ |

失败项必须带字段、稳定 `failureCode`、字段证据和 repair 建议。无效 JSON/缺证据只允许一次技术性重问；重问仍无效只隔离该镜并记录 `technicalRetry=1`，不消耗内容修复次数。其它结构合法镜头仍可独立收敛，但整包不会在存在未解决镜头时通过。

## 4. 逐镜定点修复

每个失败镜头最多执行一次定点修复；多镜同时失败时共享同一份可审计 `RepairPlan` 预算，但修复请求、异常和复验状态逐镜隔离：

- playbook：`repair-prompt-semantic-fields-v1`
- `maxAttempts=1`
- 每个镜头的 allowlist 只来自该镜失败问题引用的字段
- 禁止修改事实、授权、时长、画幅、模型能力、门槛和其它字段
- 已通过镜头冻结并复用当前语义证明，不重新调用模型
- 只重新编译并复验实际发生修改的镜头；最终包仍执行合同清单、数量、哈希和五问汇总
- 修复 schema 从当前镜头的实际 `allowedFields` 生成，不再固定给 `camera_movement` 示例

单镜出现允许字段外修改、字段/提示词哈希未变化、复验仍有失败或合同编译失败时标记为 `quarantined`；结构硬错误标记为 `needs_upstream`；未知外部回执标记为 `unknown_receipt`。其它镜头继续收敛，但最终包只有全部必需镜头均为 `accepted` 或 `repaired` 才可形成 G6 passed。任何未解决镜头都不触发真实供应商 POST。

## 5. 证据

G6/G7 在制片工作区落盘：

```text
gates/<projectId>/attempt-<n>/
  prompt-quality/
    prompt-contract-<shotId>.json
    semantic-quality-report.json
    prompt-quality-decision.json
    prompt-semantic-repair-plan.json
    prompt-semantic-repair-attempt.json
  render-eligibility.json
```

每个文件记录 SHA-256；`semantic-quality-report.json` 同时保存每个镜头的 `shotOutcomes`，`prompt-semantic-repair-attempt.json` 保存 `shotRepairAttempts`。G6/G7 门证据引用这些实际文件。`production_qualifications` 不复制合同正文作为第二事实源，而是把合同摘要写入 canonical script fields，使 request hash 绑定当前合同。

`video.studio.status` 的 `promptQuality` 返回同一状态的轻量投影，包含总体 `status/g6Eligible`、每镜 `status/findingCodes/nextAction`、技术重试次数、内容修复次数和失败原因；它不复制完整合同正文。

## 6. G7/G8 边界

G7 不重新评审审美，只验证 G6 决策、字段/提示词/请求哈希和当前镜头包一致。任何漂移都拒绝，并使资格不可用。

`render_eligible` 只允许进入 G8，不等于付费提交。`enforce` 下 G8 还必须：

1. 通过预算、成本上限、权限、围栏、供应商/模型与当前资格检查；
2. 有一张未过期的 `l4_chairman` 人工授权单；
3. 授权单绑定 `qualificationId + requestHash + payloadHash + modelId + shotId + durationSec + estimatedCny + allowOverage`；
4. 授权单只能消费一次，替换 payload 或重放必须重新审批。

没有 `g8ApprovalId` 时，`video.render.submit` 会创建待审批单并返回 `G8_HUMAN_APPROVAL_REQUIRED:<approvalId>`，不会调用供应商；审批完成后用同一资格与审批 ID 重试。

## 7. 回滚

回滚只改部署配置：

```text
PROMPT_CONTRACT_V2=off
```

不要删除已生成的合同、语义报告、修复计划、G6/G7 事件或历史资格。旧 run 的 `fieldSchema` 仍决定读取口径；新 run 不会被回写为旧策略。
