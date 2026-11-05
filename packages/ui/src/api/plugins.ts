import type { PluginConfigConstraint, PluginRuntimeScope } from '@jeffusion/bungee-types';
import { get } from 'svelte/store';
import { api, requestPluginControl, type ApiRequestOptions } from './client';
import {
  ConfigurationSubmissionUnknownError, getConfigurationOperation, isDefinitiveConfigurationRejection,
  trustedConfigurationOperation, type ConfigurationOperationState,
} from './config';
import { configurationWrite } from '../stores/configuration-write';
import { v4 as uuidv4 } from 'uuid';

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
  runtimeScope?: PluginRuntimeScope;
  version?: string;
  description?: string;
  enabled: boolean;
  metadata?: PluginMetadata;
  management?: {loginComponent?:string;setupComponent?:string};
  dependencies?: Record<string,string>;
  dependents?: string[];
  ready?: boolean;
  blockedReason?: string;
  lifecycle?: string;
}

export interface PluginSchema {
  name: string;
  runtimeScope?: PluginRuntimeScope;
  version?: string;
  description?: string;
  metadata?: PluginMetadata;
  configSchema: any[];
  configConstraints?: readonly PluginConfigConstraint[];
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
  getManagementSetup: async (name: string): Promise<{initialized: boolean}> => {
    const status = await api.get<{initialized: boolean}>(`/plugins/${encodeURIComponent(name)}/management-setup`);
    if (typeof status?.initialized !== 'boolean') throw new Error('management_setup_unavailable');
    return status;
  },

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

  enable: (name: string, managementSetup?:unknown, mutationId?:string) => api.post<PluginToggleAccepted>(`/plugins/${encodeURIComponent(name)}/enable`,
    { ...(managementSetup?{managementSetup}:{}), ...(mutationId?{mutation_id:mutationId}:{}) }, {preserveSessionOnUnauthorized:true}),
  disable: (name: string, mutationId?:string) => api.post<PluginToggleAccepted>(`/plugins/${encodeURIComponent(name)}/disable`,
    { ...(mutationId?{mutation_id:mutationId}:{}) }, {preserveSessionOnUnauthorized:true}),
};

type PluginToggleAccepted = ConfigurationOperationState & {
  readonly unchanged?: boolean;
  readonly operation_id?: string;
};

/** A query by the original identity is the only acceptable proof of a lost toggle. */
async function reconcileToggle(mutationId: string, cause: unknown): Promise<PluginToggleAccepted> {
  try {
    const state = await getConfigurationOperation(mutationId);
    if (!trustedConfigurationOperation(state, mutationId)) throw new ConfigurationSubmissionUnknownError(mutationId, cause);
    return { ...state, operation_id: mutationId };
  } catch (error) {
    if (error instanceof ConfigurationSubmissionUnknownError) throw error;
    throw new ConfigurationSubmissionUnknownError(mutationId, cause);
  }
}

function trustedToggle(accepted: PluginToggleAccepted, mutationId: string): boolean {
  return accepted.operation_id === mutationId && trustedConfigurationOperation(accepted, mutationId);
}

/**
 * A durable configuration ACK ends the toggle. Publication continues in the
 * shared runtime view; an authentication handoff must still complete first.
 * Callers re-read the plugin list after this resolves.
 */
export async function setPluginEnabled(
  name: string,
  enabled: boolean,
  options: { managementSetup?:unknown; onAccepted?:(operation:PluginToggleAccepted)=>void|Promise<void> } = {},
): Promise<'unchanged' | 'committed'> {
  // A write with an unconfirmed result may have committed. Never dispatch a second
  // identity before the first is reconciled.
  const write = get(configurationWrite);
  if (write.corrupt || (write.pending !== null && !write.pending.accepted)) {
    throw new Error('configuration_write_unconfirmed');
  }
  const mutationId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : uuidv4();
  configurationWrite.markDispatched(mutationId);
  let accepted: PluginToggleAccepted;
  try {
    accepted = await (enabled
      ? PluginsAPI.enable(name, options.managementSetup, mutationId)
      : PluginsAPI.disable(name, mutationId));
  } catch (error) {
    // Only a structured rejection proves nothing was committed. result_unknown, malformed
    // responses and transport failures may have committed; reconcile by the original ID.
    if (isDefinitiveConfigurationRejection(error)) {
      configurationWrite.clear();
      throw error;
    }
    accepted = await reconcileToggle(mutationId, error);
  }
  if (accepted.unchanged === true) {
    configurationWrite.clear();
    await options.onAccepted?.(accepted);
    return 'unchanged';
  }
  // A 2xx with a foreign or malformed identity is not an ACK; keep the marker until proven.
  if (!trustedToggle(accepted, mutationId)) {
    accepted = await reconcileToggle(mutationId, new Error('untrusted_ack'));
  }
  if (accepted.operation.state === 'superseded') {
    // Saved, then replaced before it applied. This is a known terminal, not a failure to retry blindly.
    configurationWrite.clear();
    throw new Error('configuration_superseded');
  }
  configurationWrite.markAccepted(mutationId);
  await options.onAccepted?.(accepted);
  return 'committed';
}
