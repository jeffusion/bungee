# 模型映射（model-mapping）

把客户端请求中的源模型映射到目标模型，并在 `model_mapping` 配置字段中提供可搜索的模型目录。

模型目录由 [models-dev](../models-dev/README.md) 提供。本插件消费其公开服务 `models-dev.catalog.v1`：worker 用于请求期归一化，control 用于 `/catalog` 查询。

## 行为

- `GET /catalog` 返回分页模型目录（`provider`/`search`/`page`），数据来自 models-dev；models-dev 不可用时返回 `catalog_unavailable`，不回退到离线或静态目录。
- 目录刷新在 models-dev 设置页进行，本插件不提供刷新接口。
- 请求钩子在 worker 同步执行映射与归一化：目标名称采用 `provider:model` 格式且 provider 存在于目录时，去掉该前缀。请求期不访问网络或数据库。

## 上游名称和目录身份

`source` 是匹配名称，`target` 是上游名称。`catalogModel` 可选，用完整、精确的 `provider/model` 指定能力目录身份，与上游名称独立：

```json
{
  "modelMappings": [
    {"source":"glm-5.3","target":"GLM-5.3","catalogModel":{"provider":"zai","model":"glm-5.3"}},
    {"source":"glm-5.3-flash","target":"GLM-5.3-Flash","catalogModel":{"provider":"zai","model":"glm-5.3-flash"}}
  ]
}
```

保存检查身份字段同时存在、非空且无首尾空白；运行时适配器检查目录存在性。目录身份必须显式指定，不从 source、大小写、显示名称或前缀推断。目录选择按提供商筛选，保存完整身份；选择或清除身份不改上游名称。

编辑器先展示“请求中的模型名称 → 发给上游的模型名称”。源名称可输入自定义名称，也可在下拉查找区按提供商筛选。下方显示可选的能力校验目录：已关联时展示完整的提供商和模型，未关联时显示“关联目录模型”；点击“关联”或“更换”展开目录选择器。确认选择后收起，取消保留原关联，清除仅移除目录关联。窄屏按请求名称、上游名称、目录关联的顺序纵向排列。

匹配规则通过内部 `models-dev.model-identity` 注解声明实际写入的 `wireModel` 及目录身份，即使名称未变化也声明。匹配无身份规则清除此前声明；没有匹配保留已有声明；多阶段映射以最后匹配规则为准。精确 source 匹配优先；目录前缀候选若归一化后的上游名称或可选身份不同（包含有无身份），返回本地 `422 model_mapping_ambiguous`，不继续回退。

Gemini 使用 URL 的终端模型段，支持基址前缀与 URL 编码，忽略正文 model。声明只在内部请求上下文流转，不写入请求正文、头、历史缓存或持久化状态。最终校验及错误定义见[协议适配器参考](../../docs/reference/llm-protocol-adapter.md#最终模型身份校验)。
