# 插件 SDK 参考

插件通过 `@jeffusion/bungee-core/plugin` 导入公开类型和工具。该入口不启动宿主。协议转换通过 `@jeffusion/bungee-llms/plugin-api` 导入；禁止核心或转换包的源码、dist 深层导入。

完整类型以 [Plugin 与 manifest 类型](../../packages/core/src/plugin.types.ts)、[Hook 定义](../../packages/core/src/hooks/plugin-hooks.ts)、[控制面契约](../../packages/core/src/plugin-control/contracts.ts)及[公开 SDK](../../packages/core/src/gateway/plugin.ts)为准。开发流程见[插件指南](../guides/plugin-development.md)，机制见[插件架构](../architecture/plugins.md)。

## Manifest

所有 runtime 插件使用 `schemaVersion: 3`。路径相对插件目录；构建工具编译入口并改写发行 manifest，源码路径不是发行目录结构。

| 字段 | 含义与限制 |
| --- | --- |
| `name`, `version` | 唯一名称、SemVer 版本；与导出构造器元数据一致 |
| `artifactKind` | runtime 插件为 `runtime-plugin` |
| `main` | worker 插件入口 |
| `runtimeScope` | `scoped`（缺省）、`global` 或 `global-and-scoped`；双作用域插件自动发布全局服务，显式绑定运行自身配置，详见 [LLM 协议适配器](llm-protocol-adapter.md) |
| `capabilities` | 实际使用的能力，例如 hooks、api、dynamicRuntimeLoad、controlPlane；由严格 parser 校验 |
| `engines.bungee` | 可运行的宿主版本范围 |
| `control.entry`, `control.rpc` | 控制面入口、声明的 bound-attempt RPC |
| `ingress.entry` | ingress 入口，不自动加载 worker 全部代码 |
| `dependencies` | 必需插件及版本范围，加入自动激活闭包 |
| `optionalDependencies` | 不支持；依赖图拒绝该字段 |
| `services` | 提供／消费的 ID、整数契约版本、进程及服务种类 |
| `configSchema` | 插件选项字段；类型、默认值、验证和显示规则见类型定义 |
| `uiExtensionMode` | none、native-static 或 sandbox-iframe |
| `ui.components` | 构建期原生组件名称及相对入口 |
| `contributes` | API、导航、widgets、设置及资源扩展声明 |
| `management.loginComponent`, `management.setupComponent` | 已声明的原生登录、一次性初始化组件名称 |
| `translations` | 按语言组织的插件 namespace 翻译 |

完整可运行例子见[最小插件](../guides/plugin-development.md#创建插件)。严格字段和组合约束由 [manifest parser](../../packages/core/src/plugin-manifest-catalog/manifest-parser.ts)维护。声明能力是 Host 授权边界，不是 JavaScript 代码安全沙箱。

## 插件实例

```ts
interface Plugin {
  bodyRequirements(context: PluginBodyRequirementContext): PluginBodyRequirements;
  init?(context: PluginInitContext): Promise<void>;
  register(hooks: PluginHooks): void;
  reset?(): void | Promise<void>;
  onDestroy?(): Promise<void>;
}
```

`definePlugin` 约束构造器静态 `name`、`version`；构造器接收 binding options。`init` 在实例注册前取得作用域和已声明的能力。不得把 init 理解成“整个部署只执行一次”；global 的含义是每个声明进程的全局实例。临时状态通过 reset 清理，资源通过 onDestroy 释放，销毁需要等待在途租约。

缺少 `bodyRequirements` 或返回无效需求会使初始化／执行失败，不从 Hook 名称推断需求。该方法同步、无副作用，根据当前 method、URL、scope 和实际启用功能返回内容需求。

| `PluginBodyRequirementContext` 字段 | 含义 |
| --- | --- |
| `requestId`, `method`, `url` | 当前请求身份、HTTP 方法、URL |
| `routeId?`, `serviceId?`, `upstreamId?` | 已选择的对象；未选中 endpoint 不参与需求计算 |
| `stage` | route 或 selected |

| 需求 | 效果 |
| --- | --- |
| `request: 'none'` | 不请求正文视图，元数据插件通常选择此项 |
| `request: 'json-read'` | 共享只读 JSON，发送仍保留 wire 字节 |
| `request: 'json-write'` | 为改写建立可变副本；改写后建立新表示 |
| `response: ['json', 'sse-json']` | 选择需要的响应视图，可只声明其中一种 |
| `replay: true` | 独立要求重放保留，不等于解码需求 |
| `observe: {request?, response?, sse?}` | 可降级观察，不升级强制转发需求 |

## Hook 注册和返回值

通过 `register(hooks)` 注册 `tap`／`tapPromise`，名称用于定位，`stage` 用于同一 Hook 内排序。不同执行边界不能靠 stage 互换。

| Hook | 执行方式 | 回调结果 |
| --- | --- | --- |
| `onRequestInit` | 并行初始化 | 不改写请求 |
| `onBeforeRequest` | 串行瀑布 | 返回修改后的 MutableRequestContext |
| `onValidateOutbound` | 串行瀑布 | 读取最终深冻结的 OutboundValidationContext，发送前校验 |
| `onInterceptRequest` | 串行 Bail | 返回 InterceptResult 或不拦截 |
| `onResponse` | 串行瀑布，参数为 Response、ResponseContext | 返回 Response |
| `onRawResponse` | 原始响应边界 | 返回 RawResponseResult；严格完成／错误契约见类型 |
| `onStreamChunk` | 串行 Map | 封套数组；null 或空数组过滤，多个输出为 N:M |
| `onFlushStream` | 串行瀑布 | 返回剩余 SSEEnvelope 数组 |
| `onError`, `onFinally` | 并行通知 | 错误观察、清理与完成通知 |
| `onWebSocketHandshake` | 握手瀑布 | 握手上下文，不处理 HTTP body |
| `onWebSocketObservation` | 独立有界只读观察 | 遵守 isActive 租约 |

网关阶段 Hook（`onGateway*`）、准入与 attempt 观察的全部签名见 Hook 定义。平台装配要求必需网关阶段恰好一个 provider；普通 scoped 插件不应重复注册核心阶段提供者。

路由或服务阶段 `onInterceptRequest` 返回成功响应时，宿主仍执行当前访问权限的只读检查，再返回本地响应；不连接上游或预留上游预算。拦截响应不执行上游响应 Hook。

URL 可改 pathname、search、hash，不能改 protocol、host 或 port。Headers 在请求上下文中为普通记录，不是 Headers 实例。对冻结 JSON／事件进行转换时创建新对象，不能修改共享视图。

## 内部请求注解

`MutableRequestContext.annotations?: Record<string, PluginConfigValue>` 为插件拥有的内部 JSON 元数据。核心只负责传递、复制和冻结，不解释键或模型语义。dispatch 到最终 route/service、返回新上下文的请求 hook 和上游 hook 均传递注解。

每个故障切换 attempt 从 route/service 基线深复制注解；`OutboundValidationContext.annotations` 是最终注解的深冻结快照，attempt 之间不共享可变对象。修复重试保存当次最终注解，跳过已完成转换后重新校验。辅助请求和每次 WebSocket generation 都从新上下文开始，不继承父请求或上次生成的注解。

注解不从客户端正文或请求头加载，不写入上游请求、历史缓存或持久化数据。业务契约由相应插件的公开 contract 定义，例如[模型目录身份](llm-protocol-adapter.md#最终模型身份校验)。

## 正文与 SSE

上下文提供 `bodyHandle`；`bytes()`、`decoded()`、`json()`、`events()` 共享同一表示的计算，见 [BodyHandle 类型](../../packages/core/src/gateway/body-contracts.ts)。不自行 clone、tee、getReader 或从网络 Response 调用 json/text/arrayBuffer。四种表示及资源上限见[正文架构](../architecture/http-body.md)。

SSEEnvelope：

```ts
interface SSEEnvelope {
  data: string;
  json?: unknown;
  event?: string;
  id?: string;
  retry?: string;
  comments?: string[];
  raw?: string;
}
```

修改 data 或元数据后清除 raw；JSON 与 data 保持一致。原始 event 独立于 JSON.type，不能注入 `_event` 或推断已有事件名。协议转换器显式产生新协议事件。

```ts
hooks.onStreamChunk.tap('example', envelope => {
  if (!envelope.json || typeof envelope.json !== 'object') return [envelope];
  const json = { ...envelope.json, customField: true };
  return [{ ...envelope, raw: undefined, data: JSON.stringify(json), json }];
});
```

可选消费者独立取消、积压与超时；观察失败标记 incomplete，不将 unknown 记成零。安全准入、可靠预算等强制能力不能通过吞异常放行。

## 内部调度与准备

`onDispatchRequest` 只解析编译配置声明的 `gateway_target`，返回最终 target/protocol 及可选一次性 `prepareRequest`。宿主先执行入口和最终目标的只读访问授权，再调用准备回调，随后转换正文并进入正常上游链路。Ingress 插件通过 `authorize(target, policy)` 返回拒绝或 null；此阶段不调用 plan、生成准入票据或提交预算。实际发送前仍执行正式准入，每次最终模型映射和尝试都检查适用权限。

声明 `protocol` 的生成调度使用 `@jeffusion/bungee-llms/plugin-api` 的 `protocolRequestPath`：Responses 为 `/responses`，Chat Completions 为 `/v1/chat/completions`，Anthropic Messages 为 `/v1/messages`，Gemini 为 `/v1beta/models/{model}:generateContent` 或 `:streamGenerateContent`，流式 Gemini 设置 `alt=sse`。函数覆盖上述四种格式，具体插件的可选协议仍由其配置和转换能力限定。端点不继承入口路径。service 目标直接使用端点，不执行入口的 `path_rewrite`；route 目标在端点前加目标 route.path，再执行该目标的路径规则。未声明协议的调度使用入口相对路径，同样只为 route 目标添加路由前缀。附属 Responses 请求使用相同端点规则。

上游 URL 的路径作为网关基址前缀拼接。Responses 保留宿主及提供商插件的 `/responses` 入口契约：公共 OpenAI API 的上游基址包含 `/v1`；ChatGPT OAuth 上游基址使用 origin，由其插件改写到 `/v1/responses` 或原生 Codex 后端。其他三种端点已包含 API 版本，上游基址不应重复包含 `/v1` 或 `/v1beta`。

准备回调获得可信 principal、固定 servingRevision、取消信号和 `executeAuxiliary`，WS 还提供宿主生成的连接身份及关闭信号。附属请求只能选择当前插件编译配置中已声明的 route/service；不能提供任意地址、凭据或可信身份，也不能再次内部转交或创建附属请求。它复用唯一 Gateway provider 和完整目标插件链，不通过监听端口绕回自身。

附属请求具有独立 requestId、父请求关联、admission、尝试和结算。返回 `kind: response` 时包含 status、共享 BodyHandle、completion、实际模型/upstream 及不透明凭据作用域、dispose；`kind: reused` 返回已授权的复用值及实际目标身份。复用检查在实际凭据与模型解析及只读授权之后、上游连接和预算提交之前执行。调用方必须检查完成状态并释放响应；宿主禁用附属正文日志，保留状态及计量。

显式传入附属 signal 表示取消由共享调用的聚合等待者管理；未传则继承父请求取消。共享调用必须通过公共 `services.runBackground` 保持独立授权帧和租约，不能借用已结束或已取消请求的 RPC 授权。

## 持久化和插件通信

控制面取得命名空间 `durableState`，所有操作异步。`get/list` 返回不可变版本记录，`transact` 用 expectedVersion 做同库原子 CAS；普通更新不生成历史命令。幂等业务操作经声明的 RPC command journal，未知结果先查询或 reconciliation，禁止换 ID 自动重执行。

普通 KV、秘密存储、可靠事件与命令日志位于 plugin-state.db；观察数据位于 access.db。状态、结果及 outbox 的原子契约、纯 planner 读集、队列与关闭 ACK 见[存储说明](../architecture/storage.md)。插件不能取得配置库裸连接。

同进程服务通过 `context.services.consume` 使用已声明的 provider、ID 和版本；跨进程使用声明的 RPC，事件、snapshot 和可靠 channel 使用各自契约。消费另一个插件的 namespace 不是通信接口。声明例子可查 [model-mapping manifest](../../plugins/model-mapping/manifest.json)和[插件服务类型](../../packages/core/src/plugin-services.ts)。

本地服务门面受控转发 AbortSignal、Promise、异步迭代器和函数回调，数据及二进制视图提供隔离副本；实现对象身份不对外开放。所有操作仍受消费方和提供方排空、租约及撤销检查。跨进程 RPC 继续使用数据契约，不能传递这些进程内句柄。需要在插件租约结束后保存的日志详情必须在记录时取快照。

## API、UI 与资源扩展

插件 API 声明 path、methods、handler、execution 和 capability；Host 按当前 management subject 授权后调用。不得从请求 JSON 自行信任 principal。资源 collection／extension reader 只取得 get/list，不启动停用插件，不授予写能力。

`native-static` 组件随 UI 构建注册，不能运行时任意注入 Svelte 模块；iframe 扩展使用沙箱协议，不能当作原生组件访问宿主。导航是业务页入口，设置和 widget 使用对应 contributes 字段，不使用旧 handler/settingsPage 示范。

插件 UI 遵循[UI 指引](../../packages/ui/AGENTS.md)和[工业规范](../../packages/ui/docs/INDUSTRIAL_DESIGN_SYSTEM.md)。宿主提供 widget 外框，组件不重复绘制卡片。类型和示例见 [UI SDK](../../packages/ui/src/plugin-sdk)及[user-auth manifest](../../plugins/user-auth/manifest.json)。

## 管理认证登录界面

管理认证插件通过 manifest 声明登录与一次性初始化组件。`management.loginComponent` 和 `management.setupComponent` 必须引用 `ui.components` 中的组件名；组件随 `native-static` UI bundle 编译、发布，并应与运行它的 Bungee 版本匹配。

```json
{
  "uiExtensionMode": "native-static",
  "ui": {
    "components": [
      { "name": "ExampleManagementLogin", "entry": "ui/ManagementLogin.svelte" },
      { "name": "ExampleManagementSetup", "entry": "ui/ManagementSetup.svelte" }
    ]
  },
  "management": {
    "loginComponent": "ExampleManagementLogin",
    "setupComponent": "ExampleManagementSetup"
  }
}
```

登录组件使用 `@bungee/plugin-sdk` 导出的纯类型 `ManagementLoginContext`。上下文类型如下；它不提供可变 endpoint、平台 store 或通用认证实现。`login` 的结果为 `unknown`，必须按插件自己的响应协议进行运行时收窄和解释；只有确认插件登录成功后才调用 `complete()`。平台会独立使用 Cookie-only verify 核验登录模式、provider 和会话，再初始化既有 Dashboard、导航与插件 API，不接受插件提供的 subject 或 token 作为认证结论。

```typescript
export interface ManagementLoginContext {
  readonly provider: Readonly<{ name: string; publicOrigin: string }>;
  loginOptions<T = unknown>(): Promise<T>;
  beginLogin(input: { methodId: string; returnTo?: string }): Promise<{ authorizationUrl: string; flowId: string }>;
  login(input: unknown): Promise<unknown>;
  complete(): Promise<void>;
}
```

```typescript
import type { ManagementLoginContext } from '@bungee/plugin-sdk';

interface LoginResult {
  readonly success: true;
}

function isLoginResult(value: unknown): value is LoginResult {
  return typeof value === 'object' && value !== null
    && 'success' in value && value.success === true;
}

async function submitLogin(context: ManagementLoginContext, payload: unknown): Promise<void> {
  const result = await context.login(payload);
  if (!isLoginResult(result)) return; // 保留插件自己的字段校验与错误展示
  await context.complete();
}
```

登录组件负责凭据输入、认证步骤、错误与恢复帮助；平台负责通用页面框架、路由、会话验证及登录后的初始化导航。静态翻译必须在登录前可用，并放在插件自己的 namespace 中。不要依赖登录事件、导入 Dashboard 的 `$api`／`$stores`、自行恢复宿主会话，或通过公开插件 catalog 查找登录组件；组件缺失时平台应显示不可用状态，不能退回匿名管理。

登录上下文提交请求时会绑定当前 provider。provider 已变化时请求以 `409 authentication_provider_changed` 拒绝；未携带绑定 header 的 API 调用不具有该 provider 变化检查。浏览器交接只接受 Cookie 会话；请求代次保护只能避免过期结果污染当前 UI 状态，不能撤销已创建的服务端会话，也不能消除浏览器全部 Cookie 竞态。

JSON login 保留原有凭据交接。可选 `ManagementProvider.loginOptions`、`beginLogin`、`completeLogin` 分别通过固定 `GET /api/auth/login/options`、`POST /api/auth/login/start` 和 `GET /api/auth/login/callback/:methodId` 分派到当前 provider；未实现时返回 501。start 校验公开 Origin 和 provider 绑定。回调保留 provider 的重定向及多条 Set-Cookie；provider 切换后丢弃旧响应。Host 不解释协议业务，也不开放任意匿名插件路径；登录交互响应不缓存。

初始化组件使用 `@bungee/plugin-sdk` 导出的纯类型 `ManagementSetupContext`：

```typescript
export interface ManagementSetupContext {
  readonly provider: Readonly<{ name: string; publicOrigin: string }>;
  initialize(input: unknown): Promise<void>;
}
```

Host 将初始化请求绑定当前 provider 与页面生命周期，通过固定 `POST /api/auth/setup` 调用 `ManagementProvider.initialize(request)`。user-auth 的输入为 `{setupCode, username, password, passwordConfirmation}`，不接受 `code` 别名。Host 负责公开 Origin 校验和初始化框架，插件验证一次性码、字段与限流，并原子建立身份。初始化成功回登录页，不创建会话，也不执行登录后的 Dashboard 初始化。

`ManagementProvider.setupStatus()` 返回 `uninitialized` 或 `ready`。未初始化时 Host 只呈现受限初始化入口；状态或组件不可用时拒绝访问，不匿名放行。code 的签发、重签与身份恢复通过停机 TTY 能力完成，不通过在线激活向导收集凭据。具体账号、码及会话策略见 [user-auth](../../plugins/user-auth/README.md)。

`OfflineRecoveryCapability.kind: identity` 仅通过停机后的本地 TTY action 调用。重置字段由插件的 `prompts` 声明，Host 关闭输入历史并隐藏 `secret: true` 的输入；Host 不解释账号或密码规则。结构化 stdin 和 owner-only 文件只接受 `kind: plugin-state`，不能调用身份恢复能力。输入限制与操作入口见[离线恢复](../guides/offline-recovery.md)。


---
