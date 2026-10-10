import { describe, expect, test } from 'bun:test';
import { PluginServiceHost } from '../../../src/plugin-services';

describe('plugin service host', () => {
  test('global and scoped consumers require declared dependency, ready provider, matching contract', () => {
    const host = new PluginServiceHost(); const provider = host.createContext('provider');
    provider.publish('count', 1, { read: () => 7, nested: { count: 7 } });
    const consumer = host.createContext('consumer', 'route:r', { provider: '^1' });
    expect(() => consumer.consume('provider', 'count', 1)).toThrow('not ready');
    host.markReady('provider');
    expect(() => host.createContext('stranger').consume('provider', 'count', 1)).toThrow('Undeclared');
    expect(() => consumer.consume('provider', 'count', 2)).toThrow('mismatch');
    const scopedProvider = host.createContext('scoped-provider', 'route:r');
    expect(() => scopedProvider.publish('count', 1, {})).toThrow('global');
    const handle = consumer.consume<{ read(): number; nested: { count: number } }>('provider', 'count', 1);
    expect(handle.read()).toBe(7); expect(Object.isFrozen(handle)).toBe(true); expect(Object.isFrozen(handle.nested)).toBe(true);
  });
  test('consumer lease retains its provider; drain preserves old handle then revokes cached methods and callbacks', async () => {
    const host = new PluginServiceHost(); let callback!: () => void; let calls = 0;
    const provider = host.createContext('provider'); provider.publish('events', 1, { read: () => 1, subscribe: (options: { callback: () => void }) => { callback = options.callback; } }); host.markReady('provider');
    const consumer = host.createContext('consumer', 'global', { provider: '^1' }); host.markReady('consumer');
    const handle = consumer.consume<{ read(): number; subscribe(options: { callback: () => void }): void }>('provider', 'events', 1);
    const read = handle.read; handle.subscribe({ callback: () => { calls++; } });
    const release = host.acquireLease('consumer'); expect(host.references('provider').find(reference => reference.plugin === 'provider')!.leases).toBe(1);
    let drained = false; const disposal = host.dispose('consumer').then(() => { drained = true; });
    expect(read()).toBe(1); callback(); expect(calls).toBe(1);
    expect(() => host.acquireLease('consumer')).toThrow('not ready');
    await expect(host.dispose('provider')).rejects.toThrow('referenced');
    expect(drained).toBe(false); release(); await disposal;
    expect(() => read()).toThrow('revoked'); expect(() => callback()).toThrow('revoked');
    await host.dispose('provider');
  });
  test('registered cleanup runs only after old leases and callbacks drain', async () => {
    const host = new PluginServiceHost(); let subscribed = false;
    const provider = host.createContext('provider'); provider.publish('events', 1, { subscribe: () => { subscribed = true; return () => { subscribed = false; }; } }); host.markReady('provider');
    const consumer = host.createContext('consumer', 'global', { provider: '^1' }); host.markReady('consumer');
    const unsubscribe = consumer.consume<{ subscribe(): () => void }>('provider', 'events', 1).subscribe(); consumer.onDispose(unsubscribe);
    const release = host.acquireLease('consumer'); const disposal = host.dispose('consumer');
    expect(subscribed).toBe(true);
    expect(() => host.acquireLease('consumer')).toThrow('not ready');
    release(); await disposal; expect(subscribed).toBe(false); await host.dispose('provider');
  });
  test('awaited consumer callbacks retain drain until completion', async () => {
    const host = new PluginServiceHost(); let callback!: () => Promise<void>; let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const provider = host.createContext('provider'); provider.publish('events', 1, { subscribe: (options: { callback: () => Promise<void> }) => { callback = options.callback; } }); host.markReady('provider');
    const consumer = host.createContext('consumer', 'global', { provider: '^1' }); host.markReady('consumer');
    consumer.consume<{ subscribe(options: { callback: () => Promise<void> }): void }>('provider', 'events', 1).subscribe({ callback: () => gate });
    const pending = callback(); let disposed = false; const disposal = host.dispose('consumer').then(() => { disposed = true; });
    await Promise.resolve(); expect(disposed).toBe(false); finish(); await pending; await disposal; expect(disposed).toBe(true);
  });
});

test('manifest declarations enforce exact publication and consumption contracts', () => {
  const host = new PluginServiceHost();
  const contract = {id: 'count', version: 1, process: 'worker' as const};
  host.setDeclarations(new Map([
    ['provider', {provides: [contract]}],
    ['consumer', {consumes: [{...contract, plugin: 'provider'}]}],
    ['no-dependency', {consumes: [{...contract, plugin: 'provider'}]}],
  ]));
  const provider = host.createContext('provider');
  expect(() => provider.publish('undeclared', 1, {})).toThrow('Undeclared plugin service publication');
  expect(() => provider.publish('count', 2, {})).toThrow('Undeclared plugin service publication');
  expect(() => host.createContext('undeclared-provider').publish('count', 1, {})).toThrow('Undeclared plugin service publication');
  expect(() => host.createContext('provider', 'route:r').publish('count', 1, {})).toThrow('global');
  provider.publish('count', 1, {read: () => 42}); host.markReady('provider');
  const consumer = host.createContext('consumer', 'route:r', {provider: '^1.0.0'});
  expect(() => consumer.consume('provider', 'other', 1)).toThrow('Undeclared plugin service consumption');
  expect(() => consumer.consume('provider', 'count', 2)).toThrow('Undeclared plugin service consumption');
  expect(() => host.createContext('stranger', 'global', {provider: '^1.0.0'}).consume('provider', 'count', 1)).toThrow('Undeclared plugin service consumption');
  expect(() => host.createContext('no-dependency').consume('provider', 'count', 1)).toThrow('Undeclared plugin service dependency');
  expect(consumer.consume<{read(): number}>('provider', 'count', 1).read()).toBe(42);
});
