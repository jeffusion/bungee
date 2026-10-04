<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { _, locale, SUPPORTED_LOCALES, switchLocale } from '$i18n';
  import { confirmation } from '$stores/confirmation';
  import * as Sheet from '$components/ui/sheet';
  import * as DropdownMenu from '$components/ui/dropdown-menu';
  import { Button, buttonVariants } from '$components/ui/button';
  import { CornerBrackets, HudClock } from '$components/industrial';
  import Menu from 'lucide-svelte/icons/menu';
  import Languages from 'lucide-svelte/icons/languages';
  import LogOut from 'lucide-svelte/icons/log-out';

  let { items, showLogout, logoutBusy = false, onLogout }: {
    items: Array<{ href: string; label: string; isActive: boolean }>;
    showLogout: boolean;
    logoutBusy?: boolean;
    onLogout: () => void | Promise<void>;
  } = $props();

  let menuOpen = $state(false);
  let localeOpen = $state(false);
  let desktop = $state(false);
  let logoutPending = false;
  let brand: HTMLAnchorElement;
  let navigation = $state<HTMLUListElement>();
  let indicator = $state({ left: 0, width: 0 });
  const activeIndex = $derived(items.findIndex(item => item.isActive));

  $effect(() => {
    const index = items.findIndex(item => item.isActive);
    const list = navigation;
    if (!desktop || index < 0 || !list) return;
    const updateIndicator = () => {
      const tab = list.children[index].getBoundingClientRect();
      indicator = { left: tab.left - list.getBoundingClientRect().left, width: tab.width };
    };
    // Track font loading, translations and resizing as well as route changes.
    const observer = new ResizeObserver(updateIndicator);
    let cancelled = false;
    void tick().then(() => {
      if (cancelled) return;
      updateIndicator();
      observer.observe(list);
      for (const tab of list.querySelectorAll('.header-tab')) observer.observe(tab);
      list.children[index]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    return () => { cancelled = true; observer.disconnect(); };
  });

  onMount(() => {
    const breakpoint = window.matchMedia('(min-width: 768px)');
    const update = () => {
      desktop = breakpoint.matches;
      // Close through the primitive, not CSS hiding: release its focus trap and scroll lock.
      menuOpen = false;
      localeOpen = false;
    };
    update();
    breakpoint.addEventListener('change', update);
    return () => breakpoint.removeEventListener('change', update);
  });

  function menuClosed() {
    const returnFocus = desktop ? brand : document.getElementById('header-menu-trigger');
    // The guard captured a link inside this now-detached sheet. Its confirmation
    // must return to the still-visible menu key, not to that removed link.
    if ($confirmation?.opener?.closest('[data-testid="header-menu"]')) {
      confirmation.update(request => request ? { ...request, opener: returnFocus } : request);
    }
    // Route mounting can replace the primitive's initial focus destination.
    // Do not steal focus from an unsaved-changes confirmation opened by the navigation guard.
    if (!$confirmation) returnFocus?.focus({ preventScroll: true });
    // Wait for the sheet to release its modal state before opening logout confirmation.
    if (logoutPending) { logoutPending = false; void onLogout(); }
  }

  function selectNavigation(event: MouseEvent) {
    if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) menuOpen = false;
  }
</script>

<!-- Also close when the existing unsaved-changes guard intercepts the link click. -->
<svelte:window onhashchange={() => { menuOpen = false; localeOpen = false; }} />

<header data-testid="app-header" class="sticky top-0 z-50 flex h-[var(--app-header-height)] shrink-0 items-stretch border-b border-carbon-600 bg-carbon-950"
  style="padding-top: env(safe-area-inset-top); padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right)">
  <a bind:this={brand} href="/#/" class="flex min-w-0 shrink-0 items-center gap-3 px-4 transition-colors hover:bg-carbon-800 xl:px-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-nexus-500">
    <span class="relative flex h-9 w-9 shrink-0 items-center justify-center border border-nexus-500/60 bg-carbon-900">
      <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5 text-nexus-500" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13 3L5 13h6l-1 8l8-11h-6l1-7z" /></svg>
      <span class="absolute -bottom-1 -right-1 h-1.5 w-1.5 bg-nexus-500 shadow-glow-orange"></span>
    </span>
    <span class="flex flex-col leading-none">
      <span class="nx-display text-base tracking-[0.04em] text-zinc-50">BUNGEE</span>
      <span class="mt-1 font-mono text-[9px] uppercase tracking-chiseled text-zinc-500">REVERSE PROXY</span>
    </span>
  </a>

  <!-- Scroll plugin contributions horizontally to keep the header height fixed. -->
  <nav aria-label={$_('header.navigation')} class="header-navigation hidden min-w-0 flex-1 overflow-x-auto border-l border-carbon-600 md:flex">
    <ul bind:this={navigation} class="relative flex min-w-full shrink-0 items-stretch">
      {#each items as item (item.href)}
        <li class="shrink-0">
          <a href={item.href} aria-current={item.isActive ? 'page' : undefined}
            class="header-tab relative flex h-full items-center justify-center whitespace-nowrap px-[calc(1rem+(5px+0.375rem)/2)] font-mono text-[11px] font-semibold uppercase tracking-command text-zinc-400 transition-colors hover:bg-nexus-500/5 hover:text-nexus-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-nexus-500"
            class:is-active={item.isActive}>
            <!-- Split the original 5px caret + gap-1.5 across both sides: same hitbox, centered label. -->
            <span class="nx-caret-left absolute left-[calc(1rem-(5px+0.375rem)/2)]" class:invisible={!item.isActive} aria-hidden="true"></span>
            <span title={item.label}>{item.label}</span>
          </a>
        </li>
      {/each}
      <li aria-hidden="true" class="pointer-events-none absolute bottom-0 left-0 h-0.5 bg-nexus-500 motion-safe:transition-[transform,width] motion-safe:duration-200 motion-safe:ease-out"
        style:width={`${indicator.width}px`} style:transform={`translateX(${indicator.left}px)`} style:visibility={desktop && activeIndex >= 0 ? 'visible' : 'hidden'}></li>
    </ul>
  </nav>

  <div class="hidden shrink-0 items-center border-l border-carbon-600 px-4 md:flex"><HudClock /></div>

  <div class="hidden shrink-0 items-stretch border-l border-carbon-600 md:flex">
    <DropdownMenu.Root bind:open={localeOpen}>
      <DropdownMenu.Trigger aria-label={$_('header.language')} class="flex min-h-[44px] items-center gap-2 px-4 font-mono text-[11px] uppercase tracking-command text-zinc-400 transition-colors hover:bg-carbon-800 hover:text-nexus-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-nexus-500">
        <Languages aria-hidden="true" class="h-4 w-4" /><span>{($locale || '').toUpperCase()}</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="z-[60] min-w-36 border-carbon-500 bg-carbon-900 text-zinc-200 shadow-industrial">
        {#each SUPPORTED_LOCALES as supportedLocale}
          <DropdownMenu.Item class="font-mono" onclick={() => { switchLocale(supportedLocale.code); localeOpen = false; }}>
            <span class:text-nexus-300={$locale === supportedLocale.code}>{supportedLocale.name}</span>
          </DropdownMenu.Item>
        {/each}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
    {#if showLogout}
      <Button variant="ghost" disabled={logoutBusy} aria-busy={logoutBusy} class="h-auto min-h-[44px] gap-2 border-0 border-l border-carbon-600 px-4 font-mono text-zinc-400 hover:bg-carbon-800" onclick={() => void onLogout()}>
        <LogOut aria-hidden="true" class="h-4 w-4" />{$_('login.logout')}
      </Button>
    {/if}
  </div>

  <div class="ml-auto flex shrink-0 items-center px-3 md:hidden">
    <Sheet.Root bind:open={menuOpen} preventScroll closeFocus={() => $confirmation ? null : desktop ? brand : document.getElementById('header-menu-trigger')}>
      <Sheet.Trigger id="header-menu-trigger" class={buttonVariants({ variant: 'ghost', className: 'gap-2' })}>
        <Menu aria-hidden="true" class="h-4 w-4" /><span>{$_('header.menu')}</span>
      </Sheet.Trigger>
      <Sheet.Content side="right" data-testid="header-menu" class="nx-bracketed flex !h-dvh flex-col !gap-0 overflow-hidden border-carbon-600 bg-carbon-900 !p-0 !shadow-industrial"
        style="width: min(24rem, calc(100vw - 24px)); max-width: none; padding-top: env(safe-area-inset-top); padding-right: env(safe-area-inset-right); padding-bottom: env(safe-area-inset-bottom)"
        inTransitionConfig={{ x: '100%', duration: 180, opacity: 1 }} outTransitionConfig={{ x: '100%', duration: 200, opacity: 1 }}
        closeLabel={$_('header.closeMenu')} closeClass={buttonVariants({ variant: 'ghost', size: 'icon', className: '!right-3 !top-[calc(7px+env(safe-area-inset-top))] !opacity-100' })} onClosed={menuClosed}>
        <CornerBrackets />
        <div class="nx-panel-head min-h-[48px] shrink-0 pr-16">
          <div class="nx-panel-head-title"><span class="nx-stripe" aria-hidden="true"></span><Sheet.Title class="font-mono text-sm font-semibold uppercase tracking-command">{$_('header.navigation')}</Sheet.Title></div>
        </div>
        <Sheet.Description class="sr-only">{$_('header.description')}</Sheet.Description>
        <!-- One scroll region keeps navigation AND account actions reachable on short landscape screens. -->
        <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
          <nav aria-label={$_('header.navigation')}>
            <ul class="space-y-1">
              {#each items as item}
                <li>
                  <Button href={item.href} variant="ghost" aria-current={item.isActive ? 'page' : undefined} onclick={selectNavigation}
                    class={`h-auto min-h-[34px] w-full justify-start gap-2 whitespace-normal border-0 border-l-2 px-3 py-1.5 text-left font-mono ${item.isActive ? 'border-nexus-500 bg-nexus-500/10 text-nexus-300' : 'border-transparent text-zinc-300 hover:bg-carbon-800'}`}>
                    <span class="nx-caret-left shrink-0" class:invisible={!item.isActive} aria-hidden="true"></span>
                    <span class="min-w-0 break-words [overflow-wrap:anywhere]">{item.label}</span>
                  </Button>
                </li>
              {/each}
            </ul>
          </nav>
          <section aria-label={$_('header.language')} class="mt-4 space-y-3 border-t border-carbon-600 px-3 pt-4">
            <h2 class="flex items-center gap-2 font-mono text-sm font-semibold text-zinc-400"><Languages aria-hidden="true" class="h-4 w-4" />{$_('header.language')}</h2>
            <div class="grid grid-cols-2 gap-2">
              {#each SUPPORTED_LOCALES as supportedLocale}
                <Button variant="ghost" aria-pressed={$locale === supportedLocale.code} onclick={() => switchLocale(supportedLocale.code)}
                  class={$locale === supportedLocale.code ? 'border-nexus-500 bg-nexus-500/10 text-nexus-300' : ''}>
                  {supportedLocale.name}
                </Button>
              {/each}
            </div>
          </section>
          {#if showLogout}
            <div class="mt-4 border-t border-carbon-600 px-3 pt-4">
              <Button variant="ghost" disabled={logoutBusy} aria-busy={logoutBusy} class="gap-2" onclick={() => { logoutPending = true; menuOpen = false; }}>
                <LogOut aria-hidden="true" class="h-4 w-4" />{$_('login.logout')}
              </Button>
            </div>
          {/if}
        </div>
      </Sheet.Content>
    </Sheet.Root>
  </div>
</header>

<style>
  .header-navigation { scrollbar-width: none; }
  .header-navigation::-webkit-scrollbar { display: none; }
  .header-tab.is-active { color: var(--nx-accent); }
</style>
