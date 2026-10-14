# models.dev 目录（models-dev）

`models-dev` 下载并维护 `https://models.dev/api.json` 的模型目录，保留无价格模型、所有 provider 及其 `api` 和全部模型字段。插件：

- 通过 Bungee 的版本化快照机制发布不可变快照；
- 在 control 与 worker 进程中分别发布同契约的**本地只读服务** `models-dev.catalog.v1`；
- 在 control 提供目录状态/设置/刷新与查询的 HTTP API。

其他插件只依赖并消费该公开服务，不读取 models-dev 的 KV、表或文件，也不导入下载/缓存实现。

## 数据与一致性

- control 是唯一网络写入者：下载、解析并将 `{version, fetchedAt, catalog}` 原子提交到平台分块快照，成功提交后才发布新版本。目录正文仅从平台快照恢复；没有快照时保持空状态，等待首次成功下载。
- 刷新失败保留最后一次有效目录并给出明确 `error`；快照缺失时服务状态为 `empty`/`failed`，绝不伪装成价格 0。
- worker 消费 control 发布的平台版本化快照，验证摘要和正文结构后在本进程构建只读目录视图，每 5 秒对账并在版本更新时整体原子替换。请求期的定价和查询使用该视图，不访问网络或数据库。
- 外部消费者（其他插件、UI）只能使用公开接口：本进程本地只读服务 `models-dev.catalog.v1`，或版本化快照 `models-dev.catalog.snapshot.v1`。消费者不得读取插件私有存储或导入 `server/*` 内部实现。
- 插件要求平台提供耐久分块快照存储 `services.snapshot.store()`；缺少该能力时，控制面返回能力错误。
- 目录正文通过分块快照传递，快照正文上限 32 MiB，保留 3 个版本。

## 公开契约

[contract.ts](contract.ts) 导出服务 ID、快照契约与读取类型。读取方法同步、无 I/O：

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

## 刷新设置

设置页管理目录刷新，供消费目录的插件共用。自动刷新默认开启；`intervalHours` 为 1–24 小时的整数，默认 24；`timeoutSeconds` 为 5–120 秒的整数，默认 15。

设置输入只接受整数，必填空值不能保存。界面中的越界整数在失焦或按 Enter 时调整到最近边界；HTTP API 拒绝超出范围的值。
