import { expect, test } from 'bun:test';

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

test('startup restores the session once before protected initialization; no global credential menus', async () => {
  const source = await read('../App.svelte');
  const startup = source.slice(source.indexOf('async function initializeAuthenticatedSession'), source.indexOf('onMount(async'));
  expect(startup.indexOf('await restoreManagementSession()')).toBeGreaterThanOrEqual(0);
  expect(startup.indexOf('await restoreManagementSession()')).toBeLessThan(startup.indexOf('await protectedInitialize('));
  expect(startup).toContain("if (mode.mode === 'plugin') window.location.hash = '#/login'");
  expect(startup).not.toContain('get(location)');
  expect(startup).not.toContain('initialLocation');
  expect(startup).toContain('destroyed || generation !== initializationGeneration');
  expect(startup).toContain('isAuthenticationStateCurrent(revision)');
  expect(source).not.toContain('verifyToken');
  expect(source).not.toContain('readAuthMode');
  expect(source).not.toContain('logout(');
  expect(source).toContain('loginPageActive || isOnLogin');
  expect(source).toContain("modeReady && $authMode?.mode === 'plugin'");
  expect(source).toContain("$isAuthenticated && !loginPageActive ? 'restored' : 'login'");
  expect(source).toContain('!protectedInitialized');
  expect(source).not.toContain('$capabilities');
  for (const path of ['/#/keys', '/#/password']) expect(source).not.toContain(path);
  expect(source).toContain("showLogout={$authMode?.mode === 'plugin' && $isAuthenticated}");
  expect(source).toContain('onLogout={handleLogout}');
});

test('identity invalidates the initialization cache without unmounting the shell during authentication handoffs', async () => {
  const source = await read('../App.svelte');
  const template = source.slice(source.indexOf('</script>'));
  expect(template).toContain('{:else if !modeReady || !$isAuthenticated || !protectedInitialized}');
  for (const cacheState of ['applicationReady', 'protectedIdentity', 'authenticationIdentity']) expect(template).not.toContain(cacheState);
  expect(source).toContain('const applicationReady = $derived(protectedInitialized && protectedIdentity === authenticationIdentity)');
  const protectedInit = source.slice(source.indexOf('async function protectedInitialize'), source.indexOf('async function initializeAuthenticatedSession'));
  expect(protectedInit).toContain('if (applicationReady) return true');
  expect(protectedInit).toContain('protectedInitialized = false');
  const startup = source.slice(source.indexOf('async function initializeAuthenticatedSession'), source.indexOf('onMount(async'));
  for (const reset of ['authInitialized = false', 'modeReady = false', 'protectedInitialized = false']) expect(startup).toContain(reset);
  expect(template).toContain('{#if $isLoading || !authInitialized}');
  expect(source).toContain('if (!$isAuthenticated) protectedInitialized = false');
});

test('protected initialization guards asynchronous results and navigation happens only after context completion', async () => {
  const source = await read('../App.svelte');
  const protectedInit = source.slice(source.indexOf('async function protectedInitialize'), source.indexOf('async function initializeAuthenticatedSession'));
  expect(protectedInit).toContain('const revision = getAuthStateRevision()');
  expect(protectedInit).toContain('isAuthenticationStateCurrent(revision) && currentGuard()');
  expect(protectedInit).toContain('!destroyed && generation === protectedGeneration');
  expect(protectedInit).toContain('&& get(isAuthenticated)');
  expect(protectedInit).not.toContain('get(location)');
  expect(protectedInit).not.toContain('initialLocation');
  expect(protectedInit).toContain('await loadPluginTranslations(current)');
  expect(protectedInit).toMatch(/await PluginsAPI\.list[\s\S]*if \(!current\(\)\) return false;[\s\S]*pluginList\.set\(plugins\)/);
  expect(protectedInit).toContain("if (current()) initializationError = 'management.initializationFailed'");
  const authenticated = source.slice(source.indexOf('async function handleAuthenticated'), source.indexOf('function handleLoginCompleted'));
  expect(authenticated).toContain('await protectedInitialize(currentGuard)');
  expect(authenticated).toContain('return initialized && currentGuard() && !destroyed');
  expect(authenticated).not.toContain('window.location');
  expect(source).toContain('onCompleted={handleLoginCompleted}');
});

test('normal hash changes retain the login capability and completion leaves only the current exact login entry', async () => {
  const app = await read('../App.svelte');
  const loginKey = app.match(/\{#key ([^\n]*?)\}<Login /)?.[1];
  expect(loginKey).toBeDefined();
  expect(loginKey).not.toContain('$location');
  const completion = app.slice(app.indexOf('function handleLoginCompleted'), app.indexOf('// Navigation items'));
  expect(completion).toContain("const path = window.location.hash.replace(/^#/, '').split('?', 1)[0]");
  expect(completion).toMatch(/if \(destroyed\) return;[\s\S]*loginPageActive = false;[\s\S]*if \(path === '\/login'\) window\.location\.hash = '#\/';/);
  for (const staleNavigation of ['get(location)', 'navigationCurrent', 'capturedLocation', 'startsWith']) expect(completion).not.toContain(staleNavigation);
  const login = await read('./Login.svelte');
  expect(login).not.toContain('$stores/navigation-guard');
  expect(login).toContain('onCompleted: () => void');
  const factoryScope = login.slice(login.indexOf('const owned = untrack'), login.indexOf('instance = owned'));
  expect(factoryScope).toContain('onAuthenticated: (currentGuard: () => boolean) => onAuthenticated(currentGuard)');
  expect(factoryScope).toContain('if (!destroyed) onCompleted()');
  expect(factoryScope).not.toContain('capturedLocation');
  expect(factoryScope).not.toContain('get(location)');
  expect(factoryScope).not.toContain('$location');
});

test('platform login hosts an owned static provider capability without a refresh action', async () => {
  const source = await read('./Login.svelte');
  expect(source).toContain("$authMode?.mode === 'plugin'");
  expect(source).toContain('hasManagementLoginComponent($authMode.provider.name, $authMode.provider.loginComponent)');
  expect(source).toContain('createManagementLoginContext');
  expect(source).toContain('context={instance.context}');
  expect(source.indexOf('registerStaticPluginTranslations(mode.provider.name)')).toBeLessThan(source.indexOf('return createManagementLoginContext'));
  expect(source).toContain('owned?.dispose()');
  expect(source).toContain('onDestroy(() => { destroyed = true; instance?.dispose(); })');
  expect(source).toContain('if (!ProviderLogin) return');
  for (const removed of ['onRefresh', 'refreshing', 'contextReady', 'async function refresh', "common.refresh"]) expect(source).not.toContain(removed);
  for (const removed of ['accountError', 'pluginActivation.', 'on:login', 'verifyToken', 'readAuthMode', 'tokenInput', 'loginWithToken', 'bungee init', '管理 Key']) {
    expect(source).not.toContain(removed);
  }
  const registry = await read('../components/native-widgets/index.ts');
  expect(registry).toContain('getWidgetSource(component) === provider');
});

test('activation only blocks new management enablement without this bundle’s provider component', async () => {
  const source = await read('../components/domain/plugin/PluginActivationDialog.svelte');
  expect(source).toContain('enabled && !plugin.enabled && !!plugin.management && !accepted && !complete');
  expect(source).toContain('hasManagementLoginComponent(plugin.name, plugin.management.loginComponent)');
  expect(source).toMatch(/if \([^\n]*loginUnavailable[^\n]*\) return/);
  expect(source).toMatch(/disabled=\{[^}]*loginUnavailable/);
  expect(source).toContain("import RecoveryHelp from '@plugins/local-accounts/ui/RecoveryHelp.svelte'");
  // Preserve setup, publication confirmation, accepted-operation recovery and disable flows.
  for (const existing of ['managementSetup:', 'await waitForMode()', 'await establishSession()', 'async function recover()', "stage = accepted ? 'acceptedIncomplete'"]) expect(source).toContain(existing);
});

test('plugin login has no host auth dependencies, endpoint prop or completion events', async () => {
  const source = await read('../../../../plugins/local-accounts/ui/Login.svelte');
  expect(source).toContain("_, isManagementLoginStaleError, type ManagementLoginContext } from '@bungee/plugin-sdk'");
  for (const forbidden of ['$api/', '$stores/', 'accountError', 'createEventDispatcher', 'endpoint', "dispatch('login'", 'pluginActivation.', '$components/domain/plugin/RecoveryHelp']) expect(source).not.toContain(forbidden);
  expect(source.indexOf('requireLoginSuccess(result)')).toBeLessThan(source.indexOf('await activeContext.complete()'));
  expect(source).toContain('destroyed || context !== activeContext || isManagementLoginStaleError(cause)');
  expect(source).toMatch(/finally\s*\{\s*password = ''/);
  expect(source).not.toContain('<h2');
  const sdk = await read('../plugin-sdk/index.ts');
  expect(sdk).toContain("export type { ManagementLoginContext } from './management-login'");
  expect(sdk).toContain("export { isManagementLoginStaleError } from './management-login'");
  expect(sdk).not.toContain('createManagementLoginContext');
});

test('shell logout is host-owned, guards drafts and only navigates after verified settlement', async () => {
  const app = await read('../App.svelte');
  const action = app.slice(app.indexOf('async function handleLogout'), app.indexOf('// Navigation items'));
  expect(action).toContain('if (logoutBusy');
  expect(action).toContain('await confirmAction');
  expect(action).toContain('if (!accepted || !current()) return');
  expect(action).toContain('await endSession({ onCompleted: settledRevision =>');
  expect(action).toContain('isAuthenticationStateCurrent(settledRevision)');
  expect(action.indexOf('await endSession(')).toBeLessThan(action.indexOf('settingsDirty.set(false)'));
  expect(action.indexOf('await endSession(')).toBeLessThan(action.indexOf('dashboardDirty.set(false)'));
  expect(action.indexOf('await endSession(')).toBeLessThan(action.indexOf("window.location.hash = '#/login'"));
  expect(action).toContain("toast.show($_('login.logoutFailed'), 'error')");
  for (const forbidden of ['local-accounts', 'requestPluginControl', 'secureChannel', 'onRefresh', 'common.refresh']) expect(app).not.toContain(forbidden);
  const header = await read('../components/shell/AppHeader.svelte');
  for (const removed of ['secureChannel', 'StatusBadge', '>SECURE<', '>OPEN<']) expect(header).not.toContain(removed);
  // Desktop and mobile share one System menu and one guarded logout action.
  expect(header.match(/disabled=\{logoutBusy\}/g)).toHaveLength(1);
  expect(header).toContain('data-testid="header-management-menu"');
  expect(header).toContain('use:managementLifecycle');
  expect(header).toContain('if (logoutPending) { logoutPending = false; void onLogout(); }');
});

test('shell separates plugin/business navigation from system administration', async () => {
  const app = await read('../App.svelte');
  const navigation = app.slice(app.indexOf('const navItems'), app.indexOf('const isOnLogin'));
  expect(navigation).not.toContain("href: '/#/config'");
  expect(navigation).not.toContain("href: '/#/plugins'");
  expect(navigation).toContain('$pluginList.forEach');
  const header = await read('../components/shell/AppHeader.svelte');
  const pages = header.slice(header.indexOf('<Sheet.Root'), header.indexOf('</Sheet.Root>'));
  expect(pages).toContain('{#each items as item}');
  for (const system of ['/#/config', '/#/plugins', 'header.language', 'login.logout']) expect(pages).not.toContain(system);
  expect(header).toContain('href="/#/config"');
  expect(header).toContain('href="/#/plugins"');
  expect(header).toContain("managementPage === 'configuration' ? 'page'");
  expect(header).toContain("managementPage === 'plugins' ? 'page'");
});
