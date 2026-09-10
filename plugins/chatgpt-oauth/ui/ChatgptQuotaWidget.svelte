<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { requestPluginControl } from '$api/client';
  import { _, locale } from '$i18n';
  import { isLoading } from 'svelte-i18n';
  import { getPluginText } from '$utils/plugin-i18n';
  import type { NativeWidgetHeaderChange } from '$components/native-widgets/widget-header';
  import { LoadingIndicator, MetricBar, StatusBadge } from '$components/industrial';
  import { accountSummary, accountUsage, errorText } from './account-model.js';

  let { pluginName = 'chatgpt-oauth', onHeaderChange }: { pluginName?: string; selectedRange?: string; onHeaderChange?: NativeWidgetHeaderChange } = $props();
  type Row = { account: ReturnType<typeof accountSummary>; usage?: ReturnType<typeof accountUsage>; error?: string };
  let rows = $state<Row[]>([]), busy = $state(true), loaded = $state(false), notice = $state('');
  let generation = 0, disposed = false, controller: AbortController | undefined;
  const t = (key: string, values: Record<string, string | number> = {}) => $isLoading ? '' : getPluginText(key, pluginName, (key, options) => $_(key, { ...options, values }));
  const dateText = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8640000000000000
    ? new Date(value).toLocaleString($locale ?? 'en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : t('ui.widgetResetUnknown');
  const validPercent = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
  function windowLabel(seconds: unknown) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return t('ui.usageWindow');
    if (seconds === 18000) return t('ui.fiveHourLimit');
    if (seconds === 604800) return t('ui.weekLimit');
    if (seconds % 86400 === 0) return t('ui.dayLimit', { count: seconds / 86400 });
    if (seconds % 3600 === 0) return t('ui.hourLimit', { count: seconds / 3600 });
    return t('ui.widgetMinuteLimit', { count: Math.round(seconds / 60) });
  }
  function creditCount(row: Row) {
    if (!row.usage) return undefined;
    for (const state of ['fresh', 'stale']) {
      for (const section of [row.usage.resetCredits, row.usage.usage]) {
        if (section.state === state && section.value?.availableCount !== undefined) return section.value.availableCount;
      }
    }
    return undefined;
  }
  function usageState(row: Row) {
    if (row.account.status !== 'active') return 'unavailable';
    const hasSnapshot = !!(row.usage?.usage.value || row.usage?.resetCredits.value);
    if (row.error || (notice && notice !== 'ui.widgetPartialAccounts')) return hasSnapshot ? 'stale' : 'unavailable';
    if (!row.usage) return busy ? 'loading' : 'unavailable';
    if (!hasSnapshot) return 'unavailable';
    const { usage, resetCredits } = row.usage;
    if (usage.state === 'stale' || resetCredits.state === 'stale') return 'stale';
    if (usage.state === 'unavailable' && resetCredits.state === 'unavailable') return 'stale';
    const windows = [usage.value?.primary, usage.value?.secondary].filter(Boolean);
    if (usage.state !== 'fresh' || resetCredits.state !== 'fresh' || !windows.length || windows.some(window => !validPercent(window?.usedPercent)) || creditCount(row) === undefined) return 'partial';
    return 'fresh';
  }
  async function refresh() {
    if (disposed) return;
    const current = ++generation, owner = pluginName;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const latest = () => !disposed && !signal.aborted && current === generation && owner === pluginName;
    const get = (path: string) => requestPluginControl<unknown>(owner, path, 'GET', undefined, signal);
    busy = true; notice = '';
    try {
      const response = await get('/accounts') as { accounts?: unknown[] };
      if (!latest()) return;
      if (!response || !Array.isArray(response.accounts)) throw new Error('invalid_response');
      const next: Row[] = [];
      const seen = new Set<string>();
      for (const value of response.accounts) {
        try {
          const account = accountSummary(value);
          if (!account.id || seen.has(account.id)) throw new Error('invalid_response');
          seen.add(account.id);
          next.push({ account, usage: account.status === 'active' ? rows.find(row => row.account.id === account.id)?.usage : undefined });
        } catch { notice = 'ui.widgetPartialAccounts'; }
      }
      rows = next; loaded = true;
      let cursor = 0;
      const worker = async () => {
        while (latest() && cursor < next.length) {
          const index = cursor++, row = next[index];
          if (row.account.status !== 'active') continue;
          try {
            const usage = accountUsage(await get(`/accounts/usage?accountRef=${encodeURIComponent(row.account.id)}`));
            if (latest()) rows[index] = { account: row.account, usage };
          } catch (error) {
            if (latest()) rows[index] = { ...row, error: errorText(error) };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, next.length) }, worker));
    } catch (error) { if (latest()) notice = errorText(error); }
    finally { if (latest()) busy = false; }
  }
  onMount(() => {
    const report = onHeaderChange;
    void refresh();
    const timer = setInterval(() => void refresh(), 60000);
    return () => { disposed = true; ++generation; controller?.abort(); clearInterval(timer); report?.(null); };
  });
  $effect(() => {
    const report = onHeaderChange;
    const header = {
      summary: loaded ? t('ui.accountCount', { available: rows.filter(row => row.account.available).length, total: rows.length }) : t(busy ? 'ui.accountsLoading' : 'ui.accountsFailed'),
      refresh: { label: t('ui.refreshUsage'), busy, disabled: busy, run: refresh },
    };
    untrack(() => report?.(header));
  });
</script>

<div class="quota-widget flex h-full min-h-0 min-w-0 flex-col" data-testid="chatgpt-quota-widget">
  <!-- Native scroll region remains keyboard scrollable when there are no buttons in the list. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1 focus-visible:outline focus-visible:outline-1 focus-visible:outline-nexus-500" role="region" aria-label={t('ui.widgetAccounts')} tabindex="0" data-testid="quota-list">
    {#if notice}<p role="alert" class="mb-2 text-xs text-amber-300">{t(notice)}</p>{/if}
    {#if busy && !loaded}<LoadingIndicator size="xs" height="none" label={t('ui.accountsLoading')} />
    {:else if loaded && !rows.length}<p class="py-3 text-sm text-zinc-400">{t('ui.widgetEmpty')}</p>
    {:else}
      <div class="quota-grid grid grid-cols-1 items-start gap-x-3 gap-y-2">
        {#each rows as row (row.account.id)}
          {@const account = row.account}
          {@const state = usageState(row)}
          <section class="min-w-0 space-y-1.5 border-b border-carbon-600 pb-2" data-testid="quota-account">
            <div class="flex flex-wrap items-start justify-between gap-1">
              <span class="min-w-0 flex-1 break-all text-sm font-semibold text-zinc-200">{account.label || account.email || t('ui.account')}</span>
              <StatusBadge variant={account.available ? 'active' : account.status === 'revoked' ? 'muted' : 'standby'}>{t(account.available ? 'ui.available' : account.status === 'active' ? 'account.reauth_required' : `account.${account.status}`)}</StatusBadge>
            </div>
            {#if account.email && account.email !== account.label}<p class="break-all text-xs text-zinc-400">{account.email}</p>{/if}
            {#if account.plan}<p class="text-xs text-zinc-400">{t('ui.accountType', { plan: account.plan })}</p>{/if}
            <div class="flex flex-wrap items-baseline gap-x-2 text-xs text-zinc-400"><span>{t('ui.resetCredits')} · <span class="nx-display tabular-nums text-zinc-100" data-testid="quota-count">{creditCount(row) ?? '—'}</span></span>{#if state !== 'fresh'}<span data-testid="quota-state" class={state === 'stale' || state === 'partial' ? 'text-amber-300' : 'text-zinc-400'}>{t(`ui.usage.${state}`)}</span>{/if}</div>
            {#if row.error}<p class="text-xs text-amber-300">{t(row.error)}</p>{/if}
            {#if account.status !== 'active'}<p class="text-xs text-zinc-400">{t('ui.usageSkipped')}</p>
            {:else if !row.usage && busy && !row.error}<LoadingIndicator size="xs" centered={false} height="none" label={t('ui.usageLoading')} />
            {:else}
              {#each [row.usage?.usage.value?.primary, row.usage?.usage.value?.secondary].filter(Boolean) as window}
                <div class="space-y-1">
                  {#if validPercent(window?.usedPercent)}<MetricBar label={windowLabel(window?.windowSeconds)} value={window.usedPercent} valueLabel={`${window.usedPercent}% ${t('ui.used')}`} />
                  {:else}<p class="text-xs text-zinc-400">{windowLabel(window?.windowSeconds)} · {t('ui.widgetUsageUnknown')}</p>{/if}
                  <p class="text-xs tabular-nums text-zinc-400">{t('ui.resetAt', { value: dateText(window?.resetAt) })}</p>
                </div>
              {/each}
              {#if !row.usage?.usage.value?.primary && !row.usage?.usage.value?.secondary}<p class="text-xs text-zinc-400">{t('ui.noUsageWindows')}</p>{/if}
            {/if}
          </section>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .quota-widget { container-type: inline-size; }
  @container (min-width: 32rem) { .quota-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
