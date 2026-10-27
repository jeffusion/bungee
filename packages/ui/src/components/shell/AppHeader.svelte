<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { _, isLoading, locale, SUPPORTED_LOCALES, switchLocale } from '$i18n';
  import * as DropdownMenu from '$components/ui/dropdown-menu';
  import * as Sheet from '$components/ui/sheet';
  import { Button, buttonVariants } from '$components/ui/button';
  import { confirmation } from '$stores/confirmation';
  import Menu from 'lucide-svelte/icons/menu';
  import LayoutGrid from 'lucide-svelte/icons/layout-grid';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import { CornerBrackets, HudClock } from '$components/industrial';
  import Languages from 'lucide-svelte/icons/languages';
  import LogOut from 'lucide-svelte/icons/log-out';
  import MenuIcon from '$components/domain/menu/MenuIcon.svelte';
  import MenuGroup from './MenuGroup.svelte';
  import SystemUpdates from '$components/domain/system/SystemUpdates.svelte';
  import type { EffectiveMenu, EffectivePage } from '$components/domain/menu/menu-model';
  const moreControlWidth = 104;
  let { items, showLogout, logoutBusy = false, onLogout }: {
    items: EffectiveMenu[]; showLogout: boolean; logoutBusy?: boolean; onLogout: (opener: HTMLElement) => void | Promise<void>;
  } = $props();
  let languageOpen = $state(false);
  let menuOpen = $state(false);
  let desktop = $state(false);
  let moreOpen = $state(false);
  let visibleCount = $state(Infinity);
  const overflowItems = $derived(items.slice(visibleCount));
  const overflowActive = $derived(overflowItems.some(item => item.active));
  let brand: HTMLAnchorElement | null = $state(null);
  let collapsedSections = $state<Record<string, boolean>>({});
  $effect(() => {
    const activeSections = items.filter(item => item.kind === 'group' && item.active);
    if (menuOpen) untrack(() => {
      for (const section of activeSections) collapsedSections[section.id] = false;
    });
  });
  onMount(() => {
    const breakpoint = window.matchMedia('(min-width: 768px)');
    const update = () => { desktop = breakpoint.matches; menuOpen = false; languageOpen = false; moreOpen = false; };
    update(); breakpoint.addEventListener('change', update);
    return () => breakpoint.removeEventListener('change', update);
  });
  $effect(() => { if (!overflowItems.length) moreOpen = false; });
  function measureNavigation(node: HTMLElement) {
    const list = node.querySelector('ul')!;
    let alive = true;
    let overflowIdentity = '';
    function measure() {
      if (!node.clientWidth) return;
      const entries = Array.from(list.children) as HTMLElement[];
      const widths = entries.map(entry => entry.getBoundingClientRect().width);
      const available = node.clientWidth;
      let count = entries.length;
      if (widths.reduce((total, width) => total + width, 0) > available) {
        // Reserve the fixed-width More control before fitting whole menu items.
        let used = moreControlWidth;
        count = 0;
        for (const width of widths) {
          if (used + width > available) break;
          used += width; count++;
        }
      }
      const focused = entries.findIndex(entry => entry.contains(document.activeElement));
      const identity = JSON.stringify(items.slice(count).map(item => item.kind === 'group'
        ? [item.id, item.children.map(page => page.id)] : item.id));
      if (count !== visibleCount || identity !== overflowIdentity) moreOpen = false;
      overflowIdentity = identity;
      if (count === entries.length && $confirmation?.opener?.id === 'header-more-trigger') {
        confirmation.update(request => request ? { ...request, opener: brand } : request);
      }
      visibleCount = count;
      if (focused >= count) requestAnimationFrame(() => {
        if (alive) document.getElementById('header-more-trigger')?.focus({ preventScroll: true });
      });
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node); observer.observe(list);
    void document.fonts.ready.then(() => { if (alive) measure(); });
    measure();
    return { update: measure, destroy() { alive = false; observer.disconnect(); } };
  }
  function moreLifecycle(node: HTMLElement) {
    return { destroy() {
      if ($confirmation?.opener && node.contains($confirmation.opener)) confirmation.update(value => value ? {
        ...value, opener: document.getElementById('header-more-trigger') ?? brand,
      } : value);
    } };
  }
  function menuClosed() {
    const returnFocus = desktop ? brand : document.getElementById('header-menu-trigger');
    if ($confirmation?.opener?.closest('[data-testid="header-menu"]')) {
      confirmation.update(request => request ? { ...request, opener: returnFocus } : request);
    }
    if (!$confirmation) returnFocus?.focus({ preventScroll: true });
  }
  function selectNavigation(event: MouseEvent) {
    if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) menuOpen = false;
  }
  const headerActionClass = 'header-action flex min-h-[44px] min-w-[44px] items-center justify-center gap-2 whitespace-nowrap font-mono text-[11px] font-semibold uppercase tracking-command transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-nexus-500';
  const headerUtilityClass = `${headerActionClass} header-utility w-11 px-0 hover:bg-carbon-800 hover:text-nexus-300`;
  const tabClass = `${headerActionClass} header-tab relative h-full gap-[12px] px-[18px] text-zinc-300 hover:bg-carbon-700 hover:text-zinc-100 data-[state=open]:bg-carbon-700 data-[state=open]:text-zinc-100`;
</script>
{#snippet navigationLink(item: EffectivePage)}
  <Button href={item.href} variant="ghost" aria-current={item.active ? 'page' : undefined} onclick={selectNavigation}
  class={`drawer-page h-auto min-h-[44px] w-full justify-start gap-2 whitespace-normal border-0 border-l-[3px] px-3 py-2 text-left font-mono text-[11px] font-normal ${item.active ? 'border-nexus-500 bg-nexus-500/10 text-nexus-300' : 'border-transparent text-zinc-300 hover:bg-carbon-800'}`}>
    <MenuIcon icon={item.icon} /><span class="min-w-0 break-words [overflow-wrap:anywhere]">{item.label}</span>
  </Button>
{/snippet}
<svelte:window onhashchange={() => { languageOpen = false; menuOpen = false; moreOpen = false; }} />
{#if !$isLoading}
<header data-testid="app-header" class="sticky top-0 z-50 flex h-[var(--app-header-height)] w-full min-w-0 max-w-full shrink-0 items-stretch border-b border-carbon-600 bg-carbon-950"
  style="padding-top: env(safe-area-inset-top); padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right)">
  <div class="flex shrink-0 items-center pl-2 md:hidden">
    <Sheet.Root bind:open={menuOpen} preventScroll closeFocus={() => $confirmation ? null : desktop ? brand : document.getElementById('header-menu-trigger')}>
      <Sheet.Trigger id="header-menu-trigger" aria-label={$_('header.menu')} title={$_('header.menu')} class={`${headerUtilityClass} text-zinc-400`}>
        <Menu aria-hidden="true" class="h-4 w-4" />
      </Sheet.Trigger>
      <Sheet.Content side="left" data-testid="header-menu" class="nx-bracketed flex !h-dvh flex-col !gap-0 overflow-hidden border-carbon-600 bg-carbon-900 !p-0 !shadow-industrial"
        style="width: min(384px, calc(100vw - 24px)); max-width: none; padding-top: env(safe-area-inset-top); padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right); padding-bottom: env(safe-area-inset-bottom)"
        inTransitionConfig={{ x: '-100%', duration: 180, opacity: 1 }} outTransitionConfig={{ x: '-100%', duration: 200, opacity: 1 }}
        closeLabel={$_('header.closeMenu')} closeClass={buttonVariants({ variant: 'ghost', size: 'icon', className: '!h-[40px] !w-[40px] !right-[12px] !top-[calc(8px+env(safe-area-inset-top))] !opacity-100' })} onClosed={menuClosed}>
        <CornerBrackets />
        <div class="nx-panel-head min-h-[56px] shrink-0 pr-16">
          <div class="nx-panel-head-title"><span class="nx-stripe" aria-hidden="true"></span><Sheet.Title class="font-mono text-[16px] font-semibold uppercase tracking-command">{$_('header.navigation')}</Sheet.Title></div>
        </div>
        <Sheet.Description class="sr-only">{$_('header.description')}</Sheet.Description>
        <!-- Business pages remain reachable on short landscape screens. -->
        <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2 pt-1">
          <nav aria-label={$_('header.navigation')}>
            <ul>
              {#each items as item (item.id)}
                {#if item.kind === 'page'}
                  <li>{@render navigationLink(item)}</li>
                {:else}
                {@const contentId = `header-section-${encodeURIComponent(item.id)}`}
                <li data-testid="header-menu-section">
                  <button type="button" class="drawer-section flex min-h-[44px] w-full items-center gap-2 border-l-[3px] border-transparent px-3 text-left font-mono text-[11px] font-semibold uppercase tracking-command text-zinc-400 transition-colors hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-nexus-500"
                    aria-expanded={!collapsedSections[item.id]} aria-controls={contentId} onclick={() => collapsedSections[item.id] = !collapsedSections[item.id]}>
                    <MenuIcon icon={item.icon} /><span class="min-w-0 break-words [overflow-wrap:anywhere]">{item.label}</span><span class="min-w-4 flex-1 border-t border-carbon-600" aria-hidden="true"></span>
                    <ChevronDown class={`h-4 w-4 shrink-0 transition-transform duration-150 ${collapsedSections[item.id] ? '-rotate-90' : ''}`} aria-hidden="true" />
                  </button>
                  <ul id={contentId} class="drawer-pages ml-4 border-l border-carbon-600" hidden={collapsedSections[item.id]}>
                    {#each item.children as page (page.id)}<li>{@render navigationLink(page)}</li>{/each}
                  </ul>
                </li>
                {/if}
              {/each}
            </ul>
          </nav>
        </div>
      </Sheet.Content>
    </Sheet.Root>
  </div>

  <a bind:this={brand} href="/#/" aria-label="BUNGEE" class="flex min-w-0 shrink-0 items-center gap-[12px] px-2 transition-colors hover:bg-carbon-800 md:px-[18px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-nexus-500">
    <span class="relative flex h-[32px] w-[32px] shrink-0 items-center justify-center border border-nexus-500/60 bg-carbon-900">
      <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5 text-nexus-500" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13 3L5 13h6l-1 8l8-11h-6l1-7z" /></svg>
    </span>
    <span class="hidden flex-col leading-none sm:flex"><span class="nx-display text-[16px] tracking-[0.04em] text-zinc-50">BUNGEE</span><span class="mt-[5px] font-mono text-[9px] uppercase tracking-chiseled text-zinc-500">REVERSE PROXY</span></span>
  </a>
  <SystemUpdates returnFocus={brand} />
  <nav aria-label={$_('header.navigation')} use:measureNavigation={items} class="hidden w-0 min-w-0 flex-1 border-l border-carbon-600 md:flex" data-testid="header-top-menu">
    <div class="header-tabs-viewport min-w-0 flex-1 overflow-hidden">
    <ul class="flex h-full w-max items-stretch">
      {#each items as item, index (item.id)}<li class="shrink-0" class:invisible={index >= visibleCount} inert={index >= visibleCount} aria-hidden={index >= visibleCount ? true : undefined}>
        {#if item.kind === 'page'}
          <a href={item.href} aria-current={item.active ? 'page' : undefined} data-active={item.active} class={tabClass}><MenuIcon icon={item.icon} /><span>{item.label}</span></a>
        {:else}<MenuGroup {item} triggerClass={tabClass} visible={index < visibleCount} />{/if}
      </li>{/each}
    </ul>
    </div>
    {#if overflowItems.length}
      <DropdownMenu.Root bind:open={moreOpen} closeFocus={() => $confirmation ? null : document.getElementById('header-more-trigger') ?? brand}>
        <DropdownMenu.Trigger id="header-more-trigger" style={`width: ${moreControlWidth}px`} class={`${tabClass} shrink-0 gap-[8px] bg-carbon-800 ${overflowActive ? '!text-nexus-300' : ''}`} data-active={overflowActive}>
          <LayoutGrid class="h-[16px] w-[16px] shrink-0" aria-hidden="true" /><span>{$_('header.more')}</span><ChevronDown class="h-3 w-3 shrink-0" aria-hidden="true" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Content data-testid="header-more-menu" align="end" sideOffset={4} class="z-[60] w-max min-w-[160px] !max-w-[min(320px,calc(100vw-24px))] max-h-[calc(100dvh-64px)] overflow-y-auto border-carbon-600 bg-carbon-900 text-zinc-200 shadow-industrial">
          <div use:moreLifecycle class="space-y-1">
            {#each overflowItems as item, index (item.id)}
              {#if item.kind === 'group'}
                {#if index > 0}<DropdownMenu.Separator class="bg-carbon-600" />{/if}
                <DropdownMenu.Group class="space-y-1">
                  <DropdownMenu.Label class="font-mono text-[11px] font-normal text-zinc-400"><span class="min-w-0 break-words [overflow-wrap:anywhere]">{item.label}</span></DropdownMenu.Label>
                  {#each item.children as page (page.id)}
                    {@render overflowLink(page, true)}
                  {/each}
                </DropdownMenu.Group>
              {:else}{@render overflowLink(item)}{/if}
            {/each}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/if}
  </nav>
  <div class="header-clock hidden shrink-0 items-center border-l border-carbon-600 px-[18px] md:flex"><HudClock /></div>
  <div class="ml-auto flex shrink-0 items-stretch border-l border-carbon-600 md:ml-0 md:border-l-0">
    <DropdownMenu.Root bind:open={languageOpen}>
      <DropdownMenu.Trigger id="header-language-trigger" aria-label={$_('header.language')} title={`${$_('header.language')} · ${SUPPORTED_LOCALES.find(item => item.code === $locale)?.name ?? $locale}`}
        class={`${headerUtilityClass} ${languageOpen ? 'bg-nexus-500/10 text-nexus-300' : 'text-zinc-500'}`}><Languages aria-hidden="true" class="h-4 w-4" /></DropdownMenu.Trigger>
      <DropdownMenu.Content data-testid="header-language-menu" align="end" sideOffset={4} class="z-[60] min-w-36 border-carbon-500 bg-carbon-900 text-zinc-200 shadow-industrial">
        <DropdownMenu.RadioGroup value={$locale || ''} class="space-y-1">{#each SUPPORTED_LOCALES as supportedLocale}<DropdownMenu.RadioItem value={supportedLocale.code} class="min-h-[40px] font-mono" onclick={() => { switchLocale(supportedLocale.code); languageOpen = false; }}>{supportedLocale.name}</DropdownMenu.RadioItem>{/each}</DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>
  {#if showLogout}<button id="header-logout-button" type="button" aria-label={$_('login.logout')} title={$_('login.logout')} disabled={logoutBusy} aria-busy={logoutBusy} onclick={event => { void onLogout(event.currentTarget); }} class={`${headerUtilityClass} shrink-0 border-l border-carbon-600 text-zinc-500 disabled:cursor-not-allowed disabled:opacity-50 md:border-l-0`}><LogOut aria-hidden="true" class="h-4 w-4" /></button>{/if}
</header>
{/if}

{#snippet overflowLink(page: EffectivePage, nested = false)}
  <DropdownMenu.Item href={page.href} aria-current={page.active ? 'page' : undefined} class={`min-h-[40px] gap-2 text-[11px] data-[highlighted]:bg-carbon-700 ${nested ? 'pl-4' : ''} ${page.active ? 'bg-nexus-500/10 text-nexus-300 data-[highlighted]:text-nexus-300' : 'data-[highlighted]:text-zinc-100'}`}>
    <MenuIcon icon={page.icon} /><span class="min-w-0 break-words [overflow-wrap:anywhere]">{page.label}</span>
  </DropdownMenu.Item>
{/snippet}

<style>
  .drawer-section :global([data-menu-icon]), .drawer-page :global([data-menu-icon]) { width: 16px; height: 16px; flex-shrink: 0; }
  .header-tabs-viewport :global([data-menu-icon]) { width: 16px; height: 16px; flex-shrink: 0; }
  nav[data-testid="header-top-menu"] :global(.header-tab[data-active="true"]) { color: var(--nx-accent); }
  nav[data-testid="header-top-menu"] :global(.header-tab[data-active="true"])::after { content: ''; position: absolute; bottom: 0; left: 18px; right: 18px; height: 2px; background: var(--nx-accent); }
</style>
