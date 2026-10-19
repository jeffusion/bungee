import {afterEach, expect as bunExpect} from 'bun:test';
import {expect, type Page, type Locator} from 'playwright/test';
import {createDefaultMenuLayout} from '@jeffusion/bungee-types';
import manifest from '../../../../../plugins/user-auth/manifest.json';
import {configurationRuntimeFixture} from '../publication';
import {fulfillMenuIcons, menuSnapshot} from '../menus';

export const control = '/api/plugins/user-auth/control';
export const administrator = {id: 'admin', username: 'admin', displayName: 'Administrator', disabled: false, hasLocalPassword: true, requiresPasswordChange: false};
export const evidence = '/tmp/bungee-user-auth';
export async function expectVerticalFields(container: Locator) {
  await expect.poll(() => container.locator('input:not([type=checkbox]):not([type=hidden]):visible, textarea:visible').evaluateAll(elements => {
    const bounds = elements.map(element => element.getBoundingClientRect());
    return bounds.length > 1 && bounds.every((bound, index) => index === 0 ||
      (bound.top >= bounds[index - 1]!.bottom && Math.abs(bound.left - bounds[0]!.left) < 1));
  })).toBe(true);
}

const violations: string[] = [];
afterEach(() => { const found = violations.splice(0); bunExpect(found).toEqual([]); });
const methods: Record<string, readonly string[]> = {
  '/api/auth/mode': ['GET'], '/api/auth/verify': ['GET'], '/api/auth/login/options': ['GET'],
  '/api/auth/login': ['POST'], '/api/auth/logout': ['POST'], '/api/auth/login/start': ['POST'],
  '/api/ui/menus': ['GET'], '/api/ui/icons/data': ['GET'], '/api/plugin-translations': ['GET'],
  '/api/plugins': ['GET'], '/api/config/runtime': ['GET'], '/api/config': ['GET'],
  '/api/runtime/upstreams': ['GET'], '/api/stats/dashboard': ['GET'], '/api/resources/api-key': ['GET'],
  [control + '/self']: ['GET'], [control + '/users']: ['GET', 'POST'],
  [control + '/users/update']: ['PUT'], [control + '/users/password']: ['POST'],
  [control + '/password']: ['POST'], [control + '/identities']: ['GET', 'DELETE'],
  [control + '/identities/link/start']: ['POST'], [control + '/identities/link/finish']: ['POST'],
  [control + '/login-connections']: ['GET', 'POST', 'PUT', 'DELETE'],
  [control + '/login-connections/discover']: ['POST'], [control + '/login-settings']: ['GET', 'PUT'],
  [control + '/turnstile']: ['GET', 'PUT'], [control + '/session-policy']: ['GET', 'PUT'],
};

export async function mockApplication(page: Page, handle: (path: string, method: string, body: any) => unknown, signedIn = true) {
  page.on('pageerror', error => violations.push(`pageerror ${page.url()}: ${error.message}`));
  const faultCounts = new Map<string, number>();
  const expectedHttpErrors: {url: string; status: number; remaining: number}[] = [];
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const url = message.location().url;
    const expected = expectedHttpErrors.find(item => item.url === url && item.remaining > 0 && message.text().includes(String(item.status)));
    if (expected) { expected.remaining--; return; }
    violations.push(`console ${url}: ${message.text()}`);
  });
  page.on('requestfailed', request => violations.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`));
  const config = configurationRuntimeFixture();
  const menus = menuSnapshot();
  const catalog = [...menus.catalog, ...manifest.contributes.navigation.map(nav => ({
    id: `plugin:user-auth:${encodeURIComponent(nav.path)}`, label: nav.label, href: `/#/extensions/user-auth${nav.path}`,
    source: 'plugin' as const, pluginName: manifest.name, defaultIcon: 'lucide:user', available: true,
  }))];
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({contentType: 'text/css', body: ''}));
  await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
    const request = route.request(), url = new URL(request.url());
    if (!methods[url.pathname]?.includes(request.method())) {
      violations.push(`Unexpected API ${request.method()} ${url.pathname}`);
      return route.fulfill({status: 501, json: {error: 'unexpected_fixture_request'}});
    }
    const body = request.postData() ? request.postDataJSON() : undefined;
    const supplied = await handle(url.pathname + url.search, request.method(), body);
    if (supplied !== undefined) {
      if (typeof supplied === 'object' && supplied !== null && 'fixtureError' in supplied) {
        const status = (supplied as {fixtureStatus?: number}).fixtureStatus ?? 409;
        const fault = `${request.method()} ${url.pathname} ${status} ${(supplied as any).fixtureError}`;
        const count = (faultCounts.get(fault) ?? 0) + 1; faultCounts.set(fault, count);
        if (count > 1) violations.push(`Repeated fixture fault: ${fault}`);
        expectedHttpErrors.push({url: request.url(), status, remaining: 1});
        return route.fulfill({status, json: {error: (supplied as any).fixtureError}});
      }
      if (url.pathname === control + '/login-connections' && request.method() === 'GET') return route.fulfill({json: {publicOrigin: 'https://public.example', ...supplied as object}});
      return route.fulfill({json: supplied});
    }
    if (request.method() !== 'GET') { violations.push(`Unconfigured API ${request.method()} ${url.pathname}`); return route.fulfill({status:501,json:{error:'unconfigured_fixture_request'}}); }
    if (url.pathname === '/api/auth/mode') return route.fulfill({json: {mode: 'plugin', initialized: true, publicOrigin: 'https://public.example', provider: {name: manifest.name, ...manifest.management}}});
    if (url.pathname === '/api/auth/verify') return route.fulfill({json: {mode: 'plugin', success: signedIn, ...(signedIn ? {subject: {id: 'admin', provider: manifest.name}, csrfToken: 'csrf'} : {})}});
    if (url.pathname === '/api/auth/login/options') return route.fulfill({json: {local: {enabled: true, turnstile: {enabled: false}}, methods: []}});
    if (url.pathname === '/api/ui/menus') return route.fulfill({json: {...menus, catalog, layout: createDefaultMenuLayout(catalog)}});
    if (url.pathname === '/api/ui/icons/data') return fulfillMenuIcons(route);
    if (url.pathname === '/api/plugin-translations') return route.fulfill({json: Object.fromEntries(Object.entries(manifest.translations).map(([language, messages]) => [language, {plugins: {[manifest.name]: messages}}]))});
    if (url.pathname === '/api/plugins') return route.fulfill({json: [{name: manifest.name, enabled: true, version: manifest.version, management: manifest.management, metadata: {...manifest.metadata, contributes: manifest.contributes}}]});
    if (url.pathname === control + '/self') return route.fulfill({json: {administrator}});
    if (url.pathname === control + '/session-policy') return route.fulfill({json: {version: 1, policy: {idleTimeoutMinutes: 30, absoluteTimeoutMinutes: 480}}});
    if (url.pathname === '/api/config/runtime') return route.fulfill({json: config});
    if (url.pathname === '/api/config') return route.fulfill({json: {revision: 1, content_hash: config.content_hash, config: config.config}});
    if (url.pathname === '/api/runtime/upstreams') return route.fulfill({json: {schema: 'bungee-runtime-upstreams-v1', generated_at: Date.now(), availability: 'complete', reason: null, admission: {revision: 1}, workers: {observed: [], missing: []}, upstreams: []}});
    if (url.pathname === '/api/stats/dashboard') return route.fulfill({json: {startTime: Date.now() - 3600000, endTime: Date.now(), range: '1h', history: {timestamps: [], requests: [], errors: [], responseTime: [], successRate: [], failureRate: [], requestCounts: {success: [], failed: []}}, upstreams: [], requestCounts: {success: 0, failed: 0}}});
    if (url.pathname === '/api/resources/api-key') return route.fulfill({json: {keys: []}});
    violations.push(`Unconfigured API ${request.method()} ${url.pathname}`);
    return route.fulfill({status: 501, json: {error: 'unconfigured_fixture_request'}});
  });
}
