import { resolve, dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { ConfigRepository } from '../config-storage';
import { acquireStoppedInstanceLock } from './stopped-instance-lock';

/** Initialize storage locally under the same lock as master. Management starts anonymously. */
export async function initializeConfigurationDatabase(input: { readonly configDbPath: string }): Promise<void> {
  const path = resolve(input.configDbPath);
  await mkdir(dirname(path), {recursive:true});
  const lock = await acquireStoppedInstanceLock(path);
  try { const repository = ConfigRepository.open(path); repository.close(); }
  finally { await lock.release(); }
}
