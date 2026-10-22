export type TpsRange = '1h' | '12h' | '24h';

export interface TpsSample {
  readonly attemptId: string;
  readonly requestId: string;
  readonly routeId: string;
  /** Configured endpoint ID, or an opaque hash when the upstream identity is a URL. */
  readonly endpointId: string;
  /** Actual outbound URL.host, or null when unavailable. */
  readonly upstreamHost: string | null;
  readonly model: string | null;
  readonly finishedAtMs: number;
  readonly outputTokens: number;
  readonly generationDurationMs: number;
  readonly outputSource: 'official' | 'estimated';
}

export interface TpsAggregate {
  readonly tps: number | null;
  readonly outputTokens: number;
  readonly generationDurationMs: number;
  readonly sampleCount: number;
  readonly estimatedSampleCount: number;
}

export interface TpsEndpointStats extends TpsAggregate {
  readonly routeId: string;
  readonly upstreamHost: string;
}

export interface TpsModelStats extends TpsAggregate {
  readonly routeId: string;
  readonly model: string;
}

export interface TpsHistoryPoint extends TpsAggregate {
  readonly bucketStartMs: number;
}

export interface TpsStatsResponse {
  readonly range: TpsRange;
  readonly asOfMs: number;
  readonly total: TpsAggregate;
  readonly endpoints: readonly TpsEndpointStats[];
  readonly models: readonly TpsModelStats[];
  readonly history: readonly TpsHistoryPoint[];
  readonly reportingIncomplete: boolean;
}

export const TPS_RETENTION_MS = 31 * 24 * 60 * 60 * 1000;
export const TPS_REPORTING_INCOMPLETE_KEY = 'reporting:incomplete';

/** Canonical URL.host only: no credentials, path, query or fragment. */
export function isUpstreamHost(value: unknown): value is string {
  if (typeof value !== 'string' || !value || /[\s\u0000-\u001f\u007f/\\@?#]/.test(value)) return false;
  try {
    // Either scheme preserves the other scheme's default port in a valid host.
    return new URL(`http://${value}`).host === value || new URL(`https://${value}`).host === value;
  } catch { return false; }
}
