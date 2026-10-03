<script lang="ts">
  import { budgetUsed, formatBudget, formatBudgetPeriod, formatBudgetDate, periodLabels, statisticsLink, type BudgetPolicy as Policy, type BudgetUsage as Usage } from './budget-view';
  import { isLoading, _, locale } from 'svelte-i18n';
  import { getPluginText } from '$utils/plugin-i18n';
  import { onMount } from 'svelte';
  import { querystring } from 'svelte-spa-router';
  import { keysApi, type ApiKey, type KeyExtension } from '$api/keys';
  import { requestPluginControl } from '$api/client';
  import { Input } from '$components/ui/input';
  import { PanelCard, IndustrialDialog, LoadingIndicator, StatusBadge, BSelect, BRadioGroup } from '$components/industrial';
  import { canEditPolicy, keyStatus, latestRequest } from '$components/domain/credentials/policy-state';
  let { pluginName = 'token-budget' }: { pluginName?: string; apiBase?: string } = $props();
  type Row = {key:ApiKey;extension:KeyExtension|null;error:string};
  let rows = $state<Row[]>([]), loading = $state(true), saving = $state(false), error = $state(''), feedback = $state(''), search = $state('');
  let selected = $state<Row|null>(null), editOpen = $state(false), usageOpen = $state(false), draftMode = $state('none'), draftUnit = $state('usd'), draftLimit = $state<number|undefined>(undefined), dialogError = $state('');
  let now = $state(Date.now());
  const guard = latestRequest();
  const t = (key:string, values?:Record<string,string|number>) => $isLoading ? '' : getPluginText(key,pluginName,(id,options) => $_(id,{...options,values}));
  const keyStatusKey = (row:Row) => ({'有效':'status.valid','已撤销':'status.revoked','已过期':'status.expired'}[keyStatus(row.key,now)]);
  const number = (value:number,unit='tokens') => formatBudget(value,unit,$locale ?? undefined);
  const unitLabel = (unit:string|undefined) => t(unit === 'usd' ? 'unit.usd' : 'unit.tokens');
  const periodLabel = (mode:string) => t(periodLabels[mode]);
  const periodDate = (mode:Exclude<Policy['mode'],'cumulative'>) => formatBudgetPeriod(mode,now,$locale ?? undefined);
  const collectionDate = (value:number) => formatBudgetDate(value,$locale ?? undefined);
  const policy = (row:Row) => row.extension?.value as Policy|null;
  const usage = (row:Row) => row.extension?.usage as Usage|undefined;
  const visible = $derived(rows.filter(row => `${row.key.name} ${row.key.prefix}`.toLowerCase().includes(search.toLowerCase().trim())));
  const selectedUsage = $derived(selected ? usage(selected) : undefined);
  const draftUsed = $derived(budgetUsed(selected ? usage(selected) : undefined,draftMode,draftUnit,now));
  function used(row:Row) { return budgetUsed(usage(row),policy(row)?.mode ?? 'cumulative',policy(row)?.unit ?? 'tokens',now); }
  function unknown(row:Row) { return Object.values(policy(row)?.unit === 'usd' ? usage(row)?.money?.unresolved ?? {} : usage(row)?.unresolved ?? {}).includes('unknown'); }
  function reason(row:Row) {
    return row.error ? t(row.error) : keyStatus(row.key,now) !== '有效' ? t('reason.key',{status:t(keyStatusKey(row))}) : !row.extension?.active ? t('reason.disabled') : !row.extension.ready ? t('reason.notReady') : '';
  }
  function budgetStatus(row:Row) {
    if (row.error) return 'status.loadFailed';
    if (!row.extension?.active) return 'status.disabled';
    if (!row.extension.ready) return 'status.notReady';
    if (keyStatus(row.key,now) !== '有效') return keyStatusKey(row);
    if (!policy(row)) return 'status.unlimited';
    if (unknown(row)) return 'status.unknown';
    return used(row) >= policy(row)!.limit ? 'status.exhausted' : 'status.active';
  }
  async function refresh() {
    const generation = guard.begin(); loading = true; error = '';
    try {
      const keys = (await keysApi.list()).keys;
      const next = await Promise.all(keys.map(async key => {
        try {
          const extension = (await keysApi.extensions(key.id)).extensions.find(item => item.plugin === pluginName) ?? null;
          return {key,extension,error:extension ? '' : 'error.load'};
        } catch { return {key,extension:null,error:'error.load'}; }
      }));
      if (guard.current(generation)) { rows = next; if (selected) selected = next.find(row => row.key.id === selected!.key.id) ?? null; }
    } catch { if (guard.current(generation)) error = 'error.keys'; }
    finally { if (guard.current(generation)) loading = false; }
  }
  function edit(row:Row) { selected = row; draftMode = policy(row)?.mode ?? 'none'; draftUnit = policy(row) ? policy(row)!.unit ?? 'tokens' : 'usd'; draftLimit = policy(row)?.limit; dialogError = ''; editOpen = true; }
  async function save(event:SubmitEvent) {
    event.preventDefault();
    if (saving || !selected || !canEditPolicy(selected.key,selected.extension,Date.now())) return;
    if (draftMode !== 'none' && (!draftLimit || !Number.isFinite(draftLimit) || draftLimit <= 0 || (draftUnit === 'tokens' ? !Number.isSafeInteger(draftLimit) : Number(draftLimit.toFixed(6)) !== draftLimit || !Number.isSafeInteger(Math.round(draftLimit*1e9))))) { dialogError = draftUnit === 'usd' ? 'error.usd' : 'error.tokens'; return; }
    saving = true; dialogError = ''; feedback = '';
    try {
      await requestPluginControl(pluginName,selected.extension!.path.replace(':keyId',encodeURIComponent(selected.key.id)),'PUT',draftMode === 'none' ? null : {mode:draftMode,unit:draftUnit,limit:draftLimit});
      editOpen = false; feedback = 'feedback.saved'; await refresh();
    } catch { dialogError = 'error.save'; }
    finally { saving = false; }
  }
  onMount(() => {
    let mounted = true;
    void refresh().then(() => { if (!mounted) return; const id = new URLSearchParams($querystring).get('keyId'); if (id) { const row = rows.find(row => row.key.id === id); if (row) { selected = row; usageOpen = true; } else error = 'error.missingKey'; } });
    const timer = setInterval(() => now = Date.now(),1000);
    return () => { mounted = false; guard.invalidate(); clearInterval(timer); };
  });
</script>
<div class="space-y-4" data-testid="policy-settings-budget">
  <PanelCard title={t('ui.title')} tag={t('ui.tag')}>
    <div class="space-y-3 mb-4">
      <p class="text-sm text-zinc-300">{t('ui.description')}</p>
      <p class="text-sm text-zinc-400">{t('ui.behavior')}</p>
      <div class="flex flex-wrap items-center gap-3">
        <label class="flex-1 min-w-0"><span class="sr-only">{t('ui.search')}</span><Input placeholder={t('ui.searchPlaceholder')} bind:value={search} /></label>
        <button class="nx-btn-ghost" disabled={loading || saving} onclick={refresh}>{t('ui.refresh')}</button>
        <a class="nx-btn-ghost" href="/#/plugins/key-access/settings">{t('ui.manageKeys')}</a>
      </div>
    </div>
    {#if feedback}<p role="status" class="text-sm text-emerald-400 mb-3">{t(feedback)}</p>{/if}
    {#if error}<p role="alert" class="text-sm text-red-400 mb-3">{t(error)}</p>{/if}
    {#if loading}<LoadingIndicator label={t('ui.loading')} height="sm" />
    {:else if !rows.length && !error}<p class="text-sm text-zinc-400 py-4">{t('ui.empty')}</p>
    {:else if rows.length && !visible.length}<p class="text-sm text-zinc-400 py-4">{t('ui.noMatches')}</p>
    {:else if rows.length}<div class="overflow-x-auto"><table class="w-full text-left text-sm"><thead class="text-zinc-400"><tr><th class="px-2 py-3">{t('ui.key')}</th><th class="px-2 py-3">{t('ui.budget')}</th><th class="px-2 py-3">{t('ui.usedRemaining')}</th><th class="px-2 py-3">{t('ui.status')}</th><th class="px-2 py-3">{t('ui.actions')}</th></tr></thead><tbody>
      {#each visible as row (row.key.id)}
        <tr class="border-t border-carbon-600">
          <td class="px-2 py-3"><p class="break-all">{row.key.name}</p><p class="font-mono text-xs text-zinc-500">{row.key.prefix}…</p></td>
          <td class="px-2 py-3 whitespace-nowrap">{#if row.error}—{:else if policy(row)}<p>{number(policy(row)!.limit,policy(row)!.unit)} {unitLabel(policy(row)!.unit)}</p><p class="text-xs text-zinc-400">{periodLabel(policy(row)!.mode)} · {policy(row)!.mode === 'cumulative' ? t('ui.noReset') : periodDate(policy(row)!.mode as Exclude<Policy['mode'],'cumulative'>)}</p>{:else}{t('ui.unlimited')}{/if}</td>
          <td class="px-2 py-3 whitespace-nowrap">{#if !row.error && policy(row)}<p>{t('ui.usedValue',{value:number(used(row),policy(row)!.unit)})}</p><p class="text-xs text-zinc-400">{t('ui.remainingValue',{value:number(Math.max(0,policy(row)!.limit-used(row)),policy(row)!.unit)})}</p>{:else}—{/if}</td>
          <td class="px-2 py-3 whitespace-nowrap"><StatusBadge variant={budgetStatus(row) === 'status.active' ? 'active' : ['status.unknown','status.exhausted'].includes(budgetStatus(row)) ? 'standby' : 'muted'}>{t(budgetStatus(row))}</StatusBadge></td>
          <td class="px-2 py-3"><div class="flex gap-2 whitespace-nowrap"><button class="nx-btn-ghost nx-btn-sm" disabled={!!row.error} onclick={() => edit(row)}>{t('ui.edit')}</button><button class="nx-btn-ghost nx-btn-sm" disabled={!!row.error} onclick={() => { selected = row; usageOpen = true; }}>{t('ui.viewUsage')}</button></div></td>
        </tr>
      {/each}
    </tbody></table></div>{/if}
  </PanelCard>
</div>
<IndustrialDialog bind:open={editOpen} title={t('ui.editTitle',{name:selected?.key.name ?? ''})} description={t('ui.editDescription')} busy={saving} scrollBody>
  {#snippet body()}
    {#if selected}
      {#if reason(selected)}<p role="status" class="text-sm text-amber-400 mb-4">{reason(selected)}</p>{/if}
      <form id="token-budget-form" onsubmit={save} class="space-y-4">
        <fieldset disabled={saving || !canEditPolicy(selected.key,selected.extension,now)} class="space-y-4">
          <div class="space-y-2"><span class="nx-field-label">{t('ui.unit')}</span><BSelect ariaLabel={t('ui.unit')} options={[{value:'tokens',label:t('ui.tokensOption')},{value:'usd',label:t('ui.usdOption')}]} bind:value={draftUnit} disabled={saving || !canEditPolicy(selected.key,selected.extension,now)} /></div>
          {#if draftUnit === 'usd'}<p class="text-sm text-zinc-400">{t('ui.usdHelp')}</p>{/if}
          <div class="space-y-2"><span class="nx-field-label">{t('ui.period')}</span>
            <BRadioGroup ariaLabel={t('ui.period')} bind:value={draftMode} disabled={saving || !canEditPolicy(selected.key,selected.extension,now)} options={[
              {value:'none',label:t('ui.unlimited'),description:t('ui.noneDescription')},
              {value:'daily',label:t('ui.daily'),description:t('ui.dailyDescription')},
              {value:'weekly',label:t('ui.weekly'),description:t('ui.weeklyDescription')},
              {value:'monthly',label:t('ui.monthly'),description:t('ui.monthlyDescription')},
              {value:'cumulative',label:t('ui.cumulative'),description:t('ui.cumulativeDescription')},
            ]} />
          </div>
          {#if draftMode !== 'none'}
            <label class="block space-y-2"><span class="nx-field-label">{draftUnit === 'usd' ? t('ui.usdLimit') : t('ui.tokenLimit')}</span><Input class="budget-limit" type="number" min={draftUnit === 'usd' ? 0.000001 : 1} max={draftUnit === 'usd' ? 9007199.25474 : Number.MAX_SAFE_INTEGER} step={draftUnit === 'usd' ? 0.000001 : 1} required bind:value={draftLimit} /></label>
            <p class="text-sm text-zinc-400">{t('ui.recorded',{period:periodLabel(draftMode),value:number(draftUsed,draftUnit),unit:unitLabel(draftUnit)})}</p>
            {#if draftLimit && draftLimit <= draftUsed}<p role="alert" class="text-sm text-amber-400">{t('ui.exhaustedWarning')}</p>{/if}
          {/if}
        </fieldset>
        <p class="text-sm text-zinc-400">{t('ui.history')}</p>
        {#if dialogError}<p role="alert" class="text-sm text-red-400">{t(dialogError)}</p>{/if}
      </form>
    {/if}
  {/snippet}
  {#snippet footer()}<button class="nx-btn-ghost" disabled={saving} onclick={() => editOpen = false}>{t('ui.cancel')}</button><button class="nx-btn-primary" form="token-budget-form" disabled={saving || !selected || !canEditPolicy(selected.key,selected.extension,now)}>{saving ? t('ui.saving') : t('ui.save')}</button>{/snippet}
</IndustrialDialog>
<IndustrialDialog bind:open={usageOpen} title={t('ui.usageTitle',{name:selected?.key.name ?? ''})} description={t('ui.usageDescription')} width="40rem" scrollBody>
  {#snippet body()}
    {#if selected}
      <div class="space-y-4">
        {#if policy(selected)}<div class="grid grid-cols-2 gap-4"><div><p class="nx-field-label">{t('ui.periodUsed',{period:periodLabel(policy(selected)!.mode)})}</p><p class="font-mono text-xl text-zinc-200 mt-2">{number(used(selected),policy(selected)!.unit)} <span class="text-xs">{unitLabel(policy(selected)!.unit)}</span></p></div><div><p class="nx-field-label">{t('ui.remaining')}</p><p class="font-mono text-xl text-zinc-200 mt-2">{number(Math.max(0,policy(selected)!.limit-used(selected)),policy(selected)!.unit)} <span class="text-xs">{unitLabel(policy(selected)!.unit)}</span></p></div></div>{:else}<p class="text-sm text-zinc-300">{t('ui.noBudget')}</p>{/if}
        {#if unknown(selected)}<p role="alert" class="text-sm text-amber-400">{t('ui.unknownWarning')}</p>{/if}
        <p class="text-sm text-zinc-400">{t('ui.ledgerHelp')}</p>
        {#if selectedUsage?.collection?.legacyTokensExcluded}<p class="text-sm text-amber-400">{t('ui.legacyWarning')}</p>{/if}
        {#if selectedUsage?.collection?.dailyWeeklyStartedAtMs}<p class="text-xs text-zinc-400">{t('ui.dailyWeeklyStarted',{date:collectionDate(selectedUsage.collection.dailyWeeklyStartedAtMs)})}</p>{/if}
        {#if selectedUsage?.collection?.moneyStartedAtMs}<p class="text-xs text-zinc-400">{t('ui.moneyStarted',{date:collectionDate(selectedUsage.collection.moneyStartedAtMs)})}</p>{/if}
        <p class="text-sm text-zinc-400">{t('ui.statisticsHelp')}</p>
      </div>
    {/if}
  {/snippet}
  {#snippet footer()}<button class="nx-btn-ghost" onclick={() => usageOpen = false}>{t('ui.close')}</button>{#if selected}<a class="nx-btn-primary" href={statisticsLink(selected.key.id)}>{t('ui.statistics')}</a>{/if}{/snippet}
</IndustrialDialog>

<style>
  :global(input.budget-limit) { appearance: textfield; -moz-appearance: textfield; }
  :global(input.budget-limit::-webkit-inner-spin-button),
  :global(input.budget-limit::-webkit-outer-spin-button) { -webkit-appearance: none; margin: 0; }
</style>
