export async function startConfigWorkerProcess(): Promise<void> {
  const { runConfigWorkerProcess } = await import('./config-worker/process-entry');
  await runConfigWorkerProcess();
}
