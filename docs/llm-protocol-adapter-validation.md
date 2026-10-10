# LLM 协议适配器验收记录

实施基线：`main` 的 `506036bcccef0eb1d280501c4827bb3fc0cf279d`，已包含 #76–#81。开发分支：`codex/llm-protocol-adapter`。检查日期：2026-10-10；Bun 1.4.2；初次重构验收使用 Codex CLI 0.160.1，可选搜索补丁验收使用 0.162.1。最终代码以本次 PR 的提交为准。

## 隔离和证据范围

开发、构建及测试未替换镜像、重启正式实例、读取正式凭据、修改正式绑定或当前客户端配置，也未向正式 Bungee 发送请求。进程测试使用临时数据库、日志、插件产物、生成的测试 token 和 loopback 端口；CLI 使用临时 CODEX_HOME、工作目录与本地 MCP。清理仅处理本次 fixture 登记的进程。

| 层级 | 本次证据 | 尚未证明的范围 |
|---|---|---|
| 协议与插件 | 四协议支持矩阵、严格语义、JSON/SSE、生命周期、公共服务与历史 RPC 自动化 | 提供商的所有扩展字段 |
| 真实本地进程 | 构建产物下的 master、两个 worker、HTTP/WS、多轮工具历史、身份隔离、取消、排空及计量 | 正式配置发布和运行 |
| 真实 CLI → mock | 命令执行、custom 文件修改、本地 MCP、三项结果回传与最终回答，分别经过 Chat 与 Anthropic | 真实模型自主选择和调用工具 |
| 公开目录 | models.dev 线上下载，经实际能力解析器和适配器验证 | 提供商实际接受参数和推理效果 |
| 隔离 UI | 中英文、独立纵向选择器、键盘、必填/组合校验、保存/摘要/再次编辑 | Codex 桌面 App 人工操作 |

未配置独立的真实提供商测试凭据，未使用当前会话凭据补齐验收。真实提供商各档位、跨模型续聊和隔离 Desktop 验收保留缺口。没有将本地 mock 成功记为真实提供商兼容。

## 可复现入口

依赖使用 `bun install --frozen-lockfile`。先构建，再串行运行重型进程测试，避免使用旧插件产物：

```sh
bun run build
bun run check:architecture
bun test
BUNGEE_CODEX_CLI_PROBE=1 bun test tests/codex-router-real-process.test.ts
bun packages/ui/tests/protocol-adapter.browser.ts
```

本次补充修复移除了 CLI probe 对 web search 的强制关闭，按客户端默认 cached 模式验证。可选服务端搜索经校验后明确省略并记录诊断；强制搜索及无法还原的搜索历史仍拒绝。验收本地命令、custom 工具和 MCP，不宣称目标执行了内置搜索。probe 的 mock 必须收到对应 `call_id` 的三项工具结果，才会生成最终答案；检查文件实际内容、MCP 执行记录、第二轮上游历史、客户端终态和计量，不能仅靠文本或 HTTP 200 通过。

初次重构的整库 `bun test` 通过 4354 个测试、跳过 4 个、失败 0 个，共 34527 个断言。该阶段 `bun run build` 通过，包含类型、架构、UI、core 和 CLI 构建。

初次重构的 `BUNGEE_CODEX_CLI_PROBE=1` 专项运行通过 9 个测试、268 个断言。覆盖原生目录/透传、Chat 和 Anthropic 工具往返、100843 字节历史的跨 worker RPC、HTTP/WS 完整失败样本、模型切换、取消、配置版本隔离和 worker 排空。CLI 实际通过 `turn/start.effort` 逐个选择 GLM 的 `low/high/max`、Anthropic 的 `low/medium/high/max`，同时检查 CLI 的模型列表、默认值和实际出站参数。工具闭环另验证默认 `glm-5.3-flash` 的 `reasoning_effort=max` 与 `thinking.type=enabled`，以及 `claude-sonnet-4-6` 的 `output_config.effort=high` 与 `thinking.type=adaptive`。

普通专项测试还逐档检查 GLM `low/high/max` 出站映射；末次出站校验在上游连接前拒绝被模型映射/后续插件改变为不可兑现的模型、协议、effort 或 thinking。目录刷新后的新生成使用新资料，活动生成保持自己的能力版本。

旧转换插件和旧转换注册表已删除。矩阵、工具、历史、流式及失败语义测试迁入共享协议会话和新插件；仍被独立 LLMSRuntime/provider API 使用的测试移入 `packages/core/tests/llms-runtime`，不为旧插件保留入口或包装器。

## 公开目录和接口依据

本次公开下载 `https://models.dev/api.json`，大小 5381018 字节，SHA-256：

```text
351c480fa7ff0d6047a63b004e7bd6d7b3e4e35d8ced8ebbaa717d5a138bf368
```

使用实际 CatalogView 和 conversion service 读取同一快照：

| 精确目录标识 | reasoning_options | 有效 effort / 默认值 |
|---|---|---|
| `zai/glm-5.3-flash` | effort `low/high/max` | `low/high/max` / `max` |
| `anthropic/claude-sonnet-4-6` | effort `low/medium/high/max`，另有独立 budget 控制 | `low/medium/high/max` / `high` |

档位来自目录；接口限制与默认值核对 [Z.ai Chat Completion](https://docs.z.ai/api-reference/llm/chat-completion)、[Anthropic effort](https://platform.claude.com/docs/en/build-with-claude/effort)、[Anthropic thinking](https://platform.claude.com/docs/en/build-with-claude/thinking) 和 [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)。目录预算不划分为档位；没有经过核实的模型/接口映射不发布档位。

带提供商私有签名的推理历史不能跨协议直接复用；转换明确拒绝。Gemini 结构化输出需要已核实模型能力，未知目标不宣称支持。连续协议阶段各自检查自己的边界，最终线路无法兑现已选强度时失败，不尝试绕经其他协议或改成普通生成。

## 2026-10-10：可选搜索声明回归

用户实际请求在 `tools[28].external_web_access` 返回 422。只读核对的失败请求 ID 为 `f17d3ba3-fe82-4678-a618-3328d8a6421f`，声明为 `web_search`、`external_web_access:false`、`tool_choice:auto`，共 29 个工具；未将原始正文或凭据加入测试。

此前重构将可选搜索改成严格拒绝，CLI 验收又显式关闭搜索，遗漏了默认 cached 模式。用户确认允许省略可选搜索并记录诊断，强制搜索保持拒绝。修复集中在共享会话/codec，不在 Router 新增另一套规则。

官方依据：

- [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search)：`external_web_access:false` 为缓存搜索，不代表关闭搜索。
- [ZAI Chat Completion](https://docs.z.ai/api-reference/llm/chat-completion)：下载的官方 OpenAPI 中 `glm-5.3-flash` 位于 Vision 请求分支，tools 仅引用 FunctionToolSchema；WebSearchObject 不提供缓存访问控制。此为文档证据，不替代真实目标验收。
- [ZAI Web Search](https://docs.z.ai/guides/tools/web-search)：平台有独立及 Chat 内搜索服务，但不能据此宣称它与 OpenAI 的缓存限制、事件和引用语义等价。

回归包括 29 个声明（末项为 cached search）、Chat/Anthropic HTTP/SSE 与 WS、原有 namespace/custom 完整工具历史、降级日志、强制搜索在上游连接前拒绝，以及默认 CLI 搜索声明下的命令/patch/MCP 两轮执行。测试仅使用临时 master/双 worker 和本地 mock；未向正式 Bungee 或真实提供商发送测试请求。

本次补丁的共享协议、适配器及 Router 专项通过 171 个测试、1121 个断言；架构检查通过，`build:llms` 和 `build:core`（含类型检查及外部插件构建）通过。启用真实 CLI 的隔离进程专项通过 10 个测试、307 个断言，实际客户端为 0.162.1。目录请求版本与 app-server 初始化的 userAgent 核对，不再写死某个安装版本。Chat 与 Anthropic 各两轮均携带 `web_search/external_web_access:false`；文件实际内容、MCP 执行记录、工具结果回传与最终完成均通过断言。

本次补丁整库 `bun test` 完成，4357 个通过、5 个跳过、0 个失败，共 34645 个断言。测试日志仍有夹具关闭数据库后的清理告警，不将通过结果表述为零告警。可选搜索补丁 `57ba454` 随后按用户授权替换了本地服务镜像；自动化结果不替代真实提供商及 App 验收。


## 2026-10-10：模型别名与本地错误误熔断

`57ba454` 镜像更新后，用户报告 HTTP 503 `All upstreams are unhealthy and within recovery interval`。只读日志核验请求 `c61efa4d-1225-43ea-bff8-3ea401209db7`：目标 service 的既有模型映射将 `glm-5.3-flash` 改为 `GLM-5.3-Flash`，实际出站参数为 `reasoning_effort=max`、`thinking.type=enabled`。目录精确查询未识别 wire 别名，最后一次连接前校验抛出本地 `llm_adapter_unsupported_reasoning`。这不是提供商返回的 503。

独立插件 bundle 与核心的错误构造器身份不同。核心 attempt catch 仅检查 `instanceof`，误将本地 422 作为上游失败累计，最终触发熔断；外层已有的公共错误归一化来不及处理被内层吞掉的错误。本次在两个 attempt 分支的分类前复用 `normalizeAdmissionError`，不新建兼容层、不关闭熔断、不调整正式配置。

用户确认公司 wire 标识对应 `zai/glm-5.3-flash` 且支持相同档位。共享适配器增加这一提供商限定的明确别名，保留出站标识、实际参数及严格能力校验，规则版本更新为 `2026-10-10.3`。未知别名、未兑现的强度和关闭 thinking 仍拒绝。

使用修复前 HEAD 源码运行新增专项测试，复现三项失败：模型别名解析失败、别名 session 无法兑现强度、failover 路径将本地拒绝返回为 503。恢复修复代码后进行专项、构建和隔离进程验证，结果见下方。

验证结果（本次修复）：

- `build:core`（核心、全部外部插件及类型检查）和 `check:architecture` 通过，后者 40 个测试、63 个断言。
- 共享能力服务、Gateway 流水线、实际适配器和 WS 专项：107 个测试、555 个断言全部通过。独立 bundle 错误构造器不属于核心类，仍返回 422 和具体 `param`；连续拒绝不增加上游失败计数，不连接上游，也释放活动计数。
- `BUNGEE_CODEX_CLI_PROBE=1 bun test tests/codex-router-real-process.test.ts`：11 个测试、377 个断言全部通过。构建产物下的临时 master、双 worker 和真实模型映射插件，将目录模型改为 `GLM-5.3-Flash`；HTTP 与 WS 各连续 5 次拒绝未验证 wire 模型，随后两个 worker 正常生成，三档参数及工具历史完整保留。CLI 0.162.1 在别名链路执行命令、custom 文件 patch、MCP 和第二轮工具结果回传；8 次正常上游调用逐次计量且无重复。
- 调度、协议、修复重试、错误详情、授权预算、故障切换、选择器、运行时状态及凭据回归：145 个测试、1074 个断言全部通过。

整组验收最初暴露测试辅助代码复用旧 MCP 审计 PID 和已修改文件的问题，单场景通过不足以排除组间影响。每次工具 probe 改为独立临时目录后，完整整组通过；没有捕获旧 PID 后重试或忽略身份检查。测试资源正常关闭并按所有权清理。首次 WS 专项在受限环境因监听端口被拒绝，允许本机测试监听后同组全部通过。

本次修复未重跑整库，前一节的 4357 通过属于可选搜索阶段。未向正式 Bungee 发送生成测试请求，未修改正式绑定、数据库、凭据或镜像；本次误熔断修复尚未部署，真实提供商与 Desktop 验收仍需部署后另行核验。
