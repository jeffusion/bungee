# Bungee Agent 指引

## 必要约束

- 按用户授权范围完成工作；保留无关行为及既有改动，不擅自部署、发布、修改自动更新设置或操作生产数据。
- 新增永久文档、工具脚本、Agent 规则或 skills 必须属于明确要求或已确认方案；普通修复优先更新现有内容，无需对已授权文件逐个重复审批。
- 不将会话计划、任务编号、交接、实施进度、当次验证统计、临时证据或个人服务器操作记录纳入项目。会话临时产物放项目外，不用归档目录或忽略规则将其留在项目中。
- 文档描述产品行为及维护契约；不依赖“本轮”“前面讨论”等会话背景。正常操作步骤和产品生命周期阶段允许编号，不按关键词机械删除。
- 正式发布历史、来源、许可证、安全说明及维护规范可以保留；每个永久新增文件应在会话交付中说明用途，不另写总结文件入库。
- 不把可插拔业务能力当成核心能力；不要擅自添加兼容层、双轨实现或超出任务的功能。
- 不将凭据写入项目、日志或验证产物；不手工修改生成文件。
- 本地测试、构建、浏览器检查、实际提供商验证和生产部署是不同证据；只报告实际完成的检查及其范围。

### 测试维护

- 测试入口放所属包、插件或工具的 `tests/{unit,integration,browser}/`；跨模块流程放根 `tests/`。按子系统组织，文件名用连字符，不重复写层级后缀。
- 新增测试前查找既有覆盖；辅助代码、被加载夹具及运行产物分别管理。具体方法读取 scripts skill。
- 禁止截取源码函数执行、复制生产算法计算预期值，以及为普通修复新增一次性测试框架、探针、报告或任务目录。
- 不擅自缩减默认回归范围、增加跳过、重试或额外门禁；单元测试不得启动数据库、服务、子进程或浏览器。
- 完整入口保持全量；PR 按已维护的模块规则执行全部快速测试和选中的集成、浏览器测试。新增模块、跨模块依赖或夹具使用方时同步维护范围规则；未知归属回退全量，读取失败报错。
- 按范围验证不得描述为全量验证。发布必须获得同一代码树的 Linux/macOS 全量证明；不得未经授权放宽选择或证明条件。CI 并行任务使用独立工作区，任务内部保持串行。

## 最小项目入口

Bungee 是 Bun/TypeScript 反向代理，包含独立 ingress、master/control、worker 和插件能力。

| 模块 | 职责 | 入口 |
| --- | --- | --- |
| `packages/core` | 运行时、控制面、网关与插件宿主 | `packages/core/src/main.ts` |
| `packages/cli` | 初始化与守护进程命令 | `packages/cli/src/index.ts` |
| `packages/llms` | AI 协议转换 | `packages/llms/src/plugin-api.ts` |
| `packages/types` | 共享类型 | `packages/types/src/index.ts` |
| `packages/ui` | 管理界面与插件 UI SDK | `packages/ui/src/main.ts` |
| `plugins` | 随项目交付的插件 | 各插件 `manifest.json` |

命令以根及各包 `package.json` 为准；文档入口是 [docs/README.md](docs/README.md)。不要在本文件复制接口、架构、依赖版本或生成产物清单。

## 按需读取

| 工作 | 先读取 |
| --- | --- |
| 文档编写、审查、移动或删除 | [.agents/skills/documentation/SKILL.md](.agents/skills/documentation/SKILL.md)，再读 [docs/AGENTS.md](docs/AGENTS.md) 及相关文档 |
| 工具脚本或测试编写与整理 | [.agents/skills/scripts/SKILL.md](.agents/skills/scripts/SKILL.md)，再读调用入口及相关工具 |
| 核心、持久化或生命周期 | [packages/core/AGENTS.md](packages/core/AGENTS.md)，再从文档索引定位架构与契约 |
| CLI | [packages/cli/AGENTS.md](packages/cli/AGENTS.md) |
| 协议转换 | [packages/llms/AGENTS.md](packages/llms/AGENTS.md) |
| 插件 | [plugins/AGENTS.md](plugins/AGENTS.md)，再读相应插件 README |
| UI、原生 widget 或管理页面 HTML | [packages/ui/AGENTS.md](packages/ui/AGENTS.md) 和 [UI 设计规范](packages/ui/docs/INDUSTRIAL_DESIGN_SYSTEM.md) |

只读取与任务相关的资料；目录级规则仅补充本地约束，不复制根规则。skills 指导方法，不扩大授权。
