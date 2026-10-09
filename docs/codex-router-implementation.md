# Codex Router 实施记录

## PR #76 合并后的基线更新（2026-10-09）

#76 以 squash 提交 `8fc891dd5d37df3197a00dce17ba1506f047fa0f` 合入 main，随后发布 5.17.0。将 #77 的功能提交从原 #76 head 重放到最新 main `01b0f2f`，再依次重放 #78、#79、#80，保留四阶段依赖关系。#77 重放无需人工源码合并；#80 的冲突仅在自动生成的 UI bundle，最终从源代码完整重建资源。重放前后功能源码一致，额外包含 main 的版本号与发布记录更新。

#77 完整构建、架构检查及目录、OAuth、配置、WebSocket 回归 346 pass / 0 fail；最终依赖链完整构建及专项 156 pass / 0 fail。构建后 master＋双 worker＋CLI mock 工具闭环 6 pass / 0 fail / 198 assertions。没有再次替换本地服务，既有真实提供商验收对应此前已部署镜像。

#77 随后的双平台 CI 暴露三项目录断言失败：外部插件构建名单、生产目录名单和目录数量仍预期新增插件前的 15 项。将这些断言在 #77 提交 `91c35b7` 补齐为包含 codex-router 的完整 16 项，保留精确名单及构建产物检查；后续分支同步重放，最终功能源码未变。独立相关回归 26 pass / 0 fail；在 #77 隔离工作树按 CI 顺序执行完整构建和 `bun test`，4319 pass / 3 skip / 0 fail，432 文件。上一轮专项检查未覆盖这三处断言，不能替代阶段 PR 的全量 CI。

修复提交的 [CI run 37929643399](https://github.com/jeffusion/bungee/actions/runs/37929643399) 在 Linux、macOS 均为 success；Linux 的 Playwright smoke、路由编辑器、原生滚动及仪表盘 ownership 回归也全部通过。此次只修正测试断言所在阶段，没有更新运行中的服务。

## Codex 请求协议修复（2026-10-09）

起点为 `codex/codex-router-websocket` 的 `090937b965d2d7d94555fa045021a40a4e4166f7`，继续 PR #80 的既有依赖链。没有新增 UI 选项、数据库迁移或旧配置兼容层。

两份完整脱敏 Desktop 请求保留工具定义、grammar、结构化输出和输入顺序，修复前可复现 additional_tools/stream_options 拒绝。CLI 版本为 0.160.1，Desktop 发出请求的版本无法从日志确认。样本位于 `plugins/codex-router/tests/fixtures/captured-app-*.json`。

### 字段与工具处理

模型目录的 `display_name` 直接使用 models.dev 的目标模型名称，例如 `GLM 5.3 Flash`；`slug` 保持绑定的原始模型标识，用于请求匹配。新增和替换条目均不在展示名称中拼接路由关系。目录专项 9 pass / 0 fail，覆盖替换、别名、原生条目保留及能力描述。

| 输入 | 转换规则 |
|---|---|
| 顶层 tools / additional_tools.tools | 转换前合并注册，载体不生成聊天消息；namespace 内 function/custom 共用编码与回程映射 |
| 重复声明 | 同身份、相同规范定义去重；类型或定义冲突拒绝；重复项仍计入工具项数预算 |
| custom | 包装为单个字符串 input，回程恢复原文；不声称目标执行原生 grammar |
| reasoning_summary_delivery=sequential_cutoff | 校验后省略，记录源交付偏好不适用于目标 |
| include_usage | 校验布尔值；Chat 流式强制 usage，Anthropic 使用自身 usage 事件 |
| access_programs 缺省 / {} / cyber=standard | 接受；有字段时省略并记录目标使用自己的访问策略 |
| cyber=daybreak_blue/red | 明确拒绝，不降级为普通外部模型调用 |
| reasoning.effort | 仅明确支持时映射，否则记录省略；不猜测 thinking budget |
| reasoning.summary / context=all_turns / text.verbosity | 验证后作为生成偏好省略并记录 |
| text.format | 保留实际格式约束；Chat 映射，目标不可表示时拒绝 |
| 加密/compaction/未解析引用/未知类型或字段 | 明确拒绝，返回具体 param，不丢弃语义继续生成 |

完整 base 样本包含严格 JSON Schema，完整 preferences 样本包含中途 developer 指令。二者在 Chat 路径通过；当前 Anthropic 无法无损表示对应约束，仍分别在 text.format / input[6].role 拒绝。较小但包含同种工具声明和生成偏好的 Anthropic 样本及真实 CLI 工具闭环通过。这是已知范围限制，不能报告任意 Codex 请求都兼容 Anthropic。

原生 Responses 沿用透传，不执行偏好降级。转换历史使用 codec 返回的 canonicalInput；原生 WS 引用续聊保留工具声明。失败、取消、截断和 incomplete 不写入成功连接历史。工具列表变化和跨 worker、跨协议续聊继续使用原始逻辑工具身份。

诊断只含字段路径、mapped/omitted 动作、稳定原因码，通过 dispatch 写入已有请求步骤 codex_router_conversion，并携带逻辑 requestId；HTTP、WS 共用 worker 的请求日志依赖。没有独立统计或新日志表。错误详情经跨 bundle 归一化保留安全 message/param，正文和参数值不回显。

### 参考与许可

以 cc-switch `b4a079430ce85a604e10d97d4b7530774e00e112` 的工具提取和测试场景作为行为参考；new-api `7aa3531ef4c247ad4891c06cc8ed9d0ffb73fecc`、sub2api `3a6fd1c9db07203ca308aaba69e502bc1f35b307` 用于核对转换损耗和历史边界。未复制这些项目的协议源码，未增加依赖或第二套网关。后续若移植实质 cc-switch 源码需保留 MIT 版权和许可。访问模式依据 [OpenAI Daybreak 文档](https://developers.openai.com/api/docs/guides/daybreak)，不授予目标权限。

### 本轮证据

- 最终 codec、插件历史、核心 HTTP/WS 与安全错误专项：147 pass / 0 fail。
- 架构检查、llms/core 构建通过；完整 types/UI/CLI 构建在本轮早期通过，UI 无改动。
- 构建插件＋真实 master＋双 worker＋真实 CLI：6 pass / 0 fail / 197 assertions；Chat、Anthropic 都实际执行 printf、custom 文件补丁和本地 MCP。mock 必须收到三项对应工具结果才返回最终答案；补丁文件、执行事件、MCP 审计、call_id、出站历史及计量均断言通过。
- 完整 Desktop fixtures 经公共 HTTP、WS 到达 Chat mock；跨 worker 的 Chat→Anthropic 规范历史和工具声明变化通过；WS 生成的诊断已查询既有 access.db processing_steps 确认落盘。
- 独立复核 P2：无条件清理 WS 工具声明破坏原生引用续聊。改为只使用转换路径的 canonicalInput，补绑定/未绑定原生续聊测试（9 pass），同轴复审确认修复。诊断宿主依赖补充复审无新增 P0–P2。
- 全量源文件精确路径回归：4111 pass / 0 fail / 32078 assertions，386 文件。Bun 未加 ./ 的过滤器会额外收集 dist 下复制的测试，首次两次运行因此有两项模块路径错误；最终精确源文件运行退出 0。
- 镜像 a8208ab6b6819e52a19a10ab19baa2a19b6d81c5 构建期间旧实例持续运行，随后 compose up --no-deps --force-recreate 直接替换，无 compose down、预先停服或额外备份。Compose 返回后 8.55 秒 /health 恢复 200，容器 healthy；这不是精确停机时长测量。配置版本切换前后均为 132，现有 gpt-6-luna→zai/glm-5.3-flash 绑定不变。
- 初次真实 CLI probe 两轮 failed、无工具执行。后续核对 401 日志发现其来自 `/chatgpt/` 当时选中的原上游，而非已经证实的 CLI 入口认证失败；此前“未到上游、需要重新配置 CLI 认证”的判断撤回。用户将目标 `/zai/oai` 临时公开后，直接调用返回 200；Router 的实际工具续聊问题及修复证据见下节。
- 当前没有已绑定的真实 Anthropic 目标；真实 Anthropic、跨真实提供商续聊与 Desktop 人工验收仍有缺口。上述 fixture/model mock 证据不代替这些验收。

真实提供商 probe：`BUNGEE_REAL_CODEX_PROBE=1 bun tests/support/codex-router-provider-probe.ts <现有公开模型> <现有入口URL>`。仅在明确授权后使用；由 Codex 自己使用现有认证，不读取或复制凭据，不写用户配置，不修改服务绑定。随机临时目录包含三行文本和本地 MCP，验证读取→修改第二行→重读→MCP→无工具续聊两个 nonce，保留临时目录用于核验。

### 真实 GLM 工具续聊修复与验收

真实请求已到达绑定的 `/zai/oai`，但 CLI 回传的 `reasoning` 含 `encrypted_content: null`、`content: null` 和明文 summary。旧判断使用 `!== undefined`，将 null 误判为不可还原加密历史，在 `input[3]` 返回 422。修复提交 `00c207de559b30d7528cd56bd62384ebee6a4129`：只将非 null 加密内容视为不可还原；Chat 的明文推理历史能力与 reasoning.effort 参数映射分离，按实际模型能力映射到 assistant.reasoning_content，不要求开启 effort override。

非空 reasoning.content 尚未实现转换，仍明确拒绝并返回该项 `.content` 位置；真正的加密、compaction 及 Anthropic 无法重编码的推理历史仍拒绝。独立复核指出非空 content 会丢失的 P2，已补严格检查和负向测试；同轴复审确认修复，无新增 finding。

- 最终 llms/插件专项 123 pass / 0 fail / 780 assertions；架构检查及 llms/core 构建通过，镜像完整构建通过。此前包含核心 HTTP/WS 的专项为 146 pass / 0 fail。
- 构建插件＋master＋双 worker＋CLI mock 闭环：6 pass / 0 fail / 198 assertions。Chat 工具响应新增明文 reasoning_content，下一轮必须将其原样传回上游才允许完成；Chat、Anthropic 原有三种工具闭环均通过。
- 按授权直接替换本地镜像到 `00c207d`，容器 healthy，`/health` 为 200；构建期间旧实例持续服务，未执行 compose down 或提前停服。单实例容器替换可能短暂断连，本轮未测量精确中断时长。配置版本仍为 132，未修改模型绑定。
- 真实 CLI 0.160.1 从 `/chatgpt` 选择 gpt-6-luna，经现有 Router 绑定到 `/zai/oai` 的 glm-5.3-flash，目标既有模型映射出站名称为 `GLM-5.3-Flash`。实际传输为 HTTP/SSE。
- 在 `/tmp/bungee-provider-probe-dFYdIQ` 实际执行两次本地命令、一项 custom apply_patch 文件修改、一项 namespace MCP echo。只替换三行文本中的第二行，其他行字节保持；MCP 审计记录实际调用。首轮和无工具续聊均 completed，fileExact、mcpExact、continuationExact 全部为 true。随机标记为 `79a43748-64d2-46d4-bccd-b29e4d858f47`。
- 6 次逻辑生成均为 200/completed，分别且仅各有一条 completed token 记录。日志检查确认原始 call_id 顺序、工具输出、文件标记、MCP 标记及明文推理均进入目标 Chat 历史。首个访问请求 `ad7db71e-ca39-4b3c-9382-b550ef48439d`，续聊 `c92c40d5-0b45-4c52-9644-441944eb1d65`；各自逻辑 ID 为 `fa36e665-3311-4607-8584-071624bfdbbd`、`5348ff58-71ac-43e8-bf67-23fbd890001e`。

probe 仅在本次子进程关闭 Apps/Plugins 功能，防止模型误选用户的远程文件工具；用户配置与认证不变。本地文件工具使用绝对临时路径。之前的一次失败尝试调用了远程 MCP 并得到路径不存在，不能当成本地 MCP 成功证据。

本轮确认真实 GLM 的 HTTP/SSE CLI 文件、custom 和 MCP 工具续聊；真实 WS 客户端、Desktop 人工操作、真实 Anthropic 和跨真实提供商续聊仍未验收。自动化 WS/Anthropic mock 证据不能代替它们。

## 协议字段清理（2026-10-09）

删除本轮开发新增的 route/service 协议字段、校验、SDK 元数据和运行时回退，不保留兼容格式。Codex 绑定的 `target.protocol` 是唯一目标协议来源；缺少时配置发布与插件初始化均拒绝。表单选择转发目标不再自动预填协议。

验证：插件/HTTP/历史/调度 36 项、配置编译/策略/schema 34 项、作用域与 manifest 31 项、实际本机 WS 6 项、架构检查 32 项通过；types/UI/core 构建与 Chromium 绑定表单验证通过。实际 master＋双 worker 5 项验收覆盖缺少协议的发布拒绝（422，配置及 serving revision 不变）、跨 worker 历史、模型切换、取消和排空，12 次逻辑生成对应 12 次上游调用。空绑定和非匹配模型均保留原生 WS 传输。

独立只读复核没有可确认 P1/P2；两个验证缺口分别通过未绑定 WS 测试、registry 初始化拒绝和正式发布入口拒绝测试补齐，由主线程自行核验。上游和目录为 fixtures，尚未补充真实 Desktop/提供商证据。本轮清理未替换本地服务镜像。

## 绑定配置与实际交互修复（2026-10-09）

本地服务已按授权更新至 `0006157`。以下为其后的修复：

- 模型绑定编辑器迁移为 Svelte 5 响应式状态；手动/目录模式可双向切换，本次编辑中分别保留两种草稿。保存后的手动模式由缺少 sourceProvider 识别。
- 源/目标提供商均复用 searchable BSelect 在字段内过滤。空的转发目标使用提示文案；目标标签区分路由/服务，加载中及失效引用均不暴露内部数组编码。
- 插件摘要随语言包和语言切换更新，模型绑定显示 `源模型 → 供应商/目标模型`、协议名称和本地化目标类型；通用结构化配置不再经过 String(object)。
- 新绑定在插件中保存 `sourceProtocol: responses` 及 `target.protocol: responses|chat_completions|anthropic_messages`。插件负责协议转换，route/service 负责转发链路；路由和服务编辑器移除模型协议字段。目标协议仅来自绑定的 target.protocol，HTTP/SSE、模型能力目录与 WS 传输选择共用这一声明；删除本轮曾添加的 route/service 协议字段及回退逻辑，缺少协议明确拒绝。当前源入口仍仅支持 Responses，不宣称其它源协议已实现。
- 移除重复目录设置页及其 native widget 注册；`/catalog` control API 和路由内绑定表单继续使用 models.dev。目录管理留在 models.dev 插件。
- 绑定弹窗复用 IndustrialDialog，滚动仅作用于表单正文，头部和操作区固定在视口内；绑定的各 Select 使用公共固定定位 renderer。

验证：41 项配置/目录/HTTP 协议/摘要专项、4 项实际本机 WS、17 项 dispatch/作用域/表单回归、23 项 manifest/schema 契约和 32 项架构检查通过；完整 UI 回归 452 pass / 0 fail，最终取消焦点修复后补跑 3 项表单处理测试及完整绑定浏览器脚本通过。UI/core 构建通过。Chromium 验证中英文摘要、双模式草稿、提供商字段过滤、协议保存重开、1440/768/390/320px、390×560 矮视口、多绑定、弹层点击、Escape、正文滚动、保存/取消返回焦点。WS 补验目标启用 WS 且绑定 Chat/Anthropic 时仍使用 HTTP 转换，上游未收到 Upgrade。

独立审查未发现可确认 P1/P2；提出的矮视口/多绑定/焦点与 WS 协议覆盖缺口已逐项补验。补验发现取消后的焦点缺失，已在取消处理器中局部恢复并通过实际浏览器验证；该修复为局部机械更改，自行验证，无需复审。模拟接口验证不代表真实提供商验收，不修改生产绑定配置。

## 统一可搜索下拉交互（2026-10-09）

原先 ClientModelPicker 使用可编辑 input 加独立分页，PriceModelPicker 使用 Popover/Command 加另一套分页。现两者都通过公共 BSelect 的 remoteSearch 模式使用同一内部 renderer；普通本地单选、multiple/tags 保持原路径，searchable 本地过滤与 creatable 单选也复用该 renderer。

搜索直接在字段内输入，弹层不再放第二个搜索框。滚动接近底部自动加载下一批并去重追加，不替换已加载选项；键盘到达已加载候选末尾也可继续加载。底部使用低对比状态边界，显示加载数量、完成或失败重试，并提供简短的“加载更多”键盘入口。没有页码和前后页按钮；目录表格保留显式分页。既有服务器分页协议、50 条批次和 abort/generation 取消服务继续复用，没有新增协议或依赖。

搜索、供应商或目录版本变化会回到首批；关闭、禁用和卸载取消请求。已确认值与查询词分开保存，Escape 恢复确认值且不关闭外层编辑弹窗。客户端别名允许明确确认自定义值，目录目标只允许选择候选。浮层沿用项目现有 Floating UI 定位库，避免旧 Popover 的模态点击拦截影响字段输入；事件通过 Svelte events API 直接监听，避免 portalled 编辑弹窗抢先处理 Escape。

验证：64 项共享模型搜索、单选/空值兼容、文字角色、样式与迁移检查通过；完整 UI 回归 451 pass / 0 fail / 4199 assertions；32 项架构检查和 UI/core 构建通过。完整 UI 回归首次受限沙箱运行因 Chromium 权限失败，允许本机浏览器后重跑全量通过。两个真实 Chromium 脚本加载构建后的管理界面，覆盖 Token 统计、设计参考、仪表盘及 Codex Router 实际路由编辑器；模型/API 数据和草稿写入均为 fixtures。覆盖追加保留与重复请求抑制、失败原批重试、键盘跨批次、末批停止、旧响应丢弃、目录版本重置、自定义确认、多行定位、活动搜索卸载、禁用候选、合成 IME 键盘事件，以及 1440/768/390/320px 布局；实际带 transform 的路由编辑弹窗内，50 条候选浮层在四种宽度下均位于视口内。截图已人工点验；未运行会写真实配置的 provider 业务验收脚本，未部署正式服务。

独立复核未发现可确认的 P1 或运行时 P2，发现两项验证链 P2，分别处理：

| Finding | 处理与验证 |
|---|---|
| creatable 迁移后旧测试仍强制提取已删除 selectCreatableItem | 更新现有测试保留普通选择、空值、清空、多选/tags 与回调断言；4 项该文件回归通过。真实 creatable 确认/清空由新 Chromium 脚本覆盖。 |
| 第二条映射业务脚本全页面定位输入造成 strict mode 冲突 | 恢复 row 范围定位；人工点验脚本对应两处修改，Chromium 模拟两条映射验证行内定位及删除活动搜索，不访问真实配置。 |

以上 findings 为局部测试适配，已处理并自行验证，无需复审。浏览器证据不代表真实提供商或生产配置验收；合成 IME 事件不代表系统输入法的人工验收。

## 界面与模型替换语义修正（2026-10-09）

以下阶段记录中的“未部署”是当时状态：`f91ac4c` 已按用户要求更新到本地服务。本轮修复暂不继续部署正式服务。

原设置路径 `/catalog` 没有原生组件声明，导致页面回退 iframe 并被 `uiExtensionMode: none` 拒绝。现按 models-dev/chatgpt-oauth 的 native-static 契约注册设置页；原生页面解析尚未完成时也禁止临时回退 iframe。

模型绑定表单参照 Token 统计的映射布局，复用其分页目标模型选择器及搜索取消状态机，使用项目 Label/Input/BSelect/Button/NumberInput/BCheckbox。原始模型与目标模型分开显示，route/service 仅负责转发链路；能力限制使用类型化控件。设置页浏览目录，绑定仍随入口路由配置保存。

布局再次收敛为纵向分组：每条绑定有独立边框和标题栏，原始模型整行显示，下方目标提供商与目标模型并列，转发路由或服务整行显示；窄屏全部单列。标签统一使用 block Label，移除操作放在标题栏，能力限制独立折叠，上下文上限与能力选项分行。实际 Chromium 验证四种宽度下原始、目标、转发的纵向顺序、整行字段左边缘与宽度，以及并列目标控件的顶部和高度对齐；截图人工点验，接口仍为 fixtures。

后续原始模型选择也接入同一 models.dev 分页搜索控件，在“匹配请求”分组内并列原始提供商和原始模型；目标分组保持独立。可选 sourceProvider 保存原始目录筛选项，匹配仍只读取 source；同标识不同原始供应商不能绕过重复绑定校验。原始模型保留手动输入模式，兼容旧配置及自定义标识。页面说明改为客户端请求与入口路由，不绑定客户端品牌；入口协议仍是 Responses，此次不增加 Chat Completions/Messages 入口或移除 Codex 目录适配。

原始模型选择验证：20 项配置、目录、原生设置与共享搜索回归，以及 33 项插件/HTTP/WS 回归通过；UI/core 构建通过。真实 Chromium 验证原始供应商切换不改变目标配置、原始模型分页/搜索、目录与手填模式保存草稿后的恢复，以及四种宽度对齐与无溢出；截图人工点验。共享选择器的 Command label 同步搜索框名称，修正上游 aria-labelledby 对显式 aria-label 的覆盖，按可访问名称定位搜索的浏览器测试通过。业务接口与上游仍为 fixtures，此轮未部署。

新增 `source`，精确匹配请求中的原始模型；`provider`/`model` 仍是目标模型。匹配后请求改写为目标 `model`，返回目录和生成结果使用 `source`。显式 source 可替换原生同名目录项，按目标能力重新描述并保留位置；未绑定的目录项不变。旧 `alias ?? model` 语义保持兼容和原冲突检查，source 与 alias 同时出现或重复原始标识均拒绝。

独立复核的 P2 finding：目标模型不可用时，目录可能保留已被替换的原生能力描述。已对模型缺失、上下文长度缺失和不支持文本三类情况关闭失败：目录隐藏占用标识，请求在上游前返回 503；目录与真实 HTTP 流水线专项验证分别覆盖这三类情况。同轴复审确认该 finding 已关闭，直接修复范围没有新增 P1/P2。此前设置页复核的分页竞态通过复用 Token 统计的共享搜索状态机解决，真实浏览器延迟响应验证通过。

验证包含 native Responses 的 route/service 转发、Chat/Anthropic JSON/SSE 的不同原始与目标模型、原生 WS 的上游模型替换与客户端标识恢复、目录替换与旧配置兼容。真实 Chromium 加载构建后的管理界面和实际路由插件编辑器，验证模型选择、编辑状态保留、能力限制、分页竞态与 1440/768/390/320px 无横向溢出；业务 API 均为 fixtures，不代表正式配置写入或真实提供商验收。

基线：PR #76，`a570e6b946bee886249d0daef35e4ae8488d1adc`。开发从独立 `codex/codex-router` 分支开始，原工作区无改动。未部署，未激活生产配置。

依赖恢复：Bun 1.4.2，`BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/bungee-bun-cache bun install --frozen-lockfile`，锁文件未改。受限沙箱不能修改外部 Git 元数据，分支操作经授权执行；依赖 prepare 中 husky 无法写入 Git config，不影响锁定依赖恢复。

基线完整构建和架构检查通过。WebSocket 专项在受限沙箱因 loopback listen EPERM 失败；允许本机监听后 48 pass / 0 fail。该记录只证明本地传输，不证明真实 Codex/OAuth 提供商兼容。

插件挂载入口 route，配置 `models` 数组：每项 `provider`、`model`、可选 `alias`、`target: {type: route|service, id: UUID, protocol: responses|chat_completions|anthropic_messages}`、可选 `capabilityOverrides`。当前目标接收协议由绑定的 `target.protocol` 声明，缺少协议拒绝发布。不管理上游 URL/凭据，不添加模型前缀。

目录模板针对 CLI 0.160.1。保留上游原生字段与顺序；没有能力目录或上下文长度时不发布外部模型。默认不声明服务端搜索、并行工具或压缩历史支持。能力修正只限制目录所支持的能力。目录按请求合并，无跨身份缓存，返回 private/no-store 与新 ETag。泛用 data[] 仍返回 data[]。原生目录与绑定 ID 冲突在读取目录时拒绝；动态原生目录不可在离线配置编译时获取，不能声称已经在提交前验证远端原生冲突。

实现包含目录、内部调度、HTTP/SSE 转换、跨 worker 临时历史和 WebSocket 会话。真实 Desktop 界面与真实提供商联调尚未完成。

目录阶段：6 项新契约测试通过；models-dev/model-mapping 回归 31 pass；OAuth/配置编译回归 74 pass；完整构建与架构检查通过。目录功能有绑定 UI、版本化模板、通用 target 引用与循环校验。后续调度尚在下一阶段。

## 内部调度阶段

增加唯一 Gateway dispatch provider 和公开 onDispatchRequest Hook。目标只能来自入口插件 schema 中 gateway_target 声明的编译引用，客户端参数无法创建引用；每次请求最多转交一次，目标目录的 dispatch Hook 不再重入。route 目标运行最终 route/service/upstream 链路，service 目标使用入口 route 和指定 service；共享 service 插件及凭据按入口作用域初始化。

调度先于单一 admission session。可信 entryRouteId 随签名 RPC、preview 和 grant 固定，key-access 同时检查入口/最终受保护 scope；入口和目标不同的 route 限流分别应用。绑定目标发布时必须声明接收协议，只在插件绑定的 target.protocol 声明；目录阶段尚不能在离线发布时获知动态原生模型冲突。

验证：新增调度、既有流水线及引用检查 23 项通过；admission/key-access/scoped phase 51 项通过（监听端口测试在沙箱外重跑）；核心构建和 32 项架构测试通过。此阶段接通原生 Responses，转换目标仍返回 protocol_not_ready，下一阶段解除。

## 协议与历史阶段

`@jeffusion/bungee-llms/plugin-api` 提供共享 Responses 请求、JSON 响应和 SSE 状态机。Codex 调度按目标接收协议生成 Chat Completions 或 Anthropic Messages；目标已有转换链路继续处理后续转换。旧 openai-messages-to-chat 插件使用相同响应 codec，保留原请求兼容入口。多候选 SSE 不再做有损合并，而是明确拒绝。

namespace 工具使用无碰撞的线协议名称并恢复原名称；custom 工具包装为字符串 input 参数并还原。工具 JSON 不完整、流截断和未知终态不能产生成功完成。Chat reasoning_effort 需要模型目录支持以及显式 capabilityOverrides。首版 Router 不启用 Anthropic thinking：签名 thinking 历史不能可靠重编码，目录也不声明该能力；通用 codec 的单次显式 budget 接口不代表 Router 支持其续聊。未支持的图像、推理历史或参数返回明确错误。

CLI 常规附带的 prompt_cache_key/client_metadata 经校验后不转交转换目标，也不能成为身份或路由依据。include 中仅接受 reasoning.encrypted_content 这一可选输出请求；转换结果不生成加密内容，实际加密输入仍拒绝。自动/none/缺省工具选择中的顶层 web_search/web_search_preview 声明可以省略；required、强制指定搜索及其他未支持的服务端工具明确报错。普通工具和 grammar custom 工具仍交由 Codex 执行。

历史正文仅保存在控制进程的有界临时缓存，经 canonical 插件 RPC 分块访问，不写入数据库或命令 journal。缓存按可信身份、入口、配置版本和绑定配置隔离；默认 512 条、32 MiB 总量、8 MiB 单条、10 分钟 TTL。待组装 RPC 分块另限 128 项、8 MiB 总量和 30 秒 TTL。无可信身份的 HTTP 请求需要完整历史。引用失效及不可还原的跨目标历史要求新建对话。

历史 RPC 使用正式请求作用域，控制进程核验签名 worker、所服务的配置版本、入口插件绑定和可信 principal。延迟响应回调保留入口 owner lease 并重新建立 invocation，不借用过期 RPC frame。分块序列化转义 UTF-16 surrogate，避免 Emoji 在 canonical RPC 边界被拆断。原生加密历史只允许经缓存验证的相同 provider/model/target/upstream，所有选择和重试都检查来源 upstream；没有可信来源或切换目标时要求新建对话。

验证：阶段组合测试 110 pass；旧桥接及共享 codec 兼容测试 62 pass；核心构建、llms 类型检查和 32 项架构检查通过。该阶段覆盖真实核心 HTTP 流水线到 mock Chat/Anthropic 上游的 JSON/SSE，以及 canonical RPC 和独立消费者的历史读写；后续多进程证据见下一节。

## WebSocket 会话与真实本地验收

透明代理仍复用 #76。指定 Codex 入口的 Responses 会话通过核心 managed session 接入；每次 response.create 派生独立请求 ID、固定配置版本和可信身份，重新执行绑定及最终目标链路。首版同一连接串行生成，忙碌时拒绝新生成；generate:false 预热仅保存连接内输入，不连接提供商、不产生生成统计。response.cancel 和断开取消活动请求。

HTTP 上游使用共享 SSE BodyHandle，转换成 WS JSON；Responses 目标启用 websocket 时使用核心原生 WS 上游。发送等待 Bun drain，不重发已入队帧；接收、消息和进程预算、关闭期限、排空均归核心 transport。每个生成复用单一 admission 与逐次 token 统计，握手不重复计为生成。入口限流沿用 #76 握手能力；要求未支持逐生成硬预算的目标，在上游连接前拒绝。匿名连接的可还原历史只保存在连接内，默认最多 32 条、8 MiB、10 分钟 TTL，关闭释放资源。

`tests/codex-router-real-process.test.ts` 启动实际 master 和两个受监督 worker，加载构建后的插件并经过公共入口、真实 canonical peer RPC。目录和提供商是 fixtures。四项验收 4 pass / 0 fail / 81 assertions：100843 字节中文/Emoji 与普通、namespace、custom 工具历史跨 worker 续接；身份及配置版本隔离；Chat service → Anthropic route 切换；原生 WS 多轮、预热、busy/cancel/断开及旧 worker 排空。一次运行中 12 个逻辑生成对应 12 个上游调用，统计无重复。

可选真实 CLI 验收：`BUNGEE_CODEX_CLI_PROBE=1 bun test tests/codex-router-real-process.test.ts --test-name-pattern 'public WS generations'`。CLI 0.160.1 在隔离 HOME/CODEX_HOME 和临时 ChatGPT-shaped stub 登录下，实际查询 GET /models?client_version=0.160.1；model/list 显示全部四个原始 org/* 标识。选择 Responses、Chat、Anthropic 分别到达正确 mock 路径并完成生成。该专项 1 pass / 0 fail / 99 assertions；六次 CLI 生成各有唯一 token 记录（4/2）。五次 app-server 请求 outcome=completed；额外 API Key codex exec 成功收到答案并关闭传输，其 outcome=aborted，不能将其视为完整消费 HTTP 流的证据。真实 CLI 还完成了两轮 Chat 工具往返：exec_command 执行 printf 返回标记；custom apply_patch 的空补丁返回真实错误，无文件修改；独立 stdio MCP echo 返回标记。下一轮实际请求包含三个原始 call_id 的结果、custom 类型与 MCP namespace，随后生成完成。MCP 子进程关闭经身份核验。没有读取或改写用户实际 Codex 配置、凭据。

独立复审发现的问题和全回归中的回归均逐项处理：

| Finding | 处理和证据 |
|---|---|
| 加密历史可能进入其他 provider 或 failover endpoint | 保存来源并固定 upstream，跨来源和来源缺失明确拒绝；插件历史测试及独立复审通过。 |
| Anthropic thinking 缺少可重放签名 | Router 禁用该能力，覆盖配置 override 无法开启的测试；独立复审通过。 |
| refusal 响应无法用于下一轮 | 作为 assistant 文本重编码，两种协议的 refusal 续聊测试通过。 |
| 空绑定遗漏正式 dispatch owner lease | 根据实际 dispatch Hook 保留 owner，不按目标数量判断；正式 RPC host 下目录/原生生成透传测试通过，同轴复审通过。 |
| 同 URL 的无 ID 端点被预热去重 | 保留原有端点位置身份，只对新增预热的显式 ID 去重；既有 upstream scope isolation 回归通过，同轴复审通过。 |
| 普通非调度路由新增入口租约影响销毁 | 仅为参与 dispatch Hook 的 owner 提前保留租约；普通 routing 销毁回归与完整 suite 通过。 |

CLI 兼容调整复审没有新增 P0–P2；独立执行 33 项测试及 42 项兼容/拒绝矩阵断言通过。Unicode 分块与错误类归一化为局部修复，已自行验证，无需复审。主线程也点验了多进程日志、测试断言、三个客户端结果和统计记录。

## 交付、启用和验收边界

四个依赖分支按顺序派生，首个仍依赖未合并的 #76；合并前序后调整 base 并变基，不重新从 main 开始：

| 分支 | 提交/PR | 初始 base |
|---|---|---|
| codex/codex-router | 8a93db0 / [#77](https://github.com/jeffusion/bungee/pull/77) | codex/websocket-responses-metering |
| codex/codex-router-dispatch | ade7d15 / [#78](https://github.com/jeffusion/bungee/pull/78) | codex/codex-router |
| codex/codex-router-protocol | 2d62c99 / [#79](https://github.com/jeffusion/bungee/pull/79) | codex/codex-router-dispatch |
| codex/codex-router-websocket | ff3ced9 / [#80](https://github.com/jeffusion/bungee/pull/80) | codex/codex-router-protocol |

功能只有指定入口挂载并启用插件才生效。按 native Responses、Chat、Anthropic 的顺序逐个启用并做提供商验收；关闭插件并恢复入口配置即可回退，目标 route/service 原用途不变，临时历史允许失效。此次没有部署或激活生产配置。

最终完整构建通过，32 项架构检查和 llms 类型检查通过；协议、目录、桥接、Gateway 流水线、admission、master composition、公共 SDK 和 WS 的组合回归 223 pass / 0 fail / 1442 assertions。与 #76 相同范围的完整回归 `bun test packages/core/tests plugins scripts packages/ui/src` 为 4015 pass / 0 fail / 31340 assertions。最后一次 Hook owner 过滤调整没有重复完整 suite，已运行直接影响的 14 项回归（92 assertions）和真实 CLI/双 worker 合并验收（4 pass / 139 assertions，18 次生成对应 18 次上游调用），全部通过。旧测试的 registry stub 同步补齐新接口，构建清单添加 codex-router，不放宽生产调用。

尚未验证：真实 Desktop App 的选择器、真实 OAuth/外部提供商及真实客户端跨模型历史切换。跨模型切换证据来自 mock 契约及公共 WS 测试；CLI 工具执行已真实完成，但模型仍为 fixtures。服务端搜索、Anthropic 签名 thinking、多候选 SSE、不可还原跨提供商历史和逐生成 WS 硬预算不支持。动态原生目录冲突在读取时拒绝，未实现离线发布前的远端冲突保证；目标接收协议必须显式设置，未根据提供商名称推断。
