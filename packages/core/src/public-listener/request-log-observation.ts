import type { AccessLogEntry } from '../logger/access-log-writer';
import type { TransportOutcome } from '../logger/transport-outcome';

export type AccessObservation = Readonly<{
  accessId: string;
  timestamp: number;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  transportType: 'http';
  transportOutcome: TransportOutcome;
  transportCode?: string;
}>;

export type IngressRequestLogCollector = (observation: AccessObservation) => AccessLogEntry | undefined;
