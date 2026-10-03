import { get } from 'svelte/store';
import { _, isLoading, locale } from 'svelte-i18n';
import type { Plugin } from '../../../api/plugins';

/** Preview only; the server remains authoritative for the activation closure. */
export function activationDependencies(plugin: Plugin, plugins: readonly Plugin[]): Plugin[] {
  const found = new Map<string, Plugin>();
  const visited = new Set<string>([plugin.name]);
  function visit(current: Plugin) {
    for (const name of Object.keys(current.dependencies ?? {})) {
      if (visited.has(name)) continue;
      visited.add(name);
      const dependency = plugins.find(item => item.name === name);
      if (!dependency) continue;
      visit(dependency);
      if (!dependency.enabled) found.set(name, dependency);
    }
  }
  visit(plugin);
  return [...found.values()];
}

export type ActivationTranslator = (key: string, options?: { values?: Record<string, string | number> }) => string;

// Existing callers can omit the callback. Reactive UI should pass its subscribed
// formatter, or retain accountError().key and translate it during rendering.
const translate: ActivationTranslator = (key, options) => get(locale) && !get(isLoading) ? get(_)(key, options) : key;

export function activationBlockedReason(plugin: Plugin, displayName: (name: string) => string, t: ActivationTranslator = translate): string {
  const dependents = plugin.dependents?.length ? plugin.dependents
    : plugin.blockedReason?.startsWith('required_by:') ? plugin.blockedReason.slice(12).split(',') : [];
  if (plugin.enabled && dependents.length) return t('pluginActivation.blocked.requiredBy', { values: { names: dependents.map(displayName).join(t('pluginActivation.listSeparator')) } });
  if (plugin.blockedReason === 'in_flight_requests' || plugin.lifecycle === 'retiring') return t('pluginActivation.blocked.inFlight');
  if (plugin.blockedReason === 'protected_routes_require_plugin') return t('pluginActivation.blocked.protectedRoutes');
  return plugin.blockedReason ? t('pluginActivation.blocked.unavailable') : '';
}

const accountErrorCodes = new Set(["control_recovering", "invalid_credentials", "invalid_password", "password_confirmation", "password_unchanged", "invalid_input", "forbidden", "unauthorized", "invalid_origin", "invalid_csrf", "management_setup_failed", "login_limited", "session_limit", "version_conflict", "bootstrap_conflict", "management_provider_unavailable", "provider_unavailable", "authentication_switch_pending"]);
export function accountError(error: unknown, t: ActivationTranslator = translate): { message: string; detail: string; key: string } {
  const detail = error instanceof Error ? error.message : String(error);
  const prefix = detail.split(':')[0];
  const code = error instanceof Error && error.name === 'ConfigurationOperationDegradedError' ? 'publicationFailed'
    : error instanceof Error && error.name === 'ConfigurationOperationTimeoutError' ? 'publicationTimeout'
    : accountErrorCodes.has(detail) ? detail
    : prefix === 'required_by' ? 'requiredBy'
    : prefix === 'in_flight_requests' ? 'inFlight' : 'unknown';
  const key = `pluginActivation.errors.${code}`;
  return { message: t(key), detail, key };
}

export function originMatches(publicOrigin: string | undefined, browserOrigin: string): boolean {
  return !!publicOrigin && publicOrigin === browserOrigin;
}
