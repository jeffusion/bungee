import { loadConfig } from '../../config';
import {
  getModelMappingCatalogStatus,
  refreshStoredModelMappingCatalog,
} from '../../../../../plugins/model-mapping/server/index';
import { freezePluginRuntimeState } from '../../plugin-runtime-state-machine';
import { getScopedPluginRegistry } from '../../scoped-plugin-registry';
import { logger } from '../../logger';
import { getPermissionManager } from '../../plugin-permissions';
import {
  getPluginRegistry,
  getPluginRuntimeOrchestrator,
  reconcilePluginRuntimeAcrossWorkers,
} from '../../worker/state/plugin-manager';

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

function getFrozenPluginState(pluginName: string) {
  const orchestratorEntry = getPluginRuntimeOrchestrator()
    ?.getStatusReport()
    .plugins.find((plugin) => plugin.pluginName === pluginName);

  if (orchestratorEntry) {
    return {
      generation: orchestratorEntry.generation,
      lifecycle: orchestratorEntry.state.lifecycle,
      authorities: orchestratorEntry.state.authorities,
      states: orchestratorEntry.state.states,
      runtime: orchestratorEntry.state.runtime,
      reasons: orchestratorEntry.state.reasons,
      failures: orchestratorEntry.state.failures,
      sources: orchestratorEntry.sources,
    };
  }

  const registrySnapshot = getPluginRegistry()?.getPluginStateSnapshot(pluginName);
  if (!registrySnapshot) {
    return null;
  }

  const runtimeSnapshot = getScopedPluginRegistry()?.getPluginRuntimeStateSnapshot(pluginName);
  const frozenState = freezePluginRuntimeState(registrySnapshot, runtimeSnapshot);

  return {
    generation: 0,
    lifecycle: frozenState.lifecycle,
    authorities: frozenState.authorities,
    states: frozenState.states,
    runtime: frozenState.runtime,
    reasons: frozenState.reasons,
    failures: frozenState.failures,
    sources: {
      registry: true,
      runtime: Boolean(runtimeSnapshot),
    },
  };
}

/**
 * 获取所有已扫描插件的元数据
 */
export async function handleGetPlugins(_req: Request): Promise<Response> {
  const registry = getPluginRegistry();
  const orchestratorReport = getPluginRuntimeOrchestrator()?.getStatusReport() ?? null;

  if (!registry && !orchestratorReport) {
    return new Response(JSON.stringify([]), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const registryPlugins = registry?.getAllPluginsMetadata() ?? [];
  const registryPluginMap = new Map(registryPlugins.map((plugin) => [plugin.name, plugin]));
  const pluginNames = new Set<string>([
    ...registryPlugins.map((plugin) => plugin.name),
    ...(orchestratorReport?.plugins.map((plugin) => plugin.pluginName) ?? []),
  ]);

  const plugins = Array.from(pluginNames)
    .sort((left, right) => left.localeCompare(right))
    .map((pluginName) => {
      const pluginState = orchestratorReport?.plugins.find((plugin) => plugin.pluginName === pluginName);
      const registryPlugin = registryPluginMap.get(pluginName);

      return {
        name: pluginName,
        version: registryPlugin?.version ?? 'unknown',
        description: registryPlugin?.description ?? '',
        metadata: registryPlugin?.metadata ?? { name: pluginName },
        enabled: registryPlugin?.enabled ?? (pluginState?.state.states.persistedEnabled === 'enabled'),
        hasManifest: registryPlugin?.hasManifest ?? Boolean(pluginState?.sources.registry),
      };
    });

  // 为翻译键添加命名空间前缀
  const transformedPlugins = plugins.map(plugin => ({
    ...plugin,
    state: getFrozenPluginState(plugin.name),
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
      ,description: isTranslationKey(plugin.description)
        ? `plugins.${plugin.name}.${plugin.description}`
        : (plugin.metadata.description ?? plugin.description)
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

    const reconcileOutcome = await reconcilePluginRuntimeAcrossWorkers(await loadConfig());
    const pluginState = reconcileOutcome.result.status.plugins.find((plugin) => plugin.pluginName === pluginName);

    return new Response(JSON.stringify({
      success: true,
      pluginName,
      generation: reconcileOutcome.result.generation,
      diff: reconcileOutcome.result.diff,
      convergence: reconcileOutcome.convergence,
      persistedEnabled: enable ? 'enabled' : 'disabled',
      state: pluginState ? {
        lifecycle: pluginState.state.lifecycle,
        authorities: pluginState.state.authorities,
        states: pluginState.state.states,
        runtime: pluginState.state.runtime,
        reasons: pluginState.state.reasons,
        failures: pluginState.state.failures,
        sources: pluginState.sources,
      } : getFrozenPluginState(pluginName),
    }), {
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

export async function handleGetPluginModels(req: Request, pluginName: string): Promise<Response> {
  const registry = getPluginRegistry();
  if (!registry) {
    return new Response(
      JSON.stringify({ error: 'Plugin registry not initialized' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const pluginClass = registry.getPluginClass(pluginName);
  if (!pluginClass) {
    return new Response(
      JSON.stringify({ error: `Plugin "${pluginName}" not found` }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (typeof pluginClass.getEditorModels === 'function') {
    const serviceContext: import('../../plugin.types').PluginServiceContext = {
      db: getPluginRuntimeOrchestrator()?.getDatabase(),
    };
    try {
      const response = await pluginClass.getEditorModels(req, serviceContext);
      return response instanceof Response
        ? response
        : new Response(JSON.stringify(response), {
          headers: { 'Content-Type': 'application/json' }
        });
    } catch (error: any) {
      logger.error({ error, pluginName }, 'Failed to resolve plugin editor model catalog');
      return new Response(
        JSON.stringify({ error: error?.message || 'Failed to resolve plugin models' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  return await handlePluginApiRequest(req, pluginName, '/models');
}

export async function handleGetModelMappingCatalogStatus(): Promise<Response> {
  try {
    const status = await getModelMappingCatalogStatus();
    return new Response(JSON.stringify(status), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    logger.error({ error }, 'Failed to get model-mapping catalog status');
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

export async function handleRefreshModelMappingCatalog(): Promise<Response> {
  try {
    const status = await refreshStoredModelMappingCatalog();
    return new Response(JSON.stringify(status), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    logger.error({ error }, 'Failed to refresh model-mapping catalog');
    return new Response(JSON.stringify({ error: error.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * 匹配路径模式（支持路径参数）
 *
 * @param pattern 路径模式，如 "/accounts/:id/refresh"
 * @param path 实际请求路径，如 "/accounts/123/refresh"
 * @returns 如果匹配返回 true，否则返回 false
 */
function matchPathPattern(pattern: string, path: string): boolean {
  // 如果没有路径参数，使用精确匹配
  if (!pattern.includes(':')) {
    return pattern === path;
  }

  // 将路径模式转换为正则表达式
  // 例如：/accounts/:id/refresh -> /accounts/([^/]+)/refresh
  const regexPattern = pattern
    .split('/')
    .map(segment => {
      if (segment.startsWith(':')) {
        // 路径参数匹配任意非斜杠字符
        return '([^/]+)';
      }
      // 普通段落需要转义特殊字符
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(path);
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
  * // 请求 GET /api/plugins/token-stats/stats
  * // 会调用 token-stats 插件实例的 getStats 方法
  */
export async function handlePluginApiRequest(
  req: Request,
  pluginName: string,
  subPath: string
): Promise<Response> {
  try {
    const scopedRegistry = getScopedPluginRegistry();
    const registry = getPluginRegistry();
    if (!scopedRegistry) {
      return new Response(
        JSON.stringify({ error: 'Plugin system not initialized' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (!registry) {
      return new Response(
        JSON.stringify({ error: 'Plugin registry not initialized' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const pluginDescriptor = registry.getPluginAssetDescriptor(pluginName);
    if (!pluginDescriptor && !registry.getPluginManifest(pluginName) && registry.getPluginApiDeclarations(pluginName).length === 0) {
      return new Response(
        JSON.stringify({ error: `Plugin "${pluginName}" not found` }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const apiDeclarations: Array<{ path: string; methods: string[]; handler: string }> =
      registry.getPluginApiDeclarations(pluginName);
    const method = req.method as 'GET' | 'POST' | 'PUT' | 'DELETE';

    const matchedApi = apiDeclarations.find(api => {
      return matchPathPattern(api.path, subPath) && api.methods.includes(method);
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

    const globalInstances = scopedRegistry.getGlobalInstances();
    const instance = globalInstances.find(i => i.handler.pluginName === pluginName);

    if (!instance) {
      logger.warn({ pluginName }, 'Plugin API request rejected because no global runtime instance is serving');
      return new Response(
        JSON.stringify({
          error: `Plugin "${pluginName}" has no active global runtime instance`,
          hint: 'Reconcile plugin runtime before calling plugin APIs'
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
