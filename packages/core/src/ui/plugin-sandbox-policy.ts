import type { StrictPluginManifest } from '../plugin-manifest-catalog/types';

export type PluginSandboxPolicy = Readonly<{
  attributes: 'allow-scripts';
  csp: string;
  allowedHostActions: readonly ('ui-context' | 'copy-styles' | 'open-external' | 'new-service' | 'references' | 'control')[];
  controlAllowlist: readonly Readonly<{ path: string; methods: readonly ('GET' | 'POST' | 'PUT' | 'DELETE')[] }>[];
}>;

const SANDBOX_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "manifest-src 'self'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

const PERMISSION_ACTIONS = [
  ['ui:popups', 'open-external'],
  ['ui:navigation', 'new-service'],
  ['api:routes', 'references'],
] as const;

function controlAllowlist(manifest: StrictPluginManifest): PluginSandboxPolicy['controlAllowlist'] {
  return (manifest.contributes?.api ?? []).map(({ path, methods }) => Object.freeze({ path, methods: Object.freeze([...methods]) }));
}

export function createPluginSandboxPolicy(manifest: StrictPluginManifest, active = false): PluginSandboxPolicy {
  const sandboxEnabled = manifest.uiExtensionMode === 'sandbox-iframe'
    && manifest.capabilities.includes('sandboxUiExtension');
  const permissions = new Set(manifest.permissions ?? []);
  const allowedHostActions: PluginSandboxPolicy['allowedHostActions'][number][] = [];
  if (sandboxEnabled) {
    allowedHostActions.push('ui-context', 'copy-styles');
    for (const [permission, action] of PERMISSION_ACTIONS) {
      if (permissions.has(permission)) allowedHostActions.push(action);
    }
    const controls = active ? controlAllowlist(manifest) : [];
    if (active && controls.length > 0) allowedHostActions.push('control');
    return Object.freeze({
      attributes: 'allow-scripts' as const,
      csp: SANDBOX_CSP,
      allowedHostActions: Object.freeze(allowedHostActions),
      controlAllowlist: Object.freeze(controls),
    });
  }

  return Object.freeze({
    attributes: 'allow-scripts' as const,
    csp: SANDBOX_CSP,
    allowedHostActions: Object.freeze(allowedHostActions),
    controlAllowlist: Object.freeze([]),
  });
}
