import { api } from './client';

export interface PluginMetadata {
  name?: string;
  description?: string;
  icon?: string;
  contributes?: {
    navigation?: Array<{
      label: string;
      path: string;
      icon?: string;
      target?: 'sidebar' | 'header';
    }>;
    widgets?: Array<{
      title: string;
      path: string;
      size?: 'small' | 'medium' | 'large' | 'full';
    }>;
    /** 原生仪表板组件（非 iframe） */
    nativeWidgets?: Array<{
      id: string;
      title: string;
      size: 'small' | 'medium' | 'large' | 'full';
      component: string;
      props?: Record<string, any>;
    }>;
    /** API 端点贡献 */
    api?: Array<{
      path: string;
      methods: Array<'GET' | 'POST' | 'PUT' | 'DELETE'>;
      handler: string;
    }>;
    settings?: string;
  };
  /** @deprecated */
  menus?: Array<{
    id: string;
    title: string;
    path: string;
    icon?: string;
    location?: 'sidebar' | 'header';
  }>;
  /** @deprecated */
  ui?: {
    dashboard?: Array<{
      id: string;
      title: string;
      path: string;
      size?: { w: number; h: number };
    }>;
    settings?: string;
  };
}

export interface Plugin {
  name: string;
  version?: string;
  enabled: boolean;
  metadata?: PluginMetadata;
}

export interface PluginSchema {
  name: string;
  version?: string;
  description?: string;
  metadata?: PluginMetadata;
  configSchema: any[];
}

export interface PluginModelCatalogResponse {
  provider: string;
  models: Array<{ value: string; label?: string; description?: string; provider?: string }>;
  source?: 'fresh' | 'static';
}

export const PluginsAPI = {
  list: () => api.get<Plugin[]>('/plugins'),

  /**
   * 获取所有插件的配置 schema
   */
  getSchemas: () => api.get<Record<string, PluginSchema>>('/plugins/schemas'),

  /**
   * 获取已启用插件的配置 schema（用于路由/上游编辑）
   */
  getEnabledSchemas: () => api.get<Record<string, PluginSchema>>('/plugins/schemas?enabledOnly=true'),

  getPluginModels: (pluginName: string, provider?: string) => {
    const normalizedPluginName = pluginName.trim();
    const normalizedProvider = typeof provider === 'string' ? provider.trim() : '';
    const query = normalizedProvider ? `?provider=${encodeURIComponent(normalizedProvider)}` : '';
    return api.get<PluginModelCatalogResponse>(`/plugins/${encodeURIComponent(normalizedPluginName)}/models${query}`);
  },

  enable: (name: string) => api.post(`/plugins/${name}/enable`, {}),
  disable: (name: string) => api.post(`/plugins/${name}/disable`, {}),
};
