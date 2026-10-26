<script lang="ts">
  import SystemUpdates from '$components/domain/system/SystemUpdates.svelte';
  import ConfirmationHost from '$components/shell/ConfirmationHost.svelte';
</script>
<div class="min-h-screen bg-carbon-950 p-4 text-zinc-200">
  <label>Draft<input aria-label="Draft" class="bg-carbon-800" /></label>
  <SystemUpdates />
</div>
<ConfirmationHost />
