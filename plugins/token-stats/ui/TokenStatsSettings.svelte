<script lang="ts">
  import { onMount } from 'svelte';
  import { isLoading } from 'svelte-i18n';
  import { getPluginText } from '$utils/plugin-i18n';
  import { PanelCard, IndustrialToggle, LoadingIndicator } from '$components/industrial';
  import { Button } from '$components/ui/button';
  import { Input } from '$components/ui/input';
  import { Label } from '$components/ui/label';
  import { requestPluginControl, _ } from '@bungee/plugin-sdk';
  import type { PriceStatus } from '../server/price-catalog';

  let status: PriceStatus | null = $state(null);
  let autoRefresh = $state(true);
  let intervalMinutes = $state(60);
  let timeoutSeconds = $state(15);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state('');
  let saved = $state(false);
  let alive = false;
  let polling = false;
  const controller = new AbortController();
  const t = (key: string) => $isLoading ? '' : getPluginText(`settings.${key}`, 'token-stats', (id, options) => $_(id, options));
  const date = (value: number | null) => value === null ? t('never') : new Date(value).toLocaleString();

  async function load(initial = false) {
    if (polling) return;
    polling = true;
    try {
      const result = await requestPluginControl<PriceStatus>('token-stats', '/pricing', 'GET', undefined, controller.signal);
      if (!alive) return;
      status = result;
      if (initial) {
        autoRefresh = result.settings.autoRefresh;
        intervalMinutes = result.settings.intervalMinutes;
        timeoutSeconds = result.settings.timeoutSeconds;
      }
      error = '';
    } catch {
      if (alive) error = 'error';
    } finally {
      if (alive) loading = false;
      polling = false;
    }
  }

  async function save() {
    saved = false;
    const interval = Number(intervalMinutes);
    const timeout = Number(timeoutSeconds);
    if (!Number.isInteger(interval) || interval < 1 || interval > 1440
      || !Number.isInteger(timeout) || timeout < 5 || timeout > 60) {
      error = 'invalid'; return;
    }
    busy = true;
    error = '';
    try {
      const result = await requestPluginControl<PriceStatus>('token-stats', '/pricing/settings', 'PUT',
        { autoRefresh, intervalMinutes: interval, timeoutSeconds: timeout }, controller.signal);
      if (alive) { status = result; saved = true; }
    } catch { if (alive) error = 'error'; }
    finally { if (alive) busy = false; }
  }

  async function refresh() {
    busy = true;
    error = '';
    try {
      const result = await requestPluginControl<PriceStatus>('token-stats', '/pricing/refresh', 'POST', undefined, controller.signal);
      if (alive) status = result;
    } catch { if (alive) error = 'error'; }
    finally { if (alive) busy = false; }
  }

  onMount(() => {
    alive = true;
    void load(true);
    const timer = setInterval(() => { if (!busy) void load(); }, 3000);
    return () => { alive = false; controller.abort(); clearInterval(timer); };
  });
</script>

<div class="space-y-6" data-testid="token-stats-settings">
  <p class="text-sm text-zinc-400">{t('description')}</p>
  {#if error}<p role="alert" class="border border-red-500/40 bg-carbon-900 p-3 text-sm text-red-400">{t(error)}</p>{/if}
  {#if loading}
    <LoadingIndicator />
  {:else if status}
    <PanelCard title={t('title')}>
      <form class="space-y-5" onsubmit={(event) => { event.preventDefault(); void save(); }}>
        <div class="flex items-center justify-between gap-4 border-b border-carbon-600 pb-4">
          <Label for="token-price-auto">{t('autoRefresh')}</Label>
          <IndustrialToggle id="token-price-auto" label={t('autoRefresh')} bind:checked={autoRefresh} disabled={busy} />
        </div>
        <div class="grid gap-5 sm:grid-cols-2">
          <div class="space-y-2">
            <Label for="token-price-interval">{t('interval')}</Label>
            <Input id="token-price-interval" type="number" min={1} max={1440} step={1} bind:value={intervalMinutes} disabled={busy} required />
          </div>
          <div class="space-y-2">
            <Label for="token-price-timeout">{t('timeout')}</Label>
            <Input id="token-price-timeout" type="number" min={5} max={60} step={1} bind:value={timeoutSeconds} disabled={busy} required />
          </div>
        </div>
        <div class="flex items-center gap-4">
          <Button type="submit" disabled={busy} aria-busy={busy}>{t(busy ? 'saving' : 'save')}</Button>
          {#if saved}<span role="status" class="text-sm text-emerald-400">{t('saved')}</span>{/if}
        </div>
      </form>
    </PanelCard>
    <PanelCard title={t('catalog')}>
      <div slot="actions">
        <Button variant="outline" disabled={busy || status.refreshing} aria-busy={status.refreshing} onclick={() => void refresh()}>
          {t(status.refreshing ? 'refreshing' : 'refresh')}
        </Button>
      </div>
      <dl class="grid gap-5 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div class="space-y-2"><dt class="text-zinc-400">{t('source')}</dt><dd class="break-all text-zinc-200"><a href={status.source} target="_blank" rel="noopener noreferrer" class="hover:text-nexus-400 underline underline-offset-4">models.dev</a></dd></div>
        <div class="space-y-2"><dt class="text-zinc-400">{t('modelCount')}</dt><dd class="font-display text-xl text-nexus-500">{status.modelCount}</dd></div>
        <div class="space-y-2"><dt class="text-zinc-400">{t('providerCount')}</dt><dd class="font-display text-xl text-zinc-100">{status.providerCount}</dd></div>
        <div class="space-y-2"><dt class="text-zinc-400">{t('lastAttempt')}</dt><dd class="font-mono text-zinc-200">{date(status.lastAttemptAt)}</dd></div>
        <div class="space-y-2"><dt class="text-zinc-400">{t('lastSuccess')}</dt><dd data-testid="price-last-success" class="font-mono text-zinc-200">{date(status.lastSuccessAt)}</dd></div>
        <div class="space-y-2"><dt class="text-zinc-400">{t('nextRefresh')}</dt><dd class="font-mono text-zinc-200">{status.nextRefreshAt === null ? t(status.settings.autoRefresh ? 'refreshing' : 'disabled') : date(status.nextRefreshAt)}</dd></div>
      </dl>
      {#if status.lastError}
        <p role="status" class="mt-5 border-l-2 border-amber-400 pl-3 text-sm text-amber-400">{t(`${status.lastError}Error`)} · {t('failure')}</p>
      {/if}
      <p class="mt-5 border-t border-carbon-600 pt-4 text-xs leading-relaxed text-zinc-400">{t('history')}</p>
    </PanelCard>
  {/if}
</div>
