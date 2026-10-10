import { resolve, dirname, join } from 'node:path';
import { acquireMasterInstanceLock, type MasterInstanceLock } from './instance-lock';
import { MASTER_PROCESS_ENV_NAMES, resolveIngressInstanceLockPath } from './process-options';

/** Master death does not stop ingress or telemetry writers. Hold every source lock during offline writes. */
export async function acquireStoppedInstanceLock(configDbPath: string, paths: {accessDbPath?:string;pluginStatePath?:string} = {}): Promise<MasterInstanceLock> {
  const config=resolve(configDbPath);
  const ingress=resolveIngressInstanceLockPath(process.env[MASTER_PROCESS_ENV_NAMES.ingressInstanceLockPath],process.cwd(),config);
  const access=resolve(paths.accessDbPath??process.env.BUNGEE_ACCESS_DB_PATH??'logs/access.db');
  const plugin=resolve(paths.pluginStatePath??join(dirname(config),'plugin-state.db'));
  const locks:MasterInstanceLock[]=[];
  try {for(const path of new Set([`${config}.lock`,`${access}.lock`,`${plugin}.lock`,ingress]))locks.push(await acquireMasterInstanceLock(path));}
  catch(error){for(const lock of locks.reverse())await lock.release();throw error;}
  return {path:locks[0]!.path,async release(){const failures:unknown[]=[];for(const lock of [...locks].reverse())try{await lock.release();}catch(e){failures.push(e);}if(failures.length)throw new AggregateError(failures,'offline locks release failed');}};
}
