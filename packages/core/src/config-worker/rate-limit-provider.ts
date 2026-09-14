import {
  createRateLimitCredential,
  createRateLimitHttpClient,
  deriveRateLimitBucketIdFromDomainKey,
  deriveRateLimitDomainKey,
  disposeRateLimitCredential,
  type RateLimitHttpClient,
  type RateLimitDebitResponseBody,
  type RateLimitIngressIdentity,
  type RateLimitNormalizedKey,
  type RateLimitWorkerIdentity,
  type RateLimitFailureReason,
  type RateLimitFailureStage,
  type RateLimitFailureInput,
  type RateLimitObserver,
} from '../rate-limit';

export type WorkerRateLimitHttpProvider = {
  readonly client: RateLimitHttpClient;
  reportFailure?(failure: {
    readonly reason: RateLimitFailureReason;
    readonly stage: RateLimitFailureStage;
    readonly protocolCode?: string;
    readonly remoteStatus?: number;
    readonly attempts?: number;
  }): void;
  debit(input: {
    readonly routeId: string;
    readonly keyExpression: string;
    readonly key: RateLimitNormalizedKey;
    readonly revision: number;
    readonly rps: number;
    readonly burst: number;
  }, signal: AbortSignal): Promise<RateLimitDebitResponseBody>;
  dispose(): void;
};

let provider: WorkerRateLimitHttpProvider | null = null;
let failureObserver: RateLimitObserver | undefined;

export function setWorkerRateLimitFailureObserver(next: RateLimitObserver | null): void {
  failureObserver = next ?? undefined;
}

export function reportWorkerRateLimitFailure(failure: RateLimitFailureInput): void {
  reportRateLimitFailure(failureObserver, failure);
}

function reportRateLimitFailure(observer: RateLimitObserver | undefined, failure: RateLimitFailureInput): void {
  if (observer?.failure === undefined) return;
  try {
    observer.failure({
      ...failure,
      attempts: failure.attempts ?? 0,
      totalMs: failure.totalMs ?? 0,
    });
  } catch { /* diagnostics never affect request handling */ }
}

export function setWorkerRateLimitClient(next: WorkerRateLimitHttpProvider | null): void {
  provider = next;
}

export function getWorkerRateLimitClient(): WorkerRateLimitHttpProvider | null {
  return provider;
}

export function createWorkerRateLimitHttpProvider(options: {
  readonly transportSecret: string;
  readonly worker: RateLimitWorkerIdentity;
  readonly expectedIngress: RateLimitIngressIdentity;
  readonly supervisionPort: number;
  readonly observer?: RateLimitObserver;
}): WorkerRateLimitHttpProvider {
  const credential = createRateLimitCredential(options.transportSecret, options.worker);
  const domainKey = deriveRateLimitDomainKey(options.transportSecret);
  const client = createRateLimitHttpClient({
    baseUrl: `http://127.0.0.1:${options.supervisionPort}/`,
    session: () => ({ credential, expectedIngress: options.expectedIngress }),
    deadlineMs: 500,
    observer: options.observer,
  });
  let disposed = false;
  return {
    client,
    reportFailure(failure): void {
      reportRateLimitFailure(options.observer, failure);
    },
    debit(input, signal): Promise<RateLimitDebitResponseBody> {
      try {
        return client.debit({
          bucket_id: deriveRateLimitBucketIdFromDomainKey(domainKey, input.routeId, input.keyExpression, input.key),
          policy_id: input.routeId,
          revision: input.revision,
          rps: input.rps,
          burst: input.burst,
        }, signal);
      } catch (error) {
        this.reportFailure?.({ reason: 'configuration_invalid', stage: 'precondition' });
        return Promise.reject(error);
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      client.dispose();
      domainKey.fill(0);
      disposeRateLimitCredential(credential);
    },
  };
}
