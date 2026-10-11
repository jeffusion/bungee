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

// Exercise the public service facade, including callbacks returning host body handles.
import { BodySource } from '../../../src/gateway/body-service';
import { controlledBodyHandle } from '../../../src/gateway/controlled-views';
import { snapshotBodyResources } from '../../../src/gateway/body-resources';
import type { BodyHandle, BodyEvent } from '../../../src/gateway/body-contracts';

test('local service forwards native signals, promises and auxiliary BodyHandle callbacks under one live invocation', async () => {
  const before = snapshotBodyResources();
  const host = new PluginServiceHost();
  const generation = new AbortController(), connection = new AbortController(), aggregate = new AbortController();
  const source = new BodySource(new Response('data: {"answer":7}\n\n').body, 1024);
  await source.buffer('service-fixture');
  let disposeCalls = 0, callbackCalls = 0;
  let observedSignal!: AbortSignal, observedConnection!: AbortSignal;
  let complete!: () => void;
  const completion = new Promise<void>(resolve => { complete = resolve; });
  type Auxiliary = { bodyHandle: BodyHandle; completion: Promise<void>; dispose(): void };
  type Input = { signal: AbortSignal; webSocketConnection: { id: string; signal: AbortSignal }; ready: Promise<string>; executeAuxiliary(input: { signal: AbortSignal }): Promise<Auxiliary> };
  const provider = host.createContext('provider');
  provider.publish('relay', 1, { async relay(input: Input) {
    input.signal.throwIfAborted(); input.webSocketConnection.signal.throwIfAborted();
    expect(input.signal instanceof AbortSignal).toBe(true);
    expect(AbortSignal.any([input.signal, input.webSocketConnection.signal]).aborted).toBe(false);
    observedSignal = input.signal; observedConnection = input.webSocketConnection.signal;
    expect(await input.ready).toBe('ready');
    const auxiliary = await input.executeAuxiliary({ signal: aggregate.signal });
    const events: BodyEvent[] = [];
    for await (const event of auxiliary.bodyHandle.events({ id: 'service-parser', signal: aggregate.signal })) events.push(event);
    expect(host.currentInvocation()?.purpose).toBe('request');
    await auxiliary.completion;
    const bytes = await auxiliary.bodyHandle.bytes({ id: 'service-bytes' });
    expect(bytes instanceof Uint8Array).toBe(true);
    return { auxiliary, events, bytes };
  } });
  host.markReady('provider');
  const consumer = host.createContext('consumer', 'global', { provider: '*' });
  const service = consumer.consume<{ relay(input: Input): Promise<{ auxiliary: Auxiliary; events: BodyEvent[]; bytes: Uint8Array }> }>('provider', 'relay', 1);
  host.markReady('consumer');
  const release = host.acquireLease('consumer');
  const pending = host.runInInvocation(consumer, { purpose: 'request', lease: release, signal: generation.signal }, () => service.relay({
    signal: generation.signal, webSocketConnection: { id: 'trusted-connection', signal: connection.signal }, ready: Promise.resolve('ready'),
    async executeAuxiliary(input) {
      callbackCalls++; input.signal.throwIfAborted();
      expect(input.signal instanceof AbortSignal).toBe(true);
      return { bodyHandle: source.handle(), completion, dispose() { disposeCalls++; source.dispose(); } };
    },
  }));
  await new Promise(resolve => setTimeout(resolve, 0));
  generation.abort('generation cancelled');
  expect(observedSignal.aborted).toBe(true); expect(observedSignal.reason).toBe('generation cancelled');
  expect(aggregate.signal.aborted).toBe(false);
  let disposed = false; const disposal = host.dispose('consumer').then(() => { disposed = true; });
  await Promise.resolve(); expect(disposed).toBe(false);
  complete(); const result = await pending;
  expect(result.events).toMatchObject([{ json: { answer: 7 } }]);
  expect(new TextDecoder().decode(result.bytes)).toContain('answer');
  expect(callbackCalls).toBe(1);
  const dispose = result.auxiliary.dispose, events = result.auxiliary.bodyHandle.events;
  dispose(); expect(disposeCalls).toBe(1);
  release(); await disposal;
  expect(observedConnection.aborted).toBe(true);
  expect(() => dispose()).toThrow('revoked'); expect(() => events()).toThrow('revoked');
  expect(() => service.relay({} as Input)).toThrow('revoked');
  await host.dispose('provider');
  expect(snapshotBodyResources().retainedBytes).toBe(before.retainedBytes);
});

test('local async iterator calls retain drain through signal cancellation and native body release', async () => {
  const before = snapshotBodyResources();
  const host = new PluginServiceHost();
  let open!: () => void, cancelled = 0;
  const cancellation = new Promise<void>(resolve => { open = resolve; });
  const source = new BodySource(new ReadableStream<Uint8Array>({ cancel() { cancelled++; return cancellation; } }, { highWaterMark: 0 }), 1024);
  const wire = source.take() as ReadableStream<Uint8Array>;
  const handle = controlledBodyHandle(source, wire, source.handle());
  const provider = host.createContext('provider');
  provider.publish('body', 1, { events(signal: AbortSignal) { signal.throwIfAborted(); return handle.events({ id: 'service-events', signal }); } });
  host.markReady('provider');
  const consumer = host.createContext('consumer', 'global', { provider: '*' });
  const service = consumer.consume<{ events(signal: AbortSignal): AsyncIterable<BodyEvent> }>('provider', 'body', 1);
  host.markReady('consumer');
  const signal = new AbortController();
  const iterator = service.events(signal.signal)[Symbol.asyncIterator]();
  const next = iterator.next().catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 0));
  let disposed = false; const disposal = host.dispose('consumer').then(() => { disposed = true; });
  signal.abort(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(cancelled).toBe(1); expect(disposed).toBe(false); expect(wire.locked).toBe(true);
  open(); expect(await next).toMatchObject({ code: 'body_consumer_cancelled' });
  await disposal; expect(wire.locked).toBe(false);
  expect(() => iterator.next()).toThrow('revoked');
  expect(() => iterator.return?.()).toThrow('revoked');
  await host.dispose('provider'); source.dispose();
  expect(snapshotBodyResources().retainedBytes).toBe(before.retainedBytes);
});

test('local service rejects arbitrary argument instances and guards async iterator return', async () => {
  const host = new PluginServiceHost(); let closed = 0, argumentsSeen = 0;
  const provider = host.createContext('provider');
  provider.publish('values', 1, { accept(_value: unknown) { argumentsSeen++; }, values() { return { async *[Symbol.asyncIterator]() { try { yield 1; yield 2; } finally { closed++; } } }; } });
  host.markReady('provider');
  const consumer = host.createContext('consumer', 'global', { provider: '*' });
  const service = consumer.consume<{ accept(value: unknown): void; values(): AsyncIterable<number> }>('provider', 'values', 1);
  host.markReady('consumer');
  class Implementation { secret = 'private'; }
  expect(() => service.accept(new Implementation())).toThrow('Unsupported plugin service argument handle');
  expect(argumentsSeen).toBe(0);
  const iterator = service.values()[Symbol.asyncIterator]();
  expect(await iterator.next()).toEqual({ value: 1, done: false });
  await iterator.return?.(); expect(closed).toBe(1);
  await host.dispose('consumer');
  expect(() => iterator.next()).toThrow('revoked');
  await host.dispose('provider');
});
