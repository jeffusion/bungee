<script lang="ts">
  import { onMount } from 'svelte';
  import type { DirectionalModificationRules, ResponseBodyFormat } from '@jeffusion/bungee-types';
  import HeadersEditor from './HeadersEditor.svelte';
  import BodyEditor from './BodyEditor.svelte';
  import QueryEditor from './QueryEditor.svelte';
  import { _, isLoading } from '$i18n';
  import { SegmentedControl } from '$components/industrial';

  export let policy: DirectionalModificationRules;
  let direction: 'request' | 'response' = 'request';
  let tab: 'headers' | 'body' | 'query' = 'headers';
  onMount(() => { policy.request ??= {}; policy.response ??= {}; });
  $: directionOptions = $isLoading ? [] : [{ value: 'request', label: $_('directional.request') }, { value: 'response', label: $_('directional.response') }];
  $: tabOptions = $isLoading ? [] : [
    { value: 'headers', label: $_('headers.title') },
    { value: 'body', label: $_('body.title') },
    ...(direction === 'request' ? [{ value: 'query', label: $_('query.title') }] : []),
  ];
  $: if (direction === 'response' && tab === 'query') tab = 'headers';
  function toggleFormat(format: ResponseBodyFormat, checked: boolean) {
    policy.response ??= {};
    const formats = policy.response.body_formats ?? ['json', 'sse-json'];
    policy.response.body_formats = checked ? [...new Set([...formats, format])] : formats.filter(value => value !== format);
  }
</script>

<div class="space-y-4" data-testid="directional-modification-editor">
  <SegmentedControl options={directionOptions} bind:value={direction} ariaLabel={$_('directional.direction')} />
  <p class="text-xs text-zinc-400">{$_(direction === 'request' ? 'directional.requestHelp' : 'directional.responseHelp')}</p>
  <SegmentedControl options={tabOptions} bind:value={tab} ariaLabel={$_('directional.field')} />
  {#if direction === 'request' && policy.request}
    {#if tab === 'headers'}<HeadersEditor bind:value={policy.request.headers} showLabel={false} />
    {:else if tab === 'body'}<BodyEditor bind:value={policy.request.body} showLabel={false} />
    {:else}<QueryEditor bind:value={policy.request.query} showLabel={false} />{/if}
  {:else if direction === 'response' && policy.response}
    {#if tab === 'headers'}<HeadersEditor bind:value={policy.response.headers} showLabel={false} />
    {:else}<BodyEditor bind:value={policy.response.body} showLabel={false} />{/if}
    <fieldset class="space-y-2 border border-carbon-600 p-3">
      <legend class="nx-label">{$_('directional.formats')}</legend>
      {#each ['json', 'sse-json'] as format}
        <label class="flex items-center gap-2 text-sm text-zinc-200">
          <input type="checkbox" checked={(policy.response.body_formats ?? ['json', 'sse-json']).includes(format as ResponseBodyFormat)} onchange={(event) => toggleFormat(format as ResponseBodyFormat, event.currentTarget.checked)} />
          {format === 'json' ? $_('directional.json') : $_('directional.sseJson')}
        </label>
      {/each}
      <p class="text-xs text-zinc-400">{$_('directional.formatsHelp')}</p>
    </fieldset>
  {/if}
</div>
