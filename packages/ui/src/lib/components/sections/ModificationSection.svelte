<script lang="ts">
  import type { Route } from '../../api/routes';
  import HeadersEditor from '../HeadersEditor.svelte';
  import BodyEditor from '../BodyEditor.svelte';
  import QueryEditor from '../QueryEditor.svelte';
  import { _ } from '../../i18n';

  export let route: Route;

  let activeTab: 'headers' | 'body' | 'query' = 'headers';
</script>

<div class="space-y-4">
  <div>
    <h3 class="text-lg font-semibold">{$_('routeEditor.requestModification')}</h3>
    <p class="text-sm text-gray-500 mt-1">
      {$_('routeEditor.requestModificationHelp')}
    </p>
  </div>

  <!-- Tabs -->
  <div role="tablist" class="tabs tabs-boxed">
    <button
      role="tab"
      class="tab"
      class:tab-active={activeTab === 'headers'}
      on:click={() => activeTab = 'headers'}
    >
      {$_('headers.title')}
    </button>
    <button
      role="tab"
      class="tab"
      class:tab-active={activeTab === 'body'}
      on:click={() => activeTab = 'body'}
    >
      {$_('body.title')}
    </button>
    <button
      role="tab"
      class="tab"
      class:tab-active={activeTab === 'query'}
      on:click={() => activeTab = 'query'}
    >
      {$_('query.title')}
    </button>
  </div>

  <!-- Tab Content -->
  <div class="mt-4">
    {#if activeTab === 'headers'}
      <HeadersEditor bind:value={route.headers} label={$_('headers.title')} showLabel={false} />
    {:else if activeTab === 'body'}
      <BodyEditor bind:value={route.body} label={$_('body.title')} showLabel={false} />
    {:else if activeTab === 'query'}
      <QueryEditor bind:value={route.query} label={$_('query.title')} showLabel={false} />
    {/if}
  </div>

  <div class="alert alert-info mt-4">
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current shrink-0 w-6 h-6">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
    </svg>
    <span class="text-sm">{$_('routeEditor.routeLevelModificationNote')}</span>
  </div>
</div>
