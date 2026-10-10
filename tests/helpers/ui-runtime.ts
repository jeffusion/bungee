import { createServer as createPortProbe } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type Alias, type ViteDevServer } from 'vite';
import appConfig from '../../packages/ui/vite.config';

/** One disposable UI service per browser test file; contexts belong to each test. */
export async function startUiRuntime(entries: string[] = ['index.html'], aliases: Alias[] = []) {
  const root = resolve(import.meta.dir, '../../packages/ui');
  const previousDirectory = process.cwd();
  const evidence = await mkdtemp(join(tmpdir(), 'bungee-ui-test-'));
  let server: ViteDevServer | undefined;
  try {
    const probe = createPortProbe();
    const port = await new Promise<number>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        if (!address || typeof address === 'string') { probe.close(); reject(new Error('UI port probe unavailable')); return; }
        probe.close(error => error ? reject(error) : resolve(address.port));
      });
    });
    process.chdir(root);
    server = await createServer({
      ...appConfig, configFile: false, root, cacheDir: join(evidence, 'cache'),
      resolve: { ...appConfig.resolve, alias: [...aliases, ...(appConfig.resolve?.alias as Alias[] ?? [])] },
      optimizeDeps: { ...appConfig.optimizeDeps, entries },
      server: { host: '127.0.0.1', port, strictPort: true, proxy: {} },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('UI fixture did not bind an owned local port');
    let closed = false;
    return { server, root, evidence, origin: `http://127.0.0.1:${address.port}`,
      async close() {
        if (closed) return;
        closed = true;
        try { await server!.close(); }
        finally {
          process.chdir(previousDirectory);
          await rm(evidence, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try { await server?.close(); }
    finally {
      process.chdir(previousDirectory);
      await rm(evidence, { recursive: true, force: true });
    }
    throw error;
  }
}
