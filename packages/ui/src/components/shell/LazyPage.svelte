<script lang="ts" generics="Props extends Record<string, unknown>">
  import type { Component } from 'svelte';
  import { _ } from '$i18n';
  import LoadingIndicator from '$components/industrial/LoadingIndicator.svelte';

  let { load, props }: {
    load: () => Promise<{ default: Component<Props> }>;
    props: Props;
  } = $props();
  let pending = $derived(load());
</script>

{#await pending}
  <LoadingIndicator label={$_('common.loading')} size="lg" />
{:then { default: Page }}
  <Page {...props} />
{:catch}
  <div class="nx-page py-5 space-y-3" role="alert">
    <p class="text-sm text-red-300">{$_('pageLoading.failed')}</p>
    <button type="button" class="nx-btn-outline" onclick={() => window.location.reload()}>{$_('pageLoading.retry')}</button>
  </div>
{/await}
