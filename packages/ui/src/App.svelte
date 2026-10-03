<script lang="ts">
  import { onMount } from 'svelte';
  import { guardedLocation as location } from '$stores/navigation-guard';
  import ConfirmationHost from '$components/shell/ConfirmationHost.svelte';
  import ConfigurationPublicationBanner from '$components/shell/ConfigurationPublicationBanner.svelte';
  import AppHeader from '$components/shell/AppHeader.svelte';
  import LazyPage from '$components/shell/LazyPage.svelte';
  import { isLoading } from 'svelte-i18n';
  import { _ } from '$i18n';
  import { loadPluginTranslations } from '$i18n/plugin-translations';
  import { isAuthenticated, logout, authMode } from '$stores/auth';
  import { readAuthMode, verifyToken } from '$api/auth';
  import { pluginList, refreshPlugins } from '$stores/plugins';
  import Dashboard from './routes/Dashboard.svelte';
  const loadConfiguration = () => import('./routes/Configuration.svelte');
  import RoutesIndex from './routes/RoutesIndex.svelte';
  const loadRouteEditor = () => import('./routes/RouteEditor.svelte');
  import ServicesIndex from './routes/ServicesIndex.svelte';
  const loadServiceEditor = () => import('./routes/ServiceEditor.svelte');
  const loadLogs = () => import('./routes/Logs.svelte');
  import Login from './routes/Login.svelte';
  import NotFound from './routes/NotFound.svelte';
  import ToastContainer from '$components/shell/ToastContainer.svelte';
  import PluginHost from '$components/shell/PluginHost.svelte';
  import PluginsPage from './routes/Plugins.svelte';
  import { getPluginText } from '$utils/plugin-i18n';
  import PluginDetailLayout from './routes/PluginDetailLayout.svelte';
  const loadDesignSystem = () => import('./routes/DesignSystem.svelte');
  import { LoadingIndicator } from '$components/industrial';

  const secureChannel = $derived($authMode?.mode === 'plugin');
  let authInitialized = $state(false);
  let protectedInitialized = $state(false);
  let initializationError = $state('');

  async function initializeAuthenticatedSession(): Promise<boolean> {
    initializationError = '';
    try {
      await readAuthMode();
      const result = await verifyToken();
      if (!result.success) throw new Error(result.error || 'Unauthorized');

      isAuthenticated.set(true);

      if (!protectedInitialized) {
        await loadPluginTranslations();
        await refreshPlugins();
        protectedInitialized = true;
      }

      return true;
    } catch (error) {
      initializationError = error instanceof Error ? error.message : '无法读取管理访问状态';
      logout();
      window.location.hash = '#/login';
      return false;
    } finally {
      authInitialized = true;
    }
  }

  onMount(async () => {
    await initializeAuthenticatedSession();
  });

  async function handleAuthenticated(): Promise<boolean> {
    const initialized = await initializeAuthenticatedSession();
    if (initialized) window.location.hash = '#/';
    return initialized;
  }

  // Navigation items share a sliding active indicator in the header.
  // Guard against $isLoading: svelte-i18n raises if `$_` is called before its
  // initial locale resource finishes loading. The translation stores get
  // re-evaluated automatically once $isLoading flips to false.
  const navItems = $derived($isLoading
    ? []
    : (() => {
        const items: Array<{ href: string; label: string; isActive: boolean }> = [
          { href: '/#/',         label: $_('nav.dashboard'),     isActive: ($location === '/' || ($location === '/login' && $authMode?.mode === 'anonymous')) },
          { href: '/#/routes',   label: $_('nav.routes'),        isActive: $location.startsWith('/routes') },
          { href: '/#/services', label: $_('nav.services'),      isActive: $location.startsWith('/services') },
          { href: '/#/logs',     label: $_('nav.logs'),          isActive: $location === '/logs' },
          { href: '/#/config',   label: $_('nav.configuration'), isActive: $location === '/config' },
          { href: '/#/plugins',  label: $_('nav.plugins'),       isActive: $location.startsWith('/plugins') },
        ];
        // Plugin nav contributions
        $pluginList.forEach((plugin) => {
          if (!plugin.enabled) return;
          const navs = plugin.metadata?.contributes?.navigation;
          if (navs) {
            navs.forEach((nav) => {
              if ((nav.target === 'header' || nav.target === 'sidebar')) {
                items.push({
                  href: `/#/extensions/${plugin.name}${nav.path}`,
                  label: getPluginText(nav.label, plugin.name, $_),
                  isActive: $location.startsWith(`/extensions/${plugin.name}${nav.path}`),
                });
              }
            });
          }
        });
        return items;
      })());

  const isOnLogin = $derived($location === '/login');
</script>

{#if $isLoading || !authInitialized}
  <!-- i18n initialization -->
  <div class="min-h-screen flex items-center justify-center bg-carbon-950">
    <LoadingIndicator label="INITIALIZING" size="lg" height="none" />
  </div>
{:else if (!$authMode || $authMode.mode === 'anonymous') && !$isAuthenticated}
  <div class="min-h-screen flex items-center justify-center bg-carbon-950"><div class="space-y-3"><p role="alert" class="text-sm text-red-400">{initializationError || '管理访问状态未就绪'}</p><button class="nx-btn-ghost" onclick={() => initializeAuthenticatedSession()}>重新检查</button></div></div>
{:else if $authMode?.mode === 'plugin' && (!$isAuthenticated || isOnLogin)}
  <Login onAuthenticated={handleAuthenticated} />
{:else}
  <div class="min-h-screen bg-carbon-950 text-zinc-200 flex flex-col" style="--app-header-height: calc(48px + env(safe-area-inset-top))">
    {#if !isOnLogin}
      <!-- Top accent hairline -->
      <div class="h-px bg-gradient-to-r from-transparent via-nexus-500 to-transparent"></div>

      <AppHeader items={navItems} {secureChannel} showLogout={false} />
    {/if}

    <!-- ===== Routed content ============================================ -->
    <main class="flex-1 flex flex-col">
      <ConfigurationPublicationBanner />
      {#if $location === '/' || ($location === '/login' && $authMode?.mode === 'anonymous')}
        <Dashboard />
      {:else if $location === '/routes'}
        <RoutesIndex />
      {:else if $location.startsWith('/routes/edit/')}
        <LazyPage load={loadRouteEditor} props={{ params: { path: $location.replace('/routes/edit/', '') } }} />
      {:else if $location === '/routes/new'}
        <LazyPage load={loadRouteEditor} props={{ params: {} }} />
      {:else if $location === '/services'}
        <ServicesIndex />
      {:else if $location.startsWith('/services/edit/')}
        <LazyPage load={loadServiceEditor} props={{ params: { name: $location.replace('/services/edit/', '') } }} />
      {:else if $location === '/services/new'}
        <LazyPage load={loadServiceEditor} props={{ params: {} }} />
      {:else if $location === '/logs'}
        <LazyPage load={loadLogs} props={{}} />
      {:else if $location === '/config'}
        <LazyPage load={loadConfiguration} props={{}} />
      {:else if $location === '/design'}
        <LazyPage load={loadDesignSystem} props={{}} />
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
        {#if $pluginList.some(plugin => plugin.enabled && plugin.name === pluginName && plugin.metadata?.contributes?.navigation?.some(page => page.path === pluginPath && page.component !== undefined))}
          <PluginDetailLayout params={{ name: pluginName, path: pluginPath }} />
        {:else}
          <div class="nx-page">
            <PluginHost pluginName={pluginName} path={pluginPath} />
          </div>
        {/if}
      {:else}
        <NotFound />
      {/if}
    </main>
  </div>
{/if}

<ToastContainer />
<ConfirmationHost />
