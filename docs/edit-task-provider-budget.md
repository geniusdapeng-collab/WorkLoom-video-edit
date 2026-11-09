# Edit 本机真实验收：单作业供应商用量账本

使用 [Agent 接入指南](AGENT-CLIENTS.md) 部署本机 Edit。这是隔离验收工具，用于给一项经授权的真实供应商作业留存请求和用量回执。它记录真实用量，但不设置产品自有的默认调用次数、金额、图片数、视频数、任务时长或 45 分钟窗口上限。正式 Studio 审批、供应商自身配额、账户余额和 Film 门禁仍独立生效。

1. 为本轮准备私有目录（`0700`）、唯一任务号和新的账本路径。`--scope` 文件形如 `{"video":{"seconds":10,"ratio":"9:16","resolution":"1080p"},"inlineImageSha256":[]}`。只把本轮批准外发的内联图片原字节 SHA-256 加入清单。范围并不授予外发权。
2. 在独立网关进程的环境中注入 `WORKLOOM_BUDGET_GATEWAY_TOKEN`（本轮随机值）、`WORKLOOM_BUDGET_DEEPSEEK_API_KEY`、`WORKLOOM_BUDGET_ARK_API_KEY`，再运行：

   ```bash
   node --import tsx scripts/tools/provider-budget-gateway.mts \
     --port 58797 --task EDIT-EXAMPLE-01 --journal /private/task/budget.jsonl \
     --scope /private/task/scope.json
   ```

3. Edit 只拿本地随机值作为供应商 bearer。`LLM_PROVIDER=deepseek`、`LLM_MODEL=deepseek-flash`、`LLM_BASE_URL=http://127.0.0.1:58797`；`SEEDREAM_ENDPOINT`、`SEEDANCE_ENDPOINT` 和使用中的 `ARK_BASE_URL` 为 `http://127.0.0.1:58797/api/v3`。按正式流程分开前期与出片，在渲染提交前验证同轮审批、图片范围与实际供应商额度。`GET /budget/status`（本地 bearer）回读待结算预占、已结算用量与任务 ID。
4. 复核 `reserve` 与 `settle`：先持久化本次完整输入估算加原生 `max_tokens`，原样转发请求，再用供应商真实 usage 结算。`deepseek-flash` 单请求允许输出 `min(393216, 1048576 - 输入估算)`；任务合计按已用加未结算预占检查。供应商返回截断或结构无效时由正常模型适配器拒收；已经发生的真实用量仍入账。参见 [DeepSeek 请求契约](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/) 与 [模型能力](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。
5. 遇到结果未知或进程中断，保留原账本。使用同一任务号、端口和范围恢复，只读回已登记的供应商任务，先对账。不能因为请求超时换账本、换供应商或再次提交。同字节视频请求返回原已登记 ID；未知结果与其他同字节请求会拒绝新提交。

当前默认不设任务级上限。账本持续记录每次完整请求的原生 `max_tokens`、预估预留、供应商真实 usage 和当前累计估算金额；实际费用与余额以供应商账单为准。若调用方确实需要消费控制，必须由上层显式提供并在调用前执行，不能把历史 40/64 次文本、¥120/¥285 文本+媒体、8 次图片、3 次视频、45 秒视频或 45 分钟窗口重新写成默认值。

## 整片工作流用量

在已授权的整片工作流中，使用新任务号和新账本，并在上述命令追加 `--profile workflow`。必须明确指定 `--scope` 中的镜头秒数、画幅和分辨率。账本会保存策略和范围，恢复时必须选择同一策略。

每次文本请求仍使用完整原生窗口，不做任意 `max_tokens` 裁剪。账本逐次登记预占并结算供应商真实 usage，分别显示文本与媒体的已结算和预占估算。结果未知时保留原始预占并冻结新增提交。

对已单独授权、需要预留逐镜语义复核和渲染资格审核的正式 Studio 作业，在新任务号和新账本上显式使用 `--profile workflow-v2`。该策略启用 Responses 结构化审查能力，不额外设置文本请求次数上限。单请求仍使用同一完整原生窗口。默认 `case`、`workflow` 与 `workflow-v2` 均不设置调用次数、金额或任务时间窗上限；已有旧账本仍按其打开时的历史 header 只读恢复和对账。Film 的正式接续沿用 `workflow`。

仅 `workflow-v2` 的正式 Studio 冻结分段作业可使用受控的 `POST /responses`。场景使用 `workloom_scene_architect` JSON Schema。对采用该场景格式、明确冻结分段且无对白的作业，可以在本次 Studio 进程显式设置 `WORKLOOM_VIDEO_RISK_RESPONSE_FORMAT=json_schema`，使风险工位使用 `workloom_risk_assessor` 的固定 JSON Schema。本机验收网关仅在每镜 10 秒、9:16、1080p 的媒体范围内接受该风险请求。未设置时风险工位沿用原有 Chat 输出。风险工位仍读取同一次已校验场景全文和客户原始材料；本地校验完整正文，后续 G3 独立判断内容是否可执行。仅完整且已计量的无效结果可以使用原有一次纠正机会；未知回执不会触发新的请求。

两种受控 Schema 请求均使用完整输入和 `deepseek-flash` 高档思考，按完整原生窗口核验 `max_output_tokens`。请求为非流式，不传工具、图片或跨轮状态。网关持久化预占后原样转发，按供应商返回的输入、输出和总 token 对账。同一账本同时计算 Chat Completions 和 Responses 调用。计量完整的失败或未完成响应仍结算真实用量。无法核实用量时保留预占并关闭新增提交。参见 [DeepSeek Responses API](https://api-docs.deepseek.com/api/create-response/)。
