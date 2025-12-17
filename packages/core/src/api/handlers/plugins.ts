import { getPluginRegistry } from '../../worker/state/plugin-manager';
import { getScopedPluginRegistry } from '../../scoped-plugin-registry';
import { logger } from '../../logger';
import { getPermissionManager } from '../../plugin-permissions';

/**
 * 检测文本是否为翻译键
 * 翻译键格式：包含 `.` 且不包含空格
 */
function isTranslationKey(text: any): boolean {
  return typeof text === 'string' && text.includes('.') && !text.includes(' ');
}

/**
 * 为插件的翻译键添加命名空间前缀
 * 递归处理对象/数组，将所有符合条件的字段的翻译键添加 `plugins.{pluginName}.` 前缀
 *
 * @param obj 要处理的对象
 * @param pluginName 插件名称
 * @param fieldsToTransform 需要转换的字段名列表
 * @returns 转换后的对象
 */
function prefixPluginTranslationKeys(
  obj: any,
  pluginName: string,
  fieldsToTransform: string[] = ['label', 'description', 'placeholder']
): any {
  if (!obj || typeof obj !== 'object') return obj;

  // 处理数组
  if (Array.isArray(obj)) {
    return obj.map(item => prefixPluginTranslationKeys(item, pluginName, fieldsToTransform));
  }

  // 处理对象
  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (fieldsToTransform.includes(key) && isTranslationKey(value)) {
      // 如果是需要转换的字段且值是翻译键，添加前缀
      result[key] = `plugins.${pluginName}.${value}`;
    } else if (typeof value === 'object' && value !== null) {
      // 递归处理嵌套对象/数组
      result[key] = prefixPluginTranslationKeys(value, pluginName, fieldsToTransform);
    } else {
      // 其他情况直接复制
      result[key] = value;
    }
  }
  return result;
}

/**
 * 获取所有已扫描插件的元数据
 */
export async function handleGetPlugins(req: Request): Promise<Response> {
  const registry = getPluginRegistry();
  if (!registry) {
    return new Response(JSON.stringify([]), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 使用 PluginRegistry 的公共方法获取所有插件元数据
  const plugins = registry.getAllPluginsMetadata();

  // 为翻译键添加命名空间前缀
  const transformedPlugins = plugins.map(plugin => ({
    ...plugin,
    // 转换 description
    description: isTranslationKey(plugin.description)
      ? `plugins.${plugin.name}.${plugin.description}`
      : plugin.description,
    // 转换 metadata.name
    metadata: plugin.metadata ? {
      ...plugin.metadata,
      name: isTranslationKey(plugin.metadata.name)
        ? `plugins.${plugin.name}.${plugin.metadata.name}`
        : plugin.metadata.name
    } : plugin.metadata
  }));

  return new Response(JSON.stringify(transformedPlugins), {
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * 获取所有插件的配置 Schema
 * 用于 UI 动态生成插件配置表单
 *
 * Query 参数：
 * - enabledOnly=true: 只返回已启用插件的 schema（用于路由/上游编辑）
 */
export async function handleGetPluginSchemas(req: Request): Promise<Response> {
  const registry = getPluginRegistry();
  if (!registry) {
    return new Response(JSON.stringify({}), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const url = new URL(req.url);
    const enabledOnly = url.searchParams.get('enabledOnly') === 'true';

    const allSchemas = registry.getAllPluginSchemas();

    // 为所有 schema 添加翻译键前缀
    const transformedSchemas: Record<string, any> = {};
    for (const [name, schema] of Object.entries(allSchemas)) {
      transformedSchemas[name] = {
        ...schema,
        // 转换 description
        description: isTranslationKey(schema.description)
          ? `plugins.${name}.${schema.description}`
          : schema.description,
        // 转换 metadata.name
        metadata: schema.metadata ? {
          ...schema.metadata,
          name: isTranslationKey(schema.metadata.name)
            ? `plugins.${name}.${schema.metadata.name}`
            : schema.metadata.name
        } : schema.metadata,
        // 递归转换 configSchema 中的所有翻译键
        configSchema: prefixPluginTranslationKeys(schema.configSchema, name)
      };
    }

    // 如果需要过滤，只返回已启用插件的 schema
    if (enabledOnly) {
      const plugins = registry.getAllPluginsMetadata();
      const enabledPluginNames = new Set(
        plugins.filter(p => p.enabled).map(p => p.name)
      );

      const filteredSchemas: Record<string, any> = {};
      for (const [name, schema] of Object.entries(transformedSchemas)) {
        if (enabledPluginNames.has(name)) {
          filteredSchemas[name] = schema;
        }
      }

      return new Response(JSON.stringify(filteredSchemas), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 默认返回所有插件的 schema
    return new Response(JSON.stringify(transformedSchemas), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    logger.error({ error }, 'Failed to get plugin schemas');
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * 启用/禁用插件
 *
 * ✅ 新架构：状态保存在数据库中，不再修改 config.json
 */
export async function handleTogglePlugin(_req: Request, pluginName: string, enable: boolean): Promise<Response> {
  try {
    const registry = getPluginRegistry();
    if (!registry) {
      return new Response(
        JSON.stringify({ error: 'Plugin registry not initialized' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ✅ 使用 PluginRegistry 的方法更新数据库
    const success = enable
      ? registry.enablePlugin(pluginName)
      : registry.disablePlugin(pluginName);

    if (!success) {
      return new Response(
        JSON.stringify({ error: `Plugin "${pluginName}" not found` }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    logger.info(
      { pluginName, enabled: enable },
      `Plugin ${enable ? 'enabled' : 'disabled'} via API`
    );

    return new Response(JSON.stringify({ success: true, enabled: enable }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    logger.error({ error, pluginName }, 'Failed to toggle plugin');
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * 获取插件的sandbox属性
 */
export async function handleGetPluginSandbox(_req: Request, pluginName: string): Promise<Response> {
  try {
    const permissionManager = getPermissionManager();
    const sandboxAttrs = permissionManager.getSandboxAttributes(pluginName);

    return new Response(JSON.stringify({ sandbox: sandboxAttrs }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    logger.error({ error, pluginName }, 'Failed to get plugin sandbox attributes');

    // 返回默认的严格sandbox
    return new Response(
      JSON.stringify({ sandbox: 'allow-scripts allow-same-origin' }),
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

/**
 * 获取所有插件的翻译内容
 *
 * 返回格式化的翻译数据，可直接用于前端 i18n 系统
 *
 * @example
 * GET /api/plugin-translations
 *
 * Response:
 * {
 *   "en": {
 *     "plugins": {
 *       "ai-transformer": {
 *         "transformation.label": "Transformation Direction",
 *         "options.anthropic_openai.label": "Anthropic → OpenAI"
 *       }
 *     }
 *   },
 *   "zh-CN": {
 *     "plugins": {
 *       "ai-transformer": {
 *         "transformation.label": "转换方向",
 *         "options.anthropic_openai.label": "Anthropic → OpenAI"
 *       }
 *     }
 *   }
 * }
 */
export async function handleGetPluginTranslations(_req: Request): Promise<Response> {
  try {
    const registry = getPluginRegistry();
    if (!registry) {
      logger.warn('Plugin registry not initialized, returning empty translations');
      return new Response(JSON.stringify({}), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const translations = registry.getAllPluginTranslations();

    logger.debug(
      {
        locales: Object.keys(translations),
        pluginCount: Object.keys(translations?.en?.plugins || {}).length
      },
      'Plugin translations retrieved'
    );

    return new Response(JSON.stringify(translations), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    logger.error({ error }, 'Failed to get plugin translations');
    return new Response(
      JSON.stringify({ error: 'Failed to get plugin translations' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

/**
 * 处理插件 API 请求
 *
 * 将请求委派给插件实例的方法处理。
 * 只有 global scope 的插件实例才能处理 API 请求。
 *
 * Scope 控制：
 * - 插件只能访问自己的存储命名空间
 * - 插件只能响应自己在 contributes.api 中声明的端点
 *
 * @example
 * // 请求 GET /api/plugins/token-stats/summary
 * // 会调用 token-stats 插件实例的 getSummary 方法
 */
export async function handlePluginApiRequest(
  req: Request,
  pluginName: string,
  subPath: string
): Promise<Response> {
  try {
    const scopedRegistry = getScopedPluginRegistry();
    if (!scopedRegistry) {
      return new Response(
        JSON.stringify({ error: 'Plugin system not initialized' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 获取插件类（如果未加载则尝试加载）
    let pluginClass = scopedRegistry.getPluginClass(pluginName);
    if (!pluginClass) {
      // 尝试动态加载插件类
      try {
        pluginClass = await scopedRegistry.ensurePluginClassLoaded({ name: pluginName });
      } catch (loadError) {
        logger.debug({ error: loadError, pluginName }, 'Failed to load plugin class');
      }
    }

    if (!pluginClass) {
      return new Response(
        JSON.stringify({ error: `Plugin "${pluginName}" not found` }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 检查 API 端点是否在 contributes.api 中声明
    // 优先从 manifest 获取（新架构），回退到静态属性（向后兼容）
    const registry = getPluginRegistry();
    const manifest = registry?.getPluginManifest(pluginName);
    const apiDeclarations: Array<{ path: string; methods: string[]; handler: string }> =
      manifest?.contributes?.api
      || pluginClass.metadata?.contributes?.api
      || [];
    const method = req.method as 'GET' | 'POST' | 'PUT' | 'DELETE';

    const matchedApi = apiDeclarations.find(api => {
      return api.path === subPath && api.methods.includes(method);
    });

    if (!matchedApi) {
      logger.debug(
        { pluginName, subPath, method, declared: apiDeclarations.map(a => `${a.methods.join('|')} ${a.path}`) },
        'Plugin API endpoint not declared'
      );
      return new Response(
        JSON.stringify({ error: `API endpoint "${subPath}" not found for plugin "${pluginName}"` }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 获取处理器实例（从 global scope 获取）
    let globalInstances = scopedRegistry.getGlobalInstances();
    let instance = globalInstances.find(i => i.handler.pluginName === pluginName);

    // 如果没有全局实例，但插件已启用且声明了 API，则动态创建实例
    if (!instance) {
      const registry = getPluginRegistry();
      const pluginMeta = registry?.getAllPluginsMetadata().find(p => p.name === pluginName);

      if (pluginMeta?.enabled) {
        logger.info({ pluginName }, 'Creating global instance for API handling');

        try {
          // 动态创建全局实例
          await scopedRegistry.createInstance(
            { type: 'global' },
            { name: pluginName, enabled: true }
          );

          // 重新获取实例
          globalInstances = scopedRegistry.getGlobalInstances();
          instance = globalInstances.find(i => i.handler.pluginName === pluginName);
        } catch (createError) {
          logger.error({ error: createError, pluginName }, 'Failed to create global instance');
        }
      }
    }

    if (!instance) {
      logger.warn({ pluginName }, 'Plugin has no global instance for API handling');
      return new Response(
        JSON.stringify({
          error: `Plugin "${pluginName}" is not enabled or failed to initialize`,
          hint: 'Enable the plugin in the Plugins management page'
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 检查 handler 是否有对应的方法
    const handler = instance.handler as any;
    if (typeof handler[matchedApi.handler] !== 'function') {
      logger.error({ pluginName, handler: matchedApi.handler }, 'Plugin handler method not found');
      return new Response(
        JSON.stringify({ error: `Handler method "${matchedApi.handler}" not implemented` }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 调用 handler 方法
    logger.debug(
      { pluginName, path: subPath, method, handler: matchedApi.handler },
      'Delegating API request to plugin'
    );

    const response = await handler[matchedApi.handler](req);

    // 确保返回的是 Response 对象
    if (!(response instanceof Response)) {
      logger.warn(
        { pluginName, handler: matchedApi.handler, responseType: typeof response },
        'Plugin handler did not return a Response object'
      );
      return new Response(
        JSON.stringify(response),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    return response;
  } catch (error: any) {
    logger.error({ error, pluginName, subPath }, 'Plugin API request failed');
    return new Response(
      JSON.stringify({ error: error.message || 'Internal error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}