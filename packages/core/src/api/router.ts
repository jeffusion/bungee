import { ConfigHandler } from './handlers/config';
import { StatsHandler } from './handlers/stats';
import { SystemHandler } from './handlers/system';
import { TransformersHandler } from './handlers/transformers';

export async function handleAPIRequest(req: Request, path: string): Promise<Response> {
  const method = req.method;

  try {
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
