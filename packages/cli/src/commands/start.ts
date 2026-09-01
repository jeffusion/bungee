import { DaemonManager } from '../daemon/manager';

interface StartOptions {
  readonly port?: string;
  readonly workers?: string;
  readonly detach?: boolean;
  readonly autoUpgrade?: boolean;
}

export async function startCommand(options: StartOptions = {}): Promise<void> {
  const daemonManager = new DaemonManager();
  try {
    console.log('Starting Bungee daemon...');
    console.log(`Workers: ${options.workers ?? '2'}`);
    if (options.port !== undefined) console.log(`Port override: ${options.port}`);
    await daemonManager.start(options);
  } catch (error) {
    console.error('Failed to start Bungee:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
