# LLM 协议转换规范

Bungee 的协议转换统一由 [LLM 协议适配器](llm-protocol-adapter.md) 提供。四种协议使用 `responses`、`chat_completions`、`anthropic_messages`、`gemini_generate_content` 标识，源/目标独立声明；Responses↔Gemini 不支持，同协议透传。

协议会话位于 `@jeffusion/bungee-llms/plugin-api` 的公共 API，plugin 负责生命周期、能力目录和宿主 hook 接入。消费者使用 adapter/contract.ts 声明的 conversion.v1 和 history.v1，不能私有导入 server 实现。请求和响应共享工具身份、规范历史及 SSE 状态，状态按单次请求隔离，结束/错误/取消后释放。

硬语义不能用“转换成功”掩盖损失：工具调用/结果、结构化输出、角色顺序、终止状态和明确历史须可表示。不可表示、未知、非法或加密历史明确拒绝；已验证且规则允许的生成偏好可以省略并记录原因。推理强度由 models.dev reasoning_options 与目标接口规则求交集，不根据 token 上限或 reasoning=true 推断 budget/档位。

完整矩阵、配置、公共服务、历史上限、推理来源与验证边界见 [适配器文档](llm-protocol-adapter.md)。
