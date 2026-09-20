<script lang="ts">
  import { confirmation, answerConfirmation } from '$stores/confirmation';
  import { IndustrialDialog } from '$components/industrial';
  import * as Dialog from '$components/ui/dialog';
  let last = $state<typeof $confirmation>(null);
  $effect.pre(() => { if ($confirmation) last = $confirmation; });
  let decision: boolean | null = null;
  function changed(open: boolean) {
    if (!open) queueMicrotask(() => { const answer = decision ?? false; decision = null; answerConfirmation(answer); });
  }
</script>
<IndustrialDialog open={$confirmation !== null} title={last?.title ?? ''} description={last?.message ?? ''} returnFocus={last?.opener} closeLabel={last?.cancelText ?? 'Close'}
  onOpenChange={changed}>
  {#snippet body()}<div data-testid="industrial-confirmation"></div>{/snippet}
  {#snippet footer()}
    <Dialog.Close class="nx-btn-outline" on:click={() => decision = false} data-testid="confirmation-cancel">{last?.cancelText}</Dialog.Close>
    <Dialog.Close class="nx-btn-primary" on:click={() => decision = true} data-testid="confirmation-accept">{last?.confirmText}</Dialog.Close>
  {/snippet}
</IndustrialDialog>
