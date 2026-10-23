<script lang="ts">
  import type { Upstream } from '$api/routes';
  import { _ } from '$i18n';
  import { IconButton, BSwitch } from '$components/industrial';
  import { NumberInput } from '$components/ui/number-input';
  let { upstream, onedit, onremove, onduplicate, ontogglestatus, onupdateweight }: {
    upstream: Upstream; onedit: () => void; onremove: () => void; onduplicate: () => void;
    ontogglestatus: () => void; onupdateweight: (weight: number | undefined) => void;
  } = $props();
</script>

<div
  class="flex items-center gap-2 sm:gap-3 flex-wrap border border-carbon-600 bg-carbon-900/60 px-3 py-2 transition-colors hover:border-nexus-500/40 hover:bg-carbon-700/40"
  class:opacity-50={upstream.is_disabled}
>
  <!-- Drag handle -->
  <div class="text-zinc-500 hover:text-zinc-300" role="img" aria-label="Drag handle">
    <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="M4 8h16M4 16h16" />
    </svg>
  </div>

  <BSwitch
    size="small"
    showChildren={false}
    checked={!upstream.is_disabled}
    onchange={ontogglestatus}
    description={upstream.is_disabled ? $_('upstream.enableTooltip') : $_('upstream.disableTooltip')}
  />

  <div class="flex-1 min-w-24">
    <div class="flex items-center gap-2 min-w-0">
      <span class="nx-label-sm shrink-0">EP</span>
      <span class="font-mono text-[12px] text-zinc-100 truncate" title={upstream.target}>{upstream.target}</span>
    </div>
    {#if upstream.description}<div class="font-mono text-[10px] text-zinc-400 truncate" title={upstream.description}>{upstream.description}</div>{/if}
  </div>
  {#if upstream.condition}<code class="hidden md:block font-mono text-[11px] text-nexus-300 truncate max-w-40" title={upstream.condition}>{upstream.condition}</code>{/if}
  <div class="flex items-center gap-2 ml-auto">
    <span class="nx-label-sm">W:</span>
    <div class="w-24"><NumberInput bind:value={() => upstream.weight, onupdateweight}
      required emptyValue={0} min={1} max={Number.MAX_SAFE_INTEGER} aria-label={$_('upstream.weight')} class="h-7 text-[11px]"
      increaseLabel="+" decreaseLabel="−" invalidMessage={$_('serviceReferences.positiveInteger')} /></div>
  </div>

  <!-- Actions -->
  <div class="flex items-center gap-1">
    <IconButton size="sm" title={$_('common.edit')} on:click={onedit} data-testid="upstream-edit-button">
      <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8">
        <path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
      </svg>
    </IconButton>
    <IconButton size="sm" title={$_('routeCard.duplicate')} on:click={onduplicate}>
      <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8">
        <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
      </svg>
    </IconButton>
    <IconButton size="sm" variant="danger" title={$_('common.delete')} on:click={onremove} data-testid="upstream-delete-button">
      <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </IconButton>
  </div>
</div>
