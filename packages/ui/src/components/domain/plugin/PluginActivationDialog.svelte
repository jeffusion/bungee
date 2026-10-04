<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { _, isLoading } from 'svelte-i18n';
  import { IndustrialDialog, LoadingIndicator } from '$components/industrial';
  import { api } from '$api/client';
  import { readAuthMode, verifyToken, type AuthMode } from '$api/auth';
  import { setPluginEnabled, type Plugin } from '$api/plugins';
  import { getConfigurationOperation, inspectTerminal, waitForConfigurationOperation } from '$api/config';
  import { token, csrfToken, beginAuthenticationHandoff } from '$stores/auth';
  import RecoveryHelp from '@plugins/local-accounts/ui/RecoveryHelp.svelte';
  import { hasManagementLoginComponent } from '$components/native-widgets';
  import { registerStaticPluginTranslations } from '$i18n/plugin-translations';
  import { accountError, originMatches } from './activation-state';
  const t = (key: string, values: Record<string, string> = {}) => $isLoading ? '' : $_(`pluginActivation.${key}`, { values });
  const errorText = (key: string) => $isLoading ? '' : $_(key);

  let { plugin, enabled, dependencies = [], onclose, oncomplete }:
    { plugin: Plugin; enabled: boolean; dependencies?: string[]; onclose: () => void; oncomplete: () => Promise<void> } = $props();
  let open = $state(true), busy = $state(false), checking = $state(!!plugin.management);
  let username = $state(''), password = $state(''), confirmation = $state('');
  let initialized = $state<boolean|null>(null);
  let mode = $state<AuthMode | null>(null), message = $state(''), detail = $state(''), stage = $state('');
  let accepted = $state(false), operationId = $state(''), complete = $state(false);
  let browserOrigin = $state('');
  let failedStage = $state('');
  const stageText = (key: string) => key ? t(`stages.${key}`, { stage: failedStage ? t(`stages.${failedStage}`) : '' }) : '';
  let endHandoff: (() => void) | undefined;
  onDestroy(() => endHandoff?.());
  const mismatch = $derived(!!plugin.management && !checking && !originMatches(mode?.publicOrigin, browserOrigin));
  const loginUnavailable = $derived(enabled && !plugin.enabled && !!plugin.management && !accepted && !complete
    && !hasManagementLoginComponent(plugin.name, plugin.management.loginComponent));
  const title = $derived(plugin.management ? enabled ? initialized === false ? t('setupTitle') : t('enableManagementTitle') : t('disableManagementTitle') : t('enablePluginTitle'));

  async function checkOrigin(loadSetup = true) {
    checking = true; message = ''; detail = '';
    try { mode = await readAuthMode(); if (loadSetup && plugin.management && enabled) initialized = (await api.get<{initialized:boolean}>(`/auth/setup?plugin=${encodeURIComponent(plugin.name)}`)).initialized; return true; }
    catch (error) { failure(error); return false; }
    finally { checking = false; }
  }
  onMount(() => { registerStaticPluginTranslations(plugin.name); browserOrigin = window.location.origin; if (plugin.management) void checkOrigin(); });
  function failure(error: unknown) { const translated = accountError(error); message = translated.key; detail = translated.detail; }
  async function establishSession() {
    stage = enabled ? 'establishingSession' : 'restoringAnonymous';
    if (enabled) {
      // Establish the cookie session without a leftover bearer credential.
      token.set(null); csrfToken.set(null);
      await api.post('/auth/login', { username, password, transport: 'cookie' }, {preserveSessionOnUnauthorized:true});
    } else { token.set(null); csrfToken.set(null); }
    const session = await verifyToken({preserveSessionOnFailure:true});
    if (!session.success) throw new Error('unauthorized');
  }
  async function waitForMode() {
    const deadline = Date.now() + 30_000;
    while (true) {
      mode = await readAuthMode();
      if (enabled ? mode.mode === 'plugin' && mode.provider?.name === plugin.name : mode.mode === 'anonymous') return;
      if (Date.now() >= deadline) throw new Error('authentication_switch_pending');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  async function finish() {
    endHandoff?.(); endHandoff = undefined;
    complete = true; stage = 'complete';
    password = ''; confirmation = '';
    await oncomplete();
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault(); if (busy || checking || mismatch || loginUnavailable || accepted || complete || (plugin.management && enabled && initialized === null)) return;
    if (plugin.management && enabled && initialized === false && password !== confirmation) { failure(new Error('password_confirmation')); return; }
    if (plugin.management && enabled && ([...password].length < 6 || [...password].length > 64)) { failure(new Error('invalid_password')); return; }
    if (plugin.management && !endHandoff) endHandoff = beginAuthenticationHandoff();
    busy = true; message = ''; detail = ''; stage = 'submitting';
    try {
      if (plugin.management) {
        mode = await readAuthMode();
        if (!originMatches(mode.publicOrigin, window.location.origin)) { stage = ''; return; }
      }
      await setPluginEnabled(plugin.name, enabled, {
        managementSetup: plugin.management && enabled ? {username, password, passwordConfirmation:initialized ? password : confirmation} : undefined,
        onAccepted: async state => {
          accepted = true; operationId = state.operation_id ?? ''; stage = 'awaitingPublication';
          if (plugin.management) { await waitForMode(); await establishSession(); stage = 'confirmingPublication'; }
        },
      });
      await finish();
    } catch (error) {
      failedStage = stage;
      failure(error);
      if (plugin.management && !accepted) {
        // The response may have been lost after commit. Public mode can prove
        // the transition happened, but cannot prove publication converged.
        try { mode = await readAuthMode(); if (enabled ? mode.mode === 'plugin' && mode.provider?.name === plugin.name : mode.mode === 'anonymous') accepted = true; } catch { /* preserve the original failure */ }
      }
      stage = accepted ? 'acceptedIncomplete' : 'unconfirmed';
      await oncomplete();
    } finally { busy = false; }
  }
  async function recover() {
    if (busy) return; busy = true; message = ''; detail = '';
    try {
      if (plugin.management) { if (!await checkOrigin(false) || mismatch) return; await waitForMode(); await establishSession(); }
      stage = 'recheckingPublication';
      if (operationId) await (inspectTerminal(await getConfigurationOperation(operationId)) ?? waitForConfigurationOperation(operationId));
      else if (accepted) {
        await oncomplete(); stage = 'sessionRecovered';
        password = ''; confirmation = ''; return;
      }
      await finish();
    } catch (error) { failure(error); stage = 'needsRecovery'; }
    finally { busy = false; }
  }
</script>

<IndustrialDialog bind:open {title} description={plugin.management ? enabled ? t('enableManagementDescription') : t('disableManagementDescription') : t('enablePluginDescription')}
  {busy} scrollBody closeLabel={t('close')} onOpenChange={(value) => { if (!value) onclose(); }}>
  {#snippet body()}
    <form id="plugin-activation" class="space-y-4" onsubmit={submit} aria-busy={busy}>
      {#if loginUnavailable}<p role="alert" class="text-sm text-amber-400">{errorText('management.loginComponentUnavailable')}</p>{/if}
      {#if dependencies.length}<p class="text-sm text-zinc-300">{t('dependencies', { names: dependencies.join(t('listSeparator')) })}</p>{/if}
      {#if plugin.management}
        {#if checking}<LoadingIndicator label={t('checkingOrigin')} size="xs" />{/if}
        {#if mismatch}<div role="alert" class="text-sm text-amber-400 space-y-2"><p>{t('originMismatch', { origin: browserOrigin })}</p>
          {#if mode?.publicOrigin}<a class="text-nexus-300 underline break-all" href={`${mode.publicOrigin}/#/plugins`}>{t('correctAddress', { origin: mode.publicOrigin })}</a>{:else}<p>{t('missingOrigin')}</p>{/if}
          <p>{t('updateOrigin')}</p></div>{/if}
        {#if enabled && initialized !== null}
          <p class="text-sm text-zinc-300">{initialized ? t('existingAccount') : t('createAccount')}</p>
          <label class="block space-y-1"><span class="nx-field-label">{t('username')}</span><input class="nx-input" bind:value={username} autocomplete="username" pattern={'[A-Za-z0-9][A-Za-z0-9_.@\\-]{0,63}'} maxlength="64" required disabled={busy || complete} /></label>
          <label class="block space-y-1"><span class="nx-field-label">{t('password')}</span><input class="nx-input" type="password" bind:value={password} autocomplete={initialized ? 'current-password' : 'new-password'} required disabled={busy || complete} /></label>
          {#if !initialized}<label class="block space-y-1"><span class="nx-field-label">{t('confirmation')}</span><input class="nx-input" type="password" bind:value={confirmation} autocomplete="new-password" required disabled={busy || complete} /></label>{/if}
          {#if initialized && plugin.name === 'local-accounts'}<RecoveryHelp />{/if}
        {:else if !enabled}
          <p class="text-sm text-zinc-300">{t('disableAccountHelp')}</p>
        {/if}
      {/if}
      {#if stage}<p role="status" class="text-sm text-zinc-300">{stageText(stage)}</p>{/if}

      {#if message}<p role="alert" class="text-sm text-red-400">{errorText(message)}</p><details class="text-sm text-zinc-400"><summary>{t('technicalDetails')}</summary><pre class="whitespace-pre-wrap break-all">{detail}</pre></details>{/if}
      {#if accepted && !complete && !busy}<p class="text-sm text-amber-400">{t('acceptedHelp')}</p>{/if}
    </form>
  {/snippet}
  {#snippet footer()}
    {#if !complete && !accepted}<button class="nx-btn-ghost" disabled={busy} onclick={() => { open = false; onclose(); }}>{t('cancel')}</button>{/if}
    {#if complete}<button class="nx-btn-primary" onclick={() => { open = false; onclose(); }}>{t('done')}</button>
    {:else if accepted}<button class="nx-btn-primary" disabled={busy || checking || mismatch} onclick={recover}>{busy ? t('recovering') : t('retry')}</button>
    {:else}<button form="plugin-activation" class="nx-btn-primary" disabled={busy || checking || mismatch || loginUnavailable || (plugin.management && enabled && initialized === null)}>{busy ? t('processing') : !enabled ? t('disable') : plugin.management ? initialized ? t('verifyEnable') : t('createEnable') : t('enable')}</button>{/if}
    {#if mismatch || (message && !accepted)}<button class="nx-btn-ghost" disabled={busy} onclick={() => checkOrigin()}>{t('checkAddress')}</button>{/if}
  {/snippet}
</IndustrialDialog>
