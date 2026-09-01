import { exactExitProof } from './runtime-evidence';
import { MasterRuntimeError, type MasterRuntimeOptions } from './runtime-contracts';

export async function cleanupMasterRuntime(
  options: MasterRuntimeOptions,
  unsubscribeExit: (() => void) | null,
  repairSettled: Promise<void>,
): Promise<readonly unknown[]> {
  const errors: unknown[] = [];
  const capture = async (operation: () => void | Promise<void>): Promise<void> => {
    try { await operation(); }
    catch (error) {
      errors.push(error instanceof Error
        ? error : new MasterRuntimeError('cleanup_failed', 'master runtime cleanup failed', error));
    }
  };

  if (unsubscribeExit !== null) await capture(unsubscribeExit);
  await capture(() => options.publicListener.stop());
  await capture(() => options.publicationTasks.stop());
  await capture(() => repairSettled);
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

  if (options.ancillary !== undefined) await capture(() => options.ancillary?.close());
  await capture(() => options.repository.close());

  if (exitsConfirmed) await capture(() => options.instanceLock.release());
  else errors.push(new MasterRuntimeError(
    'worker_exit_unconfirmed',
    'worker exits were not confirmed; instance lock retained',
    { expectedPids },
  ));
  return errors;
}
