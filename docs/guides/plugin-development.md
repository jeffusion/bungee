# 创建插件

本指南帮助仓库开发者创建、编译并启用一个仅修改请求头的 scoped 插件。先安装[开发环境](development.md)，了解[插件 API](../reference/plugin-api.md)；需要 UI 时先读取[设计规范](../../packages/ui/docs/INDUSTRIAL_DESIGN_SYSTEM.md)。

## 创建插件

1. 建立 `plugins/example-header/manifest.json`：

```json
{
  "name": "example-header",
  "version": "1.0.0",
  "schemaVersion": 3,
  "artifactKind": "runtime-plugin",
  "main": "server/index.ts",
  "runtimeScope": "scoped",
  "capabilities": ["hooks", "dynamicRuntimeLoad"],
  "uiExtensionMode": "none",
  "engines": { "bungee": "^5.0.0" },
  "configSchema": []
}
```

2. 建立 `plugins/example-header/server/index.ts`：

```ts
import { definePlugin, type Plugin, type PluginBodyRequirements, type PluginHooks } from '@jeffusion/bungee-core/plugin';

export default definePlugin(class implements Plugin {
  static readonly name = 'example-header';
  static readonly version = '1.0.0';

  bodyRequirements(): PluginBodyRequirements {
    return { request: 'none' };
  }

  register(hooks: PluginHooks): void {
    hooks.onBeforeRequest.tapPromise('example-header', async context => {
      context.headers['x-example-header'] = 'active';
      return context;
    });
  }
});
```

此插件不读取正文。`onBeforeRequest` 是瀑布 Hook，必须返回上下文；不要实现一个同名直接方法来代替注册。

3. 在仓库根构建：

```bash
bun run build
```

构建工具编译 server/control/ingress 入口并输出到 `packages/core/dist/plugins/`，发行 manifest 指向编译后的文件。检查构建成功、目标目录含 manifest 与 index.js，再启动独立开发实例。

4. 在插件中心启用 example-header，并在一条开发路由绑定它。全局 activation 与路由 binding 的 enabled 分别控制可用性和执行范围。
5. 保存后确认实际服务 revision 已切换。向受控上游发送请求，确认上游收到 `x-example-header: active`，响应仍可完整读取。验证时使用开发路由，不把生产返回 200 作为插件执行证明。

## 添加配置和业务能力

构造器接收 binding options；字段定义放 manifest 的 configSchema，静态 configSchema 与其保持一致。验证输入类型和范围，不将 UI 表单校验当成服务端校验。

需要正文时根据 method、路径和功能声明 json-read/json-write；响应读取使用 bodyHandle，流转换使用 SSEEnvelope。完整边界见[正文契约](../reference/plugin-api.md#正文与-sse)。

需要跨插件能力时，声明 dependencies 与 services，再通过服务句柄消费；参考 [model-mapping](../../plugins/model-mapping/server/index.ts)。需要持久业务状态时添加 control entry，通过异步 durableState 做 CAS；需要幂等外部操作时采用命令日志及结果查询，不用普通 KV 模拟原子账本。

API、管理登录和 UI 贡献均需 manifest 声明。管理登录由选中的 provider 组件实现，见[登录组件契约](../reference/plugin-api.md#管理认证登录界面)。API 权限由 Host 门禁执行；声明不能将第三方 JavaScript 代码变成沙箱。

## 调试与结果确认

- 使用公开 SDK 的 logger，记录插件名、scope 与请求 ID，不输出凭据或完整正文。
- `init` 获取能力，构造器保持无异步副作用；`reset` 清理请求状态，`onDestroy` 释放资源。
- 单测通过实际 Hook 调用验证返回值及修改，不能直接调用不存在的 plugin.onRequest。
- 检查初始化、依赖和发布失败日志。已提交版本与 serving 版本不同，说明运行发布尚未完成；不要继续写入试图掩盖问题。
- 隔离环境的构建、浏览器与真实进程验证入口见[开发指南](development.md)。

典型实现：[model-mapping](../../plugins/model-mapping/server/index.ts)、[ai-transformer](../../plugins/ai-transformer/server/index.ts)、[控制面账户插件](../../plugins/local-accounts/server/control.ts)。
