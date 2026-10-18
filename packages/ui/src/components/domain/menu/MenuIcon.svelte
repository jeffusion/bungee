<script lang="ts">
  import Icon from '@iconify/svelte';
  import { _, isLoading } from '$i18n';
  import type { MenuIconData } from '@jeffusion/bungee-types';
  import { loadMenuIcon, menuIconRevision } from './menu-icons';
  let { icon }: { icon: string } = $props();
  let data = $state<MenuIconData | null>(null);
  let failed = $state(false);
  $effect(() => {
    const id = icon;
    $menuIconRevision;
    let current = true;
    data = null; failed = false;
    void loadMenuIcon(id).then(result => { if (current) { data = result; failed = result === null; } })
      .catch(() => { if (current) { data = null; failed = true; } });
    return () => { current = false; };
  });
</script>
<span class="inline-flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true" title={failed && !$isLoading ? $_('menus.iconUnavailable') : undefined} data-menu-icon={icon} data-icon-state={failed ? 'error' : data ? 'ready' : 'empty'}>
  {#if data}<Icon icon={data} width={16} height={16} />{:else}<span class="h-1 w-1 bg-current opacity-40"></span>{/if}
</span>
