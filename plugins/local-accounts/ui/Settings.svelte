<script lang="ts">
  import { _, isLoading } from 'svelte-i18n';
  import { getPluginText } from '$utils/plugin-i18n';
  import { onMount } from 'svelte';
  import { requestPluginControl } from '$api/client';
  import { logout } from '$stores/auth';
  import { PanelCard, LoadingIndicator, BSelect } from '$components/industrial';
  import { Input } from '$components/ui/input';
  import { Button } from '$components/ui/button';
  import { accountError } from '$components/domain/plugin/activation-state';
  const t = (key: string) => $isLoading ? '' : getPluginText(key, 'local-accounts', (id, options) => $_(id, options));
  const core = (key: string, values: Record<string, string> = {}) => $isLoading ? '' : $_(key, { values });
  let { pluginName = 'local-accounts' }: { pluginName?: string; apiBase?: string } = $props();
  let administrator = $state<{id:string;username:string;requiresPasswordChange?:boolean} | null>(null);
  let currentPassword = $state(''), password = $state(''), confirmation = $state(''), error = $state(''), detail = $state(''), busy = $state(false), loading = $state(true);
  type SessionPolicy = {idleTimeoutMinutes: number; absoluteTimeoutMinutes: number};
  type PolicyResult = {version: number; policy: SessionPolicy};
  const factors: Record<string, number> = {minutes: 1, hours: 60, days: 1440};
  const maxMinutes = Math.floor(Number.MAX_SAFE_INTEGER / 60_000);
  let durations = $state<{key: keyof SessionPolicy; label: string; value: number | undefined; unit: string}[]>([
    {key: 'idleTimeoutMinutes', label: 'session.idle', value: 30, unit: 'minutes'},
    {key: 'absoluteTimeoutMinutes', label: 'session.absolute', value: 8, unit: 'hours'},
  ]);
  let policyVersion = $state<number | null>(null), savedPolicy = $state<SessionPolicy | null>(null);
  let policyLoading = $state(true), policyBusy = $state(false), policyError = $state(''), policyDetail = $state(''), policySaved = $state(false);
  let units = $derived(['minutes', 'hours', 'days'].map(unit => ({value: unit, label: t('session.' + unit)})));
  let draftPolicy = $derived(Object.fromEntries(durations.map(field => [field.key, field.value === undefined ? NaN : field.value * factors[field.unit]!])) as SessionPolicy);
  let validPolicy = $derived(durations.every(field => Number.isSafeInteger(field.value) && field.value! >= 0)
    && Object.values(draftPolicy).every(value => Number.isSafeInteger(value) && value >= 0 && value <= maxMinutes));
  let policyDirty = $derived(savedPolicy !== null && (draftPolicy.idleTimeoutMinutes !== savedPolicy.idleTimeoutMinutes || draftPolicy.absoluteTimeoutMinutes !== savedPolicy.absoluteTimeoutMinutes));
  function applyPolicy(result: PolicyResult) {
    policyVersion = result.version; savedPolicy = result.policy;
    for (const field of durations) {
      const minutes = result.policy[field.key];
      field.unit = minutes > 0 && minutes % 1440 === 0 ? 'days' : minutes > 0 && minutes % 60 === 0 ? 'hours' : 'minutes';
      field.value = minutes / factors[field.unit]!;
    }
  }
  function policyFailure(e: unknown) {
    const result = accountError(e); policyDetail = result.detail;
    policyError = result.detail === 'version_conflict' ? 'session.conflict' : result.detail === 'invalid_session_policy' ? 'session.invalid' : 'session.failed';
  }
  async function loadPolicy() {
    if (policyBusy) return;
    policyLoading = true; policyError = ''; policyDetail = ''; policySaved = false;
    try { applyPolicy(await requestPluginControl<PolicyResult>(pluginName, '/session-policy', 'GET')); }
    catch (e) { policyFailure(e); }
    finally { policyLoading = false; }
  }
  async function savePolicy(event: SubmitEvent) {
    event.preventDefault(); if (policyBusy || policyLoading || policyVersion === null) return;
    if (!validPolicy) { policyError = 'session.invalid'; return; }
    policyBusy = true; policyError = ''; policyDetail = ''; policySaved = false;
    try {
      applyPolicy(await requestPluginControl<PolicyResult>(pluginName, '/session-policy', 'PUT', {version: policyVersion, policy: draftPolicy}));
      policySaved = true;
    } catch (e) { policyFailure(e); }
    finally { policyBusy = false; }
  }
  function failure(e: unknown) { const result = accountError(e); error = result.key; detail = result.detail; }
  onMount(() => { void requestPluginControl<{administrator: typeof administrator}>(pluginName, '/self', 'GET').then(result => { administrator = result.administrator; }).catch(failure).finally(() => { loading = false; }); });
  onMount(() => { void loadPolicy(); });
  async function change(event: SubmitEvent) {
    event.preventDefault(); if (busy) return;
    if (password !== confirmation) { failure(new Error('password_confirmation')); return; }
    if ([...password].length < 6 || [...password].length > 64) { failure(new Error('invalid_password')); return; }
    busy = true; error = ''; detail = '';
    try { await requestPluginControl(pluginName, '/password', 'POST', {currentPassword,password,passwordConfirmation:confirmation}, undefined, {preserveSessionOnUnauthorized:true}); logout(); window.location.hash = '#/login'; }
    catch(e) { failure(e); }
    finally { currentPassword = ''; password = ''; confirmation = ''; busy = false; }
  }
  async function leave() {
    if (busy) return; busy = true;
    try { await requestPluginControl(pluginName, '/logout', 'POST'); logout(); window.location.hash = '#/login'; }
    catch(e) { failure(e); } finally { busy = false; }
  }
</script>
<div class="space-y-4" data-testid="management-auth-settings">
  <PanelCard title={t('settings.accountTitle')} tag={t('settings.accountTag')}>
    {#if loading}<LoadingIndicator label={t('settings.loading')} height="sm" />{:else if administrator}<p class="text-sm text-zinc-200">{administrator.username}</p><p class="text-sm text-zinc-400 mt-2">{t('settings.accountDescription')}</p>{/if}
  </PanelCard>
  <PanelCard title={t('session.title')} tag={t('session.tag')}>
    <p class="text-sm text-zinc-400 mb-4">{t('session.description')}</p>
    {#if policyLoading}<LoadingIndicator label={t('session.loading')} height="sm" />{:else}
      <form class="space-y-3" onsubmit={savePolicy} aria-busy={policyBusy} data-testid="session-policy-form">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {#each durations as field (field.key)}
            <div class="grid gap-1 min-w-0">
              <label class="nx-field-label" for={'session-' + field.key}>{t(field.label)}</label>
              <div class="flex items-center gap-2">
                <Input id={'session-' + field.key} type="number" min={0} max={Math.floor(maxMinutes / factors[field.unit]!)} step={1} required bind:value={field.value} disabled={policyBusy || policyVersion === null} class="min-w-0 flex-1" />
                <BSelect bind:value={field.unit} options={units} ariaLabel={t(field.label) + ' · ' + t('session.unit')} width="6rem" disabled={policyBusy || policyVersion === null} />
              </div>
            </div>
          {/each}
        </div>
        <p class="text-sm text-zinc-400">{t('session.browserNote')}</p>
        <div class="flex flex-wrap gap-2">
          <Button type="submit" disabled={policyBusy || policyVersion === null || !policyDirty || !validPolicy}>{policyBusy ? t('session.saving') : t('session.save')}</Button>
          {#if policyError}<Button type="button" variant="ghost" onclick={loadPolicy} disabled={policyBusy}>{t('session.reload')}</Button>{/if}
        </div>
        {#if policySaved && !policyDirty}<p role="status" class="text-sm text-emerald-400">{t('session.saved')}</p>{/if}
      </form>
    {/if}
    {#if policyError}<p role="alert" class="text-sm text-red-400 mt-3">{t(policyError)}</p><details class="text-sm text-zinc-400"><summary>{core('pluginActivation.technicalDetails')}</summary><pre class="whitespace-pre-wrap break-all">{policyDetail}</pre></details>{/if}
  </PanelCard>
  <PanelCard title={t('settings.passwordTitle')} tag={t('settings.passwordTag')}>
    <p class="text-sm text-zinc-400 mb-4">{t('settings.passwordDescription')}</p>
    <form class="space-y-3" onsubmit={change} aria-busy={busy}>
      <label class="grid gap-1"><span class="nx-field-label">{t('settings.currentPassword')}</span><input class="nx-input" type="password" autocomplete="current-password" bind:value={currentPassword} required disabled={busy || !administrator} /></label>
      <label class="grid gap-1"><span class="nx-field-label">{t('settings.newPassword')}</span><input class="nx-input" type="password" autocomplete="new-password" bind:value={password} required disabled={busy || !administrator} /></label>
      <label class="grid gap-1"><span class="nx-field-label">{t('settings.confirmation')}</span><input class="nx-input" type="password" autocomplete="new-password" bind:value={confirmation} required disabled={busy || !administrator} /></label>
      <div class="flex gap-2"><button class="nx-btn-primary" disabled={busy || !administrator}>{busy ? t('settings.updating') : t('settings.submit')}</button><button type="button" class="nx-btn-ghost" disabled={busy || !administrator} onclick={leave}>{t('settings.logout')}</button></div>
    </form>
    {#if error}<p role="alert" class="text-sm text-red-400 mt-3">{core(error)}</p><details class="text-sm text-zinc-400"><summary>{core('pluginActivation.technicalDetails')}</summary><pre class="whitespace-pre-wrap break-all">{detail}</pre></details>{/if}
  </PanelCard>
</div>
