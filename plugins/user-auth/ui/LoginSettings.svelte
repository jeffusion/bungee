<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { _, isLoading } from 'svelte-i18n';
  import { v4 as uuid } from 'uuid';
  import { requestPluginControl } from '$api/client';
  import { logout, getAuthStateRevision, isAuthenticationStateCurrent } from '$stores/auth';
  import { IndustrialToggle, IndustrialDialog, BSelect, StatusBadge } from '$components/industrial';
  import { Button } from '$components/ui/button';
  import { Input } from '$components/ui/input';
  import { Plus } from 'lucide-svelte';
  import type { Connection, ConnectionInput } from './contracts';
  import ConnectionEditor from './ConnectionEditor.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import TurnstileSettings from './TurnstileSettings.svelte';
  let {pluginName}: {pluginName: string} = $props();
  const id = $props.id();
  const t = (key: string) => $isLoading ? '' : $_(`plugins.user-auth.${key}`);
  const lifetime = new AbortController(), ownerRevision = getAuthStateRevision();
  const current = () => !lifetime.signal.aborted && isAuthenticationStateCurrent(ownerRevision);
  const call = <T,>(path: string, method: 'GET'|'POST'|'PUT'|'DELETE', body?: unknown) => requestPluginControl<T>(pluginName, path, method, body, lifetime.signal);
  type LoginSettings = {version: number; autoCreateUsers: boolean};
  let connections = $state<Connection[]>([]), settings = $state<LoginSettings | null>(null);
  let editorOpen = $state(false), deleteOpen = $state(false);
  let deleteTarget = $state<Connection | null>(null), search = $state(''), status = $state('all');
  let visibleConnections = $derived(connections.filter(connection =>
    (status === 'all' || connection.enabled === (status === 'enabled')) &&
    [connection.label, connection.provider, connection.issuer, connection.clientId].some(value => value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))));
  let editing = $state<Connection | null>(null), draftId = $state('');
  let busy = $state(false), loading = $state(true), error = $state(''), notice = $state('');
  let publicOrigin = $state<string | undefined>();
  async function load() {
    loading = true;
    try { const [methods, login] = await Promise.all([call<{connections: Connection[]; publicOrigin: string | null}>('/login-connections', 'GET'), call<LoginSettings>('/login-settings', 'GET')]); if (current()) { connections = methods.connections; publicOrigin = methods.publicOrigin ?? undefined; settings = login; } }
    finally { if (current()) loading = false; }
  }
  function edit(connection?: Connection) {
    editing = connection ?? null; draftId = connection?.id ?? uuid();
    editorOpen = true; error = ''; notice = '';
  }
  async function action(operation: () => Promise<void>) {
    if (busy || !current()) return; busy = true; error = ''; notice = '';
    try { await operation(); if (current()) notice ||= t('admin.saved'); }
    catch (cause) { if (!current()) return; const code = cause instanceof Error ? cause.message : '';
      if (code === 'version_conflict') { const editing = editorOpen, editingId = draftId; deleteOpen = false; deleteTarget = null; try { await load(); if (current() && editing) edit(connections.find(connection => connection.id === editingId)); } catch {} if (current()) error = t('admin.errors.version_conflict'); }
      else error = ["invalid_input", "invalid_origin", "invalid_provider", "invalid_microsoft_configuration", "invalid_microsoft_tenant", "microsoft_account_scope", "microsoft_signing_key_issuer", "invalid_oidc_configuration", "invalid_oauth_identity", "oidc_metadata_failed", "oidc_metadata_invalid", "oidc_metadata_limit", "oidc_network_failed", "oidc_pkce_unsupported", "oidc_signing_alg_unsupported", "preset_scopes_fixed", "verified_identity_required", "invalid_oidc_url", "oidc_issuer_mismatch", "oidc_auth_method_unsupported", "oidc_secret_required"].includes(code) ? t(`admin.errors.${code}`) : t('settings.errors.failed');
    } finally { if (current()) busy = false; }
  }
  async function saveConnection(input: ConnectionInput) { await action(async () => {
    const result = await call<{connection: Connection}>('/login-connections', editing ? 'PUT' : 'POST', input);
    if (!current()) return;
    applyConnection(result.connection); editorOpen = false;
    notice = t('connections.saved');
  }); }
  function confirmDelete(connection: Connection) { deleteTarget = connection; error = ''; notice = ''; deleteOpen = true; }
  function applyConnection(connection: Connection) { if (current()) connections = [...connections.filter(item => item.id !== connection.id), connection]; }
  async function toggleConnection(connection: Connection) { await action(async () => {
    const result = await call<{connection: Connection}>('/login-connections', 'PUT', {
      id: connection.id, version: connection.version, label: connection.label, enabled: !connection.enabled,
      provider: connection.provider, configuration: connection.configuration, clientId: connection.clientId, ...(connection.provider === 'oidc' ? {scopes: connection.scopes} : {}),
    });
    applyConnection(result.connection);
  }); }
  async function removeConnection() { await action(async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    try {
      const result = await call<{ok: true; sessionRevoked: boolean}>('/login-connections', 'DELETE', {id: target.id, version: target.version});
      if (!current()) return;
      if (result.sessionRevoked) { logout(); window.location.hash = '#/login'; return; }
    } catch (cause) {
      if (!current()) return;
      if (cause instanceof Error && cause.message === 'version_conflict') throw cause;
      const result = await call<{connections: Connection[]}>('/login-connections', 'GET');
      if (!current()) return;
      connections = result.connections;
      if (connections.some(connection => connection.id === target.id)) throw cause;
    }
    connections = connections.filter(connection => connection.id !== target.id); deleteOpen = false; deleteTarget = null;
  }); }
  async function toggleAuto(value: boolean) { await action(async () => { if (!settings) return; const result = await call<LoginSettings>('/login-settings', 'PUT', {version: settings.version, autoCreateUsers: value}); if (current()) settings = result; }); }
  onMount(() => { void load().catch(() => { if (current()) error = t('settings.errors.failed'); }); });
  onDestroy(() => { lifetime.abort(); });
</script>
<div data-testid="auth-login-settings">
  <SettingsSection title={t('connections.title')}>
    <div class="space-y-4">
      {#if loading}<p class="text-sm text-zinc-400">{t('settings.loading')}</p>{:else}
        <div class="flex items-start gap-3 border-b border-carbon-600 pb-4"><IndustrialToggle id={id + '-login-auto'} checked={settings?.autoCreateUsers ?? false} label={t('connections.autoCreate')} disabled={busy || !settings} onchange={toggleAuto} /><div class="min-w-0 pt-2"><label for={id + '-login-auto'} class="nx-field-label cursor-pointer">{t('connections.autoCreate')}</label><p class="text-sm text-zinc-400 mt-1">{t('connections.autoCreateWarning')}</p></div></div>
        {#if connections.length}
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between" data-testid="login-connections-toolbar">
            <Button variant="ghost" class="self-start shrink-0 gap-2" disabled={busy} onclick={() => edit()}><Plus class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t('connections.add')}</Button>
            <div class="flex w-full min-w-0 flex-col gap-3 sm:ml-auto sm:w-auto sm:flex-row sm:items-center" data-testid="login-connections-filters">
              <Input class="min-w-0 sm:w-80" type="search" bind:value={search} placeholder={t('connections.searchPlaceholder')} aria-label={t('connections.search')} />
              <div class="w-full shrink-0 sm:w-auto sm:min-w-36"><BSelect autoWidth={false} bind:value={status} options={[{value: 'all', label: t('connections.all')}, {value: 'enabled', label: t('users.enabled')}, {value: 'disabled', label: t('users.disabled')}]} ariaLabel={t('connections.status')} /></div>
            </div>
          </div>
          <div class="overflow-x-auto" role="region" aria-label={t('connections.title')}>
          <table class="w-full min-w-[48rem] text-left text-base border border-carbon-600" aria-label={t('connections.title')}>
            <thead class="bg-carbon-900 text-zinc-400"><tr>
              <th class="px-2 py-3" scope="col">{t('connections.label')}</th><th class="px-2 py-3" scope="col">{t('connections.provider')}</th><th class="px-2 py-3" scope="col">{t('connections.clientId')}</th><th class="px-2 py-3" scope="col">{t('connections.status')}</th><th class="px-2 py-3" scope="col">{t('connections.actions')}</th>
            </tr></thead>
            <tbody>{#each visibleConnections as connection (connection.id)}
              <tr class="border-t border-carbon-600" data-testid="login-connection-row">
                <th class="max-w-48 break-words px-2 py-4 font-normal text-zinc-200" scope="row">{connection.label}</th>
                <td class="max-w-64 break-all px-2 py-3 font-mono text-zinc-400">{t('providers.' + connection.provider)}</td>
                <td class="px-2 py-3 text-zinc-300"><span class="block max-w-64 truncate font-mono text-sm" title={connection.clientId}>{connection.clientId}</span></td>
                <td class="px-2 py-3"><StatusBadge variant={connection.enabled ? 'active' : 'muted'}>{connection.enabled ? t('users.enabled') : t('users.disabled')}</StatusBadge></td>
                <td class="px-2 py-3"><div class="flex gap-2">
                  <Button variant="ghost" disabled={busy} onclick={() => edit(connection)}>{t('admin.edit')}</Button>
                  <Button variant="ghost" disabled={busy || (!connection.enabled && !publicOrigin)} title={!connection.enabled && !publicOrigin ? t('connections.missingOrigin') : undefined} onclick={() => toggleConnection(connection)}>{t(connection.enabled ? 'connections.disable' : 'connections.enable')}</Button>
                  <Button variant="destructive" disabled={busy} onclick={() => confirmDelete(connection)}>{t('connections.remove')}</Button>
                </div></td>
              </tr>
            {:else}<tr><td colspan="5" class="px-2 py-6 text-zinc-400">{t('connections.noMatches')}</td></tr>{/each}</tbody>
          </table>
          </div>
        {:else}
          <div class="flex flex-col items-start gap-3 py-4" data-testid="login-connections-empty">
            <p class="text-sm text-zinc-400">{t('connections.empty')}</p>
            <Button class="gap-2" disabled={busy} onclick={() => edit()}><Plus class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t('connections.add')}</Button>
          </div>
        {/if}

      {/if}
    </div>
  </SettingsSection>
  <TurnstileSettings {pluginName} />
  {#if notice && !editorOpen && !deleteOpen}<p class="text-sm text-emerald-400" role="status">{notice}</p>{/if}
  {#if error && !editorOpen && !deleteOpen}<p class="text-sm text-red-400" role="alert">{error}</p><Button variant="ghost" disabled={busy} onclick={() => action(load)}>{t('session.reload')}</Button>{/if}
</div>

{#if editorOpen}
  {#key `${draftId}:${editing?.version ?? 0}`}<ConnectionEditor bind:open={editorOpen} {pluginName} connection={editing} connectionId={draftId} {publicOrigin} {busy} {error} onsave={saveConnection} />{/key}
{/if}

{#snippet deleteBody()}
  <p class="break-words text-sm text-zinc-200">{deleteTarget?.label}</p>
  {#if error}<p role="alert" class="text-sm text-red-400">{error}</p>{/if}
{/snippet}
{#snippet deleteFooter()}<Button variant="destructive" disabled={busy || !deleteTarget} onclick={removeConnection}>{t('connections.remove')}</Button>{/snippet}
<IndustrialDialog bind:open={deleteOpen} title={t('connections.delete')} description={t('connections.deleteWarning')} {busy} closeLabel={t('admin.cancel')} body={deleteBody} footer={deleteFooter} onOpenChange={value => {if (!value) {deleteTarget = null; error = '';}}} />
