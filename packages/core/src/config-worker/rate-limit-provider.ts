import { createSignedWorkerRpcClient, DATA_ADMISSION_RPC_PATH, WORKER_STATE_RPC_PATH } from '../data-admission/rpc';
import { setWorkerAdmissionSession } from '../data-admission/worker';
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
  setWorkerAdmissionSession({
    admission: createSignedWorkerRpcClient({ ...options, expectedServer: options.expectedIngress,
      url: `http://127.0.0.1:${options.supervisionPort}${DATA_ADMISSION_RPC_PATH}` }),
    // Master RPC identity is pinned by its authenticated startup environment.
    state: process.env.BUNGEE_MASTER_STATE_RPC_INSTANCE_ID && process.env.BUNGEE_MASTER_STATE_RPC_BOOT_NONCE
      ? createSignedWorkerRpcClient({ ...options, expectedServer: { role: 'ingress',
        process_instance_id: process.env.BUNGEE_MASTER_STATE_RPC_INSTANCE_ID, boot_nonce: process.env.BUNGEE_MASTER_STATE_RPC_BOOT_NONCE },
        url: `http://127.0.0.1:${process.env.BUNGEE_MASTER_CONTROL_PORT}${WORKER_STATE_RPC_PATH}` }) : undefined,
  });
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
      setWorkerAdmissionSession(null);
      client.dispose();
      domainKey.fill(0);
      disposeRateLimitCredential(credential);
    },
  };
}
