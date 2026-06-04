<script lang="ts">
  import { onMount } from 'svelte';
  import { location } from 'svelte-spa-router';
  import { isLoading } from 'svelte-i18n';
  import { _, locale, SUPPORTED_LOCALES, switchLocale } from '$i18n';
  import { loadPluginTranslations } from '$i18n/plugin-translations';
  import { isAuthenticated, authRequired, getToken, logout } from '$stores/auth';
  import { getConfig } from '$api/config';
  import { pluginList, refreshPlugins } from '$stores/plugins';
  import Dashboard from './routes/Dashboard.svelte';
  import Configuration from './routes/Configuration.svelte';
  import RoutesIndex from './routes/RoutesIndex.svelte';
  import RouteEditor from './routes/RouteEditor.svelte';
  import ServicesIndex from './routes/ServicesIndex.svelte';
  import ServiceEditor from './routes/ServiceEditor.svelte';
  import Logs from './routes/Logs.svelte';
  import Login from './routes/Login.svelte';
  import NotFound from './routes/NotFound.svelte';
  import ToastContainer from '$components/shell/ToastContainer.svelte';
  import PluginHost from '$components/shell/PluginHost.svelte';
  import PluginsPage from './routes/Plugins.svelte';
  import PluginDetailLayout from './routes/PluginDetailLayout.svelte';
  import DesignSystem from './routes/DesignSystem.svelte';
  import { HudClock, LoadingIndicator, StatusBadge } from '$components/industrial';

  let secureChannel = false;

  function handleLocaleChange(newLocale: string) {
    switchLocale(newLocale);
  }

  onMount(async () => {
    try {
      await loadPluginTranslations();
      refreshPlugins();

      const config = await getConfig();
      const needAuth = config.auth?.enabled || false;
      authRequired.set(needAuth);
      secureChannel = needAuth;

      if (needAuth) {
        const token = getToken();
        isAuthenticated.set(!!token);

        if (!token && $location !== '/login') {
          window.location.hash = '#/login';
        }
      }
    } catch (error) {
      console.error('Failed to check auth status:', error);
    }
  });

  function handleLogout() {
    if (confirm($_('login.logoutConfirm'))) {
      logout();
      window.location.hash = '#/login';
    }
  }

  // Navigation items — each renders as a tab with a left orange caret when active.
  // Guard against $isLoading: svelte-i18n raises if `$_` is called before its
  // initial locale resource finishes loading. The translation stores get
  // re-evaluated automatically once $isLoading flips to false.
  $: navItems = $isLoading
    ? []
    : (() => {
        const items: Array<{ href: string; label: string; isActive: boolean }> = [
          { href: '/__ui/#/',         label: $_('nav.dashboard'),     isActive: $location === '/' },
          { href: '/__ui/#/routes',   label: $_('nav.routes'),        isActive: $location.startsWith('/routes') },
          { href: '/__ui/#/services', label: $_('nav.services'),      isActive: $location.startsWith('/services') },
          { href: '/__ui/#/logs',     label: $_('nav.logs'),          isActive: $location === '/logs' },
          { href: '/__ui/#/config',   label: $_('nav.configuration'), isActive: $location === '/config' },
          { href: '/__ui/#/plugins',  label: $_('nav.plugins'),       isActive: $location.startsWith('/plugins') },
        ];
        // Plugin nav contributions
        $pluginList.forEach((plugin) => {
          if (!plugin.enabled) return;
          const navs = plugin.metadata?.contributes?.navigation;
          if (navs) {
            navs.forEach((nav: any) => {
              if (nav.target === 'header') {
                items.push({
                  href: `/__ui/#/extensions/${plugin.name}${nav.path}`,
                  label: nav.label,
                  isActive: $location.startsWith(`/extensions/${plugin.name}${nav.path}`),
                });
              }
            });
          } else if (plugin.metadata?.menus) {
            plugin.metadata.menus.forEach((menu: any) => {
              if (menu.location === 'header') {
                items.push({
                  href: `/__ui/#/extensions/${plugin.name}${menu.path}`,
                  label: menu.title,
                  isActive: $location.startsWith(`/extensions/${plugin.name}${menu.path}`),
                });
              }
            });
          }
        });
        return items;
      })();

  $: isOnLogin = $location === '/login';
</script>

{#if $isLoading}
  <!-- i18n bootstrap -->
  <div class="min-h-screen flex items-center justify-center bg-carbon-950">
    <LoadingIndicator label="INITIALIZING" size="lg" height="none" />
  </div>
{:else}
  <div class="min-h-screen bg-carbon-950 text-zinc-200 flex flex-col">
    {#if !isOnLogin}
      <!-- Top accent hairline -->
      <div class="h-px bg-gradient-to-r from-transparent via-nexus-500 to-transparent"></div>

      <!-- ===== HUD top bar — 64px =================================== -->
      <header
        class="sticky top-0 z-50 h-16 flex items-stretch border-b border-carbon-600 bg-carbon-950/95 backdrop-blur"
      >
        <!-- Brand block -->
        <a
          href="/__ui/#/"
          class="flex items-center gap-3 px-5 hover:bg-carbon-800/60 transition-colors"
        >
          <span class="relative flex h-9 w-9 items-center justify-center border border-nexus-500/60 bg-carbon-900">
            <svg viewBox="0 0 24 24" class="h-5 w-5 text-nexus-500" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M13 3L5 13h6l-1 8l8-11h-6l1-7z" />
            </svg>
            <span class="absolute -bottom-1 -right-1 h-1.5 w-1.5 bg-nexus-500 shadow-glow-orange"></span>
          </span>
          <span class="flex flex-col leading-none">
            <span class="nx-display text-base text-zinc-50 tracking-[0.04em]">BUNGEE</span>
            <span class="mt-1 font-mono text-[9px] uppercase tracking-chiseled text-zinc-500">
              REVERSE PROXY · v4.0
            </span>
          </span>
        </a>

        <span class="self-stretch w-px bg-carbon-600"></span>

        <!-- Navigation tabs -->
        <nav class="flex-1 flex items-stretch overflow-x-auto">
          <ul class="flex items-stretch">
            {#each navItems as item}
              <li>
                <a
                  href={item.href}
                  class="nx-nav-tab"
                  class:is-active={item.isActive}
                >
                  {#if item.isActive}
                    <span class="nx-caret-left mr-1" aria-hidden="true"></span>
                  {/if}
                  <span>{item.label}</span>
                </a>
              </li>
            {/each}
          </ul>
        </nav>

        <span class="self-stretch w-px bg-carbon-600"></span>

        <!-- HUD clock -->
        <div class="hidden lg:flex items-center px-5">
          <HudClock />
        </div>

        <span class="hidden lg:block self-stretch w-px bg-carbon-600"></span>

        <!-- Channel security -->
        <div class="hidden xl:flex items-center px-4">
          {#if secureChannel}
            <StatusBadge variant="online" dot>SECURE</StatusBadge>
          {:else}
            <StatusBadge variant="muted">OPEN</StatusBadge>
          {/if}
        </div>

        <span class="hidden xl:block self-stretch w-px bg-carbon-600"></span>

        <!-- Locale -->
        <div class="relative group flex items-center">
          <button
            tabindex="0"
            class="h-full px-4 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-command text-zinc-400 hover:text-nexus-300 hover:bg-carbon-800 transition-colors"
          >
            <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" /></svg>
            <span>{($locale || '').toUpperCase()}</span>
          </button>
          <ul role="menu" tabindex="0" class="invisible absolute right-0 top-full z-50 mt-1 w-36 border border-carbon-500 bg-carbon-900 shadow-industrial-lg p-1 opacity-0 transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
            {#each SUPPORTED_LOCALES as supportedLocale}
              <li>
                <button
                  class="w-full text-left px-3 py-1.5 font-mono text-[11px] uppercase tracking-command transition-colors"
                  class:text-nexus-300={$locale === supportedLocale.code}
                  class:bg-carbon-800={$locale === supportedLocale.code}
                  class:text-zinc-400={$locale !== supportedLocale.code}
                  on:click={() => handleLocaleChange(supportedLocale.code)}
                >
                  {supportedLocale.name}
                </button>
              </li>
            {/each}
          </ul>
        </div>

        <!-- Logout -->
        {#if $authRequired && $isAuthenticated}
          <button
            class="px-4 flex items-center gap-1.5 border-l border-carbon-600 font-mono text-[11px] uppercase tracking-command text-zinc-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
            on:click={handleLogout}
          >
            <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
            <span class="hidden md:inline">{$_('login.logout')}</span>
          </button>
        {/if}
      </header>
    {/if}

    <!-- ===== Routed content ============================================ -->
    <main class="flex-1 flex flex-col">
      {#if $location === '/login'}
        <Login />
      {:else if $location === '/'}
        <Dashboard />
      {:else if $location === '/routes'}
        <RoutesIndex />
      {:else if $location.startsWith('/routes/edit/')}
        <RouteEditor params={{ path: $location.replace('/routes/edit/', '') }} />
      {:else if $location === '/routes/new'}
        <RouteEditor params={{}} />
      {:else if $location === '/services'}
        <ServicesIndex />
      {:else if $location.startsWith('/services/edit/')}
        <ServiceEditor params={{ name: $location.replace('/services/edit/', '') }} />
      {:else if $location === '/services/new'}
        <ServiceEditor params={{}} />
      {:else if $location === '/logs'}
        <Logs />
      {:else if $location === '/config'}
        <Configuration />
      {:else if $location === '/design'}
        <DesignSystem />
      {:else if $location === '/plugins'}
        <PluginsPage />
      {:else if $location.startsWith('/plugins/')}
        {@const pathParts = $location.replace('/plugins/', '').split('/')}
        {@const pluginName = pathParts[0]}
        <PluginDetailLayout params={{ name: pluginName }} />
      {:else if $location.startsWith('/extensions/')}
        {@const pathParts = $location.replace('/extensions/', '').split('/')}
        {@const pluginName = pathParts[0]}
        {@const pluginPath = '/' + pathParts.slice(1).join('/')}
        <PluginHost pluginName={pluginName} path={pluginPath} />
      {:else}
        <NotFound />
      {/if}
    </main>
  </div>
{/if}

<ToastContainer />

<style>
  /* ---- Navigation tab ----
   * Active tab gets orange text + bottom accent bar; the orange caret is
   * rendered inline by the markup (.nx-caret-left).
   */
  :global(.nx-nav-tab) {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    height: 100%;
    padding-left: 1rem;
    padding-right: 1rem;
    font-family: 'DM Mono', 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #a1a1aa;
    transition: color 0.12s ease-out, background-color 0.12s ease-out;
    position: relative;
    white-space: nowrap;
  }
  :global(.nx-nav-tab:hover) {
    color: #fdba74; /* nexus-300 */
    background-color: rgba(249, 115, 22, 0.04);
  }
  :global(.nx-nav-tab.is-active) {
    color: #f97316; /* nexus-500 */
  }
  :global(.nx-nav-tab.is-active::after) {
    content: '';
    position: absolute;
    bottom: 0;
    left: 0.5rem;
    right: 0.5rem;
    height: 2px;
    background-color: #f97316;
  }
</style>
