# 核心开发

遵循[根指引](../../AGENTS.md)。

| 任务 | 入口与按需资料 |
| --- | --- |
| 进程、发布与管理 | `src/main.ts`、`src/master-runtime/composition.ts`、`src/master-runtime/control-api.ts`；[运行架构](../../docs/architecture/runtime.md) |
| 存储与迁移 | `src/config-storage/`、`src/plugin-state/`、`src/migrations/`；[存储契约](../../docs/architecture/storage.md) |
| 请求与正文 | `src/gateway/`、`src/worker/`；[正文架构](../../docs/architecture/http-body.md) |
| 插件接口 | `src/gateway/plugin.ts`、`src/plugin.types.ts`、`src/hooks/`；[插件参考](../../docs/reference/plugin-api.md) |

- 核心按能力声明协调插件，不通过内置插件名称实现业务分支。
- 已发布数据库基线和迁移不可重写；升级追加连续迁移。
- 使用共享 BodyHandle 和已声明的内容需求，避免独立克隆、解码或竞争消费正文。
- `src/ui/assets.ts` 为生成文件，使用构建入口生成。
