# 插件系统重构 - 快速开始指南

**最后更新**: 2025-12-13

---

## 📚 文档导航

1. **PLUGIN_REFACTOR_PLAN.md** - 完整的执行计划和架构设计
2. **PLUGIN_REFACTOR_TASKS.md** - 详细的任务追踪表格
3. **本文档** - 快速开始和实施指南

---

## 🚀 立即开始

### 前置条件

- [ ] 代码已提交到Git（确保有回滚点）
- [ ] 创建新分支 `feature/plugin-system-refactor`
- [ ] 测试环境可用
- [ ] 通知团队成员

```bash
# 创建新分支
git checkout -b feature/plugin-system-refactor

# 安装依赖（如果需要新依赖）
bun install lru-cache  # Phase 2需要
```

---

## 📋 第一周任务（P0修复）

### Day 1: P0-1 修复PluginRegistry初始化逻辑

#### 步骤1: 理解问题（30分钟）

阅读以下文件，理解当前问题：
- `packages/core/src/plugin-registry.ts:136-163`
- `packages/core/src/plugin.types.ts`

**当前问题**:
```typescript
// ❌ 错误的实现
const tempInstance = new PluginClass(config.options || {});
const storage = new SQLitePluginStorage(db, tempInstance.name);
if (tempInstance.onInit) {
  await tempInstance.onInit({ storage, logger, config });
}
// ❌ tempInstance被丢弃，storage丢失！
```

#### 步骤2: 实施修复（6小时）

已提供模板文件：
- ✅ `packages/core/src/plugin-context-manager.ts`

**需要修改的文件**:

1. **修改 `plugin-registry.ts`** (3小时)

```typescript
// 在文件顶部导入
import {
  getPluginContextManager,
  type ExtendedPluginInitContext
} from './plugin-context-manager';

// 修改loadPlugin方法
async loadPlugin(config: PluginConfig): Promise<string> {
  const enabled = config.enabled !== false;
  const pluginPath = path.isAbsolute(config.path)
    ? config.path
    : path.resolve(this.configBasePath, config.path);

  logger.info({ pluginPath, enabled }, 'Loading plugin');

  // 动态导入
  const pluginModule = await import(pluginPath);
  const PluginClass = pluginModule.default || pluginModule.Plugin;

  if (!PluginClass) {
    throw new Error(`Plugin at ${pluginPath} must export a default class`);
  }

  // ✅ 创建临时实例仅用于获取名称和版本
  const tempInstance = new PluginClass(config.options || {});

  if (!tempInstance.name) {
    throw new Error(`Plugin at ${pluginPath} must have a 'name' property`);
  }

  const pluginName = tempInstance.name;

  // ✅ 通过ContextManager获取或创建全局context
  const contextManager = getPluginContextManager();
  const pluginContext = contextManager.getOrCreateContext(
    pluginName,
    pluginPath,
    config.options || {}
  );

  // ✅ 如果插件有onInit，在context上执行一次
  if (enabled && tempInstance.onInit) {
    try {
      logger.info({ pluginName }, 'Initializing plugin...');
      await tempInstance.onInit(pluginContext);
    } catch (error) {
      logger.error({ error, pluginName }, 'Plugin initialization failed');
      // 初始化失败应该禁用插件
      throw error;
    }
  }

  // 检测池化
  const pooled = !!(PluginClass as any).__pooled__;
  const poolOptions = (PluginClass as any).__poolOptions__ || {};

  // ✅ 创建对象池，注入context
  let pool: PluginPool<Plugin> | undefined;
  if (pooled) {
    pool = new PluginPool<Plugin>(
      () => {
        const instance = new PluginClass(config.options || {});
        // ✅ 注入context到实例
        (instance as any).__pluginContext__ = pluginContext;
        return instance;
      },
      {
        minSize: poolOptions.minSize || 2,
        maxSize: poolOptions.maxSize || 20
      }
    );
    logger.info({ pluginName, ...poolOptions }, 'Plugin pool created');
  }

  // 保存工厂信息
  const factoryInfo: PluginFactoryInfo = {
    PluginClass,
    config,
    enabled,
    pooled,
    pool,
    // ✅ 保存context引用
    context: pluginContext
  };

  this.pluginFactories.set(pluginName, factoryInfo);

  logger.info(
    { pluginName, version: tempInstance.version, enabled, pooled },
    'Plugin loaded successfully'
  );

  return pluginName;
}

// ✅ 修改createPluginInstances，注入context
createPluginInstances(pluginNames?: string[]): Plugin[] {
  const targetNames = pluginNames || Array.from(this.pluginFactories.keys());
  const instances: Plugin[] = [];

  for (const name of targetNames) {
    const factoryInfo = this.pluginFactories.get(name);

    if (!factoryInfo || !factoryInfo.enabled) {
      continue;
    }

    try {
      const instance = new factoryInfo.PluginClass(factoryInfo.config.options || {});
      // ✅ 注入context
      (instance as any).__pluginContext__ = factoryInfo.context;
      instances.push(instance);
    } catch (error) {
      logger.error({ error, pluginName: name }, 'Failed to create plugin instance');
    }
  }

  return instances;
}
```

2. **修改 `plugin.types.ts`** (1小时)

```typescript
// 添加辅助函数供插件使用
/**
 * 获取当前插件的context
 * 插件实例可以调用此函数访问自己的context
 */
export function getPluginContext(pluginInstance: Plugin): PluginInitContext | undefined {
  return (pluginInstance as any).__pluginContext__;
}
```

3. **更新 `main.ts`** (30分钟)

```typescript
import { initializePluginContextManager } from './plugin-context-manager';
import { accessLogWriter } from './logger/access-log-writer';

// 在启动时初始化ContextManager
const db = accessLogWriter.getDatabase();
initializePluginContextManager(db);

// ... 其他初始化代码 ...
```

#### 步骤3: 编写测试（2小时）

创建 `packages/core/tests/plugin-context-manager.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'bun:test';
import { PluginContextManager } from '../src/plugin-context-manager';
import { Database } from 'bun:sqlite';

describe('PluginContextManager', () => {
  let db: Database;
  let manager: PluginContextManager;

  beforeEach(() => {
    db = new Database(':memory:');
    // 创建plugin_storage表
    db.exec(`
      CREATE TABLE plugin_storage (
        plugin_name TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        ttl INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (plugin_name, key)
      )
    `);
    manager = PluginContextManager.getInstance(db);
  });

  it('should create context only once', () => {
    const ctx1 = manager.getOrCreateContext('test-plugin', '/path/to/plugin.ts', {});
    const ctx2 = manager.getOrCreateContext('test-plugin', '/path/to/plugin.ts', {});

    // 应该返回同一个实例
    expect(ctx1).toBe(ctx2);
  });

  it('should provide separate storage for different plugins', async () => {
    const ctx1 = manager.getOrCreateContext('plugin-a', '/path/a.ts', {});
    const ctx2 = manager.getOrCreateContext('plugin-b', '/path/b.ts', {});

    await ctx1.storage.set('key', 'value-a');
    await ctx2.storage.set('key', 'value-b');

    const value1 = await ctx1.storage.get('key');
    const value2 = await ctx2.storage.get('key');

    expect(value1).toBe('value-a');
    expect(value2).toBe('value-b');
  });

  it('should support globalState and workspaceState', async () => {
    const ctx = manager.getOrCreateContext('test-plugin', '/path/to/plugin.ts', {});

    await ctx.globalState.update('count', 42);
    await ctx.workspaceState.update('temp', 'data');

    const globalValue = await ctx.globalState.get('count');
    const workspaceValue = await ctx.workspaceState.get('temp');

    expect(globalValue).toBe(42);
    expect(workspaceValue).toBe('data');
  });

  it('should destroy context', async () => {
    manager.getOrCreateContext('test-plugin', '/path/to/plugin.ts', {});

    await manager.destroyContext('test-plugin');

    const ctx = manager.getContext('test-plugin');
    expect(ctx).toBeUndefined();
  });
});
```

运行测试:
```bash
bun test packages/core/tests/plugin-context-manager.test.ts
```

#### 步骤4: 验证修复（1小时）

1. 启动开发服务器
2. 访问 `http://localhost:8088/__ui/#/plugins`
3. 启用demo插件
4. 多次触发缓存（发送请求）
5. 检查缓存统计是否正确累加
6. 重启服务器，检查globalState是否保留

**验收标准**:
- ✅ 插件初始化只执行一次
- ✅ 所有实例共享同一个storage
- ✅ 缓存统计正确累加
- ✅ 测试全部通过

---

### Day 2: P0-2 & P0-3 修复安全漏洞

#### P0-2: 修复postMessage安全漏洞（3小时）

**修改 `packages/ui/src/lib/components/PluginHost.svelte`**:

```svelte
<script lang="ts">
  import { onMount, afterUpdate } from 'svelte';

  export let pluginName: string;
  export let path: string;

  let iframe: HTMLIFrameElement;
  let loading = true;

  // ✅ 计算插件origin
  $: src = `/__ui/plugins/${pluginName}/index.html#${path}`;
  $: pluginOrigin = new URL(src, window.location.href).origin;

  function handleLoad() {
    loading = false;
    syncTheme();
  }

  // ✅ 使用指定origin发送消息
  function syncTheme() {
    if (iframe && iframe.contentWindow) {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

      // ✅ 使用pluginOrigin替代'*'
      iframe.contentWindow.postMessage({
        type: 'bungee:theme',
        theme: isDark ? 'dark' : 'light'
      }, pluginOrigin);  // ✅ 指定origin
    }
  }

  onMount(() => {
    const observer = new MutationObserver(() => {
      syncTheme();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });
    return () => observer.disconnect();
  });
</script>

<div class="flex-1 w-full h-[calc(100vh-64px)] relative bg-carbon-950">
  {#if loading}
    <div class="absolute inset-0 flex items-center justify-center bg-carbon-950/95 z-10">
      <span class="loading loading-spinner loading-lg"></span>
    </div>
  {/if}

  <iframe
    bind:this={iframe}
    {src}
    title={`Plugin ${pluginName}`}
    class="w-full h-full border-none"
    on:load={handleLoad}
  ></iframe>
</div>
```

#### P0-3: 修复路径遍历漏洞（2小时）

**创建 `packages/core/src/utils/path-validator.ts`**:

```typescript
import * as path from 'path';
import * as fs from 'fs/promises';

const ALLOWED_EXTENSIONS = [
  '.html', '.htm',
  '.js', '.mjs', '.cjs',
  '.css',
  '.json',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
  '.woff', '.woff2', '.ttf', '.eot',
  '.map'
];

/**
 * 验证文件路径是否安全
 * 防止路径遍历攻击
 */
export async function validatePluginAssetPath(
  baseDir: string,
  requestedPath: string
): Promise<{ valid: boolean; error?: string; resolvedPath?: string }> {
  try {
    // 1. 规范化路径
    const fullPath = path.normalize(path.join(baseDir, requestedPath));

    // 2. 解析真实路径（防止符号链接绕过）
    let realPath: string;
    try {
      realPath = await fs.realpath(fullPath);
    } catch {
      return { valid: false, error: 'File not found' };
    }

    // 3. 检查是否在baseDir内
    const relativePath = path.relative(baseDir, realPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return { valid: false, error: 'Access denied: path outside base directory' };
    }

    // 4. 检查文件类型白名单
    const ext = path.extname(realPath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return { valid: false, error: `File type not allowed: ${ext}` };
    }

    // 5. 检查文件是否存在且是文件
    const stats = await fs.stat(realPath);
    if (!stats.isFile()) {
      return { valid: false, error: 'Not a file' };
    }

    return { valid: true, resolvedPath: realPath };
  } catch (error: any) {
    return { valid: false, error: error.message };
  }
}
```

**修改 `packages/core/src/ui/server.ts`**:

```typescript
import { validatePluginAssetPath } from '../utils/path-validator';

async function servePluginAsset(registry: PluginRegistry, pluginName: string, assetPath: string): Promise<Response> {
  try {
    const factoryInfo = (registry as any).pluginFactories.get(pluginName);
    if (!factoryInfo) {
      return new Response('Plugin not found', { status: 404 });
    }

    const pluginPath = factoryInfo.config.path;
    const pluginDir = path.dirname(pluginPath);
    const uiDir = path.join(pluginDir, 'ui');

    // ✅ 使用严格的路径验证
    const validation = await validatePluginAssetPath(uiDir, assetPath);

    if (!validation.valid) {
      logger.warn({ pluginName, assetPath, error: validation.error },
                  'Plugin asset access denied');
      return new Response(validation.error, { status: 403 });
    }

    // ✅ 使用验证后的真实路径
    const assetFile = file(validation.resolvedPath!);

    return new Response(assetFile, {
      headers: {
        'Content-Type': getContentType(assetPath),
        'Cache-Control': 'public, max-age=3600'
      }
    });
  } catch (error) {
    logger.error({ error, pluginName, assetPath }, 'Error serving plugin asset');
    return new Response('Internal Server Error', { status: 500 });
  }
}
```

---

### Day 3-4: P0-4 修复Storage并发问题

参考评审报告中的实现方案，添加原子操作和事务支持。

### Day 5: P0-5 综合测试

运行所有测试，确保P0问题全部解决。

---

## 📊 进度追踪

每天结束时更新 `PLUGIN_REFACTOR_TASKS.md`:

```bash
# 标记任务为进行中
# 将任务状态从 🔴 改为 🟡

# 标记任务为完成
# 将任务状态从 🟡 改为 🟢
# 填写完成日期
```

---

## 🔍 常见问题

### Q: 测试失败怎么办？
A:
1. 检查数据库是否正确初始化
2. 查看日志输出
3. 使用调试器单步执行
4. 在团队群里询问

### Q: 遇到意外的bug怎么办？
A:
1. 记录bug详情（复现步骤、错误信息）
2. 创建Issue
3. 在TASKS.md中标记任务为"受阻"
4. 寻求帮助

### Q: 工时超出预估怎么办？
A:
1. 评估是否需要调整范围
2. P0必须完成，P1/P2可以调整
3. 及时沟通，调整计划

---

## 📞 支持渠道

- **技术问题**: 团队群聊
- **代码审查**: 提PR @team
- **紧急问题**: 直接联系负责人

---

## ✅ 每日检查清单

- [ ] 代码提交到Git
- [ ] 运行单元测试
- [ ] 更新任务状态
- [ ] 记录遇到的问题
- [ ] 同步进度给团队

---

## 🎉 开始吧！

现在就开始第一个任务：

```bash
# 1. 创建PluginContextManager（已提供）
# 2. 修改plugin-registry.ts
# 3. 编写测试
# 4. 验证修复

# 加油！ 💪
```
