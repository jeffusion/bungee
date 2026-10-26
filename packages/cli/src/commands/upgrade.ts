import { DaemonManager } from '../daemon/manager';

export async function upgradeCommand(options: { force?: boolean } = {}): Promise<void> {
  try { await new DaemonManager().upgrade(options); }
  catch (error) {
    console.error('Upgrade failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
