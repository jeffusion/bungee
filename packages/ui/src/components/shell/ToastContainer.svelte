<!--
  ToastContainer — Stacks active toasts in the top-right corner of the
  viewport. Pointer-events disabled on the container itself so the page
  underneath is still interactive; each toast restores pointer-events.
-->
<script lang="ts">
  import { toast } from '$stores/toast';
  import Toast from './Toast.svelte';

  function handleClose(id: number) {
    toast.remove(id);
  }
</script>

<div
  class="fixed top-20 right-4 z-[100] flex flex-col gap-2 pointer-events-none"
  aria-live="polite"
  data-testid="toast-container"
>
  {#each $toast as item (item.id)}
    <Toast
      message={item.message}
      type={item.type}
      duration={item.duration}
      on:close={() => handleClose(item.id)}
    />
  {/each}
</div>
