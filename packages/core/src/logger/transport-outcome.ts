/** Proxy-observed byte-stream lifecycle, independent of HTTP and application protocols. */
export const TRANSPORT_OUTCOMES = ['pending', 'completed', 'failed', 'cancelled', 'unknown'] as const;
export type TransportOutcome = typeof TRANSPORT_OUTCOMES[number];
export interface HttpStatusCounts {
  status2xx: number; status3xx: number; status4xx: number; status5xx: number; statusOther: number;
}
export interface RequestCounts { success: number; failed: number; }
export const emptyRequestCounts = (): RequestCounts => ({ success: 0, failed: 0 });
export interface TransportCounts {
  pending: number; completed: number; failed: number; cancelled: number; unknown: number;
}
export const emptyHttpCounts = (): HttpStatusCounts => ({ status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0, statusOther: 0 });
export const emptyTransportCounts = (): TransportCounts => ({ pending: 0, completed: 0, failed: 0, cancelled: 0, unknown: 0 });

// Byte lifecycle ownership lives with the gateway's stream observers.
export { observeTransportResponse } from '../gateway/body-observation-stream';
