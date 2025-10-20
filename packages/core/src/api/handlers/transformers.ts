// 内置 transformer plugins
const BUILT_IN_PLUGINS = [
  'openai-to-anthropic',
  'anthropic-to-openai',
  'anthropic-to-gemini',
  'gemini-to-anthropic',
  'openai-to-gemini',
  'gemini-to-openai'
];

export class TransformersHandler {
  /**
   * 获取所有可用的 plugins (transformers) 列表
   */
  static getAll(): Response {
    try {
      return new Response(
        JSON.stringify({
          transformers: BUILT_IN_PLUGINS,  // 保持字段名为 transformers 以兼容前端
          plugins: BUILT_IN_PLUGINS,        // 同时提供 plugins 字段
          count: BUILT_IN_PLUGINS.length
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    } catch (error: any) {
      return new Response(
        JSON.stringify({ error: error.message || 'Failed to get plugins' }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
  }

  /**
   * 获取特定 plugin (transformer) 的详细信息
   */
  static getById(transformerId: string): Response {
    try {
      if (!BUILT_IN_PLUGINS.includes(transformerId)) {
        return new Response(
          JSON.stringify({ error: `Plugin '${transformerId}' not found` }),
          {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }

      return new Response(
        JSON.stringify({
          id: transformerId,
          name: transformerId,
          type: 'transformer',
          builtin: true
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    } catch (error: any) {
      return new Response(
        JSON.stringify({ error: error.message || 'Failed to get plugin' }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
  }
}
