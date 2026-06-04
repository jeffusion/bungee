<script lang="ts">
  import { resolveRouteEndpoints, type Route, type Service } from '$api/routes';
  import { _ } from '$i18n';
  import { PanelCard, StatusBadge } from '$components/industrial';

  export let route: Route;
  export let services: Service[] = [];

  let showJson = false;
  $: endpoints = resolveRouteEndpoints(route, services);

  $: previewRoute = {
    ...route,
    endpoints: route.endpoints?.map(({ _uid, ...upstream }) => upstream)
  };

  $: jsonConfig = JSON.stringify(previewRoute, null, 2);

  $: stats = {
    upstreamsCount: endpoints.length,
    hasAuth: route.auth?.enabled || false,
    hasFailover: route.failover?.enabled || false,
    hasTransformer: (route.plugins && route.plugins.length > 0) || false,
    hasPathRewrite: route.path_rewrite && Object.keys(route.path_rewrite).length > 0,
    totalWeight: endpoints.reduce((sum, u) => sum + (u.weight || 100), 0)
  };
</script>

<div class="space-y-6">
  <div>
    <h3 class="text-lg font-semibold">{$_('routeEditor.preview')}</h3>
    <p class="text-sm text-zinc-500 mt-1">{$_('routeEditor.previewHelp')}</p>
  </div>

  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
    <PanelCard title={$_('routeEditor.upstreams')} tag={String(stats.upstreamsCount)}>
      <div class="space-y-2">
        <div class="text-sm text-zinc-400">{$_('routeEditor.totalWeight')}: {stats.totalWeight}</div>
      </div>
    </PanelCard>

    <PanelCard title={$_('routeEditor.features')} tag="FEATURES">
      <div class="space-y-2">
        <div class="flex items-center gap-2"><StatusBadge variant={stats.hasAuth ? 'active' : 'muted'}>{$_('auth.routeAuth')}</StatusBadge></div>
        <div class="flex items-center gap-2"><StatusBadge variant={stats.hasFailover ? 'active' : 'muted'}>{$_('routeEditor.failoverTitle')}</StatusBadge></div>
        <div class="flex items-center gap-2"><StatusBadge variant={stats.hasTransformer ? 'active' : 'muted'}>{$_('routeEditor.transformer')}</StatusBadge></div>
        <div class="flex items-center gap-2"><StatusBadge variant={stats.hasPathRewrite ? 'active' : 'muted'}>{$_('routeEditor.pathRewrite')}</StatusBadge></div>
      </div>
    </PanelCard>

    <PanelCard title={$_('routes.path')} tag="PATH">
      <div class="text-sm truncate" title={route.path}>{route.path || $_('routeEditor.notSet')}</div>
    </PanelCard>
  </div>

  <PanelCard title={$_('routeEditor.enabledFeatures')} tag="FLAGS">
    <div class="grid gap-2">
      <div class="flex items-center gap-2"><StatusBadge variant={stats.hasAuth ? 'active' : 'muted'}>{$_('auth.routeAuth')}</StatusBadge></div>
      <div class="flex items-center gap-2"><StatusBadge variant={stats.hasFailover ? 'active' : 'muted'}>{$_('routeEditor.failoverTitle')}</StatusBadge></div>
      <div class="flex items-center gap-2"><StatusBadge variant={stats.hasTransformer ? 'active' : 'muted'}>{$_('routeEditor.transformer')}</StatusBadge></div>
      <div class="flex items-center gap-2"><StatusBadge variant={stats.hasPathRewrite ? 'active' : 'muted'}>{$_('routeEditor.pathRewrite')}</StatusBadge></div>
    </div>
  </PanelCard>

  <PanelCard title={$_('routeEditor.upstreams')} tag="UPSTREAMS">
    {#if route.service}
      <div class="mb-2"><StatusBadge variant="online">service: {route.service}</StatusBadge></div>
    {/if}
    <div class="space-y-2">
      {#each endpoints as upstream, index}
        <div class="flex items-center gap-3 p-3 border border-carbon-600 bg-carbon-900/60 rounded">
          <div class="nx-feature-tag">{upstream.priority || index + 1}</div>
          <div class="flex-1 min-w-0">
            <div class="font-medium text-sm truncate" title={upstream.target}>{upstream.target || $_('routeEditor.notSet')}</div>
            <div class="text-xs text-zinc-500">{$_('upstream.weight')}: {upstream.weight || 100}{#if upstream.plugins && upstream.plugins.length > 0}<span class="ml-2"><StatusBadge variant="info">Transformer</StatusBadge></span>{/if}</div>
          </div>
        </div>
      {/each}
    </div>
  </PanelCard>

  <PanelCard title={$_('routeEditor.jsonConfig')} tag="JSON">
    <div class="flex justify-end">
      <button type="button" class="nx-btn-ghost nx-btn-sm" on:click={() => showJson = !showJson}>{showJson ? $_('common.hide') : $_('common.show')}</button>
    </div>
    {#if showJson}
      <div class="mt-4 border border-carbon-600 bg-carbon-950 p-3 font-mono text-xs whitespace-pre overflow-auto">{jsonConfig}</div>
      <div class="mt-4 flex justify-end">
        <button type="button" class="nx-btn-outline nx-btn-sm" on:click={() => { navigator.clipboard.writeText(jsonConfig); alert($_('common.copied')); }}>{$_('common.copy')}</button>
      </div>
    {/if}
  </PanelCard>

  <PanelCard title={$_('routeEditor.requestFlow')} tag="FLOW">
    <div class="flex flex-col gap-3">
      <div class="flex items-center gap-3"><div class="nx-feature-tag">1</div><div class="flex-1"><div class="font-medium">{$_('routeEditor.clientRequest')}</div><div class="text-xs text-zinc-500">{route.path || '/'}</div></div></div>
      <div class="ml-6 border-l-2 border-carbon-600 pl-4 space-y-3">
        {#if stats.hasAuth}
          <div class="flex items-center gap-3"><div class="nx-feature-tag">✓</div><div class="text-sm">{$_('auth.routeAuth')}</div></div>
        {/if}
        {#if stats.hasPathRewrite}
          <div class="flex items-center gap-3"><div class="nx-feature-tag">→</div><div class="text-sm">{$_('routeEditor.pathRewrite')}</div></div>
        {/if}
        {#if stats.hasTransformer}
          <div class="flex items-center gap-3"><div class="nx-feature-tag">⚡</div><div class="text-sm">{$_('routeEditor.transformer')}</div></div>
        {/if}
        <div class="flex items-center gap-3"><div class="nx-feature-tag">2</div><div class="flex-1"><div class="font-medium">{$_('routeEditor.selectUpstream')}</div><div class="text-xs text-zinc-500">{stats.upstreamsCount} {$_('routeEditor.upstreams')}{#if stats.hasFailover}<StatusBadge variant="active">{$_('routeEditor.failoverEnabled')}</StatusBadge>{/if}</div></div></div>
        <div class="flex items-center gap-3"><div class="nx-feature-tag">3</div><div class="font-medium">{$_('routeEditor.returnResponse')}</div></div>
      </div>
    </div>
  </PanelCard>
</div>
