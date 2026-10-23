import type {
  Endpoint,
  LogicalConfiguration,
  PluginBinding,
  PluginConfig,
  RouteConfig,
  ConfigurationRoute,
  Service as BaseService,
  ConfigurationService,
  ConfigurationUpstream,
} from '@jeffusion/bungee-types';
import { v4 as uuidv4 } from 'uuid';
import type { EditorRouteTimeouts } from '$utils/route-timeouts';

export type EditorPluginBinding = PluginConfig & {
  _uid?: string;
  _position?: number;
};

export type EditorUpstream = Omit<Endpoint, 'id' | 'plugins'> & {
  managedBy?: ConfigurationUpstream['managedBy'];
  _uid?: string;
  _position?: number;
  plugins?: Array<EditorPluginBinding | string>;
};

export type EditorService = Omit<BaseService, 'endpoints' | 'plugins' | 'timeouts'> & {
  _uid?: string;
  _position?: number;
  description?: string;
  endpoints: EditorUpstream[];
  plugins?: Array<EditorPluginBinding | string>;
};

export type EditorRoute = Omit<RouteConfig, 'endpoints' | 'plugins' | 'timeouts'> & {
  timeouts?: EditorRouteTimeouts;
  _uid?: string;
  _position?: number;
  endpoints?: EditorUpstream[];
  plugins?: Array<EditorPluginBinding | string>;
  transformer?: string | object;
};

function toEditorPlugin(binding: PluginBinding): EditorPluginBinding {
  return {
    _uid: binding.id,
    _position: binding.position,
    name: binding.name,
    ...(binding.options === undefined ? {} : { options: structuredClone(binding.options) }),
    enabled: binding.enabled,
  };
}

function toV2Plugins(
  plugins: readonly (EditorPluginBinding | string)[],
  previous: readonly PluginBinding[],
): readonly PluginBinding[] {
  const used = new Set<string>();
  let nextPosition = previous.reduce((maximum, binding) => Math.max(maximum, binding.position), -1) + 1;
  return plugins.map((plugin) => {
    const name = typeof plugin === 'string' ? plugin : plugin.name;
    const requestedId = typeof plugin === 'string' ? undefined : plugin._uid;
    const match = previous.find((binding) => !used.has(binding.id)
      && (binding.id === requestedId || (requestedId === undefined && binding.name === name)));
    if (match !== undefined) used.add(match.id);
    const options = typeof plugin === 'string' ? match?.options : (plugin.options ?? match?.options);
    return {
      id: match?.id ?? requestedId ?? uuidv4(),
      position: match?.position ?? nextPosition++,
      name,
      ...(options === undefined ? {} : { options }),
      enabled: typeof plugin === 'string' ? (match?.enabled ?? true) : (plugin.enabled ?? match?.enabled ?? true),
    };
  });
}

export function toEditorUpstream(upstream: ConfigurationUpstream): EditorUpstream {
  assertManagedBinding(upstream.managedBy, upstream.plugins);
  const { id, position, plugins, ...policy } = upstream;
  return {
    ...structuredClone(policy),
    _uid: id,
    _position: position,
    plugins: plugins.map(toEditorPlugin),
  };
}

export class ManagedBindingError extends Error {
  readonly name = 'ManagedBindingError';
  constructor() { super('插件管理绑定缺失或不匹配，无法保存。请恢复绑定后重试；目标不会转为手动 URL。'); }
}

function assertManagedBinding(
  managedBy: ConfigurationUpstream['managedBy'],
  plugins: readonly (PluginBinding | EditorPluginBinding | string)[] | undefined,
): void {
  if (managedBy === undefined) return;
  if (!managedBy || !managedBy.plugin || !managedBy.contributionId || !managedBy.bindingId
    || !Array.isArray(plugins)
    || plugins.filter(binding => typeof binding !== 'string'
      && ('id' in binding ? binding.id : binding._uid) === managedBy.bindingId
      && binding.name === managedBy.plugin).length !== 1) {
    throw new ManagedBindingError();
  }
}

export function hasInvalidManagedBinding(upstream: EditorUpstream): boolean {
  try { assertManagedBinding(upstream.managedBy, upstream.plugins); return false; }
  catch { return true; }
}

// Configuration is JSON; this also accepts Svelte's reactive proxy drafts.
export function cloneUpstreamDraft(upstream: EditorUpstream): EditorUpstream {
  return JSON.parse(JSON.stringify(upstream));
}

export function duplicateEditorUpstream(upstream: EditorUpstream): EditorUpstream {
  assertManagedBinding(upstream.managedBy, upstream.plugins);
  const copy = cloneUpstreamDraft(upstream);
  copy._uid = uuidv4();
  delete copy._position;
  copy.plugins = copy.plugins?.map(binding => {
    if (typeof binding === 'string') return binding;
    const id = uuidv4();
    if (copy.managedBy && copy.managedBy.bindingId === binding._uid) {
      copy.managedBy = { ...copy.managedBy, bindingId: id };
    }
    const { _position, ...policy } = binding;
    return { ...policy, _uid: id };
  });
  return copy;
}

export function duplicateEditorService(service: EditorService): EditorService {
  // Svelte list items can be reactive proxies; configuration is a JSON graph.
  const copy: EditorService = JSON.parse(JSON.stringify(service));
  delete copy._uid;
  delete copy._position;
  copy.endpoints = copy.endpoints.map(endpoint => ({ ...duplicateEditorUpstream(endpoint), _position: endpoint._position }));
  copy.service_references = copy.service_references?.map(reference => ({ ...reference, id: uuidv4() }));
  copy.plugins = copy.plugins?.map(binding => {
    if (typeof binding === 'string') return binding;
    const { _position, ...policy } = binding;
    return { ...policy, _uid: uuidv4() };
  });
  return copy;
}

function toV2Upstreams(
  upstreams: readonly EditorUpstream[],
  previous: readonly ConfigurationUpstream[],
  referencePositions: readonly number[] = [],
): readonly ConfigurationUpstream[] {
  const used = new Set<string>();
  let nextPosition = Math.max(-1, ...previous.map(upstream => upstream.position), ...referencePositions) + 1;
  return upstreams.map((upstream) => {
    const match = previous.find((candidate) => !used.has(candidate.id)
      && (candidate.id === upstream._uid || (upstream._uid === undefined && candidate.target === upstream.target)));
    if (match !== undefined) used.add(match.id);
    if (match?.managedBy && !upstream.managedBy) throw new ManagedBindingError();
    assertManagedBinding(upstream.managedBy, upstream.plugins);
    const {
      _uid, _position, plugins = [], condition, ...policy
    } = upstream;
    return {
      ...policy,
      // A cleared optional condition means unconditional, not an empty expression.
      ...(condition === undefined || condition.trim() === '' ? {} : { condition }),
      id: match?.id ?? _uid ?? uuidv4(),
      position: _position ?? match?.position ?? nextPosition++,
      weight: upstream.weight ?? match?.weight ?? 100,
      priority: upstream.priority ?? match?.priority ?? 1,
      is_disabled: upstream.is_disabled ?? match?.is_disabled ?? false,
      plugins: toV2Plugins(plugins, match?.plugins ?? []),
    };
  });
}

export function toEditorService(service: ConfigurationService): EditorService {
  const { id, position, endpoints, plugins, service_references, timeouts: _removedTimeouts, ...policy } = service as ConfigurationService & { timeouts?: unknown };
  return {
    ...policy,
    _uid: id,
    _position: position,
    endpoints: endpoints.map(toEditorUpstream),
    ...(service_references?.length ? { service_references: service_references.map(reference => ({...reference})) } : {}),
    plugins: plugins.map(toEditorPlugin),
  };
}

export function toV2Service(
  service: EditorService,
  previous: ConfigurationService | undefined,
  position: number,
): ConfigurationService {
  const {
    _uid, _position, description, endpoints, service_references, plugins = [], timeouts: _removedTimeouts, ...policy
  } = service as EditorService & { timeouts?: unknown };
  return {
    ...policy,
    id: previous?.id ?? uuidv4(),
    position: previous?.position ?? position,
    endpoints: toV2Upstreams(endpoints, previous?.endpoints ?? [], service_references?.map(reference => reference.position)),
    ...(service_references?.length ? {service_references: service_references.map(reference => ({ ...reference }))} : {}),
    plugins: toV2Plugins(plugins, previous?.plugins ?? []),
  };
}

export function toEditorRoute(route: ConfigurationRoute, _services: readonly ConfigurationService[]): EditorRoute {
  const { id, position, plugins, endpoints, service_references, ...policy } = route;
  return {
    ...structuredClone(policy),
    _uid: id,
    _position: position,
    ...(service_references?.length ? { service_references: service_references.map(reference => ({...reference})) } : {}),
    ...(endpoints === undefined ? {} : { endpoints: endpoints.map(toEditorUpstream) }),
    plugins: plugins.map(toEditorPlugin),
  };
}

export function toV2Route(
  route: EditorRoute,
  _logical: LogicalConfiguration,
  previous: ConfigurationRoute | undefined,
  position: number,
): ConfigurationRoute {
  const {
    _uid, _position, service_references, endpoints = [], plugins = [], transformer, auth: _legacyAuth, ...policy
  } = route as EditorRoute & {auth?:unknown};
  const base = {
    ...policy,
    id: previous?.id ?? uuidv4(),
    position: previous?.position ?? position,
    plugins: toV2Plugins(plugins, previous?.plugins ?? []),
  };
  if (service_references?.length) {
    if (endpoints.length) throw new Error('服务引用与自定义端点不能同时保存');
    return { ...base, service_references: JSON.parse(JSON.stringify(service_references)) };
  }
  return { ...base, endpoints: toV2Upstreams(endpoints, previous?.endpoints ?? []) };
}
