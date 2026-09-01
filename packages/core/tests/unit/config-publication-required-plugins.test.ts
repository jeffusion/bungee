import { describe, expect, test } from 'bun:test';
import type { AppConfig, PluginConfig } from '@jeffusion/bungee-types';
import { requiredPluginNames } from '../../src/config-publication/worker-runtime-plugins';

const plugin = (name: string): PluginConfig => ({ name, enabled: true });

describe('route-reachable required plugins', () => {
  test('does not require plugins from an orphan service', () => {
    const config: AppConfig = {
      routes: [{ path: '/direct', endpoints: [{ target: 'http://direct.test' }] }],
      services: [{ name: 'orphan', plugins: [plugin('orphan')], endpoints: [{ target: 'http://orphan.test' }] }],
    };

    expect(requiredPluginNames(config)).toEqual([]);
  });

  test('requires a service plugin when a route references that service', () => {
    const config: AppConfig = {
      routes: [{ path: '/service', service: 'reachable' }],
      services: [{ name: 'reachable', plugins: [plugin('service')], endpoints: [{ target: 'http://service.test' }] }],
    };

    expect(requiredPluginNames(config)).toEqual(['service']);
  });

  test('requires service-level and effective endpoint plugins', () => {
    const config: AppConfig = {
      routes: [{ path: '/service', service: 'reachable' }],
      services: [{
        name: 'reachable',
        plugins: [plugin('service')],
        endpoints: [{ target: 'http://service.test', plugins: [plugin('endpoint')] }],
      }],
    };

    expect(new Set(requiredPluginNames(config))).toEqual(new Set(['service', 'endpoint']));
  });

  test('requires plugins on direct route endpoints', () => {
    const config: AppConfig = {
      plugins: [plugin('global')],
      routes: [{
        path: '/direct',
        plugins: [plugin('route')],
        endpoints: [{ target: 'http://direct.test', plugins: [plugin('direct-endpoint')] }],
      }],
    };

    expect(new Set(requiredPluginNames(config))).toEqual(new Set(['global', 'route', 'direct-endpoint']));
  });
});
