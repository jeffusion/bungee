import { ConfigHandler } from './handlers/config';
import { StatsHandler } from './handlers/stats';
import { SystemHandler } from './handlers/system';
import { TransformersHandler } from './handlers/transformers';
import { LogsHandler } from './handlers/logs';
import { RoutesHandler } from './handlers/routes';
import { UpstreamControlHandler } from './handlers/upstreams';
import { AuthHandler } from './handlers/auth';
import { handleGetPlugins, handleGetPluginModels, handleTogglePlugin, handleGetPluginSandbox, handleGetPluginSchemas, handleGetPluginTranslations, handlePluginApiRequest, handleGetModelMappingCatalogStatus, handleRefreshModelMappingCatalog } from './handlers/plugins';
import { loadConfig } from '../config';
import { authenticateRequest } from '../auth';

export async function handleAPIRequest(req: Request, path: string): Promise<Response> {
  const method = req.method;

  try {
    const config = await loadConfig();

    if (config.auth?.enabled) {
      const isLoginEndpoint = path === '/api/auth/login';

      if (!isLoginEndpoint) {
        const reqUrl = new URL(req.url);
        const context = {
          env: process.env as Record<string, string>,
          request: {},
          headers: {},
          query: {},
          body: {},
          url: {
            pathname: reqUrl.pathname,
            search: reqUrl.search,
            host: reqUrl.host,
            protocol: reqUrl.protocol
          },
          method: req.method
        };

        const authResult = await authenticateRequest(req, config.auth, context);

        if (!authResult.success) {
          return new Response(
            JSON.stringify({
              error: 'Unauthorized',
              message: authResult.error || 'Authentication required'
            }),
            { status: 401, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }
    }

    if (path === '/api/auth/login' && method === 'POST') {
      return await AuthHandler.login(req);
    }

    if (path === '/api/auth/verify' && method === 'GET') {
      return await AuthHandler.verify(req);
    }

    if (path === '/api/config') {
      if (method === 'GET') {
        return ConfigHandler.get();
      }
      if (method === 'PUT') {
        return await ConfigHandler.update(req);
      }
    }

    if (path === '/api/config/validate' && method === 'POST') {
      return await ConfigHandler.validate(req);
    }

    if (path === '/api/routes' && method === 'GET') {
      return await RoutesHandler.list();
    }

    const upstreamControlMatch = path.match(/^\/api\/routes\/(.+?)\/upstreams\/(\d+)\/(enable|disable)$/);
    if (upstreamControlMatch && method === 'POST') {
      const [, encodedRoutePath, indexStr, action] = upstreamControlMatch;
      const upstreamIndex = parseInt(indexStr, 10);
      return UpstreamControlHandler.toggle(
        decodeURIComponent(encodedRoutePath),
        upstreamIndex,
        action === 'disable'
      );
    }

    if (path === '/api/stats' && method === 'GET') {
      return StatsHandler.getSnapshot();
    }

    if (path === '/api/stats/history' && method === 'GET') {
      return StatsHandler.getHistory(req);
    }

    if (path === '/api/stats/history/v2' && method === 'GET') {
      return await StatsHandler.getHistoryV2(req);
    }

    if (path === '/api/stats/upstream-stats' && method === 'GET') {
      return await StatsHandler.getUnifiedUpstreamStats(req);
    }

    if (path === '/api/stats/upstream-distribution' && method === 'GET') {
      return await StatsHandler.getUpstreamDistribution(req);
    }

    if (path === '/api/stats/upstream-failures' && method === 'GET') {
      return await StatsHandler.getUpstreamFailures(req);
    }

    if (path === '/api/stats/upstream-status-codes' && method === 'GET') {
      return await StatsHandler.getUpstreamStatusCodes(req);
    }

    if (path === '/api/system' && method === 'GET') {
      return SystemHandler.getInfo();
    }

    if (path === '/api/system/reload' && method === 'POST') {
      return SystemHandler.reload();
    }

    if (path === '/api/system/restart' && method === 'POST') {
      return SystemHandler.restart();
    }

    // Transformers管理
    if (path === '/api/transformers' && method === 'GET') {
      return TransformersHandler.getAll();
    }

    if (path.startsWith('/api/transformers/') && method === 'GET') {
      const transformerId = path.replace('/api/transformers/', '');
      return TransformersHandler.getById(transformerId);
    }

    // 插件管理
    if (path === '/api/plugins' && method === 'GET') {
      return await handleGetPlugins(req);
    }

    if (path === '/api/plugins/schemas' && method === 'GET') {
      return await handleGetPluginSchemas(req);
    }

    if (path === '/api/plugin-translations' && method === 'GET') {
      return await handleGetPluginTranslations(req);
    }

    if (path === '/api/plugins/model-mapping/catalog' && method === 'GET') {
      return await handleGetModelMappingCatalogStatus();
    }

    if (path === '/api/plugins/model-mapping/catalog/refresh' && method === 'POST') {
      return await handleRefreshModelMappingCatalog();
    }

    const pluginModelsMatch = path.match(/^\/api\/plugins\/([^\/]+)\/models$/);
    if (pluginModelsMatch && method === 'GET') {
      const [, pluginName] = pluginModelsMatch;
      return await handleGetPluginModels(req, pluginName);
    }

    if (path.startsWith('/api/plugins/') && path.endsWith('/sandbox') && method === 'GET') {
      const pluginName = path.replace('/api/plugins/', '').replace('/sandbox', '');
      return await handleGetPluginSandbox(req, pluginName);
    }

    if (path.startsWith('/api/plugins/') && path.endsWith('/enable') && method === 'POST') {
      const pluginName = path.replace('/api/plugins/', '').replace('/enable', '');
      return await handleTogglePlugin(req, pluginName, true);
    }

    if (path.startsWith('/api/plugins/') && path.endsWith('/disable') && method === 'POST') {
      const pluginName = path.replace('/api/plugins/', '').replace('/disable', '');
      return await handleTogglePlugin(req, pluginName, false);
    }

    // ===== 插件 API 委派 =====
    // 路径格式: /api/plugins/:pluginName/:subPath (不以 /enable, /disable, /sandbox 结尾)
    // 用于支持插件注册自己的 API 端点
    const pluginApiMatch = path.match(/^\/api\/plugins\/([^\/]+)\/(.+)$/);
    if (pluginApiMatch) {
      const [, pluginName, subPath] = pluginApiMatch;
      // 排除已有的内置端点
      if (!['enable', 'disable', 'sandbox'].includes(subPath)) {
        return await handlePluginApiRequest(req, pluginName, '/' + subPath);
      }
    }

    // 日志查询
    if (path === '/api/logs' && method === 'GET') {
      return await LogsHandler.query(req);
    }

    if (path === '/api/logs/stream' && method === 'GET') {
      return await LogsHandler.stream(req);
    }

    if (path === '/api/logs/export' && method === 'GET') {
      return await LogsHandler.export(req);
    }

    if (path === '/api/logs/stats' && method === 'GET') {
      return await LogsHandler.getStats(req);
    }

    if (path === '/api/logs/stats/timeseries' && method === 'GET') {
      return await LogsHandler.getTimeSeriesStats(req);
    }

    // 日志清理管理
    if (path === '/api/logs/cleanup' && method === 'POST') {
      return await LogsHandler.triggerCleanup(req);
    }

    if (path === '/api/logs/cleanup/config' && method === 'GET') {
      return LogsHandler.getCleanupConfig();
    }

    if (path === '/api/logs/cleanup/config' && method === 'PUT') {
      return await LogsHandler.updateCleanupConfig(req);
    }

    // Body 内容查询
    if (path.startsWith('/api/logs/body/') && method === 'GET') {
      const bodyId = path.replace('/api/logs/body/', '');
      return await LogsHandler.getBodyById(bodyId);
    }

    // Header 内容查询
    if (path.startsWith('/api/logs/headers/') && method === 'GET') {
      const headerId = path.replace('/api/logs/headers/', '');
      return await LogsHandler.loadHeader(headerId);
    }

    // 通过 Request ID 查询单条日志（需要放在最后，因为它匹配 /api/logs/*）
    if (path.startsWith('/api/logs/') && method === 'GET') {
      const requestId = path.replace('/api/logs/', '');
      return await LogsHandler.getById(requestId);
    }

    // 未匹配的路由
    return new Response(
      JSON.stringify({ error: 'Not Found' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('API Error:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Internal Server Error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
