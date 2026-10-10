# LLM 协议适配器验收记录

实施基线：`main` 的 `506036bcccef0eb1d280501c4827bb3fc0cf279d`，已包含 #76–#81。开发分支：`codex/llm-protocol-adapter`。检查日期：2026-10-10；Bun 1.4.2；Codex CLI 0.160.1。最终代码以本次 PR 的提交为准。

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

CLI probe 默认关闭服务端 web search，仅验收本地命令、custom 工具和 MCP。服务端搜索不具备可还原的执行语义时仍明确拒绝，不静默删除工具。probe 的 mock 必须收到对应 `call_id` 的三项工具结果，才会生成最终答案；检查文件实际内容、MCP 执行记录、第二轮上游历史、客户端终态和计量，不能仅靠文本或 HTTP 200 通过。

整库 `bun test` 通过 4354 个测试、跳过 4 个、失败 0 个，共 34527 个断言。最终 `bun run build` 通过，包含类型、架构、UI、core 和 CLI 构建。

`BUNGEE_CODEX_CLI_PROBE=1` 的最终专项运行通过 9 个测试、268 个断言。覆盖原生目录/透传、Chat 和 Anthropic 工具往返、100843 字节历史的跨 worker RPC、HTTP/WS 完整失败样本、模型切换、取消、配置版本隔离和 worker 排空。CLI 实际通过 `turn/start.effort` 逐个选择 GLM 的 `low/high/max`、Anthropic 的 `low/medium/high/max`，同时检查 CLI 的模型列表、默认值和实际出站参数。工具闭环另验证默认 `glm-5.3-flash` 的 `reasoning_effort=max` 与 `thinking.type=enabled`，以及 `claude-sonnet-4-6` 的 `output_config.effort=high` 与 `thinking.type=adaptive`。

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
