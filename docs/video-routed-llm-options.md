# 视频语言模型调用参数

`WorkloomLLMEngine` 接入 `routeSmart` 后，仍将适配器配置的超时（默认 180 秒）和每次调用的生成选项送到实际 `ModelProvider.chat`。生成选项只包含 `temperature`、`topP`、`maxTokens`、`responseFormat`、`thinking`；它们不选择模型，也不覆盖路由的套餐、场景、预算、事件汇或供应商凭据。

适配器的默认值与直连路径一致：温度 1、top-p 0.95、输出 token 上限 8192（可由构造配置覆盖）。显式数值 0 原样保留。`forceJson: true` 优先于 `responseFormat`，转换成 `response_format: { type: "json_object" }`。未指定 `thinking` 时不发送该字段。独立使用 `OpenAiCompatibleProvider` 时，原有温度默认值 0.2 保持不变，其他未指定字段省略。

DeepSeek 文本模型使用统一 token 单位：`deepseek-flash` 的官方上下文为 1,048,576 tokens，输出上限为 393,216 tokens。每次调用先以本次 `max_tokens` 预留输出，再限制输入，因此两者不会分别按上限相加。视频 JSON 任务申请 16,384 output tokens，输入预算相应为 1,032,192 tokens；文本先按官方中文字符 0.6 token、英文/数字/空白字符 0.3 token、符号 1 token 的近似比例换算。精确用量以 API `usage` 为准，估算超限直接失败关闭，不调用替代模型。`LLM_NON_THINKING=0` 可显式恢复思考模式，否则 Flash 文本任务默认非思考。

取消信号与供应商超时共同约束网络请求和响应正文读取。调用方取消会记录原因并停止后续供应商尝试，不累计供应商故障次数；供应商错误仍沿现有降级链记录。积分仍由成功回包的真实 token 用量计量，原有熔断阈值与预算边界保留。

营销事实提取是原文转录任务，明确传 `thinking: { type: "disabled" }`、温度 0 和 JSON 格式。原文支持关系审核及最终镜头事实审核继续使用独立 `reviewStage`，不继承提取任务的 thinking 设置，也不改变通过条件。

离线回归使用本地 HTTP 服务读取实际 POST 字节，覆盖参数、默认值、超时、取消、HTTP 错误和计量。这里的验证不构成供应商服务可用性或正式视频生产成功回执。
