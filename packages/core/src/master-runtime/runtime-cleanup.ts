import { exactExitProof } from './runtime-evidence';
import { MasterRuntimeError, type MasterRuntimeOptions } from './runtime-contracts';
import type { MasterIngressStartupFailureDisposition } from '../ingress/master-controller';

export async function cleanupAfterStartupFailure(
  options: MasterRuntimeOptions,
  unsubscribeExit: (() => void) | null,
  repairSettled: Promise<void>,
): Promise<readonly unknown[]> {
  return cleanupMasterRuntimeLifecycle(options, unsubscribeExit, repairSettled, 'startup_failure');
}

export async function closeForNormalShutdown(
  options: MasterRuntimeOptions,
  unsubscribeExit: (() => void) | null,
  repairSettled: Promise<void>,
): Promise<readonly unknown[]> {
  return cleanupMasterRuntimeLifecycle(options, unsubscribeExit, repairSettled, 'normal_shutdown');
}

async function cleanupMasterRuntimeLifecycle(
  options: MasterRuntimeOptions,
  unsubscribeExit: (() => void) | null,
  repairSettled: Promise<void>,
  lifecycle: 'startup_failure' | 'normal_shutdown',
): Promise<readonly unknown[]> {
  const errors: unknown[] = [];
  let alwaysClosed = true;
  let backgroundStopped = true;
  let listenerStopped = true;
  let controlListenerStopped = true;
  let startupWorkersCleaned = true;
  let startupIngressCleaned = true;
  let startupDispositionKnown = options.ancillary?.cleanupAfterStartupFailure === undefined;
  const capture = async (operation: () => void | Promise<void>): Promise<void> => {
    try { await operation(); }
    catch (error) {
      errors.push(error instanceof Error
        ? error : new MasterRuntimeError('cleanup_failed', 'master runtime cleanup failed', error));
    }
  };

  options.publicListener.stopAccepting?.();
  try { await options.publicListener.stop(); }
  catch (error) {
    listenerStopped = false;
    errors.push(error instanceof Error
      ? error : new MasterRuntimeError('cleanup_failed', 'management listener cleanup failed', error));
  }
  if (options.controlListener !== undefined) {
    options.controlListener.stopAccepting?.();
    try { await options.controlListener.stop(); }
    catch (error) {
      controlListenerStopped = false;
      errors.push(error instanceof Error
        ? error : new MasterRuntimeError('cleanup_failed', 'master control listener cleanup failed', error));
    }
  }
  if (options.ancillary?.beforeCleanup !== undefined) {
    try { await options.ancillary.beforeCleanup(); }
    catch (error) {
      backgroundStopped = false;
      errors.push(error instanceof Error
        ? error : new MasterRuntimeError('cleanup_failed', 'master background cleanup failed', error));
    }
  }
  if (lifecycle === 'normal_shutdown' && options.ancillary?.beforeStop !== undefined) {
    await capture(() => options.ancillary!.beforeStop!());
  }
  if (unsubscribeExit !== null) await capture(unsubscribeExit);
  if (options.pluginControlSubscriptions !== undefined) await capture(options.pluginControlSubscriptions);
  if (options.pluginControlBridge !== undefined) await capture(() => options.pluginControlBridge!.dispose());
  if (options.pluginControl !== undefined) await capture(() => options.pluginControl!.dispose());
  if (options.alwaysClose !== undefined) {
    try { await options.alwaysClose(); }
    catch (error) {
      alwaysClosed = false;
      errors.push(error instanceof Error
        ? error : new MasterRuntimeError('cleanup_failed', 'master always-close resource cleanup failed', error));
    }
  }
  await capture(() => options.publicationTasks.stop());
  await capture(() => repairSettled);
  if (lifecycle === 'startup_failure') {
    let disposition: MasterIngressStartupFailureDisposition | undefined;
    if (options.ancillary?.cleanupAfterStartupFailure !== undefined) {
      try {
        disposition = await options.ancillary.cleanupAfterStartupFailure();
        startupDispositionKnown = disposition !== undefined;
      } catch (error) {
        startupIngressCleaned = false;
        errors.push(error instanceof Error
          ? error : new MasterRuntimeError('cleanup_failed', 'startup ingress cleanup failed', error));
      }
    }
    try {
      await (options.cleanupWorkersAfterStartupFailure?.(disposition) ?? options.workerPool.disconnectAll());
    } catch (error) {
      startupWorkersCleaned = false;
      errors.push(error instanceof Error
        ? error : new MasterRuntimeError('cleanup_failed', 'startup worker cleanup failed', error));
    }
    await capture(() => options.repository.close());
    if (alwaysClosed && backgroundStopped && listenerStopped && controlListenerStopped && startupIngressCleaned && startupWorkersCleaned && startupDispositionKnown) await capture(() => options.instanceLock.release());
    else errors.push(new MasterRuntimeError(
      'cleanup_failed',
      !backgroundStopped
        ? 'master background cleanup did not stop; instance lock retained'
        : !alwaysClosed
        ? 'master always-close resource did not close; instance lock retained'
        : !startupWorkersCleaned
        ? 'startup worker cleanup did not complete; instance lock retained'
        : !startupIngressCleaned
        ? 'startup ingress cleanup did not complete; instance lock retained'
        : !startupDispositionKnown
        ? 'startup ingress disposition was not reported; instance lock retained'
        : !controlListenerStopped
        ? 'master control listener did not stop; instance lock retained'
        : 'management listener did not stop; instance lock retained',
    ));
    return errors;
  }
  await capture(() => options.admission.clear());

  let expectedPids: readonly number[] | null = null;
  let exitsConfirmed = false;
  try { expectedPids = options.workerPool.pids(); }
  catch (error) {
    errors.push(error instanceof Error
      ? error : new MasterRuntimeError('cleanup_failed', 'worker PID snapshot failed', error));
  }
  try {
    const results = await options.workerPool.shutdownAll();
    exitsConfirmed = expectedPids !== null && exactExitProof(expectedPids, results);
  } catch (error) {
    errors.push(error instanceof Error
      ? error : new MasterRuntimeError('cleanup_failed', 'worker pool shutdown failed', error));
  }

  if (exitsConfirmed) await capture(() => options.ancillary?.closeForNormalShutdown?.());
  await capture(() => options.repository.close());

   if (exitsConfirmed && alwaysClosed && backgroundStopped && listenerStopped && controlListenerStopped) await capture(() => options.instanceLock.release());
  else errors.push(exitsConfirmed
    ? new MasterRuntimeError(
      'cleanup_failed',
      !backgroundStopped
        ? 'master background cleanup did not stop; instance lock retained'
        : !alwaysClosed
         ? 'master always-close resource did not close; instance lock retained'
         : !controlListenerStopped
         ? 'master control listener did not stop; instance lock retained'
         : 'management listener did not stop; instance lock retained',
    )
    : new MasterRuntimeError(
      'worker_exit_unconfirmed',
      'worker exits were not confirmed; instance lock retained',
      { expectedPids },
    ));
  return errors;
}
