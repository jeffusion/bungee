import { runSupervisedWorkerProcess } from './config-worker/supervised-process-entry';

export async function startConfigWorkerProcess(): Promise<void> {
  await runSupervisedWorkerProcess();
}
