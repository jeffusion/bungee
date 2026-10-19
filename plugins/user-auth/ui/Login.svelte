<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { isLoading } from 'svelte-i18n';
  import { _, isManagementLoginStaleError, type ManagementLoginContext } from '@bungee/plugin-sdk';
  import TurnstileChallenge from './TurnstileChallenge.svelte';
  import RecoveryHelp from './RecoveryHelp.svelte';
  import type { LoginProvider } from './contracts';
  import { loginFailure, requireLoginSuccess } from './login-errors';

  let { context }: { context: ManagementLoginContext } = $props();
  const t = (key: string, values: Record<string, string> = {}) => $isLoading ? '' : $_(`plugins.user-auth.${key}`, { values });
  let username = $state(''), password = $state(''), busy = $state(false);
  let error = $state(''), detail = $state('');
  type LoginOptions = {local: {enabled: true; turnstile: {enabled: boolean; siteKey?: string}}; methods: {id: string; label: string; provider: LoginProvider}[]};
  let options = $state<LoginOptions | null>(null), optionsBusy = $state(true), token = $state(''), resetKey = $state(0);
  let destroyed = false;
  async function loadOptions() {
    optionsBusy = true; error = ''; detail = '';
    const activeContext = context;
    try {
      const result = await activeContext.loginOptions<LoginOptions>();
      if (destroyed || context !== activeContext) return;
      if (!result?.local || result.local.enabled !== true || typeof result.local.turnstile?.enabled !== 'boolean' || !Array.isArray(result.methods)
        || result.methods.some(item => !item || typeof item.id !== 'string' || !item.id || typeof item.label !== 'string' || !item.label || !['google', 'microsoft', 'github', 'oidc'].includes(item.provider))
        || (result.local.turnstile.enabled && !result.local.turnstile.siteKey)) throw new Error('provider_unavailable');
      options = result;
    } catch (cause) { if (!destroyed && context === activeContext && !isManagementLoginStaleError(cause)) { const failure = loginFailure(cause); error = failure.key; detail = failure.detail; } }
    finally { if (!destroyed && context === activeContext) optionsBusy = false; }
  }
  onMount(() => {
    void loadOptions().then(() => {
      const code = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('oidcError');
      if (code && !destroyed) { const failure = loginFailure(new Error(code)); error = failure.key; detail = failure.key === 'login.errors.unknown' ? 'oidc_failed' : failure.detail; }
    });
  });
  async function begin(methodId: string) {
    if (busy) return; busy = true; error = ''; detail = '';
    const activeContext = context;
    try {
      const result = await activeContext.beginLogin({methodId});
      if (destroyed || context !== activeContext) return;
      const url = new URL(result.authorizationUrl);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('oidc_failed');
      window.location.assign(url.href);
    } catch (cause) { if (!destroyed && context === activeContext && !isManagementLoginStaleError(cause)) { const failure = loginFailure(cause); error = failure.key; detail = failure.detail; } }
    finally { if (!destroyed && context === activeContext) busy = false; }
  }
  onDestroy(() => { destroyed = true; });

  async function login(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    if (!options || optionsBusy || (options.local.turnstile.enabled && !token)) return;
    const activeContext = context;
    busy = true; error = ''; detail = '';
    try {
      const result = await activeContext.login({ username, password, transport: 'cookie', ...(options.local.turnstile.enabled ? { turnstileToken: token } : {}) });
      if (destroyed || context !== activeContext || result === undefined) return;
      requireLoginSuccess(result);
      await activeContext.complete();
    } catch (cause) {
      if (destroyed || context !== activeContext || isManagementLoginStaleError(cause)) return;
      const failure = loginFailure(cause);
      error = failure.key; detail = failure.detail;
    } finally {
      password = ''; token = ''; resetKey++;
      if (!destroyed && context === activeContext) busy = false;
    }
  }
</script>

<form onsubmit={login} aria-label={t('login.title')} aria-busy={busy} class="space-y-4">
  <label class="grid gap-1"><span class="nx-field-label">{t('login.username')}</span><input class="nx-input" bind:value={username} autocomplete="username" required maxlength="64" disabled={busy} /></label>
  <label class="grid gap-1"><span class="nx-field-label">{t('login.password')}</span><input class="nx-input" bind:value={password} type="password" autocomplete="current-password" required disabled={busy} /></label>
  {#if error}
    <p role="alert" class="text-sm text-red-400">{t(error)}</p>
    {#if detail === 'invalid_origin' && context.provider.publicOrigin}<a class="text-sm text-nexus-300 underline break-all" href={`${context.provider.publicOrigin}/#/login`}>{t('login.correctAddress', { origin: context.provider.publicOrigin })}</a>{/if}
    <details class="text-sm text-zinc-400"><summary>{t('login.technicalDetails')}</summary><pre class="whitespace-pre-wrap break-all">{detail}</pre></details>
  {/if}
  {#if options?.local.turnstile.enabled && options.local.turnstile.siteKey}<TurnstileChallenge siteKey={options.local.turnstile.siteKey} {resetKey} onToken={value => { token = value; }} retryLabel={t('login.retryChallenge')} failureLabel={t('login.challengeFailed')} />{/if}
  {#if !options && !optionsBusy}<button type="button" class="nx-btn-ghost" onclick={loadOptions}>{t('session.reload')}</button>{/if}
  <RecoveryHelp />
  <button class="nx-btn-primary w-full justify-center" disabled={busy || optionsBusy || !options || (options.local.turnstile.enabled && !token)}>{busy ? t('login.busy') : t('login.submit')}</button>
</form>
{#if options?.methods.length}<div class="mt-4 grid gap-3" aria-label={t('login.methods')}>
  {#each options.methods as connection (connection.id)}<button type="button" class="nx-btn-ghost w-full justify-center gap-2 break-words" aria-label={`${connection.label} · ${t('providers.' + connection.provider)}`} disabled={busy} onclick={() => begin(connection.id)}><span>{connection.label}</span><span class="text-sm text-zinc-400">{t('providers.' + connection.provider)}</span></button>{/each}
</div>{/if}
