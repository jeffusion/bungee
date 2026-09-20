import { afterEach, describe, expect, test } from 'bun:test';
import { exportLogs } from './logs';

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

function install(token: string | null): { requests: Array<{ url: string; init?: RequestInit }> } {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => token },
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response('exported', { status: 200 });
    },
  });
  return { requests };
}

afterEach(() => {
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch });
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('log export', () => {
  test('sends the dashboard credential to the management API', async () => {
    const { requests } = install('secret-token');

    expect(await (await exportLogs({ status: 200 }, 'csv')).text()).toBe('exported');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('/api/logs/export?status=200&format=csv');
    expect(new Headers(requests[0]?.init?.headers).get('Authorization')).toBe('Bearer secret-token');
  });

  test('keeps anonymous exports free of an authorization header', async () => {
    const { requests } = install(null);

    await exportLogs();
    expect(new Headers(requests[0]?.init?.headers).has('Authorization')).toBe(false);
  });
});
