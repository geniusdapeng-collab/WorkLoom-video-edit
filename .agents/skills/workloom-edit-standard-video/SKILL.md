---
name: workloom-edit-standard-video
description: 用本仓 WorkLoom Video Edit 的正式流程制作、返修或交付视频。用户要求 Codex、Qoder 或其他本地 AI 办公 Agent 调用 Edit 做视频时使用，含通用叙事、营销片与成功源片复用。仅用于 Edit 视频任务。
---

# Edit 标准视频

先完整读取 [本仓专属规则](../../../AGENTS.repo.md) 和 [视频工作台指南](../../../docs/ai-video-workbench-guide.md)，核对产品 ID `workloom-ai-video-edit`。也可调用 `node scripts/edit-agent.mjs invoke growth.video.workbench.guide` 或 MCP `workloom_growth_video_workbench_guide` 获取正文和摘要。新环境按 [接入指南](../../../docs/AGENT-CLIENTS.md) 生成客户端配置并核对实际服务与认证；不替换用户既有 provider、权限或 sandbox 设置。

1. 完整保留用户原话和已确认 Brief，冻结人物、商品、平台、总时长、声音、交付规格、素材与预算授权。镜头数、逐镜时长和顺序由正式管线规划；不得擅自添加「3 镜 × 10 秒」或沿用旧片约束。先核对已有成功源片的任务、来源、当前字节和授权，按需走正式后期。
2. 新生成先读指南，调用 `edit.agent.doctor`，再用 `edit.video.workflow.plan` 传完整 `intent` / `brief`。只有已有本次文字前期授权，才用稳定 `idempotencyKey` 和 `authorization.textGeneration:true` 调用 `edit.video.workflow.start`。CLI 用 `node scripts/edit-agent.mjs invoke <能力ID> --input-file <JSON文件或->`；MCP 对应 `workloom_edit_video_workflow_*`。参数以实际 `describe` / `tools/list` 为准。
3. 保存返回的 `jobId`，用 `edit.video.workflow.status` 回读同一作业。审批、执行中、未知状态和前期归档都未交付；超时、取消等待或客户端重启不代表可以换键重投。API、目录与秘密只由操作者进程环境提供。
4. 只承接本项目本轮服务端归档，核对 `projectId`、`runId`、`attempt`、需求合同、提示词/片单摘要及适用审批。保留原件字节和 `draft` 标记，禁止手造片单或改标签过门。提示词失败先读正式 `edit.video.workflow.repair_plan`；仅可承接且已有文字修复授权时调用 `repair`，保留同一修复 job。
5. 当前 G7、正式来源和本次媒体预算授权齐备后，用同一 `jobId` 与 `authorization.mediaGeneration:true` 调用 `edit.video.workflow.continue`，接续已有 Film、正式后期和技术质检。原生预算或能力不兼容时保留实际阻塞，不改用户需求、镜头方案、路由、模型或重试政策来适配。
6. 最终回读同一 job 的当前媒体、正式交付清单和技术质检。核对实际秒数、画幅、声音、字幕、封面与片段。只有实际 `delivered:true` 且当前字节和必需回执齐备，才报告完成；未测的主观品质仍按指南如实标记。对外发布单独走授权流程。
