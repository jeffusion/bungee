<script lang="ts">
  import { onMount } from 'svelte';
  import { getRouteBodyPlans, type RouteBodyPlansResponse } from '$api/runtime';
  import { _ } from '$i18n';
  export let routeId: string;
  let result: RouteBodyPlansResponse | null = null;
  let failed = false;
  let alive = true;
  $: plan = result?.routes.find(value => value.route_id === routeId);
  onMount(() => {
    getRouteBodyPlans().then(value => { if (alive) result = value; }).catch(() => { if (alive) failed = true; });
    return () => { alive = false; };
  });
</script>

<details class="border border-carbon-600 p-3 text-sm" data-testid="route-body-plan">
  <summary class="cursor-pointer">{$_('bodyPlan.title')}</summary>
  <p class="mt-2 text-xs text-zinc-400">{$_('bodyPlan.help')}</p>
  {#if failed}<p class="mt-2 text-amber-300">{$_('bodyPlan.unavailable')}</p>
  {:else if !result}<p class="mt-2 text-zinc-400">{$_('common.loading')}</p>
  {:else if plan}
    <p class="mt-2 text-zinc-400">{$_('bodyPlan.revision')}: {result.revision}</p>
    {#each [{...plan, upstream_id: $_('bodyPlan.route')}, ...plan.endpoints] as entry}
      <div class="mt-3 space-y-1 border-l border-carbon-600 pl-3">
        <p class="font-mono text-xs">{entry.upstream_id}</p>
        {#each ['request', 'response'] as direction}
          {@const part = direction === 'request' ? entry.request : entry.response}
          <p>{$_(`directional.${direction}`)}: {$_(part.mode === 'opaque-stream' ? 'bodyPlan.opaque' : 'bodyPlan.content')}
            {#if part.reasons.length}<span class="font-mono text-xs text-zinc-400">({part.reasons.join(', ')})</span>{/if}
          </p>
        {/each}
        {#if entry.replay}<p>{$_('bodyPlan.replay')}</p>{/if}
        {#if entry.dynamic_plugins.length}<p>{$_('bodyPlan.plugins')}: {entry.dynamic_plugins.join(', ')}</p>{/if}
      </div>
    {/each}
  {:else}<p class="mt-2 text-zinc-400">{$_('bodyPlan.unavailable')}</p>{/if}
</details>
