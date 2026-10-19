<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { _, isLoading } from 'svelte-i18n';
  import { requestPluginControl } from '$api/client';
  import { IndustrialDialog, IndustrialToggle, StatusBadge } from '$components/industrial';
  import { Button } from '$components/ui/button';
  import * as Dialog from '$components/ui/dialog';
  import SettingsSection from './SettingsSection.svelte';

  let {pluginName}: {pluginName: string} = $props();
  const id = $props.id();
  let returnFocus = $state<HTMLElement | null>(null);
  const t = (key: string) => $isLoading ? '' : $_(`plugins.user-auth.${key}`);
  type Turnstile = {version: number; enabled: boolean; siteKey: string; hostnames: string[]; hasSecret: boolean};
  let saved = $state<Turnstile | null>(null), draft = $state<Turnstile | null>(null);
  let open = $state(false), busy = $state(false), loading = $state(true);
  let secret = $state(''), hostnames = $state(''), error = $state('');
  let configured = $derived(!!saved?.siteKey && !!saved?.hasSecret && !!saved?.hostnames.length);
  let enabledChanged = $derived(!!saved && !!draft && saved.enabled !== draft.enabled);
  let dirty = $derived(!!saved && !!draft && (enabledChanged || saved.siteKey !== draft.siteKey || hostnames !== saved.hostnames.join('\n') || !!secret));

  function resetDraft() {
    draft = saved ? {...saved, hostnames: [...saved.hostnames]} : null;
    hostnames = saved?.hostnames.join('\n') ?? ''; secret = '';
  }
  async function load() {
    loading = true;
    try { saved = await requestPluginControl<Turnstile>(pluginName, '/turnstile', 'GET'); resetDraft(); }
    finally { loading = false; }
  }
  function edit() {
    returnFocus = document.getElementById(id + '-edit'); resetDraft(); error = ''; open = true; }
  function close() { open = false; draft = null; hostnames = ''; secret = ''; error = ''; }
  async function reload() {
    if (busy || loading) return;
    error = '';
    try { await load(); } catch { error = t('settings.errors.failed'); }
  }
  async function save(event: SubmitEvent) {
    event.preventDefault(); if (busy || loading || !draft) return;
    busy = true; error = '';
    try {
      const result = await requestPluginControl<Turnstile>(pluginName, '/turnstile', 'PUT', {
        version: draft.version, enabled: draft.enabled, siteKey: draft.siteKey,
        hostnames: hostnames.split(/[\s,]+/).filter(Boolean), ...(secret ? {secret} : {}),
      });
      saved = result; close(); await tick(); returnFocus?.focus();
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      if (code === 'version_conflict') { try { await load(); } catch {} }
      error = ['version_conflict', 'turnstile_incomplete', 'invalid_input', 'invalid_origin'].includes(code) ? t(`admin.errors.${code}`) : t('settings.errors.failed');
    } finally { busy = false; await tick(); if (open) document.getElementById(id + '-enabled')?.focus(); }
  }
  onMount(() => { void load().catch(() => { error = t('settings.errors.failed'); }); });
  onDestroy(() => { secret = ''; });
</script>

{#snippet status()}
  {#if saved}<span role="status" data-testid="turnstile-saved-status"><StatusBadge variant={saved.enabled ? 'active' : configured ? 'standby' : 'muted'}>{t(saved.enabled ? 'turnstile.active' : configured ? 'turnstile.configuredDisabled' : 'turnstile.inactive')}</StatusBadge></span>{/if}
{/snippet}
{#snippet actions()}<Button id={id + '-edit'} variant="ghost" disabled={loading || !saved} onclick={edit}>{t('turnstile.configure')}</Button>{/snippet}
<SettingsSection title={t('turnstile.title')} description={t('turnstile.description')} {status} {actions}>
  {#if loading}<p class="text-sm text-zinc-400">{t('settings.loading')}</p>{/if}
  {#if error && !open}<p role="alert" class="text-sm text-red-400">{error}</p><Button variant="ghost" disabled={loading} onclick={reload}>{t('session.reload')}</Button>{/if}
</SettingsSection>

{#snippet body()}
  {#if draft}<form id={id + '-turnstile'} class="space-y-4" onsubmit={save} aria-label={t('turnstile.title')}>
    <div class="flex items-center gap-3"><IndustrialToggle id={id + '-enabled'} bind:checked={draft.enabled} disabled={busy || loading} label={t('turnstile.enabled')} /><label for={id + '-enabled'} class="nx-field-label cursor-pointer">{t('turnstile.enabled')}</label></div>
    <label class="grid gap-1"><span class="nx-field-label">{t('turnstile.siteKey')}</span><input class="nx-input" bind:value={draft.siteKey} required={draft.enabled} disabled={busy || loading} /></label>
    <label class="grid gap-1"><span class="nx-field-label">{t('turnstile.secret')}</span><input class="nx-input" type="password" autocomplete="new-password" bind:value={secret} required={draft.enabled && !draft.hasSecret} placeholder={draft.hasSecret ? t('admin.secretRetained') : ''} disabled={busy || loading} /></label>
    <label class="grid gap-1"><span class="nx-field-label">{t('turnstile.hostnames')}</span><textarea class="nx-input h-24" bind:value={hostnames} required={draft.enabled} disabled={busy || loading}></textarea></label>
    {#if dirty}<p role="status" class="text-sm text-amber-400">{t('turnstile.pending')}</p>{/if}
    {#if error}<p role="alert" class="text-sm text-red-400">{error}</p>{/if}
  </form>{/if}
{/snippet}
{#snippet footer()}
  <Dialog.Close asChild let:builder><Button builders={[builder]} variant="ghost" disabled={busy || loading}>{t('admin.cancel')}</Button></Dialog.Close>
  <Button type="submit" form={id + '-turnstile'} disabled={busy || loading || !draft}>{t(enabledChanged ? (draft?.enabled ? 'turnstile.saveEnable' : 'turnstile.saveDisable') : 'turnstile.save')}</Button>
{/snippet}
<IndustrialDialog bind:open {returnFocus} title={t('turnstile.title')} description={t('turnstile.description')} {busy} closeLabel={t('admin.close')} {body} {footer} scrollBody onOpenChange={value => {if (!value) close();}} />
