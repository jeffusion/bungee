<script lang="ts">
  import { onMount } from 'svelte';
  import { isLoading } from 'svelte-i18n';
  import { getPluginText } from '$utils/plugin-i18n';
  import { PanelCard, IndustrialToggle, LoadingIndicator } from '$components/industrial';
  import { Button } from '$components/ui/button';
  import { NumberInput } from '$components/ui/number-input';
  import { Label } from '$components/ui/label';
  import { requestPluginControl, _ } from '@bungee/plugin-sdk';

  interface CatalogStatus {
    state: 'empty' | 'ready' | 'stale' | 'failed'; version: number | null;
    settings: { autoRefresh: boolean; intervalHours: number; timeoutSeconds: number };
    refreshing: boolean; lastAttemptAt: number | null; lastSuccessAt: number | null;
    nextRefreshAt: number | null; lastError: string | null; modelCount: number; providerCount: number;
  }
  let status = $state<CatalogStatus | null>(null);
  let autoRefresh = $state(true);
  let intervalHours = $state(24);
  let timeoutSeconds = $state(15);
  let loading = $state(true);
  let busy = $state(false);
  let saved = $state(false);
  let error = $state('');
  let loadError = $state(false);
  let alive = false;
  let polling = false;
  let generation = 0;
  const controller = new AbortController();
  const t = (key: string) => $isLoading ? '' : getPluginText(`settings.${key}`, 'models-dev', (id, options) => $_(id, options));
  const date = (value: number | null) => value === null ? t('never') : new Date(value).toLocaleString();

  async function load(initial = false) {
    if (polling || busy) return;
    polling = true;
    const version = generation;
    try {
      const result = await requestPluginControl<CatalogStatus>('models-dev', '/catalog/status', 'GET', undefined, controller.signal);
      if (!alive || version !== generation) return;
      // A poll started before a mutation must not overwrite its newer response.
      if (!busy) status = result;
      if (initial) {
        autoRefresh = result.settings.autoRefresh;
        intervalHours = result.settings.intervalHours;
        timeoutSeconds = result.settings.timeoutSeconds;
      }
      loadError = false;
    } catch { if (alive && version === generation) loadError = true; }
    finally { if (alive) loading = false; polling = false; }
  }
  async function save() {
    if (busy || !status) return;
    saved = false;
    const hours = Number(intervalHours), timeout = Number(timeoutSeconds);
    if (!Number.isInteger(hours) || hours < 1 || hours > 24 || !Number.isInteger(timeout) || timeout < 5 || timeout > 120) {
      error = 'invalid'; return;
    }
    generation++; busy = true; error = '';
    try {
      const result = await requestPluginControl<CatalogStatus>('models-dev', '/catalog/settings', 'PUT',
        { autoRefresh, intervalHours: hours, timeoutSeconds: timeout }, controller.signal);
      if (alive) { status = result; saved = true; }
    } catch { if (alive) error = 'error'; }
    finally { if (alive) busy = false; }
  }
  async function refresh() {
    if (busy || status?.refreshing) return;
    generation++; busy = true; error = '';
    try {
      const result = await requestPluginControl<CatalogStatus>('models-dev', '/catalog/refresh', 'POST', undefined, controller.signal);
      if (alive) status = result;
    } catch { if (alive) error = 'error'; }
    finally { if (alive) busy = false; }
  }
  onMount(() => {
    alive = true; void load(true);
    const timer = setInterval(() => void load(), 1000);
    return () => { alive = false; controller.abort(); clearInterval(timer); };
  });
</script>

<div class="space-y-6" data-testid="models-dev-settings">
  <p class="text-sm text-zinc-400">{t('description')}</p>
  {#if error || loadError}<p role="alert" class="text-sm text-red-400">{t(error || 'error')}</p>{/if}
  {#if loading}<LoadingIndicator />
  {:else if status}
    <PanelCard title={t('title')}>
      <form class="space-y-5" onsubmit={(event) => { event.preventDefault(); void save(); }}>
        <div class="flex items-center justify-between gap-4 border-b border-carbon-600 pb-4">
          <Label for="models-dev-auto">{t('autoRefresh')}</Label>
          <IndustrialToggle id="models-dev-auto" label={t('autoRefresh')} bind:checked={autoRefresh} disabled={busy} />
        </div>
        <div class="grid gap-5 sm:grid-cols-2">
          <div class="space-y-2"><Label for="models-dev-interval">{t('interval')}</Label>
            <NumberInput id="models-dev-interval" data-testid="models-dev-interval" min={1} max={24} bind:value={intervalHours} disabled={busy} required /></div>
          <div class="space-y-2"><Label for="models-dev-timeout">{t('timeout')}</Label>
            <NumberInput id="models-dev-timeout" data-testid="models-dev-timeout" min={5} max={120} bind:value={timeoutSeconds} disabled={busy} required /></div>
        </div>
        <div class="flex items-center gap-4">
          <Button type="submit" data-testid="models-dev-save" disabled={busy} aria-busy={busy}>{t(busy ? 'saving' : 'save')}</Button>
          {#if saved}<span role="status" class="text-sm text-emerald-400">{t('saved')}</span>{/if}
        </div>
      </form>
    </PanelCard>
    <PanelCard title={t('catalog')}>
      <div slot="actions"><Button variant="outline" data-testid="models-dev-refresh" disabled={busy || status.refreshing} aria-busy={status.refreshing} onclick={() => void refresh()}>{t(status.refreshing ? 'refreshing' : 'refresh')}</Button></div>
      <dl class="grid gap-5 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div class="space-y-2"><dt class="text-zinc-400">{t('state')}</dt><dd data-testid="models-dev-state">{t(status.state)}</dd></div>
        <div class="space-y-2"><dt class="text-zinc-400">{t('version')}</dt><dd data-testid="models-dev-version">{status.version ?? t('never')}</dd></div>
        <div class="space-y-2"><dt class="text-zinc-400">{t('lastSuccess')}</dt><dd data-testid="models-dev-fetched-at">{date(status.lastSuccessAt)}</dd></div>
        <div class="space-y-2"><dt class="text-zinc-400">{t('modelCount')}</dt><dd>{status.modelCount}</dd></div>
        <div class="space-y-2"><dt class="text-zinc-400">{t('providerCount')}</dt><dd>{status.providerCount}</dd></div>
        <div class="space-y-2"><dt class="text-zinc-400">{t('nextRefresh')}</dt><dd>{status.nextRefreshAt === null ? t(status.settings.autoRefresh ? 'never' : 'disabled') : date(status.nextRefreshAt)}</dd></div>
      </dl>
      {#if status.lastError}<p role="status" data-testid="models-dev-error" class="mt-5 border-l-2 border-amber-400 pl-3 text-sm text-amber-400">{t(`${status.lastError}Error`)} · {t('failure')}</p>{/if}
    </PanelCard>
  {:else}<Button variant="outline" onclick={() => void load(true)}>{t('retry')}</Button>{/if}
</div>
