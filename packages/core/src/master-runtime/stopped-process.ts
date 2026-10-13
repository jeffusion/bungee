import {createManagementListener} from '../management-listener';
import {readMasterProcessOptions} from './process-options';
import {logger} from '../logger';

/** Last-resort bootstrap failure keeps Docker from restarting an unbudgeted master. */
export function keepStoppedProcessAlive(): void {
  process.exitCode = undefined;
  const keeper = setInterval(() => {},60_000);
  let listener: ReturnType<typeof createManagementListener> | null = null;
  try {
    const options = readMasterProcessOptions();
    listener = createManagementListener({profile:'management',hostname:options.managementHost,port:options.managementPort,
      shutdownTimeoutMs:options.shutdownTimeoutMs,
      health: () => ({live:true,management:false,data:false,degraded:true}),
      controlApi:{handle:async () => Response.json({error:'runtime_stopped'},{status:503})}});
    listener.start(); listener.ready?.();
  } catch { logger.error({code:'stopped_listener_unavailable'},'Stopped master requires local offline recovery'); }
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    void Promise.resolve(listener?.stop()).finally(() => {clearInterval(keeper);process.exit(0);});
  };
  process.once('SIGTERM',stop); process.once('SIGINT',stop);
}
