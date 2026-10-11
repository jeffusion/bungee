import { acquireStoppedInstanceLock } from './stopped-instance-lock';
import type { MasterInstanceLock } from './instance-lock';

interface ClosableStorage { close(): Promise<void> }
export interface OfflineStorageSession {
  open<T extends ClosableStorage>(factory: () => Promise<T>): Promise<T>;
}

// An offline caller can remain alive after a rejected operation. Keep the lock
// connections reachable until process exit when storage closure is unconfirmed.
const retainedLocks = new Set<MasterInstanceLock>();

export async function withOfflineStorageSession<T>(
  path: string,
  operation: (session: OfflineStorageSession) => Promise<T>,
): Promise<T> {
  const lock = await acquireStoppedInstanceLock(path);
  const resources: ClosableStorage[] = [];
  let openingUnconfirmed = false;
  const session: OfflineStorageSession = {
    async open(factory) {
      // A rejected open can hide a live Worker; terminate() is not a close ACK.
      try {
        const resource = await factory();
        resources.push(resource);
        return resource;
      }
      catch (error) { openingUnconfirmed = true; throw error; }
    },
  };
  let result!: T;
  let failed = false;
  let primary: unknown;
  try { result = await operation(session); }
  catch (error) { failed = true; primary = error; }
  const cleanupErrors: unknown[] = [];
  for (const resource of resources.reverse()) {
    try { await resource.close(); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (openingUnconfirmed || cleanupErrors.length) {
    retainedLocks.add(lock);
    cleanupErrors.push(Object.assign(new Error('offline storage closure unconfirmed; instance locks retained'), {
      resourceUnreleased: true,
    }));
  } else {
    try { await lock.release(); }
    catch (error) { retainedLocks.add(lock); cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) throw new AggregateError(
    failed ? [primary, ...cleanupErrors] : cleanupErrors,
    'offline storage cleanup failed', failed ? { cause: primary } : undefined,
  );
  if (failed) throw primary;
  return result;
}
