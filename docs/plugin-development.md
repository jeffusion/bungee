# Bungee 插件开发指南

本指南将帮助你理解 Bungee 的插件系统架构，并指导你如何开发自定义插件。

---

## 📋 目录

- [核心概念](#核心概念)
- [插件生命周期](#插件生命周期)
- [快速开始](#快速开始)
- [插件配置 Schema](#插件配置-schema)
- [存储系统](#存储系统)
- [权限管理](#权限管理)
- [调试和测试](#调试和测试)
- [最佳实践](#最佳实践)
- [示例插件](#示例插件)

---

## 核心概念

### 什么是 Bungee 插件？

Bungee 插件是一个实现 `Plugin` 接口的 TypeScript 类，可以在请求/响应处理流程中注入自定义逻辑。

### 插件架构

```
┌─────────────────────────────────────────────────────────┐
│                      Client Request                      │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│                  Plugin: onRequest                       │ ← 拦截请求，可修改请求
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│              Plugin: onBeforeRequest                     │ ← 发送前最后处理
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│                    Upstream Service                      │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│                  Plugin: onResponse                      │ ← 处理响应，可修改响应
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│            Plugin: processStreamChunk (可选)             │ ← 处理流式响应
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│                      Client Response                     │
└─────────────────────────────────────────────────────────┘
```

---

## 插件生命周期

### 生命周期钩子

```typescript
interface Plugin {
  /**
   * 插件初始化
   * 在 register 之前调用，用于初始化配置和资源。
   * 只有 global scope 的插件实例会调用此方法。
   */
  init?(context: PluginInitContext): Promise<void>;

  /**
   * 注册 Hooks
   * 插件在此方法中选择需要的 hooks 并注册回调。
   */
  register(hooks: PluginHooks): void;

  /**
   * 重置状态（对象池使用）
   */
  reset?(): void | Promise<void>;

  /**
   * 插件销毁
   */
  onDestroy?(): Promise<void>;
}
```

### 生命周期阶段

| 阶段 | 调用时机 | 用途 |
|------|----------|------|
| `init` | 插件加载时（全局一次） | 初始化全局资源、连接外部服务 |
| `register` | 插件注册时 | 声明式注册 Hook 回调（如 `hooks.onRequest.tap(...)`） |
| `reset` | 实例归还对象池时 | 清理请求相关的临时状态 |
| `onDestroy` | 插件卸载时 | 释放全局资源 |

---

## 快速开始

### 1. 创建插件文件

在 `plugins/` 目录下创建插件目录（推荐采用 **Artifact-first** 结构）：

```bash
plugins/my-plugin/
  ├── manifest.json      # 插件元数据
  ├── server/
  │   └── index.ts       # 服务端源码
  ├── dist/
  │   └── index.js       # 编译后的产物 (Artifact)
  └── ui/
      └── MyWidget.svelte # UI 组件
```

> **注意**: 生产环境运行时仅加载 `dist/index.js`。开发模式下支持直接加载 `server/index.ts` 以实现快速调试，但这属于 **dev-compat** 行为，不应作为正式发布的契约。

### 2. 实现插件类

```typescript
import type { Plugin, PluginHooks, PluginInitContext } from '@jeffusion/bungee-types';
import { definePlugin } from '@jeffusion/bungee-types';

export const MyPlugin = definePlugin(
  class implements Plugin {
    // 静态元数据（必需，需与 manifest.json 一致）
    static readonly name = 'my-plugin';
    static readonly version = '1.0.0';

    async init(context: PluginInitContext): Promise<void> {
      // 初始化逻辑
    }

    register(hooks: PluginHooks): void {
      // 注册请求钩子
      hooks.onBeforeRequest.tapPromise({ name: 'my-plugin' }, async (ctx) => {
        ctx.headers['x-my-plugin'] = 'active';
      });
    }
  }
);

export default MyPlugin;
```

### 3. 编写 manifest.json (vNext)

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "manifestContract": "vnext",
  "schemaVersion": 2,
  "artifactKind": "runtime-plugin",
  "main": "dist/index.js",
  "uiExtensionMode": "none",
  "capabilities": ["hooks"],
  "engines": {
    "bungee": "^4.2.0"
  }
}
```


---

## 插件配置 Schema

### 定义配置 Schema

通过定义 `configSchema`，UI 会自动生成配置表单：

```typescript
import type { PluginConfigField } from '../../plugin.types';

export const MyPlugin = definePlugin(
  class implements Plugin {
    static readonly name = 'my-plugin';
    static readonly version = '1.0.0';
    static readonly description = 'My plugin with configuration';

    // 定义配置 Schema
    static readonly configSchema: PluginConfigField[] = [
      {
        name: 'apiKey',
        type: 'string',
        label: 'API Key',
        required: true,
        description: 'Your API key for authentication',
        placeholder: 'Enter your API key',
        validation: {
          pattern: '^[a-zA-Z0-9]{32}$',
          message: 'API key must be 32 alphanumeric characters'
        }
      },
      {
        name: 'timeout',
        type: 'number',
        label: 'Request Timeout (ms)',
        required: false,
        default: 5000,
        description: 'Timeout for external API calls',
        validation: {
          min: 1000,
          max: 30000,
          message: 'Timeout must be between 1000 and 30000 ms'
        }
      },
      {
        name: 'enabled',
        type: 'boolean',
        label: 'Enable Feature',
        default: true,
        description: 'Enable or disable this feature'
      },
      {
        name: 'mode',
        type: 'select',
        label: 'Operation Mode',
        required: true,
        options: [
          { label: 'Development', value: 'dev', description: 'Development mode with debug logging' },
          { label: 'Production', value: 'prod', description: 'Production mode with optimizations' }
        ]
      }
    ];

    // ... 实现代码
  }
);
```

### 支持的字段类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `string` | 文本输入 | API key, URL |
| `number` | 数字输入 | 超时时间, 重试次数 |
| `boolean` | 复选框 | 启用/禁用开关 |
| `select` | 单选下拉 | 模式选择, 区域选择 |
| `multiselect` | 多选下拉 | 功能列表, 标签 |
| `textarea` | 多行文本 | 描述, JSON 配置 |
| `json` | JSON 编辑器 | 复杂配置对象 |

### 虚拟字段转换

使用 `fieldTransform` 将一个 UI 字段映射到多个存储字段：

```typescript
{
  name: 'transformation',
  type: 'select',
  label: 'Transformation Direction',
  required: true,

  // 字段转换规则
  fieldTransform: {
    type: 'split',
    separator: '-',
    fields: ['from', 'to']
  },

  options: [
    { label: 'Anthropic → OpenAI', value: 'anthropic-openai' },
    { label: 'OpenAI → Anthropic', value: 'openai-anthropic' }
  ]
}
```

用户选择 `anthropic-openai` 时，会自动展开为：
```json
{
  "from": "anthropic",
  "to": "openai"
}
```

---

## 存储系统

### 使用插件存储

每个插件都有独立的命名空间存储：

```typescript
async onInit(context: PluginInitContext): Promise<void> {
  const { storage } = context;

  // 保存数据
  await storage.set('counter', 0);
  await storage.set('config', { enabled: true }, 3600); // TTL: 1小时

  // 读取数据
  const counter = await storage.get<number>('counter');

  // 原子操作（并发安全）
  const newValue = await storage.increment('stats', 'requestCount', 1);

  // 比较并交换（CAS）
  const success = await storage.compareAndSet('status', 'old', 'idle', 'processing');

  // 删除数据
  await storage.delete('temp');

  // 列出所有键
  const keys = await storage.keys('prefix:');

  // 清空存储
  await storage.clear();
}
```

### 存储 API

| 方法 | 说明 | 示例 |
|------|------|------|
| `get<T>(key)` | 获取值 | `await storage.get('key')` |
| `set(key, value, ttl?)` | 设置值 | `await storage.set('key', 'value', 3600)` |
| `delete(key)` | 删除值 | `await storage.delete('key')` |
| `keys(prefix?)` | 列出键 | `await storage.keys('user:')` |
| `clear()` | 清空存储 | `await storage.clear()` |
| `increment(key, field, delta)` | 原子递增 | `await storage.increment('stats', 'count', 1)` |
| `compareAndSet(key, field, expected, newValue)` | CAS操作 | `await storage.compareAndSet('lock', 'status', 'idle', 'locked')` |

---

## 权限管理

### 声明插件权限

在 `metadata` 中声明插件所需的权限：

```typescript
export const MyPlugin = definePlugin(
  class implements Plugin {
    static readonly name = 'my-plugin';
    static readonly version = '1.0.0';
    static readonly description = 'My plugin';

    static readonly metadata = {
      author: 'Your Name',
      license: 'MIT',

      // 声明所需权限
      capabilities: {
        network: true,      // 需要网络访问
        filesystem: false,  // 不需要文件系统访问
        database: true      // 需要数据库访问
      }
    };

    // ... 实现代码
  }
);
```

### 检查权限

系统会在插件加载时自动检查权限，如果插件缺少必要权限，加载会失败。

---

## 调试和测试

### 日志输出

使用内置的 logger：

```typescript
import { logger } from '../../logger';

async onRequest(ctx: PluginContext): Promise<void> {
  logger.debug({ url: ctx.url.pathname }, 'Processing request');
  logger.info('Request processed successfully');
  logger.warn({ issue: 'slow-response' }, 'Response took too long');
  logger.error({ error }, 'Failed to process request');
}
```

### 单元测试

```typescript
import { describe, it, expect, beforeEach } from 'bun:test';
import { MyPlugin } from './my-plugin';

describe('MyPlugin', () => {
  let plugin: any;

  beforeEach(() => {
    plugin = new MyPlugin({ apiKey: 'test-key' });
  });

  it('should have correct metadata', () => {
    expect(MyPlugin.name).toBe('my-plugin');
    expect(MyPlugin.version).toBe('1.0.0');
  });

  it('should process request correctly', async () => {
    const ctx = {
      url: new URL('https://example.com/api'),
      headers: new Headers(),
      body: {}
    };

    await plugin.onRequest(ctx);

    expect(ctx.url.searchParams.get('plugin')).toBe('my-plugin');
    expect(ctx.headers.get('x-plugin-processed')).toBe('true');
  });
});
```

### 运行测试

```bash
cd packages/core
bun test
```

---

## 最佳实践

### 1. 使用 TypeScript 类型

充分利用 TypeScript 的类型系统，确保类型安全：

```typescript
interface MyPluginOptions {
  apiKey: string;
  timeout?: number;
}

export const MyPlugin = definePlugin(
  class implements Plugin {
    private options: MyPluginOptions;

    constructor(options: MyPluginOptions) {
      this.options = options;
    }
  }
);
```

### 2. 错误处理

始终处理可能的错误，避免插件崩溃影响整个系统：

```typescript
async onRequest(ctx: PluginContext): Promise<void> {
  try {
    // 你的逻辑
  } catch (error) {
    logger.error({ error, plugin: 'my-plugin' }, 'Request processing failed');
    // 不要抛出错误，让请求继续
  }
}
```

### 3. 性能优化

- 使用原子操作避免并发问题
- 缓存频繁访问的数据
- 避免阻塞 I/O 操作

```typescript
// ❌ 不好的做法：并发不安全
const count = await storage.get('counter') || 0;
await storage.set('counter', count + 1);

// ✅ 好的做法：使用原子操作
await storage.increment('stats', 'counter', 1);
```

### 4. 文档注释

为插件添加详细的 JSDoc 注释：

```typescript
/**
 * My Plugin
 *
 * 这个插件用于处理 API 请求的转换和增强
 *
 * @example
 * ```json
 * {
 *   "name": "my-plugin",
 *   "options": {
 *     "apiKey": "your-key"
 *   }
 * }
 * ```
 */
export const MyPlugin = definePlugin(/* ... */);
```

### 5. 避免副作用

在构造函数中避免执行异步操作或产生副作用，将初始化逻辑放在 `onInit` 中：

```typescript
// ❌ 不好
constructor(options: MyPluginOptions) {
  this.options = options;
  fetch('https://api.example.com/init'); // 副作用
}

// ✅ 好
constructor(options: MyPluginOptions) {
  this.options = options;
}

async onInit(context: PluginInitContext): Promise<void> {
  await fetch('https://api.example.com/init');
}
```

---

## 示例插件

### 1. 简单的日志插件

```typescript
import type { Plugin, PluginContext } from '../../plugin.types';
import { definePlugin } from '../../plugin.types';
import { logger } from '../../logger';

export const RequestLoggerPlugin = definePlugin(
  class implements Plugin {
    static readonly name = 'request-logger';
    static readonly version = '1.0.0';
    static readonly description = 'Log all incoming requests';

    async onRequest(ctx: PluginContext): Promise<void> {
      logger.info({
        method: ctx.method,
        url: ctx.url.pathname,
        headers: Object.fromEntries(ctx.headers.entries())
      }, 'Incoming request');
    }
  }
);

export default RequestLoggerPlugin;
```

### 2. 请求计数插件

```typescript
import type { Plugin, PluginContext, PluginInitContext } from '../../plugin.types';
import { definePlugin } from '../../plugin.types';
import { logger } from '../../logger';

export const RequestCounterPlugin = definePlugin(
  class implements Plugin {
    static readonly name = 'request-counter';
    static readonly version = '1.0.0';
    static readonly description = 'Count requests by path';

    async onRequest(ctx: PluginContext): Promise<void> {
      const storage = ctx.storage;
      const path = ctx.url.pathname;

      // 原子递增计数
      const count = await storage.increment('stats', `path:${path}`, 1);

      logger.debug({ path, count }, 'Request counted');

      // 添加计数到响应头
      ctx.headers.set('x-request-count', count.toString());
    }
  }
);

export default RequestCounterPlugin;
```

### 3. API 转换插件

```typescript
import type { Plugin, PluginContext } from '../../plugin.types';
import { definePlugin } from '../../plugin.types';

interface TransformerOptions {
  from: 'openai' | 'anthropic' | 'gemini';
  to: 'openai' | 'anthropic' | 'gemini';
}

export const APITransformerPlugin = definePlugin(
  class implements Plugin {
    static readonly name = 'api-transformer';
    static readonly version = '1.0.0';
    static readonly description = 'Transform API requests between different formats';

    private options: TransformerOptions;

    constructor(options: TransformerOptions) {
      this.options = options;
    }

    async onBeforeRequest(ctx: PluginContext): Promise<void> {
      if (this.options.from === 'openai' && this.options.to === 'anthropic') {
        // 转换 OpenAI 格式到 Anthropic 格式
        const body = ctx.body as any;
        ctx.body = {
          model: this.mapModel(body.model),
          messages: body.messages,
          max_tokens: body.max_tokens
        };
      }
    }

    async onResponse(ctx: PluginContext & { response: Response }): Promise<Response> {
      if (this.options.from === 'anthropic' && this.options.to === 'openai') {
        // 转换 Anthropic 响应到 OpenAI 格式
        const data = await ctx.response.json();
        const transformed = {
          id: data.id,
          object: 'chat.completion',
          choices: [{
            message: {
              role: 'assistant',
              content: data.content[0].text
            }
          }]
        };

        return new Response(JSON.stringify(transformed), {
          headers: ctx.response.headers
        });
      }

      return ctx.response;
    }

    private mapModel(model: string): string {
      // 模型映射逻辑
      return model;
    }
  }
);

export default APITransformerPlugin;
```

---

## 更多资源

- [Plugin API 参考](../packages/core/src/plugin.types.ts)
- [ai-transformer 插件入口](../plugins/ai-transformer/server/index.ts)
- [ai-transformer 转换规范](./ai-provider-conversion.md)
- [测试示例](../packages/core/tests/)

---

## 常见问题

### Q: 插件如何获取配置文件中的 options？

A: 通过构造函数参数接收：

```typescript
constructor(options: MyPluginOptions) {
  this.options = options;
}
```

### Q: 如何在插件间共享数据？

A: 使用插件存储系统，每个插件有独立的命名空间：

```typescript
// 插件 A
await storage.set('shared:key', 'value');

// 插件 B (无法访问插件 A 的数据)
const value = await storage.get('shared:key'); // null
```

如果需要跨插件通信，请参考 Phase 4 的插件间通信机制（即将推出）。

### Q: 插件可以修改哪些内容？

A: 插件可以修改：
- URL（路径、查询参数）
- Headers
- Body
- Response

不能修改的内容会在运行时被拦截。

### Q: 如何调试插件？

A:
1. 使用 `logger.debug()` 输出调试信息
2. 设置 `LOG_LEVEL=debug` 环境变量
3. 查看 `logs/` 目录下的日志文件
4. 编写单元测试

### Q: 插件会影响性能吗？

A: 插件会增加一定的处理时间，建议：
- 避免同步阻塞操作
- 使用缓存减少重复计算
- 在 `onInit` 中完成耗时的初始化
- 使用性能分析工具测量影响

---

**最后更新**: 2025-12-14
**版本**: v2.4.0
