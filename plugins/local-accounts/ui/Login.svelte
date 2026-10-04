<script lang="ts">
  import { onDestroy } from 'svelte';
  import { isLoading } from 'svelte-i18n';
  import { _, isManagementLoginStaleError, type ManagementLoginContext } from '@bungee/plugin-sdk';
  import RecoveryHelp from './RecoveryHelp.svelte';
  import { loginFailure, requireLoginSuccess } from './login-errors';

  let { context }: { context: ManagementLoginContext } = $props();
  const t = (key: string, values: Record<string, string> = {}) => $isLoading ? '' : $_(`plugins.local-accounts.${key}`, { values });
  let username = $state(''), password = $state(''), busy = $state(false);
  let error = $state(''), detail = $state('');
  let destroyed = false;
  onDestroy(() => { destroyed = true; });

  async function login(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    const activeContext = context;
    busy = true; error = ''; detail = '';
    try {
      const result = await activeContext.login({ username, password, transport: 'cookie' });
      if (destroyed || context !== activeContext || result === undefined) return;
      requireLoginSuccess(result);
      await activeContext.complete();
    } catch (cause) {
      if (destroyed || context !== activeContext || isManagementLoginStaleError(cause)) return;
      const failure = loginFailure(cause);
      error = failure.key; detail = failure.detail;
    } finally {
      password = '';
      if (!destroyed && context === activeContext) busy = false;
    }
  }
</script>

<form onsubmit={login} aria-label={t('login.title')} aria-busy={busy} class="space-y-4">
  <p class="text-sm text-zinc-400">{t('login.description')}</p>
  <label class="grid gap-1"><span class="nx-field-label">{t('login.username')}</span><input class="nx-input" bind:value={username} autocomplete="username" required maxlength="64" disabled={busy} /></label>
  <label class="grid gap-1"><span class="nx-field-label">{t('login.password')}</span><input class="nx-input" bind:value={password} type="password" autocomplete="current-password" required disabled={busy} /></label>
  {#if error}
    <p role="alert" class="text-sm text-red-400">{t(error)}</p>
    {#if detail === 'invalid_origin' && context.provider.publicOrigin}<a class="text-sm text-nexus-300 underline break-all" href={`${context.provider.publicOrigin}/#/login`}>{t('login.correctAddress', { origin: context.provider.publicOrigin })}</a>{/if}
    <details class="text-sm text-zinc-400"><summary>{t('login.technicalDetails')}</summary><pre class="whitespace-pre-wrap break-all">{detail}</pre></details>
  {/if}
  <RecoveryHelp />
  <button class="nx-btn-primary w-full justify-center" disabled={busy}>{busy ? t('login.busy') : t('login.submit')}</button>
</form>
