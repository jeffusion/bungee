import type { TpsEndpointStats, TpsModelStats } from '../contract';

export function formatTps(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value) : '—';
}

/** Host-issued opaque identities are safe fallbacks; URL-shaped values are never labels. */
export function endpointIdentity(id: string): string {
  return /^[a-zA-Z0-9_-]+$/.test(id) ? id : 'endpoint';
}

/** Match the dashboard's host labels without exposing URL credentials, paths or queries. */
export function endpointLabel(target: string | undefined, id: string): string {
  try {
    const url = new URL(target ?? '');
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.host;
  } catch { /* Deleted or managed endpoints may have no URL. */ }
  return `endpoint · ${endpointIdentity(id).slice(0, 8)}`;
}

export function rankedEndpoints(rows: readonly TpsEndpointStats[]): TpsEndpointStats[] {
  return [...rows].sort((a, b) => (b.tps ?? -1) - (a.tps ?? -1)
    || a.routeId.localeCompare(b.routeId) || a.endpointId.localeCompare(b.endpointId));
}

export function rankedModels(rows: readonly TpsModelStats[]): TpsModelStats[] {
  return [...rows].sort((a, b) => (b.tps ?? -1) - (a.tps ?? -1)
    || a.routeId.localeCompare(b.routeId) || a.model.localeCompare(b.model));
}
