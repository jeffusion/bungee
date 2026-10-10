import { recordShutdownFailure, shutdownElapsedMs, type ShutdownStage } from './shutdown-diagnostics';
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
  let repositoryClosed = true;
  let backgroundStopped = true;
  let listenerStopped = true;
  let controlListenerStopped = true;
  let startupWorkersCleaned = true;
  let startupIngressCleaned = true;
  let startupDispositionKnown = options.ancillary?.cleanupAfterStartupFailure === undefined;
  let startedAt = performance.now();
  const recordFailure = (stage: ShutdownStage, error: unknown): void => {
    recordShutdownFailure(stage, { lifecycle, elapsedMs: shutdownElapsedMs(startedAt) }, error);
  };
  const capture = async (stage: ShutdownStage, operation: () => void | Promise<void>): Promise<void> => {
    startedAt = performance.now();
    try { await operation(); }
    catch (error) {
      recordFailure(stage, error);
      errors.push(error instanceof Error
        ? error : new MasterRuntimeError('cleanup_failed', 'master runtime cleanup failed', error));
    }
  };

  options.publicListener.stopAccepting?.();
  startedAt = performance.now();
  try { await options.publicListener.stop(); }
  catch (error) {
    recordFailure('management_listener', error);
    listenerStopped = false;
    errors.push(error instanceof Error
      ? error : new MasterRuntimeError('cleanup_failed', 'management listener cleanup failed', error));
  }
  if (options.ancillary?.beforeCleanup !== undefined) {
    startedAt = performance.now();
    try { await options.ancillary.beforeCleanup(); }
    catch (error) {
      recordFailure('background_tasks', error);
      backgroundStopped = false;
      errors.push(error instanceof Error
        ? error : new MasterRuntimeError('cleanup_failed', 'master background cleanup failed', error));
    }
  }
  if (lifecycle === 'normal_shutdown' && options.ancillary?.beforeStop !== undefined) {
    await capture('before_stop', () => options.ancillary!.beforeStop!());
  }
  if (unsubscribeExit !== null) await capture('exit_subscription', unsubscribeExit);
  await capture('publication_tasks', () => options.publicationTasks.stop());
  await capture('repair_tasks', () => repairSettled);
  if (lifecycle === 'startup_failure') {
    let disposition: MasterIngressStartupFailureDisposition | undefined;
    if (options.ancillary?.cleanupAfterStartupFailure !== undefined) {
      startedAt = performance.now();
      try {
        disposition = await options.ancillary.cleanupAfterStartupFailure();
        startupDispositionKnown = disposition !== undefined;
      } catch (error) {
        recordFailure('startup_ingress', error);
        startupIngressCleaned = false;
        errors.push(error instanceof Error
          ? error : new MasterRuntimeError('cleanup_failed', 'startup ingress cleanup failed', error));
      }
    }
    startedAt = performance.now();
    try {
      await (options.cleanupWorkersAfterStartupFailure?.(disposition) ?? options.workerPool.disconnectAll());
    } catch (error) {
      recordFailure('startup_workers', error);
      startupWorkersCleaned = false;
      errors.push(error instanceof Error
        ? error : new MasterRuntimeError('cleanup_failed', 'startup worker cleanup failed', error));
    }
  if (options.controlListener !== undefined) {
    options.controlListener.stopAccepting?.();
    startedAt = performance.now();
    try { await options.controlListener.stop(); }
    catch (error) {
      recordFailure('control_listener', error);
      controlListenerStopped = false;
      errors.push(error instanceof Error
        ? error : new MasterRuntimeError('cleanup_failed', 'master control listener cleanup failed', error));
    }
  }
  if (options.pluginControlSubscriptions !== undefined) await capture('plugin_subscriptions', options.pluginControlSubscriptions);
  if (options.pluginControlBridge !== undefined) await capture('plugin_bridge', () => options.pluginControlBridge!.dispose());
  if (options.pluginControl !== undefined) await capture('plugin_control', () => options.pluginControl!.dispose());
  if (options.alwaysClose !== undefined) {
    startedAt = performance.now();
    try { await options.alwaysClose(); }
    catch (error) {
      recordFailure('stats', error);
      alwaysClosed = false;
      errors.push(error instanceof Error
        ? error : new MasterRuntimeError('cleanup_failed', 'master always-close resource cleanup failed', error));
    }
  }
    await capture('repository', async () => {
      try { await options.repository.close(); }
      catch (error) { repositoryClosed = false; throw error; }
    });
    if (repositoryClosed && alwaysClosed && backgroundStopped && listenerStopped && controlListenerStopped && startupIngressCleaned && startupWorkersCleaned && startupDispositionKnown) await capture('instance_lock', () => options.instanceLock.release());
    else errors.push(new MasterRuntimeError(
      'cleanup_failed',
      !repositoryClosed
        ? 'configuration storage did not close; instance lock retained'
        : !backgroundStopped
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
  await capture('admission', () => options.admission.clear());

  let expectedPids: readonly number[] | null = null;
  let exitsConfirmed = false;
  startedAt = performance.now();
  try { expectedPids = options.workerPool.pids(); }
  catch (error) {
    recordFailure('worker_snapshot', error);
    errors.push(error instanceof Error
      ? error : new MasterRuntimeError('cleanup_failed', 'worker PID snapshot failed', error));
  }
  startedAt = performance.now();
  try {
    const results = await options.workerPool.shutdownAll();
    exitsConfirmed = expectedPids !== null && exactExitProof(expectedPids, results);
    if (!exitsConfirmed) {
      const confirmed = results.filter(result => exactExitProof([result.process.pid], [result])).map(result => result.process.pid);
      const remaining = [...confirmed];
      const unconfirmed = expectedPids?.filter(pid => {
        const index = remaining.indexOf(pid);
        if (index < 0) return true;
        remaining.splice(index, 1);
        return false;
      });
      recordShutdownFailure('worker_shutdown', {
        lifecycle, elapsedMs: shutdownElapsedMs(startedAt),
        ...(expectedPids === null ? {} : { expectedWorkers: expectedPids.length, unconfirmedPids: unconfirmed!.slice(0, 16) }),
        confirmedWorkers: confirmed.length,
      }, new MasterRuntimeError('worker_exit_unconfirmed', 'worker exits were not confirmed'));
    }
  } catch (error) {
    recordFailure('worker_shutdown', error);
    errors.push(error instanceof Error
      ? error : new MasterRuntimeError('cleanup_failed', 'worker pool shutdown failed', error));
  }

  if (options.controlListener !== undefined) {
    options.controlListener.stopAccepting?.();
    startedAt = performance.now();
    try { await options.controlListener.stop(); }
    catch (error) {
      recordFailure('control_listener', error);
      controlListenerStopped = false;
      errors.push(error instanceof Error
        ? error : new MasterRuntimeError('cleanup_failed', 'master control listener cleanup failed', error));
    }
  }
  if (options.pluginControlSubscriptions !== undefined) await capture('plugin_subscriptions', options.pluginControlSubscriptions);
  if (options.pluginControlBridge !== undefined) await capture('plugin_bridge', () => options.pluginControlBridge!.dispose());
  if (options.pluginControl !== undefined) await capture('plugin_control', () => options.pluginControl!.dispose());
  if (exitsConfirmed) await capture('ingress_shutdown', () => options.ancillary?.closeForNormalShutdown?.());
  if (options.alwaysClose !== undefined) {
    startedAt = performance.now();
    try { await options.alwaysClose(); }
    catch (error) {
      recordFailure('stats', error);
      alwaysClosed = false;
      errors.push(error instanceof Error
        ? error : new MasterRuntimeError('cleanup_failed', 'master always-close resource cleanup failed', error));
    }
  }
  await capture('repository', async () => {
    try { await options.repository.close(); }
    catch (error) { repositoryClosed = false; throw error; }
  });

   if (repositoryClosed && exitsConfirmed && alwaysClosed && backgroundStopped && listenerStopped && controlListenerStopped) await capture('instance_lock', () => options.instanceLock.release());
  else errors.push(exitsConfirmed
    ? new MasterRuntimeError(
      'cleanup_failed',
      !repositoryClosed
        ? 'configuration storage did not close; instance lock retained'
        : !backgroundStopped
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
