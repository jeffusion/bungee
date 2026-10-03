<script lang="ts">
  import { isLoading, _, locale } from 'svelte-i18n';
  import { getPluginText } from '$utils/plugin-i18n';
  import { onMount, untrack } from 'svelte';
  import { querystring } from 'svelte-spa-router';
  import { keysApi, type ApiKey, type KeyExtension } from '$api/keys';
  import { requestPluginControl } from '$api/client';
  import { Input } from '$components/ui/input';
  import { PanelCard, IndustrialDialog, LoadingIndicator, StatusBadge, BSelect, BRadioGroup, BSwitch } from '$components/industrial';
  import { canEditPolicy, keyStatus, latestRequest } from '$components/domain/credentials/policy-state';
  import { automaticBurst, changeCustomBurst, changeRateUnit, createRateDraft, draftPolicy, formatRate, unitLabel, type RatePolicy } from './rate-policy';
  let { pluginName = 'key-rate-limit' }: { pluginName?: string; apiBase?: string } = $props();
  type Row = {key:ApiKey;extension:KeyExtension|null;error:string};
  let rows = $state<Row[]>([]), loading = $state(true), saving = $state(false), error = $state(''), feedback = $state(''), search = $state('');
  let selected = $state<Row|null>(null), editOpen = $state(false), draftMode = $state('none');
  let draft = $state(createRateDraft()), unitSelection = $state('minute'), dialogError = $state(''), dialogNotice = $state(''), now = $state(Date.now());
  let initialized = $state(false);
  const guard = latestRequest();
  const t = (key:string, values?:Record<string,string|number>) => $isLoading ? '' : getPluginText(key,pluginName,(id,options) => $_(id,{...options,values}));
  const keyStatusKey = (row:Row) => ({'有效':'status.valid','已撤销':'status.revoked','已过期':'status.expired'}[keyStatus(row.key,now)]);
  const policy = (row:Row) => row.extension?.value as RatePolicy|null;
  const visible = $derived(rows.filter(row => `${row.key.name} ${row.key.prefix}`.toLowerCase().includes(search.toLowerCase().trim())));
  const number = (value:number) => value.toLocaleString($locale ?? undefined,{maximumSignificantDigits:21});
  const payload = $derived(draftPolicy(draft));
  const autoBurst = $derived(automaticBurst(draft.quantity));
  function reason(row:Row) {
    return row.error ? t(row.error) : keyStatus(row.key,now) !== '有效' ? t('reason.key',{status:t(keyStatusKey(row))}) : !row.extension?.active ? t('reason.disabled') : !row.extension.ready ? t('reason.notReady') : '';
  }
  function status(row:Row) {
    if (row.error) return 'status.loadFailed';
    if (!row.extension?.active) return 'status.disabled';
    if (!row.extension.ready) return 'status.notReady';
    if (keyStatus(row.key,now) !== '有效') return keyStatusKey(row);
    return policy(row) ? 'status.active' : 'status.unlimited';
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
  function edit(row:Row) {
    selected = row; draftMode = policy(row) ? 'limited' : 'none'; draft = createRateDraft(policy(row)); unitSelection = draft.unit; dialogError = ''; dialogNotice = ''; editOpen = true;
  }
  function selectUnit(value:string|string[]) {
    if (value !== 'minute' && value !== 'second') return;
    const next = changeRateUnit(draft,value);
    if (!next) { unitSelection = draft.unit; dialogError = 'error.unit'; return; }
    dialogNotice = !draft.customBurst && next.customBurst ? 'notice.capacity' : '';
    draft = next; dialogError = '';
  }
  async function save(event:SubmitEvent) {
    event.preventDefault();
    if (saving || !selected || !canEditPolicy(selected.key,selected.extension,Date.now())) return;
    if (draftMode === 'limited' && !payload) { dialogError = 'error.invalid'; return; }
    saving = true; dialogError = ''; feedback = '';
    try {
      await requestPluginControl(pluginName,selected.extension!.path.replace(':keyId',encodeURIComponent(selected.key.id)),'PUT',draftMode === 'none' ? null : payload);
      editOpen = false; feedback = 'feedback.saved'; await refresh();
    } catch { dialogError = 'error.save'; }
    finally { saving = false; }
  }
  $effect(() => {
    const query = $querystring;
    if (!initialized) return;
    untrack(() => {
      const id = new URLSearchParams(query).get('keyId');
      if (id) { const row = rows.find(row => row.key.id === id); if (row) edit(row); else error = 'error.missingKey'; }
    });
  });
  onMount(() => {
    let mounted = true;
    void refresh().then(() => { if (mounted) initialized = true; });
    const timer = setInterval(() => now = Date.now(),1000);
    return () => { mounted = false; guard.invalidate(); clearInterval(timer); };
  });
</script>
<div class="space-y-4" data-testid="policy-settings-rate">
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
    {:else if rows.length}<div class="overflow-x-auto"><table class="w-full text-left text-sm"><thead class="text-zinc-400"><tr><th class="px-2 py-3">{t('ui.key')}</th><th class="px-2 py-3">{t('ui.rate')}</th><th class="px-2 py-3">{t('ui.burst')}</th><th class="px-2 py-3">{t('ui.status')}</th><th class="px-2 py-3">{t('ui.actions')}</th></tr></thead><tbody>
      {#each visible as row (row.key.id)}
        <tr class="border-t border-carbon-600">
          <td class="px-2 py-3"><p class="break-all">{row.key.name}</p><p class="font-mono text-xs text-zinc-500">{row.key.prefix}…</p></td>
          <td class="px-2 py-3 whitespace-nowrap">{row.error ? '—' : policy(row) ? formatRate(policy(row)!,t,$locale ?? undefined) : t('ui.unlimited')}</td>
          <td class="px-2 py-3 whitespace-nowrap">{!row.error && policy(row) ? t('ui.requests',{count:number(policy(row)!.burst)}) : '—'}</td>
          <td class="px-2 py-3 whitespace-nowrap"><StatusBadge variant={status(row) === 'status.active' ? 'active' : 'muted'}>{t(status(row))}</StatusBadge></td>
          <td class="px-2 py-3 whitespace-nowrap"><button class="nx-btn-ghost nx-btn-sm" disabled={!!row.error} onclick={() => edit(row)}>{t('ui.edit')}</button></td>
        </tr>
      {/each}
    </tbody></table></div>{/if}
  </PanelCard>
</div>
<IndustrialDialog bind:open={editOpen} title={t('ui.editTitle',{name:selected?.key.name ?? ''})} description={t('ui.editDescription')} busy={saving} scrollBody>
  {#snippet body()}
    {#if selected}
      {#if reason(selected)}<p role="status" class="text-sm text-amber-400 mb-4">{reason(selected)}</p>{/if}
      <form id="key-rate-limit-form" onsubmit={save} class="space-y-4">
        <fieldset disabled={saving || !canEditPolicy(selected.key,selected.extension,now)} class="space-y-4">
          <BRadioGroup ariaLabel={t('ui.mode')} bind:value={draftMode} disabled={saving || !canEditPolicy(selected.key,selected.extension,now)} options={[
            {value:'none',label:t('ui.unlimited'),description:t('ui.noneDescription')},
            {value:'limited',label:t('ui.limited'),description:t('ui.limitedDescription')},
          ]} />
          {#if draftMode === 'limited'}
            <div class="grid gap-4 sm:grid-cols-2">
              <label class="block space-y-2"><span class="nx-field-label">{t('ui.quantity')}</span><Input class="rate-number" type="number" min="0" step="any" required bind:value={draft.quantity} /><span class="block text-xs text-zinc-400">{t('ui.quantityHelp')}</span></label>
              <div class="space-y-2"><span class="nx-field-label">{t('ui.unit')}</span><BSelect ariaLabel={t('ui.unit')} options={[{value:'minute',label:t('unit.minute')},{value:'second',label:t('unit.second')}]} bind:value={unitSelection} onchange={selectUnit} disabled={saving || !canEditPolicy(selected.key,selected.extension,now)} /><span class="block text-xs text-zinc-400">{t('ui.unitHelp')}</span></div>
            </div>
            <details class="space-y-3">
              <summary class="cursor-pointer text-sm text-zinc-300">{t('ui.advanced')}</summary>
              <BSwitch label={t('ui.customBurst')} checked={draft.customBurst} onchange={enabled => { draft = changeCustomBurst(draft,enabled); dialogNotice = ''; }} disabled={saving || !canEditPolicy(selected.key,selected.extension,now)} />
              {#if draft.customBurst}
                <label class="block space-y-2"><span class="nx-field-label">{t('ui.burstQuantity')}</span><Input class="rate-number" type="number" min="1" max={Number.MAX_SAFE_INTEGER} step="1" required bind:value={draft.burst} /><span class="block text-xs text-zinc-400">{t('ui.burstHelp')}</span></label>
              {:else}<p class="text-xs text-zinc-400">{t('ui.autoBurst',{count:autoBurst === undefined ? '—' : number(autoBurst)})}</p>{/if}
            </details>
            {#if dialogNotice}<p class="text-xs text-zinc-400" role="status">{t(dialogNotice)}</p>{/if}
            {#if payload}<p class="text-sm text-zinc-300" role="status">{t('ui.summary',{unit:unitLabel(draft.unit,t),quantity:number(draft.quantity!),burst:number(payload.burst)})}</p>{/if}
          {/if}
        </fieldset>
        {#if dialogError}<p role="alert" class="text-sm text-red-400">{t(dialogError)}</p>{/if}
      </form>
    {/if}
  {/snippet}
  {#snippet footer()}<button class="nx-btn-ghost" disabled={saving} onclick={() => editOpen = false}>{t('ui.cancel')}</button><button class="nx-btn-primary" form="key-rate-limit-form" disabled={saving || !selected || !canEditPolicy(selected.key,selected.extension,now)}>{saving ? t('ui.saving') : t('ui.save')}</button>{/snippet}
</IndustrialDialog>
<style>
  :global(input.rate-number) { appearance: textfield; -moz-appearance: textfield; }
  :global(input.rate-number::-webkit-inner-spin-button),
  :global(input.rate-number::-webkit-outer-spin-button) { -webkit-appearance: none; margin: 0; }
</style>
