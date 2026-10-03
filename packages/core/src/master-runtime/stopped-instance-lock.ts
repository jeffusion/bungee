import { acquireMasterInstanceLock, type MasterInstanceLock } from './instance-lock';
import { MASTER_PROCESS_ENV_NAMES, resolveIngressInstanceLockPath } from './process-options';

/** Master death does not stop ingress. Hold both locks throughout offline writes. */
export async function acquireStoppedInstanceLock(configDbPath: string): Promise<MasterInstanceLock> {
  const ingressPath = resolveIngressInstanceLockPath(process.env[MASTER_PROCESS_ENV_NAMES.ingressInstanceLockPath], process.cwd(), configDbPath);
  const master = await acquireMasterInstanceLock(`${configDbPath}.lock`);
  let ingress: MasterInstanceLock;
  try { ingress = await acquireMasterInstanceLock(ingressPath); }
  catch (error) { await master.release(); throw error; }
  return { path: master.path, async release() {
    try { await ingress.release(); } finally { await master.release(); }
  } };
}
