<script lang="ts">
  import type { Route, Service } from '$api/routes';
  import FailoverEditor from '$components/domain/service/FailoverEditor.svelte';
  import { _ } from '$i18n';

  export let route: Route;
  export let services: Service[] = [];

  let referencedService: Service | undefined;
  $: referencedService = services.find((s) => s.name === route.service);
</script>

<div class="space-y-3">
  <p class="text-xs text-zinc-500">
    {$_('routeEditor.failoverHelp')}
  </p>

  {#if route.service && referencedService?.failover?.enabled}
    <div class="border-l-2 border-l-nexus-500 bg-nexus-500/5 px-3 py-2 flex items-start gap-2">
      <svg viewBox="0 0 24 24" class="h-4 w-4 shrink-0 text-nexus-400 mt-0.5" fill="none" stroke="currentColor" stroke-width="1.8">
        <path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <span class="font-mono text-[11px] uppercase tracking-command text-nexus-200">
        {$_('routeEditor.failoverInheritedFromService', { values: { service: route.service } })}
      </span>
    </div>
  {/if}

  <FailoverEditor
    bind:failover={route.failover}
    label={$_('routeEditor.failoverTitle')}
    showHelp={true}
  />
</div>
