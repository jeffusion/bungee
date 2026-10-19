<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { _, isLoading } from 'svelte-i18n';
  import { requestPluginControl } from '$api/client';
  import { endSession } from '$api/auth';
  import { logout, getAuthStateRevision, isAuthenticationStateCurrent } from '$stores/auth';
  import { PanelCard, LoadingIndicator, StatusBadge, IndustrialDialog } from '$components/industrial';
  import { Button } from '$components/ui/button';
  import LoginProviderIcon from './LoginProviderIcon.svelte';
  import { validPassword, authorizationUrl, type User, type Connection, type Identity } from './contracts';

  let { pluginName = 'user-auth' }: { pluginName?: string; apiBase?: string } = $props();
  const id = $props.id();
  const t = (key: string) => $isLoading ? '' : $_(`plugins.user-auth.${key}`);
  const lifetime = new AbortController();
  const revision = getAuthStateRevision();
  const current = () => !lifetime.signal.aborted && isAuthenticationStateCurrent(revision);
  const call = <T,>(path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown) => requestPluginControl<T>(pluginName, path, method, body, lifetime.signal);
  let administrator = $state<User | null>(null), identities = $state<Identity[]>([]), connections = $state<Connection[]>([]);
  let currentPassword = $state(''), password = $state(''), confirmation = $state('');
  let busy = $state(false), loading = $state(true), error = $state(''), detail = $state('');
  let passwordOpen = $state(false), unlinkTarget = $state<Identity | null>(null), unlinkOpen = $state(false);
  let bindingRows = $derived(connections
    .filter(connection => connection.enabled || identities.some(identity => identity.connectionId === connection.id))
    .map(connection => ({connection, identities: identities.filter(identity => identity.connectionId === connection.id)})));
  let unmatchedIdentities = $derived(identities.filter(identity => !connections.some(connection => connection.id === identity.connectionId)));
  let unlinkConnection = $derived(connections.find(connection => connection.id === unlinkTarget?.connectionId));
  function failure(cause: unknown) {
    detail = cause instanceof Error ? cause.message : String(cause);
    const key = ['invalid_password', 'password_confirmation', 'password_unchanged'].includes(detail) ? 'settings.errors.' + detail
      : ['management_origin_required', 'invalid_origin', 'invalid_oidc_url', 'oidc_unavailable', 'oidc_network_failed', 'oidc_metadata_failed', 'oidc_metadata_invalid', 'oidc_pkce_unsupported', 'identity_exists'].includes(detail) ? 'admin.errors.' + detail : 'settings.errors.failed';
    error = key;
  }
  function signedOut() { if (current()) { logout(); window.location.hash = '#/login'; } }
  async function load() {
    loading = true; error = ''; detail = '';
    try {
      const result = await call<{administrator: User}>('/self', 'GET');
      if (!current()) return;
      administrator = result.administrator;
      const [bound, methods] = await Promise.all([
        call<{identities: Identity[]}>(`/identities?userId=${encodeURIComponent(result.administrator.id)}`, 'GET'),
        call<{connections: Connection[]}>('/login-connections', 'GET'),
      ]);
      if (current()) { identities = bound.identities; connections = methods.connections; }
    } catch (cause) { if (current()) failure(cause); }
    finally { if (current()) loading = false; }
  }
  async function action(operation: () => Promise<void>) {
    if (busy || !current()) return;
    busy = true; error = ''; detail = '';
    try { await operation(); } catch (cause) { if (current()) failure(cause); }
    finally { if (current()) busy = false; }
  }
  async function change(event: SubmitEvent) {
    event.preventDefault();
    await action(async () => {
      validPassword(password, confirmation);
      try {
        await requestPluginControl(pluginName, '/password', 'POST', {currentPassword, password, passwordConfirmation: confirmation}, lifetime.signal, {preserveSessionOnUnauthorized: true});
        signedOut();
      } finally { currentPassword = ''; password = ''; confirmation = ''; }
    });
  }
  async function leave() { await action(async () => { await endSession({onCompleted: () => { if (!lifetime.signal.aborted) window.location.hash = '#/login'; }}); }); }
  async function link(connection: Connection) { await action(async () => {
    if (!connection.enabled || identities.some(identity => identity.connectionId === connection.id)) return;
    const result = await call<{authorizationUrl: string}>('/identities/link/start', 'POST', {connectionId: connection.id});
    if (current()) window.location.assign(authorizationUrl(result.authorizationUrl));
  }); }
  function confirmUnbind(identity: Identity) { error = ''; detail = ''; unlinkTarget = identity; unlinkOpen = true; }
  async function unbind(identity: Identity) { await action(async () => { await call('/identities', 'DELETE', {id: identity.id}); signedOut(); }); }
  onMount(() => {
    const flowId = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('oidcLink');
    if (flowId) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search + window.location.hash.split('?')[0]);
      loading = false;
      void action(async () => { await call('/identities/link/finish', 'POST', {flowId}); signedOut(); });
    } else void load();
  });
  onDestroy(() => { lifetime.abort(); currentPassword = ''; password = ''; confirmation = ''; });
</script>

<div class="space-y-4" data-testid="auth-user-profile">
  <div class="space-y-2">
    <h1 class="nx-display text-xl text-zinc-50">{t('profile.title')}</h1>
  </div>
  <PanelCard title={t('settings.accountTitle')} tag={t('settings.accountTag')}>
    <div data-testid="account-summary">
      {#if loading}<LoadingIndicator label={t('settings.loading')} height="sm" />
      {:else if administrator}
        <div class="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div class="min-w-0 space-y-3" data-testid="account-details">
            <dl class="space-y-2">
              <div><dt class="sr-only">{t('login.username')}</dt><dd class="break-all text-xl font-semibold text-zinc-100">{administrator.username}</dd></div>
              <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm"><dt class="text-zinc-400">{t('users.displayName')}</dt><dd class="min-w-0 break-words text-zinc-300">{administrator.displayName || administrator.username}</dd></div>
            </dl>
            <StatusBadge variant="active">{t(administrator.hasLocalPassword ? 'users.local' : 'users.sso')}</StatusBadge>
            {#if !administrator.hasLocalPassword}<p class="max-w-xl text-sm text-zinc-400">{t('profile.noPassword')}</p>{/if}
          </div>
          <div class="flex shrink-0 flex-col gap-2 sm:border-l sm:border-carbon-600 sm:pl-6" data-testid="account-actions">
            {#if administrator.hasLocalPassword}<Button class="w-full sm:min-w-32" disabled={busy} onclick={() => {error = ''; detail = ''; passwordOpen = true;}}>{t('profile.changePassword')}</Button>{/if}
            <Button class="w-full sm:min-w-32" variant="ghost" disabled={busy} onclick={leave}>{t('settings.logout')}</Button>
          </div>
        </div>
      {/if}
    </div>
  </PanelCard>
  <PanelCard title={t('users.identities')} tag="SSO">
    <div class="space-y-4" data-testid="identity-bindings">
      <p class="text-sm text-zinc-400">{t('profile.bindingDescription')}</p>
      {#if loading}<LoadingIndicator label={t('settings.loading')} height="sm" />
      {:else if bindingRows.length || unmatchedIdentities.length}
        <ul class="divide-y divide-carbon-600" aria-label={t('users.identities')}>
          {#each bindingRows as row (row.connection.id)}
            {@const connection = row.connection}
            <li class="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center" data-connection-id={connection.id}>
              <div class="flex min-w-0 items-center gap-3 sm:w-1/3 sm:shrink-0">
                <LoginProviderIcon provider={connection.provider} />
                <div class="min-w-0 flex-1 space-y-1">
                  <h3 class="break-words text-base font-semibold text-zinc-100">{connection.provider === 'oidc' ? connection.label : t('providers.' + connection.provider)}</h3>
                  {#if connection.provider === 'oidc' || connection.label !== t('providers.' + connection.provider)}
                    <p class="break-words text-sm text-zinc-400">{connection.provider === 'oidc' ? t('providers.oidc') : connection.label}</p>
                  {/if}
                  {#if !row.identities.length}<p class="text-sm text-zinc-400">{t('profile.notBound')}</p>{/if}
                  {#if !connection.enabled}<StatusBadge variant="muted">{t('connections.disable')}</StatusBadge>{/if}
                </div>
              </div>
              <div class="min-w-0 flex-1 space-y-3">
                {#if !row.identities.length}
                  <div class="flex justify-end"><Button variant="ghost" disabled={busy || !administrator || !connection.enabled} aria-label={`${t('profile.bind')} ${connection.label}`} onclick={() => link(connection)}>{t('profile.bind')}</Button></div>
                {:else}
                  {#each row.identities as identity (identity.id)}
                    <div class="flex flex-wrap items-center gap-3">
                      <p class="min-w-0 flex-1 break-all text-sm text-zinc-400">{t('profile.identityId')}<span class="ml-2 font-mono text-zinc-300">{identity.subject}</span></p>
                      <StatusBadge variant="active">{t('profile.bound')}</StatusBadge>
                      <Button variant="destructive" disabled={busy || !administrator} aria-label={`${t('users.unbind')} ${connection.label} ${identity.subject}`} onclick={() => confirmUnbind(identity)}>{t('users.unbind')}</Button>
                    </div>
                  {/each}
                {/if}
              </div>
            </li>
          {/each}
          {#each unmatchedIdentities as identity (identity.id)}
            <li class="flex flex-wrap items-center gap-3 py-4 last:pb-0">
              <LoginProviderIcon provider="oidc" />
              <div class="min-w-0 flex-1 space-y-1"><h3 class="break-all text-base text-zinc-100">{identity.issuer}</h3><p class="break-all text-sm text-zinc-400">{t('profile.identityId')} <span class="font-mono">{identity.subject}</span></p></div>
              <Button variant="destructive" disabled={busy || !administrator} aria-label={`${t('users.unbind')} ${identity.subject}`} onclick={() => confirmUnbind(identity)}>{t('users.unbind')}</Button>
            </li>
          {/each}
        </ul>
        <p class="border-t border-carbon-600 pt-3 text-sm text-zinc-400">{t('users.bindingNote')}</p>
      {:else}<p class="text-sm text-zinc-400">{t('profile.noConnections')}</p>{/if}
    </div>
  </PanelCard>
  {#if error && !passwordOpen && !unlinkOpen}
    <p role="alert" class="text-sm text-red-400">{t(error)}</p>
    <details class="text-sm text-zinc-400"><summary>{t('login.technicalDetails')}</summary><pre class="whitespace-pre-wrap break-all">{detail}</pre></details>
    <Button variant="ghost" disabled={busy} onclick={load}>{t('session.reload')}</Button>
  {/if}
</div>

{#snippet passwordBody()}
      <form id={id + '-password'} class="space-y-3" onsubmit={change} aria-busy={busy} aria-label={t('settings.passwordTitle')}>
        <label class="grid gap-1"><span class="nx-field-label">{t('settings.currentPassword')}</span><input class="nx-input" type="password" autocomplete="current-password" bind:value={currentPassword} required disabled={busy || !administrator} /></label>
        <label class="grid gap-1"><span class="nx-field-label">{t('settings.newPassword')}</span><input class="nx-input" type="password" autocomplete="new-password" bind:value={password} required disabled={busy || !administrator} /></label>
        <label class="grid gap-1"><span class="nx-field-label">{t('settings.confirmation')}</span><input class="nx-input" type="password" autocomplete="new-password" bind:value={confirmation} required disabled={busy || !administrator} /></label>
        {#if error}<p role="alert" class="text-sm text-red-400">{t(error)}</p>{/if}
      </form>
{/snippet}
{#snippet passwordFooter()}<Button type="submit" form={id + '-password'} disabled={busy || !administrator}>{busy ? t('settings.updating') : t('settings.submit')}</Button>{/snippet}
<IndustrialDialog bind:open={passwordOpen} title={t('settings.passwordTitle')} description={t('settings.passwordDescription')} {busy} closeLabel={t('admin.close')} body={passwordBody} footer={passwordFooter} scrollBody onOpenChange={value => {if (!value) {currentPassword = ''; password = ''; confirmation = ''; error = ''; detail = '';}}} />

{#snippet unlinkBody()}
  {#if unlinkTarget}
    <div class="flex items-start gap-3">
      <LoginProviderIcon provider={unlinkConnection?.provider ?? 'oidc'} />
      <div class="min-w-0 space-y-1"><p class="break-words font-semibold text-zinc-100">{unlinkConnection?.label ?? unlinkTarget.issuer}</p><p class="break-all text-sm text-zinc-400">{t('profile.identityId')} <span class="font-mono">{unlinkTarget.subject}</span></p></div>
    </div>
    <p class="text-sm text-zinc-300">{t('profile.unbindWarning')}</p>
  {/if}
  {#if error}<p role="alert" class="text-sm text-red-400">{t(error)}</p>{/if}
{/snippet}
{#snippet unlinkFooter()}<Button type="button" variant="destructive" disabled={busy || !administrator || !unlinkTarget} onclick={() => {if (unlinkTarget) void unbind(unlinkTarget);}}>{t('users.unbind')}</Button>{/snippet}
<IndustrialDialog bind:open={unlinkOpen} title={t('profile.unbindTitle')} description="" {busy} closeLabel={t('admin.cancel')} body={unlinkBody} footer={unlinkFooter} scrollBody onOpenChange={value => {if (!value) {unlinkTarget = null; error = ''; detail = '';}}} />
