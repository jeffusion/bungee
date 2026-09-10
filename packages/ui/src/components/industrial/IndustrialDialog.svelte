<!-- Shared industrial chassis; shadcn owns portal, focus trap and dismissal.
     Keep scrollBody=false around inline dropdowns (Bits UI 0.22 has no Select portal). -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import * as Dialog from '$components/ui/dialog';
  import CornerBrackets from './CornerBrackets.svelte';
  let {
    open = $bindable(false), title, description, busy = false, closeLabel = 'Close',
    onOpenChange, width = '36rem', scrollBody = false, body, footer,
  }: {
    open?: boolean; title: string; description: string; busy?: boolean; closeLabel?: string;
    onOpenChange?: (open: boolean) => void; width?: string; scrollBody?: boolean;
    body: Snippet; footer?: Snippet;
  } = $props();
  let opener: HTMLElement | null = null;
  // Programmatic openers do not register a Dialog.Trigger in Bits UI 0.22.
  // Supply its supported focus destination; the primitive still owns focus handling.
  $effect.pre(() => { if (open) opener = document.activeElement instanceof HTMLElement ? document.activeElement : null; });
</script>

<Dialog.Root bind:open closeOnEscape={!busy} closeOnOutsideClick={!busy} closeFocus={() => opener}
  onOutsideClick={(event) => { if (busy) event.preventDefault(); }} {onOpenChange}>
  <Dialog.Content class="nx-panel-raised nx-bracketed flex max-h-[calc(100dvh-2rem)] flex-col gap-0 rounded-none border-carbon-600 bg-carbon-800 p-0 shadow-industrial overflow-visible"
    style={`width: min(${width}, calc(100vw - 2rem)); max-width: calc(100vw - 2rem)`}
    closeDisabled={busy} {closeLabel} closeClass="right-4 top-3 inline-flex h-7 w-7 items-center justify-center border-2 border-carbon-500 bg-transparent text-zinc-400 opacity-100 !ring-0 !ring-offset-0 ![box-shadow:none] !outline-0 focus:!outline-0 hover:border-nexus-500 hover:text-nexus-300 focus:border-nexus-500 focus:text-nexus-300 focus:bg-nexus-500/10">
    <CornerBrackets />
    <header class="nx-panel-head shrink-0 pr-14">
      <div class="min-w-0 space-y-1.5">
        <div class="nx-panel-head-title"><span class="nx-stripe shrink-0" aria-hidden="true"></span><Dialog.Title class="font-mono text-sm font-bold uppercase tracking-command break-words">{title}</Dialog.Title></div>
        <Dialog.Description class="text-sm text-zinc-400 break-words">{description}</Dialog.Description>
      </div>
    </header>
    <div data-dialog-body class="min-h-0 px-4 py-4 space-y-4" class:overflow-y-auto={scrollBody} class:overflow-visible={!scrollBody}>
      {@render body()}
    </div>
    {#if footer}
      <footer class="shrink-0 border-t border-carbon-600 px-4 py-3 flex flex-wrap justify-end gap-2 bg-carbon-900/60">
        {@render footer()}
      </footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
