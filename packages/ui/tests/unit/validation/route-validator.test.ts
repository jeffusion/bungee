import { afterEach, beforeAll, describe, test, expect, mock, spyOn } from 'bun:test';
import type { Route, Service } from '$api/routes';
import { PluginsAPI } from '../../../src/api/plugins';
import { validateRoute } from '../../../src/validation/route-validator';
import { clearTransformersCache, validateUpstream } from '../../../src/validation/upstream-validator';
import { addMessages, init } from 'svelte-i18n';
import en from '../../../src/i18n/locales/en.json';

beforeAll(async () => {
  addMessages('en', en);
  await init({ fallbackLocale: 'en', initialLocale: 'en' });
});

afterEach(() => {
  mock.restore();
  clearTransformersCache();
});

describe('validateRoute response_rules upstream requirements', () => {
  test('requires an upstream when only response_rules are enabled', async () => {
    const route: Route = {
      path: '/test',
      response_rules: [
        {
          enabled: true,
          path: '/health',
          type: 'redirect',
          url: '/ready'
        }
      ]
    };

    const errors = await validateRoute(route);
    const upstreamErrors = errors.filter(
      (error) => error.field === 'endpoints' || error.message.includes('upstream')
    );

    expect(upstreamErrors.length).toBeGreaterThan(0);
  });
});

describe('validateRoute mixed targets', () => {
  const service: Service = { _uid: 'svc', name: 'svc', endpoints: [] };
  const reference = { id: 'reference', position: 1, service_id: 'svc', weight: 100, priority: 1, is_disabled: false };

  test('accepts upstreams and references on the same route', async () => {
    expect(await validateRoute({ path: '/mixed', service_references: [reference],
      endpoints: [{ target: 'https://example.com' }] }, [service])).toEqual([]);
  });

  test('still validates endpoints owned by a mixed route', async () => {
    const errors = await validateRoute({ path: '/mixed', service_references: [reference],
      endpoints: [{ target: 'not-a-url' }] }, [service]);
    expect(errors.some(({ field }) => field === 'endpoints[0].target')).toBe(true);
  });
});

test('upstream plugin validation uses and caches the plugin catalog names', async () => {
  const list = spyOn(PluginsAPI, 'list').mockResolvedValue([{ name: 'custom-plugin', enabled: true }]);

  expect(await validateUpstream({ target: 'https://example.com', plugins: ['custom-plugin'] }, 0)).toEqual([]);
  const errors = await validateUpstream({ target: 'https://example.com', plugins: ['missing-plugin'] }, 1);
  expect(errors).toHaveLength(1);
  expect(errors[0]?.field).toBe('endpoints[1].plugins');
  expect(errors[0]?.message).toContain('custom-plugin');
  expect(errors[0]?.message).toContain('missing-plugin');
  expect(list).toHaveBeenCalledTimes(1);
});

test('upstream plugin validation retains the cached fallback when the catalog is unavailable', async () => {
  const list = spyOn(PluginsAPI, 'list').mockRejectedValue(new Error('catalog unavailable'));
  const warning = spyOn(console, 'warn').mockImplementation(() => {});

  expect(await validateUpstream({ target: 'https://example.com', plugins: ['openai-to-anthropic'] }, 0)).toEqual([]);
  const errors = await validateUpstream({ target: 'https://example.com', plugins: ['missing-plugin'] }, 0);
  expect(errors).toHaveLength(1);
  expect(errors[0]?.message).toContain('openai-to-anthropic');
  expect(list).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledTimes(1);
});
