# models.dev 目录（models-dev）

`models-dev` 是 `https://models.dev/api.json` 的**唯一下载入口**。它把完整目录（不裁剪：无价模型、所有 provider 及其 `api`、全部模型字段都保留）下载、解析并私有持久化，然后：

- 通过 Host 的版本化快照机制发布不可变快照；
- 在 control 与 worker 进程中分别发布同契约的**本地只读服务** `models-dev.catalog.v1`；
- 在 control 提供目录状态/设置/刷新与查询的 HTTP API。

其他插件只依赖并消费该公开服务，不读取 models-dev 的 KV、表或文件，也不导入下载/缓存实现。

## 数据与一致性

- control 是唯一网络写入者：下载、解析并将 `{version, fetchedAt, catalog}` 原子提交到 Host 分块快照，成功提交后才发布新版本。旧 KV 目录仅在没有快照时一次性导入，不再双写。
- 刷新失败保留最后一次有效目录并给出明确 `error`；快照缺失时服务状态为 `empty`/`failed`，绝不伪装成价格 0。
- worker 不下载：它消费 control 的 Host 版本化快照，验证摘要和正文结构后在本进程构建只读目录视图，按后台周期（5s）对账并在版本更新时整体原子替换。定价/查询因此不逐请求访问网络或 SQLite。
- 外部消费者（其他 plugin、UI）只能使用公开接口：本进程本地只读服务 `models-dev.catalog.v1`，或版本化快照 `models-dev.catalog.snapshot.v1`。任何消费者都不得读取 models-dev 的 KV/表/文件，也不得 import `server/*` 内部实现。
- control 的版本快照必须由 Host 的耐久分块快照存储承载（`services.snapshot.store()`）。若 Host 未提供该能力，控制面**显式 capability 失败**，不使用进程内备用存储来掩盖缺失的耐久能力。
- 5 MiB 级正文走快照数据通道（分块），不使用 64 KiB RPC 消息或 1 MiB 耐久命令记录；快照正文上限 32 MiB、保留 3 个版本。

## 公开契约

`plugins/models-dev/contract.ts` 是唯一公开文件，导出服务 ID、快照契约字面量与读取类型。读取方法同步、无 I/O：

- `status()`：`empty|ready|stale|failed`、版本、抓取时间、provider/model 计数、错误。
- `providers()`：provider 列表，含 `provider.api`。
- `modelOptions({provider,search,page,pageSize})`：有界分页模型列表。
- `resolveModel({model,pricingProvider?,url?})`：精确、大小写敏感地解析唯一目录条目；同名多 provider、URL 命中多个 `provider.api`、无法确认时为 `null`。
- `resolveProvider({url})`：按规范化后的 host + 路径段匹配 `provider.api`，歧义返回 `null`。

## HTTP API（control）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/catalog/status` | 状态、设置、上次尝试/成功、下次刷新、错误、计数、版本 |
| GET | `/catalog/providers` | provider 列表 |
| GET | `/catalog/models?provider=&search=&page=` | 有界分页模型 |
| PUT | `/catalog/settings` | `{autoRefresh, intervalHours, timeoutSeconds}` |
| POST | `/catalog/refresh` | 触发一次刷新（异步） |

价格设置已集中在此插件；Token 统计只保留自己的别名映射与费用责任。

刷新间隔和下载超时均使用 NumberInput，只接受整数：刷新间隔为 1–24 小时，默认 24 小时；超时为 5–120 秒，默认 15 秒。界面、HTTP API 和持久化统一使用 `intervalHours`，不做旧分钟设置的兼容或迁移。

NumberInput 复用项目 Input 样式，提供自定义步进按钮和方向键操作。输入时拒绝小数点、符号及非法粘贴内容；越界整数在失焦或按 Enter 时调整到最近边界。编辑时可清空，必填空值不能保存。
