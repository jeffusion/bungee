# Plugin System

Bungee features a powerful, TypeScript-first plugin system that enables extensible request/response transformations with full type safety and IDE support.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [插件生命周期与作用域](#插件生命周期与作用域)
- [Plugin Directory Structure](#plugin-directory-structure)
- [Plugin Types](#plugin-types)
- [Configuration](#configuration)
- [Available Plugins](#available-plugins)
- [Writing Custom Plugins](#writing-custom-plugins)
- [Plugin Contributions](#plugin-contributions)
- [Plugin API Reference](#plugin-api-reference)
- [Plugin SDK (Frontend)](#plugin-sdk-frontend)
- [Build System](#build-system)
- [Testing Plugins](#testing-plugins)
- [Security: URL Protection Mechanism](#security-url-protection-mechanism)
- [Best Practices](#best-practices)

---

## Architecture Overview

Bungee 插件系统采用**分层架构**，支持内置插件和外部插件，同时提供前后端扩展能力。新架构引入了 **Artifact-first** 契约，将 `manifest.json` 作为插件元数据的唯一真相来源。

```plaintext
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Plugin System Architecture                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        Plugin Registry Layer                         │   │
│  │  ┌─────────────────────┐    ┌─────────────────────────────────────┐ │   │
│  │  │   PluginRegistry    │    │      PluginRuntimeOrchestrator      │ │   │
│  │  │  (Discovery/Meta)   │    │  (Reconcile/Generation/Convergence)  │ │   │
│  │  └─────────────────────┘    └─────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                     │                                       │
│                                     ▼                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         Plugin Sources                               │   │
│  │  ┌─────────────────────┐    ┌─────────────────────────────────────┐ │   │
│  │  │   Internal Plugins  │    │       External Plugins              │ │   │
│  │  │ packages/core/src/  │    │        plugins/                     │ │   │
│  │  │     plugins/        │    │   ┌─────────────────────────────┐   │ │   │
│  │  │                     │    │   │ token-stats/                │   │ │   │
│  │  │ • ai-transformer    │    │   │  ├─ manifest.json           │   │ │   │
│  │  │ • token-cache       │    │   │  ├─ dist/index.js (Artifact)│   │ │   │
│  │  │ • hooks-example     │    │   │  └─ ui/TokenStatsChart.svelte│  │ │   │
│  │  └─────────────────────┘    │   └─────────────────────────────┘   │ │   │
│  │                             └─────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                     │                                       │
│                                     ▼                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                       Plugin Capabilities                            │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────────┐ │   │
│  │  │    Hooks     │  │     API      │  │    UI Extensions           │ │   │
│  │  │ onRequest    │  │ /stats v2    │  │ 1. Native Widgets (Static) │ │   │
│  │  │ onResponse   │  │ groupBy=route│  │ 2. Sandbox Iframe (Dynamic)│ │   │
│  │  │ onStreamChunk│  │              │  │                            │ │   │
│  │  └──────────────┘  └──────────────┘  └────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Features

| Feature | Description |
|---------|-------------|
| **Artifact-first** | `manifest.json` 声明所有能力，框架按需加载，无需预执行代码 |
| **State Machine** | 完整的生命周期管理，支持 `quarantined` (隔离) 和 `degraded` (降级) 状态 |
| **Generation Control** | 基于 Generation 的多 worker 状态收敛，支持平滑热更新 |
| **UI Boundary** | 明确 Native Widget (静态) 与 Sandbox Iframe (动态) 的安全边界 |
| **Type Safety** | 全量 TypeScript 接口支持，IDE 友好 |
| **Scoped Execution** | Global, Route, Service, Upstream 四层作用域精确控制 |

---

## 插件生命周期与作用域

Bungee 的运行时插件由 `ScopedPluginRegistry` 按配置作用域创建长期存活的 handler，并在启动或配置热更新时预编译为可直接执行的 Hook 链。请求处理阶段不再临时查找或实例化插件，而是按 route、service、endpoint 组合读取已经编译好的 phase-aware hooks。

### 四层作用域模型

插件可以配置在四个层级，越靠近具体上游语义越具体：

| 作用域 | 配置位置 | 适用范围 | 常见用途 |
|--------|----------|----------|----------|
| Global | `plugins[]` | 所有路由 | 全局观测、通用审计、基础限流 |
| Route | `routes[].plugins[]` | 单个路由 | 认证、路由级限流、请求改写 |
| Service | `services[].plugins[]` | 引用该 service 的路由实例 | 协议转换、上游族群鉴权、响应转换 |
| Upstream / Endpoint | `services[].endpoints[].plugins[]` 或 `routes[].endpoints[].plugins[]` | 单个 endpoint 尝试 | endpoint 专属签名、目标端特殊兼容逻辑 |

推荐将“面向入口请求”的能力放在 Route 层，将“面向后端服务族群”的能力放在 Service 层，将“面向单个目标端”的差异放在 Endpoint 层。这样可以避免把协议转换、目标端鉴权等后端语义散落到路由层，也避免 endpoint 级插件承担全局策略。

### 三阶段执行模型

一次代理请求被拆成三个插件执行阶段：

1. **Phase 1: pre-failover route phase**：执行 global + route 插件，支持 `onRequestInit`、`onBeforeRequest`、`onInterceptRequest`。该阶段发生在 failover 前，适合入口级校验、限流、请求路径和 header 改写。
2. **Phase 2: pre-failover service phase**：执行 service 插件，支持 `onBeforeRequest`、`onInterceptRequest`。该阶段同样发生在 failover 前，适合协议转换、上游族群鉴权、service 级响应语义准备。
3. **Phase 3: per-attempt upstream phase**：每次 endpoint 尝试执行对应 upstream/endpoint 插件，支持 `onBeforeRequest`、`onInterceptRequest`、实际 proxy，以及响应入站链。failover 重试时只重新执行当前尝试的 upstream phase，不重复执行 Phase 1 和 Phase 2。

响应入站链按“最具体到最通用”执行：`endpoint -> service -> route -> global`。因此响应转换、流式 chunk 处理、flush、error 等入站 Hook 会先经过 endpoint 插件，再逐层回到全局插件。

### Phase-local 覆盖规则

同名插件只在同一个 phase 内按作用域覆盖，跨 phase 不互相覆盖：

- Phase 1 内，route 插件与 global 插件同名时，route 插件生效，global 同名实例被跳过。
- Phase 2 内，service 插件只在 service phase 内去重，不会覆盖 route/global 的同名插件。
- Phase 3 内，endpoint 插件只在 upstream phase 内去重，不会覆盖 service/route/global 的同名插件。
- 跨 phase 的同名插件会独立执行。例如同一个插件名同时配置在 route 和 service，Phase 1 执行 route 实例，Phase 2 执行 service 实例。

可以把覆盖优先级理解为 phase-local 的思路：在 Phase 1（route phase）内，route 插件覆盖同名 global 插件；在 Phase 2（service phase）和 Phase 3（upstream phase）内，各自独立按 `pluginName` 去重。不同 phase 表达的是不同生命周期点，同名插件不会互相吞掉，而是按 phase 独立执行。

### InterceptResult 语义

`onInterceptRequest` 可以返回三类结果：

| 返回值 | 含义 | 适用阶段 |
|--------|------|----------|
| `{ action: 'respond', response }` 或直接 `Response` | 终止当前请求，直接返回响应，不触发 failover | Phase 1 / Phase 2 / Phase 3 |
| `{ action: 'failover', reason? }` | 放弃当前 endpoint，进入下一个可用 upstream | 仅 Phase 3 |
| `undefined` | 不拦截，继续后续 Hook 或代理流程 | Phase 1 / Phase 2 / Phase 3 |

`failover` 只在 upstream/endpoint phase 有意义，因为只有 Phase 3 处于单次上游尝试上下文中。Route 或 Service 插件如果需要终止请求，应使用 `respond`。

### onFinally 分层

`onFinally` 被拆成两个生命周期层级：

- **request-level**：global、route、service 插件在一次请求结束时执行一次，用于清理请求级资源、记录整体指标、写入审计日志。
- **final-upstream-level**：endpoint 插件只对最终 upstream 执行一次，用于记录最终命中的目标端、释放 endpoint 级资源或写入目标端指标。

如果请求经历 failover，中间失败的 endpoint 不会执行 final-upstream-level `onFinally`；只有最终成功返回响应（HTTP 状态码 < 400）的 endpoint 进入该层级。当所有 upstream 都失败时，endpoint 的 final-upstream-level `onFinally` 不执行，但 request-level 的 `onFinally` 仍然执行。这样可以避免 endpoint 级清理和指标被每次失败尝试重复计算，同时保留请求级插件的“一次请求一次”语义。

---

## Plugin Directory Structure

### External Plugins（外部插件）

位于项目根目录 `plugins/`，采用 **Artifact-first** 结构：

```plaintext
plugins/
└── token-stats/              # 插件根目录
    ├── manifest.json         # 插件元数据（唯一真相来源 ✨）
    ├── dist/                 # 编译后的产物目录
    │   └── index.js          # 服务端入口（Artifact）
    └── ui/                   # 前端组件与资源
        ├── TokenStatsChart.svelte
        └── logo.png
```

#### manifest.json vNext 规范

**manifest.json 是插件元数据的唯一真相来源**。

**Sandbox Iframe 示例**

```json
{
  "name": "token-stats",
  "version": "1.0.0",
  "manifestContract": "vnext",
  "schemaVersion": 2,
  "artifactKind": "runtime-plugin",
  "main": "dist/index.js",
  "uiExtensionMode": "sandbox-iframe",
  "capabilities": ["hooks", "api", "sandboxUiExtension"],
  "engines": {
    "bungee": "^4.2.0"
  },
  "contributes": {
    "api": [...]
  }
}
```

**Native Widget 静态示例**

```json
{
  "name": "token-stats",
  "version": "1.0.0",
  "manifestContract": "vnext",
  "schemaVersion": 2,
  "artifactKind": "runtime-plugin",
  "main": "dist/index.js",
  "uiExtensionMode": "native-static",
  "capabilities": ["hooks", "api", "nativeWidgetsStatic"],
  "engines": {
"bungee": "^4.2.0"
  },
  "contributes": {
    "nativeWidgets": [...],
    "api": [...]
  }
}
```

| 字段 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `manifestContract` | string | ✅ | 契约版本，固定为 `"vnext"` |
| `schemaVersion` | number | ✅ | Manifest 结构版本，当前为 `2` |
| `artifactKind` | string | ✅ | 产物类型，当前仅支持 `"runtime-plugin"` |
| `main` | string | ✅ | 服务端入口产物路径（相对于插件根目录） |
| `uiExtensionMode` | string | ✅ | UI 模式：`none`, `native-static`, `sandbox-iframe` |
| `capabilities` | array | ✅ | 声明能力：`hooks`, `api`, `nativeWidgetsStatic`, `sandboxUiExtension` |
| `engines.bungee` | string | ✅ | 兼容的 Bungee 版本范围（semver） |

---

## State Model & Lifecycle

Bungee 插件系统引入了严格的状态机管理，确保系统稳定性。

### Lifecycle States

| 状态 | 描述 | 运维含义 |
|------|------|----------|
| `undiscovered` | 尚未发现 | 插件目录不存在或未扫描 |
| `discovered` | 已发现 | 已读取 manifest，等待验证 |
| `validated` | 验证通过 | Manifest 规范、引擎版本、产物路径均合法 |
| `enabled` | 已启用 | 配置中声明启用，准备加载到运行时 |
| `loaded` | 已加载 | 插件类已实例化并完成 `init` |
| `serving` | 正在服务 | 插件已注册 Hooks/API，正在处理流量 |
| `disabled` | 已禁用 | 配置中显式禁用，或数据库状态为禁用 |
| `degraded` | 降级运行 | 运行时加载失败（如代码报错），但不影响主流程 |
| `quarantined` | 已隔离 | 严重验证失败（如引擎不匹配），禁止加载 |

### Rollback & Quarantine 机制

- **自动隔离 (Quarantine)**：如果插件的 `engines.bungee` 与当前版本不匹配，或 `schemaVersion` 过旧，系统会将其标记为 `quarantined`，防止不兼容代码破坏系统。
- **运行时降级 (Degraded)**：如果插件在 `init` 或 `register` 阶段抛出异常，Orchestrator 会将其标记为 `degraded`，并保留旧版本的 `serving` 状态（如果存在）或直接跳过，确保代理主流程不中断。

---

## Reconcile & Convergence

### PluginRuntimeOrchestrator

Orchestrator 是插件运行时的指挥官，负责：
1. **Reconcile**：对比配置与当前状态，计算增量变化。
2. **Generation 管理**：每次配置应用都会产生一个新的 `generation`。
3. **平滑过渡**：通过 `servingGeneration` 和 `drainingGenerations` 确保旧请求在旧插件实例中完成，新请求进入新实例。

### 多 Worker 收敛 (Convergence)

在多进程模式下，Master 进程通过 IPC 协调所有 Worker 的状态：
- **Target Generation**：Master 下发的期望版本。
- **Converged**：所有 Worker 均报告已成功应用 Target Generation。
- **Stale/Failed**：部分 Worker 仍运行在旧版本或应用失败。

---

## UI Boundary: Static vs Dynamic

Bungee 严格区分了两种 UI 扩展模式，以平衡性能与灵活性。

### 1. Native Widgets (静态边界)
- **模式**：`native-static`
- **特点**：高性能，与主应用深度集成。
- **约束**：必须在构建期通过 `bun run generate:widgets` 注册。不支持运行时动态注入代码。
- **安全**：代码经过主应用构建流水线，安全性高。

### 2. Sandbox Iframe (动态边界)
- **模式**：`sandbox-iframe`
- **特点**：强隔离，支持运行时动态加载。
- **约束**：资源通过 `/__ui/plugins/:pluginName/assets/` 暴露。
- **安全**：通过 iframe 隔离 CSS 和 JS 环境，受 `sandboxUiExtension` 能力声明约束。

---

## Known Limitations & Non-goals

- **路径解析约束**：严格 v2 catalog 从 `manifest.json.main` 解析插件入口，入口必须位于插件目录内。
- **激活真值**：全局 activation 只来自 `bungee.db` 当前 revision 的 `plugin_activations`；binding enabled 与全局 activation 是两个独立字段。
- **Native Widget 动态性**：目前不支持在不重新构建 UI 的情况下动态添加 Native Widget。


### Compiled Output（编译输出）

```plaintext
packages/core/dist/plugins/
├── ai-transformer/
│   └── index.js              # 内置插件编译产物
├── token-stats/
│   └── index.js              # 外部插件编译产物
└── ...
```

---

## Plugin Types

### 1. Hook-based Plugins（Hook 插件）

用于请求/响应处理的插件，可在 Global/Route/Upstream 三个作用域配置：

```typescript
class MyPlugin implements Plugin {
  static readonly name = 'my-plugin';
  static readonly version = '1.0.0';

  register(hooks: PluginHooks): void {
    hooks.onRequest.tapPromise({ name: 'my-plugin' }, async (req, ctx) => {
      // 处理请求
      return req;
    });

    hooks.onResponse.tapPromise({ name: 'my-plugin' }, async (res, ctx) => {
      // 处理响应
      return res;
    });
  }
}
```

### 2. API Plugins（API 插件）

提供自定义 API 端点的插件，通过 `manifest.json` 的 `contributes.api` 声明：

**manifest.json**:
```json
{
  "name": "token-stats",
  "version": "1.0.0",
  "manifestContract": "vnext",
  "main": "dist/index.js",
  "contributes": {
    "api": [
      { "path": "/stats", "methods": ["GET"], "handler": "getStats" }
    ]
  }
}
```

**server/index.ts**（Source）:
```typescript
class TokenStatsPlugin implements Plugin {
  static readonly name = 'token-stats';
  static readonly version = '1.0.0';

  async getStats(req: Request): Promise<Response> {
    return new Response(JSON.stringify({
      groupBy: 'route',
      totalInputTokens: 1000,
      totalOutputTokens: 600,
      logicalRequests: 24,
      upstreamAttempts: 28,
      authorityBreakdown: {
        input: { official: 24, local: 0, heuristic: 0, partial: 0, none: 0 },
        output: { official: 24, local: 0, heuristic: 0, partial: 0, none: 0 },
      },
      data: [],
    }));
  }
}
```

**API 路由规则**：`/api/plugins/{pluginName}/{path}`

示例：`GET /api/plugins/token-stats/stats?groupBy=route&range=24h`

### 3. Widget Plugins（组件插件）

提供仪表板原生组件的插件，通过 `manifest.json` 的 `contributes.nativeWidgets` 和 `ui.components` 声明：

**manifest.json**:
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "ui": {
    "components": [
      {
        "name": "TokenStatsChart",
        "entry": "ui/TokenStatsChart.svelte"
      }
    ]
  },
  "contributes": {
    "nativeWidgets": [
      {
        "id": "token-stats-chart",
        "title": "widgets.chart.title",
        "size": "medium",
        "component": "TokenStatsChart",
        "props": {}
      }
    ]
  }
}
```

**关键字段说明**：

- `ui.components`: 声明组件入口，用于构建时自动生成组件注册表
- `contributes.nativeWidgets.component`: 引用 `ui.components` 中声明的组件名称

---

## Configuration

Plugin bindings live inside the revisioned configuration aggregate. Global activation and binding enabled state are independent.

```json
{
  "logical_configuration": {
    "services": [{
      "id": "aaaaaaaa-0000-4000-8000-000000000001",
      "position": 1,
      "name": "ai-providers",
      "plugins": [],
      "endpoints": [{
        "id": "bbbbbbbb-0000-4000-8000-000000000001",
        "position": 1,
        "target": "https://api.gemini.com",
        "plugins": [{
          "name": "ai-transformer",
          "enabled": true,
          "options": {
            "from": "anthropic",
            "to": "gemini"
          }
        }]
      }]
    }],
    "routes": [],
    "plugins": []
  },
  "plugin_activations": [{ "plugin_name": "ai-transformer" }]
}
```

### Plugin Loading

Bungee only loads strict v2 catalog artifacts. Built-in production plugins are under `packages/core/dist/plugins/*/manifest.json`; source development uses the repository `plugins/` catalog. Every `manifest.json.main` must point to an existing built entry inside its plugin directory.


---

## Available Plugins

Bungee includes built-in plugins for API compatibility and format conversion:

| Plugin | Description |
|--------|-------------|
| `ai-transformer` | Convert request/response format between `openai` / `anthropic` / `gemini` by `from/to` options |
| `openai-messages-to-chat` | Unified OpenAI compatibility adapter: downgrades `/v1/messages` and `/v1/responses` requests to upstream `/v1/chat/completions`; rewrites adapted `/v1/messages` responses to Messages-style output and adapted `/v1/responses` responses to Responses-style output (JSON + SSE) |

Supported directions:

- `openai → anthropic`
- `anthropic → openai`
- `openai → gemini`
- `gemini → openai`
- `anthropic → gemini`
- `gemini → anthropic`

### Feature Support

All transformer plugins support:

- ✅ Request transformation (path, headers, body)
- ✅ Response transformation (non-streaming)
- ✅ SSE streaming transformation
- ✅ Tool calls / Function calling
- ✅ Multi-modal content (images)
- ✅ Thinking tags support
- ✅ Error handling

---

## Writing Custom Plugins

### Plugin Interface

```typescript
interface Plugin {
  // Required
  name: string;

  // Optional metadata
  version?: string;

  // Lifecycle hooks
  onRequestInit?(ctx: PluginContext): Promise<void>;
  onBeforeRequest?(ctx: PluginContext): Promise<void>;
  onInterceptRequest?(ctx: PluginContext): Promise<Response | null>;
  onResponse?(ctx: PluginContext & { response: Response }): Promise<Response | void>;
  onError?(ctx: PluginContext & { error: Error }): Promise<void>;
  onDestroy?(): Promise<void>;

  // Streaming hooks
  processStreamChunk?(chunk: any, ctx: StreamChunkContext): Promise<any[] | null>;
  flushStream?(ctx: StreamChunkContext): Promise<any[]>;
}
```

### Simple Example: Header Transformer

```typescript
import type { Plugin, PluginContext } from '../plugin.types';

export default class CustomHeaderPlugin implements Plugin {
  name = 'custom-header-transformer';
  version = '1.0.0';

  async onBeforeRequest(ctx: PluginContext): Promise<void> {
    // Add custom headers
    ctx.headers['X-Custom-Header'] = 'my-value';
    ctx.headers['X-Timestamp'] = String(Date.now());

    // Modify body
    if (ctx.body && typeof ctx.body === 'object') {
      ctx.body.customField = 'custom-value';
    }
  }
}
```

### Stream Transformer Example

```typescript
import type { Plugin, StreamChunkContext } from '../plugin.types';

export default class CustomStreamPlugin implements Plugin {
  name = 'custom-stream-transformer';

  async processStreamChunk(
    chunk: any,
    ctx: StreamChunkContext
  ): Promise<any[] | null> {
    // Transform the chunk
    const transformed = {
      ...chunk,
      customField: 'added-by-plugin',
      chunkNumber: ctx.chunkIndex
    };

    // Return as array (supports N:M transformations)
    return [transformed];
  }

  async flushStream(ctx: StreamChunkContext): Promise<any[]> {
    // Output any buffered data
    return [];
  }
}
```

### N:M Stream Transformation

The `processStreamChunk` hook supports flexible input/output ratios:

```typescript
async processStreamChunk(chunk: any, ctx: StreamChunkContext): Promise<any[] | null> {
  // 1:0 - Buffer the chunk (don't output yet)
  if (shouldBuffer(chunk)) {
    ctx.streamState.set('buffered', chunk);
    return [];
  }

  // 1:1 - Simple transformation
  if (isSimpleCase(chunk)) {
    return [transform(chunk)];
  }

  // 1:M - Split into multiple chunks
  if (shouldSplit(chunk)) {
    return [
      transformPart1(chunk),
      transformPart2(chunk)
    ];
  }

  // N:M - Combine with buffered chunks
  const buffered = ctx.streamState.get('buffered');
  if (buffered) {
    ctx.streamState.delete('buffered');
    return [combine(buffered, chunk)];
  }

  // null - Pass through unchanged
  return null;
}
```

---

## Plugin API Reference

### PluginContext

Available in all request hooks:

```typescript
interface PluginContext {
  // Request information
  method: string;

  /**
   * Protected URL object
   * Plugins can READ all fields but can only MODIFY:
   * - pathname (e.g., '/v1/messages')
   * - search (e.g., '?foo=bar')
   * - hash (e.g., '#section')
   *
   * READONLY fields (cannot be modified):
   * - protocol, host, hostname, port, origin, href
   */
  url: PluginUrl;

  headers: Record<string, string>;
  body?: any;

  // Route configuration
  route: RouteConfig;
  upstream: Upstream;

  // Request metadata
  requestId: string;
}

interface PluginUrl {
  // Modifiable fields (whitelist)
  pathname: string;  // Plugin can modify
  search: string;    // Plugin can modify
  hash: string;      // Plugin can modify

  // Readonly fields (cannot modify)
  readonly protocol: string;
  readonly host: string;
  readonly hostname: string;
  readonly port: string;
  readonly href: string;
  readonly origin: string;
}
```

### StreamChunkContext

Available in streaming hooks:

```typescript
interface StreamChunkContext extends PluginContext {
  chunkIndex: number;
  streamState: Map<string, any>;  // For buffering/state management
}
```

### Lifecycle Hooks

| Hook | When Called | Purpose |
|------|-------------|---------|
| `onRequestInit` | Before any processing | Initialize plugin state |
| `onBeforeRequest` | Before forwarding request | Modify request |
| `onInterceptRequest` | Before forwarding | Return custom response |
| `onResponse` | After receiving response | Transform non-streaming response |
| `processStreamChunk` | For each SSE chunk | Transform streaming data |
| `flushStream` | End of stream | Output buffered data |
| `onError` | On request error | Handle errors |
| `onDestroy` | Plugin cleanup | Release resources |

### Response Transformation

The `onResponse` hook must return a new Response object:

```typescript
async onResponse(ctx: PluginContext & { response: Response }): Promise<Response | void> {
  const contentType = ctx.response.headers.get('content-type') || '';

  // Only process JSON responses
  if (!contentType.includes('application/json')) {
    return; // Pass through
  }

  // Clone before reading body (Response can only be read once)
  const responseClone = ctx.response.clone();
  const body = await responseClone.json();

  // Transform the body
  const transformed = this.transformBody(body);

  // Return new Response
  return new Response(JSON.stringify(transformed), {
    status: ctx.response.status,
    statusText: ctx.response.statusText,
    headers: ctx.response.headers
  });
}
```

**Important**:

- Must return `Promise<Response | void>`
- Return `void` to pass through unchanged
- Return `Response` to replace original
- Always `clone()` before reading body

---

## Plugin Contributions

插件通过 `manifest.json` 的 `contributes` 字段声明其贡献点。

> **注意**: 从 v2.4.0 开始，推荐使用 manifest.json 声明贡献点（manifest-first 模式）。
> 静态属性方式仍然支持，用于向后兼容。

### API Contributions

声明自定义 API 端点：

**manifest.json**:
```json
{
  "contributes": {
    "api": [
      {
        "path": "/stats",
        "methods": ["GET"],
        "handler": "getStats"
      }
    ]
  }
}
```

**路由规则**：`/api/plugins/{pluginName}{path}`

| 声明路径 | 实际 API URL |
|----------|-------------|
| `/stats` | `/api/plugins/token-stats/stats?groupBy=route&range=24h` |

**Handler 方法签名**：

```typescript
async getStats(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const range = url.searchParams.get('range') || '24h';
  const groupBy = url.searchParams.get('groupBy') || 'route';

  // 从 storage 读取 v2 聚合数据
  const data = await this.storage.get(`token-stats:v2:${groupBy}:all:${new Date().toISOString().slice(0, 13)}`);

  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
}
```

### Native Widget Contributions

声明仪表板原生组件：

**manifest.json**:
```json
{
  "ui": {
    "components": [
      {
        "name": "TokenStatsChart",
        "entry": "ui/TokenStatsChart.svelte"
      }
    ]
  },
  "contributes": {
    "nativeWidgets": [
      {
        "id": "my-chart",
        "title": "widgets.chart.title",
        "size": "medium",
        "component": "TokenStatsChart",
        "props": {
          "showLegend": true
        }
      }
    ]
  }
}
```

**尺寸选项**：

| Size | Grid Width | Grid Height | Description |
|------|------------|-------------|-------------|
| `small` | 1 | 1 | 单格小组件 |
| `medium` | 2 | 1 | 横向中等组件 |
| `large` | 2 | 2 | 方形大组件 |
| `full` | 4 | 2 | 全宽横幅组件 |

### iframe Widget Contributions（Legacy）

传统 iframe 方式的组件声明：

```typescript
static readonly metadata = {
  contributes: {
    widgets: [
      {
        path: '/widget.html',   // 相对于插件 UI 目录
        title: 'My Widget',
        size: 'medium',
      },
    ],
  },
};
```

### Translations

插件的多语言翻译（在 manifest.json 中声明）：

**manifest.json**:
```json
{
  "translations": {
    "en": {
      "metadata.name": "Token Statistics",
      "plugin.description": "Track AI API token usage",
      "widgets.chart.title": "Token Usage"
    },
    "zh-CN": {
      "metadata.name": "Token 统计",
      "plugin.description": "追踪 AI API 的 Token 使用量",
      "widgets.chart.title": "Token 使用量"
    }
  }
}
```

**命名空间规则**：翻译键会自动添加 `plugins.{pluginName}.` 前缀。

- 插件中声明：`widgets.chart.title`
- 前端实际使用：`plugins.token-stats.widgets.chart.title`

---

## Plugin SDK (Frontend)

为外部插件提供的前端 SDK，统一导出常用依赖。

### 导入方式

```typescript
// 在插件 UI 组件中
import { api, _, chartTheme } from '@bungee/plugin-sdk';
```

### 可用导出

| Export | Type | Description |
|--------|------|-------------|
| `api` | Object | HTTP API 客户端 |
| `_` | Store | i18n 翻译函数 store |
| `chartTheme` | Object | Chart.js 主题配置 |
| `Chart` | Component | Chart.js Svelte 组件 |
| `BarElement`, `LineElement`, etc. | Object | Chart.js 元素 |

### 使用示例

```svelte
<script lang="ts">
  import { api, _, chartTheme, Chart, BarElement, ... } from '@bungee/plugin-sdk';
  import { onMount } from 'svelte';

  // 注册 Chart.js 元素
  Chart.register(BarElement, CategoryScale, LinearScale, ...);

  let chartData = { labels: [], datasets: [] };

  onMount(async () => {
    // 调用插件 API
    const result = await api.get('/plugins/token-stats/stats?range=1h&groupBy=route');
    chartData = result.data;
  });
</script>

<!-- 使用 i18n -->
<h3>{$_('plugins.token-stats.widgets.chart.title')}</h3>

<!-- 当前 v2 返回形状示例 -->
<pre>{JSON.stringify({
  groupBy: 'route',
  totalInputTokens: 1000,
  totalOutputTokens: 600,
  logicalRequests: 24,
  upstreamAttempts: 28,
  authorityBreakdown: { input: {}, output: {} },
  data: [{
    dimension: 'openai-chat',
    inputTokens: 500,
    outputTokens: 300,
    logicalRequests: 12,
    upstreamAttempts: 14,
    officialInputTokens: 500,
    officialOutputTokens: 300,
    partialOutputs: 0,
    authorityBreakdown: { input: {}, output: {} },
  }],
}, null, 2)}</pre>

<!-- 使用图表 -->
<Chart type="bar" data={chartData} options={chartTheme.bar} />
```

### SDK 源码位置

`packages/ui/src/lib/plugin-sdk/index.ts`

---

## Build System

### 构建流程

```plaintext
┌─────────────────────────────────────────────────────────────────┐
│                       Build Pipeline                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   npm run build                                                 │
│         │                                                       │
│         ├──▶ bun run build:types                               │
│         │         └─▶ TypeScript definitions                   │
│         │                                                       │
│         ├──▶ bun run generate:widgets  ← 新增 ✨               │
│         │         └─▶ 扫描 manifest.json                       │
│         │         └─▶ 生成 native-widgets/generated.ts         │
│         │                                                       │
│         ├──▶ bun run build:ui                                  │
│         │         └─▶ Vite build (packages/ui)                 │
│         │                                                       │
│         └──▶ bun run build:core                                │
│                   │                                             │
│                   ├──▶ tsc (packages/core/src → dist/)         │
│                   │         └─▶ Internal plugins compiled      │
│                   │                                             │
│                   └──▶ scripts/build-external-plugins.ts       │
│                             └─▶ plugins/* → dist/plugins/      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 外部插件构建脚本

`scripts/build-external-plugins.ts`：

```typescript
// 扫描 plugins/ 目录
const pluginDirs = fs.readdirSync(PLUGINS_DIR);

for (const dir of pluginDirs) {
  const serverEntry = path.join(PLUGINS_DIR, dir, 'server', 'index.ts');

  // 使用 Bun.build API 编译
  await Bun.build({
    entrypoints: [serverEntry],
    outdir: path.join(OUTPUT_DIR, dir),
    target: 'bun',
    format: 'esm',
    naming: 'index.js',
  });
}
```

### 路径别名配置

**Vite 配置** (`packages/ui/vite.config.ts`)：

```typescript
resolve: {
  alias: {
    '@bungee/plugin-sdk': path.resolve(__dirname, './src/lib/plugin-sdk'),
    '@plugins': path.resolve(__dirname, '../../plugins'),
  },
}
```

**TypeScript 配置** (`tsconfig.json`)：

```json
{
  "compilerOptions": {
    "paths": {
      "@bungee/plugin-sdk": ["./packages/ui/src/lib/plugin-sdk"],
      "@plugins/*": ["./plugins/*"]
    }
  }
}
```

### 组件注册表

原生组件通过 `manifest.json` 的 `ui.components` 声明，构建时自动生成注册表。

**构建流程**：

1. 运行 `bun run generate:widgets` 扫描所有插件的 manifest.json
2. 自动生成 `packages/ui/src/lib/components/native-widgets/generated.ts`
3. UI 构建时导入生成的组件注册表

**生成脚本**: `scripts/generate-widget-registry.ts`

```bash
# 手动生成（通常不需要，构建时自动执行）
bun run generate:widgets

# 输出示例
# Generating native widget registry...
#   Scanning: /path/to/plugins
#   Found: TokenStatsChart from token-stats
# Generated native-widgets/generated.ts
#   Total components: 1
```

**生成的文件结构**：

```typescript
// generated.ts（自动生成，请勿手动修改）
import TokenStatsChart from '@plugins/token-stats/ui/TokenStatsChart.svelte';

export const generatedWidgetRegistry = {
  TokenStatsChart,
};

export const componentSourceMap = {
  TokenStatsChart: 'token-stats',
};
```

**添加新组件的步骤**：

1. 在插件目录创建 Svelte 组件：`plugins/my-plugin/ui/MyWidget.svelte`
2. 在 `manifest.json` 中声明组件：
   ```json
   {
     "ui": {
       "components": [{ "name": "MyWidget", "entry": "ui/MyWidget.svelte" }]
     }
   }
   ```
3. 运行 `bun run build`（会自动执行 `generate:widgets`）

### 开发模式路径解析

开发模式下，插件系统会自动调整搜索路径：

```typescript
// PluginRegistry 路径解析
const isDevMode = baseDir.endsWith('/src');
this.systemPluginsDir = isDevMode
  ? path.join(baseDir, '..', 'dist', 'plugins')  // Dev: 使用编译后的
  : path.join(baseDir, 'plugins');                // Prod: 使用打包目录
```

**开发工作流**：

1. 修改 `plugins/*/server/index.ts`
2. 运行 `npm run build` 重新编译
3. 运行 `npm run dev` 启动服务

---

## Testing Plugins

### Unit Tests

```typescript
import { describe, expect, test } from 'bun:test';
import MyPlugin from './my-plugin';

describe('MyPlugin', () => {
  const plugin = new MyPlugin();

  test('should transform request headers', async () => {
    const ctx = {
      method: 'POST',
      headers: {},
      body: { test: true }
    };

    await plugin.onBeforeRequest(ctx);

    expect(ctx.headers['X-Custom-Header']).toBe('my-value');
  });

  test('should transform response body', async () => {
    const response = new Response(
      JSON.stringify({ original: 'data' }),
      { headers: { 'content-type': 'application/json' } }
    );

    const ctx = { response };
    const result = await plugin.onResponse(ctx);

    const transformed = await result.json();
    expect(transformed).toHaveProperty('transformedField');
  });
});
```

### Integration Tests

Use the real master/config-worker harness with a valid `ConfigurationAggregateV2`, stable UUIDs, explicit `plugin_activations`, and a scoped binding. Do not use a file-shaped legacy config fixture.

---

## Security: URL Protection Mechanism

### Overview

Bungee implements a **dual-layer protection mechanism** to prevent plugins from modifying critical URL fields (like `host` or `protocol`), ensuring request isolation between upstreams.

### Why It Matters

Without protection, a plugin could accidentally (or maliciously) change the request destination:

```typescript
// ❌ DANGEROUS (blocked by protection)
ctx.url.host = 'evil.com';  // Would redirect request to wrong server
ctx.url.protocol = 'http:';  // Would downgrade to insecure connection
```

This could cause:

- **Request leakage**: Requests meant for upstream A being sent to upstream B
- **Security breaches**: Sensitive data sent to unauthorized servers
- **Failover corruption**: Retry logic sending requests to wrong upstreams

### Protection Layers

#### 1. Compile-Time Protection (TypeScript)

The `PluginUrl` interface uses `readonly` modifiers:

```typescript
interface PluginUrl {
  // ✅ Allowed: Plugins can modify these
  pathname: string;
  search: string;
  hash: string;

  // ❌ Blocked: TypeScript compiler prevents modification
  readonly protocol: string;
  readonly host: string;
  readonly hostname: string;
  readonly port: string;
  readonly href: string;
  readonly origin: string;
}
```

**Result**: IDE shows error immediately when trying to modify readonly fields.

#### 2. Runtime Protection (Proxy)

Even if TypeScript checks are bypassed, JavaScript Proxy intercepts modifications:

```typescript
// Attempt to modify host
ctx.url.host = 'evil.com';

// Console warning:
// [PluginUrl] Attempt to modify readonly field "host" (blocked for security)

// Value remains unchanged
console.log(ctx.url.host); // Still 'api.example.com'
```

**Result**: Modifications are logged and blocked at runtime.

### What Plugins Can Do

Plugins have full read access to all URL fields:

```typescript
async onBeforeRequest(ctx: PluginContext): Promise<void> {
  // ✅ READ all fields (for decision logic)
  if (ctx.url.host === 'api.openai.com') {
    // Your logic here
  }

  console.log(ctx.url.protocol); // 'https:'
  console.log(ctx.url.pathname); // '/v1/chat/completions'

  // ✅ MODIFY whitelisted fields
  ctx.url.pathname = '/v1/messages';
  ctx.url.search = '?stream=true';
  ctx.url.hash = '#section';

  // ❌ CANNOT modify readonly fields
  // TypeScript error + Runtime block
  ctx.url.host = 'evil.com';
}
```

### Whitelist: Modifiable Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `pathname` | `string` | URL path | `/v1/messages` |
| `search` | `string` | Query string | `?foo=bar` |
| `hash` | `string` | URL fragment | `#section` |

### Blacklist: Readonly Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `protocol` | `readonly string` | URL protocol | `https:` |
| `host` | `readonly string` | Host + port | `api.example.com:443` |
| `hostname` | `readonly string` | Host only | `api.example.com` |
| `port` | `readonly string` | Port number | `443` |
| `href` | `readonly string` | Complete URL | `https://api.example.com/path` |
| `origin` | `readonly string` | Protocol + host | `https://api.example.com` |

### Example: Path Transformation Plugin

```typescript
export class OpenAIToAnthropicPlugin implements Plugin {
  name = 'my-format-plugin';

  async onBeforeRequest(ctx: PluginContext): Promise<void> {
    // ✅ Read pathname to check format
    if (ctx.url.pathname === '/v1/chat/completions') {
      // ✅ Modify pathname (whitelisted)
      ctx.url.pathname = '/v1/messages';

      // ✅ Host remains unchanged automatically
      // Request will still go to the configured upstream
    }

    // Transform body...
    const body = ctx.body as any;
    // ...
  }
}
```

### Testing URL Protection

You can verify the protection mechanism:

```typescript
test('should block host modification', () => {
  const url = new URL('https://api.example.com/v1/messages');
  const pluginUrl = createPluginUrl(url);

  // Attempt to modify host
  const result = Reflect.set(pluginUrl, 'host', 'evil.com');

  // Verification
  expect(result).toBe(false);  // Modification blocked
  expect(pluginUrl.host).toBe('api.example.com');  // Value unchanged
});
```

See `packages/core/tests/unit/plugin-url-security.test.ts` for complete test suite (24 tests covering all scenarios).

---

## Best Practices

### 1. Keep Plugins Focused

Each plugin should do one thing well:

✅ **Good**: `ai-transformer` - one plugin with explicit `from/to` options per route
❌ **Bad**: `multi-format-converter` - tries to handle all formats

### 2. Use TypeScript Types

Leverage TypeScript for better development experience:

```typescript
interface OpenAIRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
}

interface AnthropicRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens: number;
}
```

### 3. Handle Errors Gracefully

```typescript
async onResponse(ctx: PluginContext & { response: Response }): Promise<Response | void> {
  try {
    const body = await ctx.response.clone().json();
    return new Response(JSON.stringify(transform(body)));
  } catch (error) {
    // Log error but don't break the proxy
    console.error('Plugin transformation failed:', error);
    return; // Pass through original response
  }
}
```

### 4. Clone Responses Before Reading

Always clone before reading the body:

```typescript
// ✅ Correct
const responseClone = ctx.response.clone();
const body = await responseClone.json();

// ❌ Wrong - consumes the original response
const body = await ctx.response.json();
```

### 5. Use Stream State for Buffering

For stateful stream transformations:

```typescript
async processStreamChunk(chunk: any, ctx: StreamChunkContext): Promise<any[]> {
  // Store state
  const buffer = ctx.streamState.get('buffer') || [];
  buffer.push(chunk);
  ctx.streamState.set('buffer', buffer);

  // Process when ready
  if (isComplete(buffer)) {
    ctx.streamState.delete('buffer');
    return [combineChunks(buffer)];
  }

  return [];
}
```

### 6. Document Configuration Options

If your plugin accepts options:

```typescript
interface MyPluginOptions {
  /** Maximum retries for failed transformations */
  maxRetries?: number;
  /** Enable debug logging */
  debug?: boolean;
}

export default class MyPlugin implements Plugin {
  name = 'my-plugin';

  constructor(private options: MyPluginOptions = {}) {
    this.options.maxRetries = options.maxRetries ?? 3;
    this.options.debug = options.debug ?? false;
  }
}
```

### 7. Respect URL Modification Limits

Only modify whitelisted URL fields to ensure request isolation:

```typescript
// ✅ Correct: Modify pathname and search
async onBeforeRequest(ctx: PluginContext): Promise<void> {
  if (ctx.url.pathname === '/v1/chat/completions') {
    ctx.url.pathname = '/v1/messages';
  }

  // Add stream parameter
  ctx.url.search = '?stream=true';
}

// ❌ Wrong: Never modify host or protocol
async onBeforeRequest(ctx: PluginContext): Promise<void> {
  ctx.url.host = 'api.anthropic.com';  // TypeScript error + Runtime block
  ctx.url.protocol = 'https:';          // TypeScript error + Runtime block
}
```

**Why this matters**:

- Plugins should transform request format, not redirect to different servers
- Upstream selection is handled by the routing layer
- Modifying host breaks request isolation and failover logic
- The protection mechanism will block such attempts automatically

---

## Reference Implementation

For complete examples, see the built-in transformer plugins:

- `plugins/ai-transformer/manifest.json`
- `plugins/ai-transformer/server/index.ts`
- `plugins/ai-transformer/server/converters/*.ts`

These implementations demonstrate:

- Full bidirectional API format conversion
- Streaming transformation
- Error handling
- Tool calling support
- Multi-modal content handling

For OpenAI Messages compatibility adapter examples, see:

- `plugins/openai-messages-to-chat/manifest.json`
- `plugins/openai-messages-to-chat/server/index.ts`

---

## Further Reading

- [OpenAI Messages/Responses Compatibility Guide](./openai-messages-to-chat.md)
- [Plugin Registry Implementation](../packages/core/src/plugin-registry.ts)
- [Plugin Type Definitions](../packages/core/src/plugin.types.ts)
- [Stream Executor](../packages/core/src/stream-executor.ts)
- [Test Examples](../packages/core/tests/plugin-registry.test.ts)
