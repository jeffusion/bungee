import type { IngressRequestLogCollector } from '@jeffusion/bungee-core/plugin';

export function createIngressRequestLogCollector(): IngressRequestLogCollector {
  return observation => {
    const { accessId, timestamp, method, path, status, durationMs, transportType, transportOutcome, transportCode } = observation;
    return {
      recordKind: 'access', accessId, requestId: accessId, timestamp, method, path, status,
      duration: durationMs, transportType, transportOutcome, transportCode,
      requestType: 'final', replacePendingTransport: transportOutcome !== 'pending',
      success: status < 400 && transportOutcome === 'completed',
    };
  };
}
