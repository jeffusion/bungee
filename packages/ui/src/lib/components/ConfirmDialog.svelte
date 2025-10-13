<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { _ } from '../i18n';

  export let open = false;
  export let title = '';
  export let message = '';
  export let confirmText = '';
  export let cancelText = '';
  export let confirmClass = 'btn-error';

  // Use i18n defaults if not provided
  $: finalTitle = title || $_('confirmDialog.title');
  $: finalMessage = message;
  $: finalConfirmText = confirmText || $_('confirmDialog.confirm');
  $: finalCancelText = cancelText || $_('confirmDialog.cancel');

  const dispatch = createEventDispatcher();

  function handleConfirm() {
    dispatch('confirm');
    open = false;
  }

  function handleCancel() {
    dispatch('cancel');
    open = false;
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      handleCancel();
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <dialog class="modal modal-open" on:click={handleBackdropClick}>
    <div class="modal-box">
      <h3 class="font-bold text-lg">{finalTitle}</h3>
      <p class="py-4">{finalMessage}</p>
      <div class="modal-action">
        <button class="btn" on:click={handleCancel}>{finalCancelText}</button>
        <button class="btn {confirmClass}" on:click={handleConfirm}>{finalConfirmText}</button>
      </div>
    </div>
  </dialog>
{/if}