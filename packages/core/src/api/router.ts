import { ConfigHandler } from './handlers/config';
import { StatsHandler } from './handlers/stats';
import { SystemHandler } from './handlers/system';
import { TransformersHandler } from './handlers/transformers';
import { LogsHandler } from './handlers/logs';
import { RoutesHandler } from './handlers/routes';
import { AuthHandler } from './handlers/auth';
import { loadConfig } from '../config';
import { authenticateRequest } from '../auth';

export async function handleAPIRequest(req: Request, path: string): Promise<Response> {
  const method = req.method;

  try {
    // ===== API 认证中间件 =====
    // 1. 获取配置检查是否启用认证
    const config = await loadConfig();

    if (config.auth?.enabled) {
      // 2. 白名单：login 接口不需要认证（避免死锁）
      const isLoginEndpoint = path === '/api/auth/login';

      if (!isLoginEndpoint) {
        // 3. 验证 Authorization header
        const context = {
          env: process.env,
          request: {},
          headers: {},
          query: {}
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

    // ===== 路由处理 =====
    // 认证管理（白名单：login 不需要认证）
    if (path === '/api/auth/login' && method === 'POST') {
      return await AuthHandler.login(req);
    }

    if (path === '/api/auth/verify' && method === 'GET') {
      return await AuthHandler.verify(req);
    }

    // 配置管理
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

    // 路由管理
    if (path === '/api/routes' && method === 'GET') {
      return RoutesHandler.list();
    }

    // 统计数据
    if (path === '/api/stats' && method === 'GET') {
      return StatsHandler.getSnapshot();
    }

    if (path === '/api/stats/history' && method === 'GET') {
      return StatsHandler.getHistory(req);
    }

    // 新的历史数据API，支持新的时间范围
    if (path === '/api/stats/history/v2' && method === 'GET') {
      return await StatsHandler.getHistoryV2(req);
    }

    // 系统信息
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
