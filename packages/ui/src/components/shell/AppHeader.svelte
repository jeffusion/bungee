<script lang="ts">
  import { _, isLoading, locale, SUPPORTED_LOCALES, switchLocale } from '$i18n';
  import * as DropdownMenu from '$components/ui/dropdown-menu';
  import { HudClock } from '$components/industrial';
  import Languages from 'lucide-svelte/icons/languages';
  import LogOut from 'lucide-svelte/icons/log-out';
  import MenuIcon from '$components/domain/menu/MenuIcon.svelte';
  import MenuGroup from './MenuGroup.svelte';
  import type { EffectiveMenu } from '$components/domain/menu/menu-model';
  let { items, showLogout, logoutBusy = false, onLogout }: {
    items: EffectiveMenu[]; showLogout: boolean; logoutBusy?: boolean; onLogout: (opener: HTMLElement) => void | Promise<void>;
  } = $props();
  let languageOpen = $state(false);
  const headerActionClass = 'header-action flex min-h-[44px] min-w-[44px] items-center justify-center gap-2 whitespace-nowrap font-mono text-[11px] font-semibold uppercase tracking-command transition-colors hover:bg-carbon-800 hover:text-nexus-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-nexus-500';
  const headerUtilityClass = `${headerActionClass} header-utility w-11 px-0`;
  const tabClass = `${headerActionClass} h-full px-3 text-zinc-400`;
</script>
<svelte:window onhashchange={() => { languageOpen = false; }} />
{#if !$isLoading}
<header data-testid="app-header" class="sticky top-0 z-50 flex h-[var(--app-header-height)] shrink-0 items-stretch border-b border-carbon-600 bg-carbon-950"
  style="padding-top: env(safe-area-inset-top); padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right)">
  <a href="/#/" aria-label="BUNGEE" class="flex min-w-0 shrink-0 items-center gap-3 px-2 transition-colors hover:bg-carbon-800 md:px-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-nexus-500">
    <span class="relative flex h-9 w-9 shrink-0 items-center justify-center border border-nexus-500/60 bg-carbon-900">
      <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5 text-nexus-500" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13 3L5 13h6l-1 8l8-11h-6l1-7z" /></svg>
      <span class="absolute -bottom-1 -right-1 h-1.5 w-1.5 bg-nexus-500 shadow-glow-orange"></span>
    </span>
    <span class="hidden flex-col leading-none sm:flex"><span class="nx-display text-base tracking-[0.04em] text-zinc-50">BUNGEE</span><span class="mt-1 font-mono text-[9px] uppercase tracking-chiseled text-zinc-500">REVERSE PROXY</span></span>
  </a>
  <nav aria-label={$_('header.navigation')} class="flex flex-1 border-l border-carbon-600" data-testid="header-top-menu">
    <ul class="flex items-stretch">
      {#each items as item (item.id)}<li class="shrink-0">
        {#if item.kind === 'page'}
          <a href={item.href} aria-current={item.active ? 'page' : undefined} class={`${tabClass} ${item.active ? 'border-b-2 border-nexus-500 bg-nexus-500/10 !text-nexus-300' : ''}`}><MenuIcon icon={item.icon} /><span>{item.label}</span></a>
        {:else}<MenuGroup {item} triggerClass={tabClass} />{/if}
      </li>{/each}
    </ul>
  </nav>
  <div class="hidden shrink-0 items-center border-l border-carbon-600 px-4 xl:flex"><HudClock /></div>
  <div class="flex shrink-0 items-stretch border-l border-carbon-600 md:border-l-0">
    <DropdownMenu.Root bind:open={languageOpen}>
      <DropdownMenu.Trigger id="header-language-trigger" aria-label={$_('header.language')} title={`${$_('header.language')} · ${SUPPORTED_LOCALES.find(item => item.code === $locale)?.name ?? $locale}`}
        class={`${headerUtilityClass} ${languageOpen ? 'bg-nexus-500/10 text-nexus-300' : 'text-zinc-500'}`}><Languages aria-hidden="true" class="h-4 w-4" /></DropdownMenu.Trigger>
      <DropdownMenu.Content data-testid="header-language-menu" align="end" sideOffset={8} class="z-[60] min-w-36 border-carbon-500 bg-carbon-900 text-zinc-200 shadow-industrial">
        <DropdownMenu.RadioGroup value={$locale || ''}>{#each SUPPORTED_LOCALES as supportedLocale}<DropdownMenu.RadioItem value={supportedLocale.code} class="min-h-[44px] font-mono" onclick={() => { switchLocale(supportedLocale.code); languageOpen = false; }}>{supportedLocale.name}</DropdownMenu.RadioItem>{/each}</DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>
  {#if showLogout}<button id="header-logout-button" type="button" aria-label={$_('login.logout')} title={$_('login.logout')} disabled={logoutBusy} aria-busy={logoutBusy} onclick={event => { void onLogout(event.currentTarget); }} class={`${headerUtilityClass} shrink-0 border-l border-carbon-600 text-zinc-500 disabled:cursor-not-allowed disabled:opacity-50 md:border-l-0`}><LogOut aria-hidden="true" class="h-4 w-4" /></button>{/if}
</header>
{/if}
