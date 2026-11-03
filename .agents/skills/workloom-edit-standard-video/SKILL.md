---
name: workloom-edit-standard-video
description: 用本仓 WorkLoom Video Edit 的正式流程制作、返修或交付视频。用户点名用 Codex 调用 Edit 做指定秒数视频时使用，含通用叙事、营销片与成功源片复用。
---

# Edit 标准视频

从 Edit 仓库根目录读取 [本仓专属规则](../../../AGENTS.repo.md) 和 [视频工作台指南](../../../docs/ai-video-workbench-guide.md)。也可用 `node scripts/workloom-agent.mjs invoke growth.video.workbench.guide` 或 MCP 工具 `workloom_growth_video_workbench_guide` 获取全文和摘要。核对产品 ID `workloom-ai-video-edit`。新环境按 [接入指南](../../../docs/AGENT-CLIENTS.md) 启动本仓服务和预检。

新生成任务先用 `node --import tsx scripts/tools/codex-video-workflow.mjs --intent "$EDIT_RAW_INTENT"` 生成只读计划。确认授权后用同一入口加 `--execute --api "$EDIT_API" --receipt "$EDIT_RUN_ROOT/studio-start.json"`，然后用 `--status --receipt "$EDIT_RUN_ROOT/studio-start.json"` 继续回读。每次执行沿用同一私有回执路径。遇到审批先回读正式审批。在 `preproduction_archived` 且本次渲染授权已具备时，用同一入口的 `--continue --receipt` 接续同轮 Film、后期和交付质检。已生成作业用原回执查询当前成片和摘要。

1. 保留用户原话，冻结人物、商品、平台、时长、声音、交付规格与授权。把明确指定的秒数写入 `metadata.brief.duration`，避免 Studio 缺省 30 秒覆盖要求。核验已有成功源片的项目、镜号、供应商回执、当前字节和授权，按需走正式后期。
2. 新生成从正式分流和 Studio 入口启动。营销走商品情报与 G1，其余门按本次片型适用性核验。缺项采用本仓分流器返回的澄清，口播走正式解说入口。发现阶段失败、额度或授权阻断时保留原始事实，按本项目状态恢复。
3. 只从本项目本轮服务端归档获取片单。核对 `projectId`、`runId`、`attempt`、提示词及片单 SHA-256 和适用审批。保持原件字节，包括 `draft` 标记。禁止手工造片单或改标签补过门。预览只核对本地输入，实际提交由正式资格和 G8 决定。
4. 按本轮合同调用本仓 Film 和正式后期。使用已批准的素材与范围。状态未知时回读原任务。保留成功来源和历史拒绝记录，只在有据且获授权时重渲相应镜头。
5. 最终回读正式交付清单和当前媒体的 `growth.video.post.quality` 技术质检。核对用户要求的实际秒数、画幅、声音、字幕、封面和片段。只有当前成片字节和必需回执齐备才报告完成。对外发布单独执行授权流程。
