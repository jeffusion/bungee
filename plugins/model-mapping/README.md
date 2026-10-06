# 模型映射（model-mapping）

把客户端请求中的源模型映射到目标模型，并在 `model_mapping` 配置字段中提供可搜索的模型目录。

目录不再由本插件下载或缓存：它消费 models-dev 的公开服务 `models-dev.catalog.v1`（worker 进程用于请求期归一化，control 进程用于 `/catalog` 查询），因此只有一个下载入口和一份版本化数据。

## 行为

- `GET /catalog` 返回分页模型目录（`provider`/`search`/`page`），数据来自 models-dev；models-dev 不可用时返回 `catalog_unavailable`，不回退到离线或静态目录。
- 已删除旧的 `/catalog/refresh` 与本地抓取/调度/缓存代码；刷新统一在 models-dev 设置页进行。
- 映射规则本身仍由本插件负责：请求钩子在 worker 同步执行归一化（把 `provider:model` 前缀在 provider 属于目录时去掉），不进行网络或 SQLite 访问。
