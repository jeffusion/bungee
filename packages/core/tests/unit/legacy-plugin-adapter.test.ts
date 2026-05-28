import { describe, expect, test } from 'bun:test';
import type { AppConfig, InterceptResult, PluginPhase } from '@jeffusion/bungee-types';
import { LegacyCompatAdapter } from '../../src/compat/legacy-plugin-adapter';

describe('LegacyCompatAdapter.adaptConfig', () => {
  test('adds empty plugins array to service without plugins field', () => {
    const config: AppConfig = {
      services: [{ name: 'api-service', endpoints: [{ target: 'http://example.com' }] }],
      routes: [{ path: '/api', service: 'api-service' }],
    };

    expect(LegacyCompatAdapter.adaptConfig(config).services?.[0]?.plugins).toEqual([]);
  });

  test('leaves service plugins unchanged when already present', () => {
    const plugins = ['auth'];
    const config: AppConfig = {
      services: [{ name: 'api-service', endpoints: [{ target: 'http://example.com' }], plugins }],
      routes: [{ path: '/api', service: 'api-service' }],
    };

    const adapted = LegacyCompatAdapter.adaptConfig(config);

    expect(adapted.services?.[0]?.plugins).toBe(plugins);
  });

  test('returns config unchanged when services field is absent', () => {
    const config: AppConfig = {
      routes: [{ path: '/api', endpoints: [{ target: 'http://example.com' }] }],
    };

    expect(LegacyCompatAdapter.adaptConfig(config)).toBe(config);
  });

  test('returns config unchanged when services is undefined', () => {
    const config: AppConfig = {
      services: undefined,
      routes: [{ path: '/api', endpoints: [{ target: 'http://example.com' }] }],
    };

    expect(LegacyCompatAdapter.adaptConfig(config)).toBe(config);
  });
});

describe('LegacyCompatAdapter.adaptInterceptResult', () => {
  test('returns undefined for undefined result', () => {
    expect(LegacyCompatAdapter.adaptInterceptResult(undefined)).toBeUndefined();
  });

  test('wraps Response object as respond action', () => {
    const response = new Response('ok');

    expect(LegacyCompatAdapter.adaptInterceptResult(response)).toEqual({ action: 'respond', response });
  });

  test('returns existing respond action unchanged', () => {
    const response = new Response('ok');
    const result: InterceptResult = { action: 'respond', response };

    expect(LegacyCompatAdapter.adaptInterceptResult(result)).toBe(result);
  });

  test('returns existing failover action unchanged', () => {
    const result: InterceptResult = { action: 'failover', reason: 'test' };

    expect(LegacyCompatAdapter.adaptInterceptResult(result)).toBe(result);
  });
});

test('plugin phase and intercept result types compile', () => {
  const phase: PluginPhase = 'service';
  const result: InterceptResult = { action: 'failover', reason: phase };

  void result;
});
