import { describe, expect, test } from 'bun:test';
import { createPluginSandboxPolicy } from '../../src/ui/plugin-sandbox-policy';
import type { StrictPluginManifest } from '../../src/plugin-manifest-catalog';

function manifest(capabilities: StrictPluginManifest['capabilities'], permissions: string[] = [], withControl = false): StrictPluginManifest {
  return {
    name: 'policy-plugin',
    version: '1.0.0',
    schemaVersion: 2,
    artifactKind: 'runtime-plugin',
    main: 'server/index.ts',
    capabilities,
    uiExtensionMode: 'sandbox-iframe',
    permissions,
    ...(withControl ? { contributes: { api: [{ path: '/control', methods: ['POST'], handler: 'control', execution: 'control' as const }] } } : {}),
    engines: { bungee: '*' },
    configSchema: [],
  };
}

describe('plugin sandbox policy', () => {
  test('uses scripts-only sandboxing and brokers control through the host bridge', () => {
    const policy = createPluginSandboxPolicy(manifest(['hooks', 'sandboxUiExtension', 'dynamicRuntimeLoad'], ['ui:popups', 'ui:navigation', 'api:routes']));
    expect(policy.attributes).toBe('allow-scripts');
    expect(policy.attributes).not.toContain('allow-same-origin');
    expect(policy.allowedHostActions).toEqual(['ui-context', 'copy-styles', 'open-external', 'new-service', 'references']);
    expect(policy.controlAllowlist).toEqual([]);
    expect(policy.csp).toContain("script-src 'self'");
    expect(policy.csp).toContain("connect-src 'none'");
    expect(policy.csp).not.toContain('unsafe-eval');
  });

  test('allows the control host action only when active and declared by the manifest', () => {
    const policy = createPluginSandboxPolicy(manifest([
      'hooks', 'sandboxUiExtension', 'dynamicRuntimeLoad', 'controlPlane', 'api',
    ], [], true), true);
    expect(policy.allowedHostActions).toEqual(['ui-context', 'copy-styles', 'control']);
    expect(policy.controlAllowlist).toEqual([{ path: '/control', methods: ['POST'] }]);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.controlAllowlist)).toBe(true);
    expect(Object.isFrozen(policy.controlAllowlist[0])).toBe(true);
  });

  test('does not derive permissions from capabilities', () => {
    const policy = createPluginSandboxPolicy(manifest(['sandboxUiExtension', 'controlPlane'], [], true), true);
    expect(policy.allowedHostActions).toEqual(['ui-context', 'copy-styles', 'control']);
  });
});
