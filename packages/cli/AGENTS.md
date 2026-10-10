# CLI 开发

遵循[根指引](../../AGENTS.md)。入口为 `src/index.ts` 和 `src/commands/`。

- 改命令时核对参数、退出码、数据目录、守护进程及凭据处理；同步[命令参考](../../docs/reference/cli.md)。
- 恢复命令调用插件声明的恢复能力，遵守停止实例与实例锁契约；见[离线恢复](../../docs/guides/offline-recovery.md)。
- 构建或发布工具变更先读取 [scripts skill](../../.agents/skills/scripts/SKILL.md)，文档变更读取 [documentation skill](../../.agents/skills/documentation/SKILL.md)。
