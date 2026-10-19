<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { _, isLoading } from 'svelte-i18n';
  import { requestPluginControl } from '$api/client';
  import { IndustrialDialog, IndustrialToggle } from '$components/industrial';
  import { Button } from '$components/ui/button';
  import type { Connection, ConnectionInput, DiscoveryMetadata, LoginProvider, MicrosoftConfiguration, OidcConfiguration } from './contracts';

  let {open = $bindable(), pluginName, connection, connectionId, publicOrigin, busy, error, onsave}: {
    open: boolean; pluginName: string; connection: Connection | null; connectionId: string; publicOrigin?: string;
    busy: boolean; error: string; onsave: (input: ConnectionInput) => Promise<void>;
  } = $props();
  const id = $props.id();
  const t = (key: string) => $isLoading ? '' : $_(`plugins.user-auth.${key}`);
  const existing = untrack(() => connection);
  const initial = existing?.configuration;
  const custom = existing?.provider === 'oidc' ? initial as OidcConfiguration : undefined;
  const microsoft = existing?.provider === 'microsoft' ? initial as MicrosoftConfiguration : undefined;
  const providers: LoginProvider[] = ['google', 'microsoft', 'github', 'oidc'];
  const guides: Record<LoginProvider, string> = {
    google: 'https://console.cloud.google.com/auth/clients',
    microsoft: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    github: 'https://github.com/settings/applications/new',
    oidc: 'https://openid.net/developers/how-connect-works/',
  };
  let provider = $state<LoginProvider | ''>(existing?.provider ?? '');
  let label = $state(existing?.label ?? ''), enabled = $state(existing?.enabled ?? false);
  let clientId = $state(existing?.clientId ?? ''), clientSecret = $state('');
  let accountType = $state<MicrosoftConfiguration['accountType']>(microsoft?.accountType ?? 'tenant'), tenantId = $state(microsoft?.tenantId ?? '');
  let mode = $state<OidcConfiguration['mode']>(custom?.mode ?? 'issuer');
  let source = $state(custom?.mode === 'discovery' ? custom.discoveryUrl ?? '' : custom?.issuer ?? '');
  let manualIssuer = $state(custom?.issuer ?? ''), authorizationEndpoint = $state(custom?.authorizationEndpoint ?? '');
  let tokenEndpoint = $state(custom?.tokenEndpoint ?? ''), jwksUri = $state(custom?.jwksUri ?? '');
  let tokenEndpointAuthMethod = $state<'client_secret_basic' | 'client_secret_post'>(custom?.tokenEndpointAuthMethod ?? 'client_secret_basic');
  let idTokenSigningAlg = $state<'RS256' | 'PS256' | 'ES256'>(custom?.idTokenSigningAlg ?? 'RS256');
  let scopes = $state(existing?.scopes.join(' ') ?? 'openid profile email');
  let metadata = $state<DiscoveryMetadata | null>(null), metadataKey = $state(''), discovering = $state(false), discoveryError = $state(''), localError = $state(''), copied = $state(false);
  let activeRequest: AbortController | undefined, requestVersion = 0, destroyed = false;
  const callback = $derived(publicOrigin ? `${publicOrigin.replace(/\/$/, '')}/api/auth/login/callback/${encodeURIComponent(connectionId)}` : '');
  const currentKey = $derived(`${provider}:${mode}:${source.trim()}`);
  const metadataCurrent = $derived(metadata !== null && metadataKey === currentKey);
  const urlFields = $derived([manualIssuer, authorizationEndpoint, tokenEndpoint, jwksUri]);
  const configurationValid = $derived(provider === 'microsoft'
    ? accountType !== 'tenant' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId.trim())
    : provider !== 'oidc' || (mode === 'manual' ? urlFields.every(validUrl) : metadataCurrent));
  const canSave = $derived(!!provider && !!label.trim() && !!clientId.trim() && (!!clientSecret || !!existing?.hasSecret) && configurationValid && (provider !== 'oidc' || scopes.split(/\s+/).includes('openid')) && (!enabled || !!publicOrigin));

  function validUrl(value: string): boolean {
    try { const url = new URL(value); return !url.username && !url.password && !url.hash && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))); }
    catch { return false; }
  }
  function cancelDiscovery() { requestVersion++; activeRequest?.abort(); activeRequest = undefined; discovering = false; metadata = null; metadataKey = ''; discoveryError = ''; }
  function choose(value: LoginProvider) { if (existing || busy) return; cancelDiscovery(); provider = value; localError = ''; }
  function changeMode(value: string) { cancelDiscovery(); mode = value as OidcConfiguration['mode']; source = ''; localError = ''; }
  function invalidateSource() { cancelDiscovery(); localError = ''; }
  async function discover() {
    if (!open || provider !== 'oidc' || mode === 'manual' || busy) return;
    const url = source.trim();
    if (!validUrl(url)) { cancelDiscovery(); if (url) discoveryError = t('connections.invalidUrl'); return; }
    if (metadataCurrent || discovering) return;
    cancelDiscovery();
    const version = requestVersion, key = currentKey, controller = new AbortController(); activeRequest = controller; discovering = true;
    try {
      const result = await requestPluginControl<DiscoveryMetadata>(pluginName, '/login-connections/discover', 'POST', {mode, url}, controller.signal);
      if (destroyed || !open || controller.signal.aborted || version !== requestVersion || key !== currentKey) return;
      if (![result.issuer, result.authorizationEndpoint, result.tokenEndpoint, result.jwksUri, result.discoveryUrl].every(validUrl)) throw new Error('oidc_metadata_invalid');
      metadata = result; metadataKey = key;
    } catch { if (!destroyed && open && !controller.signal.aborted && version === requestVersion && key === currentKey) discoveryError = t('connections.discoveryFailed'); }
    finally { if (version === requestVersion) { discovering = false; activeRequest = undefined; } }
  }
  async function copyCallback() {
    try { await navigator.clipboard.writeText(callback); copied = true; }
    catch { localError = t('connections.copyFailed'); }
  }
  async function save(event: SubmitEvent) {
    event.preventDefault(); if (busy || !canSave || !provider) return;
    let configuration: Connection['configuration'] = {};
    if (provider === 'microsoft') configuration = {accountType, ...(accountType === 'tenant' ? {tenantId: tenantId.trim()} : {})};
    if (provider === 'oidc') {
      if (mode === 'manual') configuration = {mode, issuer: manualIssuer.trim(), authorizationEndpoint: authorizationEndpoint.trim(), tokenEndpoint: tokenEndpoint.trim(), jwksUri: jwksUri.trim(), tokenEndpointAuthMethod, idTokenSigningAlg};
      else if (metadataCurrent && metadata) configuration = mode === 'issuer' ? {mode, issuer: source.trim()} : {mode, issuer: metadata.issuer, discoveryUrl: source.trim()};
      else return;
    }
    await onsave({id: connectionId, label: label.trim(), enabled, provider, clientId: clientId.trim(), configuration,
      ...(existing ? {version: existing.version} : {}), ...(clientSecret ? {clientSecret} : {}), ...(provider === 'oidc' ? {scopes: scopes.split(/\s+/).filter(Boolean)} : {})});
  }
  onMount(() => { if (existing?.provider === 'oidc' && mode !== 'manual') void discover(); });
  onDestroy(() => { destroyed = true; cancelDiscovery(); clientSecret = ''; });
</script>

{#snippet body()}
  <form id={id + '-connection'} class="space-y-4" onsubmit={save} aria-label={t('connections.editor')}>
    <div class="space-y-2">
      <p class="nx-field-label" id={id + '-provider-label'}>{t('connections.provider')}</p>
      {#if existing}<p class="text-sm text-zinc-200">{t('providers.' + existing.provider)}</p><p class="text-sm text-zinc-400">{t('connections.providerFixed')}</p>
      {:else}<div class="grid grid-cols-2 gap-2" role="group" aria-labelledby={id + '-provider-label'}>{#each providers as value}<Button type="button" variant={provider === value ? 'default' : 'outline'} disabled={busy} aria-pressed={provider === value} onclick={() => choose(value)}>{t('providers.' + value)}</Button>{/each}</div>{/if}
    </div>
    <div class="space-y-2">
      <label class="grid gap-1"><span class="nx-field-label">{t('connections.callback')}</span><input class="nx-input font-mono" readonly value={callback} data-testid="login-callback" /></label>
      {#if callback}<Button type="button" variant="ghost" onclick={copyCallback}>{t(copied ? 'connections.copied' : 'connections.copy')}</Button>{:else}<p role="alert" class="text-sm text-red-400">{t('connections.missingOrigin')}</p>{/if}
    </div>
    {#if provider}
      <div class="space-y-1"><a class="text-sm text-nexus-300 underline" href={guides[provider]} target="_blank" rel="noreferrer">{t(provider === 'oidc' ? 'connections.oidcGuide' : 'connections.createApp')}</a><p class="text-sm text-zinc-400">{t('guides.' + provider)}</p></div>
      <label class="grid gap-1"><span class="nx-field-label">{t('connections.label')}</span><input class="nx-input" required bind:value={label} disabled={busy} /></label>
      {#if provider === 'microsoft'}
        <label class="grid gap-1"><span class="nx-field-label">{t('connections.accountType')}</span><select class="nx-input" bind:value={accountType} disabled={busy}>{#each ['tenant', 'organizations', 'consumers', 'common'] as value}<option value={value}>{t('accounts.' + value)}</option>{/each}</select></label>
        {#if accountType === 'tenant'}<label class="grid gap-1"><span class="nx-field-label">Tenant ID</span><input class="nx-input" required bind:value={tenantId} disabled={busy} placeholder="00000000-0000-0000-0000-000000000000" pattern={'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'} /></label>{/if}
      {/if}
      {#if provider === 'oidc'}
        <label class="grid gap-1"><span class="nx-field-label">{t('connections.mode')}</span><select class="nx-input" value={mode} onchange={event => changeMode(event.currentTarget.value)} disabled={busy}><option value="issuer">{t('connections.modeIssuer')}</option><option value="discovery">{t('connections.modeDiscovery')}</option><option value="manual">{t('connections.modeManual')}</option></select></label>
        {#if mode !== 'manual'}
          <label class="grid gap-1"><span class="nx-field-label">{t(mode === 'issuer' ? 'connections.issuer' : 'connections.discoveryUrl')}</span><input class="nx-input" required type="url" bind:value={source} oninput={invalidateSource} onblur={discover} disabled={busy} /></label>
          {#if discovering}<p class="text-sm text-zinc-400" role="status">{t('connections.discovering')}</p>{/if}
          {#if discoveryError}<p role="alert" class="text-sm text-red-400">{discoveryError}</p>{/if}
          {#if metadataCurrent && metadata}<dl class="space-y-2" data-testid="discovered-metadata">{#each [['connections.issuer', metadata.issuer], ['connections.authorizationEndpoint', metadata.authorizationEndpoint], ['connections.tokenEndpoint', metadata.tokenEndpoint], ['connections.jwksUri', metadata.jwksUri]] as [key, value]}<div><dt class="nx-field-label">{t(key)}</dt><dd class="break-all text-sm text-zinc-200">{value}</dd></div>{/each}</dl>{/if}
        {:else}
          <label class="grid gap-1"><span class="nx-field-label">{t('connections.issuer')}</span><input class="nx-input" required type="url" bind:value={manualIssuer} disabled={busy} /></label>
          <label class="grid gap-1"><span class="nx-field-label">{t('connections.authorizationEndpoint')}</span><input class="nx-input" required type="url" bind:value={authorizationEndpoint} disabled={busy} /></label>
          <label class="grid gap-1"><span class="nx-field-label">{t('connections.tokenEndpoint')}</span><input class="nx-input" required type="url" bind:value={tokenEndpoint} disabled={busy} /></label>
          <label class="grid gap-1"><span class="nx-field-label">{t('connections.jwksUri')}</span><input class="nx-input" required type="url" bind:value={jwksUri} disabled={busy} /></label>
          <label class="grid gap-1"><span class="nx-field-label">{t('connections.authMethod')}</span><select class="nx-input" bind:value={tokenEndpointAuthMethod} disabled={busy}><option value="client_secret_basic">HTTP Basic</option><option value="client_secret_post">POST</option></select></label>
          <label class="grid gap-1"><span class="nx-field-label">{t('connections.signingAlg')}</span><select class="nx-input" bind:value={idTokenSigningAlg} disabled={busy}>{#each ['RS256', 'PS256', 'ES256'] as value}<option value={value}>{value}</option>{/each}</select></label>
        {/if}
      {/if}
      {#if provider !== 'oidc' || mode === 'manual' || metadataCurrent}
        <label class="grid gap-1"><span class="nx-field-label">{t('connections.clientId')}</span><input class="nx-input" required bind:value={clientId} disabled={busy} /></label>
        <label class="grid gap-1"><span class="nx-field-label">{t('connections.secret')}</span><input class="nx-input" type="password" autocomplete="new-password" required={!existing?.hasSecret} bind:value={clientSecret} disabled={busy} placeholder={existing?.hasSecret ? t('admin.secretRetained') : ''} /></label>
      {/if}
      {#if provider === 'oidc'}<details><summary class="cursor-pointer text-sm text-zinc-400">{t('connections.advanced')}</summary><label class="mt-3 grid gap-1"><span class="nx-field-label">{t('connections.scopes')}</span><input class="nx-input" required bind:value={scopes} disabled={busy} /></label></details>{/if}
      {#if existing}<div class="flex items-center gap-2"><IndustrialToggle id={id + '-enabled'} bind:checked={enabled} disabled={busy} label={t('connections.enabled')} /><label for={id + '-enabled'} class="nx-field-label cursor-pointer">{t('connections.enabled')}</label></div>{/if}
      <p class="text-sm text-zinc-400">{t('connections.saveNote')}</p>
    {/if}
    {#if error || localError}<p role="alert" class="text-sm text-red-400">{error || localError}</p>{/if}
  </form>
{/snippet}
{#snippet footer()}<Button type="submit" form={id + '-connection'} disabled={busy || !canSave || discovering}>{t('admin.save')}</Button>{/snippet}
<IndustrialDialog bind:open title={t(existing ? 'connections.edit' : 'connections.new')} description={t('connections.description')} {busy} closeLabel={t('admin.close')} {body} {footer} scrollBody onOpenChange={value => {if (!value) {cancelDiscovery(); clientSecret = '';}}} />
