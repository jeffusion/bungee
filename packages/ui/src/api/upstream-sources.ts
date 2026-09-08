import { v4 as uuidv4 } from 'uuid';
import type { LogicalConfigurationV2, PluginConfigOptions } from '@jeffusion/bungee-types';
import { requestPluginControl } from './client';
import { PluginsAPI, type Plugin, type UpstreamSourceContribution } from './plugins';
import type { EditorUpstream } from './config-adapters';

export interface SourceAccount { readonly id: string; readonly label: string; readonly available: boolean; readonly reason?: string }
export interface UpstreamSource { readonly plugin: Plugin; readonly contribution: UpstreamSourceContribution }
export interface SourceDraft { readonly target: string; readonly bindingOptions: PluginConfigOptions }

export async function listUpstreamSources(): Promise<UpstreamSource[]> {
  return (await PluginsAPI.list()).flatMap(plugin =>
    (plugin.metadata?.contributes?.upstreamSources ?? []).map(contribution => ({ plugin, contribution })));
}

export function sourceEndpoint(source: UpstreamSource, action: 'listAccounts' | 'createDraft') {
  const method = action === 'listAccounts' ? 'GET' : 'POST';
  const matches = source.plugin.metadata?.contributes?.api?.filter(endpoint =>
    endpoint.handler === source.contribution[action] && endpoint.execution === 'control' && endpoint.methods.includes(method)) ?? [];
  if (matches.length !== 1) throw new Error('插件未提供唯一可用的账号接口声明');
  return { method, path: matches[0].path } as const;
}

export async function listSourceAccounts(source: UpstreamSource, signal?: AbortSignal): Promise<SourceAccount[]> {
  if (!source.plugin.enabled) throw new Error('插件未启用，原绑定已保留');
  const endpoint = sourceEndpoint(source, 'listAccounts');
  const response = await requestPluginControl<{ accounts: SourceAccount[] }>(source.plugin.name, endpoint.path, endpoint.method, undefined, signal);
  if (!Array.isArray(response.accounts) || response.accounts.some(account => !account || typeof account.id !== 'string'
    || typeof account.label !== 'string' || typeof account.available !== 'boolean')) throw new Error('插件账号响应无效');
  return response.accounts;
}

export async function createSourceDraft(source: UpstreamSource, accountRef: string, signal?: AbortSignal): Promise<SourceDraft> {
  if (!source.plugin.enabled) throw new Error('插件未启用');
  const endpoint = sourceEndpoint(source, 'createDraft');
  const draft = await requestPluginControl<SourceDraft>(source.plugin.name, endpoint.path, endpoint.method, { accountRef }, signal);
  const url = new URL(draft.target);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
    || !draft.bindingOptions || typeof draft.bindingOptions !== 'object' || Array.isArray(draft.bindingOptions)
    || draft.bindingOptions.accountRef !== accountRef) throw new Error('插件返回的上游草稿无效');
  return draft;
}

export function applySourceDraft(upstream: EditorUpstream, source: UpstreamSource, draft: SourceDraft): EditorUpstream {
  const bindingId = uuidv4();
  return {
    ...upstream, _uid: upstream._uid ?? uuidv4(), target: draft.target,
    managedBy: { plugin: source.plugin.name, contributionId: source.contribution.id, bindingId },
    plugins: [
      ...(upstream.plugins ?? []).filter(binding => typeof binding === 'string' || binding._uid !== upstream.managedBy?.bindingId),
      { _uid: bindingId, name: source.plugin.name, enabled: true, options: structuredClone(draft.bindingOptions) },
    ],
  };
}

/** Current configuration references, never a claim about live worker usage. */
export function accountReferences(logical: LogicalConfigurationV2, plugin: string, accountRef: string) {
  const bound = (plugins: LogicalConfigurationV2['plugins']) => plugins.some(binding => binding.name === plugin && binding.options?.accountRef === accountRef);
  const uses = (endpoints: LogicalConfigurationV2['services'][number]['endpoints']) => endpoints.some(endpoint =>
    bound(endpoint.plugins ?? []));
  const services = logical.services.filter(service => bound(service.plugins) || uses(service.endpoints));
  const ids = new Set(services.map(service => service.id));
  const routes = logical.routes.filter(route => bound(route.plugins) || (route.service_id ? ids.has(route.service_id) : uses(route.endpoints ?? [])));
  return { services: services.map(({ id, name }) => ({ id, name })), routes: routes.map(({ id, path }) => ({ id, path })), global: bound(logical.plugins), runtime: 'unknown' as const };
}
