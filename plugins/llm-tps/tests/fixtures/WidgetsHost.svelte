<script lang="ts">
  import { locale, waitLocale } from 'svelte-i18n';
  import { configStore } from '$stores/config';
  import type { LogicalConfiguration } from '@jeffusion/bungee-types';
  import type { TimeRange } from '@bungee/plugin-sdk';
  import type { NativeWidgetHeader } from '$components/native-widgets/widget-header';
  import KpiCard from '$components/industrial/KpiCard.svelte';
  import PanelCard from '$components/industrial/PanelCard.svelte';
  import TpsOverview from '../../ui/TpsOverview.svelte';
  import TpsEndpoints from '../../ui/TpsEndpoints.svelte';
  let selectedRange: TimeRange = $state('24h');
  let overview: NativeWidgetHeader | null = $state(null);
  let endpoints: NativeWidgetHeader | null = $state(null);
  let visible = $state(true);
  const endpoint = (id: string, description: string, position: number) => ({ id, description, position,
    target: 'https://never-render.example/private?secret=never-render', weight: 1, priority: 0, is_disabled: false, plugins: [] });
  configStore.set({ services: [{ id: 'service-1', position: 0, name: 'shared-service', plugins: [], endpoints: [
    endpoint('fast', 'Fast endpoint with a very long English description that wraps across narrow displays', 0),
    endpoint('slow', '较慢端点：用于核验窄屏长中文描述能够完整换行而不被省略', 1),
  ] }], routes: [{ id: 'route-1', position: 0, path: '/test', service_id: 'service-1', plugins: [] },
    { id: 'route-2', position: 1, path: '/other', endpoints: [endpoint('fast', '第二条路由的同名端点', 0)], plugins: [] }], plugins: [] } as LogicalConfiguration);
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
    <KpiCard label="LLM Generation Speed" icon-head={overviewActions}>
      <TpsOverview {selectedRange} onHeaderChange={value => overview = value} />
    </KpiCard>
    <PanelCard title="Endpoint Generation Speed" class="mt-6">
      <svelte:fragment slot="actions"><button data-testid="endpoints-refresh" class="nx-btn-secondary" aria-label="Refresh endpoints" disabled={endpoints?.refresh.busy || endpoints?.refresh.disabled} onclick={() => endpoints?.refresh.run()}>{endpoints?.refresh.label}</button></svelte:fragment>
      <TpsEndpoints {selectedRange} onHeaderChange={value => endpoints = value} />
    </PanelCard>
  {/if}
  <output data-testid="headers-reset">{!overview && !endpoints ? 'reset' : 'active'}</output>
</div>

<style>.fixture { max-width: 960px; margin: 24px auto; padding: 0 18px; }</style>
