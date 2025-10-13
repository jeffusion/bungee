import { transformers } from '../../transformers';

export class TransformersHandler {
  /**
   * 获取所有可用的transformers列表
   */
  static getAll(): Response {
    try {
      const transformerNames = Object.keys(transformers);

      return new Response(
        JSON.stringify({
          transformers: transformerNames,
          count: transformerNames.length
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    } catch (error: any) {
      return new Response(
        JSON.stringify({ error: error.message || 'Failed to get transformers' }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
  }

  /**
   * 获取特定transformer的详细配置
   */
  static getById(transformerId: string): Response {
    try {
      const transformer = transformers[transformerId];

      if (!transformer) {
        return new Response(
          JSON.stringify({ error: `Transformer '${transformerId}' not found` }),
          {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }

      return new Response(
        JSON.stringify({
          id: transformerId,
          config: transformer
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    } catch (error: any) {
      return new Response(
        JSON.stringify({ error: error.message || 'Failed to get transformer' }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
  }
}
