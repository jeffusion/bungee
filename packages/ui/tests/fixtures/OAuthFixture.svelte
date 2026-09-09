<script lang="ts">
  import AccountsPage from '@plugins/chatgpt-oauth/ui/AccountsPage.svelte';
  import UpstreamSourcePicker from '$components/domain/route/UpstreamSourcePicker.svelte';
  import type { EditorUpstream } from '$api/config-adapters';
  const picker = new URLSearchParams(window.location.search).get('picker');
  let upstream = $state<EditorUpstream>(picker === 'missing' ? {
    target: 'https://chatgpt.com/backend-api/codex/responses',
    managedBy: { plugin: 'chatgpt-oauth', contributionId: 'chatgpt', bindingId: 'binding' },
    plugins: [{ _uid: 'binding', name: 'chatgpt-oauth', enabled: true, options: { accountRef: 'missing-account' } }],
  } : { target: '' });
</script>
<main class="nx-page py-6">{#if picker}<UpstreamSourcePicker bind:upstream />{:else}<AccountsPage />{/if}</main>
