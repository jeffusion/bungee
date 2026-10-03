<script lang="ts">
  import { _, isLoading } from 'svelte-i18n';
  import { getPluginText } from '$utils/plugin-i18n';
  import { createEventDispatcher } from 'svelte';
  import { api } from '$api/client';
  import { readAuthMode } from '$api/auth';
  import { token, csrfToken } from '$stores/auth';
  import RecoveryHelp from '$components/domain/plugin/RecoveryHelp.svelte';
  import { accountError, originMatches } from '$components/domain/plugin/activation-state';
  const t = (key: string) => $isLoading ? '' : getPluginText(key, 'local-accounts', (id, options) => $_(id, options));
  const core = (key: string, values: Record<string, string> = {}) => $isLoading ? '' : $_(key, { values });
  let { endpoint = '/api/auth/login' }: {endpoint?: string} = $props();
  const dispatch = createEventDispatcher();
  let username = $state(''), password = $state(''), busy = $state(false), error = $state(''), detail = $state(''), publicOrigin = $state('');
  async function login(event: SubmitEvent) {
    event.preventDefault(); if (busy) return;
    busy = true; error = ''; detail = '';
    try {
      const mode = await readAuthMode(); publicOrigin = mode.publicOrigin ?? '';
      if (!originMatches(mode.publicOrigin, window.location.origin)) throw new Error('invalid_origin');
      token.set(null); csrfToken.set(null);
      const result = await api.post(endpoint.replace(/^\/api/, ''), {username, password, transport:'cookie'}, {preserveSessionOnUnauthorized:true});
      dispatch('login', result);
    } catch (e) { const result = accountError(e); error = result.key; detail = result.detail; }
    finally { password = ''; busy = false; }
  }
</script>
<form onsubmit={login} aria-label={t('login.title')} aria-busy={busy} class="space-y-4">
  <h2 class="font-mono text-sm text-zinc-100">{t('login.title')}</h2>
  <p class="text-sm text-zinc-400">{t('login.description')}</p>
  <label class="grid gap-1"><span class="nx-field-label">{t('login.username')}</span><input class="nx-input" bind:value={username} autocomplete="username" required maxlength="64" disabled={busy} /></label>
  <label class="grid gap-1"><span class="nx-field-label">{t('login.password')}</span><input class="nx-input" bind:value={password} type="password" autocomplete="current-password" required disabled={busy} /></label>
  {#if error}<p role="alert" class="text-sm text-red-400">{core(error)}</p>{#if detail === 'invalid_origin' && publicOrigin}<a class="text-sm text-nexus-300 underline break-all" href={`${publicOrigin}/#/login`}>{core('pluginActivation.correctAddress', { origin: publicOrigin })}</a>{/if}<details class="text-sm text-zinc-400"><summary>{core('pluginActivation.technicalDetails')}</summary><pre class="whitespace-pre-wrap break-all">{detail}</pre></details>{/if}
  <RecoveryHelp />
  <button class="nx-btn-primary w-full justify-center" disabled={busy}>{busy ? t('login.busy') : t('login.submit')}</button>
</form>
