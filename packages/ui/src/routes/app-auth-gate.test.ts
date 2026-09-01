import { describe, expect, test } from 'bun:test';

describe('app authentication gate', () => {
  test('verifies authentication before protected initialization', async () => {
    const source = await Bun.file(new URL('../App.svelte', import.meta.url)).text();
    const tokenGate = source.indexOf('const currentToken = getToken()');
    const verification = source.indexOf('await verifyToken()');
    const protectedInitialization = source.indexOf('await loadPluginTranslations()');
    const authenticatedInitialization = source.indexOf(
      'await initializeAuthenticatedSession(true, currentToken !== null)',
    );

    expect(source).not.toContain("from '$api/config'");
    expect(source).toContain('let authInitialized = false');
    expect(source).toContain('{#if $isLoading || !authInitialized}');
    expect(source).toContain('{:else if !$isAuthenticated || isOnLogin}');
    expect(source).toContain('<Login onAuthenticated={handleAuthenticated} />');
    expect(source).not.toContain('if (!currentToken)');
    expect(tokenGate).toBeGreaterThan(0);
    expect(verification).toBeGreaterThan(0);
    expect(protectedInitialization).toBeGreaterThan(verification);
    expect(authenticatedInitialization).toBeGreaterThan(tokenGate);
  });

  test('waits for authenticated initialization before leaving login', async () => {
    const source = await Bun.file(new URL('./Login.svelte', import.meta.url)).text();

    expect(source).toContain('let { onAuthenticated }: Props = $props()');
    expect(source.indexOf('await onAuthenticated()')).toBeGreaterThan(source.indexOf('login(tokenInput)'));
  });

  test('configured-auth-only gate: anonymous verify, login routing, no token synthesis', async () => {
    const appSource = await Bun.file(new URL('../App.svelte', import.meta.url)).text();
    const loginSource = await Bun.file(new URL('./Login.svelte', import.meta.url)).text();

    expect(appSource).not.toContain('login(');

    const verifyCall = appSource.indexOf('await verifyToken()');
    expect(verifyCall).toBeGreaterThan(0);
    expect(appSource.indexOf('logout();')).toBeGreaterThan(verifyCall);
    expect(appSource).toContain("window.location.hash = '#/login'");
    expect(loginSource).toContain('login(tokenInput)');
  });
});
