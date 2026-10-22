import type { TpsEndpointStats, TpsModelStats } from '../contract';

export function formatTps(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value) : '—';
}

export function rankedEndpoints(rows: readonly TpsEndpointStats[]): TpsEndpointStats[] {
  return [...rows].sort((a, b) => (b.tps ?? -1) - (a.tps ?? -1)
    || a.routeId.localeCompare(b.routeId) || a.upstreamHost.localeCompare(b.upstreamHost));
}

export function rankedModels(rows: readonly TpsModelStats[]): TpsModelStats[] {
  return [...rows].sort((a, b) => (b.tps ?? -1) - (a.tps ?? -1)
    || a.routeId.localeCompare(b.routeId) || a.model.localeCompare(b.model));
}
