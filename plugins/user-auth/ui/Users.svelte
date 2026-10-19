<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { _, isLoading } from 'svelte-i18n';
  import { requestPluginControl } from '$api/client';
  import { logout, getAuthStateRevision, isAuthenticationStateCurrent, subject } from '$stores/auth';
  import { PanelCard, IndustrialToggle, IndustrialDialog } from '$components/industrial';
  import { Button } from '$components/ui/button';
  import { validPassword, type User } from './contracts';

  let {pluginName = 'user-auth'}: {pluginName?: string; apiBase?: string} = $props();
  const id = $props.id();
  const selfId = $derived($subject?.id);
  const t = (key: string) => $isLoading ? '' : $_(`plugins.user-auth.${key}`);
  const lifetime = new AbortController(), ownerRevision = getAuthStateRevision();
  const current = () => !lifetime.signal.aborted && isAuthenticationStateCurrent(ownerRevision);
  const call = <T,>(path: string, method: 'GET' | 'POST' | 'PUT', body?: unknown) => requestPluginControl<T>(pluginName, path, method, body, lifetime.signal);
  let users = $state<User[]>([]), loading = $state(true), busy = $state(false), error = $state('');
  let open = $state(false), operation = $state<'edit' | 'reset'>('edit');
  let draft = $state({id: '', username: '', displayName: '', disabled: false}), password = $state(''), confirmation = $state('');
  let returnFocus = $state<HTMLElement | null>(null);
  let title = $derived(t(operation === 'reset' ? 'users.reset' : draft.id ? 'users.edit' : 'users.new'));
  function fail(cause: unknown) { const code = cause instanceof Error ? cause.message : ''; error = t(`admin.errors.${code}`) === `plugins.user-auth.admin.errors.${code}` ? t('settings.errors.failed') : t(`admin.errors.${code}`); }
  async function load() {
    loading = true;
    try { const result = await call<{users: User[]}>('/users', 'GET'); if (current()) users = result.users; }
    catch (cause) { if (current()) fail(cause); } finally { if (current()) loading = false; }
  }
  function signedOut() { if (current()) { logout(); window.location.hash = '#/login'; } }
  function clearSecrets() { password = ''; confirmation = ''; }
  function edit(user?: User, reset = false) {
    operation = reset ? 'reset' : 'edit';
    draft = user ? {id: user.id, username: user.username, displayName: user.displayName, disabled: user.disabled} : {id: '', username: '', displayName: '', disabled: false};
    clearSecrets(); error = ''; open = true;
    returnFocus = document.getElementById(id + '-create');
  }
  async function mutate(work: () => Promise<void>) {
    if (busy || !current()) return;
    busy = true; error = '';
    try { await work(); } catch (cause) { if (current()) fail(cause); }
    finally { if (current()) busy = false; }
  }
  async function save(event: SubmitEvent) { event.preventDefault(); await mutate(async () => {
    if (operation === 'reset') { validPassword(password, confirmation); await call('/users/password', 'POST', {id: draft.id, password, passwordConfirmation: confirmation}); }
    else if (draft.id) await call('/users/update', 'PUT', {id: draft.id, username: draft.username, displayName: draft.displayName, disabled: draft.disabled});
    else { if (password || confirmation) validPassword(password, confirmation); await call('/users', 'POST', {username: draft.username, displayName: draft.displayName, ...(password ? {password, passwordConfirmation: confirmation} : {})}); }
    clearSecrets();
    if (operation === 'reset' && draft.id === selfId) signedOut();
    else { await load(); if (current()) open = false; }
  }); }
  async function toggle(user: User) { await mutate(async () => {
    await call('/users/update', 'PUT', {id: user.id, username: user.username, displayName: user.displayName, disabled: !user.disabled});
    if (selfId === user.id) signedOut(); else await load();
  }); }
  onMount(() => { void load(); });
  onDestroy(() => { lifetime.abort(); clearSecrets(); });
</script>

<div class="space-y-4" data-testid="auth-users">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="space-y-2"><h1 class="nx-display text-xl text-zinc-50">{t('users.title')}</h1></div>
    <Button id={id + '-create'} disabled={busy || loading} onclick={() => edit()}>{t('users.new')}</Button>
  </div>
  <PanelCard title={t('users.title')} tag="USERS">
    <div class="space-y-4">
      <p class="text-sm text-zinc-400">{t('users.access')}</p>
      {#if loading}<p class="text-sm text-zinc-400">{t('settings.loading')}</p>
      {:else if !users.length}<p class="text-sm text-zinc-400">{t('users.empty')}</p>
      {:else}
        <div class="space-y-2">{#each users as user (user.id)}
          <div class="flex flex-col gap-2 border-b border-carbon-600 pb-3 sm:flex-row sm:items-center sm:justify-between" data-testid="auth-user-row">
            <div class="min-w-0"><p class="break-words text-zinc-200">{user.displayName || user.username}</p><p class="text-sm text-zinc-400 break-all">{user.username} · {user.disabled ? t('users.disabled') : t('users.enabled')} · {user.hasLocalPassword ? t('users.local') : t('users.sso')}</p></div>
            <div class="flex flex-wrap items-center gap-2"><Button variant="ghost" disabled={busy} onclick={() => edit(user)}>{t('admin.edit')}</Button><Button variant="ghost" disabled={busy} onclick={() => edit(user, true)}>{t('users.reset')}</Button><IndustrialToggle checked={!user.disabled} disabled={busy} label={t('users.toggle') + ' ' + user.username} onchange={() => toggle(user)} /></div>
          </div>
        {/each}</div>
      {/if}
      {#if error && !open}<p class="text-sm text-red-400" role="alert">{error}</p><Button variant="ghost" disabled={busy} onclick={() => {error = ''; void load();}}>{t('session.reload')}</Button>{/if}
    </div>
  </PanelCard>
</div>

{#snippet editorBody()}
  <form id={id + '-form'} onsubmit={save} class="space-y-3" aria-label={title} aria-busy={busy}>
    {#if operation === 'reset'}<p class="text-sm text-zinc-200 break-all">{draft.username}</p>
    {:else}
      <div class="grid gap-3"><label class="grid gap-1"><span class="nx-field-label">{t('login.username')}</span><input class="nx-input" required maxlength="64" bind:value={draft.username} disabled={busy} /></label><label class="grid gap-1"><span class="nx-field-label">{t('users.displayName')}</span><input class="nx-input" maxlength="256" bind:value={draft.displayName} disabled={busy} /></label></div>
    {/if}
    {#if operation === 'reset' || !draft.id}
      {#if operation !== 'reset'}<p class="text-sm text-zinc-400">{t('users.optionalPassword')}</p>{/if}
      <div class="grid gap-3"><label class="grid gap-1"><span class="nx-field-label">{t('users.password')}</span><input class="nx-input" type="password" autocomplete="new-password" required={operation === 'reset'} bind:value={password} disabled={busy} /></label><label class="grid gap-1"><span class="nx-field-label">{t('users.confirmation')}</span><input class="nx-input" type="password" autocomplete="new-password" required={operation === 'reset'} bind:value={confirmation} disabled={busy} /></label></div>
    {/if}
    {#if error}<p class="text-sm text-red-400" role="alert">{error}</p>{/if}
  </form>
{/snippet}
{#snippet editorFooter()}<Button type="submit" form={id + '-form'} disabled={busy}>{t(operation === 'reset' ? 'users.reset' : 'admin.save')}</Button>{/snippet}
<IndustrialDialog bind:open {title} description={t(operation === 'reset' ? 'users.revokes' : 'users.editDescription')} {busy} {returnFocus} closeLabel={t('admin.close')} body={editorBody} footer={editorFooter} scrollBody onOpenChange={value => {if (!value) {clearSecrets(); error = '';}}} />
