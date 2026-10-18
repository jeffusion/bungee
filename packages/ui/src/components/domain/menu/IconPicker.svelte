<script lang="ts">
  import { onMount } from 'svelte';
  import type { MenuIconCollection, MenuIconSearch } from '@jeffusion/bungee-types';
  import { menuSessionGuard } from '$stores/menus';
  import { MenusAPI } from '$api/menus';
  import { _, isLoading } from '$i18n';
  import { IndustrialDialog, BSelect } from '$components/industrial';
  import { Button } from '$components/ui/button';
  import MenuIcon from './MenuIcon.svelte';
  import { setMenuIconRevision } from './menu-icons';
  let { open = $bindable(false), value, defaultIcon, onSelect, returnFocus }: {
    open?: boolean; value?: string; defaultIcon: string; onSelect: (icon: string | undefined) => void; returnFocus?: HTMLElement | null;
  } = $props();
  const recommended = ['lucide:layout-dashboard', 'lucide:route', 'lucide:server', 'lucide:file-text', 'lucide:settings', 'lucide:blocks', 'lucide:list-tree', 'lucide:folder'];
  const t = (key: string) => $isLoading ? '' : $_('menus.' + key);
  let collections = $state<readonly MenuIconCollection[]>([]), collection = $state('lucide'), query = $state(''), offset = $state(0);
  let result = $state<MenuIconSearch | null>(null), loading = $state(false), error = $state(false), collectionsError = $state(false);
  let retry = $state(0);
  let request = 0, alive = true, collectionRequest = 0;
  async function loadCollections() {
    const serial = ++collectionRequest, current = menuSessionGuard(); collectionsError = false;
    try {
      const response = await MenusAPI.collections();
      if (!alive || !current() || serial !== collectionRequest) return;
      collections = response.collections; setMenuIconRevision(response.revision);
      if (collections.length && !collections.some(item => item.id === collection)) collection = collections[0].id;
    } catch { if (alive && current() && serial === collectionRequest) collectionsError = true; }
  }
  onMount(() => { void loadCollections(); return () => { alive = false; request++; collectionRequest++; }; });
  $effect(() => {
    const active = open, selected = collection, search = query, start = offset, serial = ++request;
    retry;
    result = null; error = false; loading = active;
    if (!active) return;
    const current = menuSessionGuard();
    const timer = setTimeout(() => {
      void MenusAPI.search(selected, search, start).then(response => {
        if (!alive || !current() || serial !== request) return;
        setMenuIconRevision(response.revision); result = response; error = false;
      }).catch(() => { if (alive && current() && serial === request) { result = null; error = true; } })
        .finally(() => { if (alive && current() && serial === request) loading = false; });
    }, 300);
    return () => { clearTimeout(timer); };
  });
  function choose(icon?: string) { onSelect(icon); open = false; }
  function resetSearch() { offset = 0; }
</script>
<IndustrialDialog bind:open title={t('chooseIcon')} description={t('iconHelp')} width="44rem" scrollBody closeLabel={t('close')} {returnFocus}>
  {#snippet body()}
    <div class="flex flex-wrap items-center gap-3 text-sm text-zinc-300"><span>{t('currentIcon')}</span><MenuIcon icon={value ?? defaultIcon} /><span class="break-all font-mono">{value ?? defaultIcon}</span><Button variant="outline" size="sm" onclick={() => choose()}>{t('restoreIcon')}</Button></div>
    <div class="space-y-2"><p class="nx-field-label">{t('recommended')}</p><div class="flex flex-wrap gap-1">{#each recommended as icon}<button type="button" class="flex h-11 w-11 items-center justify-center border border-carbon-500 text-zinc-300 hover:border-nexus-500 hover:text-nexus-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-nexus-500" title={icon} aria-label={icon} aria-pressed={value === icon} onclick={() => choose(icon)}><MenuIcon {icon} /></button>{/each}</div></div>
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-[10rem_1fr]">
      <div class="space-y-1"><span class="nx-field-label">{t('collection')}</span><BSelect bind:value={collection} ariaLabel={t('collection')} options={collections.length ? collections.map(item => ({ value: item.id, label: item.title })) : [{ value: 'lucide', label: 'Lucide' }]} onchange={resetSearch} /></div>
      <label class="space-y-1"><span class="nx-field-label">{t('searchIcons')}</span><input class="nx-input w-full" type="search" bind:value={query} oninput={resetSearch} placeholder={t('searchHint')} /></label>
    </div>
    {#if collectionsError}<div role="status" class="flex items-center gap-3 text-sm text-amber-400">{t('iconsFailed')}<Button variant="ghost" size="sm" onclick={() => void loadCollections()}>{t('retry')}</Button></div>{/if}
    <div aria-live="polite" aria-busy={loading} class="text-sm text-zinc-400">{#if loading}{t('loading')}{:else if error}{t('iconsFailed')}{:else if result}{result.total} {t('results')}{/if}</div>
    {#if error}<Button variant="outline" onclick={() => retry++}>{t('retry')}</Button>{/if}
    <div class="grid grid-cols-4 gap-2 sm:grid-cols-8" data-testid="icon-search-results">{#each result?.items ?? [] as item (item.id)}<button type="button" title={item.name} aria-label={item.id} aria-pressed={(value ?? defaultIcon) === item.id} onclick={() => choose(item.id)} class={`flex min-h-[64px] flex-col items-center justify-center gap-2 overflow-hidden border px-1 text-zinc-300 hover:border-nexus-500 hover:text-nexus-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-nexus-500 ${(value ?? defaultIcon) === item.id ? 'border-nexus-500 bg-nexus-500/10' : 'border-carbon-600'}`}><MenuIcon icon={item.id} /><span class="w-full truncate text-center font-mono text-[10px]">{item.name}</span></button>{/each}</div>
    {#if result && result.total === 0}<p class="text-sm text-zinc-400">{t('noIcons')}</p>{/if}
    {#if result}<div class="flex items-center justify-between gap-3"><Button variant="outline" size="sm" disabled={loading || offset === 0} onclick={() => offset = Math.max(0, offset - 48)}>{t('previous')}</Button><span class="font-mono text-sm text-zinc-400">{Math.floor(offset / 48) + 1} / {Math.max(1, Math.ceil(result.total / 48))}</span><Button variant="outline" size="sm" disabled={loading || offset + 48 >= result.total} onclick={() => offset += 48}>{t('next')}</Button></div>{/if}
    {@const selectedCollection = collections.find(item => item.id === collection)}
    {#if selectedCollection}<p class="text-xs text-zinc-400">{selectedCollection.title} · {selectedCollection.license.title}{#if selectedCollection.license.url} · <a class="underline" href={selectedCollection.license.url} target="_blank" rel="noreferrer">{t('license')}</a>{/if}</p>{/if}
  {/snippet}
</IndustrialDialog>
