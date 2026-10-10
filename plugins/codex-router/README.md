# Codex Router

在指定 Responses 入口 route 绑定插件。先启用 models-dev，在入口路由的插件配置中添加绑定，分别选择原始提供商与模型、目标提供商与模型，再选择已有 route/service，保存目标的接收协议。

`source` 精确匹配客户端请求中的 `model`；`provider`/`model` 选择 models.dev 中的目标模型；`target` 选择转发链路。匹配后先将请求的 `model` 改为目标模型，再交给 route/service，其已有模型映射仍可继续改写。返回给客户端的模型名称恢复为 `source`。目标模型与转发链路缺一不可。

原始模型和目标模型共用 models.dev 的分页搜索选择器，各自按提供商筛选。可选 `sourceProvider` 保存原始模型的目录筛选项，只帮助选择，不参与路由匹配；同一模型标识在不同供应商下仍只能配置一个绑定。原始模型也可切换为手动输入，用于客户端别名或目录未收录的标识；切换后不保存 sourceProvider。手填 source/alias 配置也可编辑。改变原始提供商只清空原始模型，不影响目标模型或转发位置。

模型匹配不依赖 Codex 客户端身份；其它 Responses 客户端也可使用此入口。当前仍只接受 Responses 生成入口，目标支持 Responses、Chat Completions、Anthropic Messages；增加原始模型目录选择不代表新增 Chat Completions 或 Messages 入口。Codex 专用模型目录适配与会话兼容行为继续保留。

显式 `source` 可以替换原生目录中的同名模型，保留它的位置并使用目标能力描述；其它原生模型保持原样。新增标识则追加到目录。同一原始标识不允许多个绑定。未声明 source 时按 `alias ?? model` 匹配，保留原冲突检查；`source` 与 `alias` 不允许同时设置。

目标模型缺失、缺少上下文长度或不支持文本时，目录隐藏该绑定占用的标识，请求返回模型不可用；不会恢复原生能力或悄悄转回原生上游。models.dev 刷新失败时仍使用最后有效资料。

模型绑定直接在入口路由的插件配置表单中编辑并随该路由保存。插件不提供独立设置页，目录管理使用 models-dev 插件。

```json
{"models":[{"source":"gpt-native","sourceProtocol":"responses","provider":"anthropic","model":"claude-sonnet-4","target":{"type":"service","id":"目标服务的 UUID","protocol":"anthropic_messages"}}]}
```

上游地址、API Key、模型映射、重试均使用目标原配置。Codex base URL 已指向入口即可；ChatGPT 登录的模型目录请求可发现新增模型，API Key 模式不承诺自动列入选择器。

入口使用 WebSocket 时开启 route.websocket.enabled。目标接收协议必须在插件绑定的 `target.protocol` 中声明；Responses 目标也开启 websocket 时使用原生 WS 上游，否则使用 HTTP/SSE。缺少协议时拒绝保存，不从 route/service 推断。每个连接串行生成，断开取消活动请求。WS 实现沿用握手限流；需要未支持的逐生成硬预算时，目标生成在连接上游前拒绝。

普通与工具历史可跨 worker/模型重编码；可信身份的临时缓存默认 10 分钟失效，不持久化正文。丢失引用、不可还原的压缩/加密历史要求新建对话；原生加密引用只能回到经验证的相同上游。实现不启用 Anthropic thinking 或模拟服务端搜索，强制搜索明确报错。

## 模型目录与调度

目录模板对应 Codex CLI 0.160.1；保留原生字段与顺序，display_name 使用目标目录名称，slug 使用原始模型标识。capabilityOverrides 只能限制已支持的能力，不能制造上下文长度、服务端搜索或签名 thinking 支持。按请求合并，不跨身份缓存，返回 private/no-store 与新 ETag；泛用 data[] 仍保持形状。

内部调度只使用编译时 gateway_target 引用，客户端不能通过参数指定任意 URL。每个请求最多调度一次；入口与最终 scope 都参与保护校验，最终 route/service/upstream 的原有规则继续执行。

## 转换字段与损耗

原生 Responses 透传不执行转换路径的偏好降级。Chat／Anthropic 目标经共享 Responses codec 重编码，具体可表示性不同：

| 输入 | 转换行为 |
| --- | --- |
| tools 与 additional_tools.tools | 合并注册；namespace function/custom 使用无碰撞名称并恢复逻辑名称 |
| 重复工具 | 同身份同定义去重，冲突拒绝；重复项仍计入工具预算 |
| custom 工具 | 包装单个字符串 input，回程恢复原文；不承诺目标原生执行 grammar |
| reasoning.effort | 仅目录和显式能力修正支持时映射；不猜 thinking budget |
| reasoning_summary_delivery=sequential_cutoff | 验证后省略交付偏好 |
| reasoning.summary、context=all_turns、text.verbosity | 验证后省略目标不可表示的生成偏好 |
| prompt_cache_key、client_metadata | 校验后不转发转换目标，不作为身份或路由依据 |
| include_usage | 校验布尔值，Chat 流请求 usage，Anthropic 使用协议自身事件 |
| include | 只接受 reasoning.encrypted_content 输出请求，转换结果不生成加密内容 |
| text.format | 保留可表示的格式约束；严格 JSON Schema 等不可表示约束明确拒绝 |
| access_programs 缺省、{} 或 cyber=standard | 接受；显式配置经校验后省略，目标使用自身策略 |
| cyber=daybreak_blue/red | 拒绝，不通过外部模型降级获取该权限 |
| 自动／none／缺省 web_search 声明 | 可省略；required 或强制指定服务端搜索拒绝 |
| 未知字段、未知输入类型、多候选 SSE、不可还原历史 | 明确错误，不丢弃语义后伪造成功 |

工具 JSON 不完整、流截断、取消和 incomplete 不写入成功连接历史。Anthropic 不能无损表达某些结构化输出及中途 developer 指令，也不支持 Router 的签名 thinking 续聊。转换诊断只记录字段路径、mapped/omitted、稳定原因码和请求 ID，不回显正文或参数值。

## 历史缓存

历史通过 canonical 插件 RPC 在 control 进程临时保存，不持久化正文或写命令日志。隔离键包含可信身份、入口、配置版本与绑定；无可信身份的 HTTP 请求应提供完整历史。

| 资源 | 默认上限 |
| --- | --- |
| 完整历史 | 512 条、32 MiB 总量、8 MiB 单条、10 分钟 TTL |
| 待组装 RPC 分块 | 128 项、8 MiB 总量、30 秒 TTL |
| 匿名 WS 连接内历史 | 32 条、8 MiB、10 分钟 TTL，关闭释放 |

普通与工具历史可以重编码；失效引用、compaction 或不可还原跨目标历史要求新建对话。原生加密历史只允许回到经缓存验证的相同 provider/model/target/upstream；每次选择与 failover 都检查来源，不因相同 URL 就放宽来源要求。

## WebSocket 会话

`response.create` 派生独立请求 ID 并重新执行绑定与最终链路；同一连接串行生成，busy 时拒绝新生成。`generate:false` 仅预热连接内输入，不访问提供商也不产生生成统计。response.cancel 和断连取消活动生成。

HTTP 上游经共享 SSE BodyHandle 转成 WS JSON；启用 WS 的 Responses 目标可使用原生上游连接。发送 drain、消息预算、关闭期限和旧代排空归核心[WebSocket transport](../../docs/architecture/websocket.md)。逐生成硬预算未支持时在上游连接前拒绝，不能用统计代替授权。

## 来源与验证方法

字段处理参考 cc-switch `b4a079430ce85a604e10d97d4b7530774e00e112` 的工具提取与测试场景；new-api `7aa3531ef4c247ad4891c06cc8ed9d0ffb73fecc` 和 sub2api `3a6fd1c9db07203ca308aaba69e502bc1f35b307` 用于核对转换损耗与历史边界。未复制这些项目的协议源码或增加依赖；移植实质源码时须保留对应许可证。访问模式依据 [OpenAI Daybreak](https://developers.openai.com/api/docs/guides/daybreak)，不授予目标权限。

[脱敏 fixtures](tests/fixtures/README.md)保留真实请求形状和不可表示约束。[真实进程测试](../../tests/codex-router-real-process.test.ts)经过实际宿主、worker 与 SQLite，但目录和模型上游使用 fixtures，不能证明远端提供商兼容。可选真实 CLI 检查使用 `BUNGEE_CODEX_CLI_PROBE=1`；它需要本地 Codex CLI，隔离配置和凭据，不访问用户实际会话。运行方法及证据边界见[开发指南](../../docs/guides/development.md)。
