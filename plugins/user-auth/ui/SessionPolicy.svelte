<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { _, isLoading } from 'svelte-i18n';
  import { requestPluginControl } from '$api/client';
  import { IndustrialDialog, BSelect } from '$components/industrial';
  import { NumberInput } from '$components/ui/number-input';
  import { Button } from '$components/ui/button';
  import * as Dialog from '$components/ui/dialog';
  import SettingsSection from './SettingsSection.svelte';
  let { pluginName }: { pluginName: string } = $props();
  const t = (key: string) => $isLoading ? '' : $_(`plugins.user-auth.${key}`);
  type SessionPolicy = {idleTimeoutMinutes: number; absoluteTimeoutMinutes: number};
  type PolicyResult = {version: number; policy: SessionPolicy};
  const factors: Record<string, number> = {minutes: 1, hours: 60, days: 1440};
  const maxMinutes = 43200;
  const id = $props.id();
  let returnFocus = $state<HTMLElement | null>(null);
  let open = $state(false);
  let durations = $state<{key: keyof SessionPolicy; label: string; value: number | undefined; unit: string}[]>([
    {key: 'idleTimeoutMinutes', label: 'session.idle', value: 30, unit: 'minutes'},
    {key: 'absoluteTimeoutMinutes', label: 'session.absolute', value: 8, unit: 'hours'},
  ]);
  let policyVersion = $state<number | null>(null), savedPolicy = $state<SessionPolicy | null>(null);
  let policyLoading = $state(true), policyBusy = $state(false), policyError = $state(''), policyDetail = $state(''), policySaved = $state(false);
  let units = $derived(['minutes', 'hours', 'days'].map(unit => ({value: unit, label: t('session.' + unit)})));
  let draftPolicy = $derived(Object.fromEntries(durations.map(field => [field.key, field.value === undefined ? NaN : field.value * factors[field.unit]!])) as SessionPolicy);
  let validPolicy = $derived(durations.every(field => Number.isSafeInteger(field.value) && field.value! >= 0)
    && Object.values(draftPolicy).every(value => Number.isSafeInteger(value) && value >= 0 && value <= maxMinutes) && draftPolicy.absoluteTimeoutMinutes > 0);
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
    const detail = e instanceof Error ? e.message : String(e); const result = {detail}; policyDetail = detail;
    policyError = result.detail === 'version_conflict' ? 'session.conflict' : result.detail === 'invalid_session_policy' ? 'session.invalid' : 'session.failed';
  }
  async function loadPolicy() {
    if (policyBusy) return;
    policyLoading = true; policyError = ''; policyDetail = ''; policySaved = false;
    try { applyPolicy(await requestPluginControl<PolicyResult>(pluginName, '/session-policy', 'GET')); }
    catch (e) { policyFailure(e); }
    finally { policyLoading = false; await tick(); if (open) document.getElementById('session-idleTimeoutMinutes')?.focus(); }
  }
  async function savePolicy(event: SubmitEvent) {
    event.preventDefault(); if (policyBusy || policyLoading || policyVersion === null) return;
    if (!validPolicy) { policyError = 'session.invalid'; return; }
    policyBusy = true; policyError = ''; policyDetail = ''; policySaved = false;
    try {
      applyPolicy(await requestPluginControl<PolicyResult>(pluginName, '/session-policy', 'PUT', {version: policyVersion, policy: draftPolicy}));
      policySaved = true; open = false; await tick(); returnFocus?.focus();
    } catch (e) { policyFailure(e); }
    finally { policyBusy = false; await tick(); if (open) document.getElementById('session-idleTimeoutMinutes')?.focus(); }
  }
  function edit() {
    returnFocus = document.getElementById(id + '-edit');
    if (!savedPolicy || policyVersion === null) return;
    applyPolicy({version: policyVersion, policy: savedPolicy});
    policyError = ''; policyDetail = ''; policySaved = false; open = true;
  }
  function close() {
    open = false; policyError = ''; policyDetail = '';
    if (savedPolicy && policyVersion !== null) applyPolicy({version: policyVersion, policy: savedPolicy});
  }
  function formatDuration(minutes: number) {
    if (!minutes) return t('session.noIdleTimeout');
    const unit = minutes % 1440 === 0 ? 'days' : minutes % 60 === 0 ? 'hours' : 'minutes';
    return `${minutes / factors[unit]!} ${t('session.' + unit)}`;
  }
  onMount(() => { void loadPolicy(); });
</script>

{#snippet actions()}<Button id={id + '-edit'} variant="ghost" disabled={policyLoading || !savedPolicy} onclick={edit}>{t('admin.edit')}</Button>{/snippet}
<SettingsSection title={t('session.title')} {actions}>
  {#if policyLoading}<p class="text-sm text-zinc-400">{t('session.loading')}</p>
  {:else if savedPolicy}<p class="text-sm text-zinc-400" data-testid="session-policy-summary">{t('session.idle')} {formatDuration(savedPolicy.idleTimeoutMinutes)} · {t('session.absolute')} {formatDuration(savedPolicy.absoluteTimeoutMinutes)}</p>{/if}
  {#if policySaved && !open}<p role="status" class="mt-2 text-sm text-emerald-400">{t('session.saved')}</p>{/if}
  {#if policyError && !open}<p role="alert" class="text-sm text-red-400">{t(policyError)}</p><Button variant="ghost" onclick={loadPolicy} disabled={policyLoading}>{t('session.reload')}</Button>{/if}
</SettingsSection>

{#snippet body()}
  <form id={id + '-policy'} class="space-y-4" onsubmit={savePolicy} aria-busy={policyBusy} data-testid="session-policy-form">
    {#each durations as field (field.key)}
      <div class="grid gap-1 min-w-0">
        <label class="nx-field-label" for={'session-' + field.key}>{t(field.label)}</label>
        <div class="flex items-center gap-2">
          <NumberInput id={'session-' + field.key} min={field.key === 'absoluteTimeoutMinutes' ? 1 : 0} max={Math.floor(maxMinutes / factors[field.unit]!)} increaseLabel={t('session.increase')} decreaseLabel={t('session.decrease')} invalidMessage={t('session.invalid')} required bind:value={field.value} disabled={policyBusy || policyLoading || policyVersion === null} class="min-w-0 flex-1" />
          <BSelect bind:value={field.unit} options={units} ariaLabel={t(field.label) + ' · ' + t('session.unit')} width="w-28 shrink-0" disabled={policyBusy || policyLoading || policyVersion === null} />
        </div>
      </div>
    {/each}
    {#if policyError}<p role="alert" class="text-sm text-red-400">{t(policyError)}</p><details class="text-sm text-zinc-400"><summary>{t('login.technicalDetails')}</summary><pre class="whitespace-pre-wrap break-all">{policyDetail}</pre></details>{/if}
  </form>
{/snippet}
{#snippet footer()}
  {#if policyError}<Button variant="ghost" onclick={loadPolicy} disabled={policyBusy || policyLoading}>{t('session.reload')}</Button>{/if}
  <Dialog.Close asChild let:builder><Button builders={[builder]} variant="ghost" disabled={policyBusy || policyLoading}>{t('admin.cancel')}</Button></Dialog.Close>
  <Button type="submit" form={id + '-policy'} disabled={policyBusy || policyLoading || policyVersion === null || !policyDirty || !validPolicy}>{policyBusy ? t('session.saving') : t('session.save')}</Button>
{/snippet}
<IndustrialDialog bind:open {returnFocus} title={t('session.title')} description={t('session.description')} busy={policyBusy || policyLoading} closeLabel={t('admin.close')} {body} {footer} onOpenChange={value => {if (!value) close();}} />
