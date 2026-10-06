/**
 * Isolated fixture for the real-process plugin RPC gateway acceptance test.
 *
 * It only prepares an OWN temporary data/credential/port surface and the two probe
 * plugin directories; the real master + two supervised workers are launched by the
 * shared `token-stats-gateway` helpers (same DaemonManager launch path, same owned
 * shutdown proof). No second supervision layer and no production data are used.
 */

import { ConfigRepository } from '../../packages/core/src/config-storage';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { makeCanonicalTempDir } from './canonical-temp';
import type { GatewayFixture } from './token-stats-gateway';

/** Control-plane provider plugin name (also the on-disk directory name). */
export const RPC_PROBE_PROVIDER = 'rpc-probe-provider';
/** Worker consumer plugin name (also the on-disk directory name). */
export const RPC_PROBE_CONSUMER = 'rpc-probe-consumer';

const PROBE_SOURCE_ROOT = resolve(import.meta.dir, 'plugin-rpc-probe');

/**
 * Creates a fresh fixture root containing:
 *  - `data/plugins/<name>/` copies of the tracked probe plugin sources,
 *  - an isolated config database (`data/bungee.db`) and access database path,
 *  - a freshly generated plugin-secrets key.
 *
 * Nothing is read from or written to the production working tree; the plugin sources
 * are copied (not symlinked) so the catalog's non-symlink/regular-file rules hold.
 */
export async function createRpcGatewayFixture(): Promise<GatewayFixture> {
  const root = makeCanonicalTempDir('plugin-rpc-gateway', { daemonSafe: true });
  try {
    const pluginsPath = join(root, 'data', 'plugins');
    await Promise.all([
      mkdir(pluginsPath, { recursive: true }),
      mkdir(join(root, 'data'), { recursive: true }),
      mkdir(join(root, 'logs'), { recursive: true }),
      mkdir(join(root, '.bungee', 'run'), { recursive: true }),
    ]);
    for (const name of [RPC_PROBE_PROVIDER, RPC_PROBE_CONSUMER]) {
      await cp(join(PROBE_SOURCE_ROOT, name), join(pluginsPath, name), { recursive: true, errorOnExist: true });
    }
    // Real budget dependencies are built artifacts, so this also exercises the
    // separately bundled Host callback boundary (no source-module WeakMap alias).
    for (const name of ['key-access', 'token-budget', 'token-metering', 'token-stats', 'models-dev']) {
      await cp(resolve(import.meta.dir, '../../packages/core/dist/plugins', name), join(pluginsPath, name), {recursive: true, errorOnExist: true});
    }
    // Force the master onto the isolated SQLite configuration database only.
    await writeFile(join(root, 'config.json'), '{invalid json', 'utf8');
    const repository = ConfigRepository.open(join(root, 'data', 'bungee.db'));
    repository.close();
    return {
      root,
      configDbPath: join(root, 'data', 'bungee.db'),
      accessDbPath: join(root, 'logs', 'access.db'),
      pluginsPath,
      pluginSecretsKey: randomBytes(32).toString('base64'),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
