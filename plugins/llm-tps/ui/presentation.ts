import type { TpsEndpointStats } from '../contract';

export function formatTps(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value) : '—';
}

/** Host-issued opaque identities are safe fallbacks; URL-shaped values are never labels. */
export function endpointIdentity(id: string): string {
  return /^[a-zA-Z0-9_-]+$/.test(id) ? id : 'endpoint';
}

export function rankedEndpoints(rows: readonly TpsEndpointStats[]): TpsEndpointStats[] {
  return [...rows].sort((a, b) => (b.tps ?? -1) - (a.tps ?? -1)
    || a.routeId.localeCompare(b.routeId) || a.endpointId.localeCompare(b.endpointId));
}
