/**
 * Header Injection Example Plugin
 *
 * 功能：
 * - 添加自定义 Header
 * - 修改请求 URL 路径
 */

import type { Plugin } from '../../../packages/core/src/plugin.types';
import { definePlugin } from '../../../packages/core/src/plugin.types';
import type { PluginHooks, PluginInitContext } from '../../../packages/core/src/hooks';

export const HeaderInjectionExamplePlugin = definePlugin(
  class implements Plugin {
    // 保留必要的静态属性（用于类型检查和向后兼容）
    // 详细元数据从 manifest.json 读取
    static readonly name = 'header-injection-example';
    static readonly version = '1.0.0';

    /** @internal */
    customHeaders: Record<string, string> = {};

    async init(context: PluginInitContext): Promise<void> {
      this.customHeaders = context.config.headers || {
        'X-Plugin-Version': '1.0.0',
        'X-Powered-By': 'Bungee',
      };
    }

    register(hooks: PluginHooks): void {
      hooks.onBeforeRequest.tap(
        { name: 'header-injection-example', stage: -50 },
        (ctx) => {
          Object.assign(ctx.headers, this.customHeaders);
          return ctx;
        }
      );
    }
  }
);

export default HeaderInjectionExamplePlugin;
