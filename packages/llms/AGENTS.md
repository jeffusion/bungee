# 协议转换开发

遵循[根指引](../../AGENTS.md)。先读取[包说明](README.md)及[协议转换参考](../../docs/reference/ai-protocol-conversion.md)。

- 对插件暴露 `@jeffusion/bungee-llms/plugin-api` 门面，不导入宿主私有运行模块。
- 转换保持请求、响应与流事件的协议语义；不将未支持的字段写成无损转换能力。
- 正文消费使用调用方的共享内容视图；转换器不自行克隆网络 Response 或重复解析共享 SSE。
- 对公开接口的调整同步类型和使用示例。
