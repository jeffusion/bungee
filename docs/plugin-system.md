# Plugin System

Bungee features a powerful, TypeScript-first plugin system that enables extensible request/response transformations with full type safety and IDE support.

## Table of Contents

- [Architecture Overview](#architecture-overview)
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

Bungee 插件系统采用**分层架构**，支持内置插件和外部插件，同时提供前后端扩展能力。

```plaintext
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Plugin System Architecture                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        Plugin Registry Layer                         │   │
│  │  ┌─────────────────────┐    ┌─────────────────────────────────────┐ │   │
│  │  │   PluginRegistry    │    │      ScopedPluginRegistry           │ │   │
│  │  │  (Discovery/Meta)   │    │  (Instance Management/Hooks)        │ │   │
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
│  │  │ • token-cache       │    │   │  ├─ server/index.ts         │   │ │   │
│  │  │ • hooks-example     │    │   │  └─ ui/TokenStatsChart.svelte│  │ │   │
│  │  └─────────────────────┘    │   └─────────────────────────────┘   │ │   │
│  │                             └─────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                     │                                       │
│                                     ▼                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                       Plugin Capabilities                            │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────────┐ │   │
│  │  │    Hooks     │  │     API      │  │    Native Widgets          │ │   │
│  │  │ onRequest    │  │ /summary     │  │    (Dashboard UI)          │ │   │
│  │  │ onResponse   │  │ /by-route    │  │ TokenStatsChart.svelte     │ │   │
│  │  │ onStreamChunk│  │              │  │                            │ │   │
│  │  └──────────────┘  └──────────────┘  └────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Features

| Feature | Description |
|---------|-------------|
| **Type Safety** | Full TypeScript interfaces with IntelliSense support |
| **Scoped Execution** | Global, Route, Upstream 三级作用域 |
| **Native Widgets** | 原生 Svelte 组件，与主应用共享样式和图表库 |
| **Plugin API** | 插件可声明自定义 API 端点 |
| **Hot Reload** | 支持插件配置热更新 |
| **High Cohesion** | 外部插件 server/ui 代码放在同一目录 |

---

## Plugin Directory Structure

### Internal Plugins（内置插件）

位于 `packages/core/src/plugins/`，与核心代码一起编译：

```plaintext
packages/core/src/plugins/
├── ai-transformer/           # 目录形式插件
│   └── index.ts
├── token-cache/
│   └── index.ts
└── hooks-example/
    └── index.ts
```

### External Plugins（外部插件）

位于项目根目录 `plugins/`，高内聚结构：

```plaintext
plugins/
└── token-stats/              # 插件根目录
    ├── manifest.json         # 插件元数据（单一数据源 ✨）
    ├── server/               # 后端代码
    │   └── index.ts          # 入口文件（必须）
    └── ui/                   # 前端组件（可选）
        └── TokenStatsChart.svelte
```

#### manifest.json 规范

**manifest.json 是插件元数据的唯一真相来源**。框架通过读取此文件发现插件能力，无需执行插件代码。

```json
{
  "name": "token-stats",
  "version": "1.0.0",
  "displayName": "metadata.name",
  "description": "plugin.description",
  "icon": "bar_chart",
  "author": "Bungee Team",
  "main": "server/index.ts",
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
    ],
    "api": [
      {
        "path": "/summary",
        "methods": ["GET"],
        "handler": "getSummary"
      }
    ]
  },
  "translations": {
    "en": {
      "metadata.name": "Token Statistics",
      "plugin.description": "Track AI API token usage"
    },
    "zh-CN": {
      "metadata.name": "Token 统计",
      "plugin.description": "追踪 AI API 的 Token 使用量"
    }
  }
}
```

| 字段 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `name` | string | ✅ | 插件唯一标识符 |
| `version` | string | ✅ | 版本号（semver） |
| `displayName` | string | - | 显示名称（支持 i18n key） |
| `description` | string | - | 插件描述 |
| `icon` | string | - | Material Icon 名称 |
| `main` | string | - | 服务端入口路径 |
| `ui.components` | array | - | UI 组件声明（用于自动注册） |
| `contributes` | object | - | 贡献点配置 |
| `translations` | object | - | 多语言翻译 |

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
  "main": "server/index.ts",
  "contributes": {
    "api": [
      { "path": "/summary", "methods": ["GET"], "handler": "getSummary" },
      { "path": "/by-route", "methods": ["GET"], "handler": "getByRoute" }
    ]
  }
}
```

**server/index.ts**:
```typescript
class TokenStatsPlugin implements Plugin {
  // 最小静态属性（用于类型检查和向后兼容）
  static readonly name = 'token-stats';
  static readonly version = '1.0.0';

  // API Handler 方法
  async getSummary(req: Request): Promise<Response> {
    return new Response(JSON.stringify({ total: 1000 }));
  }

  async getByRoute(req: Request): Promise<Response> {
    return new Response(JSON.stringify([]));
  }
}
```

**API 路由规则**：`/api/plugins/{pluginName}/{path}`

示例：`GET /api/plugins/token-stats/summary`

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

### Route-Level Plugins

Apply plugins to all requests matching a route:

```json
{
  "routes": [{
    "path": "/v1/chat/completions",
    "plugins": [{
      "name": "ai-transformer",
      "options": {
        "from": "openai",
        "to": "anthropic"
      }
    }],
    "upstreams": [{
      "target": "https://api.anthropic.com"
    }]
  }]
}
```

### Upstream-Level Plugins

Apply plugins to specific upstreams:

```json
{
  "routes": [{
    "path": "/api/ai",
    "plugins": [{
      "name": "ai-transformer",
      "options": {
        "from": "anthropic",
        "to": "openai"
      }
    }],
    "upstreams": [
      {
        "target": "https://api.openai.com",
        "priority": 1
      },
      {
        "target": "https://api.gemini.com",
        "priority": 2,
        "plugins": [{
          "name": "ai-transformer",
          "options": {
            "from": "anthropic",
            "to": "gemini"
          }
        }]
      }
    ]
  }]
}
```

### Plugin Loading

Bungee automatically loads plugins from:

1. **Built-in plugins**: `plugins/*/manifest.json` + `plugins/*/index.ts`
2. **Custom plugins**: Specified by path in configuration

```json
{
  "plugins": [
    {
      "path": "./custom-plugins/my-plugin.ts",
      "enabled": true,
      "options": {
        "customOption": "value"
      }
    }
  ]
}
```

---

## Available Plugins

Bungee includes built-in plugins for API compatibility and format conversion:

| Plugin | Description |
|--------|-------------|
| `ai-transformer` | Convert request/response format between `openai` / `anthropic` / `gemini` by `from/to` options |
| `openai-messages-to-chat` | Compatibility adapter that rewrites OpenAI-style `/v1/messages` requests to upstream `/v1/chat/completions`, and rewrites responses back to Messages-style output |

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
        "path": "/summary",
        "methods": ["GET"],
        "handler": "getSummary"
      },
      {
        "path": "/data",
        "methods": ["GET", "POST"],
        "handler": "handleData"
      }
    ]
  }
}
```

**路由规则**：`/api/plugins/{pluginName}{path}`

| 声明路径 | 实际 API URL |
|----------|-------------|
| `/summary` | `/api/plugins/token-stats/summary` |
| `/data` | `/api/plugins/token-stats/data` |

**Handler 方法签名**：

```typescript
async getSummary(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const range = url.searchParams.get('range') || '24h';

  // 从 storage 读取数据
  const data = await this.storage.get('stats');

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
    const result = await api.get('/plugins/token-stats/summary?range=1h');
    chartData = transformData(result);
  });
</script>

<!-- 使用 i18n -->
<h3>{$_('plugins.token-stats.widgets.chart.title')}</h3>

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

```typescript
test('plugin should work end-to-end', async () => {
  const config = {
    routes: [{
      path: '/test',
      plugins: ['my-plugin'],
      upstreams: [{ target: 'http://localhost:9000' }]
    }]
  };

  const server = await startTestServer(config);

  const response = await fetch('http://localhost:8088/test', {
    method: 'POST',
    body: JSON.stringify({ test: true })
  });

  const data = await response.json();
  expect(data).toMatchSnapshot();

  await server.stop();
});
```

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

- [OpenAI Messages Compatibility Guide](./openai-messages-to-chat.md)
- [Plugin Registry Implementation](../packages/core/src/plugin-registry.ts)
- [Plugin Type Definitions](../packages/core/src/plugin.types.ts)
- [Stream Executor](../packages/core/src/stream-executor.ts)
- [Test Examples](../packages/core/tests/plugin-registry.test.ts)
