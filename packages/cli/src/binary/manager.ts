import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { UpdateController } from '../../../core/src/updates/controller';
import { assertNoUpdate, installedExecutable, selectedVersion } from '../../../core/src/updates/installation';
import { compareVersions, UpdateError } from '../../../core/src/updates/release';

export class BinaryManager {
  static get root(): string { return process.env.BUNGEE_INSTALL_ROOT ?? join(homedir(), '.bungee'); }

  static async ensureBinary(): Promise<string> {
    assertNoUpdate(this.root);
    try { return installedExecutable(this.root); }
    catch { throw new Error('Bungee binary is unavailable. Run bungee upgrade first.'); }
  }

  static async upgrade(options: Readonly<{ force?: boolean }> = {}): Promise<void> {
    const version = selectedVersion(this.root) ?? '0.0.0';
    const updates = new UpdateController({ version, root: this.root, compiled: false, offline: true,
      admit: async () => {
        if (existsSync(join(this.root, 'run', 'daemon.json'))) throw new UpdateError('update_busy', 409);
      } });
    const cancel = () => updates.cancel();
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    try {
      await updates.check();
      const status = updates.status();
      if (status.check_error || !status.latest) throw new Error(status.check_error ?? 'release_check_failed');
      if (compareVersions(status.latest.version, version) < 0 || (status.latest.version === version && !options.force)) {
        console.log(`Bungee ${version} is already installed.`); return;
      }
      console.log(`Installing Bungee ${status.latest.version}...`);
      await updates.request({ operation_id: randomUUID(), current_version: version, target_version: status.latest.version, force: options.force });
      const result = (await updates.wait()).operation;
      if (result?.phase !== 'succeeded') throw new Error(result?.error ?? 'result_unknown');
      console.log(`Installed Bungee ${result.target_version}. The stopped instance was not started.`);
    } finally {
      await updates.wait();
      process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    }
  }
}
