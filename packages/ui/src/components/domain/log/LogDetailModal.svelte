<script lang="ts">
  import { _ } from '$i18n';
  import type { LogEntry } from '$api/logs';
  import LogDetailContent from './LogDetailContent.svelte';

  export let log: LogEntry;
  export let onClose: () => void;

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }
</script>

<div
  class="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
  role="presentation"
  on:click={handleBackdropClick}
  on:keydown={(e) => e.key === 'Escape' && onClose()}
>
  <LogDetailContent {log} {onClose} showHeader={true} />
</div>
