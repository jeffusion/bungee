<script lang="ts">
  import type { Route } from '$api/routes';
  import HeadersEditor from '../HeadersEditor.svelte';
  import BodyEditor from '../BodyEditor.svelte';
  import QueryEditor from '../QueryEditor.svelte';
  import { _ } from '$i18n';
  import { SegmentedControl } from '$components/industrial';

  export let route: Route;

  let activeTab: 'headers' | 'body' | 'query' = 'headers';

  $: tabOptions = [
    { value: 'headers', label: $_('headers.title') },
    { value: 'body', label: $_('body.title') },
    { value: 'query', label: $_('query.title') },
  ];
</script>

<div class="space-y-4">
  <p class="text-xs text-zinc-500">
    {$_('routeEditor.requestModificationHelp')}
  </p>

  <SegmentedControl options={tabOptions} bind:value={activeTab} ariaLabel="modification scope" />

  <div>
    {#if activeTab === 'headers'}
      <HeadersEditor bind:value={route.headers} label={$_('headers.title')} showLabel={false} />
    {:else if activeTab === 'body'}
      <BodyEditor bind:value={route.body} label={$_('body.title')} showLabel={false} />
    {:else if activeTab === 'query'}
      <QueryEditor bind:value={route.query} label={$_('query.title')} showLabel={false} />
    {/if}
  </div>

  <div class="border-l-2 border-l-nexus-500 bg-nexus-500/5 px-3 py-2 flex items-start gap-2">
    <svg viewBox="0 0 24 24" class="h-4 w-4 shrink-0 text-nexus-400 mt-0.5" fill="none" stroke="currentColor" stroke-width="1.8">
      <path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
    <span class="font-mono text-[11px] uppercase tracking-command text-nexus-200">
      {$_('routeEditor.routeLevelModificationNote')}
    </span>
  </div>
</div>
