# 冻结分镜的模型结构化响应

当当前项目的正式营销 Brief 明确冻结逐段边界时，可以由当前本机服务的受控配置选择 `WORKLOOM_VIDEO_SCENE_RESPONSE_FORMAT=json_schema`。只影响 SceneArchitect 生成分镜的单次请求。未选择时维持原来的 `json_object`，其他模型工位不受影响。请求仍经过 WorkLoom 同一个文本调度器，使用原 `deepseek-flash`、思考策略、完整输入与合法的模型窗口。

新模式使用 [DeepSeek Responses API](https://api-docs.deepseek.com/api/create-response/) 的 `text.format`，发送本次原生有效结构及完整输入。应用仍本地验证真实输出、分段时长、动作结构和后续独立 G3，不会把 HTTP 成功、供应商完成状态、错误 JSON 或未结算响应视为通过。格式由运行环境在开始时固定；未配置此路由的本机预算模式不自动转用其他接口。见 [DeepSeek 兼容说明](https://api-docs.deepseek.com/guides/responses_api/)。

在正式部署前用当前源码、同一调度器和授权的冻结样例核对：实际 `/responses` 请求的模型、思考强度、`max_output_tokens`、结构摘要、结算用量和当前业务裁决。若有独立的受控本机网关，使用支持这条路径的显式 Studio 整片模式。保留旧请求与失败原件；遇到未知结算不重发，避免为保住语法而裁剪业务字段。
