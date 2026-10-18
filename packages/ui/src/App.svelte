<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { guardedLocation as location, settingsDirty, dashboardDirty, menuDirty } from '$stores/navigation-guard';
  import { confirmAction } from '$stores/confirmation';
  import { toast } from '$stores/toast';
  import ConfirmationHost from '$components/shell/ConfirmationHost.svelte';
  import ConfigurationPublicationBanner from '$components/shell/ConfigurationPublicationBanner.svelte';
  import AppHeader from '$components/shell/AppHeader.svelte';
  import LazyPage from '$components/shell/LazyPage.svelte';
  import { isLoading } from 'svelte-i18n';
  import { _ } from '$i18n';
  import { loadPluginTranslations } from '$i18n/plugin-translations';
  import { isAuthenticated, authMode, subject, getAuthStateRevision, isAuthenticationStateCurrent } from '$stores/auth';
  import { restoreManagementSession, endSession } from '$api/auth';
  import { PluginsAPI } from '$api/plugins';
  import { pluginList } from '$stores/plugins';
  import Dashboard from './routes/Dashboard.svelte';
  const loadConfiguration = () => import('./routes/Configuration.svelte');
  import RoutesIndex from './routes/RoutesIndex.svelte';
  const loadRouteEditor = () => import('./routes/RouteEditor.svelte');
  import ServicesIndex from './routes/ServicesIndex.svelte';
  const loadServiceEditor = () => import('./routes/ServiceEditor.svelte');
  const loadMenus = () => import('./routes/Menus.svelte');
  const loadLogs = () => import('./routes/Logs.svelte');
  import Login from './routes/Login.svelte';
  import NotFound from './routes/NotFound.svelte';
  import ToastContainer from '$components/shell/ToastContainer.svelte';
  import PluginHost from '$components/shell/PluginHost.svelte';
  import PluginsPage from './routes/Plugins.svelte';
  import { getPluginText } from '$utils/plugin-i18n';
  import PluginDetailLayout from './routes/PluginDetailLayout.svelte';
  const loadDesignSystem = () => import('./routes/DesignSystem.svelte');
  import { menus, resetMenus, refreshMenus, updateMenuFallback } from '$stores/menus';
  import { effectiveMenu, fallbackMenuCatalog } from '$components/domain/menu/menu-model';
  import { LoadingIndicator } from '$components/industrial';

  let logoutBusy = $state(false);
  let authInitialized = $state(false);
  let modeReady = $state(false);
  let protectedInitialized = $state(false);
  let initializationError = $state('');
  let loginPageActive = $state(false);
  let protectedIdentity = $state('');
  let initializationGeneration = 0;
  let protectedGeneration = 0;
  let destroyed = false;
  const authenticationIdentity = $derived(JSON.stringify([
    $authMode?.mode, $authMode?.provider?.name, $authMode?.publicOrigin, $subject?.id,
  ]));
  const applicationReady = $derived(protectedInitialized && protectedIdentity === authenticationIdentity);

  onDestroy(() => { destroyed = true; initializationGeneration++; protectedGeneration++; resetMenus(); });
  $effect(() => {
    if (!$isAuthenticated) protectedInitialized = false;
    if ($authMode?.mode === 'plugin' && !$isAuthenticated) loginPageActive = true;
  });

  async function protectedInitialize(currentGuard: () => boolean = () => true): Promise<boolean> {
    const revision = getAuthStateRevision();
    const generation = ++protectedGeneration;
    const identity = authenticationIdentity;
    const current = () => !destroyed && generation === protectedGeneration
      && isAuthenticationStateCurrent(revision) && currentGuard()
      && get(isAuthenticated);
    if (!current()) return false;
    initializationError = '';
    if (applicationReady) return true;
    protectedInitialized = false;
    try {
      if (!await loadPluginTranslations(current)) return false;
      const plugins = await PluginsAPI.list({ preserveSessionOnUnauthorized: true });
      if (!current()) return false;
      pluginList.set(plugins);
      protectedIdentity = identity;
      protectedInitialized = true;
      return true;
    } catch {
      if (current()) initializationError = 'management.initializationFailed';
      return false;
    }
  }

  async function initializeAuthenticatedSession(): Promise<boolean> {
    const generation = ++initializationGeneration;
    const revision = getAuthStateRevision();
    protectedGeneration++;
    authInitialized = false;
    modeReady = false;
    protectedInitialized = false;
    initializationError = '';
    try {
      const mode = await restoreManagementSession();
      if (destroyed || generation !== initializationGeneration) return false;
      modeReady = true;
      loginPageActive = mode.mode === 'plugin' && !get(isAuthenticated);
      if (!get(isAuthenticated)) {
        if (mode.mode === 'plugin') window.location.hash = '#/login';
        return true;
      }
      return await protectedInitialize(() => generation === initializationGeneration);
    } catch {
      if (!destroyed && generation === initializationGeneration && isAuthenticationStateCurrent(revision)) {
        initializationError = 'management.stateUnavailable';
      }
      return false;
    } finally {
      if (!destroyed && generation === initializationGeneration) authInitialized = true;
    }
  }

  onMount(async () => {
    await initializeAuthenticatedSession();
  });

  async function handleAuthenticated(currentGuard: () => boolean): Promise<boolean> {
    const initialized = await protectedInitialize(currentGuard);
    return initialized && currentGuard() && !destroyed;
  }

  function handleLoginCompleted(): void {
    if (destroyed) return;
    loginPageActive = false;
    const path = window.location.hash.replace(/^#/, '').split('?', 1)[0];
    if (path === '/login') window.location.hash = '#/';
  }

  async function handleLogout(opener: HTMLElement): Promise<void> {
    if (logoutBusy || $authMode?.mode !== 'plugin' || !$isAuthenticated) return;
    const revision = getAuthStateRevision();
    const current = () => !destroyed && isAuthenticationStateCurrent(revision);
    logoutBusy = true;
    try {
      const warnings = [$_('login.logoutConfirm')];
      if ($settingsDirty) warnings.push($_('settings.leaveWarning'));
      if ($dashboardDirty) warnings.push($_('dashboardLayout.discardMessage'));
      if ($menuDirty) warnings.push($_('menus.leaveWarning'));
      const accepted = await confirmAction({
        opener,
        title: $_('login.logout'), message: warnings.join(' '),
        confirmText: $_('confirmDialog.confirm'), cancelText: $_('confirmDialog.cancel'),
      });
      if (!accepted || !current()) return;
      await endSession({ onCompleted: settledRevision => {
        if (destroyed || !isAuthenticationStateCurrent(settledRevision)) return;
        settingsDirty.set(false);
        dashboardDirty.set(false);
        menuDirty.set(false);
        resetMenus();
        pluginList.set([]);
        loginPageActive = true;
        window.location.hash = '#/login';
      } });
    } catch {
      if (current()) toast.show($_('login.logoutFailed'), 'error');
    } finally {
      if (!destroyed) logoutBusy = false;
    }
  }

  const fallbackCatalog = $derived(fallbackMenuCatalog($pluginList));
  let menuIdentity = '';
  let menuContributions = '';
  $effect(() => {
    const activeIdentity = applicationReady && $isAuthenticated ? JSON.stringify([authenticationIdentity, $subject, $authMode, getAuthStateRevision()]) : '';
    const signature = JSON.stringify(fallbackCatalog);
    if (activeIdentity !== menuIdentity) {
      menuIdentity = activeIdentity;
      menuContributions = signature;
      resetMenus(activeIdentity ? fallbackCatalog : []);
      if (activeIdentity) void refreshMenus();
    } else if (activeIdentity && signature !== menuContributions) {
      menuContributions = signature;
      updateMenuFallback(fallbackCatalog);
      void refreshMenus();
    }
  });
  const menuItems = $derived($isLoading ? [] : effectiveMenu($menus.snapshot.layout, $menus.snapshot.catalog,
    $location === '/login' && $authMode?.mode === 'anonymous' ? '/' : $location,
    page => page.source === 'plugin' ? getPluginText(page.label, page.pluginName ?? '', $_) : $_(page.label), $_('header.management')));

  const isOnLogin = $derived($location === '/login');
</script>

{#if $isLoading || !authInitialized}
  <!-- i18n initialization -->
  <div class="min-h-screen flex items-center justify-center bg-carbon-950">
    <LoadingIndicator label="INITIALIZING" size="lg" height="none" />
  </div>
{:else if modeReady && $authMode?.mode === 'plugin' && (!$isAuthenticated || loginPageActive || isOnLogin)}
  {#key ($isAuthenticated && !loginPageActive ? 'restored' : 'login')}<Login onAuthenticated={handleAuthenticated} onCompleted={handleLoginCompleted} />{/key}
{:else if !modeReady || !$isAuthenticated || !protectedInitialized}
  <div class="min-h-screen flex items-center justify-center p-4 bg-carbon-950"><p role="alert" class="text-sm text-red-400">{$_(initializationError || 'management.stateUnavailable')}</p></div>
{:else}
  <div class="min-h-screen bg-carbon-950 text-zinc-200 flex flex-col" style="--app-header-height: calc(48px + env(safe-area-inset-top))">
    {#if !isOnLogin}
      <!-- Top accent hairline -->
      <div class="h-px bg-gradient-to-r from-transparent via-nexus-500 to-transparent"></div>

      <AppHeader items={menuItems}
        showLogout={$authMode?.mode === 'plugin' && $isAuthenticated} {logoutBusy} onLogout={handleLogout} />
    {/if}

    <!-- ===== Routed content ============================================ -->
    <main class="flex-1 flex flex-col">
      <ConfigurationPublicationBanner />
      {#if $menus.error}<div role="status" class="border-b border-amber-500/40 bg-carbon-900 px-4 py-2 text-sm text-amber-400">{$_('menus.loadFailed')}</div>{/if}
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
      {:else if $location === '/menus'}
        <LazyPage load={loadMenus} props={{}} />
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

<svelte:window onfocus={() => { if (applicationReady && $isAuthenticated) void refreshMenus(); }} />
<ToastContainer />
<ConfirmationHost />
