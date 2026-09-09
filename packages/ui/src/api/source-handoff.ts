import type { EditorService } from './config-adapters';
import { applySourceDraft, createSourceDraft, listSourceAccounts, listUpstreamSources } from './upstream-sources';

const keys = ['serviceId', 'sourcePlugin', 'sourceId', 'accountRef', 'mode'] as const;
export interface SourceHandoff { serviceId?: string; sourcePlugin: string; sourceId: string; accountRef: string; mode: 'new' | 'existing' }
const slug = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
