<script lang="ts">
  import { onMount } from 'svelte';
  import { isLoading, _, locale } from 'svelte-i18n';
  import { getPluginText } from '$utils/plugin-i18n';
  import { requestPluginControl, ApiError } from '$api/client';
  import { getConfigSnapshot } from '$api/config';
  import { PluginsAPI } from '$api/plugins';
  import { keysApi, type ApiKey } from '$api/keys';
  import { PanelCard, IndustrialDialog, LoadingIndicator, StatusBadge, SegmentedControl, BSwitch } from '$components/industrial';
  import { keyStatus, modelPatterns, latestRequest } from '$components/domain/credentials/policy-state';
  import { createdCredential, publicationMessage } from './key-flow';
  let { pluginName = 'key-access' }: {pluginName?:string;apiBase?:string} = $props();
  let tab = $state('keys'), keys = $state<ApiKey[]>([]), routes = $state<{id:string;path:string}[]>([]), protectedIds = $state<string[]>([]);
  let loading = $state(true), busy = $state(false), error = $state<Message | null>(null), status = $state<Message | null>(null), ready = $state(false), inactive = $state(false);
  let createOpen = $state(false), policyOpen = $state(false), secretOpen = $state(false), deleteOpen = $state(false);
  let target = $state<ApiKey | null>(null), name = $state(''), expires = $state(''), allRoutes = $state(false), allowed = $state<string[]>([]), models = $state('');
  let secret = $state(''), copied = $state(false), secretStatus = $state<Message | null>(null), policyLoading = $state(false), policyReady = $state(false);
  let routeConfigOpen = $state(false), selectedRoute = $state<{id:string;path:string}|null>(null);
  let routeKeyBindings = $state<Record<string,{id:string;name:string}[]>>({});
  let unrestrictedKeyIds = $state<string[]>([]);
  const isKeyApplied = (routeId:string, keyId:string) => unrestrictedKeyIds.includes(keyId) || !!routeKeyBindings[routeId]?.some(key => key.id === keyId);
  type Message = { key: string; values?: Record<string, string | number | string[] | Message>; append?: Message };
  const message = (key: string, values?: Message['values']): Message => ({ key, values });
  const t = (key: string, values?: Record<string, string | number>) => $isLoading ? '' : getPluginText(key, pluginName, (id, options) => $_(id, { ...options, values }));
  function displayMessage(value: Message | null): string {
    if (!value) return '';
    const values = Object.fromEntries(Object.entries(value.values ?? {}).map(([key, item]) => [key, Array.isArray(item) ? new Intl.ListFormat($locale ?? undefined).format(item) : typeof item === 'object' ? displayMessage(item) : item]));
    return [t(value.key, values), value.append ? displayMessage(value.append) : ''].filter(Boolean).join(' ');
  }
  class LocalizedError extends Error {
    readonly content: Message;
    constructor(content: Message) { super(content.key); this.content = content; }
  }
  const keyStatusText = (key: ApiKey) => t(keyStatus(key) === '有效' ? 'ui.keyActive' : keyStatus(key) === '已过期' ? 'ui.keyExpired' : 'ui.keyRevoked');
  function errorMessage(e: unknown): Message {
    if (e instanceof LocalizedError) return e.content;
    if (e instanceof ApiError && (e.body as any)?.error === 'key_name_exists') return message('ui.keyNameExists');
    if (e instanceof ApiError && (e.body as any)?.persisted) return message('ui.persistedPending');
    if (e instanceof ApiError) {
      const code = (e.body as any)?.error;
      const known: Record<string, string> = {
        invalid_key_name: 'ui.invalidName', invalid_expiration: 'ui.expirationFuture', key_not_found: 'ui.keyNotFound',
        invalid_references: 'ui.invalidReferences', invalid_routes: 'ui.invalidRoutes', invalid_binding: 'ui.invalidBinding',
        reference_validator_unavailable: 'ui.validationUnavailable', key_secret_unavailable: 'ui.secretFailed',
        'key-access.inactive': 'ui.inactive', 'key-access.invalid_write': 'ui.invalidWrite',
      };
      return known[code] ? message(known[code]) : message('ui.requestFailed', { status: e.status });
    }
    return message('ui.operationFailed');
  }
  const guard = latestRequest();
  const control = <T,>(path:string,method:'GET'|'PUT',body?:unknown) => requestPluginControl<T>(pluginName,path,method,body);
  function failure(e:unknown) { if (e instanceof ApiError && (e.body as any)?.ready === false) ready = false; error = errorMessage(e); }
  async function refresh() {
    loading = true; error = null;
    try {
      const [credentials, config, plugins] = await Promise.all([keysApi.list(),getConfigSnapshot(),PluginsAPI.list()]);
      keys = credentials.keys; routes = config.config.logical_configuration.routes.map(route => ({id:route.id,path:route.path}));
      inactive = !plugins.find(plugin => plugin.name === pluginName)?.enabled;
      if (inactive) { ready = false; status = message('ui.inactive'); return; }
      const protection = await control<{protectedRouteIds:string[];routeKeyBindings:Record<string,{id:string;name:string}[]>;unrestrictedKeyIds?:string[];ready?:boolean}>('/routes','GET');
      protectedIds = protection.protectedRouteIds; routeKeyBindings = protection.routeKeyBindings; unrestrictedKeyIds = protection.unrestrictedKeyIds ?? []; ready = protection.ready !== false;
      status = ready ? null : message('ui.configurationPending');
    } catch(e) { ready = false; failure(e); } finally { loading = false; }
  }
  onMount(() => { void refresh(); return () => guard.invalidate(); });
  function newKey(routeId?:string) { if (secretOpen) return; name = ''; expires = ''; allRoutes = false; allowed = routeId ? [routeId] : []; models = ''; error = null; createOpen = true; }
  async function edit(key:ApiKey) {
    target = key; name = key.name; expires = localDate(key.expiresAt); copied = false; policyOpen = true; policyLoading = true; policyReady = false; error = null;
    const generation = guard.begin();
    try {
      const result = await control<{value:{routes:string[]|null;models:string[]|null}|null}>(`/keys/${encodeURIComponent(key.id)}`,'GET');
      if (!guard.current(generation)) return;
      allRoutes = result.value?.routes == null; allowed = result.value?.routes ?? []; models = result.value?.models?.join('\n') ?? ''; policyReady = true;
    } catch(e) { if (guard.current(generation)) failure(e); } finally { if (guard.current(generation)) policyLoading = false; }
  }
  async function applyRouteKey(key:ApiKey) {
    if (busy || !selectedRoute) return;
    busy = true; error = null;
    try {
      const result = await control<{protectedRouteIds:string[];routeKeyBindings:Record<string,{id:string;name:string}[]>;unrestrictedKeyIds?:string[];ready?:boolean;published?:boolean}>('/route-key','PUT',{routeId:selectedRoute.id,keyId:key.id});
      protectedIds = result.protectedRouteIds; routeKeyBindings = result.routeKeyBindings; unrestrictedKeyIds = result.unrestrictedKeyIds ?? []; ready = result.ready !== false;
      status = message(publicationMessage(result)); routeConfigOpen = false;
    } catch(e) { failure(e); } finally { busy = false; }
  }
  function toggleRoute(id:string,checked:boolean) { allowed = checked ? [...allowed,id] : allowed.filter(value => value !== id); }
  function localDate(value:number|null) { return value === null ? '' : new Date(value - new Date(value).getTimezoneOffset()*60000).toISOString().slice(0,16); }
  function expiration() {
    const value = policyOpen && target && expires === localDate(target.expiresAt) ? target.expiresAt : expires ? new Date(expires).getTime() : null;
    if (value !== null && (!Number.isFinite(value) || (value <= Date.now() && value !== target?.expiresAt))) throw new LocalizedError(message('ui.expirationFuture'));
    return value;
  }
  async function revealKey(key:ApiKey) {
    if (busy) return;
    const generation = guard.begin(); target = key; secret = ''; secretStatus = null; copied = false; secretOpen = true; busy = true;
    try { const result = await keysApi.reveal(key.id); if (guard.current(generation) && secretOpen) secret = result.token; }
    catch(e) { if (guard.current(generation)) secretStatus = e instanceof ApiError && (e.body as any)?.error === 'key_secret_not_stored' ? message('ui.legacySecret') : message('ui.secretFailed'); }
    finally { busy = false; }
  }
  async function savePolicy(id:string, includeDetails=false) {
    if (!allRoutes && allowed.some(id => !routes.some(route => route.id === id))) throw new LocalizedError(message('ui.deletedRouteError'));
    const scope = {routes:allRoutes ? null : allowed,models:modelPatterns(models)};
    const result = includeDetails ? await keysApi.update(id,{name,expiresAt:expiration(),...scope}) : await control<{ready?:boolean;published?:boolean}>(`/keys/${encodeURIComponent(id)}`,'PUT',scope);
    if ('key' in result) { const key = result.key as ApiKey; keys = keys.map(item => item.id === id ? key : item); target = key; }
    if (result.ready === false || result.published === false) throw new LocalizedError(message('ui.keyRoutesPending'));
    const protection = await control<{protectedRouteIds:string[];routeKeyBindings:Record<string,{id:string;name:string}[]>;unrestrictedKeyIds?:string[]}>('/routes','GET');
    protectedIds = protection.protectedRouteIds; routeKeyBindings = protection.routeKeyBindings; unrestrictedKeyIds = protection.unrestrictedKeyIds ?? [];
  }
  async function create(event:SubmitEvent) {
    event.preventDefault(); if (busy) return;
    const expiresAt = expires ? new Date(expires).getTime() : null;
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) { error = message('ui.expirationFuture'); return; }
    busy = true; error = null; status = null; secretStatus = null;
    let stage = 'ui.stageCreate';
    try {
      let created;
      try { created = await keysApi.create({name,expiresAt}); }
      catch(e) { created = createdCredential(e); if (!created) throw e; }
      // Keep the newly created credential before any subsequent request can fail.
      secret = created.token; copied = false; secretOpen = true; createOpen = false;
      keys = [...keys.filter(key => key.id !== created.key.id),created.key];
      if (created.ready === false || created.published === false) { ready = false; secretStatus = message('ui.createdPending'); return; }
      stage = 'ui.stageSavePolicy';
      await savePolicy(created.key.id);
      secretStatus = message('ui.createdPublic');
      status = secretStatus;
    } catch(e) { failure(e); if (secret) secretStatus = message('ui.createdIncomplete', { stage: message(stage), reason: error ?? message('ui.operationFailed') }); }
    finally { busy = false; }
  }
  async function update(event:SubmitEvent) {
    event.preventDefault(); if (busy || policyLoading || !policyReady || !target) return;
    try { expiration(); } catch(e) { failure(e); return; }
    busy = true; error = null; status = null;
    try { await savePolicy(target.id,true); policyOpen = false; status = message('ui.policyPublished'); }
    catch(e) { failure(e); } finally { busy = false; }
  }
  async function protect(id:string,checked:boolean) {
    if (busy) return;
    busy = true; error = null; status = null;
    try { const result = await control<{protectedRouteIds:string[];routeKeyBindings:Record<string,{id:string;name:string}[]>;unrestrictedKeyIds?:string[];ready?:boolean;published?:boolean}>('/routes','PUT',{protectedRouteIds:checked ? [...new Set([...protectedIds,id])] : protectedIds.filter(value => value !== id)}); protectedIds = result.protectedRouteIds; routeKeyBindings = result.routeKeyBindings; unrestrictedKeyIds = result.unrestrictedKeyIds ?? []; status = message(publicationMessage(result)); ready = result.ready !== false; }
    catch(e) { await refresh(); failure(e); } finally { busy = false; }
  }
  async function removeKey() {
    if (busy || !target) return; busy = true; error = null; status = null;
    try { const result = await keysApi.remove(target.id); status = message(publicationMessage(result)); deleteOpen = false; await refresh(); }
    catch(e) { failure(e); } finally { busy = false; }
  }
  async function copySecret(value=secret) { try { await navigator.clipboard.writeText(value); copied = true; } catch { secretStatus = secretStatus ? { ...secretStatus, append: message('ui.clipboardUnavailable') } : message('ui.clipboardUnavailable'); } }
</script>
<div class="space-y-4" data-testid="access-control-settings">
  <div class="flex flex-wrap items-center justify-between gap-3"><SegmentedControl options={[{value:'keys',label:t('ui.keys')},{value:'routes',label:t('ui.routeAccess')}]} bind:value={tab} onchange={() => void refresh()} ariaLabel={t('ui.settings')} /><button class="nx-btn-ghost nx-btn-md" disabled={busy || loading} onclick={refresh}>{t('ui.refresh')}</button></div>
  {#if !ready && !inactive}<p role="alert" class="text-sm text-amber-400">{t('ui.notReady')}</p>{/if}
  {#if status}<p role="status" class="text-sm text-zinc-300">{displayMessage(status)}</p>{/if}
  {#if error && !createOpen && !policyOpen && !deleteOpen && !routeConfigOpen}<p role="alert" class="text-sm text-red-400">{displayMessage(error)}</p>{/if}
  {#if tab === 'keys'}
    <PanelCard title={t('ui.keys')} tag={t('ui.keyCount', { count: keys.length })}>
      <div class="flex flex-wrap justify-between items-center gap-3 mb-4"><p class="text-sm text-zinc-400">{t('ui.keyHelp')}</p><button class="nx-btn-primary" disabled={busy || loading || !ready || secretOpen} onclick={() => newKey()}>{t('ui.createKey')}</button></div>
      {#if loading}<LoadingIndicator label={t('ui.loadingKeys')} height="sm" />{:else if !keys.length}<p class="text-sm text-zinc-400">{t('ui.noKeys')}</p>{:else}<div class="overflow-x-auto"><table class="w-full text-left text-sm"><thead class="text-zinc-400"><tr><th class="px-2 py-3">{t('ui.name')}</th><th class="px-2 py-3">{t('ui.prefix')}</th><th class="px-2 py-3">{t('ui.validity')}</th><th class="px-2 py-3">{t('ui.status')}</th><th class="px-2 py-3">{t('ui.actions')}</th></tr></thead><tbody>{#each keys as key (key.id)}<tr class="border-t border-carbon-600"><td class="px-2 py-3">{key.name}</td><td class="px-2 py-3 font-mono">{key.prefix}…</td><td class="px-2 py-3">{key.expiresAt == null ? t('ui.noExpiration') : new Date(key.expiresAt).toLocaleString($locale ?? undefined)}</td><td class="px-2 py-3"><StatusBadge variant={keyStatus(key) === '有效' ? 'active' : 'muted'}>{keyStatusText(key)}</StatusBadge></td><td class="px-2 py-3"><div class="flex gap-2"><button class="nx-btn-ghost nx-btn-sm" disabled={busy || inactive} onclick={() => revealKey(key)}>{t('ui.view')}</button><button class="nx-btn-ghost nx-btn-sm" disabled={busy || !ready || key.revokedAt !== null} onclick={() => edit(key)}>{t('ui.edit')}</button><button class="nx-btn-danger nx-btn-sm" disabled={busy || !ready} onclick={() => { target = key; error = null; deleteOpen = true; }}>{t('ui.delete')}</button></div></td></tr>{/each}</tbody></table></div>{/if}
    </PanelCard>
  {:else}
    <PanelCard title={t('ui.routeAccess')} tag={t('ui.routeCount', { count: routes.length })}>
      <p class="text-sm text-zinc-400 mb-4">{t('ui.routeHelp')}</p>
      {#if loading}<LoadingIndicator label={t('ui.loadingRoutes')} height="sm" />{:else if !routes.length}<p class="text-sm text-zinc-400">{t('ui.noRoutes')}</p>{:else}<div class="overflow-x-auto"><table class="w-full text-left text-sm"><thead class="text-zinc-400"><tr><th class="px-2 py-3">{t('ui.route')}</th><th class="px-2 py-3">{t('ui.public')}</th><th class="px-2 py-3">{t('ui.actions')}</th></tr></thead><tbody>{#each routes as route (route.id)}<tr class="border-t border-carbon-600"><td class="px-2 py-3 font-mono">{route.path}</td><td class="px-2 py-3"><BSwitch checked={!protectedIds.includes(route.id)} description={t('ui.isRoutePublic', { path: route.path })} disabled={busy || loading || !ready} onchange={isPublic => protect(route.id,!isPublic)} />
      </td><td class="px-2 py-3"><button class="nx-btn-ghost nx-btn-sm" disabled={busy || loading || !ready || secretOpen} onclick={() => { selectedRoute = route; error = null; routeConfigOpen = true; }}>{t('ui.configureKey')}</button></td></tr>{/each}</tbody></table></div>{/if}
    </PanelCard>
  {/if}
</div>
{#snippet basicFields()}
<fieldset class="space-y-3"><legend class="nx-field-label">{t('ui.basicInfo')}</legend><div class="grid grid-cols-1 sm:grid-cols-2 gap-4"><label class="block space-y-2"><span class="nx-field-label">{t('ui.name')}</span><input class="nx-input w-full" placeholder={t('ui.namePlaceholder')} bind:value={name} maxlength="128" required disabled={busy} /></label><label class="block space-y-2"><span class="nx-field-label">{t('ui.expiration')}</span><input class="nx-input w-full min-w-0" type="datetime-local" bind:value={expires} disabled={busy} /></label></div></fieldset>
{/snippet}
{#snippet routeFields()}
  <fieldset class="space-y-3 border-t border-carbon-600 pt-4">
    <legend class="nx-field-label">{t('ui.allowedRoutes')}</legend>
    <div class="flex flex-wrap items-center justify-between gap-2"><p class="text-sm text-zinc-400">{t('ui.allowedRoutesHelp')}</p><BSwitch label={t('ui.allRoutes')} bind:checked={allRoutes} disabled={busy || policyLoading} /></div>
    {#if allRoutes}<p class="text-sm text-zinc-400">{t('ui.allRoutesHelp')}</p>{/if}
    {#if !allRoutes}<div class="max-h-52 overflow-y-auto border border-carbon-600 divide-y divide-carbon-600">
      {#each routes as route (route.id)}
        <label class="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3 py-2 hover:bg-carbon-700">
          <span class="flex min-w-0 items-center gap-3"><input type="checkbox" class="accent-nexus-500" checked={allRoutes || allowed.includes(route.id)} disabled={busy || policyLoading || allRoutes} onchange={event => toggleRoute(route.id,event.currentTarget.checked)} /><span class="font-mono text-sm text-zinc-200 break-all">{route.path}</span></span>
          <StatusBadge variant={protectedIds.includes(route.id) ? 'active' : 'muted'}>{protectedIds.includes(route.id) ? t('ui.requiresKey') : t('ui.publicRoute')}</StatusBadge>
        </label>
      {:else}<p class="p-3 text-sm text-zinc-400">{t('ui.createRoutesFirst')}</p>{/each}
      {#each allowed.filter(id => !routes.some(route => route.id === id)) as id}<label class="flex gap-2 p-3 text-sm text-amber-400"><input type="checkbox" checked disabled={busy} onchange={() => allowed = allowed.filter(value => value !== id)} />{t('ui.deletedRoute', { id })}</label>{/each}
    </div>{/if}
    {#if !allRoutes && !allowed.length}<p class="text-sm text-zinc-400">{t('ui.noRoutesSelected')}</p>{/if}
  </fieldset>
  <fieldset class="space-y-2 border-t border-carbon-600 pt-4">
    <legend class="nx-field-label">{t('ui.modelScopeOptional')}</legend>
    <label class="block space-y-2"><span class="text-sm text-zinc-400">{t('ui.allowedModels')}</span><textarea class="nx-input w-full min-h-20 font-mono" rows="3" placeholder="gpt-*&#10;gemini-*" bind:value={models} disabled={busy || policyLoading}></textarea></label>
    <p class="text-sm text-zinc-400">{t('ui.modelsHelp')}</p>
  </fieldset>
{/snippet}
<IndustrialDialog bind:open={createOpen} title={t('ui.createKey')} description={t('ui.createHelp')} width="48rem" {busy} scrollBody>
  {#snippet body()}
    <form id="create-api-key" class="space-y-5" onsubmit={create}>
      {@render basicFields()}
      {@render routeFields()}
      {#if error}<p role="alert" class="text-sm text-red-400">{displayMessage(error)}</p>{/if}
    </form>
  {/snippet}
  {#snippet footer()}<button class="nx-btn-ghost" disabled={busy} onclick={() => { createOpen = false; }}>{t('ui.cancel')}</button><button class="nx-btn-primary" form="create-api-key" disabled={busy}>{busy ? t('ui.saving') : t('ui.save')}</button>{/snippet}
</IndustrialDialog>
<IndustrialDialog bind:open={policyOpen} title={t('ui.editKey', { name: target?.name ?? '' })} description={t('ui.editHelp')} width="48rem" {busy} scrollBody onOpenChange={open => { if (!open) { guard.invalidate(); } }}>
  {#snippet body()}{#if policyLoading}<LoadingIndicator label={t('ui.loadingPolicy')} height="sm" />{:else}<form id="key-route-policy" class="space-y-5" onsubmit={update}>{@render basicFields()}
      {@render routeFields()}{#if error}<p role="alert" class="text-sm text-red-400">{displayMessage(error)}</p>{/if}</form>{/if}{/snippet}
  {#snippet footer()}<button class="nx-btn-ghost" disabled={busy} onclick={() => { policyOpen = false; guard.invalidate(); }}>{t('ui.cancel')}</button><button class="nx-btn-primary" form="key-route-policy" disabled={busy || policyLoading || !policyReady || !target || target.revokedAt !== null}>{busy ? t('ui.saving') : t('ui.save')}</button>{/snippet}
</IndustrialDialog>
<IndustrialDialog bind:open={secretOpen} title={t('ui.viewKey')} description={t('ui.viewHelp')} busy={busy} onOpenChange={open => { if (!open) { secret = ''; secretStatus = null; guard.invalidate(); } }}>
  {#snippet body()}{#if secret}<code class="block select-all break-all border border-carbon-600 bg-carbon-950 p-3 font-mono text-zinc-200">{secret}</code>{:else if busy}<LoadingIndicator label={t('ui.loadingKeys')} height="sm" />{/if}{#if secretStatus}<p role="status" class="text-sm text-zinc-300 mt-3">{displayMessage(secretStatus)}</p>{/if}{#if copied}<p class="text-sm text-emerald-400 mt-3">{t('ui.copied')}</p>{/if}{/snippet}
  {#snippet footer()}<button class="nx-btn-primary" disabled={busy || !secret} onclick={() => copySecret()}>{copied ? t('ui.copyAgain') : t('ui.copyPlaintext')}</button>{/snippet}
</IndustrialDialog>
<IndustrialDialog bind:open={deleteOpen} title={t('ui.deleteKey')} description={t('ui.deleteDescription', { name: target?.name ?? '' })} {busy}>
  {#snippet body()}<p class="text-sm text-zinc-300">{t('ui.deleteHelp')}</p>{#if error}<p role="alert" class="text-sm text-red-400 mt-3">{displayMessage(error)}</p>{/if}{/snippet}
  {#snippet footer()}<button class="nx-btn-danger" disabled={busy || !ready} onclick={removeKey}>{busy ? t('ui.deleting') : t('ui.confirmDelete')}</button>{/snippet}
</IndustrialDialog>

<IndustrialDialog bind:open={routeConfigOpen} title={t('ui.configureKey')} description={t('ui.configureDescription', { path: selectedRoute?.path ?? '' })} {busy} scrollBody>
  {#snippet body()}
    <div class="space-y-4">
      <button class="nx-btn-primary" disabled={busy} onclick={() => { routeConfigOpen = false; newKey(selectedRoute?.id); }}>{t('ui.newKey')}</button>
      <div class="space-y-2">
        <p class="nx-field-label">{t('ui.chooseExistingKey')}</p>
        <p class="text-sm text-zinc-400">{t('ui.applyHelp')}</p>
        <div class="divide-y divide-carbon-600">
          {#each keys.filter(key => key.revokedAt === null) as key (key.id)}
            <div class="flex items-center justify-between gap-3 py-3">
              <div class="min-w-0"><p class="text-sm text-zinc-200 break-all">{key.name}</p><p class="font-mono text-xs text-zinc-400">{key.prefix}… · {keyStatusText(key)}</p></div>
              <button class="nx-btn-ghost nx-btn-sm" disabled={busy || isKeyApplied(selectedRoute?.id ?? '',key.id)} onclick={() => void applyRouteKey(key)}>{isKeyApplied(selectedRoute?.id ?? '',key.id) ? t('ui.applied') : t('ui.apply')}</button>
            </div>
          {:else}<p class="py-3 text-sm text-zinc-400">{t('ui.noUsableKeys')}</p>{/each}
        </div>
      </div>
    </div>
    {#if error}<p role="alert" class="text-sm text-red-400 mt-3">{displayMessage(error)}</p>{/if}
  {/snippet}
  {#snippet footer()}<button class="nx-btn-ghost" disabled={busy} onclick={() => routeConfigOpen = false}>{t('ui.cancel')}</button>{/snippet}
</IndustrialDialog>
