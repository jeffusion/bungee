<script lang="ts">
  import { onMount } from 'svelte';
  import { guardedLocation as location, settingsDirty, dashboardDirty } from '$stores/navigation-guard';
  import { confirmAction } from '$stores/confirmation';
  import ConfirmationHost from '$components/shell/ConfirmationHost.svelte';
  import ConfigurationPublicationBanner from '$components/shell/ConfigurationPublicationBanner.svelte';
  import AppHeader from '$components/shell/AppHeader.svelte';
  import { isLoading } from 'svelte-i18n';
  import { _ } from '$i18n';
  import { loadPluginTranslations } from '$i18n/plugin-translations';
  import { isAuthenticated, authRequired, getToken, logout } from '$stores/auth';
  import { verifyToken } from '$api/auth';
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
  import { getPluginText } from '$utils/plugin-i18n';
  import PluginDetailLayout from './routes/PluginDetailLayout.svelte';
  import DesignSystem from './routes/DesignSystem.svelte';
  import { LoadingIndicator } from '$components/industrial';

  let secureChannel = $state(false);
  let authInitialized = $state(false);
  let protectedInitialized = $state(false);

  async function initializeAuthenticatedSession(
    verifyExistingToken: boolean,
    requiresAuth: boolean,
  ): Promise<boolean> {
    try {
      if (verifyExistingToken) {
        const result = await verifyToken();
        if (!result.success) {
          throw new Error(result.error || 'Unauthorized');
        }
      }

      authRequired.set(requiresAuth);
      isAuthenticated.set(true);
      secureChannel = requiresAuth;

      if (!protectedInitialized) {
        await loadPluginTranslations();
        await refreshPlugins();
        protectedInitialized = true;
      }

      return true;
    } catch (error) {
      logout();
      authRequired.set(true);
      secureChannel = false;
      window.location.hash = '#/login';
      return false;
    } finally {
      authInitialized = true;
    }
  }

  onMount(async () => {
    const currentToken = getToken();
    await initializeAuthenticatedSession(true, currentToken !== null);
  });

  async function handleAuthenticated(): Promise<boolean> {
    const initialized = await initializeAuthenticatedSession(false, true);
    if (initialized) window.location.hash = '#/';
    return initialized;
  }

  async function handleLogout() {
    if (await confirmAction({ title: $_('login.logout'), message: $_('login.logoutConfirm') + ($dashboardDirty ? ` ${$_('dashboardLayout.discardMessage')}` : $settingsDirty ? ` ${$_('settings.leaveWarning')}` : ''),
      confirmText: $_('confirmDialog.confirm'), cancelText: $_('confirmDialog.cancel') })) {
      settingsDirty.set(false); dashboardDirty.set(false);
      logout();
      window.location.hash = '#/login';
    }
  }

  // Navigation items — each renders as a tab with a left orange caret when active.
  // Guard against $isLoading: svelte-i18n raises if `$_` is called before its
  // initial locale resource finishes loading. The translation stores get
  // re-evaluated automatically once $isLoading flips to false.
  const navItems = $derived($isLoading
    ? []
    : (() => {
        const items: Array<{ href: string; label: string; isActive: boolean }> = [
          { href: '/#/',         label: $_('nav.dashboard'),     isActive: $location === '/' },
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
              if (nav.target === 'header') {
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
{:else if !$isAuthenticated || isOnLogin}
  <Login onAuthenticated={handleAuthenticated} />
{:else}
  <div class="min-h-screen bg-carbon-950 text-zinc-200 flex flex-col">
    {#if !isOnLogin}
      <!-- Top accent hairline -->
      <div class="h-px bg-gradient-to-r from-transparent via-nexus-500 to-transparent"></div>

      <AppHeader items={navItems} {secureChannel} showLogout={$authRequired && $isAuthenticated} onLogout={handleLogout} />
    {/if}

    <!-- ===== Routed content ============================================ -->
    <main class="flex-1 flex flex-col">
      <ConfigurationPublicationBanner />
      {#if $location === '/'}
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
        {#if $pluginList.some(plugin => plugin.name === pluginName && plugin.metadata?.contributes?.navigation?.some(page => page.path === pluginPath && page.component !== undefined))}
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
