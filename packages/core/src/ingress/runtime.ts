import { resolve } from 'node:path';
import { acquireInstanceLock, type MasterInstanceLock } from '../instance-lock';
import { createIngressPublicListener, type PublicListener } from '../public-listener';
import {
  RATE_LIMIT_HTTP_PATH,
  IngressTokenBucketStore,
  createRateLimitCredential,
  createRateLimitHttpServer,
  createRateLimitProfileCollector,
  rateLimitProfileEnabled,
  writeRateLimitProfileSummary,
  type RateLimitHttpServer,
  type RateLimitProfileCollector,
} from '../rate-limit';
import { SupervisionProtocolError, type SupervisionProcessCredential } from '../supervision';
import { IngressAdmissionRegistry } from './admission-registry';
import { IngressSupervisionHttpServer } from './supervision-http';

export const INGRESS_SUPERVISION_HOST = '127.0.0.1';
const activeLocks = new Set<MasterInstanceLock>();

export type IngressRuntimeOptions = {
  readonly instanceLockPath: string;
  readonly credential: SupervisionProcessCredential;
  readonly transportSecret: string;
  readonly publicHost: string;
  readonly publicPort: number;
  readonly supervisionPort: number;
  readonly acquireLock?: typeof acquireInstanceLock;
  /** Startup attach watchdog: self-stops when no authenticated attach arrives in time. */
  readonly startupWatchdogMs?: number;
};

export type IngressProcessHandle = {
  readonly publicPort: number | null;
  readonly supervisionPort: number | null;
  stop(): Promise<void>;
};

function port(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
}

export async function startIngressProcess(options: IngressRuntimeOptions): Promise<IngressProcessHandle> {
  if (options.credential.identity.role !== 'ingress') {
    throw new SupervisionProtocolError('identity_mismatch', 'ingress runtime requires an ingress credential');
  }
  port(options.publicPort, 'publicPort');
  port(options.supervisionPort, 'supervisionPort');
  if (options.publicHost.length === 0 || options.instanceLockPath.length === 0) throw new Error('ingress paths are invalid');
  const lock = await (options.acquireLock ?? acquireInstanceLock)(options.instanceLockPath);
  activeLocks.add(lock);
  let control: ReturnType<typeof Bun.serve> | null = null;
  let publicListener: PublicListener | null = null;
  let supervision: IngressSupervisionHttpServer | null = null;
  let rateLimitStore: IngressTokenBucketStore | null = null;
  let rateLimit: RateLimitHttpServer | null = null;
  const profile: RateLimitProfileCollector | null = rateLimitProfileEnabled() ? createRateLimitProfileCollector() : null;
  let profileWritten = false;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelStartupWatchdog = (): void => {
    if (watchdogTimer !== null) clearTimeout(watchdogTimer);
    watchdogTimer = null;
  };
  const writeProfile = (): void => {
    if (profile === null || profileWritten) return;
    profileWritten = true;
    writeRateLimitProfileSummary('ingress', profile);
  };
  try {
    const registry = new IngressAdmissionRegistry();
    rateLimitStore = new IngressTokenBucketStore({
      credential: createRateLimitCredential(options.transportSecret, {
        role: 'ingress',
        process_instance_id: options.credential.identity.process_instance_id,
        boot_nonce: options.credential.identity.boot_nonce,
      }),
      authorizeWorker: registry.authorizeRateLimitWorker.bind(registry),
    });
    rateLimit = createRateLimitHttpServer({ store: rateLimitStore, observer: profile?.observer });
    let stopProcess: (() => Promise<void>) | null = null;
    supervision = new IngressSupervisionHttpServer({
      credential: options.credential,
      registry,
      onAttached: cancelStartupWatchdog,
      onShutdown: () => stopProcess?.(),
    });
    control = Bun.serve({
      hostname: INGRESS_SUPERVISION_HOST,
      port: options.supervisionPort,
      reusePort: false,
      fetch: (request) => {
        if (new URL(request.url).pathname === RATE_LIMIT_HTTP_PATH) return rateLimit!.fetch(request);
        return supervision!.fetch(request);
      },
    });
    publicListener = createIngressPublicListener({
      admission: registry,
      transportSecret: options.transportSecret,
      hostname: options.publicHost,
      port: options.publicPort,
    });
    publicListener.start();
    if (options.startupWatchdogMs !== undefined) {
      watchdogTimer = setTimeout(() => {
        watchdogTimer = null;
        // Guards only the startup window before the first authenticated attach; a lease
        // freeze after the master disappears must never self-stop a serving ingress.
        if (supervision?.isAttached() !== true) void stopProcess?.().catch(() => { process.exitCode = 1; });
      }, options.startupWatchdogMs);
    }
    const currentControl = control;
    const currentPublic = publicListener;
    let stopped: Promise<void> | null = null;
    const onSignal = () => {
      void stopProcess?.().catch(() => { process.exitCode = 1; });
    };
    const stop = async (): Promise<void> => {
      if (stopped !== null) return stopped;
      const errors: unknown[] = [];
      stopped = (async () => {
        try { cancelStartupWatchdog(); } catch (error) { errors.push(error); }
        try { supervision?.stop(); } catch (error) { errors.push(error); }
        try { rateLimit?.dispose(); } catch (error) { errors.push(error); }
        try { rateLimitStore?.dispose(); } catch (error) { errors.push(error); }
        try { await currentPublic.stop(); } catch (error) { errors.push(error); }
        try { await currentControl.stop(false); } catch (error) { errors.push(error); }
        try { await lock.release(); } catch (error) { errors.push(error); }
        activeLocks.delete(lock);
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        writeProfile();
        if (errors.length > 0) throw new AggregateError(errors, 'ingress shutdown failed');
      })();
      return stopped;
    };
    stopProcess = stop;
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    return {
      get publicPort() { return currentPublic.port; },
      get supervisionPort() { return currentControl.port ?? null; },
      stop,
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try { cancelStartupWatchdog(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    try { supervision?.stop(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    try { rateLimit?.dispose(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    try { rateLimitStore?.dispose(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    try { if (publicListener !== null) await publicListener.stop(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    try { if (control !== null) await control.stop(false); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    try { await lock.release(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    activeLocks.delete(lock);
    writeProfile();
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], 'ingress startup and cleanup failed');
    throw error;
  }
}

export type IngressEnvironmentOptions = Omit<IngressRuntimeOptions, 'instanceLockPath' | 'publicHost' | 'publicPort' | 'supervisionPort'> & {
  readonly instanceLockPath?: string;
  readonly publicHost?: string;
  readonly publicPort?: number;
  readonly supervisionPort?: number;
};

export function ingressOptionsFromEnvironment(
  credential: SupervisionProcessCredential,
  transportSecret: string,
  environment: Record<string, string | undefined> = process.env,
): IngressRuntimeOptions {
  const path = environment.BUNGEE_INGRESS_INSTANCE_LOCK_PATH ?? 'data/ingress.instance.lock';
  const productionPort = (name: string, fallback: string): number => {
    const value = Number(environment[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0 || value > 65_535) throw new Error(`${name} must be between 1 and 65535`);
    return value;
  };
  const restrictedPositiveInteger = (name: string): number | undefined => {
    const raw = environment[name];
    if (raw === undefined || raw === '') return undefined;
    if (!/^(0|[1-9]\d*)$/.test(raw)) throw new Error(`${name} must be a decimal integer`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a safe integer >= 1`);
    return value;
  };
  return {
    credential,
    transportSecret,
    instanceLockPath: resolve(process.cwd(), path),
    publicHost: environment.BUNGEE_INGRESS_PUBLIC_HOST ?? '0.0.0.0',
    publicPort: productionPort('BUNGEE_INGRESS_PUBLIC_PORT', '3000'),
    supervisionPort: productionPort('BUNGEE_INGRESS_SUPERVISION_PORT', '3010'),
    startupWatchdogMs: restrictedPositiveInteger('BUNGEE_INGRESS_STARTUP_WATCHDOG_MS'),
  };
}
