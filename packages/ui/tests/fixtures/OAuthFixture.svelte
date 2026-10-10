<script lang="ts">
  import AccountsPage from '@plugins/chatgpt-oauth/ui/AccountsPage.svelte';
  import RouteEditor from '$lib/routes/RouteEditor.svelte';
  import UpstreamSourcePicker from '$components/domain/route/UpstreamSourcePicker.svelte';
  import UpstreamsSection from '$components/domain/route/sections/UpstreamsSection.svelte';
  import UpstreamForm from '$components/domain/route/UpstreamForm.svelte';
  import { Button } from '$components/ui/button';
  import * as Dialog from '$components/ui/dialog';
  import { IndustrialDialog } from '$components/industrial';
  import DesignSystem from '$lib/routes/DesignSystem.svelte';
  import type { EditorUpstream } from '$api/config-adapters';
  const picker = new URLSearchParams(window.location.search).get('picker');
  const endpoint = new URLSearchParams(window.location.search).get('endpoint');
  const dialogKind = new URLSearchParams(window.location.search).get('dialog');
  const routeFlow = new URLSearchParams(window.location.search).has('routeFlow');
  let pickerGeneration = $state(0);
  let hash = $state(window.location.hash.slice(1));
  const editPath = $derived(hash.match(/^\/routes\/edit\/([^?]+)/)?.[1]);
  let dialogOpen = $state(false);
  let endpointSection: { openUpstreamModal(index?: number): void } | undefined = $state();
  let service = $state({ endpoints: [{ _uid: 'endpoint', target: 'https://chatgpt.com/backend-api/codex/responses', weight: 100, priority: 1,
    managedBy: { plugin: 'chatgpt-oauth', contributionId: 'chatgpt', bindingId: 'binding' },
    plugins: [{ _uid: 'binding', name: 'chatgpt-oauth', enabled: true, options: { accountRef: 'account-1' } }],
  }] });
  let upstream = $state<EditorUpstream>(picker === 'missing' ? {
    target: 'https://chatgpt.com/backend-api/codex/responses',
    managedBy: { plugin: 'chatgpt-oauth', contributionId: 'chatgpt', bindingId: 'binding' },
    plugins: [{ _uid: 'binding', name: 'chatgpt-oauth', enabled: true, options: { accountRef: 'missing-account' } }],
  } : { target: '' });
</script>
<svelte:window onhashchange={() => hash = window.location.hash.slice(1)} />
{#if routeFlow && hash.startsWith('/routes/')}
  {#key hash.split('?')[0]}
    <RouteEditor params={editPath ? { path: editPath } : {}} />
  {/key}
{:else if routeFlow && hash.startsWith('/services/')}
  <!-- The service handoff is owned by ServiceEditor; navigation must unmount the account chooser. -->
  <main data-testid="service-handoff-destination"></main>
{:else}
<main class="nx-page py-6">
  {#if dialogKind === 'industrial'}
    <Button onclick={() => dialogOpen = true}>Open focus fixture</Button>
    <IndustrialDialog bind:open={dialogOpen} title="Close focus fixture" description="Industrial dialog keyboard and pointer focus">
      {#snippet body()}<p>Local fixture. No account operations.</p>{/snippet}
    </IndustrialDialog>
  {:else if dialogKind === 'standard'}
    <Dialog.Root>
      <Dialog.Trigger asChild let:builder><Button builders={[builder]}>Open focus fixture</Button></Dialog.Trigger>
      <Dialog.Content>
        <Dialog.Title>Close focus fixture</Dialog.Title>
        <Dialog.Description>Standard dialog keyboard and pointer focus</Dialog.Description>
      </Dialog.Content>
    </Dialog.Root>
  {:else if new URLSearchParams(window.location.search).has('design')}
    <DesignSystem />
  {:else if endpoint === 'modal'}
    <Button onclick={() => endpointSection?.openUpstreamModal(0)}>Open endpoint</Button>
    <UpstreamsSection bind:this={endpointSection} bind:route={service} isService />
  {:else if endpoint === 'inline'}
    <UpstreamForm bind:upstream={service.endpoints[0]} index={0} onRemove={() => {}} onDuplicate={() => {}} />
  {:else if picker}
    <button onclick={() => { upstream = { target: 'https://manual.test' }; pickerGeneration++; }}>Use manual upstream</button>
    <button onclick={() => upstream.target = 'https://newer-edit.test'}>Edit endpoint</button>
    {#key pickerGeneration}<UpstreamSourcePicker bind:upstream />{/key}
    <output data-testid="picker-upstream">{JSON.stringify(upstream)}</output>{:else}<AccountsPage />{/if}
</main>
{/if}
