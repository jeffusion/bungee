import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installBinaryArchive } from './archive-installer';
import { getBinaryName } from './names';
import { UpdateError, type UpdateRelease } from './release';

export type StagedUpdate = { executable: string; directory: string; dispose(): void };

export async function stageRelease(root: string, release: UpdateRelease, signal: AbortSignal,
  verifying: () => void, http: typeof fetch = fetch): Promise<StagedUpdate> {
  if (!release.asset) throw new UpdateError('asset_not_ready');
  mkdirSync(join(root, 'bin'), { recursive: true });
  const directory = mkdtempSync(join(root, 'bin', '.download-'));
  const archive = join(directory, 'release.tar.gz');
  try {
    const response = await http(release.asset.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
    if (!response.ok || !response.body) throw new UpdateError('download_failed', 503);
    const hash = createHash('sha256');
    const fd = openSync(archive, 'wx', 0o600);
    let bytes = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > release.asset.size) throw new UpdateError('digest_mismatch');
        hash.update(chunk.value);
        let offset = 0;
        while (offset < chunk.value.byteLength) offset += writeSync(fd, chunk.value, offset);
      }
    } finally { closeSync(fd); await reader.cancel().catch(() => undefined); }
    verifying();
    if (bytes !== release.asset.size || `sha256:${hash.digest('hex')}` !== release.asset.digest) throw new UpdateError('digest_mismatch');
    signal.throwIfAborted();
    const executable = installBinaryArchive({ archivePath: archive, installRoot: directory,
      version: release.version, binaryName: getBinaryName() });
    const probe = spawnSync(executable, ['--version'], { cwd: directory, timeout: 5_000, maxBuffer: 4096,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, BUNGEE_ROLE: 'master', BUNGEE_CONFIG_DB_PATH: join(directory, 'probe.db') }, encoding: 'utf8' });
    if (probe.status !== 0 || probe.stdout.trim() !== release.version) throw new UpdateError('binary_version_mismatch');
    return { executable, directory: join(directory, release.version), dispose: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function activateStaged(root: string, release: UpdateRelease, staged: StagedUpdate): string {
  const target = join(root, 'bin', release.version);
  const backup = `${target}.backup-${randomUUID()}`;
  let backedUp = false;
  // Keep a replaced package until an operator can inspect any failed startup.
  try { renameSync(target, backup); backedUp = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { renameSync(staged.directory, target); }
  catch (error) { if (backedUp) renameSync(backup, target); throw error; }
  return join(target, getBinaryName());
}
