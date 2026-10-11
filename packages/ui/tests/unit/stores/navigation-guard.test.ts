import { expect, mock, test } from 'bun:test';
import { get, writable } from 'svelte/store';

test('guardedLocation refreshes its readable cache after source changes while fully unsubscribed', async () => {
  const rawLocation = writable('/login');
  let confirmationCalls = 0;
  let resolveConfirmation: ((accepted: boolean) => void) | undefined;
  mock.module('svelte-spa-router', () => ({ location: rawLocation }));
  mock.module('../../../src/stores/confirmation', () => ({
    confirmAction: () => {
      confirmationCalls++;
      return new Promise<boolean>(resolve => { resolveConfirmation = resolve; });
    },
  }));

  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  const originalHashChangeEvent = Object.getOwnPropertyDescriptor(globalThis, 'HashChangeEvent');
  let originalLegacyToken: string | null | undefined;
  try { originalLegacyToken = globalThis.localStorage?.getItem('bungee_auth_token'); } catch { /* Storage may be unavailable in the test runtime. */ }
  let addedListeners = 0;
  let removedListeners = 0;
  const fakeWindow = {
    location: { href: 'http://localhost/#/login', hash: '#/login' },
    navigator: { language: 'en', languages: ['en'] },
    addEventListener: () => { addedListeners++; },
    removeEventListener: () => { removedListeners++; },
    dispatchEvent: () => true,
    setTimeout: globalThis.setTimeout.bind(globalThis),
  };
  const fakeDocument = {
    documentElement: { setAttribute: (_name: string, _value: string) => {} },
    addEventListener: () => { addedListeners++; },
    removeEventListener: () => { removedListeners++; },
  };
  const fakeHistory = {
    state: null,
    pushState: (_state: unknown, _title: string, nextUrl?: string | URL | null) => {
      if (nextUrl === undefined || nextUrl === null) return;
      const url = new URL(String(nextUrl), fakeWindow.location.href);
      fakeWindow.location.href = url.href;
      fakeWindow.location.hash = url.hash;
    },
  };
  let unsubscribe: (() => void) | undefined;
  let restoreStoreState: (() => void) | undefined;
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
    Object.defineProperty(globalThis, 'history', { configurable: true, value: fakeHistory });
    Object.defineProperty(globalThis, 'HashChangeEvent', { configurable: true, value: class FakeHashChangeEvent {} });

    const [{ guardedLocation, dashboardDirty, settingsDirty }, { isAuthenticated }] = await Promise.all([
      import('../../../src/stores/navigation-guard'), import('../../../src/stores/auth'),
    ]);
    const previousDashboardDirty = get(dashboardDirty);
    const previousSettingsDirty = get(settingsDirty);
    const previousAuthentication = get(isAuthenticated);
    restoreStoreState = () => {
      dashboardDirty.set(previousDashboardDirty);
      settingsDirty.set(previousSettingsDirty);
      isAuthenticated.set(previousAuthentication);
    };
    dashboardDirty.set(false);
    settingsDirty.set(false);
    isAuthenticated.set(false);

    const initialValues: string[] = [];
    unsubscribe = guardedLocation.subscribe(value => initialValues.push(value));
    expect(initialValues).toEqual(['/login']);
    unsubscribe();
    unsubscribe = undefined;

    rawLocation.set('/');
    expect(get(guardedLocation)).toBe('/');
    fakeWindow.location.href = 'http://localhost/#/';
    fakeWindow.location.hash = '#/';

    const refreshedValues: string[] = [];
    unsubscribe = guardedLocation.subscribe(value => refreshedValues.push(value));
    expect(refreshedValues.length).toBeGreaterThan(0);
    expect(refreshedValues.every(value => value === '/')).toBe(true);
    expect(confirmationCalls).toBe(0);

    const { isLoading } = await import('../../../src/i18n');
    if (get(isLoading)) {
      await new Promise<void>(resolve => {
        let stop: () => void = () => {};
        stop = isLoading.subscribe(loading => { if (!loading) { stop(); resolve(); } });
      });
    }

    isAuthenticated.set(true);
    dashboardDirty.set(true);
    rawLocation.set('/routes');
    expect(confirmationCalls).toBe(1);
    resolveConfirmation?.(false);
    await Promise.resolve();
    expect(refreshedValues.at(-1)).toBe('/');
    expect(get(dashboardDirty)).toBe(true);

    rawLocation.set('/services');
    expect(confirmationCalls).toBe(2);
    resolveConfirmation?.(true);
    await Promise.resolve();
    expect(refreshedValues.at(-1)).toBe('/services');
    expect(get(dashboardDirty)).toBe(false);

    unsubscribe();
    unsubscribe = undefined;
    expect(addedListeners).toBe(removedListeners);
  } finally {
    unsubscribe?.();
    restoreStoreState?.();
    mock.restore();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (originalHistory) Object.defineProperty(globalThis, 'history', originalHistory);
    else Reflect.deleteProperty(globalThis, 'history');
    if (originalHashChangeEvent) Object.defineProperty(globalThis, 'HashChangeEvent', originalHashChangeEvent);
    else Reflect.deleteProperty(globalThis, 'HashChangeEvent');
    try {
      if (originalLegacyToken === null || originalLegacyToken === undefined) globalThis.localStorage?.removeItem('bungee_auth_token');
      else globalThis.localStorage?.setItem('bungee_auth_token', originalLegacyToken);
    } catch { /* Storage may be unavailable in the test runtime. */ }
  }
});
