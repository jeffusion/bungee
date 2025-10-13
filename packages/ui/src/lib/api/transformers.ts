const API_BASE = '/__ui/api';

/**
 * Transformers API响应类型
 */
export interface TransformersResponse {
  transformers: string[];
  count: number;
}

export interface TransformerDetailResponse {
  id: string;
  config: any[];
}

/**
 * Transformers API客户端
 */
export class TransformersAPI {
  /**
   * 获取所有可用的transformers列表
   */
  static async getAll(): Promise<string[]> {
    const response = await fetch(`${API_BASE}/transformers`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data: TransformersResponse = await response.json();
    return data.transformers;
  }

  /**
   * 获取特定transformer的详细配置
   */
  static async getById(id: string): Promise<TransformerDetailResponse> {
    const response = await fetch(`${API_BASE}/transformers/${encodeURIComponent(id)}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  }
}