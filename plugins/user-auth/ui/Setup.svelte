<script lang="ts">
  import { onDestroy } from 'svelte';
  import { isLoading } from 'svelte-i18n';
  import { _ } from '@bungee/plugin-sdk';
  import type { ManagementSetupContext } from '@bungee/plugin-sdk';
  let { context }: { context: ManagementSetupContext } = $props();
  const t = (key: string) => $isLoading ? '' : $_(`plugins.user-auth.${key}`);
  let setupCode = $state(''), username = $state(''), password = $state(''), passwordConfirmation = $state('');
  let busy = $state(false), error = $state(''), detail = $state('');
  let destroyed = false;
  onDestroy(() => { destroyed = true; });
  async function initialize(event: SubmitEvent) {
    event.preventDefault(); if (busy) return;
    const active = context; error = ''; detail = '';
    if (password !== passwordConfirmation) { error = 'setup.password_confirmation'; return; }
    if ([...password].length < 5 || [...password].length > 32) { error = 'setup.invalid_password'; return; }
    busy = true;
    try { await active.initialize({setupCode, username, password, passwordConfirmation}); }
    catch (cause) {
      if (destroyed || context !== active) return;
      detail = cause instanceof Error ? cause.message : String(cause);
      error = ['invalid_setup_code', 'password_confirmation', 'invalid_password', 'already_initialized'].includes(detail) ? `setup.${detail}` : 'setup.failed';
    } finally {
      password = ''; passwordConfirmation = ''; setupCode = '';
      if (!destroyed && context === active) busy = false;
    }
  }
</script>

<form onsubmit={initialize} aria-label={t('setup.title')} aria-busy={busy} class="space-y-4">
  <p class="text-sm text-zinc-400">{t('setup.description')}</p>
  <label class="grid gap-1"><span class="nx-field-label">{t('setup.code')}</span><input class="nx-input font-mono" bind:value={setupCode} autocomplete="off" required disabled={busy} /></label>
  <label class="grid gap-1"><span class="nx-field-label">{t('login.username')}</span><input class="nx-input" bind:value={username} autocomplete="username" required maxlength="64" disabled={busy} /></label>
  <label class="grid gap-1"><span class="nx-field-label">{t('setup.password')}</span><input class="nx-input" type="password" bind:value={password} autocomplete="new-password" required disabled={busy} /></label>
  <label class="grid gap-1"><span class="nx-field-label">{t('setup.confirmation')}</span><input class="nx-input" type="password" bind:value={passwordConfirmation} autocomplete="new-password" required disabled={busy} /></label>
  {#if error}<p role="alert" class="text-sm text-red-400">{t(error)}</p>{#if detail}<details class="text-sm text-zinc-400"><summary>{t('login.technicalDetails')}</summary><pre class="whitespace-pre-wrap break-all">{detail}</pre></details>{/if}{/if}
  <button class="nx-btn-primary w-full justify-center" disabled={busy}>{busy ? t('setup.busy') : t('setup.submit')}</button>
</form>
