import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@jeffusion/bungee-types';
import { ScopedPluginRegistry } from '../src/scoped-plugin-registry';
import type { MutableRequestContext } from '../src/hooks';

const TEST_PLUGIN_NAME = 'test-header-injection';

function createTempPluginRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bungee-plugin-scope-'));
  const pluginDir = join(root, 'plugins', TEST_PLUGIN_NAME, 'server');
  mkdirSync(pluginDir, { recursive: true });

  const pluginTypesPath = JSON.stringify(join(process.cwd(), 'packages/core/src/plugin.types'));
  const hooksPath = JSON.stringify(join(process.cwd(), 'packages/core/src/hooks'));

  writeFileSync(
    join(pluginDir, 'index.ts'),
    `import type { Plugin } from ${pluginTypesPath};
import { definePlugin } from ${pluginTypesPath};
import type { PluginHooks, PluginInitContext } from ${hooksPath};

export default definePlugin(
  class implements Plugin {
    static readonly name = '${TEST_PLUGIN_NAME}';
    static readonly version = '1.0.0';

    customHeaders: Record<string, string> = {};

    async init(context: PluginInitContext): Promise<void> {
      this.customHeaders = context.config.headers || {};
    }

    register(hooks: PluginHooks): void {
      hooks.onBeforeRequest.tap(
        { name: '${TEST_PLUGIN_NAME}', stage: -50 },
        (ctx) => {
          Object.assign(ctx.headers, this.customHeaders);
          return ctx;
        }
      );
    }
  }
);
`
  );

  return root;
}

type HeaderEcho = {
  onlyA: string | null;
  onlyB: string | null;
  enabled: string | null;
  disabled: string | null;
};

const createSameTargetConfig = (target: string): AppConfig => ({
  routes: [
    {
      path: '/same-target',
      upstreams: [
        {
          target,
          priority: 1,
          plugins: [
            {
              name: TEST_PLUGIN_NAME,
              options: {
                headers: { 'x-only-a': '1' },
                priority: 10,
              }
            }
          ]
        },
        {
          target,
          priority: 2,
          plugins: [
            {
              name: TEST_PLUGIN_NAME,
              options: {
                headers: { 'x-only-b': '1' },
                priority: 1,
              }
            }
          ]
        }
      ],
      failover: { enabled: false, retryOn: [] },
    },
  ],
});

const createDisabledConfig = (target: string): AppConfig => ({
  routes: [
    {
      path: '/same-target-disabled',
      upstreams: [
        {
          target,
          priority: 1,
          plugins: [
            {
              name: TEST_PLUGIN_NAME,
              options: {
                headers: { 'x-enabled': '1' },
                priority: 10,
              }
            }
          ]
        },
        {
          target,
          priority: 2,
          disabled: true,
          plugins: [
            {
              name: TEST_PLUGIN_NAME,
              options: {
                headers: { 'x-disabled': '1' },
                priority: 1,
              }
            }
          ]
        }
      ],
      failover: { enabled: false, retryOn: [] },
    },
  ],
});

const runScenario = async (
  configBuilder: (target: string) => AppConfig,
  routeId: string,
  upstreamId: string
): Promise<HeaderEcho> => {
  const pluginRoot = createTempPluginRoot();
  const registry = new ScopedPluginRegistry(pluginRoot);

  try {
    const config = configBuilder('http://mock-upstream-a.com');
    const { failed } = await registry.initializeFromConfig(config);
    expect(failed).toBe(0);

    const precompiledHooks = registry.getPrecompiledHooks(routeId, upstreamId);
    if (!precompiledHooks) {
      throw new Error(`No precompiled hooks found for route=${routeId}, upstream=${upstreamId}`);
    }

    const context: MutableRequestContext = {
      method: 'GET',
      originalUrl: new URL(`http://localhost${routeId}`),
      clientIP: '127.0.0.1',
      requestId: crypto.randomUUID(),
      routeId,
      upstreamId,
      url: new URL('http://mock-upstream-a.com'),
      headers: {},
      body: null,
    };

    const transformed = await precompiledHooks.hooks.onBeforeRequest.promise(context);

    return {
      onlyA: transformed.headers['x-only-a'] ?? null,
      onlyB: transformed.headers['x-only-b'] ?? null,
      enabled: transformed.headers['x-enabled'] ?? null,
      disabled: transformed.headers['x-disabled'] ?? null,
    };
  } finally {
    await registry.destroy();
    rmSync(pluginRoot, { recursive: true, force: true });
  }
};

describe('ScopedPluginRegistry upstream scope isolation', () => {
  test('should isolate plugins for identical and disabled upstream scenarios', async () => {
    const sameTargetResult = await runScenario(createSameTargetConfig, '/same-target', '0');
    expect(sameTargetResult.onlyA).toBe('1');
    expect(sameTargetResult.onlyB).toBeNull();

    const disabledResult = await runScenario(createDisabledConfig, '/same-target-disabled', '0');
    expect(disabledResult.enabled).toBe('1');
    expect(disabledResult.disabled).toBeNull();
  });
});
