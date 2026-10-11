# 插件开发

遵循[根指引](../AGENTS.md)，读取[插件开发指南](../docs/guides/plugin-development.md)、[SDK 参考](../docs/reference/plugin-api.md)及目标插件 README。

- 插件采用 manifest schema 3 和注册式 SDK：同步声明 `bodyRequirements`，在 `register(hooks)` 注册回调。
- 通过公开 SDK 导入类型；服务、RPC、通道、权限及依赖必须声明，不借核心私有接口绕过门禁。
- 状态通过异步存储能力访问；普通 CAS 与幂等命令分别处理。见[存储契约](../docs/architecture/storage.md)。
- URL 改写仅涉及路径、查询或片段，不改主机、协议或端口。
- 修改原生 UI 时读取 [UI 规则](../packages/ui/AGENTS.md)和[设计规范](../packages/ui/docs/INDUSTRIAL_DESIGN_SYSTEM.md)。
