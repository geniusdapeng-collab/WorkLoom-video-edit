# Edit 本机真实验收：单作业供应商预算

使用 [Agent 接入指南](AGENT-CLIENTS.md) 部署本机 Edit。这是隔离验收工具，用于给一项经授权的真实供应商作业留存请求和用量回执。普通 RDAS 的默认预算、正式 Studio 审批和 Film 门禁不变。

1. 为本轮准备私有目录（`0700`）、唯一任务号和新的账本路径。`--scope` 文件形如 `{"video":{"seconds":10,"ratio":"9:16","resolution":"1080p"},"inlineImageSha256":[]}`。只把本轮批准外发的内联图片原字节 SHA-256 加入清单。范围并不授予外发权。
2. 在独立网关进程的环境中注入 `WORKLOOM_BUDGET_GATEWAY_TOKEN`（本轮随机值）、`WORKLOOM_BUDGET_DEEPSEEK_API_KEY`、`WORKLOOM_BUDGET_ARK_API_KEY`，再运行：

   ```bash
   node --import tsx scripts/tools/provider-budget-gateway.mts \
     --port 58797 --task EDIT-EXAMPLE-01 --journal /private/task/budget.jsonl \
     --scope /private/task/scope.json
   ```

3. Edit 只拿本地随机值作为供应商 bearer。`LLM_PROVIDER=deepseek`、`LLM_MODEL=deepseek-flash`、`LLM_BASE_URL=http://127.0.0.1:58797`；`SEEDREAM_ENDPOINT`、`SEEDANCE_ENDPOINT` 和使用中的 `ARK_BASE_URL` 为 `http://127.0.0.1:58797/api/v3`。按正式流程分开前期与出片，在渲染提交前验证同轮审批、图片范围与实际供应商额度。`GET /budget/status`（本地 bearer）回读待结算预占、已结算用量与任务 ID。
4. 复核 `reserve` 与 `settle`：先持久化本次完整输入估算加原生 `max_tokens`，原样转发请求，再用供应商真实 usage 结算。`deepseek-flash` 单请求允许输出 `min(393216, 1048576 - 输入估算)`；任务合计按已用加未结算预占检查。供应商返回截断或结构无效时由正常模型适配器拒收；已经发生的真实用量仍入账。参见 [DeepSeek 请求契约](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/) 与 [模型能力](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。
5. 遇到结果未知、超额或进程中断，保留原账本。使用同一任务号、端口和范围恢复，只读回已登记的供应商任务，先对账。不能因为请求超时换账本、换供应商或再次提交。同字节视频请求返回原已登记 ID；未知结果与其他同字节请求会拒绝新提交。

当前内置验收范围为 45 分钟、最多 40 次文本调用、1,048,576 个合计文本 token、8 次图片生成和 3 次视频生成；媒体规格还受本轮 scope 约束。¥120 是基于 [供应商公开价格](https://console.volcengine.com/ark/region:cn-beijing/docs/model-pricing) 的本地估算上限，实际费用与余额以供应商账单为准。

## 整片工作流预算

在已授权的整片工作流中，使用新任务号和新账本，并在上述命令追加 `--profile workflow`。必须明确指定 `--scope` 中的镜头秒数、画幅和分辨率。账本会保存策略和范围，恢复时必须选择同一策略。

每次文本请求仍使用完整原生窗口，最多 40 次文本请求。41,943,040 是 40 次各自最多 1,048,576 个输入和输出 token 得出的总量上界。账本逐次预占和结算，并分别显示文本与媒体的已结算和预占估算。按当前公开峰值估算，文本上界约 ¥178.26，仅供观察。媒体估算独立受 ¥120、8 次图片、3 次视频及原有镜头范围限制。两种策略均为 45 分钟，结果未知时保留原始预占并冻结新增提交。
