# Codex Router 架构

`codex-router` 在现有 plugins 体系中提供 Codex 模型目录替换、模型绑定和调度。请求转换、推理接口规则与临时规范历史由 [LLM 协议适配器](llm-protocol-adapter.md) 提供。网关核心保留公共 hook、BodyHandle、dispatch、作用域、服务和请求日志能力。

## 职责和依赖

Router manifest 声明 `models-dev` 和 `llm-protocol-adapter` 依赖。control 侧消费 models-dev 的目录/能力服务和 adapter conversion 描述服务，生成模型目录与客户端能力说明；worker 侧消费 adapter 的 conversion 本地服务和 history RPC，按模型绑定建立请求级会话并转发到绑定 route/service。跨插件 imports 仅限 contract.ts，禁止导入 adapter/server 或 models-dev/server。

model directory 的 slug 保持原始模型标识，display_name 来自目标目录名称。绑定将 source/sourceProvider 与 provider/model 分开；提供商 ID 用于目录精确定位，协议字段用于线路格式。route/service 只拥有转发链路，不新增模型协议字段。

## 绑定与界面

每条绑定显式声明 `sourceProtocol: responses` 及 `target.protocol: responses|chat_completions|anthropic_messages`。缺少目标协议在配置发布和插件初始化拒绝；选择路由/service 不猜协议。源和目标模型选择复用公共 BSelect 与 models.dev 的搜索/分页，手动源模型和目录源模型保留各自编辑草稿。能力限制仅能缩小 tools、images、reasoning、contextWindow，不能手工指定推理档位或 thinking budget。

绑定通过通用 PluginEditor/DynamicPluginForm 配置；Router 没有额外 settings page。目录管理属于 models-dev，模型替换与转发目标属于 Router。摘要显示源模型 → provider/model、目标协议和本地化的路由/service 类型。

## 转换、历史和传输

匹配绑定后 Router 通过 adapter conversion.v1 建立会话，转换 Responses 请求、JSON 响应或 SSE 事件。规范历史经 adapter history.v1 由 control 共享，按绑定/入口 scope 隔离。Router 只提交成功完整生成的 canonicalInput/输出；失败、取消、incomplete 不写成功历史。工具注册、调用身份和输出顺序由同一会话维护，跨 worker 续聊读取同一规范历史；变更工具声明不依靠旧私有缓存。

原生 Responses 保持 HTTP/SSE 或原生 WS；绑定 Chat/Anthropic 的 WS 入口通过现有 dispatch 走 HTTP/SSE 转换。上游连接、认证、重试、取消、排空和日志仍使用统一网关，不由 Router 新建网络栈。出站 attempt 必须兑现绑定模型、协议和已选推理强度，模型映射或 failover 改变这些条件时明确拒绝。

## 能力与严格语义

control 模型目录和 worker 请求共用 adapter 的有效能力解析：models.dev reasoning_options 与有版本的接口规则求交集。目录 missing、已知空列表和 invalid 三种状态保留，不从 reasoning=true 伪造 selector 或 default。目标不存在或不可证明支持时，对外强度列表为空。具体 GLM 档位、rulesVersion 与契约见 [适配器文档](llm-protocol-adapter.md#推理能力来源和规则版本)。

工具、自定义工具封装、JSON Schema、输入顺序和引用历史等硬语义不得静默丢弃。未知字段、加密/compaction、不可表达的约束及多候选转换返回具体 param；经过验证的生成偏好可依明确规则省略并记录诊断。诊断写入既有请求步骤，包含逻辑 requestId、字段路径与稳定原因码，不回显正文或参数值。

## 验证范围

本地单元/协议、HTTP/SSE/WS 与 master 多 worker fixture 验证分别提供不同证据。UI 使用隔离 API 与本机浏览器；真实提供商、真实 Desktop、正式配置发布及部署必须单独验收。仓库测试通过不能作为这些动作已经完成的证明。
