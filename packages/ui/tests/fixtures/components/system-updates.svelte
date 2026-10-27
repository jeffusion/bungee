<script lang="ts">
  import AppHeader from '$components/shell/AppHeader.svelte';
  import ConfirmationHost from '$components/shell/ConfirmationHost.svelte';
</script>
<div class="min-h-screen bg-carbon-950 text-zinc-200">
  <AppHeader items={[]} showLogout={false} onLogout={() => {}} />
  <label class="m-4 block">Draft<input aria-label="Draft" class="bg-carbon-800" /></label>
</div>
<ConfirmationHost />
