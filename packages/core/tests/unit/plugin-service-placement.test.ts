import { describe, expect, test } from 'bun:test';
import { PluginServiceHost, type PluginServiceDeclarations } from '../../src/plugin-services';
import { PluginDependencyGraph } from '../../src/plugin-dependencies';
import { ScopedPluginRegistry, type PluginClass } from '../../src/scoped-plugin-registry';

describe('process-specific local services', () => {
  test('control services cannot be published or consumed through a worker host', () => {
    const declarations = new Map<string, PluginServiceDeclarations>([
      ['provider', { provides: [{ id: 'counter', version: 1, process: 'control' as const }] }],
      ['consumer', { consumes: [{ plugin: 'provider', id: 'counter', version: 1, process: 'control' as const }] }],
    ]);
    const worker = new PluginServiceHost('worker');
    worker.setDeclarations(declarations);
    expect(() => worker.createContext('provider').publish('counter', 1, { read: () => 1 })).toThrow('Undeclared');
    const control = new PluginServiceHost('control');
    control.setDeclarations(declarations);
    control.createContext('provider').publish('counter', 1, { read: () => 1 });
    control.markReady('provider');
    expect(control.createContext('consumer', 'global', { provider: '^1.0.0' }).consume<{ read(): number }>('provider', 'counter', 1).read()).toBe(1);
  });

  test('major versions coexist without ambiguity or an implicit fallback', () => {
    const host = new PluginServiceHost();
    const provider = host.createContext('provider');
    provider.publish('counter', 1, { read: () => 1 });
    provider.publish('counter', 2, { read: () => 2 });
    host.markReady('provider');
    const consumer = host.createContext('consumer', 'global', { provider: '*' });
    expect(consumer.consume<{ read(): number }>('provider', 'counter', 1).read()).toBe(1);
    expect(consumer.consume<{ read(): number }>('provider', 'counter', 2).read()).toBe(2);
    expect(() => consumer.consume('provider', 'counter', 3)).toThrow('contract mismatch');
  });

  test('rejects binding providers and optional declarations before owner creation', () => {
    for (const services of [
      { provides: [{ id: 'counter', version: 1, process: 'worker', scope: 'binding' }] },
      { consumes: [{ plugin: 'provider', id: 'counter', version: 1, process: 'worker', optional: true }] },
    ]) expect(() => new PluginServiceHost().setDeclarations(new Map([['plugin', services as PluginServiceDeclarations]]))).toThrow();
    expect(() => new PluginDependencyGraph([{ name: 'plugin', version: '1.0.0', optionalDependencies: {} } as never])).toThrow('optional dependencies');
  });

  test('scoped callers retain a global provider and preserve their exact lease identity', async () => {
    const host = new PluginServiceHost();
    host.setDeclarations(new Map([
      ['provider', { provides: [{ id: 'counter', version: 1, process: 'worker' }] }],
      ['consumer', { consumes: [{ plugin: 'provider', id: 'counter', version: 1, process: 'worker' }] }],
    ]));
    host.createContext('provider').publish('counter', 1, { read: () => 7 });
    host.markReady('provider');
    for (const scope of ['route:a', 'route:b']) {
      const consumer = host.createContext('consumer', scope, { provider: '*' });
      expect(consumer.consume<{read(): number}>('provider', 'counter', 1).read()).toBe(7);
      host.markReady('consumer', scope);
    }
    const release = host.acquireLease('consumer', 'route:a');
    expect(host.references('provider').filter(reference => reference.plugin === 'consumer')).toEqual([
      { plugin: 'consumer', scope: 'route:a', leases: 1 }, { plugin: 'consumer', scope: 'route:b', leases: 0 },
    ]);
    await expect(host.dispose('provider')).rejects.toThrow('referenced');
    release();
    await host.dispose('consumer', 'route:a'); await host.dispose('consumer', 'route:b'); await host.dispose('provider');
  });

  test('an RPC service never silently becomes a synchronous JavaScript object', () => {
    const host = new PluginServiceHost('control');
    host.setDeclarations(new Map<string, PluginServiceDeclarations>([['provider', { provides: [{ id: 'query', version: 1, process: 'control' as const, kind: 'rpc' as const }] }]]));
    expect(() => host.createContext('provider').publish('query', 1, { read: () => 1 })).toThrow('unavailable');
  });

  test('late lifecycle work cannot mark, retire or dispose a replacement context', async () => {
    const host = new PluginServiceHost('control');
    const oldContext = host.createContext('provider');
    host.markReady('provider', 'global', oldContext);
    await host.dispose('provider', 'global', oldContext);
    const replacement = host.createContext('provider');
    expect(() => host.markReady('provider', 'global', oldContext)).toThrow('Stale');
    expect(() => host.retire('provider', 'global', oldContext)).toThrow('Stale');
    await expect(host.dispose('provider', 'global', oldContext)).rejects.toThrow('Stale');
    host.markReady('provider', 'global', replacement);
    const release = host.acquireLease('provider');
    release();
    await host.dispose('provider', 'global', replacement);
  });

  test.each([false, true])('required subscription cleanup attempts every callback and handler (%s)', async cleanupFails => {
    const registry = new ScopedPluginRegistry();
    const cleaned: string[] = [];
    registry.ensurePluginClassLoaded = async config => {
      const name = typeof config === 'string' ? config : config.name;
      return { name, version: '1.0.0', createHandler: async (_options, context) => {
        if (name === 'z') context.services!.publish('events', 1, { subscribe: () => () => { cleaned.push('unsubscribe'); if (cleanupFails) throw new Error('cleanup failed'); } });
        else {
          const service = context.services!.consume<{ subscribe(): () => void }>('z', 'events', 1);
          expect(service).not.toBeNull();
          context.services!.onDispose(service!.subscribe());
          context.services!.onDispose(() => { cleaned.push('second-cleanup'); });
        }
        return { pluginName: name, config: {}, register() {}, async destroy() { cleaned.push(`destroy:${name}`); } };
      } } satisfies PluginClass;
    };
    const graph = new PluginDependencyGraph([
      { name: 'z', version: '1.0.0', runtimeScope: 'global', services: { provides: [{ id: 'events', version: 1, process: 'worker' }] } },
      { name: 'a', version: '1.0.0', dependencies: { z: '*' }, services: { consumes: [{ plugin: 'z', id: 'events', version: 1, process: 'worker' }] } },
    ]);
    expect(await registry.initializeFromConfig({ plugins: ['a', 'z'] }, graph)).toEqual({ success: 2, failed: 0 });
    if (cleanupFails) await expect(registry.destroy()).rejects.toThrow('Scoped plugin registry cleanup failed');
    else await registry.destroy();
    expect(cleaned).toEqual(['unsubscribe', 'second-cleanup', 'destroy:a', 'destroy:z']);
  });
});

describe('activation and initialization graphs', () => {
  test('a control-only required provider activates but does not require a worker global instance', () => {
    const graph = new PluginDependencyGraph([
      { name: 'provider', version: '1.0.0', runtimeScope: 'global', capabilities: ['api', 'controlPlane'], control: {} },
      { name: 'consumer', version: '1.0.0', capabilities: ['hooks'], dependencies: { provider: '^1.0.0' } },
    ]);
    expect(graph.closure(['consumer'])).toEqual(['provider', 'consumer']);
    expect(graph.localDependenciesOf('consumer', 'worker')).toEqual([]);
    expect(graph.localDependenciesOf('consumer', 'control')).toEqual(['provider']);
    expect(graph.initializationOrder(['consumer', 'provider'], 'control')).toEqual(['provider', 'consumer']);
  });

  test('remote lookup matches logical contract without binding the caller to the provider process', () => {
    const graph = new PluginDependencyGraph([
      { name: 'provider', version: '1.0.0', runtimeScope: 'global', services: { provides: [{ id: 'lookup', version: 1, process: 'control', kind: 'rpc' }] } },
      { name: 'consumer', version: '1.0.0', dependencies: { provider: '*' }, services: { consumes: [{ plugin: 'provider', id: 'lookup', version: 1, process: 'worker', kind: 'rpc' }] } },
    ]);
    expect(graph.closure(['consumer'])).toEqual(['provider', 'consumer']);
  });

});
