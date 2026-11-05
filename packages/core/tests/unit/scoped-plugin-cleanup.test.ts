import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@jeffusion/bungee-types';
import { PluginInstanceCleanupError, ScopedPluginRegistry } from '../../src/scoped-plugin-registry';

const roots: string[] = [];
const stateKey = (): string => `cleanup:${crypto.randomUUID()}`;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bungee-scoped-cleanup-'));
  roots.push(root);
  return root;
}

type CleanupState = { attempts: number; destroys: number; signal?: AbortSignal };

function state(key: string): CleanupState {
  return (globalThis as typeof globalThis & Record<string, CleanupState>)[key];
}

function writeWaitingPlugin(root: string, key: string): string {
  const path = join(root, 'waiting-plugin.ts');
  writeFileSync(path, `
const state = () => globalThis[${JSON.stringify(key)}] ??= { attempts: 0, destroys: 0 };
export default class WaitingPlugin {
  static name = 'waiting-plugin';
  static version = '1.0.0';
  async init(context) {
    const current = state();
    current.attempts += 1;
    current.signal = context.signal;
    if (context.signal === undefined) throw new Error('init context signal is missing');
    await new Promise((_resolve, reject) => {
      if (context.signal.aborted) return reject(context.signal.reason);
      context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
    });
  }
  bodyRequirements() { return { request: 'none' }; }
  register() {}
  async onDestroy() { state().destroys += 1; }
}
`);
  return path;
}

function writeFailingDestroyPlugin(root: string, key: string): string {
  const path = join(root, 'failing-destroy-plugin.ts');
  writeFileSync(path, `
const state = () => globalThis[${JSON.stringify(key)}] ??= { attempts: 0, destroys: 0 };
export default class FailingDestroyPlugin {
  static name = 'failing-destroy-plugin';
  static version = '1.0.0';
  bodyRequirements() { return { request: 'none' }; }
  register() {}
  async onDestroy() { state().destroys += 1; throw new Error('plugin teardown failed'); }
}
`);
  return path;
}

function writeFailingInitCleanupPlugin(root: string, key: string): string {
  const path = join(root, 'failing-init-plugin.ts');
  writeFileSync(path, `
const state = () => globalThis[${JSON.stringify(key)}] ??= { attempts: 0, destroys: 0 };
export default class FailingInitPlugin {
  static name = 'failing-init-plugin';
  static version = '1.0.0';
  async init() { state().attempts += 1; throw new Error('init failed'); }
  bodyRequirements() { return { request: 'none' }; }
  register() {}
  async onDestroy() { state().destroys += 1; throw new Error('onDestroy failed'); }
}
`);
  return path;
}

function writePostCreateCleanupPlugin(root: string, key: string): string {
  const path = join(root, 'post-create-plugin.ts');
  writeFileSync(path, `
const state = () => globalThis[${JSON.stringify(key)}] ??= { attempts: 0, destroys: 0 };
export default class PostCreatePlugin {
  static name = 'post-create-plugin';
  static version = '1.0.0';
  static async createHandler(config) {
    state().attempts += 1;
    return {
      pluginName: 'post-create-plugin',
      config,
      register() {},
      async destroy() { state().destroys += 1; throw new Error('handler teardown failed'); },
    };
  }
}
`);
  return path;
}

function config(path: string, name: string): AppConfig {
  return { plugins: [{ name, path }], routes: [] };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('scoped plugin registry cancellation cleanup', () => {
  test('aborted initialization settles once, runs onDestroy, and does not retry', async () => {
    const root = tempRoot();
    const key = stateKey();
    (globalThis as typeof globalThis & Record<string, CleanupState>)[key] = { attempts: 0, destroys: 0 };
    const registry = new ScopedPluginRegistry(root);
    const controller = new AbortController();
    const pending = registry.initializeFromConfig(config(writeWaitingPlugin(root, key), 'waiting-plugin'), undefined, controller.signal);
    while (state(key).signal === undefined) await Bun.sleep(1);

    controller.abort(new Error('worker shutdown'));

    await expect(pending).rejects.toThrow('worker shutdown');
    expect(state(key)).toMatchObject({ attempts: 1, destroys: 1 });
    // Registry teardown after cancellation stays a completed, idempotent cleanup.
    await registry.destroy();
    await registry.destroy();
  });

  test('a partial instance cleanup failure is not retried and stays a teardown failure', async () => {
    const root = tempRoot();
    const key = stateKey();
    (globalThis as typeof globalThis & Record<string, CleanupState>)[key] = { attempts: 0, destroys: 0 };
    const registry = new ScopedPluginRegistry(root);

    await expect(registry.initializeFromConfig(config(writeFailingInitCleanupPlugin(root, key), 'failing-init-plugin')))
      .rejects.toBeInstanceOf(PluginInstanceCleanupError);
    expect(state(key)).toMatchObject({ attempts: 1, destroys: 1 });

    await expect(registry.destroy()).rejects.toThrow('Scoped plugin registry cleanup failed');
    await expect(registry.destroy()).rejects.toThrow('Scoped plugin registry cleanup failed');
  });

  test('a handler created before a failed install is destroyed and its failure keeps teardown rejected', async () => {
    const root = tempRoot();
    const key = stateKey();
    (globalThis as typeof globalThis & Record<string, CleanupState>)[key] = { attempts: 0, destroys: 0 };
    const registry = new ScopedPluginRegistry(root);

    const failure = await registry.initializeFromConfig(config(writePostCreateCleanupPlugin(root, key), 'post-create-plugin'))
      .then(() => { throw new Error('expected initialization to fail'); }, (error: unknown) => error);

    expect(failure).toBeInstanceOf(PluginInstanceCleanupError);
    expect(String((failure as PluginInstanceCleanupError).initError)).toContain('plugin_body_requirements_missing');
    expect(state(key)).toMatchObject({ attempts: 1, destroys: 1 });
    await expect(registry.destroy()).rejects.toThrow('Scoped plugin registry cleanup failed');
  });

  test('a failed handler teardown rejects every destroy call instead of reporting success', async () => {
    const root = tempRoot();
    const key = stateKey();
    (globalThis as typeof globalThis & Record<string, CleanupState>)[key] = { attempts: 0, destroys: 0 };
    const registry = new ScopedPluginRegistry(root);
    await registry.initializeFromConfig(config(writeFailingDestroyPlugin(root, key), 'failing-destroy-plugin'));
    expect(state(key).destroys).toBe(0);

    const first = registry.destroy();
    const second = registry.destroy();

    expect(first).toBe(second);
    await expect(first).rejects.toThrow('Scoped plugin registry cleanup failed');
    await expect(second).rejects.toThrow('Scoped plugin registry cleanup failed');
    expect(state(key).destroys).toBe(1);
  });
});
