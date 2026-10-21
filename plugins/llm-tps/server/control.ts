import type { ControlApiHandlerContext, ControlHostContext, ControlPlugin, PluginControl } from '@jeffusion/bungee-core/plugin';
import { TPS_REPORTING_INCOMPLETE_KEY, type TpsRange } from '../contract';
import { observationClient } from './storage';
export { createObservationAdapter } from './storage';

class ControlError extends Error {
  constructor(readonly code: 'disposed' | 'request_cancelled' | 'invalid_input') { super(code); }
}

function abortable<T>(operation: Promise<T>, signals: readonly AbortSignal[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const listeners: Array<() => void> = [];
    const cleanup = () => signals.forEach((signal, index) => signal.removeEventListener('abort', listeners[index]!));
    const fail = (index: number) => { cleanup(); reject(new ControlError(index < 3 ? 'disposed' : 'request_cancelled')); };
    signals.forEach((signal, index) => {
      const listener = () => fail(index); listeners.push(listener);
      signal.addEventListener('abort', listener, { once: true });
    });
    const cancelled = signals.findIndex(signal => signal.aborted);
    if (cancelled !== -1) fail(cancelled);
    operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export function createControl(host: ControlHostContext): PluginControl {
  const client = observationClient(host.storage);
  const disposal = new AbortController();
  let disposed = false;
  const assertAlive = (context?: ControlApiHandlerContext) => {
    if (disposed || host.signal.aborted || context?.signal.aborted) throw new ControlError('disposed');
    if (context?.requestSignal.aborted || context?.request.signal.aborted) throw new ControlError('request_cancelled');
  };
  const dispose = () => { disposed = true; disposal.abort(); host.signal.removeEventListener('abort', dispose); };
  host.signal.addEventListener('abort', dispose, { once: true });
  return {
    api: [{ path: '/stats', methods: ['GET'], handler: 'getStats', async invoke(context) {
      try {
        assertAlive(context);
        if (context.request.method !== 'GET') return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: { allow: 'GET' } });
        const params = new URL(context.request.url).searchParams;
        const range = params.get('range') ?? '24h';
        if ([...params.keys()].some(key => key !== 'range') || params.getAll('range').length > 1
          || !['1h', '12h', '24h'].includes(range)) throw new ControlError('invalid_input');
        const readIncomplete = async () => {
          const storage = host.storage;
          const strict = storage.readStrict ? await storage.readStrict<unknown>(TPS_REPORTING_INCOMPLETE_KEY) : null;
          const value = strict === null ? await storage.get<unknown>(TPS_REPORTING_INCOMPLETE_KEY) : strict.found ? strict.value : null;
          if (value !== null && value !== false && value !== true) throw new Error('invalid reporting status');
          return value === true;
        };
        const [stats, incomplete] = await abortable(Promise.all([
          client.queryStats({ range: range as TpsRange, asOfMs: Date.now() }), readIncomplete(),
        ]), [disposal.signal, host.signal, context.signal, context.requestSignal, context.request.signal]);
        assertAlive(context);
        return Response.json({ ...stats, reportingIncomplete: stats.reportingIncomplete || incomplete });
      } catch (error) {
        const code = error instanceof ControlError ? error.code : 'storage_unavailable';
        const status = code === 'invalid_input' || code === 'request_cancelled' ? 400 : code === 'disposed' ? 409 : 503;
        return Response.json({ error: code }, { status });
      }
    } }],
    rpc: [],
    start() { assertAlive(); },
    dispose,
  };
}

export default { createControl } satisfies ControlPlugin;
