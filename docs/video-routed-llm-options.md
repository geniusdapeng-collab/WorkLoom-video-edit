# 视频语言模型调用参数

`WorkloomLLMEngine` 接入 `routeSmart` 后，仍将适配器配置的超时（默认 180 秒）和每次调用的生成选项送到实际 `ModelProvider.chat`。生成选项只包含 `temperature`、`topP`、`maxTokens`、`responseFormat`、`thinking`；它们不选择模型，也不覆盖路由的套餐、场景、预算、事件汇或供应商凭据。

适配器的默认值与直连路径一致：温度 1、top-p 0.95、输出 token 上限 8192（可由构造配置覆盖）。显式数值 0 原样保留。`forceJson: true` 优先于 `responseFormat`，转换成 `response_format: { type: "json_object" }`。未指定 `thinking` 时不发送该字段。独立使用 `OpenAiCompatibleProvider` 时，原有温度默认值 0.2 保持不变，其他未指定字段省略。

取消信号与供应商超时共同约束网络请求和响应正文读取。调用方取消会记录原因并停止后续供应商尝试，不累计供应商故障次数；供应商错误仍沿现有降级链记录。积分仍由成功回包的真实 token 用量计量，原有熔断阈值与预算边界保留。

营销事实提取是原文转录任务，明确传 `thinking: { type: "disabled" }`、温度 0 和 JSON 格式。原文支持关系审核及最终镜头事实审核继续使用独立 `reviewStage`，不继承提取任务的 thinking 设置，也不改变通过条件。

离线回归使用本地 HTTP 服务读取实际 POST 字节，覆盖参数、默认值、超时、取消、HTTP 错误和计量。这里的验证不构成供应商服务可用性或正式视频生产成功回执。
