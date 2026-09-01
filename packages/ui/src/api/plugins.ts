import { api } from './client';
import { inspectTerminal, waitForConfigurationOperation, type ConfigurationOperationState } from './config';

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
  description?: string;
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
  source?: 'stored' | 'static';
  fetchedAt?: number;
}

export interface ModelMappingCatalogStatus {
  source: 'stored' | 'static';
  fetchedAt: number | null;
  modelCount: number;
  providerCount: number;
  models: Array<{ value: string; label: string; description: string; provider?: string }>;
  providers: string[];
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

  getModelMappingCatalogStatus: () => api.get<ModelMappingCatalogStatus>('/plugins/model-mapping/catalog'),
  refreshModelMappingCatalog: () => api.post<ModelMappingCatalogStatus>('/plugins/model-mapping/catalog/refresh', {}),

  enable: (name: string) => api.post<PluginToggleAccepted>(`/plugins/${encodeURIComponent(name)}/enable`, {}),
  disable: (name: string) => api.post<PluginToggleAccepted>(`/plugins/${encodeURIComponent(name)}/disable`, {}),
};

type PluginToggleAccepted = ConfigurationOperationState & {
  readonly unchanged?: boolean;
  readonly operation_id?: string;
};

/**
 * Toggles plugin activation through the master control plane and follows the
 * accepted publication operation to its terminal state before resolving.
 * Server truth — callers must re-read the plugin list after this resolves.
 */
export async function setPluginEnabled(
  name: string,
  enabled: boolean,
  options: { readonly timeoutMs?: number; readonly pollIntervalMs?: number } = {},
): Promise<'unchanged' | 'converged'> {
  const accepted = await (enabled ? PluginsAPI.enable(name) : PluginsAPI.disable(name));
  if (accepted.unchanged === true) return 'unchanged';
  if (typeof accepted.operation_id !== 'string') {
    throw new Error(`Plugin activation for ${name} was not accepted as a configuration operation`);
  }
  await (inspectTerminal(accepted) ?? waitForConfigurationOperation(accepted.operation_id, options));
  return 'converged';
}
