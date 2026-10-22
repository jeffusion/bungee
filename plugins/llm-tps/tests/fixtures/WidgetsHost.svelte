<script lang="ts">
  import { locale, waitLocale } from 'svelte-i18n';
  import { _, isLoading } from '$i18n';
  import { getPluginText } from '$utils/plugin-i18n';
  import { configStore } from '$stores/config';
  import type { LogicalConfiguration } from '@jeffusion/bungee-types';
  import type { TimeRange } from '@bungee/plugin-sdk';
  import type { NativeWidgetHeader } from '$components/native-widgets/widget-header';
  import KpiCard from '$components/industrial/KpiCard.svelte';
  import PanelCard from '$components/industrial/PanelCard.svelte';
  import TpsOverview from '../../ui/TpsOverview.svelte';
  import TpsEndpoints from '../../ui/TpsEndpoints.svelte';
  import TpsModels from '../../ui/TpsModels.svelte';
  let selectedRange: TimeRange = $state('24h');
  let overview: NativeWidgetHeader | null = $state(null);
  let endpoints: NativeWidgetHeader | null = $state(null);
  let models: NativeWidgetHeader | null = $state(null);
  const t = (key: string) => $isLoading ? '' : getPluginText(key, 'llm-tps', $_);
  let visible = $state(true);
  const endpoint = (id: string, description: string, position: number) => ({ id, description, position,
    target: `https://fixture-user:never-render@${id}.example.com/private?secret=never-render`, weight: 1, priority: 0, is_disabled: false, plugins: [] });
  configStore.set({ services: [{ id: 'service-1', position: 0, name: 'shared-service', plugins: [], endpoints: [
    endpoint('fast', 'Fast endpoint with a very long English description that wraps across narrow displays', 0),
    endpoint('slow', '', 1),
    endpoint('eu', '', 2),
  ] }], routes: [{ id: 'route-1', position: 0, path: '/chat/', service_id: 'service-1', plugins: [] },
    { id: 'route-2', position: 1, path: '/agents/', endpoints: [endpoint('fast', '第二条路由的同名端点', 0), endpoint('backup', '', 1)], plugins: [] },
    { id: 'route-3', position: 2, path: '/research/', endpoints: [endpoint('api', '', 0)], plugins: [] }], plugins: [] } as LogicalConfiguration);
  async function changeLocale(language: string) { locale.set(language); await waitLocale(language); }
</script>

{#snippet overviewActions()}<button data-testid="overview-refresh" class="nx-btn-secondary" aria-label="Refresh overview" disabled={overview?.refresh.busy || overview?.refresh.disabled} onclick={() => overview?.refresh.run()}>{overview?.refresh.label}</button>{/snippet}

<div class="fixture">
  <nav class="flex flex-wrap gap-3 mb-6" aria-label="Fixture controls">
    {#each ['1h', '12h', '24h'] as value}<button class="nx-btn-secondary" onclick={() => selectedRange = value as TimeRange}>{value}</button>{/each}
    <button class="nx-btn-secondary" onclick={() => changeLocale('zh-CN')}>中文</button>
    <button class="nx-btn-secondary" onclick={() => changeLocale('en')}>English</button>
    <button class="nx-btn-secondary" onclick={() => visible = !visible}>Toggle widgets</button>
  </nav>
  {#if visible}
    <KpiCard label={t('widgets.overview.title')} icon-head={overviewActions} foot={overview?.footer} fillHeight>
      <TpsOverview {selectedRange} onHeaderChange={value => overview = value} />
    </KpiCard>
    <div class="detail-panels" data-testid="tps-detail-panels">
    <PanelCard title={t('widgets.endpoints.title')} tag={endpoints?.summary} class="flex h-[560px] flex-col">
      <svelte:fragment slot="actions"><button data-testid="endpoints-refresh" class="nx-btn-secondary" aria-label="Refresh endpoints" disabled={endpoints?.refresh.busy || endpoints?.refresh.disabled} onclick={() => endpoints?.refresh.run()}>{endpoints?.refresh.label}</button></svelte:fragment>
      <TpsEndpoints {selectedRange} onHeaderChange={value => endpoints = value} />
    </PanelCard>
    <PanelCard title={t('widgets.models.title')} tag={models?.summary} class="flex h-[560px] flex-col">
      <svelte:fragment slot="actions"><button data-testid="models-refresh" class="nx-btn-secondary" aria-label="Refresh models" disabled={models?.refresh.busy || models?.refresh.disabled} onclick={() => models?.refresh.run()}>{models?.refresh.label}</button></svelte:fragment>
      <TpsModels {selectedRange} onHeaderChange={value => models = value} />
    </PanelCard>
    </div>
  {/if}
  <output data-testid="headers-reset">{!overview && !endpoints && !models ? 'reset' : 'active'}</output>
</div>

<style>
  .fixture { max-width: 1440px; margin: 24px auto; padding: 0 18px; }
  .detail-panels { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; margin-top: 24px; }
  .detail-panels :global(.nx-panel-body) { flex: 1; min-height: 0; }
  @media (max-width: 767px) { .detail-panels { grid-template-columns: minmax(0, 1fr); } }
</style>
