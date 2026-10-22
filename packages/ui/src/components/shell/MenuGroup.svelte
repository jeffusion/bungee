<script lang="ts">
  import * as DropdownMenu from '$components/ui/dropdown-menu';
  import { confirmation } from '$stores/confirmation';
  import MenuIcon from '$components/domain/menu/MenuIcon.svelte';
  import type { EffectiveGroup } from '$components/domain/menu/menu-model';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  let { item, triggerClass, visible = true }: { item: EffectiveGroup; triggerClass: string; visible?: boolean } = $props();
  let open = $state(false);
  $effect(() => { if (!visible) open = false; });
  const triggerId = $derived(`menu-group-${encodeURIComponent(item.id)}`);
  function lifecycle(node: HTMLElement) { return { destroy() {
    if ($confirmation?.opener && node.contains($confirmation.opener)) confirmation.update(value => value ? { ...value, opener: document.getElementById(triggerId) } : value);
  } }; }
</script>
<svelte:window onhashchange={() => { open = false; }} />
<DropdownMenu.Root bind:open closeFocus={() => $confirmation ? null : document.getElementById(visible ? triggerId : 'header-more-trigger')}>
  <DropdownMenu.Trigger id={triggerId} class={triggerClass} aria-label={item.label} data-active={item.active}>
    <MenuIcon icon={item.icon} /><span>{item.label}</span><ChevronDown class="h-3 w-3" aria-hidden="true" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="start" sideOffset={4} class="z-[60] max-h-[calc(100dvh-64px)] w-max min-w-[192px] max-w-[min(320px,calc(100vw-24px))] overflow-y-auto border-carbon-600 bg-carbon-900 p-[12px] text-zinc-200 shadow-industrial">
    <div use:lifecycle>
      {#each item.children as page (page.id)}
        <DropdownMenu.Item href={page.href} aria-current={page.active ? 'page' : undefined} class={`min-h-[44px] gap-[12px] px-[12px] text-[14px] ${page.active ? 'bg-nexus-500/10 text-nexus-300' : ''}`}>
          <MenuIcon icon={page.icon} /><span class="break-words [overflow-wrap:anywhere]">{page.label}</span>
        </DropdownMenu.Item>
      {/each}
    </div>
  </DropdownMenu.Content>
</DropdownMenu.Root>
