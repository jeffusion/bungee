<script lang="ts">
  import { locale } from 'svelte-i18n';
  import { requestPluginControl } from '@bungee/plugin-sdk';
  import { KpiCard, LoadingIndicator, PanelCard } from '$components/industrial';
  import { Button } from '$components/ui/button';

  let { pluginName = 'request-body-redaction' }: { pluginName?: string } = $props();

  const copy = $derived($locale?.startsWith('zh') ? {
    title: '全局统计',
    scope: '按脱敏执行次数计，不代表请求成功数。',
    processedRequests: '处理次数', redactedRequests: '有替换的处理次数', replacements: '替换处数',
    load: '加载统计…', refresh: '刷新', error: '无法加载统计。', retry: '重试',
    incomplete: '部分统计可能缺失。',
  } : {
    title: 'Overall statistics',
    scope: 'Counts redaction runs, not successful requests.',
    processedRequests: 'Runs', redactedRequests: 'Runs with replacements', replacements: 'Replacements',
    load: 'Loading statistics…', refresh: 'Refresh', error: 'Could not load statistics.', retry: 'Retry',
    incomplete: 'Some counts may be missing.',
  });

  const metrics = ['processedRequests', 'redactedRequests', 'replacements'] as const;
  type Stats = Record<typeof metrics[number], number> & { reportingIncomplete: boolean };
  let stats = $state<Stats | null>(null);
  let failed = $state(false);
  let revision = $state(0);

  $effect(() => {
    const name = pluginName;
    void revision;
    const controller = new AbortController();
    stats = null;
    failed = false;
    void requestPluginControl<Stats>(name, '/stats', 'GET', undefined, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return;
        if (!result || !metrics.every(key => Number.isSafeInteger(result[key]) && result[key] >= 0)
          || typeof result.reportingIncomplete !== 'boolean') {
          failed = true;
          return;
        }
        stats = result;
      })
      .catch(() => { if (!controller.signal.aborted) failed = true; });
    return () => controller.abort();
  });
</script>

<section class="min-w-0 space-y-2" data-testid="request-body-redaction-stats">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0 flex-1 space-y-1">
      <h2 class="nx-field-label">{copy.title}</h2>
      <p class="text-sm text-zinc-400">{copy.scope}</p>
    </div>
    <Button variant="outline" size="sm" aria-disabled={!stats && !failed}
      class="min-h-[44px] sm:min-h-0 aria-disabled:opacity-50" onclick={() => { if (stats || failed) revision++; }}>
      {failed ? copy.retry : copy.refresh}
    </Button>
  </div>

  {#if failed}
    <PanelCard headless corners={false}>
      <p role="alert" class="text-sm text-red-300">{copy.error}</p>
    </PanelCard>
  {:else if !stats}
    <PanelCard headless corners={false}>
      <LoadingIndicator label={copy.load} size="sm" height="none" />
    </PanelCard>
  {:else}
    {#if stats.reportingIncomplete}
      <p role="status" class="border-l-2 border-amber-500 bg-carbon-900 px-3 py-2 text-sm text-amber-300">{copy.incomplete}</p>
    {/if}
    <div class="grid gap-3 sm:grid-cols-3">
      {#each metrics as key (key)}
        <KpiCard label={copy[key]} value={stats[key].toLocaleString($locale ?? undefined)} />
      {/each}
    </div>
  {/if}
</section>
