import { api, requestPluginControl, type ApiRequestOptions } from './client';
import { inspectTerminal, waitForConfigurationOperation, type ConfigurationOperationState } from './config';

export interface UpstreamSourceContribution {
  readonly id: string;
  readonly label: string;
  readonly listAccounts: string;
  readonly createDraft: string;
  readonly credentialPolicy: {
    readonly allowedOrigins: readonly string[];
    readonly allowedRequests: readonly { readonly pathname: string; readonly methods: readonly string[] }[];
    readonly allowedHeaderNames: readonly string[];
  };
}

export interface PluginMetadata {
  name?: string;
  description?: string;
  icon?: string;
  contributes?: {
    upstreamSources?: readonly UpstreamSourceContribution[];
    navigation?: Array<{
      label: string;
      path: string;
      icon?: string;
      target?: 'sidebar' | 'header';
      component?: string;
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
      presentation?: 'kpi';
      props?: Record<string, any>;
    }>;
    /** API 端点贡献 */
    api?: Array<{
      path: string;
      methods: Array<'GET' | 'POST' | 'PUT' | 'DELETE'>;
      handler: string;
      execution: 'control';
    }>;
    resourceExtensions?: Array<{resource:string;component:string;path:string}>;
    settings?: string;
    nativeSettingsComponent?: string;
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
  runtimeScope?: 'global' | 'scoped';
  version?: string;
  description?: string;
  enabled: boolean;
  metadata?: PluginMetadata;
  management?: {loginComponent?:string};
  dependencies?: Record<string,string>;
  dependents?: string[];
  ready?: boolean;
  blockedReason?: string;
  lifecycle?: string;
}

export interface PluginSchema {
  name: string;
  runtimeScope?: 'global' | 'scoped';
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
  matchedCount: number;
  page: number;
  pageSize: number;
  models: Array<{ value: string; label: string; description: string; provider?: string }>;
  providers: string[];
}

export const PluginsAPI = {
  list: (options?: ApiRequestOptions) => api.get<Plugin[]>('/plugins', options),

  /**
   * 获取所有插件的配置 schema
   */
  getSchemas: () => api.get<Record<string, PluginSchema>>('/plugins/schemas'),

  /**
   * 获取已启用插件的配置 schema（用于路由/上游编辑）
   */
  getEnabledSchemas: (scope?: 'global' | 'route' | 'service' | 'upstream') =>
    api.get<Record<string, PluginSchema>>(`/plugins/schemas?enabledOnly=true${scope ? `&scope=${scope}` : ''}`),

  getPluginModels: (pluginName: string, provider?: string) => {
    const normalizedPluginName = pluginName.trim();
    const normalizedProvider = typeof provider === 'string' ? provider.trim() : '';
    const query = normalizedProvider ? `?provider=${encodeURIComponent(normalizedProvider)}` : '';
    return requestPluginControl<PluginModelCatalogResponse>(normalizedPluginName, `/models${query}`, 'GET');
  },

  getModelMappingCatalogStatus: (filters: { provider?: string; search?: string; page?: number } = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (filters.provider) params.set('provider', filters.provider);
    if (filters.search) params.set('search', filters.search);
    if (filters.page !== undefined) params.set('page', String(filters.page));
    const query = params.size ? `?${params}` : '';
    return requestPluginControl<ModelMappingCatalogStatus>('model-mapping', `/catalog${query}`, 'GET', undefined, signal);
  },
  refreshModelMappingCatalog: async (signal?: AbortSignal): Promise<void> => {
    type RefreshStatus = { refreshing: boolean; lastError: string | null; settings: { timeoutSeconds: number } };
    let status = await requestPluginControl<RefreshStatus>('models-dev', '/catalog/refresh', 'POST', undefined, signal);
    const deadline = Date.now() + ((status.settings?.timeoutSeconds ?? 120) + 10) * 1000;
    while (status.refreshing) {
      if (Date.now() >= deadline) throw new Error('Catalog refresh timed out');
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, 500);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
      status = await requestPluginControl<RefreshStatus>('models-dev', '/catalog/status', 'GET', undefined, signal);
    }
    if (status.lastError) throw new Error('Catalog refresh failed');
  },

  enable: (name: string, managementSetup?:unknown) => api.post<PluginToggleAccepted>(`/plugins/${encodeURIComponent(name)}/enable`, managementSetup?{managementSetup}:{}, {preserveSessionOnUnauthorized:true}),
  disable: (name: string) => api.post<PluginToggleAccepted>(`/plugins/${encodeURIComponent(name)}/disable`, {}, {preserveSessionOnUnauthorized:true}),
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
  options: { readonly timeoutMs?: number; readonly pollIntervalMs?: number; managementSetup?:unknown; onAccepted?:(operation:PluginToggleAccepted)=>void|Promise<void> } = {},
): Promise<'unchanged' | 'converged'> {
  const accepted = await (enabled ? PluginsAPI.enable(name,options.managementSetup) : PluginsAPI.disable(name));
  await options.onAccepted?.(accepted);
  if (accepted.unchanged === true) return 'unchanged';
  if (typeof accepted.operation_id !== 'string') {
    throw new Error(`Plugin activation for ${name} was not accepted as a configuration operation`);
  }
  await (inspectTerminal(accepted) ?? waitForConfigurationOperation(accepted.operation_id, options));
  return 'converged';
}
