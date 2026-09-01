import { DaemonManager } from '../daemon/manager';

interface RestartOptions {
  readonly port?: string;
  readonly workers?: string;
  readonly autoUpgrade?: boolean;
}

export async function restartCommand(options: RestartOptions = {}): Promise<void> {
  try {
    await new DaemonManager().restart(options);
  } catch (error) {
    console.error('Failed to restart Bungee:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
