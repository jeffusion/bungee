import { describe, expect, test } from 'bun:test';
import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createBoundControlClient,
  createBoundControlRpcServer,
  disposeBoundControlClient,
  type ControlIpcMessage,
} from '../../src/plugin-control/ipc';
import {
  createBoundControlClientProvider,
  setBoundControlClientProvider,
} from '../../src/config-worker/runtime-dependencies';
import { createPluginControlHost } from '../../src/plugin-control/host';
import type { PluginManifestRecord } from '../../src/plugin-manifest-catalog/types';
import type { ControlPlugin, SecretStore } from '../../src/plugin-control/contracts';
import type { SecretStoreFactory } from '../../src/plugin-control';

const identity = {
  master_generation: '10000000-0000-4000-8000-000000000001',
  worker_instance_id: '20000000-0000-4000-8000-000000000001',
  worker_slot: 0,
} as const;
const binding = { plugin: 'fake-control', contributionId: 'source', bindingId: 'attempt-1', bindingOptions: { account_id: 'account-1' } } as const;

function pluginRecord(): PluginManifestRecord {
  return {
    name: 'fake-control', rootPath: '/tmp', pluginPath: '/tmp/fake-control', pluginDir: '/tmp/fake-control',
    manifestPath: '/tmp/fake-control/manifest.json', mainPath: '/tmp/fake-control/main.ts', controlPath: '/tmp/fake-control/control.ts',
    runtimeHash: `sha256:${'a'.repeat(64)}`, configSchema: [],
    manifest: {
      name: 'fake-control', version: '1.0.0', schemaVersion: 2, artifactKind: 'runtime-plugin', main: 'main.ts',
      capabilities: ['api', 'dynamicRuntimeLoad', 'controlPlane'], uiExtensionMode: 'none', engines: { bungee: '^4.3.0' },
      control: { entry: 'control.ts', rpc: [{ name: 'refresh', access: 'bound-attempt' }] }, configSchema: [],
    },
  };
}

function factory(): SecretStoreFactory {
  return {
    create: (namespace) => ({ namespace, get: async () => null, compareAndSet: async () => 1, delete: async () => undefined } satisfies SecretStore),
    revoke: () => undefined,
    clear: () => undefined,
  };
}

describe('bound control IPC integration', () => {
  test('dispatches only declared bound methods and drops forged identity', async () => {
    let seenOptions: unknown;
    const control: ControlPlugin = {
      createControl: () => ({
        api: [], rpc: [{ name: 'refresh', handler: 'refresh', invoke: async (payload, context) => { seenOptions = context.binding.bindingOptions; return payload; } }],
        start: () => undefined, dispose: () => undefined,
      }),
    };
    const host = createPluginControlHost({ records: [pluginRecord()], secretStores: factory(), loadControl: async () => control });
    await host.activate('fake-control');
    let receive: ((message: unknown) => void) | undefined;
    let disconnect: (() => void) | undefined;
    let server!: { accept(message: unknown): void };
    const transport = {
      send(message: ControlIpcMessage) { server.accept(message); return Promise.resolve(); },
      subscribe(listener: (message: unknown) => void) { receive = listener; return () => { receive = undefined; }; },
      subscribeDisconnect(listener: () => void) { disconnect = listener; return () => undefined; },
    };
    server = createBoundControlRpcServer({
      host, processIdentity: identity, send: async (message) => receive?.(message),
      isBindingCurrent: (requestIdentity, requestBinding) => requestIdentity.revision === 7
        && requestIdentity.endpointId === 'endpoint-1' && requestIdentity.attemptId === 'attempt-1'
        && requestBinding.bindingId === binding.bindingId,
      allowedMethods: () => ['refresh'],
      resolveBindingOptions: () => binding.bindingOptions,
    });
    const client = createBoundControlClient({
      transport, identity, revision: 7, endpointId: 'endpoint-1', attemptId: 'attempt-1',
      binding: { ...binding, bindingOptions: { account_id: 'forged' } }, methods: ['refresh'],
    });
    await expect(client.call('not-declared', {}, new AbortController().signal)).rejects.toThrow('not declared');
    await expect(client.call('refresh', { value: 3 }, new AbortController().signal)).resolves.toEqual({ value: 3 });
    expect(seenOptions).toEqual(binding.bindingOptions);

    const cancelled = new AbortController();
    const pending = client.call('refresh', { value: 4 }, cancelled.signal);
    cancelled.abort();
    await expect(pending).rejects.toThrow('cancelled');
    disconnect?.();
    await expect(client.call('refresh', {}, new AbortController().signal)).rejects.toThrow('disconnected');
  });

  test('uses the production worker entry and real child-process IPC channel', async () => {
    const host = createPluginControlHost({
      records: [pluginRecord()], secretStores: factory(),
      loadControl: async () => ({ createControl: () => ({ api: [], rpc: [{ name: 'refresh', handler: 'refresh', invoke: async (payload) => payload }], start() {}, dispose() {} }) }),
    });
    await host.activate('fake-control');
    const root = mkdtempSync(join(tmpdir(), 'bungee-control-child-'));
    const script = join(root, 'worker.ts');
    const resultPath = join(root, 'result.json');
    writeFileSync(script, `
      const binding = ${JSON.stringify(binding)};
      import { dispatchProcessRole } from ${JSON.stringify(resolve(import.meta.dir, '../../src/main.ts'))};
      import { getBoundControlClient } from ${JSON.stringify(resolve(import.meta.dir, '../../src/config-worker/runtime-dependencies.ts'))};
      import { writeFile } from 'node:fs/promises';
      void dispatchProcessRole('worker');
      setTimeout(async () => {
        try {
          const client = getBoundControlClient(binding, { revision: 7, endpointId: 'endpoint-1', attemptId: 'attempt-1' });
          const result = await client.call('refresh', { child: true }, new AbortController().signal);
          await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ ok: true, result }));
        } catch (error) {
          await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ ok: false, error: String(error) }));
        }
      }, 250);
    `);
    const child = fork(script, [], {
      cwd: root,
      env: {
        ...process.env, BUNGEE_ROLE: 'worker', PLUGINS_DIR: resolve(import.meta.dir, '../../../plugins'),
        BUNGEE_INCLUDE_SYSTEM_PLUGINS: 'false', BUNGEE_MASTER_GENERATION: identity.master_generation,
        BUNGEE_WORKER_INSTANCE_ID: identity.worker_instance_id, BUNGEE_WORKER_SLOT: '0',
        BUNGEE_MASTER_PID: String(process.pid), BUNGEE_HEARTBEAT_TIMEOUT_MS: '10000',
        BUNGEE_SHUTDOWN_TIMEOUT_MS: '1000', BUNGEE_INTERNAL_TRANSPORT_SECRET: 'A'.repeat(43),
        BUNGEE_ACCESS_DB_PATH: join(root, 'logs', 'access.db'),
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const heartbeat = setInterval(() => {
      child.send({ command: 'master-heartbeat', ...identity, master_pid: process.pid, sequence: Date.now() });
    }, 100);
    try {
      const server = createBoundControlRpcServer({
        host, processIdentity: identity,
        send: async (message) => { child.send(message); },
        isBindingCurrent: (requestIdentity, requestBinding) => requestIdentity.revision === 7
          && requestIdentity.endpointId === 'endpoint-1' && requestIdentity.attemptId === 'attempt-1'
          && requestBinding.bindingId === binding.bindingId,
        allowedMethods: () => ['refresh'],
        resolveBindingOptions: () => binding.bindingOptions,
      });
      child.on('message', (message: unknown) => server.accept(message));
      const deadline = Date.now() + 10_000;
      let result: Record<string, unknown> | undefined;
      while (Date.now() < deadline && result === undefined) {
        try { result = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>; }
        catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
      }
      expect(result).toMatchObject({ ok: true, result: { child: true } });
    } finally {
      clearInterval(heartbeat);
      child.kill();
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not send pre-aborted calls or mix clients sharing an attempt', async () => {
    const messages: ControlIpcMessage[] = [];
    const listeners = new Set<(message: unknown) => void>();
    const disconnectListeners = new Set<() => void>();
    const transport = {
      send(message: ControlIpcMessage) { messages.push(message); return Promise.resolve(); },
      subscribe(listener: (message: unknown) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      subscribeDisconnect(listener: () => void) {
        disconnectListeners.add(listener);
        return () => disconnectListeners.delete(listener);
      },
    };
    const bindingA = { ...binding, bindingId: 'binding-a' };
    const bindingB = { ...binding, bindingId: 'binding-b' };
    const clientA = createBoundControlClient({
      transport, identity, revision: 7, endpointId: 'endpoint-1', attemptId: 'same-attempt',
      binding: bindingA, methods: ['refresh'],
    });
    const clientB = createBoundControlClient({
      transport, identity, revision: 7, endpointId: 'endpoint-1', attemptId: 'same-attempt',
      binding: bindingB, methods: ['refresh'],
    });
    const aborted = new AbortController();
    aborted.abort();
    await expect(clientA.call('refresh', { aborted: true }, aborted.signal)).rejects.toThrow('cancelled');

    const first = clientA.call('refresh', { client: 'a' }, new AbortController().signal);
    const second = clientB.call('refresh', { client: 'b' }, new AbortController().signal);
    await Promise.resolve();
    expect(messages).toHaveLength(2);
    expect(messages[0]?.requestId).not.toBe(messages[1]?.requestId);
    for (const message of messages) {
      if (message.kind !== 'plugin-control-call') continue;
      for (const listener of listeners) listener({
        kind: 'plugin-control-response', requestId: message.requestId, identity: message.identity,
        binding: message.binding, method: message.method, ok: true, result: message.payload,
      });
    }
    await expect(first).resolves.toEqual({ client: 'a' });
    await expect(second).resolves.toEqual({ client: 'b' });
    disposeBoundControlClient(clientA);
    disposeBoundControlClient(clientB);
    expect(listeners).toHaveLength(0);
    expect(disconnectListeners).toHaveLength(0);
  });

  test('requires admission evidence for ACK, revision, drain, disable, and exit', async () => {
    const host = createPluginControlHost({
      records: [pluginRecord()], secretStores: factory(),
      loadControl: async () => ({ createControl: () => ({ api: [], rpc: [{ name: 'refresh', handler: 'refresh', invoke: async () => ({ ok: true }) }], start() {}, dispose() {} }) }),
    });
    await host.activate('fake-control');
    let evidence: { revision: number; catalog: string; phase: 'serving' | 'draining' } | undefined;
    let disabled = false;
    let receive: ((message: unknown) => void) | undefined;
    const transport = {
      send(message: ControlIpcMessage) { server.accept(message); return Promise.resolve(); },
      subscribe(listener: (message: unknown) => void) { receive = listener; return () => { receive = undefined; }; },
      subscribeDisconnect() { return () => undefined; },
    };
    const accepted = (requestRevision: number): boolean => evidence !== undefined
      && evidence.revision === requestRevision && evidence.catalog === 'catalog-1'
      && !disabled;
    const server = createBoundControlRpcServer({
      host, processIdentity: identity, send: async (message) => receive?.(message),
      isBindingCurrent: (requestIdentity) => accepted(requestIdentity.revision),
      allowedMethods: () => ['refresh'], resolveBindingOptions: () => binding.bindingOptions,
    });
    const call = async (revision: number): Promise<unknown> => {
      const client = createBoundControlClient({
        transport, identity, revision, endpointId: 'endpoint-1', attemptId: `attempt-${revision}`,
        binding, methods: ['refresh'],
      });
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 75);
      try { return await client.call('refresh', {}, abort.signal); }
      finally { clearTimeout(timer); disposeBoundControlClient(client); }
    };

    await expect(call(7)).rejects.toThrow('cancelled');
    evidence = { revision: 6, catalog: 'catalog-1', phase: 'draining' };
    await expect(call(6)).resolves.toEqual({ ok: true });
    disabled = true;
    await expect(call(6)).rejects.toThrow('cancelled');
    disabled = false;
    evidence = undefined;
    await expect(call(6)).rejects.toThrow('cancelled');
    await host.dispose();
  });

  test('keeps one transport subscription across sequential attempts', async () => {
    const messages = new Set<(message: unknown) => void>();
    const disconnects = new Set<() => void>();
    const transport = {
      send(message: ControlIpcMessage) {
        if (message.kind === 'plugin-control-call') {
          const response: ControlIpcMessage = { kind: 'plugin-control-response', requestId: message.requestId,
            identity: message.identity, binding: message.binding, method: message.method, ok: true, result: { ok: true } };
          for (const listener of [...messages]) listener(response);
        }
        return Promise.resolve();
      },
      subscribe(listener: (message: unknown) => void) { messages.add(listener); return () => { messages.delete(listener); }; },
      subscribeDisconnect(listener: () => void) { disconnects.add(listener); return () => { disconnects.delete(listener); }; },
    };
    const provider = createBoundControlClientProvider({ transport, identity, methods: ['refresh'] });
    setBoundControlClientProvider(provider);
    try {
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        const client = provider(binding, { revision: 7, endpointId: 'endpoint-1', attemptId: `attempt-${attempt}` });
        await expect(client.call('refresh', {}, new AbortController().signal)).resolves.toEqual({ ok: true });
        expect(messages).toHaveLength(1);
        expect(disconnects).toHaveLength(1);
      }
    } finally {
      setBoundControlClientProvider(null);
    }
    expect(messages).toHaveLength(0);
    expect(disconnects).toHaveLength(0);
  });

  test('does not leak a subscription when disconnect races the first call', async () => {
    const listeners = new Set<(message: unknown) => void>();
    const disconnects = new Set<() => void>();
    let sends = 0;
    const transport = {
      send() { sends += 1; return Promise.resolve(); },
      subscribe(listener: (message: unknown) => void) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      subscribeDisconnect(listener: () => void) {
        disconnects.add(listener);
        listener();
        return () => { disconnects.delete(listener); };
      },
    };
    const client = createBoundControlClient({
      transport, identity, revision: 7, endpointId: 'endpoint-1', attemptId: 'race', binding, methods: ['refresh'],
    });

    await expect(client.call('refresh', {}, new AbortController().signal)).rejects.toThrow('disconnected');
    expect(sends).toBe(0);
    expect(listeners).toHaveLength(0);
    expect(disconnects).toHaveLength(0);
    disposeBoundControlClient(client);
  });

  test('cancels only the exact pending server call', async () => {
    let attemptSignal: AbortSignal | undefined;
    const host = {
      invokeRpc: async (_plugin: string, _method: string, _payload: unknown, context: { attempt: { signal: AbortSignal } }) => await new Promise<unknown>((resolve) => {
        attemptSignal = context.attempt.signal;
        // The server owns this controller through the invocation context in production;
        // keep this fixture non-cooperative so cancellation must still settle the server state.
        void resolve;
      }),
    } as unknown as import('../../src/plugin-control/host').PluginControlHost;
    let server!: { accept(message: unknown): void; dispose(): void };
    let receive: ((message: unknown) => void) | undefined;
    const messages: ControlIpcMessage[] = [];
    const transport = {
      send(message: ControlIpcMessage) { messages.push(message); server.accept(message); return Promise.resolve(); },
      subscribe(listener: (message: unknown) => void) { receive = listener; return () => { receive = undefined; }; },
      subscribeDisconnect() { return () => undefined; },
    };
    server = createBoundControlRpcServer({
      host, processIdentity: identity, send: async (message) => receive?.(message),
      isBindingCurrent: () => true, allowedMethods: () => ['refresh'], resolveBindingOptions: () => ({}),
    });
    const client = createBoundControlClient({
      transport, identity, revision: 7, endpointId: 'endpoint-1', attemptId: 'attempt-1', binding, methods: ['refresh'],
    });
    const abort = new AbortController();
    const pending = client.call('refresh', {}, abort.signal);
    await Promise.resolve();
    const callMessage = messages.find((message): message is Extract<ControlIpcMessage, { kind: 'plugin-control-call' }> => message.kind === 'plugin-control-call');
    if (callMessage === undefined) throw new Error('call message was not sent');
    server.accept({ ...callMessage, kind: 'plugin-control-cancel', method: 'wrong-method' });
    expect(attemptSignal?.aborted).not.toBe(true);
    abort.abort();
    await expect(pending).rejects.toThrow('cancelled');
    await Promise.resolve();
    expect(messages.some((message) => message.kind === 'plugin-control-cancel'
      && message.requestId === callMessage.requestId && message.method === 'refresh')).toBe(true);
    server.dispose();
    disposeBoundControlClient(client);
  });
});
