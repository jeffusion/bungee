const API_BASE = '/__ui/api';

/**
 * Plugins API响应类型
 */
export interface PluginsResponse {
  plugins: string[];
  count: number;
}

export interface PluginDetailResponse {
  id: string;
  config: any[];
}

/**
 * Plugins API客户端
 */
export class PluginsAPI {
  /**
   * 获取所有可用的plugins列表
   */
  static async getAll(): Promise<string[]> {
    const response = await fetch(`${API_BASE}/transformers`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data: any = await response.json();
    // 支持新旧两种响应格式，保持向后兼容
    return data.plugins || data.transformers || [];
  }

  /**
   * 获取特定plugin的详细配置
   */
  static async getById(id: string): Promise<PluginDetailResponse> {
    const response = await fetch(`${API_BASE}/transformers/${encodeURIComponent(id)}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  }
}