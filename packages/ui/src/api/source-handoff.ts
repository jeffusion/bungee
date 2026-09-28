import type { EditorRoute, EditorService } from './config-adapters';
import type { Route } from './routes';
import { applySourceDraft, createSourceDraft, listSourceAccounts, listUpstreamSources } from './upstream-sources';

const keys = ['serviceId', 'sourcePlugin', 'sourceId', 'accountRef', 'mode'] as const;
export interface SourceHandoff { serviceId?: string; sourcePlugin: string; sourceId: string; accountRef: string; mode: 'new' | 'existing' }
const slug = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const routeKeys = ['routeId', 'sourcePlugin', 'sourceId', 'accountRef', 'mode'] as const;
export interface RouteSourceHandoff { routeId?: string; sourcePlugin: string; sourceId: string; accountRef: string; mode: 'new' | 'existing' }
export type RouteSourceHandoffErrorCode = 'invalid_handoff' | 'route_changed' | 'unsupported_target' | 'source_unavailable' | 'account_unavailable';

const routeSourceHandoffMessages: Record<RouteSourceHandoffErrorCode, string> = {
  invalid_handoff: 'Route source handoff is invalid.',
  route_changed: 'The route changed; reopen it before continuing.',
  unsupported_target: 'This route cannot accept a custom endpoint.',
  source_unavailable: 'The upstream source is unavailable.',
  account_unavailable: 'The account is unavailable.',
};

export class RouteSourceHandoffError extends Error {
  readonly name = 'RouteSourceHandoffError';
  constructor(readonly code: RouteSourceHandoffErrorCode) {
    super(routeSourceHandoffMessages[code]);
  }
}

function validAccountRef(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function validRouteSourceHandoff(handoff: RouteSourceHandoff): boolean {
  return slug.test(handoff.sourcePlugin) && slug.test(handoff.sourceId) && validAccountRef(handoff.accountRef)
    && (handoff.mode === 'new' ? handoff.routeId === undefined : handoff.mode === 'existing' && uuid.test(handoff.routeId ?? ''));
}

/** Consume before doing any asynchronous work. Reject the entire handoff on extra payloads. */
export function consumeSourceHandoff(query: string): { handoff: SourceHandoff | null; error: string; query: string } {
  const params = new URLSearchParams(query);
  if (!['sourcePlugin', 'sourceId', 'accountRef', 'mode'].some(key => params.has(key))) return { handoff: null, error: '', query };
  const values = Object.fromEntries(keys.map(key => [key, params.get(key)]));
  const allowed = new Set<string>([...keys, 'section']);
  const valid = query.length <= 1024 && [...params.keys()].every(key => allowed.has(key) && params.getAll(key).length === 1)
    && (!params.has('section') || params.get('section') === 'endpoints')
    && slug.test(values.sourcePlugin ?? '') && slug.test(values.sourceId ?? '')
    && typeof values.accountRef === 'string' && values.accountRef.length > 0 && values.accountRef.length <= 128
    && values.accountRef === values.accountRef.trim() && !/[\u0000-\u001f\u007f]/.test(values.accountRef)
    && (values.mode === 'new' ? values.serviceId === null : values.mode === 'existing' && uuid.test(values.serviceId ?? ''));
  return { handoff: valid ? { ...values, serviceId: values.serviceId ?? undefined } as SourceHandoff : null,
    error: valid ? '' : '账号交接参数无效，已拒绝。请从账号页面重新选择服务。', query: valid && params.has('section') ? 'section=endpoints' : '' };
}

export function sourceHandoffUrl(handoff: SourceHandoff, serviceName?: string) {
  const params = new URLSearchParams();
  for (const key of keys) if (handoff[key] !== undefined) params.set(key, handoff[key]!);
  return `/services/${handoff.mode === 'new' ? 'new' : `edit/${encodeURIComponent(serviceName!)}`}?${params}`;
}

/** Returns an unsaved replacement only; publication belongs to ServiceEditor.handleSave. */
export async function prepareSourceHandoff(service: EditorService, handoff: SourceHandoff, signal?: AbortSignal) {
  if ((handoff.mode === 'existing' && service._uid !== handoff.serviceId) || (handoff.mode === 'new' && service._uid)) {
    throw new Error('服务标识已变化，未修改当前草稿。请重新选择服务。');
  }
  const sources = (await listUpstreamSources()).filter(source => source.plugin.name === handoff.sourcePlugin && source.contribution.id === handoff.sourceId);
  if (sources.length !== 1 || !sources[0].plugin.enabled) throw new Error('上游来源不存在或插件未启用。');
  const source = sources[0];
  const accounts = (await listSourceAccounts(source, signal)).filter(account => account.id === handoff.accountRef);
  if (accounts.length !== 1 || !accounts[0].available) throw new Error('账号不存在或当前不可用。请返回账号页面刷新。');
  const existing = service.endpoints.findIndex(endpoint => endpoint.managedBy?.plugin === handoff.sourcePlugin
    && endpoint.managedBy.contributionId === handoff.sourceId
    && endpoint.plugins?.some(binding => typeof binding !== 'string' && binding._uid === endpoint.managedBy?.bindingId
      && binding.name === handoff.sourcePlugin && binding.options?.accountRef === handoff.accountRef));
  if (existing >= 0) return { service, index: existing, duplicate: true };
  const draft = await createSourceDraft(source, handoff.accountRef, signal);
  const first = service.endpoints[0];
  const reuse = handoff.mode === 'new' && service.endpoints.length === 1 && !first.target && !first.managedBy && !first.plugins?.length;
  const endpoint = applySourceDraft(reuse ? first : { target: '', weight: 100, priority: 1 }, source, draft);
  const endpoints = reuse ? [endpoint] : [...service.endpoints, endpoint];
  return { service: { ...service, endpoints }, index: endpoints.length - 1, duplicate: false };
}

/** Consume a route handoff; unknown or repeated parameters invalidate it as a whole. */
export function consumeRouteSourceHandoff(query: string): { handoff: RouteSourceHandoff | null; error: string; query: string } {
  const params = new URLSearchParams(query);
  if (!routeKeys.some(key => params.has(key))) return { handoff: null, error: '', query };
  const values = Object.fromEntries(routeKeys.map(key => [key, params.get(key)]));
  const allowed = new Set<string>([...routeKeys, 'section']);
  const valid = query.length <= 1024 && [...params.keys()].every(key => allowed.has(key) && params.getAll(key).length === 1)
    && (!params.has('section') || params.get('section') === 'target')
    && slug.test(values.sourcePlugin ?? '') && slug.test(values.sourceId ?? '')
    && validAccountRef(values.accountRef)
    && (values.mode === 'new' ? values.routeId === null : values.mode === 'existing' && uuid.test(values.routeId ?? ''));
  const handoff = valid ? { ...values, routeId: values.routeId ?? undefined } as RouteSourceHandoff : null;
  return {
    handoff,
    error: valid ? '' : 'invalid_handoff',
    query: valid && params.has('section') ? 'section=target' : '',
  };
}

export function routeSourceHandoffUrl(handoff: RouteSourceHandoff, routePath?: string): string {
  if (!validRouteSourceHandoff(handoff)) throw new RouteSourceHandoffError('invalid_handoff');
  const params = new URLSearchParams();
  for (const key of routeKeys) if (handoff[key] !== undefined) params.set(key, handoff[key]!);
  const path = handoff.mode === 'new' ? '/routes/new' : `/routes/edit/${encodeURIComponent(routePath ?? '')}`;
  return `${path}?${params}`;
}

/** Produces an unsaved route draft only; persistence remains the editor's responsibility. */
export async function prepareRouteSourceHandoff(
  route: Route | EditorRoute,
  handoff: RouteSourceHandoff,
  signal?: AbortSignal,
) {
  if (!validRouteSourceHandoff(handoff)) throw new RouteSourceHandoffError('invalid_handoff');
  if ((handoff.mode === 'existing' && route._uid !== handoff.routeId)
    || (handoff.mode === 'new' && route._uid)) {
    throw new RouteSourceHandoffError('route_changed');
  }
  if (route.service !== undefined || route._serviceId !== undefined || route.direct_response?.enabled || route.redirect?.enabled) {
    throw new RouteSourceHandoffError('unsupported_target');
  }
  let availableSources: Awaited<ReturnType<typeof listUpstreamSources>>;
  try {
    availableSources = await listUpstreamSources();
  } catch {
    throw new RouteSourceHandoffError('source_unavailable');
  }
  const sources = availableSources.filter(source => source.plugin.name === handoff.sourcePlugin && source.contribution.id === handoff.sourceId);
  if (sources.length !== 1 || !sources[0].plugin.enabled) throw new RouteSourceHandoffError('source_unavailable');
  const source = sources[0];
  let availableAccounts: Awaited<ReturnType<typeof listSourceAccounts>>;
  try {
    availableAccounts = await listSourceAccounts(source, signal);
  } catch {
    throw new RouteSourceHandoffError('account_unavailable');
  }
  const accounts = availableAccounts.filter(account => account.id === handoff.accountRef);
  if (accounts.length !== 1 || !accounts[0].available) throw new RouteSourceHandoffError('account_unavailable');

  const endpoints = route.endpoints ?? [];
  const existing = endpoints.findIndex(endpoint => endpoint.managedBy?.plugin === handoff.sourcePlugin
    && endpoint.managedBy.contributionId === handoff.sourceId
    && endpoint.plugins?.some(binding => typeof binding !== 'string' && binding._uid === endpoint.managedBy?.bindingId
      && binding.name === handoff.sourcePlugin && binding.options?.accountRef === handoff.accountRef));
  if (existing >= 0) return { route: route as EditorRoute, index: existing, duplicate: true };

  let draft: Awaited<ReturnType<typeof createSourceDraft>>;
  try {
    draft = await createSourceDraft(source, handoff.accountRef, signal);
  } catch {
    throw new RouteSourceHandoffError('source_unavailable');
  }
  const first = endpoints[0];
  const reuse = handoff.mode === 'new' && endpoints.length === 1 && !first.target && !first.managedBy && !first.plugins?.length;
  const endpoint = applySourceDraft(reuse ? first : { target: '', weight: 100, priority: 1 }, source, draft);
  const nextEndpoints = reuse ? [endpoint] : [...endpoints, endpoint];
  return { route: { ...route, endpoints: nextEndpoints }, index: nextEndpoints.length - 1, duplicate: false };
}
