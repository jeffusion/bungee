<!--
  ConfirmDialog — Industrial modal for destructive / weighty actions.

  Visual: opaque dark backdrop + nx-panel-raised centered, orange stripe +
  Orbitron-styled title, mono uppercase action labels. Confirm button
  varies by `confirmClass` prop using industrial button variants.

  API preserved:
    open: bool (two-way bound)
    title, message: string
    confirmText, cancelText: string
    confirmClass: string — 'nx-btn-danger' / 'nx-btn-primary' / other industrial variants
    on:confirm, on:cancel events
-->
<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { _ } from '$i18n';

  export let open = false;
  export let title = '';
  export let message = '';
  export let confirmText = '';
  export let cancelText = '';
  export let confirmClass = 'nx-btn-danger';

  $: finalTitle = title || $_('confirmDialog.title');
  $: finalMessage = message;
  $: finalConfirmText = confirmText || $_('confirmDialog.confirm');
  $: finalCancelText = cancelText || $_('confirmDialog.cancel');

  const dispatch = createEventDispatcher();

  $: confirmBtnClass = (() => {
    if (confirmClass.includes('nx-btn-danger')) return 'nx-btn-danger';
    if (confirmClass.includes('nx-btn-warn')) return 'nx-btn-warn';
    if (confirmClass.includes('nx-btn-outline')) return 'nx-btn-outline';
    if (confirmClass.includes('nx-btn-ghost')) return 'nx-btn-ghost';
    return 'nx-btn-primary';
  })();

  function handleConfirm() {
    dispatch('confirm');
    open = false;
  }

  function handleCancel() {
    dispatch('cancel');
    open = false;
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) handleCancel();
  }

  // Escape key closes the dialog.
  function handleKeydown(e: KeyboardEvent) {
    if (open && e.key === 'Escape') {
      e.stopPropagation();
      handleCancel();
    }
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeydown);
  });

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeydown);
  });
</script>

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <div
    class="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
    on:click={handleBackdropClick}
    role="dialog"
    aria-modal="true"
    aria-labelledby="confirm-dialog-title"
  >
    <div class="nx-panel-raised nx-bracketed relative w-full max-w-md">
      <!-- Corner brackets render via the parent's nx-bracketed contract
           through the same hover/focus styles; for static modal we still
           paint them so the chassis feel is consistent. -->
      <span class="nx-corner nx-corner-tl" aria-hidden="true"></span>
      <span class="nx-corner nx-corner-tr" aria-hidden="true"></span>
      <span class="nx-corner nx-corner-bl" aria-hidden="true"></span>
      <span class="nx-corner nx-corner-br" aria-hidden="true"></span>

      <!-- Header with orange stripe + title + close icon -->
      <header class="nx-panel-head">
        <div class="nx-panel-head-title">
          <span class="nx-stripe" aria-hidden="true"></span>
          <span id="confirm-dialog-title">{finalTitle}</span>
        </div>
        <button
          type="button"
          class="inline-flex items-center justify-center h-7 w-7 border-2 border-carbon-500 bg-transparent text-zinc-400 transition-colors hover:border-nexus-500 hover:text-nexus-300"
          on:click={handleCancel}
          title={finalCancelText}
          aria-label={finalCancelText}
        >
          <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2.4">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </header>

      <div class="nx-panel-body">
        <p class="text-sm text-zinc-300 leading-relaxed">{finalMessage}</p>
      </div>

      <footer class="border-t border-carbon-600 px-4 py-3 flex justify-end gap-2 bg-carbon-900/60">
        <button class="nx-btn-ghost" on:click={handleCancel} data-testid="confirm-dialog-cancel">
          {finalCancelText}
        </button>
        <button class={confirmBtnClass} on:click={handleConfirm} data-testid="confirm-dialog-confirm">
          {finalConfirmText}
        </button>
      </footer>
    </div>
  </div>
{/if}
